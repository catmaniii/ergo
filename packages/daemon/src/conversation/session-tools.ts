// 每个会话都配的代为执行的工具：装配用的一个对象（daemon.ts 建一次，交给秘书、任务的维护者、项目的维护者、定时作业的维护者、
// 子 agent 的装配；70 号票评审后定：不再把联网工具一样样穿过各模块的选项）。
// - 联网搜索、读网页（70 号票）：每个会话都配（评审子 agent 除外），联网开关关着时守卫拒绝；子 agent 从维护者收窄后也有。
//   162 号票起工具说明跟着设置里的队列写（停用了的方式不写，agent-browser 的位置写进去），所以每次装配现做（web(agent)：这个 agent
//   有没有 bash 决定提不提 agent-browser）；设置改了 onWebChange 通知，常驻的秘书手头这一条处理完按新的重新装配，别的 agent 下次唤起时就是新的；
//   182 号票：有 browse_* 工具的 agent（秘书）说明里另写"鸿蒙 App 的内置浏览器"的位置，web_search 按这一轮是不是侧边栏、悬浮按钮来的
//   判它用不用得了（212 号票起只在浏览插件运行时，组合根按插件的服务现判）；侧边栏、悬浮按钮那一轮交给秘书的输入后面加的那一句
//   212 号票起在浏览插件的输入附注里（它经内核的 KERNEL.webSearch 取这一句）；
// - 语音回复（32 号票）：口语总结工具，外加会话里的说明（用户发语音时）和追问（AgentSession 的 voiceReplies）；86 号票起还有
//   发语音工具（用户打字的那一轮也能发语音气泡，用不用得了调用时按这一轮看）。子 agent 不加（它不和用户说话）；没接语音回复时没有。
// - 214 号票起语音是插件（voice/）：语音回复由组合根按语音插件现取（插件停用了是 undefined），工具每次装配现取，会话里的说明、追问
//   每次现取（sessionVoice 交给会话的是转一手的）；输入队列的挡板（inputGate）也经这里，语音插件在运行时由它回答（208、210 号票的
//   规矩），不在时按内核的（input-gate.ts）；插件运行中停用、启用了（onVoiceChange）秘书手头这一条处理完按新的重新装配，
//   各会话再看一眼队首（还没识别完的语音不再挡、又照规矩挡）。
import type { MessageEnvelope } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { AgentSessionOptions, AgentVoiceReplies } from "./agent-session.ts";
import type { InputGate } from "./input-gate.ts";

/** 装配联网工具时要知道的这个 agent 的样子 */
export interface WebToolsAgent {
  /** 有 bash（才用得了 agent-browser，162 号票） */
  bash: boolean;
  /** 有 browse_* 工具（秘书，182 号票：才用得了鸿蒙 App 的内置浏览器，也只在侧边栏、悬浮按钮那一轮；212 号票起还要浏览插件在运行） */
  browse?: boolean;
}

export interface SessionTools {
  /** 联网搜索、读网页：按此刻的设置现做（162 号票） */
  web(agent: WebToolsAgent): readonly HostTool[];
  /** 联网设置改了（工具说明跟着变）时叫；回一个取消的函数。不给就不通知 */
  onWebChange?(listener: () => void): () => void;
  /** 语音回复；没接时没有（214 号票起按语音插件现取：插件没在运行时没有） */
  readonly voiceReplies?: AgentVoiceReplies | undefined;
  /** 输入队列的挡板（214 号票）：这条消息这时还要不要等，语音插件在运行时由它回答；回 undefined（插件不在）按内核的。不给就按内核的 */
  inputGate?(message: MessageEnvelope): InputGate | undefined;
  /** 语音插件运行中停用、启用了（214 号票）：语音回复、挡板跟着变；回取消的函数。不给就不通知 */
  onVoiceChange?(listener: () => void): () => void;
}

/** 和用户说话的会话（秘书、维护者的每一段、定时作业的每次运行）都有的工具：联网搜索、读网页，口语总结、发语音；不给就没有 */
export function conversationTools(tools: SessionTools | undefined, agent: WebToolsAgent): HostTool[] {
  return [...(tools?.web(agent) ?? []), ...(tools?.voiceReplies?.tools ?? [])];
}

/**
 * AgentSession 的语音那几个选项（214 号票）：语音回复（replies 为 true 的会话才接：用户会对它说话的）、输入队列的挡板、
 * 语音插件停用启用时再看一眼队首。语音回复每次现取（转一手：插件停用了就没有，启用回来是新的那一份）；没给 tools 就都没有
 */
export function sessionVoice(tools: SessionTools | undefined, replies: boolean): Pick<AgentSessionOptions, "voiceReplies" | "inputGate" | "onGateChange"> {
  if (!tools) return {};
  return {
    ...(replies
      ? {
          voiceReplies: {
            inputContext: (message) => tools.voiceReplies?.inputContext(message),
            followUp: (conversation, inputMessageId) => tools.voiceReplies?.followUp(conversation, inputMessageId),
            interruptedResults: (conversation) => tools.voiceReplies?.interruptedResults?.(conversation) ?? {},
          },
        }
      : {}),
    ...(tools.inputGate ? { inputGate: (message: MessageEnvelope) => tools.inputGate?.(message) } : {}),
    ...(tools.onVoiceChange ? { onGateChange: (listener: () => void) => tools.onVoiceChange!(listener) } : {}),
  };
}
