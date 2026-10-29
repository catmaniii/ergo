// 前端状态层回放 58 号票（流程：起草、审查修补、一次授权、按步骤执行）主切面录下的事件流：
// - workflow（workflow.test.ts）：维护者交出两步的计划（写笔记、读一遍，条件"先写再读"），流程计划卡进待我处理；
//   授权后排队、开始执行，维护者用 report_step 自报每一步，两步都做完时流程完成。
// 重新录：ERGO_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/workflow.test.ts -t 录给前端回放
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  cardDisplay,
  inboxEntries,
  replay,
  taskKind,
  type UiInput,
  type UiState,
  workflowAuthFigures,
  workflowConfirmationItems,
  type WorkflowPlanCardPayload,
  workflowReviewFigures,
  workflowStepProgress,
} from "../../src/state/index.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const flowCards = (state: UiState) => Object.values(state.cards).filter((c) => c.card.type === "workflow_plan");

describe("回放：流程（workflow）", () => {
  const inputs = load("workflow");
  const final = replay(inputs);

  test("流程计划卡：这个页面认识这种卡（按类型显示，不降级）；授权之后是已处理（授权执行）", () => {
    const cards = flowCards(final);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(cardDisplay(final, card.card.id)).toMatchObject({ kind: "typed", type: "workflow_plan" });
    expect([card.card.status, card.card.outcome?.action]).toEqual(["handled", "confirm"]);
  });

  test("卡上：审查四步的数字、每一步的工具、参数和条件（写成人话，连同审查时查出的结果）；没有要你逐项确认的", () => {
    const p = flowCards(final)[0]!.card.payload as WorkflowPlanCardPayload;
    expect(workflowReviewFigures(p.plan.review)).toMatchObject({ repairs: [], fixed: 0, left: 0, asks: [] });
    expect(workflowConfirmationItems(p.plan.review)).toEqual([]);
    expect(p.plan.review.deferred).toHaveLength(1);
    // 逐条规则的复测：框架的 6 条、计划里写的 1 条，各自查出几处违反、几处判不了
    expect(p.plan.review.rules).toHaveLength(7);
    expect(p.plan.review.rules.filter((r) => r.source === "plan").map((r) => [r.id, r.title, r.violated, r.unknown])).toEqual([["write-before-read", "先写再读", 0, 0]]);
    expect(p.plan.review.rules.reduce((n, r) => n + r.unknown, 0)).toBe(1);
    expect(p.plan.review.phases).toMatchObject({ facts: 0 });
    expect(p.plan.steps.map((s) => [s.id, s.title, s.tool, s.after])).toEqual([
      ["s1", "写笔记", "write", []],
      ["s2", "读一遍笔记", "read", ["s1"]],
    ]);
    expect(p.plan.steps[1]!.conditions).toEqual([{ ruleId: "write-before-read", title: "先写再读", text: "read 之前必须已经成功做过 write；违反时退回，先补上再做", source: "plan", status: "pass" }]);
    expect(p.plan.steps[0]!.conditions[0]).toMatchObject({ source: "template", status: "unknown" });
    expect(workflowAuthFigures(p.plan)).toEqual({ sensitive: 0, stops: 0 });
  });

  test("卡出来时在待我处理里（待处理）；授权之后移到已处理", () => {
    const at = inputs.findIndex((i) => i.kind === "frame" && i.frame.type === "inbox_item");
    const pending = replay(inputs.slice(0, at + 1));
    const cardId = flowCards(final)[0]!.card.id;
    const isCard = (e: { item: { kind: string; cardId?: string } }) => e.item.kind === "card" && e.item.cardId === cardId;
    expect(inboxEntries(pending, "open").some(isCard)).toBe(true);
    expect(inboxEntries(final, "done").some(isCard)).toBe(true);
  });

  test("看板上的流程：种类是流程；执行时各步的状态跟着 report_step 变，两步都做完时流程完成", () => {
    const task = final.tasks["t-1"]!;
    expect(taskKind(task)).toBe("workflow");
    expect(task.state).toBe("done");
    expect(task.steps).toMatchObject({ total: 2, done: 2 });
    expect(workflowStepProgress(task)).toEqual({
      s1: { stepId: "s1", title: "写笔记", state: "done", gist: "笔记写在 notes.md" },
      s2: { stepId: "s2", title: "读一遍笔记", state: "done", gist: "读过了，一条" },
    });
    // 执行到一半：第一步做完、第二步在做
    const halfway = inputs.findIndex((i) => i.kind === "frame" && i.frame.type === "task" && (i.frame.payload as { task: { steps?: { list?: { state: string }[] } } }).task.steps?.list?.[1]?.state === "in_progress");
    expect(halfway).toBeGreaterThan(0);
    const mid = replay(inputs.slice(0, halfway + 1)).tasks["t-1"]!;
    expect(mid.state).toBe("running");
    expect(mid.steps?.list?.map((s) => s.state)).toEqual(["done", "in_progress"]);
  });
});
