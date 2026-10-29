// 关注类别设置（规格第 9 节，26 号票）。用户的调整和自定义类别是数据，放在数据目录配置区的 config/watch-categories.json
// （守卫的写法；守卫每次判定现读）。这里是唯一写它的地方：
// - 设置页的修改（update_watch_categories 请求）→ 校验（内置类别只能往严里调、两条底线改不动、名字和规则写对）
//   → 写文件（先写临时文件再改名）→ 关注类别频道上一条 watch_category_settings 事件（设置的最新样子，前端据此同步）；
// - 文件是真相：每次现读（守卫判定、任务模块、快速动作、启动、"重新读取"）发现和上次记下的不一样（用户手改过、改坏了），
//   就记一条 system 事件。文件坏了时守卫判定一律出错（拦下），事件里带上问题，表格仍是上一次有效的设置，设置页据此提示并修复：
//   恢复成上一次有效的设置或恢复默认，坏掉的文件另存一份（WATCH_CATEGORIES_BROKEN_COPY）。坏了的同时在待我处理里放一条事项，
//   修好后自动归档；
// - 删除或调松一个自定义类别时，事件里记下还有几个进行中的任务确认时快照了它（它们仍按确认时的设置检查）；
// - 新的自定义类别 id 是 c-<n>：n 取用过的最大号（事件里、当前文件里、计划里）加一，删掉的 id 不再用。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  type NoticeInboxItem,
  type UpdateWatchCategoriesParams,
  type UpdateWatchCategoriesResult,
  WATCH_CATEGORIES_BROKEN_COPY,
  WATCH_CATEGORIES_REPAIR_ACTION,
  WATCH_CATEGORY_CHANGE_OPS,
  WATCH_CATEGORY_OPS,
  type WatchCategoriesState,
  type WatchCategoryChange,
  type WatchCategoryDraft,
  type WatchCategorySettingsEventPayload,
  type WatchToolChoice,
  t,
} from "@ergo/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import {
  BOTTOM_LINES,
  BUILTIN_WATCH_CATEGORIES,
  builtinDisposition,
  type CustomWatchCategory,
  type Disposition,
  editWatchCategorySettings,
  isStricter,
  parseWatchCategorySettings,
  readWatchCategoryFile,
  type Scene,
  type WatchCategoryEdit,
  type WatchCategorySettings,
} from "../guard/index.ts";
import { GUARD_DISPOSITION, WIRE_DISPOSITION } from "../guard-wire/dispositions.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { normalizeCategoryMatch } from "./match.ts";

const CHANNEL = CHANNELS.watchCategories;
const BROKEN_NOTICE = "watch_categories_broken";
const brokenTitle = () => t("watchCategories.broken.title");
/** 几条问题连起来 */
const problemsText = (problems: readonly string[]) => problems.join(t("watchCategories.sep"));

export interface WatchCategoryService {
  /** 全局设置：现读配置区的文件（和上次记下的不一样就记一条 system 事件）；文件坏了时抛错，守卫据此判定出错 */
  current(): WatchCategorySettings;
  /** 设置页的一次修改；不让做时抛 RequestRejected（设置文件不变） */
  update(params: UpdateWatchCategoriesParams, idempotencyKey: string): UpdateWatchCategoriesResult;
  /** 设置现在的样子（关注类别频道上最后一条事件里的） */
  state(): WatchCategoriesState;
  /** 启动时读一遍文件：频道上还没有事件、或者和上次记下的不一样时记一条 */
  start(): void;
}

export interface WatchCategoryServiceOptions {
  store: EventStore;
  /** 设置文件坏了时放"关注类别设置文件有问题"事项，修好后归档 */
  inbox: InboxService;
  layout: Pick<DataDirLayout, "watchCategoriesFile">;
  now: () => string;
  /** 自定义类别能匹配的工具（内置的、代为执行的、快速动作的伪工具）：设置页的候选；现取 */
  tools: () => WatchToolChoice[];
  /** 任务计划里出现过的关注类别 id（新的自定义类别 id 要躲开）；现取 */
  categoryIdsInPlans: () => string[];
  /** 有几个进行中的任务确认计划时快照了这个自定义类别（它们仍按确认时的设置检查）；现取 */
  heldByTasks: (categoryId: string) => number;
}

/** 读一次文件的结果：原文（没有文件是 null），解析出的设置或问题 */
type FileRead = { text: string | null; settings: WatchCategorySettings; problems: [] } | { text: string | null; settings?: undefined; problems: string[] };

type EditParams = Exclude<UpdateWatchCategoriesParams, { op: typeof WATCH_CATEGORY_OPS.repair | typeof WATCH_CATEGORY_OPS.reload }>;

export function createWatchCategoryService(options: WatchCategoryServiceOptions): WatchCategoryService {
  const { store, inbox, now } = options;
  const file = options.layout.watchCategoriesFile;
  /** 上一次读到的（原文没变就不再解析） */
  let cached: FileRead | undefined;
  /** 上一次对过的读取结果（原文没变就不用再对：每次判定都要现读） */
  let synced: FileRead | undefined;
  /** 频道上最后一条事件里的设置 */
  let last: WatchCategoriesState | undefined;

  const lastFromLog = (): WatchCategoriesState | undefined => {
    const seq = store.lastSeq(CHANNEL);
    return seq === 0 ? undefined : (store.eventAt(CHANNEL, seq)?.payload as WatchCategorySettingsEventPayload | undefined)?.state;
  };

  const readFile = (): FileRead => {
    let text: string | null;
    try {
      text = readWatchCategoryFile(file);
    } catch (err) {
      return { text: null, problems: [t("watchCategories.unreadable", { file, error: err instanceof Error ? err.message : String(err) })] };
    }
    if (cached && cached.text === text) return cached;
    try {
      cached = { text, settings: parseWatchCategorySettings(text, file), problems: [] };
    } catch (err) {
      cached = { text, problems: [err instanceof Error ? err.message : String(err)] };
    }
    return cached;
  };

  /** 读到的设置画成设置页的样子；坏了时表格沿用上一次有效的（还没有就是默认） */
  const stateOf = (read: FileRead): WatchCategoriesState => {
    const tools = options.tools();
    if (read.settings) return { ...tablesOf(read.settings), tools, problems: [] };
    const tables = last ? { builtin: last.builtin, bottomLines: last.bottomLines, custom: last.custom } : tablesOf({});
    return { ...tables, tools, problems: read.problems };
  };

  const append = (state: WatchCategoriesState, change: WatchCategoryChange, by: "user" | "system", idempotencyKey?: string) => {
    const payload: WatchCategorySettingsEventPayload = { state, change, by, time: now() };
    store.append({ channel: CHANNEL, type: EVENT_TYPES.watchCategorySettings, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
    last = state;
  };

  /** 还开着的"设置文件有问题"事项 */
  const brokenNotices = (): NoticeInboxItem[] =>
    inbox.list().filter((i): i is NoticeInboxItem => i.kind === "notice" && i.notice === BROKEN_NOTICE && !i.archived && !i.deleted);

  /** 设置文件坏了：放一条事项（已经有开着的就不再放），马上告诉用户 */
  const noticeBroken = (problems: readonly string[]) => {
    if (brokenNotices().length > 0) return;
    const item = inbox.add({
      kind: "notice",
      notice: BROKEN_NOTICE,
      title: brokenTitle(),
      body: t("watchCategories.broken.body", { file, problems: problemsText(problems) }),
      source: t("watchCategories.broken.source"),
      urgency: "blocking",
      actions: [WATCH_CATEGORIES_REPAIR_ACTION],
    });
    inbox.alert(item);
  };

  /** 设置文件好了：开着的"有问题"事项自动归档 */
  const retireBroken = () => {
    for (const item of brokenNotices()) store.append(inbox.buildUpdate(item, { archived: true, title: t("watchCategories.broken.fixedTitle") }).event);
  };

  /** 文件和上次记下的不一样（或者还没记过）：记一条 system 事件；坏了放事项，好了归档事项 */
  const sync = (read: FileRead) => {
    if (read === synced) return;
    synced = read;
    const state = stateOf(read);
    if (!last || JSON.stringify(state) !== JSON.stringify(last)) append(state, { op: WATCH_CATEGORY_CHANGE_OPS.file }, "system");
    if (read.settings) retireBroken();
    else noticeBroken(read.problems);
  };

  /** 设置页的修改写进文件之后：记事件，这份就是对过的 */
  const commit = (written: FileRead, change: WatchCategoryChange, idempotencyKey: string) => {
    append(stateOf(written), change, "user", idempotencyKey);
    synced = written;
    retireBroken();
  };

  const write = (settings: WatchCategorySettings): FileRead => {
    const body: WatchCategorySettings = {
      ...(settings.builtin && Object.keys(settings.builtin).length > 0 ? { builtin: settings.builtin } : {}),
      ...(settings.custom && settings.custom.length > 0 ? { custom: settings.custom } : {}),
    };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    // 先写临时文件再改名，被占着时重试（265 号票）
    writeFileAtomic(file, text);
    cached = { text, settings: body, problems: [] };
    return cached;
  };

  /** 新的自定义类别 id：c-<n>，n 取用过的最大号（事件里、当前文件里、计划里）加一，删掉的 id 不再用 */
  const newCustomId = (settings: WatchCategorySettings): string => {
    const used = [
      ...store.read(CHANNEL, 0, EVENT_TYPES.watchCategorySettings).flatMap((e) => {
        const p = e.payload as WatchCategorySettingsEventPayload;
        return [...p.state.custom.map((c) => c.id), ...(p.change.categoryId === undefined ? [] : [p.change.categoryId])];
      }),
      ...(settings.custom ?? []).map((c) => c.id),
      ...options.categoryIdsInPlans(),
    ];
    const max = Math.max(0, ...used.map((id) => /^c-(\d+)$/.exec(id)).map((m) => (m ? Number(m[1]) : 0)));
    return `c-${max + 1}`;
  };

  /** 设置页的操作换成对守卫设置的修改 */
  const editOf = (params: EditParams, settings: WatchCategorySettings): WatchCategoryEdit => {
    switch (params.op) {
      case WATCH_CATEGORY_OPS.setBuiltin:
        return { op: "set_builtin", categoryId: params.categoryId, scene: params.scene, disposition: GUARD_DISPOSITION[params.disposition] };
      case WATCH_CATEGORY_OPS.createCustom:
        return { op: "create_custom", category: customOf(newCustomId(settings), params.category) };
      case WATCH_CATEGORY_OPS.updateCustom:
        mustHaveCustom(settings, params.categoryId);
        return { op: "update_custom", category: customOf(params.categoryId, params.category) };
      case WATCH_CATEGORY_OPS.deleteCustom:
        mustHaveCustom(settings, params.categoryId);
        return { op: "delete_custom", categoryId: params.categoryId };
    }
  };

  /** 删除或调松（任一场景更松、规则改了）一个自定义类别：还有几个进行中的任务按确认时快照下来的设置检查它 */
  const heldBy = (before: WatchCategorySettings, after: WatchCategorySettings, categoryId: string): number => {
    const was = before.custom?.find((c) => c.id === categoryId);
    if (!was) return 0;
    const next = after.custom?.find((c) => c.id === categoryId);
    const loosened = !next || isStricter(was.chat, next.chat) || isStricter(was.task, next.task) || JSON.stringify(was.match) !== JSON.stringify(next.match);
    return loosened ? options.heldByTasks(categoryId) : 0;
  };

  return {
    current() {
      const read = readFile();
      sync(read);
      if (!read.settings) throw new Error(read.problems.join("\n"));
      return read.settings;
    },
    update(params, idempotencyKey) {
      const prior = store.eventByIdempotencyKey(idempotencyKey);
      if (prior) {
        if (prior.type !== EVENT_TYPES.watchCategorySettings) throw new RequestRejected("bad_params", t("watchCategories.keyReused"));
        // 和第一次的结果一样：只有新建带回类别 id
        const { change } = prior.payload as WatchCategorySettingsEventPayload;
        return change.op === WATCH_CATEGORY_OPS.createCustom && change.categoryId !== undefined ? { categoryId: change.categoryId } : {};
      }
      const read = readFile();
      sync(read);
      if (params.op === WATCH_CATEGORY_OPS.reload) return {};
      if (params.op === WATCH_CATEGORY_OPS.repair) {
        if (read.settings) throw new RequestRejected("not_allowed", t("watchCategories.notBroken"));
        if (read.text !== null) fs.writeFileSync(path.join(path.dirname(file), WATCH_CATEGORIES_BROKEN_COPY), read.text);
        commit(write(params.to === "defaults" ? {} : settingsOfTables(last ?? tablesOf({}))), { op: params.op, to: params.to }, idempotencyKey);
        return {};
      }
      if (!read.settings) {
        throw new RequestRejected("not_allowed", t("watchCategories.repairFirst", { problems: problemsText(read.problems) }));
      }
      const result = editWatchCategorySettings(read.settings, editOf(params, read.settings));
      if (!result.ok) throw new RequestRejected("not_allowed", problemsText(result.problems));
      const held = heldBy(read.settings, result.settings, result.categoryId);
      const change: WatchCategoryChange = {
        op: params.op,
        categoryId: result.categoryId,
        ...(params.op === WATCH_CATEGORY_OPS.setBuiltin ? { scene: params.scene, disposition: params.disposition } : {}),
        ...(held > 0 ? { heldByTasks: held } : {}),
      };
      commit(write(result.settings), change, idempotencyKey);
      return params.op === WATCH_CATEGORY_OPS.createCustom ? { categoryId: result.categoryId } : {};
    },
    state() {
      return last ?? stateOf(readFile());
    },
    start() {
      last = lastFromLog();
      sync(readFile());
    },
  };
}

/** 设置页写的类别换成守卫的写法：名字和规则过 normalizeCategoryMatch，不对的回 bad_params */
function customOf(id: string, draft: WatchCategoryDraft): CustomWatchCategory {
  const checked = normalizeCategoryMatch(draft);
  if (checked.problems.length > 0) throw new RequestRejected("bad_params", problemsText(checked.problems));
  return { id, title: checked.title, match: checked.match, chat: GUARD_DISPOSITION[draft.chat], task: GUARD_DISPOSITION[draft.task] };
}

function mustHaveCustom(settings: WatchCategorySettings, id: string): void {
  if (!(settings.custom ?? []).some((c) => c.id === id)) throw new RequestRejected("not_found", t("watchCategories.noCustom", { id }));
}

/** 设置画成表格：内置九类（现在的处置只会比默认严）、两条底线、自定义类别（处置都是协议的写法） */
function tablesOf(settings: WatchCategorySettings): Pick<WatchCategoriesState, "builtin" | "bottomLines" | "custom"> {
  return {
    builtin: BUILTIN_WATCH_CATEGORIES.map((c) => ({
      id: c.id,
      title: c.title,
      defaults: { chat: c.defaults.chat === null ? null : WIRE_DISPOSITION[c.defaults.chat], task: WIRE_DISPOSITION[c.defaults.task ?? "ask_first"] },
      chat: c.defaults.chat === null ? null : WIRE_DISPOSITION[builtinDisposition(c.id, "chat", [settings])],
      task: WIRE_DISPOSITION[builtinDisposition(c.id, "task", [settings])],
    })),
    bottomLines: Object.entries(BOTTOM_LINES).map(([id, line]) => ({ id, title: line.title, disposition: WIRE_DISPOSITION[line.disposition] })),
    custom: (settings.custom ?? []).map((c) => ({ id: c.id, title: c.title, match: c.match, chat: WIRE_DISPOSITION[c.chat], task: WIRE_DISPOSITION[c.task] })),
  };
}

/** 表格换回守卫的设置（恢复成上一次有效的设置用）：内置类别和默认不一样的才写 */
function settingsOfTables(tables: Pick<WatchCategoriesState, "builtin" | "custom">): WatchCategorySettings {
  const builtin: NonNullable<WatchCategorySettings["builtin"]> = {};
  for (const c of tables.builtin) {
    const scenes: Partial<Record<Scene, Disposition>> = {};
    if (c.chat !== null && c.chat !== c.defaults.chat) scenes.chat = GUARD_DISPOSITION[c.chat];
    if (c.task !== c.defaults.task) scenes.task = GUARD_DISPOSITION[c.task];
    if (Object.keys(scenes).length > 0) builtin[c.id as keyof typeof builtin] = scenes;
  }
  const custom = tables.custom.map((c) => ({ id: c.id, title: c.title, match: c.match, chat: GUARD_DISPOSITION[c.chat], task: GUARD_DISPOSITION[c.task] }));
  return { ...(Object.keys(builtin).length > 0 ? { builtin } : {}), ...(custom.length > 0 ? { custom } : {}) };
}
