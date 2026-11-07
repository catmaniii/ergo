// 体检"二狗本身"的新检查（二）（411）：备份、定时触发的任务、内部作业、卡住的 agent 和名额、日志大小、配置文件、缺的 skill，
// 加三项提示（待办、手机 App 版本、数据库的预写日志）。组合根（daemon.ts）把各模块现成的状态交进来，登记成内核的检查项
// （checks.ts 的登记表，不带插件名，放"二狗本身"那一块）。都是 passive：只读内存和本机文件，不联网、不调模型、不改东西。
//
// 判法（几级、事实、怎么修），每条一个纯函数，测试直接喂假的状态：
// - 备份（backupFinding）：一次都没成过——最近一次失败了、或者等第一次已经超过 48 小时——坏了；最近一次失败（本机快照没做成，
//   或者写进另存的文件夹失败）注意，事实写失败原因原文；超过 48 小时没成功（OVERDUE_AFTER_MS，和"连着两天没人备份"的提醒同一个数）
//   注意，从上次成功起；最近一次做成了但跳过了被占着的文件（422 加的 skipped，有就算）注意；最近一次校验没通过注意；
//   还没备份过、第一次还没到点的正常。
// - 定时触发的任务（triggersFinding）：连续失败被自动暂停、还没恢复的；运行中超过 TRIGGER_RUN_STUCK_MS、排队超过
//   TRIGGER_QUEUE_STUCK_MS 的运行——有就注意，事实逐个列，动作跳到第一个。
// - 内部作业（internalJobsFinding）：登记着的里上一次出错的（internal-jobs.ts 记的结局）注意，事实写哪个、什么时候、出错原文。
//   夜里整理这种自己收尾、不抛错的作业，它的结局（用了多久、超没超时）在它自己的记录里，由记忆插件的体检项看（412），这里不重复。
// - 卡住的 agent、名额（agentsFinding）：在一轮里、停在同一步超过"单次模型调用 + 工具调用"两段超时之和（agent-manager 的 AgentStep；
//   在等的工具声明了更长的超时按它的，不按超时算的不判，在等用户批准的不算）注意；活着的子进程到了上限的九成注意。
// - 日志大小（logSizeFinding）：服务管家的日志目录和数据目录的日志里，单个文件超过 LOG_FILE_WARN_BYTES 注意，事实写哪个文件多大。
// - 配置文件（configFinding）：mcp.json 读不出来（文件里的 MCP 都用不了）、模型设置文件读不出来（在用默认）、MCP 要的凭据
//   在二狗的环境里没有——有就注意，事实写哪个文件、什么问题。
// - 缺的 skill（skillsFinding）：合集的清单（ergo-collection.json 的 members）里写着、库里认不出来的成员；在跑的项目和没结束的任务的
//   工具包、给助手选的 skill 名单里写着、库里没有的——有就注意，事实列名字和出处。只读，不动 skill 库。
// - 提示（"提示"不是一种结果：结果都是正常，不拉低总状态，事实里写数）：待办几条、其中待审批几条（pendingFinding）；没吊销的手机里
//   App 比最低版本旧的有几台（appVersionFinding；没有配对的手机不适用）；数据库的预写日志超过 WAL_HINT_BYTES 的（walFinding）。
//
// 句子：事实、修法交文案键 + 参数（doctor.json），参数里的时间、大小、小句子按当前语言先写好（和 auto.ts 一样）。
import fs from "node:fs";
import path from "node:path";
import {
  appVersionOutdated,
  type BackupRunRecord,
  type DoctorAction,
  type DoctorMessage,
  formatList,
  formatNumber,
  type JobRun,
  MIN_APP_VERSION,
  type PairedDevice,
  type ScheduledJob,
  t,
} from "@ergo/protocol";
import type { AgentManagerDoctorFacts } from "../agent-manager/agent-manager.ts";
import { type BackupDoctorFacts, OVERDUE_AFTER_MS } from "../backup/backup.ts";
import type { InternalJobState } from "../scheduler/internal-jobs.ts";
import { doctorTime } from "./auto.ts";
import type { DoctorCheck, DoctorFinding } from "./checks.ts";

/** 定时触发的任务的一次运行：运行中超过这么久算卡住 */
export const TRIGGER_RUN_STUCK_MS = 3 * 3_600_000;
/** 排队超过这么久还没开始算卡住 */
export const TRIGGER_QUEUE_STUCK_MS = 3_600_000;
/** 活着的子进程到了上限的这么多算快满了 */
export const AGENT_SLOTS_WARN_RATIO = 0.9;
/** 单个日志文件超过这么大算太大（服务管家还不会自己切分日志） */
export const LOG_FILE_WARN_BYTES = 200 * 1024 ** 2;
/** 数据库的预写日志（-wal 文件）超过这么大提示一句 */
export const WAL_HINT_BYTES = 256 * 1024 ** 2;
/** 事实里一样东西最多列几个（多了写"等 N 个"） */
const LIST_MAX = 5;

const BACKUP_ROUTE = "#/more/backup";
const SKILLS_ROUTE = "#/more/skills";
const MODELS_ROUTE = "#/more/models";
const DEVICES_ROUTE = "#/more/devices";
const INBOX_ROUTE = "#/inbox";

const open = (route: string): DoctorAction => ({ kind: "open", route });
const msg = (key: string, params?: DoctorMessage["params"]): DoctorMessage => (params === undefined ? { key } : { key, params });

/** 字节数写成"265 MB""1.2 GB"（按当前语言的数字写法） */
export function sizeText(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) return t("doctor.size.gb", { n: formatNumber(mb / 1024, { maximumFractionDigits: 1 }) });
  return t("doctor.size.mb", { n: formatNumber(mb, { maximumFractionDigits: mb >= 10 ? 0 : 1 }) });
}

/** 时长写成"3 小时""25 分钟"（一小时以上按小时，往下取整） */
export function durationText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return t("doctor.duration.hours", { count: hours });
  }
  return t("doctor.duration.minutes", { count: minutes });
}

/** 列一串：最多 LIST_MAX 个，多了写"……等 N 个" */
function listOf(items: readonly string[]): string {
  if (items.length <= LIST_MAX) return formatList(items);
  return t("doctor.list.more", { items: formatList(items.slice(0, LIST_MAX)), count: items.length });
}

/** 几句话接成一段（各条问题之间） */
const joined = (lines: readonly string[]) => lines.join(t("doctor.list.sep"));

// ───────── 备份 ─────────

/** 422 起记录里可能有的"跳过了哪些被占着的文件"（这边不依赖它的类型：字段不在时照常） */
interface SkippedPart {
  count: number;
  files: ReadonlyArray<{ path: string; reason?: string }>;
}

function skippedOf(record: BackupRunRecord | undefined): SkippedPart | undefined {
  const skipped = (record as { skipped?: unknown } | undefined)?.skipped;
  if (typeof skipped !== "object" || skipped === null) return undefined;
  const { count, files } = skipped as Partial<SkippedPart>;
  if (typeof count !== "number" || count <= 0) return undefined;
  return { count, files: Array.isArray(files) ? files.filter((f) => typeof f?.path === "string") : [] };
}

const recordFailed = (record: BackupRunRecord) => record.local === "failed" || record.sync === "failed";

/** 备份那一项（now：此刻的毫秒时间戳） */
export function backupFinding(facts: BackupDoctorFacts, now: number): DoctorFinding {
  const { last, lastOkAt } = facts;
  const action = open(BACKUP_ROUTE);
  const failedFix = msg("doctor.fix.backupFailed");
  const lastTime = last ? doctorTime(last.finishedAt) : "";
  // 一次都没成过
  if (lastOkAt === undefined) {
    if (last && recordFailed(last)) return { level: "error", fact: msg("doctor.backup.neverFailed", { time: lastTime, error: last.error ?? "" }), fix: failedFix, action };
    const waited = facts.watchingSince === undefined ? 0 : now - Date.parse(facts.watchingSince);
    if (!facts.running && waited > OVERDUE_AFTER_MS) {
      return { level: "error", fact: msg("doctor.backup.never", { duration: durationText(waited) }), fix: msg("doctor.fix.backupStale"), since: facts.watchingSince!, action };
    }
    return { level: "ok", fact: facts.next ? msg("doctor.backup.notYet", { time: doctorTime(facts.next) }) : msg("doctor.backup.notYetNoNext") };
  }
  // 最近一次失败了：本机快照没做成、写进另存的文件夹失败
  if (last && last.local === "failed") {
    const fact = facts.latestLocal
      ? msg("doctor.backup.failedLatest", { time: lastTime, error: last.error ?? "", date: facts.latestLocal })
      : msg("doctor.backup.failed", { time: lastTime, error: last.error ?? "" });
    return { level: "warn", fact, fix: failedFix, action };
  }
  if (last && last.sync === "failed") return { level: "warn", fact: msg("doctor.backup.syncFailed", { time: lastTime, error: last.error ?? "" }), fix: failedFix, action };
  // 太久没成功
  const sinceOk = now - Date.parse(lastOkAt);
  if (!facts.running && sinceOk > OVERDUE_AFTER_MS) {
    return { level: "warn", fact: msg("doctor.backup.stale", { duration: durationText(sinceOk), time: doctorTime(lastOkAt) }), fix: msg("doctor.fix.backupStale"), since: lastOkAt, action };
  }
  // 做成了，但有被占着的文件没收进去（422）
  const skipped = skippedOf(last);
  if (last && skipped) {
    const files = skipped.files.map((f) => f.path);
    const fact = files.length > 0 ? msg("doctor.backup.skipped", { time: lastTime, count: skipped.count, files: listOf(files) }) : msg("doctor.backup.skippedNoList", { time: lastTime, count: skipped.count });
    return { level: "warn", fact, fix: msg("doctor.fix.backupSkipped"), action };
  }
  // 最近一次校验没通过
  const bad = facts.lastVerify?.checks.filter((check) => check.problems.length > 0) ?? [];
  if (facts.lastVerify && bad.length > 0) {
    const places = bad.map((check) =>
      t("doctor.backup.verifyPlace", { place: t(check.location === "local" ? "doctor.backup.placeLocal" : "doctor.backup.placeSync"), date: check.date, problems: listOf(check.problems) }),
    );
    return { level: "warn", fact: msg("doctor.backup.verifyFailed", { time: doctorTime(facts.lastVerify.finishedAt), places: joined(places) }), fix: msg("doctor.fix.backupVerify"), action };
  }
  return { level: "ok", fact: msg("doctor.backup.ok", { time: doctorTime(lastOkAt) }) };
}

// ───────── 定时触发的任务 ─────────

/** 定时触发的任务那一项要的：被自动暂停的作业、还在排队或运行中的运行（带上它属于的作业） */
export interface TriggerFacts {
  autoPaused: readonly ScheduledJob[];
  open: ReadonlyArray<{ run: JobRun; job: ScheduledJob | undefined }>;
}

/** 作业在网页上的位置：项目内部的在项目页上，别的在看板上 */
const jobRoute = (job: Pick<ScheduledJob, "id" | "projectId">) => (job.projectId ? `#/projects/${encodeURIComponent(job.projectId)}/jobs/${encodeURIComponent(job.id)}` : `#/tasks/jobs/${encodeURIComponent(job.id)}`);

export function triggersFinding(facts: TriggerFacts, now: number): DoctorFinding {
  const lines: string[] = [];
  let first: Pick<ScheduledJob, "id" | "projectId"> | undefined;
  for (const job of facts.autoPaused) {
    first ??= job;
    const reason = job.lastRun?.reason;
    lines.push(
      reason
        ? t("doctor.triggers.paused", { title: job.title, count: job.consecutiveFailures, reason })
        : t("doctor.triggers.pausedNoReason", { title: job.title, count: job.consecutiveFailures }),
    );
  }
  for (const { run, job } of facts.open) {
    const title = job?.title ?? run.jobId;
    if (run.state === "running" && run.startedAt !== undefined && now - Date.parse(run.startedAt) > TRIGGER_RUN_STUCK_MS) {
      lines.push(t("doctor.triggers.running", { title, duration: durationText(now - Date.parse(run.startedAt)), time: doctorTime(run.startedAt) }));
    } else if (run.state === "queued" && now - Date.parse(run.queuedAt) > TRIGGER_QUEUE_STUCK_MS) {
      lines.push(t("doctor.triggers.queued", { title, duration: durationText(now - Date.parse(run.queuedAt)) }));
    } else continue;
    first ??= job ?? { id: run.jobId };
  }
  if (lines.length === 0) return { level: "ok", fact: msg("doctor.triggers.ok") };
  return { level: "warn", fact: msg("doctor.triggers.bad", { count: lines.length, items: joined(lines) }), fix: msg("doctor.fix.triggers"), ...(first ? { action: open(jobRoute(first)) } : {}) };
}

// ───────── 内部作业 ─────────

/** 内部作业给人看的名字（不认得的写作业名本身） */
export function internalJobName(name: string): string {
  if (name.startsWith("data-source:")) return t("doctor.internalJob.dataSource", { id: name.slice("data-source:".length) });
  const key = INTERNAL_JOB_KEYS[name];
  return key === undefined ? name : t(key);
}

const INTERNAL_JOB_KEYS: Readonly<Record<string, string>> = {
  backup: "doctor.internalJob.backup",
  verify_snapshot: "doctor.internalJob.verifySnapshot",
  clean_tmp: "doctor.internalJob.cleanTmp",
  backup_overdue_check: "doctor.internalJob.backupOverdue",
  component_update_check: "doctor.internalJob.componentUpdate",
  folder_grant_expiry_check: "doctor.internalJob.folderGrantExpiry",
  tool_call_detail_retention: "doctor.internalJob.detailRetention",
  memory_interview_invite: "doctor.internalJob.interviewInvite",
  "memory-nightly": "doctor.internalJob.memoryNightly",
  archive_list: "doctor.internalJob.archiveList",
  holiday_data_check: "doctor.internalJob.holidayCheck",
};

export function internalJobsFinding(states: readonly InternalJobState[]): DoctorFinding {
  const failed = states.filter((state) => state.lastOutcome === "failed");
  if (failed.length === 0) return { level: "ok", fact: msg("doctor.internalJobs.ok", { count: states.length }) };
  const lines = failed.map((state) =>
    t("doctor.internalJobs.failed", { name: internalJobName(state.job), time: doctorTime(state.lastEndedAt ?? state.lastRunAt ?? state.since), error: state.lastError ?? "" }),
  );
  return { level: "warn", fact: msg("doctor.internalJobs.bad", { count: failed.length, items: joined(lines) }), fix: msg("doctor.fix.internalJobs") };
}

// ───────── 卡住的 agent、名额 ─────────

/** 一个 agent 给人看的名字，和点了去它对话的地址（不认得的没有地址） */
export interface AgentLabel {
  name: string;
  route?: string;
}

export function agentsFinding(facts: AgentManagerDoctorFacts, labelOf: (agentId: string) => AgentLabel): DoctorFinding {
  const lines: string[] = [];
  let route: string | undefined;
  for (const step of facts.steps) {
    if (step.limitMs === null || step.forMs <= step.limitMs) continue;
    const label = labelOf(step.agentId);
    route ??= label.route;
    const doing = step.detail.kind === "calling_tool" ? t("doctor.stuckAgents.tool", { tool: step.detail.tool ?? "" }) : t("doctor.stuckAgents.model");
    lines.push(t("doctor.stuckAgents.stuck", { name: label.name, doing, duration: durationText(step.forMs), limit: durationText(step.limitMs) }));
  }
  const stuck = lines.length;
  const full = facts.maxLive > 0 && facts.live >= Math.ceil(facts.maxLive * AGENT_SLOTS_WARN_RATIO);
  if (full) lines.push(facts.queued > 0 ? t("doctor.stuckAgents.fullQueued", { live: facts.live, max: facts.maxLive, queued: facts.queued }) : t("doctor.stuckAgents.full", { live: facts.live, max: facts.maxLive }));
  if (lines.length === 0) return { level: "ok", fact: msg("doctor.stuckAgents.ok", { live: facts.live, max: facts.maxLive }) };
  const fixes = [...(stuck > 0 ? [t("doctor.stuckAgents.fixStuck")] : []), ...(full ? [t("doctor.stuckAgents.fixFull")] : [])];
  return { level: "warn", fact: msg("doctor.stuckAgents.bad", { items: joined(lines) }), fix: msg("doctor.fix.steps", { steps: fixes.join(" ") }), ...(route ? { action: open(route) } : {}) };
}

// ───────── 日志大小 ─────────

/** 看哪个目录：服务管家的日志目录、数据目录的日志区 */
export interface LogDir {
  kind: "supervisor" | "data";
  dir: string;
}

/** 一个日志文件 */
export interface LogFile {
  kind: LogDir["kind"];
  file: string;
  bytes: number;
}

/** 列日志目录里的文件和大小（往下看两层；目录不在、读不了的跳过） */
export function listLogFiles(dirs: readonly LogDir[]): LogFile[] {
  const files: LogFile[] = [];
  const walk = (kind: LogDir["kind"], dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) walk(kind, full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = fs.statSync(full, { throwIfNoEntry: false })?.size;
      if (size !== undefined) files.push({ kind, file: full, bytes: size });
    }
  };
  for (const { kind, dir } of dirs) walk(kind, dir, 0);
  return files;
}

export function logSizeFinding(files: readonly LogFile[]): DoctorFinding {
  const big = files.filter((f) => f.bytes > LOG_FILE_WARN_BYTES).toSorted((a, b) => b.bytes - a.bytes);
  if (big.length === 0) {
    const largest = files.toSorted((a, b) => b.bytes - a.bytes)[0];
    if (!largest) return { level: "ok", fact: msg("doctor.logSize.none") };
    return { level: "ok", fact: msg("doctor.logSize.ok", { limit: sizeText(LOG_FILE_WARN_BYTES), name: path.basename(largest.file), size: sizeText(largest.bytes) }) };
  }
  const lines = big.map((f) => t("doctor.logSize.file", { file: f.file, size: sizeText(f.bytes), where: t(f.kind === "supervisor" ? "doctor.logSize.supervisor" : "doctor.logSize.data") }));
  return { level: "warn", fact: msg("doctor.logSize.bad", { limit: sizeText(LOG_FILE_WARN_BYTES), items: joined(lines) }), fix: msg("doctor.fix.logSize") };
}

// ───────── 配置文件 ─────────

/** 配置文件那一项要的：mcp.json 的问题、模型设置文件的问题、缺凭据的 MCP */
export interface ConfigFacts {
  mcpProblem?: string;
  modelSettings?: { file: string; error: string };
  missingEnv: ReadonlyArray<{ title: string; variables: readonly string[] }>;
}

export function configFinding(facts: ConfigFacts): DoctorFinding {
  const lines: string[] = [];
  const fixes: string[] = [];
  let route: string | undefined;
  if (facts.mcpProblem !== undefined) {
    lines.push(t("doctor.configFiles.mcp", { problem: facts.mcpProblem }));
    fixes.push(t("doctor.configFiles.fixMcp"));
    route ??= SKILLS_ROUTE;
  }
  if (facts.modelSettings) {
    lines.push(t("doctor.configFiles.model", { file: facts.modelSettings.file, error: facts.modelSettings.error }));
    fixes.push(t("doctor.configFiles.fixModel"));
    route ??= MODELS_ROUTE;
  }
  if (facts.missingEnv.length > 0) {
    for (const mcp of facts.missingEnv) lines.push(t("doctor.configFiles.mcpEnv", { name: mcp.title, variables: formatList(mcp.variables) }));
    fixes.push(t("doctor.configFiles.fixMcpEnv"));
    route ??= SKILLS_ROUTE;
  }
  if (lines.length === 0) return { level: "ok", fact: msg("doctor.configFiles.ok") };
  return { level: "warn", fact: msg("doctor.configFiles.bad", { items: joined(lines) }), fix: msg("doctor.fix.steps", { steps: fixes.join(" ") }), ...(route ? { action: open(route) } : {}) };
}

// ───────── 缺的 skill ─────────

/** 缺的 skill 那一项要的：合集里认不出来的成员；装配清单（工具包、给助手选的名单）里写着、库里没有的，出处已经按当前语言写好 */
export interface SkillFacts {
  collections: ReadonlyArray<{ collection: string; members: readonly string[] }>;
  lists: ReadonlyArray<{ where: string; names: readonly string[] }>;
}

export function skillsFinding(facts: SkillFacts): DoctorFinding {
  const lines = [
    ...facts.collections.filter((c) => c.members.length > 0).map((c) => t("doctor.missingSkills.collection", { collection: c.collection, names: listOf(c.members) })),
    ...facts.lists.filter((l) => l.names.length > 0).map((l) => t("doctor.missingSkills.list", { where: l.where, names: listOf(l.names) })),
  ];
  if (lines.length === 0) return { level: "ok", fact: msg("doctor.missingSkills.ok") };
  const fixes = [
    ...(facts.collections.some((c) => c.members.length > 0) ? [t("doctor.missingSkills.fixCollection")] : []),
    ...(facts.lists.some((l) => l.names.length > 0) ? [t("doctor.missingSkills.fixList")] : []),
  ];
  return { level: "warn", fact: msg("doctor.missingSkills.bad", { items: joined(lines) }), fix: msg("doctor.fix.steps", { steps: fixes.join(" ") }), action: open(SKILLS_ROUTE) };
}

// ───────── 提示：待办、手机 App 版本、数据库的预写日志 ─────────

/** 待办几条（没处理、没归档的），其中待审批几条 */
export function pendingFinding(facts: { open: number; approvals: number }): DoctorFinding {
  if (facts.open === 0 && facts.approvals === 0) return { level: "ok", fact: msg("doctor.pending.none") };
  const fact = facts.approvals > 0 ? msg("doctor.pending.withApprovals", { count: facts.open, approvals: facts.approvals }) : msg("doctor.pending.some", { count: facts.open });
  return { level: "ok", fact, action: open(INBOX_ROUTE) };
}

/** 手机 App 的版本：没吊销、没删的设备里报过版本的；比最低版本旧的提示一句 */
export function appVersionFinding(devices: readonly Pick<PairedDevice, "name" | "revoked" | "deletedAt" | "appVersion">[], min: string = MIN_APP_VERSION): DoctorFinding {
  const paired = devices.filter((device) => !device.revoked && device.deletedAt === undefined);
  if (paired.length === 0) return { level: "na", fact: msg("doctor.appVersion.noDevices") };
  const reported = paired.filter((device) => device.appVersion !== undefined);
  if (reported.length === 0) return { level: "ok", fact: msg("doctor.appVersion.noReports") };
  const old = reported.filter((device) => appVersionOutdated(device.appVersion!, min));
  if (old.length === 0) return { level: "ok", fact: msg("doctor.appVersion.ok", { count: reported.length, min }) };
  const list = listOf(old.map((device) => t("doctor.appVersion.device", { name: device.name, version: device.appVersion! })));
  return { level: "ok", fact: msg("doctor.appVersion.old", { count: old.length, min, devices: list }), fix: msg("doctor.fix.appVersion"), action: open(DEVICES_ROUTE) };
}

/** 一个数据库的预写日志 */
export interface WalFile {
  /** 数据库文件名（ergo.db） */
  db: string;
  bytes: number;
}

/** 数据库区里各个数据库的预写日志（<名字>-wal）有多大；目录读不了是空的 */
export function listWalFiles(dbDir: string): WalFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dbDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith("-wal"))
    .flatMap((name) => {
      const size = fs.statSync(path.join(dbDir, name), { throwIfNoEntry: false })?.size;
      return size === undefined ? [] : [{ db: name.slice(0, -"-wal".length), bytes: size }];
    });
}

export function walFinding(files: readonly WalFile[]): DoctorFinding {
  const big = files.filter((f) => f.bytes > WAL_HINT_BYTES).toSorted((a, b) => b.bytes - a.bytes);
  if (big.length > 0) {
    const list = listOf(big.map((f) => t("doctor.dbWal.file", { db: f.db, size: sizeText(f.bytes) })));
    return { level: "ok", fact: msg("doctor.dbWal.big", { files: list, limit: sizeText(WAL_HINT_BYTES) }), fix: msg("doctor.fix.dbWal") };
  }
  const largest = files.toSorted((a, b) => b.bytes - a.bytes)[0];
  return { level: "ok", fact: largest ? msg("doctor.dbWal.ok", { size: sizeText(largest.bytes) }) : msg("doctor.dbWal.none") };
}

// ───────── 登记成检查项 ─────────

/** 组合根交进来的现成状态（每样现取；不给的那一项不登记） */
export interface HousekeepingSources {
  /** 此刻（毫秒）；组合根给守护进程的时钟 */
  now: () => number;
  backup?: () => BackupDoctorFacts;
  triggers?: () => TriggerFacts;
  internalJobs?: () => readonly InternalJobState[];
  agents?: () => AgentManagerDoctorFacts;
  agentLabel?: (agentId: string) => AgentLabel;
  logDirs?: () => readonly LogDir[];
  config?: () => ConfigFacts;
  skills?: () => SkillFacts;
  pending?: () => { open: number; approvals: number };
  devices?: () => readonly PairedDevice[];
  /** 数据库区（db/） */
  dbDir?: () => string;
}

/** 检查项的 id（"二狗本身"那一块里唯一，和原来八项、410 的不撞） */
export const HOUSEKEEPING_CHECK_IDS = ["backup", "triggers", "internal-jobs", "stuck-agents", "log-size", "config-files", "missing-skills", "pending", "app-version", "db-wal"] as const;

const check = (id: (typeof HOUSEKEEPING_CHECK_IDS)[number], title: string, run: () => DoctorFinding): DoctorCheck => ({ id, title, cost: "passive", run });

/** 交进来几样就登记几项（先后照 HOUSEKEEPING_CHECK_IDS：要注意的在前，三项提示在最后） */
export function housekeepingChecks(sources: HousekeepingSources): DoctorCheck[] {
  const { now } = sources;
  const checks: DoctorCheck[] = [];
  const { backup, triggers, internalJobs, agents, logDirs, config, skills, pending, devices, dbDir } = sources;
  if (backup) checks.push(check("backup", "doctor.check.backup.title", () => backupFinding(backup(), now())));
  if (triggers) checks.push(check("triggers", "doctor.check.triggers.title", () => triggersFinding(triggers(), now())));
  if (internalJobs) checks.push(check("internal-jobs", "doctor.check.internalJobs.title", () => internalJobsFinding(internalJobs())));
  if (agents) checks.push(check("stuck-agents", "doctor.check.stuckAgents.title", () => agentsFinding(agents(), sources.agentLabel ?? ((agentId) => ({ name: agentId })))));
  if (logDirs) checks.push(check("log-size", "doctor.check.logSize.title", () => logSizeFinding(listLogFiles(logDirs()))));
  if (config) checks.push(check("config-files", "doctor.check.configFiles.title", () => configFinding(config())));
  if (skills) checks.push(check("missing-skills", "doctor.check.missingSkills.title", () => skillsFinding(skills())));
  if (pending) checks.push(check("pending", "doctor.check.pending.title", () => pendingFinding(pending())));
  if (devices) checks.push(check("app-version", "doctor.check.appVersion.title", () => appVersionFinding(devices())));
  if (dbDir) checks.push(check("db-wal", "doctor.check.dbWal.title", () => walFinding(listWalFiles(dbDir()))));
  return checks;
}
