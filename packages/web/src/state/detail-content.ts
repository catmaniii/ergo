// 详情页显示什么（56 号票）：各种详情（文字、工具调用……），按二狗的条目（52 号票的 chat-items.ts）
// 改写成纯函数，界面（ui/detail/DetailPane.tsx）只管画。详情按条目 id 存，这里每次用 locateChatItem 现查，所以流式更新、
// 往上翻之后看到的都是现在的样子。
// 详情的种类：
// - 文本：用户消息、回复、思考、语音（用户的是识别出的文字，agent 的是送进 TTS 的原文）、系统说明；
// - 工具调用组：按先后列出每一步思考和调用，出了状况的标清楚是第几次（用户 2026-10-09 定）；
// - 调用记忆（187 号票）："这次用到的记忆"——按先后列出思考、每次检索（为什么查、查了什么、找到的每条：怎么找出来的、读没读全文）、
//   读全文（读的是前面检索到的那条就不另列，在那条上标"读了全文"）；每条的原话、时间、在哪由界面按素材 id 现取（memory-recall.ts）；
// - 单次工具调用：按调用的 id 打开（组里的一次，或者挂在某一条上的内部工具调用、发出了气泡的发语音调用）；完整参数和返回由界面现取
//   （53 号票），这里只投影。工具发的语音（87 号票）的详情里也带着发它的那次调用（会话里不单独显示它）；
// - 卡片、时间线记录（偏离、范围变更、越界、操作记录……）。
import {
  type AgentLetterKind,
  currentWording,
  type Disposition,
  DISPOSITION_LABEL,
  isTimelineRecordKind,
  type MessagePart,
  type MessageScope,
  QUICK_ACTION_BASIS_LABEL,
  TIMELINE_RECORD_KIND_INFO,
  TOOL_CALL_BLOCK_LABEL,
  type TimelineRecordSeverity,
  type ToolCallClearReason,
  type ToolCallDetail,
  type ToolCallEffectObject,
  type ToolCallOutcome,
  t,
  tTable,
  voiceDurationLabel,
} from "./protocol.ts";
import { agentVoiceBubble } from "./agent-voice.ts";
import { selectTask } from "./board.ts";
import { stageLabelIn } from "./stage-codes.ts";
import { taskStages } from "./task-detail.ts";
import { CALL_ISSUE_LABEL, type CallIssue, type ChatGroupStep, type ChatItem, type ChatToolCall, INTERNAL_TOOLS, locateChatItem } from "./chat-items.ts";
import { toolLabel } from "./call-sentence.ts";
import { type BriefItemLine, briefItemLines, type RecallHit, recallEntryOf, recallHowLabel } from "./memory-recall.ts";
import type { DetailRef } from "./detail-pane.ts";
import { MARK_KIND_LABEL, relayLabel } from "./timeline.ts";
import type { AgentLetter } from "./agent-letters.ts";
import type { ConversationRecord, UiState } from "./ui-state.ts";
import { voiceBubble } from "./voice.ts";

/** 文本详情的种类（标签的颜色按它取） */
export type TextDetailTag = "user" | "thinking" | "reply" | "voice" | "system";

export interface TextDetail {
  readonly kind: "text";
  /** 这一条现在的 id（"在对话中定位"用） */
  readonly itemId: string;
  readonly tag: TextDetailTag;
  /** 种类的中文名：用户输入、模型思考、模型回复、语音转写、语音回复、系统说明；秘书转达的话写"<名字占位>转达"（103 号票） */
  readonly label: string;
  /** 完整内容 */
  readonly text: string;
  /** 字数（按字符串长度数） */
  readonly chars: number;
  /** 模型回复本来就是 Markdown，按渲染后的样子看；agent 之间的来信（115 号票）也照 Markdown 画；其余按原文看 */
  readonly markdown: boolean;
  /**
   * agent 之间的来信（115 号票：任务做完、维护者来信、秘书转达、计划检查）：哪种。会话里只有一行，这里是全文——种类写在 label，
   * 标题行是那一句总结；运行时写的单个换行照样分行（agent-letters.ts 的 letterMarkdown）。别的没有
   */
  readonly letter: AgentLetterKind | undefined;
  /** 来信的一句话总结（会话里那一行写的）；不是来信的没有 */
  readonly summary: string | undefined;
  readonly time: string | undefined;
  readonly scope: MessageScope;
  /** 所属任务的标题；不属于任务、或者看板上还没有这个任务的没有 */
  readonly task: string | undefined;
  /** 文字以外的部分：图片、文件、引用的卡片 */
  readonly attachments: readonly MessagePart[];
  /** 语音：谁说的（用户的是语音转写，agent 的是语音回复）、时长；用户的还有识别状态 */
  readonly voice: { readonly speaker: "user" | "agent"; readonly duration: string; readonly status?: string } | undefined;
  /**
   * 工具发的语音（87 号票）：发这条语音的那次"发语音"调用，和单次工具调用的详情一样的内容（会话里不单独显示它）。
   * 语音回复、用户的语音、别的文本没有
   */
  readonly toolCall: CallDetail | undefined;
}

/** 一次调用的结局怎么说：已执行、执行中、没有执行（被拦下、你拒绝了、等你批准）、出错（170 号票起按当前语言现取，界面按 outcome 判断） */
export type CallStatus = string;

const CALL_STATUS_TEXT = tTable({
  done: "state.detailContent.status.done",
  running: "state.detailContent.status.running",
  error: "state.detailContent.status.error",
  notExecuted: "state.detailContent.status.notExecuted",
});

/** 授权：命中关注类别、属于计划里的授权项（within）；命中了但不在授权内（outside）；没命中关注类别，不需要授权（not_needed） */
export type CallGrant = "within" | "outside" | "not_needed";

export const CALL_GRANT_LABEL: Readonly<Record<CallGrant, string>> = tTable({
  within: "state.detailContent.grant.within",
  outside: "state.detailContent.grant.outside",
  not_needed: "state.detailContent.grant.notNeeded",
});

/** 详情里的一次调用（只用工具调用 part 里有的：参数和结果是摘要；完整的由界面按 callId 现取） */
export interface CallLine {
  /** 这次调用的 id：点进单次调用的详情用 */
  readonly id: string;
  /** 工具调用 part 的 callId：取完整参数和返回用（53 号票） */
  readonly callId: string;
  readonly tool: string;
  /** 工具的中文名（67 号票；MCP 工具和没登记的是原名） */
  readonly label: string;
  /** 说人话的那一句（67 号票，call-sentence.ts）：没有模板的是"中文名 · 参数值" */
  readonly sentence: string;
  /** 那一句是有模板说成的人话 */
  readonly said: boolean;
  /** 参数摘要 */
  readonly args: string;
  /** 结果摘要（被拦下的是给模型的说明的开头） */
  readonly result: string | undefined;
  /** 第几次：组里算进"调用了 N 个工具"的调用按先后从 1 数；顺利执行的内部工具、不在组里的调用没有 */
  readonly number: number | undefined;
  /** 内部工具（52 号票的 INTERNAL_TOOLS）：会话里由什么代表它；不是内部工具的没有 */
  readonly internal: string | undefined;
  /** 发出了语音气泡的"发语音"调用（87 号票）：会话里不单独显示，由那个气泡代表 */
  readonly sentVoice: boolean;
  /** 结局（工具调用 part 的 outcome）：界面按它判断；status 是它的说法 */
  readonly outcome: ToolCallOutcome;
  readonly status: CallStatus;
  /** 执行了没有：被拦下、你拒绝了、等你批准的没有执行 */
  readonly executed: boolean;
  /** 出的状况；顺利执行的没有 */
  readonly issue: CallIssue | undefined;
  readonly issueLabel: string | undefined;
  /** 被拦下的原因（硬拒绝、按规则退回、判定出错）；不是这几种的没有 */
  readonly why: string | undefined;
  /** 命中的关注类别 */
  readonly categories: readonly string[];
  /** 处置（判定出错时没有） */
  readonly disposition: Disposition | undefined;
  /** 守卫怎么判的：处置；被拦下的原因不是处置的写原因，再注明按处置会怎么判 */
  readonly verdict: string;
  /** 授权：界面按它判断；grantLabel 是它的说法 */
  readonly grant: CallGrant;
  readonly grantLabel: string;
  readonly genericBash: boolean;
  readonly time: string | undefined;
  readonly scope: MessageScope;
}

/**
 * 连续的同类调用合成一条：head 是第一条，下面挂"还有 more 次同样的操作"；
 * tail 是折起来的，head 是第一条调用的 id（点开第一条下面的按钮才逐条显示）。
 * grant 是这几次的授权：都在授权内（within）、都不需要授权（not_needed）、两样都有（mixed），按钮上的说法照它
 */
export type CallRun = { readonly kind: "head"; readonly more: number; readonly grant: Exclude<CallGrant, "outside"> | "mixed" } | { readonly kind: "tail"; readonly head: string };

/** 组里的一步 */
export type GroupStepLine = { readonly kind: "thinking"; readonly id: string; readonly text: string } | { readonly kind: "call"; readonly call: CallLine; readonly run?: CallRun };

export interface GroupDetail {
  readonly kind: "tool_group";
  readonly itemId: string;
  readonly time: string | undefined;
  readonly scope: MessageScope;
  /** 要点那一行：调用了 N 个工具、哪几种、出的状况 */
  readonly title: string;
  /** N：算进去的调用有几次 */
  readonly count: number;
  /** 出了状况的：每种几次、是第几次（按 CALL_ISSUES 的先后） */
  readonly issues: readonly { readonly issue: CallIssue; readonly label: string; readonly count: number; readonly numbers: readonly number[] }[];
  /** 按先后的每一步：思考、调用（含内部工具） */
  readonly steps: readonly GroupStepLine[];
}

/** 单次工具调用：组里的一次，或者挂在某一条上的内部工具调用 */
export interface CallDetail {
  readonly kind: "tool_call";
  /** 它所在的那一条（组，或者挂着它的卡片、回复……）现在的 id："在对话中定位"定位到那一条 */
  readonly itemId: string;
  readonly time: string | undefined;
  readonly scope: MessageScope;
  readonly call: CallLine;
  /** 在组里是第几次、共几次；不在组里、不编号的（顺利执行的内部工具）没有 */
  readonly position: { readonly number: number; readonly count: number } | undefined;
  /** 在做哪个阶段：第 n 阶段「标题」；不属于任务的阶段、还没收到计划的没有 */
  readonly stage: string | undefined;
}

/** 调用记忆里找到的一条（187 号票）：原话、时间、在哪由界面按素材 id 现取 */
export interface RecallHitLine {
  readonly materialId: string;
  /** 怎么找出来的："关键词命中"、"语义相近（0.71）"……；读全文的没有 */
  readonly how: string | undefined;
  /** 这一条里被读过全文（read_material） */
  readonly readFull: boolean;
}

/** 调用记忆里的一步：思考、一次检索、一次读全文（读的不是前面检索到的那条时才单独列） */
export type RecallStepLine =
  | { readonly kind: "thinking"; readonly id: string; readonly text: string }
  | {
      readonly kind: "search";
      /** 这次调用的 id（点进单次调用的详情） */
      readonly id: string;
      readonly callId: string;
      /** 为什么查；187 号票之前的记录没有，写"查：<query>" */
      readonly title: string;
      /** 查了什么（有为什么查时另写一行）；没有为什么查的已经写在 title 里，这里没有 */
      readonly query: string | undefined;
      /** 找到的每条，按结果的先后；旧记录不知道（undefined：界面现取完整返回、按行认） */
      readonly hits: readonly RecallHitLine[] | undefined;
    }
  | { readonly kind: "read"; readonly id: string; readonly callId: string; readonly hit: RecallHitLine }
  /** 266 号票：自动带上的记忆简报——每条为什么带它、说到的结论（界面按编号现取说法），简报引的原话背后的素材 */
  | { readonly kind: "brief"; readonly id: string; readonly title: string; readonly items: readonly BriefItemLine[]; readonly hits: readonly RecallHitLine[] };

export interface RecallDetail {
  readonly kind: "recall";
  readonly itemId: string;
  readonly time: string | undefined;
  readonly scope: MessageScope;
  /** 会话里那一行："回忆了 3 条记忆"、"查了记忆，没找到相关的" */
  readonly title: string;
  /** 用到了几条记忆（去重） */
  readonly count: number;
  readonly steps: readonly RecallStepLine[];
}

/** 卡片：界面照卡片 id 把整张卡画出来（审批、计划确认……各有各的画法），这里给头上的一行 */
export interface CardDetail {
  readonly kind: "card";
  readonly itemId: string;
  readonly time: string | undefined;
  readonly scope: MessageScope;
  readonly cardId: string;
  readonly cardType: string;
  /** 卡片纯文本的第一行（守护进程写的，换成现在的说法、名字占位留着） */
  readonly title: string;
  /** 待处理、已处理、已关掉、已过期 */
  readonly status: string;
  readonly pending: boolean;
}

/** 时间线记录：偏离、范围变更、越界……（不认识的种类照样显示），快速动作的操作记录 */
export interface RecordDetail {
  readonly kind: "record";
  readonly itemId: string;
  readonly time: string | undefined;
  readonly scope: MessageScope;
  /** 种类的中文名（偏离、范围变更、越界、操作记录……；不认识的写"记录"） */
  readonly label: string;
  /** 一句话（守护进程写的，换成现在的说法） */
  readonly summary: string;
  /** 详细说明 */
  readonly detail: string | undefined;
  /** 严重度（界面按它取样式）；操作记录没有 */
  readonly severity: TimelineRecordSeverity | undefined;
  /** 属于哪张工单 */
  readonly workOrderId: string | undefined;
  /** 操作记录：动作的名字、凭什么执行的、结果、对应的卡片 */
  readonly operation: { readonly name: string; readonly basis: string | undefined; readonly ok: boolean; readonly result: string; readonly cardId: string } | undefined;
}

/** 每种详情都有：挂在这一条上的内部工具调用（52 号票：条目里不显示，详情页查得到） */
interface WithInternalCalls {
  readonly internalCalls: readonly CallLine[];
}

/**
 * 一条的详情。找不到的是 missing：not_found 是不在已加载的范围里（或者 id 不对），deleted 是这条消息已经彻底删除了
 * （打开着的时候被删的，原来的位置只剩"已删除"）
 */
export type DetailContent =
  | { readonly kind: "missing"; readonly reason: "not_found" | "deleted" }
  /** 插件没启用（193 号票）：打开着的时候它的插件停了，这一条换成了占位 */
  | { readonly kind: "missing"; readonly reason: "unavailable"; readonly plugin: string }
  | ((TextDetail | GroupDetail | RecallDetail | CardDetail | RecordDetail) & WithInternalCalls)
  | CallDetail;

const TEXT_LABEL: Readonly<Record<Exclude<TextDetailTag, "voice">, string>> = tTable({
  user: "state.detailContent.text.user",
  thinking: "state.detailContent.text.thinking",
  reply: "state.detailContent.text.reply",
  system: "state.detailContent.text.system",
});

/** 打开的这一条显示什么 */
export function detailContent(state: UiState, items: readonly ChatItem[], ref: DetailRef): DetailContent {
  const found = locateChatItem(items, ref.id);
  if (!found) return { kind: "missing", reason: "not_found" };
  const { item, call } = found;
  const base = { itemId: item.id, time: item.time, scope: item.scope };
  if (call) {
    // 调用记忆（187 号票）里的一次也照组里的一次编号：第几次、共几次
    const counted = item.kind === "tool_group" || item.kind === "recall" ? item.calls : [];
    const index = counted.findIndex((c) => c.id === call.id);
    const position = index < 0 ? undefined : { number: index + 1, count: counted.length };
    return { kind: "tool_call", ...base, call: callLine(call, position?.number), position, stage: stageLabel(state, call.scope) };
  }
  const withCalls = { ...base, internalCalls: item.internalCalls.map((c) => callLine(c, undefined)) };
  const textOf = (tag: Exclude<TextDetailTag, "voice">, body: string, parts: readonly MessagePart[]) => textDetail(state, withCalls, tag, body, parts);
  switch (item.kind) {
    case "user": {
      const detail = textOf("user", item.text, item.message.parts);
      // 秘书转达的话（103 号票）：种类写"<名字>转达"，不是"用户输入"；115 号票起是来信，全文照 Markdown 画
      if (item.letter) return asLetter(detail, item.letter);
      return item.relayed ? { ...detail, label: relayLabel() } : detail;
    }
    case "thinking":
      return textOf("thinking", item.text, []);
    case "reply":
      return textOf("reply", item.text, item.parts);
    case "system": {
      const detail = textOf("system", item.text, item.parts);
      // 分支摘要（150 号票）：种类写"分支摘要"
      if (item.branch) return { ...detail, label: t("state.detailContent.branchSummary") };
      // 写给 agent 的来信（115 号票）：种类写"任务做完""维护者来信"……，不是"系统说明"
      return item.letter ? asLetter(detail, item.letter) : detail;
    }
    case "voice":
      return voiceDetail(state, withCalls, item);
    case "tool_group":
      return { ...groupDetail(base, item), internalCalls: withCalls.internalCalls };
    case "recall":
      return { ...recallDetail(base, item), internalCalls: withCalls.internalCalls };
    case "card":
      return cardDetail(state, withCalls, item.cardId);
    case "record":
      return { ...recordDetail(base, item.record), internalCalls: withCalls.internalCalls };
    case "deleted":
      return { kind: "missing", reason: "deleted" };
    case "unavailable":
      return { kind: "missing", reason: "unavailable", plugin: item.plugin };
    case "divider":
      // 工单分隔线没有详情（52 号票），按 id 打开时当作找不到
      return { kind: "missing", reason: "not_found" };
  }
}

const CARD_STATUS_TEXT = tTable({
  pending: "state.detailContent.card.pending",
  handled: "state.detailContent.card.handled",
  dismissed: "state.detailContent.card.dismissed",
  expired: "state.detailContent.card.expired",
});

/** 来信的详情（115 号票）：种类写来信的种类，带上那一句总结，全文照 Markdown 画 */
function asLetter(detail: TextDetail & WithInternalCalls, letter: AgentLetter): TextDetail & WithInternalCalls {
  return { ...detail, label: letter.label, letter: letter.kind, summary: letter.summary, markdown: true };
}

function cardDetail(state: UiState, base: Pick<CardDetail, "itemId" | "time" | "scope"> & WithInternalCalls, cardId: string): DetailContent {
  const head = cardHeadOf(state, cardId);
  if (!head) return { kind: "missing", reason: "not_found" };
  return { kind: "card", ...base, ...head };
}

/** 一张卡详情头上的一行：种类、卡片纯文本的第一行、待处理还是已处理（91 号票：按卡片 id 打开计划卡、计划变更卡的详情也用它）；没收到过这张卡没有 */
export function cardHeadOf(state: UiState, cardId: string): Pick<CardDetail, "cardId" | "cardType" | "title" | "status" | "pending"> | undefined {
  const card = state.cards[cardId]?.card;
  if (!card) return undefined;
  const title =
    currentWording(card.text)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? t("state.detailContent.card.fallbackTitle");
  return { cardId, cardType: card.type, title, status: CARD_STATUS_TEXT[card.status], pending: card.status === "pending" };
}

type GroupItem = Extract<ChatItem, { kind: "tool_group" }>;

/** 工具调用组：每一步按先后，算进 N 的调用编上号；出了状况的各是第几次 */
function groupDetail(base: Pick<GroupDetail, "itemId" | "time" | "scope">, item: GroupItem): GroupDetail {
  const numbers = new Map(item.calls.map((c, i) => [c.id, i + 1]));
  const runs = runsOf(item.steps);
  const steps = item.steps.map((s): GroupStepLine => {
    if (s.kind === "thinking") return { kind: "thinking", id: s.id, text: s.text };
    const run = runs.get(s.call.id);
    return { kind: "call", call: callLine(s.call, numbers.get(s.call.id)), ...(run ? { run } : {}) };
  });
  return {
    kind: "tool_group",
    ...base,
    title: item.keyLine,
    count: item.calls.length,
    issues: item.issues.map(({ issue, count }) => ({
      issue,
      label: CALL_ISSUE_LABEL[issue],
      count,
      numbers: item.calls.flatMap((c, i) => (c.issue === issue ? [i + 1] : [])),
    })),
    steps,
  };
}

type RecallItem = Extract<ChatItem, { kind: "recall" }>;

/**
 * 调用记忆：按先后列出思考、每次检索、读全文。读的是这一条里前面（或后面）检索到的那条的，在那条上标"读了全文"，不另列；
 * 读的不在这一条的检索结果里（上一轮查到的、用户直接给的编号）单独一条
 */
function recallDetail(base: Pick<RecallDetail, "itemId" | "time" | "scope">, item: RecallItem): RecallDetail {
  const entries = new Map(item.calls.map((c) => [c.id, recallEntryOf(c.part)]));
  const readIds = new Set(item.calls.flatMap((c) => (entries.get(c.id)!.source === "read" ? (entries.get(c.id)!.hits ?? []).map((h) => h.materialId) : [])));
  const searched = new Set(item.calls.flatMap((c) => (entries.get(c.id)!.source === "search" ? (entries.get(c.id)!.hits ?? []).map((h) => h.materialId) : [])));
  const line = (h: RecallHit): RecallHitLine => ({ materialId: h.materialId, how: recallHowLabel(h), readFull: readIds.has(h.materialId) });
  const steps = item.steps.flatMap((s): RecallStepLine[] => {
    if (s.kind === "thinking") return [{ kind: "thinking", id: s.id, text: s.text }];
    const { call } = s;
    const entry = entries.get(call.id)!;
    if (call.brief) return [{ kind: "brief", id: call.id, title: t("state.memoryRecall.brief"), items: briefItemLines(call.brief), hits: (entry.hits ?? []).map(line) }];
    if (entry.source === "read") return (entry.hits ?? []).filter((h) => !searched.has(h.materialId)).map((h) => ({ kind: "read", id: call.id, callId: call.part.callId, hit: line(h) }));
    const query = entry.query ?? "";
    // 263 号票：问记忆写"问记忆：<问题>"，找到的是简报里引用的证据背后的素材
    const title = entry.source === "ask" ? t("state.memoryRecall.ask", { question: query }) : (entry.why ?? t("state.memoryRecall.queryOnly", { query }));
    return [
      {
        kind: "search",
        id: call.id,
        callId: call.part.callId,
        title,
        query: entry.source === "ask" || entry.why === undefined ? undefined : entry.query,
        hits: entry.hits?.map(line),
      },
    ];
  });
  return { kind: "recall", ...base, title: item.keyLine, count: item.recall.count, steps };
}

/** 连续这么多次以上的同类调用才合成一条 */
const RUN_MIN = 3;

/**
 * 顺利执行、可以和同类合成一条的调用（执行成功、没被纠正、不用当场确认、没有高危标注）。
 * 二狗里：执行完了、没出任何状况（没被拦下、没问过你、没出错……），也没有要点上的标注——命中关注类别的只有在授权内才算，
 * 没命中的不需要授权，也算；做完告诉我的、通用 bash（要点层、全局层单独标出的）都不合
 */
function plainCall(call: ChatToolCall): boolean {
  const { part } = call;
  if (part.outcome !== "done" || call.issue !== undefined) return false;
  if (part.genericBash || part.disposition === "do_then_tell") return false;
  return grantOf(part) !== "outside";
}

/** 组里连续 3 次以上、都顺利执行的同一个工具（中间没有思考、没有别的调用）：第一条挂上还有几次，其余折起来 */
function runsOf(steps: readonly ChatGroupStep[]): Map<string, CallRun> {
  const runs = new Map<string, CallRun>();
  for (let i = 0; i < steps.length; ) {
    const a = steps[i]!;
    let j = i + 1;
    if (a.kind === "call" && plainCall(a.call)) {
      while (j < steps.length) {
        const b = steps[j]!;
        if (b.kind !== "call" || !plainCall(b.call) || b.call.part.tool !== a.call.part.tool) break;
        j++;
      }
    }
    if (a.kind === "call" && j - i >= RUN_MIN) {
      const members = steps.slice(i, j).flatMap((b) => (b.kind === "call" ? [b.call] : []));
      const grants = new Set(members.map((c) => grantOf(c.part)));
      runs.set(a.call.id, { kind: "head", more: j - i - 1, grant: grants.size > 1 ? "mixed" : grants.has("within") ? "within" : "not_needed" });
      for (const b of members.slice(1)) runs.set(b.id, { kind: "tail", head: a.call.id });
    }
    i = j;
  }
  return runs;
}

/** 一次调用怎么显示（number：在组里是第几次） */
function callLine(call: ChatToolCall, number: number | undefined): CallLine {
  const { part } = call;
  const executed = part.outcome === "done" || part.outcome === "error" || part.outcome === "running";
  const { sentence } = call;
  return {
    id: call.id,
    callId: part.callId,
    tool: part.tool,
    label: toolLabel(part.tool),
    sentence: sentence.text,
    said: sentence.said,
    args: part.argsSummary,
    result: part.resultSummary,
    number,
    internal: call.internal ? INTERNAL_TOOLS[part.tool]?.what : undefined,
    sentVoice: call.voiceId !== undefined,
    outcome: part.outcome,
    status: part.outcome === "done" ? CALL_STATUS_TEXT.done : part.outcome === "running" ? CALL_STATUS_TEXT.running : part.outcome === "error" ? CALL_STATUS_TEXT.error : CALL_STATUS_TEXT.notExecuted,
    executed,
    issue: call.issue,
    issueLabel: call.issue ? CALL_ISSUE_LABEL[call.issue] : undefined,
    why: part.blockedBy ? TOOL_CALL_BLOCK_LABEL[part.blockedBy] : undefined,
    categories: part.categoryTitles,
    disposition: part.disposition,
    verdict: verdictOf(part),
    grant: grantOf(part),
    grantLabel: CALL_GRANT_LABEL[grantOf(part)],
    genericBash: part.genericBash,
    time: call.time,
    scope: call.scope,
  };
}

function grantOf(part: ChatToolCall["part"]): CallGrant {
  return part.withinGrant ? "within" : part.categoryTitles.length ? "outside" : "not_needed";
}

/**
 * 守卫怎么判的：被拦下的原因不是处置时先写原因，再写按处置会怎么判；判定出错时没有处置（原来 parts.tsx 的 dispositionText）。
 * 任务的 agent 超出授权、先不管直接做的（101 号票），处置后面写明
 */
function verdictOf(part: ChatToolCall["part"]): string {
  const disposition = part.disposition ? DISPOSITION_LABEL[part.disposition] : "";
  if (part.blockedBy === "judge_error") return t("state.detailContent.verdict.judgeError", { why: TOOL_CALL_BLOCK_LABEL.judge_error });
  if (part.blockedBy) return disposition ? t("state.detailContent.verdict.blockedWithDisposition", { why: TOOL_CALL_BLOCK_LABEL[part.blockedBy], disposition }) : TOOL_CALL_BLOCK_LABEL[part.blockedBy];
  // 任务的 agent 超出授权、先不管直接做的调用，处置后面的说法（101 号票）
  return part.beyondGrant ? t("state.detailContent.verdict.beyondGrant", { disposition }) : disposition;
}

// ───────────────────────── 完整参数和返回（53 号票的接口取来的） ─────────────────────────

/** 一次调用的完整参数和返回，整理成详情要显示的样子 */
export interface CallFullContent {
  /** 工具的中文名（没登记的没有） */
  readonly toolTitle: string | undefined;
  /** 完整参数（模型给的原样）：界面按字段画（ValueView） */
  readonly args: unknown;
  /** 原始参数（给开发者看）：JSON 原样 */
  readonly rawArgs: string;
  /** 完整返回：工具交回模型的文字；被拦下的是模型收到的说明 */
  readonly result: string;
  /** 返回能解析成结构（JSON 对象或数组）就给结构，界面按结构画；本来就是正文的没有 */
  readonly resultValue: unknown;
  /** 截断了的值：返回（path 空）或参数里的某个字段（path 是字段的路径），原长多少字节 */
  readonly truncated: readonly { readonly where: "args" | "result"; readonly path: readonly string[]; readonly bytes: number }[];
  /** 读了密钥文件，返回没有记下来（result 是一句说明） */
  readonly withheld: boolean;
  /**
   * 删掉了（参数和返回里的文字都换成了删除标记）时的说法：彻底删除的"已彻底删除"，删除项目时一起删掉的"已随项目删除"
   * （66 号票）；没删的是 undefined
   */
  readonly purgedLabel: string | undefined;
  /**
   * 过了保留期、超出总量上限清掉了（65 号票）：参数和返回只剩摘要，界面按它退回聊天里的摘要（和没存完整内容一样），
   * clearedNote 是注明的那句。没清掉的是 undefined
   */
  readonly cleared: ToolCallClearReason | undefined;
  readonly clearedNote: string | undefined;
  /** 没有内联的二进制内容（读图片时的图片）：是什么、多大 */
  readonly media: readonly string[];
  /** 从开始判定到调用结束用了多久 */
  readonly durationMs: number | undefined;
  /** 发起调用的 agent */
  readonly agentId: string;
  /**
   * 这次调用的效果记录（守护进程的效果日志里的，执行成功的才有）：通用 bash 拆出来的每条操作各一条。
   * undefined：没有这个字段（没执行、彻底删除过）；空数组：效果日志里没找到
   */
  readonly effects: readonly EffectLine[] | undefined;
}

/** 一条效果记录：哪个工具、效果摘要、涉及的对象（"改动 D:\…\b.md"、"发给 …"），写了多少（"写入 N 字"，68 号票） */
export interface EffectLine {
  readonly seq: number;
  readonly title: string;
  readonly summary: string;
  readonly objects: readonly string[];
  readonly content?: string;
}

/** 路径怎么碰的 */
const PATH_ACCESS_TEXT: Readonly<Record<NonNullable<ToolCallEffectObject["access"]>, string>> = tTable({
  read: "state.detailContent.effect.read",
  write: "state.detailContent.effect.write",
  delete: "state.detailContent.effect.delete",
  unknown: "state.detailContent.effect.unknown",
});

function effectObjectText(o: ToolCallEffectObject): string {
  const how = o.kind === "recipient" ? t("state.detailContent.effect.recipient") : o.kind === "url" ? t("state.detailContent.effect.url") : PATH_ACCESS_TEXT[o.access ?? "unknown"];
  return t(o.uncertain ? "state.detailContent.effect.objectUncertain" : "state.detailContent.effect.object", { how, value: o.value });
}

/** 完整内容删掉了的说法：彻底删除的、删除项目时一起删掉的（66 号票，ToolCallDetail.purgedBy） */
export const TOOL_CALL_PURGED_LABEL: Readonly<Record<"purge" | "project_deletion", string>> = tTable({
  purge: "state.detailContent.purged.purge",
  project_deletion: "state.detailContent.purged.projectDeletion",
});

/** 完整内容为什么清掉了（65 号票）：详情页退回摘要时注明的那句 */
export const TOOL_CALL_CLEARED_NOTE: Readonly<Record<ToolCallClearReason, string>> = tTable({
  expired: "state.detailContent.cleared.expired",
  over_limit: "state.detailContent.cleared.overLimit",
});

export function callFullContent(detail: ToolCallDetail): CallFullContent {
  const started = detail.startedAt ? Date.parse(detail.startedAt) : Number.NaN;
  const ended = detail.endedAt ? Date.parse(detail.endedAt) : Number.NaN;
  return {
    toolTitle: detail.toolTitle,
    args: detail.args,
    rawArgs: JSON.stringify(detail.args, null, 2) ?? "",
    result: detail.result,
    resultValue: parseStructured(detail.result),
    truncated: (detail.truncated ?? []).map(({ pointer, bytes }) => {
      const [where, ...path] = pointer.split("/").slice(1).map(unescapePointer);
      return { where: where === "args" ? "args" : "result", path, bytes };
    }),
    withheld: detail.resultWithheld !== undefined,
    purgedLabel: detail.purged === true ? TOOL_CALL_PURGED_LABEL[detail.purgedBy ?? "purge"] : undefined,
    // 删掉了的按删除说（66 号票之前清掉过再删掉的，负载里还留着清掉的说明）
    cleared: detail.purged === true ? undefined : detail.cleared?.reason,
    clearedNote: detail.purged === true || !detail.cleared ? undefined : TOOL_CALL_CLEARED_NOTE[detail.cleared.reason],
    media: (detail.media ?? []).map((m) => {
      const what = m.type === "image" ? t("state.detailContent.media.image") : m.type;
      const facts = [m.mimeType, m.bytes === undefined ? undefined : sizeLabel(m.bytes)].filter((x) => x !== undefined);
      return facts.length ? t("state.detailContent.media.withFacts", { what, facts: facts.join(t("state.detailContent.media.factSep")) }) : what;
    }),
    durationMs: Number.isNaN(started) || Number.isNaN(ended) ? undefined : ended - started,
    agentId: detail.agentId,
    effects: detail.effects?.map((e) => ({
      seq: e.seq,
      title: e.toolTitle ?? e.tool,
      summary: e.summary,
      objects: e.objects.map(effectObjectText),
      ...(e.content === undefined ? {} : { content: e.content }),
    })),
  };
}

/** 返回值大多是 JSON 字符串，能解析成结构就按结构画，解析不了就是正文 */
function parseStructured(text: string): unknown {
  const s = text.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

/** JSON Pointer 的一段：~1 是 /，~0 是 ~ */
function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** 文件大小的写法（附件、上传、详情里的图片和截断说明、设置里工具调用的完整内容占了多大共用） */
export function sizeLabel(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

type TextBase = Pick<TextDetail, "itemId" | "time" | "scope"> & WithInternalCalls;

function textDetail(state: UiState, base: TextBase, tag: Exclude<TextDetailTag, "voice">, body: string, parts: readonly MessagePart[]): TextDetail & WithInternalCalls {
  return {
    kind: "text",
    ...base,
    tag,
    label: TEXT_LABEL[tag],
    text: body,
    chars: body.length,
    markdown: tag === "reply",
    letter: undefined,
    summary: undefined,
    task: taskTitle(state, base.scope),
    attachments: parts.filter((p) => p.type !== "text" && p.type !== "reasoning"),
    voice: undefined,
    toolCall: undefined,
  };
}

/**
 * 语音：用户的是识别出的文字（语音转写），agent 的是送进 TTS 的原文（语音回复）。
 * 工具发的（87 号票）下面再给发它的那次调用（"在对话中定位"定位到的还是这个气泡）
 */
function voiceDetail(state: UiState, base: TextBase, item: Extract<ChatItem, { kind: "voice" }>): TextDetail & WithInternalCalls {
  const { part, toolCall } = item;
  const user = part.type === "voice" ? voiceBubble(state, part) : undefined;
  const body = (part.type === "voice" ? user?.text : agentVoiceBubble(state, part).text) ?? "";
  return {
    kind: "text",
    ...base,
    tag: "voice",
    label: item.speaker === "user" ? t("state.detailContent.text.voiceUser") : t("state.detailContent.text.voiceAgent"),
    text: body,
    chars: body.length,
    markdown: false,
    letter: undefined,
    summary: undefined,
    task: taskTitle(state, base.scope),
    // 用户的语音可以连同引用的卡片和附件一起发（2026-10-10 起），详情里照样列出来；agent 的语音只是这一段
    attachments: user ? item.message.parts.filter((p) => p.type !== "voice" && p.type !== "text" && p.type !== "reasoning") : [],
    voice: user ? { speaker: "user", duration: user.duration, status: user.label } : { speaker: "agent", duration: voiceDurationLabel(part.durationMs) },
    toolCall: toolCall && { kind: "tool_call", itemId: item.id, time: toolCall.time, scope: toolCall.scope, call: callLine(toolCall, undefined), position: undefined, stage: stageLabel(state, toolCall.scope) },
  };
}

/** 在做哪个阶段：第 n 阶段「标题」（任务的阶段列表里有它时；91 号票起按依赖图的编号，并行的写 4a、4b） */
function stageLabel(state: UiState, scope: MessageScope): string | undefined {
  if (scope.taskId === undefined || scope.stageId === undefined) return undefined;
  const stage = taskStages(state, scope.taskId).find((s) => s.stageId === scope.stageId);
  return stage ? t("state.detailContent.stage", { stage: stageLabelIn(state, scope.taskId, stage.stageId), title: stage.title }) : undefined;
}

/** 所属任务的标题（看板上有这个任务时） */
function taskTitle(state: UiState, scope: MessageScope): string | undefined {
  return scope.taskId === undefined ? undefined : selectTask(state, scope.taskId)?.title;
}

/** 时间线记录、操作记录 */
function recordDetail(base: Pick<RecordDetail, "itemId" | "time" | "scope">, record: ConversationRecord): RecordDetail {
  if (record.type === "operation") {
    const op = record.operation;
    return {
      kind: "record",
      ...base,
      label: MARK_KIND_LABEL.operation,
      summary: currentWording(op.title),
      detail: undefined,
      severity: undefined,
      workOrderId: undefined,
      operation: { name: op.name, basis: op.basis ? QUICK_ACTION_BASIS_LABEL[op.basis] : op.explicit ? QUICK_ACTION_BASIS_LABEL.explicit : undefined, ok: op.result.ok, result: currentWording(op.result.summary), cardId: op.cardId },
    };
  }
  const { timeline } = record;
  const info = isTimelineRecordKind(timeline.kind) ? TIMELINE_RECORD_KIND_INFO[timeline.kind] : undefined;
  return {
    kind: "record",
    ...base,
    label: info?.label ?? t("state.detailContent.record"),
    summary: currentWording(timeline.summary),
    detail: timeline.detail === undefined ? undefined : currentWording(timeline.detail),
    severity: info?.severity ?? "info",
    workOrderId: timeline.workOrderId,
    operation: undefined,
  };
}
