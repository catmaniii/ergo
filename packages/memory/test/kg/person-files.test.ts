// 283 号票：个人档案和记忆联动在引擎这一侧的几样——认人物信息（kg/person-info.ts，模型版只认原文里有的、规则版认几种常见说法、
// 每条证据只看一次）、档案里的人对到人物实体、新值作废旧事实（kg/profile.ts，经唯一写入口、依赖的结论转待复核）、
// 发给模型之前加档案摘要和藏号码（llm/guarded-chat.ts）。全用假模型；示例数据是编的。
import { afterEach, describe, expect, it } from "vitest";
import type { Evidence } from "../../src/domain/types.ts";
import { type ChatRequest, FakeChatModel } from "../../src/llm/chat.ts";
import { redactText, withBackground, withRedaction } from "../../src/llm/guarded-chat.ts";
import { LlmPersonInfoExtractor, markPersonInfoScanned, personInfoPending, RulePersonInfoExtractor } from "../../src/kg/person-info.ts";
import { entitiesForPerson, expireProfileFacts, factsMatchingValue } from "../../src/kg/profile.ts";
import { createBudget } from "../../src/rg/reasoning-graph.ts";
import { closeEngines, openEngine, say } from "../rg/helpers.ts";

afterEach(closeEngines);

const T0 = "2026-10-01T09:00:00+08:00";
const NOW = "2026-10-26T10:00:00+08:00";

function evidenceOf(id: string, text: string, over: Partial<Evidence> = {}): Evidence {
  return { id, sourceLevel: "self", mode: "say", kind: "utterance", text, context: [], eventTime: T0, observedAt: T0, sourceRef: `m-${id}`, contentHash: "x", status: "active", ...over };
}

describe("认人物信息：模型版", () => {
  it("只收原文里有的名字、关系、值；证据 id 不是这一批的、字段不认得的丢掉；说的是用户自己写我", async () => {
    const batch = [evidenceOf("ev-1", "我表弟小张在某公司上班"), evidenceOf("ev-2", "周末和小张去爬山"), evidenceOf("ev-3", "我换工作了，现在在某研究所")];
    const model = new FakeChatModel(() => ({
      people: [
        { name: "小张", aliases: ["张弟"], relation: "表弟", evidence_ids: ["ev-1", "ev-2", "ev-9"], fields: [{ field: "work", value: "某公司", evidence_id: "ev-1" }, { field: "phone", value: "123", evidence_id: "ev-1" }] },
        { name: "老王", aliases: [], relation: "同事", evidence_ids: ["ev-2"], fields: [] },
        { name: "用户", aliases: [], relation: null, evidence_ids: ["ev-3"], fields: [{ field: "work", value: "某研究所", evidence_id: "ev-3" }, { field: "birthday", value: "3月2日", evidence_id: "ev-3" }] },
      ],
    }));
    const result = await new LlmPersonInfoExtractor(model).extract(batch, [], { budget: createBudget(5) });
    expect(result.calls).toBe(1);
    expect(result.scanned).toEqual(["ev-1", "ev-2", "ev-3"]);
    expect(result.mentions).toEqual([
      // 别名"张弟"原文里没有：不收；关系"表弟"在原文里；电话不是能认的字段
      { name: "小张", aliases: [], relation: "表弟", evidenceIds: ["ev-1", "ev-2"], fields: [{ field: "work", value: "某公司", evidenceId: "ev-1" }] },
      // 用户自己：生日原文里没有，丢掉
      { name: "我", aliases: [], evidenceIds: ["ev-3"], fields: [{ field: "work", value: "某研究所", evidenceId: "ev-3" }] },
    ]);
    // 老王原文里没有
    expect(result.dropped.map((d) => d.reason).join("\n")).toContain("「老王」原文里没有");
    expect(model.calls[0]!.purpose).toBe("people");
  });

  it("已知的人可以用档案里的叫法（原文是\"我妈\"）；预算用完了就不再问、没看的不记看过", async () => {
    const batch = Array.from({ length: 25 }, (_, i) => evidenceOf(`ev-${i + 1}`, i === 0 ? "我妈腿脚不好" : `第 ${i + 1} 句话`));
    const model = new FakeChatModel((request: ChatRequest) => (request.user.includes("ev-1\"") ? { people: [{ name: "妈妈", aliases: [], relation: null, evidence_ids: ["ev-1"], fields: [] }] } : { people: [] }));
    const result = await new LlmPersonInfoExtractor(model).extract(batch, [{ name: "妈妈", aliases: ["老妈"], relation: "母亲" }], { budget: createBudget(1) });
    expect(result.calls).toBe(1);
    expect(result.scanned).toHaveLength(20);
    expect(result.mentions).toEqual([{ name: "妈妈", aliases: [], evidenceIds: ["ev-1"], fields: [] }]);
    expect(model.calls[0]!.user).toContain('"name":"妈妈"');
  });
});

describe("认人物信息：规则版", () => {
  it("\"我表弟小张\"\"小张在某公司上班\"\"我的生日是 3 月 2 日\"；档案里已有的人提到了也算一次", async () => {
    const batch = [evidenceOf("ev-1", "我表弟小张在某公司上班。"), evidenceOf("ev-2", "老妈说周末来"), evidenceOf("ev-3", "我的生日是3月2日")];
    const result = await new RulePersonInfoExtractor().extract(batch, [{ name: "妈妈", aliases: ["老妈"] }], { budget: createBudget(0) });
    expect(result.calls).toBe(0);
    expect(result.mentions).toEqual(
      expect.arrayContaining([
        { name: "小张", aliases: [], relation: "表弟", evidenceIds: ["ev-1"], fields: [{ field: "relation", value: "表弟", evidenceId: "ev-1" }, { field: "work", value: "某公司", evidenceId: "ev-1" }] },
        { name: "妈妈", aliases: [], evidenceIds: ["ev-2"], fields: [] },
        { name: "我", aliases: [], evidenceIds: ["ev-3"], fields: [{ field: "birthday", value: "3月2日", evidenceId: "ev-3" }] },
      ]),
    );
  });
});

describe("看过哪几条", () => {
  it("只给本人说的、有效的、没看过的、since 以后的；记下看过的下次不再给", () => {
    const { engine } = openEngine(NOW);
    engine.ingestEvidence(say("ev-a", "我表弟小张在某公司上班", "2026-10-25T20:00:00+08:00"));
    engine.ingestEvidence(say("ev-b", "很久以前的话", "2026-09-01T20:00:00+08:00"));
    engine.ingestEvidence({ ...say("ev-c", "别人转述的", "2026-10-25T21:00:00+08:00"), sourceLevel: "untrusted" });
    expect(personInfoPending(engine.store, { since: "2026-10-24T03:00:00+08:00" }).map((e) => e.id)).toEqual(["ev-a"]);
    markPersonInfoScanned(engine.store, ["ev-a"], "rule:1", NOW);
    expect(personInfoPending(engine.store, { since: "2026-10-24T03:00:00+08:00" })).toEqual([]);
  });
});

describe("档案里的人对到人物实体、新值作废旧事实", () => {
  function seed() {
    const t = openEngine(NOW);
    const store = t.engine.store;
    const evidence = store.insertEvidence(say("ev-1", "我住在杭州市西湖区文三路 18 号，老妈也常来", T0));
    const mom = store.insertEntity({ type: "person", name: "老妈", aliases: [] });
    const base = { negated: false, assertion: "user_stated" as const, context: [], evidenceIds: [evidence.id], eventTime: T0, observedAt: T0, validFrom: T0, validTo: null, status: "active" as const, supersededBy: null, retractedBy: null, contestedWith: [], extractedBy: "model:fake" };
    const address = store.insertFact({ ...base, subjectId: "en-user", predicate: "associated_with", object: { type: "value", value: "杭州市西湖区文三路18号" }, statement: "用户住在杭州市西湖区文三路18号" }, { reason: "测试" });
    const other = store.insertFact({ ...base, subjectId: "en-user", predicate: "prefers", object: { type: "value", value: "安静的周末" }, statement: "用户喜欢安静的周末" }, { reason: "测试" });
    const momFact = store.insertFact({ ...base, subjectId: mom.id, predicate: "associated_with", object: { type: "value", value: "腿脚不好" }, statement: "妈妈腿脚不好" }, { reason: "测试" });
    const claim = store.insertClaim({
      tier: "preference",
      statement: "喜欢住在西湖边",
      kind: "conclusion",
      epistemic: "inferred",
      method: "induction",
      status: "active",
      confidence: "medium",
      context: [],
      validFrom: null,
      validTo: null,
      inferredAt: T0,
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [],
    });
    store.putLink({ claimId: claim.id, target: address.id, polarity: "supports", rationale: "测试", weight: "strong" });
    return { ...t, mom, address, other, momFact, claim };
  }

  it("称呼、别名一样的就是同一个人（只认人物实体）；本人对用户自己", () => {
    const { engine, mom } = seed();
    expect(entitiesForPerson(engine.store, { names: ["妈妈", "老妈"] }).map((e) => e.id)).toEqual([mom.id]);
    expect(entitiesForPerson(engine.store, { names: ["表弟"] })).toEqual([]);
    expect(entitiesForPerson(engine.store, { self: true, names: [] }).map((e) => e.id)).toEqual(["en-user"]);
  });

  it("说的是旧值的状态类事实才算（宾语、或够长的旧值在陈述里）；换值那一刻以后才知道的不算", () => {
    const { engine, address, momFact } = seed();
    expect(factsMatchingValue(engine.store, ["en-user"], "杭州市西湖区文三路 18 号", NOW).map((f) => f.id)).toEqual([address.id]);
    expect(factsMatchingValue(engine.store, ["en-user"], "杭州市西湖区文三路 18 号", "2026-09-01T00:00:00+08:00")).toEqual([]);
    expect(factsMatchingValue(engine.store, ["en-user"], "腿脚不好", NOW)).toEqual([]);
    expect(entitiesForPerson(engine.store, { names: ["老妈"] }).flatMap((e) => factsMatchingValue(engine.store, [e.id], "腿脚不好", NOW)).map((f) => f.id)).toEqual([momFact.id]);
  });

  it("住址换了：旧住址的事实到期（状态不变），支持它的结论加复核标记；经唯一写入口，用户发起 · 经个人档案；再来一次什么都不写", () => {
    const { engine, address, other, claim } = seed();
    const result = expireProfileFacts(engine, { person: { self: true, names: [] }, label: "住址", oldValue: "杭州市西湖区文三路 18 号", at: NOW });
    expect(result).toEqual({ expired: [address.id], reviewed: [claim.id] });
    expect(engine.store.getFact(address.id)).toMatchObject({ validTo: NOW, status: "active" });
    expect(engine.store.getFact(other.id)!.validTo).toBeNull();
    expect(engine.store.getClaim(claim.id)).toMatchObject({ status: "active", needsReview: true });
    const writes = engine.store.db.all<{ actor: string; via: string; op: string; object_id: string }>("SELECT actor, via, op, object_id FROM rg_writes");
    expect(writes).toEqual(expect.arrayContaining([{ actor: "user", via: "个人档案", op: "correct", object_id: address.id }]));
    expect(expireProfileFacts(engine, { person: { self: true, names: [] }, label: "住址", oldValue: "杭州市西湖区文三路 18 号", at: NOW })).toEqual({ expired: [], reviewed: [] });
  });
});

describe("发给模型之前：档案摘要当背景、号码换成占位", () => {
  it("号码中间夹着空格、短横也认；住址中间的空白不算；短的不藏", () => {
    const values = [
      { value: "13800138000", placeholder: "［号码］", digits: true },
      { value: "杭州市西湖区文三路 18 号", placeholder: "［住址］" },
      { value: "123", placeholder: "［短］", digits: true },
    ];
    expect(redactText("手机 138 0013-8000，住杭州市西湖区文三路18号，门牌 123", values)).toBe("手机 ［号码］，住［住址］，门牌 123");
  });

  it("推理那几步的系统提示末尾加摘要，抽事实不加；每个请求的系统提示和用户那段都藏号码", async () => {
    const inner = new FakeChatModel(() => ({}));
    const chat = withBackground(
      withRedaction(inner, () => [{ value: "110101199003071234", placeholder: "［号码已略去］", digits: true }]),
      () => "【个人档案摘要】……",
    );
    await chat.complete({ purpose: "propose", system: "推理", user: "证据：110101199003071234", maxTokens: 10 });
    await chat.complete({ purpose: "extract", system: "抽事实", user: "110101 19900307 1234", maxTokens: 10 });
    expect(inner.calls.map((c) => [c.purpose, c.system, c.user])).toEqual([
      ["propose", "推理\n\n【个人档案摘要】……", "证据：［号码已略去］"],
      ["extract", "抽事实", "［号码已略去］"],
    ]);
    expect(chat.name).toBe(inner.name);
  });
});
