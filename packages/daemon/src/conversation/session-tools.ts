// 每个会话都配的代为执行的工具：装配用的一个对象（daemon.ts 建一次，交给秘书、任务的维护者、项目的维护者、定时作业的维护者、
// 子 agent 的装配；70 号票评审后定：不再把联网工具一样样穿过各模块的选项）。
// - 联网搜索、读网页（70 号票）：每个会话都配（评审子 agent 除外），联网开关关着时守卫拒绝；子 agent 从维护者收窄后也有；
// - 语音回复（32 号票）：口语总结工具，外加会话里的说明（用户发语音时）和追问（AgentSession 的 voiceReplies）。子 agent 不加
//   （它不和用户说话）；没接语音回复时没有。
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { AgentVoiceReplies } from "./agent-session.ts";

export interface SessionTools {
  /** 联网搜索、读网页 */
  readonly web: readonly HostTool[];
  /** 语音回复；没接时没有 */
  readonly voiceReplies?: AgentVoiceReplies | undefined;
}

/** 和用户说话的会话（秘书、维护者的每一段、定时作业的每次运行）都有的工具：联网搜索、读网页，口语总结；不给就没有 */
export function conversationTools(tools: SessionTools | undefined): HostTool[] {
  return [...(tools?.web ?? []), ...(tools?.voiceReplies ? [tools.voiceReplies.tool] : [])];
}

/** AgentSession 的 voiceReplies 选项：接了语音回复才有 */
export function sessionVoiceReplies(tools: SessionTools | undefined): { voiceReplies?: AgentVoiceReplies } {
  return tools?.voiceReplies ? { voiceReplies: tools.voiceReplies } : {};
}
