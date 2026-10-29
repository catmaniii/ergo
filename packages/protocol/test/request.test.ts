// 共享协议包的请求解析：守护进程收到的每一帧都经过它。格式不对的给出错误（由网关回成错误响应，连接不断）。
import { describe, expect, test } from "vitest";
import {
  checkHttpBody,
  DEBUG_AUDIO_MAX_BYTES,
  DEBUG_SPEAK_TEXT_MAX,
  DebugRecognizeBody,
  DebugRecognizeResult,
  DebugSpeakBody,
  DebugSpeakResult,
  FRONTEND_PROTOCOL_VERSION,
  isChannel,
  nowIso,
  parseRequest,
  requiresIdempotencyKey,
} from "../src/index.ts";

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

  test("对简单提醒的动作（185 号票）：取消、归档、删除，一条或几条，带幂等键", () => {
    for (const action of ["cancel", "archive", "delete"]) {
      const raw = JSON.stringify({ id: "r1", method: "reminder_action", params: { reminderIds: ["r-1", "r-2"], action }, idempotencyKey: "k1" });
      expect(parseRequest(raw)).toEqual({ ok: true, request: { id: "r1", method: "reminder_action", params: { reminderIds: ["r-1", "r-2"], action }, idempotencyKey: "k1" } });
    }
  });

  test("设备多选（123 号票）：延期带天数，吊销、删除不用；都要幂等键", () => {
    const extend = { action: "extend", deviceIds: ["d-1", "d-2"], days: 90 };
    expect(parseRequest(JSON.stringify({ id: "r1", method: "device_batch_action", params: extend, idempotencyKey: "k1" }))).toEqual({
      ok: true,
      request: { id: "r1", method: "device_batch_action", params: extend, idempotencyKey: "k1" },
    });
    expect(parseRequest(JSON.stringify({ id: "r2", method: "device_batch_action", params: { action: "delete", deviceIds: ["d-1"] }, idempotencyKey: "k2" }))).toMatchObject({ ok: true });
  });

  test("改时间（98 号票）：reschedule_job 带触发登记和新的时间表（和简单提醒同一个 ReminderSchedule），要幂等键；时间表不合格的回 bad_params", () => {
    const params = { jobId: "j-1", schedule: { kind: "daily", time: "08:00" } };
    expect(parseRequest(JSON.stringify({ id: "r1", method: "reschedule_job", params, idempotencyKey: "k1" }))).toEqual({ ok: true, request: { id: "r1", method: "reschedule_job", params, idempotencyKey: "k1" } });
    const once = { jobId: "j-1", schedule: { kind: "once", at: "2026-10-13T08:00:00.000+08:00" } };
    expect(parseRequest(JSON.stringify({ id: "r2", method: "reschedule_job", params: once, idempotencyKey: "k2" }))).toMatchObject({ ok: true });
    expect(parseRequest(JSON.stringify({ id: "r3", method: "reschedule_job", params }))).toMatchObject({ ok: false, error: { code: "idempotency_key_required" } });
    expect(parseRequest(JSON.stringify({ id: "r4", method: "reschedule_job", params: { jobId: "j-1", schedule: { kind: "daily", time: "8点" } }, idempotencyKey: "k4" }))).toMatchObject({ ok: false, error: { code: "bad_params" } });
    expect(parseRequest(JSON.stringify({ id: "r5", method: "reschedule_job", params: { jobId: "j-1" }, idempotencyKey: "k5" }))).toMatchObject({ ok: false, error: { code: "bad_params" } });
  });

  test("立即运行一次、跑完自动播报（100 号票）：run_job_now 带触发登记，set_voice_announce 带任务和开关，都要幂等键；发起时也能先勾上", () => {
    expect(parseRequest(JSON.stringify({ id: "r1", method: "run_job_now", params: { jobId: "j-1" }, idempotencyKey: "k1" }))).toEqual({ ok: true, request: { id: "r1", method: "run_job_now", params: { jobId: "j-1" }, idempotencyKey: "k1" } });
    expect(parseRequest(JSON.stringify({ id: "r2", method: "run_job_now", params: { jobId: "j-1" } }))).toMatchObject({ ok: false, error: { code: "idempotency_key_required" } });
    expect(parseRequest(JSON.stringify({ id: "r3", method: "run_job_now", params: {}, idempotencyKey: "k3" }))).toMatchObject({ ok: false, error: { code: "bad_params" } });
    const on = { taskId: "t-5", on: true };
    expect(parseRequest(JSON.stringify({ id: "r4", method: "set_voice_announce", params: on, idempotencyKey: "k4" }))).toEqual({ ok: true, request: { id: "r4", method: "set_voice_announce", params: on, idempotencyKey: "k4" } });
    expect(parseRequest(JSON.stringify({ id: "r5", method: "set_voice_announce", params: on }))).toMatchObject({ ok: false, error: { code: "idempotency_key_required" } });
    expect(parseRequest(JSON.stringify({ id: "r6", method: "set_voice_announce", params: { taskId: "t-5", on: "开" }, idempotencyKey: "k6" }))).toMatchObject({ ok: false, error: { code: "bad_params" } });
    expect(parseRequest(JSON.stringify({ id: "r7", method: "start_task", params: { request: "每天出 AI 新闻日报", kind: "plain", voiceAnnounce: true }, idempotencyKey: "k7" }))).toMatchObject({ ok: true });
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
    // 185 号票：对简单提醒的动作——没带幂等键、没给提醒、动作不认识（没有取消归档）、同一条写了两遍都不行
    ["提醒的动作没带幂等键", JSON.stringify({ id: "r21", method: "reminder_action", params: { reminderIds: ["r-1"], action: "delete" } }), "r21", "idempotency_key_required"],
    ["提醒的动作没给提醒", JSON.stringify({ id: "r22", method: "reminder_action", params: { reminderIds: [], action: "archive" }, idempotencyKey: "k" }), "r22", "bad_params"],
    ["提醒不能取消归档", JSON.stringify({ id: "r23", method: "reminder_action", params: { reminderIds: ["r-1"], action: "unarchive" }, idempotencyKey: "k" }), "r23", "bad_params"],
    ["同一条提醒写了两遍", JSON.stringify({ id: "r24", method: "reminder_action", params: { reminderIds: ["r-1", "r-1"], action: "delete" }, idempotencyKey: "k" }), "r24", "bad_params"],
    // 123 号票：设备多选——没带幂等键、没给设备、动作不认识、同一台写了两遍、延期天数超出上限都不行
    ["设备多选没带幂等键", JSON.stringify({ id: "r15", method: "device_batch_action", params: { action: "revoke", deviceIds: ["d-1"] } }), "r15", "idempotency_key_required"],
    ["设备多选没给设备", JSON.stringify({ id: "r16", method: "device_batch_action", params: { action: "revoke", deviceIds: [] }, idempotencyKey: "k" }), "r16", "bad_params"],
    ["设备多选的动作不认识", JSON.stringify({ id: "r17", method: "device_batch_action", params: { action: "rename", deviceIds: ["d-1"] }, idempotencyKey: "k" }), "r17", "bad_params"],
    ["同一台设备写了两遍", JSON.stringify({ id: "r18", method: "device_batch_action", params: { action: "delete", deviceIds: ["d-1", "d-1"] }, idempotencyKey: "k" }), "r18", "bad_params"],
    ["延期超过一年", JSON.stringify({ id: "r19", method: "device_batch_action", params: { action: "extend", deviceIds: ["d-1"], days: 366 }, idempotencyKey: "k" }), "r19", "bad_params"],
    ["延期天数不是整数", JSON.stringify({ id: "r20", method: "device_batch_action", params: { action: "extend", deviceIds: ["d-1"], days: 1.5 }, idempotencyKey: "k" }), "r20", "bad_params"],
  ])("%s → 错误（%s）", (_name, raw, id, code) => {
    expect(parseRequest(raw)).toMatchObject({ ok: false, id, error: { code, message: expect.stringMatching(/\S/) } });
  });
});

describe("守护进程的版本（124 号票：设置里的关于二狗、Debug 工具集）", () => {
  test("daemon_info 只读、不带参数也不用幂等键；带了幂等键也照收", () => {
    expect(parseRequest(JSON.stringify({ id: "r1", method: "daemon_info", params: {} }))).toEqual({ ok: true, request: { id: "r1", method: "daemon_info", params: {} } });
    expect(parseRequest(JSON.stringify({ id: "r2", method: "daemon_info", params: {}, idempotencyKey: "k2" }))).toMatchObject({ ok: true });
    expect(requiresIdempotencyKey("daemon_info")).toBe(false);
    expect(parseRequest(JSON.stringify({ id: "r3", method: "daemon_info", params: "x" }))).toMatchObject({ ok: false, id: "r3", error: { code: "bad_params" } });
  });

  test("调试用的识别、合成：请求体按 schema 查（录音不能是空的、念的一句不超过上限），结果是成功或者带原因的失败", () => {
    expect(checkHttpBody(DebugRecognizeBody, { audioBase64: "UklGRg==", mime: "audio/wav" })).toMatchObject({ ok: true });
    expect(checkHttpBody(DebugRecognizeBody, { audioBase64: "", mime: "audio/wav" })).toMatchObject({ ok: false });
    expect(checkHttpBody(DebugRecognizeBody, { audioBase64: "x".repeat(Math.ceil((DEBUG_AUDIO_MAX_BYTES * 4) / 3) + 100), mime: "audio/wav" })).toMatchObject({ ok: false });
    expect(checkHttpBody(DebugSpeakBody, { text: "你好，我是二狗。" })).toMatchObject({ ok: true });
    expect(checkHttpBody(DebugSpeakBody, { text: "长".repeat(DEBUG_SPEAK_TEXT_MAX + 1) })).toMatchObject({ ok: false });
    expect(checkHttpBody(DebugRecognizeResult, { ok: true, text: "你好", ms: 820, model: "small", device: "cuda" })).toMatchObject({ ok: true });
    expect(checkHttpBody(DebugSpeakResult, { ok: false, reason: "语音合成服务没开", ms: 3 })).toMatchObject({ ok: true });
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
