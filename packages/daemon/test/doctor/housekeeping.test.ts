// 体检"二狗本身"的新检查（二）（411，src/doctor/housekeeping.ts）：每条一个纯函数，喂假的状态看几级、事实、怎么修。
// 今天（11-07）的实例当样例：备份最近一次失败原因是 EBUSY → 注意，事实里有原文；matt-pocock 合集的清单里列了 handoff、
// to-questionnaire 但库里没有 → 注意，列出名字。另有：内部作业上一次出错、定时触发的任务被自动暂停 / 卡住、agent 停在同一步太久、
// 名额快满、日志 265 MB、mcp.json 读坏、模型设置文件读坏、MCP 缺凭据、待办几条、手机 App 太旧、预写日志太大。
// 文件系统那两样（日志目录、数据库区）用临时目录造真文件（稀疏的大文件，不真写几百 MB）。
import fs from "node:fs";
import path from "node:path";
import { activeLocale, activeLocaleFrom, type BackupRunRecord, type JobRun, type PairedDevice, type ScheduledJob, setActiveLocale, t } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentManagerDoctorFacts, AgentStep } from "../../src/agent-manager/agent-manager.ts";
import type { BackupDoctorFacts } from "../../src/backup/backup.ts";
import { createDoctorChecks, runDoctorCheck } from "../../src/doctor/checks.ts";
import {
  agentsFinding,
  appVersionFinding,
  backupFinding,
  configFinding,
  durationText,
  HOUSEKEEPING_CHECK_IDS,
  housekeepingChecks,
  internalJobsFinding,
  listLogFiles,
  listWalFiles,
  LOG_FILE_WARN_BYTES,
  logSizeFinding,
  pendingFinding,
  sizeText,
  skillsFinding,
  triggersFinding,
  TRIGGER_QUEUE_STUCK_MS,
  TRIGGER_RUN_STUCK_MS,
  WAL_HINT_BYTES,
  walFinding,
} from "../../src/doctor/housekeeping.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import type { InternalJobState } from "../../src/scheduler/internal-jobs.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const MB = 1024 ** 2;
const NOW = Date.parse("2026-11-07T15:30:00+08:00");
const iso = (text: string) => new Date(Date.parse(text)).toISOString();

/** 一句话按当前语言拼出来 */
const say = (message: { key: string; params?: Readonly<Record<string, string | number>> } | undefined) => (message === undefined ? "" : t(message.key, message.params));

const before = activeLocale();
afterEach(() => setActiveLocale(before));

// ───────── 备份 ─────────

const EBUSY = "EBUSY: resource busy or locked, open 'C:\\Users\\demo\\.ergo\\outputs\\t-47\\.ergo-tmp\\sgac-profile\\Default\\Network\\Cookies'";

function record(extra: Partial<BackupRunRecord> = {}): BackupRunRecord {
  return { by: "daemon", mode: "auto", startedAt: iso("2026-11-07T06:37:00+08:00"), finishedAt: iso("2026-11-07T06:37:30+08:00"), date: "2026-11-07", local: "created", sync: "copied", ...extra };
}

function backupFacts(extra: Partial<BackupDoctorFacts> = {}): BackupDoctorFacts {
  return { schedule: "internal", running: false, ...extra };
}

describe("备份", () => {
  it("今天的实例：最近一次本机快照因为 EBUSY 没做成，上次成功是昨天凌晨 → 注意，事实里有失败原因原文，修法和动作指向设置 · 备份", () => {
    const facts = backupFacts({ last: record({ local: "failed", sync: "skipped", error: EBUSY }), lastOkAt: iso("2026-11-06T03:31:00+08:00"), latestLocal: "2026-11-06" });
    const finding = backupFinding(facts, NOW);
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.backup.failedLatest" }, fix: { key: "doctor.fix.backupFailed" }, action: { kind: "open", route: "#/more/backup" } });
    expect(say(finding.fact)).toContain(EBUSY);
    expect(say(finding.fact)).toContain("2026-11-06");
  });

  it("写进另存的文件夹失败（本机快照做好了）也是注意，事实写原因", () => {
    const finding = backupFinding(backupFacts({ last: record({ sync: "failed", error: "EPERM: operation not permitted, rename" }), lastOkAt: iso("2026-11-07T06:37:20+08:00") }), NOW);
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.backup.syncFailed" } });
    expect(say(finding.fact)).toContain("EPERM");
  });

  it("从没成功过：最近一次失败了，或者等第一次已经超过 48 小时 → 坏了；还没到第一次 → 正常，写第一次在什么时候", () => {
    expect(backupFinding(backupFacts({ last: record({ local: "failed", sync: "skipped", error: EBUSY }) }), NOW)).toMatchObject({ level: "error", fact: { key: "doctor.backup.neverFailed" } });
    const waited = backupFinding(backupFacts({ watchingSince: iso("2026-11-05T09:00:00+08:00") }), NOW);
    expect(waited).toMatchObject({ level: "error", fact: { key: "doctor.backup.never" }, since: iso("2026-11-05T09:00:00+08:00") });
    expect(backupFinding(backupFacts({ watchingSince: iso("2026-11-07T09:00:00+08:00"), next: iso("2026-11-08T03:30:00+08:00") }), NOW)).toMatchObject({ level: "ok", fact: { key: "doctor.backup.notYet" } });
    // 正在做第一份：不算等太久
    expect(backupFinding(backupFacts({ watchingSince: iso("2026-11-01T09:00:00+08:00"), running: true }), NOW).level).toBe("ok");
  });

  it("超过 48 小时没成功：注意，从上次成功起；刚好 48 小时以内照常正常", () => {
    const old = iso("2026-11-05T03:30:00+08:00");
    expect(backupFinding(backupFacts({ last: record({ finishedAt: old }), lastOkAt: old }), NOW)).toMatchObject({ level: "warn", fact: { key: "doctor.backup.stale" }, fix: { key: "doctor.fix.backupStale" }, since: old });
    const recent = new Date(NOW - 47 * HOUR).toISOString();
    expect(backupFinding(backupFacts({ last: record({ finishedAt: recent }), lastOkAt: recent }), NOW)).toMatchObject({ level: "ok", fact: { key: "doctor.backup.ok" } });
  });

  it("做成了但跳过了被占着的文件（422 的 skipped）：注意，列出跳过了哪些；记录里没有这一项的照常正常", () => {
    const skipped = { count: 2, files: [{ path: "outputs/t-47/browser/Cookies", reason: "EBUSY" }, { path: "outputs/t-47/browser/History", reason: "EBUSY" }] };
    const last: BackupRunRecord = { ...record(), skipped };
    const finding = backupFinding(backupFacts({ last, lastOkAt: last.finishedAt }), NOW);
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.backup.skipped", params: { count: 2 } }, fix: { key: "doctor.fix.backupSkipped" } });
    expect(say(finding.fact)).toContain("outputs/t-47/browser/Cookies");
    expect(backupFinding(backupFacts({ last: record(), lastOkAt: record().finishedAt }), NOW).level).toBe("ok");
  });

  it("最近一次校验没通过：注意，写哪一处、哪天的快照、什么问题", () => {
    const lastVerify = { finishedAt: iso("2026-11-01T04:31:00+08:00"), checks: [{ location: "local" as const, date: "2026-11-01", problems: ["db/ergo.db：完整性检查没过"] }] };
    const finding = backupFinding(backupFacts({ last: record(), lastOkAt: record().finishedAt, lastVerify }), NOW);
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.backup.verifyFailed" }, fix: { key: "doctor.fix.backupVerify" } });
    expect(say(finding.fact)).toContain("db/ergo.db：完整性检查没过");
    expect(say(finding.fact)).toContain("本机");
  });
});

// ───────── 定时触发的任务 ─────────

function job(extra: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "j-3",
    title: "每日新闻摘要",
    each: "",
    maintainerId: "jm-3",
    taskId: "t-12",
    taskTitle: "每日新闻摘要",
    grants: [],
    temporalRules: [],
    grantInfo: {},
    state: "active",
    lastFailed: false,
    consecutiveFailures: 0,
    runCount: 5,
    createdAt: iso("2026-11-01T08:00:00+08:00"),
    updatedAt: iso("2026-11-07T08:00:00+08:00"),
    ...extra,
  } as ScheduledJob;
}

function run(extra: Partial<JobRun> = {}): JobRun {
  return { runId: "j-3-r6", jobId: "j-3", trigger: "scheduled", dueAt: iso("2026-11-07T08:00:00+08:00"), state: "running", queuedAt: iso("2026-11-07T08:00:00+08:00"), ...extra };
}

describe("定时触发的任务", () => {
  it("没有被自动暂停的、没有卡住的运行：正常（正在跑、刚排上队的不算）", () => {
    const facts = { autoPaused: [], open: [{ run: run({ startedAt: new Date(NOW - 10 * MINUTE).toISOString() }), job: job() }, { run: run({ runId: "j-3-r7", state: "queued", queuedAt: new Date(NOW - 5 * MINUTE).toISOString() }), job: job() }] };
    expect(triggersFinding(facts, NOW)).toEqual({ level: "ok", fact: { key: "doctor.triggers.ok" } });
  });

  it("连续失败被自动暂停：注意，写名字、几次、最近一次的原因，动作跳到看板上的它（项目内部的跳项目页）", () => {
    const paused = job({ state: "paused", pausedBy: "failures", consecutiveFailures: 3, lastFailed: true, lastRun: run({ state: "failed", reason: "模型服务商 503" }) });
    const finding = triggersFinding({ autoPaused: [paused], open: [] }, NOW);
    expect(finding).toMatchObject({ level: "warn", fix: { key: "doctor.fix.triggers" }, action: { kind: "open", route: "#/tasks/jobs/j-3" } });
    expect(say(finding.fact)).toContain("每日新闻摘要");
    expect(say(finding.fact)).toContain("模型服务商 503");
    const inProject = triggersFinding({ autoPaused: [job({ ...paused, projectId: "p-2" })], open: [] }, NOW);
    expect(inProject.action).toEqual({ kind: "open", route: "#/projects/p-2/jobs/j-3" });
  });

  it("运行中超过 3 小时、排队超过 1 小时：注意，写卡了多久", () => {
    const stuck = run({ startedAt: new Date(NOW - TRIGGER_RUN_STUCK_MS - MINUTE).toISOString() });
    const waiting = run({ runId: "j-4-r1", jobId: "j-4", state: "queued", queuedAt: new Date(NOW - TRIGGER_QUEUE_STUCK_MS - MINUTE).toISOString() });
    const finding = triggersFinding({ autoPaused: [], open: [{ run: stuck, job: job() }, { run: waiting, job: job({ id: "j-4", title: "周报" }) }] }, NOW);
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.triggers.bad", params: { count: 2 } }, action: { kind: "open", route: "#/tasks/jobs/j-3" } });
    expect(say(finding.fact)).toContain("3 小时");
    expect(say(finding.fact)).toContain("周报");
  });
});

// ───────── 内部作业 ─────────

describe("内部作业", () => {
  const ok: InternalJobState = { job: "backup", since: iso("2026-10-01T00:00:00+08:00"), lastRunAt: iso("2026-11-07T03:30:00+08:00"), lastOutcome: "ok", lastEndedAt: iso("2026-11-07T03:31:00+08:00") };
  it("上一次都跑完了（以前记的没有结局的也算）：正常", () => {
    expect(internalJobsFinding([ok, { job: "clean_tmp", since: ok.since, lastRunAt: ok.lastRunAt }])).toEqual({ level: "ok", fact: { key: "doctor.internalJobs.ok", params: { count: 2 } } });
  });

  it("上一次出错的：注意，写给人看的名字、什么时候、出错原文；不认得的作业名原样", () => {
    const failed: InternalJobState = { job: "memory-nightly", since: ok.since, lastRunAt: iso("2026-11-07T03:00:00+08:00"), lastOutcome: "failed", lastError: "推理库打不开：SQLITE_BUSY", lastEndedAt: iso("2026-11-07T03:12:00+08:00") };
    const odd: InternalJobState = { ...failed, job: "some_new_job", lastError: "boom" };
    const finding = internalJobsFinding([ok, failed, odd]);
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.internalJobs.bad", params: { count: 2 } }, fix: { key: "doctor.fix.internalJobs" } });
    expect(say(finding.fact)).toContain("夜里整理记忆");
    expect(say(finding.fact)).toContain("推理库打不开：SQLITE_BUSY");
    expect(say(finding.fact)).toContain("some_new_job");
  });
});

// ───────── 卡住的 agent、名额 ─────────

const step = (extra: Partial<AgentStep> = {}): AgentStep => ({ agentId: "tm-4", forMs: MINUTE, detail: { kind: "calling_tool", tool: "运行命令" }, limitMs: 15 * MINUTE, ...extra });
const agentFacts = (extra: Partial<AgentManagerDoctorFacts> = {}): AgentManagerDoctorFacts => ({ live: 3, maxLive: 8, queued: 0, steps: [step()], ...extra });
const label = (agentId: string) => (agentId === "tm-4" ? { name: "任务「整理报销」的负责人", route: "#/tasks/t-4" } : { name: agentId });

describe("卡住的 agent、名额", () => {
  it("没超过两段超时之和、名额没到九成：正常，写活着几个", () => {
    expect(agentsFinding(agentFacts(), label)).toEqual({ level: "ok", fact: { key: "doctor.stuckAgents.ok", params: { live: 3, max: 8 } } });
  });

  it("停在同一步超过模型 + 工具两段超时之和：注意，写谁、在做什么、多久，动作跳到它的对话；不按超时算的工具（null）不判", () => {
    const finding = agentsFinding(agentFacts({ steps: [step({ forMs: 23 * MINUTE }), step({ agentId: "tm-9", forMs: 90 * MINUTE, limitMs: null })] }), label);
    expect(finding).toMatchObject({ level: "warn", action: { kind: "open", route: "#/tasks/t-4" } });
    const text = say(finding.fact);
    expect(text).toContain("任务「整理报销」的负责人");
    expect(text).toContain("运行命令");
    expect(text).toContain("23 分钟");
    expect(text).not.toContain("tm-9");
    expect(say(finding.fix)).toContain("停止");
  });

  it("活着的子进程到了上限的九成：注意（8 个上限时 8 个才算；排队的写出来）", () => {
    expect(agentsFinding(agentFacts({ live: 7, steps: [] }), label).level).toBe("ok");
    const full = agentsFinding(agentFacts({ live: 8, queued: 2, steps: [] }), label);
    expect(full.level).toBe("warn");
    expect(say(full.fact)).toContain("2 个在排队");
    expect(say(full.fix)).toContain("agents.maxLive");
    expect(agentsFinding(agentFacts({ live: 9, maxLive: 10, steps: [] }), label).level).toBe("warn");
  });
});

// ───────── 日志大小 ─────────

describe("日志大小", () => {
  it("今天的实例：服务管家的 ergo-daemon.out.log 265 MB → 注意，写哪个文件多大；都不到 200 MB 正常", () => {
    const dir = makeTempDir("ergo-doctor-logs-");
    const big = path.join(dir, "ergo-daemon.out.log");
    // 稀疏文件：大小是 265 MB，不真写这么多
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 265 * MB);
    fs.writeFileSync(path.join(dir, "manager.log"), "x".repeat(1000));
    const files = listLogFiles([{ kind: "supervisor", dir }, { kind: "data", dir: path.join(dir, "not-there") }]);
    expect(files.map((f) => path.basename(f.file)).toSorted()).toEqual(["ergo-daemon.out.log", "manager.log"]);
    const finding = logSizeFinding(files);
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.logSize.bad" }, fix: { key: "doctor.fix.logSize" } });
    expect(say(finding.fact)).toContain(big);
    expect(say(finding.fact)).toContain("265 MB");
    expect(say(finding.fact)).toContain("服务管家的日志");

    fs.truncateSync(big, LOG_FILE_WARN_BYTES);
    expect(logSizeFinding(listLogFiles([{ kind: "supervisor", dir }]))).toMatchObject({ level: "ok", fact: { key: "doctor.logSize.ok" } });
    expect(logSizeFinding([])).toEqual({ level: "ok", fact: { key: "doctor.logSize.none" } });
  });
});

// ───────── 配置文件 ─────────

describe("配置文件", () => {
  it("都读得出来、凭据都在：正常", () => {
    expect(configFinding({ missingEnv: [] })).toEqual({ level: "ok", fact: { key: "doctor.configFiles.ok" } });
  });

  it("mcp.json 读坏、模型设置文件读坏、MCP 缺凭据：注意，事实写哪个文件、什么问题，修法各一句", () => {
    const finding = configFinding({
      mcpProblem: "C:\\demo\\.ergo\\config\\mcp.json 不是合法的 JSON：Unexpected token } in JSON at position 120",
      modelSettings: { file: "C:\\demo\\.ergo\\config\\model-settings.json", error: "Unexpected end of JSON input" },
      missingEnv: [{ title: "GitHub", variables: ["GITHUB_TOKEN"] }],
    });
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.configFiles.bad" }, fix: { key: "doctor.fix.steps" }, action: { kind: "open", route: "#/more/skills" } });
    const text = say(finding.fact);
    expect(text).toContain("mcp.json 不是合法的 JSON");
    expect(text).toContain("model-settings.json");
    expect(text).toContain("GITHUB_TOKEN");
    const fix = say(finding.fix);
    expect(fix).toContain(".history");
    expect(fix).toContain("设置 · 模型");
    expect(fix).toContain("ergo-daemon");
    // 只有模型设置坏了：动作跳到设置 · 模型
    expect(configFinding({ modelSettings: { file: "x", error: "y" }, missingEnv: [] }).action).toEqual({ kind: "open", route: "#/more/models" });
  });
});

// ───────── 缺的 skill ─────────

describe("缺的 skill", () => {
  it("今天的实例：matt-pocock 合集的清单里列了 handoff、to-questionnaire，库里没有 → 注意，列出名字和出处，修法是重新导入或从清单移掉", () => {
    const finding = skillsFinding({ collections: [{ collection: "matt-pocock", members: ["handoff", "to-questionnaire"] }], lists: [] });
    expect(finding).toMatchObject({ level: "warn", fact: { key: "doctor.missingSkills.bad" }, action: { kind: "open", route: "#/more/skills" } });
    const text = say(finding.fact);
    expect(text).toContain("matt-pocock");
    expect(text).toContain("handoff");
    expect(text).toContain("to-questionnaire");
    expect(say(finding.fix)).toContain("重新导入这个合集");
  });

  it("工具包、名单里写着、库里没有的：注意，写出处；都在时正常（名单是空的不算）", () => {
    const finding = skillsFinding({ collections: [], lists: [{ where: "项目「记账本」的工具包", names: ["pdf-tools"] }, { where: "任务「周报」的工具包", names: [] }] });
    expect(finding.level).toBe("warn");
    expect(say(finding.fact)).toContain("项目「记账本」的工具包里写着、库里没有：pdf-tools");
    expect(say(finding.fact)).not.toContain("周报");
    expect(skillsFinding({ collections: [], lists: [{ where: "x", names: [] }] })).toEqual({ level: "ok", fact: { key: "doctor.missingSkills.ok" } });
  });
});

// ───────── 提示：待办、手机 App、预写日志 ─────────

const device = (name: string, appVersion: string | undefined, extra: Partial<PairedDevice> = {}) => ({ name, revoked: false, appVersion, ...extra }) as PairedDevice;

describe("提示（结果都是正常，不拉低总状态）", () => {
  it("待办：几条、其中待审批几条，有的话带去看看；没有的不带", () => {
    expect(pendingFinding({ open: 0, approvals: 0 })).toEqual({ level: "ok", fact: { key: "doctor.pending.none" } });
    const some = pendingFinding({ open: 6, approvals: 2 });
    expect(some).toEqual({ level: "ok", fact: { key: "doctor.pending.withApprovals", params: { count: 6, approvals: 2 } }, action: { kind: "open", route: "#/inbox" } });
    expect(say(some.fact)).toBe("待办 6 条，其中待审批 2 条");
  });

  it("手机 App：没吊销的设备里低于最低版本的列出来（提示）；吊销了、删了的不算；没有配对的手机不适用", () => {
    expect(appVersionFinding([], "0.4.1").level).toBe("na");
    expect(appVersionFinding([device("旧手机", "0.3.0", { revoked: true })], "0.4.1").level).toBe("na");
    expect(appVersionFinding([device("笔记本浏览器", undefined)], "0.4.1")).toEqual({ level: "ok", fact: { key: "doctor.appVersion.noReports" } });
    expect(appVersionFinding([device("我的安卓", "0.4.3")], "0.4.1")).toMatchObject({ level: "ok", fact: { key: "doctor.appVersion.ok", params: { count: 1 } } });
    const old = appVersionFinding([device("我的安卓", "0.4.3"), device("家里的平板", "0.3.9"), device("删掉的", "0.1.0", { deletedAt: iso("2026-11-01T00:00:00+08:00") })], "0.4.1");
    expect(old).toMatchObject({ level: "ok", fact: { key: "doctor.appVersion.old", params: { count: 1, min: "0.4.1" } }, fix: { key: "doctor.fix.appVersion" }, action: { kind: "open", route: "#/more/devices" } });
    expect(say(old.fact)).toContain("家里的平板（0.3.9）");
  });

  it("数据库的预写日志：超过 256 MB 提示（还是正常），写哪个库多大；不大写最大的；没有写没有", () => {
    const dir = makeTempDir("ergo-doctor-db-");
    fs.writeFileSync(path.join(dir, "ergo.db"), "");
    const wal = path.join(dir, "ergo.db-wal");
    fs.writeFileSync(wal, "");
    fs.truncateSync(wal, WAL_HINT_BYTES + 50 * MB);
    fs.writeFileSync(path.join(dir, "materials.db-wal"), "x".repeat(4096));
    const files = listWalFiles(dir);
    expect(files.map((f) => f.db).toSorted()).toEqual(["ergo.db", "materials.db"]);
    const big = walFinding(files);
    expect(big).toMatchObject({ level: "ok", fact: { key: "doctor.dbWal.big" }, fix: { key: "doctor.fix.dbWal" } });
    expect(say(big.fact)).toContain("ergo.db 的 306 MB");
    fs.truncateSync(wal, 0);
    expect(walFinding(listWalFiles(dir))).toMatchObject({ level: "ok", fact: { key: "doctor.dbWal.ok" } });
    expect(walFinding(listWalFiles(path.join(dir, "nope")))).toEqual({ level: "ok", fact: { key: "doctor.dbWal.none" } });
  });
});

describe("登记成检查项", () => {
  it("给了几样登记几项，id 照 HOUSEKEEPING_CHECK_IDS 的先后，都是 passive、能登记进登记表（不和二狗自己的 id 撞）、跑出来像样", async () => {
    const checks = housekeepingChecks({
      now: () => NOW,
      backup: () => backupFacts({ last: record({ local: "failed", sync: "skipped", error: EBUSY }), lastOkAt: iso("2026-11-06T03:31:00+08:00") }),
      triggers: () => ({ autoPaused: [], open: [] }),
      internalJobs: () => [],
      agents: () => agentFacts(),
      logDirs: () => [],
      config: () => ({ missingEnv: [] }),
      skills: () => ({ collections: [{ collection: "matt-pocock", members: ["handoff", "to-questionnaire"] }], lists: [] }),
      pending: () => ({ open: 0, approvals: 0 }),
      devices: () => [],
      dbDir: () => makeTempDir("ergo-doctor-db-"),
    });
    expect(checks.map((check) => check.id)).toEqual([...HOUSEKEEPING_CHECK_IDS]);
    expect(checks.every((check) => check.cost === "passive")).toBe(true);
    const registry = createDoctorChecks();
    for (const check of checks) registry.register(check);
    const findings = await Promise.all(checks.map((check) => runDoctorCheck(check)));
    expect(findings.map((f) => f.level)).toEqual(["warn", "ok", "ok", "ok", "ok", "ok", "warn", "ok", "na", "ok"]);
    // 只给了一样就只登记一项
    expect(housekeepingChecks({ now: () => NOW, pending: () => ({ open: 1, approvals: 0 }) }).map((check) => check.id)).toEqual(["pending"]);
  });

  it("英文下拼得出来（大小、时长、列表跟着语言）", () => {
    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    expect(sizeText(265 * MB)).toBe("265 MB");
    expect(durationText(3 * HOUR)).toBe("3 hours");
    expect(durationText(MINUTE)).toBe("1 minute");
    const finding = skillsFinding({ collections: [{ collection: "matt-pocock", members: ["handoff", "to-questionnaire"] }], lists: [] });
    expect(say(finding.fact)).toBe('In the list of the "matt-pocock" collection but not in the library: handoff and to-questionnaire');
    expect(say(pendingFinding({ open: 1, approvals: 0 }).fact)).toBe("1 item in the inbox");
  });
});
