// 264 号票：顺口问接进线上时引擎这一半——
// - 只看不记（pickQuestion 的 peek）：秘书回话前先挑一个，等秘书真的在回话里带上了才记"问过"（markQuestionAsked）；
// - 读用户的下一句（classifyReply / readQuestionReply）：是在答这个问题、跳过、说"别问这个"，还是在说别的。规则版、不调模型：
//   宁可漏认（漏认的回答照样是素材，下一夜照常读成证据；问题到第二天算跳过一次），不错认（错认会把别的话记成对这个问题的回答）。
// 例子都是自己写的；问题箱用周末社交案例的前三条整理一夜出来的那几个。
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryEngine } from "../../src/engine.ts";
import { classifyReply, type QuestionView } from "../../src/rg/questions.ts";
import { claimOf, closeEngines, ingestWeekend, openEngine, say, type TestEngine } from "./helpers.ts";

afterEach(closeEngines);

const NIGHT1 = "2026-10-10T03:00:00+08:00";
const WEEKEND_TALK = "这周六同学约我聚会，我还在想要不要去。";
const OWN_TIME = "上次推掉的周末活动，要是时间由你自己定，你会去吗？";
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

const own = { text: OWN_TIME, terms: [] as string[] };
const busy = { text: BUSY, terms: [] as string[] };

describe("读用户的下一句：classifyReply", () => {
  it("说到了问题里的事、又表了态：是在回答（读成是 / 不是，加重的算明确）", () => {
    expect(classifyReply(own, "会啊，时间我自己定的话就去")).toMatchObject({ kind: "answer", verdict: "yes", clear: false });
    expect(classifyReply(own, "时间我自己定的话也不去")).toMatchObject({ kind: "answer", verdict: "no" });
    expect(classifyReply(busy, "确实，这阵子身体特别累")).toMatchObject({ kind: "answer", verdict: "yes", clear: true });
    expect(classifyReply(busy, "还好，这阵子一点都不忙")).toMatchObject({ kind: "answer", verdict: "no", clear: true });
  });

  it("短短一句接着问题的话头答（会 / 不会 / 去 / 不去 / 是的 / 对 / 没有）：是在回答", () => {
    expect(classifyReply(own, "会")).toMatchObject({ kind: "answer", verdict: "yes" });
    expect(classifyReply(own, "不会。")).toMatchObject({ kind: "answer", verdict: "no" });
    expect(classifyReply(own, "去啊")).toMatchObject({ kind: "answer", verdict: "yes" });
    expect(classifyReply(own, "不去")).toMatchObject({ kind: "answer", verdict: "no" });
    expect(classifyReply(busy, "是的")).toMatchObject({ kind: "answer", verdict: "yes" });
    expect(classifyReply(busy, "对")).toMatchObject({ kind: "answer", verdict: "yes" });
    expect(classifyReply(busy, "没有")).toMatchObject({ kind: "answer", verdict: "no" });
  });

  it("说不好的（看情况、不一定）也是回答，只是不判输赢", () => {
    expect(classifyReply(own, "看情况吧")).toMatchObject({ kind: "answer", verdict: "unclear" });
    expect(classifyReply(busy, "说不好")).toMatchObject({ kind: "answer", verdict: "unclear" });
  });

  it("接着说别的事、只是应一声的（好的、谢谢、嗯、帮我订票）：不算回答——宁可漏认，不错认", () => {
    for (const reply of ["好的谢谢", "嗯", "行，就这样", "帮我订明天去上海的火车票", "周六下午三点提醒我拿快递", "收到"]) {
      expect({ reply, kind: classifyReply(own, reply).kind }).toEqual({ reply, kind: "unrelated" });
      expect({ reply, kind: classifyReply(busy, reply).kind }).toEqual({ reply, kind: "unrelated" });
    }
  });

  it("问题的说法（检索短语、活动名）出现在回答里也算说到了这件事", () => {
    expect(classifyReply({ text: "下次王哥再约你，你会去吗？", terms: ["王哥"] }, "王哥约的话我肯定去")).toMatchObject({ kind: "answer", verdict: "yes", clear: true });
  });

  it("'别问这个''这个别问了''以后别再问'：别问这个（这一类不再问）；'别问为什么，反正我去'不算", () => {
    for (const reply of ["别问这个", "这个别问了", "以后别再问我这种事", "不要再问了"]) expect({ reply, kind: classifyReply(own, reply).kind }).toEqual({ reply, kind: "decline" });
    expect(classifyReply(own, "你别问为什么，反正时间我自己定就会去")).toMatchObject({ kind: "answer", verdict: "yes" });
  });

  it("'跳过''不想说''先不说这个'：跳过一次", () => {
    for (const reply of ["跳过", "不想说", "这个先不说了", "pass", "不想回答"]) expect({ reply, kind: classifyReply(busy, reply).kind }).toEqual({ reply, kind: "skip" });
  });
});

describe("只看不记、秘书带上了才记问过", () => {
  it("peek：挑出来、写好那一句，但问题还在问题箱里（没记问过，同一天还能再挑）", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T20:00:00+08:00");
    const peeked = t.engine.pickQuestion(WEEKEND_TALK, { peek: true });
    expect(peeked.ask).toBe(true);
    expect(peeked.text).toBe(`顺便问一句：${peeked.question!.text}（想更了解你一点，不想答可以跳过。）`);
    expect(peeked.matchedOn).toBeTruthy();
    expect(peeked.question!.status).toBe("open");
    expect(t.engine.listQuestions({ status: "asked" })).toEqual([]);
    expect(t.engine.pickQuestion(WEEKEND_TALK, { peek: true })).toMatchObject({ ask: true, question: { id: peeked.question!.id } });
  });

  it("markQuestionAsked：记问过（经过里写明怎么问的），之后同一天不再挑；不是开着的问题记不了", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T20:00:00+08:00");
    const q = questionBetween(t.engine, "scene_autonomy", "dislike_content");
    const peeked = t.engine.pickQuestion(WEEKEND_TALK, { peek: true });
    expect(peeked.question!.id).toBe(q.id);
    t.setNow("2026-10-10T20:01:00+08:00");
    const asked = t.engine.markQuestionAsked(q.id, { how: `秘书在回话末尾顺口问了（${peeked.matchedOn}）` });
    expect(asked).toMatchObject({ status: "asked", askedCount: 1, lastAskedAt: "2026-10-10T20:01:00+08:00" });
    expect(asked.history.at(-1)).toMatchObject({ event: "asked", at: "2026-10-10T20:01:00+08:00" });
    expect(asked.history.at(-1)!.detail).toContain("秘书在回话末尾顺口问了");
    expect(t.engine.pickQuestion("周日要不要约朋友去爬山？", { peek: true })).toMatchObject({ ask: false, reason: "asked_today" });
    expect(() => t.engine.markQuestionAsked(q.id)).toThrow(/问过、等回答/);
  });

  it("readQuestionReply：按那个问题读用户的下一句；读的结果交给 recordQuestionAnswer / recordQuestionSkipped / declineQuestion", async () => {
    const t = await firstNight();
    t.setNow("2026-10-10T20:00:00+08:00");
    const q = questionBetween(t.engine, "scene_autonomy", "dislike_content");
    t.engine.markQuestionAsked(q.id);
    expect(q.text).toBe(OWN_TIME);
    expect(t.engine.readQuestionReply(q.id, "好的谢谢").kind).toBe("unrelated");
    const reading = t.engine.readQuestionReply(q.id, "会啊，时间我自己定的话就去，就是不想周末被别人提前排满");
    expect(reading).toMatchObject({ kind: "answer", verdict: "yes" });
    t.setNow("2026-10-10T20:05:00+08:00");
    const record = t.engine.recordQuestionAnswer(q.id, say("ev-a1", "会啊，时间我自己定的话就去，就是不想周末被别人提前排满", "2026-10-10T20:05:00+08:00"));
    expect(record).toMatchObject({ verdict: "yes", applied: "nightly", question: { status: "answered" } });
    expect(() => t.engine.readQuestionReply("qu-9999", "会")).toThrow(/没有这个问题/);
  });
});
