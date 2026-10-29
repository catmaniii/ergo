// 330 号票（R5）：猜测怎么用——快照、解释里猜测标明是猜测；标着复核的照真值状态给、标出来；猜测写明"为什么还是猜测"。
// 例子是 196 号票测试的那个人（task-helpers 的 storyEngine，自己写的，不看 fixtures/truth）。
import { afterEach, describe, expect, it } from "vitest";
import { renderExplanation } from "../../src/rg/explain.ts";
import { closeEngines } from "./helpers.ts";
import { member, NEED, storyEngine, VALUE } from "./task-helpers.ts";

afterEach(closeEngines);

describe("快照：猜测照样给，标明是猜测", () => {
  it("没分出来的猜测在 uncertain 里，带真值状态、把握、谁说的；已验证的不标复核", async () => {
    const { engine } = await storyEngine();
    const phase = member(engine, VALUE, "value_phase");
    expect(phase.status).toBe("contested");
    const model = engine.getUserModel({});
    expect(model.uncertain.find((u) => u.claimId === phase.id)).toMatchObject({ status: "contested", confidence: phase.confidence, label: "inferred" });
    const need = member(engine, NEED, "need_autonomy");
    const entry = model.values.find((v) => v.claimId === need.id);
    expect(entry).toBeDefined();
    expect(entry!.needsReview).toBeUndefined();
  });

  it("依据刚变（工作日那句话被忘掉）：需求成了猜测、标着复核——照样在快照里（329 起不再整条拿掉），标 needsReview", async () => {
    const { engine } = await storyEngine();
    engine.invalidateEvidence("ev-d3", "用户说忘掉");
    const need = engine.store.getClaim(member(engine, NEED, "need_autonomy").id)!;
    expect(need).toMatchObject({ status: "contested", needsReview: true });
    const model = engine.getUserModel({});
    expect(model.uncertain.find((u) => u.claimId === need.id)).toMatchObject({ status: "contested", needsReview: true });
  });
});

describe("解释：猜测写明为什么还是猜测", () => {
  it("没分出来的猜测：写证据哪里不够；已验证的没有这一段", async () => {
    const { engine } = await storyEngine();
    const phase = member(engine, VALUE, "value_phase");
    const x = engine.explainClaim(phase.id);
    expect(x.whyGuess).not.toBeNull();
    expect(renderExplanation(x)).toContain("为什么还是猜测：");
    const need = member(engine, NEED, "need_autonomy");
    expect(engine.explainClaim(need.id).whyGuess).toBeNull();
    expect(renderExplanation(engine.explainClaim(need.id))).not.toContain("为什么还是猜测");
  });
});
