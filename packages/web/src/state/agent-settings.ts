// 每个 agent 的会话里的 ⚙的状态层：秘书会话、任务整页、项目整页的标题栏上点开的面板。纯函数，界面（ui/agent-settings.tsx）只管画。
// - 单独的提示词两种写法：追加（接在通用模板后面，默认）、整份自己写（从通用模板复制一份来改）；边改边查，和守护进程同一个检查
//   （协议包的 agentPromptProblem，能用的占位符照这个 agent 的通用模板，和设置 · 系统提示一样）；
// - 清空当前对话：先确认（"清空后它不记得之前聊过什么，记录照样能看"）；项目负责人的清空就是重置负责人；
// - 上下文用量：现在用了多少 / 窗口多大（进度条）、上次压缩是什么时候、离自动压缩还有多少（用量超过这个 agent 的自动压缩点就压缩，
//   最近约 2 万 token 原样保留）；数都是守护进程从 token 账本里取的，这里只写成话。
// - 自动压缩点（420）：跟随设置 · 模型里的默认还是单独设的、设的比这个模型的上限大时按上限算（写明为什么）、自己管压缩的运行时灰掉、
//   上次自动压缩没压成写什么时候再试；改的时候边改边查（和守护进程同一个函数 autoCompactProblem）。
import {
  type AgentClearKind,
  type AgentContextView,
  type AgentPromptMode,
  agentPromptProblem,
  type AgentSettingsView,
  autoCompactProblem,
  formatNumber,
  intlLocale,
  normalizePromptSource,
  PI_COMPACTION_DEFAULTS,
  t,
  tTable,
} from "./protocol.ts";
import { systemPromptSpec } from "./system-prompts.ts";

/** 两种写法的名字和一句说明 */
export const AGENT_PROMPT_MODE_INFO: Readonly<Record<AgentPromptMode, { label: string; hint: string }>> = {
  append: tTable({ label: "state.agentSettings.mode.append.label", hint: "state.agentSettings.mode.append.hint" }),
  replace: tTable({ label: "state.agentSettings.mode.replace.label", hint: "state.agentSettings.mode.replace.hint" }),
};

/** 清空当前对话怎么做、确认框里怎么说 */
export const AGENT_CLEAR_COPY: Readonly<Record<AgentClearKind, { button: string; title: string; body: string; done: string }>> = {
  new_session: tTable({
    button: "state.agentSettings.clear.newSession.button",
    title: "state.agentSettings.clear.newSession.title",
    body: "state.agentSettings.clear.newSession.body",
    done: "state.agentSettings.clear.newSession.done",
  }),
  reset_maintainer: tTable({
    button: "state.agentSettings.clear.resetMaintainer.button",
    title: "state.agentSettings.clear.resetMaintainer.title",
    body: "state.agentSettings.clear.resetMaintainer.body",
    done: "state.agentSettings.clear.resetMaintainer.done",
  }),
};

/** 打开某种写法时编辑框里的初始内容：正在用这种写法的就是它；整份自己写从通用模板复制一份；追加从空的开始 */
export function agentPromptDraft(view: AgentSettingsView, mode: AgentPromptMode): string {
  if (view.prompt.state === mode) return view.prompt.content;
  return mode === "replace" ? view.prompt.template.content : "";
}

/** 正在改的单独提示词：存不存得进去（不对时写明第几行错在哪）、和现在用的比改没改 */
export interface AgentPromptDraftCheck {
  readonly ok: boolean;
  readonly problem: string | undefined;
  readonly changed: boolean;
}

export function checkAgentPromptDraft(view: AgentSettingsView, mode: AgentPromptMode, draft: string): AgentPromptDraftCheck {
  const source = normalizePromptSource(draft);
  const current = view.prompt.state === mode ? normalizePromptSource(view.prompt.content) : undefined;
  // 追加的空着、现在也没有单独的：没有可存的
  const changed = current === undefined ? !(mode === "append" && source.trim() === "" && view.prompt.state === "template") : source !== current;
  const problem = agentPromptProblem(mode, source, systemPromptSpec(view.prompt.template), view.prompt.template.allowEmpty);
  return { ok: problem === undefined, problem, changed };
}

/** 单独的提示词那一节开头一句：现在用的是哪种 */
export function agentPromptStateText(view: AgentSettingsView): string {
  const { state, problem } = view.prompt;
  if (problem !== undefined) return t("state.agentSettings.promptState.broken");
  if (state === "template") return t("state.agentSettings.promptState.template");
  if (state === "append") return t("state.agentSettings.promptState.append");
  return t("state.agentSettings.promptState.replace");
}

/**
 * token 数：一万以上写"8.2 万"（和任务卡、消耗页一样）。按"万"数是中文的写法（语言文件里的 tokensWan），
 * 别的语言用 Intl 的紧凑写法（英文"82K""1.3M"）
 */
export function tokensText(n: number): string {
  if (n < 10_000) return String(n);
  if (intlLocale().startsWith("zh")) return t("state.agentSettings.tokensWan", { n: Number((n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)) });
  return formatNumber(n, { notation: "compact", maximumFractionDigits: 1 });
}

/** ISO 时间 → "10-13 14:02" */
const whenText = (iso: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
};

/** 上下文用量那一块写成的话 */
export interface AgentContextLines {
  /** "8.2 万 / 12.8 万 token"；还不知道的写说明 */
  readonly usage: string;
  /** 进度条：用了窗口的几成（0–1）；不知道时没有 */
  readonly ratio: number | undefined;
  /** 超过自动压缩的线了 */
  readonly overLine: boolean;
  /** 离自动压缩还有多少（和自动压缩的规矩） */
  readonly autoCompact: string;
  /** 上次压缩 */
  readonly lastCompacted: string;
  /** "现在压缩"这会儿的样子或上一次的结果；没有是 undefined */
  readonly compaction: string | undefined;
  /** "现在压缩"按钮能不能点、不能点为什么 */
  readonly canCompact: boolean;
  readonly cannotCompact: string | undefined;
}

export function agentContextLines(context: AgentContextView, readOnly: string | undefined): AgentContextLines {
  const { usedTokens, window, autoCompactAt } = context;
  const keep = context.keepRecentTokens ?? PI_COMPACTION_DEFAULTS.keepRecentTokens;
  const compactedAfter = context.lastCompactedAt !== undefined && (context.measuredAt === undefined || context.lastCompactedAt > context.measuredAt);
  // 最近一次调用的上下文里缓存命中的单写（"（其中缓存命中 8 万）"），说法照消耗页
  const cacheHit = context.cacheHitTokens !== undefined && context.cacheHitTokens > 0 ? t("state.agentSettings.context.cacheHit", { hit: tokensText(context.cacheHitTokens) }) : "";
  const used =
    usedTokens !== undefined
      ? `${tokensText(usedTokens)}${window !== undefined ? ` / ${tokensText(window)}` : ""} token${cacheHit}`
      : compactedAfter
        ? t("state.agentSettings.context.justCompacted")
        : t("state.agentSettings.context.noCalls");
  const usage = window === undefined && usedTokens !== undefined ? t("state.agentSettings.context.windowUnknown", { used }) : used;
  const overLine = usedTokens !== undefined && autoCompactAt !== undefined && usedTokens > autoCompactAt;
  const rule =
    autoCompactAt !== undefined
      ? t("state.agentSettings.context.ruleAt", { at: tokensText(autoCompactAt), keep: tokensText(keep) })
      : t("state.agentSettings.context.ruleNearWindow", { keep: tokensText(keep) });
  const autoCompact =
    usedTokens === undefined || autoCompactAt === undefined
      ? rule
      : overLine
        ? t("state.agentSettings.context.overLine", { rule })
        : t("state.agentSettings.context.left", { left: tokensText(autoCompactAt - usedTokens), rule });
  const lastCompacted = context.lastCompactedAt === undefined ? t("state.agentSettings.context.neverCompacted") : t("state.agentSettings.context.lastCompacted", { at: whenText(context.lastCompactedAt) });
  const cannotCompact = readOnly ?? context.cannotCompact;
  return {
    usage,
    ratio: usedTokens !== undefined && window ? Math.min(1, usedTokens / window) : undefined,
    overLine,
    autoCompact,
    lastCompacted,
    compaction: compactionText(context),
    canCompact: cannotCompact === undefined && context.compaction === "idle",
    cannotCompact,
  };
}

/** "现在压缩"这会儿：等它说完、正在压；不在压时说上一次手动压缩的结果 */
function compactionText(context: AgentContextView): string | undefined {
  if (context.compaction === "waiting") return context.running ? t("state.agentSettings.compaction.waitTurn") : t("state.agentSettings.compaction.waitStart");
  if (context.compaction === "running") return t("state.agentSettings.compaction.running");
  const last = context.lastCompact;
  if (!last) return undefined;
  const at = whenText(last.at);
  if (last.outcome === "done") return t("state.agentSettings.compaction.done", { at });
  if (last.outcome === "nothing") return t("state.agentSettings.compaction.nothing", { at, keep: tokensText(context.keepRecentTokens ?? PI_COMPACTION_DEFAULTS.keepRecentTokens) });
  return t("state.agentSettings.compaction.failed", { at, message: last.message ?? t("state.agentSettings.compaction.error") });
}

/** 清空那一块的一句：在等它说完、上次清空（重置）的时间 */
export function agentClearText(view: AgentSettingsView): string | undefined {
  if (view.clear.pending) return t("state.agentSettings.clear.pending");
  if (view.clear.lastAt === undefined) return undefined;
  const at = whenText(view.clear.lastAt);
  return view.clear.how === "reset_maintainer" ? t("state.agentSettings.clear.lastReset", { at }) : t("state.agentSettings.clear.lastCleared", { at });
}

/** ⚙ 里"自动压缩点"那一小块写成的话（420） */
export interface AgentAutoCompactLines {
  /** 输入框里的初始值：单独设的，跟随默认时是默认值 */
  readonly value: number;
  /** 现在用的、从哪来 */
  readonly source: string;
  /** 设的比这个模型的上限大：按上限算了，为什么 */
  readonly clamped: string | undefined;
  /** 自己管压缩的运行时（Claude Code、Codex）：这一项不起作用 */
  readonly managed: string | undefined;
  /** 上次自动压缩没压成：什么时候、为什么、什么时候再试 */
  readonly failed: string | undefined;
  /** 能改（只读的、自己管压缩的不能） */
  readonly canEdit: boolean;
  /** 能恢复默认（单独设过才能） */
  readonly canReset: boolean;
}

export function agentAutoCompactLines(view: AgentSettingsView): AgentAutoCompactLines | undefined {
  const auto = view.context.autoCompact;
  if (!auto) return undefined;
  const configured = auto.own ?? auto.defaultAt;
  const source =
    auto.own === undefined
      ? t("state.agentSettings.autoCompact.followDefault", { at: tokensText(auto.defaultAt) })
      : t("state.agentSettings.autoCompact.own", { at: tokensText(auto.own), default: tokensText(auto.defaultAt) });
  const window = view.context.window;
  const clamped =
    auto.clamped && auto.limit !== undefined && window !== undefined
      ? t("state.agentSettings.autoCompact.clamped", { set: tokensText(configured), limit: tokensText(auto.limit), window: tokensText(window), reserve: window - auto.limit })
      : undefined;
  const managed = auto.managedBy === undefined ? undefined : t("state.agentSettings.autoCompact.managed", { runtime: auto.managedBy });
  const last = auto.last;
  const failed =
    last?.outcome === "failed"
      ? t(auto.retryAt === undefined ? "state.agentSettings.autoCompact.failed" : "state.agentSettings.autoCompact.failedRetry", {
          at: whenText(last.at),
          message: last.message ?? t("state.agentSettings.compaction.error"),
          retry: auto.retryAt === undefined ? "" : whenText(auto.retryAt),
        })
      : undefined;
  const canEdit = view.readOnly === undefined && managed === undefined;
  return { value: configured, source, clamped, managed, failed, canEdit, canReset: canEdit && auto.own !== undefined };
}

/** 正在改的压缩点：能不能存（不对时写为什么）、和现在设的比改没改 */
export interface AutoCompactDraftCheck {
  readonly at: number | undefined;
  readonly problem: string | undefined;
  readonly changed: boolean;
}

/**
 * 查正在改的压缩点（⚙、设置 · 模型共用）：认整数（可以带空格、千分位的逗号），范围照守护进程同一个函数查；
 * limit / window 给了（⚙ 里这个 agent 的模型窗口知道时）还不能超过这个模型的上限
 */
export function checkAutoCompactDraft(draft: string, current: number, model?: { window: number; limit: number }): AutoCompactDraftCheck {
  // 空白、千分位的逗号（半角、全角 U+FF0C）、下划线都去掉
  const cleaned = draft.replace(/[\s,_\uFF0C]/g, "");
  const at = /^\d+$/.test(cleaned) ? Number(cleaned) : undefined;
  if (at === undefined) return { at, problem: t("protocol.autoCompact.notInteger"), changed: cleaned !== "" };
  const problem = autoCompactProblem(at, model ? { window: model.window, reserveTokens: model.window - model.limit } : undefined);
  return { at, problem, changed: at !== current };
}

/** 面板开着时要不要过一会儿再取一次：在等清空、在等或正在压缩 */
export function agentSettingsBusy(view: AgentSettingsView): boolean {
  return view.clear.pending || view.context.compaction !== "idle";
}
