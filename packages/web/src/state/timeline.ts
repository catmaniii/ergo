// 时间线的要点（规格第 19 节，25 号票）：秘书聊天和维护者会话里哪些是要点、怎么说、怎么聚块。
// 54 号票起会话的缩放换成一镜到底（ui/zoom/ZoomHistory.tsx，条目来自 chat-items.ts），25 号票的分段按钮和要点层、全局层
// 两套单独的渲染去掉了；要点（marksOf、partMarksOf）照旧在这里推，缩小后右侧的标注用它们。gistView、globalView 留着：
// 测试拿 gistView 核对条目层的要点一条不少；globalView 的聚块（按天、按工单段、按阶段）是 55 号票底色带要的分段。
// 纯函数，输入是前端状态层的时间线（ui-state.ts 的 timelineItems：消息和时间线记录按序号排好）：
// - 要点层（gistView）：只留要点——关注类别命中的操作、审批、偏离、验收、通用 bash、范围变更和越界，以及被拦下、问过的操作，
//   以及快速动作的操作记录（21 号票转来：每次执行都标出）；其余条目收起成"收起了 N 条"；
// - 全局层（globalView）：把会话聚成色块——任务的维护者会话按阶段（消息带着的 stageId；开始执行之前是"规划"），
//   项目维护者的会话按工单段（工单分隔 part 起一段，对话段也各成一块），秘书主线按天；色块上仍标出这些要点；
// - 三种样式（授权内放行、做完告诉我、被拦下或问过）和更细的说法（被拦下、问过、你点明的、你确认后）、结果的文字、
//   通用 bash 标记都在这里推出来，界面只管画：工具调用按守卫的判定（opOfToolCall），操作记录按它凭什么执行的（点明、授权内、确认后）；
//   通用 bash 标记取自工具调用 part 的 genericBash（守卫判定时定的），带类型的特殊 bash 工具（28 号票）不带。
// 往上翻取回的旧页里的记录一样在这里（全局层按已加载的部分聚块）。
import {
  ACCEPTANCE_VERDICT_LABEL,
  type ApprovalCardPayload,
  CHANNELS,
  type ConversationId,
  type Disposition,
  isTimelineRecordKind,
  maintainerChannel,
  type MessagePart,
  type ProgressCardPayload,
  QUICK_ACTION_BASIS_LABEL,
  type QuickActionCardPayload,
  TIMELINE_RECORD_KIND_INFO,
  type TimelineRecordKind,
  type TimelineRecordSeverity,
  TOOL_CALL_BLOCK_LABEL,
} from "./protocol.ts";
import { stageLabelIn, taskStageCodes } from "./stage-codes.ts";
import { type ConversationRecord, type TimelineItem, timelineItems, type UiState } from "./ui-state.ts";

/** 操作的三种样式：授权内放行、做完告诉我、被拦下或问过（图例照这个顺序） */
export const OP_STYLES = ["granted", "notify", "stopped"] as const;
export type OpStyle = (typeof OP_STYLES)[number];
export const OP_STYLE_LABEL: Readonly<Record<OpStyle, string>> = { granted: "授权内", notify: "做完告诉我", stopped: "被拦下或问过" };

/** 通用 bash 标记的文字（要点、色块上的小标记、图例共用） */
export const GENERIC_BASH_LABEL = "通用 bash";

/**
 * 样式下更细的说法：授权内、做完告诉我；同属"被拦下或问过"的被拦下、问过，以及操作记录的你点明的、你确认后（用户决定的）
 */
export type OpReason = "granted" | "notify" | "blocked" | "asked" | "explicit" | "confirmed";
export const OP_REASON: Readonly<Record<OpReason, { style: OpStyle; label: string }>> = {
  granted: { style: "granted", label: OP_STYLE_LABEL.granted },
  notify: { style: "notify", label: OP_STYLE_LABEL.notify },
  blocked: { style: "stopped", label: "被拦下" },
  asked: { style: "stopped", label: "问过" },
  explicit: { style: "stopped", label: QUICK_ACTION_BASIS_LABEL.explicit },
  confirmed: { style: "stopped", label: QUICK_ACTION_BASIS_LABEL.confirmed },
};

/** 聚块的颜色有几种（tone 0 到 N-1；25 号票全局层的色板，55 号票的底色带配色照这个数）；0 号留给规划、对话段 */
export const TIMELINE_TONE_COUNT = 6;
/** 第 n 个（从 1 起）阶段、工单段的颜色：在 1 号到最后一号之间轮转（0 号留着） */
const cycledTone = (n: number) => 1 + ((n - 1) % (TIMELINE_TONE_COUNT - 1));

/** 一个要点是什么：工具调用、快速动作的操作记录、审批、验收，或者时间线记录（偏离、范围变更、越界……） */
export type MarkKind = "tool" | "operation" | "approval" | "acceptance" | TimelineRecordKind;
export const MARK_KIND_LABEL: Readonly<Record<MarkKind, string>> = {
  tool: "工具调用",
  operation: "操作记录",
  approval: "审批",
  acceptance: "验收",
  ...Object.fromEntries(Object.entries(TIMELINE_RECORD_KIND_INFO).map(([kind, info]) => [kind, info.label])),
} as Record<MarkKind, string>;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/** 时间线上的一个要点 */
export interface TimelineMark {
  key: string;
  /** 它在完整视图里的哪一条（timelineItemKey） */
  itemKey: string;
  kind: MarkKind;
  /** 色块上小标记的短文字：工具名，或者要点的种类 */
  short: string;
  /** 一句话：工具名和参数摘要、记录的摘要、审批要做的事、验收的结论 */
  title: string;
  /** 命中的关注类别（显示用的名字） */
  categories: readonly string[];
  /** 通用 bash 调用 */
  genericBash: boolean;
  /** 操作（工具调用、操作记录）的样式和更细的说法；没有处置可说的（直接做的通用 bash、命中的类别直接做）没有 */
  style?: OpStyle;
  reason?: OpReason;
  /** 结果：工具调用被拦下的原因、你拒绝了、等你批准、出错；操作记录执行的结果 */
  outcome?: string;
  /** 补充说明：记录的详细说明 */
  note?: string;
  /** 时间线记录的严重度（界面按它取样式） */
  severity?: TimelineRecordSeverity;
  /** 审批要点的审批卡（界面按卡片的处理结果写"已批准""已拒绝"） */
  cardId?: string;
  /** 验收要点：这一次验收过没过（55 号票：缩小后通过的不在右侧标，书脊那一段变绿就是通过了） */
  passed?: boolean;
  time?: string;
  /** 工具调用要点的原 part（界面据此打开详情） */
  toolCall?: ToolCallPart;
}

/** 要点层的一行：一条带要点的条目，或者收起的若干条（itemKey 是收起的第一条：点它回到完整视图跳到那里） */
export type GistRow = { kind: "marks"; key: string; itemKey: string; time: string | undefined; marks: TimelineMark[] } | { kind: "folded"; key: string; itemKey: string; count: number };

/** 全局层怎么聚色块：按阶段（任务的维护者会话）、按段（项目维护者的工单段和对话段）、按天（秘书主线） */
export type TimelineGrouping = "stage" | "segment" | "day" | "run";

/** 全局层的一个色块 */
export interface TimelineBlock {
  key: string;
  grouping: TimelineGrouping;
  /** "第 1 阶段 · 整理笔记"、"工单 W-1 · 扫描重复照片"、"对话段"、"10 月 8 日" */
  title: string;
  /** 颜色的序号（0 到 TIMELINE_TONE_COUNT - 1）：同一个阶段、同一天总是同一种颜色；规划、对话段总是 0 */
  tone: number;
  /** 这一块里第一条和最后一条的时间 */
  from: string | undefined;
  to: string | undefined;
  /** 这一块里有几条（完整视图里的条目） */
  count: number;
  /** 这一块的第一条（timelineItemKey：点色块时在完整视图里跳到它） */
  firstKey: string;
  marks: TimelineMark[];
}

/** 要问过用户、交给用户或一律不做的处置：这样的调用算"问过"（执行了也一样） */
const ASKED: readonly Disposition[] = ["ask_first", "hand_to_me", "never"];

/** 这次是不是问过用户：先问我、交给我做、永不；"计划里列了才做"而这次不在授权内的，执行时也是当场问 */
function asked(disposition: Disposition | undefined, withinGrant: boolean): boolean {
  if (disposition === undefined) return false;
  return ASKED.includes(disposition) || (disposition === "planned_only" && !withinGrant);
}

/**
 * 工具调用的样式下更细的说法：被拦下（硬拒绝、按规则退回、判定出错、用户拒绝、先问我类的没执行）；问过的；做完告诉我的；授权内放行的。
 * 同时是做完告诉我和授权内的，按"做完告诉我"（用户要求事后告诉他）；都不是的没有
 */
export function opReasonOf(part: ToolCallPart): OpReason | undefined {
  if (part.blockedBy !== undefined || part.outcome === "blocked" || part.outcome === "denied") return "blocked";
  if (asked(part.disposition, part.withinGrant)) return "asked";
  if (part.disposition === "do_then_tell") return "notify";
  if (part.withinGrant) return "granted";
  return undefined;
}

/** 工具调用的样式：授权内、做完告诉我、被拦下或问过 */
export function opStyleOf(part: ToolCallPart): OpStyle | undefined {
  const reason = opReasonOf(part);
  return reason === undefined ? undefined : OP_REASON[reason].style;
}

/**
 * 这次调用没执行、在等你批准：先问我、计划里列了才做（这次不在授权内）的被挂起，审批卡在等你。
 * 被拦下的原因不是处置的（硬拒绝、按规则退回、判定出错）不算；"等你批准"只在这里判（会话条目层也用它）
 */
export function awaitingApproval(part: ToolCallPart): boolean {
  return part.outcome === "blocked" && part.blockedBy === undefined && (part.disposition === "ask_first" || part.disposition === "planned_only");
}

/** 工具调用的结果怎么说：被拦下的原因、你拒绝了、等你批准、出错；放行执行完的不说 */
export function toolOutcome(part: ToolCallPart): string | undefined {
  if (part.blockedBy) return TOOL_CALL_BLOCK_LABEL[part.blockedBy];
  if (part.outcome === "denied") return "你拒绝了";
  if (part.outcome === "blocked") return awaitingApproval(part) ? "等你批准" : "被拦下";
  if (part.outcome === "error") return "出错";
  return undefined;
}

/** 工具调用是不是要点：命中了关注类别、是通用 bash，或者有样式（授权内、做完告诉我、被拦下或问过） */
export function isKeyToolCall(part: ToolCallPart): boolean {
  return part.categoryTitles.length > 0 || part.genericBash || opReasonOf(part) !== undefined;
}

/** 时间线上一条的 key（和完整视图里的一样：自己发的消息从乐观显示换成权威消息时不变） */
export function timelineItemKey(item: TimelineItem): string {
  if (item.kind === "deleted" || item.kind === "record") return item.key;
  return item.idempotencyKey ? `k:${item.idempotencyKey}` : item.message.id;
}

/** 一条的时间（正在生成的回复还没有） */
export function timelineItemTime(item: TimelineItem): string | undefined {
  if (item.kind === "deleted" || item.kind === "record") return item.time;
  return item.message.time || undefined;
}

/** 操作记录凭什么执行的：点明的、确认后的算问过或用户决定的，授权内的算授权内；25 号票之前的记录只知道点没点明 */
function operationReason(operation: Extract<ConversationRecord, { type: "operation" }>["operation"]): OpReason | undefined {
  const basis = operation.basis ?? (operation.explicit ? "explicit" : undefined);
  if (basis === undefined) return undefined;
  return basis === "within_grant" ? "granted" : basis;
}

/** 一条操作记录（快速动作）：每次执行都是要点；命中的类别取自它的快速动作卡（没收到卡时没有） */
function operationMark(state: UiState, record: Extract<ConversationRecord, { type: "operation" }>, itemKey: string, time: string | undefined): TimelineMark {
  const { operation } = record;
  const payload = state.cards[operation.cardId]?.card.payload as Partial<QuickActionCardPayload> | undefined;
  const reason = operationReason(operation);
  return {
    key: `${itemKey}#op`,
    itemKey,
    kind: "operation",
    short: operation.name,
    title: operation.title,
    categories: payload?.categories ?? [],
    genericBash: false,
    ...(reason ? { style: OP_REASON[reason].style, reason } : {}),
    outcome: operation.result.summary,
    ...(time ? { time } : {}),
  };
}

/** 一条里的要点（没有就是空的） */
export function marksOf(state: UiState, item: TimelineItem): TimelineMark[] {
  const itemKey = timelineItemKey(item);
  const time = timelineItemTime(item);
  const at = time ? { time } : {};
  if (item.kind === "record") {
    if (item.record.type === "operation") return [operationMark(state, item.record, itemKey, time)];
    const { timeline } = item.record;
    if (!isTimelineRecordKind(timeline.kind)) return [];
    const info = TIMELINE_RECORD_KIND_INFO[timeline.kind];
    if (!info.gist) return [];
    return [
      {
        key: `${itemKey}#record`,
        itemKey,
        kind: timeline.kind,
        short: info.label,
        title: timeline.summary,
        categories: [],
        genericBash: false,
        severity: info.severity,
        ...(timeline.detail ? { note: timeline.detail } : {}),
        ...at,
      },
    ];
  }
  if (item.kind !== "message") return [];
  return item.message.parts.flatMap((_part, i) => partMarksOf(state, item, i));
}

/**
 * 一条消息里第 i 个 part 的要点（没有就是空的）：工具调用、审批卡、验收卡。
 * 会话条目层（chat-items.ts）把一条消息拆成几条时，每条取自己那几个 part 的要点
 */
export function partMarksOf(state: UiState, item: TimelineItem, i: number): TimelineMark[] {
  if (item.kind !== "message") return [];
  const part = item.message.parts[i];
  if (part === undefined) return [];
  const itemKey = timelineItemKey(item);
  const key = `${itemKey}#${i}`;
  const time = timelineItemTime(item);
  const at = time ? { time } : {};
  if (part.type === "tool_call") {
    if (!isKeyToolCall(part)) return [];
    const reason = opReasonOf(part);
    const outcome = toolOutcome(part);
    return [
      {
        key,
        itemKey,
        kind: "tool",
        short: part.tool,
        title: `${part.tool} ${part.argsSummary}`.trim(),
        categories: part.categoryTitles,
        genericBash: part.genericBash,
        ...(reason ? { style: OP_REASON[reason].style, reason } : {}),
        ...(outcome ? { outcome } : {}),
        ...at,
        toolCall: part,
      },
    ];
  }
  if (part.type !== "card_ref") return [];
  const card = state.cards[part.cardId]?.card;
  if (card?.type === "approval") {
    const p = card.payload as ApprovalCardPayload;
    return [{ key, itemKey, kind: "approval", short: MARK_KIND_LABEL.approval, title: `${p.toolTitle}「${p.argsSummary}」`, categories: p.categoryTitles, genericBash: false, cardId: card.id, ...at }];
  }
  if (card?.type === "progress") {
    const p = card.payload as ProgressCardPayload;
    if (p.kind !== "acceptance" || !p.acceptance) return [];
    // 91 号票：第几阶段按依赖图的编号（卡上守护进程写的是计划里的顺序号，认不出这个阶段时才用它）
    const stage = stageLabelIn(state, p.taskId, p.stageId, `第 ${p.stageIndex} 阶段`);
    const title = `${stage}「${p.stageTitle}」验收${p.acceptance.passed ? "通过" : "没通过"}（${ACCEPTANCE_VERDICT_LABEL[p.acceptance.judgedBy]}）`;
    return [{ key, itemKey, kind: "acceptance", short: MARK_KIND_LABEL.acceptance, title, categories: [], genericBash: false, passed: p.acceptance.passed, ...at }];
  }
  return [];
}

/** 要点层：带要点的条目各一行，连着的没有要点的条目收起成一行（写明几条，带着收起的第一条） */
export function gistView(state: UiState, conversation: ConversationId): GistRow[] {
  const rows: GistRow[] = [];
  for (const item of timelineItems(state, conversation)) {
    const marks = marksOf(state, item);
    const itemKey = timelineItemKey(item);
    if (marks.length > 0) {
      rows.push({ kind: "marks", key: itemKey, itemKey, time: timelineItemTime(item), marks });
      continue;
    }
    const last = rows.at(-1);
    if (last?.kind === "folded") rows[rows.length - 1] = { ...last, count: last.count + 1 };
    else rows.push({ kind: "folded", key: `fold:${itemKey}`, itemKey, count: 1 });
  }
  return rows;
}

/**
 * 这个会话在全局层怎么聚色块：秘书主线按天；项目维护者的会话（或者会话里有工单分隔线）按段；定时触发的任务的会话（有运行的分隔线，
 * 76 号票）按运行；别的（任务的维护者）按阶段
 */
export function timelineGrouping(state: UiState, conversation: ConversationId): TimelineGrouping {
  if (conversation === CHANNELS.secretary) return "day";
  if (Object.values(state.projects).some((p) => maintainerChannel(p.maintainerId) === conversation)) return "segment";
  const items = timelineItems(state, conversation);
  if (items.some((it) => it.kind === "message" && it.message.parts.some((p) => p.type === "work_order_divider"))) return "segment";
  return items.some((it) => it.kind === "message" && it.message.parts.some((p) => p.type === "run_divider")) ? "run" : "stage";
}

/** 一条落进哪一块：块的 key、标题、颜色，按阶段的还有任务；undefined 表示跟着上一块 */
type Placement = { key: string; title: string; tone: number; taskId?: string } | undefined;

/** 聚块的规则：看这一条和当前那一块，决定开新块还是跟着 */
type Placer = (item: TimelineItem, current: { key: string; taskId?: string } | undefined) => Placement;

/** 按阶段：带阶段的落进那个阶段；属于任务、没带阶段的，同一个任务已有块就跟着，否则是"规划" */
function stagePlacer(state: UiState): Placer {
  return (item, current) => {
    const scope = item.kind === "message" ? item.scope : item.kind === "record" && item.record.type === "timeline" ? item.record.scope : undefined;
    const taskId = scope?.taskId;
    if (taskId === undefined || (scope?.stageId === undefined && current?.taskId === taskId)) return undefined;
    if (scope?.stageId === undefined) return { key: `task:${taskId}:planning`, title: "规划", tone: 0, taskId };
    const list = state.tasks[taskId]?.stages?.list ?? [];
    const index = list.findIndex((s) => s.stageId === scope.stageId);
    const code = taskStageCodes(state, taskId).get(scope.stageId);
    const title = index >= 0 ? `第 ${code ?? index + 1} 阶段 · ${list[index]!.title}` : `阶段 ${scope.stageId}`;
    return { key: `task:${taskId}:${scope.stageId}`, title, tone: cycledTone((index >= 0 ? index : list.length) + 1), taskId };
  };
}

/** 按段：工单分隔线起一段（工单段、对话段）；第一条分隔线之前的算一个对话段 */
function segmentPlacer(): Placer {
  let workOrders = 0;
  return (item, current) => {
    const divider = item.kind === "message" ? item.message.parts.find((p) => p.type === "work_order_divider") : undefined;
    if (divider?.type === "work_order_divider") {
      const key = `segment:${timelineItemKey(item)}`;
      if (!divider.workOrderId) return { key, title: `对话段 · ${divider.title}`, tone: 0 };
      workOrders += 1;
      return { key, title: `工单 ${divider.workOrderId} · ${divider.title}`, tone: cycledTone(workOrders) };
    }
    return current ? undefined : { key: "segment:start", title: "对话段", tone: 0 };
  };
}

/** 按运行（76 号票）：每次运行的分隔线起一块（"第 2 次运行 · …"）；第一次运行之前的（流程起草、授权计划）算一块"运行之前" */
function runPlacer(): Placer {
  let runs = 0;
  return (item, current) => {
    const divider = item.kind === "message" ? item.message.parts.find((p) => p.type === "run_divider") : undefined;
    if (divider?.type === "run_divider") {
      runs += 1;
      return { key: `run:${divider.runId}`, title: divider.title, tone: cycledTone(runs) };
    }
    return current ? undefined : { key: "run:before", title: "运行之前", tone: 0 };
  };
}

/** 按天：换了一天开一块（"10 月 8 日"，同一年里不写年份）；还没有时间的（正在生成的回复）跟着上一块 */
function dayPlacer(): Placer {
  let days = 0;
  return (item, current) => {
    const day = timelineItemTime(item)?.slice(0, 10);
    if (day === undefined || current?.key === `day:${day}`) return undefined;
    const [, month, date] = day.split("-");
    return { key: `day:${day}`, title: `${Number(month)} 月 ${Number(date)} 日`, tone: days++ % TIMELINE_TONE_COUNT };
  };
}

const PLACERS: Readonly<Record<TimelineGrouping, (state: UiState) => Placer>> = { stage: stagePlacer, segment: segmentPlacer, day: dayPlacer, run: runPlacer };

/** 全局层：会话聚成色块（按阶段、按段、按天），块上标出要点 */
export function globalView(state: UiState, conversation: ConversationId, grouping: TimelineGrouping = timelineGrouping(state, conversation)): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  const place = PLACERS[grouping](state);
  let current: (TimelineBlock & { taskId?: string }) | undefined;
  for (const item of timelineItems(state, conversation)) {
    const time = timelineItemTime(item);
    const placement = place(item, current);
    if (placement && placement.key !== current?.key) {
      current = {
        key: placement.key,
        grouping,
        title: placement.title,
        tone: placement.tone,
        from: time,
        to: time,
        count: 0,
        firstKey: timelineItemKey(item),
        marks: [],
        ...(placement.taskId === undefined ? {} : { taskId: placement.taskId }),
      };
      blocks.push(current);
    }
    // 第一块之前没有归属的（比如只有乐观显示的消息）：开一块没有标题的
    if (!current) {
      current = { key: "start", grouping, title: "会话", tone: 0, from: time, to: time, count: 0, firstKey: timelineItemKey(item), marks: [] };
      blocks.push(current);
    }
    current.count += 1;
    if (time) {
      current.from ??= time;
      current.to = time;
    }
    current.marks.push(...marksOf(state, item));
  }
  return blocks.map(({ key, grouping: g, title, tone, from, to, count, firstKey, marks }) => ({ key, grouping: g, title, tone, from, to, count, firstKey, marks }));
}
