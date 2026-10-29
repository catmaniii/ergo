// 207 号票：规则版抽取修两个毛病——问句不当成说过的事、否定不能丢。接进二狗以后每句话都是素材，不修会造出假事实。
// 例子都是自己写的。188 的规则版（rule:3）和引擎默认的 rule:4（199）都要对。
import { afterEach, describe, expect, it } from "vitest";
import type { Evidence, EvidenceDraft } from "../../src/domain/types.ts";
import { clauseMoods, RuleFactExtractor, type FactDraft, type KgView } from "../../src/kg/extractor.ts";
import { RelationalFactExtractor } from "../../src/kg/relations.ts";
import { closeEngines, openEngine, say } from "../rg/helpers.ts";

afterEach(closeEngines);

const T = "2026-10-12T22:00:00+08:00";
const EMPTY: KgView = { findEntity: () => undefined, knownNames: () => [] };
const EXTRACTORS = [new RuleFactExtractor(), new RelationalFactExtractor()] as const;

function ev(text: string, over: Partial<Evidence> = {}): Evidence {
  return { id: "ev-1", sourceLevel: "self", mode: "say", kind: "utterance", text, context: [], eventTime: T, observedAt: T, sourceRef: null, contentHash: "h", status: "active", ...over };
}

function brief(d: FactDraft): string {
  const obj = d.object.type === "value" ? d.object.value : "name" in d.object.ref ? d.object.ref.name : d.object.ref.id;
  const subject = "name" in d.subject && d.subject.name !== "用户" ? `${d.subject.name}.` : "";
  return `${subject}${d.negated ? "¬" : ""}${d.predicate}(${obj})`;
}

/** 两个规则版各抽一遍（结果要一样的用这个） */
const both = (text: string, over: Partial<Evidence> = {}) => EXTRACTORS.map((x) => x.extract(ev(text, over), EMPTY).map(brief));

describe("分句的语气：哪些是问句、商量的话", () => {
  it("问号结尾的句子：最后一个分句是问句；前面的分句有疑问词、\"还是\"、\"吗\"的也是，没有的照旧是陈述", () => {
    expect(clauseMoods("我昨天推掉了聚会，你觉得我做得对吗？")).toEqual([
      { text: "我昨天推掉了聚会", question: false },
      { text: "你觉得我做得对吗", question: true },
    ]);
    expect(clauseMoods("周末要不要出去，还是在家歇着？").map((c) => c.question)).toEqual([true, true]);
    expect(clauseMoods("上海到杭州的高铁要坐几个小时？").map((c) => c.question)).toEqual([true]);
  });

  it("没有问号也认：要不要、该不该、是不是该、能不能、去不去这类正反问，句末的\"吗\"，\"难道\"这类反问", () => {
    for (const text of ["我还在想要不要去", "周六去不去爬山", "你说我是不是该去跑步", "明天能不能推掉那个会", "你周末有空吗", "难道我不想去"]) {
      expect({ text, moods: clauseMoods(text).map((c) => c.question) }).toEqual({ text, moods: [true] });
    }
  });

  it("陈述句不当成问句：\"什么都不想做\"\"要不我们改天\"\"差不多就这样\"\"我不知道他去了没\"", () => {
    for (const text of ["什么都不想做", "要不我们改天吧", "差不多就这样", "这周天天加班到十一点"]) {
      expect({ text, moods: clauseMoods(text).map((c) => c.question) }).toEqual({ text, moods: [false] });
    }
  });
});

describe("问句不当成说过的事", () => {
  it("\"周日要不要约朋友去爬山？\"不抽成\"主动约了爬山\"", () => {
    expect(both("周日要不要约朋友去爬山？")).toEqual([[], []]);
  });

  it("\"我还在想要不要去\"不抽成\"偏好不要去\"；商量的话（该不该、是不是该、能不能、去不去）都不抽", () => {
    for (const text of ["这周六同学约我聚会，我还在想要不要去。", "这周末该不该去参加同学聚会？", "你说我是不是该把健身卡退了", "明天能不能推掉那个会？", "周六的聚会我还没想好去不去。", "我要不要每天跑步？"]) {
      expect({ text, facts: both(text) }).toEqual({ text, facts: [[], []] });
    }
  });

  it("反问句、问状态的也不抽：\"难道我不想去吗？\"\"最近忙吗？\"\"累不累？\"", () => {
    for (const text of ["难道我不想去吗？", "最近忙吗？", "你累不累？", "你喜欢爬山吗？"]) {
      expect({ text, facts: both(text) }).toEqual({ text, facts: [[], []] });
    }
  });

  it("问句前面的陈述照样抽：\"我昨天推掉了聚会，你觉得我做得对吗？\"", () => {
    expect(both("我昨天推掉了聚会，你觉得我做得对吗？")).toEqual([["declined(聚会)"], ["declined(聚会)"]]);
  });

  it("问句里说到的那件事留给后面的分句：小周问\"周六爬山去不去？\"，我回\"不去了\" → 推掉了爬山（rule:4 认成小周约的那次爬山）", () => {
    const [rule3, rule4] = both("小周问：“周六爬山去不去？”我回：“不去了。”");
    expect(rule3).toEqual(["declined(爬山)"]);
    expect(rule4).toEqual(["declined(小周约的爬山（2026-10-17）)", "小周约的爬山（2026-10-17）.organized_by(小周)", "小周约的爬山（2026-10-17）.of_type(运动)"]);
  });

  it("rule:4：问句里的\"跟阿杰去\"不是和阿杰一起去了（只记提到了阿杰）；\"要不要每天跑\"不是打算每天跑", () => {
    const facts = new RelationalFactExtractor().extract(ev("周六要不要跟阿杰去爬山？"), EMPTY).map(brief);
    expect(facts).not.toContain("went_with(阿杰)");
    expect(facts).toContain("mentioned(阿杰)");
    expect(new RelationalFactExtractor().extract(ev("我是不是该从下周起每天跑步？"), EMPTY).map(brief)).toEqual([]);
  });

  it("整条链路：问句灌进库也不出事实，不进推理", async () => {
    const t = openEngine("2026-10-20T12:00:00+08:00");
    const drafts: EvidenceDraft[] = [
      say("ev-q1", "周日要不要约朋友去爬山？", "2026-10-10T21:30:00+08:00", { context: ["weekend"] }),
      say("ev-q2", "这周六同学约我聚会，我还在想要不要去。", "2026-10-10T20:00:00+08:00", { context: ["weekend", "social"] }),
    ];
    for (const d of drafts) t.engine.ingestEvidence(d);
    t.engine.extractFacts();
    expect(t.engine.store.factsByEvidence("ev-q1")).toEqual([]);
    expect(t.engine.store.factsByEvidence("ev-q2")).toEqual([]);
  });
});

describe("否定不能丢：说自己不忙、不累", () => {
  it("\"不算忙\"\"不怎么累\"\"没那么忙\"\"一点都不累\"抽成否定", () => {
    for (const [text, want] of [
      ["这阵子不算忙", "¬said_about(忙)"],
      ["最近不怎么累", "¬said_about(累)"],
      ["其实没那么忙", "¬said_about(忙)"],
      ["一点都不累", "¬said_about(累)"],
    ] as const) {
      expect({ text, facts: both(text) }).toEqual({ text, facts: [[want], [want]] });
    }
  });

  it("别的说法也一样：不是很忙、也不太累、谈不上忙、没觉得累、不咋忙、这周不用加班", () => {
    for (const [text, want] of [
      ["不是很忙", "¬said_about(忙)"],
      ["也不太累", "¬said_about(累)"],
      ["谈不上忙", "¬said_about(忙)"],
      ["没觉得累", "¬said_about(累)"],
      ["最近不咋忙", "¬said_about(忙)"],
      ["这周不用加班", "¬said_about(忙)"],
    ] as const) {
      expect({ text, facts: both(text) }).toEqual({ text, facts: [[want], [want]] });
    }
  });

  it("不是否定的照旧是肯定：\"没想到这么累\"\"忙得不可开交\"\"累得不行\"\"最近很忙，没空\"", () => {
    for (const [text, want] of [
      ["没想到这么累", "said_about(累)"],
      ["这周忙得不可开交", "said_about(忙)"],
      ["今天累得不行", "said_about(累)"],
      ["最近很忙，没空", "said_about(忙)"],
    ] as const) {
      expect({ text, facts: both(text) }).toEqual({ text, facts: [[want], [want]] });
    }
  });
});
