// 前端状态层回放主切面录下的真实事件流（规格 Testing Decisions）。
// 录制在 packages/daemon/test/main/recordings.test.ts：真的守护进程 + faux 秘书，模拟前端经 WebSocket 收到的帧，
// 连同它自己的本地动作（发消息）和连接状态，原样存成 recordings/*.json。重新录的方法见那个文件。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ASSISTANT_NAME_MARK,
  type ActivityEventPayload,
  activityNote,
  type ActivityProgressEventPayload,
  agentActivity,
  boardGroups,
  type ConversationId,
  gistView,
  globalView,
  timelineGrouping,
  timelineItems,
  CARD_TYPE_VERSIONS,
  builtinChoices,
  cardDisplay,
  dayReasonLabel,
  describeSchedule,
  type CharterCardPayload,
  type ProjectEventPayload,
  projectViews,
  selectProject,
  type ConversationItem,
  conversationView,
  type DeviceEventPayload,
  inboxBadge,
  inboxEntries,
  type MessageEventPayload,
  type MessagePart,
  pairedDevices,
  type ParallelCardPayload,
  type PlanCardPayload,
  selectCard,
  selectTask,
  taskControls,
  taskStages,
  taskTokenTotal,
  taskUsage,
  pairingOpening,
  replay,
  resumeCursors,
  selectReminder,
  type UiInput,
  type UiState,
  revokedMarkAfter,
  type ReminderCardPayload,
  workdayCalendarOf,
  workdaySettingsOf,
  watchCategorySettings,
  projectPipeline,
  taskWaitingForProject,
  taskWorkOrders,
  type WorkOrderEventPayload,
  workOrderTaskId,
  projectScopeRecords,
  taskScopeRecords,
  type ScopeRecordEventPayload,
} from "../../src/state/index.ts";
import { msg } from "./events.ts";

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

/** 项目列表频道上某种变化的 project 事件 */
const projectEvent = (change: string) => (input: UiInput) =>
  input.kind === "frame" && input.frame.type === "project" && (input.frame.payload as ProjectEventPayload).change === change;

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
    expect(msg(streaming[1]!).id).toBe(final.message.id);
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
      .flatMap((it) => msg(it).parts)
      .find((p) => p.type === "card_ref");
    const cardId = ref?.type === "card_ref" ? ref.cardId : "";
    expect(cardDisplay(state, cardId)).toMatchObject({
      kind: "typed",
      type: "approval",
      state: { card: { status: "pending", urgency: "non_blocking", payload: { source: `${ASSISTANT_NAME_MARK}对话`, tool: "read", toolTitle: "读文件", categoryTitles: ["越出项目目录"] } } },
    });
    expect(inboxEntries(state, "open")).toMatchObject([{ item: { kind: "card", cardId, urgency: "non_blocking" }, processed: false }]);
    expect(inboxBadge(state)).toEqual({ unread: 1, seenPending: 0 });
  });

  test("批准之后：卡片已处理（待我处理里同一个事项也算处理过）；聊天里有这次调用的记录：先问我、越出项目目录、已执行", () => {
    const state = replay(inputs);
    expect(inboxEntries(state, "open")).toEqual([]);
    expect(inboxEntries(state, "done")).toMatchObject([{ processed: true, card: { card: { status: "handled", outcome: { action: "approve" } } } }]);
    const tool = view(state)
      .flatMap((it) => msg(it).parts)
      .find((p) => p.type === "tool_call");
    expect(tool).toMatchObject({ tool: "read", categoryTitles: ["越出项目目录"], disposition: "ask_first", genericBash: false, outcome: "done" });
    expect(texts(view(state)).at(-1)).toBe("agent:读到了：周五交房租。");
  });
});

describe("回放：秘书建的提醒到点（reminder-due）", () => {
  const inputs = load("reminder-due");
  const turnEnd = indexOf(inputs, isFrame("turn_end"));

  test("秘书建好提醒：聊天里一条只有卡片引用的消息（和这次工具调用的记录），提醒卡认识、待处理；看板上的提醒待触发", () => {
    const state = replay(inputs.slice(0, turnEnd + 1));
    const items = view(state);
    expect(items.map((it) => msg(it).parts.map((p) => p.type).join(","))).toEqual(["text", "card_ref", "tool_call", "text"]);
    expect(msg(items[2]!).parts[0]).toMatchObject({ type: "tool_call", tool: "create_reminder", disposition: "do", outcome: "done" });
    const ref = msg(items[1]!).parts[0]!;
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

describe("回放：彻底删除（memory-purge）", () => {
  const inputs = load("memory-purge");
  const action = inputs.findIndex((i) => i.kind === "card_action");

  test("秘书出的记忆删除卡认识、待核对，列出匹配的素材；聊天里原话还在", () => {
    const state = replay(inputs.slice(0, action));
    expect(texts(view(state))).toContain("user:下个月要搬家了，房东要卖房");
    const card = Object.values(state.cards).find((c) => c.card.type === "memory_delete")!;
    expect(cardDisplay(state, card.card.id)).toMatchObject({ kind: "typed", type: "memory_delete", state: { card: { status: "pending", payload: { mode: "purge", matches: [{ excerpt: "下个月要搬家了，房东要卖房" }] } } } });
    expect(inboxEntries(state, "open").map((e) => e.item.title)).toEqual(["核对要彻底删除的记忆（1 条）"]);
  });

  test("确认彻底删除后：聊天里那条原话变成\"已删除\"（不刷新也一样），卡片上的摘录去掉，界面里一个字都不剩", () => {
    const state = replay(inputs);
    const items = view(state);
    expect(items.map((it) => it.kind)).toContain("deleted");
    expect(texts(items)).not.toContain("user:下个月要搬家了，房东要卖房");
    expect(JSON.stringify(items)).not.toContain("房东要卖房");
    const card = Object.values(state.cards).find((c) => c.card.type === "memory_delete")!;
    expect(card.card).toMatchObject({ status: "handled", payload: { result: { mode: "purge", count: 1 }, matches: [{ excerpt: "", purged: true }] } });
    expect(JSON.stringify(state.cards)).not.toContain("房东要卖房");
  });
});

describe("回放：发起任务到计划确认（task-initiation）", () => {
  // 秘书按用户的话直接建任务 → 提问卡"全按推荐" → 维护者交计划，待我处理里出现计划卡 → 收窄一项授权后确认 → 任务排队，
  // 有执行名额马上开始第 1 阶段（13 号票）
  const inputs = load("task-initiation");
  const planCardEvent = indexOf(inputs, (i) => i.kind === "frame" && i.frame.type === "card" && (i.frame.payload as { card: { type: string } }).card.type === "plan");
  const confirm = indexOf(inputs, (i) => i.kind === "card_action" && i.action === "confirm");

  test("秘书建出任务：在看板的进行中（规划中）；聊天里出现提问卡", () => {
    const state = replay(inputs.slice(0, indexOf(inputs, isFrame("task")) + 1));
    expect(groupOfTask(state, "t-1")).toBe("active");
    expect(selectTask(state, "t-1")).toMatchObject({ state: "planning", origin: "request" });
    const card = Object.values(replay(inputs.slice(0, planCardEvent)).cards).find((c) => c.card.type === "questions")!;
    expect(cardDisplay(replay(inputs.slice(0, planCardEvent)), card.card.id)).toMatchObject({ kind: "typed", type: "questions" });
    expect(card.card).toMatchObject({ status: "handled", outcome: { action: "answer", note: "全按推荐" } });
  });

  test("维护者交了计划：任务挪到等我（待确认），待我处理里是这张计划卡、还没处理；卡上的阶段数就是看板上的 M", () => {
    const state = replay(inputs.slice(0, confirm));
    expect(groupOfTask(state, "t-1")).toBe("waiting");
    const task = selectTask(state, "t-1")!;
    expect(task).toMatchObject({ state: "awaiting_confirm", stages: { total: 2 } });
    const [entry] = inboxEntries(state, "open");
    expect(entry).toMatchObject({ processed: false, item: { kind: "card", cardId: task.planCardId } });
    const plan = selectCard(state, task.planCardId!)!;
    expect(plan.card).toMatchObject({ type: "plan", status: "pending" });
    expect((plan.card.payload as PlanCardPayload).plan.stages).toHaveLength(2);
  });

  test("点了确认：卡片先是处理中，收到更新后已处理（收窄的那一项写在卡上）；待我处理里算处理过；任务回到进行中（排队中，马上开始第 1/2 阶段）", () => {
    const sending = replay(inputs.slice(0, confirm + 1));
    const planCardId = selectTask(sending, "t-1")!.planCardId!;
    expect(selectCard(sending, planCardId)?.pending).toMatchObject({ action: "confirm", status: "sending" });
    const state = replay(inputs);
    expect(selectCard(state, planCardId)?.card).toMatchObject({ status: "handled", outcome: { action: "confirm", note: "收窄 1 项" }, payload: { narrowedGrants: ["push-report"] } });
    expect(inboxEntries(state, "done").map((e) => e.item.kind === "card" && e.item.cardId)).toEqual([planCardId]);
    expect(groupOfTask(state, "t-1")).toBe("active");
    const queued = replay(inputs.slice(0, indexOf(inputs, (i) => i.kind === "frame" && i.frame.type === "task" && (i.frame.payload as { change: string }).change === "started")));
    expect(selectTask(queued, "t-1")).toMatchObject({ state: "queued", stages: { total: 2 } });
    expect(selectTask(state, "t-1")).toMatchObject({ state: "running", stages: { total: 2, current: 1 } });
  });
});

/** 任务 t-1 的维护者会话 */
const maintainerView = (state: UiState) => conversationView(state, "maintainer:tm-1");

describe("回放：两阶段任务到完成、再返工（task-execution）", () => {
  // 13 号票：计划确认后开始执行；第一阶段脚本验收通过，第二阶段评审判定通过，任务自动完成；再返工第二阶段
  const inputs = load("task-execution");
  const taskFrames = inputs.flatMap((i, at) => (i.kind === "frame" && i.frame.type === "task" ? [{ at, payload: i.frame.payload as { change: string; stageId?: string } }] : []));
  const atChange = (change: string, nth = 0) => taskFrames.filter((f) => f.payload.change === change)[nth]!.at;
  const stateAt = (index: number) => replay(inputs.slice(0, index + 1));
  const stagesAt = (index: number) => taskStages(stateAt(index), "t-1").map((s) => [s.stageId, s.state]);

  test("确认前：阶段抽屉按计划列出两个阶段，都没开始；交付件、验收方式取自计划卡", () => {
    const state = stateAt(atChange("plan_confirmed") - 1);
    expect(taskStages(state, "t-1")).toMatchObject([
      { stageId: "s1", n: 1, state: "pending", deliverables: ["资料清单 sources.md"], acceptance: [{ criterion: "资料清单存在", method: "script" }] },
      { stageId: "s2", n: 2, state: "pending", dependsOn: ["s1"], acceptance: [{ method: "review" }] },
    ]);
  });

  test("开始执行：看板上在进行中，第 1/2 阶段；第一阶段进行中；能暂停、取消", () => {
    const state = stateAt(atChange("stage_started"));
    expect(groupOfTask(state, "t-1")).toBe("active");
    expect(selectTask(state, "t-1")).toMatchObject({ state: "running", stages: { total: 2, current: 1 } });
    expect(stagesAt(atChange("stage_started"))).toEqual([
      ["s1", "running"],
      ["s2", "pending"],
    ]);
    expect(taskControls(selectTask(state, "t-1")!).map((c) => c.action)).toEqual(["pause", "cancel"]);
  });

  test("第一阶段脚本验收通过、第二阶段开始：第 2/2 阶段；抽屉里第一阶段已验收，验收结果写着通过", () => {
    const index = atChange("stage_started", 1);
    const state = stateAt(index);
    expect(selectTask(state, "t-1")?.stages?.current).toBe(2);
    expect(taskStages(state, "t-1")[0]).toMatchObject({ state: "accepted", attempts: 1, acceptance: [{ method: "script", result: { passed: true } }] });
    expect(stagesAt(index)).toEqual([
      ["s1", "accepted"],
      ["s2", "running"],
    ]);
  });

  test("任务自动完成：挪到最近结束；两个阶段都已验收，第二阶段的结果是评审判定；会话里有两张验收结论的进度卡；只能返工", () => {
    const index = atChange("completed");
    const state = stateAt(index);
    expect(groupOfTask(state, "t-1")).toBe("ended");
    expect(taskStages(state, "t-1")[1]).toMatchObject({ state: "accepted", acceptance: [{ method: "review", result: { passed: true, note: "看过了，满足" } }] });
    const end = replay(inputs);
    const cards = maintainerView(end)
      .flatMap((it) => (it.kind === "message" ? it.message.parts : []))
      .flatMap((p) => (p.type === "card_ref" ? [selectCard(end, p.cardId)?.card] : []))
      .filter((c) => c?.type === "progress");
    expect(cards.map((c) => (c!.payload as { acceptance?: { judgedBy: string } }).acceptance?.judgedBy)).toEqual(["script", "review", "review"]);
    expect(taskControls(selectTask(state, "t-1")!)).toEqual([
      { action: "rework", label: "返工第 1 阶段", stageId: "s1" },
      { action: "rework", label: "返工第 2 阶段", stageId: "s2" },
    ]);
  });

  test("返工第二阶段：回到进行中，只有它被重开，第一阶段保持已验收；最后再次完成", () => {
    const index = atChange("rework");
    expect(groupOfTask(stateAt(index), "t-1")).toBe("active");
    expect(stagesAt(index)).toEqual([
      ["s1", "accepted"],
      ["s2", "pending"],
    ]);
    const end = replay(inputs);
    expect(selectTask(end, "t-1")).toMatchObject({ state: "done" });
    expect(taskStages(end, "t-1").map((s) => [s.stageId, s.state, s.attempts])).toEqual([
      ["s1", "accepted", 1],
      ["s2", "accepted", 2],
    ]);
  });
});

/** 并行确认卡的 card 事件 */
const isParallelCard = (input: UiInput) => input.kind === "frame" && input.frame.type === "card" && (input.frame.payload as { card: { type: string } }).card.type === "parallel";
/** 状态里那张并行确认卡 */
const cardIdOf = (state: UiState) => Object.values(state.cards).find((c) => c.card.type === "parallel")!.card.id;

describe("回放：并行确认卡被拒、照常串行做完（parallel-sequential）", () => {
  // 20 号票：执行中维护者提议把 s1、s2 派给两个子 agent 并行 → 待我处理里出现并行确认卡（不卡任务）→ 用户确认之前维护者照常
  // 先做完 s1、开始 s2 → 用户点"不并行，按顺序做"（附一句话）→ 维护者收到通知，照常做完 s2，任务完成。没拉起任何子 agent
  const inputs = load("parallel-sequential");
  const proposed = indexOf(inputs, isParallelCard);
  const decide = indexOf(inputs, (i) => i.kind === "card_action" && i.action === "sequential");

  test("提议之后：并行确认卡写明任务、为什么并行、两个子 agent 各做什么；待我处理里一项（不卡任务），维护者会话里有它的引用；任务仍在进行中", () => {
    const state = replay(inputs.slice(0, proposed + 3));
    const cardId = cardIdOf(state);
    const display = cardDisplay(state, cardId);
    expect(display).toMatchObject({ kind: "typed", type: "parallel", state: { card: { status: "pending", urgency: "non_blocking" } } });
    const payload = selectCard(state, cardId)!.card.payload as ParallelCardPayload;
    expect(payload).toMatchObject({ taskId: "t-1", taskTitle: "两个文件", reason: "两个阶段互不依赖，同时做省时间" });
    expect(payload.agents.map((a) => [a.agentId, a.stageId, a.instructions])).toEqual([
      ["sa-1", "s1", "写 a.txt，内容是 A"],
      ["sa-2", "s2", "写 b.txt，内容是 B"],
    ]);
    expect(inboxEntries(state, "open")).toMatchObject([{ item: { kind: "card", cardId, urgency: "non_blocking" }, processed: false }]);
    expect(groupOfTask(state, "t-1")).toBe("active");
    expect(selectTask(state, "t-1")).toMatchObject({ state: "running" });
    const end = replay(inputs);
    const refs = maintainerView(end).flatMap((it) => (it.kind === "message" ? it.message.parts : [])).filter((p) => p.type === "card_ref" && p.cardId === cardId);
    expect(refs).toHaveLength(1);
  });

  test("用户处理之前：维护者照常先做完 s1（脚本验收通过），开始 s2；卡片还没处理", () => {
    const state = replay(inputs.slice(0, decide));
    expect(taskStages(state, "t-1").map((s) => [s.stageId, s.state])).toEqual([
      ["s1", "accepted"],
      ["s2", "running"],
    ]);
    expect(selectCard(state, cardIdOf(state))?.card.status).toBe("pending");
  });

  test("点“不并行，按顺序做”：卡片先是处理中，收到更新后已处理；待我处理里算处理过；维护者会话里一条通知（附用户写的话）；最后任务完成", () => {
    const sending = replay(inputs.slice(0, decide + 1));
    const cardId = cardIdOf(sending);
    expect(selectCard(sending, cardId)?.pending).toMatchObject({ action: "sequential", status: "sending" });
    const end = replay(inputs);
    expect(selectCard(end, cardId)?.card).toMatchObject({ status: "handled", outcome: { action: "sequential", note: "按顺序就行" } });
    expect(inboxEntries(end, "open")).toEqual([]);
    expect(inboxEntries(end, "done").map((e) => e.item.cardId)).toContain(cardId);
    const notice = maintainerView(end).find((it) => it.kind === "message" && it.message.speaker === "system" && JSON.stringify(it.message.parts).includes("没同意并行"));
    expect(JSON.stringify(notice)).toContain("按顺序就行");
    expect(selectTask(end, "t-1")).toMatchObject({ state: "done" });
    expect(groupOfTask(end, "t-1")).toBe("ended");
    expect(taskStages(end, "t-1").map((s) => [s.stageId, s.state])).toEqual([
      ["s1", "accepted"],
      ["s2", "accepted"],
    ]);
  });
});

describe("回放：维护者用带类型的 bash 工具干活（typed-shell-tools）", () => {
  // 录制在 packages/daemon/test/main/typed-shell.test.ts：看状态和差异 → 提交 → 建远端仓库（问过）→ 没跑测试就推送（退回）→
  // 测试没通过 → 推送仍退回 → 测试通过 → 推送（问过）→ force push 两次（一律禁止）→ 合并有冲突 → 合并 → 构建 → 装依赖。
  // 时间线上的样式归 25 号票；这里断言工具调用 part 的字段（判定、授权内、通用 bash、结果）
  const inputs = load("typed-shell-tools");
  const maintainer = "maintainer:tm-1";
  const toolCalls = (state: UiState) =>
    conversationView(state, maintainer)
      .flatMap((it) => msg(it).parts)
      .filter((p): p is Extract<MessagePart, { type: "tool_call" }> => p.type === "tool_call");

  test("时间线的要点层和全局层上：提交、合并、装依赖是“做完告诉我”的样式，推送（问过、退回）和 force push 是“被拦下或问过”的样式；只有 bash 那条带“通用 bash”标记", () => {
    const state = replay(inputs);
    const marks = gistView(state, maintainer).flatMap((r) => (r.kind === "marks" ? r.marks : []));
    const styleOf = (tool: string) => marks.filter((m) => m.kind === "tool" && m.toolCall?.tool === tool).map((m) => m.style ?? null);
    expect(styleOf("git_commit")).toEqual(["notify"]);
    expect(styleOf("git_merge")).toEqual(["notify", "notify"]);
    expect(styleOf("install_deps")).toEqual(["notify"]);
    expect(styleOf("git_push")).toEqual(["stopped", "stopped", "stopped", "stopped"]);
    // 同属"被拦下或问过"：按规则退回、永不的是被拦下（写明原因），批准后执行的是问过
    expect(marks.filter((m) => m.toolCall?.tool === "git_push").map((m) => [m.reason, m.outcome ?? null])).toEqual([
      ["blocked", "按规则退回"],
      ["blocked", "按规则退回"],
      ["asked", null],
      ["blocked", "被拦下"],
    ]);
    expect(styleOf("bash")).toEqual(["stopped"]);
    expect(marks.filter((m) => m.genericBash).map((m) => m.toolCall?.tool)).toEqual(["bash"]);
    // 全局层：同样的标记落在色块上
    const blockMarks = globalView(state, maintainer).flatMap((b) => b.marks);
    expect(blockMarks.map((m) => [m.toolCall?.tool, m.style ?? null, m.genericBash])).toEqual(marks.map((m) => [m.toolCall?.tool, m.style ?? null, m.genericBash]));
  });

  test("提交、合并、装依赖按“做完告诉我”出现；推送按“问过”（先问我、已执行）出现；都不带“通用 bash”标记，只有 bash 里的 force push 带", () => {
    const parts = toolCalls(replay(inputs));
    const gist = (tool: string) => parts.filter((p) => p.tool === tool).map((p) => ({ disposition: p.disposition, outcome: p.outcome, blockedBy: p.blockedBy, genericBash: p.genericBash, withinGrant: p.withinGrant }));
    expect(gist("git_commit")).toEqual([{ disposition: "do_then_tell", outcome: "done", blockedBy: undefined, genericBash: false, withinGrant: false }]);
    expect(gist("git_merge").map((p) => [p.disposition, p.outcome])).toEqual([
      ["do_then_tell", "error"],
      ["do_then_tell", "done"],
    ]);
    expect(gist("install_deps")).toEqual([{ disposition: "do_then_tell", outcome: "done", blockedBy: undefined, genericBash: false, withinGrant: false }]);
    expect(gist("git_push").map((p) => [p.disposition, p.blockedBy, p.outcome])).toEqual([
      ["ask_first", "pull_back", "blocked"],
      ["ask_first", "pull_back", "blocked"],
      ["ask_first", undefined, "done"],
      ["never", undefined, "blocked"],
    ]);
    expect(parts.filter((p) => p.genericBash).map((p) => p.tool)).toEqual(["bash"]);
    expect(parts.find((p) => p.tool === "git_push" && p.outcome === "done")!.categoryTitles).toEqual(["以我的名义对外发送或发布"]);
  });

  test("推送和建远端仓库的审批卡：认识、已批准；聊天里、待我处理里是同一张", () => {
    const state = replay(inputs);
    const approvals = Object.values(state.cards).filter((c) => c.card.type === "approval");
    expect(approvals.map((c) => [(c.card.payload as { tool: string }).tool, c.card.status, c.card.outcome?.action])).toEqual([
      ["create_remote_repo", "handled", "approve"],
      ["git_push", "handled", "approve"],
    ]);
    for (const c of approvals) expect(cardDisplay(state, c.card.id)).toMatchObject({ kind: "typed", type: "approval" });
    expect(inboxEntries(state, "done").map((e) => e.item.kind === "card" && e.item.cardId).toSorted()).toEqual(approvals.map((c) => c.card.id).toSorted());
  });
});

/** 看板上（唯一的）那张任务卡 */
const taskCard = (s: UiState) => boardGroups(s).flatMap((g) => g.items).find((i) => i.kind === "task");

describe("回放：时间线的缩放和活动状态（timeline-zoom）", () => {
  // 录制在 packages/daemon/test/main/timeline.test.ts：两阶段任务，第一阶段里写文件、通用 bash（ls）、授权内的建目录（bash）、
  // 做完告诉我的提交、问过的读主目录（审批卡、批准）、脚本验收；第二阶段写报告、写围栏外被硬拒绝、脚本验收，任务完成，维护者闲置退出
  const inputs = load("timeline-zoom");
  const maintainer = "maintainer:tm-1";
  const state = replay(inputs);
  const activityAt = (match: (p: ActivityEventPayload) => boolean) => indexOf(inputs, (i) => i.kind === "frame" && i.frame.type === "activity" && match(i.frame.payload as ActivityEventPayload));

  test("要点层：只剩关注类别命中、审批、验收、通用 bash 和被拦下的这些要点，其余收起", () => {
    const rows = gistView(state, maintainer);
    const line = (r: (typeof rows)[number]) =>
      r.kind === "folded" ? "…" : r.marks.map((m) => (m.kind === "tool" ? `${m.toolCall!.tool}${m.style ? `[${m.style}]` : ""}${m.genericBash ? "{通用 bash}" : ""}` : m.kind)).join("|");
    expect(rows.map(line)).toEqual(["…", "bash{通用 bash}", "bash[granted]{通用 bash}", "git_commit[notify]", "approval", "read[stopped]", "…", "acceptance", "…", "write[stopped]", "…", "acceptance", "…"]);
    const marks = rows.flatMap((r) => (r.kind === "marks" ? r.marks : []));
    // 关注类别命中写在要点上（问过的）；被硬拒绝的写明原因；审批要点带着审批卡（界面按卡片的处理结果写批了没有）；验收写明通过和怎么判的
    expect(marks.find((m) => m.toolCall?.tool === "read")).toMatchObject({ categories: ["越出项目目录"], style: "stopped", reason: "asked" });
    expect(marks.find((m) => m.toolCall?.tool === "write")).toMatchObject({ style: "stopped", reason: "blocked", outcome: "硬拒绝" });
    const approval = marks.find((m) => m.kind === "approval")!;
    expect(state.cards[approval.cardId!]?.card).toMatchObject({ type: "approval", status: "handled", outcome: { action: "approve" } });
    expect(marks.filter((m) => m.kind === "acceptance").map((m) => m.title)).toEqual(["第 1 阶段「整理笔记」验收通过（脚本检查）", "第 2 阶段「写报告」验收通过（脚本检查）"]);
  });

  test("三种情形三种样式：授权内放行、做完告诉我、被拦下或问过各不相同；没有处置可说的通用 bash 不带样式", () => {
    const marks = gistView(state, maintainer).flatMap((r) => (r.kind === "marks" ? r.marks : []));
    expect(marks.filter((m) => m.kind === "tool").map((m) => m.style ?? null)).toEqual([null, "granted", "notify", "stopped", "stopped"]);
  });

  test("全局层：任务的维护者会话按阶段聚成色块（规划、第 1 阶段、第 2 阶段），色块上仍标出这些要点", () => {
    expect(timelineGrouping(state, maintainer)).toBe("stage");
    const blocks = globalView(state, maintainer);
    expect(blocks.map((b) => b.title)).toEqual(["规划", "第 1 阶段 · 整理笔记", "第 2 阶段 · 写报告"]);
    expect(blocks.map((b) => b.marks.map((m) => (m.kind === "tool" ? m.toolCall!.tool : m.kind)))).toEqual([[], ["bash", "bash", "git_commit", "approval", "read", "acceptance"], ["write", "acceptance"]]);
    expect(new Set(blocks.map((b) => b.tone)).size).toBe(3);
    // 完整视图里的条目一条不少地分进了色块
    expect(blocks.reduce((n, b) => n + b.count, 0)).toBe(timelineItems(state, maintainer).length);
  });

  test("活动状态小圆点：被唤起、干活中（附带在做什么）、等你批准、闲置退出时跟着变；看板的任务卡上就是它的维护者", () => {
    const woken = replay(inputs.slice(0, activityAt((p) => p.agentId === "tm-1" && p.detail?.kind === "woken") + 1));
    expect(taskCard(woken)).toMatchObject({ activity: { state: "working", detail: { kind: "woken" } } });
    const commit = { kind: "calling_tool", tool: "git 提交" };
    const progressAt = indexOf(inputs, (i) => i.kind === "frame" && i.frame.type === "activity_progress" && JSON.stringify((i.frame.payload as ActivityProgressEventPayload).detail) === JSON.stringify(commit));
    const committing = agentActivity(replay(inputs.slice(0, progressAt + 1)), "tm-1");
    expect(committing).toEqual({ state: "working", detail: commit });
    expect(activityNote(committing)).toBe("调用：git 提交");
    const waiting = replay(inputs.slice(0, activityAt((p) => p.agentId === "tm-1" && p.state === "waiting_for_user") + 1));
    expect(taskCard(waiting)).toMatchObject({ activity: { state: "waiting_for_user", detail: { kind: "approval", tool: "读文件" } } });
    // 等你批准时任务还是执行中：活动状态不改任务状态
    expect(selectTask(waiting, "t-1")?.state).toBe("running");
    expect(agentActivity(state, "tm-1")).toEqual({ state: "sleeping", detail: { kind: "idle_exit" } });
    expect(selectTask(state, "t-1")?.state).toBe("done");
  });
});

/** 要点层里的要点：种类和一句话 */
const gistTitles = (s: UiState, conversation: ConversationId) => gistView(s, conversation).flatMap((r) => (r.kind === "marks" ? r.marks.map((m) => `${m.kind}:${m.title}`) : []));

describe("回放：往上翻取回旧页里的时间线记录（timeline-history）", () => {
  // 录制在 packages/daemon/test/main/history.test.ts：维护者会话、秘书会话各 60 条消息，第一次补发只到最近 50 条；
  // 维护者会话里旧页有一条偏离（第一阶段）、最近一页有一条范围变更；秘书会话旧页、最近一页各有一次快速动作的执行
  const inputs = load("timeline-history");
  const maintainer = "maintainer:tm-1";
  const firstPage = indexOf(inputs, (i) => i.kind === "history_page");
  const before = replay(inputs.slice(0, firstPage));
  const after = replay(inputs);

  test("翻回来之前：要点层只有最近一页里的范围变更、操作记录", () => {
    expect(gistTitles(before, maintainer)).toEqual(["scope_change:加了一个导出步骤"]);
    expect(gistTitles(before, "secretary")).toEqual(["operation:记住：周三体检"]);
  });

  test("翻回来之后：旧页里的偏离、操作记录按序号排进时间线，要点层、全局层都看得到", () => {
    expect(gistTitles(after, maintainer)).toEqual(["deviation:计划外读了一次参考资料", "scope_change:加了一个导出步骤"]);
    expect(gistTitles(after, "secretary")).toEqual(["operation:记住：周三体检", "operation:记住：周三体检"]);
    const items = timelineItems(after, maintainer);
    expect(items.map((it) => it.seq)).toEqual(items.map((_it, i) => i + 1));
    // 全局层按已加载的部分聚块：偏离落在第一阶段那一块上
    const blocks = globalView(after, maintainer);
    expect(blocks.map((b) => [b.title, b.marks.map((m) => m.kind)])).toEqual([
      ["阶段 s1", ["deviation"]],
      ["阶段 s2", ["scope_change"]],
    ]);
    expect(blocks.reduce((n, b) => n + b.count, 0)).toBe(items.length);
  });
});

describe("回放：设置里的关注类别（watch-categories）", () => {
  const inputs = load("watch-categories");
  const settingsFrames = inputs.flatMap((i, at) => (i.kind === "frame" && i.frame.type === "watch_category_settings" ? [at] : []));

  test("一订阅就有设置：内置九类（对话、任务两套处置，计划外工单的对话一栏不适用）、两条底线，还没有自己加的类别", () => {
    const first = watchCategorySettings(replay(inputs.slice(0, settingsFrames[0]! + 1)))!;
    expect(first.builtin).toHaveLength(9);
    expect(first.builtin.find((c) => c.id === "unplanned_work_order")).toMatchObject({ chat: null, task: "ask_first" });
    expect(builtinChoices(first.builtin.find((c) => c.id === "delete_or_overwrite")!, "task")).toEqual(["do_then_tell", "planned_only", "ask_first", "hand_to_me", "never"]);
    expect(first.bottomLines.map((b) => b.disposition)).toEqual(["hand_to_me", "never"]);
    expect(first.custom).toEqual([]);
  });

  test("新建、往松里改处置、调严内置类别：每次设置页跟着变；想调松内置类别被拒，原因交给界面提示；删掉之后自定义类别没了", () => {
    const afterCreate = watchCategorySettings(replay(inputs.slice(0, settingsFrames[1]! + 1)))!;
    expect(afterCreate.custom).toEqual([{ id: "c-1", title: "动数据库迁移目录", match: { paths: ["D:\\code\\app\\db\\migrations"] }, chat: "ask_first", task: "ask_first" }]);
    expect(watchCategorySettings(replay(inputs.slice(0, settingsFrames[2]! + 1)))!.custom[0]).toMatchObject({ task: "do" });
    expect(watchCategorySettings(replay(inputs.slice(0, settingsFrames[3]! + 1)))!.builtin.find((c) => c.id === "delete_or_overwrite")).toMatchObject({ task: "ask_first", defaults: { task: "do_then_tell" } });
    const state = replay(inputs);
    expect(state.failures).toEqual([expect.objectContaining({ idempotencyKey: "k-loosen", error: expect.stringMatching(/只能往严里调/) })]);
    expect(watchCategorySettings(state)!.custom).toEqual([]);
    expect(watchCategorySettings(state)!.builtin.find((c) => c.id === "delete_or_overwrite")?.task).toBe("ask_first");
  });
});

describe("回放：项目的一生（project-lifecycle）", () => {
  // 录制在 packages/daemon/test/main/projects.test.ts 的"演示流程"：建议立项 → 立项 → 立项问答（开发类、绑定外部路径）
  // → 立项书卡"确认并开工" → 首个建设任务完成转使用中 → 停用、重新启用；另一个项目放弃、取消归档、再放弃、删除
  const inputs = load("project-lifecycle");
  const at = (change: string) => replay(inputs.slice(0, indexOf(inputs, projectEvent(change)) + 1));

  test("点了“立项”：项目以筹备中出现在项目列表，维护者会话里有一条说明", () => {
    const state = at("created");
    expect(projectViews(state).map((v) => [v.project.name, v.project.state, v.activeTasks])).toEqual([["记账本", "preparing", 0]]);
    expect(selectProject(state, "p-1")?.actions).toEqual(["abandon"]);
  });

  test("立项书卡：显示项目类型和外部工作目录绑定；确认并开工后已处理，项目转建设中、带首个建设任务，进行中任务 1", () => {
    const submitted = at("charter_submitted");
    const cardId = selectProject(submitted, "p-1")!.project.charterCardId!;
    const charter = selectCard(submitted, cardId)!.card;
    expect(charter).toMatchObject({ type: "charter", status: "pending" });
    expect((charter.payload as CharterCardPayload).charter).toMatchObject({ kind: "dev", bindExternal: true, externalPath: expect.stringMatching(/^<临时目录>\\ergou-repo-.+\\ledger$/) });
    expect(cardDisplay(submitted, cardId)?.kind).toBe("typed");

    const started = at("building_started");
    expect(selectProject(started, "p-1")).toMatchObject({ project: { state: "building", kind: "dev", workdir: { external: true }, toolkit: { bash: true }, buildTaskId: "t-1" }, activeTasks: 1 });
    const state = replay(inputs);
    expect(selectCard(state, cardId)?.card).toMatchObject({ status: "handled", outcome: { action: "confirm_start" }, payload: { confirmed: { start: true, buildTaskId: "t-1" } } });
  });

  test("首个建设任务完成：项目自动转使用中；停用、重新启用之后还是使用中", () => {
    expect(selectProject(at("in_use"), "p-1")).toMatchObject({ project: { state: "in_use" }, activeTasks: 0, actions: ["retire", "archive"] });
    expect(selectProject(at("retired"), "p-1")?.actions).toEqual(["reactivate", "archive"]);
    expect(selectProject(at("reactivated"), "p-1")?.project.state).toBe("in_use");
  });

  test("另一个项目放弃到已归档（只读）、取消归档、再放弃，删除的二次确认在待我处理里；确认后项目和它的维护者会话都不在了", () => {
    expect(selectProject(at("abandoned"), "p-2")).toMatchObject({ project: { state: "archived", archivedFrom: "preparing" }, actions: ["unarchive", "delete"] });
    expect(selectProject(at("unarchived"), "p-2")?.project.state).toBe("preparing");
    const state = replay(inputs);
    expect(projectViews(state).map((v) => [v.project.id, v.project.state])).toEqual([["p-1", "in_use"]]);
    expect(state.conversations["maintainer:pm-2"]).toBeUndefined();
    expect(conversationView(state, "maintainer:pm-1").length).toBeGreaterThan(0);
    const deletion = inboxEntries(state, "done").find((e) => e.item.kind === "notice" && e.item.notice === "project_delete");
    expect(deletion?.item).toMatchObject({ title: "删除项目「家电档案」？", handled: "确认删除" });
  });
});

describe("回放：两个任务排进同一项目（work-orders-queue）", () => {
  // 录制在 packages/daemon/test/main/work-orders.test.ts 的"派单"：给同一个项目连发两个单项目任务，
  // 第二个的工单排着（等项目 X），前一张结束后自动开始；计划确认后第二个任务留在排队中，第一个做完它自动开始
  const inputs = load("work-orders-queue");
  const at = (change: string, taskId: string, kind: string) => replay(inputs.slice(0, indexOf(inputs, orderEvent(change, taskId, kind)) + 1));

  test("第二个任务的起草计划工单排着：流水线上排队中，看板上它标“等项目 记账本”；第一个没有标", () => {
    const state = at("created", "t-2", "plan");
    expect(lanes(state)).toEqual({ queued: ["t-2 起草计划"], active: ["t-1 起草计划"], ended: [] });
    expect(taskWaitingForProject(state, "t-2")).toBe("记账本");
    expect(taskWaitingForProject(state, "t-1")).toBeUndefined();
    expect(boardTask(state, "t-2")).toMatchObject({ waitingForProject: "记账本" });
    const [queued] = projectPipeline(state, "p-1").queued;
    expect(queued).toMatchObject({ source: "你", status: "待接", stage: "规划中", workOrder: { taskTitle: "记账本出月报" } });
  });

  test("前一张结束后它自动开始，不再标“等项目”", () => {
    const state = at("started", "t-2", "plan");
    expect(lanes(state)).toEqual({ queued: [], active: ["t-2 起草计划"], ended: ["t-1 起草计划"] });
    expect(taskWaitingForProject(state, "t-2")).toBeUndefined();
  });

  test("计划确认后项目正忙：第二个任务留在排队中、标“等项目 记账本”；进行中的工单显示所属任务现在到哪了", () => {
    const state = at("created", "t-2", "execute");
    expect(selectTask(state, "t-2")?.state).toBe("queued");
    expect(taskWaitingForProject(state, "t-2")).toBe("记账本");
    expect(lanes(state).queued).toEqual(["t-2 执行"]);
    expect(lanes(state).active).toEqual(["t-1 执行"]);
    expect(projectPipeline(state, "p-1").active[0]!.stage).toMatch(/^执行中 · 第 1\/1 阶段「写出来」$/);
  });

  test("第一个做完，第二个自动开始；最后都结束，流水线的已结束最近的在前；维护者会话里每张工单一条分隔线", () => {
    const started = at("started", "t-2", "execute");
    expect(taskWaitingForProject(started, "t-2")).toBeUndefined();
    expect(selectTask(started, "t-1")?.state).toBe("done");
    const state = replay(inputs);
    expect(lanes(state)).toEqual({ queued: [], active: [], ended: ["t-2 执行", "t-1 执行", "t-2 起草计划", "t-1 起草计划"] });
    expect(projectPipeline(state, "p-1").ended.map((v) => v.status)).toEqual(["已结束 · 完成", "已结束 · 完成", "已结束 · 完成", "已结束 · 完成"]);
    const dividers = conversationView(state, "maintainer:pm-1").flatMap((it) => (it.kind === "message" ? it.message.parts.filter((p) => p.type === "work_order_divider") : []));
    expect(dividers.map((p) => (p as Extract<MessagePart, { type: "work_order_divider" }>).title)).toEqual(["起草计划：记账本出周报", "起草计划：记账本出月报", "执行：记账本出周报", "执行：记账本出月报"]);
  });
});

/** 某种范围记录的 scope_record 事件 */
const isScopeRecord = (kind: string) => (input: UiInput) => input.kind === "frame" && input.frame.type === "scope_record" && (input.frame.payload as ScopeRecordEventPayload).record.kind === kind;
const summaries = (views: readonly { record: { summary: string } }[]) => views.map((v) => v.record.summary);
/** 待我处理里还没处理的越界通知 */
const openOutOfScopeNotices = (state: UiState) => inboxEntries(state, "open").filter((e) => e.item.kind === "notice" && e.item.notice === "out_of_scope");

describe("回放：范围审视（scope-review）", () => {
  // 录制在 packages/daemon/test/main/scope-review.test.ts 的第一个用例（只录了项目列表、待我处理、看板三个频道）：
  // 项目任务的执行工单结束时审视出一条越界；之后用户在维护者会话里说"先帮我做下 X"，压缩会话时审视出一条范围变更
  const inputs = load("scope-review");

  test("越界记下之后：项目页的范围记录里越界一组有它（写明工单结束时、哪张工单），任务详情里也有；待我处理里一条未读的越界通知，小红点亮着", () => {
    // 同一事务里的越界通知紧跟在范围记录之后到达
    const state = replay(inputs.slice(0, indexOf(inputs, isFrame("inbox_item"), indexOf(inputs, isScopeRecord("out_of_scope"))) + 1));
    const project = projectScopeRecords(state, "p-1");
    expect(summaries(project.out_of_scope)).toEqual(["顺手改了立项书范围外的 README"]);
    expect(project.scope_change).toEqual([]);
    expect(project.out_of_scope[0]).toMatchObject({ kind: "越界", trigger: "工单结束时" });
    expect(project.out_of_scope[0]!.where).toMatch(/^工单 wo-\d+ · 任务 t-1「给记账本加周报」$/);
    expect(summaries(taskScopeRecords(state, "t-1").out_of_scope)).toEqual(["顺手改了立项书范围外的 README"]);
    const [notice] = openOutOfScopeNotices(state);
    expect(notice!.item).toMatchObject({ read: false, urgency: "non_blocking", actions: ["知道了"] });
    expect(notice!.item.title).toBe("越界：顺手改了立项书范围外的 README");
    expect(inboxBadge(state).unread).toBe(1);
  });

  test("最后：范围变更另一组（压缩会话时、带依据，不属于任务），越界通知还是那一条", () => {
    const state = replay(inputs);
    const project = projectScopeRecords(state, "p-1");
    expect(summaries(project.scope_change)).toEqual(["按用户说的先导出了分类表 CSV"]);
    expect(project.scope_change[0]).toMatchObject({ kind: "范围变更", trigger: "压缩会话时", where: undefined, record: { basis: "用户在会话里说：先帮我做下 X" } });
    expect(summaries(project.out_of_scope)).toEqual(["顺手改了立项书范围外的 README"]);
    expect(taskScopeRecords(state, "t-1").scope_change).toEqual([]);
    expect(openOutOfScopeNotices(state)).toHaveLength(1);
    expect(inboxBadge(state).unread).toBe(1);
  });
});

describe("回放：涉及多个项目的任务：派单 → 一张退回 → 重派 → 全部完成（multi-project）", () => {
  // 录制在 packages/daemon/test/main/multi-project.test.ts 的"派单、回执和阶段验收"：任务涉及记账本（s1）、家电档案（s2），
  // 计划确认时两行各建出一张工单，s1 开始时派出记账本的；记账本完成、s1 验收通过后派出家电档案的，它被退回；
  // 任务维护者调整做法重新派单（算一次验收退回），这张完成后 s2 验收通过、任务完成
  const inputs = load("multi-project");
  const at = (change: string, workOrderId: string) => replay(inputs.slice(0, indexOf(inputs, workOrderEvent(change, workOrderId)) + 1));

  test("计划确认、s1 开始：两张工单都在任务详情里——记账本的派出了，家电档案的等阶段开始、不在家电档案的流水线上", () => {
    const state = at("dispatched", "wo-1");
    expect(workOrderRows(state)).toEqual(["wo-1 记账本 待接 | 第 1 阶段「记账本加导出」 · 进行中", "wo-2 家电档案 等阶段开始 | 第 2 阶段「家电档案接导入」 · 未开始"]);
    expect(projectPipeline(state, "p-2")).toEqual({ queued: [], active: [], ended: [] });
    expect(projectPipeline(state, "p-1").queued.map((v) => [v.workOrder.id, v.source])).toEqual([["wo-1", "任务维护者"]]);
    expect(taskStages(state, "t-1").map((s) => s.state)).toEqual(["running", "pending"]);
  });

  test("家电档案退回：工单列表上已结束 · 退回（附理由），s2 还在做；回执作为消息进了任务维护者的会话", () => {
    const state = at("ended", "wo-2");
    expect(workOrderRows(state)).toEqual(["wo-1 记账本 已结束 · 完成 | 第 1 阶段「记账本加导出」 · 已验收", "wo-2 家电档案 已结束 · 退回 | 第 2 阶段「家电档案接导入」 · 进行中"]);
    expect(taskWorkOrders(state, "t-1")[1]!.workOrder.reason).toBe("会改动家电档案现有的表结构，伤害本项目");
    const before = replay(inputs.slice(0, indexOf(inputs, workOrderEvent("created", "wo-3"))));
    const receipts = texts(conversationView(before, "maintainer:tm-1")).filter((t) => t.includes("的回执："));
    expect(receipts.map((t) => t.match(/工单 wo-\d+「[^」]*」的回执：项目「[^」]+」[^。\n]+/)?.[0])).toEqual([
      "工单 wo-1「加一个导出说明 export.md」的回执：项目「记账本」完成",
      "工单 wo-2「按记账本的导出说明加导入说明 import.md」的回执：项目「家电档案」退回",
    ]);
  });

  test("重派之后全部完成：任务已完成、两个阶段都已验收；工单列表按阶段排：记账本的、家电档案退回的那张、重派完成的那张；家电档案的流水线上两张都在已结束", () => {
    const state = replay(inputs);
    expect(selectTask(state, "t-1")?.state).toBe("done");
    expect(taskStages(state, "t-1").map((s) => s.state)).toEqual(["accepted", "accepted"]);
    expect(workOrderRows(state)).toEqual([
      "wo-1 记账本 已结束 · 完成 | 第 1 阶段「记账本加导出」 · 已验收",
      "wo-2 家电档案 已结束 · 退回 | 第 2 阶段「家电档案接导入」 · 已验收",
      "wo-3 家电档案 已结束 · 完成 | 第 2 阶段「家电档案接导入」 · 已验收",
    ]);
    expect(taskWorkOrders(state, "t-1").map((v) => v.unplanned)).toEqual([false, false, false]);
    expect(projectPipeline(state, "p-2").ended.map((v) => v.workOrder.id)).toEqual(["wo-3", "wo-2"]);
  });
});

/** t-1 的工单列表压成"工单 项目 状态 | 所属阶段" */
function workOrderRows(state: UiState) {
  return taskWorkOrders(state, "t-1").map((v) => `${v.workOrder.id} ${v.project} ${v.status} | ${v.stage}`);
}

/** 项目列表频道上某张工单的某种变化 */
function workOrderEvent(change: string, workOrderId: string) {
  return (input: UiInput) => {
    if (input.kind !== "frame" || input.frame.type !== "work_order") return false;
    const p = input.frame.payload as WorkOrderEventPayload;
    return p.change === change && p.workOrder.id === workOrderId;
  };
}

/** 项目列表频道上某个任务、某种工单的某种变化 */
function orderEvent(change: string, taskId: string, kind: string) {
  return (input: UiInput) => {
    if (input.kind !== "frame" || input.frame.type !== "work_order") return false;
    const p = input.frame.payload as WorkOrderEventPayload;
    return p.change === change && workOrderTaskId(p.workOrder) === taskId && p.workOrder.kind === kind;
  };
}

/** p-1 的工单流水线压成"任务 要做的事" */
function lanes(state: UiState) {
  const pipeline = projectPipeline(state, "p-1");
  const names = (xs: typeof pipeline.queued) => xs.map((v) => `${workOrderTaskId(v.workOrder)} ${v.kind}`);
  return { queued: names(pipeline.queued), active: names(pipeline.active), ended: names(pipeline.ended) };
}

/** 看板上的某个任务 */
function boardTask(state: UiState, taskId: string) {
  return boardGroups(state)
    .flatMap((g) => g.items)
    .find((i) => i.kind === "task" && i.task.id === taskId);
}

/** 任务在看板的哪一组 */
function groupOfTask(state: UiState, taskId: string) {
  return boardGroups(state).find((g) => g.items.some((i) => i.kind === "task" && i.task.id === taskId))?.group;
}

/** 把会话视图压成"发言方:文字"，推理 part 记成 [reasoning]，乐观显示的条目带上自己的状态 */
function texts(items: readonly ConversationItem[]): string[] {
  return items.map((it) => {
    if (it.kind === "deleted") return "（已删除）";
    const text = it.message.parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
    return it.kind === "pending" ? `${it.message.speaker}:${text}（${it.status}）` : `${it.message.speaker}:${text}`;
  });
}

describe("回放：设置里的工作日历和按我的工作日的提醒（workday-calendar）", () => {
  const inputs = load("workday-calendar");
  const state = replay(inputs);
  const brief = (date: string) => {
    const day = workdayCalendarOf(state)!.day(date);
    return [day.workday ? "上班" : "休息", ...day.reasons.map(dayReasonLabel)];
  };

  test("工作日历页：框架自带的节假日数据加改过的个人设置，每天标明上班或休息及原因", () => {
    expect(brief("2026-10-01")).toEqual(["上班", "新加坡工作日"]);
    expect(brief("2026-10-08")).toEqual(["上班", "新加坡工作日", "国内工作日"]);
    expect(brief("2026-10-09")).toEqual(["休息", "手动标记休息"]);
    expect(brief("2026-10-10")).toEqual(["上班", "调休补班"]);
    expect(brief("2026-10-11")).toEqual(["休息", "周末"]);
    expect(brief("2026-10-31")).toEqual(["上班", "额外规则：每月最后一个周六"]);
    expect(brief("2026-11-09")).toEqual(["上班", "国内工作日"]);
    expect(workdayCalendarOf(state)!.missing(2027)).toEqual(["cn"]);
    expect(workdaySettingsOf(state)).toEqual({ rules: [{ kind: "last_weekday", weekday: 6 }], marks: [{ date: "2026-10-09", mark: "rest" }] });
  });

  test("提醒卡：显示\"按我的工作日 09:00\"，下一次跟着工作日历变到 10 月 10 日", () => {
    const cardId = Object.keys(state.cards)[0]!;
    const display = cardDisplay(state, cardId);
    expect(display).toMatchObject({ kind: "typed", type: "reminder", state: { card: { status: "pending" } } });
    const payload = state.cards[cardId]!.card.payload as ReminderCardPayload;
    expect(describeSchedule(payload.schedule!)).toBe("按我的工作日 09:00");
    expect(payload.nextAt?.slice(0, 16)).toBe("2026-10-10T09:00");
    expect(selectReminder(state, "r-1")?.nextAt?.slice(0, 16)).toBe("2026-10-10T09:00");
  });
});

describe("回放：节假日数据缺失 → 发起更新任务 → 计划卡（holiday-update-task）", () => {
  // 待我处理里的"缺 2027 年国内节假日数据"→ 用户点"发起更新任务" → 任务（用户发起）在看板上规划中 → 维护者交计划，
  // 在计划卡上确认
  const inputs = load("holiday-update-task");
  const planCardEvent = indexOf(inputs, (i) => i.kind === "frame" && i.frame.type === "card");
  const state = replay(inputs);
  const planCardId = selectTask(state, "t-1")!.planCardId!;

  test("缺失事项带着\"发起更新任务\"；点了之后任务在看板的进行中（规划中，用户发起）", () => {
    const first = replay(inputs.slice(0, 2));
    expect(inboxEntries(first, "open").map((e) => e.item)).toMatchObject([{ kind: "notice", notice: "holiday_data_missing", title: "缺 2027 年国内节假日数据", actions: ["发起更新任务"] }]);
    const planning = replay(inputs.slice(0, planCardEvent));
    expect(groupOfTask(planning, "t-1")).toBe("active");
    expect(selectTask(planning, "t-1")).toMatchObject({ title: "更新 2027 年国内节假日数据", state: "planning", origin: "button" });
  });

  test("计划卡（负载版本 5：76 号票起计划里没有定时作业）：确认后任务排队，有名额马上开始执行（13 号票）", () => {
    const card = selectCard(state, planCardId)!.card;
    expect(card).toMatchObject({ type: "plan", typeVersion: CARD_TYPE_VERSIONS.plan, status: "handled", outcome: { action: "confirm" } });
    expect(cardDisplay(state, planCardId)).toMatchObject({ kind: "typed", type: "plan" });
    expect((card.payload as PlanCardPayload).plan).not.toHaveProperty("scheduledJobs");
    expect(selectTask(state, "t-1")).toMatchObject({ state: "running", stages: { total: 2, current: 1 } });
  });

  test("只认得旧版计划卡的前端：降级成纯文本加\"去 Web 处理\"的链接", () => {
    const newer = inputs.map((i) =>
      i.kind === "frame" && i.frame.type === "card" ? { ...i, frame: { ...i.frame, payload: { card: { ...(i.frame.payload as { card: object }).card, typeVersion: CARD_TYPE_VERSIONS.plan + 1 } } } } : i,
    );
    expect(cardDisplay(replay(newer), planCardId)).toMatchObject({ kind: "fallback", reason: "newer_version", webPath: `#/card/${planCardId}` });
  });
});

/** 看板上 t-1 那张任务卡 */
const cardTokens = (state: UiState) =>
  boardGroups(state)
    .flatMap((g) => g.items)
    .find((i) => i.kind === "task" && i.task.id === "t-1");

describe("回放：任务的 token 用量（token-ledger）", () => {
  // 24 号票：剧本里每次回话带固定的用量；起草计划 2 次、执行 5 次（s1 两次、s2 两次、全部验收之后收尾一次）、评审子 agent 3 次
  const inputs = load("token-ledger");
  const totalsFrames = inputs.flatMap((i, at) => (i.kind === "frame" && i.frame.type === "token_totals" ? [at] : []));

  test("每次新的模型调用之后，看板上任务卡的总量跟着增长；回放到最后，和账本（剧本之和）一致", () => {
    expect(totalsFrames.map((at) => taskTokenTotal(replay(inputs.slice(0, at + 1)), "t-1"))).toEqual([2300, 4420, 7380, 10410, 13690, 17120, 18140, 19230, 20355, 23815]);
    const state = replay(inputs);
    expect(cardTokens(state)).toMatchObject({ kind: "task", tokens: 23815 });
    // 第一次调用之前没有用量
    expect(taskTokenTotal(replay(inputs.slice(0, totalsFrames[0]!)), "t-1")).toBe(0);
  });

  test("任务详情：维护者和评审子 agent 各占一行，各行之和等于任务卡上的总量", () => {
    const usage = taskUsage(replay(inputs), "t-1");
    expect(usage.rows.map((r) => ({ label: r.label, total: r.total, calls: r.calls }))).toEqual([
      { label: "维护者 tm-1", total: 20580, calls: 7 },
      { label: "评审子 agent review-t-1-s2-1", total: 3235, calls: 3 },
    ]);
    expect(usage.rows.reduce((a, r) => a + r.total, 0)).toBe(usage.total);
    expect(usage.total).toBe(23815);
  });

  test("阶段抽屉：每个阶段的预算旁边是它干活用掉的 token（起草计划、收尾的调用不算进任何阶段，评审子 agent 的不算进预算）", () => {
    expect(taskStages(replay(inputs), "t-1").map((s) => [s.stageId, s.budget?.usedTokens, s.budget?.tokens])).toEqual([
      ["s1", 5990, 100_000],
      ["s2", 6710, 100_000],
    ]);
  });

  test("看板频道重新同步：合计清掉，从头补发后回到同样的数", () => {
    const state = replay([...inputs, { kind: "resync", channel: "board" }]);
    expect(taskTokenTotal(state, "t-1")).toBe(0);
    const again = replay([...inputs, { kind: "resync", channel: "board" }, ...inputs.filter((i) => i.kind === "frame" && i.frame.channel === "board")]);
    expect(taskTokenTotal(again, "t-1")).toBe(23815);
  });
});
