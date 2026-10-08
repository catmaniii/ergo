// 子 agent 并行（20 号票）给人和模型看的话，都在这里组织（编排在 sub-agents.ts，只给结构化的数据）：
// 一个子 agent 的一行说法、并行确认卡的纯文本降级、提议的工具结果、用户决定后交给维护者的通知、交给子 agent 的工作说明、
// 子 agent 交回维护者的结果、子 agent 的调用事后才被批准或拒绝时给维护者的通知、工具包变了重新装配时给子 agent 的说明。
import type { GrantInfo, ParallelAgent, ParallelCardPayload, Plan, Task } from "@ergou/protocol";
import type { ApprovalDecision } from "../guard-runtime/events.ts";
import { TOOL } from "../guard/index.ts";
import { authorizationSection, stageAuthorization, stageBrief, toolkitText } from "../tasks/context-block.ts";
import { EXECUTION_TOOL } from "../tasks/tool-names.ts";
import type { ShellToolkit } from "../typed-shell/index.ts";
import type { SubAgentOutcome } from "./events.ts";

type AgentRef = Pick<ParallelAgent, "agentId" | "stageId" | "stageTitle" | "step">;

/** 一个子 agent 的一行说法："sa-1 做阶段 s1「做 a.txt」的「第一步」"（卡片、素材、工具结果、通知共用） */
export function subAgentLine(a: AgentRef): string {
  return `${a.agentId} 做阶段 ${a.stageId}「${a.stageTitle}」${a.step ? `的「${a.step}」` : ""}`;
}

/** 审批卡、"交给我做"事项上子 agent 的调用写的来源 */
export function subAgentSource(taskTitle: string, stageId: string, agentId: string): string {
  return `任务「${taskTitle}」阶段 ${stageId} 的子 agent ${agentId}`;
}

/** 并行确认卡的纯文本降级：任务、派几个子 agent、各做什么 */
export function parallelCardText(p: ParallelCardPayload): string {
  return `并行确认：任务「${p.taskTitle}」想派 ${p.agents.length} 个子 agent 同时做（${p.reason}）。${p.agents.map((a) => `${subAgentLine(a)}：${a.instructions}`).join("；")}`;
}

/** 提议之后给维护者的工具结果 */
export function proposeResultText(r: { proposalId: string; agents: readonly ParallelAgent[] }): string {
  return [
    `并行确认卡已放进用户的待我处理（${r.proposalId}）：派 ${r.agents.length} 个子 agent——`,
    ...r.agents.map((a) => `- ${subAgentLine(a)}（目录 ${a.workDir}）`),
    "用户确认之前不会拉起子 agent：照常一件一件做，不要等。用户同意或不同意时你会收到通知。",
  ].join("\n");
}

/** 用户同意并行后交给维护者的通知 */
export function confirmedNotice(p: ParallelCardPayload, said: string | undefined): string {
  const own = p.agents.some((a) => a.ownWorkDir);
  return [
    `用户同意了并行（${p.proposalId}）：运行时拉起了 ${p.agents.length} 个子 agent——`,
    ...p.agents.map((a) => `- ${subAgentLine(a)}：在 ${a.workDir}`),
    "这几部分由子 agent 去做，你不要重复做；它们做完后结果会作为消息交回你。有子 agent 在做的阶段不能宣布完成、不能切过去。",
    own
      ? `它们在各自的目录里提交在各自的分支上；结果回来后用 ${EXECUTION_TOOL.startStage} 切到那个阶段，用 ${TOOL.git_merge} 把分支合并回工作目录，再调用 ${EXECUTION_TOOL.completeStage} 宣布完成。`
      : `结果回来后用 ${EXECUTION_TOOL.startStage} 切到那个阶段，核对一遍，再调用 ${EXECUTION_TOOL.completeStage} 宣布完成。`,
    ...(said ? [`用户附的话：「${said}」`] : []),
  ].join("\n");
}

/** 用户不同意并行后交给维护者的通知 */
export function declinedNotice(p: ParallelCardPayload, said: string | undefined): string {
  return `用户没同意并行（${p.proposalId}）${said ? `：「${said}」` : ""}。照常一件一件做：一个阶段做完调用 ${EXECUTION_TOOL.completeStage}，再做下一个。`;
}

/** 交给子 agent 的第一条输入：它做什么、在哪做、这个阶段的交付件和验收标准、授权和时序规则、边界 */
export function workText(input: { task: Pick<Task, "id" | "title">; agent: ParallelAgent; plan: Plan | undefined; grantInfo: Readonly<Record<string, GrantInfo>>; toolkit: ShellToolkit }): string {
  const { task, agent, plan } = input;
  const boundary = [
    `- 工作目录 ${agent.workDir}：只在这里改动${agent.ownWorkDir ? "（维护者为你建的目录，开发类是 git worktree：改完在这里提交）" : "（和维护者共用）"}；项目档案不能写；` +
      `工具包和维护者一样：${toolkitText(input.toolkit)}`,
    `- 授权项只在阶段 ${agent.stageId} 内有效；“先问我”类的操作执行时照样问用户`,
  ];
  return [
    `你是子 agent ${agent.agentId}：替任务 ${task.id}「${task.title}」做阶段 ${agent.stageId}「${agent.stageTitle}」${agent.step ? `里的「${agent.step}」这一步` : ""}。`,
    "维护者给你的工作说明：",
    agent.instructions,
    `阶段 ${agent.stageId} 的交付件和验收标准（验收由维护者交给运行时做，你只管做好你这部分）：`,
    ...(plan ? stageBrief(plan, agent.stageId) : []),
    ...(plan ? authorizationSection(stageAuthorization(plan, agent.stageId, input.grantInfo), boundary) : boundary),
    "做完用一段话交回结果：做了什么、改了哪些文件、提交号（有的话）、没做完的和原因。",
  ].join("\n");
}

/** 子 agent 随任务停下的原因 */
export const STOPPED_BY: Readonly<Record<"paused" | "ended", string>> = { paused: "任务暂停了", ended: "任务结束了" };

/**
 * 子 agent 被打断、随任务停下时还在执行的有副作用的调用（23 号票：说不清做没做完，已经放进待我处理等用户确认）：
 * 交回维护者的说明里写明，免得维护者接手时把它重做一遍
 */
function uncertainText(uncertain: readonly string[]): string {
  if (uncertain.length === 0) return "";
  return `它停下时正在执行的${uncertain.join("、")}说不清做没做完，已经放进待我处理请用户确认：用户告诉你之前不要重做，也不要换个写法再做一遍。`;
}

/**
 * 子 agent 交回维护者的那条消息：做完了交回的话，出错、被打断、随任务停下的说明。
 * uncertain：被打断、随任务停下时还在执行的有副作用的调用的摘要（23 号票）
 */
export function resultText(agent: ParallelAgent, outcome: SubAgentOutcome, reply: string, detail?: string, uncertain: readonly string[] = []): string {
  const name = `子 agent ${subAgentLine(agent)}`;
  const said = reply.trim();
  switch (outcome) {
    case "done":
      return [`${name}，做完了，交回的结果：`, said || "（它没说什么）", ...(agent.ownWorkDir ? [`它的改动在 ${agent.workDir}，要你用 ${TOOL.git_merge} 合并回工作目录。`] : [])].join("\n");
    case "error":
      return [`${name}，出错了：${detail ?? "原因不明"}`, ...(said ? ["它交回的话：", said] : [])].join("\n");
    case "interrupted":
      return `${name}，被打断了（${detail ?? "守护进程重启"}），没有结果。${uncertainText(uncertain)}${uncertain.length > 0 ? "其余的" : ""}需要的话自己接着做，或者再提议并行。`;
    case "stopped":
      return `${detail ?? STOPPED_BY.ended}，${name}，随之停下，没做完。${uncertainText(uncertain)}${said ? `\n它停下前说的：${said}` : ""}`;
  }
}

/**
 * 子 agent 的调用等审批超时挂起后，用户事后才批准或拒绝：通知进的是维护者的会话（子 agent 收不到）。
 * 批准的这次一次性授权只认子 agent 自己的调用指纹，维护者原样重试对不上，所以写明用不上了、要做就自己在那个阶段里重新调用（会再问一次）
 */
export function lateDecisionText(input: { what: string; agentId: string; stageId: string | null; decision: ApprovalDecision; note?: string; ended: boolean }): string {
  const where = input.stageId ? `在阶段 ${input.stageId} ` : "";
  const whose = `${input.what}是子 agent ${input.agentId} ${where}的调用`;
  if (input.decision === "denied") return `${whose}，已被用户拒绝${input.note ? `：${input.note}` : ""}。不要换个写法绕过；需要的话问问用户怎么办。`;
  const again = `还要做的话请${input.stageId ? `在阶段 ${input.stageId} 里` : ""}自己重新调用，会再问一次用户。`;
  if (input.ended) return `${whose}，用户事后批准了；子 agent 已结束，这次批准用不上了。${again}`;
  return `${whose}，用户事后批准了；子 agent 还在做，但收不到这条通知（它自己原样重试才放行一次）。它交回的结果里这一步没做成的话，${again}`;
}

/** 工具包变了、按新的装配重新拉起之后交给子 agent 的说明 */
export function reassembledText(before: { piTools: readonly string[]; hostTools: readonly string[]; toolkit: ShellToolkit }, after: typeof before): string {
  const list = (x: typeof before) => [...x.piTools, ...x.hostTools].join("、") || "（没有）";
  return [
    `工具包已变更（维护者的工具包或授权收窄了）：之前 ${toolkitText(before.toolkit)}，工具 ${list(before)}；现在 ${toolkitText(after.toolkit)}，工具 ${list(after)}。`,
    "刚才那一步被中止了。用现在的工具接着做完原来的工作；做不了的写进交回的结果里。",
  ].join("\n");
}
