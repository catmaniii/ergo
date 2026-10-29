// 流程会话的步骤开始回退点（153 号票：带 report_step、状态进行中的那条 assistant 消息之前
// 是"撤回到步骤「…」开始前"）的前端状态：回放维护者会话频道上的事件（手写的，照主切面 daemon/test/main/session-rollback-workflow.test.ts
// 的形状），看
// - 步骤开始的记号（stage_start 带 stepId）挂在含这次 report_step 的那条回复上；没说话的（只有调用）挂在这次调用那一块上（汇报步骤
//   缩小后照样画）；说法是"撤回到步骤「…」开始前"，不带阶段（不是阶段框上的那一个、确认框里不说接着做）；
// - 定时、事件触发的流程：一次运行就是一段会话，上一次运行里的（用户消息、步骤开始）没有回退点。
import { describe, expect, test } from "vitest";
import { chatItems, type ConversationId, type EventFrame, type MessageEnvelope, type MessagePart, replay, type StageStartEventPayload, type UiState, zoomBlocks, zoomDecor } from "../../src/state/index.ts";
import { frame } from "./events.ts";

const M: ConversationId = "maintainer:tm-1";
const T = "2026-10-18T10:00:00+08:00";

const message = (seq: number, id: string, speaker: MessageEnvelope["speaker"], parts: MessagePart[], extra: Partial<MessageEnvelope> = {}, payload: Record<string, unknown> = {}): EventFrame =>
  frame(M, seq, "message", { message: { id, conversation: M, speaker, time: T, parts, ...extra } satisfies MessageEnvelope, taskId: "t-1", stageId: "flow", ...payload });
const text = (t: string): MessagePart => ({ type: "text", text: t });
const call = (callId: string, tool: string, argsSummary: string): MessagePart => ({
  type: "tool_call",
  callId,
  tool,
  argsSummary,
  categoryTitles: [],
  disposition: "do",
  withinGrant: true,
  genericBash: false,
  outcome: "done",
  nature: tool === "report_step" ? "look" : "act",
});
const stepMark = (seq: number, id: string, stepId: string, title: string, callId: string): EventFrame =>
  frame(M, seq, "stage_start", { id, conversation: M, taskId: "t-1", stageId: "flow", stepId, title, via: { call: callId, tool: "report_step", after: false }, time: T } satisfies StageStartEventPayload);

const pointsOf = (state: UiState, conversation: ConversationId = M) => {
  const items = chatItems(state, conversation);
  const decor = zoomDecor(state, conversation, items);
  return items.flatMap((it) => [it.id, ...zoomBlocks(it).map((b) => b.id)].flatMap((id) => (decor.rollbacks.get(id) ?? []).map((p) => `${id} ← ${p.label}`)));
};

/** s1：维护者说了一句、同一条回复里报开始（回退点在这条回复上）；s2：只报开始、没说话（回退点在汇报这一步开始的那次调用上） */
const frames: EventFrame[] = [
  message(1, "m-start", "system", [text("用户已授权计划 v1，开始执行流程 t-1「整理周报」，请按计划执行。")], {}, { agentInput: true }),
  message(2, "m-say1", "agent", [text("先写资料")], { calls: ["c-r1"] }),
  stepMark(3, "ss-1", "s1", "写资料", "c-r1"),
  message(4, "m-r1", "agent", [call("c-r1", "report_step", "stepId=s1 status=in_progress")]),
  message(5, "m-w1", "agent", [call("c-w1", "write", "path=a.md")]),
  stepMark(6, "ss-2", "s2", "写周报", "c-r2"),
  message(7, "m-r2", "agent", [call("c-r2", "report_step", "stepId=s2 status=in_progress")]),
  message(8, "m-w2", "agent", [call("c-w2", "write", "path=b.md")]),
  message(9, "m-u1", "user", [text("周报写短一点")]),
];

describe("流程步骤开始的回退点（前端）", () => {
  test("挂在含 report_step 的那条回复上；没说话的挂在那次调用上；说法是步骤的，不带阶段；用户消息照旧", () => {
    const state = replay(frames);
    const items = chatItems(state, M);
    const say1 = items.find((it) => it.seq === 2)!.id;
    const r2 = items.flatMap((it) => zoomBlocks(it)).find((b) => b.kind === "call" && b.call.part.callId === "c-r2")!.id;
    const user = items.find((it) => it.seq === 9)!.id;
    expect(pointsOf(state)).toEqual([`${say1} ← 撤回到步骤「写资料」开始前`, `${r2} ← 撤回到步骤「写周报」开始前`, `${user} ← 撤回到这条请求之前`]);
    const point = zoomDecor(state, M, items).rollbacks.get(r2)![0]!;
    expect(point.before).toEqual({ stageStart: "ss-2" });
    expect(point.stage).toBeUndefined();
  });

  test("定时、事件触发的流程：一次运行就是一段会话，上一次运行里的没有回退点", () => {
    const divider = (seq: number, runId: string, title: string) => message(seq, `m-div-${runId}`, "system", [{ type: "run_divider", jobId: "j-1", runId, title }], {}, { scheduledJobId: "j-1" });
    const state = replay([
      divider(1, "j-1-r1", "第 1 次运行"),
      message(2, "m-n1", "system", [text("第 1 次运行")], {}, { agentInput: true }),
      stepMark(3, "ss-r1", "s1", "看看工作目录", "c-r1"),
      message(4, "m-r1", "agent", [call("c-r1", "report_step", "stepId=s1 status=in_progress")]),
      message(5, "m-l1", "agent", [call("c-l1", "ls", "path=.")]),
      message(6, "m-u1", "user", [text("下次也这样")]),
      divider(7, "j-1-r2", "第 2 次运行"),
      message(8, "m-n2", "system", [text("第 2 次运行")], {}, { agentInput: true }),
      stepMark(9, "ss-r2", "s1", "看看工作目录", "c-r2"),
      message(10, "m-r2", "agent", [call("c-r2", "report_step", "stepId=s1 status=in_progress")]),
      message(11, "m-l2", "agent", [call("c-l2", "ls", "path=.")]),
    ]);
    const r2 = chatItems(state, M)
      .flatMap((it) => zoomBlocks(it))
      .find((b) => b.kind === "call" && b.call.part.callId === "c-r2")!.id;
    expect(pointsOf(state)).toEqual([`${r2} ← 撤回到步骤「看看工作目录」开始前`]);
  });
});
