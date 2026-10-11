// 共享协议包的请求解析：守护进程收到的每一帧都经过它。格式不对的给出错误（由网关回成错误响应，连接不断）。
import { describe, expect, test } from "vitest";
import { FRONTEND_PROTOCOL_VERSION, isChannel, nowIso, parseRequest } from "../src/index.ts";

describe("解析请求帧", () => {
  test("合法的发消息请求：带幂等键，参数按方法校验", () => {
    const raw = JSON.stringify({
      id: "r1",
      method: "send_message",
      params: { conversation: "secretary", parts: [{ type: "text", text: "在吗" }] },
      idempotencyKey: "k1",
    });
    expect(parseRequest(raw)).toEqual({
      ok: true,
      request: { id: "r1", method: "send_message", params: { conversation: "secretary", parts: [{ type: "text", text: "在吗" }] }, idempotencyKey: "k1" },
    });
  });

  test("一次处理多个任务（90 号票）：暂停、继续、取消、归档，带幂等键", () => {
    const raw = JSON.stringify({ id: "r1", method: "task_batch_action", params: { taskIds: ["t-1", "t-2"], action: "archive" }, idempotencyKey: "k1" });
    expect(parseRequest(raw)).toEqual({ ok: true, request: { id: "r1", method: "task_batch_action", params: { taskIds: ["t-1", "t-2"], action: "archive" }, idempotencyKey: "k1" } });
  });

  test("订阅请求带协议版本和每个频道最后收到的序号", () => {
    const raw = JSON.stringify({ id: "r1", method: "subscribe", params: { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 3, "maintainer:p-notes": 0 } } });
    expect(parseRequest(raw)).toMatchObject({ ok: true, request: { method: "subscribe" } });
  });

  test.each([
    ["不是 JSON", "{oops", null, "bad_frame"],
    ["不是对象", "[1,2]", null, "bad_frame"],
    ["缺 id", JSON.stringify({ method: "subscribe", params: {} }), null, "bad_frame"],
    ["不认识的方法", JSON.stringify({ id: "r2", method: "drop_tables", params: {} }), "r2", "unknown_method"],
    ["参数不对", JSON.stringify({ id: "r3", method: "send_message", params: { conversation: "secretary", parts: [] }, idempotencyKey: "k" }), "r3", "bad_params"],
    ["未知的 part 类型", JSON.stringify({ id: "r4", method: "send_message", params: { conversation: "secretary", parts: [{ type: "html", html: "<b>" }] }, idempotencyKey: "k" }), "r4", "bad_params"],
    ["不存在的会话", JSON.stringify({ id: "r5", method: "send_message", params: { conversation: "board", parts: [{ type: "text", text: "x" }] }, idempotencyKey: "k" }), "r5", "bad_params"],
    ["有副作用的请求没带幂等键", JSON.stringify({ id: "r6", method: "send_message", params: { conversation: "secretary", parts: [{ type: "text", text: "x" }] } }), "r6", "idempotency_key_required"],
    ["卡片动作没带幂等键", JSON.stringify({ id: "r7", method: "card_action", params: { cardId: "c1", action: "save", expectedVersion: 1 } }), "r7", "idempotency_key_required"],
    ["待我处理的动作没带幂等键", JSON.stringify({ id: "r8", method: "inbox_action", params: { itemIds: ["i1"], action: "read" } }), "r8", "idempotency_key_required"],
    ["待我处理的动作不认识", JSON.stringify({ id: "r9", method: "inbox_action", params: { itemIds: ["i1"], action: "burn" }, idempotencyKey: "k" }), "r9", "bad_params"],
    ["待我处理的动作没给事项", JSON.stringify({ id: "r10", method: "inbox_action", params: { itemIds: [], action: "read" }, idempotencyKey: "k" }), "r10", "bad_params"],
    // 90 号票：一次处理多个任务（看板多选）——没带幂等键、没给任务、动作不在批量能做的四种里、同一个任务写了两遍都不行
    ["多个任务的动作没带幂等键", JSON.stringify({ id: "r11", method: "task_batch_action", params: { taskIds: ["t-1"], action: "pause" } }), "r11", "idempotency_key_required"],
    ["多个任务的动作没给任务", JSON.stringify({ id: "r12", method: "task_batch_action", params: { taskIds: [], action: "pause" }, idempotencyKey: "k" }), "r12", "bad_params"],
    ["多个任务不能一起重做", JSON.stringify({ id: "r13", method: "task_batch_action", params: { taskIds: ["t-1"], action: "rework" }, idempotencyKey: "k" }), "r13", "bad_params"],
    ["同一个任务写了两遍", JSON.stringify({ id: "r14", method: "task_batch_action", params: { taskIds: ["t-1", "t-1"], action: "cancel" }, idempotencyKey: "k" }), "r14", "bad_params"],
  ])("%s → 错误（%s）", (_name, raw, id, code) => {
    expect(parseRequest(raw)).toMatchObject({ ok: false, id, error: { code, message: expect.stringMatching(/\S/) } });
  });
});

describe("频道名", () => {
  test.each([
    ["secretary", true],
    ["cards", true],
    ["activity", true],
    ["maintainer:p-notes", true],
    ["nowhere", false],
    ["maintainers:x", false],
  ])("%s → %s", (name, expected) => {
    expect(isChannel(name)).toBe(expected);
  });
});

describe("时间格式", () => {
  test("带时区偏移的本地 ISO 时间，精确到毫秒，表示的是同一时刻", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    const at = new Date(Date.UTC(2026, 9, 7, 13, 5, 0, 123));
    expect(new Date(nowIso(at)).getTime()).toBe(at.getTime());
  });
});
