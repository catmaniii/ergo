// 前端状态层回放主切面录下的真实事件流（规格 Testing Decisions）。
// 录制在 packages/daemon/test/main/recordings.test.ts：真的守护进程 + faux 秘书，模拟前端经 WebSocket 收到的帧，
// 连同它自己的本地动作（发消息）和连接状态，原样存成 recordings/*.json。重新录的方法见那个文件。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  cardDisplay,
  type ConversationItem,
  conversationView,
  type DeviceEventPayload,
  inboxBadge,
  inboxEntries,
  type MessageEventPayload,
  pairedDevices,
  pairingOpening,
  replay,
  resumeCursors,
  selectReminder,
  type UiInput,
  type UiState,
  revokedMarkAfter,
} from "../../src/state/index.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const view = (state: UiState) => conversationView(state, "secretary");

/** 第一个满足条件的输入的下标 */
function indexOf(inputs: readonly UiInput[], match: (input: UiInput) => boolean, from = 0): number {
  const i = inputs.findIndex((input, j) => j >= from && match(input));
  if (i < 0) throw new Error("录好的事件流里没有要找的输入");
  return i;
}

const isFrame = (type: string) => (input: UiInput) => input.kind === "frame" && input.frame.type === type;

describe("回放：秘书聊天（secretary-chat）", () => {
  const inputs = load("secretary-chat");
  const sends = inputs.filter((i): i is Extract<UiInput, { kind: "send_message" }> => i.kind === "send_message");

  test("自己发的先乐观显示；收到带同一个幂等键的权威消息后原地替换", () => {
    const firstSend = indexOf(inputs, (i) => i.kind === "send_message");
    expect(texts(view(replay(inputs.slice(0, firstSend + 1))))).toEqual(["user:在吗（sending）"]);

    const confirmed = replay(inputs.slice(0, indexOf(inputs, isFrame("message")) + 1));
    expect(view(confirmed)).toMatchObject([{ kind: "message", idempotencyKey: sends[0]!.idempotencyKey, message: { speaker: "user" } }]);
  });

  test("回复先以流式增量出现在权威消息之后，定稿消息（同一个 id）到了就换掉它", () => {
    const firstStream = indexOf(inputs, isFrame("stream"));
    const streaming = view(replay(inputs.slice(0, firstStream + 1)));
    expect(streaming.map((it) => it.kind)).toEqual(["message", "streaming"]);

    const finalIndex = indexOf(inputs, isFrame("message"), firstStream);
    const final = (inputs[finalIndex] as Extract<UiInput, { kind: "frame" }>).frame.payload as MessageEventPayload;
    expect(streaming[1]!.message.id).toBe(final.message.id);
    // 定稿之前的每一刻，正在生成的文字都是定稿正文的前缀
    for (let i = firstStream; i < finalIndex; i++) {
      const item = view(replay(inputs.slice(0, i + 1))).find((it) => it.kind === "streaming");
      expect(item?.kind === "streaming" && item.broken).toBe(false);
      for (const part of item?.message.parts ?? []) {
        const same = final.message.parts.find((p) => p.type === part.type);
        expect(same?.type === part.type && "text" in same && "text" in part && same.text.startsWith(part.text)).toBe(true);
      }
    }
    expect(view(replay(inputs.slice(0, finalIndex + 1))).map((it) => it.kind)).toEqual(["message", "message"]);
  });

  test("全部回放：四条权威消息，推理 part 在正文之前；没有尾巴、没有正在生成的；游标停在最后一个落盘事件", () => {
    const state = replay(inputs);
    expect(texts(view(state))).toEqual([
      "user:在吗",
      "agent:[reasoning]在的。今天有什么要我帮忙的？",
      "user:帮我记一下：周五交房租",
      "agent:好，周五交房租，我记下了。不过现在我还不能建提醒，到时候需要你自己留意。",
    ]);
    expect(resumeCursors(state)).toEqual({ secretary: 8 });
    expect(state.connection).toBe("online");
  });
});

describe("回放：断线重连（secretary-reconnect）", () => {
  const inputs = load("secretary-reconnect");
  const lastSend = inputs.findLast((i): i is Extract<UiInput, { kind: "send_message" }> => i.kind === "send_message")!;

  test("刚发出一条网就断了：断开期间那条一直乐观显示，连接状态是断开", () => {
    const during = replay(inputs.slice(0, indexOf(inputs, (i) => i.kind === "connection" && i.status === "offline") + 1));
    expect(during.connection).toBe("offline");
    expect(texts(view(during))).toEqual(["user:在吗", "agent:在的。", "user:断网前发出的一句（sending）"]);
  });

  test("重连后补发的事件按序接上：乐观显示的那条被替换，不重不漏", () => {
    const after = replay(inputs);
    expect(after.connection).toBe("online");
    expect(texts(view(after))).toEqual(["user:在吗", "agent:在的。", "user:断网前发出的一句", "agent:收到，断网之前那条我看到了。"]);
    expect(view(after)[2]).toMatchObject({ kind: "message", idempotencyKey: lastSend.idempotencyKey });
    expect(resumeCursors(after)).toEqual({ secretary: 8 });
  });

  test("同样的事件再补发一遍（比如又重连了一次）也只算一次", () => {
    const after = replay(inputs);
    const again = replay(
      inputs.filter((i) => i.kind === "frame"),
      after,
    );
    expect(texts(view(again))).toEqual(texts(view(after)));
  });
});

describe("回放：重新同步（secretary-resync）", () => {
  const inputs = load("secretary-resync");
  const resyncAt = indexOf(inputs, (i) => i.kind === "resync");

  test("恢复成旧快照之前：两轮聊天都在，游标停在 8", () => {
    const before = replay(inputs.slice(0, resyncAt));
    expect(texts(view(before))).toEqual(["user:第一轮", "agent:第一轮的回复", "user:第二轮", "agent:第二轮的回复（快照之后，会丢）"]);
    expect(resumeCursors(before)).toEqual({ secretary: 8 });
  });

  test("服务端要求重新同步：这个频道清空，从头补发的只有快照里的第一轮，游标回到 4", () => {
    expect(view(replay(inputs.slice(0, resyncAt + 1)))).toEqual([]);
    const after = replay(inputs);
    expect(texts(view(after))).toEqual(["user:第一轮", "agent:第一轮的回复"]);
    expect(resumeCursors(after)).toEqual({ secretary: 4 });
    expect(after.connection).toBe("online");
  });
});

describe("回放：在聊天里处理的卡，待我处理里同步（cards-inbox-sync）", () => {
  // 录的是"待我处理"那个前端：卡片在另一个前端（聊天里）被处理
  const inputs = load("cards-inbox-sync");
  const lastCard = inputs.findLastIndex(isFrame("card"));

  test("处理之前：待我处理里一件未读的卡片事项，tab 亮小红点", () => {
    const before = replay(inputs.slice(0, lastCard));
    expect(inboxEntries(before, "open")).toMatchObject([{ item: { kind: "card" }, processed: false, card: { card: { status: "pending" } } }]);
    expect(inboxBadge(before)).toEqual({ unread: 1, seenPending: 0 });
  });

  test("别处处理了这张卡：同一个事项变成已处理，小红点灭了", () => {
    const after = replay(inputs);
    expect(inboxEntries(after, "open")).toEqual([]);
    expect(inboxEntries(after, "done")).toMatchObject([{ processed: true, card: { card: { status: "handled", outcome: { action: "start_task" } } } }]);
    expect(inboxBadge(after)).toEqual({ unread: 0, seenPending: 0 });
  });
});

describe("回放：秘书要读草稿区外的文件，先问用户（secretary-approval）", () => {
  // 录制在 packages/daemon/test/main/approvals.test.ts
  const inputs = load("secretary-approval");
  const action = indexOf(inputs, (i) => i.kind === "card_action");

  test("批准之前：聊天里一张审批卡（认识、待处理），待我处理里同一张、未读、不卡任务", () => {
    const state = replay(inputs.slice(0, action));
    const ref = view(state)
      .flatMap((it) => it.message.parts)
      .find((p) => p.type === "card_ref");
    const cardId = ref?.type === "card_ref" ? ref.cardId : "";
    expect(cardDisplay(state, cardId)).toMatchObject({
      kind: "typed",
      type: "approval",
      state: { card: { status: "pending", urgency: "non_blocking", payload: { source: "秘书对话", tool: "read", toolTitle: "读文件", categories: ["越出项目目录"] } } },
    });
    expect(inboxEntries(state, "open")).toMatchObject([{ item: { kind: "card", cardId, urgency: "non_blocking" }, processed: false }]);
    expect(inboxBadge(state)).toEqual({ unread: 1, seenPending: 0 });
  });

  test("批准之后：卡片已处理（待我处理里同一个事项也算处理过）；聊天里有这次调用的记录：先问我、越出项目目录、已执行", () => {
    const state = replay(inputs);
    expect(inboxEntries(state, "open")).toEqual([]);
    expect(inboxEntries(state, "done")).toMatchObject([{ processed: true, card: { card: { status: "handled", outcome: { action: "approve" } } } }]);
    const tool = view(state)
      .flatMap((it) => it.message.parts)
      .find((p) => p.type === "tool_call");
    expect(tool).toMatchObject({ tool: "read", watchCategories: ["越出项目目录"], disposition: "ask_first", genericBash: false, outcome: "done" });
    expect(texts(view(state)).at(-1)).toBe("agent:读到了：周五交房租。");
  });
});

describe("回放：秘书建的提醒到点（reminder-due）", () => {
  const inputs = load("reminder-due");
  const turnEnd = indexOf(inputs, isFrame("turn_end"));

  test("秘书建好提醒：聊天里一条只有卡片引用的消息（和这次工具调用的记录），提醒卡认识、待处理；看板上的提醒待触发", () => {
    const state = replay(inputs.slice(0, turnEnd + 1));
    const items = view(state);
    expect(items.map((it) => it.message.parts.map((p) => p.type).join(","))).toEqual(["text", "card_ref", "tool_call", "text"]);
    expect(items[2]!.message.parts[0]).toMatchObject({ type: "tool_call", tool: "create_reminder", disposition: "do", outcome: "done" });
    const ref = items[1]!.message.parts[0]!;
    const display = ref.type === "card_ref" ? cardDisplay(state, ref.cardId) : undefined;
    expect(display).toMatchObject({ kind: "typed", type: "reminder", state: { card: { status: "pending", payload: { text: "交报告" } } } });
    expect(selectReminder(state, "r-1")?.status).toBe("pending");
    expect(inboxEntries(state, "open")).toEqual([]);
  });

  test("到点：待我处理顶部是置顶的提醒事项，界面要提示一次；提醒卡变成已触发", () => {
    const state = replay(inputs);
    const [top] = inboxEntries(state, "open");
    expect(top?.item).toMatchObject({ notice: "reminder_due", title: "提醒：交报告", pinned: true, read: false });
    expect(state.alerts).toMatchObject([{ title: "提醒：交报告", itemId: top?.item.id }]);
    expect(inboxBadge(state)).toEqual({ unread: 1, seenPending: 0 });
    expect(selectReminder(state, "r-1")?.status).toBe("fired");
    expect(cardDisplay(state, top!.item.cardId!)).toMatchObject({ kind: "typed", state: { card: { status: "expired", payload: { status: "fired" } } } });
  });
});

describe("回放：吊销一台已配对设备（device-revoke）", () => {
  // 录的是只订阅了"已配对设备"的设置页：两台设备配对，然后吊销了第一台
  const inputs = load("device-revoke");
  const revokedAt = inputs.findLastIndex(isFrame("device"));
  // "现在"取录制时的时刻（吊销的时间），录好的文件放多久都一样
  const last = (inputs[revokedAt] as Extract<UiInput, { kind: "frame" }>).frame.payload as DeviceEventPayload;
  const now = Date.parse(last.device.revokedAt!);

  test("吊销之前：两台设备都在已配对的列表里", () => {
    const before = pairedDevices(replay(inputs.slice(0, revokedAt)), now);
    expect(before.active.map((d) => d.name).toSorted()).toEqual(["家里的平板", "我的手机"]);
    expect(before.inactive).toEqual([]);
  });

  test("吊销事件之后：已配对设备列表少了这一台，它在失效的一组里", () => {
    const after = pairedDevices(replay(inputs), now);
    expect(after.active.map((d) => d.name)).toEqual(["家里的平板"]);
    expect(after.inactive).toMatchObject([{ reason: "revoked", device: { name: "我的手机", revoked: true } }]);
  });
});

describe("回放：这台设备被吊销（device-revoked-here）", () => {
  // 录的是被吊销的那台设备上开着的页面：连着的时候服务端关掉连接（4401），页面问了一下信任情况，得到"被吊销"
  const inputs = load("device-revoked-here");
  const state = replay(inputs);

  test("连接状态是 unpaired，原因是被吊销：配对等待页不自动申请，只显示\"此设备已被吊销\"和\"重新申请\"", () => {
    expect(inputs.at(-1)).toEqual({ kind: "connection", status: "unpaired", reason: "revoked" });
    expect([state.connection, state.unpairedReason]).toEqual(["unpaired", "revoked"]);
    expect(pairingOpening(state.unpairedReason, false)).toBe("revoked");
  });

  test("刷新页面之后服务端只回 none（凭证已经删了）：靠浏览器里留下的记号，仍然不自动申请", () => {
    // 那次问到"被吊销"时留下记号
    const marked = revokedMarkAfter(state.unpairedReason === undefined ? { access: "none" } : { access: "none", reason: state.unpairedReason }, false);
    expect(marked).toBe(true);
    // 刷新：新的状态里什么都没有，服务端只回 none
    const afterReload = revokedMarkAfter({ access: "none" }, marked);
    expect(pairingOpening(undefined, afterReload)).toBe("revoked");
    // 没有记号的浏览器（新设备）照常自动申请
    expect(pairingOpening(undefined, false)).toBe("request");
  });
});

/** 把会话视图压成"发言方:文字"，推理 part 记成 [reasoning]，乐观显示的条目带上自己的状态 */
function texts(items: readonly ConversationItem[]): string[] {
  return items.map((it) => {
    const text = it.message.parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
    return it.kind === "pending" ? `${it.message.speaker}:${text}（${it.status}）` : `${it.message.speaker}:${text}`;
  });
}
