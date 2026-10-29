// 330 号票 B（R10，ADR-0032）：预测做成从结论推出来的节点（来源、推法：演绎 / 可废止），落空了往回打——
// 先撤预测，再回头打来源：演绎的撤错的那条前提（再按 R8 往上传）、没验证的不止一条判不出就出问题不乱撤、前提都已验证的挨反例；
// 可废止的来源只挨一条反证。应验了只刷新预测这一条，来源不因此变已验证。别人转述的证伪不了（R3）。
// 来源被撤回，开着的预测跟着作废（R8），来源复活它跟着回来（R11）。老账本迁过来的预测还在。
// 例子用 task-helpers 的自主安排故事（规则版、假模型判预测，自己写的，不看评测数据）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "../../src/domain/time.ts";
import type { Claim, Derivation, PredictionRecord } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { checkReasoningGraph } from "../../src/rg/graph-check.ts";
import type { PredictionJudge, PredictionJudgeInput, PredictionVerdict } from "../../src/rg/predictions.ts";
import { generateQuestions } from "../../src/rg/question-sources.ts";
import { MemoryStore } from "../../src/store/store.ts";
import { closeEngines, say } from "./helpers.ts";
import { member, NEED, NOW, storyEngine, VALUE } from "./task-helpers.ts";

afterEach(closeEngines);

const NEED_LOAD = "lift:need|load";
const VALUE_LOAD = "lift:value|load";
const LATER = addDays(NOW, 3);

const get = (engine: MemoryEngine, id: string): Claim => engine.store.getClaim(id)!;

/** 假模型判预测：每次照 next 给（null 是判不了），记下喂进去的 */
function switchJudge(): PredictionJudge & { next: PredictionVerdict | null; calls: PredictionJudgeInput[] } {
  const judge = {
    next: null as PredictionVerdict | null,
    calls: [] as PredictionJudgeInput[],
    async judgePrediction(input: PredictionJudgeInput) {
      judge.calls.push(input);
      return judge.next;
    },
  };
  return judge;
}

/** 故事建好以后：近期状态（猜测）→ 需求"留出恢复"（猜测）→ 价值（猜测）；需求"重视自主安排"、价值"长期看重自主"已验证 */
async function story() {
  const judge = switchJudge();
  const t = await storyEngine({ predictionJudge: judge });
  const recovery = member(t.engine, NEED_LOAD, "need_recovery");
  const recoveryValue = member(t.engine, VALUE_LOAD, "value_enduring");
  const load = member(t.engine, NEED, "overall_load");
  const autonomy = member(t.engine, NEED, "need_autonomy");
  expect([recovery.status, recoveryValue.status, load.status, autonomy.status]).toEqual(["contested", "contested", "contested", "active"]);
  return { ...t, judge, recovery, recoveryValue, load, autonomy };
}

/** 从这几条结论推出一条预测（明天到期） */
function predict(engine: MemoryEngine, premiseIds: string[], derivation: Derivation, predicts: string): PredictionRecord {
  return engine.gate.write({ op: "predict", reason: "测试：从结论推出一条预测" }, () =>
    engine.gate.putPrediction({ claimId: premiseIds[0]!, premiseIds, derivation, predicts, madeAt: NOW, dueAt: addDays(NOW, 1), status: "open", evidenceId: null, judgedAt: null, note: "" }),
  );
}

/** 第二天来了一条本人的观察，到期那夜整理：判成 verdict（凭这条观察） */
async function judgedAs(t: Awaited<ReturnType<typeof story>>, outcome: PredictionVerdict["outcome"], text = "这周六被排得满满的，我都去了，玩得挺开心") {
  t.engine.ingestEvidence(say("ev-m1", text, addDays(NOW, 2), { context: ["weekend"] }));
  t.setNow(LATER);
  t.judge.next = { outcome, why: "测试：照这条观察判", evidenceId: "ev-m1" };
  return t.engine.reflect();
}

describe("演绎预测落空：先撤预测，再撤错的那条前提（再按 R8 往上传）", () => {
  it("只有一条来源、它是猜测 → 预测撤（墓碑指证伪它的观察）、来源撤（墓碑同一条观察）、来源的下游按 R8 撤；它底下的不动；自检全绿", async () => {
    const t = await story();
    const p = predict(t.engine, [t.recovery.id], "deductive", "下次周末被排满，他一定会推掉");
    const report = await judgedAs(t, "miss");
    expect(t.engine.store.getPrediction(p.id)).toMatchObject({ status: "miss", retractedBy: "ev-m1", blame: { mode: "culprit", claimIds: [t.recovery.id] } });
    expect(get(t.engine, t.recovery.id)).toMatchObject({ status: "retracted", retractedBy: "ev-m1" });
    expect(t.engine.store.linksOf(t.recovery.id).find((l) => l.target === "ev-m1")).toMatchObject({ polarity: "refutes", weight: "decisive" });
    expect(get(t.engine, t.recoveryValue.id)).toMatchObject({ status: "retracted", retractedBy: t.recovery.id });
    // 来源推出来的前提（近期状态那几条猜测）不动
    const below = t.engine.store
      .inferencesOf(t.recovery.id)
      .flatMap((i) => i.premiseIds)
      .map((id) => t.engine.store.getClaim(id))
      .filter((c) => c !== undefined);
    expect(below.length).toBeGreaterThan(0);
    expect(below.filter((c) => c.status === "retracted")).toEqual([]);
    expect(report.predictions?.backprop).toEqual({ retracted: 1, countered: 0, undetermined: 0, counterexamples: 0 });
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
    // 解释里看得到这条预测和它的结局
    const x = t.engine.explainClaim(t.recovery.id);
    expect(x.predictions.map((q) => q.id)).toEqual([p.id]);
    expect(x.text).toContain("落空了（ev-m1；撤了错的那条前提");

    // 再整理一夜：照旧撤着（决定性反证落地，计分撤的照样是这个结果）
    t.setNow(addDays(LATER, 1));
    t.engine.ingestEvidence(say("ev-x1", "今天中午吃了碗面", addDays(LATER, 1)));
    await t.engine.reflect();
    expect(get(t.engine, t.recovery.id).status).toBe("retracted");
  });

  it("几条来源一起推出、没验证的不止一条（Duhem-Quine）→ 判不出，一条都不撤；每条嫌疑往问题箱出一个问题；用户确认一条以后，排除法落到剩下那条、撤回", async () => {
    const t = await story();
    const p = predict(t.engine, [t.recovery.id, t.load.id], "deductive", "接下来两周有人约，他一定会推掉");
    await judgedAs(t, "miss");
    expect(t.engine.store.getPrediction(p.id)).toMatchObject({ status: "miss", blame: { mode: "undetermined", claimIds: [t.recovery.id, t.load.id] } });
    for (const c of [t.recovery, t.load]) expect(get(t.engine, c.id)).toMatchObject({ status: "contested", retractedBy: null });
    expect(t.engine.store.linksOf(t.recovery.id).some((l) => l.target === "ev-m1")).toBe(false);
    const drafts = generateQuestions(t.engine.rg, LATER).drafts.filter((d) => d.key.startsWith(`falsified:${p.id}|`));
    expect(drafts.map((d) => d.key).toSorted()).toEqual([`falsified:${p.id}|${t.recovery.id}`, `falsified:${p.id}|${t.load.id}`].toSorted());
    expect(drafts[0]).toMatchObject({ kind: "prediction_violation" });
    expect(drafts[0]!.text).toContain("还对吗");

    // 用户说"整体负荷高"那条还对 → 嫌疑只剩"留出恢复"，别的都已验证 → 下一夜排除法落到它
    t.engine.recordClaimVerdict(t.load.id, "confirm", { note: "测试：用户说这阵子确实忙" });
    t.setNow(addDays(LATER, 1));
    t.engine.ingestEvidence(say("ev-x1", "今天中午吃了碗面", addDays(LATER, 1)));
    await t.engine.reflect();
    expect(t.engine.store.getPrediction(p.id)!.blame).toMatchObject({ mode: "culprit", claimIds: [t.recovery.id] });
    expect(get(t.engine, t.recovery.id)).toMatchObject({ status: "retracted", retractedBy: "ev-m1" });
    expect(get(t.engine, t.load.id).status).toBe("active");
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
  });

  it("用户答了其中一条「不对了」 → 就是它（撤回），别的嫌疑逃过一劫、照旧是猜测", async () => {
    const t = await story();
    const p = predict(t.engine, [t.recovery.id, t.load.id], "deductive", "接下来两周有人约，他一定会推掉");
    await judgedAs(t, "miss");
    t.engine.recordClaimVerdict(t.load.id, "reject", { note: "测试：用户说最近并不忙" });
    t.setNow(addDays(LATER, 1));
    t.engine.ingestEvidence(say("ev-x1", "今天中午吃了碗面", addDays(LATER, 1)));
    await t.engine.reflect();
    expect(t.engine.store.getPrediction(p.id)!.blame).toMatchObject({ mode: "culprit", claimIds: [t.load.id] });
    expect(get(t.engine, t.recovery.id)).toMatchObject({ status: "contested", retractedBy: null });
  });

  it("来源都已验证（原始 §6：前提全真）→ 不撤，来源挨一条有分量的反例（强），出问题弄清", async () => {
    const t = await story();
    const p = predict(t.engine, [t.autonomy.id], "deductive", "下次周末被别人排满，他一定会推掉");
    // 观察的原话写成和推理无关的（不让当夜的整理先拿它把需求打成猜测），判的模型说它证伪了预测
    await judgedAs(t, "miss", "今天天气不错");
    expect(t.engine.store.getPrediction(p.id)).toMatchObject({ status: "miss", blame: { mode: "counterexample", claimIds: [t.autonomy.id] } });
    expect(get(t.engine, t.autonomy.id).status).not.toBe("retracted");
    expect(t.engine.store.linksOf(t.autonomy.id).find((l) => l.target === "ev-m1")).toMatchObject({ polarity: "refutes", weight: "strong" });
    expect(generateQuestions(t.engine.rg, LATER).drafts.map((d) => d.key)).toContain(`falsified:${p.id}|${t.autonomy.id}`);
  });
});

describe("可废止预测落空：来源只挨一条反证（按现在的计分），不撤", () => {
  it("已验证的需求推出的'大概会'落空 → 预测撤；需求多一条弱反证、不撤（R9 只降把握）", async () => {
    const t = await story();
    const p = predict(t.engine, [t.autonomy.id], "defeasible", "接下来两周再遇到类似的安排，他还会想自己定时间");
    const report = await judgedAs(t, "miss");
    expect(t.engine.store.getPrediction(p.id)).toMatchObject({ status: "miss", retractedBy: "ev-m1", blame: { mode: "counter", claimIds: [t.autonomy.id] } });
    expect(t.engine.store.linksOf(t.autonomy.id).filter((l) => l.target === "ev-m1")).toEqual([expect.objectContaining({ polarity: "refutes", weight: "weak" })]);
    expect(get(t.engine, t.autonomy.id)).toMatchObject({ retractedBy: null });
    expect(get(t.engine, t.autonomy.id).status).not.toBe("retracted");
    expect(report.predictions?.backprop).toEqual({ retracted: 0, countered: 1, undetermined: 0, counterexamples: 0 });
  });
});

describe("应验了：只刷新预测这一条，来源不因此变已验证（证实的不对称）", () => {
  it("猜测推出的预测应验 → 预测 hit（依据就是那条观察）；来源照旧是猜测，不加支持", async () => {
    const t = await story();
    const p = predict(t.engine, [t.recovery.id], "deductive", "下周末他会给自己留出休息的时间");
    const links = t.engine.store.linksOf(t.recovery.id).length;
    await judgedAs(t, "hit", "今天天气不错");
    expect(t.engine.store.getPrediction(p.id)).toMatchObject({ status: "hit", evidenceId: "ev-m1", retractedBy: null, blame: null });
    expect(get(t.engine, t.recovery.id)).toMatchObject({ status: "contested" });
    expect(t.engine.store.linksOf(t.recovery.id)).toHaveLength(links);
  });
});

describe("R3：别人转述的证伪不了关于用户的预测", () => {
  it("到期以后只有别人转述的新证据 → 不喂给判的模型、预测照旧开着，来源不动", async () => {
    const t = await story();
    const p = predict(t.engine, [t.recovery.id], "deductive", "下次周末被排满，他一定会推掉");
    t.engine.ingestEvidence(say("ev-u1", "同事说他这周六去聚会了，玩到很晚", addDays(NOW, 2), { sourceLevel: "untrusted" }));
    t.setNow(LATER);
    t.judge.next = { outcome: "miss", why: "测试", evidenceId: "ev-u1" };
    await t.engine.reflect();
    expect(t.judge.calls.flatMap((c) => c.evidence.map((e) => e.id))).not.toContain("ev-u1");
    expect(t.engine.store.getPrediction(p.id)!.status).toBe("open");
    expect(get(t.engine, t.recovery.id).status).toBe("contested");
  });
});

describe("预测节点跟着来源走（R8、R11）", () => {
  it("来源被用户否掉 → 开着的预测跟着作废（墓碑指来源）；那句否认被忘掉、来源复活 → 预测跟着回到开着", async () => {
    const t = await story();
    const p = predict(t.engine, [t.recovery.id], "deductive", "下次周末被排满，他一定会推掉");
    const verdict = t.engine.recordClaimVerdict(t.recovery.id, "reject", { note: "测试：用户说不对" });
    expect(t.engine.store.getPrediction(p.id)).toMatchObject({ status: "void", retractedBy: t.recovery.id });
    expect(checkReasoningGraph(t.engine.store).problems).toEqual([]);
    t.engine.invalidateEvidence(verdict.evidenceId, "测试：那句否认不算");
    expect(get(t.engine, t.recovery.id).status).not.toBe("retracted");
    expect(t.engine.store.getPrediction(p.id)).toMatchObject({ status: "open", retractedBy: null });
  });

  it("自检：开着的预测来源却撤回了 → 报 prediction（只可能是绕过写入口写进来的坏数据）", async () => {
    const t = await story();
    const p = predict(t.engine, [t.recovery.id], "deductive", "下次周末被排满，他一定会推掉");
    t.engine.store.db.run("UPDATE claims SET status = 'retracted', retracted_by = 'ev-w1' WHERE id = ?", t.recovery.id);
    expect(checkReasoningGraph(t.engine.store).problems).toContainEqual(expect.objectContaining({ check: "prediction", subject: p.id }));
  });
});

describe("老账本迁过来", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("226 号票的预测账本（没有来源、推法、墓碑这几列）打开时补上：来源就是原来那条结论、推法按可废止、落空的墓碑是判它的证据；预测都还在", () => {
    const dir = mkdtempSync(join(tmpdir(), "ergo-pred-"));
    dirs.push(dir);
    const file = join(dir, "rg.db");
    const old = MemoryStore.open(file, { clock: () => NOW });
    old.db.exec("DROP TABLE predictions");
    old.db.exec(`CREATE TABLE predictions (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, predicts TEXT NOT NULL, made_at TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL,
      evidence_id TEXT, judged_at TEXT, note TEXT NOT NULL)`);
    old.db.run("INSERT INTO predictions VALUES ('pd-0001', 'cl-0003', '下个月还会推掉周末的聚会', ?, ?, 'open', NULL, NULL, '')", NOW, addDays(NOW, 14));
    old.db.run("INSERT INTO predictions VALUES ('pd-0002', 'cl-0004', '接下来两周他还会说忙', ?, ?, 'miss', 'ev-0009', ?, '没再说忙')", NOW, addDays(NOW, 14), LATER);
    old.close();

    const store = MemoryStore.open(file, { clock: () => NOW });
    try {
      expect(store.listPredictions()).toEqual([
        expect.objectContaining({ id: "pd-0001", claimId: "cl-0003", premiseIds: ["cl-0003"], derivation: "defeasible", status: "open", retractedBy: null, blame: null }),
        expect.objectContaining({ id: "pd-0002", claimId: "cl-0004", premiseIds: ["cl-0004"], derivation: "defeasible", status: "miss", retractedBy: "ev-0009", note: "没再说忙" }),
      ]);
      // 再打开一次不重复补
      store.close();
      const again = MemoryStore.open(file, { clock: () => NOW });
      expect(again.listPredictions().map((p) => p.premiseIds)).toEqual([["cl-0003"], ["cl-0004"]]);
      again.close();
    } finally {
      try {
        store.close();
      } catch {
        // 上面已经关了
      }
    }
  });
});

describe("夜里记下来的预测带推法", () => {
  it("规则版往上抽的预测都是倾向（还会、接下来两周）→ 记成可废止的节点，来源就是那条结论", async () => {
    const t = await story();
    const nodes = t.engine.store.listPredictions({ claimId: t.autonomy.id });
    expect(nodes).toEqual([expect.objectContaining({ premiseIds: [t.autonomy.id], derivation: "defeasible", status: "open" })]);
    const value = member(t.engine, VALUE, "value_enduring");
    expect(t.engine.store.listPredictions({ claimId: value.id })[0]).toMatchObject({ derivation: "defeasible" });
  });
});
