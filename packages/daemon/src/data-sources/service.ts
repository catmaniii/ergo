// 设置 · 数据源（295 号票，issue 25）：把插件登记的数据源（registry.ts）接成一处——
// - 页面（view）：每个数据源的名字、登记它的插件、连接状态（插件报的；没在运行时按密钥区有没有东西估）、上次同步和条数、正在同步、
//   两种用法各开没开、用到的敏感类别（对上记忆的敏感类别开关：默认只记录、不用于推断）、认哪种文件、定期导入的时间；导入文件夹的路径、
//   留在里面没导入的文件和原因、最近导入的；
// - 动作（act）：立即同步、断开（留着已导入的 / 连已导入的一起删，后者走"删除参与方"登记表：deletion.ts）、开关一种用法、填设置；
// - 定期导入：连着、导入开着、插件在运行、登记了时间的数据源挂一个内部作业（data-source:<id>，错过了开机补一次）；
// - 按需查：内核替数据源给秘书登记一份工具（agent 贡献），只给按需查开着、插件在运行的；开关一变通知秘书重新装配，
//   正在跑的一轮里再调关着的回"关着"；
// - 导入文件夹（import-folder.ts）：每隔一会儿、文件夹里一有变化、用户点"现在检查"时看一遍，认得的交给那个数据源导入、挪进"已导入"，
//   认不出的、几个数据源都认的、插件没启用的、导入关着的、出错的留在原地并提示；出错的同一个文件自动再看时不重试（手动看时重试）。
// 同步、导入出错的原因里带着这个数据源的密钥的换成 ***（redactSecrets），记进同步记录（events.ts）。
// 299 号票加了：设备交来的（push：按数据源登记的 schema 查、交给它收下、记同步记录 trigger device，同一个幂等键重发只收一次）、
// 外部日历（calendarEvents：插件在运行的数据源交给日历插件显示的日程，经 KERNEL.externalCalendars 给日历插件）、
// 数据源自己数"共几条"（count）、同步记录带"这次进来的是什么"（summary）。
// 300 号票加了：原始数据（raw：插件自己存储里的，页面按天列出；动作 clear_raw 清掉几天的，插件在运行时才行）。
// 297 号票：定期导入可以"每隔几分钟"（内部作业的 IntervalSchedule）；每隔几分钟的那种，到点同步了、什么都没变（新进来 0 条、没出错、
// 上一条记下的同步也没出错）的那次不记事件（每 30 分钟一条会把事件日志撑大），只在内存里记着、页面上照样显示"上次同步"；
// 重启后显示最后记下的那次。数据源可以说导入的东西去哪（destination，不写是整理成素材）、填好设置连上以后马上同步一次（syncOnConnect）、
// 报一句提示（note）和它下面的几样（items）。
// 307 号票：数据源报的插件那一块要的数据（panel）、断开时要说的一句（disconnectNote）原样交给页面；有本机文件夹的（localFolder）能
// "在电脑上打开"（open 动作，和导入文件夹同一个 openFolder）。
// 306 号票：
// - 按需查的工具只在连上时给秘书：插件在运行、按需查开着之外还要连着（插件报的最近一次已知的连接状态，status 要快、不连网，装配时不等网络）；
//   没连、出错（Key 失效、地址失效）的不给。给出去的那份变了才让秘书重新装配（295 合并时定的）：用法开关、填设置、断开、插件起停、
//   同步完、设备交来、按需查调完（插件可能在这时发现 Key 失效）都比一比；正在跑的一轮里再调没连上的回"没连上 / 出错了"；
// - 外部日历的版本（calendarVersion）：交给日历的日程变了（数据源的记录写进了新的、断开了、插件起停、连接状态变了）就往上加、
//   通知订阅的（组合根在工作日历频道上推临时事件 external_calendar），开着的日历页不用换月就重新取；
// - 出错的自己回来（主会话 2026-10-26 定）：插件在运行、报出错、能再试（登记了 recheck，或者有 sync 且导入开着；能填设置的要密钥区里
//   真有东西）的数据源，内核每小时替它试一次（recheck 用存着的设置再测连接；没有 recheck 的照同步那样同步一次，不看连没连着），
//   试过了比一比——好了就回到连着（按需查的工具跟着回来、秘书重新装配一次），没好一小时后再试；Key 失效、密码错这种也照样试，
//   页面上写明"每小时自动再试一次"（autoRetry）；
// - 断开的确认框按数据源说话：页面上带"有没有填过的密钥"（hasSecrets）、"导入的进不进素材"（toMaterials，它的记录登记了素材来源没有），
//   数据源报的一句（disconnectNote）插件没报的从数据源登记的那一句取。
import fs from "node:fs";
import path from "node:path";
import {
  type CalendarExternalEntry,
  checkHttpBody,
  type DataSourceActionBody,
  type DataSourceActionResult,
  type DataSourcePushBody,
  type DataSourcePushResult,
  type DataSourceRawView,
  type DataSourcesView,
  type DataSourceSyncView,
  type DataSourceUsage,
  type DataSourceView,
  describeSchedule,
  formatList,
  forModel,
  type ImportedFileView,
  type ImportFileHint,
  type ImportFileProblem,
  type ImportFolderActionBody,
  type ImportFolderActionResult,
  IMPORTED_SHOWN,
  isDeletedEventPayload,
  t,
} from "@ergo/protocol";
import type { AgentContributions } from "../agent-host/contributions.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { SensitiveCategory } from "../config/config.ts";
import type { DeletionParticipants } from "../deletion/participants.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { Materials } from "../materials/materials.ts";
import { type InternalJobs, isInterval } from "../scheduler/internal-jobs.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { DataSourceContext, DataSourceFileType, DataSourceSchedule, DataSourceStatus } from "./api.ts";
import { disconnectedBefore, recordDisconnect } from "./deletion.ts";
import { DATA_SOURCE_SYNCED, DATA_SOURCES_CHANNEL, dataSourceRecords, type DataSourceSyncedPayload } from "./events.ts";
import { fileTypeMatches, listImportFiles, moveInto, readHead } from "./import-folder.ts";
import type { DataSourceEntry, DataSourceRegistry } from "./registry.ts";
import { type DataSourceSecretStore, redactSecrets } from "./secrets.ts";
import type { DataSourceSettings } from "./settings.ts";

/** 点"立即同步"时最多等多久就先交回（还在同步的页面上显示"正在同步"，过一会儿再取） */
const SYNC_WAIT_MS = 20_000;
/** 导入文件夹多久看一遍（文件夹里有变化另外马上看） */
const SCAN_EVERY_MS = 60_000;
/** 文件刚改过多久之内算"还在写"，不碰它 */
const SETTLE_MS = 3_000;
/** 出错的数据源多久替它再试一次（306 号票，主会话定的每小时） */
export const RETRY_EVERY_MS = 60 * 60_000;

export interface DataSourcesOptions {
  registry: DataSourceRegistry;
  store: EventStore;
  secrets: DataSourceSecretStore;
  settings: DataSourceSettings;
  /** 定期导入挂在内部作业上 */
  internalJobs: Pick<InternalJobs, "register">;
  /** 出错的数据源每小时再试一次挂在调度器上（只在内存里：重启后插件记着的出错也没了） */
  scheduler: Pick<Scheduler, "schedule" | "cancel">;
  /** 按需查的工具经它给秘书；refresh 通知秘书重新装配 */
  contributions: Pick<AgentContributions, "tools" | "refresh">;
  /** 断开并删走"删除参与方"登记表 */
  participants: Pick<DeletionParticipants, "plan">;
  /** 导入文件夹、"已导入" */
  folder: { imports: string; imported: string };
  /** 记忆那边允许用来推断的敏感类别（配置 memory.sensitiveCategories） */
  inferable: () => readonly SensitiveCategory[];
  /** 素材库：哪类事件登记了素材来源（306 号票：断开的确认框说不说"素材"） */
  materials: Pick<Materials, "captures">;
  now: () => string;
  /** 在电脑上打开文件夹（测试换成假的） */
  openFolder: (dir: string) => Promise<void>;
  log: (line: string) => void;
  /** 导入文件夹多久看一遍（毫秒）；false 不定时看、不监视（测试） */
  scanEveryMs?: number | false;
  /** 文件刚改过多久之内不碰（毫秒，测试给 0） */
  settleMs?: number;
}

export interface DataSources {
  /** 设置 · 数据源整页 */
  view(): DataSourcesView;
  /** 对一个数据源做的事 */
  act(id: string, body: DataSourceActionBody): Promise<DataSourceActionResult>;
  /** 对导入文件夹做的事 */
  folder(body: ImportFolderActionBody): Promise<ImportFolderActionResult>;
  /** 同步一次（正在同步的等同一次）：交回新进来几条或者出错的原因；不能同步的抛 RequestRejected */
  sync(id: string, trigger: "manual" | "scheduled"): Promise<{ added?: number; error?: string }>;
  /** 设备交来的（299 号票）：不认得的数据源抛 not_found，插件没在运行、不收、导入关着、data 不对抛 RequestRejected */
  push(id: string, body: DataSourcePushBody): Promise<DataSourcePushResult>;
  /** 外部日历（299 号票）：插件在运行的数据源交给日历插件显示的 [from, to) 里的日程（出错的那个数据源跳过、记日志） */
  calendarEvents(from: Date, to: Date): CalendarExternalEntry[];
  /** 外部日历现在的版本（306 号票）：交给日历的日程变了就往上加（只增不减，毫秒时间起步） */
  calendarVersion(): number;
  /** 外部日历变了（交来新版本）；返回取消订阅 */
  onCalendarChange(listener: (version: number) => void): () => void;
  /** 看一遍导入文件夹（retry：出错过的也再试一次） */
  scan(options?: { retry?: boolean }): Promise<void>;
  /** 插件的状况变了（运行中停用、启用）：定期导入、按需查的工具、正在跑的同步跟着变 */
  refresh(): void;
  /** 起来：给秘书登记按需查的工具、挂定期导入、看一遍导入文件夹、开始定时看 */
  start(options?: { scan?: boolean }): void;
  stop(): Promise<void>;
  /** 正在跑的同步、导入、出错后的再试都做完 */
  whenIdle(): Promise<void>;
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** "X插件没启用"（插件给人看的名字现取） */
const pluginOff = (entry: DataSourceEntry) => t("plugins.notEnabled", { title: entry.owner.title });
/** 同步记录给页面的样子 */
const syncView = (p: DataSourceSyncedPayload): DataSourceSyncView => ({
  at: p.at,
  trigger: p.trigger,
  ...(p.added === undefined ? {} : { added: p.added }),
  ...(p.error === undefined ? {} : { error: p.error }),
  ...(p.file ? { file: p.file.name } : {}),
  ...(p.summary === undefined ? {} : { summary: p.summary }),
});
/** 导入文件夹里留着的一个文件 */
const hint = (name: string, size: number, problem: ImportFileProblem, text: string): ImportFileHint => ({ name, size, problem, text });
/** 导入出错过的文件按名字、大小、修改时间认（改过了就重试） */
const failureKey = (name: string, size: number, mtimeMs: number) => `${name}\u0000${size}\u0000${mtimeMs}`;

/** 等一次同步最多 SYNC_WAIT_MS：没完的交回 undefined（页面上显示"正在同步"，过一会儿再取） */
async function waitSync(promise: Promise<{ added?: number; error?: string }>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), SYNC_WAIT_MS)))]);
  clearTimeout(timer);
  return waited;
}

/** 定期导入的时间给人看的写法：提醒那一套照 describeSchedule；每隔几分钟的写"每 30 分钟""每小时""每 2 小时" */
export function describeSyncSchedule(schedule: DataSourceSchedule): string {
  if (!isInterval(schedule)) return describeSchedule(schedule);
  const { minutes } = schedule;
  if (minutes === 60) return t("dataSources.every.hour");
  if (minutes % 60 === 0) return t("dataSources.every.hours", { n: minutes / 60 });
  return t("dataSources.every.minutes", { n: minutes });
}

/** 出错后再试挂在调度器上的 key（306 号票） */
const retryKey = (id: string) => `data-source-retry:${id}`;

/** 设备交来的那一次的幂等键（同一个键重发只回第一次记下的） */
const pushKey = (id: string, idempotencyKey: string) => `data-source-push:${id}:${idempotencyKey}`;

export function createDataSources(options: DataSourcesOptions): DataSources {
  const { registry, store, secrets, settings, log } = options;
  const settleMs = options.settleMs ?? SETTLE_MS;
  /** 正在跑的同步：数据源 → 那一次 */
  const running = new Map<string, { promise: Promise<{ added?: number; error?: string }>; controller: AbortController }>();
  /** 填设置时测试连接没过的原因（下一次填对了、断开时清掉） */
  const configureProblems = new Map<string, string>();
  /** 每隔几分钟的定期导入什么都没变的那次（不记事件，只记在这里；断开时清掉） */
  const quietSyncs = new Map<string, DataSourceSyncedPayload>();
  /** 挂着的定期导入：数据源 → 撤销 */
  const jobs = new Map<string, () => void>();
  /** 导入文件夹：留着的文件的提示、上次看的时间、导入出错过的文件（名字、大小、修改时间 → 原因） */
  let pending: ImportFileHint[] = [];
  let scannedAt: string | undefined;
  const failures = new Map<string, string>();
  let scanning: Promise<void> = Promise.resolve();
  const stopping = new AbortController();
  const teardown: Array<() => void> = [];

  const entryOf = (id: string): DataSourceEntry => {
    const entry = registry.get(id);
    if (!entry) throw new RequestRejected("not_found", t("dataSources.unknown", { id }));
    return entry;
  };
  const contextOf = (entry: DataSourceEntry): DataSourceContext => ({
    secrets: secrets.forSource(entry.source.id),
    log: (line) => log(`数据源 ${entry.source.id}：${line}`),
  });
  const redact = (entry: DataSourceEntry, text: string) => redactSecrets(text, secrets.valuesOf(entry.source.id));

  /** 这种用法提供了没有、开没开（没改过照数据源登记的默认） */
  const usageOn = (entry: DataSourceEntry, usage: DataSourceUsage): boolean => {
    const offered = entry.source.usages[usage];
    if (!offered) return false;
    return settings.usage(entry.source.id, usage) ?? offered.default;
  };

  /** 连接状态：手动导入的没有；插件没在运行时按密钥区有没有东西估；填设置没过的写那次的原因 */
  const statusOf = (entry: DataSourceEntry): DataSourceStatus | "manual" => {
    const { source } = entry;
    if (!source.status) return "manual";
    if (!entry.owner.running()) return { connection: secrets.hasAny(source.id) ? "connected" : "not_connected" };
    let status: DataSourceStatus;
    try {
      status = source.status(contextOf(entry));
    } catch (err) {
      status = { connection: "error", problem: describe(err) };
    }
    // 填设置没过：没连上的算出错；已经连着的（297 号票：Google 日历已有一个日历、再加一个没加上）照样连着，原因写在出错那一行
    const failed = configureProblems.get(source.id);
    if (failed !== undefined) return { ...status, connection: status.connection === "connected" ? "connected" : "error", problem: failed };
    return status.problem === undefined ? status : { ...status, problem: redact(entry, status.problem) };
  };
  const connected = (entry: DataSourceEntry) => {
    const status = statusOf(entry);
    return status === "manual" || status.connection === "connected";
  };
  /**
   * 出错了、内核每小时替它再试一次的（306 号票）：插件在运行、报出错、能再试（登记了 recheck，或者有 sync 且导入开着），
   * 能填设置的还要密钥区里真有东西（只是填设置没过、什么都没存的不算：没什么可试）
   */
  const retryable = (entry: DataSourceEntry): boolean => {
    const { source } = entry;
    if (!entry.owner.running()) return false;
    if (!source.recheck && !(source.sync && usageOn(entry, "import"))) return false;
    if (source.configure && !secrets.hasAny(source.id)) return false;
    const status = statusOf(entry);
    return status !== "manual" && status.connection === "error";
  };
  /**
   * 按需查的工具现在给不给（306 号票）：插件在运行、按需查开着、连着。连接状态是插件报的最近一次已知的（status 要快、不连网：
   * 插件在同步、按需查时碰到 Key 失效记在内存里），装配时不等网络；没连、出错（Key 失效、地址失效）的不给
   */
  const queryReady = (entry: DataSourceEntry) => entry.source.tools !== undefined && entry.owner.running() && usageOn(entry, "query") && connected(entry);

  /** 它导入的记录现在有几条（还没删掉的）；插件在运行、自己会数的（299 号票）由它数 */
  const countOf = (entry: DataSourceEntry): number => {
    if (entry.source.count && entry.owner.running()) {
      try {
        return entry.source.count(contextOf(entry));
      } catch (err) {
        log(`数据源 ${entry.source.id} 数不出几条（照记录数）：${describe(err)}`);
      }
    }
    let n = 0;
    for (const { channel, type } of entry.source.records ?? []) {
      const events = channel === undefined ? store.ofType(type) : store.read(channel, 0, type);
      n += events.filter((e) => !isDeletedEventPayload(e.payload)).length;
    }
    return n;
  };

  /** 同步记录归并：每个数据源最近一次断开之后的最后一次同步；最近导入的文件（新的在前） */
  const history = () => {
    const last = new Map<string, DataSourceSyncedPayload>();
    const files: DataSourceSyncedPayload[] = [];
    for (const { synced, disconnected } of dataSourceRecords(store)) {
      if (disconnected) last.delete(disconnected.source);
      if (!synced) continue;
      last.set(synced.source, synced);
      if (synced.file) files.push(synced);
    }
    // 没记事件的那几次（每隔几分钟、什么都没变）更晚的话用它
    for (const [id, quiet] of quietSyncs) {
      const recorded = last.get(id);
      if (!recorded || Date.parse(quiet.at) >= Date.parse(recorded.at)) last.set(id, quiet);
    }
    return { last, files: files.toReversed() };
  };

  /** 原始数据（300 号票）：插件在运行、登记了的才有；列不出来的记日志、不写 */
  const rawOf = (entry: DataSourceEntry): DataSourceRawView | undefined => {
    const { raw } = entry.source;
    if (!raw || !entry.owner.running()) return undefined;
    try {
      return { title: raw.title, days: raw.days(contextOf(entry)).map((d) => ({ date: d.date, count: d.count, summarized: d.summarized })) };
    } catch (err) {
      log(`数据源 ${entry.source.id} 列不出原始数据：${describe(err)}`);
      return undefined;
    }
  };

  const sourceView = (entry: DataSourceEntry, last: DataSourceSyncedPayload | undefined): DataSourceView => {
    const { source, owner } = entry;
    const available = owner.running();
    const status = statusOf(entry);
    const inferable = options.inferable();
    const schedule = source.usages.import?.schedule;
    const raw = rawOf(entry);
    const destination = source.usages.import?.destination;
    const reported = status !== "manual" && available ? status : undefined;
    // 断开时要说的一句：插件在运行时报的（随状态变），没报的用数据源登记的那一句（306 号票：手机日历、通讯录、Google 联系人）
    const disconnectNote = reported?.disconnectNote ?? source.disconnectNote;
    return {
      id: source.id,
      title: source.title,
      summary: source.summary ?? "",
      plugin: owner.plugin,
      pluginTitle: owner.title,
      available,
      ...(available ? {} : { unavailable: pluginOff(entry) }),
      connection: status === "manual" ? "manual" : status.connection,
      ...(status !== "manual" && status.problem !== undefined ? { problem: status.problem } : {}),
      ...(status !== "manual" && status.account !== undefined ? { account: status.account } : {}),
      ...(reported?.note === undefined ? {} : { note: reported.note }),
      ...(reported?.items === undefined ? {} : { items: reported.items.map((item) => ({ ...item, ...(item.problem === undefined ? {} : { problem: redact(entry, item.problem) }) })) }),
      ...(reported?.panel === undefined ? {} : { panel: reported.panel }),
      ...(disconnectNote === undefined ? {} : { disconnectNote }),
      ...(secrets.hasAny(source.id) ? { hasSecrets: true as const } : {}),
      ...((source.records ?? []).some((r) => options.materials.captures(r.type)) ? { toMaterials: true as const } : {}),
      usages: (["query", "import"] as const).filter((u) => source.usages[u]).map((usage) => ({ usage, on: usageOn(entry, usage) })),
      sensitive: (source.sensitive ?? []).map((id) => ({ id, title: t(`dataSources.sensitive.${id}`), inferable: inferable.includes(id) })),
      count: countOf(entry),
      ...(last ? { lastSync: syncView(last) } : {}),
      syncing: running.has(source.id),
      canSync: available && usageOn(entry, "import") && source.sync !== undefined && (status === "manual" || status.connection === "connected"),
      ...(retryable(entry) ? { autoRetry: true as const } : {}),
      ...(schedule ? { schedule: describeSyncSchedule(schedule) } : {}),
      ...(destination === undefined ? {} : { destination }),
      files: (source.files ?? []).map((f) => f.title),
      configurable: source.configure !== undefined,
      ...(source.push ? { fromDevice: true as const } : {}),
      ...(raw ? { raw } : {}),
    };
  };

  const view = (): DataSourcesView => {
    const { last, files } = history();
    const titleOf = (id: string) => registry.get(id)?.source.title ?? id;
    const recent: ImportedFileView[] = files.slice(0, IMPORTED_SHOWN).map((p) => ({ name: p.file!.name, source: p.source, sourceTitle: titleOf(p.source), at: p.at, added: p.added ?? 0 }));
    return {
      sources: registry.list().map((entry) => sourceView(entry, last.get(entry.source.id))),
      folder: { path: options.folder.imports, importedPath: options.folder.imported, pending: [...pending], recent, ...(scannedAt ? { scannedAt } : {}) },
    };
  };

  /** 记一条同步记录（原因里的密钥换掉）；设备交来的带幂等键 */
  const recordSync = (entry: DataSourceEntry, payload: Omit<DataSourceSyncedPayload, "source" | "at">, idempotencyKey?: string) => {
    const p: DataSourceSyncedPayload = { source: entry.source.id, at: options.now(), ...payload, ...(payload.error === undefined ? {} : { error: redact(entry, payload.error) }) };
    store.append({ channel: DATA_SOURCES_CHANNEL, type: DATA_SOURCE_SYNCED, payload: p, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
    return p;
  };

  /** 上次成功同步（不算导入文件）是什么时候：记下的和没记事件的那几次里更晚的 */
  const lastSyncAt = (id: string): string | undefined => {
    const recorded = dataSourceRecords(store)
      .flatMap(({ synced }) => (synced && synced.source === id && synced.trigger !== "file" && synced.error === undefined ? [synced.at] : []))
      .at(-1);
    const quiet = quietSyncs.get(id)?.at;
    if (quiet === undefined) return recorded;
    return recorded === undefined || Date.parse(quiet) >= Date.parse(recorded) ? quiet : recorded;
  };

  /** 这次同步要不要记事件：每隔几分钟的定期导入什么都没变、上一条记下的同步（断开之后的）也没出错的不记 */
  const worthRecording = (id: string, trigger: "manual" | "scheduled", added: number): boolean => {
    const schedule = registry.get(id)?.source.usages.import?.schedule;
    if (trigger !== "scheduled" || added > 0 || !schedule || !isInterval(schedule)) return true;
    const previous = dataSourceRecords(store)
      .flatMap(({ synced, disconnected }) => (synced?.source === id && synced.trigger !== "file" ? [synced] : disconnected?.source === id ? [undefined] : []))
      .at(-1);
    return previous === undefined || previous.error !== undefined;
  };

  /** 同步一次；retry 是出错后每小时的再试（不看连没连着，306 号票） */
  const startSync = (id: string, trigger: "manual" | "scheduled", retry = false): Promise<{ added?: number; error?: string }> => {
    const entry = entryOf(id);
    const { source } = entry;
    const now = running.get(id);
    if (now) return now.promise;
    if (!entry.owner.running()) return Promise.reject(new RequestRejected("not_allowed", pluginOff(entry)));
    if (!source.sync || !source.usages.import) return Promise.reject(new RequestRejected("not_allowed", t("dataSources.noSync", { title: source.title })));
    if (!usageOn(entry, "import")) return Promise.reject(new RequestRejected("not_allowed", t("dataSources.importOff", { title: source.title })));
    if (!retry && !connected(entry)) return Promise.reject(new RequestRejected("not_allowed", t("dataSources.notConnected", { title: source.title })));
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, stopping.signal]);
    const doSync = source.sync;
    const promise = (async (): Promise<{ added?: number; error?: string }> => {
      try {
        const result = await doSync({ ...contextOf(entry), trigger, lastSyncAt: lastSyncAt(id), signal });
        if (signal.aborted) return { error: t("dataSources.syncAborted") };
        if (worthRecording(id, trigger, result.added)) {
          recordSync(entry, { trigger, added: result.added, ...(result.summary === undefined ? {} : { summary: result.summary }) });
          quietSyncs.delete(id);
        } else quietSyncs.set(id, { source: id, at: options.now(), trigger, added: 0 });
        return { added: result.added };
      } catch (err) {
        if (signal.aborted) return { error: t("dataSources.syncAborted") };
        const p = recordSync(entry, { trigger, error: describe(err) });
        quietSyncs.delete(id);
        log(`数据源 ${id} 同步出错：${p.error}`);
        return { error: p.error! };
      } finally {
        running.delete(id);
        // 同步时可能碰到 Key 失效、地址失效（或者又好了）：给出去的按需查工具、交给日历的变了才通知
        noticeChanges();
      }
    })();
    running.set(id, { promise, controller });
    return promise;
  };
  const sync = (id: string, trigger: "manual" | "scheduled") => startSync(id, trigger);

  /** 定期导入挂上、摘下：插件在运行、导入开着、连着、登记了时间的挂着 */
  const armJobs = () => {
    for (const entry of registry.list()) {
      const { id, usages, sync: canSync } = entry.source;
      const schedule = usages.import?.schedule;
      const want = schedule !== undefined && canSync !== undefined && entry.owner.running() && usageOn(entry, "import") && connected(entry);
      const armed = jobs.get(id);
      if (want && !armed) {
        jobs.set(
          id,
          options.internalJobs.register({
            name: `data-source:${id}`,
            schedule,
            run: async () => {
              const current = registry.get(id);
              // 到点时又没连上、关了、插件停了：这一次什么都不做
              if (!current || !current.owner.running() || !usageOn(current, "import") || !connected(current)) return;
              await sync(id, "scheduled");
            },
          }),
        );
      } else if (!want && armed) {
        armed();
        jobs.delete(id);
      }
    }
  };

  /** 哪些数据源的按需查现在给得出工具（插件在运行、按需查开着、连着：306 号票）：变了才让秘书重新装配 */
  const queryToolOwners = (): string =>
    registry
      .list()
      .filter(queryReady)
      .map((entry) => entry.source.id)
      .join(",");
  /** 秘书上次装配时拿到的那一份（还没装配过就不用通知） */
  let assembledToolOwners: string | undefined;

  /** 按需查的工具：插件在运行、按需查开着、连着的；调用时再看一遍（正在跑的一轮里关掉了回"关着"、没连上了回"没连上 / 出错了"） */
  const queryTools = (): HostTool[] => {
    assembledToolOwners = queryToolOwners();
    return registry.list().flatMap((entry) => {
      if (!queryReady(entry) || !entry.source.tools) return [];
      let tools: readonly HostTool[];
      try {
        tools = entry.source.tools(contextOf(entry));
      } catch (err) {
        log(`数据源 ${entry.source.id} 的按需查工具拿不到：${describe(err)}`);
        return [];
      }
      return tools.map(
        (tool): HostTool => ({
          ...tool,
          run(args, call) {
            const now = registry.get(entry.source.id);
            if (!now || !now.owner.running()) return { text: forModel(() => `${entry.owner.title}插件没启用：现在用不了 ${tool.spec.name}（用户停用了这个插件）。如实告诉用户。`), isError: true }; // @i18n-ignore model：交给 agent 的工具结果
            if (!usageOn(now, "query")) return { text: forModel(() => `${entry.source.title}的按需查关着（用户在设置 · 数据源里关了）：现在查不了。如实告诉用户。`), isError: true }; // @i18n-ignore model：交给 agent 的工具结果
            const status = statusOf(now);
            if (status !== "manual" && status.connection !== "connected") {
              const why = status.problem === undefined ? "" : `（${status.problem}）`; // @i18n-ignore model：交给 agent 的工具结果
              const text =
                status.connection === "error"
                  ? forModel(() => `${entry.source.title}出错了${why}：现在查不了 ${tool.spec.name}。如实告诉用户，请用户去设置 · 数据源看看。`) // @i18n-ignore model：交给 agent 的工具结果
                  : forModel(() => `${entry.source.title}没连上（用户在设置 · 数据源里断开了，或者还没填好）：现在查不了 ${tool.spec.name}。如实告诉用户。`); // @i18n-ignore model：交给 agent 的工具结果
              return { text, isError: true };
            }
            // 插件可能在查的时候发现 Key 失效、地址失效：查完比一比，给出去的那份变了才通知秘书（这一轮做完再按新的装配）
            const result = tool.run(args, call);
            if (result instanceof Promise) return result.finally(noticeChanges);
            noticeChanges();
            return result;
          },
        }),
      );
    });
  };

  // ---- 外部日历的版本（306 号票） ----

  /** 外部日历的版本：交给日历的日程变了就往上加（只增不减；毫秒时间起步，重启后照样比以前的大） */
  let calendarVersion = Date.now();
  const calendarListeners = new Set<(version: number) => void>();
  /** 交给日历的是哪几个数据源、各是什么连接状态（插件起停、断开、连接状态变了，日历里的就跟着变） */
  const calendarShape = (): string =>
    registry
      .list()
      .filter((entry) => entry.source.calendar !== undefined && entry.owner.running())
      .map((entry) => {
        const status = statusOf(entry);
        return `${entry.source.id}:${status === "manual" ? "manual" : status.connection}`;
      })
      .join(",");
  let shownCalendars: string | undefined;
  let calendarSoon = false;
  const bumpCalendar = () => {
    calendarVersion = Math.max(calendarVersion + 1, Date.now());
    for (const listener of calendarListeners) {
      try {
        listener(calendarVersion);
      } catch (err) {
        log(`外部日历变了的通知出错：${describe(err)}`);
      }
    }
  };
  /** 交给日历的数据源的记录写进了新的（同步、设备交来、填设置时插件写的）：同一批只加一次 */
  const onRecord = (event: StoredEvent) => {
    if (calendarSoon) return;
    const hit = registry
      .list()
      .some((entry) => entry.source.calendar !== undefined && (entry.source.records ?? []).some((r) => r.type === event.type && (r.channel === undefined || r.channel === event.channel)));
    if (!hit) return;
    calendarSoon = true;
    queueMicrotask(() => {
      calendarSoon = false;
      bumpCalendar();
    });
  };

  // ---- 出错的自己回来（306 号票：每小时替它再试一次） ----

  /** 挂着再试的数据源（调度器的 key 是 data-source-retry:<id>）、正在再试的 */
  const retryArmed = new Set<string>();
  const retrying = new Set<Promise<void>>();
  /** 再试一次：有 recheck 的叫它（用存着的设置再测连接），没有的照同步那样同步一次；做完重挂定期导入、比一比（好了秘书重新拿到工具，没好再挂一小时） */
  const retryOnce = (id: string) => {
    retryArmed.delete(id);
    const entry = registry.get(id);
    if (!entry || !retryable(entry) || running.has(id)) return void noticeChanges();
    const { source } = entry;
    const run = (async () => {
      try {
        if (source.recheck) await source.recheck({ ...contextOf(entry), signal: stopping.signal });
        else await startSync(id, "scheduled", true);
        log(`数据源 ${id} 出错后每小时再试了一次`);
      } catch (err) {
        if (!stopping.signal.aborted) log(`数据源 ${id} 出错后再试没成：${redact(entry, describe(err))}`);
      }
    })().finally(() => {
      retrying.delete(run);
      if (stopping.signal.aborted) return;
      armJobs();
      noticeChanges();
    });
    retrying.add(run);
  };
  /** 出错、能再试的挂上一小时后的再试；不再出错的摘下 */
  const armRetries = () => {
    if (stopping.signal.aborted) return;
    for (const entry of registry.list()) {
      const { id } = entry.source;
      const want = retryable(entry);
      if (want && !retryArmed.has(id)) {
        retryArmed.add(id);
        options.scheduler.schedule(retryKey(id), Date.parse(options.now()) + RETRY_EVERY_MS, () => retryOnce(id));
      } else if (!want && retryArmed.has(id)) {
        retryArmed.delete(id);
        options.scheduler.cancel(retryKey(id));
      }
    }
  };

  /**
   * 给出去的按需查工具、交给日历的数据源变了才通知（别的插件起停、和它们无关的开关、什么都没变的同步不惊动谁）；
   * 顺带挂上、摘下出错后的每小时再试
   */
  const noticeChanges = () => {
    if (assembledToolOwners !== undefined && assembledToolOwners !== queryToolOwners()) options.contributions.refresh();
    const shape = calendarShape();
    if (shownCalendars !== undefined && shape !== shownCalendars) bumpCalendar();
    shownCalendars = shape;
    armRetries();
  };

  const refresh = () => {
    // 插件停了的：正在跑的同步中止
    for (const [id, run] of running) {
      const entry = registry.get(id);
      if (!entry || !entry.owner.running()) run.controller.abort();
    }
    armJobs();
    noticeChanges();
  };

  // ---- 导入文件夹 ----


  const scanOnce = async (retry: boolean) => {
    fs.mkdirSync(options.folder.imported, { recursive: true });
    const hints: ImportFileHint[] = [];
    const entries = registry.list();
    for (const file of listImportFiles(options.folder.imports)) {
      if (stopping.signal.aborted) break;
      const key = failureKey(file.name, file.size, file.mtimeMs);
      if (settleMs > 0 && Date.now() - file.mtimeMs < settleMs) {
        hints.push(hint(file.name, file.size, "busy", t("dataSources.folder.busy")));
        continue;
      }
      const failed = failures.get(key);
      if (failed !== undefined && !retry) {
        hints.push(hint(file.name, file.size, "failed", failed));
        continue;
      }
      const head = readHead(file.path);
      const matched: Array<{ entry: DataSourceEntry; type: DataSourceFileType }> = [];
      for (const entry of entries) {
        const type = (entry.source.files ?? []).find((ft) => fileTypeMatches(ft, file.name, head));
        if (type) matched.push({ entry, type });
      }
      if (matched.length === 0) {
        hints.push(hint(file.name, file.size, "unrecognized", t("dataSources.folder.unrecognized")));
        continue;
      }
      if (matched.length > 1) {
        hints.push(hint(file.name, file.size, "ambiguous", t("dataSources.folder.ambiguous", { sources: formatList(matched.map((m) => m.entry.source.title)) })));
        continue;
      }
      const { entry, type } = matched[0]!;
      if (!entry.owner.running()) {
        hints.push(hint(file.name, file.size, "plugin_off", t("dataSources.folder.pluginOff", { source: entry.source.title, reason: pluginOff(entry) })));
        continue;
      }
      if (!usageOn(entry, "import")) {
        hints.push(hint(file.name, file.size, "import_off", t("dataSources.folder.importOff", { source: entry.source.title })));
        continue;
      }
      // 先挪进"已导入"再导入（同一个文件不会被导两次）；挪不动的（被占着）下次再看
      let moved: string;
      try {
        moved = moveInto(file.path, options.folder.imported, file.name);
      } catch {
        hints.push(hint(file.name, file.size, "busy", t("dataSources.folder.busy")));
        continue;
      }
      try {
        const result = await type.import({ path: moved, name: file.name, size: file.size }, { ...contextOf(entry), signal: stopping.signal });
        const stored = path.relative(options.folder.imports, moved).split(path.sep).join("/");
        recordSync(entry, { trigger: "file", added: result.added, file: { name: file.name, stored }, ...(result.summary === undefined ? {} : { summary: result.summary }) });
        failures.delete(key);
        log(`导入文件夹：${file.name} 交给数据源 ${entry.source.id} 导入了 ${result.added} 条`);
      } catch (err) {
        // 导入出错：挪回原地（原名被占了就加序号），记下原因，自动再看时不重试
        let back = file.path;
        try {
          back = moveInto(moved, options.folder.imports, file.name);
        } catch (moveErr) {
          log(`导入文件夹：${file.name} 导入出错后挪不回去：${describe(moveErr)}`);
        }
        const text = t("dataSources.folder.failed", { reason: redact(entry, describe(err)) });
        const stat = fs.existsSync(back) ? fs.statSync(back) : undefined;
        failures.set(stat ? failureKey(path.basename(back), stat.size, stat.mtimeMs) : key, text);
        hints.push(hint(path.basename(back), file.size, "failed", text));
        log(`导入文件夹：${file.name} 交给数据源 ${entry.source.id} 导入出错：${redact(entry, describe(err))}`);
      }
    }
    pending = hints.toSorted((a, b) => a.name.localeCompare(b.name));
    scannedAt = options.now();
  };

  const scan = (opts: { retry?: boolean } = {}): Promise<void> => {
    const next = scanning.then(() => scanOnce(opts.retry === true));
    scanning = next.catch((err: unknown) => log(`看导入文件夹出错：${describe(err)}`));
    return next;
  };

  const act = async (id: string, body: DataSourceActionBody): Promise<DataSourceActionResult> => {
    const entry = entryOf(id);
    const { source } = entry;
    switch (body.action) {
      case "sync": {
        const waited = await waitSync(sync(id, "manual"));
        return { view: view(), ...(waited?.added === undefined ? {} : { added: waited.added }), ...(waited?.error === undefined ? {} : { error: waited.error }) };
      }
      case "usage": {
        if (!source.usages[body.usage]) throw new RequestRejected("not_allowed", t(body.usage === "query" ? "dataSources.noQuery" : "dataSources.noImport", { title: source.title }));
        settings.setUsage(id, body.usage, body.on);
        refresh();
        return { view: view() };
      }
      case "configure": {
        if (!source.configure) throw new RequestRejected("not_allowed", t("dataSources.notConfigurable", { title: source.title }));
        if (!entry.owner.running()) throw new RequestRejected("not_allowed", pluginOff(entry));
        let status: DataSourceStatus;
        try {
          status = await source.configure(body.values, contextOf(entry));
        } catch (err) {
          status = { connection: "error", problem: describe(err) };
        }
        // 出错的记下原因；连上了、或者填完是"没连"（297 号票：删掉了最后一个日历）的清掉
        if (status.connection === "error") configureProblems.set(id, redact(entry, status.problem ?? t("dataSources.configureFailed")));
        else configureProblems.delete(id);
        refresh();
        // 连上了、导入开着、数据源要的话马上同步一次（297 号票），和"立即同步"一样最多等一会儿
        if (status.connection === "connected" && source.usages.import?.syncOnConnect && source.sync && usageOn(entry, "import")) {
          const waited = await waitSync(sync(id, "manual"));
          return { view: view(), ...(waited?.added === undefined ? {} : { added: waited.added }), ...(waited?.error === undefined ? {} : { error: waited.error }) };
        }
        return { view: view() };
      }
      case "open": {
        // 在电脑上打开它的文件夹（307 号票：Looki 存到本地的位置），和导入文件夹的"在电脑上打开"同一个做法
        if (!source.localFolder) throw new RequestRejected("not_allowed", t("dataSources.noFolder", { title: source.title }));
        if (!entry.owner.running()) throw new RequestRejected("not_allowed", pluginOff(entry));
        try {
          const dir = source.localFolder(contextOf(entry));
          if (dir === undefined) return { view: view(), opened: false, error: t("dataSources.folder.openFailed", { reason: t("dataSources.noFolderYet") }) };
          await options.openFolder(dir);
          return { view: view(), opened: true };
        } catch (err) {
          return { view: view(), opened: false, error: t("dataSources.folder.openFailed", { reason: describe(err) }) };
        }
      }
      case "clear_raw": {
        if (!source.raw) throw new RequestRejected("not_allowed", t("dataSources.noRaw", { title: source.title }));
        if (!entry.owner.running()) throw new RequestRejected("not_allowed", pluginOff(entry));
        const cleared = source.raw.clear([...new Set(body.dates)], contextOf(entry));
        log(`数据源 ${id} 清掉了 ${body.dates.length} 天的原始数据（${cleared} 条）`);
        return { view: view(), cleared };
      }
      case "disconnect": {
        // 同一个幂等键重发：什么都不再做，只回第一次记下的
        const before = disconnectedBefore(store, body.idempotencyKey);
        if (before) return { view: view(), ...(before.counts ? { purged: before.counts } : {}) };
        const now = running.get(id);
        if (now) {
          now.controller.abort();
          await now.promise.catch(() => {});
        }
        if (entry.owner.running() && source.disconnect) {
          try {
            await source.disconnect({ ...contextOf(entry), purge: body.purge });
          } catch (err) {
            log(`数据源 ${id} 断开时插件自己的清理出错（照样断开）：${describe(err)}`);
          }
        }
        secrets.clear(id);
        configureProblems.delete(id);
        quietSyncs.delete(id);
        const record = recordDisconnect({ store, participants: options.participants, now: options.now, log }, { source: id, records: source.records ?? [], purge: body.purge }, body.idempotencyKey);
        refresh();
        return { view: view(), ...(record.counts ? { purged: record.counts } : {}) };
      }
    }
  };

  const folder = async (body: ImportFolderActionBody): Promise<ImportFolderActionResult> => {
    fs.mkdirSync(options.folder.imported, { recursive: true });
    if (body.action === "open") {
      try {
        await options.openFolder(options.folder.imports);
        return { view: view(), opened: true };
      } catch (err) {
        return { view: view(), opened: false, error: t("dataSources.folder.openFailed", { reason: describe(err) }) };
      }
    }
    await scan({ retry: true });
    return { view: view() };
  };

  const push = async (id: string, body: DataSourcePushBody): Promise<DataSourcePushResult> => {
    const entry = entryOf(id);
    const { source } = entry;
    // 同一个幂等键重发：不再收，回第一次记下的
    const done = store.eventByIdempotencyKey(pushKey(id, body.idempotencyKey));
    if (done) {
      const p = done.payload as DataSourceSyncedPayload;
      return { view: view(), ...(p.added === undefined ? {} : { added: p.added }), ...(p.summary === undefined ? {} : { summary: p.summary }), ...(p.reply === undefined ? {} : { reply: p.reply }), ...(p.error === undefined ? {} : { error: p.error }) };
    }
    if (!entry.owner.running()) throw new RequestRejected("not_allowed", pluginOff(entry));
    if (!source.push) throw new RequestRejected("not_allowed", t("dataSources.noPush", { title: source.title }));
    if (!usageOn(entry, "import")) throw new RequestRejected("not_allowed", t("dataSources.importOff", { title: source.title }));
    const checked = checkHttpBody(source.push.body, body.data);
    if (!checked.ok) throw new RequestRejected("bad_params", t("dataSources.badPush", { title: source.title, message: checked.message }));
    let outcome;
    try {
      outcome = await source.push.receive(checked.value, contextOf(entry));
    } catch (err) {
      if (err instanceof RequestRejected) throw err;
      const p = recordSync(entry, { trigger: "device", error: describe(err) }, pushKey(id, body.idempotencyKey));
      log(`数据源 ${id} 收设备交来的出错：${p.error}`);
      return { view: view(), error: p.error! };
    } finally {
      // 设备交来的可能改了连接状态（连上、授权被撤回）
      noticeChanges();
    }
    recordSync(
      entry,
      { trigger: "device", added: outcome.added, ...(outcome.summary === undefined ? {} : { summary: outcome.summary }), ...(outcome.reply === undefined ? {} : { reply: outcome.reply }) },
      pushKey(id, body.idempotencyKey),
    );
    return { view: view(), added: outcome.added, ...(outcome.summary === undefined ? {} : { summary: outcome.summary }), ...(outcome.reply === undefined ? {} : { reply: outcome.reply }) };
  };

  const calendarEvents = (from: Date, to: Date): CalendarExternalEntry[] =>
    registry.list().flatMap((entry) => {
      const { source } = entry;
      if (!source.calendar || !entry.owner.running()) return [];
      try {
        return source.calendar({ from, to }, contextOf(entry)).map((e): CalendarExternalEntry => ({ ...e, source: source.id, sourceTitle: source.title }));
      } catch (err) {
        log(`数据源 ${source.id} 的日程拿不到：${describe(err)}`);
        return [];
      }
    });

  let toolsUndo: (() => void) | undefined;
  return {
    view,
    act,
    folder,
    push,
    calendarEvents,
    calendarVersion: () => calendarVersion,
    onCalendarChange(listener) {
      calendarListeners.add(listener);
      return () => void calendarListeners.delete(listener);
    },
    sync,
    scan,
    refresh,
    start(startOptions = {}) {
      fs.mkdirSync(options.folder.imported, { recursive: true });
      toolsUndo = options.contributions.tools.register({ to: { agents: ["secretary"] }, tools: () => queryTools() });
      shownCalendars = calendarShape();
      teardown.push(store.onAppend(onRecord));
      armJobs();
      if (startOptions.scan !== false) void scan();
      const every = options.scanEveryMs ?? SCAN_EVERY_MS;
      if (every !== false) {
        const timer = setInterval(() => void scan(), every);
        timer.unref?.();
        teardown.push(() => clearInterval(timer));
        // 文件夹里一有变化过一会儿就看（复制大文件时会连着变好几次：最后一次之后 2 秒）
        try {
          let soon: ReturnType<typeof setTimeout> | undefined;
          const watcher = fs.watch(options.folder.imports, () => {
            clearTimeout(soon);
            soon = setTimeout(() => void scan(), 2_000);
            soon.unref?.();
          });
          watcher.on("error", () => {});
          teardown.push(() => {
            clearTimeout(soon);
            watcher.close();
          });
        } catch (err) {
          log(`监视不了导入文件夹（照样每隔一会儿看一遍）：${describe(err)}`);
        }
      }
    },
    async stop() {
      stopping.abort();
      for (const id of retryArmed) options.scheduler.cancel(retryKey(id));
      retryArmed.clear();
      await Promise.allSettled(retrying);
      for (const step of teardown.splice(0)) step();
      toolsUndo?.();
      for (const undo of jobs.values()) undo();
      jobs.clear();
      await Promise.allSettled([...running.values()].map((r) => r.promise));
      await scanning;
    },
    async whenIdle() {
      await scanning;
      while (retrying.size > 0) await Promise.allSettled(retrying);
      await Promise.allSettled([...running.values()].map((r) => r.promise));
    },
  };
}
