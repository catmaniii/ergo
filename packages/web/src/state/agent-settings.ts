// 每个 agent 的会话里的 ⚙（114 号票）的状态层：秘书会话、任务整页、项目整页的标题栏上点开的面板。纯函数，界面（ui/agent-settings.tsx）只管画。
// - 单独的提示词两种写法：追加（接在通用模板后面，默认）、整份自己写（从通用模板复制一份来改）；边改边查，和守护进程同一个检查
//   （协议包的 agentPromptProblem，能用的占位符照这个 agent 的通用模板，和设置 · 系统提示一样）；
// - 清空当前对话：先确认（"清空后它不记得之前聊过什么，记录照样能看"）；项目维护者的清空就是重置维护者；
// - 上下文用量：现在用了多少 / 窗口多大（进度条）、上次压缩是什么时候、离自动压缩还有多少（pi 的规矩：用量超过窗口减 16384 自动压缩，
//   最近约 2 万 token 原样保留）；数都是守护进程从 token 账本里取的，这里只写成话。
import { type AgentClearKind, type AgentContextView, type AgentPromptMode, agentPromptProblem, type AgentSettingsView, normalizePromptSource, PI_COMPACTION_DEFAULTS } from "./protocol.ts";
import { systemPromptSpec } from "./system-prompts.ts";

/** 两种写法的名字和一句说明 */
export const AGENT_PROMPT_MODE_INFO: Readonly<Record<AgentPromptMode, { label: string; hint: string }>> = {
  append: { label: "在通用模板后面追加", hint: "接在通用模板后面的一段这个 agent 自己的话。通用模板以后改了，它跟着变，追加的照旧接在后面" },
  replace: { label: "整份自己写", hint: "从通用模板复制一份来改。这个 agent 用的是自己的一整份，通用模板改了不影响它" },
};

/** 清空当前对话怎么做、确认框里怎么说 */
export const AGENT_CLEAR_COPY: Readonly<Record<AgentClearKind, { button: string; title: string; body: string; done: string }>> = {
  new_session: {
    button: "清空当前对话",
    title: "清空当前对话？",
    body: "清空后它不记得之前聊过什么，记录照样能看（收在“更早的对话”里，往上翻就有）。正在做的事不会忘：任务的计划、当前阶段和进展照常给它。",
    done: "已清空：从下一句起是新的对话",
  },
  reset_maintainer: {
    button: "清空当前对话（重置维护者）",
    title: "重置维护者？",
    body: "会新开一段会话，维护者只凭项目档案（立项书、规格、术语表、进展）重建理解，不记得之前聊过什么。旧会话保留，往上翻照样能看；这个项目单独的提示词照旧用。",
    done: "已重置维护者：新的一段从项目档案开始",
  },
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
  if (problem !== undefined) return "自己写的那份有错，现在用的是通用模板";
  if (state === "template") return "用通用模板，没有单独的";
  if (state === "append") return "通用模板 + 追加的一段";
  return "整份自己写的（通用模板改了不影响它）";
}

/** token 数：一万以上写"8.2 万"（和任务卡、消耗页一样） */
export function tokensText(n: number): string {
  return n >= 10_000 ? `${Number((n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1))} 万` : String(n);
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
  const used =
    usedTokens !== undefined
      ? `${tokensText(usedTokens)}${window !== undefined ? ` / ${tokensText(window)}` : ""} token`
      : compactedAfter
        ? "刚压缩过，下一次调用模型后更新"
        : "这段对话还没调用过模型";
  const usage = window === undefined && usedTokens !== undefined ? `${used}（窗口多大要等它下次运行时报上来）` : used;
  const overLine = usedTokens !== undefined && autoCompactAt !== undefined && usedTokens > autoCompactAt;
  const rule = autoCompactAt !== undefined ? `用量超过 ${tokensText(autoCompactAt)} token 时自动压缩，最近约 ${tokensText(keep)} token 原样保留` : `用量快到窗口时自动压缩，最近约 ${tokensText(keep)} token 原样保留`;
  const autoCompact =
    usedTokens === undefined || autoCompactAt === undefined ? rule : overLine ? `已经过了自动压缩的线（${rule}），下一次调用前会自动压缩` : `离自动压缩还有 ${tokensText(autoCompactAt - usedTokens)} token（${rule}）`;
  const lastCompacted = context.lastCompactedAt === undefined ? "这段对话还没压缩过" : `上次压缩：${whenText(context.lastCompactedAt)}`;
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
  if (context.compaction === "waiting") return context.running ? "它正在说，说完这一条就压缩" : "先把它拉起来，再压缩";
  if (context.compaction === "running") return "正在压缩……";
  const last = context.lastCompact;
  if (!last) return undefined;
  const at = whenText(last.at);
  if (last.outcome === "done") return `压缩好了（${at}）`;
  if (last.outcome === "nothing") return `没什么可压的（${at}）：对话还短，最近约 ${tokensText(context.keepRecentTokens ?? PI_COMPACTION_DEFAULTS.keepRecentTokens)} token 本来就原样保留`;
  return `没压成（${at}）：${last.message ?? "出错了"}`;
}

/** 清空那一块的一句：在等它说完、上次清空（重置）的时间 */
export function agentClearText(view: AgentSettingsView): string | undefined {
  if (view.clear.pending) return "它正在说，说完这一条就清空";
  if (view.clear.lastAt === undefined) return undefined;
  return `${view.clear.how === "reset_maintainer" ? "上次重置" : "上次清空"}：${whenText(view.clear.lastAt)}`;
}

/** 面板开着时要不要过一会儿再取一次：在等清空、在等或正在压缩 */
export function agentSettingsBusy(view: AgentSettingsView): boolean {
  return view.clear.pending || view.context.compaction !== "idle";
}
