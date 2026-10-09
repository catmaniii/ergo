// 会话条目层（52 号票，规格第 19 节"会话区照搬 AgentSense"）：照 AgentSense 的 ChatItem（web/src/agent/sessionView.ts）
// 和 semanticsOf / keyLine（web/src/ui/semantic.ts），把一个会话拆成一条条"条目"，按二狗的数据改写。
// 缩放（54 号票，每条一个矩形，三层叠在里面）、两侧标注（55）、详情页（56，按条目 id 存）、聊天区精简（57）都从这里取。
//
// 输入是前端状态层的时间线（ui-state.ts 的 timelineItems：消息、时间线记录、正在生成的回复、乐观显示的尾巴），纯函数，不碰 DOM。
// 切法：
// - 一条消息拆成几条：用户消息整条一条（带着附件和引用的卡片；有语音的是语音）；agent 的消息里思考一条、正文一条
//   （AgentSense 也是这样拆），每张卡片、每条工单分隔线各一条；系统说明一条；
// - 工具调用组（AgentSense 没有，用户要的汇总行，规格第 19 节）：两段话之间的工具调用按先后合成一组。
//   被拦下、问过你、你拒绝了、等你批准、出错的也在组里、按先后排，组上带着这几种情况的计数（issues）和最显眼的性质色
//   （用户 2026-10-09 改：单独成条像两件事，先后顺序也乱）。卡片（包括审批卡）、系统说明、记录、已删除会把组隔开；
//   换了 agent（子 agent）、换了任务或阶段也另起一组，免得一组跨两个阶段；
// - 思考（用户 2026-10-09 定，在 AgentSense 之上的改动）：两段话之间、没有正文的思考不论长短都并进工具调用组，
//   组里按时间顺序留着每一步的思考和调用（steps），详情里照这个顺序列；思考不隔开组。带着正文的思考照常单独一条，排在回复前面；
//   前后都没有调用的思考单独一条；正在生成的思考还不知道后面有没有调用、有没有正文，也单独一条；
// - 二狗的内部工具（INTERNAL_TOOLS，用户 2026-10-09 定）：会话里已经有对应的卡片、说明或记录代表它，顺利执行时不显示——
//   不算进组的 N；在组里的留在组的 steps 里，不在组里的挂在代表它的那一条上（internalCalls），详情页、locateChatItem 都查得到。
//   被拦下、出错的照旧算进组里，不藏；
// - 时间线记录（偏离、范围变更、越界、操作记录）、"已删除"各自一条。
// 每条推出：种类、稳定的 id、要点层那一行字（keyLine）、性质色（授权内、做完告诉我、被拦下或问过）、两侧标注要的要点
// （timeline.ts 的 TimelineMark）、内容类型（要点层、全局层的底色）、能不能打开详情和详情的种类。
// keyLine 里守护进程写的话（卡片的纯文本、系统说明、记录）换成现在的说法、保留名字占位（43 号票），界面照名字标签画。
//
// id 的规矩（详情页、缩放的锚点按它存；查找一律用 locateChatItem，不直接按 id 比对）：
// - 一条消息的"主体"（用户消息、语音、回复、系统说明）用消息的 key（timelineItemKey：自己发的是幂等键，从乐观显示换成权威消息时不变；
//   正在生成的回复是定稿后那条消息的 id）；思考是 key 加 ":think"；工具调用、卡片、工单分隔是 key 加 "#part 序号"；
// - 工具调用组是 "group:" 加组里第一次算进 N 的调用的 id：后面追加调用、思考时不变。
//   例外：往上翻时，如果翻回来的那一页末尾也是同一组的调用，这一组会并上更早的调用、第一次调用变了，组的 id 跟着变。
//   locateChatItem 按组原来的 id、组里任何一步（调用、思考）的 id 都找得到它。
import {
  type MessageEnvelope,
  type MessagePart,
  type MessageScope,
  TIMELINE_RECORD_KIND_INFO,
  isTimelineRecordKind,
  voiceDurationLabel,
  settledVoiceText,
  type ConversationId,
  currentWording,
} from "./protocol.ts";
import { awaitingApproval, type OpStyle, opReasonOf, opStyleOf, partMarksOf, type TimelineMark, marksOf, timelineItemKey, timelineItemTime, toolOutcome } from "./timeline.ts";
import { type ConversationRecord, type RequestStatus, type TimelineItem, timelineItems, type UiState } from "./ui-state.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
type WorkOrderDividerPart = Extract<MessagePart, { type: "work_order_divider" }>;
type VoiceLikePart = Extract<MessagePart, { type: "voice" | "tts_audio" }>;

/** 内部工具在会话里由什么代表：某种卡片、某种时间线记录、系统说明、它说的那段回复；只是记账的没有（挂在紧挨着的前一条上） */
export type InternalShownAs =
  | { readonly kind: "card"; readonly cardType: string }
  | { readonly kind: "record"; readonly recordKind: string }
  | { readonly kind: "system" }
  | { readonly kind: "reply" }
  | { readonly kind: "none" };

/**
 * 二狗的内部工具（用户 2026-10-09 定）：照 AgentSense 不显示 report_step、把 propose_plan 改写成计划卡的做法，
 * 这些工具的调用在会话里已经有对应的卡片、系统说明或时间线记录（或者只是 agent 自己的记账），顺利执行时不再显示调用本身，
 * 挂在代表它的那一条上（shownAs）。名单只在这里；工具名以守护进程的定义为准（注释里是定义的位置）。
 * 评审子 agent 交结论的 submit_review 不在这里：评审的会话是 null，它的调用不进会话
 */
export const INTERNAL_TOOLS: Readonly<Record<string, { readonly what: string; readonly shownAs: InternalShownAs }>> = {
  // 用户点名的五个
  /** maintainers/tools.ts SUBMIT_PLAN_TOOL */
  submit_plan: { what: "计划卡", shownAs: { kind: "card", cardType: "plan" } },
  /** tasks/tool-names.ts EXECUTION_TOOL.completeStage：还有一条"维护者宣布阶段完成"的系统说明 */
  complete_stage: { what: "验收结论的进度卡", shownAs: { kind: "card", cardType: "progress" } },
  /** work-orders/tool-names.ts WORK_ORDER_TOOL.writeProgress：写回进展文档 */
  write_progress: { what: "agent 自己的记账（同 AgentSense 的 report_step）", shownAs: { kind: "none" } },
  /** work-orders/tool-names.ts WORK_ORDER_TOOL.writeSegmentSummary：写这一段的摘要 */
  write_segment_summary: { what: "agent 自己的记账（同 AgentSense 的 report_step）", shownAs: { kind: "none" } },
  /** voice/texts.ts SPOKEN_SUMMARY_TOOL：口语总结合成的语音另有一条 */
  spoken_summary: { what: "它总结的那段回复", shownAs: { kind: "reply" } },
  // 检查过的其他维护者内部工具：守护进程在调用时往同一个会话里放了卡片、说明或记录（用户同意不算进 N）
  /** tasks/tool-names.ts EXECUTION_TOOL.reportProgress */
  report_progress: { what: "进度卡", shownAs: { kind: "card", cardType: "progress" } },
  /** tasks/tool-names.ts EXECUTION_TOOL.proposePlanChange */
  propose_plan_change: { what: "计划变更卡", shownAs: { kind: "card", cardType: "plan_change" } },
  /** tasks/tool-names.ts EXECUTION_TOOL.revisePlan */
  revise_plan: { what: "时间线记录「自行调整计划」", shownAs: { kind: "record", recordKind: "plan_revision" } },
  /** tasks/tool-names.ts EXECUTION_TOOL.markInfeasible：这一支停下等你 */
  mark_infeasible: { what: "时间线记录「偏离」", shownAs: { kind: "record", recordKind: "deviation" } },
  /** tasks/tool-names.ts EXECUTION_TOOL.failTask */
  fail_task: { what: "系统说明「维护者判任务失败」", shownAs: { kind: "system" } },
  /** tasks/tool-names.ts PROPOSE_PARALLEL_TOOL */
  propose_parallel: { what: "并行确认卡", shownAs: { kind: "card", cardType: "parallel" } },
  /** projects/tool-names.ts SUBMIT_CHARTER_TOOL */
  submit_charter: { what: "立项书卡", shownAs: { kind: "card", cardType: "charter" } },
  /** toolkit/tool-names.ts REQUEST_TOOLKIT_CHANGE_TOOL */
  request_toolkit_change: { what: "工具包变更卡", shownAs: { kind: "card", cardType: "toolkit_change" } },
  /** toolkit/tool-names.ts ADJUST_SKILLS_TOOL */
  adjust_skills: { what: "时间线记录「工具包变更」", shownAs: { kind: "record", recordKind: "toolkit" } },
  /** work-orders/tool-names.ts MULTI_PROJECT_TOOL.dispatchWorkOrder */
  dispatch_work_order: { what: "时间线记录「工单」", shownAs: { kind: "record", recordKind: "work_order" } },
};

/** 是不是二狗的内部工具（INTERNAL_TOOLS） */
export function isInternalTool(tool: string): boolean {
  return Object.hasOwn(INTERNAL_TOOLS, tool);
}

export const CHAT_ITEM_KINDS = ["user", "voice", "thinking", "reply", "tool_group", "card", "system", "record", "divider", "deleted"] as const;
/**
 * 条目的种类：用户消息、语音（用户的、agent 的）、思考、回复、工具调用组（含出了状况的调用）、
 * 卡片、系统说明、时间线记录（偏离、范围变更、越界、操作记录）、工单分隔、已删除
 */
export type ChatItemKind = (typeof CHAT_ITEM_KINDS)[number];

/** 内容类型：要点层、全局层每条的底色和图例（照 AgentSense 的 ContentKind；卡片用 plan 那一色，说明和记录用 context） */
export type ContentKind = "user" | "thinking" | "reply" | "plan" | "tool" | "context";
export const CONTENT_KIND_LABEL: Readonly<Record<ContentKind, string>> = {
  user: "用户输入",
  thinking: "模型思考",
  reply: "模型回复",
  plan: "卡片",
  tool: "工具调用",
  context: "说明和记录",
};

/**
 * 条目详情的种类：文本（用户消息、回复、思考、语音转写、系统说明）、工具调用组、卡片、时间线记录。
 * 单次工具调用的详情从组的详情里点进去（locateChatItem 按调用的 id 找到组和那一次）
 */
export type DetailKind = "text" | "tool_group" | "card" | "record";

export const CALL_ISSUES = ["blocked", "denied", "waiting", "error", "asked"] as const;
/** 一次调用出的状况：被拦下（硬拒绝、按规则退回、判定出错、交给我做和永不没执行）、你拒绝了、等你批准、出错、问过你（批准后执行的） */
export type CallIssue = (typeof CALL_ISSUES)[number];
export const CALL_ISSUE_LABEL: Readonly<Record<CallIssue, string>> = { blocked: "被拦下", denied: "你拒绝了", waiting: "等你批准", error: "出错", asked: "问过你" };

/** 这次调用出了什么状况；顺利执行的没有 */
export function callIssueOf(part: ToolCallPart): CallIssue | undefined {
  if (part.outcome === "error") return "error";
  if (part.outcome === "denied") return "denied";
  if (awaitingApproval(part)) return "waiting";
  if (part.outcome === "blocked") return "blocked";
  if (opReasonOf(part) === "asked") return "asked";
  return undefined;
}

/** 一次工具调用（在组里，或者挂在某一条上的内部工具调用） */
export interface ChatToolCall {
  /** 这次调用的 id（消息 key 加 "#part 序号"）：详情页按它找到组里（或挂着它的那一条上）的这一次 */
  readonly id: string;
  readonly part: ToolCallPart;
  /** 二狗的内部工具（INTERNAL_TOOLS） */
  readonly internal: boolean;
  /** 出的状况；顺利执行的没有 */
  readonly issue: CallIssue | undefined;
  /** 结果怎么说：硬拒绝、按规则退回、判定出错、你拒绝了、等你批准、被拦下、出错（timeline.ts 的 toolOutcome） */
  readonly outcome: string | undefined;
  /** 算进"调用了 N 个工具"：除了顺利执行的内部工具都算 */
  readonly counted: boolean;
  readonly seq?: number;
  readonly time: string | undefined;
  readonly scope: MessageScope;
  /** 这次调用的要点（关注类别命中、通用 bash、三种样式；没有就是空的） */
  readonly marks: readonly TimelineMark[];
}

/** 组里的一步：一段思考，或者一次调用（含内部工具），按时间顺序 */
export type ChatGroupStep =
  | { readonly kind: "thinking"; readonly id: string; readonly text: string; readonly seq?: number; readonly time: string | undefined; readonly scope: MessageScope }
  | { readonly kind: "call"; readonly call: ChatToolCall };

/** 每条都有的 */
interface ChatItemBase {
  /** 稳定的 id（见文件开头） */
  readonly id: string;
  /** 来源的序号（组是第一步的）：权威消息和记录有；正在生成的、乐观显示的没有 */
  readonly seq: number | undefined;
  /** 时间（组是第一步的）：正在生成的回复还没有 */
  readonly time: string | undefined;
  /** 归属：任务、项目、阶段、定时作业、agent */
  readonly scope: MessageScope;
  /** 内容类型（底色） */
  readonly content: ContentKind;
  /** 要点层那一行字：只写一行，不换行 */
  readonly keyLine: string;
  /** 性质色：授权内、做完告诉我、被拦下或问过；没有处置可说的没有。组取组里最显眼的（被拦下或问过 > 做完告诉我 > 授权内） */
  readonly tone: OpStyle | undefined;
  /** 两侧标注要的要点（timeline.ts 的 marksOf 推出的）；组是组里算进 N 的调用的要点 */
  readonly marks: readonly TimelineMark[];
  /** 能打开的详情的种类；不能打开的没有 */
  readonly detail: DetailKind | undefined;
  /** 出错（全局层加内描边）：组里有执行出错的调用 */
  readonly error: boolean;
  /** 挂在这一条上的内部工具调用（不在组里的，比如提交计划挂在计划卡上）：条目里不显示，详情页查得到 */
  readonly internalCalls: readonly ChatToolCall[];
}

/** 会话里的一条 */
export type ChatItem = ChatItemBase &
  (
    | {
        readonly kind: "user";
        /** 整条消息：文字、图片、文件、引用的卡片 */
        readonly message: MessageEnvelope;
        /** 文字部分 */
        readonly text: string;
        /** 乐观显示、还没得到确认的：发送中或失败 */
        readonly pending: RequestStatus | undefined;
      }
    | {
        readonly kind: "voice";
        readonly speaker: "user" | "agent";
        readonly part: VoiceLikePart;
        readonly message: MessageEnvelope;
        readonly pending: RequestStatus | undefined;
      }
    | { readonly kind: "thinking"; readonly text: string; readonly streaming: boolean }
    | {
        readonly kind: "reply";
        readonly text: string;
        /** 正文和附件（文字、图片、文件） */
        readonly parts: readonly MessagePart[];
        readonly streaming: boolean;
        /** 正在生成、漏了中间增量的：不拼残缺的文字，等定稿消息 */
        readonly broken: boolean;
      }
    | {
        readonly kind: "tool_group";
        /** 算进"调用了 N 个工具"的调用（含出了状况的，不含顺利执行的内部工具），按先后 */
        readonly calls: readonly ChatToolCall[];
        /** 按时间顺序的每一步：思考、调用（含内部工具）。详情里照这个顺序列 */
        readonly steps: readonly ChatGroupStep[];
        /** 出了状况的调用各有几次（按 CALL_ISSUES 的先后，只列有的）：57 号票画小签"· 1 次被拦下" */
        readonly issues: readonly { readonly issue: CallIssue; readonly count: number }[];
      }
    | { readonly kind: "card"; readonly cardId: string }
    | { readonly kind: "system"; readonly text: string; readonly parts: readonly MessagePart[] }
    | { readonly kind: "record"; readonly record: ConversationRecord }
    | { readonly kind: "divider"; readonly divider: WorkOrderDividerPart }
    | { readonly kind: "deleted" }
  );

/** 某个会话的条目（按时间线的先后） */
export function chatItems(state: UiState, conversation: ConversationId): ChatItem[] {
  return assemble(
    timelineItems(state, conversation).flatMap((it) => piecesOf(state, it)),
    (cardId) => state.cards[cardId]?.card.type,
  );
}

/**
 * 按 id 找一条：条目的 id，组里某一步的 id（调用的 id 带不带 "group:"、思考的 id），或者挂在某一条上的内部工具调用的 id。
 * 找到的是那一条，按调用的 id 找的还有那一次调用。详情页、缩放的锚点存了 id 的，都用它找，不直接按 id 比对
 */
export function locateChatItem(items: readonly ChatItem[], id: string): { item: ChatItem; call?: ChatToolCall } | undefined {
  const grouped = id.startsWith(GROUP_PREFIX);
  const callId = grouped ? id.slice(GROUP_PREFIX.length) : id;
  for (const item of items) {
    if (item.id === id) return { item };
    const attached = item.internalCalls.find((c) => c.id === callId);
    if (attached) return grouped ? { item } : { item, call: attached };
    if (item.kind !== "tool_group") continue;
    for (const step of item.steps) {
      if (step.kind === "thinking" && step.id === id) return { item };
      if (step.kind === "call" && step.call.id === callId) return grouped ? { item } : { item, call: step.call };
    }
  }
  return undefined;
}

const GROUP_PREFIX = "group:";

// ───────────────────────── 拆 ─────────────────────────

/** 拆出来、还没归组的一块：一次调用；一段能并进组的思考（没有正文的消息里的、定稿了的）；或者别的（已经是一条） */
type Piece = { kind: "call"; call: ChatToolCall } | { kind: "thought"; step: Extract<ChatGroupStep, { kind: "thinking" }>; item: ChatItem } | { kind: "item"; item: ChatItem };

/** 时间线上的一条拆成几块 */
function piecesOf(state: UiState, it: TimelineItem): Piece[] {
  const key = timelineItemKey(it);
  const time = timelineItemTime(it);
  const seq = it.seq;
  if (it.kind === "deleted") return [itemPiece({ kind: "deleted", id: key, seq, time, scope: {}, content: "context", keyLine: "已删除", marks: [] })];
  if (it.kind === "record") {
    const scope = it.record.type === "timeline" ? it.record.scope : {};
    const marks = marksOf(state, it);
    return [itemPiece({ kind: "record", id: key, seq, time, scope, content: "context", keyLine: recordLine(it.record), marks, tone: marks[0]?.style, detail: "record", record: it.record })];
  }
  const scope = it.scope ?? {};
  const { message } = it;
  const pending: RequestStatus | undefined = it.kind === "pending" ? (it.status === "failed" ? { status: "failed", error: it.error } : { status: "sending" }) : undefined;
  const at = { seq, time, scope };
  const marksIn = (indexes: readonly number[]) => indexes.flatMap((i) => partMarksOf(state, it, i));
  const all = message.parts.map((_p, i) => i);

  if (message.speaker === "user") {
    const voice = message.parts.find((p): p is VoiceLikePart => p.type === "voice" || p.type === "tts_audio");
    if (voice) return [itemPiece({ kind: "voice", id: key, ...at, content: "user", keyLine: `你：${voiceLine(state, voice)}`, marks: marksIn(all), detail: "text", speaker: "user", part: voice, message, pending })];
    const text = textOf(message.parts);
    return [itemPiece({ kind: "user", id: key, ...at, content: "user", keyLine: `你：${firstLine(text, 80) || attachmentsLine(message.parts)}`, marks: marksIn(all), detail: "text", message, text, pending })];
  }

  // agent、系统的消息：思考、主体（正文和附件、系统说明、agent 的语音）在第一次出现的位置，工具调用、卡片、分隔线各在自己的位置
  const streaming = it.kind === "streaming";
  // 漏了中间增量的回复：不拼残缺的文字，只占一个"正在回复"的位置
  if (it.kind === "streaming" && it.broken) return [itemPiece({ kind: "reply", id: key, ...at, content: "reply", keyLine: "回复：（正在回复）", marks: [], text: "", parts: [], streaming, broken: true })];
  const main: number[] = [];
  const thinking: number[] = [];
  const slots: Array<"main" | "thinking" | number> = [];
  message.parts.forEach((part, i) => {
    if (part.type === "reasoning") {
      if (thinking.length === 0) slots.push("thinking");
      thinking.push(i);
    } else if (part.type === "tool_call" || part.type === "card_ref" || part.type === "work_order_divider") slots.push(i);
    else {
      if (main.length === 0) slots.push("main");
      main.push(i);
    }
  });

  const out: Piece[] = [];
  for (const slot of slots) {
    if (slot === "thinking") {
      const text = textOf(thinking.map((i) => message.parts[i]!));
      const id = `${key}:think`;
      const item = finish({ kind: "thinking", id, ...at, content: "thinking", keyLine: `思考：${firstLine(text)}`, marks: [], detail: "text", text, streaming });
      // 没有正文、定稿了的思考能并进组；带着正文的、正在生成的照常单独一条
      out.push(!streaming && main.length === 0 ? { kind: "thought", step: { kind: "thinking", id, text, ...at }, item } : { kind: "item", item });
    } else if (slot === "main") {
      const parts = main.map((i) => message.parts[i]!);
      out.push(itemPiece(mainItem(state, message, parts, { id: key, ...at, marks: marksIn(main), streaming })));
    } else {
      const part = message.parts[slot]!;
      const id = `${key}#${slot}`;
      const marks = partMarksOf(state, it, slot);
      if (part.type === "tool_call") out.push({ kind: "call", call: toolCall(id, part, at, marks) });
      else if (part.type === "card_ref")
        out.push(itemPiece({ kind: "card", id, ...at, content: "plan", keyLine: cardLine(state, part.cardId), marks, detail: state.cards[part.cardId] ? "card" : undefined, cardId: part.cardId }));
      else if (part.type === "work_order_divider") out.push(itemPiece({ kind: "divider", id, ...at, content: "context", keyLine: dividerLine(part), marks, divider: part }));
    }
  }
  return out;
}

/** 一次调用：出的状况、结果的说法、算不算进 N（顺利执行的内部工具不算） */
function toolCall(id: string, part: ToolCallPart, at: { seq: number | undefined; time: string | undefined; scope: MessageScope }, marks: TimelineMark[]): ChatToolCall {
  const internal = isInternalTool(part.tool);
  const issue = callIssueOf(part);
  return { id, part, internal, issue, outcome: toolOutcome(part), counted: !internal || issue !== undefined, ...at, marks };
}

/** agent、系统消息的主体：系统说明、agent 的语音、回复（正文和附件） */
function mainItem(
  state: UiState,
  message: MessageEnvelope,
  parts: MessagePart[],
  base: { id: string; seq: number | undefined; time: string | undefined; scope: MessageScope; marks: TimelineMark[]; streaming: boolean },
): Draft {
  const { streaming, ...rest } = base;
  const text = textOf(parts);
  if (message.speaker === "system") return { kind: "system", ...rest, content: "context", keyLine: `系统：${firstLine(currentWording(text)) || attachmentsLine(parts)}`, detail: "text", text, parts };
  const voice = parts.find((p): p is VoiceLikePart => p.type === "voice" || p.type === "tts_audio");
  if (voice) return { kind: "voice", ...rest, content: "reply", keyLine: `回复：${voiceLine(state, voice)}`, detail: "text", speaker: "agent", part: voice, message, pending: undefined };
  return { kind: "reply", ...rest, content: "reply", keyLine: `回复：${firstLine(text) || attachmentsLine(parts)}`, detail: "text", text, parts, streaming, broken: false };
}

/** 对联合类型逐个去掉几个字段 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 还没补齐公共字段的一条 */
type Draft = DistributiveOmit<ChatItem, "tone" | "detail" | "error" | "internalCalls"> & Partial<Pick<ChatItemBase, "tone" | "detail" | "error" | "internalCalls">>;

/** 补齐没写的公共字段（性质色、详情、出错、挂着的内部工具调用默认没有） */
function finish(draft: Draft): ChatItem {
  return { tone: undefined, detail: undefined, error: false, internalCalls: [], ...draft } as ChatItem;
}

function itemPiece(draft: Draft): Piece {
  return { kind: "item", item: finish(draft) };
}

// ───────────────────────── 归组 ─────────────────────────

/** 同一组里的每一步要同一个 agent、同一个任务和阶段、同一次定时作业 */
function sameRun(a: MessageScope, b: MessageScope): boolean {
  return a.agentId === b.agentId && a.taskId === b.taskId && a.stageId === b.stageId && a.scheduledJobId === b.scheduledJobId;
}

/** 攒着的一段里的一块：调用，或者能并进组的思考 */
type RunPiece = Extract<Piece, { kind: "call" | "thought" }>;

const runScope = (p: RunPiece) => (p.kind === "call" ? p.call.scope : p.step.scope);
const stepOf = (p: RunPiece): ChatGroupStep => (p.kind === "call" ? { kind: "call", call: p.call } : p.step);

/**
 * 把拆出来的块排成条目：两段话之间连续的思考和调用攒成一段，里面有算进 N 的调用就成一组；
 * 没有的话（只有思考、顺利执行的内部工具），思考各自单独一条，内部工具调用挂到代表它的那一条上
 */
function assemble(pieces: readonly Piece[], cardTypeOf: (cardId: string) => string | undefined): ChatItem[] {
  const out: ChatItem[] = [];
  let run: RunPiece[] = [];
  /** 还没有能挂的条目时（会话开头就是内部工具调用）先记着，挂到下一条上 */
  let unattached: ChatToolCall[] = [];
  const push = (item: ChatItem) => {
    out.push(unattached.length > 0 ? { ...item, internalCalls: [...unattached, ...item.internalCalls] } : item);
    unattached = [];
  };
  const attach = (call: ChatToolCall) => {
    const at = attachIndex(out, INTERNAL_TOOLS[call.part.tool]!.shownAs, cardTypeOf);
    if (at === undefined) unattached.push(call);
    else out[at] = { ...out[at]!, internalCalls: [...out[at]!.internalCalls, call] };
  };
  const flush = () => {
    const done = run;
    run = [];
    if (done.some((p) => p.kind === "call" && p.call.counted)) return push(groupItem(done.map(stepOf)));
    for (const p of done) {
      if (p.kind === "call") attach(p.call);
      else push(p.item);
    }
  };
  for (const piece of pieces) {
    if (piece.kind === "item") {
      flush();
      push(piece.item);
      continue;
    }
    if (run.length > 0 && !sameRun(runScope(run[0]!), runScope(piece))) flush();
    run.push(piece);
  }
  flush();
  // 整个会话只有内部工具调用时没有能挂的条目，不显示（实际不会出现：调用之前总有一条输入）
  return out;
}

/**
 * 不在组里的内部工具调用挂到哪一条：在这一轮里（不越过用户的输入）往前找代表它的那一条——
 * 那种卡片（提交计划的计划卡、宣布阶段完成的验收卡……）、那种记录、系统说明、它总结的那段回复；
 * 找不到（或者它只是记账）就挂在紧挨着的前一条上。前面一条都没有时是 undefined
 */
function attachIndex(out: readonly ChatItem[], shownAs: InternalShownAs, cardTypeOf: (cardId: string) => string | undefined): number | undefined {
  if (out.length === 0) return undefined;
  if (shownAs.kind !== "none") {
    for (let i = out.length - 1; i >= 0; i--) {
      const item = out[i]!;
      if (representedBy(item, shownAs, cardTypeOf)) return i;
      if (item.kind === "user" || (item.kind === "voice" && item.speaker === "user")) break;
    }
  }
  return out.length - 1;
}

function representedBy(item: ChatItem, shownAs: InternalShownAs, cardTypeOf: (cardId: string) => string | undefined): boolean {
  switch (shownAs.kind) {
    case "card":
      return item.kind === "card" && cardTypeOf(item.cardId) === shownAs.cardType;
    case "record":
      return item.kind === "record" && item.record.type === "timeline" && item.record.timeline.kind === shownAs.recordKind;
    case "system":
      return item.kind === "system";
    case "reply":
      return item.kind === "reply" || (item.kind === "voice" && item.speaker === "agent");
    case "none":
      return false;
  }
}

/** 性质色的显眼程度：被拦下或问过 > 做完告诉我 > 授权内 */
const TONE_RANK: readonly OpStyle[] = ["stopped", "notify", "granted"];

/** 一组：思考和调用，按时间顺序；N 只数算进去的调用 */
function groupItem(steps: ChatGroupStep[]): ChatItem {
  const calls = steps.flatMap((s) => (s.kind === "call" && s.call.counted ? [s.call] : []));
  const first = steps[0]!;
  const head = first.kind === "thinking" ? first : first.call;
  const styles = new Set(calls.map((c) => opStyleOf(c.part)));
  const issues = CALL_ISSUES.flatMap((issue) => {
    const count = calls.filter((c) => c.issue === issue).length;
    return count > 0 ? [{ issue, count }] : [];
  });
  return finish({
    kind: "tool_group",
    id: `${GROUP_PREFIX}${calls[0]!.id}`,
    seq: head.seq,
    time: head.time,
    scope: calls[0]!.scope,
    content: "tool",
    keyLine: groupLine(calls, issues),
    tone: TONE_RANK.find((tone) => styles.has(tone)),
    marks: calls.flatMap((c) => c.marks),
    detail: "tool_group",
    error: calls.some((c) => c.issue === "error"),
    calls,
    steps,
    issues,
  });
}

// ───────────────────────── 要点层那一行 ─────────────────────────

/**
 * 照 AgentSense 的 firstLine（semantic.ts:65-72）：去掉 Markdown 记号，取第一个非空行，截到 max 字。
 * 和它不同的一处：连字符、下划线只在单独成段时（列表的"- "、分隔线"---"）去掉，"t-1"、"my_notes.md"里的照留
 */
function firstLine(text: string, max = 60): string {
  const line = text
    .replace(/[#*`>|]+/g, " ")
    .replace(/(^|\s)[-_]+(?=\s|$)/gm, "$1 ")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "").slice(0, max);
}

/** 第一个非空行（守护进程写的话：不去 Markdown 记号） */
function plainFirstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

/** 文字（正文、思考）part 拼起来（照 AgentSense：几段直接接上） */
function textOf(parts: readonly MessagePart[]): string {
  return parts.map((p) => (p.type === "text" || p.type === "reasoning" ? p.text : "")).join("");
}

/** 没有文字时写附件：[图片：a.png] [附件：b.pdf] */
function attachmentsLine(parts: readonly MessagePart[]): string {
  return parts
    .flatMap((p) => (p.type === "image" ? [`[图片：${p.name}]`] : p.type === "file" ? [`[附件：${p.name}]`] : p.type === "video" ? ["[视频]"] : []))
    .join(" ");
}

/** 语音：时长和文字（用户的取识别出的文字，agent 的取送进 TTS 的原文；还没有就只写时长） */
function voiceLine(state: UiState, part: VoiceLikePart): string {
  const id = part.voiceId;
  const text = id === undefined ? undefined : part.type === "voice" ? state.voices[id] && settledVoiceText(state.voices[id]) : state.agentVoices[id]?.text;
  const said = text ? firstLine(text) : "";
  return `[语音 ${voiceDurationLabel(part.durationMs)}]${said ? ` ${said}` : ""}`;
}

/** 卡片：纯文本降级版本的第一行（守护进程写的，换成现在的说法），处理过的写明 */
function cardLine(state: UiState, cardId: string): string {
  const card = state.cards[cardId]?.card;
  if (!card) return "卡片";
  const line = plainFirstLine(currentWording(card.text)) ?? "卡片";
  return card.status === "pending" ? line : `${line} · ${CARD_STATUS_TEXT[card.status]}`;
}

const CARD_STATUS_TEXT = { pending: "待处理", handled: "已处理", dismissed: "已关掉", expired: "已过期" } as const;

/** 工单分隔线 */
function dividerLine(part: WorkOrderDividerPart): string {
  return part.workOrderId ? `工单 ${part.workOrderId} · ${part.title}` : `对话段 · ${part.title}`;
}

/** 时间线记录：偏离、范围变更、越界写种类和摘要；操作记录写做了什么（不认识的种类写"记录"） */
function recordLine(record: ConversationRecord): string {
  if (record.type === "operation") return `操作记录：${currentWording(record.operation.title)}`;
  const { kind, summary } = record.timeline;
  return `${isTimelineRecordKind(kind) ? TIMELINE_RECORD_KIND_INFO[kind].label : "记录"}：${currentWording(summary)}`;
}

/** 工具调用组：调了几个工具、哪几种（同一种连着数），出了状况的写在后面；思考再长也不写 */
function groupLine(calls: readonly ChatToolCall[], issues: readonly { issue: CallIssue; count: number }[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.part.tool, (counts.get(c.part.tool) ?? 0) + 1);
  const names = [...counts].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join("、");
  const trouble = issues.map(({ issue, count }) => `${count} 次${CALL_ISSUE_LABEL[issue]}`).join("、");
  return `调用了 ${calls.length} 个工具：${names}${trouble ? `（${trouble}）` : ""}`;
}
