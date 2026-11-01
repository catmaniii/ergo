// 阈值：预算的比值、催促的计数，以及给负责人看的说法里的数字都照阈值（不写死）。纯函数。
import { describe, expect, it } from "vitest";
import { thresholdsText } from "../../src/maintainers/system-prompt.ts";
import { defaultPromptLibrary } from "../../src/prompts/index.ts";
import { noticeText, stopReasonText } from "../../src/tasks/execution-tools.ts";
import { nextNudge } from "../../src/tasks/stall.ts";
import { budgetTokensOf, callMeterTokens } from "../../src/ledger/views.ts";
import { planFromSubmission } from "../../src/tasks/plan.ts";
import { BUDGET_SCALE_MAX, BUDGET_SCALE_MIN, budgetRatio, callScale, DEFAULT_TASK_THRESHOLDS } from "../../src/tasks/thresholds.ts";
import { samplePlan } from "../helpers/plans.ts";

describe("预算怎么算", () => {
  it("一次调用记进预算的：没命中缓存的输入 + 输出 + 命中缓存的十分之一；试验里的数字（缓存 15 万、没命中 2000、输出 500）记 17500", () => {
    expect(budgetTokensOf({ cacheHit: 150_000, cacheMiss: 2000, output: 500 })).toBe(17_500);
    // 缓存全算进去一次就是 152500，预算 4 万的阶段第一次调用就超了 2 倍；这样算还不到一半
    expect(budgetRatio({ tokens: 17_500, toolCalls: 1 }, { tokens: 40_000, toolCalls: 50 })).toBeLessThan(0.5);
  });

  it("单次计量：最近的实测平均和按最近一次的上下文估的取大的；一次都没记过时按假定的上下文估", () => {
    // 试验里 pm-1 的平均：上下文 13 万、没命中 2900、输出 720
    const trial = { cacheHit: 130_000, cacheMiss: 2900, output: 720 };
    expect(callMeterTokens([trial, trial, trial])).toBe(16_620);
    // 上下文刚涨起来：最近一次（最前面的）算出的比平均大
    expect(callMeterTokens([{ cacheHit: 200_000, cacheMiss: 0, output: 0 }, { cacheHit: 0, cacheMiss: 1000, output: 100 }])).toBe(23_000);
    expect(callMeterTokens([])).toBe(5_000);
  });

  it("校准比例：实际次数 ÷ 估的次数（合起来算），有上下限；还没有验收的阶段是 1", () => {
    expect(callScale([])).toBe(1);
    expect(callScale([{ estimated: 10, actual: 30 }])).toBe(3);
    expect(callScale([{ estimated: 10, actual: 30 }, { estimated: 30, actual: 10 }])).toBe(1);
    expect(callScale([{ estimated: 10, actual: 1000 }])).toBe(BUDGET_SCALE_MAX);
    expect(callScale([{ estimated: 100, actual: 1 }])).toBe(BUDGET_SCALE_MIN);
  });

  it("负责人交来的计划：写了 token 也不作数，存进去是 0；整个任务的粗估和大约多少钱按此刻的单次计量算", () => {
    const plan = samplePlan();
    expect(plan.stages.map((s) => s.budget.tokens)).toEqual([200_000, 120_000]);
    const stored = planFromSubmission({ ...plan, tokenEstimate: 1 }, { perCall: 1000, costPerCall: { amount: 0.01, currency: "CNY" } });
    expect(stored.stages.map((s) => s.budget)).toEqual([
      { tokens: 0, toolCalls: 60 },
      { tokens: 0, toolCalls: 40 },
    ]);
    expect(stored.tokenEstimate).toBe(100_000);
    expect(stored.costEstimate).toEqual({ amount: 1, currency: "CNY" });
    expect(planFromSubmission(plan, { perCall: 1000 }).costEstimate).toBeUndefined();
  });
});

describe("预算的比值", () => {
  it("token 和工具调用次数各算一个比值、取大的；预算里写 0 的那一项不算，两项都没给是 0", () => {
    expect(budgetRatio({ tokens: 1500, toolCalls: 3 }, { tokens: 1000, toolCalls: 10 })).toBe(1.5);
    expect(budgetRatio({ tokens: 100, toolCalls: 25 }, { tokens: 1000, toolCalls: 10 })).toBe(2.5);
    expect(budgetRatio({ tokens: 99_999, toolCalls: 5 }, { tokens: 0, toolCalls: 2 })).toBe(2.5);
    expect(budgetRatio({ tokens: 5, toolCalls: 5 }, { tokens: 0, toolCalls: 0 })).toBe(0);
  });
});

describe("催促", () => {
  it("又一次停滞：催过的次数加 1，超过上限这一支停下", () => {
    expect(nextNudge({}, 3)).toEqual({ kind: "nudge", n: 1 });
    expect(nextNudge({ nudges: 2 }, 3)).toEqual({ kind: "nudge", n: 3 });
    expect(nextNudge({ nudges: 3 }, 3)).toEqual({ kind: "stop", nudges: 3 });
  });
});

describe("说法里的数字照阈值", () => {
  it("系统提示：默认的阈值原样写进去；预算控制默认关着，不提超了预算会怎样", () => {
    expect(thresholdsText(defaultPromptLibrary(), DEFAULT_TASK_THRESHOLDS)).toBe(
      "运行时盯着偏离：被拉回（按规则退回）满 3 次后又被拉回、20 分钟没有成功的工具调用也没有阶段推进被催满 3 次还没有进展、" +
        "阶段验收退回 2 次后第 3 次还不过，这一支会停下等用户；" +
        "用户累计拒绝 5 次（审批、计划变更），整个任务会暂停。",
    );
  });

  it("打开预算控制：和之前一样说（用量超过预算说明进展，超过预算的 2 倍找用户）", () => {
    expect(thresholdsText(defaultPromptLibrary(), { ...DEFAULT_TASK_THRESHOLDS, budgetControl: true })).toBe(
      "运行时盯着偏离：被拉回（按规则退回）满 3 次后又被拉回、20 分钟没有成功的工具调用也没有阶段推进被催满 3 次还没有进展、" +
        "阶段验收退回 2 次后第 3 次还不过、用量超过预算的 2 倍，这一支会停下等用户；用量超过预算时运行时会让你说明进展（用 report_progress）。" +
        "token 按没命中缓存的输入 + 输出 + 命中缓存的十分之一算。超预算停下之后，这个阶段只放行 complete_stage 和 propose_plan_change，别的工具都被拒：活做完了就宣布完成；还要接着做就提加预算（只写 budget.toolCalls），用户确认后用量从确认时重新算，用户点“追加预算继续”也一样。这和审批卡没有关系。" +
        "用户累计拒绝 5 次（审批、计划变更），整个任务会暂停。",
    );
  });

  it("改了配置：系统提示、说明进展的通知、停下的原因跟着变", () => {
    const t = { ...DEFAULT_TASK_THRESHOLDS, pullBacks: 5, nudges: 2, stallMs: 30 * 60_000, acceptanceReturns: 1, budgetExplainTimes: 1.5, budgetAskTimes: 3, budgetControl: true, rejections: 4 };
    const text = thresholdsText(defaultPromptLibrary(), t);
    for (const part of ["满 5 次后又被拉回", "30 分钟没有成功的工具调用", "被催满 2 次", "退回 1 次后第 2 次还不过", "用量超过预算的 3 倍，这一支会停下", "用量超过预算的 1.5 倍时运行时会让你说明进展", "累计拒绝 4 次"]) {
      expect(text).toContain(part);
    }
    const spend = { used: { tokens: 1600, toolCalls: 2 }, budget: { tokens: 1000, toolCalls: 10 } };
    const explain = noticeText.budgetExplain({ stageId: "s1", title: "收集" }, spend, 3);
    expect(explain).toContain("阶段 s1「收集」的用量已经超过预算：用了 1600 token、2 次工具调用（预算 1000 token、10 次）");
    expect(explain).toContain("用量超过预算的 3 倍时运行时会让这一支停下找用户");
    expect(stopReasonText({ kind: "over_budget", ...spend, times: 3 })).toBe("用了 1600 token、2 次工具调用（预算 1000 token、10 次），超过预算的 3 倍");
    expect(stopReasonText({ kind: "pull_backs", count: 6, tool: "make_dir", ruleIds: ["r1"] })).toBe("被拉回（按规则退回）5 次后又被拉回（make_dir：r1）");
    expect(stopReasonText({ kind: "stall", minutes: 30, nudges: 2 })).toBe("30 分钟没有进展，催了 2 次仍没有进展");
    expect(stopReasonText({ kind: "acceptance", returns: 2, judged: "评审判定" })).toBe("验收退回 1 次后，第 2 次还没通过（评审判定）");
    expect(stopReasonText({ kind: "infeasible", reason: "没有资料" })).toBe("做不了：没有资料");
  });
});
