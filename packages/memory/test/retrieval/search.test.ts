// 190 号票：三种已实现的检索模式（vector / hybrid / hybrid_kg）、两层开关、时间和场景过滤、图扩展、D 组的接口。
// 用手写的几条证据、规则版抽取和假向量，结果确定。
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceDraft } from "../../src/domain/types.ts";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import { MemoryEngine } from "../../src/engine.ts";
import type { Hit, ReasoningRetrieval, SearchOptions } from "../../src/retrieval/types.ts";

const CLOCK = "2026-10-20T12:00:00+08:00";
const engines: MemoryEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.close();
});

const draft = (id: string, text: string, at: string | null, over: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  id,
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text,
  context: [],
  eventTime: at,
  observedAt: at ?? CLOCK,
  ...over,
});

const EVIDENCE: EvidenceDraft[] = [
  draft("ev-a1", "周六的聚会我就不去了，最近周末想好好休息。", "2026-10-01T20:00:00+08:00", { context: ["weekend", "social"] }),
  draft("ev-a2", "用户主动报名参加了工作日的技术交流会。", "2026-10-03T19:00:00+08:00", { mode: "do", kind: "action", context: ["workday", "work"] }),
  draft("ev-a3", "其实我一直都不吃香菜。", "2026-03-11T12:00:00+08:00", { context: ["food"] }),
  draft("ev-a4", "同事说他最近忙得见不着人。", "2026-10-10T12:00:00+08:00", { sourceLevel: "untrusted", context: ["social"] }),
  draft("ev-a5", "以前我很喜欢爬山。", "2025-12-01T12:00:00+08:00"),
  draft("ev-a6", "现在我不喜欢爬山了。", "2026-06-01T12:00:00+08:00"),
  draft("ev-a7", "小时候学过几年围棋。", null),
];

async function open(options: { embedder?: boolean; evidence?: EvidenceDraft[] } = {}): Promise<MemoryEngine> {
  const engine = MemoryEngine.open({ file: ":memory:", clock: () => CLOCK, embedder: options.embedder === false ? undefined : new FakeEmbedder() });
  engines.push(engine);
  for (const d of options.evidence ?? EVIDENCE) engine.ingestEvidence(d);
  engine.extractFacts();
  await engine.indexVectors();
  return engine;
}

const ids = (hits: Hit[]) => hits.map((h) => h.evidenceId);
const by = (hits: Hit[], id: string) => hits.find((h) => h.evidenceId === id)!;
const search = (engine: MemoryEngine, q: string, o: SearchOptions) => engine.search(q, o);

describe("A 组 vector：只用向量，余弦取前 k", () => {
  it("只有原话的向量这一路，按余弦排；融合分就是余弦；k 条", async () => {
    const engine = await open();
    const hits = await search(engine, "周末聚会", { mode: "vector", layers: "evidence", limit: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0]!.evidenceId).toBe("ev-a1");
    for (const h of hits) {
      expect(Object.keys(h.channels)).toEqual(["evidence_vector"]);
      expect(h.fused).toBeCloseTo(h.channels.evidence_vector!.score, 10);
    }
    expect(hits.map((h) => h.channels.evidence_vector!.rank)).toEqual([1, 2, 3]);
    expect(hits[0]!.fused).toBeGreaterThanOrEqual(hits[1]!.fused);
  });

  it("只搜精炼陈述：命中事实后经 evidenceIds 回到原话，记下经过哪条事实", async () => {
    const engine = await open();
    const hits = await search(engine, "聚会", { mode: "vector", layers: "statement", limit: 3 });
    expect(hits[0]!.evidenceId).toBe("ev-a1");
    expect(Object.keys(hits[0]!.channels)).toEqual(["fact_vector"]);
    expect(hits[0]!.via.factIds.length).toBeGreaterThan(0);
    for (const f of hits[0]!.via.factIds) expect(engine.getFact(f)!.evidenceIds).toContain("ev-a1");
  });

  it("两层都搜：同一条证据只出现一次，分数取两层里高的那个余弦", async () => {
    const engine = await open();
    const hits = await search(engine, "聚会", { mode: "vector", layers: "both" });
    expect(new Set(ids(hits)).size).toBe(hits.length);
    const a1 = hits.find((h) => h.evidenceId === "ev-a1")!;
    expect(a1.channels.evidence_vector).toBeDefined();
    expect(a1.channels.fact_vector).toBeDefined();
    expect(a1.fused).toBeCloseTo(Math.max(a1.channels.evidence_vector!.score, a1.channels.fact_vector!.score), 10);
  });

  it("没有向量函数时 vector 模式报错", async () => {
    const engine = await open({ embedder: false });
    await expect(search(engine, "聚会", { mode: "vector" })).rejects.toThrow(/向量/);
  });
});

describe("B 组 hybrid：关键词（FTS5 bm25 + 短词子串扫描）加向量，RRF 融合", () => {
  it("每条命中记下来源等级、状态、每路的名次和分数、融合分（RRF 的和）", async () => {
    const engine = await open();
    const hits = await search(engine, "技术交流会", { mode: "hybrid", layers: "evidence" });
    const top = hits[0]!;
    expect(top.evidenceId).toBe("ev-a2");
    expect(top).toMatchObject({ sourceLevel: "self", status: "active" });
    expect(top.channels.evidence_keyword!.rank).toBe(1);
    expect(top.channels.evidence_keyword!.score).toBeGreaterThan(0);
    expect(top.channels.evidence_vector).toBeDefined();
    const expected = 1 / (60 + top.channels.evidence_keyword!.rank) + 1 / (60 + top.channels.evidence_vector!.rank);
    expect(top.fused).toBeCloseTo(expected, 10);
  });

  it("3 个字以下的词退回子串扫描：香菜（两个字）也能找到", async () => {
    const engine = await open({ embedder: false });
    const hits = await search(engine, "香菜", { mode: "hybrid", layers: "evidence" });
    expect(ids(hits)).toEqual(["ev-a3"]);
    expect(hits[0]!.channels.evidence_keyword!.score).toBeGreaterThan(0);
  });

  it("192：问题里单字的状态词（忙、累）也能找到原话", async () => {
    const extra = [draft("ev-b1", "这俩月要上新系统，估计得忙到四月底。", "2026-03-02T12:00:00+08:00"), draft("ev-b2", "连着熬了三个通宵，整个人累垮了。", "2026-03-20T12:00:00+08:00")];
    const engine = await open({ embedder: false, evidence: [...EVIDENCE, ...extra] });
    expect(ids(await search(engine, "那阵子忙吗？", { mode: "hybrid", layers: "evidence" }))).toContain("ev-b1");
    const tired = await search(engine, "累吗", { mode: "hybrid", layers: "evidence" });
    expect(ids(tired)[0]).toBe("ev-b2");
    expect(tired[0]!.channels.evidence_keyword!.score).toBeGreaterThan(0);
  });

  it("没有向量函数时只走关键词", async () => {
    const engine = await open({ embedder: false });
    const hits = await search(engine, "技术交流会", { mode: "hybrid", layers: "both" });
    expect(hits[0]!.evidenceId).toBe("ev-a2");
    expect(Object.keys(hits[0]!.channels).some((c) => c.endsWith("_vector"))).toBe(false);
  });

  it("被忘掉的证据不再出现；被纠正的照样能搜到、标着 corrected", async () => {
    const engine = await open();
    engine.ingestEvidence(draft("ev-a8", "记错了，其实我不讨厌香菜。", "2026-04-01T12:00:00+08:00", { kind: "correction" }));
    engine.correct("ev-a3", "ev-a8");
    engine.invalidateEvidence("ev-a2", "用户要求忘掉");
    const all = await search(engine, "香菜 技术交流会", { mode: "hybrid", limit: 20 });
    expect(ids(all)).not.toContain("ev-a2");
    expect(all.find((h) => h.evidenceId === "ev-a3")?.status).toBe("corrected");
    expect(ids(await search(engine, "技术交流会", { mode: "vector", limit: 20 }))).not.toContain("ev-a2");
  });

  it("只要某些来源等级", async () => {
    const engine = await open();
    const all = await search(engine, "忙得见不着人", { mode: "hybrid", limit: 20 });
    expect(ids(all)).toContain("ev-a4");
    const selfOnly = await search(engine, "忙得见不着人", { mode: "hybrid", limit: 20, sourceLevels: ["self"] });
    expect(ids(selfOnly)).not.toContain("ev-a4");
    expect(selfOnly.every((h) => h.sourceLevel === "self")).toBe(true);
  });
});

describe("时间过滤", () => {
  it("发生时间范围：只要范围里的原话和事实，不知道发生时间的不要", async () => {
    const engine = await open();
    const range: [string, string] = ["2026-10-01T00:00:00+08:00", "2026-10-05T00:00:00+08:00"];
    const hits = await search(engine, "周末聚会 技术交流会 围棋 爬山", { mode: "hybrid", eventRange: range, limit: 20 });
    expect(ids(hits).toSorted()).toEqual(["ev-a1", "ev-a2"]);
  });

  it("有效期 at：精炼陈述这一路只要那时成立的事实（以前喜欢爬山 / 现在不喜欢）", async () => {
    const engine = await open({ embedder: false });
    const before = await search(engine, "爬山", { mode: "hybrid", layers: "statement", at: "2025-11-01T12:00:00+08:00" });
    expect(ids(before)).toEqual(["ev-a5"]);
    const after = await search(engine, "爬山", { mode: "hybrid", layers: "statement", at: "2026-08-01T12:00:00+08:00" });
    expect(ids(after)).toEqual(["ev-a6"]);
    for (const h of [...before, ...after]) for (const f of h.via.factIds) expect(engine.getFact(f)!.evidenceIds).toContain(h.evidenceId);
  });

  it("原话没有有效期，at 不过滤原话；不填 at 精炼陈述也不按有效期过滤", async () => {
    const engine = await open({ embedder: false });
    const evidenceLayer = await search(engine, "爬山", { mode: "hybrid", layers: "evidence", at: "2026-08-01T12:00:00+08:00" });
    expect(ids(evidenceLayer).toSorted()).toEqual(["ev-a5", "ev-a6"]);
    const noAt = await search(engine, "爬山", { mode: "hybrid", layers: "statement" });
    expect(ids(noAt).toSorted()).toEqual(["ev-a5", "ev-a6"]);
  });
});

describe("场景过滤", () => {
  it("strict（190 的做法，194 起要明说）：场景冲突的（周末 vs 工作日）不要；没写场景的、别的维度的照样要", async () => {
    const engine = await open({ embedder: false });
    const q = "周末聚会 技术交流会 香菜 围棋";
    const all = ids(await search(engine, q, { mode: "hybrid", limit: 20 }));
    expect(all).toEqual(expect.arrayContaining(["ev-a1", "ev-a2", "ev-a3", "ev-a7"]));
    const workday = ids(await search(engine, q, { mode: "hybrid", limit: 20, context: ["workday"], contextMode: "strict" }));
    expect(workday).not.toContain("ev-a1");
    expect(workday).toEqual(expect.arrayContaining(["ev-a2", "ev-a3", "ev-a7"]));
  });

  it("194 默认 soft：场景对不上的不扔，只往后排——每一路给它的票乘 0.5，命中里标 offContext；对得上的、没写场景的照常", async () => {
    const engine = await open({ embedder: false });
    const q = "周末聚会 技术交流会 香菜 围棋";
    const none = await search(engine, q, { mode: "hybrid", limit: 20 });
    const soft = await search(engine, q, { mode: "hybrid", limit: 20, context: ["workday"] });
    expect(ids(soft).toSorted()).toEqual(ids(none).toSorted());
    // 各路的名次和不按场景时一样（soft 不扔东西），对不上的融合分正好打对折
    expect(by(soft, "ev-a1").fused).toBeCloseTo(0.5 * by(none, "ev-a1").fused, 10);
    expect(Object.values(by(soft, "ev-a1").channels).every((c) => c!.offContext === true)).toBe(true);
    for (const id of ["ev-a2", "ev-a3", "ev-a7"]) {
      expect(by(soft, id).fused).toBeCloseTo(by(none, id).fused, 10);
      expect(Object.values(by(soft, id).channels).some((c) => c!.offContext)).toBe(false);
    }
    expect(ids(soft).indexOf("ev-a1")).toBeGreaterThanOrEqual(ids(none).indexOf("ev-a1"));
    // 系数可以改
    const quarter = await search(engine, q, { mode: "hybrid", limit: 20, context: ["workday"], contextPenalty: 0.25 });
    expect(by(quarter, "ev-a1").fused).toBeCloseTo(0.25 * by(none, "ev-a1").fused, 10);
  });

  it("soft：精炼陈述那两路看事实的场景，原话那两路看证据的标签", async () => {
    const engine = await open({ embedder: false });
    const hits = await search(engine, "聚会", { mode: "hybrid", context: ["workday"] });
    const a1 = hits.find((h) => h.evidenceId === "ev-a1")!;
    expect(a1.channels.evidence_keyword!.offContext).toBe(true);
    expect(a1.channels.fact_keyword!.offContext).toBe(true);
  });

  it("soft 下 A 组（余弦）：对不上的余弦乘系数", async () => {
    const engine = await open();
    const none = await search(engine, "周末聚会", { mode: "vector", layers: "evidence", limit: 20 });
    const soft = await search(engine, "周末聚会", { mode: "vector", layers: "evidence", limit: 20, context: ["workday"] });
    const a1 = soft.find((h) => h.evidenceId === "ev-a1")!;
    expect(a1.fused).toBeCloseTo(0.5 * none.find((h) => h.evidenceId === "ev-a1")!.fused, 10);
    expect(a1.channels.evidence_vector).toMatchObject({ offContext: true });
  });
});

describe("194：两层都搜时精炼陈述降权", () => {
  it("默认原话两路 1.0、精炼陈述两路 0.5", async () => {
    const engine = await open();
    const [top] = await search(engine, "技术交流会", { mode: "hybrid" });
    const c = top!.channels;
    expect(top!.evidenceId).toBe("ev-a2");
    for (const ch of ["evidence_keyword", "evidence_vector", "fact_keyword", "fact_vector"] as const) expect(c[ch]).toBeDefined();
    const expected = 1 / (60 + c.evidence_keyword!.rank) + 1 / (60 + c.evidence_vector!.rank) + 0.5 / (60 + c.fact_keyword!.rank) + 0.5 / (60 + c.fact_vector!.rank);
    expect(top!.fused).toBeCloseTo(expected, 10);
  });

  it("权重是检索选项：statementWeight = 1 就是 190 的等权", async () => {
    const engine = await open();
    const [top] = await search(engine, "技术交流会", { mode: "hybrid", statementWeight: 1 });
    const c = top!.channels;
    const expected = 1 / (60 + c.evidence_keyword!.rank) + 1 / (60 + c.evidence_vector!.rank) + 1 / (60 + c.fact_keyword!.rank) + 1 / (60 + c.fact_vector!.rank);
    expect(top!.fused).toBeCloseTo(expected, 10);
  });

  it("只搜精炼陈述时不降权（没有原话可让）；图扩展那一路不在降权之列", async () => {
    const engine = await open();
    const [top] = await search(engine, "技术交流会", { mode: "hybrid", layers: "statement" });
    const c = top!.channels;
    expect(top!.fused).toBeCloseTo(1 / (60 + c.fact_keyword!.rank) + 1 / (60 + c.fact_vector!.rank), 10);
    const [kg] = await search(engine, "派对", { mode: "hybrid_kg" });
    const g = kg!.channels;
    const parts = Object.entries(g).map(([ch, s]) => (ch.startsWith("fact_") ? 0.5 : 1) / (60 + s!.rank));
    expect(kg!.fused).toBeCloseTo(parts.reduce((x, y) => x + y, 0), 10);
    expect(g.graph).toBeDefined();
  });
});

describe("C 组 hybrid_kg：图扩展", () => {
  it("问题里认出实体（按别名也行），它的事实的证据加入候选，记下经过的事实和实体", async () => {
    const engine = await open({ embedder: false });
    // "派对"是词表里"聚会"的别名：原话里没有这两个字，关键词找不到，图扩展能找到
    expect(ids(await search(engine, "派对", { mode: "hybrid" }))).toEqual([]);
    const hits = await search(engine, "派对", { mode: "hybrid_kg" });
    expect(ids(hits)).toEqual(["ev-a1"]);
    const entity = engine.store.findEntityByName("聚会")!;
    expect(hits[0]!.via.entityIds).toEqual([entity.id]);
    expect(hits[0]!.channels.graph).toEqual({ rank: 1, score: 1 });
    const fact = engine.getFact(hits[0]!.via.factIds[0]!)!;
    expect(fact.object).toEqual({ type: "entity", id: entity.id });
  });

  it("图扩展也按有效期和场景过滤（场景：strict 不要，soft 往后排、标 offContext）", async () => {
    const engine = await open({ embedder: false });
    const before = await search(engine, "登山", { mode: "hybrid_kg", layers: "statement", at: "2025-11-01T12:00:00+08:00" });
    expect(ids(before)).toEqual(["ev-a5"]);
    const workday = await search(engine, "派对", { mode: "hybrid_kg", context: ["workday"], contextMode: "strict" });
    expect(ids(workday)).toEqual([]);
    const soft = await search(engine, "派对", { mode: "hybrid_kg", context: ["workday"] });
    expect(ids(soft)).toEqual(["ev-a1"]);
    expect(soft[0]!.channels.graph).toEqual({ rank: 1, score: 1, offContext: true });
    expect(soft[0]!.fused).toBeCloseTo(0.5 / 61, 10);
  });

  it("两跳：经过别的实体再走一步（用户本人那里停下，不往外扩），权重减半", async () => {
    const engine = await open({ embedder: false });
    const club = engine.store.insertEntity({ type: "organization", name: "登山社", aliases: [] });
    const hiking = engine.store.findEntityByName("爬山")!;
    const link = engine.store.insertFact(
      {
        subjectId: club.id,
        predicate: "associated_with",
        object: { type: "entity", id: hiking.id },
        negated: false,
        statement: "登山社和爬山有关",
        assertion: "observed",
        context: [],
        evidenceIds: ["ev-a7"],
        eventTime: null,
        observedAt: CLOCK,
        validFrom: null,
        validTo: null,
        status: "active",
        supersededBy: null,
        retractedBy: null,
        contestedWith: [],
        extractedBy: "rule:test",
      },
      { reason: "测试：两跳" },
    );
    const hits = await search(engine, "登山社", { mode: "hybrid_kg", layers: "statement", limit: 20 });
    const one = hits.find((h) => h.evidenceId === "ev-a7")!;
    expect(one.channels.graph!.score).toBe(1);
    expect(one.via.factIds).toContain(link.id);
    const two = hits.filter((h) => h.evidenceId === "ev-a5" || h.evidenceId === "ev-a6");
    expect(two).toHaveLength(2);
    for (const h of two) expect(h.channels.graph!.score).toBe(0.5);
    // 不会经过用户本人走到聚会、香菜那些事实上
    expect(ids(hits)).not.toContain("ev-a1");
  });

  it("没认出实体时和 B 组一样", async () => {
    const engine = await open();
    const b = await search(engine, "好好休息", { mode: "hybrid" });
    const c = await search(engine, "好好休息", { mode: "hybrid_kg" });
    expect(ids(c)).toEqual(ids(b));
  });
});

describe("两层开关（每种模式都有）", () => {
  it("只搜原话没有精炼陈述那两路；只搜精炼陈述没有原话那两路；两层都有、按证据去重", async () => {
    const engine = await open();
    for (const mode of ["vector", "hybrid", "hybrid_kg"] as const) {
      const ev = await search(engine, "周末聚会", { mode, layers: "evidence", limit: 20 });
      expect(ev.every((h) => !h.channels.fact_keyword && !h.channels.fact_vector)).toBe(true);
      const st = await search(engine, "周末聚会", { mode, layers: "statement", limit: 20 });
      expect(st.every((h) => !h.channels.evidence_keyword && !h.channels.evidence_vector)).toBe(true);
      expect(st.length).toBeGreaterThan(0);
      const both = await search(engine, "周末聚会", { mode, limit: 20 });
      expect(new Set(ids(both)).size).toBe(both.length);
      expect(both.some((h) => (h.channels.evidence_keyword || h.channels.evidence_vector) && (h.channels.fact_keyword || h.channels.fact_vector))).toBe(true);
    }
  });
});

describe("D 组 hybrid_kg_rg", () => {
  it("没另接 ReasoningRetrieval 时由自带的推理图谱做：拿 C 组的结果，命中照样带来源", async () => {
    const engine = await open();
    const hits = await search(engine, "为啥", { mode: "hybrid_kg_rg" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.evidenceId).toMatch(/^ev-/);
  });

  it("接上以后拿到的 base 是 C 组的检索，选项照传", async () => {
    const engine = await open();
    const seen: SearchOptions[] = [];
    const rg: ReasoningRetrieval = {
      async search(query, options, base) {
        seen.push(options);
        const hits = await base(query, { ...options, limit: 5 });
        return hits.map((h) => ({ ...h, via: { ...h.via, probeIds: ["pr-0001"] } }));
      },
    };
    engine.setReasoningRetrieval(rg);
    const hits = await search(engine, "派对", { mode: "hybrid_kg_rg", context: ["weekend"] });
    expect(seen).toEqual([{ mode: "hybrid_kg_rg", context: ["weekend"] }]);
    expect(ids(hits)[0]).toBe("ev-a1");
    expect(hits[0]!.channels.graph).toBeDefined();
    expect(hits[0]!.via.probeIds).toEqual(["pr-0001"]);
  });
});
