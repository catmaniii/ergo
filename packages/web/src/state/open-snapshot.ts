// 打开页面时先用的本机快照（388）：状态层里由事件折出来的那部分，连同各频道的游标，存在这台设备上（页面那一半在
// app/open-snapshot.ts，存 IndexedDB）。下次打开先用它把界面画出来，订阅时带它的游标，守护进程只补增量。
//
// 存哪些：落盘事件折出来的（会话、卡片、待办、看板上的任务和提醒、定时作业、活动状态、已配对设备、项目、工单、范围记录、
// 工作日历、关注类别、名字、语言、已读位置……），和守护进程订阅时总会补推一次的"现在的样子"（插件的状况、两个开关、项目的服务：
// 打开时先照上次的画，补推的一到就换掉，导航、项目卡片不先按默认画一遍再变）。
// 不存：发送中的（乐观显示的尾巴、自己先做的排队编辑、卡片上点了还没回的）、提醒弹窗、被拒的提示、正在生成的回复、干活中的进度、
// 新到的语音、秘书刚说完的一轮、连接状态、补发推完了没有、网页的版本、经 HTTP 取的（我的名字、角色、语音模型、日历的各月、
// 取回的废弃分支）、输入框里引用的卡片、词典的版本（页面自己另记着词典，app/locale.ts）、背后的 agent 的计数。
// 会话照现在的"最近一页 + 往上翻"：每个会话只留当前分支上最近一页（HISTORY_PAGE_SIZE 条）消息起的那一段（之前的记录、阶段开始的
// 记号、那之前的消息带的语音对象都不留），留下的还能往上翻。游标照旧是收到的最后一条：守护进程从它之后补。
// 本机除了折好的快照，还存一份事件本身（452）：网页换了一版、快照不能用了，事件照样能用——用新版本的状态层把存着的事件重新折一遍
// （等于本机自己做一次"从头补"），再带着游标订阅，守护进程只补增量。只存会话频道以外的（keepsOpenEvents）。存的事件按冷补发同一份规则
// 合并（456，协议包的 replay-compaction.ts）：被后来的盖掉的旧记录不留。
// 纯函数，不依赖 React 和 DOM。
import { initialCalendarState } from "./calendar.ts";
import { CHANNELS, type EventFrame, HISTORY_PAGE_SIZE, MAINTAINER_CHANNEL_PREFIX, onBranchPath } from "./protocol.ts";
import type { UiInput, UiState } from "./ui-state.ts";

/** 快照的格式：存的样子变了就加一，旧格式的快照不用（页面换了一版的本来就不用，见 app/open-snapshot.ts） */
export const OPEN_SNAPSHOT_FORMAT = 1;

/**
 * 本机存的事件的格式（存的样子、存在哪些键上）：变了就加一，旧格式的事件不用、从头补。2：按冷补发同一份规则合并过（456，
 * 记着各频道合并到哪儿）；1（452）存的是没合并的整段，页面照样认（读出来先合并，见 app/open-snapshot.ts）
 */
export const OPEN_EVENTS_FORMAT = 2;

/**
 * 本机存不存这个频道的事件（452）：会话频道（秘书会话、负责人的会话）不存——冷打开时守护进程本来就只补最近一页（更早的经 HTTP
 * 往上翻），网页换了一版时这几个频道从 0 再要一次最近一页就行（用户那台 2026-11-09 数过：秘书会话最近一页 73 条、42 KB），本机不用照
 * "最近一页"的规矩修剪。别的频道冷打开时守护进程从第一条起全部补发，存下来，换了一版时用新的状态层重新折一遍、只要增量
 */
export function keepsOpenEvents(channel: string): boolean {
  return channel !== CHANNELS.secretary && !channel.startsWith(MAINTAINER_CHANNEL_PREFIX);
}

/** 用本机存的事件重新折一遍：当成补发的帧一次交（和守护进程从头补发时攒着一次交的一样，补发的不算新到的） */
export function refoldInput(events: readonly EventFrame[]): UiInput {
  return { kind: "batch", inputs: events.map((frame) => ({ kind: "frame", frame, catchUp: true })) };
}

/** 快照里存的那几样 */
const SNAPSHOT_KEYS = [
  "cursors",
  "conversations",
  "cards",
  "inbox",
  "reminders",
  "tasks",
  "taskReopens",
  "activity",
  "devices",
  "watchCategories",
  "safety",
  "projects",
  "tokenTotals",
  "workOrders",
  "scheduledJobs",
  "jobRuns",
  "taskPlans",
  "scopeRecords",
  "workday",
  "voices",
  "agentVoices",
  "turnStarts",
  "turnEnds",
  "calendar",
  "assistantName",
  "language",
  "pluginStatus",
  "projectServices",
  "readMarks",
] as const satisfies readonly (keyof UiState)[];

/** 存在这台设备上的那部分状态 */
export type OpenSnapshot = Pick<UiState, (typeof SNAPSHOT_KEYS)[number]>;

type Conversation = UiState["conversations"][string];

/** 从现在的状态取出要存的那部分（会话只留最近一页） */
export function snapshotOf(state: UiState): OpenSnapshot {
  const picked = Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, state[key]])) as OpenSnapshot;
  // 往上翻取回的、预览废弃分支取回的更早的消息不留；它们带的语音对象也不留（还没落到哪条消息上的、消息还没到的照留）
  const dropped = new Set<string>();
  const conversations = Object.fromEntries(
    Object.entries(state.conversations).map(([id, conv]) => {
      const kept = lastPage(conv);
      if (kept.messages.length < conv.messages.length) {
        const from = kept.messages[0]?.seq ?? Infinity;
        for (const m of conv.messages) if (m.seq < from && "message" in m) dropped.add(m.message.id);
      }
      return [id, kept];
    }),
  );
  const keepVoice = (v: { messageId?: string }) => v.messageId === undefined || !dropped.has(v.messageId);
  return {
    ...picked,
    conversations,
    voices: dropped.size === 0 ? state.voices : Object.fromEntries(Object.entries(state.voices).filter(([, v]) => keepVoice(v))),
    agentVoices: dropped.size === 0 ? state.agentVoices : Object.fromEntries(Object.entries(state.agentVoices).filter(([, v]) => keepVoice(v))),
    // 卡片上点了、还没等到结果的不留（下次打开按卡片的权威版本画）
    cards: Object.values(state.cards).some((c) => c.pending !== undefined) ? Object.fromEntries(Object.entries(state.cards).map(([id, c]) => [id, c.pending === undefined ? c : { card: c.card }])) : state.cards,
    // 日历只留"最近一次会让日历变的事件"的序号；各月是经 HTTP 取的，用到时再取
    calendar: { ...initialCalendarState, changedAt: state.calendar.changedAt },
  };
}

/**
 * 一个会话里要存的：当前分支上最近一页消息起的那一段（这一段里废弃分支上的消息照样留着，和补发的一样），
 * 发送中的、自己先做的排队编辑、取回的分支样子不留。截掉了更早的就还能往上翻
 */
function lastPage(conv: Conversation): Conversation {
  const { branchViews: _views, ...rest } = conv;
  const base: Conversation = { ...rest, tail: [], queueEdits: [] };
  const tree = conv.branches;
  const onPath = tree === undefined || tree.branches.length <= 1 ? () => true : (seq: number) => onBranchPath(tree, seq);
  const path = conv.messages.filter((m) => onPath(m.seq));
  if (path.length <= HISTORY_PAGE_SIZE) return base;
  const from = path[path.length - HISTORY_PAGE_SIZE]!.seq;
  return {
    ...base,
    messages: conv.messages.filter((m) => m.seq >= from),
    records: conv.records.filter((r) => r.seq >= from),
    ...(conv.stageStarts === undefined ? {} : { stageStarts: conv.stageStarts.filter((s) => s.seq >= from) }),
    olderExhausted: false,
  };
}

/**
 * 打开时先用快照：手里还什么事件都没有时才用（已经收到事件了就不再盖），快照里的那几样换上去，别的（经 HTTP 先取到的我的名字、
 * 角色这些）照旧
 */
export function withSnapshot(state: UiState, snapshot: OpenSnapshot): UiState {
  if (Object.keys(state.cursors).length > 0) return state;
  return { ...state, ...snapshot };
}

/** 要存的那几样有没有变（没变就不用再存一遍：正在生成的回复、弹窗这些变了不算） */
export function snapshotChanged(before: UiState | undefined, after: UiState): boolean {
  return before === undefined || SNAPSHOT_KEYS.some((key) => before[key] !== after[key]);
}

const isMap = (x: unknown): boolean => typeof x === "object" && x !== null && !Array.isArray(x);

/** 读回来的东西像不像一份快照（格式对、几样主要的都在）；不像的不用 */
export function isOpenSnapshot(value: unknown): value is OpenSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isMap(v.cursors) &&
    Object.values(v.cursors as object).every((n) => Number.isInteger(n) && (n as number) >= 0) &&
    isMap(v.conversations) &&
    isMap(v.cards) &&
    isMap(v.tasks) &&
    isMap(v.inbox) &&
    Array.isArray(v.projectServices) &&
    isMap(v.calendar)
  );
}
