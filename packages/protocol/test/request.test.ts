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
