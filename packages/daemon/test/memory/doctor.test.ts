// 记忆插件自己的体检项（412，src/memory/doctor.ts）的判法；记忆简报那一项读 427 的简报统计（MessageBriefs.stats()）里最近 24 小时的。
// 都是纯函数：造假的向量状态、假的推理库现状、假的记忆系统健康、假的简报统计、假的整理记录，看判成几级、事实和修法的键、
// "从什么时候起"、动作按钮；每项再按当前语言拼一遍句子，确认键都在语言文件里（拼出来的不是键名本身）。
// 插件装上、停用时这一块跟着出现、消失的那一半在 doctor-plugin.test.ts。
import { activeLocale, activeLocaleFrom, doctorItemText, type DoctorMessage, type MemoryHealth, type MemoryNightlySourceSync, type MemoryProviderInfo, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorFinding } from "../../src/doctor/checks.ts";
import { doctorTime } from "../../src/doctor/auto.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import {
  BRIEF_MIN_ASKED,
  BRIEF_WINDOW_MS,
  briefFinding,
  briefWindow,
  type GraphFacts,
  graphFinding,
  indexFinding,
  type NightlyFacts,
  nightlyFinding,
  type NightlyRecordFacts,
  presyncFinding,
  systemFinding,
  type VectorFacts,
} from "../../src/memory/doctor.ts";
import { MESSAGE_BRIEF_RECENT, type MessageBriefRun, type MessageBriefStats } from "../../src/memory/message-brief.ts";

const HOUR = 3_600_000;
/** 此刻：2026-11-07 15:30（北京时间） */
const NOW = Date.parse("2026-11-07T15:30:00+08:00");

/** 这一项按当前语言拼出来的句子（名字随便给一个：只看事实和修法） */
function said(finding: DoctorFinding): { fact: string; fix?: string } {
  const text = doctorItemText({ title: { key: "memory.doctor.index.title" }, fact: finding.fact, ...(finding.fix === undefined ? {} : { fix: finding.fix }) });
  return { fact: text.fact, ...(text.fix === undefined ? {} : { fix: text.fix }) };
}

/** 拼出来的句子里不能还是键名、不能有没填的 {参数} */
function expectRendered(finding: DoctorFinding) {
  const text = said(finding);
  for (const line of [text.fact, text.fix ?? ""]) {
    expect(line).not.toMatch(/memory\.doctor\./);
    expect(line).not.toMatch(/\{[a-zA-Z]+\}/);
  }
  return text;
}

const keyOf = (m: DoctorMessage | undefined) => m?.key;

const before = activeLocale();
afterEach(() => setActiveLocale(before));

// ───────── 1. 向量索引 ─────────

const vectors = (extra: Partial<VectorFacts> = {}): VectorFacts => ({ model: "bge-m3", available: true, indexed: 1200, pending: 0, state: "idle", ...extra });

describe("向量索引", () => {
  it("都算好了正常；还差一点正常（写还差几条、在不在算）", () => {
    const ok = indexFinding(vectors());
    expect(ok).toEqual({ level: "ok", fact: { key: "memory.doctor.index.ok", params: { indexed: 1200, pending: 0, total: 1200, model: "bge-m3" } } });
    expect(expectRendered(ok).fact).toContain("1200");
    // 还差 80 条（不到 INDEX_LAG_MIN）、正在算：正常
    const catching = indexFinding(vectors({ pending: 80, state: "running" }));
    expect(catching).toMatchObject({ level: "ok", fact: { key: "memory.doctor.index.okPending" } });
    expect(expectRendered(catching).fact).toContain("80");
    // 还差 150 条、一共 10150 条（不到一成）：正常
    expect(indexFinding(vectors({ indexed: 10_000, pending: 150 })).level).toBe("ok");
    // 一条素材都没有：正常，不说"0 条都算好了"
    expect(indexFinding(vectors({ indexed: 0 }))).toEqual({ level: "ok", fact: { key: "memory.doctor.index.empty" } });
  });

  it("还差的超过总数一成、又至少 100 条：注意（写差几条、一共几条、在不在算）", () => {
    const behind = indexFinding(vectors({ indexed: 900, pending: 300, state: "running" }));
    expect(behind).toMatchObject({ level: "warn", fact: { key: "memory.doctor.index.behind", params: { pending: 300, total: 1200 } }, fix: { key: "memory.doctor.fix.indexBehind" } });
    expect(expectRendered(behind).fact).toMatch(/300.*1200/);
    // 刚起来一共才 20 条、全没算：不到 100 条不算落后
    expect(indexFinding(vectors({ indexed: 0, pending: 20 })).level).toBe("ok");
  });

  it("模型不在（等模型）：注意，跳设置 · 组件；算向量出错：坏了；没在采集素材：不适用", () => {
    const waiting = indexFinding(vectors({ available: false, state: "waiting_for_model", indexed: 0, pending: 500 }));
    expect(waiting).toMatchObject({ level: "warn", fact: { key: "memory.doctor.index.noModel" }, fix: { key: "memory.doctor.fix.indexModel" }, action: { kind: "open", route: "#/more/components" } });
    expect(expectRendered(waiting).fact).toContain("bge-m3");
    const failed = indexFinding(vectors({ state: "error", pending: 40 }));
    expect(failed).toMatchObject({ level: "error", fact: { key: "memory.doctor.index.error" }, fix: { key: "memory.doctor.fix.indexError" } });
    expectRendered(failed);
    expect(indexFinding(vectors({ state: "off", available: false, model: "", indexed: 0 }))).toEqual({ level: "na", fact: { key: "memory.doctor.index.off" } });
  });
});

// ───────── 2. 推理库 ─────────

const graph = (extra: Partial<GraphFacts> = {}): GraphFacts => ({ enabled: true, opened: false, bytes: 12 * 1024 * 1024, ...extra });

describe("推理库", () => {
  it("在用、启动时核过、整理关着但库在：正常，写多大", () => {
    const inUse = graphFinding(graph({ opened: true }));
    expect(inUse).toEqual({ level: "ok", fact: { key: "memory.doctor.graph.inUse", params: { size: "12" } } });
    expect(expectRendered(inUse).fact).toContain("12 MB");
    expect(graphFinding(graph())).toMatchObject({ level: "ok", fact: { key: "memory.doctor.graph.checked" } });
    expect(graphFinding(graph({ enabled: false }))).toMatchObject({ level: "ok", fact: { key: "memory.doctor.graph.notOpened" } });
  });

  it("启动时版本对不上、引擎认定要重建：坏了，修法说不会自动迁移；引擎打不开：坏了，从认定的时候起", () => {
    const setup = graphFinding(graph({ setupIssue: { code: "schema_mismatch", found: "2", expected: 1 } }));
    expect(setup).toMatchObject({ level: "error", fact: { key: "memory.doctor.graph.rebuild" }, fix: { key: "memory.doctor.fix.graphRebuild" } });
    expect(expectRendered(setup).fact).toMatch(/2.*1/);
    const since = "2026-11-07T09:12:00+08:00";
    const manifest = graphFinding(graph({ engineIssue: { reason: { code: "manifest_missing" }, since } }));
    expect(manifest).toMatchObject({ level: "error", fact: { key: "memory.doctor.graph.rebuild" }, since });
    const broken = graphFinding(graph({ engineIssue: { reason: { code: "open_failed", detail: "磁盘满了" }, since } }));
    expect(broken).toMatchObject({ level: "error", fact: { key: "memory.doctor.graph.unusable" }, fix: { key: "memory.doctor.fix.graphOpen" }, since });
    expect(expectRendered(broken).fact).toContain("磁盘满了");
  });

  it("整理开着却没有库：坏了；整理关着又没有库：不适用；引擎认定还没建库、库是后来才有的：注意（重启才用得上）", () => {
    const since = "2026-11-07T09:12:00+08:00";
    expect(graphFinding(graph({ bytes: undefined, engineIssue: { reason: { code: "not_built" }, since } }))).toMatchObject({
      level: "error",
      fact: { key: "memory.doctor.graph.missing" },
      fix: { key: "memory.doctor.fix.graphMissing" },
      since,
    });
    expect(graphFinding(graph({ bytes: undefined }))).toMatchObject({ level: "error", fact: { key: "memory.doctor.graph.missing" } });
    expect(graphFinding(graph({ enabled: false, bytes: undefined, engineIssue: { reason: { code: "not_built" }, since } }))).toEqual({ level: "na", fact: { key: "memory.doctor.graph.off" } });
    const late = graphFinding(graph({ enabled: false, engineIssue: { reason: { code: "not_built" }, since } }));
    expect(late).toMatchObject({ level: "warn", fact: { key: "memory.doctor.graph.notLoaded" }, fix: { key: "memory.doctor.fix.graphRestart" } });
    expectRendered(late);
  });
});

// ───────── 3. 记忆系统 ─────────

const SUBTEXT: MemoryProviderInfo = { api: 1, id: "subtext", name: { zh: "会意", en: "Subtext" }, version: "0.4.3", capabilities: { brief: true }, requirements: {} };

describe("记忆系统（槽里在跑的那一套自己报的健康）", () => {
  it("在跑：正常，写有效证据几条、上次整理完的时间、占多大", () => {
    const health: MemoryHealth = { items: 523, lastConsolidatedAt: "2026-11-07T03:12:00+08:00", bytes: 8 * 1024 * 1024 };
    const ok = systemFinding(SUBTEXT, health);
    expect(ok).toMatchObject({ level: "ok", fact: { key: "memory.doctor.system.ok", params: { name: "会意" } } });
    const fact = expectRendered(ok).fact;
    expect(fact).toContain("523");
    expect(fact).toContain(doctorTime("2026-11-07T03:12:00+08:00"));
    expect(fact).toContain("8 MB");
    // 没整理过、没算大小的：照写"还没整理过"，不写大小
    const fresh = expectRendered(systemFinding(SUBTEXT, { items: 0 })).fact;
    expect(fresh).toContain("还没整理过");
    expect(fresh).not.toContain("MB");
  });

  it("它报了问题：注意，原话照写；没有在跑的：坏了", () => {
    const problems = systemFinding(SUBTEXT, { items: 0, problems: ["推理库现在用不了"] });
    expect(problems).toMatchObject({ level: "warn", fact: { key: "memory.doctor.system.problems", params: { name: "会意", problems: "推理库现在用不了" } }, fix: { key: "memory.doctor.fix.systemProblems" } });
    expectRendered(problems);
    const none = systemFinding(undefined, undefined);
    expect(none).toEqual({ level: "error", fact: { key: "memory.doctor.system.none" }, fix: { key: "memory.doctor.fix.systemNone" } });
    expectRendered(none);
  });
});

// ───────── 4. 记忆简报 ─────────

const iso = (ms: number) => new Date(ms).toISOString();
/** 一次简报（427 的 MessageBriefRun，只填判法看的几样） */
const run = (at: number, outcome: MessageBriefRun["outcome"], ms = 300): MessageBriefRun => ({ at: iso(at), outcome, ms, steps: [] });
/** 427 的简报统计：since 起算，recent 里早的在前；counts 按 recent 数（另给 extra 表示更早的已经丢了） */
function stats(since: number, recent: MessageBriefRun[], extra = 0): MessageBriefStats {
  const counts = { asked: recent.length + extra, brought: extra, empty: 0, timeout: 0, error: 0 };
  for (const r of recent) counts[r.outcome] += 1;
  return { since: iso(since), counts, recent };
}

describe("记忆简报：从 427 的统计里取最近 24 小时", () => {
  it("统计建起来以后的都算，from 是建起来的时刻", () => {
    const window = briefWindow(stats(NOW - HOUR, [run(NOW - 30 * 60_000, "brought"), run(NOW - 60_000, "timeout", 3001)]), NOW);
    expect(window.from).toBe(NOW - HOUR);
    expect(window.runs.map((r) => r.outcome)).toEqual(["brought", "timeout"]);
  });

  it("超过 24 小时的不算，from 是窗口起点；统计只留了最近几次时从留下的最早那次起算", () => {
    const old = briefWindow(stats(NOW - 30 * HOUR, [run(NOW - 25 * HOUR, "timeout"), run(NOW - HOUR, "brought")]), NOW);
    expect(old.from).toBe(NOW - BRIEF_WINDOW_MS);
    expect(old.runs.map((r) => r.outcome)).toEqual(["brought"]);
    const recent = Array.from({ length: MESSAGE_BRIEF_RECENT }, (_, i) => run(NOW - (MESSAGE_BRIEF_RECENT - i) * 60_000, "brought"));
    const capped = briefWindow(stats(NOW - 2 * HOUR, recent, 7), NOW);
    expect(capped.from).toBe(NOW - MESSAGE_BRIEF_RECENT * 60_000);
    expect(capped.runs).toHaveLength(MESSAGE_BRIEF_RECENT);
  });
});

/** 最近 24 小时里问了 asked 次：超时 timedOut 次、出错 failed 次，别的带上了；最近一次（最后那次）用了 ms 毫秒、是超时 */
function snap(asked: number, timedOut: number, failed: number, ms = 3000): MessageBriefStats {
  const outcomes: MessageBriefRun["outcome"][] = [
    ...Array.from({ length: asked - timedOut - failed }, () => "brought" as const),
    ...Array.from({ length: failed }, () => "error" as const),
    ...Array.from({ length: timedOut }, () => "timeout" as const),
  ];
  const runs = outcomes.map((outcome, i) => run(NOW - (asked - i) * 60_000, outcome));
  if (runs.length > 0) runs[runs.length - 1] = { ...runs.at(-1)!, ms };
  return stats(NOW - 24 * HOUR, runs);
}

describe("记忆简报那一项", () => {

  it("记忆页关了简报：不适用；还没问过：正常", () => {
    expect(briefFinding(false, snap(30, 30, 0), NOW)).toEqual({ level: "na", fact: { key: "memory.doctor.brief.off" } });
    const idle = briefFinding(true, stats(NOW - HOUR, []), NOW);
    expect(idle).toMatchObject({ level: "ok", fact: { key: "memory.doctor.brief.idle" } });
    expect(expectRendered(idle).fact).toContain(doctorTime(new Date(NOW - HOUR).toISOString()));
  });

  it("超时加出错占三成以上：注意，事实写比例和最近一次用时，修法写多少秒就不带", () => {
    const slow = briefFinding(true, snap(30, 10, 2), NOW);
    expect(slow).toMatchObject({ level: "warn", fact: { key: "memory.doctor.brief.slow", params: { asked: 30, timedOut: 10, failed: 2, last: "3" } }, fix: { key: "memory.doctor.fix.briefSlow", params: { seconds: "3" } } });
    const text = expectRendered(slow);
    expect(text.fact).toContain("40%");
    expect(text.fact).toContain("3 秒");
    expect(text.fix).toContain("3 秒");
    // 正好三成也算
    expect(briefFinding(true, snap(10, 3, 0), NOW).level).toBe("warn");
  });

  it("不到三成、问得太少（不到 BRIEF_MIN_ASKED 次）：正常", () => {
    const ok = briefFinding(true, snap(30, 2, 1, 420), NOW);
    expect(ok).toMatchObject({ level: "ok", fact: { key: "memory.doctor.brief.ok", params: { asked: 30, last: "0.4" } } });
    expectRendered(ok);
    expect(briefFinding(true, snap(BRIEF_MIN_ASKED - 1, BRIEF_MIN_ASKED - 1, 0), NOW).level).toBe("ok");
    expect(briefFinding(true, snap(BRIEF_MIN_ASKED, 2, 0), NOW).level).toBe("warn");
  });
});

// ───────── 5. 每晚整理 ─────────

/** 一条整理记录（只填判法看的几项） */
function record(night: string, state: NightlyRecordFacts["state"], at: string, extra: Partial<NightlyRecordFacts> = {}): NightlyRecordFacts {
  return {
    night,
    at,
    state,
    trigger: "scheduled",
    deferrals: 0,
    newClaims: 0,
    changedClaims: 0,
    reviewed: 0,
    needsReview: 0,
    questions: { added: 0, resolved: 0, obsolete: 0, expired: 0, skipped: 0, retired: 0, open: 0 },
    modelCalls: 0,
    budgetExhausted: false,
    processedEvidence: 0,
    pendingEvidence: 0,
    ...(state === "ran" ? { ranAt: at } : {}),
    ...extra,
  };
}

const nightly = (records: NightlyRecordFacts[], extra: Partial<NightlyFacts> = {}): NightlyFacts => ({ enabled: true, records, job: { job: "memory-nightly", since: "2026-10-01T09:00:00+08:00" }, ...extra });

describe("每晚整理", () => {
  it("昨晚跑成了：正常，写时间和新出几条结论；记录里有 durationMs 写用了多久", () => {
    const ok = nightlyFinding(nightly([record("2026-11-07", "ran", "2026-11-07T03:14:00+08:00", { newClaims: 4 })]), NOW);
    expect(ok).toMatchObject({ level: "ok", fact: { key: "memory.doctor.nightly.ok" } });
    expect(expectRendered(ok).fact).toContain("4");
    const timed = nightlyFinding(nightly([record("2026-11-07", "ran", "2026-11-07T03:14:00+08:00", { durationMs: 14 * 60_000 })]), NOW);
    expect(expectRendered(timed).fact).toContain("14 分钟");
    // 推后的不算有结果：前一晚跑成、今晚推后，照样正常
    const deferred = nightlyFinding(nightly([record("2026-11-07", "ran", "2026-11-07T03:14:00+08:00"), record("2026-11-08", "deferred", "2026-11-07T15:00:00+08:00")]), NOW);
    expect(deferred.level).toBe("ok");
  });

  it("最近一条有结果的是失败、没 Key 跳过、要重建：坏了，原因照写，从这一串没跑成的第一条起，跳记忆管理员", () => {
    const ran = record("2026-11-04", "ran", "2026-11-04T03:20:00+08:00");
    const failed5 = record("2026-11-05", "failed", "2026-11-05T04:00:00+08:00", { reason: "模型不可用" });
    const failed6 = record("2026-11-06", "failed", "2026-11-06T04:00:00+08:00", { reason: "整理超时" });
    const failed = nightlyFinding(nightly([ran, failed5, record("2026-11-06", "deferred", "2026-11-06T03:00:00+08:00"), failed6]), NOW);
    expect(failed).toMatchObject({ level: "error", fact: { key: "memory.doctor.nightly.failed" }, fix: { key: "memory.doctor.fix.nightlyFailed" }, since: failed5.at, action: { kind: "open", route: "#/more/memory/curator" } });
    const text = expectRendered(failed).fact;
    expect(text).toContain("整理超时");
    expect(text).toContain(doctorTime(ran.at));

    const skipped = nightlyFinding(nightly([record("2026-11-07", "skipped", "2026-11-07T03:00:00+08:00", { reason: "没配 DeepSeek 的 key" })]), NOW);
    expect(skipped).toMatchObject({ level: "error", fact: { key: "memory.doctor.nightly.skipped" }, fix: { key: "memory.doctor.fix.nightlySkipped" } });
    expect(expectRendered(skipped).fact).toContain("还没跑成过");
    const rebuild = nightlyFinding(nightly([ran, record("2026-11-07", "rebuild_needed", "2026-11-07T03:00:00+08:00", { reason: "推理库的格式版本是 2" })]), NOW);
    expect(rebuild).toMatchObject({ level: "error", fact: { key: "memory.doctor.nightly.rebuild" }, fix: { key: "memory.doctor.fix.graphRebuild" } });
    // 失败之后又跑成了：照最近一条算，正常
    expect(nightlyFinding(nightly([failed5, record("2026-11-07", "ran", "2026-11-07T03:14:00+08:00")]), NOW).level).toBe("ok");
  });

  it("最近一次跑成距今超过 36 小时：坏了，从那次起；一次都没跑成、作业排上超过 36 小时：坏了；刚排上还没到第一次：正常", () => {
    const old = record("2026-11-05", "ran", "2026-11-05T03:10:00+08:00");
    const stale = nightlyFinding(nightly([old]), NOW);
    expect(stale).toMatchObject({ level: "error", fact: { key: "memory.doctor.nightly.stale", params: { hours: 60 } }, fix: { key: "memory.doctor.fix.nightlyStale" }, since: old.at });
    expectRendered(stale);
    // 正好 36 小时以内不算
    expect(nightlyFinding(nightly([record("2026-11-06", "ran", new Date(NOW - 35 * HOUR).toISOString())]), NOW).level).toBe("ok");

    const never = nightlyFinding(nightly([]), NOW);
    expect(never).toMatchObject({ level: "error", fact: { key: "memory.doctor.nightly.never" }, since: "2026-10-01T09:00:00+08:00" });
    expectRendered(never);
    const fresh = nightlyFinding(nightly([], { job: { job: "memory-nightly", since: new Date(NOW - 5 * HOUR).toISOString() } }), NOW);
    expect(fresh).toEqual({ level: "ok", fact: { key: "memory.doctor.nightly.notYet" } });
    expect(nightlyFinding(nightly([], { job: undefined }), NOW).level).toBe("ok");
  });

  it("跑成了但中途超时过：注意——记录里有 timedOut（423 加的）按它；老记录按同一夜两条开始时间不同的跑成记录认", () => {
    const curator = nightlyFinding(nightly([record("2026-11-07", "ran", "2026-11-07T03:15:00+08:00", { timedOut: "curator", durationMs: 15 * 60_000 })]), NOW);
    expect(curator).toMatchObject({ level: "warn", fact: { key: "memory.doctor.nightly.timedOut" }, fix: { key: "memory.doctor.fix.nightlyTimedOut" }, action: { kind: "open", route: "#/more/memory/curator" } });
    const text = expectRendered(curator).fact;
    expect(text).toContain("记忆管理员");
    expect(text).toContain("15 分钟");

    // 423 之前：管理员那一份 03:00 起、作业补跑那一份 03:10 起，各记一条 ran
    const first = record("2026-11-07", "ran", "2026-11-07T03:21:00+08:00", { ranAt: "2026-11-07T03:00:05+08:00" });
    const second = record("2026-11-07", "ran", "2026-11-07T03:25:00+08:00", { ranAt: "2026-11-07T03:10:02+08:00" });
    const reran = nightlyFinding(nightly([first, second]), NOW);
    expect(reran).toMatchObject({ level: "warn", fact: { key: "memory.doctor.nightly.reran", params: { night: "2026-11-07" } } });
    expectRendered(reran);
    // 管理员写完日记后作业补记调用次数：开始时间一样，不算重跑
    const same = record("2026-11-07", "ran", "2026-11-07T03:25:08+08:00", { ranAt: "2026-11-07T03:00:05+08:00", curatorModelCalls: 3 });
    expect(nightlyFinding(nightly([first, same]), NOW).level).toBe("ok");
    // 手动整理一次不算
    const manual = record("2026-11-07", "ran", "2026-11-07T10:00:00+08:00", { ranAt: "2026-11-07T09:58:00+08:00", trigger: "manual" });
    expect(nightlyFinding(nightly([first, manual]), NOW).level).toBe("ok");
  });

  it("memory.enabled 关着：不适用", () => {
    expect(nightlyFinding(nightly([], { enabled: false }), NOW)).toEqual({ level: "na", fact: { key: "memory.doctor.nightly.off" } });
  });
});

// ───────── 6. 整理前的数据源导入 ─────────

const sync = (sources: MemoryNightlySourceSync["sources"]): MemoryNightlySourceSync => ({ waitMinutes: 10, sources });

describe("整理前导入数据源", () => {
  it("都导好了：正常，列出各新进来几条、刚同步过的", () => {
    const ok = presyncFinding(
      nightly([
        record("2026-11-07", "ran", "2026-11-07T03:14:00+08:00", {
          sourceSync: sync([
            { id: "google-calendar", title: "Google · 日历", state: "synced", added: 3 },
            { id: "looki", title: "Looki", state: "fresh" },
          ]),
        }),
      ]),
    );
    expect(ok).toMatchObject({ level: "ok", fact: { key: "memory.doctor.presync.ok" } });
    const text = expectRendered(ok).fact;
    expect(text).toContain("Google · 日历（新进来 3 条）");
    expect(text).toContain("Looki（刚同步过）");
  });

  it("有数据源没导成（出错、连接出错、等到上限还没导完）：注意，列出哪几个、为什么，跳设置 · 数据源，从那条记录起", () => {
    const at = "2026-11-07T03:14:00+08:00";
    const bad = presyncFinding(
      nightly([
        record("2026-11-07", "ran", at, {
          sourceSync: sync([
            { id: "google-calendar", title: "Google · 日历", state: "synced", added: 1 },
            { id: "looki", title: "Looki", state: "broken", reason: "Key 不对" },
            { id: "google-gmail", title: "Google · Gmail", state: "timeout" },
          ]),
        }),
      ]),
    );
    expect(bad).toMatchObject({ level: "warn", fact: { key: "memory.doctor.presync.bad", params: { count: 2 } }, fix: { key: "memory.doctor.fix.presync" }, since: at, action: { kind: "open", route: "#/more/data-sources" } });
    const text = expectRendered(bad).fact;
    expect(text).toContain("Looki（连接出错：Key 不对）");
    expect(text).toContain("Google · Gmail（等了 10 分钟");
    expect(text).not.toContain("Google · 日历");
    // 读的是最近一条带同步结果的记录（后来推后的那条没同步，不挡着）
    const later = presyncFinding(nightly([record("2026-11-06", "ran", at, { sourceSync: sync([{ id: "looki", title: "Looki", state: "failed" }]) }), record("2026-11-07", "deferred", "2026-11-07T03:00:00+08:00")]));
    expect(later).toMatchObject({ level: "warn" });
    expect(expectRendered(later).fact).toContain("没写原因");
  });

  it("memory.enabled 关着、还没有带同步结果的记录、没有要先导入的数据源：不适用", () => {
    expect(presyncFinding(nightly([], { enabled: false }))).toEqual({ level: "na", fact: { key: "memory.doctor.nightly.off" } });
    expect(presyncFinding(nightly([record("2026-11-07", "ran", "2026-11-07T03:14:00+08:00")]))).toEqual({ level: "na", fact: { key: "memory.doctor.presync.none" } });
    expect(presyncFinding(nightly([record("2026-11-07", "ran", "2026-11-07T03:14:00+08:00", { sourceSync: sync([]) })]))).toEqual({ level: "na", fact: { key: "memory.doctor.presync.noSources" } });
  });
});

describe("英文", () => {
  it("每种句子换成英文也都拼得出来", () => {
    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    {
      const findings: DoctorFinding[] = [
        indexFinding(vectors({ indexed: 900, pending: 300, state: "running" })),
        graphFinding(graph({ setupIssue: { code: "schema_mismatch", found: "2", expected: 1 } })),
        systemFinding(SUBTEXT, { items: 3, lastConsolidatedAt: "2026-11-07T03:12:00+08:00", bytes: 1024 * 1024 }),
        briefFinding(true, snap(30, 10, 2), NOW),
        nightlyFinding(nightly([record("2026-11-07", "ran", "2026-11-07T03:15:00+08:00", { timedOut: "curator", durationMs: 15 * 60_000 })]), NOW),
        presyncFinding(nightly([record("2026-11-07", "ran", "2026-11-07T03:14:00+08:00", { sourceSync: sync([{ id: "looki", title: "Looki", state: "broken", reason: "bad key" }]) })])),
      ];
      const texts = findings.map(expectRendered);
      expect(texts.map((x) => x.fact).join("\n")).not.toMatch(/[一-鿿]/);
      expect(keyOf(findings[5]!.fact)).toBe("memory.doctor.presync.bad");
      // 单复数：一个数据源没导成用单数那句
      expect(texts[5]!.fact).toContain("1 data source wasn't imported: Looki (connection error: bad key)");
      expect(texts[1]!.fix).toContain("rebuild");
      expect(texts[2]!.fact).toContain("Subtext");
    }
  });
});
