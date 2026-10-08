// 前端状态层：把事件流归并成界面状态。全部是纯函数，不依赖 React 和 DOM。
//
// 两类输入：
// - 事件帧：服务端在某个频道上推来的权威事件。按频道记下最后收到的序号，重复或更旧的直接丢掉。
//   临时事件（流式增量）不占序号，只归并成"正在生成的回复"，定稿消息到了就被它替换。
// - 本地动作：用户刚做、服务端还没确认的事（发消息）。先乐观显示在会话末尾，
//   收到带同一个幂等键的权威事件后被替换；请求失败就标成失败，留着原文好重发。
// - 连接状态：连接告诉状态层的（连接中、在线、断开、页面版本过旧）；以及"重新同步某个频道"
//   （前端的序号比服务端还大，比如数据目录恢复成了旧快照：清掉这个频道，服务端从头补发）。
// - 往上翻取回的一页历史（HTTP）：会话频道第一次只补发最近一页，更早的消息按序号并进来，不推进游标。
// 06 号票起还有：待我处理事项（inbox_item）、简单提醒（看板频道上的 reminder）、到点的通知（临时的 notify，
// 界面显示过就用 alert_seen 去掉）、和消息与卡片对不上的被拒请求（比如卡着任务的事项不能删，界面提示过就用 failure_seen 去掉）。
// 待我处理的排序和 tab 上的提示见 inbox.ts，卡片的纯文本降级见 cards.ts。
// 12 号票起还有：任务（看板频道上的 task 事件，看板的五组见 board.ts）、agent 的活动状态（活动状态频道上的 activity 事件）。
// 10 号票起还有：已配对设备（devices 频道上的 device 事件，列表和分组见 devices.ts）；连接状态多了 unpaired
// （外网端口上这台设备的凭证失效了：被吊销或过期，界面回到配对等待页，开场方式见 pairing-gate.ts）。
// 21 号票起：被彻底删除的消息（事件改写成"已删除"标记，或者 messages_purged 说手里的哪几条被删了）在原来的位置只剩一条
// "已删除"，原话不留；带原话的工具调用记录换成改写后的样子（messages_purged 里的 replacement）。
// 输入框里引用的卡片（quote_card / unquote_card）也在这里：发消息时带上，发出去就清掉。
// 29 号票起：个人工作日历（calendar 频道上的节假日数据和个人设置的最新样子），每天的结果见 workday.ts。
// 15 号票起：项目（项目列表频道上的 project 事件，列表和项目页的入口见 projects.ts）；删掉的项目连同它的维护者会话一起拿掉。
// 24 号票起：任务和定时作业名下的 token 用量合计（看板频道上的 token_totals，每次记账后一条最新的），任务卡、作业卡、
// 任务详情的细分见 usage.ts。
// 25 号票起：会话里除了消息还有时间线上的记录（timeline_record：偏离、范围变更、越界；quick_action_executed：快速动作的操作记录），
// 和消息一起按序号排进时间线（timelineItems；要点层、全局层见 timeline.ts）；往上翻取回的一页里也带着落在那一页里的记录。
// 消息、记录都记下归属（共享协议包的 MessageScope：任务、项目、阶段；全局层按它聚色块）。操作记录跟着它的快速动作卡：
// 卡片来了新版本（彻底删除时换成去掉原话的），操作记录的标题、参数、结果一起换。
// 活动状态多了说明（落盘的 activity 事件里）和干活中的进度（临时的 activity_progress，状态变了就作废），agentActivity 取两者，
// 没收到过的是休眠。
// 31 号票起：语音对象（会话频道上的 voice 事件，按版本留最新的；往上翻取回的一页也带着它们），气泡要的东西见 voice.ts。
// 16 号票起：工单（项目列表频道上的 work_order 事件，项目页的工单流水线和看板上的"等项目 X"见 work-orders.ts）；
// 删掉的项目连同它的工单一起拿掉。维护者会话的分段（segment 事件）界面不用：分隔线是会话里的工单分隔 part。
// 32 号票起：agent 发的语音（会话频道上的 agent_voice 事件，按版本留最新的；往上翻取回的一页也带着它们），气泡和"转文字"见
// agent-voice.ts。用语音回复的那一轮不流式显示回复；整段合成的回复文字收进语音里（时间线上不显示，长按"转文字"展开）。
import {
  type ActivityDetail,
  activityDetailText,
  type ActivityEventPayload,
  type Card,
  type CardAction,
  type CardEventPayload,
  CHANNELS,
  type ConversationId,
  type CredentialRejection,
  type DeletedEventPayload,
  type DeviceEventPayload,
  EVENT_TYPES,
  type HolidayDataEventPayload,
  type HolidayYear,
  type EventFrame,
  type HistoryPage,
  type HistoryRecord,
  maintainerChannel,
  type Project,
  type ProjectEventPayload,
  type InboxItem,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  isEphemeralEventType,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type MessageScope,
  type MessagesPurgedEventPayload,
  type NotifyEventPayload,
  type PairedDevice,
  type Reminder,
  type ReminderEventPayload,
  type StreamDelta,
  type StreamEventPayload,
  type ActivityProgressEventPayload,
  type ActivityState,
  pickMessageScope,
  type QuickActionCardPayload,
  type QuickActionExecutedEventPayload,
  type TimelineRecord,
  type TimelineRecordEventPayload,
  type Task,
  type TaskEventPayload,
  type TaskPlanEventPayload,
  type TokenTotalsEventPayload,
  ledgerOwnerKey,
  type WorkdaySettings,
  type WorkdaySettingsEventPayload,
  type WatchCategorySettingsEventPayload,
  type VoiceEventPayload,
  type VoiceRecord,
  type WorkOrder,
  type WorkOrderEventPayload,
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  type ScopeRecord,
  type ScopeRecordEventPayload,
  scopeRecordChannel,
} from "./protocol.ts";
import { agentVoicePhase, replyCoverage } from "./agent-voice.ts";

export interface UiState {
  /** 每个频道最后收到的序号 */
  readonly cursors: Readonly<Record<string, number>>;
  /** 会话（键是会话 id，也就是频道名） */
  readonly conversations: Readonly<Record<string, ConversationState>>;
  /** 卡片（键是卡片 id） */
  readonly cards: Readonly<Record<string, CardState>>;
  /** 每个会话里正在生成的回复（键是会话 id）：由流式增量拼成，定稿消息到了就去掉 */
  readonly streams: Readonly<Record<string, StreamingMessage>>;
  /** 待我处理事项（键是事项 id；删掉的不在这里） */
  readonly inbox: Readonly<Record<string, InboxItem>>;
  /** 简单提醒（键是提醒 id） */
  readonly reminders: Readonly<Record<string, Reminder>>;
  /** 任务（键是任务 id）：看板频道上 task 事件里的最新状态 */
  readonly tasks: Readonly<Record<string, Task>>;
  /** agent 的活动状态（键是 agent id）：休眠、干活中、等你、排队，连同说明 */
  readonly activity: Readonly<Record<string, ActivityEventPayload>>;
  /** 干活中的 agent 此刻在做什么（键是 agent id；临时事件 activity_progress，下一条 activity 事件到了就作废） */
  readonly activityProgress: Readonly<Record<string, ActivityDetail>>;
  /** 已配对设备（键是设备 id；吊销了的也在，标着 revoked） */
  readonly devices: Readonly<Record<string, PairedDevice>>;
  /** 关注类别设置：关注类别频道上最后一条设置事件（26 号票）；还没收到是 undefined */
  readonly watchCategories: WatchCategorySettingsEventPayload | undefined;
  /** 项目（键是项目 id）：项目列表频道上 project 事件里的最新状态；删掉的不在这里 */
  readonly projects: Readonly<Record<string, Project>>;
  /** 任务、定时作业名下的 token 用量合计（键是 ledgerOwnerKey：task:t-1、job:j-1）：看板频道上最新的 token_totals（24 号票） */
  readonly tokenTotals: Readonly<Record<string, TokenTotalsEventPayload>>;
  /** 工单（键是工单 id，16 号票）：项目列表频道上 work_order 事件里的最新状态；删掉的项目的不在这里 */
  readonly workOrders: Readonly<Record<string, WorkOrder>>;
  /**
   * 执行中的任务现在生效的计划（键是任务 id）：看板频道上最新的 task_plan（14 号票：计划变更确认、维护者自行调整计划之后推来）。
   * 没换过版的任务没有，阶段抽屉取计划卡上的
   */
  readonly taskPlans: Readonly<Record<string, TaskPlanEventPayload>>;
  /**
   * 范围记录（键是记录 id，18 号票）：项目列表频道（项目维护者的）、任务看板频道（不属于项目的任务的）上的 scope_record 事件；
   * 删掉的项目的不在这里
   */
  readonly scopeRecords: Readonly<Record<string, ScopeRecord>>;
  /** 要马上告诉用户的通知（到点的提醒）：界面在任意页面提示，显示过就去掉 */
  readonly alerts: readonly NotifyEventPayload[];
  /** 被拒的请求里和消息、卡片对不上的那些（比如卡着任务的事项不能删）：界面提示原因，提示过就去掉 */
  readonly failures: readonly RequestFailure[];
  readonly connection: ConnectionStatus;
  /** 连接报 unpaired 时知道的原因（被吊销、过期）；不知道或者不是 unpaired 时没有 */
  readonly unpairedReason: CredentialRejection | undefined;
  /** 输入框里引用的卡片（键是会话 id）：发消息时作为卡片引用带上，发出去就清掉（21 号票） */
  readonly quotes: Readonly<Record<string, readonly string[]>>;
  /** 个人工作日历（29 号票）：工作日历频道上节假日数据和个人设置的最新样子；还没收到的是 undefined */
  readonly workday: { readonly holidays: readonly HolidayYear[] | undefined; readonly settings: WorkdaySettings | undefined };
  /** 语音对象（键是语音 id，31 号票）：会话频道上 voice 事件里的最新版本 */
  readonly voices: Readonly<Record<string, VoiceRecord>>;
  /** agent 发的语音（键是 agent 语音 id，32 号票）：会话频道上 agent_voice 事件里的最新版本 */
  readonly agentVoices: Readonly<Record<string, AgentVoiceRecord>>;
}

/** 一个被拒的请求：幂等键和原因 */
export interface RequestFailure {
  readonly idempotencyKey: string;
  readonly error: string;
}

/**
 * 和服务端的连接：连接中、在线、断开（正在重连）、页面版本过旧（要刷新）、
 * 这台设备的凭证失效了（外网端口上被吊销或太久没用：不再重连，回到配对等待页）
 */
export type ConnectionStatus = "connecting" | "online" | "offline" | "outdated" | "unpaired";

/** 正在生成的一条回复 */
interface StreamingMessage {
  readonly messageId: string;
  readonly parts: readonly { readonly type: StreamDelta["type"]; readonly text: string }[];
  /** 漏掉了中间的增量（断线重连、或者说到一半才打开页面）：不再拼文字，等定稿消息 */
  readonly broken: boolean;
}

/** 一个已发出、还没得到结果的请求：在路上，或者失败了（带错误说明） */
export type RequestStatus = { readonly status: "sending" } | { readonly status: "failed"; readonly error: string };

/** 会话里的一条权威消息（连同归属：任务、项目、阶段）；被彻底删除的只剩"已删除"标记（消息 id 和时间） */
type ConversationEntry =
  | { readonly seq: number; readonly message: MessageEnvelope; readonly idempotencyKey?: string; readonly scope: MessageScope }
  | { readonly seq: number; readonly deleted: DeletedEventPayload };

/**
 * 时间线上消息之外的一条记录：偏离、范围变更、越界这类（timeline_record，种类见协议包 timeline.ts，可能有前端还不认识的种类，
 * 连同归属），或者快速动作的执行（操作记录，quick_action_executed）
 */
export type ConversationRecord =
  | { readonly type: "timeline"; readonly timeline: TimelineRecord; readonly scope: MessageScope }
  | { readonly type: "operation"; readonly operation: QuickActionExecutedEventPayload };

interface ConversationState {
  /** 权威消息，按序号从早到晚（往上翻取回的更早消息插在前面）；用户自己发的带着发送请求的幂等键 */
  readonly messages: readonly ConversationEntry[];
  /** 时间线上的记录，按序号从早到晚（往上翻取回的更早的插在前面） */
  readonly records: readonly { readonly seq: number; readonly record: ConversationRecord }[];
  /** 乐观显示的尾巴：已发出、还没收到权威事件的消息，按发出顺序 */
  readonly tail: readonly PendingMessage[];
  /** 往上翻已经翻到头了（服务端说更早没有了） */
  readonly olderExhausted: boolean;
}

type PendingMessage = { readonly idempotencyKey: string; readonly message: MessageEnvelope } & RequestStatus;

/** 一张卡片的状态：权威版本，加上本地点了按钮、还没得到结果的动作。 */
export interface CardState {
  readonly card: Card;
  readonly pending?: { readonly action: CardAction; readonly idempotencyKey: string } & RequestStatus;
}

/**
 * 会话视图里的一条：权威消息，或者本地乐观显示、还没得到确认的消息。
 * 乐观显示的那条被权威消息替换后，权威消息带着同一个幂等键，界面可以拿它当 key，原地换掉不闪。
 */
export type ConversationItem =
  | { kind: "message"; message: MessageEnvelope; idempotencyKey?: string }
  /** 被彻底删除的消息：原来的位置只显示"已删除"；key 是消息 id（没有时用序号） */
  | { kind: "deleted"; key: string; time: string | undefined; idempotencyKey?: undefined }
  /** 正在生成的回复：message.id 就是定稿后那条消息的 id，界面拿它当 key，定稿时原地换掉；broken 时只显示"正在回复" */
  | { kind: "streaming"; message: MessageEnvelope; broken: boolean; idempotencyKey?: undefined }
  | ({ kind: "pending"; idempotencyKey: string; message: MessageEnvelope } & RequestStatus);

/** 状态层的输入。 */
export type UiInput =
  /** 服务端推来的事件帧 */
  | { kind: "frame"; frame: EventFrame }
  /** 用户发出一条消息（请求已发出，等权威事件） */
  | { kind: "send_message"; conversation: ConversationId; idempotencyKey: string; parts: MessagePart[]; time: string }
  /** 用户点了卡片上的按钮（"对卡片做动作"的请求已发出，等卡片更新事件） */
  | { kind: "card_action"; cardId: string; action: CardAction; idempotencyKey: string }
  /** 某个带幂等键的请求失败了（响应帧里的错误，或者连接断了没发出去） */
  | { kind: "request_failed"; idempotencyKey: string; error: string }
  /** 连接状态变了 */
  | { kind: "connection"; status: ConnectionStatus; reason?: CredentialRejection }
  /** 重新同步一个频道：清掉它的序号和归并出来的状态（还没确认的乐观显示留着），接下来服务端从头补发 */
  | { kind: "resync"; channel: string }
  /** 界面已经提示过这条通知 */
  | { kind: "alert_seen"; id: string }
  /** 界面已经提示过这个被拒的请求 */
  | { kind: "failure_seen"; idempotencyKey: string }
  /** 经 HTTP 取回的一页更早的历史（往上翻时） */
  | { kind: "history_page"; conversation: ConversationId; page: HistoryPage }
  /** 聊天里的一张卡片"引用"到输入框（同一张只引用一次） */
  | { kind: "quote_card"; conversation: ConversationId; cardId: string }
  /** 去掉输入框里引用的一张卡片 */
  | { kind: "unquote_card"; conversation: ConversationId; cardId: string };

export const initialUiState: UiState = {
  cursors: {},
  conversations: {},
  cards: {},
  streams: {},
  inbox: {},
  reminders: {},
  tasks: {},
  activity: {},
  activityProgress: {},
  devices: {},
  watchCategories: undefined,
  projects: {},
  tokenTotals: {},
  workOrders: {},
  taskPlans: {},
  scopeRecords: {},
  alerts: [],
  failures: [],
  connection: "connecting",
  quotes: {},
  unpairedReason: undefined,
  workday: { holidays: undefined, settings: undefined },
  voices: {},
  agentVoices: {},
};

const emptyConversation: ConversationState = { messages: [], records: [], tail: [], olderExhausted: false };

/** 会话频道上一条时间线记录的事件（WebSocket 上的、历史分页里的）→ 状态层里的记录；不是记录的是 undefined */
function recordOf(type: string, payload: unknown): ConversationRecord | undefined {
  if (type === EVENT_TYPES.timelineRecord) {
    const p = payload as TimelineRecordEventPayload;
    return { type: "timeline", timeline: p.record, scope: pickMessageScope(p) };
  }
  if (type === EVENT_TYPES.quickActionExecuted) return { type: "operation", operation: payload as QuickActionExecutedEventPayload };
  return undefined;
}

function withRecord(state: UiState, frame: EventFrame): UiState {
  const record = recordOf(frame.type, frame.payload);
  if (!record) return state;
  return updateConversation(state, frame.channel, (conv) => ({ ...conv, records: [...conv.records, { seq: frame.seq, record }] }));
}

/** 快速动作卡来了新版本：它的操作记录跟着换标题、参数、结果（彻底删除时卡片换成去掉原话的，操作记录也不留原话） */
function withOperationsOf(state: UiState, card: Card): UiState {
  if (card.type !== "quick_action") return state;
  const p = card.payload as QuickActionCardPayload;
  const conv = state.conversations[p.conversation];
  if (!conv?.records.some(({ record }) => record.type === "operation" && record.operation.cardId === card.id)) return state;
  return updateConversation(state, p.conversation, (c) => ({
    ...c,
    records: c.records.map((r) => {
      if (r.record.type !== "operation" || r.record.operation.cardId !== card.id) return r;
      const op = r.record.operation;
      return { seq: r.seq, record: { type: "operation", operation: { ...op, title: p.title, action: p.action, result: { ...op.result, summary: p.result ?? op.result.summary } } } };
    }),
  }));
}

/** 各事件类型的归并函数。后面的票往这张表里加；不认识的类型只推进序号。 */
const eventHandlers: Record<string, (state: UiState, frame: EventFrame) => UiState> = {
  [EVENT_TYPES.message]: (state, frame) => {
    if (isDeletedEventPayload(frame.payload)) {
      const deleted = frame.payload;
      return updateConversation(state, frame.channel, (conv) => ({ ...conv, messages: [...conv.messages, { seq: frame.seq, deleted }] }));
    }
    const payload = frame.payload as MessageEventPayload;
    const { message, idempotencyKey } = payload;
    const next = updateConversation(state, frame.channel, (conv) => ({
      ...conv,
      messages: [...conv.messages, { seq: frame.seq, message, idempotencyKey, scope: pickMessageScope(payload) }],
      tail: idempotencyKey === undefined ? conv.tail : conv.tail.filter((p) => p.idempotencyKey !== idempotencyKey),
    }));
    // 正在生成的那条定稿了：换成这条权威消息
    return next.streams[frame.channel]?.messageId === message.id ? withoutStream(next, frame.channel) : next;
  },
  // 这些消息被彻底删除了：手里的原话换成"已删除"（语音消息的语音对象也拿掉，文字不留在前端）
  [EVENT_TYPES.messagesPurged]: (state, frame) => {
    const { messages, deletedAt } = frame.payload as MessagesPurgedEventPayload;
    const purged = new Map(messages.map((m) => [m.messageId, m.replacement]));
    const voices = filterVoices(state.voices, (v) => !purged.has(v.messageId) || purged.get(v.messageId) !== undefined);
    return updateConversation({ ...state, voices }, frame.channel, (conv) => ({
      ...conv,
      messages: conv.messages.map((m): ConversationEntry => {
        if (!("message" in m) || !purged.has(m.message.id)) return m;
        const replacement = purged.get(m.message.id);
        // 字段级改写过的（工具调用记录）：换成改写后的样子；整条删掉的：只留"已删除"
        if (replacement) return { ...m, message: replacement };
        return { seq: m.seq, deleted: { deleted: true, deletedAt, messageId: m.message.id, messageTime: m.message.time } };
      }),
    }));
  },
  // 时间线上的记录（25 号票）：偏离、范围变更、越界……；快速动作的操作记录（21 号票）
  [EVENT_TYPES.timelineRecord]: withRecord,
  [EVENT_TYPES.quickActionExecuted]: withRecord,
  // 回合结束：不管有没有定稿消息（出错、中止），正在生成的都收起
  [EVENT_TYPES.turnEnd]: (state, frame) => withoutStream(state, frame.channel),
  [EVENT_TYPES.card]: (state, frame) => {
    // 彻底删除改写过的旧版本卡片：忽略（之后有去掉原话的新版本）
    if (isDeletedEventPayload(frame.payload)) return state;
    const { card } = frame.payload as CardEventPayload;
    const old = state.cards[card.id];
    if (old && old.card.version >= card.version) return state;
    // 卡片有了新的权威版本：不管是自己点的生效了还是别处先处理了，处理中的标记都结束
    return withOperationsOf({ ...state, cards: { ...state.cards, [card.id]: { card } } }, card);
  },
  [EVENT_TYPES.inboxItem]: (state, frame) => {
    const { item } = frame.payload as InboxItemEventPayload;
    const inbox = { ...state.inbox };
    if (item.deleted) delete inbox[item.id];
    else inbox[item.id] = item;
    return { ...state, inbox };
  },
  [EVENT_TYPES.reminder]: (state, frame) => {
    const { reminder } = frame.payload as ReminderEventPayload;
    return { ...state, reminders: { ...state.reminders, [reminder.id]: reminder } };
  },
  [EVENT_TYPES.task]: (state, frame) => {
    const { task } = frame.payload as TaskEventPayload;
    return { ...state, tasks: { ...state.tasks, [task.id]: task } };
  },
  [EVENT_TYPES.tokenTotals]: (state, frame) => {
    const payload = frame.payload as TokenTotalsEventPayload;
    return { ...state, tokenTotals: { ...state.tokenTotals, [ledgerOwnerKey(payload.owner)]: payload } };
  },
  [EVENT_TYPES.taskPlan]: (state, frame) => {
    const payload = frame.payload as TaskPlanEventPayload;
    return { ...state, taskPlans: { ...state.taskPlans, [payload.taskId]: payload } };
  },
  [EVENT_TYPES.activity]: (state, frame) => {
    const payload = frame.payload as ActivityEventPayload;
    // 状态变了：之前推来的进度作废
    return { ...state, activity: { ...state.activity, [payload.agentId]: payload }, activityProgress: withoutKey(state.activityProgress, payload.agentId) };
  },
  [EVENT_TYPES.device]: (state, frame) => {
    const { device } = frame.payload as DeviceEventPayload;
    return { ...state, devices: { ...state.devices, [device.id]: device } };
  },
  [EVENT_TYPES.holidayData]: (state, frame) => ({ ...state, workday: { ...state.workday, holidays: (frame.payload as HolidayDataEventPayload).years } }),
  [EVENT_TYPES.workdaySettings]: (state, frame) => ({ ...state, workday: { ...state.workday, settings: (frame.payload as WorkdaySettingsEventPayload).settings } }),
  // 关注类别设置：每条事件带着设置的最新样子，留最后一条（26 号票）
  [EVENT_TYPES.watchCategorySettings]: (state, frame) => ({ ...state, watchCategories: frame.payload as WatchCategorySettingsEventPayload }),
  // 一条语音的最新状态：旧版本（比如往上翻取回的一页里带的）不覆盖新的
  [EVENT_TYPES.voice]: (state, frame) => mergeVoices(state, "voices", [(frame.payload as VoiceEventPayload).voice]),
  // agent 发的一条语音的最新状态（32 号票）：同样按版本
  [EVENT_TYPES.agentVoice]: (state, frame) => mergeVoices(state, "agentVoices", [(frame.payload as AgentVoiceEventPayload).voice]),
  [EVENT_TYPES.project]: (state, frame) => {
    const { project, change } = frame.payload as ProjectEventPayload;
    if (change !== "deleted") return { ...state, projects: { ...state.projects, [project.id]: project } };
    // 删掉的项目：项目档案和维护者会话都删了（会话频道上只剩"已删除"标记），界面上一起拿掉
    const conversation = maintainerChannel(project.maintainerId);
    return withoutStream(
      {
        ...state,
        projects: withoutKey(state.projects, project.id),
        workOrders: Object.fromEntries(Object.entries(state.workOrders).filter(([, w]) => w.projectId !== project.id)),
        scopeRecords: Object.fromEntries(Object.entries(state.scopeRecords).filter(([, r]) => r.projectId !== project.id)),
        conversations: withoutKey(state.conversations, conversation),
        cursors: withoutKey(state.cursors, conversation),
        quotes: withoutKey(state.quotes, conversation),
        voices: filterVoices(state.voices, (v) => v.conversation !== conversation),
        agentVoices: filterVoices(state.agentVoices, (v) => v.conversation !== conversation),
      },
      conversation,
    );
  },
  // 工单（16 号票）：每条事件带着工单的最新样子（删掉的项目的工单在它的 deleted 那里一起拿掉）
  [EVENT_TYPES.workOrder]: (state, frame) => {
    const { workOrder } = frame.payload as WorkOrderEventPayload;
    return { ...state, workOrders: { ...state.workOrders, [workOrder.id]: workOrder } };
  },
  // 范围记录（18 号票）：项目列表频道上的是项目维护者的，任务看板频道上的是不属于项目的任务的；删掉的项目的在它的 deleted 那里一起拿掉
  [EVENT_TYPES.scopeRecord]: (state, frame) => {
    const { record } = frame.payload as ScopeRecordEventPayload;
    return { ...state, scopeRecords: { ...state.scopeRecords, [record.id]: record } };
  },
};

/** 并进语音对象：每条留版本最高的 */
function mergeVoices<K extends "voices" | "agentVoices">(state: UiState, key: K, voices: ReadonlyArray<UiState[K][string]>): UiState {
  const known: Readonly<Record<string, { version: number }>> = state[key];
  const fresh = voices.filter((v) => (known[v.id]?.version ?? 0) < v.version);
  if (fresh.length === 0) return state;
  return { ...state, [key]: { ...state[key], ...Object.fromEntries(fresh.map((v) => [v.id, v])) } };
}

function filterVoices<V extends { conversation: string }>(voices: Readonly<Record<string, V>>, keep: (voice: V) => boolean): Readonly<Record<string, V>> {
  const kept = Object.entries(voices).filter(([, v]) => keep(v));
  return kept.length === Object.keys(voices).length ? voices : Object.fromEntries(kept);
}

function updateConversation(state: UiState, id: string, f: (conv: ConversationState) => ConversationState): UiState {
  const conv = f(state.conversations[id] ?? emptyConversation);
  return { ...state, conversations: { ...state.conversations, [id]: conv } };
}

function resyncChannel(state: UiState, channel: string): UiState {
  const cursors = { ...state.cursors };
  delete cursors[channel];
  const conv = state.conversations[channel];
  const conversations = conv ? { ...state.conversations, [channel]: { ...emptyConversation, tail: conv.tail } } : state.conversations;
  const cards = channel === CHANNELS.cards ? {} : state.cards;
  const inbox = channel === CHANNELS.inbox ? {} : state.inbox;
  const reminders = channel === CHANNELS.board ? {} : state.reminders;
  const tasks = channel === CHANNELS.board ? {} : state.tasks;
  const tokenTotals = channel === CHANNELS.board ? {} : state.tokenTotals;
  const taskPlans = channel === CHANNELS.board ? {} : state.taskPlans;
  const activity = channel === CHANNELS.activity ? {} : state.activity;
  const activityProgress = channel === CHANNELS.activity ? {} : state.activityProgress;
  const devices = channel === CHANNELS.devices ? {} : state.devices;
  const workday = channel === CHANNELS.workdayCalendar ? initialUiState.workday : state.workday;
  const watchCategories = channel === CHANNELS.watchCategories ? undefined : state.watchCategories;
  const projects = channel === CHANNELS.projects ? {} : state.projects;
  // 会话频道上的语音对象跟着这个会话清掉（服务端从头补发它的 voice 事件）
  const voices = filterVoices(state.voices, (v) => v.conversation !== channel);
  const agentVoices = filterVoices(state.agentVoices, (v) => v.conversation !== channel);
  const workOrders = channel === CHANNELS.projects ? {} : state.workOrders;
  // 范围记录跟着它所在的频道清掉（落在哪个频道：协议包的 scopeRecordChannel）
  const scopeRecords = Object.fromEntries(Object.entries(state.scopeRecords).filter(([, r]) => scopeRecordChannel(r) !== channel));
  return withoutStream(
    { ...state, cursors, conversations, cards, inbox, reminders, tasks, tokenTotals, taskPlans, activity, activityProgress, devices, workday, watchCategories, projects, voices, agentVoices, workOrders, scopeRecords },
    channel,
  );
}

function withoutStream(state: UiState, channel: string): UiState {
  if (!state.streams[channel]) return state;
  const streams = { ...state.streams };
  delete streams[channel];
  return { ...state, streams };
}

/** 临时事件：不占序号。比已收到的落盘事件还旧的（迟到的增量、迟到的通知）丢掉 */
function reduceEphemeral(state: UiState, frame: EventFrame): UiState {
  if (frame.seq < (state.cursors[frame.channel] ?? 0)) return state;
  if (frame.type === EVENT_TYPES.notify) {
    const alert = frame.payload as NotifyEventPayload;
    return state.alerts.some((a) => a.id === alert.id) ? state : { ...state, alerts: [...state.alerts, alert] };
  }
  // 干活中的进度：只认正在干活的 agent（等你、休眠时来的不算）
  if (frame.type === EVENT_TYPES.activityProgress) {
    const { agentId, detail } = frame.payload as ActivityProgressEventPayload;
    if (state.activity[agentId]?.state !== "working") return state;
    return { ...state, activityProgress: { ...state.activityProgress, [agentId]: detail } };
  }
  if (frame.type !== EVENT_TYPES.stream) return state;
  const { messageId, deltas } = frame.payload as StreamEventPayload;
  const old = state.streams[frame.channel];
  let stream: StreamingMessage = old?.messageId === messageId ? old : { messageId, parts: [], broken: false };
  for (const d of deltas) stream = appendDelta(stream, d);
  return { ...state, streams: { ...state.streams, [frame.channel]: stream } };
}

/** 接上一段增量；位置对不上（漏了中间的）就标成残缺，不再拼 */
function appendDelta(stream: StreamingMessage, d: StreamDelta): StreamingMessage {
  if (stream.broken) return stream;
  const part = stream.parts[d.part];
  if (part && part.text.length === d.offset) {
    return { ...stream, parts: stream.parts.map((p, i) => (i === d.part ? { type: p.type, text: p.text + d.text } : p)) };
  }
  if (!part && d.part === stream.parts.length && d.offset === 0) return { ...stream, parts: [...stream.parts, { type: d.type, text: d.text }] };
  return { ...stream, broken: true };
}

function reduceFrame(state: UiState, frame: EventFrame): UiState {
  if (isEphemeralEventType(frame.type)) return reduceEphemeral(state, frame);
  // 重复或更旧的序号：重连补发、或者同一事件收到两次，直接丢掉
  if (frame.seq <= (state.cursors[frame.channel] ?? 0)) return state;
  const next = { ...state, cursors: { ...state.cursors, [frame.channel]: frame.seq } };
  const handler = eventHandlers[frame.type];
  return handler ? handler(next, frame) : next;
}

export function reduce(state: UiState, input: UiInput): UiState {
  switch (input.kind) {
    case "frame":
      return reduceFrame(state, input.frame);
    case "send_message": {
      const message: MessageEnvelope = {
        id: `pending:${input.idempotencyKey}`,
        conversation: input.conversation,
        speaker: "user",
        time: input.time,
        parts: input.parts,
      };
      const sent = updateConversation(state, input.conversation, (conv) => ({
        ...conv,
        tail: [...conv.tail, { idempotencyKey: input.idempotencyKey, message, status: "sending" }],
      }));
      // 输入框里引用的卡片随这条消息发出去了
      return input.conversation in sent.quotes ? { ...sent, quotes: withoutKey(sent.quotes, input.conversation) } : sent;
    }
    case "quote_card": {
      const quoted = state.quotes[input.conversation] ?? [];
      if (quoted.includes(input.cardId)) return state;
      return { ...state, quotes: { ...state.quotes, [input.conversation]: [...quoted, input.cardId] } };
    }
    case "unquote_card": {
      const rest = (state.quotes[input.conversation] ?? []).filter((id) => id !== input.cardId);
      return { ...state, quotes: rest.length > 0 ? { ...state.quotes, [input.conversation]: rest } : withoutKey(state.quotes, input.conversation) };
    }
    case "card_action": {
      const view = state.cards[input.cardId];
      if (!view) return state;
      const pending: CardState["pending"] = { action: input.action, idempotencyKey: input.idempotencyKey, status: "sending" };
      return { ...state, cards: { ...state.cards, [input.cardId]: { ...view, pending } } };
    }
    case "request_failed": {
      const matched =
        Object.values(state.cards).some((view) => view.pending?.idempotencyKey === input.idempotencyKey) ||
        Object.values(state.conversations).some((conv) => conv.tail.some((p) => p.idempotencyKey === input.idempotencyKey));
      // 不是消息也不是卡片按钮（比如待我处理的动作）：记下原因，界面提示
      if (!matched) return { ...state, failures: [...state.failures, { idempotencyKey: input.idempotencyKey, error: input.error }] };
      let next = state;
      for (const [id, view] of Object.entries(state.cards)) {
        if (view.pending?.idempotencyKey !== input.idempotencyKey) continue;
        const pending: CardState["pending"] = { action: view.pending.action, idempotencyKey: view.pending.idempotencyKey, status: "failed", error: input.error };
        next = { ...next, cards: { ...next.cards, [id]: { ...view, pending } } };
      }
      for (const [id, conv] of Object.entries(state.conversations)) {
        if (!conv.tail.some((p) => p.idempotencyKey === input.idempotencyKey)) continue;
        next = updateConversation(next, id, (c) => ({
          ...c,
          tail: c.tail.map((p): PendingMessage => (p.idempotencyKey === input.idempotencyKey ? { idempotencyKey: p.idempotencyKey, message: p.message, status: "failed", error: input.error } : p)),
        }));
      }
      return next;
    }
    case "connection": {
      const unpairedReason = input.status === "unpaired" ? input.reason : undefined;
      return state.connection === input.status && state.unpairedReason === unpairedReason ? state : { ...state, connection: input.status, unpairedReason };
    }
    case "resync":
      return resyncChannel(state, input.channel);
    case "alert_seen":
      return { ...state, alerts: state.alerts.filter((a) => a.id !== input.id) };
    case "failure_seen":
      return { ...state, failures: state.failures.filter((f) => f.idempotencyKey !== input.idempotencyKey) };
    case "history_page":
      return mergeHistoryPage(state, input.conversation, input.page);
  }
}

/**
 * 往上翻取回的一页更早的消息：按序号并进权威消息（手里已有的同一条不重复），落在这一页里的时间线记录同样并进来；
 * 不推进游标（游标只跟 WebSocket 上的落盘事件走）。服务端说更早没有了，就记下翻到头了。
 */
function mergeHistoryPage(state: UiState, conversation: ConversationId, page: HistoryPage): UiState {
  // 这一页的语音消息引用的语音对象（31 号票）：它们的 voice 事件可能早于第一次补发的那一页
  // 这一页里 agent 的语音消息引用的 agent 语音对象（32 号票）：送进 TTS 的原文在这里
  return updateConversation(mergeVoices(mergeVoices(state, "voices", page.voices ?? []), "agentVoices", page.agentVoices ?? []), conversation, (conv) => {
    const known = new Set(conv.messages.map((m) => m.seq));
    const older = page.messages
      .filter((m) => !known.has(m.seq))
      .map((m): ConversationEntry => {
        if ("deleted" in m) return { seq: m.seq, deleted: m.deleted };
        return { seq: m.seq, message: m.message, ...(m.idempotencyKey === undefined ? {} : { idempotencyKey: m.idempotencyKey }), scope: pickMessageScope(m) };
      });
    const messages = [...older, ...conv.messages].toSorted((a, b) => a.seq - b.seq);
    const knownRecords = new Set(conv.records.map((r) => r.seq));
    const olderRecords = page.records.filter((r) => !knownRecords.has(r.seq)).flatMap(({ seq, type, payload }: HistoryRecord) => {
      const record = recordOf(type, payload);
      return record ? [{ seq, record }] : [];
    });
    const records = [...olderRecords, ...conv.records].toSorted((a, b) => a.seq - b.seq);
    return { ...conv, messages, records, olderExhausted: conv.olderExhausted || !page.hasMore };
  });
}

/** 回放：把一串输入依次归并。直接给事件帧也行。 */
export function replay(inputs: readonly (EventFrame | UiInput)[], from: UiState = initialUiState): UiState {
  return inputs.reduce<UiState>((s, x) => reduce(s, "kind" in x ? x : { kind: "frame", frame: x }), from);
}

/** 重连时带给服务端的"每个频道最后收到的序号"。 */
export function resumeCursors(state: UiState): Record<string, number> {
  return { ...state.cursors };
}

/**
 * 某个会话还能不能往上翻：before 是手里最早那条消息的序号（取更早的一页时带给服务端）。
 * 手里没有消息、最早那条就是序号 1、或者服务端说过更早没有了，就不能再翻。
 */
export function olderHistory(state: UiState, conversation: ConversationId): { canLoadOlder: boolean; before: number | undefined } {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const before = conv.messages[0]?.seq;
  return { canLoadOlder: before !== undefined && before > 1 && !conv.olderExhausted, before };
}

/** 某张卡片的状态；没收到过这张卡就是 undefined。 */
export function selectCard(state: UiState, cardId: string): CardState | undefined {
  return state.cards[cardId];
}

/** 某条简单提醒的最新状态 */
export function selectReminder(state: UiState, reminderId: string): Reminder | undefined {
  return state.reminders[reminderId];
}

/** 一条权威消息（或"已删除"标记）在会话视图里的样子 */
function entryItem(m: ConversationEntry): ConversationItem {
  return "deleted" in m
    ? { kind: "deleted", key: m.deleted.messageId ?? `deleted:${m.seq}`, time: m.deleted.messageTime }
    : { kind: "message", message: m.message, idempotencyKey: m.idempotencyKey };
}

/** 权威消息之后的条目：正在生成的回复，乐观显示的尾巴在最后 */
function liveItems(state: UiState, conversation: ConversationId): ConversationItem[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const stream = state.streams[conversation];
  return [...(stream ? [streamingItem(conversation, stream)] : []), ...conv.tail.map((p): ConversationItem => ({ kind: "pending", ...p }))];
}

/** 某个会话要显示的条目：权威消息在前，然后是正在生成的回复，乐观显示的尾巴在最后。 */
export function conversationView(state: UiState, conversation: ConversationId): ConversationItem[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  return [...conv.messages.map(entryItem), ...liveItems(state, conversation)];
}

/**
 * 时间线上的一条：会话视图里的条目（权威消息带上序号和归属：任务、项目、阶段），或者消息之外的一条记录（偏离、范围变更、越界、操作记录）。
 * 记录的时间：时间线记录自带；操作记录取对应卡片处理的时间（还没收到卡片时没有）
 */
export type TimelineItem =
  | (ConversationItem & { readonly seq?: number; readonly scope?: MessageScope })
  | { kind: "record"; key: string; seq: number; time: string | undefined; record: ConversationRecord; idempotencyKey?: undefined };

/**
 * 某个会话的时间线（完整视图）：权威消息和记录按序号排，然后是正在生成的回复，乐观显示的尾巴在最后（和 conversationView 同一套映射）。
 * 用语音回复的（32 号票，见 agent-voice.ts）：还在回复的那一轮不显示正在生成的回复，这一轮的消息不显示文字；整段合成的回复
 * 文字收进语音（长按"转文字"展开）。只剩文字的那条整条不显示
 */
export function timelineItems(state: UiState, conversation: ConversationId): TimelineItem[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const covered = replyCoverage(state, conversation);
  const entries = conv.messages.flatMap((m): TimelineItem[] => {
    const item = entryItem(m);
    if (item.kind === "message" && covered({ seq: m.seq, message: item.message })) {
      const parts = item.message.parts.filter((p) => p.type !== "text");
      if (!parts.some((p) => p.type !== "reasoning")) return [];
      return [{ ...item, message: { ...item.message, parts }, seq: m.seq, ...("scope" in m ? { scope: m.scope } : {}) }];
    }
    return [{ ...item, seq: m.seq, ...("scope" in m ? { scope: m.scope } : {}) }];
  });
  const records = conv.records.map(
    ({ seq, record }): TimelineItem => ({
      kind: "record",
      key: record.type === "timeline" ? `record:${record.timeline.id}` : `operation:${record.operation.actionId}`,
      seq,
      time: record.type === "timeline" ? record.timeline.time : state.cards[record.operation.cardId]?.card.handledAt,
      record,
    }),
  );
  const replying = agentVoicePhase(state, conversation) === "replying";
  const live = liveItems(state, conversation).filter((it) => !(replying && it.kind === "streaming"));
  return [...[...entries, ...records].toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), ...live];
}

/** 一个 agent 的活动状态和说明（说明的文字用协议包的 activityDetailText） */
export interface AgentActivity {
  readonly state: ActivityState;
  readonly detail?: ActivityDetail;
}

/** 活动状态说明的文字（小圆点旁边写的；没有说明的是 undefined） */
export function activityNote(activity: AgentActivity): string | undefined {
  return activity.detail ? activityDetailText(activity.detail) || undefined : undefined;
}

/**
 * 一个 agent 现在的活动状态：落盘的状态和说明，干活中时说明换成最新的进度。
 * 没收到过的是休眠（还没被唤起过的维护者；默认值只在这里）
 */
export function agentActivity(state: UiState, agentId: string): AgentActivity {
  const latest = state.activity[agentId];
  if (!latest) return { state: "sleeping" };
  const detail = (latest.state === "working" ? state.activityProgress[agentId] : undefined) ?? latest.detail;
  return { state: latest.state, ...(detail === undefined ? {} : { detail }) };
}

function streamingItem(conversation: ConversationId, stream: StreamingMessage): ConversationItem {
  // 时间留空：定稿消息带着服务端的时间到来
  const parts: MessagePart[] = stream.parts.map((p) => ({ type: p.type, text: p.text }));
  return { kind: "streaming", broken: stream.broken, message: { id: stream.messageId, conversation, speaker: "agent", time: "", parts } };
}

/** 输入框里引用的卡片（按引用的先后） */
export function quotedCards(state: UiState, conversation: ConversationId): readonly string[] {
  return state.quotes[conversation] ?? [];
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
