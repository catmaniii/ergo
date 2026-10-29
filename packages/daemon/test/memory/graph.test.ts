// 233 号票：记忆的推理库只读读出来的东西（概览、结论列表、一条的完整解释、问题箱）。
// 用临时目录里的真 SQLite 和真 MemoryEngine（手写的几条证据、结论、关联、推断、问题），没有模型调用；
// 概览里的"最近一次整理"用一份假的记录（真视图由主切面 test/main/memory-graph.test.ts 覆盖）。
import path from "node:path";
import fs from "node:fs";
import { type Evidence, MemoryEngine } from "@ergo/memory";
import { describe, expect, it } from "vitest";
import { createMemoryGraphReader, type MemoryGraphReader } from "../../src/memory/graph.ts";
import type { MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { openReasoningDb, RG_DB_SCHEMA_VERSION } from "../../src/memory/rg-db.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
/** 本地时间 2026 年 m 月 d 日 hh:mm 的协议时间（带时区偏移） */
const iso = (m: number, d: number, hh: number, mm = 0) => clockIso(new ManualClock(at(m, d, hh, mm)));

/** 一夜的整理记录（概览里"最近一次整理"那一行） */
const LAST_NIGHT: MemoryNightlyRecord = {
  night: "2026-10-10",
  at: iso(10, 10, 3, 20),
  state: "ran",
  trigger: "scheduled",
  ranAt: iso(10, 10, 3, 5),
  deferrals: 0,
  newClaims: 3,
  changedClaims: 1,
  reviewed: 0,
  needsReview: 1,
  questions: { added: 1, resolved: 0, obsolete: 0, expired: 0, skipped: 0, retired: 0, open: 1 },
  modelCalls: 18,
  budgetExhausted: false,
  processedEvidence: 12,
  pendingEvidence: 0,
};

/** 临时目录里 db/rg.db 的路径 */
function rgDbFile(): string {
  return path.join(makeTempDir("ergo-mem-graph-"), "db", "rg.db");
}

/** 一条本人说过的证据 */
function say(engine: MemoryEngine, text: string, when: string, sourceLevel: "self" | "untrusted" = "self"): Evidence {
  return engine.ingestEvidence({ sourceLevel, mode: "say", kind: "utterance", text, context: ["weekend", "social"], eventTime: when, observedAt: when });
}

interface Seeded {
  main: string;
  rival: string;
  preference: string;
  retracted: string;
  evidence: { first: string; second: string; untrusted: string; against: string };
}

/** 塞一份能看出各块的数据：一组竞争解释、支持/反对/背景、一条推断、两次修订、一个问题 */
function seed(file: string): Seeded {
  const clock = new ManualClock(at(10, 10, 3, 0));
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
  if (!opened.ok) throw new Error("应该能建库");
  const engine = opened.engine;
  try {
    const first = say(engine, "这周六的聚会我就不去了，最近周末想好好休息。", "2026-10-09T20:00:00+08:00");
    const second = say(engine, "我不反感见朋友，只是不喜欢周末被提前排满。", "2026-10-09T22:00:00+08:00");
    const untrusted = say(engine, "（同事转述）他说他最近喜欢一个人待着。", "2026-10-09T22:30:00+08:00", "untrusted");
    const against = say(engine, "周末朋友约我去爬山，我还是去了。", "2026-10-08T09:00:00+08:00");
    engine.rg.registry.putGroup({
      key: "weekend_autonomy",
      pattern: "weekend_autonomy",
      params: {},
      description: "周末连着几次推掉活动",
      observationIds: [first.id, second.id],
      live: true,
      by: "rule:4.1",
    });
    const main = engine.store.insertClaim({
      id: "cl-0001",
      tier: "need",
      statement: "周末需要自己安排时间",
      kind: "hypothesis",
      epistemic: "inferred",
      method: "induction",
      status: "active",
      confidence: "medium",
      context: ["weekend"],
      validFrom: "2026-10-01T00:00:00.000+08:00",
      validTo: null,
      inferredAt: "2026-10-10T03:00:00.000+08:00",
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: ["cl-0002"],
      predicts: [],
    });
    const rival = engine.store.insertClaim({
      id: "cl-0002",
      tier: "need",
      statement: "最近太累，先不想参加社交",
      kind: "hypothesis",
      epistemic: "inferred",
      method: "abduction",
      status: "contested",
      confidence: "low",
      context: ["weekend"],
      validFrom: null,
      validTo: null,
      inferredAt: "2026-10-09T03:00:00.000+08:00",
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: ["cl-0001"],
      predicts: [],
    });
    const preference = engine.store.insertClaim({
      id: "cl-0003",
      tier: "preference",
      statement: "不喜欢周末被提前排满",
      kind: "conclusion",
      epistemic: "explicit",
      method: "explicit",
      status: "active",
      confidence: "high",
      context: ["weekend"],
      validFrom: null,
      validTo: null,
      inferredAt: "2026-10-09T03:00:00.000+08:00",
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [],
    });
    const retracted = engine.store.insertClaim({
      id: "cl-0004",
      tier: "state",
      statement: "这阵子周末都在加班",
      kind: "hypothesis",
      epistemic: "inferred",
      method: "induction",
      status: "retracted",
      confidence: "low",
      context: [],
      validFrom: "2026-10-01T00:00:00.000+08:00",
      validTo: "2026-10-15T00:00:00.000+08:00",
      inferredAt: "2026-10-08T03:00:00.000+08:00",
      reviewedAt: null,
      retractedBy: "ev-0009",
      supersededBy: null,
      competesWith: [],
      predicts: [],
    });
    engine.rg.registry.addMember(main.id, "weekend_autonomy", "scene_autonomy");
    engine.rg.registry.addMember(rival.id, "weekend_autonomy", "exhausted");
    engine.store.putLink({ claimId: main.id, target: first.id, polarity: "supports", rationale: "推掉了聚会", weight: "strong" });
    engine.store.putLink({ claimId: main.id, target: second.id, polarity: "supports", rationale: "明说只是不想被排满", weight: "decisive" });
    engine.store.putLink({ claimId: main.id, target: against.id, polarity: "refutes", rationale: "周末也出去过", weight: "weak" });
    engine.store.putLink({ claimId: main.id, target: untrusted.id, polarity: "context", rationale: "别人转述的，不当依据", weight: "weak" });
    engine.store.insertInference({ conclusionClaimId: main.id, premiseIds: [first.id, second.id], method: "induction", rationale: "两次都在周末推掉活动", by: "rule:4.1", status: "active" });
    // 第二次整理时补上场景（need 层最多 medium，不改把握）：修订日志里能看到
    engine.store.updateClaim(main.id, { context: ["weekend", "social"] }, { reason: "补上场景：两次都落在周末", evidenceId: second.id });
    engine.questions.offer(
      {
        key: "weekend-autonomy",
        topic: "group:weekend_autonomy",
        kind: "unresolved",
        sources: ["unresolved"],
        text: "上次推掉的周末活动，要是时间由你自己定，你会去吗？",
        why: "想自己安排和太累还分不出",
        targets: [
          { id: main.id, kind: "claim", statement: main.statement },
          { id: rival.id, kind: "claim", statement: rival.statement },
        ],
        answers: {
          yes: { supports: [main.id], refutes: [rival.id], maxWeight: "decisive", note: "时间自己定就愿意去" },
          no: { supports: [rival.id], refutes: [main.id], maxWeight: "decisive", note: "确实是不想参加" },
        },
        domains: ["social"],
        scenes: ["weekend"],
        terms: ["周末", "聚会"],
        probeId: null,
        validUntil: null,
        separation: 1,
        closeness: 0.8,
        frequency: 0.6,
      },
      "2026-10-10T03:10:00.000+08:00",
    );
    return { main: main.id, rival: rival.id, preference: preference.id, retracted: retracted.id, evidence: { first: first.id, second: second.id, untrusted: untrusted.id, against: against.id } };
  } finally {
    engine.close();
  }
}

function reader(file: string, nightly: MemoryNightlyRecord | null = LAST_NIGHT): MemoryGraphReader {
  return createMemoryGraphReader({
    file,
    clock: new ManualClock(at(10, 10, 9, 0)),
    model: "deepseek-flash",
    ...(nightly === null ? {} : { latestNightly: () => nightly }),
    log: () => {},
  });
}

describe("推理库还没建（或者不能用）", () => {
  it("库文件不在：三个列表和概览都是 ready=false、空数据，reason 写明还没建；不顺手把库建出来", () => {
    const file = rgDbFile();
    const graph = reader(file, undefined);
    for (const view of [graph.summary(), graph.claims({}), graph.questions({})]) {
      expect(view.ready).toBe(false);
      expect(view.reason).toContain("还没建");
    }
    expect(graph.claims({})).toMatchObject({ total: 0, items: [] });
    expect(graph.questions({})).toMatchObject({ total: 0, open: 0, items: [] });
    expect(graph.summary()).toMatchObject({ total: 0, openQuestions: 0 });
    expect(graph.summary().tiers).toEqual({ state: 0, preference: 0, need: 0, value: 0 });
    // 一条的详情：不是 404，是"读不到库"加一份空数据（网页上写还没建，不写"这条结论不在了"）
    const detail = graph.claim("cl-0001")!;
    expect(detail.ready).toBe(false);
    expect(detail.claim).toBeUndefined();
    expect(detail.supports).toEqual([]);
    expect(detail.premises).toBeUndefined();
    // 只读：看一眼不建库
    expect(fs.existsSync(file)).toBe(false);
  });

  it("manifest 的版本对不上：ready=false，reason 是那句要重建的说法", () => {
    const file = rgDbFile();
    seed(file);
    const db = openDatabase(file);
    try {
      db.run("UPDATE rg_manifest SET value = '99' WHERE key = 'schema'");
    } finally {
      db.close();
    }
    const view = reader(file).summary();
    expect(view.ready).toBe(false);
    expect(view.reason).toContain(String(RG_DB_SCHEMA_VERSION));
    expect(view.total).toBe(0);
  });
});

describe("概览（GET /api/memory/summary）", () => {
  it("各层的结论数、各状态数、问题箱开着几个、最近一次整理的时间和新增条数", () => {
    const file = rgDbFile();
    seed(file);
    expect(reader(file).summary()).toEqual({
      ready: true,
      total: 4,
      tiers: { state: 1, preference: 1, need: 2, value: 0 },
      statuses: { active: 2, contested: 1, retracted: 1, superseded: 0 },
      openQuestions: 1,
      lastNight: {
        night: "2026-10-10",
        at: LAST_NIGHT.at,
        state: "ran",
        ranAt: LAST_NIGHT.ranAt,
        newClaims: 3,
        changedClaims: 1,
        needsReview: 1,
      },
    });
  });

  it("一次都没整理过：没有 lastNight 这一项，别的照旧", () => {
    const file = rgDbFile();
    seed(file);
    const view = reader(file, null).summary();
    expect(view.ready).toBe(true);
    expect(view.lastNight).toBeUndefined();
    expect(view.total).toBe(4);
  });

  it("整理记录是重建推理库那种：原样带过去，方便网页上说明", () => {
    const file = rgDbFile();
    seed(file);
    const view = reader(file, { ...LAST_NIGHT, state: "rebuild_needed", reason: "推理库的格式版本是 2", newClaims: 0 }).summary();
    expect(view.lastNight).toMatchObject({ state: "rebuild_needed", reason: "推理库的格式版本是 2", newClaims: 0 });
  });
});

describe("结论列表（GET /api/memory/claims）", () => {
  it("按层分组要的顺序（近期状态、偏好、需求、价值），同一层新的在前；带编号、陈述、状态、把握、认知来源、更新时间", () => {
    const file = rgDbFile();
    seed(file);
    const page = reader(file).claims({});
    expect(page.ready).toBe(true);
    expect(page.total).toBe(4);
    expect(page.items.map((c) => [c.id, c.tier])).toEqual([
      ["cl-0004", "state"],
      ["cl-0003", "preference"],
      ["cl-0001", "need"],
      ["cl-0002", "need"],
    ]);
    expect(page.items[2]).toMatchObject({
      id: "cl-0001",
      statement: "周末需要自己安排时间",
      tier: "need",
      status: "active",
      confidence: "medium",
      epistemic: "inferred",
      updatedAt: "2026-10-10T03:00:00.000+08:00",
      competitors: 1,
      supports: 2,
      refutes: 1,
    });
  });

  it("按层、按状态筛；limit 只截条数，total 照旧是符合条件的全部", () => {
    const file = rgDbFile();
    seed(file);
    const graph = reader(file);
    expect(graph.claims({ tier: "need" }).items.map((c) => c.id)).toEqual(["cl-0001", "cl-0002"]);
    expect(graph.claims({ status: "retracted" }).items.map((c) => c.id)).toEqual(["cl-0004"]);
    expect(graph.claims({ tier: "need", status: "contested" }).items.map((c) => c.id)).toEqual(["cl-0002"]);
    const limited = graph.claims({ limit: 2 });
    expect(limited.items).toHaveLength(2);
    expect(limited.total).toBe(4);
    expect(graph.claims({ tier: "value" })).toMatchObject({ total: 0, items: [] });
  });
});

describe("一条结论的完整解释（GET /api/memory/claims/<编号>）", () => {
  it("支持、反对、只当背景的证据（编号 + 原话），推断、证据链、竞争解释、修订记录、所在的观察", () => {
    const file = rgDbFile();
    const seeded = seed(file);
    const view = reader(file).claim(seeded.main)!;
    expect(view.ready).toBe(true);
    expect(view.claim).toMatchObject({
      id: "cl-0001",
      statement: "周末需要自己安排时间",
      tier: "need",
      method: "induction",
      status: "active",
      confidence: "medium",
      epistemic: "inferred",
      retractedBy: null,
      supersededBy: null,
    });
    expect(view.group).toEqual({ key: "weekend_autonomy", pattern: "weekend_autonomy", description: "周末连着几次推掉活动" });

    // 支持和反对：编号、原话、多重、为什么算
    expect(view.supports).toHaveLength(2);
    expect(view.supports[1]).toMatchObject({
      target: seeded.evidence.second,
      kind: "evidence",
      statement: null,
      weight: "decisive",
      rationale: "明说只是不想被排满",
      evidence: [{ id: seeded.evidence.second, text: "我不反感见朋友，只是不喜欢周末被提前排满。", sourceLevel: "self", usable: true }],
    });
    expect(view.refutes).toHaveLength(1);
    expect(view.refutes[0]).toMatchObject({ target: seeded.evidence.against, rationale: "周末也出去过", evidence: [{ usable: true }] });
    // 别人转述的只当背景，标明不当依据
    expect(view.background).toHaveLength(1);
    expect(view.background[0]).toMatchObject({ target: seeded.evidence.untrusted, evidence: [{ sourceLevel: "untrusted", usable: false }] });

    // 竞争解释
    expect(view.competitors.map((c) => c.id)).toEqual(["cl-0002"]);
    expect(view.competitors[0]).toMatchObject({ statement: "最近太累，先不想参加社交", status: "contested", confidence: "low" });

    // 推断：这条结论是怎么推出来的
    expect(view.inferences).toHaveLength(1);
    expect(view.inferences[0]).toMatchObject({ method: "induction", by: "rule:4.1", status: "active", rationale: "两次都在周末推掉活动", premiseIds: [seeded.evidence.first, seeded.evidence.second] });

    // 证据链：结论 → 前提（这里直接是原话）
    expect(view.premises).toMatchObject({ id: "cl-0001", kind: "claim", label: "周末需要自己安排时间", status: "active" });
    expect(view.premises!.premises.map((p) => [p.kind, p.id])).toEqual([
      ["evidence", seeded.evidence.first],
      ["evidence", seeded.evidence.second],
    ]);

    // 用到的原话（去重），含反对和背景
    expect(view.evidence.map((e) => e.id).toSorted()).toEqual([seeded.evidence.first, seeded.evidence.second, seeded.evidence.against, seeded.evidence.untrusted].toSorted());

    // 修订：新建、关联的几条、补场景的一条
    const update = view.revisions.find((r) => r.op === "update");
    expect(update).toMatchObject({ reason: "补上场景：两次都落在周末" });
    expect(update!.changes).toContainEqual({ field: "context", from: '["weekend"]', to: '["weekend","social"]' });
    expect(view.revisions[0]!.op).toBe("create");
  });

  it("没有这条结论是 undefined（接口回 404）", () => {
    const file = rgDbFile();
    seed(file);
    expect(reader(file).claim("cl-9999")).toBeUndefined();
  });

  it("没有组、没有证据的明说结论：照常给出来，几个列表都是空的", () => {
    const file = rgDbFile();
    const seeded = seed(file);
    const view = reader(file).claim(seeded.preference)!;
    expect(view.group).toBeUndefined();
    expect(view.supports).toEqual([]);
    expect(view.refutes).toEqual([]);
    expect(view.background).toEqual([]);
    expect(view.competitors).toEqual([]);
    expect(view.inferences).toEqual([]);
    expect(view.premises).toEqual({ id: seeded.preference, kind: "claim", label: "不喜欢周末被提前排满", status: "active", premises: [] });
    expect(view.evidence).toEqual([]);
  });
});

describe("问题箱（GET /api/memory/questions）", () => {
  it("问什么、为什么问、能区分哪几条（带它们现在的状态）、优先级、状态", () => {
    const file = rgDbFile();
    seed(file);
    const page = reader(file).questions({});
    expect(page.ready).toBe(true);
    expect(page).toMatchObject({ total: 1, open: 1 });
    const question = page.items[0]!;
    expect(question).toMatchObject({
      text: "上次推掉的周末活动，要是时间由你自己定，你会去吗？",
      why: "想自己安排和太累还分不出",
      kind: "unresolved",
      status: "open",
      askedCount: 0,
      skippedCount: 0,
      outcome: null,
    });
    expect(question.priority).toBeGreaterThan(0);
    expect(question.priorityDetail).toEqual({ separation: 1, closeness: 0.8, frequency: 0.6, fresh: 1 });
    expect(question.targets).toEqual([
      { id: "cl-0001", kind: "claim", statement: "周末需要自己安排时间", status: "active" },
      { id: "cl-0002", kind: "claim", statement: "最近太累，先不想参加社交", status: "contested" },
    ]);
  });

  it("limit 只截条数，total、open 照旧", () => {
    const file = rgDbFile();
    seed(file);
    const page = reader(file).questions({ limit: 0 });
    expect(page.items).toEqual([]);
    expect(page).toMatchObject({ total: 1, open: 1 });
  });
});

describe("做法（GET /api/memory/strategies，330 号票）", () => {
  it("不含撤回的，在用的在前；标'建在猜测上'（依据里能用的都是猜测）、'理由没了'（依据都撤回了），依据带现在的状态；只读不写库", () => {
    const file = rgDbFile();
    const seeded = seed(file);
    const clock = new ManualClock(at(10, 10, 3, 0));
    const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
    if (!opened.ok) throw new Error("应该能打开");
    try {
      const { store } = opened.engine;
      const base = { template: "consider_motive", trigger: { domains: ["social"], scenes: [], activities: [] }, confirmedBy: null, confirmedAt: null };
      store.insertStrategy({ ...base, key: "a", when: "安排周末的活动时", actions: ["留出空白"], basisClaimIds: ["cl-0001"], status: "proposed" }, { evidenceId: null, reason: "测试" });
      store.insertStrategy({ ...base, key: "b", when: "安排日程时", actions: ["留出休息的时间"], basisClaimIds: ["cl-0002"], status: "proposed" }, { evidenceId: null, reason: "测试" });
      store.insertStrategy({ ...base, key: "c", when: "安排加班时", actions: ["先问一句"], basisClaimIds: ["cl-0004"], status: "active", confirmedBy: seeded.evidence.first, confirmedAt: "2026-10-10T03:00:00.000+08:00" }, { evidenceId: null, reason: "测试" });
      store.insertStrategy({ ...base, key: "d", when: "撤掉的", actions: ["不显示"], basisClaimIds: ["cl-0001"], status: "retracted" }, { evidenceId: null, reason: "测试" });
    } finally {
      opened.engine.close();
    }
    const view = reader(file).strategies();
    expect(view.ready).toBe(true);
    expect(view.items.map((s) => [s.when, s.status, s.onGuess, s.basisGone])).toEqual([
      ["安排加班时", "active", false, true],
      ["安排周末的活动时", "proposed", false, false],
      ["安排日程时", "proposed", true, false],
    ]);
    expect(view.items[2]!.basis).toEqual([{ id: "cl-0002", statement: "最近太累，先不想参加社交", status: "contested", confidence: "low" }]);
    // 只读：再读一次一样（没有跑同步把谁改掉）
    expect(reader(file).strategies().items.map((s) => s.status)).toEqual(["active", "proposed", "proposed"]);
  });

  it("库还没建：ready=false、空列表", () => {
    const view = reader(rgDbFile()).strategies();
    expect(view).toMatchObject({ ready: false, items: [] });
  });
});

describe("猜测为什么还是猜测（330 号票 R5）", () => {
  it("猜测的那条结论详情带 whyGuess；已验证的没有", () => {
    const file = rgDbFile();
    const seeded = seed(file);
    expect(reader(file).claim(seeded.rival)!.whyGuess).toBeDefined();
    expect(reader(file).claim(seeded.preference)!.whyGuess).toBeUndefined();
  });
});
