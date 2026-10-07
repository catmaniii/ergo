// 关注类别设置（规格第 9 节，26 号票）。用户的调整和自定义类别是数据，放在数据目录配置区的 config/watch-categories.json
// （守卫的写法；守卫每次判定现读）。这里是唯一写它的地方：
// - 设置页的修改（update_watch_categories 请求）→ 校验（内置类别只能往严里调、两条底线改不动、规则写成确定的、工具认得）
//   → 写文件（先写临时文件再改名）→ 关注类别频道上一条 watch_category_settings 事件（设置的最新样子，前端据此同步）；
// - 文件是真相：每次现读（守卫判定、任务模块、快速动作、启动、"重新读取"）发现和上次记下的不一样（用户手改过、改坏了），
//   就记一条 system 事件。文件坏了时守卫判定一律出错（拦下），事件里带上问题，表格仍是上一次有效的设置，设置页据此提示并修复：
//   恢复成上一次有效的设置或恢复默认，坏掉的文件另存一份（WATCH_CATEGORIES_BROKEN_COPY）。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  type UpdateWatchCategoriesParams,
  type UpdateWatchCategoriesResult,
  WATCH_CATEGORIES_BROKEN_COPY,
  type WatchCategoriesState,
  type WatchCategoryChange,
  type WatchCategoryDraft,
  type WatchCategorySettingsEventPayload,
  type WatchToolChoice,
} from "@ergou/protocol";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import {
  BOTTOM_LINES,
  BUILTIN_WATCH_CATEGORIES,
  builtinDisposition,
  type CustomWatchCategory,
  editWatchCategorySettings,
  parseWatchCategorySettings,
  readWatchCategoryFile,
  type WatchCategoryEdit,
  type WatchCategorySettings,
} from "../guard/index.ts";
import { GUARD_DISPOSITION, WIRE_DISPOSITION } from "../guard-runtime/describe.ts";
import { normalizeCategoryMatch } from "./match.ts";

const CHANNEL = CHANNELS.watchCategories;

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
  layout: Pick<DataDirLayout, "watchCategoriesFile">;
  now: () => string;
  /** 自定义类别能匹配的工具（内置的、代为执行的、快速动作的伪工具）；现取 */
  tools: () => WatchToolChoice[];
}

/** 读一次文件的结果：原文（没有文件是 null），解析出的设置或问题 */
type FileRead = { text: string | null; settings: WatchCategorySettings; problems: [] } | { text: string | null; settings?: undefined; problems: string[] };

export function createWatchCategoryService(options: WatchCategoryServiceOptions): WatchCategoryService {
  const { store, now } = options;
  const file = options.layout.watchCategoriesFile;
  /** 上一次读到的（原文没变就不再解析） */
  let cached: FileRead | undefined;
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
      return { text: null, problems: [`读不了关注类别设置 ${file}：${err instanceof Error ? err.message : String(err)}`] };
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

  /** 文件和上次记下的不一样（或者还没记过）：记一条 system 事件 */
  const sync = (read: FileRead) => {
    const state = stateOf(read);
    if (!last || JSON.stringify(state) !== JSON.stringify(last)) append(state, { op: "file" }, "system");
  };

  const write = (settings: WatchCategorySettings) => {
    const body: WatchCategorySettings = {
      ...(settings.builtin && Object.keys(settings.builtin).length > 0 ? { builtin: settings.builtin } : {}),
      ...(settings.custom && settings.custom.length > 0 ? { custom: settings.custom } : {}),
    };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    cached = { text, settings: body, problems: [] };
    return cached;
  };

  /** 新的自定义类别 id：c-<n>，n 按建过的个数往上数（删掉的 id 不再用：计划里对它的调严不会落到新类别上） */
  const newCustomId = (settings: WatchCategorySettings): string => {
    const created = store.read(CHANNEL, 0, EVENT_TYPES.watchCategorySettings).filter((e) => (e.payload as WatchCategorySettingsEventPayload).change.op === "create_custom").length;
    const taken = new Set((settings.custom ?? []).map((c) => c.id));
    let n = created + 1;
    while (taken.has(`c-${n}`)) n++;
    return `c-${n}`;
  };

  const customOf = (id: string, draft: WatchCategoryDraft): CustomWatchCategory => {
    const checked = normalizeCategoryMatch(draft.match, options.tools());
    const title = draft.title.trim();
    const problems = [...(title === "" ? ["名字不能是空的"] : []), ...checked.problems];
    if (problems.length > 0) throw new RequestRejected("bad_params", problems.join("；"));
    return { id, title, match: checked.match, chat: GUARD_DISPOSITION[draft.chat], task: GUARD_DISPOSITION[draft.task] };
  };

  const mustHaveCustom = (settings: WatchCategorySettings, id: string) => {
    if (!(settings.custom ?? []).some((c) => c.id === id)) throw new RequestRejected("not_found", `没有这个自定义类别：${id}`);
  };

  /** 设置页的操作换成对守卫设置的修改 */
  const editOf = (params: Exclude<UpdateWatchCategoriesParams, { op: "repair" | "reload" }>, settings: WatchCategorySettings): WatchCategoryEdit => {
    switch (params.op) {
      case "set_builtin":
        return { op: "set_builtin", categoryId: params.categoryId, scene: params.scene, disposition: GUARD_DISPOSITION[params.disposition] };
      case "create_custom":
        return { op: "create_custom", category: customOf(newCustomId(settings), params.category) };
      case "update_custom":
        mustHaveCustom(settings, params.categoryId);
        return { op: "update_custom", category: customOf(params.categoryId, params.category) };
      case "delete_custom":
        mustHaveCustom(settings, params.categoryId);
        return { op: "delete_custom", categoryId: params.categoryId };
    }
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
        if (prior.type !== EVENT_TYPES.watchCategorySettings) throw new RequestRejected("bad_params", "这个幂等键已经用在别的请求上了");
        const categoryId = (prior.payload as WatchCategorySettingsEventPayload).change.categoryId;
        return categoryId === undefined ? {} : { categoryId };
      }
      const read = readFile();
      sync(read);
      if (params.op === "reload") return {};
      if (params.op === "repair") {
        if (read.settings) throw new RequestRejected("not_allowed", "设置文件没坏，不用修复");
        if (read.text !== null) fs.writeFileSync(path.join(path.dirname(file), WATCH_CATEGORIES_BROKEN_COPY), read.text);
        const fixed = write(params.to === "defaults" ? {} : settingsOfTables(last ?? tablesOf({})));
        append(stateOf(fixed), { op: "repair", to: params.to }, "user", idempotencyKey);
        return {};
      }
      if (!read.settings) {
        throw new RequestRejected("not_allowed", `关注类别的设置文件坏了，先修复（恢复成上一次有效的设置，或者恢复默认）再改：${read.problems.join("；")}`);
      }
      const edit = editOf(params, read.settings);
      const result = editWatchCategorySettings(read.settings, edit);
      if (!result.ok) throw new RequestRejected("not_allowed", result.problems.join("；"));
      const written = write(result.settings);
      const categoryId = edit.op === "create_custom" || edit.op === "update_custom" ? edit.category.id : edit.categoryId;
      const change: WatchCategoryChange = {
        op: params.op,
        categoryId,
        ...(params.op === "set_builtin" ? { scene: params.scene, disposition: params.disposition } : {}),
      };
      append(stateOf(written), change, "user", idempotencyKey);
      return params.op === "create_custom" ? { categoryId } : {};
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
    const scenes: Partial<Record<"chat" | "task", ReturnType<typeof builtinDisposition>>> = {};
    if (c.chat !== null && c.chat !== c.defaults.chat) scenes.chat = GUARD_DISPOSITION[c.chat];
    if (c.task !== c.defaults.task) scenes.task = GUARD_DISPOSITION[c.task];
    if (Object.keys(scenes).length > 0) builtin[c.id as keyof typeof builtin] = scenes;
  }
  const custom = tables.custom.map((c) => ({ id: c.id, title: c.title, match: c.match, chat: GUARD_DISPOSITION[c.chat], task: GUARD_DISPOSITION[c.task] }));
  return { ...(Object.keys(builtin).length > 0 ? { builtin } : {}), ...(custom.length > 0 ? { custom } : {}) };
}
