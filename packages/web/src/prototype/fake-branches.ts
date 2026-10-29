// 原型里的会话回退（150 号票）：秘书主线最后演过一次回退，缩小后看得到 ↶（回退点）、⑂（废弃分支）、🧭 分支摘要；
// 点 ↶ 弹出的确认框列出这一段做了的事（按假会话里的工具调用编，见 fakeRollbackPreview），确认了照守护进程的算法长出新分支
// （session_branch 加一条分支摘要；原型不停 agent、不写真的摘要）。
// 151 号票：⑂ 展开的预览、分支详情要的一条分支的样子（fakeBranchView：它自己那一段的消息、遗留效果、分支摘要），切换分支（fakeSwitchBranch：
// 照守护进程只挪末端、记一条 session_branch），申请撤回（fakeEffectUndo：记一条 effect_undo_requested）。
// 152 号票：长程任务维护者的会话也能撤回——阶段开始的回退点照守护进程截的那一处（stage_start 记号写明维护者是怎么知道的），撤回之后
// 任务的阶段照"那个阶段及之后回到未开始"推一遍（原型不翻看板上的历史：这个阶段重新开始、之后开始过的回到未开始），看板上推一条
// rolled_back，再交给维护者一句接着做的通知（分支摘要上记着它，界面上不重复显示）和这一阶段新的开始记号。
// 153 号票：流程的步骤开始也能撤回（同一条记号带 stepId，截在含那次 report_step 的那条消息）——那一步及之后（记号在它后面的）回到没做，
// 看板上推一条 rolled_back；固定计划不交给维护者接着做的话、不记新的开始记号（等你说话）。
// 155 号票：一分钟没说话的提醒在假连接里（fake-connection.ts 的 armRollbackWait）；定时、事件触发的流程任务状态不跟着走，
// 正在跑的那次运行记"已撤回"（不算失败），看板上推一条 run_finished。
// 293 号票：用 Claude Code 的维护者（fake-runtimes.ts 的 FAKE_CLAUDE_MAINTAINERS）撤回时照守护进程：分支摘要是二狗写的（原型照做了的事编一句），
// 摘要上记着按文件检查点恢复了哪些文件（被放弃那段里 write、edit 的路径；撤回到阶段、步骤开始前的不恢复）。
import {
  type BranchEffect,
  branchForks,
  branchOwnRanges,
  type BranchView,
  type EffectUndoRequestedEventPayload,
  findBranch,
  type HistoryMessage,
  type HistoryRecord,
  type QuickActionExecutedEventPayload,
  type RequestEffectUndoResult,
  type SeqRange,
  type SwitchBranchResult,
  switchedTree,
  type TimelineRecordEventPayload,
  CHANNELS,
  type ConversationBranches,
  type ConversationId,
  EVENT_TYPES,
  type EventFrame,
  grownTree,
  isTriggered,
  JOB_RUN_ROLLED_BACK_REASON,
  type JobRun,
  type ScheduledJobEventPayload,
  inRanges,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type BranchFilesRewind,
  maintainerChannel,
  nextBranchId,
  nowIso,
  pathRanges,
  rangesFrom,
  type RollbackEffect,
  type RollbackPreview,
  type RollbackSessionResult,
  type RollbackTarget,
  rollbackFork,
  SINGLE_BRANCH,
  type SessionBranchEventPayload,
  type StageStartEventPayload,
  type Task,
  type TaskEventPayload,
  startRollbackLabel,
  toolNatureOf,
} from "../state/index.ts";
import { at } from "./fake-conversations.ts";
import { FAKE_CLAUDE_MAINTAINERS } from "./fake-runtimes.ts";
import { markOf } from "./fake-long-tasks.ts";

const S = CHANNELS.secretary;
const EXTERNAL = "以我的名义对外发送或发布";
const DELETE = "删除或覆盖";

/** 原型的假事件日志：追加一条（返回带序号的帧）、某个频道上的全部帧 */
export interface FakeBranchLog {
  append(channel: string, type: string, payload: unknown): EventFrame;
  frames(channel: string): readonly EventFrame[];
}

const text = (t: string): MessagePart => ({ type: "text", text: t });
function tool(callId: string, name: string, argsSummary: string, result: string, categories: string[] = []): MessagePart {
  const part = {
    type: "tool_call" as const,
    callId,
    tool: name,
    argsSummary,
    categoryTitles: categories,
    disposition: "do" as const,
    withinGrant: false,
    genericBash: false,
    outcome: "done" as const,
    resultSummary: result,
    ...markOf(categories),
  };
  return { ...part, nature: toolNatureOf(part) };
}
const message = (id: string, speaker: MessageEnvelope["speaker"], time: string, ...parts: MessagePart[]): MessageEnvelope => ({ id, conversation: S, speaker, time, parts });

/** 被放弃的那一段：订了餐厅（对外的，撤不回） */
const ABANDONED: MessageEnvelope[] = [
  message("msg-rb-ask", "user", at("10-07", "22:05"), text("帮我订周六晚上的餐厅，川菜，4 个人")),
  message(
    "msg-rb-book",
    "agent",
    at("10-07", "22:06"),
    tool("call-rb-1", "web_search", "query=周六 川菜 4人 订位", "找到 3 家能订的"),
    tool("call-rb-2", "book_restaurant", "name=蜀九香 time=周六19:00 people=4", "订好了，确认短信发到你手机", [EXTERNAL]),
    text("订了周六 19:00「蜀九香」的 4 人位，确认短信发到你手机了。"),
  ),
];

const SUMMARY_TEXT = [
  "用户让订周六晚上的川菜馆，已经订了「蜀九香」周六 19:00 的 4 人位（对外生效，确认短信已发到用户手机）。",
  "用户撤回了这一段，订位没有取消；用户要是不去了，提醒他打电话取消或者在短信里退订。",
  "风险点：周六到店不取消可能被记爽约。",
].join("\n");

/** 新分支：改主意，整理行程发给小王、删旧草稿（本机能撤的一件、删了没备份的一件、对外的一件） */
const AFTER: MessageEnvelope[] = [
  message("msg-rb-redo", "user", at("10-07", "22:10"), text("算了周六在家吃。把西安行程整理成一页发给小王，旧的行程草稿删掉")),
  message(
    "msg-rb-done",
    "agent",
    at("10-07", "22:11"),
    tool("call-rb-3", "write", "drafts/西安行程-一页版.md", "写好了，1 页"),
    tool("call-rb-4", "delete", "drafts/西安行程-旧.md", "删了", [DELETE]),
    tool("call-rb-5", "send_message", "to=小王 attach=drafts/西安行程-一页版.md", "发出去了", [EXTERNAL]),
    text("整理成一页发给小王了，旧草稿也删了。"),
  ),
];

/** 原型开头就有的那次回退：被放弃的一段、session_branch、分支摘要、新分支上的一轮 */
export function appendRollbackDemo(log: FakeBranchLog): void {
  for (const m of ABANDONED) log.append(S, EVENT_TYPES.message, { message: m } satisfies MessageEventPayload);
  const cut = log.frames(S).find((f) => f.type === EVENT_TYPES.message && (f.payload as MessageEventPayload).message.id === "msg-rb-ask")!.seq;
  commitRollback(log, S, SINGLE_BRANCH, { messageId: "msg-rb-ask" }, cut, "b1", SUMMARY_TEXT, at("10-07", "22:09"));
  for (const m of AFTER) log.append(S, EVENT_TYPES.message, { message: m } satisfies MessageEventPayload);
}

/** 这个会话现在的会话树（最新一条 session_branch 带的；没回退过是只有一条分支的） */
export function fakeBranchTree(log: FakeBranchLog, conversation: ConversationId): ConversationBranches {
  const last = log.frames(conversation).findLast((f) => f.type === EVENT_TYPES.sessionBranch);
  return last ? (last.payload as SessionBranchEventPayload).branches : SINGLE_BRANCH;
}

const seqOf = (f: EventFrame | undefined) => f?.seq;

/** 会话里这条阶段开始的记号（152 号票）和它的序号 */
function stageMarkOf(log: FakeBranchLog, conversation: ConversationId, id: string): { seq: number; mark: StageStartEventPayload } | undefined {
  const frame = log.frames(conversation).find((f) => f.type === EVENT_TYPES.stageStart && (f.payload as StageStartEventPayload).id === id);
  return frame && { seq: frame.seq, mark: frame.payload as StageStartEventPayload };
}

/** 回退点截在哪个序号（被放弃的是当前路径上从它起的那一段）；回不到那里时抛出原因 */
function cutOf(log: FakeBranchLog, conversation: ConversationId, tree: ConversationBranches, before: RollbackTarget): number {
  if ("stageStart" in before) {
    // 照守护进程 rollback.ts 的 stagePlan：通知交代的截在那条通知；"开始阶段"那次调用截在那条回复说的话；别的调用截在它的记录后面那一条
    const found = stageMarkOf(log, conversation, before.stageStart);
    if (!found) throw new Error("这个会话里没有这个阶段开始的回退点");
    const messages = log.frames(conversation).filter((f) => f.type === EVENT_TYPES.message && inRanges(pathRanges(tree), f.seq));
    const { via } = found.mark;
    const cut =
      "notice" in via
        ? seqOf(messages.find((f) => (f.payload as MessageEventPayload).message.id === via.notice))
        : via.after
          ? (seqOf(messages.find((f) => f.seq > found.seq && (f.payload as MessageEventPayload).message.parts.some((p) => p.type === "tool_call" && p.callId === via.call))) ?? found.seq) + 1
          : (seqOf(messages.findLast((f) => f.seq < found.seq && (f.payload as MessageEventPayload).message.calls?.includes(via.call) === true)) ?? found.seq);
    if (cut === undefined) throw new Error("这个阶段的交代不在当前分支上");
    return cut;
  }
  if ("branchId" in before) {
    const fork = rollbackFork(tree, before);
    if (!fork) throw new Error("没有这条分支");
    return fork.cutoff;
  }
  const frame = log.frames(conversation).find((f) => f.type === EVENT_TYPES.message && (f.payload as MessageEventPayload).message.id === before.messageId);
  if (!frame || !inRanges(pathRanges(tree), frame.seq)) throw new Error("这条消息不在当前分支上");
  return frame.seq;
}

/**
 * 回退前的确认（原型）：被放弃的那一段里成功执行、不是只看的工具调用各一件；带"以我的名义对外发送或发布"的是对外的（收不回），
 * 带"删除或覆盖"的是本机但没有备份，别的本机的能申请撤回
 */
export function fakeRollbackPreview(log: FakeBranchLog, conversation: ConversationId, before: RollbackTarget): RollbackPreview {
  const tree = fakeBranchTree(log, conversation);
  const abandoned = rangesFrom(pathRanges(tree), cutOf(log, conversation, tree, before));
  return { conversation, before, effects: effectsIn(log, conversation, abandoned) };
}

/** 几段序号里成功执行、不是只看的工具调用各一件（回退前的确认、分支详情的遗留效果同一个算法） */
function effectsIn(log: FakeBranchLog, conversation: ConversationId, ranges: readonly SeqRange[]): RollbackEffect[] {
  const effects: RollbackEffect[] = [];
  for (const f of log.frames(conversation)) {
    if (f.type !== EVENT_TYPES.message || !inRanges(ranges, f.seq)) continue;
    const { message: m } = f.payload as MessageEventPayload;
    for (const part of m.parts) {
      if (part.type !== "tool_call" || part.outcome !== "done" || part.nature === "look") continue;
      const external = part.categoryTitles.includes(EXTERNAL);
      const why = external ? "已经对外生效" : part.categoryTitles.includes(DELETE) ? "删除或覆盖，没有备份" : undefined;
      effects.push({
        callId: part.callId,
        tool: part.tool,
        argsSummary: part.argsSummary,
        summary: `${part.argsSummary}${part.resultSummary ? ` → ${part.resultSummary}` : ""}`,
        scope: external ? "external" : "local",
        undoable: why === undefined,
        ...(why === undefined ? {} : { why }),
        at: m.time,
      });
    }
  }
  return effects;
}

/** 申请撤回过的：工具调用 id → 第一次提交的时间 */
function undoRequests(log: FakeBranchLog, conversation: ConversationId): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of log.frames(conversation)) {
    if (f.type !== EVENT_TYPES.effectUndoRequested) continue;
    const { callId, time } = f.payload as EffectUndoRequestedEventPayload;
    if (!out.has(callId)) out.set(callId, time);
  }
  return out;
}

/** 这条分支最后一次被回退离开时写的分支摘要；之后它又是当前分支时多了消息的不算（同守护进程的 abandonSummary） */
function abandonSummary(log: FakeBranchLog, conversation: ConversationId, tree: ConversationBranches, branchId: string): string | undefined {
  const last = log.frames(conversation).findLast((f) => f.type === EVENT_TYPES.sessionBranch && (f.payload as SessionBranchEventPayload).change === "rollback" && (f.payload as SessionBranchEventPayload).from === branchId);
  if (!last) return undefined;
  const payload = last.payload as SessionBranchEventPayload;
  const written = findBranch(payload.branches, payload.to)?.summary?.text;
  const later = tree.epochs.flatMap((epoch, i) => (epoch.branch === branchId && epoch.from > last.seq ? [{ from: epoch.from, to: tree.epochs[i + 1]?.from ?? Number.POSITIVE_INFINITY }] : []));
  return log.frames(conversation).some((f) => f.type === EVENT_TYPES.message && inRanges(later, f.seq)) ? undefined : written;
}

/** 一条分支的样子（原型的 GET /api/conversations/<会话>/branch）：它路径上不在 against（不给是当前分支）路径上的那一段 */
export function fakeBranchView(log: FakeBranchLog, conversation: ConversationId, branchId: string, against?: string): BranchView {
  const tree = fakeBranchTree(log, conversation);
  const other = against ?? tree.current;
  if (!findBranch(tree, branchId) || !findBranch(tree, other)) throw new Error("没有这条分支");
  const ranges = branchOwnRanges(tree, branchId, other);
  const inside = log.frames(conversation).filter((f) => inRanges(ranges, f.seq));
  const messages = inside.flatMap((f): HistoryMessage[] => (f.type === EVENT_TYPES.message ? [{ seq: f.seq, message: (f.payload as MessageEventPayload).message }] : []));
  const records = inside.flatMap((f): HistoryRecord[] =>
    f.type === EVENT_TYPES.timelineRecord
      ? [{ seq: f.seq, type: EVENT_TYPES.timelineRecord, payload: f.payload as TimelineRecordEventPayload }]
      : f.type === EVENT_TYPES.quickActionExecuted
        ? [{ seq: f.seq, type: EVENT_TYPES.quickActionExecuted, payload: f.payload as QuickActionExecutedEventPayload }]
        : [],
  );
  const requested = undoRequests(log, conversation);
  const effects = effectsIn(log, conversation, ranges).map((e): BranchEffect => {
    const asked = requested.get(e.callId);
    return asked === undefined ? e : { ...e, undoRequested: asked };
  });
  const summary = abandonSummary(log, conversation, tree, branchId);
  return { conversation, branchId, against: other, messages, records, effects, ...(summary === undefined ? {} : { summary }) };
}

/** 切换分支（原型）：只挪末端、不写摘要，原来的当前分支记下末端；记一条 session_branch（change: switch）。切不过去时抛出原因 */
export function fakeSwitchBranch(log: FakeBranchLog, conversation: ConversationId, branchId: string): { result: SwitchBranchResult; frames: EventFrame[] } {
  const tree = fakeBranchTree(log, conversation);
  const target = findBranch(tree, branchId);
  if (!target) throw new Error("没有这条分支");
  if (target.id === tree.current) throw new Error("已经在这条分支上了");
  if (!branchForks(tree).some((f) => f.branches.includes(branchId))) throw new Error("只能切换到清空、换模型之后这段里分出去的分支");
  const seq = (log.frames(conversation).at(-1)?.seq ?? 0) + 1;
  const time = nowIso();
  const branches = switchedTree(tree, branchId, seq, `fake-tip-${tree.current}-${seq}`);
  const payload: SessionBranchEventPayload = { change: "switch", branches, from: tree.current, to: branchId, by: "user", time };
  const frames = [log.append(conversation, EVENT_TYPES.sessionBranch, payload)];
  // 任务会话（152 号票）：任务回到切过去那条分支上的样子（原型照离开那条时记下的恢复）
  const now = conversationTask(log, conversation);
  const then = branchTasks.get(branchKey(conversation, branchId));
  if (now && then) {
    branchTasks.set(branchKey(conversation, tree.current), now);
    const task: Task = { ...then, reworks: (now.reworks ?? 0) + 1, updatedAt: time };
    frames.push(log.append(CHANNELS.board, EVENT_TYPES.task, { task, change: "rolled_back", from: now.state, by: "user" } satisfies TaskEventPayload));
  }
  return { result: { branchId }, frames };
}

/** 申请撤回（原型）：废弃分支上一件能申请撤回的，记一条 effect_undo_requested；同一件再点拿到第一次的时间 */
export function fakeEffectUndo(log: FakeBranchLog, conversation: ConversationId, branchId: string, callId: string): { result: RequestEffectUndoResult; frames: EventFrame[] } {
  const tree = fakeBranchTree(log, conversation);
  if (branchId === tree.current) throw new Error("这是当前分支，申请撤回在废弃分支的详情里");
  const effect = effectsIn(log, conversation, branchOwnRanges(tree, branchId)).find((e) => e.callId === callId);
  if (!effect) throw new Error("这条分支上没有这件事");
  if (!effect.undoable) throw new Error(`这件事无法撤回（${effect.why ?? "不可撤销"}）`);
  const already = undoRequests(log, conversation).get(callId);
  if (already !== undefined) return { result: { requestedAt: already }, frames: [] };
  const time = nowIso();
  const payload: EffectUndoRequestedEventPayload = { branchId, callId, tool: effect.tool, summary: effect.summary, by: "user", time };
  return { result: { requestedAt: time }, frames: [log.append(conversation, EVENT_TYPES.effectUndoRequested, payload)] };
}

/** 回退（原型）：照守护进程的算法长出新分支，记一条 session_branch、一条分支摘要；返回推给前端的帧 */
export function fakeRollback(log: FakeBranchLog, conversation: ConversationId, before: RollbackTarget): { result: RollbackSessionResult; frames: EventFrame[] } {
  const tree = fakeBranchTree(log, conversation);
  const cut = cutOf(log, conversation, tree, before);
  const branchId = nextBranchId(tree);
  const mark = "stageStart" in before ? stageMarkOf(log, conversation, before.stageStart)?.mark : undefined;
  const target = "messageId" in before ? "这条请求之前" : "branchId" in before ? `分支 ${before.branchId} 开始前` : startRollbackLabel(mark ?? { title: "" }).replace(/^撤回到/, "");
  // 293 号票：用 Claude Code 的维护者——摘要由二狗写、文件按检查点恢复
  const claude = FAKE_CLAUDE_MAINTAINERS.some((id) => maintainerChannel(id) === conversation);
  const effects = effectsIn(log, conversation, rangesFrom(pathRanges(tree), cut));
  const summary = claude
    ? effects.length > 0
      ? `被放弃的这段做了 ${effects.length} 件事：${effects.map((e) => `${e.tool} ${e.argsSummary}`).join("、")}，都在本机、还没推送。（原型：Claude Code 自己不写分支摘要，这段由二狗按自己记下的事写）`
      : "被放弃的这段还没做什么事。（原型：Claude Code 自己不写分支摘要，这段由二狗按自己记下的事写）"
    : `（原型）撤回到${target}：守护进程会在这里写被放弃那一段的摘要——做到哪一步、对外产生了哪些效果、有哪些风险点。`;
  const files: BranchFilesRewind | undefined = claude
    ? mark
      ? { restored: [], skipped: "call_point" }
      : { restored: effects.filter((e) => e.tool === "write" || e.tool === "edit").map((e) => e.argsSummary) }
    : undefined;
  // 流程的步骤开始（153 号票）：步骤跟着退，不交代、不记新的开始记号
  if (mark?.stepId !== undefined) {
    const committed = commitRollback(log, conversation, tree, before, cut, branchId, summary, nowIso(), undefined, files);
    const markSeq = stageMarkOf(log, conversation, mark.id)!.seq;
    return { ...committed, frames: [...committed.frames, ...followStep(log, conversation, mark, markSeq, nowIso(), tree.current)] };
  }
  return commitRollback(log, conversation, tree, before, cut, branchId, summary, nowIso(), mark, files);
}

/**
 * 撤回到长程任务一个阶段开始前之后（原型，152 号票）：这个阶段重新开始、之后开始过的（记号在它后面的）回到未开始，看板上推一条 rolled_back；
 * 交给维护者一句接着做的通知（noticeId，记在分支摘要上）、这一阶段新的开始记号。返回要推的帧
 */
/**
 * 原型的任务跟着分支走（152 号票）：离开一条分支时它上面任务的样子（会话 + 分支 → 那时看板上的任务）。守护进程按看板事件在会话里的位置推导，
 * 原型没有全局的先后，撤回、切换离开时各记一份，切回来时照它恢复
 */
const branchTasks = new Map<string, Task>();
const branchKey = (conversation: ConversationId, branchId: string) => `${conversation}\u0000${branchId}`;

/** 这个会话里长程任务最新的样子（看板上最后一条；会话里有阶段开始的记号才算任务会话） */
function conversationTask(log: FakeBranchLog, conversation: ConversationId): Task | undefined {
  const mark = log.frames(conversation).findLast((f) => f.type === EVENT_TYPES.stageStart)?.payload as StageStartEventPayload | undefined;
  if (!mark) return undefined;
  return (log.frames(CHANNELS.board).findLast((f) => f.type === EVENT_TYPES.task && (f.payload as TaskEventPayload).task.id === mark.taskId)?.payload as TaskEventPayload | undefined)?.task;
}

/** 撤回到流程一个步骤开始前之后（原型，153 号票）：这一步和之后开始过的（记号在它后面的）回到没做，任务在执行中；看板上推一条 rolled_back */
function followStep(log: FakeBranchLog, conversation: ConversationId, mark: StageStartEventPayload, markSeq: number, time: string, leaving: string): EventFrame[] {
  const later = new Set(log.frames(conversation).flatMap((f) => (f.type === EVENT_TYPES.stageStart && f.seq >= markSeq ? [(f.payload as StageStartEventPayload).stepId ?? ""] : [])));
  const last = log.frames(CHANNELS.board).findLast((f) => f.type === EVENT_TYPES.task && (f.payload as TaskEventPayload).task.id === mark.taskId);
  if (!last) return [];
  const before = (last.payload as TaskEventPayload).task;
  // 定时、事件触发的（155 号票）：任务状态不跟着会话推导（一次运行就是一段会话）；正在跑的这次运行到此为止，记"已撤回"
  if (isTriggered(before)) return rolledBackRun(log, before.id, time);
  branchTasks.set(branchKey(conversation, leaving), before);
  const list = (before.steps?.list ?? []).map((s) => (later.has(s.stepId) ? { stepId: s.stepId, title: s.title, state: "pending" as const } : s));
  const done = list.filter((s) => s.state === "done" || s.state === "skipped").length;
  const task: Task = { ...before, state: "running", steps: { total: list.length, done, list }, reworks: (before.reworks ?? 0) + 1, updatedAt: time };
  return [log.append(CHANNELS.board, EVENT_TYPES.task, { task, change: "rolled_back", from: before.state, by: "user" } satisfies TaskEventPayload)];
}

/** 定时、事件触发的任务正在跑的那次运行撤回了（原型，155 号票）：记"已撤回"——不算失败，连续失败次数、"最近一次失败"不动 */
function rolledBackRun(log: FakeBranchLog, taskId: string, time: string): EventFrame[] {
  const last = log.frames(CHANNELS.board).findLast((f) => f.type === EVENT_TYPES.scheduledJob && (f.payload as ScheduledJobEventPayload).job.ownerTaskId === taskId);
  const job = (last?.payload as ScheduledJobEventPayload | undefined)?.job;
  const run = job?.lastRun;
  if (!job || run?.state !== "running") return [];
  const ended: JobRun = { ...run, state: "rolled_back", endedAt: time, reason: JOB_RUN_ROLLED_BACK_REASON.rollback };
  return [log.append(CHANNELS.board, EVENT_TYPES.scheduledJob, { job: { ...job, lastRun: ended, updatedAt: time }, change: "run_finished", by: "system", run: ended } satisfies ScheduledJobEventPayload)];
}

function followStage(log: FakeBranchLog, conversation: ConversationId, mark: StageStartEventPayload, markSeq: number, time: string, noticeId: string, leaving: string): EventFrame[] {
  const later = new Set(log.frames(conversation).flatMap((f) => (f.type === EVENT_TYPES.stageStart && f.seq >= markSeq ? [(f.payload as StageStartEventPayload).stageId] : [])));
  const last = log.frames(CHANNELS.board).findLast((f) => f.type === EVENT_TYPES.task && (f.payload as TaskEventPayload).task.id === mark.taskId);
  const frames: EventFrame[] = [];
  if (last) {
    const before = (last.payload as TaskEventPayload).task;
    branchTasks.set(branchKey(conversation, leaving), before);
    const list = (before.stages?.list ?? []).map((s) => {
      if (!later.has(s.stageId)) return s;
      const { startedAt: _s, summary: _m, userWords: _w, ...rest } = s;
      const reset = { ...rest, acceptance: s.acceptance.map(({ criterion, method }) => ({ criterion, method })), waitReason: undefined, waitingOn: undefined };
      return s.stageId === mark.stageId ? { ...reset, state: "running" as const, startedAt: time } : { ...reset, state: "pending" as const };
    });
    const position = list.findIndex((s) => s.stageId === mark.stageId) + 1;
    const task: Task = { ...before, state: "running", stages: { ...before.stages!, list, focus: mark.stageId, current: position }, reworks: (before.reworks ?? 0) + 1, updatedAt: time };
    frames.push(log.append(CHANNELS.board, EVENT_TYPES.task, { task, change: "rolled_back", from: before.state, by: "user" } satisfies TaskEventPayload));
  }
  const notice: MessageEnvelope = {
    id: noticeId,
    conversation,
    speaker: "system",
    time,
    parts: [{ type: "text", text: `用户撤回到第 ${mark.code ?? mark.stageId} 阶段「${mark.title}」开始前：之后那一段作废了（被放弃的那段写了分支摘要，在上面）。从这一阶段重新开始、重做。` }],
  };
  frames.push(log.append(conversation, EVENT_TYPES.message, { message: notice, agentInput: true, taskId: mark.taskId, stageId: mark.stageId } satisfies MessageEventPayload));
  frames.push(log.append(conversation, EVENT_TYPES.stageStart, { ...mark, id: `${mark.id}-again-${markSeq}`, via: { notice: notice.id }, time } satisfies StageStartEventPayload));
  return frames;
}

function commitRollback(
  log: FakeBranchLog,
  conversation: ConversationId,
  tree: ConversationBranches,
  before: RollbackTarget,
  cut: number,
  branchId: string,
  summary: string,
  time: string,
  stage?: StageStartEventPayload,
  files?: BranchFilesRewind,
): { result: RollbackSessionResult; frames: EventFrame[] } {
  const fork = "branchId" in before ? rollbackFork(tree, before) : rollbackFork(tree, { seq: cut });
  const start = (log.frames(conversation).at(-1)?.seq ?? 0) + 1;
  const summaryId = `msg-rb-summary-${branchId}`;
  const next = grownTree(tree, { id: branchId, ...fork!, summary: { messageId: summaryId, text: summary }, entry: `fake-entry-${branchId}`, time }, start, `fake-tip-${tree.current}`);
  const payload: SessionBranchEventPayload = { change: "rollback", branches: next, from: tree.current, to: branchId, before, by: "user", time };
  // 撤回到阶段开始前（152 号票）：交给维护者接着做的那句记在分支摘要上（界面上不重复显示）
  const noticeId = stage ? `msg-rb-notice-${conversation}-${branchId}` : undefined;
  const frames = [
    log.append(conversation, EVENT_TYPES.sessionBranch, payload),
    log.append(conversation, EVENT_TYPES.message, {
      message: {
        id: summaryId,
        conversation,
        speaker: "system",
        time,
        parts: [{ type: "branch_summary", branchId, summary, ...(noticeId === undefined ? {} : { notice: noticeId }), ...(files === undefined ? {} : { files }) }],
      },
      // 摘要归到重新开始的那个阶段（守护进程照跟着走完之后在做的阶段写）
      ...(stage ? { taskId: stage.taskId, stageId: stage.stageId } : {}),
    } satisfies MessageEventPayload),
  ];
  if (stage && noticeId) {
    const markSeq = log.frames(conversation).find((f) => f.type === EVENT_TYPES.stageStart && (f.payload as StageStartEventPayload).id === stage.id)!.seq;
    frames.push(...followStage(log, conversation, stage, markSeq, time, noticeId, tree.current));
  }
  return { result: { branchId, summaryMessageId: summaryId }, frames };
}
