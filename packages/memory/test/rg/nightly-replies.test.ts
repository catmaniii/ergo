// 271 号票：顺口问的回答由记忆管理员每晚整理时批量判（假模型）。线上秘书按语气自己改写问法，用户也常常不正面答——
// 问"这阵子是不是特别忙"，答"最近在赶项目"：白天的规则（classifyReply）认不出，以前到第二天就记成"问了没答、跳过一次"。
// 现在每晚整理时把问题和用户之后的几句话交给记忆管理员判：答了回写成本人证据（同一夜按判法判）、没答算跳过一次、拿不准留到下一夜。
// 预算：判回答那一道从整理预算的前段里划一小份保底，排在新证据之后、重跑旧追问之前。
// 例子都是自己写的；问题箱用周末社交案例的前三条整理一夜出来的那几个。
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceDraft } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import { LlmFactExtractor } from "../../src/kg/llm-extractor.ts";
import { FakeChatModel, type ChatRequest } from "../../src/llm/chat.ts";
import { runNightly } from "../../src/nightly.ts";
import { LlmReasoner } from "../../src/rg/llm-reasoner.ts";
import type { QuestionDraft } from "../../src/rg/question-sources.ts";
import type { QuestionView } from "../../src/rg/questions.ts";
import { LIFT_BUDGET_SHARE } from "../../src/rg/reasoning-graph.ts";
import { LlmReplyJudge, NIGHTLY_JUDGE_VIA, REPLY_JUDGE_SYSTEM } from "../../src/rg/reply-judge.ts";
import { claimOf, closeEngines, ingestWeekend, openEngine, say, type TestEngine } from "./helpers.ts";

afterEach(closeEngines);

const NIGHT1 = "2026-10-10T03:00:00+08:00";
const NIGHT2 = "2026-10-11T03:00:00+08:00";
const NIGHT3 = "2026-10-12T03:00:00+08:00";
const BUSY = "这阵子工作或者身体上是不是特别忙、特别累？";

async function firstNight(): Promise<TestEngine> {
  const t = openEngine("2026-10-09T22:00:00+08:00");
  ingestWeekend(t.engine, ["ev-w01", "ev-w02", "ev-w03"]);
  t.setNow(NIGHT1);
  expect((await t.engine.runNightly({ userActive: false })).ran).toBe(true);
  return t;
}

function questionBetween(engine: MemoryEngine, a: string, b: string): QuestionView {
  const ids = [claimOf(engine, a).id, claimOf(engine, b).id].toSorted();
  const q = engine.listQuestions().find((x) => x.kind === "unresolved" && x.targets.map((t) => t.id).toSorted().join() === ids.join());
  if (!q) throw new Error(`没有区分 ${a} 和 ${b} 的问题`);
  return q;
}

/** 第一夜以后，第二天 20:00 秘书顺着话题问了"是不是特别忙"（标了，记问过） */
async function askedBusy(): Promise<TestEngine & { q: QuestionView }> {
  const t = await firstNight();
  t.setNow("2026-10-10T20:00:00+08:00");
  const q = questionBetween(t.engine, "scene_autonomy", "recent_state");
  expect(q.text).toBe(BUSY);
  t.engine.markQuestionAsked(q.id, { how: "在聊天里顺着话题顺口问了" });
  return { ...t, q };
}

/** 判回答的假模型：按交来的请求回；记下每次请求 */
function judgeWith(respond: (request: ChatRequest) => unknown) {
  const calls: ChatRequest[] = [];
  const model = new FakeChatModel((request) => {
    calls.push(request);
    return respond(request);
  }, "fake-reply-judge");
  return { judge: new LlmReplyJudge(model), calls };
}

const answered = (verdict: "yes" | "no" | "unclear", ids: string[], why = "依据") => ({ kind: "answered", verdict, answer: ids, why });

const question = (engine: MemoryEngine, id: string) => engine.listQuestions().find((x) => x.id === id)!;

describe("271：每晚整理时记忆管理员判顺口问的回答", () => {
  it("隐含的回答（问'是不是特别忙'、答'最近在赶项目'）：白天的规则认不出，夜里判成在答——回答经写入口回写成本人证据，同一夜按判法判", async () => {
    const t = await askedBusy();
    const tired = claimOf(t.engine, "recent_state");
    // 白天的规则只认明显的：这句它认不出（以前到第二天就算"问了没答"）
    expect(t.engine.readQuestionReply(t.q.id, "最近在赶项目，天天弄到很晚").kind).toBe("unrelated");
    // 用户之后的话（守护进程里是这几句的素材，整理时读成证据）
    t.engine.ingestEvidence(say("ev-r1", "最近在赶项目，天天弄到很晚", "2026-10-10T20:05:00+08:00"));
    t.engine.ingestEvidence(say("ev-r2", "对了，周六早上的闹钟帮我关掉", "2026-10-10T20:10:00+08:00"));
    const { judge, calls } = judgeWith(() => answered("yes", ["s1"], "在赶项目就是忙"));
    t.setNow(NIGHT2);
    const night = await t.engine.runNightly({ userActive: false, replyJudge: judge });
    if (!night.ran) throw new Error("第二夜没跑");

    // 交给记忆管理员的：问题、为什么问、两种回答各说明什么、用户之后的两句话（s1、s2）
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "reply", system: REPLY_JUDGE_SYSTEM });
    expect(calls[0]!.user).toContain(BUSY);
    expect(calls[0]!.user).toContain("s1 10-10 20:05「最近在赶项目，天天弄到很晚」");
    expect(calls[0]!.user).toContain("s2 10-10 20:10「对了，周六早上的闹钟帮我关掉」");

    // 回写：回答是 ev-r1（本人证据），读成"是"；不算明确，同一夜按判法记强的，判过了
    const q = question(t.engine, t.q.id);
    expect(q).toMatchObject({ status: "resolved", answerEvidenceId: "ev-r1", verdict: "yes", clear: false });
    expect(q.history.map((h) => h.event)).toEqual(["created", "asked", "answered", "resolved"]);
    expect(q.history[2]!.detail).toContain("记忆管理员夜里看了问过以后用户说的话，判成在答");
    expect(q.outcome).toContain(tired.id);
    // 写入口留痕：回答是用户的表态、经记忆管理员夜里判
    expect(t.engine.gate.history(t.q.id)).toEqual(expect.arrayContaining([expect.objectContaining({ objectType: "question", op: "verdict", actor: "user_verdict", via: NIGHTLY_JUDGE_VIA })]));
    // 报告：判回答那一道花了 1 次，问题队列的变化里写着答了
    expect(night.report.spend.replies).toBe(1);
    expect(night.report.questions.replies).toMatchObject({ calls: 1, answered: [expect.objectContaining({ id: t.q.id })], notAnswered: [], unsure: [] });
    expect(night.report.questions.skipped).toEqual([]);
    expect(night.report.text).toContain(`顺口问的回答（记忆管理员看问过以后用户说的话，问了 1 次模型）：答了 ${t.q.id}`);
    expect(night.report.text).toContain("判回答 1");
  });

  it("说得明确（'确实，这阵子特别忙'，但不是紧接着的下一句）：规则也读成同一边、有加重的，马上判（标你确认过、记决定性的支持）", async () => {
    const t = await askedBusy();
    const tired = claimOf(t.engine, "recent_state");
    t.engine.ingestEvidence(say("ev-r1", "帮我看看周六天气", "2026-10-10T20:02:00+08:00"));
    t.engine.ingestEvidence(say("ev-r2", "确实，这阵子特别忙", "2026-10-10T20:06:00+08:00"));
    const { judge } = judgeWith(() => answered("yes", ["s2"], "说了特别忙"));
    t.setNow(NIGHT2);
    await t.engine.runNightly({ userActive: false, replyJudge: judge });
    expect(question(t.engine, t.q.id)).toMatchObject({ status: "resolved", answerEvidenceId: "ev-r2", verdict: "yes", clear: true });
    // 规则版的抽取器把这句读出了别的事实（"近期不忙"，它的老毛病），这一组输赢另说；这里看的是回答被马上确认了
    expect(t.engine.store.getClaim(tired.id)).toMatchObject({ epistemic: "user_confirmed" });
    expect(t.engine.store.linksOf(tired.id).some((l) => l.target === "ev-r2" && l.polarity === "supports" && l.weight === "decisive")).toBe(true);
  });

  it("没在答（说的都是别的事）：算跳过一次——回到问题箱、优先级减半，经过里写明是夜里判的", async () => {
    const t = await askedBusy();
    t.engine.ingestEvidence(say("ev-r1", "帮我订明天去上海的火车票", "2026-10-10T20:05:00+08:00"));
    const { judge, calls } = judgeWith(() => ({ kind: "not_answered", why: "在交代订票" }));
    t.setNow(NIGHT2);
    const night = await t.engine.runNightly({ userActive: false, replyJudge: judge });
    if (!night.ran) throw new Error("第二夜没跑");
    expect(calls).toHaveLength(1);
    const q = question(t.engine, t.q.id);
    expect(q).toMatchObject({ status: "open", skippedCount: 1, answerEvidenceId: null });
    expect(q.priorityDetail.fresh).toBe(0.5);
    expect(q.history.at(-1)).toMatchObject({ event: "skipped" });
    expect(q.history.at(-1)!.detail).toContain("记忆管理员夜里看了问过以后用户说的话：在交代订票，算没答");
    expect(t.engine.gate.history(t.q.id).find((r) => r.op === "skip")).toMatchObject({ actor: "nightly", via: NIGHTLY_JUDGE_VIA });
    expect(night.report.questions.skipped.map((x) => x.id)).toEqual([t.q.id]);
  });

  it("问过以后用户一句都没再说：不问模型，算跳过一次", async () => {
    const t = await askedBusy();
    const { judge, calls } = judgeWith(() => answered("yes", ["s1"]));
    t.setNow(NIGHT2);
    const night = await t.engine.runNightly({ userActive: false, replyJudge: judge });
    if (!night.ran) throw new Error("第二夜没跑");
    expect(calls).toEqual([]);
    expect(question(t.engine, t.q.id)).toMatchObject({ status: "open", skippedCount: 1 });
    expect(night.report.spend.replies).toBe(0);
  });

  it("拿不准：留到下一夜（白天挑问题时不抢先记跳过）；下一夜用户又说了话就再判一次，这次判成在答", async () => {
    const t = await askedBusy();
    t.engine.ingestEvidence(say("ev-u1", "还行吧", "2026-10-10T20:05:00+08:00"));
    let reply: unknown = { kind: "unsure", why: "'还行吧'说不清" };
    const { judge, calls } = judgeWith(() => reply);
    t.setNow(NIGHT2);
    const night2 = await t.engine.runNightly({ userActive: false, replyJudge: judge });
    if (!night2.ran) throw new Error("第二夜没跑");
    let q = question(t.engine, t.q.id);
    expect(q).toMatchObject({ status: "asked", skippedCount: 0 });
    expect(q.history.at(-1)).toMatchObject({ event: "unsure", evidenceId: "ev-u1" });
    expect(q.history.at(-1)!.detail).toContain("拿不准有没有在答（第 1 夜，留到下一夜）");
    expect(night2.report.questions.replies!.unsure.map((x) => x.id)).toEqual([t.q.id]);
    expect(night2.report.text).toContain(`拿不准、留到下一夜 ${t.q.id}`);

    // 第二天白天：线上挑问题不抢先记跳过（settle: false），问题还等着夜里判
    t.setNow("2026-10-11T09:00:00+08:00");
    t.engine.pickQuestion("下周三公司的团建要不要去？", { peek: true, settle: false });
    expect(question(t.engine, t.q.id).status).toBe("asked");
    // 用户后来又说起这事（问过以后 24 小时内）
    t.engine.ingestEvidence(say("ev-u2", "这周项目上线，天天加班到十点", "2026-10-11T09:30:00+08:00"));
    reply = answered("yes", ["s2"], "天天加班");
    t.setNow(NIGHT3);
    await t.engine.runNightly({ userActive: false, replyJudge: judge });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain("s1 10-10 20:05「还行吧」");
    expect(calls[1]!.user).toContain("s2 10-11 09:30「这周项目上线，天天加班到十点」");
    q = question(t.engine, t.q.id);
    expect(q).toMatchObject({ status: "resolved", answerEvidenceId: "ev-u2", verdict: "yes" });
  });

  it("拿不准以后用户没再说什么：第二夜不问模型，当没答算跳过一次；第二夜还拿不准也当没答（最多留两夜）", async () => {
    const quiet = await askedBusy();
    quiet.engine.ingestEvidence(say("ev-u1", "还行吧", "2026-10-10T20:05:00+08:00"));
    const once = judgeWith(() => ({ kind: "unsure", why: "说不清" }));
    quiet.setNow(NIGHT2);
    await quiet.engine.runNightly({ userActive: false, replyJudge: once.judge });
    quiet.setNow(NIGHT3);
    await quiet.engine.runNightly({ userActive: false, replyJudge: once.judge });
    expect(once.calls).toHaveLength(1);
    const q1 = question(quiet.engine, quiet.q.id);
    expect(q1).toMatchObject({ status: "open", skippedCount: 1 });
    expect(q1.history.at(-1)!.detail).toContain("拿不准以后用户没再说什么");

    closeEngines();
    const twice = await askedBusy();
    twice.engine.ingestEvidence(say("ev-u1", "还行吧", "2026-10-10T20:05:00+08:00"));
    const judge = judgeWith(() => ({ kind: "unsure", why: "还是说不清" }));
    twice.setNow(NIGHT2);
    await twice.engine.runNightly({ userActive: false, replyJudge: judge.judge });
    twice.engine.ingestEvidence(say("ev-u2", "看情况", "2026-10-11T10:00:00+08:00"));
    twice.setNow(NIGHT3);
    await twice.engine.runNightly({ userActive: false, replyJudge: judge.judge });
    expect(judge.calls).toHaveLength(2);
    const q2 = question(twice.engine, twice.q.id);
    expect(q2).toMatchObject({ status: "open", skippedCount: 1 });
    expect(q2.history.at(-1)!.detail).toContain("已经第 2 夜");
  });

  it("当天才问的（还没到第二天）这一夜不判；模型的回答读不懂当拿不准", async () => {
    const t = await firstNight();
    t.setNow("2026-10-11T01:30:00+08:00");
    const q = questionBetween(t.engine, "scene_autonomy", "recent_state");
    t.engine.markQuestionAsked(q.id);
    t.engine.ingestEvidence(say("ev-r1", "最近在赶项目", "2026-10-11T01:35:00+08:00"));
    const bad = judgeWith(() => "这不是 JSON");
    t.setNow(NIGHT2);
    const night = await t.engine.runNightly({ userActive: false, replyJudge: bad.judge });
    if (!night.ran) throw new Error("第二夜没跑");
    expect(bad.calls).toEqual([]);
    expect(question(t.engine, q.id).status).toBe("asked");
    expect(night.report.questions.replies!.later.map((x) => x.id)).toEqual([q.id]);
    t.setNow(NIGHT3);
    await t.engine.runNightly({ userActive: false, replyJudge: bad.judge });
    expect(bad.calls).toHaveLength(1);
    expect(question(t.engine, q.id).history.at(-1)).toMatchObject({ event: "unsure" });
  });

  it("没给判回答的模型（规则版的整理、演示）：照旧——问了没答到第二天算跳过一次；白天挑问题默认也照旧记", async () => {
    const t = await askedBusy();
    t.engine.ingestEvidence(say("ev-r1", "最近在赶项目", "2026-10-10T20:05:00+08:00"));
    t.setNow("2026-10-11T09:00:00+08:00");
    t.engine.pickQuestion("下周三公司的团建要不要去？", { peek: true });
    expect(question(t.engine, t.q.id)).toMatchObject({ status: "open", skippedCount: 1 });
  });
});

// ---------- 预算：保底、排在新证据之后、重跑旧追问之前（模型版、假模型的小世界，同 270 的 nightly-lanes.test.ts） ----------

const OLD = ["皮划艇", "羽毛球", "电子琴", "乒乓球", "冲浪板", "天文台"] as const;
const topicOf = (text: string) => OLD.find((k) => text.includes(k));
const idsIn = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]!);

const said = (id: string, topic: string, day: number, hour = 20): EvidenceDraft => {
  const at = `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`;
  return { id, sourceLevel: "self", mode: "say", kind: "utterance", text: `这周我又去弄了${topic}，挺喜欢的。`, context: ["leisure"], eventTime: at, observedAt: at };
};

/** 假的整理模型：抽事实一条一条"喜欢某话题"，同一话题两条以上并成一组，每组三条追问，判证据什么都不认（只记问了哪条） */
function world(timeline: string[]) {
  const asked: string[] = [];
  const model = new FakeChatModel((req: ChatRequest) => {
    if (req.purpose === "extract") {
      const lines = req.user.split("\n").filter((l) => l.startsWith("{"));
      return {
        facts: lines.flatMap((l) => {
          const e = JSON.parse(l) as { evidence_id: string; text: string };
          const topic = topicOf(e.text);
          if (!topic) return [];
          return [{ evidence_id: e.evidence_id, predicate: "prefers", object: { name: `${topic}（${e.evidence_id}）`, type: "activity" }, negated: false, context: ["leisure"], statement: `用户喜欢${topic}（${e.evidence_id}）`, span: topic }];
        }),
      };
    }
    if (req.purpose === "propose") {
      const batch = req.user.split("这一批的观察")[1]!.split("别的事实")[0]!;
      const byTopic = new Map<string, string[]>();
      for (const line of batch.split("\n").filter((l) => l.startsWith("{"))) {
        const f = JSON.parse(line) as { fact_id: string; evidence: { text: string }[] };
        const topic = topicOf(f.evidence.map((e) => e.text).join(""));
        if (topic) byTopic.set(topic, [...(byTopic.get(topic) ?? []), f.fact_id]);
      }
      return {
        groups: [...byTopic]
          .filter(([, facts]) => facts.length >= 2)
          .map(([topic, facts]) => ({
            observation_ids: facts,
            description: `${topic}这件事`,
            hypotheses: [
              { tier: "preference", statement: `用户喜欢${topic}`, context: ["leisure"], supports: [{ target: facts[0], weight: "strong", rationale: "说喜欢" }], refutes: [] },
              { tier: "state", statement: `用户最近在试${topic}`, context: ["leisure"], valid_to: null, supports: [{ target: facts[1], weight: "weak", rationale: "最近又去" }], refutes: [] },
            ],
          })),
      };
    }
    if (req.purpose === "probes") {
      const topic = topicOf(req.user)!;
      const claims = idsIn(/"claim_id":"(cl-\d+)"/g, req.user);
      return { probes: [1, 2, 3].map((i) => ({ discriminates: [claims[0], claims[1]], ask: `${topic}第${i}问`, queries: [topic], if_found: claims[0] })) };
    }
    if (req.purpose === "judge") {
      const ask = /追问：(\S+?)（/.exec(req.user)![1]!;
      asked.push(ask);
      timeline.push(`追问 ${ask}`);
      return { found_evidence_ids: [], if_found: null, links: [] };
    }
    return {};
  }, "fake-world");
  return { model, asked };
}

/** 第一夜：六个旧话题各两条证据，建好六组、十八条追问；问题箱里放三个问题（要弄清皮划艇那组） */
async function builtWorld() {
  const timeline: string[] = [];
  const w = world(timeline);
  const t = openEngine("2026-10-11T03:00:00+08:00", { reasoner: new LlmReasoner(w.model), extractor: new LlmFactExtractor(w.model), joint: false });
  OLD.forEach((topic, i) => {
    t.engine.ingestEvidence(said(`ev-${i}a`, topic, i + 1, 9));
    t.engine.ingestEvidence(said(`ev-${i}b`, topic, i + 1, 21));
  });
  await t.engine.reflect({ maxModelCalls: 500 });
  expect(t.engine.store.listProbes()).toHaveLength(18);
  const [a, b] = t.engine.rg.registry.members(t.engine.rg.registry.listGroups({ live: true })[0]!.key).map((m) => m.claimId);
  const draft = (key: string, text: string): QuestionDraft => ({
    key,
    topic: `t:${key}`,
    kind: "unresolved",
    sources: ["unresolved"],
    text,
    why: "两条解释分不清",
    targets: [
      { id: a!, kind: "claim", statement: "喜欢" },
      { id: b!, kind: "claim", statement: "最近在试" },
    ],
    answers: { yes: { supports: [a!], refutes: [], maxWeight: "strong", note: "是喜欢" }, no: { supports: [b!], refutes: [], maxWeight: "strong", note: "只是在试" } },
    domains: ["leisure"],
    scenes: [],
    terms: [],
    probeId: null,
    validUntil: null,
    separation: 1,
    closeness: 1,
    frequency: 1,
  });
  const questions = ["q1", "q2", "q3"].map((key, i) => t.engine.questions.offer(draft(key, `第${i + 1}个问题：你是真喜欢还是只是在试？`), t.engine.store.now()).question!.id);
  w.asked.length = 0;
  w.model.calls.length = 0;
  timeline.length = 0;
  return { ...t, ...w, questions, timeline };
}

const front = (limit: number) => limit - Math.floor(limit * LIFT_BUDGET_SHARE);

describe("271：判回答的预算——保底一小份，排在新证据之后、重跑旧追问之前", () => {
  it("积压的新证据把前段用满时，判回答照样有保底的那一份（按这一夜要问模型的问题数，不多占）；总上限不变", async () => {
    const t = await builtWorld();
    t.setNow("2026-10-12T20:00:00+08:00");
    t.engine.markQuestionAsked(t.questions[0]!);
    t.engine.ingestEvidence(say("ev-f1", "其实我也就是最近才开始弄", "2026-10-12T20:05:00+08:00"));
    // 积压：六条新证据各提到一个旧话题，每条都在那个话题三条旧追问的检索结果里（新证据那一道要的远比前段多）
    OLD.forEach((topic, i) => t.engine.ingestEvidence(said(`ev-new${i}`, topic, 12, 10 + i)));
    const { judge, calls } = judgeWith(() => answered("no", ["s1"], "说最近才开始"));
    t.setNow("2026-10-13T03:00:00+08:00");
    expect(front(13)).toBe(10);
    const night = await runNightly(t.engine, { userActive: false, maxModelCalls: 13, replyJudge: judge });
    if (!night.ran) throw new Error("没跑");
    // 一个问题要判：保底 1 次；新证据最多用到前段 10 − 1 = 9 次
    expect(calls).toHaveLength(1);
    expect(night.report.spend).toMatchObject({ limit: 13, newEvidence: 9, replies: 1, rejudge: 0 });
    expect(night.report.reflect.modelCalls).toBeLessThanOrEqual(13);
    expect(question(t.engine, t.questions[0]!)).toMatchObject({ verdict: "no", answerEvidenceId: "ev-f1" });
  });

  it("新证据没用完的前段先给判回答，剩下的才轮到重跑旧追问；保底不够、没轮到的问题留到下一夜", async () => {
    const t = await builtWorld();
    t.setNow("2026-10-12T20:00:00+08:00");
    for (const id of t.questions) t.engine.markQuestionAsked(id, { at: "2026-10-12T20:00:00+08:00" });
    t.engine.ingestEvidence(say("ev-f1", "说不好", "2026-10-12T20:05:00+08:00"));
    // 标着复核的组（重跑旧追问那一道有活干）
    const claim = t.engine.store.getClaim(t.engine.rg.registry.members(t.engine.rg.registry.listGroups({ live: true })[1]!.key)[0]!.claimId)!;
    t.engine.gate.write({ op: "mark_review", reason: "测试：加复核标记" }, () => t.engine.gate.updateClaim(claim.id, { needsReview: true }, { reason: "测试" }));
    const { judge, calls } = judgeWith((req) => {
      t.timeline.push(`判回答 ${/问题（(qu-\d+)）/.exec(req.user)![1]}`);
      return { kind: "unsure", why: "说不清" };
    });
    const before = t.asked.length;
    t.setNow("2026-10-13T03:00:00+08:00");
    // 保底只给 1 次（测试把上限压低），新证据只要很少几次：剩下的前段先给判回答（三个问题都判了），再给重跑旧追问
    const night = await runNightly(t.engine, { userActive: false, maxModelCalls: 40, replyJudge: judge, replyReserve: 1 });
    if (!night.ran) throw new Error("没跑");
    expect(calls).toHaveLength(3);
    expect(night.report.spend.replies).toBe(3);
    expect(night.report.spend.rejudge).toBeGreaterThan(0);
    expect(t.asked.length).toBeGreaterThan(before);
    // 先判回答，再重跑旧追问（这一夜新证据那一道一条追问都不用问）
    const lastReply = t.timeline.findLastIndex((x) => x.startsWith("判回答"));
    const firstRejudge = t.timeline.findIndex((x) => x.startsWith("追问"));
    expect(lastReply).toBeGreaterThanOrEqual(0);
    expect(firstRejudge).toBeGreaterThan(lastReply);
    // 都拿不准：还等着回答，经过里记了一笔 unsure（这几个问题是测试塞进去的，整理末尾出问题时没有同 key 的草稿，被标"不用问了"）
    for (const id of t.questions) expect(question(t.engine, id).history.some((h) => h.event === "unsure")).toBe(true);
  });

  it("预算紧到只有保底那一次：判一个，另外几个留到下一夜（不算拿不准、不记跳过）；这一夜记预算用完", async () => {
    const t = await builtWorld();
    t.setNow("2026-10-12T20:00:00+08:00");
    for (const id of t.questions) t.engine.markQuestionAsked(id, { at: "2026-10-12T20:00:00+08:00" });
    t.engine.ingestEvidence(say("ev-f1", "说不好", "2026-10-12T20:05:00+08:00"));
    const { judge, calls } = judgeWith(() => ({ kind: "unsure", why: "说不清" }));
    t.setNow("2026-10-13T03:00:00+08:00");
    const tight = await runNightly(t.engine, { userActive: false, maxModelCalls: 1, replyJudge: judge });
    if (!tight.ran) throw new Error("没跑");
    expect(calls).toHaveLength(1);
    expect(tight.report.spend).toMatchObject({ limit: 1, newEvidence: 0, replies: 1 });
    const replies = tight.report.questions.replies!;
    expect(replies.unsure).toHaveLength(1);
    expect(replies.waiting).toHaveLength(2);
    for (const q of replies.waiting) expect(question(t.engine, q.id)).toMatchObject({ skippedCount: 0 });
    expect(tight.report.reflect.budgetExhausted).toBe(true);
    expect(tight.report.text).toContain("没判成、留到下一夜");
  });
});
