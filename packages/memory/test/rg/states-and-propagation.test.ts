// 329 号票（ADR-0032）：记忆的推理图谱照原始推理图谱的状态机——真值状态只有已验证（active）/ 猜测（contested）/ 撤回（retracted），
// "待复核"是单独的复核标记，身份（kind）建号锁死。328 号票的实测（328-audit-table.md 的 A1 A2 A4 B B2 C D E probe3）每个一条，
// 照新规矩断言；另有猜测链往上推、推翻往上传（用户确认过的留下）、复活、削弱只降把握、结构检查（悬空、推论有前提、写入口查无环）。
// 例子用 task-helpers 的自主安排故事（规则版、假模型，自己写的，不看评测数据）。
import { afterEach, describe, expect, it } from "vitest";
import type { Claim, NewClaim } from "../../src/index.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { checkReasoningGraph } from "../../src/rg/graph-check.ts";
import { ReasoningWriteRefused } from "../../src/rg/write-gate.ts";
import { closeEngines, say } from "./helpers.ts";
import { member, NEED, NOW, statedOf, storyEngine, VALUE, WEEKEND_GROUP, WORKDAY_GROUP } from "./task-helpers.ts";

afterEach(closeEngines);

const get = (engine: MemoryEngine, id: string): Claim => engine.store.getClaim(id)!;
const activePremises = (engine: MemoryEngine, id: string) =>
  engine.store
    .inferencesOf(id)
    .filter((i) => i.status === "active")
    .flatMap((i) => i.premiseIds);
const kindChanges = (engine: MemoryEngine, id: string) => engine.store.revisions(id, "claim").filter((r) => r.changes.kind !== undefined);
const gateDrops = (report: { dropped: { stage: string }[] }) => report.dropped.filter((d) => d.stage === "gate");

/** 一次写，被写入口拒就交回拒的原因 */
function refusal(fn: () => void): ReasoningWriteRefused {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReasoningWriteRefused) return err;
    throw err;
  }
  throw new Error("应该被写入口拒");
}

/** 故事里已验证的几条：明说的"周末不喜欢被排满"、需求"重视自主安排"、价值"长期看重自主安排" */
async function story() {
  const t = await storyEngine();
  const premise = statedOf(t.engine, "ev-w3", "dislikes");
  const need = member(t.engine, NEED, "need_autonomy");
  const value = member(t.engine, VALUE, "value_enduring");
  expect([premise.status, need.status, value.status]).toEqual(["active", "active", "active"]);
  expect(activePremises(t.engine, need.id)).toContain(premise.id);
  return { ...t, premise, need, value };
}

const contestedDraft = (statement: string, at: string, over: Partial<NewClaim> = {}): NewClaim => ({
  tier: "preference",
  statement,
  kind: "hypothesis",
  epistemic: "inferred",
  method: "abduction",
  status: "contested",
  confidence: "low",
  context: [],
  validFrom: null,
  validTo: null,
  inferredAt: at,
  reviewedAt: null,
  retractedBy: null,
  supersededBy: null,
  competesWith: [],
  predicts: [],
  ...over,
});

/** "我不喜欢周末被排得满满的"同一天又说"我喜欢周末被排得满满的"：两条事实真冲突，都拿不准 */
async function contradicted() {
  const t = await story();
  t.engine.ingestEvidence(say("ev-w3b", "我喜欢周末被排得满满的", "2026-04-04T20:00:00+08:00", { context: ["weekend"] }));
  return t;
}

/** A（猜测）← 事实；B（猜测）← A；不在任何组里，直接经写入口写 */
function chain(engine: MemoryEngine) {
  const fact = engine.store.factsByEvidence("ev-w1")[0]!;
  return engine.gate.write({ op: "propose", reason: "测试：一条猜测链" }, () => {
    const a = engine.gate.insertClaim(contestedDraft("测试 A：周末想休息", NOW));
    engine.gate.insertInference({ conclusionClaimId: a.id, premiseIds: [fact.id], method: "abduction", rationale: "测试", by: "rule:test", status: "active" });
    engine.gate.putLink({ claimId: a.id, target: fact.id, polarity: "supports", weight: "weak", rationale: "测试" });
    const b = engine.gate.insertClaim(contestedDraft("测试 B：需要留出休息的时间", NOW, { tier: "need", method: "induction" }));
    engine.gate.insertInference({ conclusionClaimId: b.id, premiseIds: [a.id], method: "induction", rationale: "测试", by: "rule:test", status: "active" });
    return { a, b, fact };
  });
}

describe("R4 传播铁律：前提降成猜测，依赖它的已验证降回猜测、前提照挂、保留（A1、A2）", () => {
  it("A1：前提降成猜测、下游不管 → 写入口拒（点名需求）；下游跟着降成猜测（downgradeDependents）→ 不拒，需求、价值保留，前提照挂", async () => {
    const { engine, premise, need, value } = await story();
    const refused = refusal(() =>
      engine.gate.write({ op: "decide", reason: "测试：前提降成猜测、不管下游" }, () => engine.gate.updateClaim(premise.id, { status: "contested" }, { reason: "测试：前提拿不准了" })),
    );
    expect(refused.problems).toContainEqual(expect.objectContaining({ check: "dependents", objectId: need.id }));
    expect(get(engine, premise.id).status).toBe("active"); // 整次回滚

    const at = engine.store.now();
    engine.gate.write({ op: "decide", reason: "测试：前提降成猜测、下游跟着降" }, () => {
      engine.gate.updateClaim(premise.id, { status: "contested" }, { reason: "测试：前提拿不准了" });
      engine.rg.keeper.downgradeDependents(premise.id, at, { reason: `前提 ${premise.id} 拿不准了` }, engine.rg.view(at));
    });
    expect(get(engine, need.id)).toMatchObject({ status: "contested", kind: "hypothesis", retractedBy: null, needsReview: false });
    expect(get(engine, value.id)).toMatchObject({ status: "contested", retractedBy: null });
    // 前提照挂、不悄悄换依据，推断照旧成立
    expect(activePremises(engine, need.id)).toContain(premise.id);
    expect(activePremises(engine, value.id)).toEqual([need.id]);
    expect(engine.store.revisions(need.id, "claim").at(-1)!.reason).toContain(`前提 ${premise.id}`);
    expect(checkReasoningGraph(engine.store).problems).toEqual([]);
  });

  it("A2：前提、需求、价值一起降成猜测、都保留（自己写，不用 downgradeDependents）→ 写入口不拒（不再只认转待复核）", async () => {
    const { engine, premise, need, value } = await story();
    engine.gate.write({ op: "decide", reason: "测试：三层一起降成猜测" }, () => {
      for (const id of [premise.id, need.id, value.id]) engine.gate.updateClaim(id, { status: "contested" }, { reason: "测试：降成猜测、保留" });
    });
    expect([get(engine, premise.id).status, get(engine, need.id).status, get(engine, value.id).status]).toEqual(["contested", "contested", "contested"]);
    expect(activePremises(engine, need.id)).toContain(premise.id);
    expect(engine.store.listClaims({ needsReview: true })).toEqual([]);
  });

  it("建的时候就压在猜测上的已验证结论：写入口拒（以前写入口不拦、自检才拦）", async () => {
    const { engine } = await story();
    const guess = member(engine, WEEKEND_GROUP, "recent_state");
    expect(guess.status).toBe("contested");
    const evidence = engine.store.getFact(activePremises(engine, guess.id)[0]!)!.evidenceIds[0]!;
    const refused = refusal(() =>
      engine.gate.write({ op: "lift", reason: "测试：已验证的压在猜测上" }, () => {
        const c = engine.gate.insertClaim(contestedDraft("测试：建在猜测上的已验证", NOW, { tier: "need", status: "active", confidence: "low", method: "induction" }));
        engine.gate.insertInference({ conclusionClaimId: c.id, premiseIds: [guess.id], method: "induction", rationale: "测试", by: "rule:test", status: "active" });
        engine.gate.putLink({ claimId: c.id, target: evidence, polarity: "supports", weight: "strong", rationale: "测试" });
      }),
    );
    expect(refused.problems).toContainEqual(expect.objectContaining({ check: "dependents" }));
  });
});

describe("R4 猜测都能往上推，推出来的是猜测、保留（A4、猜测链）", () => {
  it("A4：猜测（还在竞争的、把握 low 的）也是往上抽的输入", async () => {
    const { engine } = await story();
    const guesses = [member(engine, WEEKEND_GROUP, "recent_state"), member(engine, WORKDAY_GROUP, "recent_state")];
    expect(guesses.map((c) => c.status)).toEqual(["contested", "contested"]);
    const at = engine.store.now();
    engine.gate.write({ op: "decide", reason: "测试：把握掉到 low" }, () => engine.gate.updateClaim(guesses[0]!.id, { confidence: "low" }, { reason: "测试" }));
    const inputs = engine.rg.liftInputs("need", engine.rg.view(at)).map((i) => i.claim.id);
    expect(inputs).toEqual(expect.arrayContaining(guesses.map((c) => c.id)));
  });

  it("猜测链往上推三层都保留：近期状态（猜测）→ 需求（猜测）→ 价值（猜测）；再整理一夜照样在，没被撤", async () => {
    const t = await story();
    const level1 = [member(t.engine, WEEKEND_GROUP, "recent_state"), member(t.engine, WORKDAY_GROUP, "recent_state")];
    const level2 = member(t.engine, "lift:need|load", "need_recovery");
    const level3 = member(t.engine, "lift:value|load", "value_enduring");
    expect([...level1, level2, level3].map((c) => c.status)).toEqual(["contested", "contested", "contested", "contested"]);
    expect(activePremises(t.engine, level2.id)).toEqual(expect.arrayContaining(level1.map((c) => c.id)));
    expect(activePremises(t.engine, level3.id)).toEqual([level2.id]);
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-x1", "今天中午吃了碗面", "2026-10-13T11:00:00+08:00"));
    const report = await t.engine.reflect();
    expect(gateDrops(report)).toEqual([]);
    for (const c of [...level1, level2, level3]) expect(get(t.engine, c.id)).toMatchObject({ status: "contested", retractedBy: null });
    expect(activePremises(t.engine, level3.id)).toEqual([level2.id]);
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });
});

describe("拿不准的事实当前提：推出来的是猜测，身份不改（B、B2、C）", () => {

  it("C：前提（顺着推断往上第二层）的事实变拿不准 → 同一次写里推断出来的已验证需求、价值降回猜测，身份不改，自检全绿", async () => {
    const t = await contradicted();
    const report = t.engine.extractFacts();
    expect(report.changes.some((c) => c.kind === "conflict")).toBe(true);
    const fact = t.engine.store.getFact(activePremises(t.engine, t.premise.id)[0]!)!;
    expect(fact.status).toBe("contested");
    expect(get(t.engine, t.premise.id)).toMatchObject({ status: "contested", kind: "conclusion" });
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "contested", kind: "hypothesis", epistemic: "inferred", retractedBy: null });
    expect(get(t.engine, t.value.id)).toMatchObject({ status: "contested", kind: "hypothesis", retractedBy: null });
    for (const c of [t.premise, t.need, t.value]) expect(kindChanges(t.engine, c.id)).toEqual([]);
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });

  it("B：整理一夜 → 明说的前提是猜测（kind 还是 conclusion），需求、价值是猜测、保留，没被撤、墓碑不指向拿不准的前提；写入口一处没拒", async () => {
    const t = await contradicted();
    const report = await t.engine.reflect();
    expect(gateDrops(report)).toEqual([]);
    expect(get(t.engine, t.premise.id)).toMatchObject({ status: "contested", kind: "conclusion", epistemic: "explicit" });
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "contested", retractedBy: null });
    expect(get(t.engine, t.value.id)).toMatchObject({ status: "contested", retractedBy: null });
    expect(t.engine.rg.registry.getGroup(NEED)!.live).toBe(true);
    expect(t.engine.rg.registry.getGroup(VALUE)!.live).toBe(true);
    expect(kindChanges(t.engine, t.premise.id)).toEqual([]);
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });

  it("B2：剩下的前提还够门槛、需求重新抽出来：拿不准的那条前提照挂在依据里（不悄悄拿掉），需求照样只是猜测", async () => {
    const t = await contradicted();
    await t.engine.reflect();
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-x1", "今天中午吃了碗面", "2026-10-13T11:00:00+08:00"));
    await t.engine.reflect();
    expect(t.engine.rg.registry.getGroup(NEED)!.observationIds).toContain(t.premise.id);
    expect(activePremises(t.engine, t.need.id)).toContain(t.premise.id);
    expect(get(t.engine, t.need.id).status).toBe("contested");
    // 推断的前提从来没去掉过这一条
    const premiseChanges = t.engine.store
      .inferencesOf(t.need.id)
      .flatMap((inf) => t.engine.store.revisions(inf.id, "inference"))
      .flatMap((r) => (r.changes.premiseIds ? [r.changes.premiseIds.to as string[]] : []));
    expect(premiseChanges.filter((ids) => !ids.includes(t.premise.id))).toEqual([]);
  });
});

describe("R8 推翻往上传、R11 复活（D、E）", () => {

  it("D：已验证的压在猜测 A 上写不进去；猜测 B、C 建在 A 上可以；A 被用户否掉 → B、C 一起撤（不管原来是不是猜测，都扫下游），墓碑指 A，不留悬空，自检全绿", async () => {
    const { engine } = await story();
    const { a, b, fact } = chain(engine);
    const refused = refusal(() =>
      engine.gate.write({ op: "lift", reason: "测试：C 已验证、压在猜测 A 上" }, () => {
        const c = engine.gate.insertClaim(contestedDraft("测试 C", NOW, { status: "active" }));
        engine.gate.insertInference({ conclusionClaimId: c.id, premiseIds: [a.id], method: "abduction", rationale: "测试", by: "rule:test", status: "active" });
        engine.gate.putLink({ claimId: c.id, target: fact.id, polarity: "supports", weight: "strong", rationale: "测试" });
      }),
    );
    expect(refused.problems).toContainEqual(expect.objectContaining({ check: "dependents" }));
    const c = engine.gate.write({ op: "propose", reason: "测试：C 是猜测" }, () => {
      const claim = engine.gate.insertClaim(contestedDraft("测试 C", NOW));
      engine.gate.insertInference({ conclusionClaimId: claim.id, premiseIds: [a.id], method: "abduction", rationale: "测试", by: "rule:test", status: "active" });
      return claim;
    });
    const verdict = engine.recordClaimVerdict(a.id, "reject", { note: "测试：用户说 A 不对" });
    expect(get(engine, a.id)).toMatchObject({ status: "retracted", retractedBy: verdict.evidenceId });
    for (const id of [b.id, c.id]) {
      expect(get(engine, id)).toMatchObject({ status: "retracted", retractedBy: a.id });
      expect(engine.store.inferencesOf(id).map((i) => i.status)).toEqual(["retracted"]);
    }
    expect(checkReasoningGraph(engine.store).problems).toEqual([]);
  });

  it("R11：A 被用户否掉、B 跟着撤；把那句否认忘掉 → A、B 都复活成猜测、加复核标记，推断恢复，墓碑清掉", async () => {
    const { engine } = await story();
    const { a, b } = chain(engine);
    const verdict = engine.recordClaimVerdict(a.id, "reject", { note: "测试：用户说 A 不对" });
    expect(get(engine, b.id)).toMatchObject({ status: "retracted", retractedBy: a.id });
    engine.invalidateEvidence(verdict.evidenceId, "测试：那句否认不算");
    for (const id of [a.id, b.id]) {
      expect(get(engine, id)).toMatchObject({ status: "contested", retractedBy: null, needsReview: true });
      expect(engine.store.inferencesOf(id).map((i) => i.status)).toEqual(["active"]);
    }
    expect(checkReasoningGraph(engine.store).problems).toEqual([]);
  });

  it("E：被决定性反证（用户否认）撤回的，下游跟着撤；把那句否认忘掉 → 推翻者不在了，它和连带撤回的都复活（推理链恢复），各组当场照证据重判", async () => {
    const t = await story();
    const weekend = member(t.engine, WEEKEND_GROUP, "scene_autonomy");
    const verdict = t.engine.recordClaimVerdict(weekend.id, "reject", { note: "测试：用户说周末这条不对" });
    expect(get(t.engine, weekend.id)).toMatchObject({ status: "retracted", retractedBy: verdict.evidenceId });
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "retracted", retractedBy: weekend.id });
    expect(get(t.engine, t.value.id)).toMatchObject({ status: "retracted", retractedBy: t.need.id });

    t.engine.invalidateEvidence(verdict.evidenceId, "测试：那句否认不算");
    for (const c of [weekend, t.need, t.value]) {
      expect(get(t.engine, c.id).status).not.toBe("retracted");
      expect(get(t.engine, c.id).retractedBy).toBeNull();
    }
    // 复活的修订写明是推翻者不在了；推理链恢复（前提照旧是周末那条）
    expect(t.engine.store.revisions(t.need.id, "claim").some((r) => r.changes.status?.from === "retracted" && r.reason.includes("复活"))).toBe(true);
    expect(activePremises(t.engine, t.need.id)).toContain(weekend.id);
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);

    t.setNow("2026-10-13T12:00:00+08:00");
    const report = await t.engine.reflect();
    expect(gateDrops(report)).toEqual([]);
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "active", needsReview: false });
    expect(get(t.engine, t.value.id)).toMatchObject({ status: "active", needsReview: false });
  });
});

describe("R7 证实不靠前提：用户确认过的，推理链塌了照样成立（probe3、推翻往上传）", () => {
  it("前提被用户否掉 → 没有直接证实的下游撤；用户确认过的需求改挂到确认上、照样已验证，上面的价值不跟着撤", async () => {
    const t = await story();
    const confirmed = t.engine.recordClaimVerdict(t.need.id, "confirm", { note: "测试：用户说就是这样" });
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "active", epistemic: "user_confirmed" });
    expect(activePremises(t.engine, t.need.id)).toEqual([confirmed.evidenceId]);
    expect(t.engine.store.inferencesOf(t.need.id).some((i) => i.status === "history")).toBe(true);
    const competitor = member(t.engine, NEED, "overall_load");
    const weekend = member(t.engine, WEEKEND_GROUP, "scene_autonomy");
    t.engine.recordClaimVerdict(weekend.id, "reject", { note: "测试：周末这条不对" });
    expect(get(t.engine, weekend.id).status).toBe("retracted");
    expect(get(t.engine, competitor.id)).toMatchObject({ status: "retracted", retractedBy: weekend.id });
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "active", retractedBy: null });
    expect(get(t.engine, t.value.id)).toMatchObject({ status: "active", retractedBy: null });
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });

  it("probe3：用户确认过的需求，往上抽的前提塌了（周末的话都被纠正）→ 照样已验证、不卡复核；价值层那组条件不够了（场景只剩一种，没有推翻者）→ 不撤，留成猜测、降把握，前提照挂；整理两夜写入口一处不拒", async () => {
    const t = await story();
    const valueBefore = get(t.engine, t.value.id);
    t.engine.recordClaimVerdict(t.need.id, "confirm", { note: "测试：用户说就是这样" });
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-c1", "前面说的周末那些都不对", "2026-10-13T10:00:00+08:00", { kind: "correction" }));
    for (const id of ["ev-w1", "ev-w2", "ev-w4", "ev-w3"]) t.engine.correct(id, "ev-c1");
    // 推理链（周末那条明说的、周末那组）塌了：没有直接证实的撤，需求改挂在确认上、照样已验证；价值层还在
    expect(get(t.engine, statedOf(t.engine, "ev-w3", "dislikes").id).status).toBe("retracted");
    expect(get(t.engine, t.need.id).status).toBe("active"); // 支持少了几条，标着复核等整理重判；真值不动
    expect(get(t.engine, t.value.id).status).not.toBe("retracted");
    const first = await t.engine.reflect();
    t.setNow("2026-10-14T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-x2", "今天中午吃了碗面", "2026-10-14T11:00:00+08:00"));
    const second = await t.engine.reflect();
    expect([...gateDrops(first), ...gateDrops(second)]).toEqual([]);
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "active", epistemic: "user_confirmed", needsReview: false });
    // Q2（主会话 10-27 定）：没有推翻者的"组不成立了"是证据变少，按 R9 + 原始 undercut：不撤，留成猜测、降把握；撤回只留给真有推翻者的（R8）
    expect(t.engine.rg.registry.getGroup(VALUE)!.live).toBe(false);
    const value = get(t.engine, t.value.id);
    expect(value).toMatchObject({ status: "contested", retractedBy: null, kind: "hypothesis" });
    const rank = { low: 0, medium: 1, high: 2 } as const;
    expect(rank[value.confidence]).toBeLessThan(rank[valueBefore.confidence]);
    expect(activePremises(t.engine, t.value.id)).toEqual([t.need.id]);
    expect(t.engine.store.revisions(t.value.id, "claim").some((r) => r.changes.status?.to === "retracted")).toBe(false);
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });
});

describe("R9 削弱只降把握", () => {
  it("已验证的需求挨了一条弱反证（不太支持的观察，没说它错）→ 不撤，把握降下来", async () => {
    const { engine, need } = await story();
    const before = get(engine, need.id);
    const weak = engine.store.factsByEvidence("ev-t1")[0]!;
    engine.gate.write({ op: "attach", reason: "测试：一条不太支持的观察" }, () =>
      engine.gate.putLink({ claimId: need.id, target: weak.id, polarity: "refutes", weight: "weak", rationale: "测试：说累，不太像是为了自主" }),
    );
    engine.rg.redecideGroup(NEED);
    const after = get(engine, need.id);
    expect(after.status).not.toBe("retracted");
    expect(after.retractedBy).toBeNull();
    const rank = { low: 0, medium: 1, high: 2 } as const;
    expect(rank[after.confidence]).toBeLessThanOrEqual(rank[before.confidence]);
  });
});

describe("结构检查：自检查悬空、推论有前提，写入口查无环", () => {
  it("自检：还活着的结论前提都不在了（悬空）、没有写了前提的成立推断（推论没前提）都报；复核标记着的等重判，不报", async () => {
    const { engine, need } = await story();
    const guess = member(engine, WEEKEND_GROUP, "recent_state");
    engine.store.db.run("UPDATE inferences SET status = 'retracted' WHERE conclusion_claim_id = ?", guess.id);
    const fact = activePremises(engine, need.id).length;
    expect(fact).toBeGreaterThan(0);
    const value = member(engine, VALUE, "value_phase");
    engine.store.db.run("UPDATE claims SET status = 'retracted', retracted_by = ? WHERE id = ?", "ev-w1", need.id);
    const problems = checkReasoningGraph(engine.store).problems;
    expect(problems).toContainEqual(expect.objectContaining({ check: "premise", subject: guess.id }));
    expect(problems).toContainEqual(expect.objectContaining({ check: "dangling", subject: value.id }));
    engine.store.db.run("UPDATE claims SET needs_review = 1 WHERE id IN (?, ?)", guess.id, value.id);
    const flagged = checkReasoningGraph(engine.store).problems.map((p) => `${p.check}:${p.subject}`);
    expect(flagged).not.toContain(`premise:${guess.id}`);
    expect(flagged).not.toContain(`dangling:${value.id}`);
  });

  it("写入口：这次写的推断让结论顺着前提绕回自己 → 拒（cycle）", async () => {
    const { engine, need, value } = await story();
    const refused = refusal(() =>
      engine.gate.write({ op: "lift", reason: "测试：需求以价值为前提" }, () => {
        const inf = engine.store.inferencesOf(need.id).find((i) => i.status === "active")!;
        engine.gate.updateInference(inf.id, { premiseIds: [...inf.premiseIds, value.id] }, { reason: "测试" });
      }),
    );
    expect(refused.problems).toContainEqual(expect.objectContaining({ check: "cycle" }));
  });

  it("写入口：身份锁死，改 kind 拒（never）——推断起的已验证也还是 hypothesis，明说的拿不准了也还是 conclusion", async () => {
    const { engine, premise } = await story();
    const weekend = member(engine, WEEKEND_GROUP, "scene_autonomy");
    expect(weekend).toMatchObject({ kind: "hypothesis", status: "active" });
    for (const [id, kind] of [
      [weekend.id, "conclusion"],
      [premise.id, "hypothesis"],
    ] as const) {
      const refused = refusal(() => engine.gate.write({ op: "decide", reason: "测试：改身份" }, () => engine.gate.updateClaim(id, { kind }, { reason: "测试" })));
      expect(refused.problems).toContainEqual(expect.objectContaining({ check: "never", objectId: id }));
    }
  });

  it("复核标记不占真值状态：用户说拿不准 → 只加标记，已验证照旧、往下的不动；整理重判后摘掉", async () => {
    const t = await story();
    t.engine.recordClaimVerdict(t.need.id, "doubt", { note: "测试：用户说拿不准" });
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "active", needsReview: true });
    expect(get(t.engine, t.value.id)).toMatchObject({ status: "active", needsReview: false });
    t.setNow("2026-10-13T12:00:00+08:00");
    await t.engine.reflect();
    expect(get(t.engine, t.need.id)).toMatchObject({ status: "active", needsReview: false });
  });
});
