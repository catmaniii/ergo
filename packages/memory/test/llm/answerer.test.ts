// 216 号票：大模型回答器（模拟秘书）。用假模型：看发出去的请求（提示词只有问题、时间、场景和记忆简报）和交回的回答
// （回答文字、表示没表示不确定、用到的证据和结论；简报以外的 id 剥掉）。不调真的 DeepSeek。
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import { ANSWER_MAX_TOKENS, ANSWER_SYSTEM, LlmAnswerer } from "../../src/llm/answerer.ts";
import { memoryBrief } from "../../src/llm/brief.ts";
import { FakeChatModel, type ChatRequest } from "../../src/llm/chat.ts";
import { MeteredChat } from "../../src/llm/metered.ts";
import { closeEngines, say } from "../rg/helpers.ts";
import { member, NEED, NOW, storyEngine } from "../rg/task-helpers.ts";

afterEach(closeEngines);

async function brief(question: string, group: "hybrid_kg" | "hybrid_kg_rg" = "hybrid_kg_rg") {
  const t = await storyEngine({ embedder: new FakeEmbedder() }, [say("ev-h1", "小王说他觉得我周末就喜欢一个人宅着", "2026-09-20T10:00:00+08:00", { sourceLevel: "untrusted", context: ["weekend"] })]);
  await t.engine.indexVectors();
  return { engine: t.engine, brief: await memoryBrief(t.engine, question, { at: NOW, group }) };
}

const Q = "我是不是不喜欢周末被安排得满满的？";

describe("大模型回答器：请求", () => {
  it("用途 answer、系统提示是固定的秘书口径（不随题目变）、用户消息只有问题、时间、场景和记忆简报", async () => {
    const { brief: b } = await brief(Q);
    const answerer = new LlmAnswerer(new FakeChatModel(() => ({})));
    const r = answerer.requestFor({ question: Q, at: NOW, context: ["weekend"], brief: b });
    expect(r.purpose).toBe("answer");
    expect(r.maxTokens).toBe(ANSWER_MAX_TOKENS);
    expect(r.system).toBe(ANSWER_SYSTEM);
    expect(r.user).toBe(`问题：${Q}\n问的时间：2026-10-12 12:00\n场景：周末\n\n记忆简报：\n${b.text}`);
    // 提示词里的 id 都是简报里的
    const evIds = new Set(r.user.match(/ev-[A-Za-z0-9]+/g));
    for (const id of evIds) expect(b.evidenceIds).toContain(id);
    const clIds = new Set(r.user.match(/cl-[A-Za-z0-9]+/g));
    for (const id of clIds) expect(b.claimIds).toContain(id);
    // 没给场景写"没说"
    expect(answerer.requestFor({ question: Q, at: NOW, brief: b }).user).toContain("场景：没说");
  });

  it("系统提示照秘书的口径：只拿本人的话当依据、说出反证的内容、证据不够直说不确定和缺什么、做决定给具体方案且这次明说的要求优先", () => {
    for (const rule of ["本人", "别人转述", "反证", "内容", "不确定", "缺什么", "具体的方案", "这次明说的要求", "优先", "JSON"]) expect(ANSWER_SYSTEM).toContain(rule);
    // 通用：不提具体的人、事、题
    expect(ANSWER_SYSTEM).not.toMatch(/ev-\d|cl-\d|周末|饭局/);
  });

  it("219：结论下面的原话是依据，用到结论时要说出具体的事例", () => {
    expect(ANSWER_SYSTEM).toMatch(/结论下面[^。]*原话[^。]*依据/);
    expect(ANSWER_SYSTEM).toContain("具体的事例");
  });

  it("219：依据只在结论下面的原话里（不在记录那节）时，引用也带上它的原话", async () => {
    const { engine } = await brief(Q);
    const b = await memoryBrief(engine, Q, { at: NOW, group: "hybrid_kg_rg", limits: { records: 2 } });
    const quote = b.profile!.claims.flatMap((c) => c.quotes ?? []).find((q) => !b.records.some((r) => r.evidenceId === q.evidenceId));
    expect(quote).toBeDefined();
    const answerer = new LlmAnswerer(new FakeChatModel(() => ({ answer: `你说过「${quote!.text}」［${quote!.evidenceId}］`, uncertain: false, grounds: [quote!.evidenceId] })));
    const a = await answerer.answer({ question: Q, at: NOW, brief: b });
    expect(a.invalidIds).toEqual([]);
    expect(a.citations).toContainEqual(expect.objectContaining({ evidenceIds: [quote!.evidenceId], text: quote!.text, role: "record" }));
  });
});

describe("大模型回答器：回答", () => {
  it("交回回答文字、是否不确定、用到的证据和结论；引用按角色记（依据、反证、结论），别人转述只在文字里", async () => {
    const { engine, brief: b } = await brief(Q);
    const need = member(engine, NEED, "need_autonomy");
    expect(b.claimIds).toContain(need.id);
    // 222 号票起同一组只留一条，简报里可能没有带反证的结论了：拿简报里一条不是依据的证据当模型说的反证（测的是引用按角色记）
    const grounds = ["ev-w3", "ev-w1", "ev-w2"];
    const counter = b.profile!.claims.flatMap((c) => c.refuteIds)[0] ?? b.profile!.groups.flatMap((g) => g.members.flatMap((m) => m.refuteIds))[0] ?? b.evidenceIds.find((id) => !grounds.includes(id))!;
    const model = new FakeChatModel(() => ({
      answer: `对，你说过不喜欢周末被排得满满的［ev-w3］，也推掉过几次周末的局［ev-w1、ev-w2］。不过也有不太一致的：${engine.getEvidence(counter)!.text}［${counter}］。小王说你喜欢宅着［ev-h1］，那是转述，不当依据。`,
      uncertain: false,
      grounds,
      counter: [counter],
      hearsay: ["ev-h1"],
      claims: [need.id],
      missing: "",
    }));
    const a = await new LlmAnswerer(model).answer({ question: Q, at: NOW, brief: b });
    expect(model.calls).toHaveLength(1);
    expect(a).toMatchObject({ route: "llm", kind: "self", certain: true, error: null, invalidIds: [], missing: [] });
    expect(a.text).toContain("［ev-w3］");
    expect(a.used).toEqual({ grounds: ["ev-w3", "ev-w1", "ev-w2"], counter: [counter], hearsay: ["ev-h1"], claims: [need.id] });
    expect(a.citations.filter((c) => c.role === "record").flatMap((c) => c.evidenceIds)).toEqual(["ev-w3", "ev-w1", "ev-w2"]);
    expect(a.citations.filter((c) => c.role === "counter").flatMap((c) => c.evidenceIds)).toEqual([counter]);
    expect(a.citations.find((c) => c.claimId === need.id)).toMatchObject({ role: "conclusion", evidenceIds: [] });
    // 评测的判法看得到（转述没被当依据，反证被考虑了）：326 号票起在评测包的 test/eval/eval2-cited.test.ts
    expect(a.hits).toEqual(b.hits);
  });

  it("说不确定时 certain 是 false，缺什么记进 missing", async () => {
    const { brief: b } = await brief("我是不是很喜欢爬山？", "hybrid_kg");
    const model = new FakeChatModel(() => ({ answer: "不确定：记录里没有你说过爬山的话。缺：你自己说的对爬山的看法。", uncertain: true, grounds: [], counter: [], hearsay: [], claims: [], missing: "你自己说的对爬山的看法" }));
    const a = await new LlmAnswerer(model).answer({ question: "我是不是很喜欢爬山？", at: NOW, brief: b });
    expect(a).toMatchObject({ certain: false, missing: ["你自己说的对爬山的看法"], citations: [] });
  });

  it("简报以外的 id（编的）从列表和文字里剥掉，记下来；明明是别人转述却放进依据的照实交给评测去判", async () => {
    const { brief: b } = await brief(Q);
    const model = new FakeChatModel(() => ({ answer: "是的［ev-w3、ev-999］，见［cl-999］。小王也这么说［ev-h1］。", uncertain: false, grounds: ["ev-w3", "ev-999", "ev-h1"], counter: ["ev-888"], hearsay: [], claims: ["cl-999"] }));
    const a = await new LlmAnswerer(model).answer({ question: Q, at: NOW, brief: b });
    expect(a.invalidIds.toSorted()).toEqual(["cl-999", "ev-888", "ev-999"]);
    expect(a.text).toBe("是的［ev-w3］，见。小王也这么说［ev-h1］。");
    expect(a.used).toEqual({ grounds: ["ev-w3", "ev-h1"], counter: [], hearsay: [], claims: [] });
  });

  it("模型输出解析不了、缺字段：记下错误，回答是空的、算没有结论，评测照常往下走", async () => {
    const { brief: b } = await brief(Q);
    for (const out of ["不是 JSON", { uncertain: false }, { answer: "好的", uncertain: "maybe" }]) {
      const a = await new LlmAnswerer(new FakeChatModel(() => out)).answer({ question: Q, at: NOW, brief: b });
      expect(a).toMatchObject({ text: "", certain: false, citations: [], route: "llm" });
      expect(a.error).toEqual(expect.any(String));
    }
  });

  it("经 MeteredChat 记用量：用途记成 answer；同样的简报同样的问题只问一次", async () => {
    const { brief: b } = await brief(Q);
    const inner = new FakeChatModel((r: ChatRequest) => ({ answer: `收到（${r.purpose}）`, uncertain: false, grounds: [], counter: [], hearsay: [], claims: [] }), "deepseek-flash");
    const meter = new MeteredChat(inner);
    const answerer = new LlmAnswerer(meter);
    expect(answerer.id).toBe("model:deepseek-flash");
    await answerer.answer({ question: Q, at: NOW, brief: b });
    await answerer.answer({ question: Q, at: NOW, brief: b });
    expect(meter.report()).toMatchObject({ calls: 1, cacheHits: 1, byPurpose: { answer: { calls: 1 } } });
    expect(inner.calls).toHaveLength(1);
  });
});
