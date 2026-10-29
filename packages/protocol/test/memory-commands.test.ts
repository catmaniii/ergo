// 337 号票：显式记忆命令的负载（`MemoryCommandEventPayload`）多了"从秘书那里来、没有卡片"的来源。
// 这一张票只放松了"记住"的 `from`（`chat` 或 `secretary` 二选一），要守住的是：
// - 历史事件（`from.kind` 是 `chat`，带快速动作和卡片）照旧解析得动——schema 放宽不能让老事件变成非法；
// - 新来源带着会话、消息（有就带）、工具调用（有就带），不硬编 actionId / cardId；
// - 不合法的不收（chat 少了卡片、secretary 少了会话、不认识的来源、空的必填项）；
// - 删除类命令的 `from` 不变：不接受 `secretary`（它只属于"记住"，别让两种命令的形状混了）。
import { describe, expect, test } from "vitest";
import { type MemoryCommandEventPayload, MemoryCommandEventPayload as MemoryCommandEventPayloadSchema, schemaChecker } from "../src/index.ts";

const checker = schemaChecker(MemoryCommandEventPayloadSchema);
const accepts = (value: unknown) => checker.check(value);
const problem = (value: unknown) => checker.firstError(value);

/** 老的"记住"事件：对话里的快速动作起的，带卡片 */
const chatRemember = (over: Record<string, unknown> = {}): unknown => ({
  commandId: "mc-1",
  command: "remember",
  content: "周三下午去取车",
  source: "typed",
  from: { kind: "chat", conversation: "secretary", actionId: "act-1", cardId: "c-1" },
  ...over,
});

/** 新的"记住"事件：秘书按用户的话记的，没有卡片 */
const secretaryRemember = (over: Record<string, unknown> = {}): unknown => ({
  commandId: "mc-2",
  command: "remember",
  content: "周三下午去取车",
  source: "typed",
  from: { kind: "secretary", conversation: "secretary" },
  ...over,
});

describe("记忆命令：老事件照旧解析", () => {
  test("chat 来源的记得住（带不带 inputMessageId 都行）", () => {
    expect(accepts(chatRemember())).toBe(true);
    expect(accepts(chatRemember({ from: { kind: "chat", conversation: "secretary", actionId: "act-1", cardId: "c-1", inputMessageId: "m-1" } }))).toBe(true);
  });

  test("删除类的命令照旧（settings、curator 这些来源都不变）", () => {
    expect(accepts({ commandId: "mc-3", command: "forget", materialIds: ["mat-1"], from: { kind: "settings", scope: { kind: "conversation", conversation: "secretary" } } })).toBe(true);
    expect(accepts({ commandId: "mc-4", command: "no_infer", materialIds: ["mat-1"], from: { kind: "curator", conversation: "memory-curator" } })).toBe(true);
    expect(accepts({ commandId: "mc-5", command: "purge", materialIds: ["mat-1"], from: { kind: "chat", conversation: "secretary", actionId: "act-1", cardId: "c-1" } })).toBe(true);
  });
});

describe("记忆命令：新来源（秘书、没有卡片）", () => {
  test("secretary 来源的记得住：会话必填，消息、工具调用可选", () => {
    expect(accepts(secretaryRemember())).toBe(true);
    expect(accepts(secretaryRemember({ from: { kind: "secretary", conversation: "secretary", inputMessageId: "m-1" } }))).toBe(true);
    expect(accepts(secretaryRemember({ from: { kind: "secretary", conversation: "secretary", inputMessageId: "m-1", toolCallId: "call-1" } }))).toBe(true);
    // 只带工具调用（没有消息）也行：比如用户是说了一句、秘书在那一轮里记的，消息编号还没定
    expect(accepts(secretaryRemember({ from: { kind: "secretary", conversation: "secretary", toolCallId: "call-1" } }))).toBe(true);
  });

  test("解析出来的负载带着会话、消息、工具调用", () => {
    const value = secretaryRemember({ from: { kind: "secretary", conversation: "secretary", inputMessageId: "m-1", toolCallId: "call-1" } });
    expect(accepts(value)).toBe(true);
    const payload = value as MemoryCommandEventPayload;
    expect(payload.command).toBe("remember");
    expect(payload.from).toEqual({ kind: "secretary", conversation: "secretary", inputMessageId: "m-1", toolCallId: "call-1" });
  });
});

describe("记忆命令：不合法的不收", () => {
  test("老的来源少了快速动作或卡片：还是非法（没被新来源放松掉）", () => {
    expect(accepts(chatRemember({ from: { kind: "chat", conversation: "secretary", cardId: "c-1" } }))).toBe(false);
    expect(accepts(chatRemember({ from: { kind: "chat", conversation: "secretary", actionId: "act-1" } }))).toBe(false);
    expect(problem(chatRemember({ from: { kind: "chat", conversation: "secretary", cardId: "c-1" } }))).toBeDefined();
  });

  test("新来源少了会话、不认识的来源、少了原话：都不收", () => {
    expect(accepts(secretaryRemember({ from: { kind: "secretary" } }))).toBe(false);
    expect(accepts(secretaryRemember({ from: { kind: "outside", conversation: "secretary" } }))).toBe(false);
    expect(accepts(secretaryRemember({ content: undefined }))).toBe(false);
    expect(accepts(secretaryRemember({ source: "guessed" }))).toBe(false);
    expect(problem(secretaryRemember({ from: { kind: "secretary" } }))).toBeDefined();
  });

  test("删除类命令不接受 secretary 来源（它只属于\"记住\"）", () => {
    expect(accepts({ commandId: "mc-6", command: "forget", materialIds: ["mat-1"], from: { kind: "secretary", conversation: "secretary" } })).toBe(false);
  });
});
