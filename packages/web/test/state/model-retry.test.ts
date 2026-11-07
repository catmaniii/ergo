// 模型出错、正在自动重试（421）的前端状态：回放会话频道上的事件（手写的事件序列，照主切面 daemon/test/main/model-retry.test.ts 的形状），
// 看聊天末尾"正在重试"那一行：
// - 这一轮里来了 model_retry 就有那一行，第几次、什么种类换成最新的那一条；
// - 重试之后回出字来（流式增量、agent 的消息）就收起；这一轮结束（成了、出错、中止）也收起；
// - 不在回复时（重连补发到的是早就结束了的那一轮）没有。
import { describe, expect, test } from "vitest";
import { type ConversationId, type EventFrame, modelRetryIn, type ModelRetryEventPayload, replay, type UiInput } from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const S: ConversationId = "secretary";

const retry = (seq: number, attempt: number, kind: ModelRetryEventPayload["kind"] = "busy"): EventFrame =>
  frame(S, seq, "model_retry", { inputMessageId: "m-1", attempt, maxAttempts: 3, kind, delayMs: 2000 * 2 ** (attempt - 1), error: "503 Service Unavailable" } satisfies ModelRetryEventPayload);

const asked: (EventFrame | UiInput)[] = [frame(S, 1, "message", { message: textMessage("m-1", "user", "问个问题"), idempotencyKey: "k-1" }), frame(S, 2, "turn_start", { inputMessageId: "m-1" })];

describe("聊天末尾\"正在重试\"那一行", () => {
  test("来一条 model_retry 就有那一行；再来一条换成第 2 次", () => {
    expect(modelRetryIn(replay(asked), S)).toBeUndefined();
    expect(modelRetryIn(replay([...asked, retry(3, 1)]), S)).toEqual({ seq: 3, inputMessageId: "m-1", attempt: 1, kind: "busy" });
    expect(modelRetryIn(replay([...asked, retry(3, 1), retry(4, 2, "timeout")]), S)).toEqual({ seq: 4, inputMessageId: "m-1", attempt: 2, kind: "timeout" });
  });

  test("重试之后回出字来（流式增量）就收起，定稿之后也没有", () => {
    const resumed = [...asked, retry(3, 1), frame(S, 3, "stream", { messageId: "m-r1", deltas: [{ part: 0, type: "text", offset: 0, text: "好了" }] })];
    expect(modelRetryIn(replay(resumed), S)).toBeUndefined();
    expect(modelRetryIn(replay([...resumed, frame(S, 4, "message", { message: textMessage("m-r1", "agent", "好了，接上了") })]), S)).toBeUndefined();
  });

  test("没有流式增量、直接来了 agent 的消息也收起；出错那次说到一半的话（在重试之前到）不算", () => {
    const partialFirst = [...asked, frame(S, 3, "message", { message: textMessage("m-r0", "agent", "说到一半") }), retry(4, 1)];
    expect(modelRetryIn(replay(partialFirst), S)?.attempt).toBe(1);
    expect(modelRetryIn(replay([...partialFirst, frame(S, 5, "message", { message: textMessage("m-r1", "agent", "接上了") })]), S)).toBeUndefined();
  });

  test("这一轮结束就收起：成了、重试用完以出错结束、被停下", () => {
    for (const outcome of ["completed", "error", "aborted"] as const) {
      const ended = [...asked, retry(3, 1), retry(4, 2), frame(S, 5, "turn_end", { inputMessageId: "m-1", outcome })];
      expect(modelRetryIn(replay(ended), S)).toBeUndefined();
    }
  });

  test("下一轮开始时不带着上一轮的", () => {
    const next = [
      ...asked,
      retry(3, 1),
      frame(S, 4, "turn_end", { inputMessageId: "m-1", outcome: "error", error: "503 Service Unavailable" }),
      frame(S, 5, "message", { message: textMessage("m-2", "user", "再问一次"), idempotencyKey: "k-2" }),
      frame(S, 6, "turn_start", { inputMessageId: "m-2" }),
    ];
    expect(modelRetryIn(replay(next), S)).toBeUndefined();
  });
});
