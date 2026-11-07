// 记忆插件自己的体检项（412）：记忆插件在 setup 里经 ctx.doctor.register 登记这六项（都是 passive：只读内存、文件、事件日志，
// 不开推理库、不联网、不调模型），插件停用时跟着撤、体检页上记忆那一块就没了。409 的框架见 doctor/checks.ts。
//
// 六项（id → 读什么 → 怎么判）：
// 1. index 向量索引：素材库现成的向量补算状态（materials.vectorStatus()：模型在不在、算了几条、还差几条、idle/running/等模型/error）。
//    出错 → 坏了；模型不在（等模型）→ 注意（只剩关键词检索，跳设置 · 组件）；还差的超过总数一成、又至少 INDEX_LAG_MIN 条 → 注意；
//    没在采集素材（插件在跑时不会）→ 不适用；别的正常。
// 2. graph 推理库：启动时打开推理库的结果（整理开着才开）、问记忆和每轮简报那份缓存引擎认定"一直用不了"的原因
//    （engine-provider.ts 新加的 issue()）、库文件在不在多大。要重建（版本对不上、没有 manifest）→ 坏了；打不开 → 坏了；
//    整理开着却没有库 → 坏了；整理关着又没有库 → 不适用；引擎认定"还没建库"之后库才有 → 注意（重启才用得上）；
//    别的正常（写在用 / 启动时核过 / 还没用过，和库多大）。
// 3. system 记忆系统：记忆插件槽里在跑的那一套（会意）自己报的健康——协议里早就有的 health()（注释写着"体检页显示"，
//    会意实现了、以前没人调）。没有在跑的 → 坏了（简报、记一句都用不了）；它报了问题 → 注意（原话照写）；别的正常
//    （有效证据几条、上次整理完的时间、占多大）。槽没接上（只有插件的测试）就不登记这一项。
// 4. brief 记忆简报：brief-stats.ts 的统计（最近 24 小时问了几次、超时几次、出错几次、最近一次用了多久；只在内存里，重启清零）。
//    记忆页关了简报 → 不适用；问够 BRIEF_MIN_ASKED 次、超时加出错占 BRIEF_BAD_RATIO（三成）以上 → 注意；别的正常。
// 5. nightly 每晚整理：事件日志里最近的整理记录（不读视图：视图一夜一条，后写的会盖掉先写的）和内部作业记着的时间（第一次见到）。
//    memory.enabled 关着 → 不适用；最近一条有结果的记录（不算推后）是失败、没 Key 跳过、要重建 → 坏了（从这一串没跑成的第一条起）；
//    最近一次跑成距今超过 NIGHTLY_STALE_HOURS（36 小时）→ 坏了；一次都没跑成、作业排上已超过 36 小时 → 坏了；
//    跑成了但中途超时过 → 注意：记录里有 timedOut 就按它（423 加的字段，有就用、没有照常），老记录按"同一夜定时 / 补跑的
//    跑成记录有两条、开始时间不同"认（423 之前超时后作业会再跑一遍）；别的正常（写跑成的时间、新出几条结论，记录里有 durationMs 写用了多久）。
// 6. presync 整理前的数据源导入：最近一条带整理前同步的整理记录（sourceSync，401 加的）。memory.enabled 关着、没有这种记录、
//    没有要先导入的数据源 → 不适用；有数据源没导成（出错、连接出错、等到上限还没导完）→ 注意；别的正常。
//
// 判法都是纯函数（交回 DoctorFinding：文案键 + 参数，键在 memory.json 的 memory.doctor.*；时间、数字、小句先按当前语言写好），
// 读现状的函数由 memoryDoctorChecks 的调用方（plugin.ts）注入，测试造假的。
import {
  activeLanguage,
  type DoctorAction,
  type DoctorMessage,
  formatNumber,
  isDeletedEventPayload,
  type MemoryHealth,
  type MemoryNightlySourceSyncItem,
  type MemoryProviderInfo,
  t,
} from "@ergo/protocol";
import { doctorTime } from "../doctor/auto.ts";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import type { EventStore } from "../events/event-store.ts";
import type { Materials } from "../materials/index.ts";
import { getJobState, INTERNAL_CHANNEL, type InternalJobState } from "../scheduler/internal-jobs.ts";
import type { BriefStatsSnapshot } from "./brief-stats.ts";
import type { MemoryEngineIssue } from "./engine-provider.ts";
import { MESSAGE_BRIEF_TIMEOUT_MS } from "./message-brief.ts";
import { MEMORY_NIGHTLY_JOB, reasoningIssueText } from "./nightly-job.ts";
import { MEMORY_NIGHTLY_EVENT, type MemoryNightlyRecord } from "./nightly-record.ts";
import type { ReasoningDbIssue } from "./rg-db.ts";

/** 向量还差的超过总数的这么多算落后 */
export const INDEX_LAG_RATIO = 0.1;
/** 向量还差至少这么多条才算落后（刚来一批素材、几秒就算完的不算） */
export const INDEX_LAG_MIN = 100;
/** 记忆简报超时加出错占这么多以上算注意（三成） */
export const BRIEF_BAD_RATIO = 0.3;
/** 记忆简报问够这么多次才判比例（一两次超时说明不了什么） */
export const BRIEF_MIN_ASKED = 5;
/** 最近一次整理跑成距今超过这么多小时算坏了（每晚一次，留出一夜推后、跑得慢的余量） */
export const NIGHTLY_STALE_HOURS = 36;
/** 往回读多少条整理记录（一夜一两条，够看一个月） */
const NIGHTLY_SCAN = 60;

const HOUR_MS = 3_600_000;

/** 动作按钮跳到的页：设置 · 组件、记忆页（简报的开关在最下面）、记忆管理员（整理记录）、设置 · 数据源 */
const COMPONENTS_ROUTE = "#/more/components";
const CURATOR_ROUTE = "#/more/memory/curator";
const DATA_SOURCES_ROUTE = "#/more/data-sources";
const open = (route: string): DoctorAction => ({ kind: "open", route });

/** 几个小句连成一句（中文用"，"，英文用", "） */
const clauses = (parts: readonly string[]) => parts.join(t("memory.doctor.sep"));

/** 字节写成 MB（一位小数） */
const megabytes = (bytes: number) => formatNumber(bytes / 1024 / 1024, { maximumFractionDigits: 1 });

/** 毫秒写成秒（一位小数） */
const seconds = (ms: number) => formatNumber(ms / 1000, { maximumFractionDigits: 1 });

// ───────── 1. 向量索引 ─────────

/** 素材库的向量补算状态（materials.vectorStatus()） */
export type VectorFacts = ReturnType<Materials["vectorStatus"]>;

export function indexFinding(status: VectorFacts): DoctorFinding {
  const total = status.indexed + status.pending;
  const params = { indexed: status.indexed, pending: status.pending, total, model: status.model };
  if (status.state === "off") return { level: "na", fact: { key: "memory.doctor.index.off" } };
  if (status.state === "error") return { level: "error", fact: { key: "memory.doctor.index.error", params }, fix: { key: "memory.doctor.fix.indexError" } };
  if (status.state === "waiting_for_model" || !status.available) {
    return { level: "warn", fact: { key: "memory.doctor.index.noModel", params }, fix: { key: "memory.doctor.fix.indexModel" }, action: open(COMPONENTS_ROUTE) };
  }
  const state = t(status.state === "running" ? "memory.doctor.index.running" : "memory.doctor.index.idle");
  if (status.pending >= INDEX_LAG_MIN && status.pending > total * INDEX_LAG_RATIO) {
    return { level: "warn", fact: { key: "memory.doctor.index.behind", params: { ...params, state } }, fix: { key: "memory.doctor.fix.indexBehind" } };
  }
  if (total === 0) return { level: "ok", fact: { key: "memory.doctor.index.empty" } };
  if (status.pending === 0) return { level: "ok", fact: { key: "memory.doctor.index.ok", params } };
  return { level: "ok", fact: { key: "memory.doctor.index.okPending", params: { ...params, state } } };
}

// ───────── 2. 推理库 ─────────

export interface GraphFacts {
  /** 这台机器上整理开着没有（配置 memory.enabled） */
  enabled: boolean;
  /** 启动时打开推理库没打开成的原因（整理开着才开；开成了、没开是 undefined） */
  setupIssue?: ReasoningDbIssue;
  /** 问记忆和每轮简报那份缓存引擎认定一直用不了的原因（engine-provider.ts 的 issue()） */
  engineIssue?: MemoryEngineIssue;
  /** 那份引擎开着没有 */
  opened: boolean;
  /** 推理库文件多大（字节）；文件不在、是空的是 undefined */
  bytes?: number;
}

/** 要重建的几种（版本对不上、没有 manifest）：不自动迁移 */
const needsRebuild = (issue: ReasoningDbIssue) => issue.code !== "open_failed";

export function graphFinding(facts: GraphFacts): DoctorFinding {
  const since = facts.engineIssue?.since;
  const at = since === undefined ? {} : { since };
  // 启动时就打不开的（整理开着时开过一次），和引擎后来认定的，哪个都算
  const issue = facts.setupIssue ?? (facts.engineIssue?.reason.code === "not_built" ? undefined : (facts.engineIssue?.reason as ReasoningDbIssue | undefined));
  if (issue !== undefined) {
    const reason = reasoningIssueText(issue);
    if (needsRebuild(issue)) return { level: "error", fact: { key: "memory.doctor.graph.rebuild", params: { reason } }, fix: { key: "memory.doctor.fix.graphRebuild" }, ...at };
    return { level: "error", fact: { key: "memory.doctor.graph.unusable", params: { reason } }, fix: { key: "memory.doctor.fix.graphOpen" }, ...at };
  }
  if (facts.bytes === undefined) {
    // 整理关着：不建库，问记忆和简报本来就是空的
    if (!facts.enabled) return { level: "na", fact: { key: "memory.doctor.graph.off" } };
    return { level: "error", fact: { key: "memory.doctor.graph.missing" }, fix: { key: "memory.doctor.fix.graphMissing" }, ...at };
  }
  const size = megabytes(facts.bytes);
  // 引擎用的时候还没有库、认定了不再去开，库是后来才有的：要重启才用得上
  if (facts.engineIssue?.reason.code === "not_built") return { level: "warn", fact: { key: "memory.doctor.graph.notLoaded", params: { size } }, fix: { key: "memory.doctor.fix.graphRestart" }, ...at };
  if (facts.opened) return { level: "ok", fact: { key: "memory.doctor.graph.inUse", params: { size } } };
  return { level: "ok", fact: { key: facts.enabled ? "memory.doctor.graph.checked" : "memory.doctor.graph.notOpened", params: { size } } };
}

// ───────── 3. 记忆系统（记忆插件槽里在跑的那一套） ─────────

/** 记忆系统的名字按当前语言 */
const systemName = (info: MemoryProviderInfo) => (activeLanguage().startsWith("zh") ? info.name.zh : info.name.en);

/** info：在跑的那一套（没有是 undefined）；health：它自己报的（没有在跑时不问） */
export function systemFinding(info: MemoryProviderInfo | undefined, health: MemoryHealth | undefined): DoctorFinding {
  if (info === undefined || health === undefined) return { level: "error", fact: { key: "memory.doctor.system.none" }, fix: { key: "memory.doctor.fix.systemNone" } };
  const name = systemName(info);
  const problems = (health.problems ?? []).filter((p) => p.trim() !== "");
  if (problems.length > 0) {
    return { level: "warn", fact: { key: "memory.doctor.system.problems", params: { name, problems: problems.join(t("memory.doctor.sep")) } }, fix: { key: "memory.doctor.fix.systemProblems" } };
  }
  const details = [
    t("memory.doctor.system.items", { items: health.items }),
    health.lastConsolidatedAt === undefined ? t("memory.doctor.system.neverConsolidated") : t("memory.doctor.system.consolidated", { time: doctorTime(health.lastConsolidatedAt) }),
    ...(health.bytes === undefined ? [] : [t("memory.doctor.system.size", { size: megabytes(health.bytes) })]),
  ];
  return { level: "ok", fact: { key: "memory.doctor.system.ok", params: { name, details: clauses(details) } } };
}

// ───────── 4. 记忆简报 ─────────

/** enabled：记忆页里记忆简报开着没有；stats：brief-stats.ts 的统计 */
export function briefFinding(enabled: boolean, stats: BriefStatsSnapshot): DoctorFinding {
  if (!enabled) return { level: "na", fact: { key: "memory.doctor.brief.off" } };
  const from = doctorTime(new Date(stats.from).toISOString());
  if (stats.asked === 0 || stats.last === undefined) return { level: "ok", fact: { key: "memory.doctor.brief.idle", params: { from } } };
  const bad = stats.timedOut + stats.failed;
  const ratio = bad / stats.asked;
  const params = {
    from,
    asked: stats.asked,
    timedOut: stats.timedOut,
    failed: stats.failed,
    ratio: formatNumber(ratio, { style: "percent", maximumFractionDigits: 0 }),
    last: seconds(stats.last.ms),
  };
  if (stats.asked >= BRIEF_MIN_ASKED && ratio >= BRIEF_BAD_RATIO) {
    return { level: "warn", fact: { key: "memory.doctor.brief.slow", params }, fix: { key: "memory.doctor.fix.briefSlow", params: { seconds: seconds(MESSAGE_BRIEF_TIMEOUT_MS) } } };
  }
  return { level: "ok", fact: { key: "memory.doctor.brief.ok", params } };
}

// ───────── 5、6. 每晚整理、整理前的数据源导入 ─────────

/**
 * 一条整理记录，加上 423 给记录加的两项（有就用、没有照常）：这一夜用了多久（毫秒）、有没有超时过
 * （consolidation 是到了墙钟上限、这一夜失败；curator 是记忆管理员那一轮先被停下、整理在后台跑完）
 */
export type NightlyRecordFacts = MemoryNightlyRecord & { durationMs?: number; timedOut?: string };

export interface NightlyFacts {
  /** 这台机器上整理开着没有（配置 memory.enabled） */
  enabled: boolean;
  /** 最近的整理记录（事件日志里的，早的在前；彻底删除换成删除标记的不在） */
  records: readonly NightlyRecordFacts[];
  /** 内部作业记着的（第一次见到、上一次开始跑）；没排过是 undefined */
  job?: InternalJobState;
}

/** 有结果的记录（推后的不算：推后是这一夜还没跑、或者已经跑过） */
const settled = (record: NightlyRecordFacts) => record.state !== "deferred";

/** 跑成的时间（记下这条的时间：跑完了才记） */
const doneAt = (record: NightlyRecordFacts) => Date.parse(record.at);

/** 423 之前的老记录：同一夜定时 / 补跑的跑成记录有两条、开始时间不同——头一遍超时后作业又跑了一遍（管理员补记调用次数的那条开始时间一样，不算） */
function reran(records: readonly NightlyRecordFacts[], night: string): boolean {
  const starts = new Set(records.filter((r) => r.night === night && r.state === "ran" && r.trigger !== "manual" && r.ranAt !== undefined).map((r) => r.ranAt));
  return starts.size > 1;
}

/** 上次跑成的那一小句（坏了时跟在原因后面） */
const lastOkText = (ran: NightlyRecordFacts | undefined) => (ran === undefined ? t("memory.doctor.nightly.neverOk") : t("memory.doctor.nightly.lastOk", { time: doctorTime(ran.at) }));

/** 没跑成的几种：事实和修法的键 */
const BAD_STATE: Partial<Record<MemoryNightlyRecord["state"], { fact: string; fix: string }>> = {
  failed: { fact: "memory.doctor.nightly.failed", fix: "memory.doctor.fix.nightlyFailed" },
  skipped: { fact: "memory.doctor.nightly.skipped", fix: "memory.doctor.fix.nightlySkipped" },
  rebuild_needed: { fact: "memory.doctor.nightly.rebuild", fix: "memory.doctor.fix.graphRebuild" },
};

/** now：此刻的毫秒时间戳 */
export function nightlyFinding(facts: NightlyFacts, now: number): DoctorFinding {
  if (!facts.enabled) return { level: "na", fact: { key: "memory.doctor.nightly.off" } };
  const records = facts.records;
  const latest = records.findLast(settled);
  const ran = records.findLast((r) => r.state === "ran");
  const action = open(CURATOR_ROUTE);

  // 最近一条有结果的是没跑成：从这一串没跑成的第一条起
  const bad = latest === undefined ? undefined : BAD_STATE[latest.state];
  if (latest !== undefined && bad !== undefined) {
    const after = ran === undefined ? records : records.slice(records.lastIndexOf(ran) + 1);
    const first = after.find(settled) ?? latest;
    const reason = latest.reason ?? t("memory.doctor.nightly.noReason");
    return { level: "error", fact: { key: bad.fact, params: { time: doctorTime(latest.at), reason, lastOk: lastOkText(ran) } }, fix: { key: bad.fix }, since: first.at, action };
  }

  if (ran === undefined) {
    // 一次都没跑成：作业排上超过 36 小时还没有，算坏了；刚装好的还没到第一次
    const since = facts.job?.since;
    if (since !== undefined && now - Date.parse(since) > NIGHTLY_STALE_HOURS * HOUR_MS) {
      return { level: "error", fact: { key: "memory.doctor.nightly.never", params: { time: doctorTime(since) } }, fix: { key: "memory.doctor.fix.nightlyStale" }, since, action };
    }
    return { level: "ok", fact: { key: "memory.doctor.nightly.notYet" } };
  }

  const hours = Math.floor((now - doneAt(ran)) / HOUR_MS);
  if (now - doneAt(ran) > NIGHTLY_STALE_HOURS * HOUR_MS) {
    return { level: "error", fact: { key: "memory.doctor.nightly.stale", params: { hours, time: doctorTime(ran.at) } }, fix: { key: "memory.doctor.fix.nightlyStale" }, since: ran.at, action };
  }

  const took = typeof ran.durationMs === "number" && ran.durationMs > 0 ? [t("memory.doctor.nightly.took", { minutes: Math.max(1, Math.round(ran.durationMs / 60_000)) })] : [];
  if (typeof ran.timedOut === "string" && ran.timedOut !== "") {
    const what = t(ran.timedOut === "curator" ? "memory.doctor.nightly.timedOutCurator" : "memory.doctor.nightly.timedOutOther");
    return { level: "warn", fact: { key: "memory.doctor.nightly.timedOut", params: { time: doctorTime(ran.at), details: clauses([what, ...took]) } }, fix: { key: "memory.doctor.fix.nightlyTimedOut" }, action };
  }
  if (reran(records, ran.night)) {
    return { level: "warn", fact: { key: "memory.doctor.nightly.reran", params: { night: ran.night } }, fix: { key: "memory.doctor.fix.nightlyTimedOut" }, action };
  }
  const details = [t("memory.doctor.nightly.newClaims", { claims: ran.newClaims }), ...took];
  return { level: "ok", fact: { key: "memory.doctor.nightly.ok", params: { time: doctorTime(ran.at), details: clauses(details) } } };
}

/** 整理前同步的一个数据源写成一小句：名字（新进来几条 / 刚同步过 / 出错原因 / 等了几分钟没导完） */
function syncItemText(item: MemoryNightlySourceSyncItem, waitMinutes: number): string {
  const name = item.title;
  switch (item.state) {
    case "synced":
      return t("memory.doctor.presync.item.synced", { name, added: item.added ?? 0 });
    case "fresh":
      return t("memory.doctor.presync.item.fresh", { name });
    case "timeout":
      return t("memory.doctor.presync.item.timeout", { name, minutes: waitMinutes });
    case "failed":
      return t("memory.doctor.presync.item.failed", { name, reason: item.reason ?? t("memory.doctor.nightly.noReason") });
    case "broken":
      return t("memory.doctor.presync.item.broken", { name, reason: item.reason ?? t("memory.doctor.nightly.noReason") });
  }
}

/** 没导成的几种：出错、连接出错、等到上限还没导完 */
const NOT_IMPORTED: ReadonlySet<MemoryNightlySourceSyncItem["state"]> = new Set(["failed", "broken", "timeout"]);

export function presyncFinding(facts: NightlyFacts): DoctorFinding {
  if (!facts.enabled) return { level: "na", fact: { key: "memory.doctor.nightly.off" } };
  const record = facts.records.findLast((r) => r.sourceSync !== undefined);
  if (record?.sourceSync === undefined) return { level: "na", fact: { key: "memory.doctor.presync.none" } };
  const { sources, waitMinutes } = record.sourceSync;
  if (sources.length === 0) return { level: "na", fact: { key: "memory.doctor.presync.noSources" } };
  const time = doctorTime(record.at);
  const bad = sources.filter((s) => NOT_IMPORTED.has(s.state));
  const sep = t("memory.doctor.listSep");
  if (bad.length > 0) {
    const list = bad.map((s) => syncItemText(s, waitMinutes)).join(sep);
    return { level: "warn", fact: { key: "memory.doctor.presync.bad", params: { time, count: bad.length, list } }, fix: { key: "memory.doctor.fix.presync" }, since: record.at, action: open(DATA_SOURCES_ROUTE) };
  }
  return { level: "ok", fact: { key: "memory.doctor.presync.ok", params: { time, list: sources.map((s) => syncItemText(s, waitMinutes)).join(sep) } } };
}

/** 事件日志里最近的整理记录（早的在前；换成删除标记的、不像样的跳过） */
export function recentNightlyRecords(store: Pick<EventStore, "readBefore">, limit = NIGHTLY_SCAN): NightlyRecordFacts[] {
  return store
    .readBefore(INTERNAL_CHANNEL, Number.MAX_SAFE_INTEGER, limit, MEMORY_NIGHTLY_EVENT)
    .filter((event) => !isDeletedEventPayload(event.payload))
    .map((event) => event.payload as NightlyRecordFacts)
    .filter((record) => typeof record.night === "string" && typeof record.at === "string" && typeof record.state === "string");
}

// ───────── 登记 ─────────

/** 体检读现状要的（plugin.ts 注入，测试造假的） */
export interface MemoryDoctorDeps {
  /** 素材库的向量补算状态 */
  vectors: () => VectorFacts;
  /** 推理库的现状 */
  graph: () => GraphFacts;
  /** 记忆插件槽里在跑的那一套；没接上槽（只有插件的测试）就不给，这一项不登记 */
  system?: { info: () => MemoryProviderInfo | undefined; health: () => Promise<MemoryHealth> };
  /** 记忆页里记忆简报开着没有 */
  briefEnabled: () => boolean;
  /** 记忆简报的统计 */
  briefStats: () => BriefStatsSnapshot;
  /** 这台机器上整理开着没有（配置 memory.enabled） */
  enabled: () => boolean;
  /** 事件日志：读整理记录、内部作业的时间 */
  store: Pick<EventStore, "readBefore" | "reader">;
  /** 此刻（毫秒时间戳） */
  now: () => number;
}

/** 整理记录和作业的时间（每晚整理、整理前导入两项各读一遍：都很快） */
function nightlyFacts(deps: MemoryDoctorDeps): NightlyFacts {
  const job = getJobState(deps.store.reader, MEMORY_NIGHTLY_JOB);
  return { enabled: deps.enabled(), records: recentNightlyRecords(deps.store), ...(job === undefined ? {} : { job }) };
}

/** 一项的名字 */
const title = (id: string): DoctorMessage["key"] => `memory.doctor.${id}.title`;

/** 记忆插件的体检项（按这个先后登记；页面上同一档照这个先后） */
export function memoryDoctorChecks(deps: MemoryDoctorDeps): DoctorCheck[] {
  const system = deps.system;
  return [
    { id: "index", title: title("index"), cost: "passive", run: () => indexFinding(deps.vectors()) },
    { id: "graph", title: title("graph"), cost: "passive", run: () => graphFinding(deps.graph()) },
    ...(system === undefined
      ? []
      : [
          {
            id: "system",
            title: title("system"),
            cost: "passive" as const,
            run: async () => {
              const info = system.info();
              return systemFinding(info, info === undefined ? undefined : await system.health());
            },
          },
        ]),
    { id: "brief", title: title("brief"), cost: "passive", run: () => briefFinding(deps.briefEnabled(), deps.briefStats()) },
    { id: "nightly", title: title("nightly"), cost: "passive", run: () => nightlyFinding(nightlyFacts(deps), deps.now()) },
    { id: "presync", title: title("presync"), cost: "passive", run: () => presyncFinding(nightlyFacts(deps)) },
  ];
}
