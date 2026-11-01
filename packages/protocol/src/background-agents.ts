// 负责人背后的 agent（"应该可以有地方实时查看背后有哪几个 agent 在运行，在做什么，进展如何。已经完成的 subagent 的
// 对话历史可以查看，但无法再唤起"）：并行派出去的子 agent（sa-<n>）、评审子 agent（review-…）。
// 列表和只读对话都走 HTTP 现取（HTTP_PATHS.agentBackground、agentTranscript：守护进程从事件和账本现算，老数据有什么算什么）；
// 有变化时背后的 agent 频道上推一条临时事件 background_agents，开着的页面重新取。只有类型和常量，不引用 TypeBox。

/** 哪种：并行派出去的子 agent、验收时的评审 */
export const BACKGROUND_AGENT_KINDS = ["sub_agent", "reviewer"] as const;
export type BackgroundAgentKind = (typeof BACKGROUND_AGENT_KINDS)[number];

/**
 * 现在怎样：运行中（含名额满了在排队的）、做完了、失败（这一轮出错、评审没交结论）、被停了（随任务暂停或结束、守护进程重启、子进程意外退出）
 */
export const BACKGROUND_AGENT_STATES = ["running", "done", "failed", "stopped"] as const;
export type BackgroundAgentState = (typeof BACKGROUND_AGENT_STATES)[number];

/** 最近一次工具调用（列表上"现在在做哪一步"）：工具名和参数摘要，写法和工具调用记录一样，网页照它说成人话 */
export interface BackgroundAgentStep {
  tool: string;
  argsSummary: string;
  at: string;
}

/** 列表上的一行 */
export interface BackgroundAgentRow {
  agentId: string;
  kind: BackgroundAgentKind;
  taskId: string;
  taskTitle: string;
  stageId?: string;
  /** 阶段名（提议时写的，评审开始时写的）；老的评审没记 */
  stageTitle?: string;
  /** 定步阶段里的哪一步 */
  step?: string;
  /** 派去做什么（一句话：工作说明的第一行）；评审没有 */
  brief?: string;
  state: BackgroundAgentState;
  /** 没做完的原因（失败的、被停了的）：出错、守护进程重启、任务暂停……给人看的话在交回的结果里，这里只是种类 */
  outcome?: "done" | "error" | "interrupted" | "stopped";
  startedAt?: string;
  endedAt?: string;
  /** 工具调用次数（被拦下的也算） */
  toolCalls: number;
  /** 最近一次工具调用（运行中的才给） */
  lastStep?: BackgroundAgentStep;
  /** 用量：名下的 token 总量、其中缓存命中的 */
  tokens: number;
  cacheHitTokens: number;
}

export interface BackgroundAgentList {
  agents: BackgroundAgentRow[];
}

/** 只读对话里的一条，按发生的先后 */
export type BackgroundAgentEntry =
  /** 收到的指令：交给它的那条输入；工具包变了重新拉起时另有一条 */
  | { kind: "input"; text: string; at: string }
  /** 它说的话（模型输出的文字） */
  | { kind: "said"; text: string; at: string }
  /** 一次工具调用；完整参数和返回按 callId 现取（HTTP_PATHS.toolCallDetail） */
  | { kind: "tool_call"; callId: string; tool: string; argsSummary: string; outcome: string; resultSummary: string; at: string }
  /** 交回负责人的结果 */
  | { kind: "result"; text: string; at: string };

export interface BackgroundAgentTranscript {
  agent: BackgroundAgentRow;
  /**
   * 派它的时候写的工作说明（提议时的那段；老的子 agent 没有 input 那一条，靠它知道收到过什么）
   */
  instructions?: string;
  entries: BackgroundAgentEntry[];
  /** 这次运行记下了它说的话没有：以前跑的没记（界面写明"这次运行没有记下它说的话"） */
  saidRecorded: boolean;
}

/** `background_agents` 事件（背后的 agent 频道，临时）：这个负责人背后的 agent 有了变化 */
export interface BackgroundAgentsEventPayload {
  maintainerId: string;
}

/** 同一个负责人两条 background_agents 之间的最短间隔（毫秒）：工具调用、用量来得很密，页面没必要跟着每条都重取 */
export const BACKGROUND_AGENTS_PUSH_MS = 400;
