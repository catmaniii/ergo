// 模型版：假模型（不调 DeepSeek）。伪造的证据 id 写入前丢掉；预算；DeepSeek 客户端的请求形状和 key 不外泄；预计费用（--dry-run）。
import { afterEach, describe, expect, it } from "vitest";
import { LlmFactExtractor } from "../../src/kg/llm-extractor.ts";
import { FakeChatModel, type ChatRequest } from "../../src/llm/chat.ts";
import { DEEPSEEK_KEY_ENV, DeepSeekChat, type PostFunction } from "../../src/llm/deepseek.ts";
import { estimateCost, estimateTokens } from "../../src/llm/estimate.ts";
import { formatPlan, planModelRun } from "../../src/llm/plan.ts";
import { LlmReasoner } from "../../src/rg/llm-reasoner.ts";
import { SyntheticEventsSource } from "../../src/evidence/synthetic.ts";
import { closeEngines, factOf, ingestWeekend, openEngine, say, WEEKEND_FIXTURE } from "./helpers.ts";

afterEach(closeEngines);

const ids = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]!);

describe("模型版事实抽取（LlmFactExtractor）", () => {
  it("204：有效期截止早于开始的事实写入前丢掉，不让整次抽取崩掉", async () => {
    const model = new FakeChatModel((req: ChatRequest) => {
      const [first] = ids(/"evidence_id":"(ev-[^"]+)"/g, req.user);
      return {
        facts: [
          { evidence_id: first, predicate: "prefers", object: { name: "爬山", type: "activity" }, negated: false, valid_from: "2026-05-01T00:00:00+08:00", valid_to: "2025-01-01T00:00:00+08:00", statement: "用户喜欢爬山", change: false, correction: false },
          { evidence_id: first, predicate: "prefers", object: { name: "游泳", type: "activity" }, negated: false, valid_from: null, statement: "用户喜欢游泳", change: false, correction: false },
        ],
      };
    });
    const { engine } = openEngine("2026-10-20T12:00:00+08:00", { extractor: new LlmFactExtractor(model) });
    engine.ingestEvidence(say("ev-1", "我喜欢爬山，也喜欢游泳", "2026-10-01T10:00:00+08:00"));
    const report = await engine.reflect();
    expect(report.dropped.map((d) => d.reason)).toContain("有效期截止早于开始");
    expect(engine.store.listFacts().map((f) => f.statement)).toEqual(["用户喜欢游泳"]);
  });

  it("模型写精炼陈述；伪造的证据 id、不认得的谓词写入前丢掉", async () => {
    const model = new FakeChatModel((req: ChatRequest) => {
      const [first] = ids(/"evidence_id":"(ev-[^"]+)"/g, req.user);
      return {
        facts: [
          { evidence_id: first, predicate: "prefers", object: { name: "爬山", type: "activity" }, negated: false, context: ["weekend"], valid_from: null, statement: "用户一直在周末喜欢爬山", change: false, correction: false, span: "我喜欢爬山" },
          { evidence_id: "ev-999", predicate: "dislikes", object: { name: "社交", type: "activity" }, negated: false, statement: "编出来的", change: false, correction: false },
          { evidence_id: first, predicate: "loves", object: { name: "爬山", type: "activity" }, negated: false, statement: "谓词不对" },
        ],
      };
    });
    const extractor = new LlmFactExtractor(model);
    const { engine } = openEngine("2026-10-20T12:00:00+08:00", { extractor });
    engine.ingestEvidence(say("ev-1", "我喜欢爬山", "2026-10-01T10:00:00+08:00", { context: ["weekend"] }));
    expect(() => engine.extractFacts()).toThrow(/先 prepare/);
    const report = await engine.reflect();
    expect(model.calls.map((c) => c.purpose)).toEqual(["extract"]);
    expect(report.modelCalls).toBe(1);
    expect(report.dropped.map((d) => d.reason)).toEqual(expect.arrayContaining(["伪造的证据 id：ev-999", "谓词不认得：loves"]));
    const [fact] = engine.store.listFacts();
    // 334 号票：模型给 null（= 一直）、原话"我喜欢爬山"没说从什么时候起——开始按说话那天算
    expect(fact).toMatchObject({ predicate: "prefers", statement: "用户一直在周末喜欢爬山", extractedBy: "model:fake-llm", assertion: "user_stated", validFrom: "2026-10-01T10:00:00+08:00", evidenceIds: ["ev-1"] });
    expect(engine.store.listFacts()).toHaveLength(1);
  });
});

/** 按请求的用途回答的假推理模型；有意夹带伪造的 id */
function fakeReasoner() {
  return new FakeChatModel((req) => {
    if (req.purpose === "propose") {
      const facts = ids(/"fact_id":"(fa-\d+)"/g, req.user);
      return {
        groups: [
          {
            observation_ids: [facts[0], facts[3], "fa-9999"],
            description: "周末两次推掉活动",
            hypotheses: [
              { tier: "preference", statement: "用户周末想自己安排时间", context: ["weekend"], supports: [{ target: facts[1], weight: "decisive", rationale: "说周末想休息" }], refutes: [] },
              { tier: "preference", statement: "用户不喜欢社交", context: ["social"], supports: [], refutes: [{ target: facts[2], weight: "weak", rationale: "工作日参加了交流" }, { target: "fa-8888", weight: "strong", rationale: "编的" }] },
              { tier: "state", statement: "用户近期太累", context: [], supports: [{ target: "ev-zzz", weight: "weak", rationale: "编的" }], refutes: [] },
            ],
          },
        ],
      };
    }
    if (req.purpose === "probes") {
      const claims = ids(/"claim_id":"(cl-\d+)"/g, req.user);
      return {
        probes: [
          { discriminates: [claims[0], claims[1]], ask: "周末自己约过朋友吗？", queries: ["排满", "不反感"], if_found: claims[0] },
          { discriminates: [claims[0], "cl-9999"], ask: "编的追问", queries: ["x"], if_found: null },
        ],
      };
    }
    if (req.purpose === "judge") {
      const claims = ids(/"claim_id":"(cl-\d+)"/g, req.user);
      const evidence = ids(/"evidence_id":"(ev-[^"]+)"/g, req.user);
      const w04 = evidence.find((e) => e === "ev-w04");
      return {
        found_evidence_ids: [...(w04 ? [w04] : []), "ev-nope"],
        if_found: claims[0],
        links: [
          ...(w04 ? [{ claim_id: claims[0], evidence_id: w04, polarity: "supports", weight: "strong", rationale: "不喜欢周末被排满" }] : []),
          { claim_id: claims[1], evidence_id: "ev-nope", polarity: "refutes", weight: "decisive", rationale: "编的证据" },
          { claim_id: "cl-7777", evidence_id: evidence[0], polarity: "supports", weight: "weak", rationale: "编的断言" },
        ],
      };
    }
    return {};
  }, "fake-reasoner");
}

describe("模型版推理（LlmReasoner）", () => {
  it("伪造的事实 id、证据 id、断言 id 写入前丢掉；决定性只给用户明说的；状态仍按关联统一算", async () => {
    const model = fakeReasoner();
    const { engine } = openEngine("2026-10-13T12:00:00+08:00", { reasoner: new LlmReasoner(model) });
    ingestWeekend(engine, ["ev-w01", "ev-w02", "ev-w03", "ev-w04"]);
    const report = await engine.reflect();
    // 第一轮找到 ev-w04，第二轮用它里面的名字（见朋友、被提前排满）再搜一次
    expect(model.calls.map((c) => c.purpose)).toEqual(["propose", "probes", "judge", "judge"]);
    expect(report).toMatchObject({ modelCalls: 4, rounds: 2 });
    const reasons = report.dropped.map((d) => d.reason).join("\n");
    expect(reasons).toContain("伪造的或不能当依据的观察 id：fa-9999");
    expect(reasons).toContain("伪造的或不能当依据的目标 id：fa-8888");
    expect(reasons).toContain("伪造的或不能当依据的目标 id：ev-zzz");
    expect(reasons).toContain("要区分的不是这组里的断言");
    expect(reasons).toContain("伪造的 id 或字段不合格（证据 ev-nope");
    expect(reasons).toContain("断言 cl-7777");
    expect(reasons).toContain("伪造的或不能当依据的证据 id：ev-nope");
    const [group] = engine.rg.registry.listGroups();
    expect(group!.by).toBe("model:fake-reasoner");
    const members = engine.rg.registry.members(group!.key).map((m) => engine.store.getClaim(m.claimId)!);
    expect(members.map((c) => c.statement)).toEqual(["用户周末想自己安排时间", "用户不喜欢社交", "用户近期太累"]);
    // 编出来的目标一条都没写进去
    const allTargets = members.flatMap((c) => engine.store.linksOf(c.id).map((l) => l.target));
    for (const fake of ["fa-8888", "fa-9999", "ev-zzz", "ev-nope"]) expect(allTargets).not.toContain(fake);
    // "说周末想休息"是用户明说的，可以是决定性
    const rest = factOf(engine, "ev-w01", "prefers", "休息");
    expect(engine.store.linksOf(members[0]!.id).find((l) => l.target === rest.id)).toMatchObject({ weight: "decisive" });
    expect(engine.store.linksOf(members[0]!.id).find((l) => l.target === "ev-w04")).toMatchObject({ polarity: "supports", weight: "strong" });
    expect(members.every((c) => c.epistemic === "inferred" && c.competesWith.length === 2)).toBe(true);
    expect(members[2]).toMatchObject({ tier: "state", validTo: "2026-10-22T21:00:00+08:00" });
  });

  it("204：模型给的有效期截止早于观察开始时不崩——不用它，照默认（近期状态到最后一次观察后 14 天），记进丢掉的", async () => {
    const model = new FakeChatModel((req) => {
      if (req.purpose !== "propose") return {};
      const facts = ids(/"fact_id":"(fa-\d+)"/g, req.user);
      return {
        groups: [
          {
            observation_ids: [facts[3], facts[0]],
            description: "周末两次推掉活动",
            hypotheses: [
              { tier: "state", statement: "用户近期太累", context: [], valid_to: "2020-01-01T23:59:59+08:00", supports: [], refutes: [] },
              { tier: "preference", statement: "用户不喜欢社交", context: [], supports: [], refutes: [] },
            ],
          },
        ],
      };
    }, "fake-reasoner");
    const { engine } = openEngine("2026-10-13T12:00:00+08:00", { reasoner: new LlmReasoner(model) });
    ingestWeekend(engine, ["ev-w01", "ev-w02", "ev-w03", "ev-w04"]);
    const report = await engine.reflect();
    const tired = engine.store.listClaims().find((c) => c.statement === "用户近期太累")!;
    expect(tired.validTo).not.toBe("2020-01-01T23:59:59+08:00");
    expect(tired.validFrom === null || tired.validTo === null || tired.validTo >= tired.validFrom).toBe(true);
    expect(report.dropped.map((d) => d.reason)).toContainEqual(expect.stringContaining("有效期截止早于开始"));
  });

  it("预算用完就不再调模型，这次没做完的证据留给下一次", async () => {
    const model = fakeReasoner();
    const { engine } = openEngine("2026-10-13T12:00:00+08:00", { reasoner: new LlmReasoner(model) });
    ingestWeekend(engine, ["ev-w01", "ev-w02", "ev-w03"]);
    const report = await engine.reflect({ maxModelCalls: 1 });
    // 270 号票：整理完一条记一条——出假设问成了、给新组出追问被预算挡住：那组观察背后的证据不算整理过，留给下一次；
    // 没进组、也没有追问欠着的那条照样记下（它的事实下一次出假设还会再看）
    expect(report).toMatchObject({ modelCalls: 1, budgetExhausted: true, processedEvidenceIds: ["ev-w02"], backlog: 2 });
    expect(model.calls).toHaveLength(1);
    const again = await engine.reflect({ maxModelCalls: 5 });
    expect(again.skipped).toBeUndefined();
    expect(again.processedEvidenceIds).toEqual(["ev-w01", "ev-w03"]);
    expect(again.backlog).toBe(0);
  });
});

const ok = (content: string): ReturnType<PostFunction> =>
  Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } })) });

/** 输出到了 max_tokens 被截断的回应 */
const truncatedPost = (): ReturnType<PostFunction> =>
  Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: '{"groups": [{"obs' }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 8000 } })) });

describe("DeepSeek 客户端", () => {

  it("POST /chat/completions，要 JSON 输出，key 从环境变量现取、放在请求头里", async () => {
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const chat = new DeepSeekChat({ env: { [DEEPSEEK_KEY_ENV]: "sk-test-123" }, post: (url, init) => (sent.push({ url, headers: init.headers, body: init.body }), ok('{"facts": []}')) });
    const res = await chat.complete({ purpose: "extract", system: "系统", user: "用户", maxTokens: 100 });
    expect(res).toEqual({ content: '{"facts": []}', usage: { inputTokens: 120, outputTokens: 30 }, truncated: false });
    expect(sent[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(sent[0]!.headers.Authorization).toBe("Bearer sk-test-123");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ model: "deepseek-flash", response_format: { type: "json_object" }, temperature: 0, max_tokens: 100 });
    // 192：默认关掉思考（V4.1 Flash 默认会先想，想的 token 也算进 max_tokens，第一、二次真跑时 propose 大都被截断）
    expect(JSON.parse(sent[0]!.body).thinking).toEqual({ type: "disabled" });
    const thinking = new DeepSeekChat({ thinking: "enabled", env: { [DEEPSEEK_KEY_ENV]: "sk-test-123" }, post: (url, init) => (sent.push({ url, headers: init.headers, body: init.body }), ok("{}")) });
    await thinking.complete({ purpose: "judge", system: "", user: "", maxTokens: 10 });
    expect(JSON.parse(sent[1]!.body).thinking).toEqual({ type: "enabled" });
  });

  it("192：finish_reason 是 length（输出到了 max_tokens）时标 truncated；推理实现丢掉时写明是被截断", async () => {
    const chat = new DeepSeekChat({ env: { [DEEPSEEK_KEY_ENV]: "sk-test-123" }, post: truncatedPost });
    expect((await chat.complete({ purpose: "propose", system: "", user: "", maxTokens: 8000 })).truncated).toBe(true);
    const { engine } = openEngine("2026-10-09T12:00:00+08:00", { reasoner: new LlmReasoner(chat) });
    ingestWeekend(engine, ["ev-w01", "ev-w02", "ev-w03"]);
    const report = await engine.reflect();
    expect(report.dropped.some((d) => d.stage === "propose" && /被截断/.test(d.reason))).toBe(true);
  });

  it("没配 key 不发请求；出错信息里不带 key", async () => {
    let called = false;
    const none = new DeepSeekChat({ env: {}, post: () => ((called = true), ok("{}")) });
    expect(none.hasKey()).toBe(false);
    await expect(none.complete({ purpose: "judge", system: "", user: "", maxTokens: 10 })).rejects.toThrow(DEEPSEEK_KEY_ENV);
    expect(called).toBe(false);
    const bad = new DeepSeekChat({
      env: { [DEEPSEEK_KEY_ENV]: "sk-secret-xyz" },
      post: () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('{"error":{"message":"invalid key sk-secret-xyz"}}') }),
    });
    const err = (await bad.complete({ purpose: "judge", system: "", user: "", maxTokens: 10 }).then(
      () => new Error("应该失败"),
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain("HTTP 401");
    expect(err.message).toContain("***");
    expect(err.message).not.toContain("sk-secret-xyz");
  });
});

describe("预计费用（--dry-run）", () => {
  it("按字数估 token：中文 0.6、其余 0.3；按价格表算两档", () => {
    expect(estimateTokens("你好abc")).toBe(3);
    const cost = estimateCost("deepseek-flash", [
      { purpose: "extract", inputTokens: 1_000_000, outputTokens: 0 },
      { purpose: "judge", inputTokens: 0, outputTokens: 1_000_000 },
    ]);
    expect(cost).toMatchObject({ calls: 2, peakYuan: 10, offPeakYuan: 5 });
    expect(() => estimateCost("gpt-x", [])).toThrow(/价格表/);
  });

  it("照规则版的结构和模型版真实的请求估：不调模型", async () => {
    const plan = await planModelRun(SyntheticEventsSource.fromFile(WEEKEND_FIXTURE));
    expect(plan).toMatchObject({ model: "deepseek-flash", evidence: 5, groups: 1 });
    expect(Object.keys(plan.estimate.byPurpose)).toEqual(["extract", "propose", "probes", "judge"]);
    expect(plan.estimate.byPurpose.judge!.calls).toBe(plan.probes * 2);
    expect(plan.estimate.peakYuan).toBeGreaterThan(0);
    expect(plan.estimate.peakYuan).toBeGreaterThan(plan.estimate.offPeakYuan);
    const text = formatPlan(plan, "weekend-events.json");
    expect(text).toContain("预计费用：高峰约 ¥");
    expect(text).toContain("不调用模型");
  });
});
