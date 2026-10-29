// 状态和置信度的规矩（rg/scoring.ts）：决定性反证撤回；领先 6 分贝以上、有判别性支持才成立；只剩一条的是正的就成立；置信上限。
import { describe, expect, it } from "vitest";
import { confidenceOf, decideGroup, LEAD_DB, upgrade, type Tally } from "../../src/rg/scoring.ts";

const t = (claimId: string, over: Partial<Tally> = {}): Tally => ({
  claimId,
  support: 0,
  refute: 0,
  net: 0,
  supportTargets: [],
  refuteTargets: [],
  decisiveRefute: undefined,
  decisiveSupport: false,
  supportEvidenceIds: [],
  periods: 1,
  contexts: 1,
  ...over,
});

describe("decideGroup", () => {
  it("决定性反证（又没有决定性支持）→ 撤回，墓碑指向那条反证", () => {
    const d = decideGroup([
      t("cl-1", { net: 3, decisiveRefute: { claimId: "cl-1", target: "fa-9", polarity: "refutes", weight: "decisive", rationale: "用户明说不反感" } }),
      t("cl-2", { net: 9, supportTargets: ["fa-1", "fa-2"] }),
      t("cl-3", { net: 6, supportTargets: ["fa-1"] }),
    ]);
    expect(d.get("cl-1")).toMatchObject({ status: "retracted", retractedBy: "fa-9" });
    expect(d.get("cl-2")!.status).toBe("contested");
  });

  it(`领先第二名 ${LEAD_DB} 分贝以上、有别人没有的支持 → 成立，其余还活着（contested）`, () => {
    const d = decideGroup([
      t("cl-1", { net: 15, supportTargets: ["fa-1", "fa-6"], supportDb: { "fa-1": 3, "fa-6": 6 } }),
      t("cl-2", { net: 9, supportTargets: ["fa-1"], supportDb: { "fa-1": 3 } }),
      t("cl-3", { net: 0, supportTargets: ["fa-1"], supportDb: { "fa-1": 3 } }),
    ]);
    expect(d.get("cl-1")!.status).toBe("active");
    expect(d.get("cl-2")!.status).toBe("contested");
    expect(d.get("cl-3")!.status).toBe("contested");
  });

  it("领先够了，但独有的支持只是弱的旁证 → 分不出来", () => {
    const d = decideGroup([t("cl-1", { net: 12, supportTargets: ["fa-1", "fa-2"], supportDb: { "fa-1": 3, "fa-2": 3 } }), t("cl-2", { net: 3, supportTargets: ["fa-1"], supportDb: { "fa-1": 3 } })]);
    expect([...d.values()].map((x) => x.status)).toEqual(["contested", "contested"]);
  });

  it("领先够了但支持都是共有的（没有判别性证据）→ 分不出来", () => {
    const d = decideGroup([t("cl-1", { net: 12, supportTargets: ["fa-1"] }), t("cl-2", { net: 3, supportTargets: ["fa-1"] })]);
    expect([...d.values()].map((x) => x.status)).toEqual(["contested", "contested"]);
  });

  it("分不出来的理由说清真正的原因：领先够了只是缺判别性支持时不写成\"不到 6\"", () => {
    // 领先 15 分贝，但独有的支持只是弱的旁证
    const weakOnly = decideGroup([t("cl-1", { net: 18, supportTargets: ["fa-1", "fa-2"], supportDb: { "fa-1": 3, "fa-2": 3 } }), t("cl-2", { net: 3, supportTargets: ["fa-1"], supportDb: { "fa-1": 3 } })]);
    for (const d of weakOnly.values()) {
      expect(d.reason).toContain("领先 15 分贝");
      expect(d.reason).toContain("没有别的假设没有的强支持");
      expect(d.reason).not.toContain(`不到 ${LEAD_DB}`);
    }
    // 领先不够：照旧说"不到 6"
    const close = decideGroup([t("cl-1", { net: 9, supportTargets: ["fa-6"], supportDb: { "fa-6": 6 } }), t("cl-2", { net: 6, supportTargets: ["fa-1"], supportDb: { "fa-1": 3 } })]);
    expect(close.get("cl-1")!.reason).toContain(`领先 3 分贝，不到 ${LEAD_DB}`);
    expect(close.get("cl-1")!.reason).not.toContain("强支持");
    // 领先的那条反证不比支持少：说这个，不说"不到 6"
    const negative = decideGroup([t("cl-1", { net: 0, supportTargets: ["fa-6"], supportDb: { "fa-6": 6 } }), t("cl-2", { net: -9, supportTargets: ["fa-1"], supportDb: { "fa-1": 3 } })]);
    expect(negative.get("cl-1")!.status).toBe("contested");
    expect(negative.get("cl-1")!.reason).toContain("反证不比支持少");
    expect(negative.get("cl-1")!.reason).not.toContain(`不到 ${LEAD_DB}`);
  });

  it("只剩一条：是正的就成立，不是就 contested；搜不到的东西不扣分", () => {
    const retract = { claimId: "cl-1", target: "fa-9", polarity: "refutes" as const, weight: "decisive" as const, rationale: "" };
    expect(decideGroup([t("cl-1", { decisiveRefute: retract }), t("cl-2", { net: 3 })]).get("cl-2")!.status).toBe("active");
    expect(decideGroup([t("cl-1", { decisiveRefute: retract }), t("cl-2", { net: 0 })]).get("cl-2")!.status).toBe("contested");
  });
});

describe("confidenceOf", () => {
  it("推断的偏好最多 medium；need 证据少、不跨时期和场景最多 low", () => {
    const strong = t("cl-1", { net: 20, supportEvidenceIds: ["ev-1", "ev-2", "ev-3"], periods: 1, contexts: 1 });
    expect(confidenceOf({ tier: "preference", epistemic: "inferred" }, strong)).toBe("medium");
    expect(confidenceOf({ tier: "need", epistemic: "inferred" }, strong)).toBe("low");
    expect(confidenceOf({ tier: "need", epistemic: "inferred" }, { ...strong, periods: 2, contexts: 2 })).toBe("medium");
    expect(confidenceOf({ tier: "preference", epistemic: "inferred" }, t("cl-1", { net: 3, supportEvidenceIds: ["ev-1"] }))).toBe("low");
  });

  it("纠正的多重升一档", () => {
    expect(upgrade("weak")).toBe("strong");
    expect(upgrade("strong")).toBe("decisive");
    expect(upgrade("decisive")).toBe("decisive");
  });
});
