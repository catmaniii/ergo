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
  /** 最后一次真的订阅（带频道的 subscribe） */
  subscription() {
    const frame = this.subscribes().filter((f) => !isReceipt(f)).at(-1);
    if (!frame) throw new Error("没订阅过");
    return frame;
  }
  /** 最后一个"补发推完了"的回执（cursors 为空的 subscribe，紧跟着订阅发出去） */
  receipt() {
    const frame = this.subscribes().filter(isReceipt).at(-1);
    if (!frame) throw new Error("没发过回执");
    return frame;
  }
  subscribes() {
    return this.sent.filter((f) => f.method === "subscribe");
  }
}

/** "补发推完了"的回执：cursors 为空的订阅 */
const isReceipt = (f: { params: unknown }) => Object.keys((f.params as { cursors: object }).cursors).length === 0;

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

/** 打开最新的 socket 并答应订阅，补发也推完了（答应订阅之后紧跟着的那个回执，见"补发"那几条） */
function openAndSubscribe(): FakeSocket {
  const socket = sockets.at(-1)!;
  socket.open();
  socket.reply(socket.subscription().id, { protocolVersion: FRONTEND_PROTOCOL_VERSION });
  socket.reply(socket.receipt().id, { protocolVersion: FRONTEND_PROTOCOL_VERSION, resync: [] });
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
    expect(socket.subscription().params).toEqual({ protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 4, cards: 0 } });
    socket.reply(socket.subscription().id);
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
    expect(sockets[1]!.subscription().params).toEqual({ protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 2, cards: 0 } });
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
    // 只有订阅和紧跟着的回执，没得到响应的请求等订阅成功了再发
    expect(second.sent.map((f) => f.method)).toEqual(["subscribe", "subscribe"]);
    second.reply(second.subscription().id);
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
    expect(second.subscription().params).toMatchObject({ cursors: { secretary: 2 } });
    second.reply(second.subscription().id, { protocolVersion: FRONTEND_PROTOCOL_VERSION, resync: ["secretary"] });
    expect(inputs.slice(-2)).toEqual([
      { kind: "connection", status: "online" },
      { kind: "resync", channel: "secretary" },
    ]);
    second.drop();
    vi.advanceTimersByTime(500);
    sockets[2]!.open();
    expect(sockets[2]!.subscription().params).toMatchObject({ cursors: { secretary: 0 } });
  });

  test("协议版本不一致：报页面过旧，不再重连", () => {
    connect();
    const socket = sockets[0]!;
    socket.open();
    socket.fail(socket.subscription().id, "protocol_mismatch", "请刷新页面");
    expect(inputs.at(-1)).toEqual({ kind: "connection", status: "outdated" });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  test("控制任务带幂等键（暂停、返工哪个阶段、退回的原因）；被拒变成 request_failed", () => {
    const { connection } = connect();
    const socket = openAndSubscribe();
    connection.taskAction({ taskId: "t-1", action: "rework", stageId: "s2", note: "缺一段对比", idempotencyKey: "k-t" });
    const sent = socket.last("task_action");
    expect(sent).toMatchObject({ params: { taskId: "t-1", action: "rework", stageId: "s2", note: "缺一段对比" }, idempotencyKey: "k-t" });
    socket.fail(sent.id, "not_allowed", "任务现在是执行中，只有已完成的任务能返工");
    expect(inputs.at(-1)).toEqual({ kind: "request_failed", idempotencyKey: "k-t", error: "任务现在是执行中，只有已完成的任务能返工" });
  });

  test("一次处理多个任务（90 号票）：带幂等键，逐条的结果交回来；整个被拒时变成 request_failed，等结果的也知道没成", async () => {
    const { connection } = connect();
    const socket = openAndSubscribe();
    const done = connection.taskBatchAction({ taskIds: ["t-1", "t-2"], action: "pause", idempotencyKey: "k-b" });
    const sent = socket.last("task_batch_action");
    expect(sent).toMatchObject({ params: { taskIds: ["t-1", "t-2"], action: "pause" }, idempotencyKey: "k-b" });
    const results = [
      { taskId: "t-1", ok: true, state: "paused" },
      { taskId: "t-2", ok: false, code: "not_allowed", message: "任务现在是已完成，不能暂停" },
    ];
    socket.reply(sent.id, { results });
    await expect(done).resolves.toEqual({ results });

    const rejected = connection.taskBatchAction({ taskIds: ["t-1"], action: "archive", idempotencyKey: "k-c" });
    socket.fail(socket.last("task_batch_action").id, "not_implemented", "这个版本还不能一次处理多个任务");
    await expect(rejected).rejects.toThrow("这个版本还不能一次处理多个任务");
    expect(inputs.at(-1)).toEqual({ kind: "request_failed", idempotencyKey: "k-c", error: "这个版本还不能一次处理多个任务" });
  });

  test("一次处理多个任务时断线：重连之后带同一个幂等键重发，结果照样交回来", async () => {
    const { connection } = connect();
    const first = openAndSubscribe();
    const done = connection.taskBatchAction({ taskIds: ["t-1"], action: "cancel", idempotencyKey: "k-d" });
    first.drop();
    vi.advanceTimersByTime(500);
    const second = openAndSubscribe();
    const resent = second.last("task_batch_action");
    expect(resent.idempotencyKey).toBe("k-d");
    second.reply(resent.id, { results: [{ taskId: "t-1", ok: true, state: "cancelled" }] });
    await expect(done).resolves.toEqual({ results: [{ taskId: "t-1", ok: true, state: "cancelled" }] });
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

  test("多订阅几个频道（打开项目的维护者会话）：连着就马上只订阅它们；它的响应不影响别的请求；断线重连时一起订阅、带上游标", () => {
    const { connection } = connect();
    const socket = openAndSubscribe();
    connection.projectAction({ projectId: "p-1", action: "retire", idempotencyKey: "k-p" });
    connection.watchChannels(["maintainer:pm-1", "secretary"]);
    const watch = socket.subscription();
    expect(watch.params).toEqual({ protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { "maintainer:pm-1": 0 } });
    // 已经订阅的不重复订阅（第一次订阅和它的回执、这次的多订阅和它的回执）
    connection.watchChannels(["maintainer:pm-1"]);
    expect(socket.subscribes()).toHaveLength(4);
    socket.reply(watch.id, { protocolVersion: FRONTEND_PROTOCOL_VERSION, resync: ["maintainer:pm-1"] });
    expect(inputs.at(-1)).toEqual({ kind: "resync", channel: "maintainer:pm-1" });
    // 项目页上的动作照常（没有因为多出来的订阅响应被重发）
    expect(socket.sent.filter((f) => f.method === "project_action")).toHaveLength(1);
    expect(socket.last("project_action")).toMatchObject({ params: { projectId: "p-1", action: "retire" }, idempotencyKey: "k-p" });
    // 转为项目带用户定的项目名
    connection.convertTaskToProject({ taskId: "t-1", name: "家庭记账", idempotencyKey: "k-c" });
    expect(socket.last("convert_task_to_project")).toMatchObject({ params: { taskId: "t-1", name: "家庭记账" }, idempotencyKey: "k-c" });

    socket.push(event("maintainer:pm-1", 3));
    socket.drop();
    vi.advanceTimersByTime(500);
    sockets[1]!.open();
    expect(sockets[1]!.subscription().params).toEqual({ protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 0, cards: 0, "maintainer:pm-1": 3 } });
  });

  test("没连上时多订阅：等连上时和别的频道一起订阅", () => {
    const { connection } = connect();
    connection.watchChannels(["maintainer:pm-1"]);
    const socket = sockets[0]!;
    socket.open();
    // 只订阅一次（加上紧跟着的回执）
    expect(socket.subscribes()).toHaveLength(2);
    expect(socket.subscription().params).toMatchObject({ cursors: { secretary: 0, cards: 0, "maintainer:pm-1": 0 } });
  });

  test("补发：订阅发出去就紧跟着发一个空订阅当回执（不等订阅的响应）；回执的响应到之前收到的帧标成补发的（catchUp），之后的是实时推来的", () => {
    connect({ secretary: 1 });
    const socket = sockets[0]!;
    socket.open();
    // 服务端按顺序处理同一条连接上的请求、补发在处理订阅时一口气推完：空订阅的响应一定在补发的帧后面
    expect(socket.subscribes().map((f) => f.params)).toEqual([
      { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 1, cards: 0 } },
      { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: {} },
    ]);
    const receipt = socket.receipt();
    socket.reply(socket.subscription().id);
    socket.push(event("secretary", 2, "agent_voice"));
    socket.push(event("cards", 1));
    expect(inputs.slice(-2)).toEqual([
      { kind: "frame", frame: event("secretary", 2, "agent_voice"), catchUp: true },
      { kind: "frame", frame: event("cards", 1), catchUp: true },
    ]);
    socket.reply(receipt.id, { protocolVersion: FRONTEND_PROTOCOL_VERSION, resync: [] });
    socket.push(event("secretary", 3, "agent_voice"));
    expect(inputs.at(-1)).toEqual({ kind: "frame", frame: event("secretary", 3, "agent_voice") });
    // 回执的响应不是别的请求的响应，也不再报一次在线
    expect(inputs.filter((i) => i.kind === "connection")).toEqual([{ kind: "connection", status: "online" }]);
  });

  test("断线重连：重新订阅之后的补发同样标成补发的，回执到了才算实时", () => {
    connect();
    const first = openAndSubscribe();
    first.push(event("secretary", 1));
    expect(inputs.at(-1)).toEqual({ kind: "frame", frame: event("secretary", 1) });
    first.drop();
    vi.advanceTimersByTime(500);
    const second = sockets[1]!;
    second.open();
    second.reply(second.subscription().id);
    second.push(event("secretary", 2));
    expect(inputs.at(-1)).toEqual({ kind: "frame", frame: event("secretary", 2), catchUp: true });
    second.reply(second.receipt().id);
    second.push(event("secretary", 3));
    expect(inputs.at(-1)).toEqual({ kind: "frame", frame: event("secretary", 3) });
  });

  test("回执还没到就断了：新连接上不沿用旧的回执", () => {
    connect();
    const first = sockets[0]!;
    first.open();
    first.reply(first.subscription().id);
    const staleReceipt = first.receipt();
    first.drop();
    vi.advanceTimersByTime(500);
    const second = sockets[1]!;
    second.open();
    second.reply(second.subscription().id);
    // 旧连接的回执 id 在新连接上不算数：还在补发
    second.reply(staleReceipt.id);
    second.push(event("secretary", 1));
    expect(inputs.at(-1)).toEqual({ kind: "frame", frame: event("secretary", 1), catchUp: true });
  });

  test("多订阅一个频道（打开维护者会话）：它的补发标成补发的，别的频道照常是实时的；它的回执到了就都是实时的", () => {
    const { connection } = connect();
    const socket = openAndSubscribe();
    connection.watchChannels(["maintainer:pm-1"]);
    // 多订阅发出去就紧跟着它的回执
    expect(socket.sent.slice(-2).map((f) => f.params)).toEqual([
      { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { "maintainer:pm-1": 0 } },
      { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: {} },
    ]);
    const receipt = socket.receipt();
    socket.reply(socket.subscription().id);
    socket.push(event("maintainer:pm-1", 1, "agent_voice"));
    socket.push(event("secretary", 1, "agent_voice"));
    expect(inputs.slice(-2)).toEqual([
      { kind: "frame", frame: event("maintainer:pm-1", 1, "agent_voice"), catchUp: true },
      { kind: "frame", frame: event("secretary", 1, "agent_voice") },
    ]);
    socket.reply(receipt.id);
    socket.push(event("maintainer:pm-1", 2, "agent_voice"));
    expect(inputs.at(-1)).toEqual({ kind: "frame", frame: event("maintainer:pm-1", 2, "agent_voice") });
  });

  test("补发推完了（109 号票）：主订阅的回执到了报 synced，断线重连之后再报一次；多订阅频道的回执不报", () => {
    const { connection } = connect();
    const first = sockets[0]!;
    first.open();
    first.reply(first.subscription().id);
    first.push(event("secretary", 1));
    expect(inputs.filter((i) => i.kind === "synced")).toEqual([]);
    first.reply(first.receipt().id);
    expect(inputs.slice(-2)).toEqual([{ kind: "frame", frame: event("secretary", 1), catchUp: true }, { kind: "synced" }]);
    connection.watchChannels(["maintainer:pm-1"]);
    first.reply(first.subscription().id);
    first.reply(first.receipt().id);
    expect(inputs.filter((i) => i.kind === "synced")).toHaveLength(1);
    first.drop();
    vi.advanceTimersByTime(500);
    openAndSubscribe();
    expect(inputs.filter((i) => i.kind === "synced")).toHaveLength(2);
  });

  test("记已读位置（109 号票）：带幂等键；没连上时先记着，连上后发", () => {
    const { connection } = connect();
    connection.markRead({ conversation: "secretary", seq: 12, idempotencyKey: "k-read" });
    const socket = openAndSubscribe();
    expect(socket.last("mark_read")).toMatchObject({ method: "mark_read", params: { conversation: "secretary", seq: 12 }, idempotencyKey: "k-read" });
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
