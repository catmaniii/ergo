// 会话树（150 号票，会话回退与分支，规格 .scratch/ergo-v2/session-rollback.md）在事件日志这一侧的样子。
//
// 模型的上下文是 pi 的会话文件（会话树，子进程那一层）；界面上的会话是二狗的事件日志（会话频道）。两份一起切：回退、切换分支时
// 会话频道上记一条 session_branch，带着这次之后整棵树的样子（ConversationBranches，和 message_queue 带整队一样），
// 会话视图、往上翻历史、前端都按它推导"当前分支"和"废弃分支"：
// - 分支：最初那条是 b0；每次回退长出一条新分支（b1、b2……），记着从哪条分支的哪一处长出来（parent、cutoff：父分支上序号小于
//   cutoff 的在它的路径上）；
// - 时代（epochs）：会话频道上每一段序号属于哪条分支。追加的事件属于追加那一刻的当前分支，所以只要记下当前分支在哪个序号换了，
//   任何一条事件属于哪条分支都推得出来（branchAt），不用给每条消息打标记；
// - 当前路径：从当前分支往上，每条分支用到哪个序号之前（branchChain）；路径上的事件是一组序号段（pathRanges），从早到晚不交叠；
// - 废弃分支：除当前分支之外的每一条（每条各有自己的末端）；分叉点在当前路径上"序号不小于 at 的第一条"之前（branchForks），
//   和回退点落在同一条边界上（回退点、分叉点共用同一条边界，一左一右）。
// 回退点一律是"回到这一条之前"：用户消息（撤回到这条请求之前）、分支摘要（撤回到这条分支开始前）；只在当前这段会话里有
// （最近一次清空、换模型之后，用户定的第 5 条：agentSessionStart 认这段从哪开始）。
// 纯函数、只有类型和 TypeBox 的请求参数，守护进程和前端共用。
import { type Static, Type } from "typebox";
import { CHANNELS, MAINTAINER_CHANNEL_PREFIX } from "./constants.ts";
import { followLocale, t, tTable } from "./i18n/runtime.ts";
import type { HistoryPage } from "./http-schema.ts";
import { ConversationId, type MessageEnvelope } from "./schema.ts";

/** 最初那条分支 */
export const ROOT_BRANCH = "b0";

/** 会话树上的一条分支 */
export interface ConversationBranch {
  readonly id: string;
  /** 从哪条分支长出来（最初那条没有） */
  readonly parent?: string;
  /** 在父分支上截到哪：父分支上序号小于它的事件在这条分支的路径上（最初那条没有） */
  readonly cutoff?: number;
  /** 这条分支从哪个序号开始（长出它的那条 session_branch 事件的序号；最初那条是 0） */
  readonly start: number;
  /** 回退时写的分支摘要：被放弃的那段做到了哪一步、对外产生了哪些效果、风险点（这条分支开头 🧭 那条消息） */
  readonly summary?: { readonly messageId: string; readonly text: string };
  /** 会话文件里这条分支从哪一条长出来（子进程报回的）：撤回到"这条分支开始前"就回到这里 */
  readonly entry?: string;
  /** 上次离开这条分支时会话文件里的末端（子进程报回的；151 号票切回来时回到这里） */
  readonly tip?: string;
  /** 长出这条分支时 agent 的会话（会话文件的名字）：清空、换模型之后是另一个会话 */
  readonly session?: string;
  readonly time?: string;
}

/** 一个会话的会话树：当前分支、全部分支、每段序号属于哪条分支 */
export interface ConversationBranches {
  readonly current: string;
  readonly branches: readonly ConversationBranch[];
  /** 会话频道上每一段序号属于哪条分支：from 起（含）到下一段的 from 之前；第一段从 0 起，是最初那条 */
  readonly epochs: readonly { readonly from: number; readonly branch: string }[];
}

/** 还没回退过的会话：只有最初那条 */
export const SINGLE_BRANCH: ConversationBranches = Object.freeze({
  current: ROOT_BRANCH,
  branches: Object.freeze([Object.freeze({ id: ROOT_BRANCH, start: 0 })]),
  epochs: Object.freeze([Object.freeze({ from: 0, branch: ROOT_BRANCH })]),
});

/** 某个序号的事件属于哪条分支（追加那一刻的当前分支） */
export function branchAt(tree: ConversationBranches, seq: number): string {
  let owner = tree.epochs[0]?.branch ?? ROOT_BRANCH;
  for (const epoch of tree.epochs) {
    if (epoch.from > seq) break;
    owner = epoch.branch;
  }
  return owner;
}

/** 按 id 找分支 */
export function findBranch(tree: ConversationBranches, id: string): ConversationBranch | undefined {
  return tree.branches.find((b) => b.id === id);
}

/** 一条分支的路径：从它往上的每条分支、各用到哪个序号之前（它自己是 Infinity），到最初那条为止 */
export function branchChain(tree: ConversationBranches, branchId: string = tree.current): { branch: string; until: number }[] {
  const chain: { branch: string; until: number }[] = [];
  let id: string | undefined = branchId;
  let until = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    chain.push({ branch: id, until });
    const branch = findBranch(tree, id);
    if (!branch || branch.parent === undefined || branch.cutoff === undefined) break;
    until = branch.cutoff;
    id = branch.parent;
  }
  return chain;
}

/** 某个序号的事件在不在这条分支的路径上（不给分支是当前分支） */
export function onBranchPath(tree: ConversationBranches, seq: number, branchId: string = tree.current): boolean {
  const owner = branchAt(tree, seq);
  const link = branchChain(tree, branchId).find((l) => l.branch === owner);
  return link !== undefined && seq < link.until;
}

/** 一段序号 [from, to)；to 是 Infinity 表示一直到最新 */
export interface SeqRange {
  readonly from: number;
  readonly to: number;
}

/** 这条分支（不给是当前分支）路径上的序号段，从早到晚、不交叠，相邻的并成一段 */
export function pathRanges(tree: ConversationBranches, branchId: string = tree.current): SeqRange[] {
  const limits = new Map(branchChain(tree, branchId).map((l) => [l.branch, l.until]));
  const out: { from: number; to: number }[] = [];
  tree.epochs.forEach((epoch, i) => {
    const until = limits.get(epoch.branch);
    if (until === undefined) return;
    const end = Math.min(tree.epochs[i + 1]?.from ?? Number.POSITIVE_INFINITY, until);
    if (end <= epoch.from) return;
    const last = out.at(-1);
    if (last && last.to === epoch.from) last.to = end;
    else out.push({ from: epoch.from, to: end });
  });
  return out;
}

/** 当前路径上序号不小于 cut 的那几段：回到 cut 那一条之前时被放弃的那一段 */
export function rangesFrom(ranges: readonly SeqRange[], cut: number): SeqRange[] {
  return ranges.flatMap((r) => (r.to <= cut ? [] : [{ from: Math.max(r.from, cut), to: r.to }]));
}

/** 序号落不落在这几段里 */
export function inRanges(ranges: readonly SeqRange[], seq: number): boolean {
  return ranges.some((r) => seq >= r.from && seq < r.to);
}

/** 当前路径上的一个分叉点：从这里分出去的废弃分支 */
export interface BranchFork {
  /** 分叉在当前路径上"序号不小于 at 的第一条"之前（回退点和分叉点落在同一条边界上） */
  readonly at: number;
  /** 从这里分出去的废弃分支（每条各有自己的末端），按长出来的先后 */
  readonly branches: readonly string[];
}

/**
 * 当前路径上的分叉点：除当前分支之外的每条分支都是一条废弃分支，顺着它往上找到第一条
 * 在当前路径上的分支，两边各用到哪里取小的那个，就是分叉的位置。同一处分出去的几条并在一起（横着排开）
 */
export function branchForks(tree: ConversationBranches): BranchFork[] {
  const current = new Map(branchChain(tree).map((l) => [l.branch, l.until]));
  const forks = new Map<number, string[]>();
  for (const branch of tree.branches) {
    if (branch.id === tree.current) continue;
    for (const link of branchChain(tree, branch.id)) {
      const until = current.get(link.branch);
      if (until === undefined) continue;
      const at = Math.min(link.until, until);
      forks.set(at, [...(forks.get(at) ?? []), branch.id]);
      break;
    }
  }
  return [...forks.entries()].toSorted((a, b) => a[0] - b[0]).map(([at, branches]) => ({ at, branches }));
}

/**
 * 回退点：回到哪一条之前——一条用户消息之前，或者一条分支开始之前（它开头的分支摘要那条）；152 号票起还有长程任务的一个阶段开始之前
 * （stageStart：维护者会话频道上那条 stage_start 记号的 id，stage-starts.ts）
 */
export const RollbackTarget = Type.Union([
  Type.Object({ messageId: Type.String({ minLength: 1 }) }),
  Type.Object({ branchId: Type.String({ minLength: 1 }) }),
  Type.Object({ stageStart: Type.String({ minLength: 1 }) }),
]);
export type RollbackTarget = Static<typeof RollbackTarget>;

/** 回退长出的新分支：父分支和截到哪。回到一条消息之前截在这条消息；回到一条分支开始前和它同一处长出来（兄弟分支） */
export function rollbackFork(tree: ConversationBranches, cut: { seq: number } | { branchId: string }): { parent: string; cutoff: number } | undefined {
  if ("seq" in cut) return { parent: branchAt(tree, cut.seq), cutoff: cut.seq };
  const branch = findBranch(tree, cut.branchId);
  return branch?.parent === undefined || branch.cutoff === undefined ? undefined : { parent: branch.parent, cutoff: branch.cutoff };
}

/**
 * 回退之后的会话树：长出一条新分支 next（从 at 序号起，at 就是这次 session_branch 事件的序号），原来的当前分支记下离开时的末端
 */
export function grownTree(
  tree: ConversationBranches,
  next: Omit<ConversationBranch, "start"> & { parent: string; cutoff: number },
  at: number,
  leftTip: string | undefined,
): ConversationBranches {
  const branches = tree.branches.map((b) => (b.id === tree.current && leftTip !== undefined ? { ...b, tip: leftTip } : b));
  return { current: next.id, branches: [...branches, { ...next, start: at }], epochs: [...tree.epochs, { from: at, branch: next.id }] };
}

/** 下一条分支的 id */
export function nextBranchId(tree: ConversationBranches): string {
  let n = tree.branches.length;
  while (tree.branches.some((b) => b.id === `b${n}`)) n++;
  return `b${n}`;
}

/** 换模型新开会话时聊天里那条说明的写法（83 号票：model-switch.ts 的 modelSwitchedNote；150 号票之前的没有 sessionStart 标记，按它认） */
const MODEL_SWITCHED_NOTE = /^已换成 .+，接着之前的对话。$/; // @i18n-ignore data：认以前存下的说明

/**
 * 这条消息是不是 agent 新开一段会话的地方（之前的聊天不在它的上下文里，回退点只在这之后，用户定的第 5 条）：清空当前对话的分隔线
 * （114 号票）、换模型新开会话的说明（83 号票）、项目维护者的会话分段线（16 号票：每段一个会话）
 */
export function agentSessionStart(message: Pick<MessageEnvelope, "speaker" | "parts" | "sessionStart">): boolean {
  if (message.sessionStart === true) return true;
  if (message.parts.some((p) => p.type === "conversation_cleared" || p.type === "work_order_divider")) return true;
  return message.speaker === "system" && message.parts.length === 1 && message.parts[0]!.type === "text" && MODEL_SWITCHED_NOTE.test(message.parts[0].text);
}

/**
 * 回退点从哪条往后才有（用户定的第 5 条"只在当前这段里"）：agent 新开一段会话的地方（agentSessionStart），外加定时、事件触发的任务
 * 一次运行的分段线（153 号票：一次运行就是一段会话，只在这一次运行里回退；各次运行接着同一段 agent 会话，所以它不算 agentSessionStart——
 * 切换分支时"那条上清空、换过模型"照旧只认 agentSessionStart）
 */
export function rollbackSegmentStart(message: Pick<MessageEnvelope, "speaker" | "parts" | "sessionStart">): boolean {
  return agentSessionStart(message) || message.parts.some((p) => p.type === "run_divider");
}

/** 能回退的会话（150 号票先做秘书主会话；152 号票接上任务、项目维护者的会话：维护者会话频道） */
export function rollbackEnabled(conversation: string): boolean {
  return conversation === CHANNELS.secretary || conversation.startsWith(MAINTAINER_CHANNEL_PREFIX);
}

/** 回退点给人看的说法 */
export const ROLLBACK_LABEL = tTable({ message: "protocol.sessionBranches.rollbackMessage", branch: "protocol.sessionBranches.rollbackBranch" });

/** 废弃分支上发起、还没处理的卡作废时写的（再点旧按钮回这句；跟着当前语言，followLocale） */
export let ROLLBACK_VOIDED_CARD = "";
followLocale(() => {
  ROLLBACK_VOIDED_CARD = t("protocol.sessionBranches.voidedCard");
});

/**
 * 回退前写分支摘要的要求：接在 pi 写分支摘要的提示后面
 */
export const BRANCH_SUMMARY_INSTRUCTIONS =
  "用中文写 3~5 行：这条被放弃的分支做到了哪一步、已经对外产生了哪些效果（发出的消息、创建的会议等）、有哪些风险点。不要用 Markdown 标题。"; // @i18n-ignore model

/** session_branch 事件（会话频道，落盘）：回退（150 号票）、切换分支（151 号票）之后这个会话的会话树 */
export interface SessionBranchEventPayload {
  change: "rollback" | "switch";
  /** 这次之后的会话树（整棵：前端、会话视图只看最新的一条） */
  branches: ConversationBranches;
  /** 离开的分支、现在的当前分支 */
  from: string;
  to: string;
  /** 回退：回到哪一条之前 */
  before?: RollbackTarget;
  /** 被放弃的那段里还没处理、作废了的卡 */
  expiredCards?: string[];
  /** 被放弃的那段里还排着没处理的输入（运行时给 agent 的通知）：带到新分支上（原来那条的消息 id → 新分支上那条的） */
  carried?: { from: string; to: string }[];
  /** 谁做的：用户点的 */
  by: "user";
  time: string;
}

/** 回退会话（rollback_session）：哪个会话、回到哪一条之前 */
export const RollbackSessionParams = Type.Object({ conversation: ConversationId, before: RollbackTarget });
export type RollbackSessionParams = Static<typeof RollbackSessionParams>;

/** 回退的结果：长出的新分支、它开头的分支摘要那条消息 */
export const RollbackSessionResult = Type.Object({ branchId: Type.String(), summaryMessageId: Type.String() });
export type RollbackSessionResult = Static<typeof RollbackSessionResult>;

/** 回退会放弃掉的那一段已经在真实世界里做了的一件事（守卫的效果记录：成功执行、有副作用的；只看的不算） */
export interface RollbackEffect {
  /** 哪次工具调用（会话里那条工具调用记录） */
  callId: string;
  tool: string;
  /** 工具的中文名（没登记的没有） */
  toolTitle?: string;
  /** 参数摘要（会话里那条工具调用记录上的）：确认框里照工具调用那一行说成人话 */
  argsSummary: string;
  /** 效果摘要（效果日志里的，同一次调用拆出的几条合起来） */
  summary: string;
  /** 本机，还是对外的（发出去的消息、发布、对外提交） */
  scope: "local" | "external";
  /** 能申请撤回（本机、不是删除没有备份、不是不可逆的提交）；对外的一律不能 */
  undoable: boolean;
  /** 不能撤回的原因（"已经对外生效""删除或覆盖，没有备份""不可逆的提交"） */
  why?: string;
  /** 执行完的时间 */
  at: string;
}

/** 回退前的确认要的（GET /api/conversations/<会话>/rollback）：这一段已经做了的事 */
export interface RollbackPreview {
  conversation: string;
  before: RollbackTarget;
  effects: RollbackEffect[];
}

// ───────────────────────── 废弃分支：预览、详情、切换（151 号票） ─────────────────────────
// 废弃分支的预览（⑂ 展开）、切换的双向动画、分支详情（遗留效果、申请撤回），切换分支（停稳、只挪末端、不写摘要）。

/** 从 a 的序号段里去掉落在 b 里的部分（两组都从早到晚、不交叠） */
export function subtractRanges(a: readonly SeqRange[], b: readonly SeqRange[]): SeqRange[] {
  const out: SeqRange[] = [];
  for (const range of a) {
    let pieces: SeqRange[] = [range];
    for (const cut of b) {
      pieces = pieces.flatMap((p) => {
        if (cut.to <= p.from || cut.from >= p.to) return [p];
        return [
          ...(cut.from > p.from ? [{ from: p.from, to: cut.from }] : []),
          ...(cut.to < p.to ? [{ from: cut.to, to: p.to }] : []),
        ];
      });
    }
    out.push(...pieces);
  }
  return out;
}

/**
 * 一条分支自己的那一段：它的路径上、不在 against（不给是当前分支）路径上的序号段（
 * 即 branchPath(叶子).filter(不在当前分支上)）。废弃分支的预览、详情、遗留效果都只看这一段；切换分支之后，新的当前分支上不在原来那条
 * 路径上的就是 branchOwnRanges(新树, 新的当前分支, 原来那条)
 */
export function branchOwnRanges(tree: ConversationBranches, branchId: string, against: string = tree.current): SeqRange[] {
  return subtractRanges(pathRanges(tree, branchId), pathRanges(tree, against));
}

/**
 * 切换分支之后的会话树（只挪末端，两条分支都还在树上）：当前分支换成 to，从 at（这次 session_branch 的序号）
 * 起追加的属于它；原来的当前分支记下离开时的末端（之后切回来回到这里）
 */
export function switchedTree(tree: ConversationBranches, to: string, at: number, leftTip: string | undefined): ConversationBranches {
  const branches = tree.branches.map((b) => (b.id === tree.current && leftTip !== undefined ? { ...b, tip: leftTip } : b));
  return { current: to, branches, epochs: [...tree.epochs, { from: at, branch: to }] };
}

/** 切换分支（switch_branch）：哪个会话、切到哪条废弃分支 */
export const SwitchBranchParams = Type.Object({ conversation: ConversationId, branchId: Type.String({ minLength: 1 }) });
export type SwitchBranchParams = Static<typeof SwitchBranchParams>;

/** 切换的结果：现在的当前分支 */
export const SwitchBranchResult = Type.Object({ branchId: Type.String() });
export type SwitchBranchResult = Static<typeof SwitchBranchResult>;

/** 申请撤回一件遗留效果（request_effect_undo）：哪个会话、哪条废弃分支上的哪次工具调用 */
export const RequestEffectUndoParams = Type.Object({ conversation: ConversationId, branchId: Type.String({ minLength: 1 }), callId: Type.String({ minLength: 1 }) });
export type RequestEffectUndoParams = Static<typeof RequestEffectUndoParams>;

/** 申请撤回的结果：什么时候提交的（同一件再点拿到第一次的时间） */
export const RequestEffectUndoResult = Type.Object({ requestedAt: Type.String() });
export type RequestEffectUndoResult = Static<typeof RequestEffectUndoResult>;

/** effect_undo_requested 事件（会话频道，落盘）：用户对废弃分支上的一件遗留效果点了「申请撤回」 */
export interface EffectUndoRequestedEventPayload {
  branchId: string;
  callId: string;
  tool: string;
  /** 效果摘要（效果日志里的） */
  summary: string;
  by: "user";
  time: string;
}

/** 废弃分支上一件遗留效果：回退前的确认里那一件，加上申请撤回了没有（什么时候提交的） */
export interface BranchEffect extends RollbackEffect {
  undoRequested?: string;
}

/**
 * 一条分支的样子（GET /api/conversations/<会话>/branch?branch=&against=，151 号票）：它自己的那一段（branchOwnRanges）里的消息、
 * 时间线记录、语音对象（和往上翻的一页同一个形状，前端照样并进来）；那一段已经在真实世界里做了的事；分支摘要——这条分支被回退离开时
 * 写的那份（按离开时的叶子取：做到了哪一步、对外产生了哪些效果、风险点；只被切换离开过的没有）
 */
export interface BranchView extends Omit<HistoryPage, "hasMore"> {
  branchId: string;
  against: string;
  summary?: string;
  effects: BranchEffect[];
}
