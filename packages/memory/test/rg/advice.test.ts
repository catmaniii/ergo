// 196 号票：给任务出建议——按权威排：这次明说的要求 > 硬约束 > 明确的偏好 > 相关的需求和价值观 > 能用的策略。
import { afterEach, describe, expect, it } from "vitest";
import { splitRequirements } from "../../src/rg/advice.ts";
import { closeEngines, say } from "./helpers.ts";
import { member, NEED, NOW, statedOf, storyEngine, VALUE, WEEKEND_GROUP } from "./task-helpers.ts";

afterEach(closeEngines);

async function confirmedStory() {
  const t = await storyEngine();
  const s = t.engine.compileStrategies().strategies.find((x) => x.key === "protect_autonomy|autonomy");
  t.engine.ingestEvidence(say("ev-ok", "对，以后周末别给我排满", NOW));
  t.engine.confirmStrategy(s!.id, "ev-ok");
  return { ...t, strategyId: s!.id };
}

describe("给任务出建议：按权威排好", () => {
  it("'帮我安排下周六'：① 原样回显 ② 忌口 ③ 你说过的 ④ 推断的需求、价值观（带置信度）和猜测 ⑤ 待你确认的策略，附一个能区分的追问", async () => {
    const { engine } = await storyEngine();
    const advice = await engine.adviseTask("帮我安排下周六");
    expect(advice.explicit).toEqual({ requirements: ["帮我安排下周六"], note: expect.stringContaining("都不能推翻它") });
    expect(advice.hardConstraints.map((h) => h.claimId)).toEqual([statedOf(engine, "ev-a1", "dislikes").id]);
    expect(advice.preferences.map((p) => p.claimId)).toEqual([statedOf(engine, "ev-w3", "dislikes").id]);
    const need = member(engine, NEED, "need_autonomy");
    const value = member(engine, VALUE, "value_enduring");
    expect(advice.motives.map((m) => m.claimId)).toEqual([member(engine, WEEKEND_GROUP, "scene_autonomy").id, need.id, value.id]);
    expect(advice.motives.find((m) => m.claimId === need.id)).toMatchObject({ label: "inferred", confidence: "medium", overriddenBy: null });
    // 猜测单列（330 号票 R5：标明是猜测，可以参考、推荐），不在 ④ 的已验证那几条里
    expect(advice.uncertain.find((u) => u.claimId === member(engine, NEED, "no_interest").id)).toMatchObject({ guess: true });
    expect(advice.motives.map((m) => m.claimId)).not.toContain(member(engine, NEED, "no_interest").id);
    // 还没确认的策略标"待你确认"；330 号票（R6）：建在猜测上的也出，标出来
    expect(advice.strategies).toEqual([
      expect.objectContaining({ status: "proposed", use: "confirm_first", when: "安排周末、工作日的活动时", onGuess: false, basisGone: false }),
      expect.objectContaining({ status: "proposed", use: "confirm_first", when: "安排日程、接新事情时", onGuess: true, basisGone: false }),
    ]);
    // 拿不准时问一句：用那组现成的判别性追问
    expect(advice.question).toMatchObject({ probeId: expect.stringMatching(/^pr-/) });
    expect(advice.question!.about).toContain(member(engine, NEED, "no_interest").id);
    // 拼好的一段按 ①–⑤ 的顺序
    const order = ["①", "②", "③", "④", "⑤", "想先问一句"].map((m) => advice.text.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(advice.text).toContain("「帮我安排下周六」");
    expect(advice.text).toContain("待你确认——安排周末、工作日的活动时：留出空白，不要排满；替用户约人、定时间之前先问他");
    expect(advice.text).toMatch(/用户重视自主安排.*需求，推断的，置信度 medium/);
    expect(advice.text).toMatch(/猜测（可以参考、推荐，说清是猜测，把握低的留余地）：.*（需求，猜测，把握 /);
    expect(advice.text).toContain("要加新事情时先问能不能推掉或挪后（建在猜测上）");
  });

  it("确认过的策略直接用；快照里也有", async () => {
    const { engine, strategyId } = await confirmedStory();
    const advice = await engine.adviseTask("帮我安排下周六");
    expect(advice.strategies).toEqual([expect.objectContaining({ strategyId, status: "active", use: "apply" }), expect.objectContaining({ status: "proposed", use: "confirm_first", onGuess: true })]);
    expect(advice.text).toContain("直接用——安排周末、工作日的活动时");
  });

  it("和任务对不上的策略不出：买月卡（消费、出行）用不上'安排时间'的策略；硬约束照样列出", async () => {
    const { engine } = await confirmedStory();
    const advice = await engine.adviseTask("帮我买个地铁月卡");
    expect(advice.domains).toEqual(["spending", "travel"]);
    expect(advice.strategies).toEqual([]);
    expect(advice.hardConstraints).toHaveLength(1);
  });
});

describe("价值观推翻不了明说的要求", () => {
  it("'下周六帮我排满，从早到晚都安排上'：要求排第一，'留出空白，不要排满'这次不用，依据的需求、价值和明说的'不喜欢被排满'都标'以你说的为准'", async () => {
    const { engine, strategyId } = await confirmedStory();
    const task = "下周六帮我排满，从早到晚都安排上";
    const advice = await engine.adviseTask(task);
    expect(advice.explicit.requirements).toEqual(["下周六帮我排满", "从早到晚都安排上"]);
    const s = advice.strategies.find((x) => x.strategyId === strategyId)!;
    expect(s.actions).toEqual([
      { text: "留出空白，不要排满", overriddenBy: "下周六帮我排满" },
      { text: "替用户约人、定时间之前先问他", overriddenBy: null },
    ]);
    const need = member(engine, NEED, "need_autonomy");
    const value = member(engine, VALUE, "value_enduring");
    expect(advice.motives.find((m) => m.claimId === need.id)!.overriddenBy).toBe("下周六帮我排满");
    expect(advice.motives.find((m) => m.claimId === value.id)!.overriddenBy).toBe("下周六帮我排满");
    // 推出需求的下层断言（推断的"重视周末的自主安排"）也一样
    expect(advice.motives.find((m) => m.claimId === member(engine, WEEKEND_GROUP, "scene_autonomy").id)!.overriddenBy).toBe("下周六帮我排满");
    expect(advice.preferences.find((p) => p.claimId === statedOf(engine, "ev-w3", "dislikes").id)!.overriddenBy).toBe("下周六帮我排满");
    // 拼好的一段：明说的要求在最前面，策略那一条写明这次不用
    expect(advice.text.indexOf("「下周六帮我排满」")).toBeLessThan(advice.text.indexOf("②"));
    expect(advice.text).toContain("「留出空白，不要排满」这次不用（你明说了「下周六帮我排满」）");
    expect(advice.text).toContain("以你说的为准");
  });

  it("说'别排满'是同意，不算冲突", async () => {
    const { engine } = await confirmedStory();
    const advice = await engine.adviseTask("下周六别排满，留点空");
    expect(advice.strategies[0]!.actions.every((a) => a.overriddenBy === null)).toBe(true);
    expect(advice.motives.every((m) => m.overriddenBy === null)).toBe(true);
    expect(advice.text).not.toContain("这次不用");
  });

  it("明说'帮我约好'：约人之前先问这一条这次不用（已经说了）", async () => {
    const { engine } = await confirmedStory();
    const advice = await engine.adviseTask("周六帮我约老同学吃饭");
    expect(advice.strategies[0]!.actions[1]).toEqual({ text: "替用户约人、定时间之前先问他", overriddenBy: "周六帮我约老同学吃饭" });
  });

  it("结构化给的要求照原样回显", async () => {
    const { engine } = await storyEngine();
    const advice = await engine.adviseTask("安排周六", { requirements: ["上午九点前不要安排"] });
    expect(advice.explicit.requirements).toEqual(["上午九点前不要安排"]);
    expect(advice.text).toContain("「上午九点前不要安排」");
  });
});

describe("硬约束", () => {
  it("用户明说的禁忌（原话带'过敏'）是硬约束；没有这类说法的'不喜欢'不是", async () => {
    const { engine } = await storyEngine();
    const advice = await engine.adviseTask("周日中午帮我订个餐厅");
    expect(advice.hardConstraints).toEqual([expect.objectContaining({ statement: "用户不喜欢香菜", evidenceIds: ["ev-a1"], overriddenBy: null })]);
    expect(advice.hardConstraints.map((h) => h.claimId)).not.toContain(statedOf(engine, "ev-w3", "dislikes").id);
    expect(advice.preferences.map((p) => p.claimId)).not.toContain(statedOf(engine, "ev-a1", "dislikes").id);
  });

  it("明说的要求和禁忌冲突：照要求排第一，但禁忌那条标出来，追问先确认", async () => {
    const { engine } = await storyEngine();
    const advice = await engine.adviseTask("订个餐厅，菜里多放香菜也行");
    expect(advice.hardConstraints[0]!.overriddenBy).toBe("菜里多放香菜也行");
    expect(advice.question).toEqual({ ask: "你说过不喜欢香菜，这次「菜里多放香菜也行」，确定吗？", probeId: null, about: [statedOf(engine, "ev-a1", "dislikes").id] });
    expect(advice.text).toContain("和这次的「菜里多放香菜也行」冲突，先确认");
  });
});

describe("小工具", () => {
  it("任务按标点切成几段要求", () => {
    expect(splitRequirements("帮我安排下周六，上午别排满；下午可以见朋友。")).toEqual(["帮我安排下周六", "上午别排满", "下午可以见朋友"]);
  });
});
