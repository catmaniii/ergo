// 前端的 WebSocket 连接：订阅时带上每个频道最后收到的序号，断线自动重连，没得到响应的请求重连后带同一个幂等键重发。
// 用一个假的 socket 驱动（真的守护进程那一侧由主切面测）。
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type SocketLike, WebSocketConnection, type WebSocketConnectionOptions } from "../../src/app/ws-connection.ts";
import { type AccessInfo, FRONTEND_PROTOCOL_VERSION, type UiInput } from "../../src/state/index.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Array<{ id: string; method: string; params: unknown; idempotencyKey?: string }> = [];
  private readonly listeners: Record<string, Array<(ev: { data: unknown }) => void>> = {};
  addEventListener(type: string, listener: (ev: { data: unknown }) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  private emit(type: string, data: unknown = undefined) {
    for (const listener of this.listeners[type] ?? []) listener({ data });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.drop();
  }
  // ── 测试里扮演服务端 ──
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  push(frame: unknown) {
    this.emit("message", JSON.stringify(frame));
  }
  reply(id: string, result: unknown = {}) {
    this.push({ id, ok: true, result });
  }
  fail(id: string, code: string, message: string) {
    this.push({ id, ok: false, error: { code, message } });
  }
  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  last(method: string) {
    const frame = this.sent.filter((f) => f.method === method).at(-1);
    if (!frame) throw new Error(`没发过 ${method}`);
    return frame;
  }
}

let sockets: FakeSocket[];
let inputs: UiInput[];

function connect(cursors: Record<string, number> = {}, options: Partial<WebSocketConnectionOptions> = {}) {
  const connection = new WebSocketConnection({
    url: "ws://127.0.0.1:8810/ws",
    channels: ["secretary", "cards"],
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    retryDelaysMs: [500, 2000],
    ...options,
  });
  const disconnect = connection.connect(cursors, (input) => inputs.push(input));
  return { connection, disconnect };
}

/** 打开最新的 socket 并答应订阅 */
function openAndSubscribe(): FakeSocket {
  const socket = sockets.at(-1)!;
  socket.open();
  socket.reply(socket.last("subscribe").id, { protocolVersion: FRONTEND_PROTOCOL_VERSION });
  return socket;
}

const event = (channel: string, seq: number, type = "message") => ({ channel, seq, type, payload: {} });

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  inputs = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("WebSocket 连接", () => {
  test("连上就订阅：带协议版本和每个频道最后收到的序号；订阅成功后报在线", () => {
    connect({ secretary: 4 });
    const socket = sockets[0]!;
    socket.open();
    expect(socket.last("subscribe").params).toEqual({ protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 4, cards: 0 } });
    socket.reply(socket.last("subscribe").id);
    expect(inputs).toEqual([{ kind: "connection", status: "online" }]);
  });

  test("事件帧原样交给状态层", () => {
    connect();
    const socket = openAndSubscribe();
    socket.push(event("secretary", 1));
    expect(inputs.at(-1)).toEqual({ kind: "frame", frame: event("secretary", 1) });
  });

  test("发消息带幂等键；失败的响应变成 request_failed", () => {
    const { connection } = connect();
    const socket = openAndSubscribe();
    connection.sendMessage({ conversation: "secretary", idempotencyKey: "k1", parts: [{ type: "text", text: "在吗" }] });
    const sent = socket.last("send_message");
    expect(sent).toMatchObject({ method: "send_message", params: { conversation: "secretary", parts: [{ type: "text", text: "在吗" }] }, idempotencyKey: "k1" });
    socket.fail(sent.id, "bad_params", "消息是空的");
    expect(inputs.at(-1)).toEqual({ kind: "request_failed", idempotencyKey: "k1", error: "消息是空的" });
  });

  test("卡片动作带期望版本和输入；待我处理的动作被拒（卡着任务不能删）变成 request_failed", () => {
    const { connection } = connect();
    const socket = openAndSubscribe();
    connection.cardAction({ cardId: "c1", action: "save", expectedVersion: 2, idempotencyKey: "k-c", input: { schedule: { kind: "daily", time: "09:00" } } });
    expect(socket.last("card_action")).toMatchObject({ params: { cardId: "c1", action: "save", expectedVersion: 2, input: { schedule: { kind: "daily", time: "09:00" } } }, idempotencyKey: "k-c" });
    connection.inboxAction({ itemIds: ["i1"], action: "delete", idempotencyKey: "k-i" });
    const sent = socket.last("inbox_action");
    expect(sent).toMatchObject({ params: { itemIds: ["i1"], action: "delete" }, idempotencyKey: "k-i" });
    socket.fail(sent.id, "not_allowed", "「计划」卡着任务，处理之前不能删除");
    expect(inputs.at(-1)).toEqual({ kind: "request_failed", idempotencyKey: "k-i", error: "「计划」卡着任务，处理之前不能删除" });
  });

  test("断线：报断开，等一会儿重连，订阅带上断线前收到的最后序号（临时事件不算）", () => {
    connect();
    const first = openAndSubscribe();
    first.push(event("secretary", 1));
    first.push(event("secretary", 2));
    first.push(event("secretary", 2, "stream"));
    first.push(event("secretary", 7, "stream")); // 临时事件的序号再大也不推进游标
    first.drop();
    expect(inputs.at(-1)).toEqual({ kind: "connection", status: "offline" });
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.last("subscribe").params).toEqual({ protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 2, cards: 0 } });
  });

  test("没得到响应的请求（包括断线时发的）重连订阅之后带同一个幂等键重发；已经有响应的不再发", () => {
    const { connection } = connect();
    const first = openAndSubscribe();
    connection.sendMessage({ conversation: "secretary", idempotencyKey: "k-done", parts: [{ type: "text", text: "一" }] });
    first.reply(first.last("send_message").id, { messageId: "m1", seq: 1 });
    connection.sendMessage({ conversation: "secretary", idempotencyKey: "k-lost", parts: [{ type: "text", text: "二" }] });
    first.drop();
    connection.sendMessage({ conversation: "secretary", idempotencyKey: "k-offline", parts: [{ type: "text", text: "三" }] });

    vi.advanceTimersByTime(500);
    const second = sockets[1]!;
    second.open();
    expect(second.sent.map((f) => f.method)).toEqual(["subscribe"]);
    second.reply(second.last("subscribe").id);
    expect(second.sent.filter((f) => f.method === "send_message").map((f) => f.idempotencyKey)).toEqual(["k-lost", "k-offline"]);
  });

  test("一直连不上：重连间隔按给定的序列拉长，之后停在最后一个", () => {
    connect();
    sockets[0]!.drop();
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    sockets[2]!.drop();
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(4);
  });

  test("订阅响应里点名重新同步的频道：交给状态层清掉，游标归零（服务端接着从头补发）", () => {
    connect();
    const first = openAndSubscribe();
    first.push(event("secretary", 1));
    first.push(event("secretary", 2));
    first.drop();
    vi.advanceTimersByTime(500);
    const second = sockets[1]!;
    second.open();
    expect(second.last("subscribe").params).toMatchObject({ cursors: { secretary: 2 } });
    second.reply(second.last("subscribe").id, { protocolVersion: FRONTEND_PROTOCOL_VERSION, resync: ["secretary"] });
    expect(inputs.slice(-2)).toEqual([
      { kind: "connection", status: "online" },
      { kind: "resync", channel: "secretary" },
    ]);
    second.drop();
    vi.advanceTimersByTime(500);
    sockets[2]!.open();
    expect(sockets[2]!.last("subscribe").params).toMatchObject({ cursors: { secretary: 0 } });
  });

  test("协议版本不一致：报页面过旧，不再重连", () => {
    connect();
    const socket = sockets[0]!;
    socket.open();
    socket.fail(socket.last("subscribe").id, "protocol_mismatch", "请刷新页面");
    expect(inputs.at(-1)).toEqual({ kind: "connection", status: "outdated" });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  test("吊销设备带幂等键；被拒变成 request_failed", () => {
    const { connection } = connect();
    const socket = openAndSubscribe();
    connection.revokeDevice({ deviceId: "d-1", idempotencyKey: "k-r" });
    const sent = socket.last("revoke_device");
    expect(sent).toMatchObject({ params: { deviceId: "d-1" }, idempotencyKey: "k-r" });
    socket.fail(sent.id, "conflict", "这台设备已经吊销了");
    expect(inputs.at(-1)).toEqual({ kind: "request_failed", idempotencyKey: "k-r", error: "这台设备已经吊销了" });
  });

  test("断线后先问一下这台设备还被信任吗：凭证失效了（被吊销、过期）就报 unpaired 和原因，不再重连", async () => {
    let access: AccessInfo = { access: "device", device: { id: "d1", name: "我的手机" } };
    connect({}, { checkAccess: async () => access });
    openAndSubscribe().drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    expect(inputs.at(-1)).toEqual({ kind: "connection", status: "offline" });

    access = { access: "none", reason: "revoked" };
    openAndSubscribe().drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    expect(inputs.at(-1)).toEqual({ kind: "connection", status: "unpaired", reason: "revoked" });
  });

  test("不知道原因（凭证已经删了）也报 unpaired，不带原因", async () => {
    connect({}, { checkAccess: async () => ({ access: "none" }) });
    openAndSubscribe().drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(inputs.at(-1)).toEqual({ kind: "connection", status: "unpaired" });
  });

  test("问不到（网断了）：照常重连", async () => {
    connect({}, { checkAccess: () => Promise.reject(new Error("网断了")) });
    openAndSubscribe().drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
  });

  test("断开连接（页面卸载）之后不再重连，也不再往状态层送东西", () => {
    const { disconnect } = connect();
    const socket = openAndSubscribe();
    disconnect();
    const count = inputs.length;
    socket.push(event("secretary", 1));
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(inputs).toHaveLength(count);
  });
});
