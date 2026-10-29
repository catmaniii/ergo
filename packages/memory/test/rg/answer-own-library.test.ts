// 206 号票：相关门槛加第二道——在这个人自己库里的记录里也排得靠前（问题和库里全部证据的余弦取第 90 百分位，库小时进前 3 也算）；
// 明说优先要求那句明说的话和挑到的那组说的是同一件事。例子都是自己写的，不看评测数据。
import { afterEach, describe, expect, it } from "vitest";
import { cosine } from "../../src/embedding/embedder.ts";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import type { Hit } from "../../src/retrieval/types.ts";
import { percentile } from "../../src/rg/background.ts";
import { DEFAULT_RELEVANCE_GATE, explicitSameMatter, hitSupported, ownLibraryThreshold, questionVectorGate, relevantForQuestion, vectorPasses, type VectorGate } from "../../src/rg/relevance.ts";
import type { Answer } from "../../src/rg/types.ts";
import { claimOf, closeEngines, explicitClaimOf, factOf, ingestWeekend, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const byRole = (a: Answer, role: string) => a.citations.filter((c) => c.role === role).map((c) => c.claimId);
const vhit = (id: string, score: number): Hit => ({ evidenceId: id, sourceLevel: "self", channels: { evidence_vector: { rank: 1, score } }, fused: 0, via: { factIds: [], probeIds: [] } });

/** 检索结果原话那一路的余弦 */
const cos = (h: Hit) => h.channels.evidence_vector?.score ?? -1;

/** 30 条只靠字的散列出向量的本人记录（假向量里没有概念词），彼此、和没有概念词的问题都挺像 */
function fillers(): ReturnType<typeof say>[] {
  const things = ["抽屉", "书架", "窗台", "鞋柜", "阳台", "门口", "桌面", "床头", "柜子", "箱子"];
  return Array.from({ length: 30 }, (_, i) => say(`ev-f${String(i).padStart(2, "0")}`, `我把${things[i % 10]}里的东西又理了第${i + 1}遍`, `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00+08:00`));
}

describe("第二道门槛：这个人自己库里的记录", () => {
  it("问题和库里全部证据的余弦取第 90 百分位，另记第 3 高的那个；at 之后才知道的、忘掉的不算", async () => {
    const t = openEngine("2026-10-20T12:00:00+08:00", { embedder: new FakeEmbedder() });
    for (const d of fillers()) t.engine.ingestEvidence(d);
    t.engine.ingestEvidence(say("ev-late", "我把书架上的书全看完了", "2026-10-15T10:00:00+08:00"));
    await t.engine.indexVectors();
    t.engine.invalidateEvidence("ev-f00", "用户说忘掉");
    const q = "我到底爱不爱看书？";
    const own = await ownLibraryThreshold(t.engine.rg, q, "2026-10-10T00:00:00+08:00");
    const e = new FakeEmbedder();
    const [qv] = await e.embedQueries([q]);
    const texts = fillers().slice(1).map((d) => d.text);
    const sims = (await e.embedDocuments(texts)).map((d) => cosine(qv!, d));
    expect(own).not.toBeNull();
    expect(own!.size).toBe(29);
    expect(own!.percentile).toBeCloseTo(percentile(sims, 0.9), 6);
    expect(own!.kth).toBeCloseTo(sims.toSorted((a, b) => b - a)[2]!, 6);
    expect(DEFAULT_RELEVANCE_GATE).toMatchObject({ ownPercentile: 0.9, ownTopK: 3 });
  });

  it("两道都要过：高于背景的第 95 百分位，并且高于自己库的第 90 百分位或者进了前 3", () => {
    const gate: VectorGate = { background: 0.5, own: { percentile: 0.7, kth: 0.75, size: 30 } };
    expect(vectorPasses(gate, 0.71)).toBe(true);
    expect(vectorPasses(gate, 0.7)).toBe(false);
    expect(vectorPasses(gate, 0.6)).toBe(false);
    // 库小时：第 90 百分位就是最高的那个，进前 3 也算
    const small: VectorGate = { background: 0.5, own: { percentile: 0.9, kth: 0.6, size: 4 } };
    expect(vectorPasses(small, 0.6)).toBe(true);
    expect(vectorPasses(small, 0.59)).toBe(false);
    // 背景那道没过，自己库里再靠前也不算
    expect(vectorPasses({ background: 0.8, own: { percentile: 0.1, kth: 0.1, size: 30 } }, 0.7)).toBe(false);
    // 没有向量函数、库里没有向量：向量那一路不算
    expect(vectorPasses({ background: null, own: null }, 0.99)).toBe(false);
    expect(vectorPasses({ background: 0.5, own: null }, 0.99)).toBe(false);
    // 只给一个数（205 的写法）：超过它就算
    expect(vectorPasses(0.5, 0.51)).toBe(true);
    expect(vectorPasses(null, 0.99)).toBe(false);
  });

  it("hitSupported 用两道门槛：过了背景那道、在自己库里没排上的不算挨着；有话题词照样算", async () => {
    const { engine } = openEngine("2026-10-20T12:00:00+08:00");
    engine.ingestEvidence(say("ev-1", "这周六的饭局我就不去了", "2026-10-03T10:00:00+08:00"));
    const view = engine.rg.view();
    const gate: VectorGate = { background: 0.5, own: { percentile: 0.8, kth: 0.85, size: 40 } };
    expect(hitSupported(vhit("ev-1", 0.7), ["夜跑"], view, gate)).toBe(false);
    expect(hitSupported(vhit("ev-1", 0.81), ["夜跑"], view, gate)).toBe(true);
    expect(hitSupported(vhit("ev-1", 0.1), ["饭局"], view, gate)).toBe(true);
  });

  it("库里 30 条和问题说法很像的记录（都比背景闲聊像）：只有在自己库里排进前 10%（这里就是前 3）的才算挨着", async () => {
    const t = openEngine("2026-10-20T12:00:00+08:00", { embedder: new FakeEmbedder() });
    // 假向量只靠字的散列时，"我到底爱不爱看海"这类和问题的字差不多，余弦都很高，但都没说到"看书"
    const shapes = ["我到底爱不爱收拾抽屉", "我不爱看电视到底", "我到底爱不爱看海", "到底爱不爱看花我", "我爱不爱看云到底"];
    for (let i = 0; i < 30; i++) t.engine.ingestEvidence(say(`ev-l${String(i).padStart(2, "0")}`, `${shapes[i % 5]}${i}`, `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00+08:00`));
    await t.engine.indexVectors();
    const q = "我到底爱不爱看书？";
    const gate = await questionVectorGate(t.engine.rg, q);
    expect(gate.background).not.toBeNull();
    expect(gate.own).toMatchObject({ size: 30 });
    const base = await t.engine.rg.baseSearch(q, { limit: 30 });
    expect(base.filter((h) => cos(h) > gate.background!).length).toBeGreaterThan(20);
    const rel = await relevantForQuestion(t.engine.rg, q, {}, base);
    const top3 = base.map(cos).toSorted((a, b) => b - a)[2]!;
    expect(rel.supportedHitIds.length).toBeGreaterThan(0);
    expect(rel.supportedHitIds.length).toBeLessThanOrEqual(3);
    for (const id of rel.supportedHitIds) expect(cos(base.find((h) => h.evidenceId === id)!)).toBeGreaterThanOrEqual(top3);
  });

  it("库很小（4 条）：第 90 百分位就是最高那条，进前 3 也算挨着", async () => {
    const t = openEngine("2026-10-20T12:00:00+08:00", { embedder: new FakeEmbedder() });
    for (const d of fillers().slice(0, 4)) t.engine.ingestEvidence(d);
    await t.engine.indexVectors();
    const own = await ownLibraryThreshold(t.engine.rg, "我把抽屉里的东西理了一遍");
    expect(own!.size).toBe(4);
    expect(own!.kth).toBeLessThan(own!.percentile);
  });
});

describe("明说优先：那句明说的话要和挑到的那组说的是同一件事", () => {
  it("周末社交案例前三条：'最近周末想好好休息'和'推掉这周六的聚会'是同一句话——挂在同一批观察上，以它为准", async () => {
    const t = openEngine("2026-10-09T12:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03", "ev-u01"]);
    await t.engine.reflect();
    const rest = explicitClaimOf(t.engine, factOf(t.engine, "ev-w01", "prefers", "休息"));
    const group = t.engine.rg.groupView("repeated_decline|weekend|social")!;
    expect(explicitSameMatter(t.engine.rg, rest, group, [], [])).toEqual({ same: true, by: "observations" });
    const a = await t.engine.answer("为什么我最近不想参加周末的聚会？", { context: ["weekend"] });
    expect(a.certain).toBe(true);
    expect(a.text).toMatch(/^以你说的为准：用户最近在周末、社交场合偏好休息/);
  });

  it("三条之一就够：共同的话题词、自己的陈述过了结论索引那条路也算；都对不上的不算", async () => {
    const t = openEngine("2026-10-20T12:00:00+08:00");
    ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03"]);
    t.engine.ingestEvidence(say("ev-x", "我不吃香菜", "2026-10-05T10:00:00+08:00"));
    await t.engine.reflect();
    const coriander = explicitClaimOf(t.engine, factOf(t.engine, "ev-x", "dislikes"));
    const group = t.engine.rg.groupView("repeated_decline|weekend|social")!;
    expect(explicitSameMatter(t.engine.rg, coriander, group, ["聚会", "周末"], [])).toEqual({ same: false, by: null });
    expect(explicitSameMatter(t.engine.rg, coriander, group, ["香菜"], [])).toEqual({ same: true, by: "topic" });
    expect(explicitSameMatter(t.engine.rg, coriander, group, ["聚会"], [{ route: "index", rank: 1 }])).toEqual({ same: true, by: "relevance" });
    // 只是往上走挂在一条命中的原话上进来的，不算"它自己过了门槛"
    expect(explicitSameMatter(t.engine.rg, coriander, group, ["聚会"], [{ route: "upward", rank: 1 }])).toEqual({ same: false, by: null });
  });

  it("组没分出来、过了门槛的明说断言却说的是别的事：不以它为准，照旧说不确定（它只跟在后面当'你说过'）", async () => {
    const t = openEngine("2026-10-09T12:00:00+08:00");
    const ws = { context: ["weekend", "social"] };
    t.engine.ingestEvidence(say("ev-1", "这周六的聚会我就不去了", "2026-10-01T20:10:00+08:00", ws));
    t.engine.ingestEvidence(say("ev-2", "主动报名参加了周三晚上的技术交流会", "2026-10-03T19:30:00+08:00", { mode: "do", kind: "action", context: ["workday", "work", "social"] }));
    t.engine.ingestEvidence(say("ev-3", "推掉了朋友安排得很紧凑的周末活动", "2026-10-08T21:00:00+08:00", { mode: "do", kind: "action", ...ws }));
    // 一句说到"聚会"的话里顺带说了不吃香菜：按"聚会"检索得到它，挂在上面的"不喜欢香菜"会过门槛，但它和那组说的不是一件事
    t.engine.ingestEvidence(say("ev-4", "上次聚会点菜的时候我就说过，我不吃香菜", "2026-10-02T12:00:00+08:00"));
    await t.engine.reflect();
    const q = "为什么我最近不想参加周末的聚会？";
    const base = await t.engine.rg.baseSearch(q, { at: "2026-10-09T12:00:00+08:00", context: ["weekend"], limit: 20 });
    const rel = await relevantForQuestion(t.engine.rg, q, { context: ["weekend"] }, base);
    const coriander = explicitClaimOf(t.engine, factOf(t.engine, "ev-4", "dislikes"));
    expect(rel.gated.find((g) => g.claimId === coriander.id)?.direct).toBe(true);
    const a = await t.engine.answer(q, { context: ["weekend"] });
    expect(a).toMatchObject({ kind: "why", certain: false });
    expect(a.text).toMatch(/^不确定：/);
    expect(a.text).not.toContain("以你说的为准");
    expect(byRole(a, "open")).toContain(claimOf(t.engine, "scene_autonomy").id);
  });
});
