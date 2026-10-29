import { describe, expect, it } from "vitest";
import { idKind, USER_ENTITY_ID } from "../../src/domain/ids.ts";
import type { Claim, Evidence, Fact, Inference, Link, Probe } from "../../src/domain/types.ts";
import {
  confidenceCap,
  defaultStateValidTo,
  problemsOfClaim,
  problemsOfEvidence,
  problemsOfFact,
  problemsOfInference,
  problemsOfLink,
  problemsOfProbe,
  ValidationError,
  assertValid,
} from "../../src/domain/validate.ts";

const T = "2026-10-01T20:10:00+08:00";

function evidence(over: Partial<Evidence> = {}): Evidence {
  return { id: "ev-001", sourceLevel: "self", mode: "say", kind: "utterance", text: "周末想休息", context: ["weekend"], eventTime: T, observedAt: T, sourceRef: null, contentHash: "x", status: "active", ...over };
}

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: "fa-0001",
    subjectId: USER_ENTITY_ID,
    predicate: "prefers",
    object: { type: "entity", id: "en-0001" },
    negated: false,
    statement: "用户从 2026-10-01 起在周末喜欢休息",
    assertion: "user_stated",
    context: ["weekend"],
    evidenceIds: ["ev-001"],
    eventTime: T,
    observedAt: T,
    validFrom: T,
    validTo: null,
    status: "active",
    supersededBy: null,
    retractedBy: null,
    contestedWith: [],
    extractedBy: "rule:1",
    ...over,
  };
}

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: "cl-0001",
    tier: "preference",
    statement: "周末想留时间休息",
    kind: "hypothesis",
    epistemic: "inferred",
    method: "induction",
    status: "active",
    confidence: "medium",
    context: ["weekend"],
    validFrom: T,
    validTo: null,
    inferredAt: T,
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [],
    predicts: [],
    needsReview: false,
    ...over,
  };
}

describe("id", () => {
  it("按前缀认出是哪种对象", () => {
    expect(idKind("ev-001")).toBe("evidence");
    expect(idKind("en-user")).toBe("entity");
    expect(idKind("fa-0001")).toBe("fact");
    expect(idKind("cl-1")).toBe("claim");
    expect(idKind("in-1")).toBe("inference");
    expect(idKind("pr-1")).toBe("probe");
    expect(idKind("xx-1")).toBeUndefined();
    expect(idKind("ev-")).toBeUndefined();
  });
});

describe("证据的校验", () => {
  it("合格的没有问题", () => {
    expect(problemsOfEvidence(evidence())).toEqual([]);
    expect(problemsOfEvidence(evidence({ eventTime: null }))).toEqual([]);
  });

  it("枚举、前缀、时间不对都查得出来", () => {
    expect(problemsOfEvidence(evidence({ id: "fa-1" })).join()).toMatch(/id/);
    expect(problemsOfEvidence(evidence({ sourceLevel: "friend" as never })).join()).toMatch(/sourceLevel/);
    expect(problemsOfEvidence(evidence({ mode: "think" as never })).join()).toMatch(/mode/);
    expect(problemsOfEvidence(evidence({ kind: "rumor" as never })).join()).toMatch(/kind/);
    expect(problemsOfEvidence(evidence({ observedAt: "2026-10-01" })).join()).toMatch(/observedAt/);
    expect(problemsOfEvidence(evidence({ context: ["weekend", ""] })).join()).toMatch(/context/);
  });

  it("assertValid 抛 ValidationError，写明是哪个对象", () => {
    expect(() => assertValid("evidence", evidence({ mode: "x" as never }))).toThrow(ValidationError);
    expect(() => assertValid("evidence", evidence({ mode: "x" as never }))).toThrow(/ev-001/);
  });
});

describe("事实的校验", () => {
  it("合格的没有问题", () => {
    expect(problemsOfFact(fact())).toEqual([]);
    expect(problemsOfFact(fact({ object: { type: "value", value: "很累" }, predicate: "said_about" }))).toEqual([]);
  });

  it("至少一条证据、证据 id 带 ev- 前缀", () => {
    expect(problemsOfFact(fact({ evidenceIds: [] })).join()).toMatch(/evidenceIds/);
    expect(problemsOfFact(fact({ evidenceIds: ["fa-1"] })).join()).toMatch(/evidenceIds/);
  });

  it("有效期不能倒过来；精炼陈述不能空", () => {
    expect(problemsOfFact(fact({ validFrom: "2026-10-05T00:00:00+08:00", validTo: "2026-10-01T00:00:00+08:00" })).join()).toMatch(/validTo/);
    expect(problemsOfFact(fact({ validFrom: null, validTo: T }))).toEqual([]);
    expect(problemsOfFact(fact({ statement: " " })).join()).toMatch(/statement/);
  });

  it("状态和配套字段：取代的要有 validTo 和 supersededBy，纠正、撤回的要有 retractedBy", () => {
    expect(problemsOfFact(fact({ status: "superseded" })).join()).toMatch(/supersededBy/);
    expect(problemsOfFact(fact({ status: "superseded", supersededBy: "fa-0002", validTo: "2026-10-09T00:00:00+08:00" }))).toEqual([]);
    expect(problemsOfFact(fact({ status: "corrected" })).join()).toMatch(/retractedBy/);
    expect(problemsOfFact(fact({ status: "retracted", retractedBy: "ev-001" }))).toEqual([]);
    expect(problemsOfFact(fact({ status: "contested" })).join()).toMatch(/contestedWith/);
  });

  it("谓词、出处、主语前缀", () => {
    expect(problemsOfFact(fact({ predicate: "loves" as never })).join()).toMatch(/predicate/);
    expect(problemsOfFact(fact({ assertion: "guessed" as never })).join()).toMatch(/assertion/);
    expect(problemsOfFact(fact({ subjectId: "user" })).join()).toMatch(/subjectId/);
  });
});

describe("断言的校验（置信上限按层和证据厚薄封顶）", () => {
  it("合格的没有问题", () => {
    expect(problemsOfClaim(claim())).toEqual([]);
  });

  it("need、value 最多 medium，而且只能是假设", () => {
    expect(problemsOfClaim(claim({ tier: "value", confidence: "high" })).join()).toMatch(/confidence/);
    expect(problemsOfClaim(claim({ tier: "need", kind: "conclusion" })).join()).toMatch(/kind/);
    expect(problemsOfClaim(claim({ tier: "need", epistemic: "user_confirmed", method: "user_confirmation" }))).toEqual([]);
  });

  it("state 必须有 validTo，默认 14 天", () => {
    expect(problemsOfClaim(claim({ tier: "state" })).join()).toMatch(/validTo/);
    expect(defaultStateValidTo(T)).toBe("2026-10-15T20:10:00+08:00");
    expect(problemsOfClaim(claim({ tier: "state", validTo: defaultStateValidTo(T) }))).toEqual([]);
  });

  it("推法和认知状态要对得上", () => {
    expect(problemsOfClaim(claim({ epistemic: "explicit", method: "induction" })).join()).toMatch(/method/);
    expect(problemsOfClaim(claim({ epistemic: "explicit", method: "explicit", confidence: "high", kind: "conclusion" }))).toEqual([]);
    expect(problemsOfClaim(claim({ epistemic: "inferred", method: "explicit" })).join()).toMatch(/method/);
  });

  it("复核标记是布尔值（329 号票：待复核不再占真值状态）；needs_review 不再是断言的状态", () => {
    expect(problemsOfClaim(claim({ needsReview: true }))).toEqual([]);
    expect(problemsOfClaim(claim({ needsReview: undefined as never })).join()).toMatch(/needsReview/);
    expect(problemsOfClaim(claim({ status: "needs_review" as never })).join()).toMatch(/status/);
  });

  it("撤回、取代要有指向；竞争者是断言 id；预测的结果是枚举", () => {
    expect(problemsOfClaim(claim({ status: "retracted" })).join()).toMatch(/retractedBy/);
    expect(problemsOfClaim(claim({ status: "superseded" })).join()).toMatch(/supersededBy/);
    expect(problemsOfClaim(claim({ competesWith: ["fa-1"] })).join()).toMatch(/competesWith/);
    expect(problemsOfClaim(claim({ predicts: [{ claim: "会推掉下次周末聚会", outcome: "maybe" as never, evidenceIds: [] }] })).join()).toMatch(/predicts/);
  });

  it("置信上限：need、value 一两条证据最多 low，state、preference 明说的可以 high", () => {
    expect(confidenceCap({ tier: "value", epistemic: "inferred", supportCount: 2 })).toBe("low");
    expect(confidenceCap({ tier: "value", epistemic: "inferred", supportCount: 5 })).toBe("medium");
    expect(confidenceCap({ tier: "need", epistemic: "user_confirmed", supportCount: 1 })).toBe("low");
    expect(confidenceCap({ tier: "preference", epistemic: "explicit", supportCount: 1 })).toBe("high");
    expect(confidenceCap({ tier: "state", epistemic: "inferred", supportCount: 1 })).toBe("medium");
  });
});

describe("关联、推断、追问的校验", () => {
  it("关联：断言 id、目标是证据或事实、极性是枚举", () => {
    const link: Link = { claimId: "cl-1", target: "ev-001", polarity: "supports", rationale: "拒绝了周末聚会" };
    expect(problemsOfLink(link)).toEqual([]);
    expect(problemsOfLink({ ...link, target: "cl-2" }).join()).toMatch(/target/);
    expect(problemsOfLink({ ...link, polarity: "neutral" as never }).join()).toMatch(/polarity/);
  });

  it("推断：前提至少一条，by 写 rule: 或 model:", () => {
    const inf: Inference = { id: "in-1", conclusionClaimId: "cl-1", premiseIds: ["fa-0001", "ev-001", "cl-2"], method: "abduction", rationale: "", by: "rule:1", status: "active", createdAt: T };
    expect(problemsOfInference(inf)).toEqual([]);
    expect(problemsOfInference({ ...inf, premiseIds: [] }).join()).toMatch(/premiseIds/);
    expect(problemsOfInference({ ...inf, premiseIds: ["en-1"] }).join()).toMatch(/premiseIds/);
    expect(problemsOfInference({ ...inf, by: "deepseek" }).join()).toMatch(/by/);
  });

  it("追问：至少区分两条，找到时指向其中一条", () => {
    const probe: Probe = { id: "pr-1", discriminates: ["cl-1", "cl-2"], ask: "周末主动约过朋友吗？", queries: ["约朋友"], ifFound: "cl-2", outcome: "open", foundEvidenceIds: [], createdAt: T };
    expect(problemsOfProbe(probe)).toEqual([]);
    expect(problemsOfProbe({ ...probe, discriminates: ["fa-1", "fa-2"], ifFound: null })).toEqual([]);
    expect(problemsOfProbe({ ...probe, discriminates: ["cl-1"] }).join()).toMatch(/discriminates/);
    expect(problemsOfProbe({ ...probe, ifFound: "cl-9" }).join()).toMatch(/ifFound/);
    expect(problemsOfProbe({ ...probe, foundEvidenceIds: ["fa-1"] }).join()).toMatch(/foundEvidenceIds/);
  });
});
