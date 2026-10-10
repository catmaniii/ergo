// 阈值（14 号票）：预算的比值、催促的计数，以及给维护者看的说法里的数字都照阈值（不写死）。纯函数。
import { describe, expect, it } from "vitest";
import { thresholdsText } from "../../src/maintainers/system-prompt.ts";
import { defaultPromptLibrary } from "../../src/prompts/index.ts";
import { noticeText, stopReasonText } from "../../src/tasks/execution-tools.ts";
import { nextNudge } from "../../src/tasks/stall.ts";
import { budgetRatio, DEFAULT_TASK_THRESHOLDS } from "../../src/tasks/thresholds.ts";

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
  it("系统提示：默认的阈值和规格的口径一致（用量超过预算说明进展，超过预算的 2 倍找用户）", () => {
    expect(thresholdsText(defaultPromptLibrary(), DEFAULT_TASK_THRESHOLDS)).toBe(
      "运行时盯着偏离：被拉回（按规则退回）满 3 次后又被拉回、20 分钟没有成功的工具调用也没有阶段推进被催满 3 次还没有进展、" +
        "阶段验收退回 2 次后第 3 次还不过、用量超过预算的 2 倍，这一支会停下等用户；用量超过预算时运行时会让你说明进展（用 report_progress）。" +
        "用户累计拒绝 5 次（审批、计划变更），整个任务会暂停。",
    );
  });

  it("改了配置：系统提示、说明进展的通知、停下的原因跟着变", () => {
    const t = { ...DEFAULT_TASK_THRESHOLDS, pullBacks: 5, nudges: 2, stallMs: 30 * 60_000, acceptanceReturns: 1, budgetExplainTimes: 1.5, budgetAskTimes: 3, rejections: 4 };
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
