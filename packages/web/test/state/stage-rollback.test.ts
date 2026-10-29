// 长程任务维护者会话的回退点（152 号票）的前端状态：回放维护者会话频道上的事件（手写的，照主切面
// daemon/test/main/session-rollback-tasks.test.ts 的形状），看
// - 用户消息、分支摘要的回退点照旧（150 号票），维护者的会话也有；
// - 阶段开始的回退点挂在守护进程截的那一处：通知交代的挂在那条通知上；在"宣布阶段完成"那次调用里开始的挂在那次调用之后的第一块上
//   （顺利执行的内部工具不画，跳过）；"开始阶段"那次挂在那条回复上；回退点的说法是"撤回到阶段「…」开始前"；
// - 往上翻取回的一页里的记号照样并进来；不在当前分支上的记号没有回退点；
// - 撤回之后交给维护者接着做的那句（分支摘要上记着它）不显示；
// - 项目维护者的会话最新那一段结束了就没有回退点。
import { describe, expect, test } from "vitest";
import {
  chatItems,
  type ConversationBranches,
  type ConversationId,
  type EventFrame,
  type MessageEnvelope,
  type MessagePart,
  replay,
  type SessionBranchEventPayload,
  type StageStartEventPayload,
  type UiState,
  zoomBlocks,
  zoomDecor,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const M: ConversationId = "maintainer:tm-1";
const T = "2026-10-18T10:00:00+08:00";

const message = (seq: number, id: string, speaker: MessageEnvelope["speaker"], parts: MessagePart[], extra: Partial<MessageEnvelope> = {}, payload: Record<string, unknown> = {}): EventFrame =>
  frame(M, seq, "message", { message: { id, conversation: M, speaker, time: T, parts, ...extra } satisfies MessageEnvelope, taskId: "t-1", ...payload });
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
  nature: "act",
});
const mark = (seq: number, id: string, stageId: string, title: string, via: StageStartEventPayload["via"]): EventFrame =>
  frame(M, seq, "stage_start", { id, conversation: M, taskId: "t-1", stageId, title, code: stageId.slice(1), via, time: T } satisfies StageStartEventPayload);

/** s1 是"开始执行"那条通知交代的；s2 在"宣布阶段完成"那次调用里开始；s3 是维护者自己"开始阶段"换过去的 */
const frames: EventFrame[] = [
  message(1, "m-start", "system", [text("计划已确认，开始执行任务 t-1「X 的调研」。")], {}, { agentInput: true, stageId: "s1" }),
  mark(2, "ss-1", "s1", "收集资料", { notice: "m-start" }),
  message(3, "m-w1", "agent", [call("c-w1", "write", "path=sources.md")], {}, { stageId: "s1" }),
  message(4, "m-say1", "agent", [text("资料清单写好了")], { calls: ["c-cs1"] }, { stageId: "s1" }),
  mark(5, "ss-2", "s2", "写报告", { call: "c-cs1", tool: "complete_stage", after: true }),
  message(6, "m-cs1", "agent", [call("c-cs1", "complete_stage", "stageId=s1")], {}, { stageId: "s1" }),
  message(7, "m-w2", "agent", [call("c-w2", "write", "path=report.md")], {}, { stageId: "s2" }),
  message(8, "m-say2", "agent", [text("先换去做 s3")], { calls: ["c-ss3"] }, { stageId: "s2" }),
  mark(9, "ss-3", "s3", "发出去", { call: "c-ss3", tool: "start_stage", after: false }),
  message(10, "m-ss3", "agent", [call("c-ss3", "start_stage", "stageId=s3")], {}, { stageId: "s2" }),
  message(11, "m-u1", "user", [text("s3 先别发")], {}, { stageId: "s3" }),
];

const pointsOf = (state: UiState, conversation: ConversationId = M) => {
  const items = chatItems(state, conversation);
  const decor = zoomDecor(state, conversation, items);
  return items.flatMap((it) => [it.id, ...zoomBlocks(it).map((b) => b.id)].flatMap((id) => (decor.rollbacks.get(id) ?? []).map((p) => `${id} ← ${p.label}`)));
};

describe("阶段开始的回退点（前端）", () => {
  test("通知交代的挂在通知上；在调用里开始的挂在那次调用之后的第一块上；开始阶段那次挂在那条回复上；用户消息照旧", () => {
    const state = replay(frames);
    const items = chatItems(state, M);
    const start = items.find((it) => it.seq === 1)!.id;
    const w2 = items.flatMap((it) => zoomBlocks(it)).find((b) => b.kind === "call" && b.call.part.callId === "c-w2")!.id;
    const say2 = items.find((it) => it.seq === 8)!.id;
    const user = items.find((it) => it.seq === 11)!.id;
    expect(pointsOf(state)).toEqual([
      `${start} ← 撤回到阶段「收集资料」开始前`,
      `${w2} ← 撤回到阶段「写报告」开始前`,
      `${say2} ← 撤回到阶段「发出去」开始前`,
      `${user} ← 撤回到这条请求之前`,
    ]);
    const decor = zoomDecor(state, M, items);
    expect(decor.rollbacks.get(w2)![0]).toMatchObject({ before: { stageStart: "ss-2" }, stage: { taskId: "t-1", stageId: "s2" } });
  });

  test("往上翻取回的一页里的记号照样并进来", () => {
    const state = replay([
      ...frames.slice(6),
      {
        kind: "history_page",
        conversation: M,
        page: {
          conversation: M,
          messages: frames.slice(0, 6).flatMap((f) => (f.type === "message" ? [{ seq: f.seq, ...(f.payload as { message: MessageEnvelope; taskId: string }) }] : [])),
          records: [],
          hasMore: false,
          stageStarts: frames.slice(0, 6).flatMap((f) => (f.type === "stage_start" ? [{ seq: f.seq, payload: f.payload as StageStartEventPayload }] : [])),
        },
      },
    ]);
    expect(pointsOf(state).filter((p) => p.includes("阶段"))).toHaveLength(3);
  });

  test("撤回之后：废弃分支上的记号没有回退点；交给维护者接着做的那句不显示，重新开始的阶段有新的回退点", () => {
    const tree: ConversationBranches = {
      current: "b1",
      branches: [
        { id: "b0", start: 0, tip: "e-9" },
        { id: "b1", parent: "b0", cutoff: 7, start: 12, summary: { messageId: "m-sum", text: "摘要" }, entry: "e-6" },
      ],
      epochs: [
        { from: 0, branch: "b0" },
        { from: 12, branch: "b1" },
      ],
    };
    const state = replay([
      ...frames,
      frame(M, 12, "session_branch", { change: "rollback", branches: tree, from: "b0", to: "b1", before: { stageStart: "ss-2" }, by: "user", time: T } satisfies SessionBranchEventPayload),
      message(13, "m-sum", "system", [{ type: "branch_summary", branchId: "b1", summary: "摘要", notice: "m-again" }]),
      message(14, "m-again", "system", [text("用户撤回到阶段 s2「写报告」开始前：……从这一阶段重新开始。")], {}, { agentInput: true, stageId: "s2" }),
      mark(15, "ss-2b", "s2", "写报告", { notice: "m-again" }),
      message(16, "m-w3", "agent", [call("c-w3", "write", "path=report.md")], {}, { stageId: "s2" }),
    ]);
    const items = chatItems(state, M);
    // 接着做的那句不显示（分支摘要说清楚了）
    expect(items.some((it) => it.seq === 14)).toBe(false);
    const labels = pointsOf(state);
    expect(labels.filter((p) => p.includes("撤回到阶段「发出去」"))).toEqual([]);
    expect(labels.filter((p) => p.includes("撤回到阶段「写报告」"))).toHaveLength(1);
    // 重新开始的 s2：通知不显示，回退点挂在它之后的第一块（分支摘要之后那次写报告）
    const w3 = items.flatMap((it) => zoomBlocks(it)).find((b) => b.kind === "call" && b.call.part.callId === "c-w3")!.id;
    expect(labels).toContain(`${w3} ← 撤回到阶段「写报告」开始前`);
    expect(labels.some((p) => p.includes("撤回到这条分支开始前"))).toBe(true);
  });

  test("项目维护者的会话：最新那一段结束了就没有回退点", () => {
    const P: ConversationId = "maintainer:pm-1";
    const seg = (seq: number, state: "open" | "closed") =>
      frame(P, seq, "segment", {
        segment: { segmentId: "pm-1-s1", maintainerId: "pm-1", projectId: "p-1", kind: "chat", session: "pm-1-s1", reset: false, state, progressHash: "h", openedAt: T },
        change: state === "open" ? "opened" : "closed",
      });
    const say = (seq: number, id: string) => frame(P, seq, "message", { message: { id, conversation: P, speaker: "user", time: T, parts: [{ type: "text", text: "说一句" }] } satisfies MessageEnvelope });
    const divider = frame(P, 2, "message", { message: { id: "m-div", conversation: P, speaker: "system", time: T, parts: [{ type: "work_order_divider", title: "和你聊天" }] } as unknown as MessageEnvelope });
    const open = replay([seg(1, "open"), divider, say(3, "m-p1")]);
    expect(pointsOf(open, P)).toEqual([`${chatItems(open, P).find((it) => it.seq === 3)!.id} ← 撤回到这条请求之前`]);
    const closed = replay([seg(1, "open"), divider, say(3, "m-p1"), seg(4, "closed")]);
    expect(pointsOf(closed, P)).toEqual([]);
  });
});
