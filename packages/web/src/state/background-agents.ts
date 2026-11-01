// 负责人背后的 agent（368 号票，纯函数）：并行派出去的子 agent、评审子 agent。数据从 HTTP 现取（协议包的 BackgroundAgentRow、BackgroundAgentTranscript），
// 有变化时背后的 agent 频道上来一条临时事件，ui-state 记下版本号（backgroundAgents），开着的列表、只读对话据此重新取。
// 这里只管说成人话：标题栏入口上写什么、一行上写什么、现在在做哪一步、用了多久。
import { callSentence } from "./call-sentence.ts";
import { activityDetailText, type ActivityState, type BackgroundAgentRow, type BackgroundAgentState, t, tTable } from "./protocol.ts";
import type { AgentActivity, UiState } from "./ui-state.ts";

export const BACKGROUND_AGENT_STATE_LABEL: Readonly<Record<BackgroundAgentState, string>> = tTable({
  running: "state.backgroundAgents.state.running",
  done: "state.backgroundAgents.state.done",
  failed: "state.backgroundAgents.state.failed",
  stopped: "state.backgroundAgents.state.stopped",
});

/** 这个负责人背后的 agent 现在的版本（来一条临时事件加一）：页面拿它当"该重新取了" */
export function backgroundAgentsVersion(state: UiState, maintainerId: string): number {
  return state.backgroundAgents[maintainerId] ?? 0;
}

/**
 * 标题栏上的入口：从来没有过就不显示（undefined）；有运行中的写"背后有 3 个 agent 在干活"，没有运行中的也能点开看已完成的。
 * count 是手机上那个小标上的数（运行中的个数，没有运行中的写总数）
 */
export function backgroundAgentsEntry(rows: readonly BackgroundAgentRow[]): { running: number; count: number; label: string } | undefined {
  if (rows.length === 0) return undefined;
  const running = rows.filter((r) => r.state === "running").length;
  return running > 0
    ? { running, count: running, label: t("state.backgroundAgents.entryRunning", { count: running }) }
    : { running: 0, count: rows.length, label: t("state.backgroundAgents.entryDone", { count: rows.length }) };
}

/** 一行的名字：子 agent 写编号（sa-1），评审写"评审" */
export function backgroundAgentName(row: Pick<BackgroundAgentRow, "agentId" | "kind">): string {
  return row.kind === "reviewer" ? t("state.backgroundAgents.reviewer") : row.agentId;
}

/** 派去做什么（一句话）：工作说明的第一行；评审写它在验收哪个阶段；老的评审只知道阶段编号 */
export function backgroundAgentPurpose(row: Pick<BackgroundAgentRow, "kind" | "brief" | "stageId" | "stageTitle">): string {
  if (row.brief) return row.brief;
  if (row.kind === "reviewer") return row.stageTitle ? t("state.backgroundAgents.reviewPurpose", { stage: row.stageTitle }) : t("state.backgroundAgents.reviewPurposeBare", { stage: row.stageId ?? "" });
  return t("state.backgroundAgents.noBrief");
}

/** 哪个阶段（定步阶段还写哪一步）；不在阶段里的没有 */
export function backgroundAgentStage(row: Pick<BackgroundAgentRow, "stageId" | "stageTitle" | "step">): string | undefined {
  if (row.stageId === undefined) return undefined;
  const stage = row.stageTitle ? t("state.backgroundAgents.stage", { id: row.stageId, title: row.stageTitle }) : t("state.backgroundAgents.stageBare", { id: row.stageId });
  return row.step ? t("state.backgroundAgents.stageStep", { stage, step: row.step }) : stage;
}

/**
 * 现在在做哪一步（运行中的才有）：活动状态说得出来的（排队、等你批准、调用某个工具、写回复）照它说，正在想、活动状态没说的写最近一次工具调用。
 * activity 是这个 agent 现在的活动状态（活动频道上的，比重新取的列表来得快）
 */
export function backgroundAgentDoing(row: Pick<BackgroundAgentRow, "state" | "lastStep">, activity: AgentActivity): string | undefined {
  if (row.state !== "running") return undefined;
  if (activity.state === "queued") return t("state.backgroundAgents.queued");
  const said = activity.detail ? activityDetailText(activity.detail) : "";
  if (said && (activity.state === "working" || activity.state === "waiting_for_user")) return said;
  return row.lastStep ? callSentence({ tool: row.lastStep.tool, argsSummary: row.lastStep.argsSummary }).text : undefined;
}

/** 活动状态的颜色（一行上那个小圆点）跟着 ActivityDot：运行中的这个 agent 是不是在等你 */
export function backgroundAgentWaiting(state: ActivityState): boolean {
  return state === "waiting_for_user";
}

/** 用了多久：结束了的按结束时间，运行中的按现在。"12 秒""3 分 12 秒""1 小时 5 分" */
export function backgroundAgentDuration(row: Pick<BackgroundAgentRow, "startedAt" | "endedAt">, nowMs: number): string | undefined {
  if (row.startedAt === undefined) return undefined;
  const from = Date.parse(row.startedAt);
  const to = row.endedAt === undefined ? nowMs : Date.parse(row.endedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return t("state.backgroundAgents.seconds", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("state.backgroundAgents.minutes", { m: minutes, s: seconds % 60 });
  return t("state.backgroundAgents.hours", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** 工具调用的结局说成一句（只读对话里那一行）：做了的不写，被拦下的、你拒绝了的、出错的写出来 */
export function backgroundCallIssue(outcome: string): string | undefined {
  switch (outcome) {
    case "blocked":
      return t("state.backgroundAgents.call.blocked");
    case "denied":
      return t("state.backgroundAgents.call.denied");
    case "error":
      return t("state.backgroundAgents.call.error");
    default:
      return undefined;
  }
}
