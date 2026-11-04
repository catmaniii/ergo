// 证据原文里的"前文"一行（400）：接着对方的话说的一句，原文后面接"［前文，不是用户说的］…"。
// - 前文不是用户说的：规则版抽事实只看用户自己的话（前文里"秘书说你喜欢爵士乐"不会抽成用户喜欢爵士乐）；
// - 模型版抽事实：提示词讲明规矩；原文片段只出自前文的事实、关系、别名写入前丢掉——构造一个前文里有"秘书说用户喜欢 X"的例子，
//   就算模型照前文抽了"用户喜欢 X"，整理后事实图谱、推理图谱里都没有它；用户这句自己的意思照常抽；
// - 判前文的模型请求：只认这一批的编号、在接着回的要有总结（超长截到上限），判不了的不在结果里；
// - 合成数据的 reply_to 照样拼成前文那一行。
import { afterEach, describe, expect, it } from "vitest";
import { REPLY_CONTEXT_PREFIX, REPLY_CONTEXT_RULE, replyContextOf, spanOnlyInReplyContext, userWordsOf, withReplyContext } from "../../src/evidence/reply-context.ts";
import { SyntheticEventsSource } from "../../src/evidence/synthetic.ts";
import { EXTRACT_SYSTEM, LlmFactExtractor } from "../../src/kg/llm-extractor.ts";
import { RuleFactExtractor } from "../../src/kg/extractor.ts";
import { FakeChatModel, type ChatRequest } from "../../src/llm/chat.ts";
import { parseReplyContexts, REPLY_CONTEXT_SUMMARY_MAX, replyContextRequest } from "../../src/llm/reply-context.ts";
import { JUDGE_SYSTEM, PROPOSE_SYSTEM } from "../../src/rg/llm-reasoner.ts";
import { closeEngines, openEngine, say } from "../rg/helpers.ts";

afterEach(closeEngines);

const JAZZ = withReplyContext("周五不行，那天要加班", "秘书说用户一直很喜欢爵士乐，问要不要订周五的爵士音乐会票");

describe("前文那一行", () => {
  it("接在原文后面；拆得回用户自己的话和前文；原文片段只出自前文的认得出来", () => {
    expect(JAZZ).toBe(`周五不行，那天要加班\n${REPLY_CONTEXT_PREFIX}秘书说用户一直很喜欢爵士乐，问要不要订周五的爵士音乐会票`);
    expect(userWordsOf(JAZZ)).toBe("周五不行，那天要加班");
    expect(replyContextOf(JAZZ)).toBe("秘书说用户一直很喜欢爵士乐，问要不要订周五的爵士音乐会票");
    expect(spanOnlyInReplyContext(JAZZ, "喜欢爵士乐")).toBe(true);
    expect(spanOnlyInReplyContext(JAZZ, "那天要加班")).toBe(false);
    expect(spanOnlyInReplyContext("我喜欢爵士乐", "喜欢爵士乐")).toBe(false);
    // 没有前文的原样；总结里的换行压成空格
    expect(userWordsOf("我喜欢爬山")).toBe("我喜欢爬山");
    expect(withReplyContext("好", "秘书问\n周六去不去")).toBe(`好\n${REPLY_CONTEXT_PREFIX}秘书问 周六去不去`);
  });

  it("规则版抽事实只看用户自己的话：前文里的\"喜欢爵士乐\"不算用户的", () => {
    const facts = new RuleFactExtractor().extract({ ...say("ev-1", JAZZ, "2026-10-01T10:00:00+08:00"), id: "ev-1", contentHash: "h", status: "active", sourceRef: null }, { findEntity: () => undefined, knownNames: () => [] });
    expect(JSON.stringify(facts)).not.toContain("爵士");
  });

  it("提示词里讲明前文不是用户说的（抽事实、出假设、判证据）", () => {
    for (const system of [EXTRACT_SYSTEM, PROPOSE_SYSTEM, JUDGE_SYSTEM]) expect(system).toContain(REPLY_CONTEXT_RULE);
  });

  it("模型版抽事实：照前文抽的\"用户喜欢爵士乐\"写入前丢掉，用户这句自己的意思照常抽；整理后推理图谱里没有因此得出喜欢爵士乐", async () => {
    const model = new FakeChatModel((req: ChatRequest) => {
      if (req.purpose !== "extract") return {};
      const id = /"evidence_id":"(ev-[^"]+)"/.exec(req.user)![1];
      return {
        facts: [
          // 读歪了的模型：把前文里秘书说的话算到用户头上
          { evidence_id: id, predicate: "prefers", object: { name: "爵士乐", type: "activity" }, negated: false, statement: "用户喜欢爵士乐", change: false, correction: false, span: "很喜欢爵士乐" },
          { evidence_id: id, predicate: "declined", object: { name: "周五的爵士音乐会", type: "event" }, negated: false, statement: "用户因为周五加班推掉了音乐会", change: false, correction: false, span: "周五不行，那天要加班" },
        ],
        relations: [{ evidence_id: id, subject: { name: "用户", type: "person" }, predicate: "mentioned", object: { name: "老周", type: "person" }, span: "秘书说用户" }],
        aliases: [{ evidence_id: id, name: "秘书", alias: "用户" }],
      };
    });
    const { engine } = openEngine("2026-10-20T12:00:00+08:00", { extractor: new LlmFactExtractor(model) });
    engine.ingestEvidence(say("ev-1", JAZZ, "2026-10-01T10:00:00+08:00"));
    const report = await engine.reflect();
    expect(model.calls[0]!.user).toContain(REPLY_CONTEXT_PREFIX);
    expect(report.dropped.map((d) => d.reason)).toEqual(expect.arrayContaining(["原文片段出自前文（不是用户说的），不算用户的事实", "关系的原文片段出自前文（不是用户说的）"]));
    const facts = engine.store.listFacts();
    expect(facts.map((f) => f.statement)).toEqual(["用户因为周五加班推掉了音乐会"]);
    expect(JSON.stringify(engine.store.listClaims())).not.toContain("喜欢爵士");
  });
});

describe("判前文的模型请求", () => {
  it("一批一次：前文留结尾、用户这句留开头；只认这一批的编号、在接着回的要有总结，超长截到上限", () => {
    const request = replyContextRequest([
      { id: "r1", by: "秘书", before: `${"很长的前文".repeat(200)}要不要周六去爬山？`, user: "好" },
      { id: "r2", by: "负责人", before: "第一稿写好了", user: "我下个月换工作" },
    ]);
    expect(request.purpose).toBe("reply_context");
    expect(request.user).toContain("要不要周六去爬山？");
    expect(request.user.length).toBeLessThan(1600);

    const parsed = parseReplyContexts(
      JSON.stringify({
        items: [
          { id: "r1", reply: true, summary: "秘书问周六要不要去爬山" },
          { id: "r2", reply: false },
          { id: "r3", reply: true, summary: "编出来的编号" },
          { id: "r1", reply: false },
        ],
      }),
      ["r1", "r2"],
    );
    expect(parsed).toEqual([
      { id: "r1", reply: true, summary: "秘书问周六要不要去爬山" },
      { id: "r2", reply: false },
    ]);
    // 在接着回却没写总结的：判不出来（不在结果里）；写长了截到上限
    expect(parseReplyContexts(JSON.stringify({ items: [{ id: "r1", reply: true }] }), ["r1"])).toEqual([]);
    const long = parseReplyContexts(JSON.stringify({ items: [{ id: "r1", reply: true, summary: "很".repeat(200) }] }), ["r1"]);
    expect([...(long[0] as { summary: string }).summary]).toHaveLength(REPLY_CONTEXT_SUMMARY_MAX);
  });

  it("合成数据的 reply_to 拼成前文那一行（不写就是原话）", () => {
    const source = new SyntheticEventsSource({
      version: 1,
      now: "2026-10-20T12:00:00+08:00",
      events: [
        { id: "ev-1", source_level: "self", mode: "say", kind: "utterance", text: "好", context: ["weekend"], observed_at: "2026-10-01T10:00:00+08:00", reply_to: "秘书问周六要不要去爬山" },
        { id: "ev-2", source_level: "self", mode: "say", kind: "utterance", text: "我喜欢爬山", context: ["weekend"], observed_at: "2026-10-01T11:00:00+08:00" },
      ],
    });
    expect(source.read().map((d) => d.text)).toEqual([`好\n${REPLY_CONTEXT_PREFIX}秘书问周六要不要去爬山`, "我喜欢爬山"]);
    expect(() => new SyntheticEventsSource({ version: 1, now: "2026-10-20T12:00:00+08:00", events: [{ id: "ev-1", source_level: "self", mode: "say", kind: "utterance", text: "好", context: ["x"], observed_at: "2026-10-01T10:00:00+08:00", reply_to: " " }] })).toThrow(/reply_to/);
  });
});
