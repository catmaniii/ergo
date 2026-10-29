import { describe, expect, it } from "vitest";
import { classifyChange, excludes, type ComparableFact } from "../../src/kg/change.ts";
import { clauseContext, contextsCompatible } from "../../src/kg/context.ts";
import { changeSignals, correctionSignals, explicitChangeSignals, resolveValidity, statesOwnStart } from "../../src/kg/signals.ts";

const REF = "2026-10-20T12:00:00+08:00";

function f(over: Partial<ComparableFact> = {}): ComparableFact {
  return {
    subjectId: "en-user",
    predicate: "prefers",
    object: { type: "entity", id: "en-0001" },
    negated: false,
    context: ["work"],
    eventTime: "2026-03-01T10:00:00+08:00",
    validFrom: "2026-03-01T10:00:00+08:00",
    validTo: null,
    ...over,
  };
}

describe("场景重不重叠", () => {
  it("一个维度上两边都写了、没有交集才算不重叠", () => {
    expect(contextsCompatible(["weekend", "social"], ["workday", "social"])).toBe(false);
    expect(contextsCompatible(["weekend", "social"], ["weekend"])).toBe(true);
    expect(contextsCompatible(["social"], ["work"])).toBe(false);
    expect(contextsCompatible(["work", "social"], ["social"])).toBe(true);
    expect(contextsCompatible(["travel", "business_trip"], ["travel", "vacation"])).toBe(false);
  });

  it("没写场景 = 不限场景；不认得的标签合起来比", () => {
    expect(contextsCompatible([], ["weekend"])).toBe(true);
    expect(contextsCompatible(["festival"], ["cafe"])).toBe(false);
    expect(contextsCompatible(["weekend", "festival"], ["weekend"])).toBe(true);
  });

  it("分句明说的周末、工作日盖过证据的；证据没标签时从分句补", () => {
    expect(clauseContext(["weekend", "social"], "最近周末想好好休息")).toEqual(["social", "weekend"]);
    expect(clauseContext(["weekend", "social"], "工作日我愿意参加")).toEqual(["social", "workday"]);
    expect(clauseContext(["weekend"], "我不喜欢吃辣")).toEqual(["weekend"]);
    expect(clauseContext([], "周末和朋友聚会")).toEqual(["weekend", "social"]);
  });
});

describe("信号词", () => {
  it("变化信号：开始、现在、最近、不再……以及句末的「不…了」", () => {
    expect(changeSignals("我现在不喜欢远程办公了")).toEqual(expect.arrayContaining(["现在"]));
    expect(changeSignals("上个月开始不喜欢这个项目")).toContain("开始");
    expect(changeSignals("我不喜欢远程办公了").length).toBeGreaterThan(0);
    expect(changeSignals("我喜欢远程办公")).toEqual([]);
  });

  it("纠正信号：其实一直、我从没、记错了、不是…是…", () => {
    expect(correctionSignals("记错了，我其实一直不喜欢爬山")).toEqual(expect.arrayContaining(["其实一直", "记错"]));
    expect(correctionSignals("我从没说过喜欢爬山").length).toBeGreaterThan(0);
    expect(correctionSignals("不是不喜欢聚会，是不喜欢周末被排满").length).toBeGreaterThan(0);
    expect(correctionSignals("其实我挺喜欢爬山")).toEqual([]);
    expect(correctionSignals("我不喜欢周末被提前排满")).toEqual([]);
  });
});

describe("334：这句话自己明说了变化没有（只认明说的，拿不准的不算）", () => {
  it("明说：不再、不…了、没…了、改成、越来越、开始、从…起、以前…现在…、搬家、换工作", () => {
    const explicit = [
      "我不再读博了",
      "想好了，毕业先工作，不读博了。",
      "对爬山没兴趣了",
      "改成每周去两次",
      "越来越不喜欢开会",
      "上个月开始不喜欢这个项目",
      "从9月起不加班",
      "搬到上海了",
      "上个月换了工作",
      "已经不想去了",
    ];
    expect(explicit.filter((text) => explicitChangeSignals(text).length === 0)).toEqual([]);
    expect(explicitChangeSignals("现在不喜欢了", "我以前喜欢爬山，现在不喜欢了")).toEqual(expect.arrayContaining(["以前…现在"]));
    expect(explicitChangeSignals("现在挺喜欢的", "以前不爱吃辣，现在挺喜欢的")).toEqual(["以前…现在"]);
  });

  it("只是相反、没说变了的不算：想…了、最近、现在、喜欢上…了", () => {
    const opposite = ["有点想回去读博了", "在公司这两个月天天调同一张报表，挺没意思的，有点想回去读博了。", "最近有点想读博", "我现在挺喜欢远程办公", "我喜欢爬山", "又想去跑步了", "我好像喜欢上徒步了"];
    expect(opposite.filter((text) => explicitChangeSignals(text).length > 0)).toEqual([]);
    // 宽的变化信号（老的 changeSignals）照旧认"最近""现在"——它管别的（矛盾根源里的"时间变了"、反常输入），不管谁取代谁
    expect(changeSignals("最近有点想读博")).toContain("最近");
  });

  it("这句话自己说了从什么时候起（时间说法、以前、一直）", () => {
    expect(statesOwnStart("上个月开始不喜欢这个项目", REF)).toBe(true);
    expect(statesOwnStart("我一直喜欢爬山", REF)).toBe(true);
    expect(statesOwnStart("以前喜欢爬山", REF)).toBe(true);
    expect(statesOwnStart("从小就怕狗", REF)).toBe(true);
    expect(statesOwnStart("有点想回去读博了", REF)).toBe(false);
    expect(statesOwnStart("最近周末想好好休息", REF)).toBe(false);
  });
});

describe("有效期的时间说法", () => {
  it("「上个月开始」从上个月 1 号起、现在仍成立", () => {
    expect(resolveValidity("我上个月开始不喜欢这个项目了", REF)).toEqual({ validFrom: "2026-09-01T00:00:00+08:00", validTo: null });
  });

  it("「去年」只在去年；「今年」从今年 1 月 1 日起", () => {
    expect(resolveValidity("去年喜欢远程办公", REF)).toEqual({ validFrom: "2025-01-01T00:00:00+08:00", validTo: "2026-01-01T00:00:00+08:00" });
    expect(resolveValidity("今年更喜欢混合办公", REF)).toEqual({ validFrom: "2026-01-01T00:00:00+08:00", validTo: null });
  });

  it("「三个月前开始」「从 9 月起」「上周」", () => {
    expect(resolveValidity("三个月前开始不爱跑步了", REF)).toEqual({ validFrom: "2026-07-20T12:00:00+08:00", validTo: null });
    expect(resolveValidity("从9月起喜欢徒步", REF)).toEqual({ validFrom: "2026-09-01T00:00:00+08:00", validTo: null });
    expect(resolveValidity("从十一月开始喜欢徒步", REF)).toEqual({ validFrom: "2025-11-01T00:00:00+08:00", validTo: null });
    expect(resolveValidity("上周很想休息", REF)).toEqual({ validFrom: "2026-10-12T00:00:00+08:00", validTo: "2026-10-19T00:00:00+08:00" });
  });

  it("没有时间说法（包括「最近」）不挪", () => {
    expect(resolveValidity("最近周末想好好休息", REF)).toBeUndefined();
    expect(resolveValidity("我喜欢爬山", REF)).toBeUndefined();
  });
});

const groupOf = (o: ComparableFact["object"]) => (o.type === "entity" && ["en-0001", "en-0002"].includes(o.id) ? "办公方式" : undefined);

describe("互相排斥", () => {
  it("喜欢 X ⟂ 不喜欢 X；同一谓词一条否定一条不否定", () => {
    expect(excludes(f(), f({ predicate: "dislikes" }))).toBe(true);
    expect(excludes(f({ predicate: "dislikes" }), f({ predicate: "dislikes", negated: true }))).toBe(true);
    expect(excludes(f(), f())).toBe(false);
    expect(excludes(f(), f({ predicate: "dislikes", negated: true }))).toBe(false);
    expect(excludes(f(), f({ predicate: "dislikes", object: { type: "entity", id: "en-0002" } }))).toBe(false);
    expect(excludes(f(), f({ subjectId: "en-0009", predicate: "dislikes" }))).toBe(false);
  });

  it("同一互斥组里的两样不会同时喜欢", () => {
    expect(excludes(f(), f({ object: { type: "entity", id: "en-0002" } }), { groupOf })).toBe(true);
    expect(excludes(f(), f({ object: { type: "entity", id: "en-0003" } }), { groupOf })).toBe(false);
  });

  it("事情类的要是同一天的同一件事；带纠正信号时不看日子", () => {
    const went = f({ predicate: "participated_in", eventTime: "2026-10-04T15:00:00+08:00", validFrom: "2026-10-04T15:00:00+08:00" });
    const sameDay = f({ predicate: "declined", eventTime: "2026-10-04T20:00:00+08:00", validFrom: "2026-10-04T20:00:00+08:00" });
    const otherDay = f({ predicate: "declined", eventTime: "2026-10-11T20:00:00+08:00", validFrom: "2026-10-11T20:00:00+08:00" });
    expect(excludes(went, sameDay)).toBe(true);
    expect(excludes(went, otherDay)).toBe(false);
    expect(excludes(went, otherDay, { correction: true })).toBe(true);
    expect(excludes(went, f({ predicate: "declined", eventTime: null, validFrom: "2026-10-11T20:00:00+08:00" }))).toBe(false);
  });
});

describe("变化判定：四种", () => {
  const none = { change: false, correction: false };

  it("场景不同：不算冲突", () => {
    expect(classifyChange(f({ context: ["workday", "work"] }), f({ predicate: "dislikes", context: ["weekend"] }), none)).toEqual({ kind: "context_differs" });
  });

  it("观点变化：有效期开始得晚的那条是后来的，它自己明说了变化才算（334）", () => {
    const later = f({ predicate: "dislikes", eventTime: "2026-10-10T10:00:00+08:00", validFrom: "2026-10-10T10:00:00+08:00" });
    expect(classifyChange(f(), later, { change: true, correction: false })).toEqual({ kind: "change_of_mind", later: "new" });
    // 新来的说的是更早的事：旧的那条是后来的，看旧的那条自己说没说变了
    expect(classifyChange(later, f(), { change: false, correction: false, oldChange: true })).toEqual({ kind: "change_of_mind", later: "old" });
    // 先说的那句说了变化不算数：要后说的那句说
    expect(classifyChange(f(), later, { change: false, correction: false, oldChange: true })).toEqual({ kind: "conflict" });
    expect(classifyChange(later, f(), { change: true, correction: false })).toEqual({ kind: "conflict" });
  });

  it("334：不在同一天说的、后说的没明说变了 → 真冲突，不再按日子先后让后说的赢", () => {
    const later = f({ predicate: "dislikes", eventTime: "2026-10-10T10:00:00+08:00", validFrom: "2026-10-10T10:00:00+08:00" });
    expect(classifyChange(f(), later, none)).toEqual({ kind: "conflict" });
    expect(classifyChange(later, f(), none)).toEqual({ kind: "conflict" });
  });

  it("纠正：带纠正信号", () => {
    expect(classifyChange(f(), f({ predicate: "dislikes", validFrom: null }), { change: false, correction: true })).toEqual({ kind: "correction" });
  });

  it("真冲突：同一天、同一场景、没有变化信号；或者不知道什么时候说的", () => {
    const morning = f({ eventTime: "2026-10-05T08:00:00+08:00", validFrom: "2026-10-05T08:00:00+08:00" });
    const evening = f({ predicate: "dislikes", eventTime: "2026-10-05T20:00:00+08:00", validFrom: "2026-10-05T20:00:00+08:00" });
    expect(classifyChange(morning, evening, none)).toEqual({ kind: "conflict" });
    expect(classifyChange(f({ eventTime: null }), f({ predicate: "dislikes", eventTime: null, validFrom: "2026-10-05T20:00:00+08:00" }), none)).toEqual({ kind: "conflict" });
    // 说的是同一段时间（开始得一样早），有变化信号也分不出先后
    expect(classifyChange(f({ validFrom: null }), f({ predicate: "dislikes", validFrom: null }), { change: true, correction: false })).toEqual({ kind: "conflict" });
  });

  it("有效期不重叠：去年喜欢、今年不喜欢", () => {
    const lastYear = f({ validFrom: "2025-01-01T00:00:00+08:00", validTo: "2026-01-01T00:00:00+08:00" });
    const thisYear = f({ predicate: "dislikes", validFrom: "2026-01-01T00:00:00+08:00", eventTime: "2026-10-05T20:00:00+08:00" });
    expect(classifyChange(lastYear, thisYear, none)).toEqual({ kind: "time_differs" });
  });
});
