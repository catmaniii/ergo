// 218 号票：出假设、往上抽、编策略这几步不能整个失败——分批、截断和解析失败自己恢复、没过门槛写明原因、建库统计。
// 假模型按剧本回（能标 finish_reason = length），不调 DeepSeek。例子都是自己写的。
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceDraft } from "../../src/domain/types.ts";
import type { ChatModel, ChatRequest, ChatResponse } from "../../src/llm/chat.ts";
import { askInBatches, chunkEvenly, inspectOutput, salvageList, type BatchPlan, type StageStatsMap } from "../../src/llm/robust.ts";
import { formatBuildStats, storeShape } from "../../src/rg/build-stats.ts";
import { LIFT_BATCH_PREMISES, LIFT_SYSTEM_VALUE, liftBatches, liftMaxTokens, liftRequest } from "../../src/rg/llm-lift.ts";
import { LlmReasoner, PROPOSE_BATCH_OBSERVATIONS, PROPOSE_MAX_GROUPS, proposeOutputEstimate } from "../../src/rg/llm-reasoner.ts";
import { strategyMaxTokens } from "../../src/rg/llm-strategies.ts";
import { createBudget } from "../../src/rg/reasoning-graph.ts";
import type { DroppedOutput } from "../../src/rg/types.ts";
import { closeEngines, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const NOW = "2026-10-20T12:00:00+08:00";

/** 按剧本回的模型：回字符串或带 truncated 的回应 */
class ScriptedModel implements ChatModel {
  readonly name = "scripted";
  readonly calls: ChatRequest[] = [];
  private readonly respond: (r: ChatRequest) => string | { content: string; truncated: boolean };
  constructor(respond: (r: ChatRequest) => string | { content: string; truncated: boolean }) {
    this.respond = respond;
  }
  complete(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const out = this.respond(request);
    const r = typeof out === "string" ? { content: out, truncated: false } : out;
    return Promise.resolve({ ...r, usage: { inputTokens: 0, outputTokens: 0 } });
  }
}

const res = (content: string, truncated = false): ChatResponse => ({ content, usage: { inputTokens: 0, outputTokens: 0 }, truncated });
const reasons = (dropped: readonly DroppedOutput[], stage?: string) => dropped.filter((d) => !stage || d.stage === stage).map((d) => d.reason);

describe("宽松解析：判截断，从完整的条目里取出能用的，丢掉最后半条", () => {
  it("被截断的半截 JSON：完整的条目照取（字符串里的括号不算），最后半条丢掉；没标 finish_reason、括号没收口也算截断", () => {
    const content = '{"groups": [{"id": "a", "note": "含 } 和 ] 的字"}, {"id": "b"}, {"id": "c", "obs';
    expect(salvageList(content, "groups")).toEqual({ items: [{ id: "a", note: "含 } 和 ] 的字" }, { id: "b" }], partial: true, bad: 0 });
    expect(inspectOutput(res(content, true), "groups")).toMatchObject({ outcome: "truncated", partial: true, items: [{ id: "a" }, { id: "b" }] });
    expect(inspectOutput(res(content), "groups").outcome).toBe("truncated");
  });

  it("整段乱码解析不了、救不回；括号收口了、中间一条坏了的，坏的丢掉、别的照取；空回答单算；围栏里的照常解析", () => {
    expect(inspectOutput(res("抱歉，这个我没法回答"), "groups")).toMatchObject({ outcome: "unparsed", items: [] });
    expect(inspectOutput(res('{"groups": [{"id": "a"}, {"id": b}, {"id": "c"}]}'), "groups")).toMatchObject({ outcome: "unparsed", items: [{ id: "a" }, { id: "c" }], bad: 1 });
    expect(inspectOutput(res(""), "groups").outcome).toBe("empty");
    expect(inspectOutput(res('```json\n{"groups": [{"id": "a"}]}\n```'), "groups")).toMatchObject({ outcome: "ok", items: [{ id: "a" }] });
  });

  it("237 号票：模型把列表的 ] 写成 }（该是条目的地方是个 }）——救回完整的条目、记一条坏的，不原地打转", () => {
    // 不修之前这里 i = end 原地转，整段建库卡死（CPU 打满、再也不调模型）
    expect(salvageList('{"groups": [{"id": "a"}, {"id": "b"}}', "groups")).toEqual({ items: [{ id: "a" }, { id: "b" }], partial: false, bad: 1 });
    expect(inspectOutput(res('{"groups": [{"id": "a"}, {"id": "b"}}'), "groups")).toMatchObject({ outcome: "truncated", items: [{ id: "a" }, { id: "b" }], bad: 1 });
    expect(inspectOutput(res('{"groups": [{"id": "a"}}'), "groups")).toMatchObject({ outcome: "truncated", items: [{ id: "a" }], bad: 1 });
  });
});

const units = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `u${i + from}`);
const ok = (r: ChatRequest) => JSON.stringify({ groups: [{ ids: r.user.split(",") }] });

describe("分批问：每批独立，截断、解析不了的剩下的对半切小重试，最多两层", () => {
  const plan: BatchPlan<string> = {
    stage: "propose",
    listKey: "groups",
    unitLabel: "条观察",
    unitId: (u) => u,
    request: (us) => ({ purpose: "propose", system: "s", user: us.join(","), maxTokens: 100 }),
    covers: (item) => (item as { ids: string[] }).ids,
  };
  const run = async (model: ChatModel, batches: string[][], limit = 40) => {
    const dropped: DroppedOutput[] = [];
    const stats: StageStatsMap = {};
    const out = await askInBatches(model, plan, batches, { budget: createBudget(limit), dropped, stats });
    return { ...out, dropped, stats: stats.propose! };
  };

  it("切批：一样大，差不超过一个", () => {
    expect(chunkEvenly(units(20), 16).map((b) => b.length)).toEqual([10, 10]);
    expect(chunkEvenly(units(33), 16).map((b) => b.length)).toEqual([11, 11, 11]);
    expect(chunkEvenly([], 16)).toEqual([]);
  });

  it("被截断：救回完整的那条，剩下的对半切成两批再问；每一步记进 dropped，统计记截断、救回、重试、恢复", async () => {
    const model = new ScriptedModel((r) => (r.user === units(8).join(",") ? { content: '{"groups": [{"ids": ["u1", "u2"]}, {"ids": ["u3"', truncated: true } : ok(r)));
    const { items, dropped, stats } = await run(model, [units(8)]);
    expect(model.calls.map((c) => c.user)).toEqual([units(8).join(","), "u3,u4,u5", "u6,u7,u8"]);
    expect(items).toEqual([{ ids: ["u1", "u2"] }, { ids: ["u3", "u4", "u5"] }, { ids: ["u6", "u7", "u8"] }]);
    expect(stats).toMatchObject({ calls: 3, batches: 1, truncated: 1, unparsed: 0, salvaged: 1, retries: 2, recovered: 1, lost: 0 });
    const text = reasons(dropped).join("\n");
    expect(text).toContain("模型输出被截断：到了上限 maxTokens 100（救回 1 条完整的，丢掉最后半条；这批 8 条观察，剩 6 没着落）");
    expect(text).toContain("对半切小重试：剩下的 6 条观察切成 2 批再问（第 1 层）");
  });

  it("一批全是乱码：对半切两层还不行就放弃、记下来；别的批照常", async () => {
    const model = new ScriptedModel((r) => (r.user.includes("u9") ? ok(r) : "这一段不是 JSON"));
    const { items, dropped, stats } = await run(model, [units(8), units(2, 9)]);
    // 8 → 4 + 4 → 2 + 2 + 2 + 2，一共 7 次；另一批 1 次
    expect(model.calls).toHaveLength(8);
    expect(items).toEqual([{ ids: ["u9", "u10"] }]);
    expect(stats).toMatchObject({ calls: 8, batches: 2, unparsed: 7, retries: 6, recovered: 0, lost: 4 });
    expect(reasons(dropped).filter((r) => r.startsWith("放弃：对半切了 2 层还是不行"))).toHaveLength(4);
    expect(dropped.find((d) => d.reason.startsWith("放弃"))!.item).toEqual(["u1", "u2"]);
  });

  it("空回答（调用失败、封顶）不重试：切小了也一样发不出去", async () => {
    const model = new ScriptedModel(() => "");
    const { dropped, stats } = await run(model, [units(4)]);
    expect(model.calls).toHaveLength(1);
    expect(stats).toMatchObject({ calls: 1, empty: 1, lost: 1, retries: 0 });
    expect(reasons(dropped)[0]).toMatch(/^模型没有回答/);
  });

  it("预算用完：重试那批没问的记下来，不再发", async () => {
    const model = new ScriptedModel(() => "乱码");
    const { dropped, stats } = await run(model, [units(4)], 2);
    expect(model.calls).toHaveLength(2);
    // 4 → 2 + 2：头一半问了（第 2 次）还是乱码，它的两半和后一半都没预算
    expect(stats).toMatchObject({ calls: 2, retries: 1, unasked: 3 });
    expect(reasons(dropped).some((r) => r.startsWith("预算用完，没重试"))).toBe(true);
  });
});

// ---------- 出假设 ----------

const ACTIVITIES = ["爬山", "游泳", "跑步", "看电影", "打羽毛球", "聚餐", "唱歌", "钓鱼", "骑车", "露营", "下棋", "画画", "做饭", "逛街", "旅行", "跳舞", "打篮球", "看书", "徒步", "滑雪"];
/** 20 条：10 次周末推掉活动、10 条说喜欢 */
const MANY: EvidenceDraft[] = ACTIVITIES.map((a, i) =>
  say(`ev-${i}`, i % 2 ? `我喜欢${a}` : `周末我不想去${a}`, `2026-0${1 + (i % 9)}-1${i % 10}T10:00:00+08:00`, { context: [i % 3 ? "weekend" : "workday"] }),
);

const parseLines = (ls: string[]) => ls.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { fact_id: string; statement: string });

/** 请求里"这一批的观察"那一段的事实（写全的，带原话）和"别的事实"那一段的 */
function sections(r: ChatRequest): { batch: { fact_id: string; statement: string; evidence?: unknown[] }[]; others: { fact_id: string }[] } {
  const lines = r.user.split("\n");
  const a = lines.findIndex((l) => l.startsWith("这一批的观察"));
  const b = lines.findIndex((l) => l.startsWith("别的事实"));
  return { batch: parseLines(lines.slice(a + 1, b)), others: parseLines(lines.slice(b + 1)) };
}

/** 给一批的前两条观察出一组两条解释 */
const groupFor = (ids: string[], tag: string) => ({
  observation_ids: ids,
  description: `${tag}：${ids.join("、")}`,
  hypotheses: [
    { tier: "preference", statement: `${tag}：用户不喜欢这类活动（${ids.join("、")}）`, context: [], supports: [], refutes: [] },
    { tier: "state", statement: `${tag}：用户那阵子太忙（${ids.join("、")}）`, context: [], supports: [], refutes: [] },
  ],
});

/** 出假设一批最多 16 条（默认 40 条，这里 20 条观察要切成两批） */
async function reflectWith(model: ChatModel, story: readonly EvidenceDraft[] = MANY) {
  const t = openEngine(NOW, { reasoner: new LlmReasoner(model, { proposeBatch: 16 }) });
  for (const e of story) t.engine.ingestEvidence(e);
  const report = await t.engine.reflect();
  return { ...t, report };
}

describe("出假设分批：一次调用里塞的观察少到不会超长", () => {
  it(`估的输出按组数封顶（一批最多 ${PROPOSE_MAX_GROUPS} 组），离 8000 的上限有余量；默认一批最多 ${PROPOSE_BATCH_OBSERVATIONS} 条`, () => {
    expect([3, 12, PROPOSE_BATCH_OBSERVATIONS].map(proposeOutputEstimate)).toEqual([460, 1840, 2760]);
    const view = { usableFact: () => true } as unknown as Parameters<LlmReasoner["proposeBatches"]>[1]["view"];
    const facts = Array.from({ length: 81 }, (_, i) => ({ id: `fa-${i}`, predicate: "declined", negated: false, context: [], object: { type: "entity", id: `en-${i % 5}` } })) as unknown as Parameters<LlmReasoner["proposeBatches"]>[0];
    expect(new LlmReasoner(new ScriptedModel(() => "")).proposeBatches(facts, { view }).map((b) => b.length)).toEqual([27, 27, 27]);
  });

  it("新的观察多于一批的条数时切成一样大的几批，同一类现象挨在一起；这批的写全，别的事实只写摘要；后一批看得到前一批出的组", async () => {
    const model = new ScriptedModel((r) => {
      if (r.purpose !== "propose") return r.purpose === "judge" ? '{"found_evidence_ids": [], "links": []}' : '{"probes": []}';
      const { batch } = sections(r);
      return JSON.stringify({ groups: [groupFor(batch.slice(0, 2).map((f) => f.fact_id), "第" + (model.calls.filter((c) => c.purpose === "propose").length) + "批")] });
    });
    const { engine, report } = await reflectWith(model);
    const proposals = model.calls.filter((c) => c.purpose === "propose");
    expect(proposals).toHaveLength(2);
    const [first, second] = proposals.map(sections);
    expect(first!.batch).toHaveLength(10);
    expect(second!.batch).toHaveLength(10);
    // 推掉的一批、说喜欢的一批
    expect(first!.batch.every((f) => f.statement.includes("拒绝"))).toBe(true);
    expect(second!.batch.every((f) => f.statement.includes("偏好"))).toBe(true);
    expect(first!.batch.every((f) => Array.isArray(f.evidence))).toBe(true);
    expect(first!.others).toHaveLength(10);
    expect(first!.others.every((f) => !("evidence" in f))).toBe(true);
    expect(proposals[1]!.user).toContain("第1批");
    expect(proposals.every((c) => c.system.includes("最多 6 组"))).toBe(true);
    expect(engine.rg.registry.listGroups().filter((g) => g.pattern === "model")).toHaveLength(2);
    expect(report.stats!.steps.propose).toMatchObject({ calls: 2, batches: 2, truncated: 0, unparsed: 0 });
  });

  it("237 号票：出假设的回复把列表的 ] 写成 } 时不会卡死（救回完整的组，整理照常结束）", async () => {
    // 229 号票 p2 那次卡死就是这个形状：propose 的响应回来了，本地解析原地打转、CPU 打满、再不调模型
    const model = new ScriptedModel((r) => {
      if (r.purpose !== "propose") return r.purpose === "judge" ? '{"found_evidence_ids": [], "links": []}' : '{"probes": []}';
      const { batch } = sections(r);
      const ids = batch.map((f) => f.fact_id);
      // 少写列表的 ]，用 } 收尾："groups": [{…}}
      return `{"groups":[${JSON.stringify(groupFor(ids.slice(0, 2), "写坏了"))}}`;
    });
    const { engine, report } = await reflectWith(model);
    // 卡死的话这条测试就过不了（testTimeout）；救回来的那组照常进图谱
    expect(engine.rg.registry.listGroups().filter((g) => g.pattern === "model").length).toBeGreaterThan(0);
    expect(reasons(report.dropped, "propose").join("\n")).toMatch(/截断|解析不了/);
  });

  it("一批的输出被截断、另一批整段乱码：截断的救回完整的组、剩下的观察切小再问；乱码的切两层后放弃——整理不失败，能出的组照常进图谱", async () => {
    const model = new ScriptedModel((r) => {
      if (r.purpose !== "propose") return r.purpose === "judge" ? '{"found_evidence_ids": [], "links": []}' : '{"probes": []}';
      const { batch } = sections(r);
      const ids = batch.map((f) => f.fact_id);
      if (!batch[0]!.statement.includes("拒绝")) return "模型说了一段话，不是 JSON";
      if (batch.length === 10) return { content: `{"groups": [${JSON.stringify(groupFor(ids.slice(0, 2), "截断前"))}, {"observation_ids": ["${ids[2]}", "`, truncated: true };
      return JSON.stringify({ groups: [groupFor(ids.slice(0, 2), `重试${ids.length}`)] });
    });
    const { engine, report } = await reflectWith(model);
    const groups = engine.rg.registry.listGroups().filter((g) => g.pattern === "model");
    // 截断前那组 + 剩下 8 条切成两批各出一组
    expect(groups.map((g) => g.description.split("：")[0])).toEqual(["截断前", "重试4", "重试4"]);
    expect(report.stats!.steps.propose).toMatchObject({ calls: 10, batches: 2, truncated: 1, unparsed: 7, salvaged: 1, retries: 8, recovered: 1, lost: 4 });
    const text = reasons(report.dropped, "propose").join("\n");
    expect(text).toContain("模型输出被截断：到了上限 maxTokens 8000（救回 1 条完整的，丢掉最后半条；这批 10 条观察，剩 8 没着落）");
    expect(text).toContain("模型输出解析不了");
    expect(text).toContain("放弃：对半切了 2 层还是不行");
    expect(report.budgetExhausted).toBe(false);
  });
});

// ---------- 往上抽 ----------

/** 三种场景（周末社交、假期家里、工作日工作，229 号票起要方面不同才算两种）、三个月都说不喜欢被排满 */
const STORY: EvidenceDraft[] = [
  say("ev-1", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-2", "假期我也不喜欢被提前排满", "2026-08-02T10:00:00+08:00", { context: ["holiday", "family"] }),
  say("ev-3", "工作日我也不喜欢被提前排满", "2026-10-09T10:00:00+08:00", { context: ["workday", "work"] }),
];

const premisesOf = (r: ChatRequest) =>
  r.user
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as { claim_id: string; facts?: { fact_id: string; role: string }[] })
    .filter((p) => typeof p.claim_id === "string");

/** 下层断言的支持事实 */
const supportFacts = (r: ChatRequest) => [...new Set(premisesOf(r).flatMap((p) => (p.facts ?? []).filter((f) => f.role === "supports").map((f) => f.fact_id)))];

/** 往上抽的一组：两条解释，第一条有两条强支持（这样能成立、再往上抽、编策略） */
const liftGroup = (theme: string, ids: string[], tiers: [string, string] = ["need", "state"], strong: string[] = []) => ({
  theme,
  premise_ids: ids,
  description: theme,
  hypotheses: [
    { tier: tiers[0], statement: `${theme}：用户需要自己掌控时间`, domains: ["schedule", "bogus"], supports: strong.map((target) => ({ target, weight: "strong", rationale: "明说的" })), refutes: [], probe: { against: 1, ask: "自己定时间的话会去吗？", queries: ["自己定"] } },
    { tier: tiers[1], statement: `${theme}：用户只是这阵子太忙`, domains: ["schedule"], supports: [], refutes: [], probe: { against: 0, ask: "这阵子忙吗？", queries: ["加班"] } },
  ],
});

const valueOutput = (r: ChatRequest) => {
  const facts = supportFacts(r);
  return JSON.stringify({ groups: [liftGroup("价值", premisesOf(r).map((p) => p.claim_id), ["value", "need"], [facts[0]!, facts[1]!])] });
};
const needOutput = (theme: string, r: ChatRequest, ids = premisesOf(r).map((p) => p.claim_id)) => {
  const facts = supportFacts(r);
  return liftGroup(theme, ids, ["need", "state"], [facts[0]!, facts[2]!]);
};

function liftModel(need: (r: ChatRequest) => string | { content: string; truncated: boolean }) {
  return new ScriptedModel((r) => {
    if (r.purpose === "propose") return '{"groups": []}';
    if (r.purpose === "lift") return r.system === LIFT_SYSTEM_VALUE ? valueOutput(r) : need(r);
    if (r.purpose === "strategies") return '{"strategies": []}';
    if (r.purpose === "judge") return '{"found_evidence_ids": [], "links": []}';
    return '{"probes": []}';
  });
}

describe("往上抽：输出上限按候选数估，候选太多分批，截断能救", () => {
  it("输出上限按这一批的下层断言条数估（2000 到 8000），不写死 2000；编策略同样按依据个数估", () => {
    expect([3, 10, 16, 40].map(liftMaxTokens)).toEqual([2000, 4500, 7200, 8000]);
    expect([2, 10, 30].map(strategyMaxTokens)).toEqual([1500, 4500, 8000]);
  });

  it(`候选多于 ${LIFT_BATCH_PREMISES} 条时分批：这批的写全，别的只写摘要；问之前全体过了门槛才问`, async () => {
    const story = ACTIVITIES.map((a, i) => say(`ev-${i}`, `我不喜欢${a}`, `2026-0${1 + (i % 9)}-0${1 + (i % 9)}T10:00:00+08:00`, { context: [["weekend", "social"], ["holiday", "family"], ["workday", "work"]][i % 3]! }));
    const model = liftModel(() => '{"groups": []}');
    const { engine } = await reflectWith(model, story);
    const view = engine.rg.view();
    const inputs = engine.rg.liftInputs("need", view);
    expect(inputs).toHaveLength(20);
    const batches = liftBatches(inputs);
    expect(batches.map((b) => b.length)).toEqual([10, 10]);
    const r = liftRequest("need", inputs, view, [], new Set(), { focus: batches[0]!, prior: [liftGroup("前一批", [inputs[0]!.claim.id])] })!;
    expect(r.maxTokens).toBe(liftMaxTokens(10));
    expect(r.user).toContain("这一批要归纳的下层断言");
    expect(r.user).toContain("主题「前一批」");
    const lines = premisesOf(r);
    expect(lines).toHaveLength(20);
    expect(lines.filter((p) => p.facts !== undefined)).toHaveLength(10);
    expect(model.calls.filter((c) => c.purpose === "lift" && c.system !== LIFT_SYSTEM_VALUE)).toHaveLength(2);
    // 一批就够时照旧全部写全
    expect(liftRequest("need", inputs, view)!.user).not.toContain("这一批要归纳的");
  });

  it("往上抽的输出被截断：完整的组照常进图谱，记进 dropped 和统计", async () => {
    const model = liftModel((r) => ({ content: `{"groups": [${JSON.stringify(liftGroup("自己掌控时间", premisesOf(r).map((p) => p.claim_id)))}, {"theme": "半截`, truncated: true }));
    const { engine, report } = await reflectWith(model, STORY);
    expect(engine.rg.registry.listGroups().find((g) => g.pattern === "lift:need")?.key).toBe("lift:need|model:自己掌控时间");
    expect(report.stats!.steps.lift).toMatchObject({ truncated: 1, salvaged: 1, recovered: 1, lost: 0 });
    expect(reasons(report.dropped, "lift").join("\n")).toContain("模型输出被截断：到了上限 maxTokens 2000（救回 1 条完整的，丢掉最后半条");
  });
});

describe("没过门槛写明是哪一条没过，按原因计数（门槛的数不改）", () => {
  it("模型交回的组按它挑的下层断言再判：差在场景、月份、证据条数的各记一次，带差多少；别的丢法（领域不认得）另记", async () => {
    const model = liftModel((r) => {
      const ids = premisesOf(r).map((p) => p.claim_id);
      return JSON.stringify({ groups: [liftGroup("两条", ids.slice(0, 2)), liftGroup("一条", ids.slice(0, 1)), needOutput("全部", r)] });
    });
    const { report } = await reflectWith(model, STORY);
    const gate = report.stats!.lift;
    // 需求层：两条的（结构过了、证据不到三条）先出临时结论；一条的连结构都没过；全部的过了；价值层过了一组
    expect(gate).toMatchObject({
      passed: 2,
      provisional: 1,
      failed: 1,
      byReason: { 场景不够: 1, 证据条数不够: 1, 月份不够: 1 },
      provisionalByReason: { 证据条数不够: 1 },
    });
    expect(gate.failures).toEqual([
      { level: "need", reasons: ["场景不够", "证据条数不够", "月份不够"], premises: 1, disjointScenes: false, scenes: 1, months: 1, evidence: 1, spanDays: 0 },
    ]);
    expect(gate.rejected).toMatchObject({ 领域不认得: 3 });
    expect(gate.notAsked).toEqual({});
    expect(reasons(report.dropped, "lift")).toContainEqual(expect.stringMatching(/^没过门槛：场景不够：.*；证据条数不够：.*；月份不够：/));
  });

  it("问之前这一层全体就没过门槛（连结构都不过）：不问，按'层：原因'记数", async () => {
    const model = liftModel(() => '{"groups": []}');
    const { report } = await reflectWith(model, STORY.slice(0, 1));
    expect(model.calls.filter((c) => c.purpose === "lift")).toHaveLength(0);
    expect(report.stats!.lift.notAsked).toEqual({ "need：场景不够+证据条数不够+月份不够": 1 });
  });
});

describe("编策略的输出被截断也能救；建库的统计", () => {
  it("编策略截断：救回完整的那条照常建；reflect 报告带每一步的统计，当前库的样子按层数", async () => {
    const model = new ScriptedModel((r) => {
      if (r.purpose === "propose") return '{"groups": []}';
      if (r.purpose === "lift") return r.system === LIFT_SYSTEM_VALUE ? valueOutput(r) : JSON.stringify({ groups: [needOutput("自己掌控时间", r)] });
      if (r.purpose === "strategies") {
        const key = (JSON.parse(r.user.split("\n").find((l) => l.startsWith("{"))!) as { key: string }).key;
        return `{"strategies": [{"key": "${key}", "when": "替用户安排周末或假期的时间时", "actions": ["每天至少留出半天不排任何事"], "domains": ["schedule"]}, {"key": "x", "when": "半`;
      }
      if (r.purpose === "judge") return '{"found_evidence_ids": [], "links": []}';
      return '{"probes": []}';
    });
    const { engine, report } = await reflectWith(model, STORY);
    expect(engine.store.listStrategies()).toHaveLength(1);
    const steps = report.stats!.steps;
    expect(steps.strategies).toMatchObject({ calls: 1, truncated: 1, salvaged: 1, recovered: 1 });
    expect(steps.propose).toMatchObject({ calls: 1 });
    expect(steps.lift).toMatchObject({ calls: 2, truncated: 0 });
    const shape = storeShape(engine);
    // 明说的三条偏好，需求层一组（需求、近期状态），价值层一组（价值观、现阶段的需求）
    expect(shape).toMatchObject({ groups: 2, strategies: 1, tiers: { preference: 3, state: 1, need: 2, value: 1 } });
    expect(shape.claims).toBe(shape.tiers.state + shape.tiers.preference + shape.tiers.need + shape.tiers.value);
    const line = formatBuildStats(report.stats, shape);
    expect(line).toContain(`当前 ${shape.claims} 条结论、2 组`);
    expect(line).toContain("strategies 1（1 批）［截断 1、救回 1 条、恢复 1］");
    expect(line).toContain("往上抽的组过门槛 2、没过 0");
  });
});

const ids = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]!);

describe("预算留一份给往上抽、编策略", () => {
  it("出假设、追问、判证据最多用到预算的 3/4；前面没做完的算预算用完，证据下次接着整理。334 号票起后 1/4 先给编策略留（不到 4 次全留），往上抽用剩下的", async () => {
    const model = new ScriptedModel((r) => {
      if (r.purpose === "propose") return JSON.stringify({ groups: [groupFor(sections(r).batch.slice(0, 2).map((f) => f.fact_id), "周末")] });
      if (r.purpose === "probes") {
        const [a, b] = ids(/"claim_id":"(cl-[^"]+)"/g, r.user);
        return JSON.stringify({ probes: ["排满", "周末", "假期", "工作日", "满满的", "提前"].map((q) => ({ discriminates: [a, b], ask: `${q}的时候怎么样？`, queries: [q, "不喜欢"], if_found: a })) });
      }
      if (r.purpose === "judge") return '{"found_evidence_ids": [], "links": []}';
      if (r.purpose === "lift") return r.system === LIFT_SYSTEM_VALUE ? valueOutput(r) : JSON.stringify({ groups: [needOutput("自己掌控时间", r)] });
      return '{"strategies": []}';
    });
    const t = openEngine(NOW, { reasoner: new LlmReasoner(model) });
    for (const e of STORY) t.engine.ingestEvidence(e);
    const report = await t.engine.reflect({ maxModelCalls: 8 });
    const purposes = model.calls.map((c) => c.purpose);
    // 前一段最多 6 次（8 − 2）：出假设 1、追问 1、判证据 4；后一段的 2 次都留给编策略（334），往上抽一次也轮不到
    expect(purposes).toEqual(["propose", "probes", "judge", "judge", "judge", "judge"]);
    expect(report).toMatchObject({ modelCalls: 6, budgetExhausted: true, processedEvidenceIds: [] });
  });
});

/** 出假设：按场景各出一组，第一条解释两条强支持（能成立），写不写场景由 withContext 定 */
const declineModel = (withContext: boolean) =>
  new ScriptedModel((r) => {
    if (r.purpose === "propose") {
      const facts = sections(r).batch;
      const groups = (["周末", "工作日"] as const).map((tag, i) => {
        const obs = facts.filter((f) => f.statement.includes(`在${tag}`)).map((f) => f.fact_id);
        const scene = withContext ? [["weekend", "social"], ["workday", "work"]][i]! : [];
        return {
          observation_ids: obs,
          description: `${tag}推掉活动`,
          hypotheses: [
            { tier: "preference", statement: `用户${tag}想自己安排时间`, context: scene, supports: obs.map((target) => ({ target, weight: "strong", rationale: "推掉了" })), refutes: [] },
            { tier: "state", statement: `用户${tag}那阵子太忙`, context: [], supports: [], refutes: [] },
          ],
        };
      });
      return JSON.stringify({ groups });
    }
    if (r.purpose === "lift") return '{"groups": []}';
    if (r.purpose === "judge") return '{"found_evidence_ids": [], "links": []}';
    if (r.purpose === "strategies") return '{"strategies": []}';
    return '{"probes": []}';
  });

describe("220：推断出来的下层断言带上模型写的场景", () => {
  /** 周末两次、工作日两次推掉活动，跨四个月 */
  const DECLINES: EvidenceDraft[] = [
    say("ev-a", "周末我不想去聚餐", "2026-03-07T10:00:00+08:00", { context: ["weekend"] }),
    say("ev-b", "周末我不想去爬山", "2026-05-09T10:00:00+08:00", { context: ["weekend"] }),
    say("ev-c", "工作日我不想去唱歌", "2026-08-12T10:00:00+08:00", { context: ["workday"] }),
    say("ev-d", "工作日我不想去钓鱼", "2026-09-16T10:00:00+08:00", { context: ["workday"] }),
  ];
  it("模型给假设写了场景：往上抽的输入用它，全体过门槛、问了模型；请求里带着场景", async () => {
    const model = declineModel(true);
    const { engine, report } = await reflectWith(model, DECLINES);
    const inputs = engine.rg.liftInputs("need", engine.rg.view());
    // 329 号票（R4）：还拿不准的"那阵子太忙"也是往上抽的输入（模型没给它写场景）
    expect(inputs.map((i) => JSON.stringify(i.scenes)).toSorted()).toEqual(['[["weekend","social"]]', '[["workday","work"]]', "[[]]", "[[]]"].toSorted());
    expect(inputs.every((i) => i.groupKey?.startsWith("model|"))).toBe(true);
    const lift = model.calls.filter((c) => c.purpose === "lift");
    expect(lift).toHaveLength(1);
    expect(lift[0]!.user).toContain('"scenes":[["weekend","social"]]');
    expect(report.stats!.lift.notAsked).toEqual({});
  });

  it("模型没写场景：照旧为空，全体'场景不够'、不问模型", async () => {
    const model = declineModel(false);
    const { engine, report } = await reflectWith(model, DECLINES);
    expect(engine.rg.liftInputs("need", engine.rg.view()).map((i) => i.scenes)).toEqual([[[]], [[]], [[]], [[]]]);
    expect(model.calls.filter((c) => c.purpose === "lift")).toHaveLength(0);
    expect(report.stats!.lift.notAsked).toEqual({ "need：场景不够": 1 });
  });
});
