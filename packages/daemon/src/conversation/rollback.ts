// 会话回退（150 号票，规格 .scratch/ergo-v2/session-rollback.md）。
// 秘书主会话先用；任务、项目维护者的会话在 152 号票接上（同一套，入口也一样）。
//
// - 回退点：会话缩小视图里条左侧的 ↶，一律"回到这一条之前"：用户消息（撤回到这条请求之前）、分支摘要（撤回到这条分支开始前）。
//   只在当前路径上、这段会话里（最近一次清空、换模型之后，用户定的第 5 条）；系统通知、网页上下的指令、排队一起交出的一批里第一条之后的不是。
// - 回退前的确认（preview）："做了的事" = 回退点之后、这个会话里成功执行、有副作用的工具调用（守卫的效果记录，只看的不算），
//   本机还是对外按效果日志的参数认（effectReach）；"收不回" = 对外的；本机但不可撤的（删除或覆盖、不可逆的提交：这次调用命中的关注类别）
//   写明原因、不算收不回。
// - 回退（rollback）：agent 的会话（AgentSession.navigateSession）先停稳手头这一轮、拦着排队的消息，子进程给被放弃的那段写摘要
//   （摘要要求接在 pi 的提示后面）、会话树切到回退点之前、叶子落盘；挪成了在同一事务里记：
//   - session_branch：这次之后的会话树（新分支从这条事件起；原来的当前分支记下离开时的末端）；
//   - 新分支开头一条分支摘要（系统消息，branch_summary part；本身也是回退点）；
//   - 被放弃的那段里 agent 发起、还没处理的卡作废，写明"用户撤回了会话"（照 84 号票的 expired；用户引用的卡、别处来的卡不动）；
//   - 被放弃的那段里还排着没交给 agent 的输入（运行时的通知）带到新分支上（追加一条一样的，原来那条出队）。
//   之后放开：排队的消息（144 号票）交给新分支。最后调撤销接口（onSessionRollback，默认什么都不做）。
// - 同一个幂等键重发拿到第一次的结果；一个会话同时只做一次。
// 151 号票：
// - 切换分支（switchBranch）：先停稳正在回复的（和回退同一个 navigateSession），子进程会话树切到那条分支离开时的末端，不写摘要，
//   叶子落盘；记一条 session_branch（change: switch），原来的当前分支对称地成为废弃分支（记下它离开时的末端）。不作废卡片、不撤销效果；
//   离开的那条上还排着没交给 agent 的输入照样带到切过去的那条上（同回退）。只能切到这段会话里（清空、换模型之后）分出去、
//   那条上也没清空换过模型的分支（它的末端在现在的会话文件里）；
// - 一条分支的样子（branchView）：它自己的那一段（branchOwnRanges）里的消息和记录、那一段已经做了的事（连同申请撤回了没有）、
//   最后一次被回退离开时写的分支摘要（之后那条上又多了消息的不算：说的是那时的样子：按叶子对，只被切换离开过的没有）；
// - 申请撤回（requestEffectUndo）：废弃分支上一件能申请撤回的遗留效果，记一笔 effect_undo_requested、调撤销接口的
//   onEffectUndoRequest（默认什么都不做）；同一件只记一次。
// 152 号票：任务、项目维护者的会话也能回退（同一套）——
// - 回退点多一种：长程任务一个阶段开始前（stageStart：维护者会话频道上那条 stage_start 记号，stage-starts.ts）。维护者从一条通知知道的，
//   回到那条通知之前；从"开始阶段"那次调用知道的，回到那条回复之前（beforeCall）；在别的调用里开始的（验收通过接着开始下一个……），
//   回到那次调用的结果之后（afterCall）；
// - 会话自己说现在能不能回退（refusal：项目维护者这一段已经结束了、任务取消了……）；
// - 跟着会话树走的业务状态（follow：长程任务的阶段、计划按保留的分支推导，tasks/execution.ts 的 followSession）：它的事件、作废的卡、
//   作废出队的输入（不带到新分支）和分支事件同一事务；它交给维护者接着做的那句记在分支摘要上（界面上不重复显示）。
//   切换分支（151 号票的 switchBranch）同样先问 refusal、同一事务调 follow（change: switch，按切过去的那条分支推导，不作废卡片；
//   离开那条上排着的这个任务的旧通知作废出队、不带过去）。
// 153 号票：流程的会话也有"撤回到步骤「…」开始前"——
// - 回退点：同一条 stage_start 记号带 stepId（维护者调 report_step(status="in_progress") 时记的），回到含这次调用的那条回复之前（beforeCall）；
//   任务状态取看板上这次汇报（step_reported）之前的；
// - 这段会话从哪开始多一种：定时、事件触发的任务一次运行的分段线（rollbackSegmentStart：一次运行就是一段会话，只在这一次运行里回退）；
// - 流程的步骤、计划核对按保留的分支推导在 follow（tasks/execution.ts 的 followSession）和守卫的计划核对（guard-runtime/plan-check.ts）里。
// 155 号票：撤回、切换期间记着这个会话在做哪一种（navigating）——定时、事件触发的任务运行中被中止的那一轮，触发底座据此把这次运行
// 记"已撤回"（不算失败）；流程撤回之后停住等你、一分钟没说话提醒一次在 tasks/rollback-wait.ts。
// 293 号票（Claude Code 的维护者）：同一套。运行时不自己写分支摘要的（能力清单 branch_summary 是 false），agent 的会话按被放弃的那段（这里交给它
// 现算的 abandoned）里二狗自己记下的事件另起一次写；运行时把它改过的文件恢复到撤回点的（能力清单 rewind_files），恢复了哪些记在分支摘要上（files）。
import { randomUUID } from "node:crypto";
import {
  agentSessionStart,
  rollbackSegmentStart,
  BRANCH_SUMMARY_INSTRUCTIONS,
  type BranchEffect,
  branchForks,
  branchOwnRanges,
  type BranchView,
  type EffectUndoRequestedEventPayload,
  type RequestEffectUndoResult,
  type SwitchBranchResult,
  switchedTree,
  type ConversationBranches,
  type ConversationId,
  EVENT_TYPES,
  findBranch,
  grownTree,
  inRanges,
  isDeletedEventPayload,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  nextBranchId,
  nowIso,
  pathRanges,
  rangesFrom,
  ROLLBACK_VOIDED_CARD,
  type RollbackEffect,
  type RollbackPreview,
  type RollbackSessionResult,
  type RollbackTarget,
  rollbackFork,
  type SeqRange,
  type SessionBranchEventPayload,
  type StageStartEventPayload,
  type TaskEventPayload,
  type TurnStartEventPayload,
  branchChain,
  CHANNELS,
  t,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import { builtinCategory, findTool, inModelLanguage, type ToolRegistry } from "../guard/index.ts";
import { effectsByCallId } from "../guard-runtime/effect-log.ts";
import { effectReach } from "../tasks/stage-view.ts";
import type { SessionFollowInput, SessionFollowResult } from "../tasks/session-follow.ts";
import { WORKFLOW_TOOL } from "../tasks/tool-names.ts";
import type { SessionNavigated, SessionNavigation } from "./agent-session.ts";
import { rangePage } from "./history.ts";
import { branchTreeOf, pathEventsBefore } from "./session-branches.ts";
import { inputOf, pendingInputs } from "./views.ts";

/**
 * 流程推进自己的工具（提交计划、汇报步骤）：只改二狗自己记的计划、步骤状态，
 * 不算这一段在真实世界里做了的事（153 号票）
 */
const PLANNING_TOOLS: ReadonlySet<string> = new Set([WORKFLOW_TOOL.proposePlan, WORKFLOW_TOOL.reportStep]);

/** 关注类别给人看的名字（工具调用记录上记的是名字，categoryTitles） */
const titleOf = (id: "external_send" | "delete_or_overwrite" | "irreversible_commit") => builtinCategory(id).title;
/**
 * 这次调用命中了这个内置类别没有（173 号票）：记了类别 id 的按 id 认；之前的记录只有名字（那时都是中文），按中文的名字认
 */
const hasCategory = (part: { categoryTitles: readonly string[]; categories?: readonly string[] | undefined }, id: "external_send" | "delete_or_overwrite" | "irreversible_commit") =>
  part.categories ? part.categories.includes(id) : part.categoryTitles.includes(inModelLanguage(() => titleOf(id)));

/** 一个能回退的会话的 agent（秘书；152 号票起任务、项目维护者）：在会话树上挪、判定副作用要的工具注册表 */
export interface RollbackSession {
  agentId: string;
  navigate(request: SessionNavigation, commit: (navigated: SessionNavigated) => void): Promise<SessionNavigated>;
  effectTools(): ToolRegistry;
  /** 现在不能回退的原因（152 号票：项目维护者这一段会话已经结束了、任务取消了、有子 agent 在做……）；能就是 undefined */
  refusal?(): string | undefined;
  /**
   * 跟着会话树走的业务状态（152 号票：长程任务的阶段、计划按保留的分支推导）：挪成了、记分支事件时一起算（同一事务）。
   * 这个会话没有跟着走的（秘书、普通任务、项目维护者的对话段……）返回 undefined
   */
  follow?(input: Omit<SessionFollowInput, "taskId">): SessionFollowResult | undefined;
}

/**
 * 撤销接口：会话回退之后调一次，交给它被放弃的那一段（会话频道上的序号段）和那一段已经做了的事。
 * 真正撤销本机效果、补救对外效果以后接（85 号票），守护进程默认的什么都不做
 */
export interface SessionRollbackHook {
  onSessionRollback(event: {
    conversation: ConversationId;
    /** 离开的分支、长出的新分支 */
    from: string;
    to: string;
    before: RollbackTarget;
    /** 被放弃的那一段（会话频道上的序号段） */
    abandoned: SeqRange[];
    effects: RollbackEffect[];
  }): Promise<void>;
  /**
   * 用户在废弃分支的详情里对一件遗留效果点了「申请撤回」（151 号票）：交给它这一件。真正的撤销以后接（85 号票），默认什么都不做
   */
  onEffectUndoRequest?(event: { conversation: ConversationId; branchId: string; effect: RollbackEffect }): Promise<void>;
}

export const NOOP_ROLLBACK_HOOK: SessionRollbackHook = { onSessionRollback: async () => {}, onEffectUndoRequest: async () => {} };

export interface SessionRollbackOptions {
  store: EventStore;
  cards: CardService;
  hook?: SessionRollbackHook;
  log: (line: string) => void;
}

export interface SessionRollbacks {
  /** 回退前的确认要的：回到这一条之前会放弃掉的那一段已经做了的事（回不到那里时抛出原因） */
  preview(conversation: ConversationId, before: RollbackTarget, session: RollbackSession): RollbackPreview;
  /** 回退：停稳 agent、写分支摘要、会话树长出新分支、记进事件日志；做完才兑现，没做成抛出原因（会话没动） */
  rollback(conversation: ConversationId, before: RollbackTarget, session: RollbackSession, idempotencyKey: string): Promise<RollbackSessionResult>;
  /** 切换到一条废弃分支（151 号票）：停稳 agent、会话树切到它的末端、记进事件日志；做完才兑现，没做成抛出原因（会话没动） */
  switchBranch(conversation: ConversationId, branchId: string, session: RollbackSession, idempotencyKey: string): Promise<SwitchBranchResult>;
  /** 一条分支的样子（151 号票）：它路径上不在 against（不给是当前分支）路径上的那一段 */
  branchView(conversation: ConversationId, branchId: string, against: string | undefined, session: RollbackSession): BranchView;
  /** 申请撤回废弃分支上的一件遗留效果（151 号票）：记一笔、调撤销接口；同一件再申请拿到第一次的时间 */
  requestEffectUndo(conversation: ConversationId, branchId: string, callId: string, session: RollbackSession): Promise<RequestEffectUndoResult>;
  /**
   * 这个会话此刻是不是正在撤回、切换分支（155 号票）：停稳期间被中止的那一轮是用户撤回、切换引起的——定时、事件触发的任务这次运行
   * 记"已撤回"、不算失败（触发底座在这一轮结束时问）。不是的是 undefined
   */
  navigating(conversation: ConversationId): "rollback" | "switch" | undefined;
}

/** 回退计划：截在哪个序号（被放弃的是当前路径上从它起的那一段）、子进程挪到哪、新分支从哪长出来 */
interface RollbackPlan {
  cut: number;
  target: SessionNavigation["target"];
  fork: { parent: string; cutoff: number };
  /** 撤回到长程任务一个阶段开始前（152 号票）：那个阶段、阶段开始那一刻（看板上那条 stage_started 的全局序号：任务状态取它之前的） */
  stage?: { stageId: string; title: string; startedAt: number };
  /** 撤回到流程一个步骤开始前（153 号票）：那一步、开始那一刻（看板上那条 step_reported 的全局序号：任务状态取它之前的） */
  step?: { stepId: string; title: string; startedAt: number };
}

/** 一条通知和它开始处理之间，这一条说明维护者手上在忙别的：agent 说的话、工具调用记录，别的输入的回合（152 号票） */
function busyBetween(event: StoredEvent): boolean {
  if (event.type === EVENT_TYPES.turnStart || event.type === EVENT_TYPES.turnEnd) return true;
  if (event.type !== EVENT_TYPES.message || isDeletedEventPayload(event.payload)) return false;
  return (event.payload as MessageEventPayload).message.speaker === "agent";
}

/** agent 光是说了几句：这条回复后面没跟着工具调用，也不是工具调用的记录、代为执行的工具出的卡片 */
function wordsOnly(event: StoredEvent): boolean {
  const { message } = event.payload as MessageEventPayload;
  return (message.calls ?? []).length === 0 && !message.parts.some((p) => p.type === "tool_call" || p.type === "card_ref");
}

/** 只能回退到这一段会话里（之前的已经压缩或换段了） */
const onlyThisSegment = () => t("conversation.rollback.onlyThisSegment");

export function createSessionRollbacks(options: SessionRollbackOptions): SessionRollbacks {
  const { store, cards, log } = options;
  const hook = options.hook ?? NOOP_ROLLBACK_HOOK;
  /** 正在回退、切换的会话（155 号票起记着是哪一种：触发底座问"这一轮是不是撤回中止的"） */
  const busy = new Map<string, "rollback" | "switch">();

  /** 一条消息在会话频道上的事件（不在这个会话里、被彻底删除了的没有） */
  const messageEvent = (conversation: ConversationId, messageId: string): StoredEvent | undefined => {
    const row = store.reader.get<{ global_seq: number; conversation: string }>("SELECT global_seq, conversation FROM conversation_messages WHERE message_id = ?", messageId);
    if (!row || row.conversation !== conversation) return undefined;
    const event = store.readGlobal(Number(row.global_seq) - 1, 1)[0];
    return event && !isDeletedEventPayload(event.payload) ? event : undefined;
  };

  /** 回退点不在这段会话里时的说法（152 号票起项目维护者的是当前这一段；153 号票起定时、事件触发的是这一次运行） */
  /** 当前路径上这段会话从哪开始（最近一条"agent 新开一段会话"的消息、一次运行的分段线的序号；没有是 0） */
  const segmentStart = (conversation: ConversationId): number => {
    let before = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const page = pathEventsBefore(store, conversation, before, 200, EVENT_TYPES.message);
      for (let i = page.length - 1; i >= 0; i--) {
        const event = page[i]!;
        if (isDeletedEventPayload(event.payload)) continue;
        if (rollbackSegmentStart((event.payload as MessageEventPayload).message)) return event.seq;
      }
      if (page.length < 200) return 0;
      before = page[0]!.seq;
    }
  };

  /** 校验回退点、算出回退计划（回不到那里时抛出原因） */
  const plan = (conversation: ConversationId, before: RollbackTarget, tree: ConversationBranches, session: RollbackSession): RollbackPlan => {
    const refusal = session.refusal?.();
    if (refusal !== undefined) throw new RequestRejected("not_allowed", refusal);
    const ranges = pathRanges(tree);
    const start = segmentStart(conversation);
    if ("stageStart" in before) return stagePlan(conversation, before.stageStart, tree, ranges, start, session.agentId);
    if ("messageId" in before) {
      const event = messageEvent(conversation, before.messageId);
      if (!event) throw new RequestRejected("not_found", t("conversation.rollback.noMessage"));
      const payload = event.payload as MessageEventPayload;
      const { message } = payload;
      if (message.speaker !== "user" || message.pageCommand !== undefined) throw new RequestRejected("not_allowed", t("conversation.rollback.onlyYours"));
      // 293 号票：接管时导进来的前情（290 号票）不是交给 agent 的输入，运行时那边没有它的记录
      if (message.prelude === true) throw new RequestRejected("not_allowed", t("conversation.rollback.prelude"));
      if (!inRanges(ranges, event.seq)) throw new RequestRejected("not_allowed", t("conversation.rollback.messageOffPath"));
      if (event.seq <= start) throw new RequestRejected("not_allowed", onlyThisSegment());
      if (payload.queueDelivery !== undefined && firstOfBatch(conversation, payload.queueDelivery, ranges) !== message.id) {
        throw new RequestRejected("not_allowed", t("conversation.rollback.batch"));
      }
      if (inputOf(store.reader, message.id)?.status === "pending") throw new RequestRejected("not_allowed", t("conversation.rollback.pending"));
      return { cut: event.seq, target: { beforeInput: message.id }, fork: rollbackFork(tree, { seq: event.seq })! };
    }
    const branch = findBranch(tree, before.branchId);
    const fork = rollbackFork(tree, before);
    if (!branch || !fork || branch.entry === undefined || branch.summary === undefined) throw new RequestRejected("not_found", t("conversation.rollback.noBranch"));
    if (!branchChain(tree).some((l) => l.branch === branch.id)) throw new RequestRejected("not_allowed", t("conversation.rollback.branchOffPath"));
    const summary = messageEvent(conversation, branch.summary.messageId);
    if (!summary || summary.seq <= start) throw new RequestRejected("not_allowed", onlyThisSegment());
    return { cut: fork.cutoff, target: { entry: branch.entry }, fork };
  };

  /**
   * 撤回到长程任务一个阶段开始前（152 号票）：按那条 stage_start 记号写的维护者是怎么知道的——
   * - 一条通知：回到这条通知之前（它要已经交给维护者了，而且交过去的时候维护者手上没在忙别的：会话频道上这条通知和它开始处理之间
   *   没有别的输入的回合、agent 的话，不然两边对不上）；交来时维护者正说着手头这一轮收尾的话的，见 closingTarget；
   * - "开始阶段"那次调用（维护者自己换去做这个阶段，撤回点在认领之前）：回到这条回复之前——会话频道上截在这条回复说的话
   *   （calls 里有这次调用的那条），没说话的截在这次调用的记录；
   * - 别的调用（阶段在这次调用里开始，比如宣布完成验收通过之后接着开始下一个）：回到这次调用的结果之后——截在这次调用的记录后面那一条。
   * 任务状态取看板上这个阶段这次开始（stage_started）之前的（和记号同一批追加，在它前面）
   */
  const stagePlan = (conversation: ConversationId, markId: string, tree: ConversationBranches, ranges: readonly SeqRange[], start: number, agentId: string): RollbackPlan => {
    const markEvent = store.read(conversation, 0, EVENT_TYPES.stageStart).find((e) => (e.payload as StageStartEventPayload).id === markId);
    if (!markEvent) throw new RequestRejected("not_found", t("conversation.rollback.noStageMark"));
    const mark = markEvent.payload as StageStartEventPayload;
    if (!inRanges(ranges, markEvent.seq)) throw new RequestRejected("not_allowed", t(mark.stepId === undefined ? "conversation.rollback.stageOffPath" : "conversation.rollback.stepOffPath"));
    if (markEvent.seq <= start) throw new RequestRejected("not_allowed", onlyThisSegment());
    // 开始那一刻：长程任务是看板上这个阶段这次开始（stage_started），流程的步骤是这次汇报开始（step_reported，153 号票）；都和记号同一批、在它前面
    const startedEvent = store
      .read(CHANNELS.board, 0, EVENT_TYPES.task)
      .findLast((e) => {
        const p = e.payload as TaskEventPayload;
        if (e.globalSeq >= markEvent.globalSeq || p.task.id !== mark.taskId) return false;
        return mark.stepId === undefined ? p.change === "stage_started" && p.stageId === mark.stageId : p.change === "step_reported";
      });
    const startedAt = startedEvent?.globalSeq ?? markEvent.globalSeq;
    const started = mark.stepId === undefined ? { stage: { stageId: mark.stageId, title: mark.title, startedAt } } : { step: { stepId: mark.stepId, title: mark.title, startedAt } };
    const at = (cut: number): RollbackPlan => {
      if (cut <= start) throw new RequestRejected("not_allowed", onlyThisSegment());
      return { cut, target: { beforeInput: "" }, fork: rollbackFork(tree, { seq: cut })!, ...started };
    };
    const { via } = mark;
    if ("notice" in via) {
      const notice = messageEvent(conversation, via.notice);
      if (!notice || !inRanges(ranges, notice.seq)) throw new RequestRejected("not_allowed", t("conversation.rollback.briefOffPath"));
      if (inputOf(store.reader, via.notice)?.status === "pending") throw new RequestRejected("not_allowed", t("conversation.rollback.briefPending"));
      const turn = store.read(conversation, notice.seq, EVENT_TYPES.turnStart).find((e) => (e.payload as TurnStartEventPayload).inputMessageId === via.notice);
      // 这条通知和它开始处理之间（会话频道上序号连着，取这一段）
      const between = turn === undefined ? [] : store.readBefore(conversation, turn.seq, turn.seq - notice.seq - 1).filter((e) => inRanges(ranges, e.seq));
      const target = between.some(busyBetween) ? closingTarget(conversation, notice, between, agentId) : { beforeInput: via.notice };
      if (!target) throw new RequestRejected("not_allowed", t("conversation.rollback.stageBusy", { title: mark.title }));
      return { ...at(notice.seq), target };
    }
    const record = store
      .read(conversation, markEvent.seq, EVENT_TYPES.message)
      .find((e) => inRanges(ranges, e.seq) && !isDeletedEventPayload(e.payload) && (e.payload as MessageEventPayload).message.parts.some((p) => p.type === "tool_call" && p.callId === via.call));
    if (via.after) {
      // 这次调用的结果之后：截在它的记录后面那一条（还没有后面的就是会话的末尾——停稳期间追加的都落在被放弃的那段里）
      const after = record?.seq ?? markEvent.seq;
      // 那次调用之后的那一段已经撤回过了（后面那一条不在当前分支上）：这个阶段的这次开始不算了（新分支上重新开始的有自己的回退点）
      if (after + 1 <= store.lastSeq(conversation) && !inRanges(ranges, after + 1)) {
        throw new RequestRejected("not_allowed", t("conversation.rollback.stageRolledBack", { title: mark.title }));
      }
      return { ...at(after + 1), target: { afterCall: via.call } };
    }
    // "开始阶段"那条回复之前：它说的话（calls 里有这次调用）在记号前面
    const reply = store
      .readBefore(conversation, markEvent.seq, 50, EVENT_TYPES.message)
      .findLast((e) => inRanges(ranges, e.seq) && !isDeletedEventPayload(e.payload) && (e.payload as MessageEventPayload).message.calls?.includes(via.call) === true);
    return { ...at(reply?.seq ?? record?.seq ?? markEvent.seq), target: { beforeCall: via.call } };
  };

  /**
   * 交代阶段的那条通知交来时，维护者正说着手头这一轮收尾的话（2026-10-26 查测试偶发失败时发现：维护者调用"提交计划"时计划卡就出来了，
   * 它后面还要说一句"计划交上去了"；你在它说完之前点了确认，"开始执行"那条通知就排在这句话前面）：通知和它开始处理之间只有那一轮剩下的
   * 话（不再调用工具）和那一轮的 turn_end，没有别的输入的回合。这时两边对得上：会话频道上照旧截在这条通知（那几句收尾的话一起放弃），
   * 子进程里截在通知交来之前这一轮最后一次工具调用的结果之后（afterCall，那几句在它后面）；通知交来之前那一轮的话已经说完、只差 turn_end 的，
   * 子进程里就是"这条通知之前"。别的（中间有别的输入的回合、通知交来之后又调用了工具、通知交来之前最后记下的是它说的话或者别的 agent 的
   * 调用）对不上，是 undefined（照旧回绝）
   */
  const closingTarget = (conversation: ConversationId, notice: StoredEvent, between: readonly StoredEvent[], agentId: string): SessionNavigation["target"] | undefined => {
    const ends = between.filter((e) => e.type === EVENT_TYPES.turnEnd);
    if (ends.length !== 1 || between.some((e) => e.type === EVENT_TYPES.turnStart)) return undefined;
    const said = between.filter((e) => e.type === EVENT_TYPES.message && busyBetween(e));
    if (said.some((e) => e.seq > ends[0]!.seq || !wordsOnly(e))) return undefined;
    if (said.length === 0) return { beforeInput: (notice.payload as MessageEventPayload).message.id };
    // 通知交来之前这一轮最后记下的（往前到这一轮的 turn_start 为止）：要是这个 agent 的一次工具调用的记录
    const earlier = pathEventsBefore(store, conversation, notice.seq, 200);
    for (let i = earlier.length - 1; i >= 0; i--) {
      const event = earlier[i]!;
      if (!busyBetween(event)) continue;
      if (event.type !== EVENT_TYPES.message) return undefined;
      const payload = event.payload as MessageEventPayload;
      const call = payload.message.parts.findLast((p): p is Extract<MessagePart, { type: "tool_call" }> => p.type === "tool_call");
      // Claude Code 子代理里的调用（parentCallId）不是这一轮主线上的：派它的那次调用还没有结果
      return call && call.parentCallId === undefined && (payload.agentId ?? agentId) === agentId ? { afterCall: call.callId } : undefined;
    }
    return undefined;
  };

  /** 排队交出的同一批里的第一条（当前路径上的） */
  const firstOfBatch = (conversation: ConversationId, delivery: string, ranges: readonly SeqRange[]): string | undefined => {
    for (const range of ranges) {
      for (const event of store.read(conversation, range.from - 1, EVENT_TYPES.message)) {
        if (event.seq >= range.to) break;
        const payload = event.payload as Partial<MessageEventPayload>;
        if (payload.queueDelivery === delivery && payload.message) return payload.message.id;
      }
    }
    return undefined;
  };

  /** 被放弃的那一段（当前路径上序号段）里的消息事件 */
  const messagesIn = (conversation: ConversationId, abandoned: readonly SeqRange[]): StoredEvent[] =>
    abandoned.flatMap((range) => store.read(conversation, range.from - 1, EVENT_TYPES.message).filter((e) => e.seq < range.to && !isDeletedEventPayload(e.payload)));

  /** 这一段已经在真实世界里做了的事：每次有效果记录、不是只看的工具调用一件 */
  const effectsIn = (conversation: ConversationId, abandoned: readonly SeqRange[], session: RollbackSession): RollbackEffect[] => {
    const tools = session.effectTools();
    const out: RollbackEffect[] = [];
    for (const event of messagesIn(conversation, abandoned)) {
      const payload = event.payload as MessageEventPayload;
      for (const part of payload.message.parts) {
        if (part.type !== "tool_call" || PLANNING_TOOLS.has(part.tool)) continue;
        const records = effectsByCallId(store.reader, part.callId, payload.agentId ?? session.agentId);
        if (records.length === 0) continue;
        const reaches = records.map((r) => effectReach(r, tools) ?? "local");
        const external = reaches.includes("external") || hasCategory(part, "external_send");
        if (!external && reaches.every((r) => r === "look")) continue;
        const why = external
          ? t("conversation.rollback.whyExternal")
          : hasCategory(part, "delete_or_overwrite")
            ? t("conversation.rollback.whyDeleted")
            : hasCategory(part, "irreversible_commit")
              ? t("conversation.rollback.whyCommitted")
              : undefined;
        const title = findTool(tools, part.tool)?.title;
        out.push({
          callId: part.callId,
          tool: part.tool,
          ...(title === undefined ? {} : { toolTitle: title }),
          argsSummary: part.argsSummary,
          summary: records.map((r) => r.summary).join(t("conversation.rollback.summarySep")),
          scope: external ? "external" : "local",
          undoable: why === undefined,
          ...(why === undefined ? {} : { why }),
          at: nowIso(new Date(Math.max(...records.map((r) => r.at)))),
        });
      }
    }
    return out;
  };

  /** 被放弃的那段里 agent 发起、还没处理的卡（用户引用的卡在用户消息里，不算） */
  const pendingCardsIn = (conversation: ConversationId, abandoned: readonly SeqRange[]): string[] => {
    const ids = new Set<string>();
    for (const event of messagesIn(conversation, abandoned)) {
      const { message } = event.payload as MessageEventPayload;
      if (message.speaker !== "agent") continue;
      for (const part of message.parts) if (part.type === "card_ref" && cards.get(part.cardId)?.status === "pending") ids.add(part.cardId);
    }
    return [...ids];
  };

  /** 挪成了：这次要记的事件（同一事务）和结果 */
  const commitEvents = (
    conversation: ConversationId,
    before: RollbackTarget,
    rollback: RollbackPlan,
    branchId: string,
    navigated: SessionNavigated,
    session: RollbackSession,
    effects: readonly RollbackEffect[],
  ): { events: NewEvent[]; result: RollbackSessionResult; abandoned: SeqRange[]; from: string; afterCommit(): void } => {
    // 停稳期间追加的（说到一半的回复、turn_end）都落在被放弃的那段里：按现在的样子重新算
    const tree = branchTreeOf(store.reader, conversation);
    const abandoned = rangesFrom(pathRanges(tree), rollback.cut);
    // 跟着会话树走的业务状态（152 号票：长程任务按保留的分支推导）：只看被放弃的那段之前（全局序号）；撤回到阶段开始前的取那次开始之前
    const first = abandoned[0] === undefined ? undefined : store.eventAt(conversation, abandoned[0].from);
    const boundary = Math.min(first?.globalSeq ?? Number.POSITIVE_INFINITY, rollback.stage?.startedAt ?? rollback.step?.startedAt ?? Number.POSITIVE_INFINITY);
    const followed = session.follow?.({
      conversation,
      change: "rollback",
      tree,
      ...(Number.isFinite(boundary) ? { boundary } : {}),
      ...(rollback.stage ? { stage: { stageId: rollback.stage.stageId, title: rollback.stage.title } } : {}),
      abandoned,
      external: effects.filter((e) => e.scope === "external"),
    });
    // 这条 session_branch 的序号：它是这一批里会话频道上的第一条（同步追加，中间没有别的）
    const at = store.lastSeq(conversation) + 1;
    const time = nowIso();
    const summaryId = `m-${randomUUID()}`;
    const text = navigated.summary?.trim() || t("conversation.rollback.noSummary");
    const summary: MessageEnvelope = {
      id: summaryId,
      conversation,
      speaker: "system",
      time,
      parts: [
        {
          type: "branch_summary",
          branchId,
          summary: text,
          ...(followed?.notice === undefined ? {} : { notice: followed.notice }),
          // 293 号票：运行时把它改过的文件恢复到撤回点没有（Claude Code 的文件检查点）
          ...(navigated.files === undefined ? {} : { files: navigated.files }),
        },
      ],
    };
    const next = grownTree(
      tree,
      { id: branchId, ...rollback.fork, summary: { messageId: summaryId, text }, entry: navigated.at, ...(navigated.session === undefined ? {} : { session: navigated.session }), time },
      at,
      navigated.from,
    );
    // 被放弃的那段里还排着、没交给 agent 的输入（运行时的通知）：带到新分支上，原来那条出队
    const carried: { from: string; to: string }[] = [];
    const carriedEvents: NewEvent[] = [];
    for (const input of pendingInputs(store.reader, conversation)) {
      // 跟着走的业务状态作废出队的（152 号票：长程任务被放弃的那段里排着的运行时通知）不带过去
      if (followed?.voidedInputs.has(input.messageId)) continue;
      const event = store.readGlobal(input.globalSeq - 1, 1)[0];
      if (!event || !inRanges(abandoned, event.seq) || isDeletedEventPayload(event.payload)) continue;
      const payload = event.payload as MessageEventPayload;
      const copy: MessageEnvelope = { ...payload.message, id: `m-${randomUUID()}`, time };
      carried.push({ from: payload.message.id, to: copy.id });
      carriedEvents.push({ channel: conversation, type: EVENT_TYPES.message, payload: { ...payload, message: copy }, idempotencyKey: `carry:${conversation}:${branchId}:${payload.message.id}` });
    }
    const ownExpired = pendingCardsIn(conversation, abandoned).filter((id) => !followed?.expiredCards.includes(id));
    const expired = [...ownExpired, ...(followed?.expiredCards ?? [])];
    const branchEvent: SessionBranchEventPayload = {
      change: "rollback",
      branches: next,
      from: tree.current,
      to: branchId,
      before,
      ...(expired.length > 0 ? { expiredCards: expired } : {}),
      ...(carried.length > 0 ? { carried } : {}),
      by: "user",
      time,
    };
    // 任务会话里（152 号票）：摘要归到这个任务、跟着走完之后在做的阶段（放进重新开始的那个阶段框）
    const summaryPayload: MessageEventPayload = { message: summary, ...followed?.scope };
    return {
      events: [
        { channel: conversation, type: EVENT_TYPES.sessionBranch, payload: branchEvent },
        { channel: conversation, type: EVENT_TYPES.message, payload: summaryPayload },
        ...carriedEvents,
        ...ownExpired.map((cardId) => cards.buildUpdate(cardId, { status: "expired", expiredNote: ROLLBACK_VOIDED_CARD }).event),
        ...(followed?.events ?? []),
      ],
      result: { branchId, summaryMessageId: summaryId },
      abandoned,
      from: tree.current,
      afterCommit: () => followed?.afterCommit(),
    };
  };

  /** 申请撤回过的遗留效果：工具调用 id → 什么时候提交的（第一次） */
  const undoRequests = (conversation: ConversationId): Map<string, string> => {
    const out = new Map<string, string>();
    for (const event of store.readBefore(conversation, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, EVENT_TYPES.effectUndoRequested)) {
      const { callId, time } = event.payload as EffectUndoRequestedEventPayload;
      if (!out.has(callId)) out.set(callId, time);
    }
    return out;
  };

  /**
   * 这条分支最后一次被回退离开时写的分支摘要（那次 session_branch 长出的分支开头那条）；之后这条分支上又多了消息的不算——那份说的是
   * 那时的样子（按叶子对：分支摘要条目的 fromId 是离开时的叶子，叶子变了就对不上）。只被切换离开过的没有
   */
  const abandonSummary = (conversation: ConversationId, tree: ConversationBranches, branchId: string): string | undefined => {
    const last = store
      .readBefore(conversation, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, EVENT_TYPES.sessionBranch)
      .findLast((e) => !isDeletedEventPayload(e.payload) && (e.payload as SessionBranchEventPayload).change === "rollback" && (e.payload as SessionBranchEventPayload).from === branchId);
    if (!last) return undefined;
    const payload = last.payload as SessionBranchEventPayload;
    const text = findBranch(payload.branches, payload.to)?.summary?.text;
    if (text === undefined) return undefined;
    // 之后这条分支又是当前分支的那几段里有没有消息
    const later = tree.epochs.flatMap((epoch, i) => (epoch.branch === branchId && epoch.from > last.seq ? [{ from: epoch.from, to: tree.epochs[i + 1]?.from ?? Number.POSITIVE_INFINITY }] : []));
    return messagesIn(conversation, later).length > 0 ? undefined : text;
  };

  /** 切换前的校验：有这条、不是当前的、记下了末端、在这段会话里分出去、那条上没清空换过模型（切不过去时抛出原因）；返回它的末端 */
  const switchTarget = (conversation: ConversationId, branchId: string, tree: ConversationBranches): string => {
    const target = findBranch(tree, branchId);
    if (!target) throw new RequestRejected("not_found", t("conversation.rollback.noBranch"));
    if (target.id === tree.current) throw new RequestRejected("not_allowed", t("conversation.rollback.alreadyOnBranch"));
    if (target.tip === undefined) throw new RequestRejected("not_allowed", t("conversation.rollback.noTip"));
    const fork = branchForks(tree).find((f) => f.branches.includes(branchId));
    if (!fork || fork.at <= segmentStart(conversation)) throw new RequestRejected("not_allowed", t("conversation.rollback.switchThisSegment"));
    // 那条分支上清空、换过模型：agent 换了一个会话，那条的末端不在现在的会话文件里
    if (messagesIn(conversation, branchOwnRanges(tree, branchId)).some((e) => agentSessionStart((e.payload as MessageEventPayload).message))) {
      throw new RequestRejected("not_allowed", t("conversation.rollback.switchCleared"));
    }
    return target.tip;
  };

  /**
   * 离开的那一段里还排着、没交给 agent 的输入（运行时的通知）：带到切过去的那条上（照抄一条，原来那条出队，同回退的 carried）。
   * at 是这次 session_branch 的序号（同一条通知可能被带过几次，幂等键按它分开）
   */
  const carryInputs = (
    conversation: ConversationId,
    left: readonly SeqRange[],
    at: number,
    time: string,
    skip: ReadonlySet<string> = new Set(),
  ): { carried: { from: string; to: string }[]; events: NewEvent[] } => {
    const carried: { from: string; to: string }[] = [];
    const events: NewEvent[] = [];
    for (const input of pendingInputs(store.reader, conversation)) {
      // 跟着走的业务状态作废出队的（152 号票：任务回到切过去那条分支上的进度，离开那条上排着的这个任务的旧通知）不带过去
      if (skip.has(input.messageId)) continue;
      const event = store.readGlobal(input.globalSeq - 1, 1)[0];
      if (!event || !inRanges(left, event.seq) || isDeletedEventPayload(event.payload)) continue;
      const payload = event.payload as MessageEventPayload;
      const copy: MessageEnvelope = { ...payload.message, id: `m-${randomUUID()}`, time };
      carried.push({ from: payload.message.id, to: copy.id });
      events.push({ channel: conversation, type: EVENT_TYPES.message, payload: { ...payload, message: copy }, idempotencyKey: `carry:${conversation}:switch-${at}:${payload.message.id}` });
    }
    return { carried, events };
  };

  return {
    navigating: (conversation) => busy.get(conversation),

    preview(conversation, before, session) {
      const tree = branchTreeOf(store.reader, conversation);
      const rollback = plan(conversation, before, tree, session);
      return { conversation, before, effects: effectsIn(conversation, rangesFrom(pathRanges(tree), rollback.cut), session) };
    },

    async rollback(conversation, before, session, idempotencyKey) {
      const key = `rollback:${conversation}:${idempotencyKey}`;
      const done = store.eventByIdempotencyKey(key);
      if (done) {
        const payload = done.payload as SessionBranchEventPayload;
        const branch = findBranch(payload.branches, payload.to);
        return { branchId: payload.to, summaryMessageId: branch?.summary?.messageId ?? "" };
      }
      if (busy.has(conversation)) throw new RequestRejected("conflict", t("conversation.rollback.busy"));
      busy.set(conversation, "rollback");
      try {
        const tree = branchTreeOf(store.reader, conversation);
        const rollback = plan(conversation, before, tree, session);
        // 撤销接口要的这一段已经做了的事：按回退前的样子算（停稳期间这一轮被中止，不会再多出效果）
        const effects = effectsIn(conversation, rangesFrom(pathRanges(tree), rollback.cut), session);
        const branchId = nextBranchId(tree);
        let committed: ReturnType<typeof commitEvents> | undefined;
        // 被放弃的那段按停稳之后的样子现算（293 号票：运行时不自己写分支摘要的，二狗按这一段里自己记下的事件写）
        const abandoned = () => rangesFrom(pathRanges(branchTreeOf(store.reader, conversation)), rollback.cut);
        await session.navigate({ target: rollback.target, summary: { instructions: BRANCH_SUMMARY_INSTRUCTIONS, abandoned }, marker: { branchId, change: "rollback" } }, (navigated) => {
          committed = commitEvents(conversation, before, rollback, branchId, navigated, session, effects);
          const [first, ...rest] = committed.events;
          store.appendBatch([{ ...first!, idempotencyKey: key }, ...rest]);
          committed.afterCommit();
        });
        if (!committed) throw new RequestRejected("internal", t("conversation.rollback.failed"));
        // @i18n-ignore-start log：只进日志
        const where =
          "messageId" in before
            ? `消息 ${before.messageId}`
            : "branchId" in before
              ? `分支 ${before.branchId} 开始`
              : rollback.step
                ? `步骤「${rollback.step.title}」开始`
                : `阶段「${rollback.stage?.title ?? before.stageStart}」开始`;
        // @i18n-ignore-end
        log(`会话回退：${conversation} 从 ${committed.from} 长出 ${branchId}（回到 ${where}之前）`);
        try {
          await hook.onSessionRollback({ conversation, from: committed.from, to: branchId, before, abandoned: committed.abandoned, effects });
        } catch (err) {
          log(`会话回退之后的撤销接口出错：${err instanceof Error ? err.message : String(err)}`);
        }
        return committed.result;
      } finally {
        busy.delete(conversation);
      }
    },

    async switchBranch(conversation, branchId, session, idempotencyKey) {
      const key = `switch:${conversation}:${idempotencyKey}`;
      const done = store.eventByIdempotencyKey(key);
      if (done) return { branchId: (done.payload as SessionBranchEventPayload).to };
      if (busy.has(conversation)) throw new RequestRejected("conflict", t("conversation.session.navigating"));
      busy.set(conversation, "switch");
      try {
        const tip = switchTarget(conversation, branchId, branchTreeOf(store.reader, conversation));
        // 会话自己说现在能不能切（152 号票：项目维护者这一段已经结束了、任务取消了、子 agent 还在跑……）
        const refusal = session.refusal?.();
        if (refusal !== undefined) throw new RequestRejected("not_allowed", refusal);
        let from: string | undefined;
        // 只挪末端、不写摘要（两条分支都还在树上，随时可以切回来）
        await session.navigate({ target: { entry: tip }, marker: { branchId, change: "switch" } }, (navigated) => {
          // 停稳期间追加的（说到一半的回复、turn_end）都落在离开的那条上：按现在的样子算
          const tree = branchTreeOf(store.reader, conversation);
          const at = store.lastSeq(conversation) + 1;
          const time = nowIso();
          const next = switchedTree(tree, branchId, at, navigated.from);
          const left = branchOwnRanges(next, tree.current);
          // 跟着会话树走的业务状态（152 号票：长程任务的阶段、计划按切过去的那条分支推导）：同一事务；不作废卡片
          const followed = session.follow?.({ conversation, change: "switch", tree: next, abandoned: left, external: [] });
          const { carried, events } = carryInputs(conversation, left, at, time, followed?.voidedInputs);
          const payload: SessionBranchEventPayload = { change: "switch", branches: next, from: tree.current, to: branchId, ...(carried.length > 0 ? { carried } : {}), by: "user", time };
          store.appendBatch([{ channel: conversation, type: EVENT_TYPES.sessionBranch, payload, idempotencyKey: key }, ...events, ...(followed?.events ?? [])]);
          followed?.afterCommit();
          from = tree.current;
        });
        log(`切换分支：${conversation} 从 ${from ?? "?"} 切到 ${branchId}`);
        return { branchId };
      } finally {
        busy.delete(conversation);
      }
    },

    branchView(conversation, branchId, against, session) {
      const tree = branchTreeOf(store.reader, conversation);
      const other = against ?? tree.current;
      if (!findBranch(tree, branchId) || !findBranch(tree, other)) throw new RequestRejected("not_found", t("conversation.rollback.noBranch"));
      const ranges = branchOwnRanges(tree, branchId, other);
      const requested = undoRequests(conversation);
      const effects = effectsIn(conversation, ranges, session).map((e): BranchEffect => {
        const at = requested.get(e.callId);
        return at === undefined ? e : { ...e, undoRequested: at };
      });
      const summary = abandonSummary(conversation, tree, branchId);
      return { ...rangePage(store, conversation, ranges), branchId, against: other, ...(summary === undefined ? {} : { summary }), effects };
    },

    async requestEffectUndo(conversation, branchId, callId, session) {
      const tree = branchTreeOf(store.reader, conversation);
      if (!findBranch(tree, branchId)) throw new RequestRejected("not_found", t("conversation.rollback.noBranch"));
      if (branchId === tree.current) throw new RequestRejected("not_allowed", t("conversation.rollback.currentBranch"));
      const effect = effectsIn(conversation, branchOwnRanges(tree, branchId), session).find((e) => e.callId === callId);
      if (!effect) throw new RequestRejected("not_found", t("conversation.rollback.noEffect"));
      if (!effect.undoable) throw new RequestRejected("not_allowed", t("conversation.rollback.notUndoable", { why: effect.why ?? t("conversation.rollback.irreversible") }));
      const already = undoRequests(conversation).get(callId);
      if (already !== undefined) return { requestedAt: already };
      const time = nowIso();
      const payload: EffectUndoRequestedEventPayload = { branchId, callId, tool: effect.tool, summary: effect.summary, by: "user", time };
      store.append({ channel: conversation, type: EVENT_TYPES.effectUndoRequested, payload, idempotencyKey: `undo:${conversation}:${callId}` });
      log(`申请撤回：${conversation} 分支 ${branchId} 上的 ${effect.tool}（${callId}）`);
      try {
        await hook.onEffectUndoRequest?.({ conversation, branchId, effect });
      } catch (err) {
        log(`申请撤回之后的撤销接口出错：${err instanceof Error ? err.message : String(err)}`);
      }
      return { requestedAt: time };
    },
  };
}
