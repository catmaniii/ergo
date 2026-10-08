// agent 宿主协议：守护进程 ⇄ agent 子进程（规格第 3 节，ADR-0004）。
//
// 传输：子进程的 stdin / stdout，每行一个 JSON 对象（UTF-8，LF 分帧；容忍 CRLF；
// 不按 U+2028 / U+2029 切分，见 line-channel.ts）。stderr 只是日志，不承载协议。
//
// 这里的类型全是二狗自己的，不含任何 pi 的类型或词汇。子进程里由运行时封装层把 pi 的会话事件
// 翻译成下面的消息，守护进程这一侧只认这些消息。
//
// 已实现：start、user_input、interject、guard_reply、host_tool_result、context_block、compact、abort、exit；ready、stream_delta、
// message_final、tool_call_start / tool_call_end、guard_request、host_tool_call、usage、turn_end、error、heartbeat。
// 先定义好、由后面的票实现：work_order（12/16）、scope_review_result（18）。
// 子进程收到还没实现的命令时回一条 code 为 "unsupported" 的 error，不崩溃。

// 版本：1 是 02 号票的第一版；2 加了守护进程代为执行的工具（hostTools、host_tool_call、host_tool_result，
// 06 和 09 号票合成一套）和用户输入里的图片（user_input.images，09）；3 在装配参数里加了必填的 shellEnv
// （bash 起的进程额外的环境变量，联网开关关着时的无效代理，07）；4 加了重注入块（装配参数 contextBlock、命令 context_block）、
// 手动压缩（compact）、回合结束时列出收下的插话（turn_end.interjected）、没收下的插话回带输入 id 的错误（13）。
export const HOST_PROTOCOL_VERSION = 4;

/**
 * 重注入块（规格第 8 节）在会话文件里的自定义消息类型（customType）：每次唤起（拉起后第一条输入之前）和每次压缩之后，
 * 子进程把守护进程给的最新一块作为一条上下文消息加进会话（模型看到的是一条用户角色的消息），不改系统提示
 */
export const CONTEXT_BLOCK_TYPE = "ergou-context";

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
   * 照着上一条工具结果调用一个工具（模拟"模型从工具结果里抄出 id 再调用工具"，比如从素材检索结果里抄素材 id）：
   * 在上下文里最后一条工具结果的文字中按正则 pattern 找出全部匹配（去重、按出现的先后），作为参数 argument（字符串数组）
   * 加进 toolCall 的参数里；argument 可以是点分的路径（"params.materialIds"）
   */
  | { kind: "call_with_matches"; toolCall: FauxToolCall; argument: string; pattern: string }
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

/**
 * 守护进程代为执行的工具（宿主工具）：秘书建、改、取消提醒这类只产生卡片的工具，"读取附件""把文件作为附件发出"，
 * 以后的"提交计划"等。子进程把它登记成 pi 的自定义工具（不受工具白名单限制）；模型调用时发 host_tool_call，
 * 等守护进程回 host_tool_result。工具本身的逻辑和它要改的状态都在守护进程里，子进程只转手。
 */
export interface HostToolSpec {
  name: string;
  /** 给模型看的说明 */
  description: string;
  /** 参数的 JSON Schema（共享协议包里用 TypeBox 定义的 schema 序列化后就是）；pi 先按它校验，不合就不转 */
  parameters: JsonValue;
}

/** 守护进程执行完一个工具的结果：给模型看的文字，是否出错（出错时模型收到的是一次出错的工具调用） */
export interface HostToolResult {
  text: string;
  isError: boolean;
}

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
  /** 工具白名单（pi 的内置工具）；守护进程代为执行的工具另列在 hostTools 里，不用写进这里 */
  tools: string[];
  /** 守护进程代为执行的工具（宿主工具） */
  hostTools: HostToolSpec[];
  /** 只加载这些 skill（工具包里列的）；不读 ~/.pi、~/.agents、~/.claude/skills */
  skillPaths: string[];
  /** 固定的系统提示，替换 pi 默认的编程助手提示；不填用 pi 的默认 */
  systemPrompt?: string;
  /**
   * 接着这个 agent 会话目录里最近的一个会话（秘书的长期主线会话用）；目录里还没有会话就新开。
   * 不选则每次拉起都新开一个会话。
   */
  continueSession: boolean;
  /**
   * 每次工具调用先发 guard_request，等到 guard_reply 才决定执行与否（07 号票起，正式的会话都打开；
   * 只有测试里直接拉起的 agent 可以不开）。
   */
  forwardToolCalls: boolean;
  /**
   * bash 工具起的进程额外的环境变量（在子进程自己的环境之上覆盖）。联网开关关着时是一组无效的代理地址
   * （process/child-env.ts 的 OFFLINE_SHELL_ENV）；子进程自己的环境不受影响。空对象表示不加
   */
  shellEnv: Record<string, string>;
  /** 心跳间隔 */
  heartbeatIntervalMs: number;
  /**
   * 重注入块（13 号票：计划摘要 + 当前阶段 + 授权 + 边界）：每条输入之前（被唤起：刚拉起，或者闲着时来了新输入；
   * 插话不算）作为上下文消息加进会话；守护进程用 context_block 换成最新的，每次压缩之后子进程也注入一次。不给就不注入
   */
  contextBlock?: string;
}

/**
 * 会话文件里标记"下一条用户消息是哪条输入"的自定义条目的类型（customType）：子进程在每条用户输入之前追加一条，
 * 数据是 { inputId }。彻底删除（21 号票）据此找到会话文件里对应的原文改写掉（agent-child/session-rewrite.ts）
 */
export const SESSION_INPUT_TAG = "ergou-input";

// ───────────────────────── 改写会话文件（彻底删除，21 号票） ─────────────────────────
// 会话文件是 pi 的格式，改写放在子进程那一层（ADR-0004、ADR-0008）：守护进程以一次性子进程的方式调用
// （agent-child/rewrite-main.ts，stdin 一行请求、stdout 一行结果，做完就退出），见 session-rewrite.ts。

/** 改写一个 agent 会话目录里的会话文件：要改掉哪些原话 */
export interface SessionRewriteRequest {
  /** 会话目录（pi 的会话文件都在这里） */
  sessionDir: string;
  /** 整条换成删除标记的用户输入（输入标记 SESSION_INPUT_TAG 里的 inputId，也就是会话里那条用户消息的 id） */
  inputIds: string[];
  /** 这些工具调用的参数里的文字、工具结果整个换成删除标记（提议"记住"那几次） */
  toolCallIds: string[];
  /** 这些工具的结果里提到这些字串（素材 id）的行，换成"- 字串 · 删除标记"（素材检索的结果） */
  toolResultLines: Array<{ toolName: string; needles: string[] }>;
  /** 删除标记 */
  marker: string;
  /** 覆盖了被删内容的压缩摘要、分支摘要整段换成这句 */
  summaryMarker: string;
}

/** 改写的结果：改了几个文件、几条条目、几段摘要 */
export interface SessionRewriteResult {
  files: number;
  entries: number;
  summaries: number;
}

// ───────────────────────── 守护进程 → 子进程 ─────────────────────────

export type HostCommand =
  | { type: "start"; protocolVersion: number; session: SessionAssembly }
  /**
   * 用户输入：文字，支持视觉的模型另外带图片。子进程在会话文件里这条用户消息前面记一条带 inputId 的标签
   * （SESSION_INPUT_TAG），彻底删除时据此找到这条消息的原文（agent-child/session-rewrite.ts）
   */
  | { type: "user_input"; inputId: string; text: string; images?: InputImage[] }
  /** 工单（12/16 号票实现） */
  | { type: "work_order"; workOrderId: string; text: string }
  /**
   * 插话：回合进行中送进去，在当前这一步（含工具调用）做完之后、下一次模型调用之前进入上下文。
   * 收下的在这一轮的 turn_end.interjected 里列出；没有进行中的回合时不收，回一条带 inputId 的 bad_command 错误
   */
  | { type: "interject"; inputId: string; text: string }
  /** 换成最新的重注入块（阶段推进、授权变了）：下一条输入之前、下次压缩之后注入的就是它 */
  | { type: "context_block"; text: string }
  /**
   * 手动压缩会话（pi 的 compact：先中止进行中的回合，模型写一段摘要）；压缩之后照常注入重注入块。
   * 守护进程现在不发：契约测试用它验证"压缩之后重注入"，24 号票按上下文用量压缩时用
   */
  | { type: "compact" }
  /** 守卫判定回复：对应同一 requestId 的 guard_request */
  | { type: "guard_reply"; requestId: string; verdict: GuardVerdict }
  /** 守护进程代为执行的工具的结果：对应同一 requestId 的 host_tool_call */
  | { type: "host_tool_result"; requestId: string; result: HostToolResult }
  /** 中止进行中的回合 */
  | { type: "abort" }
  /** 让子进程正常结束 */
  | { type: "exit" };

export type GuardVerdict = { allow: true } | { allow: false; reason: string };

/** 作为图片输入交给模型的一张图片 */
export interface InputImage {
  mime: string;
  /** 图片内容（base64） */
  data: string;
}

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
  /** 模型调用了一个守护进程代为执行的工具（参数已按 JSON Schema 校验过）：等同一 requestId 的 host_tool_result */
  | { type: "host_tool_call"; requestId: string; toolCallId: string; toolName: string; args: JsonValue }
  | UsageReport
  /** 回合结束和闲置：这一轮输入处理完了，agent 闲下来，可以送下一条输入。interjected 是这一轮里收下的插话（输入 id） */
  | { type: "turn_end"; outcome: TurnOutcome; errorMessage?: string; interjected?: string[] }
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
  /** 和哪条输入有关（没收下的插话） */
  inputId?: string;
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
export function errorReport(code: AgentErrorCode, message: string, fatal = false, inputId?: string): ErrorReport {
  return { type: "error", code, message, fatal, ...(inputId === undefined ? {} : { inputId }) };
}
