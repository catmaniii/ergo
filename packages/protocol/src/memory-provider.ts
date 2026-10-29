// 记忆插件（337 号票 v1 草案）：一家记忆系统实现一个 MemoryProvider，宿主（守护进程）同时只用其中一个。
// - 只有类型和常量：不引用 TypeBox、不引用任何实现（守护进程、网页插件都引它）；
// - 宿主规矩（实现见 packages/daemon/src/memory/provider/host.ts）：
//   - 同时只有一个在跑：换插件 = 宿主先停旧的（stop）再起新的（start）；旧的数据目录和设置原样留着，能切回来；
//   - 所有状态只能写在自己的数据目录里（ctx.dataDir），不许往别处写，也不许读别的插件的数据目录；
//   - 不许绕过 ctx.llm / ctx.embed 自己去连模型服务（key 由宿主给、用量由宿主记）；不许自己起网络端口；
//   - 核心只放每家都有的东西（检索、记一条、删、体检）；会意独有的结论/证据/预测走 capabilities.tools 和自己的页面。
// - 版本：api 变了就是接口变了；宿主不认识的不启用，也不猜（见 MEMORY_API_VERSION）。
import type { MemoryBriefItem, MemoryRecallHit } from "./schema.ts";

export const MEMORY_API_VERSION = 1;

/**
 * 插件 id 的写法（subtext、mem0……）：它也是数据目录的名字（memory/<id>/），所以只收小写字母、数字、- 和 _。
 * 宿主（启用时）和配置（memory.provider）都按它认，挡住 .. 和路径分隔符，免得数据写到数据目录外面去
 */
export const MEMORY_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** 宿主给插件的"现取"的值：插件自己的提示要用（语言、用户称呼、助手名字）；宿主不在这层写死 */
export interface MemoryIdentity {
  /** 语言代码（168 号票，比如 zh、en） */
  language: string;
  /** 用户自己的名字（没设就没有） */
  userName?: string;
  /** 助手此刻的名字（用户给它起过名时不是"二狗"） */
  assistantName: string;
}

/** 插件请宿主代调模型：prompt 由插件给，走用户配的那个服务商、宿主的限流和记账 */
export interface MemoryLlmRequest {
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
}

/**
 * 宿主叫停的信号：结构上就是 AbortSignal 的常用那几样（signal.aborted 看叫停没有，
 * addEventListener("abort", …) 听叫停）。协议包不引 DOM / Node 的类型，所以这里只写插件用得到的部分，
 * 宿主交给插件的就是真 AbortSignal
 */
export interface MemoryAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** 宿主给插件的上下文：能力都是"宿主做、插件用"，插件不要自己去搞 */
export interface MemoryProviderContext {
  /** 这个插件的私有数据目录（已经建好）：所有状态都放这儿；备份/迁移/卸载内核按整个目录处理 */
  dataDir: string;
  /** 语言、用户称呼、助手名字这些"现取"的值（插件自己的提示要用） */
  identity(): MemoryIdentity;
  /** 让宿主代调模型：走用户配的那个服务商，走宿主的限流和记账；prompt 由插件给 */
  llm(request: MemoryLlmRequest): Promise<string>;
  /** 让宿主代算向量（用用户装的那个向量模型；没有就抛，插件应先看 requirements） */
  embed(texts: string[]): Promise<number[][]>;
  /** 现在（假时钟测试会拨） */
  now(): Date;
  log(line: string): void;
  /** 宿主叫停（停用、退出）：插件应尽快收尾，之后的调用都不会再来 */
  signal: MemoryAbortSignal;
}

/** 插件声明自己会什么。宿主只看这里，不猜实现 */
export interface MemoryCapabilities {
  /** 每轮对话前带一段简报；不声明就由宿主拿 search() 拼一个默认的 */
  brief?: boolean;
  /** 自己的巩固/整理（宿主按计划叫，比如每晚 03:00） */
  consolidate?: boolean;
  /** 用户画像/结论：谁、偏好、关系（Honcho 有，Mem0 没有） */
  subject?: boolean;
  /** 时间线/双时间（Graphiti 强项） */
  timeline?: boolean;
  /** 实体关系图 */
  graph?: boolean;
  /** 设置项（宿主统一渲染成设置界面；换插件时设置界面跟着换） */
  settings?: MemorySettingSpec[];
  /** 记忆页里有哪些页签（页面本身仍由网页侧画；这里是"有哪些"的声明） */
  tabs?: MemoryTabSpec[];
  /** 额外工具（核心固定给 memory_search / memory_add / memory_forget 三个，这里只放多出来的，名字必须带插件前缀） */
  tools?: MemoryToolSpec[];
}

export interface MemoryProviderInfo {
  /**
   * 接口版本：必须等于 MEMORY_API_VERSION。写别的（比如按新版本接口写的插件）宿主拒绝启用。
   * 这里有意是 number 而不是 typeof MEMORY_API_VERSION：宿主必须能把"不认识的版本"当数据比出来
   */
  api: number;
  /** 唯一 id：subtext / …（配置里 memory.provider 选的也是它，也是数据目录的名字） */
  id: string;
  name: { zh: string; en: string };
  version: string;
  /** 实验性（会意第一版要标） */
  experimental?: boolean;
  capabilities: MemoryCapabilities;
  requirements: MemoryRequirements;
}

/** 插件要什么才能跑：向导、体检、组件页据此拦，缺了不启用 */
export interface MemoryRequirements {
  /** 要装的功能（组件清单里的 feature，比如 "memory.semantic" 就是向量模型） */
  features?: string[];
  /** 要用户自己起的外部服务（插件自己不联网，但可以声明"我需要一个地址"） */
  external?: { kind: string; note: string }[];
  /** 用的嵌入模型和维度（宿主据此提醒换模型要重建索引） */
  embedding?: { model: string; dims: number };
}

/** 一条记忆的通用样子：检索、展示、删除都按它，插件内部结构再复杂也不用暴露 */
export interface MemoryItem {
  id: string;
  /** 种类：事实、事件、断言、偏好、关系……插件自己定，宿主只用来显示/过滤 */
  kind: string;
  /** 一句话（给人和给模型看的都行） */
  text: string;
  createdAt: string;
  /** 这条事实"什么时候开始/不再成立"（有就填，没有就是不限） */
  validFrom?: string;
  validTo?: string;
  /** 0..1，插件自己怎么算都行；没有就是没给 */
  confidence?: number;
  tags?: string[];
  /** 出处：至少一条，页面和工具都靠它追溯（用户 2026-10-28 定：没有出处的条目不进简报） */
  sources: MemorySource[];
  /** 插件自己的附加字段（界面按 capability 决定显不显示，核心不解释） */
  extra?: Record<string, unknown>;
}

/** 出处：能跳回原话的坐标（会话 + 消息 / 素材 / 工具调用 / 任务 / 项目 / 文件） */
export interface MemorySource {
  kind: "conversation" | "message" | "tool_call" | "material" | "task" | "project" | "file";
  id: string;
}

/** 喂进来的一条原始素材（一条消息、一次工具调用、一份材料）：记不记、记什么由插件定 */
export interface MemoryEpisode {
  at: string;
  source: MemorySource;
  /** 原话/材料正文；插件自己决定存多少 */
  text: string;
  /** 这条素材在哪儿发生的（宿主给，插件用来分场景） */
  conversation?: { id: string; agentId?: string; projectId?: string; taskId?: string };
  attachments?: { name: string; path: string; mime?: string }[];
}

/** 收下一条素材的结果 */
export interface MemoryObserveResult {
  status: "stored" | "skipped" | "failed";
  reason?: string;
}

/**
 * 用户明说"帮我记一句"时走这条（337 号票用户 2026-10-28 定"他就可以帮我记一句"）：
 * 按原话存下来（**不从对话里猜**），回存好的那条（带 id，秘书据此回一句"记下了"）
 */
export interface MemoryRememberInput {
  /** 用户的原话（按原话存，不要改写成推断） */
  text: string;
  /** 种类：宿主给的是 note（手动记的）；插件可以自己换个更细的 */
  kind?: string;
  tags?: string[];
  /** 出处：宿主按这条会话记（会话 id + 消息 id），至少一条 */
  sources?: MemorySource[];
}

export interface MemorySearchQuery {
  text: string;
  limit?: number;
  kinds?: string[];
  since?: string;
  until?: string;
  scope?: { projectId?: string; taskId?: string; conversationId?: string };
}

export interface MemorySearchResult {
  items: MemoryItem[];
  /** 插件内部做了几轮（可选，只看日志用） */
  tookMs?: number;
}

/**
 * 删除（隐私要求，必须实现）：按条目、按来源、按时间范围、全删，四种至少实现来源和全删两种。
 * 宿主在"彻底删除""删项目""删素材"时会调；删不掉的必须如实报出来（宿主会写进二次确认）
 */
export type MemoryForgetSelector = { items: string[] } | { source: MemorySource } | { range: { from?: string; to?: string } } | { all: true };

/** 删完的结果：删掉了几条；有删不掉的（插件报的）写 failed，宿主要如实告诉用户 */
export interface MemoryForgetResult {
  removed: number;
  failed?: string;
}

export interface MemoryHealth {
  items: number;
  lastConsolidatedAt?: string;
  /** 数据目录占多少字节（没算就省） */
  bytes?: number;
  /** 有毛病就说（体检页显示） */
  problems?: string[];
}

export interface MemorySettingSpec {
  key: string;
  kind: "boolean" | "enum" | "number";
  default: boolean | string | number;
  /** enum 的选项 */
  options?: { value: string; label: { zh: string; en: string } }[];
  label: { zh: string; en: string };
  note?: { zh: string; en: string };
}

export interface MemoryTabSpec {
  id: string;
  label: { zh: string; en: string };
  /** items：宿主按通用条目渲染；custom：插件自己的网页组件画 */
  kind: "items" | "custom";
}

export interface MemoryToolSpec {
  name: string;
  description: { zh: string; en: string };
  /** 宿主按这个转成给模型的工具定义（和仓库现在的工具参数写法一致） */
  parameters: unknown;
}

/** 每轮简报的输入：这一轮用户说的话和场景（插件据此决定带不带、带什么） */
export interface MemoryBriefInput {
  text: string;
  conversation?: MemoryEpisode["conversation"];
  /**
   * 这一段对话里已经带过的：键 → 指纹（宿主从这一轮往前认到上一个分界，是前几轮简报回来的 keys）。
   * 插件自己认这套键：指纹没变的不再带；认不出就当没有——不给就是每一轮都带（不去重）
   */
  known?: Record<string, string>;
}

/**
 * 简报回来的一份（337 号票：宿主把它原样记进会话，下一轮把 keys 当 known 交回来）：
 * - text：交给秘书的正文，抬头、格式都由插件定（空串就是这一轮不带）；
 * - keys：这次带上了哪几条记忆——键 → 指纹（键怎么写由插件定）；不给（或者空）就是插件不做去重，宿主每一轮都带；
 * - items / hits：为什么带、命中的素材，和 MemoryBriefPart.items / MemoryRecall.hits 同一形状，宿主写进这一轮的回话
 *   （网页"回忆了 N 条记忆"）；不给就是空的——不做这两样的插件照样能回简报。
 * 只回字符串也行（老实现）：等于只给了正文、没有键（不去重），宿主把另外三样当空
 */
export interface MemoryBriefResult {
  text: string;
  keys?: Record<string, string>;
  items?: MemoryBriefItem[];
  hits?: MemoryRecallHit[];
}

/** 插件回来的简报：一份，或者只回正文（老实现）；这一轮不带是 undefined */
export type MemoryBriefReturn = MemoryBriefResult | string;

/** 巩固/整理的入参：since 是上次整理到的位置（没给就是插件自己记的） */
export interface MemoryConsolidateOptions {
  since?: string;
}

/** 巩固/整理改了多少（0 也行） */
export interface MemoryConsolidateResult {
  changed: number;
}

/** 一个记忆系统的实现：核心八个方法必做，其余是可选能力（声明了宿主才用） */
export interface MemoryProvider {
  info(): MemoryProviderInfo;
  /** 起来：建目录、开库、预热。宿主保证只调一次、只在一个实例上 */
  start(ctx: MemoryProviderContext): Promise<void>;
  /** 收尾：关库、清定时器（收尾期间不再有别的调用） */
  stop(): Promise<void>;
  /** 收到一条原始素材：记不记、记什么由插件定 */
  observe(episode: MemoryEpisode): Promise<MemoryObserveResult>;
  /** 用户明说"帮我记一句"时走这条：按原话存下来（不再让插件去猜），回存好的那条 */
  remember(input: MemoryRememberInput): Promise<MemoryItem>;
  /** 找跟这段话有关的记忆 */
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  /** 删（隐私） */
  forget(selector: MemoryForgetSelector): Promise<MemoryForgetResult>;
  /** 现在什么状况（体检、设置页用） */
  health(): Promise<MemoryHealth>;
  /**
   * 可选：每轮带一段简报（不声明 capabilities.brief 时宿主用 search 拼一个默认的）。
   * 回一份（正文 + 这次带上了哪几条）或者只回正文都行
   */
  brief?(context: MemoryBriefInput): Promise<MemoryBriefReturn | undefined>;
  /** 可选：自己的整理（宿主按计划叫，返回改了多少） */
  consolidate?(options: MemoryConsolidateOptions): Promise<MemoryConsolidateResult>;
  /** 可选：额外工具怎么执行（工具清单见 capabilities.tools） */
  callTool?(name: string, args: unknown): Promise<unknown>;
}
