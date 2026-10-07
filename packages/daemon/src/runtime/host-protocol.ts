// agent 宿主协议：守护进程 ⇄ agent 子进程（规格第 3 节，ADR-0004）。
//
// 传输：子进程的 stdin / stdout，每行一个 JSON 对象（UTF-8，LF 分帧；容忍 CRLF；
// 不按 U+2028 / U+2029 切分，见 line-channel.ts）。stderr 只是日志，不承载协议。
//
// 这里的类型全是二狗自己的，不含任何 pi 的类型或词汇。子进程里由运行时封装层把 pi 的会话事件
// 翻译成下面的消息，守护进程这一侧只认这些消息。
//
// 已实现：start、user_input、interject、guard_reply、abort、exit；ready、stream_delta、
// message_final、tool_call_start / tool_call_end、guard_request、usage、turn_end、error、heartbeat。
// 先定义好、由后面的票实现：work_order（12/16）、scope_review_result（18）。
// 子进程收到还没实现的命令时回一条 code 为 "unsupported" 的 error，不崩溃。

export const HOST_PROTOCOL_VERSION = 1;

// ───────────────────────── 会话装配参数 ─────────────────────────

/** 思考档位。规格要求显式设置，所以装配参数里是必填的。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** 模型：目录里的真实模型，或测试用的 faux provider（按剧本回话）。 */
export type ModelSpec = CatalogModelSpec | FauxModelSpec;

export interface CatalogModelSpec {
  kind: "catalog";
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

export interface FauxModelSpec {
  kind: "faux";
  thinkingLevel: ThinkingLevel;
  /** 每次模型调用按顺序取一步；剧本用完后再调用会得到一条错误回复 */
  script: FauxStep[];
  /** 流式输出的速度（token/秒）；不填则尽快吐完。测"中止"时调慢 */
  tokensPerSecond?: number;
}

/** faux 剧本的一步，对应一次模型调用。 */
export type FauxStep =
  | { kind: "reply"; text?: string; thinking?: string; toolCalls?: FauxToolCall[] }
  /**
   * 把这次模型调用看到的上下文原样回成一段文字（契约测试用）：系统提示、工具列表，
   * 以及按顺序排列的每条消息，每行以 `[system]`、`[tool]`、`[user]`、`[assistant]`、`[toolResult]` 开头
   */
  | { kind: "echo_context" };

export interface FauxToolCall {
  name: string;
  arguments: { [key: string]: JsonValue };
}

/** 能原样走 JSON 的值 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** "启动"命令携带的会话装配参数。 */
export interface SessionAssembly {
  agentId: string;
  /** agent 的工作目录：工具的相对路径基准 */
  cwd: string;
  /** pi 会话 JSONL 放在这里（数据目录会话区下，每个 agent 一个子目录） */
  sessionDir: string;
  /** 交给 pi 当"全局配置目录"的空目录（数据目录临时区下）；不用 ~/.pi */
  piAgentDir: string;
  model: ModelSpec;
  /** provider id → API key。经 stdin 送达、只放进 pi 的内存凭据，不进子进程的环境变量 */
  credentials: Record<string, string>;
  /** 工具白名单 */
  tools: string[];
  /** 只加载这些 skill（工具包里列的）；不读 ~/.pi、~/.agents、~/.claude/skills */
  skillPaths: string[];
  /**
   * 每次工具调用先发 guard_request，等到 guard_reply 才决定执行与否。
   * 本票只为验证这条通路；07 号票接上守卫后，所有会话都要打开。
   */
  forwardToolCalls: boolean;
  /** 心跳间隔 */
  heartbeatIntervalMs: number;
}

// ───────────────────────── 守护进程 → 子进程 ─────────────────────────

export type HostCommand =
  | { type: "start"; protocolVersion: number; session: SessionAssembly }
  | { type: "user_input"; inputId: string; text: string }
  /** 工单（12/16 号票实现） */
  | { type: "work_order"; workOrderId: string; text: string }
  /** 插话：回合进行中送进去，在当前这一步（含工具调用）做完之后、下一次模型调用之前进入上下文 */
  | { type: "interject"; inputId: string; text: string }
  /** 守卫判定回复：对应同一 requestId 的 guard_request */
  | { type: "guard_reply"; requestId: string; verdict: GuardVerdict }
  /** 中止进行中的回合 */
  | { type: "abort" }
  /** 让子进程正常结束 */
  | { type: "exit" };

export type GuardVerdict = { allow: true } | { allow: false; reason: string };

// ───────────────────────── 子进程 → 守护进程 ─────────────────────────

export type AgentReport =
  | ReadyReport
  | { type: "stream_delta"; messageId: string; part: "text" | "thinking"; delta: string }
  | { type: "message_final"; messageId: string; message: FinalMessage }
  /** 模型要调用一个工具（打开守卫转发时，此后才有 guard_request，判定之前工具不会执行） */
  | { type: "tool_call_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_call_end"; toolCallId: string; toolName: string; isError: boolean; resultText: string }
  /** 守卫判定请求：子进程里这次工具调用停住，等同一 requestId 的 guard_reply（规格：最长等 5 分钟，07 号票管超时） */
  | { type: "guard_request"; requestId: string; toolCallId: string; toolName: string; args: unknown }
  | UsageReport
  /** 回合结束和闲置：这一轮输入处理完了，agent 闲下来，可以送下一条输入 */
  | { type: "turn_end"; outcome: TurnOutcome; errorMessage?: string }
  /** 范围审视结果（18 号票实现） */
  | { type: "scope_review_result"; record: unknown }
  | ErrorReport
  | { type: "heartbeat"; at: number };

export interface ReadyReport {
  type: "ready";
  pid: number;
  sessionId: string;
  /** 会话 JSONL 的路径（pi 在第一条消息定稿后才真正写盘） */
  sessionFile: string;
  /** 实际装配进会话的资源，供核对"只加载了该加载的" */
  loaded: LoadedResources;
}

export interface LoadedResources {
  tools: string[];
  skills: string[];
  contextFiles: string[];
  extensions: string[];
  /** 配了凭据的 provider id */
  credentialProviders: string[];
}

/** 每次模型调用的用量 */
export interface UsageReport {
  type: "usage";
  messageId: string;
  provider: string;
  modelId: string;
  /** 输入里没命中缓存的部分 */
  input: number;
  output: number;
  /** 输入里命中缓存的部分 */
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export type TurnOutcome = "completed" | "aborted" | "error";

export interface FinalMessage {
  role: "assistant";
  parts: FinalPart[];
  stopReason: StopReason;
  errorMessage?: string;
}

/** 一条模型回复为什么停下 */
export type StopReason =
  /** 说完了 */
  | "done"
  /** 要调用工具，工具结果回来后会接着下一次模型调用 */
  | "tool_calls"
  /** 到了输出长度上限 */
  | "max_tokens"
  | "aborted"
  | "error";

export type FinalPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: unknown };

export interface ErrorReport {
  type: "error";
  code: AgentErrorCode;
  message: string;
  fatal: boolean;
}

export type AgentErrorCode =
  /** 命令格式不对、或在不该发的时候发（比如没启动就送输入） */
  | "bad_command"
  /** 上一回合还没结束又送了一条输入（守护进程应当排队，等 turn_end） */
  | "busy"
  /** 协议里有、但这个版本还没实现的命令 */
  | "unsupported"
  /** 会话装配失败 */
  | "start_failed"
  | "internal";

/** 构造一条 error 消息（子进程一侧统一用它） */
export function errorReport(code: AgentErrorCode, message: string, fatal = false): ErrorReport {
  return { type: "error", code, message, fatal };
}
