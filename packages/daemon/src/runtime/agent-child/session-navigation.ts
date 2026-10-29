// 会话树上挪（150 号票：会话回退；151 号票：切换分支），子进程这一侧。做法同 pi 的 navigateTree
// （回退写分支摘要、切换不写），落到二狗的会话文件上有几处不一样，所以不直接调 navigateTree，用 pi 导出的
// 同一套零件拼（collectEntriesForBranchSummary、generateBranchSummary、SessionManager 的 branchWithSummary / branch，
// 最后 refreshContext 换掉内存里的上下文——navigateTree 自己也是这几步）：
// - 回到"某条输入之前"：叶子要落在这条输入的第一条条目的父条目上。一条输入在会话文件里是 [上下文块…][输入标记][用户消息]
//   （session.ts 的 prompt），navigateTree 按目标的种类决定叶子（用户消息、自定义消息取父条目，别的取它自己），前面那条是自定义消息
//   （换模型新开会话开头的交接摘要、上一轮没回复就被中止时跟着的上下文消息）、这条输入又没有上下文块时，没有哪个目标能让它落对；
// - pi 不写摘要的导航只在内存里挪叶子，进程一退、重开文件时叶子回到文件的最后一条（session-manager.js 的 _buildIndex）：挪完一律
//   追加一条记号（SESSION_BRANCH_ENTRY）落盘，叶子就停在新分支上（写了摘要的也追加，统一）；
// - 回到根节点（叶子是 null）pi 带 label 会出错：二狗的会话开头总有模型、思考档位这些条目，回不到根之前，
//   真遇上了报"回不到会话开头之前"；
// - 写摘要的那次模型调用照压缩的写法取凭据（compaction.ts），用量另报一条（purpose: branch_summary）。
// 调用前守护进程已经停稳回合（手头这一轮以 turn_end 结束）；这里再看一眼，还在跑（或者在压缩）就先中止、等它停下。
// 回到压缩之前：那一支上没有这条压缩摘要，下一轮可能马上又自动压缩（pi 照常处理，不在这里管）。
import {
  type AgentSession,
  collectEntriesForBranchSummary,
  generateBranchSummary,
  type ModelRuntime,
  type SessionEntry,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { t } from "@ergo/protocol";
import { type AgentReport, CONTEXT_BLOCK_TYPE, type HostCommand, isSessionType, SESSION_BRANCH_ENTRY, SESSION_INPUT_TAG, type SessionNavigatedReport } from "../host-protocol.ts";
import { usageReport } from "./event-translator.ts";

type NavigateCommand = Extract<HostCommand, { type: "navigate_session" }>;

/** 写分支摘要要的：模型目录和凭据、pi 的设置（重试、摘要的预算） */
export interface NavigationDeps {
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
}

/** 挪不了的原因（报回守护进程，会话没动） */
class NavigationError extends Error {}

/** pi 写进分支摘要条目的开头（generateBranchSummary 加的）：报给守护进程、给人看的那段不带它 */
const PI_SUMMARY_PREAMBLE = /^The user explored a different conversation branch before returning here\.\nSummary of that exploration:\n\n/;
/** pi 接在摘要后面的读过、改过的文件清单 */
const PI_FILE_LISTS = /\n\n<read-files>[\s\S]*$|\n\n<modified-files>[\s\S]*$/;

/** 分支摘要条目里给人看的那段：去掉 pi 加的开头和文件清单 */
export function summaryText(summary: string): string {
  return summary.replace(PI_SUMMARY_PREAMBLE, "").replace(PI_FILE_LISTS, "").trim();
}

/**
 * 在会话树上挪：回到某条输入之前（或者某一条），回退时给被放弃的那段写摘要，追加记号让叶子落盘，换掉内存里的上下文。
 * 结果（挪成了、没挪成）作为 session_navigated 交回；写摘要那次调用的用量另外 emit
 */
export async function navigateSession(session: AgentSession, command: NavigateCommand, deps: NavigationDeps, emit: (report: AgentReport) => void): Promise<SessionNavigatedReport> {
  try {
    if (!session.isIdle) {
      await session.abort();
      await session.waitForIdle();
    }
    const sm = session.sessionManager;
    const from = sm.getLeafId();
    if (from === null) throw new NavigationError(t("runtime.navigate.empty"));
    const at = targetLeaf(sm.getBranch(), command.target, (id) => sm.getEntry(id));
    if (at === from) throw new NavigationError(t("runtime.navigate.alreadyHere"));
    let summary: { text: string; stored: string; details: unknown; usage: unknown } | undefined;
    // pi 自己写分支摘要（能力清单 branch_summary）：守护进程交给它的只会是 instructions（写好的 written 是给不自己写的运行时的，293 号票）
    if (command.summary && "instructions" in command.summary) {
      const { entries } = collectEntriesForBranchSummary(sm, from, at);
      if (entries.length > 0) summary = await writeSummary(session, entries, command.summary.instructions, deps, command.requestId, emit);
    }
    if (summary) {
      const id = sm.branchWithSummary(at, summary.stored, summary.details, false, summary.usage as Parameters<typeof sm.branchWithSummary>[4]);
      // 给摘要条目挂的标签（pi 的 label，界面不用）
      sm.appendLabelChange(id, "用户回退"); // @i18n-ignore data：会话文件里的标签（界面不用）
    } else sm.branch(at);
    sm.appendCustomEntry(SESSION_BRANCH_ENTRY, command.marker);
    session.refreshContext();
    return { type: "session_navigated", requestId: command.requestId, ok: true, from, at, ...(summary ? { summary: summary.text } : {}) };
  } catch (err) {
    const error = err instanceof NavigationError ? err.message : t("runtime.navigate.failed", { message: err instanceof Error ? err.message : String(err) });
    return { type: "session_navigated", requestId: command.requestId, ok: false, error };
  }
}

/**
 * 新叶子：回到某条输入之前——在当前这一支上找到这条输入的标记，往前跳过紧挨着它的上下文块（同一条输入注入的），落在第一条的父条目上；
 * 或者会话文件里给定的那一条；152 号票起还有某次工具调用（beforeCall：它所在的那条 assistant 消息的父条目，即回退点那条
 * 条目的 parentId；afterCall：那条 assistant 消息后面紧跟着的最后一条工具结果，同一条回复里的几次调用都留着）
 */
function targetLeaf(branch: readonly SessionEntry[], target: NavigateCommand["target"], entry: (id: string) => SessionEntry | undefined): string {
  if ("entry" in target) {
    if (!entry(target.entry)) throw new NavigationError(t("runtime.navigate.noEntry", { entry: target.entry }));
    return target.entry;
  }
  if ("beforeCall" in target || "afterCall" in target) {
    const callId = "beforeCall" in target ? target.beforeCall : target.afterCall;
    const at = branch.findLastIndex((e) => e.type === "message" && e.message.role === "assistant" && e.message.content.some((c) => c.type === "toolCall" && c.id === callId));
    if (at < 0) throw new NavigationError(t("runtime.navigate.noCall"));
    if ("beforeCall" in target) {
      const parent = branch[at]!.parentId;
      if (parent === null) throw new NavigationError(t("runtime.navigate.beforeStart"));
      return parent;
    }
    let last = at;
    while (last + 1 < branch.length) {
      const next = branch[last + 1]!;
      if (next.type !== "message" || next.message.role !== "toolResult") break;
      last++;
    }
    return branch[last]!.id;
  }
  const tag = branch.findLastIndex((e) => e.type === "custom" && isSessionType(e.customType, SESSION_INPUT_TAG) && (e.data as { inputId?: unknown } | undefined)?.inputId === target.beforeInput);
  if (tag < 0) throw new NavigationError(t("runtime.navigate.noMessage"));
  let first = tag;
  while (first > 0) {
    const prev = branch[first - 1]!;
    if (prev.type !== "custom_message" || !isSessionType(prev.customType, CONTEXT_BLOCK_TYPE)) break;
    first--;
  }
  const parent = branch[first]!.parentId;
  if (parent === null) throw new NavigationError(t("runtime.navigate.beforeStart"));
  return parent;
}

/** 给被放弃的那段写分支摘要：同 pi 的 navigateTree（同一个函数、同一个模型调用函数），凭据照压缩的写法取 */
async function writeSummary(
  session: AgentSession,
  entries: SessionEntry[],
  instructions: string,
  deps: NavigationDeps,
  requestId: string,
  emit: (report: AgentReport) => void,
): Promise<{ text: string; stored: string; details: unknown; usage: unknown }> {
  const model = session.model;
  if (!model) throw new NavigationError(t("runtime.navigate.noModel"));
  const signal = new AbortController().signal;
  const auth = await deps.modelRuntime.getAuth(model, { signal });
  const requestModel = auth?.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
  const headers = auth?.auth.headers ? Object.fromEntries(Object.entries(auth.auth.headers).flatMap(([k, v]) => (v === null ? [] : [[k, v]]))) : undefined;
  const result = await generateBranchSummary(entries, {
    model: requestModel,
    ...(auth?.auth.apiKey === undefined ? {} : { apiKey: auth.auth.apiKey }),
    ...(headers === undefined ? {} : { headers }),
    ...(auth?.env === undefined ? {} : { env: auth.env }),
    signal,
    customInstructions: instructions,
    reserveTokens: deps.settingsManager.getBranchSummarySettings().reserveTokens,
    streamFn: session.agent.streamFunction,
    retry: deps.settingsManager.getRetrySettings(),
  });
  if (result.aborted) throw new NavigationError(t("runtime.navigate.summaryAborted"));
  if (result.error !== undefined) throw new NavigationError(t("runtime.navigate.summaryFailed", { error: result.error }));
  const stored = result.summary ?? "";
  if (result.usage) emit(usageReport(`branch-summary-${requestId}`, result.usage, { provider: model.provider, modelId: model.id }, "branch_summary"));
  return { text: summaryText(stored), stored, details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] }, usage: result.usage };
}
