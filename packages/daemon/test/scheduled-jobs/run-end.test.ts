// 一次运行的结局（19、155、176 号票）：这一轮怎么结束的、维护者报没报失败、流程还有没有步骤没做、这一轮里有没有一步没做成
// （等不到批准被拦下、交给用户亲手做）→ 成功、失败、中断、已撤回、部分完成。176 号票（用户 2026-10-19 定）：有一步没做成、
// 别的维护者做完了的是"部分完成"，不再算失败；失败的原因后面跟着被拦下的那几步。
import { JOB_RUN_ROLLED_BACK_REASON } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { type BlockedStep, runEnd } from "../../src/scheduled-jobs/run-end.ts";
import { interruptedReason, partialReason } from "../../src/scheduled-jobs/texts.ts";

const bash: BlockedStep = { kind: "approval", toolTitle: "通用 bash", argsSummary: "bash daily.sh | tail -5" };
const pay: BlockedStep = { kind: "hand_over", toolTitle: "付款" };
const completed = { outcome: "completed" as const };

describe("运行的结局", () => {
  test("这一轮正常结束、什么都没拦下：成功", () => {
    expect(runEnd({ turn: completed, blocked: [] })).toEqual({ state: "done" });
  });

  test("有一步等不到批准被拦下、别的做完了：部分完成，原因写清哪一步没做成", () => {
    expect(runEnd({ turn: completed, blocked: [bash] })).toEqual({ state: "partial", reason: "有一步没等到你的批准：「通用 bash」（bash daily.sh | tail -5）" });
  });

  test("交给用户亲手做、别的做完了：部分完成", () => {
    expect(runEnd({ turn: completed, blocked: [pay] })).toEqual({ state: "partial", reason: "有一步要你亲手做：「付款」" });
  });

  test("几步没做成的列几步", () => {
    expect(runEnd({ turn: completed, blocked: [bash, pay] })).toEqual({
      state: "partial",
      reason: "有 2 步没做成——没等到你的批准：「通用 bash」（bash daily.sh | tail -5）；要你亲手做：「付款」",
    });
  });

  test("维护者自己报了失败：失败，被拦下的那一步跟在后面", () => {
    expect(runEnd({ turn: completed, reported: "新闻源连不上", blocked: [bash] })).toEqual({
      state: "failed",
      reason: "新闻源连不上；另外有一步没等到你的批准：「通用 bash」（bash daily.sh | tail -5）",
    });
    expect(runEnd({ turn: completed, reported: "新闻源连不上", blocked: [] })).toEqual({ state: "failed", reason: "新闻源连不上" });
  });

  test("这一轮出错、被中止：失败（被拦下的跟在后面）", () => {
    expect(runEnd({ turn: { outcome: "error", error: "模型超时" }, blocked: [pay] })).toEqual({ state: "failed", reason: "维护者这一轮出错了：模型超时；另外有一步要你亲手做：「付款」" });
    expect(runEnd({ turn: { outcome: "aborted" }, blocked: [] })).toEqual({ state: "failed", reason: "这一轮被中止了" });
  });

  test("定时触发的流程还有步骤没做完也没说明跳过：照旧失败，即使别的都是被拦下的", () => {
    expect(runEnd({ turn: completed, stepsLeft: () => "还有 1 步没做：s2「发日报」", blocked: [bash] })).toEqual({
      state: "failed",
      reason: "还有 1 步没做：s2「发日报」；另外有一步没等到你的批准：「通用 bash」（bash daily.sh | tail -5）",
    });
  });

  test("报了失败的不再去算还有几步没做", () => {
    let asked = false;
    runEnd({
      turn: completed,
      reported: "做不了",
      stepsLeft: () => {
        asked = true;
        return "还有 1 步没做";
      },
      blocked: [],
    });
    expect(asked).toBe(false);
  });

  test("被打断的是中断，撤回、切换分支中止的是已撤回：都不看拦下没拦下", () => {
    expect(runEnd({ turn: { outcome: "interrupted" }, blocked: [bash] })).toEqual({ state: "interrupted", reason: interruptedReason() });
    expect(runEnd({ turn: { outcome: "aborted" }, navigating: "rollback", blocked: [bash] })).toEqual({ state: "rolled_back", reason: JOB_RUN_ROLLED_BACK_REASON.rollback });
    expect(runEnd({ turn: { outcome: "aborted" }, navigating: "switch", blocked: [] })).toEqual({ state: "rolled_back", reason: JOB_RUN_ROLLED_BACK_REASON.switch });
    // 正常结束的不看撤回
    expect(runEnd({ turn: completed, navigating: "rollback", blocked: [] })).toEqual({ state: "done" });
  });

  test("命令太长的截短成一行", () => {
    const long: BlockedStep = { kind: "approval", toolTitle: "通用 bash", argsSummary: `curl -s https://example.com/${"a".repeat(300)}\n| tail` };
    const reason = partialReason([long]);
    expect(reason.startsWith("有一步没等到你的批准：「通用 bash」（curl -s https://example.com/aaa")).toBe(true);
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThan(160);
  });
});
