// Claude Code 会话的撤回和切分支（293 号票，issue 24 第三节丙类；调研 31 第 8 节：/rewind 不能当命令发），宿主协议 navigate_session 在
// Claude Code 适配子进程这一侧。Claude 的会话不是 pi 那样的一棵树，二狗这样补：
// - ↶ 撤回到某条之前：对话用 SDK 的 forkSession（复制成一个新的 Claude 会话、全部换新 uuid，截到撤回点之前的那一条为止）分叉出来接着用；
//   撤回前的会话 id 报回守护进程（from：废弃分支的末端），新会话 id 是 at（这条新分支自己的会话）。撤回点之前的那一条按 SDK 的
//   getSessionMessages 重建的主线找（大会话只读最后一次压缩之后；找不到时用二狗交这条输入时记下的上一条）；撤回到会话开头之前就新开一个空会话；
// - 代码：撤回前用文件检查点把 Claude 自己的 Write、Edit 改过的文件恢复到撤回点（Query.rewindFiles，query 起来时开 enableFileCheckpointing；
//   Bash 改的追不到，界面写明）。分叉出来的会话不带撤销历史（SDK 说的），所以撤回点在更早的会话里时一路往上恢复：现在的会话恢复到它自己的
//   第一条输入、再往上一个……直到撤回点所在的会话恢复到撤回点（不是现在的会话的，临时起一个 query 接着那个会话只做这一件事）。
//   撤回到一次工具调用前后（阶段、步骤开始前）不恢复：检查点只按整条输入记。恢复出错只报原因，对话照样撤回；
// - 切到废弃分支：接着那条分支离开时的 Claude 会话 id（不分叉、不动文件）；
// - "撤回到这条分支开始前"：照这条分支的会话当初分叉的地方（记在 lineage 里）再分叉一次，文件一路恢复到这条分支的会话的第一条输入；
// - 分支摘要 Claude 自己不写（能力清单 branch_summary 是 false），守护进程按自己记下的事件写好交来（summary.written），记在新会话名下，
//   它的下一条输入的 UserPromptSubmit 钩子交给模型（切走了没交的留着，切回来再交）。
// 这些都要二狗自己记着（会话记录里的 lineage，records.ts）：每条输入推进了哪个 Claude 会话、二狗给它定的 uuid；每个会话从哪分叉来的、
// 它自己的第一条输入；还没交给模型的分支摘要。293 号票之前交的输入没有记录，撤回不到它之前。
// 真机（真的 forkSession、rewindFiles、跨会话恢复、钩子里的摘要进上下文）在 294 号票核对。
// @i18n-ignore-file log
import { randomUUID } from "node:crypto";
import { t, type BranchFilesRewind } from "@ergo/protocol";
import type { HostCommand, NavigateTarget, SessionNavigatedReport } from "../../runtime/host-protocol.ts";

type NavigateCommand = Extract<HostCommand, { type: "navigate_session" }>;

/** 主线上的一条（SDK 的 SessionMessage 用到的那几样） */
export interface ClaudeChainMessage {
  uuid: string;
  type: string;
  message: unknown;
}

/** 文件检查点恢复的结果（SDK 的 RewindFilesResult 用到的那几样） */
export interface ClaudeRewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
}

/** 撤回要用的 SDK 会话函数（真的入口给 @anthropic-ai/claude-agent-sdk 的 forkSession、getSessionMessages，测试给假的） */
export interface ClaudeSessionOps {
  /** 复制成一个新会话（换新 uuid、不带撤销历史），截到 upToMessageId（含）为止；交回新会话 id */
  fork(sessionId: string, upToMessageId: string): Promise<string>;
  /** 会话的主线（按 parentUuid 链重建，带系统消息） */
  messages(sessionId: string): Promise<ClaudeChainMessage[]>;
}

/** 撤回点：从哪个会话的哪一条（含）分叉；empty 是撤回到会话开头之前（新开一个空会话） */
export type ClaudeForkPoint = { session: string; anchor: string } | "empty";

/** 二狗记着的（会话记录的 lineage，见文件开头） */
export interface ClaudeLineage {
  /** 交给 Claude 的每条输入（二狗的输入 id）：推进了哪个 Claude 会话、二狗给那条用户消息定的 uuid、交的时候那个会话里上一条（知道时） */
  inputs: Record<string, { session: string; uuid: string; anchor?: string }>;
  /** 每个 Claude 会话：撤回时分叉出来的记着从哪分叉（origin），它自己的第一条输入的 uuid（first） */
  sessions: Record<string, { origin?: ClaudeForkPoint; first?: string }>;
  /** 还没交给模型的分支摘要（Claude 会话 id → 进上下文的那段） */
  notes: Record<string, string>;
}

export const emptyLineage = (): ClaudeLineage => ({ inputs: {}, sessions: {}, notes: {} });

/** 撤回要会话那一侧做的：现在是哪个会话、在某个会话上按检查点恢复文件、换成接着另一个会话 */
export interface NavigationHost {
  current(): string;
  readonly lineage: ClaudeLineage;
  readonly ops: ClaudeSessionOps | undefined;
  /** 把 session 的文件按检查点恢复到 uuid 那条用户消息时（现在的会话用活着的 query，别的临时起一个） */
  rewindIn(session: string, uuid: string): Promise<ClaudeRewindResult>;
  /** 换成接着 session（started：Claude 写过记录、按 id 恢复；false 是新开）：关掉手头的 query，记进会话记录 */
  switchTo(session: string, started: boolean): void;
  log(line: string): void;
}

/** 挪不了的原因（报回守护进程，会话没动） */
class NavigationError extends Error {}

/** 文件要恢复到哪：某条输入时（会话、uuid）、某个会话开始时（这条分支开始前）、不恢复（撤回到一次工具调用前后） */
type RewindPlan = { to: { session: string; uuid: string } } | { branchStart: string } | { skip: "call_point" };

/** 在 Claude 的会话之间挪（见文件开头）；结果以 session_navigated 交回 */
export async function navigateClaude(host: NavigationHost, command: NavigateCommand): Promise<SessionNavigatedReport> {
  const { requestId } = command;
  try {
    const from = host.current();
    if (command.marker.change === "switch") {
      if (!("entry" in command.target)) throw new NavigationError(t("runtime.navigate.noEntry", { entry: JSON.stringify(command.target) }));
      const to = command.target.entry;
      if (to === from) throw new NavigationError(t("runtime.navigate.alreadyHere"));
      // 撤回到会话开头之前新开、一句话都还没交过的空会话：Claude 那边还没有它的记录，照它的 id 新开
      const own = host.lineage.sessions[to];
      host.switchTo(to, !(own?.origin === "empty" && own.first === undefined));
      host.log(`切到废弃分支：接着 Claude 会话 ${to}（离开 ${from}）`);
      return { type: "session_navigated", requestId, ok: true, from, at: to };
    }
    // 分支摘要 Claude 自己不写（能力清单 branch_summary 是 false）：守护进程按理只交写好的
    if (command.summary && "instructions" in command.summary) throw new NavigationError(t("claudeCode.navigate.ownSummary"));
    if (!host.ops) throw new NavigationError(t("claudeCode.navigate.noOps"));
    const { at: point, rewind } = await forkPoint(host, command.target);
    // 先分叉（不动原来的会话；没分叉成什么都没变），再恢复文件（要原来的会话的检查点），最后换过去
    const to = point === "empty" ? randomUUID() : await host.ops.fork(point.session, point.anchor);
    const files = await rewindFiles(host, rewind);
    host.lineage.sessions[to] = { origin: point };
    if (command.summary && "written" in command.summary && command.summary.written.trim()) host.lineage.notes[to] = command.summary.written;
    host.switchTo(to, point !== "empty");
    host.log(`撤回：从 Claude 会话 ${from} ${point === "empty" ? "新开空会话" : `的 ${point.session} 截到 ${point.anchor} 分叉出`} ${to}；文件：${JSON.stringify(files)}`);
    return { type: "session_navigated", requestId, ok: true, from, at: to, files };
  } catch (err) {
    const error = err instanceof NavigationError ? err.message : t("runtime.navigate.failed", { message: err instanceof Error ? err.message : String(err) });
    return { type: "session_navigated", requestId, ok: false, error };
  }
}

/** 撤回点和文件要恢复到哪 */
async function forkPoint(host: NavigationHost, target: NavigateTarget): Promise<{ at: ClaudeForkPoint; rewind: RewindPlan }> {
  if ("beforeInput" in target) {
    const input = host.lineage.inputs[target.beforeInput];
    if (!input) throw new NavigationError(t("claudeCode.navigate.noInput"));
    return { at: await before(host, input.session, input.uuid, input.anchor), rewind: { to: { session: input.session, uuid: input.uuid } } };
  }
  if ("entry" in target) {
    const origin = host.lineage.sessions[target.entry]?.origin;
    if (origin === undefined) throw new NavigationError(t("runtime.navigate.noEntry", { entry: target.entry }));
    return { at: origin, rewind: { branchStart: target.entry } };
  }
  return { at: await aroundCall(host, "beforeCall" in target ? { before: target.beforeCall } : { after: target.afterCall }), rewind: { skip: "call_point" } };
}

/** 读一个会话的主线；读不了是 undefined（只记日志） */
async function chainOf(host: NavigationHost, session: string): Promise<ClaudeChainMessage[] | undefined> {
  try {
    return await host.ops!.messages(session);
  } catch (err) {
    host.log(`读 Claude 会话 ${session} 的主线出错：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** 某条输入（session 里 uuid 那条用户消息）之前：主线上它的前一条；它是第一条就是这个会话开始前；主线里找不到用交的时候记下的上一条 */
async function before(host: NavigationHost, session: string, uuid: string, recorded: string | undefined): Promise<ClaudeForkPoint> {
  const chain = await chainOf(host, session);
  const at = chain?.findIndex((m) => m.uuid === uuid) ?? -1;
  if (chain && at > 0) return { session, anchor: chain[at - 1]!.uuid };
  if (at === 0) return host.lineage.sessions[session]?.origin ?? "empty";
  if (recorded !== undefined) return { session, anchor: recorded };
  const own = host.lineage.sessions[session];
  if (own?.first === uuid && own.origin !== undefined) return own.origin;
  throw new NavigationError(t("claudeCode.navigate.notFound"));
}

/** 一条主线消息里的内容块 */
const blocksOf = (m: ClaudeChainMessage): Array<{ type?: string; id?: string; tool_use_id?: string }> => {
  const content = (m.message as { content?: unknown } | null | undefined)?.content;
  return Array.isArray(content) ? (content as Array<{ type?: string; id?: string; tool_use_id?: string }>) : [];
};
/** assistant 消息的模型回复 id（Claude 把一次回复的每个内容块各记一条，id 相同） */
const replyIdOf = (m: ClaudeChainMessage): string | undefined => (m.type === "assistant" ? (m.message as { id?: string } | null | undefined)?.id : undefined);
/** 只装着工具结果的用户消息 */
const onlyToolResults = (m: ClaudeChainMessage) => m.type === "user" && blocksOf(m).length > 0 && blocksOf(m).every((b) => b.type === "tool_result");

/**
 * 现在的会话里某次工具调用前后（152、153 号票的阶段、步骤开始）：before 回到含这次调用的那次回复之前（同一次回复的几条一起撤回，它说的话也撤回，
 * 同 pi）；after 回到这次回复后面连着的那几条工具结果的最后一条之后
 */
async function aroundCall(host: NavigationHost, call: { before: string } | { after: string }): Promise<ClaudeForkPoint> {
  const session = host.current();
  const chain = (await chainOf(host, session)) ?? [];
  const callId = "before" in call ? call.before : call.after;
  const at = chain.findIndex((m) => m.type === "assistant" && blocksOf(m).some((b) => b.type === "tool_use" && b.id === callId));
  if (at < 0) throw new NavigationError(t("runtime.navigate.noCall"));
  const reply = replyIdOf(chain[at]!);
  if ("before" in call) {
    let first = at;
    if (reply !== undefined) while (first > 0 && replyIdOf(chain[first - 1]!) === reply) first--;
    return first > 0 ? { session, anchor: chain[first - 1]!.uuid } : (host.lineage.sessions[session]?.origin ?? "empty");
  }
  let last = at;
  while (last + 1 < chain.length) {
    const next = chain[last + 1]!;
    if (!(reply !== undefined && replyIdOf(next) === reply) && !onlyToolResults(next)) break;
    last++;
  }
  return { session, anchor: chain[last]!.uuid };
}

/** 按检查点恢复文件（见文件开头）；出错只报原因（恢复了的照列） */
async function rewindFiles(host: NavigationHost, plan: RewindPlan): Promise<BranchFilesRewind> {
  if ("skip" in plan) return { restored: [], skipped: plan.skip };
  const restored = new Set<string>();
  try {
    for (const step of rewindSteps(host, plan)) {
      const result = await host.rewindIn(step.session, step.uuid);
      if (!result.canRewind) throw new Error(result.error ?? t("claudeCode.navigate.cannotRewind"));
      for (const file of result.filesChanged ?? []) restored.add(file);
    }
    return { restored: [...restored] };
  } catch (err) {
    return { restored: [...restored], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 一路往上恢复的那几步：现在的会话起，每个会话恢复到它自己的第一条输入，直到撤回点所在的会话（恢复到撤回点）或这条分支的会话 */
function rewindSteps(host: NavigationHost, plan: { to: { session: string; uuid: string } } | { branchStart: string }): Array<{ session: string; uuid: string }> {
  const stop = "to" in plan ? plan.to.session : plan.branchStart;
  const steps: Array<{ session: string; uuid: string }> = [];
  const seen = new Set<string>();
  for (let session = host.current(); !seen.has(session); ) {
    seen.add(session);
    const own = host.lineage.sessions[session];
    if (session === stop) {
      if ("to" in plan) steps.push({ session, uuid: plan.to.uuid });
      else if (own?.first !== undefined) steps.push({ session, uuid: own.first });
      return steps;
    }
    if (own?.first !== undefined) steps.push({ session, uuid: own.first });
    const origin = own?.origin;
    if (origin === undefined || origin === "empty") break;
    session = origin.session;
  }
  throw new Error(t("claudeCode.navigate.offPath"));
}
