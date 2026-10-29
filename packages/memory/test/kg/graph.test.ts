import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_ENTITY_ID } from "../../src/domain/ids.ts";
import type { EvidenceDraft, Fact } from "../../src/domain/types.ts";
import { RuleFactExtractor, type FactDraft } from "../../src/kg/extractor.ts";
import { KnowledgeGraph, type AddFactResult } from "../../src/kg/graph.ts";
import { MemoryStore } from "../../src/store/store.ts";

const CLOCK = "2026-10-20T12:00:00+08:00";
let store: MemoryStore;
let kg: KnowledgeGraph;
const extractor = new RuleFactExtractor();
let n = 0;

beforeEach(() => {
  store = MemoryStore.open(":memory:", { clock: () => CLOCK });
  kg = new KnowledgeGraph(store);
  n = 0;
});
afterEach(() => store.close());

/** 写一条证据并抽事实、写进图谱 */
function say(text: string, at: string | null, over: Partial<EvidenceDraft> = {}): AddFactResult[] {
  n += 1;
  const evidence = store.insertEvidence({
    id: `ev-t${String(n).padStart(2, "0")}`,
    sourceLevel: "self",
    mode: "say",
    kind: "utterance",
    text,
    context: [],
    eventTime: at,
    observedAt: at ?? CLOCK,
    ...over,
  });
  return extractor.extract(evidence, kg.view()).map((d) => kg.addFact(d, evidence, extractor.id));
}

const fact = (id: string): Fact => store.getFact(id)!;
const entity = (name: string) => store.findEntityByName(name)!;

describe("实体对齐", () => {
  it("别名对到同一个实体；词表里的别名建实体时一起登记", () => {
    const a = kg.resolveEntity({ name: "技术交流", type: "activity" });
    expect(a.aliases).toContain("技术分享会");
    expect(kg.resolveEntity({ name: "技术分享会", type: "activity" }).id).toBe(a.id);
    expect(kg.resolveEntity({ id: USER_ENTITY_ID }).name).toBe("用户");
    expect(() => kg.resolveEntity({ id: "en-9999" })).toThrow(/en-9999/);
  });
});

describe("写事实", () => {
  it("带精炼陈述（时间、场景），出处按证据定", () => {
    const [r] = say("这周六的聚会我就不去了", "2026-10-01T20:10:00+08:00", { context: ["weekend", "social"] });
    expect(r!.fact).toMatchObject({
      subjectId: USER_ENTITY_ID,
      predicate: "declined",
      assertion: "user_stated",
      evidenceIds: ["ev-t01"],
      validFrom: "2026-10-01T20:10:00+08:00",
      validTo: null,
      status: "active",
      extractedBy: "rule:3.1",
      statement: "用户 2026-10-01 在周末、社交场合拒绝了聚会",
    });
    const [done] = say("报名参加了技术交流会", "2026-10-03T19:30:00+08:00", { mode: "do", kind: "action" });
    expect(done!.fact.assertion).toBe("observed");
    const [heard] = say("同事说他很讨厌社交", null, { sourceLevel: "untrusted", observedAt: "2026-10-13T10:00:00+08:00" });
    expect(heard!.fact.assertion).toBe("third_party_reported");
    expect(heard!.fact.statement).toBe("据别人说，用户从 2026-10-13 起在社交场合不喜欢社交");
  });

  it("同一条状态类事实又说一次：并进去，多一条证据", () => {
    const [first] = say("我喜欢爬山", "2026-10-01T10:00:00+08:00");
    const [second] = say("还是喜欢爬山", "2026-10-08T10:00:00+08:00");
    // 场景不一样的不并
    const [weekend] = say("周末喜欢爬山", "2026-10-09T10:00:00+08:00");
    expect(weekend!.merged).toBe(false);
    expect(second!.merged).toBe(true);
    expect(second!.fact.id).toBe(first!.fact.id);
    expect(fact(first!.fact.id).evidenceIds).toEqual(["ev-t01", "ev-t02"]);
  });
});

describe("时间和变化判定（四种）", () => {
  it("场景不同：两条都成立，不算冲突", () => {
    const [a] = say("工作日我喜欢参加技术交流", "2026-10-01T10:00:00+08:00", { context: ["work"] });
    const [b] = say("周末我不喜欢参加技术交流", "2026-10-01T20:00:00+08:00", { context: ["work"] });
    expect(b!.changes).toEqual([expect.objectContaining({ kind: "context_differs", oldFactId: a!.fact.id })]);
    expect(fact(a!.fact.id).status).toBe("active");
    expect(fact(b!.fact.id).status).toBe("active");
  });

  it("观点变化：旧的到期（validTo = 新的 validFrom）、标 superseded，不删；问以前仍答得出", () => {
    const [old] = say("我喜欢远程办公", "2026-03-01T10:00:00+08:00", { context: ["work"] });
    const [neu] = say("我现在不喜欢远程办公了", "2026-10-10T10:00:00+08:00", { context: ["work"] });
    expect(neu!.changes).toEqual([expect.objectContaining({ kind: "change_of_mind", oldFactId: old!.fact.id, newFactId: neu!.fact.id })]);
    expect(fact(old!.fact.id)).toMatchObject({ status: "superseded", supersededBy: neu!.fact.id, validTo: "2026-10-10T10:00:00+08:00" });
    expect(fact(old!.fact.id).statement).toBe("用户在 2026-03-01 到 2026-10-10 之间在工作中偏好远程办公");
    expect(kg.factsAt({ at: "2026-05-01T00:00:00+08:00" }).map((f) => f.id)).toEqual([old!.fact.id]);
    expect(kg.factsAt({ at: "2026-10-15T00:00:00+08:00" }).map((f) => f.id)).toEqual([neu!.fact.id]);
  });

  it("观点变化：「上个月开始不喜欢…了」明说了变化，有效期回溯到上个月", () => {
    const [old] = say("我很喜欢这个项目", "2026-03-01T10:00:00+08:00");
    const [neu] = say("我上个月开始不喜欢这个项目了", "2026-10-20T10:00:00+08:00");
    expect(fact(old!.fact.id)).toMatchObject({ status: "superseded", validTo: "2026-09-01T00:00:00+08:00" });
    expect(neu!.fact.validFrom).toBe("2026-09-01T00:00:00+08:00");
    expect(neu!.fact.observedAt).toBe("2026-10-20T10:00:00+08:00");
  });

  it("观点变化：新来的说的是更早的事、后说的（已有的那条）明说了变化 → 新来的它自己到期", () => {
    const [current] = say("我不再喜欢混合办公了", "2026-10-10T10:00:00+08:00");
    const [past] = say("我喜欢混合办公", "2026-04-01T10:00:00+08:00");
    expect(past!.fact).toMatchObject({ status: "superseded", supersededBy: current!.fact.id, validTo: "2026-10-10T10:00:00+08:00" });
    expect(fact(current!.fact.id).status).toBe("active");
  });

  it("334：前后两句意思相反、后说的没明说变了 → 真冲突，不按日子先后（新来的说的是更早的事也一样）", () => {
    const [a] = say("我喜欢混合办公", "2026-10-10T10:00:00+08:00");
    const [b] = say("我不喜欢混合办公", "2026-04-01T10:00:00+08:00");
    expect(b!.changes).toEqual([expect.objectContaining({ kind: "conflict", oldFactId: a!.fact.id })]);
    expect([fact(a!.fact.id).status, fact(b!.fact.id).status]).toEqual(["contested", "contested"]);
    const [c] = say("我喜欢开会", "2026-03-01T10:00:00+08:00");
    const [d] = say("最近不喜欢开会", "2026-10-10T10:00:00+08:00");
    expect(d!.changes).toEqual([expect.objectContaining({ kind: "conflict", oldFactId: c!.fact.id, signals: [] })]);
    expect(fact(c!.fact.id)).toMatchObject({ status: "contested", validTo: null });
  });

  it("同组互斥：喜欢远程办公 → 后来明说「以前…现在更喜欢去公司上班」", () => {
    const [remote] = say("我喜欢远程办公", "2026-03-01T10:00:00+08:00");
    say("以前喜欢远程办公，现在更喜欢去公司上班", "2026-10-10T10:00:00+08:00");
    expect(fact(remote!.fact.id)).toMatchObject({ status: "superseded", validTo: "2026-10-10T10:00:00+08:00" });
    // 只说"现在更喜欢"、没说以前怎样：拿不准是不是变了，当真冲突
    const [office] = say("我喜欢坐班", "2026-03-01T10:00:00+08:00", { context: ["weekend"] });
    say("现在更喜欢远程办公", "2026-10-10T10:00:00+08:00", { context: ["weekend"] });
    expect(fact(office!.fact.id).status).toBe("contested");
  });

  it("纠正：旧的 corrected、retractedBy 指向纠正的证据；新的有效期从旧的开始时算", () => {
    const [old] = say("我喜欢爬山", "2026-10-01T10:00:00+08:00");
    const results = say("记错了，我其实一直不喜欢爬山，喜欢的是徒步", "2026-10-15T10:00:00+08:00", { kind: "correction" });
    const [neu, hike] = results;
    expect(neu!.changes).toEqual([expect.objectContaining({ kind: "correction", oldFactId: old!.fact.id })]);
    expect(neu!.correctedFactIds).toEqual([old!.fact.id]);
    expect(fact(old!.fact.id)).toMatchObject({ status: "corrected", retractedBy: "ev-t02" });
    expect(neu!.fact.validFrom).toBeNull();
    expect(hike!.fact.predicate).toBe("prefers");
    // 纠正了的从来没成立过：哪个时间点都查不到；"喜欢的是徒步"没说一直，从说的时候起
    expect(kg.factsAt({ at: "2026-10-05T00:00:00+08:00" }).map((f) => f.id)).toEqual([neu!.fact.id]);
    expect(kg.factsAt({ at: "2026-10-16T00:00:00+08:00" }).map((f) => f.id)).toEqual([neu!.fact.id, hike!.fact.id]);
  });

  it("纠正一件事：其实那次聚会我没去（只纠最近那一次）", () => {
    const [first] = say("参加了聚会", "2026-09-20T20:00:00+08:00", { mode: "do", kind: "action" });
    const [second] = say("参加了聚会", "2026-10-04T20:00:00+08:00", { mode: "do", kind: "action" });
    const [fix] = say("记错了，那次聚会我没去", "2026-10-06T10:00:00+08:00", { kind: "correction" });
    expect(fact(second!.fact.id).status).toBe("corrected");
    expect(fact(first!.fact.id).status).toBe("active");
    expect(fix!.fact).toMatchObject({ predicate: "declined", eventTime: "2026-10-04T20:00:00+08:00" });
  });

  it("真冲突：同一天、同一场景、没有变化信号，两条都 contested，生成一个追问", () => {
    const [a] = say("我喜欢吃辣", "2026-10-05T08:00:00+08:00");
    const [b] = say("我不喜欢吃辣", "2026-10-05T20:00:00+08:00");
    expect(b!.changes).toEqual([expect.objectContaining({ kind: "conflict" })]);
    expect(fact(a!.fact.id)).toMatchObject({ status: "contested", contestedWith: [b!.fact.id] });
    expect(fact(b!.fact.id)).toMatchObject({ status: "contested", contestedWith: [a!.fact.id] });
    expect(b!.probeIds).toHaveLength(1);
    const probe = store.getProbe(b!.probeIds[0]!)!;
    expect(probe).toMatchObject({ discriminates: [a!.fact.id, b!.fact.id], queries: ["吃辣"], outcome: "open", ifFound: null });
    expect(probe.ask).toBe("关于「吃辣」，是「偏好吃辣」还是「不喜欢吃辣」？");
  });

  it("不知道什么时候说的两条也只能算真冲突", () => {
    const [a] = say("我喜欢吃辣", null, { observedAt: "2026-10-05T08:00:00+08:00" });
    say("我不喜欢吃辣", null, { observedAt: "2026-10-09T08:00:00+08:00" });
    expect(fact(a!.fact.id).status).toBe("contested");
  });

  it("以前喜欢，现在不喜欢了：以前那条本来就到期，记上被哪条接上", () => {
    const [before, now] = say("我以前喜欢爬山，现在不喜欢了", "2026-10-10T10:00:00+08:00");
    expect(fact(before!.fact.id)).toMatchObject({ status: "superseded", supersededBy: now!.fact.id, validFrom: null, validTo: "2026-10-10T10:00:00+08:00" });
  });

  it("去年喜欢、今年更喜欢别的：有效期不重叠，各自成立", () => {
    const [lastYear] = say("去年喜欢远程办公", "2026-10-10T10:00:00+08:00");
    const [thisYear] = say("今年更喜欢混合办公", "2026-10-10T11:00:00+08:00");
    expect(thisYear!.changes).toEqual([expect.objectContaining({ kind: "time_differs" })]);
    expect(kg.factsAt({ at: "2025-06-01T00:00:00+08:00" }).map((f) => f.id)).toEqual([lastYear!.fact.id]);
    expect(kg.factsAt({ at: "2026-10-15T00:00:00+08:00" }).map((f) => f.id)).toEqual([thisYear!.fact.id]);
  });

  it("194：「上回说那周要加班，其实那周一点都不忙」纠掉的是周末那条「忙」，复述的那句不再抽成新的「忙」", () => {
    const scene = { context: ["weekend", "work", "social"] };
    const first = say("下周末的聚餐我去不了，要加班赶方案。", "2026-01-05T20:00:00+08:00", scene);
    const busy = first.find((r) => r.fact.statement.includes("忙"))!;
    const fix = say("跟你更正一下：上回说聚餐那周要加班，其实那周一点都不忙，就是不想去，随口找了个理由。", "2026-01-13T20:00:00+08:00", scene);
    const notBusy = fix.find((r) => r.fact.negated && r.fact.statement.includes("忙"))!;
    expect(notBusy.fact.context.toSorted()).toEqual(["social", "weekend", "work"]);
    expect(notBusy.changes).toEqual([expect.objectContaining({ kind: "correction", oldFactId: busy.fact.id })]);
    expect(fact(busy.fact.id)).toMatchObject({ status: "corrected", retractedBy: "ev-t02" });
    // 新抽出来的只有「不忙」和「拒绝了聚餐」，没有复述出来的「忙」、也没有「拒绝了忙」
    const fromFix = store.listFacts().filter((f) => f.evidenceIds.includes("ev-t02"));
    expect(fromFix.map((f) => `${f.negated ? "¬" : ""}${f.predicate}:${store.getEntity((f.object as { id: string }).id)!.name}`).toSorted()).toEqual(["declined:聚餐", "¬said_about:忙"]);
  });

  it("别人转述的不取代、不纠正本人的", () => {
    const [mine] = say("我喜欢社交", "2026-10-01T10:00:00+08:00");
    say("同事说他其实一直很讨厌社交", "2026-10-02T10:00:00+08:00", { sourceLevel: "untrusted" });
    expect(fact(mine!.fact.id).status).toBe("active");
  });
});

describe("334：一句话抽出来的事实，开始不早于说这句话的那天", () => {
  const SAID = "2026-10-18T22:00:00+08:00";
  function addDraft(text: string, over: Partial<FactDraft>): Fact {
    n += 1;
    const evidence = store.insertEvidence({ id: `ev-d${n}`, sourceLevel: "self", mode: "say", kind: "utterance", text, context: [], eventTime: SAID, observedAt: SAID });
    const draft: FactDraft = {
      subject: { id: USER_ENTITY_ID },
      predicate: "prefers",
      object: { type: "entity", ref: { name: `话题${n}`, type: "topic" } },
      negated: false,
      context: [],
      signals: { change: ["model:change"], correction: [] },
      span: text,
      ...over,
    };
    return kg.addFact(draft, evidence, "model:fake").fact;
  }

  it("模型给 null（= 一直）、原话说的是现在的感受或打算：按说话那天算开始", () => {
    expect(addDraft("有点想回去读博了", { validFrom: null }).validFrom).toBe(SAID);
    // 模型编了个更早的日子、原话里没有：一样按说话那天
    expect(addDraft("有点想回去读博了", { validFrom: "2026-01-01T00:00:00+08:00" }).validFrom).toBe(SAID);
  });

  it("原话自己说了从什么时候起（一直、以前、上个月开始），照它；同一天早几个钟头的不挪；说的是以前（到说话时就结束了）不动", () => {
    expect(addDraft("我一直喜欢爬山", { validFrom: null }).validFrom).toBeNull();
    expect(addDraft("我上个月开始不喜欢这个项目了", { validFrom: "2026-09-01T00:00:00+08:00" }).validFrom).toBe("2026-09-01T00:00:00+08:00");
    expect(addDraft("从小就怕狗", { validFrom: null }).validFrom).toBeNull();
    expect(addDraft("今天想早点睡", { validFrom: "2026-10-18T08:00:00+08:00" }).validFrom).toBe("2026-10-18T08:00:00+08:00");
    expect(addDraft("那会儿挺喜欢打球", { validFrom: null, validTo: SAID })).toMatchObject({ validFrom: null, validTo: SAID });
  });

  it("规则版不受影响：没时间说法的本来就从说话那天起，「以前」「一直」照旧", () => {
    expect(say("我喜欢爬山", SAID)[0]!.fact.validFrom).toBe(SAID);
    expect(say("我一直不喜欢香菜", SAID)[0]!.fact.validFrom).toBeNull();
  });
});

describe("按时间点、场景查事实", () => {
  it("场景过滤：事实的场景和问的重叠，或者事实不限场景", () => {
    const [weekend] = say("周末想好好休息", "2026-10-01T10:00:00+08:00", { context: ["social"] });
    const [workday] = say("工作日喜欢参加技术交流", "2026-10-01T11:00:00+08:00", { context: ["work"] });
    const [any] = say("我喜欢吃辣", "2026-10-01T12:00:00+08:00");
    const at = "2026-10-02T00:00:00+08:00";
    expect(kg.factsAt({ at, context: ["weekend"] }).map((f) => f.id)).toEqual([weekend!.fact.id, any!.fact.id]);
    expect(kg.factsAt({ at, context: ["workday", "work"] }).map((f) => f.id)).toEqual([workday!.fact.id, any!.fact.id]);
    expect(kg.factsAt({ at }).map((f) => f.id)).toEqual([weekend!.fact.id, workday!.fact.id, any!.fact.id]);
    expect(kg.factsAt({ at: "2026-09-30T00:00:00+08:00" })).toEqual([]);
    expect(kg.factsAt({ at, predicate: "prefers", objectId: entity("吃辣").id }).map((f) => f.id)).toEqual([any!.fact.id]);
  });
});

/** 用户 —参加→ 技术交流 —在→ 公司 —有→ 同事；用户 —喜欢→ 爬山 */
function smallGraph() {
  const ev = store.insertEvidence({ id: "ev-g1", sourceLevel: "self", mode: "say", kind: "utterance", text: "x", context: [], eventTime: CLOCK, observedAt: CLOCK });
  const base = { negated: false, assertion: "user_stated" as const, context: [], evidenceIds: [ev.id], eventTime: CLOCK, observedAt: CLOCK, validFrom: CLOCK, validTo: null, status: "active" as const, supersededBy: null, retractedBy: null, contestedWith: [], extractedBy: "rule:1" };
  const talk = kg.resolveEntity({ name: "技术交流", type: "activity" });
  const office = kg.resolveEntity({ name: "公司", type: "place" });
  const colleague = kg.resolveEntity({ name: "同事", type: "person" });
  const hike = kg.resolveEntity({ name: "爬山", type: "activity" });
  const put = (s: string, p: Fact["predicate"], o: string) => store.insertFact({ ...base, subjectId: s, predicate: p, object: { type: "entity", id: o }, statement: `${s} ${p} ${o}` }, { reason: "测试" });
  const f1 = put(USER_ENTITY_ID, "participated_in", talk.id);
  const f2 = put(talk.id, "occurred_at", office.id);
  const f3 = put(office.id, "associated_with", colleague.id);
  const f4 = put(USER_ENTITY_ID, "prefers", hike.id);
  return { talk, office, colleague, hike, f1, f2, f3, f4 };
}

describe("按实体查邻接", () => {
  it("一跳：经过主语或宾语是它的事实", () => {
    const g = smallGraph();
    const one = kg.neighbors(g.talk.id, 1);
    expect(one.entities.map((e) => [e.entity.name, e.hops]).toSorted()).toEqual([
      ["公司", 1],
      ["用户", 1],
    ]);
    expect(one.facts.map((f) => f.id).toSorted()).toEqual([g.f1.id, g.f2.id].toSorted());
  });

  it("两跳：再往外一层；stopAt 的实体不往外扩", () => {
    const g = smallGraph();
    const two = kg.neighbors(g.talk.id, 2);
    expect(two.entities.map((e) => [e.entity.name, e.hops]).toSorted()).toEqual([
      ["公司", 1],
      ["同事", 2],
      ["爬山", 2],
      ["用户", 1],
    ]);
    const stopped = kg.neighbors(g.talk.id, 2, { stopAt: [USER_ENTITY_ID] });
    expect(stopped.entities.map((e) => e.entity.name).toSorted()).toEqual(["公司", "同事", "用户"]);
  });

  it("只走成立的事实（默认不走纠正、撤回的；给了时间点只走那时成立的）", () => {
    const g = smallGraph();
    store.updateFact(g.f2.id, { status: "retracted", retractedBy: "ev-g1" }, { reason: "测试" });
    expect(kg.neighbors(g.talk.id, 1).entities.map((e) => e.entity.name)).toEqual(["用户"]);
    expect(kg.neighbors(g.talk.id, 1, { at: "2026-01-01T00:00:00+08:00" }).entities).toEqual([]);
  });
});

describe("证据失效时事实这一层", () => {
  it("只靠它的事实撤回；还有别的证据的去掉它、保持原状", () => {
    const [only] = say("我喜欢吃辣", "2026-10-01T10:00:00+08:00");
    const [shared] = say("我喜欢爬山", "2026-10-01T11:00:00+08:00");
    say("还是喜欢爬山", "2026-10-02T11:00:00+08:00");
    store.updateEvidence("ev-t02", { status: "forgotten", text: "" }, { reason: "忘掉" });
    const r = kg.dropEvidence("ev-t02", "forgotten", "ev-t02");
    expect(r).toEqual({ retractedFactIds: [], weakenedFactIds: [shared!.fact.id], restoredFactIds: [] });
    expect(fact(shared!.fact.id)).toMatchObject({ status: "active", evidenceIds: ["ev-t03"] });
    store.updateEvidence("ev-t01", { status: "forgotten", text: "" }, { reason: "忘掉" });
    expect(kg.dropEvidence("ev-t01", "forgotten", "ev-t01").retractedFactIds).toEqual([only!.fact.id]);
    expect(fact(only!.fact.id)).toMatchObject({ status: "retracted", retractedBy: "ev-t01" });
  });

  it("取代它的事实撤回了：旧的恢复原状（有效期、状态、陈述）", () => {
    const [old] = say("我喜欢远程办公", "2026-03-01T10:00:00+08:00");
    const [neu] = say("我现在不喜欢远程办公了", "2026-10-10T10:00:00+08:00");
    const before = fact(old!.fact.id);
    expect(before.status).toBe("superseded");
    store.updateEvidence("ev-t02", { status: "forgotten", text: "" }, { reason: "忘掉" });
    const r = kg.dropEvidence("ev-t02", "forgotten", "ev-t02");
    expect(r.retractedFactIds).toEqual([neu!.fact.id]);
    expect(r.restoredFactIds).toEqual([old!.fact.id]);
    expect(fact(old!.fact.id)).toMatchObject({ status: "active", supersededBy: null, validTo: null, statement: old!.fact.statement });
  });

  it("冲突的另一条撤回了：剩下的回到 active", () => {
    const [a] = say("我喜欢吃辣", "2026-10-05T08:00:00+08:00");
    say("我不喜欢吃辣", "2026-10-05T20:00:00+08:00");
    store.updateEvidence("ev-t02", { status: "corrected" }, { reason: "纠正" });
    const r = kg.dropEvidence("ev-t02", "corrected", "ev-t02");
    expect(r.restoredFactIds).toEqual([a!.fact.id]);
    expect(fact(a!.fact.id)).toMatchObject({ status: "active", contestedWith: [] });
  });

  it("纠正它的证据被忘掉：被纠正的旧事实恢复", () => {
    const [old] = say("我喜欢爬山", "2026-10-01T10:00:00+08:00");
    say("记错了，我其实一直不喜欢爬山", "2026-10-15T10:00:00+08:00", { kind: "correction" });
    expect(fact(old!.fact.id).status).toBe("corrected");
    store.updateEvidence("ev-t02", { status: "forgotten", text: "" }, { reason: "忘掉" });
    const r = kg.dropEvidence("ev-t02", "forgotten", "ev-t02");
    expect(r.restoredFactIds).toContain(old!.fact.id);
    expect(fact(old!.fact.id)).toMatchObject({ status: "active", retractedBy: null });
  });
});
