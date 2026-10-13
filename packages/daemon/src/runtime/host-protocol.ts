// agent 宿主协议：守护进程 ⇄ agent 子进程（规格第 3 节，ADR-0004）。
//
// 传输：子进程的 stdin / stdout，每行一个 JSON 对象（UTF-8，LF 分帧；容忍 CRLF；
// 不按 U+2028 / U+2029 切分，见 line-channel.ts）。stderr 只是日志，不承载协议。
//
// 这里的类型全是二狗自己的，不含任何 pi 的类型或词汇。子进程里由运行时封装层把 pi 的会话事件
// 翻译成下面的消息，守护进程这一侧只认这些消息。
//
// 已实现：start、user_input、interject、yield、guard_reply、host_tool_result、context_block、scope_context、scope_review、compact、abort、exit；
// ready、stream_delta、message_final、tool_call_start / tool_call_end、guard_request、host_tool_call、usage（含压缩、范围审视那次）、
// turn_end、scope_review_result、compacted、error、heartbeat。
// 先定义好、还没有实现的：work_order（16 号票的工单经会话里的通知送达，没用到它）。
// 子进程收到还没实现的命令时回一条 code 为 "unsupported" 的 error，不崩溃。
import type { ToolResultMedia } from "@ergou/protocol";

// 版本：1 是 02 号票的第一版；2 加了守护进程代为执行的工具（hostTools、host_tool_call、host_tool_result，
// 06 和 09 号票合成一套）和用户输入里的图片（user_input.images，09）；3 在装配参数里加了必填的 shellEnv
// （bash 起的进程额外的环境变量，联网开关关着时的无效代理，07）；4 加了重注入块（装配参数 contextBlock、命令 context_block）、
// 手动压缩（compact）、回合结束时列出收下的插话（turn_end.interjected）、没收下的插话回带输入 id 的错误（13）；
// 5 加了跟在用户输入后面的上下文消息（user_input.context）和自定义的压缩指令（装配参数 compactionInstructions，22）；
// 6 加了用量的用途（usage.purpose：压缩会话的那次子进程照常报；范围审视预留给 18 号票）、faux 剧本里给定的用量（FauxStep.usage）、
// 目录模型的请求地址（CatalogModelSpec.baseUrl，契约测试把真实 provider 的请求发到本机录好的响应）（24）；
// 7 加了被杀后的恢复（装配参数 interruptedToolResults：接着会话时补上被中断的工具调用的结果，23）；
// 8 在装配参数里加了 session（接会话目录里指定名字的那个会话，16 号票：维护者会话分段），ready 报回这次打开的会话的名字（session）；
// 9 加了范围审视（18 号票）：装配参数 scopeReview（审视用的模型、审视的说明、对照物、近期范围记录）、命令 scope_context（换成最新的
// 对照物和近期范围记录）和 scope_review（守护进程要子进程审视这个会话里还没审视过的部分）、scope_review_result 定形（守护进程要的、
// 压缩时子进程自己做的，带上会话里交给它的输入）、usage.purpose 用上 scope_review，faux 剧本的 reply_with_context；
// 改写会话文件的请求加了 customTypes（范围审视结果的副本）。
// 10 加了"做完手头这一步就停下"（命令 yield，回合结局 yielded：27 号票，工具包变了重新装配会话之前让回合停在两次模型调用之间）。
// 11 在 tool_call_end 里加了 media：结果里没放进 resultText 的非文字块（图片）是什么、多大（53 号票，工具调用的完整参数和返回）。
// 12 在 guard_reply 的放行里加了 args、resultPrefix（59 号票：流程执行时按计划改回参数再执行，结果前面写明）。
// 13 加了看图能力（79 号票）：装配参数 vision（配置里写明的；不给按模型目录）、ready 报回实际生效的 vision，
// 宿主工具的结果可以带图片（host_tool_result.images：读取附件读图），插话可以带图片（interject.images）。
// 14 是一个会话固定一个模型（73 号票）：装配参数 model 只用于新开的会话，接着已有的会话（目录里的模型）时子进程照会话开始时的
// 模型、思考档位和看图能力（会话文件里记着，SESSION_MODEL_ENTRY）；装配参数 vision 改成按模型的表（配置里写明的，键是
// 「provider/模型 id」）；ready 报回会话实际用的模型（ready.model）。另加一次性的模型探查子进程（model-probe-main.ts：
// 列出模型目录里某个服务商的模型、连通测试），请求和结果见 ModelProbeRequest / ModelProbeResult。范围审视用的模型每次审视时
// 现取：命令 scope_review、scope_context 带上 model（设置里改了，下一次审视就用新的；压缩时子进程自己做的审视用最近交给它的）。
// 15 是换模型就新开会话（83 号票）：装配参数 handoff（接着的会话开始时的模型和这次的不一样时，先用原来的模型写一份交接摘要，
// 再新开一个会话、以摘要开头），ready 报回换没换成（ready.handoff）、接着的会话的模型和装配参数里的不一样（ready.model.differs），
// 写交接摘要那次调用的用量 usage.purpose 是 handoff；新会话开头的那条交接摘要是 HANDOFF_SUMMARY_TYPE 的自定义消息，
// 彻底删除时原来的会话里有被删的内容，这段摘要整段换掉（改写会话文件时跨文件看）。
// 16 在 host_tool_call 里加了 interjected（86 号票）：这一轮里已经进了上下文的插话（输入 id），守护进程的工具据此知道模型
// 发起这次调用时看到过用户插的哪几句（发语音认"用户在说话的那一轮"；送进去了还排着的不算）。
// 17 是 114 号票（每个 agent 的 ⚙：清空当前对话、上下文用量和"现在压缩"）：装配参数 freshSession（清空之后新开的那一段会话的名字：
// 会话目录里还没有这个名字的会话就马上用它新开一个，有了就照常接着最近的）；ready 报回会话的上下文窗口和 pi 的压缩设置（ready.context）；
// 每次压缩结束（自动、手动，压成、没什么可压、没压成都算）报一条 compacted。
export const HOST_PROTOCOL_VERSION = 17;

/** 被中断的工具调用补上的结果都以这句开头（23 号票） */
export const INTERRUPTED_PREFIX = "这次调用被中断了：执行时守护进程（或 agent 子进程）重启了，";

/**
 * 被中断的工具调用补上的结果（23 号票，规格第 17 节）：接着会话时，会话文件里最后一个回合的工具调用还没有结果
 * （被杀时正在执行、正在等审批，或者同一批里别的调用还没做完、结果还没写进会话），子进程补上一条工具结果。
 * 守护进程按调用给了说法的（等审批的、有副作用的：做完了的、失败了的、说不清做没做完的）用它的，
 * 没给的（只读或幂等的，或者守护进程也不知道的）用这一句（出错）
 */
export const INTERRUPTED_TOOL_RESULT = `${INTERRUPTED_PREFIX}没有拿到结果，不知道它做完没有。需要的话再调用一次。`;

/** 守护进程给一次被中断的工具调用备好的结果：文字，和它算不算出错（已经做完的不算） */
export interface InterruptedToolResult {
  text: string;
  isError: boolean;
}

/**
 * 重注入块（规格第 8 节）在会话文件里的自定义消息类型（customType）：每次唤起（拉起后第一条输入之前）和每次压缩之后，
 * 子进程把守护进程给的最新一块作为一条上下文消息加进会话（模型看到的是一条用户角色的消息），不改系统提示
 */
export const CONTEXT_BLOCK_TYPE = "ergou-context";

/**
 * 跟在一条用户输入后面的上下文消息（22 号票：秘书的"看板变化"）在会话文件里的自定义消息类型：模型看到的是紧跟在
 * 这条用户消息之后的一条用户角色的消息，不改系统提示
 */
export const INPUT_CONTEXT_TYPE = "ergou-input-context";

/**
 * 范围审视的结果在会话文件里的自定义条目类型（pi 的 appendEntry，不进模型的上下文）：每次审视（压缩时、守护进程要的）
 * 子进程记一条，数据是 { requestId?, findings, error? }（守护进程要的带 requestId）。只是副本：范围记录以守护进程保存的为准
 * （18 号票）；彻底删除时整条里的文字换成删除标记（改写会话文件的 customTypes）
 */
export const SCOPE_REVIEW_ENTRY = "ergou-scope-review";

/**
 * 会话开始时定下的看图能力在会话文件里的自定义条目类型（pi 的 appendEntry，不进模型的上下文，73 号票）：数据是 { vision }。
 * 一个会话固定一个模型：模型和思考档位 pi 自己在会话文件里记着（model_change、thinking_level_change），看图能力由子进程
 * 在新开会话时（和第一次接着 73 号票之前开的会话时）记一条；之后接着这个会话都照它，设置里改了只对新会话生效
 */
export const SESSION_MODEL_ENTRY = "ergou-session-model";

/**
 * 换模型新开的会话开头那条交接摘要（83 号票）在会话文件里的自定义消息类型：模型看到的是一条用户角色的消息（原来的模型写的摘要，
 * 前面一句说明换了模型、接着之前的对话），数据（details，不进模型的上下文）是 { fromSession, fromModel }：从哪个会话换过来的。
 * 彻底删除时原来的会话（连同它再往前换过来的）里有被删的内容，这段摘要整段换成删除标记（agent-child/session-rewrite.ts）
 */
export const HANDOFF_SUMMARY_TYPE = "ergou-handoff";

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
  /**
   * 换掉模型目录里的请求地址（24 号票）：只给契约测试用——把真实 provider 的请求发到本机一个回放录好的响应的服务，
   * 锁住 pi 对这家 provider 用量字段的换算。正式的会话不给
   */
  baseUrl?: string;
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
  /** 一次回复；带 usage 时这次调用照它上报用量（不带就由 faux 按上下文估算），主切面靠它让账本和剧本对得上（24 号票） */
  | { kind: "reply"; text?: string; thinking?: string; toolCalls?: FauxToolCall[]; usage?: FauxUsage }
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
  | { kind: "echo_context" }
  /**
   * 回复 text，其中的 {{context}} 换成这次调用看到的上下文（写法同 echo_context，按 JSON 字符串转义、不带引号）：
   * 范围审视的那次调用要回 JSON，契约测试和主切面借它核对审视的输入（18 号票）
   */
  | { kind: "reply_with_context"; text: string }
  /**
   * 模型报"上下文溢出"（provider 的出错回复，契约测试用）：pi 据此自动压缩、再重试这一轮（22 号票验证自动压缩用自定义的压缩指令）
   */
  | { kind: "context_overflow" };

/** 剧本给定的一次调用的用量：输入里命中缓存的、没命中的，和输出（token 数） */
export interface FauxUsage {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

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

/**
 * 守护进程执行完一个工具的结果：给模型看的文字，是否出错（出错时模型收到的是一次出错的工具调用）；
 * images 是跟在文字后面交给模型看的图片（79 号票：读取附件读图，只在模型看得了图时给）
 */
export interface HostToolResult {
  text: string;
  isError: boolean;
  images?: InputImage[];
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
  /**
   * 新开的会话用的模型和思考档位。一个会话固定一个模型（73 号票）：接着已有的会话（目录里的模型、会话文件里有消息）时，
   * 子进程照会话开始时记下的模型和思考档位，不用这里的（faux 例外：测试的剧本按每次拉起给，一律照这里的）；
   * 目录里的模型请求地址（baseUrl）照这里的
   */
  model: ModelSpec;
  /**
   * 看图能力（79 号票）：配置里写明的（设置页改的、配置文件 models["provider/模型 id"].vision），键是「provider/模型 id」
   * （faux 是 faux）；会话用的模型在表里就按它，不在就按模型目录（模型的输入里有图片就算能看）。73 号票起会话开始时定下、
   * 记进会话文件（SESSION_MODEL_ENTRY），接着这个会话时照记下的。
   * 子进程按实际生效的改写会话用的模型能收什么输入（pi 对历史里的图片、工具结果里的图片也按它处理：看不了的换成占位），
   * 在 ready 里报回实际生效的
   */
  vision?: Readonly<Record<string, boolean>>;
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
   * 接会话目录里这个名字的会话（16 号票：维护者会话分段，每段一个会话，接哪一段由守护进程明确指定；会话文件怎么命名、
   * 存成什么样只有子进程知道）：已经有了就打开它接着；还没有时，选了 continueSession 就接着目录里最近的那个
   * （项目维护者的第一段对话段接着任务转来的、16 号票之前的会话），目录里没有会话就新开一个、用这个名字存。
   * ready 里报回这次打开的会话的名字
   */
  session?: string;
  /**
   * 清空当前对话之后新开的那一段会话的名字（114 号票，秘书、任务的维护者）：会话目录里还没有这个名字的会话，就马上用这个名字
   * 建一个新会话（空文件先建好再交给 pi 打开，马上在盘上：之后接着最近的会话接的就是它，这时被杀、重启也接得上）、不接以前的；
   * 已经有了就当没给（照 continueSession、session 的规矩接，接到的是它或者之后换模型换过去的）。守护进程每次拉起都带上最近一次清空的名字
   */
  freshSession?: string;
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
  /**
   * 自定义的压缩指令（22 号票：秘书专用的那一份）：会话压缩时（自动：到了阈值、上下文溢出；手动：compact 命令）
   * 写摘要的模型调用按它写。不给就用 pi 默认的写法
   */
  compactionInstructions?: string;
  /**
   * 被中断的工具调用补上的结果（23 号票）：接着会话（continueSession）时，会话文件里最后一个回合的工具调用还没有结果的，
   * 子进程补上一条工具结果，按工具调用 id 取这里的，没有的用 INTERRUPTED_TOOL_RESULT（出错）。末尾写到一半的一行同时去掉
   */
  interruptedToolResults?: Record<string, InterruptedToolResult>;
  /**
   * 范围审视（18 号票，维护者的会话才有）：子进程挂上审视的扩展——
   * - before_agent_start：每条输入之前把近期范围记录拼到系统提示末尾（有才拼）；
   * - session_before_compact：把要压缩掉的消息转成文本，在会话之外另开一次模型调用审视，结果 appendEntry 进会话、报给守护进程；
   * - 命令 scope_review：同样另开一次调用，审视会话里还没审视过的部分（上次压缩留下的和之后的）。
   * 守护进程用 scope_context 换成最新的对照物和近期范围记录（和审视用的模型）
   */
  scopeReview?: ScopeReviewSetup;
  /**
   * 换模型就新开会话（83 号票，规格第 1 节"模型"）：接着已有的会话、而它开始时的模型或思考档位（思考档位按模型支持的档换算之后比）
   * 和这里的 model 不一样时，子进程先用会话开始时的模型照 instructions 写一份交接摘要（pi 的压缩摘要的写法，instructions 接在后面），
   * 再新开一个会话（用这里的模型），第一条就是这份摘要；摘要没写成（模型出错、超时）就照旧接着原来的会话、照它开始时的模型。
   * 换没换成都在 ready.handoff 里报回。不给就不换（任务执行中途）。faux 不固定模型，也就不换
   */
  handoff?: HandoffSetup;
}

/** 换模型时写交接摘要：写法（守护进程填好的提示）、最多等多久 */
export interface HandoffSetup {
  /** 交接摘要要写什么（prompts/handoff-summary.md 填好值），接在 pi 的摘要提示后面 */
  instructions: string;
  /** 写摘要那次模型调用最多等多久（毫秒）；超时算没写成 */
  timeoutMs: number;
}

/** 范围审视的装配：审视用的模型（便宜模型）、审视的说明、对照物、近期范围记录（文字都由守护进程写好，子进程只拼） */
export interface ScopeReviewSetup {
  /**
   * 审视那次模型调用用的模型（默认 deepseek-flash，73 号票起按设置里的"模型"）；不进会话。这是拉起时的，之后
   * scope_context、scope_review 带的 model 换掉它（每次审视时现取）
   */
  model: ModelSpec;
  /** 审视那次模型调用的系统提示：要找什么、怎么回（约定的 JSON {"records":[…]}） */
  instructions: string;
  /** 对照物：立项书、任务计划、用户给过的授权（含审批卡上的批准）和用户在会话里直接说的话 */
  reference: string;
  /** 近期范围记录（最近 5 条，一整段，带标题）；没有就不拼 */
  recentRecords?: string;
}

/** 范围审视找出的一件事：用户授权过的范围变更，或者没授权的越界（范围之内的不记） */
export interface ScopeFinding {
  kind: ScopeFindingKind;
  /** 一句话 */
  summary: string;
  /** 说明 */
  detail?: string;
  /** 依据：范围变更是用户的哪句话、哪项授权 */
  basis?: string;
}

export type ScopeFindingKind = "scope_change" | "out_of_scope";

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
  /**
   * 这些类型（customType）的自定义条目，数据里的文字全换成删除标记：范围审视结果的副本（SCOPE_REVIEW_ENTRY，18 号票）。
   * 副本不进模型的上下文、也不给人看（范围记录以守护进程保存的为准），有彻底删除就整个换掉，不去辨认引了哪句
   */
  customTypes: string[];
}

/** 改写的结果：改了几个文件、几条条目、几段摘要 */
export interface SessionRewriteResult {
  files: number;
  entries: number;
  summaries: number;
}

// ───────────────────────── 模型探查（设置里的"模型"，73 号票） ─────────────────────────
// 模型目录只有子进程查得到（ADR-0001、ADR-0004），守护进程自己不跑模型（ADR-0002）：设置页要列出某个服务商的模型
// （各自能不能看图、支持哪几档思考），要做连通测试，都以一次性子进程的方式调用（agent-child/model-probe-main.ts，
// stdin 一行请求、stdout 一行结果，做完就退出），见 model-probe.ts。

/**
 * 模型探查的请求：
 * - catalog：列出模型目录里这个服务商的模型（不连网、不要凭据）；
 * - ping：连通测试——用这个模型发一条极短的请求（不开思考），量首 token 延迟。credentials 经 stdin 送达、只放进内存
 */
export type ModelProbeRequest = { type: "catalog"; provider: string } | { type: "ping"; model: ModelSpec; credentials: Record<string, string> };

/** 模型目录里的一个模型 */
export interface CatalogModel {
  modelId: string;
  name: string;
  /** 输入里有没有图片（目录说能不能看图） */
  vision: boolean;
  /** 支持的思考档位（pi 的叫法，按从低到高） */
  thinkingLevels: ThinkingLevel[];
}

/** 模型探查的结果：catalog 回模型列表；ping 回通不通、首 token 延迟、整次多久，不通时 error 是原因（凭据的内容已经去掉） */
export type ModelProbeResult = { type: "catalog"; models: CatalogModel[] } | { type: "ping"; ok: boolean; firstTokenMs?: number; totalMs: number; error?: string };

// ───────────────────────── 守护进程 → 子进程 ─────────────────────────

export type HostCommand =
  | { type: "start"; protocolVersion: number; session: SessionAssembly }
  /**
   * 用户输入：文字，支持视觉的模型另外带图片。子进程在会话文件里这条用户消息前面记一条带 inputId 的标签
   * （SESSION_INPUT_TAG），彻底删除时据此找到这条消息的原文（agent-child/session-rewrite.ts）
   */
  | {
      type: "user_input";
      inputId: string;
      text: string;
      images?: InputImage[];
      /**
       * 跟在这条用户消息后面的一条上下文消息（22 号票：秘书的看板变化）：模型看到的是紧跟其后的一条用户角色消息
       * （会话文件里是 INPUT_CONTEXT_TYPE 的自定义消息），不改系统提示；不给就不加
       */
      context?: string;
    }
  /** 工单（12/16 号票实现） */
  | { type: "work_order"; workOrderId: string; text: string }
  /**
   * 插话：回合进行中送进去，在当前这一步（含工具调用）做完之后、下一次模型调用之前进入上下文。
   * 收下的在这一轮的 turn_end.interjected 里列出；没有进行中的回合时不收，回一条带 inputId 的 bad_command 错误。
   * 看得了图的模型另外带图片（79 号票）
   */
  | { type: "interject"; inputId: string; text: string; images?: InputImage[] }
  /**
   * 做完手头这一步就停下（27 号票：工具包变了，守护进程要按新工具包重新装配会话）：当前这一批工具调用结束之后、
   * 下一次模型调用之前结束这一回合（turn_end 的 outcome 是 yielded），会话文件里因此没有做了一半的回合，换一套装配接着会话
   * 就能接着干。这一步的回复已经不再调用工具（模型在写最后的回复）时照常结束（completed）。没有进行中的回合时什么都不做。
   * 停下时还排着、没进上下文的插话不算收下（不列进 turn_end.interjected）
   */
  | { type: "yield" }
  /** 换成最新的重注入块（阶段推进、授权变了）：下一条输入之前、下次压缩之后注入的就是它 */
  | { type: "context_block"; text: string }
  /**
   * 换成最新的范围审视对照物和近期范围记录（18 号票）：之后的压缩审视按它对照，之后每条输入之前拼的是它。
   * model 给了就换成它审视（73 号票：设置里改了审视用的模型，之后压缩时的审视用新的）。
   * 装配里没有 scopeReview 的子进程回 bad_command
   */
  | { type: "scope_context"; reference: string; recentRecords?: string; model?: ModelSpec }
  /**
   * 审视这个会话里还没审视过的部分（上次压缩留下的消息和之后的；18 号票：工单结束时，子进程退出之前）：在会话之外另开一次
   * 模型调用，结果以同一 requestId 的 scope_review_result 报回。审视做完之前，排在后面的命令（含 exit）等它。
   * model 是这次审视用的（73 号票：守护进程每次审视时现取；不给照最近交给它的）
   */
  | { type: "scope_review"; requestId: string; reference: string; model?: ModelSpec }
  /**
   * 手动压缩会话（pi 的 compact：先中止进行中的回合，模型写一段摘要）；压缩之后照常注入重注入块。
   * 114 号票起 ⚙ 里的"现在压缩"发它（守护进程等手头这一条处理完再发）；压完（或没压成）报一条 compacted
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

/**
 * 守卫的判定：放行或不放行（不放行时模型收到 reason）。
 * 放行时可以带 args（12，59 号票：流程执行时按计划把参数改回来）：子进程按它执行这次调用（整份换掉模型写的参数），
 * 并在工具结果前面加上 resultPrefix（告诉模型实际执行的是哪一版）
 */
export type GuardVerdict = { allow: true; args?: Record<string, unknown>; resultPrefix?: string } | { allow: false; reason: string };

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
  /**
   * 工具调用结束：resultText 是结果里的文字（非文字的块换成 [image] 这样的占位）；media 列出那些非文字的块是什么、多大
   * （内容不过宿主协议；只有文字时不带，53 号票）。形状就是给前端的 ToolCallDetail.media 那一份（共享协议包的 ToolResultMedia，只引类型）
   */
  | { type: "tool_call_end"; toolCallId: string; toolName: string; isError: boolean; resultText: string; media?: ToolResultMedia[] }
  /** 守卫判定请求：子进程里这次工具调用停住，等同一 requestId 的 guard_reply（规格：最长等 5 分钟，07 号票管超时） */
  | { type: "guard_request"; requestId: string; toolCallId: string; toolName: string; args: unknown }
  /** 模型调用了一个守护进程代为执行的工具（参数已按 JSON Schema 校验过）：等同一 requestId 的 host_tool_result */
  /** interjected：这一轮里已经进了上下文的插话（输入 id，按先后；86 号票）；没有时不带 */
  | { type: "host_tool_call"; requestId: string; toolCallId: string; toolName: string; args: JsonValue; interjected?: string[] }
  | UsageReport
  /** 回合结束和闲置：这一轮输入处理完了，agent 闲下来，可以送下一条输入。interjected 是这一轮里收下的插话（输入 id） */
  | { type: "turn_end"; outcome: TurnOutcome; errorMessage?: string; interjected?: string[] }
  | ScopeReviewReport
  | CompactedReport
  | ErrorReport
  | { type: "heartbeat"; at: number };

/** 压缩是怎么起的：手动（compact 命令）、用量到了阈值、上下文溢出之后 */
export type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * 一次压缩结束了（114 号票）：自动的（到了阈值、上下文溢出）和手动的都报。outcome：压好了（done，tokensBefore 是压缩前上下文的估算）、
 * 没什么可压的（nothing：会话还短，最近约 keepRecentTokens 原样保留、前面没有；或者刚压过）、被中止（aborted）、没压成（failed，error 写原因）。
 * 压缩那次模型调用的用量照旧另报一条 usage（purpose: compaction）。守护进程据此在会话的时间线上记"这里压缩过一次"、告诉等着的"现在压缩"
 */
export interface CompactedReport {
  type: "compacted";
  reason: CompactionReason;
  outcome: "done" | "nothing" | "aborted" | "failed";
  tokensBefore?: number;
  error?: string;
}

/** 会话的上下文（114 号票）：模型的窗口、pi 的压缩设置（用量超过 window - reserveTokens 自动压缩，最近约 keepRecentTokens 原样保留） */
export interface SessionContextInfo {
  window: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

/**
 * 范围审视的结果（18 号票）：守护进程要的（带同一 requestId）、压缩时子进程自己做的（没有 requestId）。
 * findings 为空是这段工作都在范围之内；没做成（模型出错、回复不是约定的 JSON）时 error 写原因、findings 为空。
 * inputIds 是这个会话里交给它的输入（输入标记 SESSION_INPUT_TAG 里的，也就是会话频道里那些消息的 id）：审视的工作记录里
 * 可能引着它们的原话，守护进程记在范围记录上，彻底删除其中一条时据此改写。审视那次模型调用的用量另报一条 usage（purpose: scope_review）
 */
export interface ScopeReviewReport {
  type: "scope_review_result";
  requestId?: string;
  findings: ScopeFinding[];
  inputIds: string[];
  error?: string;
}

/** 守护进程要的一次审视没做成（子进程没装配范围审视、中途退出、超时……）：error 写原因 */
export function failedScopeReview(requestId: string, error: string): ScopeReviewReport {
  return { type: "scope_review_result", requestId, findings: [], inputIds: [], error };
}

export interface ReadyReport {
  type: "ready";
  pid: number;
  sessionId: string;
  /** 会话 JSONL 的路径（pi 在第一条消息定稿后才真正写盘） */
  sessionFile: string;
  /** 这次打开的会话的名字（装配参数 session 用的就是它，16 号票） */
  session: string;
  /** 实际装配进会话的资源，供核对"只加载了该加载的" */
  loaded: LoadedResources;
  /**
   * 会话的模型实际能不能看图（79 号票）：装配参数给了 vision 就是它，没给按模型目录。守护进程据此决定
   * 用户消息里的图片作为图片交过来还是投影成占位、读取附件读图时交不交图片
   */
  vision: boolean;
  /** 会话实际用的模型（73 号票：接着已有的会话时是它开始时的，可能不是装配参数里的） */
  model: SessionModel;
  /** 会话的上下文窗口和压缩设置（114 号票：⚙ 里的上下文用量、离自动压缩还有多少按它算） */
  context: SessionContextInfo;
  /**
   * 换模型（83 号票）：装配参数给了 handoff、接着的会话开始时的模型又和装配参数里的不一样时才有。换成了（没有 error）时
   * 这次打开的是新会话（session、model 都是新的）；没写成交接摘要（error）时照旧是原来的会话
   */
  handoff?: HandoffReport;
}

/** 会话实际用的模型：provider 和模型 id（faux 是 faux provider 的）、思考档位；pinned 为真是接着已有的会话、照它开始时的 */
export interface SessionModel {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  pinned: boolean;
  /**
   * 接着的会话开始时的模型（或按模型支持的档换算后的思考档位）和装配参数里的不一样（83 号票）：装配参数没给 handoff，
   * 或者交接摘要没写成。守护进程据此在下一条能换的输入之前带上 handoff 重新拉起。一样的不写
   */
  differs?: true;
}

/** 一个模型：provider、模型 id、模型目录里的名字（给人看）、思考档位 */
export interface ModelRef {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevel: ThinkingLevel;
}

/** 换模型的结果（83 号票） */
export interface HandoffReport {
  /** 原来的会话：名字、它开始时的模型 */
  from: { session: string; model: ModelRef };
  /** 换成的模型（没换成时是这次本来要换成的）；思考档位按模型支持的档换算过 */
  to: ModelRef;
  /** 交接摘要没写成的原因（凭据的内容已经去掉）：这时没换，照旧接着原来的会话 */
  error?: string;
}

export interface LoadedResources {
  tools: string[];
  skills: string[];
  contextFiles: string[];
  extensions: string[];
  /** 配了凭据的 provider id */
  credentialProviders: string[];
}

/**
 * 每次模型调用的用量（token 账本据此记一条，24 号票）。输入分三块、互不重叠：命中缓存的 cacheRead，
 * 没命中的 input 和 cacheWrite（这次写进缓存的；DeepSeek 不报，是 0）——账本里"缓存未命中"= input + cacheWrite。
 * 平常的调用在回复定稿时报（messageId 是那条回复）；压缩会话的那次在压缩结束时报（purpose 是 compaction，messageId 是 compaction-<n>）；
 * 范围审视的那次在审视的模型回复后报（purpose 是 scope_review，messageId 是 scope-review-<n>，provider、modelId 是审视用的模型的）；
 * 换模型时写交接摘要的那次在 ready 之后报（purpose 是 handoff，messageId 是 handoff-<原来的会话>，provider、modelId 是原来的模型的，83 号票）
 */
export interface UsageReport {
  type: "usage";
  messageId: string;
  provider: string;
  modelId: string;
  /** 输入里没命中缓存的部分（不含 cacheWrite） */
  input: number;
  output: number;
  /** 输入里命中缓存的部分 */
  cacheRead: number;
  /** 输入里没命中、这次写进缓存的部分 */
  cacheWrite: number;
  totalTokens: number;
  /**
   * 这次调用不是平常的回复：压缩会话（compaction）、范围审视（scope_review，18 号票：维护者子进程里另开的那一次）、
   * 换模型时写交接摘要（handoff，83 号票）。账本里单独标出
   */
  purpose?: UsagePurpose;
}

/** 用量报告的用途（平常的回复不写） */
export type UsagePurpose = "compaction" | "scope_review" | "handoff";

/** 回合的结局：做完了、被中止、出错、按 yield 停在两次模型调用之间（27 号票） */
export type TurnOutcome = "completed" | "aborted" | "error" | "yielded";

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
