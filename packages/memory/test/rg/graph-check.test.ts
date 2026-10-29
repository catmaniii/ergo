// 326 号票：图谱自检（rg/graph-check.ts）——每晚校验把整张推理图谱查一遍，记忆系统自己的 TypeScript，不起别的程序。
// 覆盖：整理出来的图通过；几类不合格（传播铁律、引用不在、绕圈、字段不合格；329 号票补悬空、推论没前提）；坏数据（JSON 坏了、
// 词表外的状态）不抛错、照样报；和唯一写入口共用的那几条判断（rg/graph-rules.ts）。不合格的数据都是绕过写入口直接改库造出来的。
import { afterEach, describe, expect, it } from "vitest";
import type { Claim } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { checkReasoningGraph, findCycles } from "../../src/rg/graph-check.ts";
import { isDangling, lacksPremises, premiseHolds, premiseVerified, refExists, storeLookup, type GraphLookup } from "../../src/rg/graph-rules.ts";
import { graphSelfCheck } from "../../src/rg/nightly-validate.ts";
import { claimOf, closeEngines, ingestWeekend, openEngine } from "./helpers.ts";
import { member, NEED, storyEngine } from "./task-helpers.ts";

afterEach(closeEngines);

async function weekend() {
  const t = openEngine("2026-10-09T12:00:00+08:00");
  ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03", "ev-u01"]);
  await t.engine.reflect();
  t.setNow("2026-10-13T12:00:00+08:00");
  ingestWeekend(t.engine, ["ev-w04"]);
  await t.engine.reflect();
  return t;
}

/** 绕过写入口直接改库（造不合格的数据） */
const raw = (engine: MemoryEngine, sql: string, ...params: Array<string | number>) => engine.store.db.run(sql, ...params);

/** 这条结论的成立推断写的前提 */
const premisesOf = (engine: MemoryEngine, claim: Claim) =>
  engine.store
    .inferencesOf(claim.id)
    .filter((i) => i.status === "active")
    .flatMap((i) => i.premiseIds);

/** 往上抽出来的需求（前提是下一层的结论） */
async function lifted() {
  const t = await storyEngine();
  const need = member(t.engine, NEED, "need_autonomy");
  const premiseClaims = premisesOf(t.engine, need).filter((id) => id.startsWith("cl-"));
  return { ...t, need, premiseClaims };
}

const lines = (engine: MemoryEngine) => checkReasoningGraph(engine.store).problems;

describe("整理出来的图通过", () => {
  it("周末社交案例、196 号那个人：一处问题都没有，graphSelfCheck 回通过；查了的节点数是证据、事实、结论加起来", async () => {
    for (const t of [await weekend(), await storyEngine()]) {
      const result = checkReasoningGraph(t.engine.store);
      expect(result.problems).toEqual([]);
      const count = (table: string) => Number(t.engine.store.db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]!.n);
      expect(result.nodes).toBe(count("evidence") + count("facts") + count("claims"));
      expect(result.nodes).toBeGreaterThan(10);
      expect(await graphSelfCheck.validate(t.engine)).toEqual({ state: "ok" });
    }
  });
});

describe("几类不合格", () => {
  it("传播铁律（dependents）：已验证的需求，推出它的下一层结论变成猜测——点名这条需求、写明是哪条前提怎么了，交回要降回猜测的", async () => {
    const t = await lifted();
    expect(t.need.status).toBe("active");
    expect(t.premiseClaims.length).toBeGreaterThan(0);
    const premise = t.premiseClaims[0]!;
    raw(t.engine, "UPDATE claims SET status = 'contested' WHERE id = ?", premise);
    const found = lines(t.engine).filter((p) => p.check === "dependents");
    expect(found).toEqual([{ check: "dependents", subject: t.need.id, message: expect.stringContaining(`${premise}（猜测或拿不准）`) }]);
    expect(checkReasoningGraph(t.engine.store).downgrade).toEqual([t.need.id]);
    const result = await graphSelfCheck.validate(t.engine);
    expect(result).toMatchObject({ state: "failed", downgrade: [t.need.id] });
    // 一行一条，行首是主语
    expect(result.state === "failed" && result.problems.some((line) => line.startsWith(`${t.need.id}：已验证，但推出它的前提`))).toBe(true);
  });

  it("前提事实拿不准、被纠正了：已验证的结论点名（329 号票：拿不准的事实也算没验证）；被新值取代还算已验证；猜测不查铁律", async () => {
    const t = await weekend();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(autonomy.status).toBe("active");
    const facts = premisesOf(t.engine, autonomy).filter((id) => id.startsWith("fa-"));
    expect(facts.length).toBeGreaterThan(1);
    raw(t.engine, "UPDATE facts SET status = 'superseded' WHERE id = ?", facts[1]!);
    expect(lines(t.engine).filter((p) => p.check === "dependents")).toEqual([]);
    raw(t.engine, "UPDATE facts SET status = 'contested' WHERE id = ?", facts[0]!);
    // （那条事实背后明说的结论也点名，这里只看 autonomy）
    const mine = () => lines(t.engine).filter((p) => p.check === "dependents" && p.subject === autonomy.id);
    expect(mine()).toEqual([{ check: "dependents", subject: autonomy.id, message: expect.stringContaining(`${facts[0]}（猜测或拿不准）`) }]);
    raw(t.engine, "UPDATE facts SET status = 'corrected' WHERE id = ?", facts[0]!);
    expect(mine()).toEqual([{ check: "dependents", subject: autonomy.id, message: expect.stringContaining(`${facts[0]}（被纠正了）`) }]);
    // 猜测本来就可以压在没验证的前提上：不查铁律
    raw(t.engine, "UPDATE claims SET status = 'contested' WHERE id = ?", autonomy.id);
    expect(mine()).toEqual([]);
  });

  it("悬空（dangling）、推论没前提（premise）：还活着的结论前提都不在了、或者连一条成立推断都没有，点名；标着复核的不点（等整理重判）", async () => {
    const t = await lifted();
    const value = member(t.engine, "lift:value|autonomy", "value_phase");
    raw(t.engine, "UPDATE claims SET status = 'retracted', retracted_by = 'ev-w1' WHERE id = ?", t.need.id);
    const guess = member(t.engine, NEED, "no_interest");
    raw(t.engine, "UPDATE inferences SET status = 'retracted' WHERE conclusion_claim_id = ?", guess.id);
    expect(lines(t.engine).filter((p) => p.check === "dangling" || p.check === "premise")).toEqual(
      expect.arrayContaining([
        { check: "dangling", subject: value.id, message: expect.stringContaining(`${t.need.id} 都不在了`) },
        { check: "premise", subject: guess.id, message: expect.stringContaining("推论必须有前提") },
      ]),
    );
    raw(t.engine, "UPDATE claims SET needs_review = 1 WHERE id IN (?, ?)", value.id, guess.id);
    expect(lines(t.engine).filter((p) => (p.check === "dangling" || p.check === "premise") && [value.id, guess.id].includes(p.subject))).toEqual([]);
  });

  it("引用不在（exists）：成立推断的前提、关联的目标不存在点名结论；还在的事实的证据不存在点名事实", async () => {
    const t = await weekend();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    const inference = t.engine.store.inferencesOf(autonomy.id).find((i) => i.status === "active")!;
    raw(t.engine, "UPDATE inferences SET premise_ids = ? WHERE id = ?", JSON.stringify([...inference.premiseIds, "fa-nope"]), inference.id);
    raw(t.engine, "INSERT INTO links (claim_id, target, polarity, rationale, weight) VALUES (?, 'ev-nope', 'supports', '编的', 'weak')", autonomy.id);
    const fact = t.engine.store.listFacts({ status: ["active"] })[0]!;
    raw(t.engine, "UPDATE facts SET evidence_ids = ? WHERE id = ?", JSON.stringify([...fact.evidenceIds, "ev-gone"]), fact.id);
    const found = lines(t.engine).filter((p) => p.check === "exists");
    expect(found).toEqual([
      { check: "exists", subject: autonomy.id, message: expect.stringMatching(/fa-nope.*ev-nope.*不存在/) },
      { check: "exists", subject: fact.id, message: "事实的证据 ev-gone 不存在" },
    ]);
    // 编出来的前提不算"不成立"，只算"不在"（不重复报成 dependents）
    expect(lines(t.engine).filter((p) => p.check === "dependents")).toEqual([]);
  });

  it("依赖绕圈（cycle）：两条结论互为前提，报一次，从 id 小的起头", async () => {
    const t = await lifted();
    const [a, b] = [t.need.id, t.premiseClaims[0]!].toSorted();
    raw(t.engine, "INSERT INTO inferences (id, conclusion_claim_id, premise_ids, method, rationale, by, status, created_at) VALUES ('in-loop1', ?, ?, 'induction', '绕回来', 'rule:test', 'active', '2026-10-12T12:00:00+08:00')", a!, JSON.stringify([b]));
    raw(t.engine, "INSERT INTO inferences (id, conclusion_claim_id, premise_ids, method, rationale, by, status, created_at) VALUES ('in-loop2', ?, ?, 'induction', '绕回来', 'rule:test', 'active', '2026-10-12T12:00:00+08:00')", b!, JSON.stringify([a]));
    const found = lines(t.engine).filter((p) => p.check === "cycle");
    expect(found).toEqual([{ check: "cycle", subject: a, message: `依赖绕成了环：${a} → ${b} → ${a}（几条结论互为前提，哪条都推不出来）` }]);
  });

  it("字段不合格（readable）：和存储写入前同一份规矩（domain/validate）——陈述空、状态不在词表里", async () => {
    const t = await weekend();
    const autonomy = claimOf(t.engine, "scene_autonomy");
    raw(t.engine, "UPDATE claims SET statement = '' WHERE id = ?", autonomy.id);
    const fact = t.engine.store.listFacts()[0]!;
    raw(t.engine, "UPDATE facts SET status = 'maybe' WHERE id = ?", fact.id);
    const found = lines(t.engine).filter((p) => p.check === "readable");
    expect(found).toEqual([
      { check: "readable", subject: fact.id, message: expect.stringContaining("事实字段不合格：status 是 \"maybe\"") },
      { check: "readable", subject: autonomy.id, message: expect.stringContaining("结论字段不合格：statement 应为非空字符串") },
    ]);
    // 问题按检查的先后排：readable 在最前
    expect(lines(t.engine)[0]!.check).toBe("readable");
  });
});

describe("坏数据", () => {
  it("JSON 坏了的结论、推断、事实：各记一条读不出来，不抛错，别的照查", async () => {
    const t = await lifted();
    const other = member(t.engine, NEED, "need_autonomy");
    raw(t.engine, "UPDATE claims SET context = '{坏了' WHERE id = ?", t.premiseClaims[0]!);
    const inference = t.engine.store.inferencesOf(other.id).find((i) => i.status === "active")!;
    raw(t.engine, "UPDATE inferences SET premise_ids = '[坏了' WHERE id = ?", inference.id);
    const fact = t.engine.store.listFacts()[0]!;
    raw(t.engine, "UPDATE facts SET evidence_ids = 'null' WHERE id = ?", fact.id);
    let result: ReturnType<typeof checkReasoningGraph> | undefined;
    expect(() => (result = checkReasoningGraph(t.engine.store))).not.toThrow();
    const readable = result!.problems.filter((p) => p.check === "readable");
    expect(readable).toContainEqual({ check: "readable", subject: t.premiseClaims[0]!, message: expect.stringContaining("结论读不出来") });
    expect(readable).toContainEqual({ check: "readable", subject: other.id, message: expect.stringContaining(`推断 ${inference.id} 读不出来`) });
    expect(readable).toContainEqual({ check: "readable", subject: fact.id, message: expect.stringContaining("事实字段不合格：evidenceIds 应为数组") });
    expect(result!.nodes).toBeGreaterThan(10);
  });

  it("空库：通过，0 个节点", () => {
    const t = openEngine("2026-10-12T12:00:00+08:00");
    expect(checkReasoningGraph(t.engine.store)).toEqual({ nodes: 0, problems: [], downgrade: [] });
  });
});

/** 邻接表 → 往下走的函数 */
const graph = (edges: Record<string, string[]>) => (id: string) => edges[id] ?? [];
/** 按给的状态查 */
const lookup = (statuses: Record<string, string>, premises: Record<string, string[]> = {}, flagged: string[] = []): GraphLookup => ({
  statusOf: (id) => statuses[id],
  premisesOf: (id) => premises[id] ?? [],
  flagged: (id) => flagged.includes(id),
});

describe("找环（findCycles）", () => {
  it("没有环、自己指向自己、两个环、同一个环从不同的点进去只报一次", () => {
    expect(findCycles(["a", "b", "c"], graph({ a: ["b"], b: ["c"] }))).toEqual([]);
    expect(findCycles(["a"], graph({ a: ["a"] }))).toEqual([["a"]]);
    expect(findCycles(["c", "a", "x"], graph({ a: ["b"], b: ["c"], c: ["a"], x: ["y"], y: ["x"] }))).toEqual([
      ["a", "b", "c"],
      ["x", "y"],
    ]);
  });

  it("很长的链（两万层）不爆栈：不设深度上限", () => {
    const n = 20_000;
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    expect(findCycles(ids, (id) => (id === `n${n - 1}` ? [] : [`n${Number(id.slice(1)) + 1}`]))).toEqual([]);
    expect(findCycles(ids, (id) => [`n${(Number(id.slice(1)) + 1) % n}`])).toHaveLength(1);
  });
});

describe("和唯一写入口共用的判断（graph-rules）", () => {
  it("前提还在（不留悬空）和前提已验证（传播铁律）只差在猜测上：猜测还在、但没验证；撤回、被取代的不在", () => {
    const l = lookup({ "cl-a": "active", "cl-b": "contested", "cl-d": "retracted", "cl-e": "superseded" });
    expect(["cl-a", "cl-b", "cl-d", "cl-e", "cl-x"].map((id) => premiseHolds(l, id))).toEqual([true, true, false, false, false]);
    expect(["cl-a", "cl-b", "cl-d", "cl-e", "cl-x"].map((id) => premiseVerified(l, id))).toEqual([true, false, false, false, false]);
  });

  it("事实成立、拿不准、被新值取代都还在，被纠正、撤回的不在；拿不准的事实没验证（329 号票），被新值取代的在有效期内还算已验证；证据有效才算；不认识的 id 不在", () => {
    const l = lookup({ "fa-1": "active", "fa-2": "contested", "fa-3": "superseded", "fa-4": "corrected", "fa-5": "retracted", "ev-1": "active", "ev-2": "forgotten", "en-1": "x" });
    const ids = ["fa-1", "fa-2", "fa-3", "fa-4", "fa-5", "ev-1", "ev-2", "en-1"];
    expect(ids.map((id) => premiseHolds(l, id))).toEqual([true, true, true, false, false, true, false, false]);
    expect(ids.map((id) => premiseVerified(l, id))).toEqual([true, false, true, false, false, true, false, false]);
    expect(refExists(l, "fa-4")).toBe(true);
    expect(refExists(l, "fa-9")).toBe(false);
  });

  it("悬空、推论没前提：只看还活着、没标复核的", () => {
    const l = lookup({ "cl-a": "contested", "cl-b": "active", "cl-c": "retracted", "fa-1": "retracted", "fa-2": "active", "cl-f": "contested" }, { "cl-a": ["fa-1"], "cl-b": ["fa-1", "fa-2"], "cl-c": ["fa-1"], "cl-f": ["fa-1"] }, ["cl-f"]);
    expect(["cl-a", "cl-b", "cl-c", "cl-f"].map((id) => isDangling(l, id))).toEqual([true, false, false, false]);
    const bare = lookup({ "cl-a": "active", "cl-b": "retracted", "cl-f": "contested" }, {}, ["cl-f"]);
    expect(["cl-a", "cl-b", "cl-f"].map((id) => lacksPremises(bare, id))).toEqual([true, false, false]);
  });

  it("按存储现查（写入口用的那一份）和图谱自检读到的状态一致", async () => {
    const t = await weekend();
    const l = storeLookup(t.engine.store);
    const autonomy = claimOf(t.engine, "scene_autonomy");
    expect(l.statusOf(autonomy.id)).toBe("active");
    expect(l.statusOf("ev-w01")).toBe("active");
    expect(l.statusOf("cl-nope")).toBeUndefined();
    expect(l.statusOf("in-1")).toBeUndefined();
  });
});
