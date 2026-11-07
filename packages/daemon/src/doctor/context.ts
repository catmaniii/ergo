// 体检"二狗本身"里的"对话长度"（410）：秘书和现在活着的负责人、任务 agent 各自的上下文用量。
// 读的是会话 ⚙ 那一份（agentSettings.view(id).context）：用了多少 token（这段会话里最近一次干活的调用，压缩之后还没调用过的没有）、
// 模型的窗口、它自己的自动压缩点（autoCompactAt；420 让这个点可设，这里只读）、上一次自动压缩的结果（lastAutoCompact，410 补记的）。
// 不自己算、不连模型。Claude Code、Codex 跑的 agent 不查（它们自己管压缩）。
// 判法（用户 11-07 定）：
// - 用到模型窗口的九成 → 坏了（再长就聊不下去了）；
// - 超过它自己的自动压缩点还没压下去，或者上次自动压缩没压成（之后也没压成过）→ 注意；
// - 别的正常（写用得最多的那个）；一个都没有用量 → 正常（写"还没有用量"）。
// 一项里只放一个动作：给最该压的那个 agent 一个"现在压缩"（它压得了的话）；别的有问题的 agent 在事实里点名。
// 纯函数：交回结果（DoctorFinding），数字先按当前语言写好放进参数，句子由 doctor.ts 拼。
import { type AgentSettingsView, type DoctorMessage, fillAssistantName, formatList, formatNumber, PI_RUNTIME_ID, t } from "@ergo/protocol";
import { doctorTime } from "./auto.ts";
import type { DoctorFinding } from "./checks.ts";

/** 用到窗口的几成算坏了 */
export const CONTEXT_FULL_RATIO = 0.9;

/** 一个 agent 的上下文（只用到 ⚙ 那一份里的这几样） */
export type ContextAgentView = Pick<AgentSettingsView, "agentId" | "label" | "context"> & { runtime?: Pick<NonNullable<AgentSettingsView["runtime"]>, "id"> };

/** token 数写成"93.5 万"（中文）、"935K"（英文） */
export function doctorTokens(n: number): string {
  const unit = Number(t("doctor.tokens.unit")) || 10_000;
  return t("doctor.tokens.n", { n: formatNumber(n / unit, { maximumFractionDigits: 1 }) });
}

type Verdict = { level: "ok" | "warn" | "error"; agent: ContextAgentView; name: string; ratio: number; why: "full" | "over" | "autoFailed" | "fine" };

/** 上次自动压缩没压成，而且之后没压成过（压缩时间在它之后的不算） */
function autoFailed(context: AgentSettingsView["context"]): boolean {
  const auto = context.lastAutoCompact;
  if (auto?.outcome !== "failed") return false;
  return context.lastCompactedAt === undefined || Date.parse(context.lastCompactedAt) <= Date.parse(auto.at);
}

function judgeOne(agent: ContextAgentView, name: string): Verdict | undefined {
  const { usedTokens: used, window, autoCompactAt } = agent.context;
  const ratio = used !== undefined && window !== undefined && window > 0 ? used / window : 0;
  if (used !== undefined && window !== undefined && window > 0 && used >= CONTEXT_FULL_RATIO * window) return { level: "error", agent, name, ratio, why: "full" };
  if (used !== undefined && autoCompactAt !== undefined && used > autoCompactAt) return { level: "warn", agent, name, ratio, why: "over" };
  if (autoFailed(agent.context)) return { level: "warn", agent, name, ratio, why: "autoFailed" };
  if (used === undefined) return undefined;
  return { level: "ok", agent, name, ratio, why: "fine" };
}

const RANK = { error: 2, warn: 1, ok: 0 } as const;

/** 不知道的数写问号 */
const tokens = (n: number | undefined) => (n === undefined ? "?" : doctorTokens(n));

/** 一个 agent 的那句事实 */
function factOf(v: Verdict): DoctorMessage {
  const { usedTokens: used, window, autoCompactAt } = v.agent.context;
  switch (v.why) {
    case "full":
      return { key: "doctor.context.full", params: { name: v.name, used: tokens(used), window: tokens(window), percent: Math.round(v.ratio * 100) } };
    case "over":
      return { key: "doctor.context.over", params: { name: v.name, used: tokens(used), at: tokens(autoCompactAt), window: tokens(window) } };
    case "autoFailed": {
      const auto = v.agent.context.lastAutoCompact!;
      const message = auto.message ?? "?";
      return used === undefined
        ? { key: "doctor.context.autoFailedNoUse", params: { name: v.name, time: doctorTime(auto.at), message } }
        : { key: "doctor.context.autoFailed", params: { name: v.name, time: doctorTime(auto.at), message, used: tokens(used) } };
    }
    default:
      return { key: "doctor.context.fine", params: { name: v.name, used: tokens(used), at: tokens(autoCompactAt) } };
  }
}

/**
 * 判一次：agents 是要看的那几个（秘书在前），name 是用户给秘书起的名字（秘书的 label 是名字占位）。
 * 不是 pi 跑的、没有用量也没有压缩出错的不算
 */
export function judgeContext(agents: readonly ContextAgentView[], name: string): DoctorFinding {
  const verdicts = agents
    .filter((agent) => (agent.runtime?.id ?? PI_RUNTIME_ID) === PI_RUNTIME_ID)
    .flatMap((agent) => judgeOne(agent, fillAssistantName(agent.label, name)) ?? []);
  if (verdicts.length === 0) return { level: "ok", fact: { key: "doctor.context.none" } };
  const sorted = verdicts.toSorted((a, b) => RANK[b.level] - RANK[a.level] || b.ratio - a.ratio);
  const worst = sorted[0]!;
  if (worst.level === "ok") return { level: "ok", fact: factOf(worst) };
  const others = sorted.slice(1).filter((v) => v.level !== "ok");
  const base = factOf(worst);
  const fact: DoctorMessage = others.length === 0 ? base : { key: "doctor.context.others", params: { base: t(base.key, base.params), names: formatList(others.map((v) => v.name)) } };
  const canCompact = worst.agent.context.cannotCompact === undefined;
  return {
    level: worst.level,
    fact,
    fix: { key: worst.level === "error" ? "doctor.fix.contextFull" : "doctor.fix.context" },
    ...(worst.why === "autoFailed" ? { since: worst.agent.context.lastAutoCompact!.at } : {}),
    ...(canCompact ? { action: { kind: "compact" as const, agentId: worst.agent.agentId } } : {}),
  };
}
