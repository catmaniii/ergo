// @i18n-ignore-file log：没装上的原因、登记出错都是给开发者看的（日志、健康检查）；插件没启用时给用户的那句、设置里没装上的原因走 t()（174、211 号票）
// 插件宿主（ADR-0027，126 号票）：守护进程里装插件的那部分。借 Cordis 的规矩、不引入 Cordis（调研 19 §3.3、§8.2）：
// 1. 每次注册都能撤销，并记在插件名下：插件经宿主给的上下文（PluginContext）登记卡片类型、彻底删除的改写函数、
//    快速动作、内部作业、看板种类、事件触发的订阅方、转发的应用（132 号票）、运营手段（130 号票）、定时器 / 订阅 / 事件监听（effect）、自己的 start/stop，每一次都返回撤销函数、
//    记在这个插件名下；停用时按登记的逆序撤（单个撤销出错只记日志、不拦着别的）。停了以后再经它登记直接报错，迟到的登记不会悄悄漏掉。
// 2. 依赖靠声明：插件声明要的服务（needs：内核提供的或别的插件提供的，缺一个就不装，原因写进日志和 report()）、
//    可选的服务（wants：在的话先装提供它的插件、取得到；不在照装，取到 undefined；用的时候现取、不要存起来，提供它的插件随时可能停）、
//    自己提供的服务（provides，装配时 provide 登记）。按依赖排顺序装（同等的按清单的先后），停的时候依赖它的先停；
//    循环依赖的都不装，写明是哪一圈（Cordis 4.x 循环依赖会一直挂着不报错，cordis#66）。
//    "依赖别的插件"就是依赖它提供的服务；可选依赖的写法是 wants（Cordis 4.x 的 inject 全是必需的，调研 19 §3.8）。
// 3. 插件之间、内核和插件之间不互相 import 内部：经宿主按服务名取（ServiceKey 带着类型；插件对外的服务名和类型放在它的 api.ts）。
// 另外两样：
// - 派生视图：插件在定义里声明（views），宿主在打开事件存储之前收齐（views()）；不装的插件的视图名交给事件存储记成停着的
//   （dormantViews()：表留着、不再更新，以后装上时整表补一遍）；运行中停用的插件，它的视图从事件存储上摘下（同样记成停着的），
//   运行中启用时登记回去、马上整表补齐（211 号票，EventStore.attachView）。
// - 数据契约（contracts）：插件拥有的卡片类型、事件类型怎么改写（彻底删除）、怎么变成素材（129 号票）、前端请求怎么回、
//   移除时"连数据删"删什么（211 号票，removal.ts）——不管插件开没开、装没装上都登记，停用也不撤。彻底删除（ADR-0008：没登记改写函数的
//   事件类型整个拒删）、卡片改写后的新版本靠它照常；素材来源也是确定性地只看事件本身（ADR-0006），停用的插件以前写下的事件照样留原话副本、
//   重建 materials.db 时照样采得出来；要用插件服务的部分（卡片动作、前端请求）经 active() 现取，插件没在运行时回"X插件没启用"（not_allowed）。
//   286 号票起数据契约里还登记 agent 运行时（"运行时"贡献点，ctx.runtimes）：id、名字、子进程入口、能力清单、可选模型和设置项、
//   列可接管会话的函数——维护者记着用哪个运行时，插件停用时也要认得、写得出是哪个插件没启用；能不能用跟着插件在不在运行
//   （登记表 runtime/runtimes.ts，停用时用它的维护者不启动，见 agent-host/runtime-gate.ts）。
//   295 号票起数据契约里还登记数据源（"数据源"贡献点，ctx.dataSources）：名字、敏感类别、两种用法（按需查 / 导入）、它导入的记录、
//   认导入文件夹里哪种文件，连同要插件在运行才叫的函数（连接状态、填设置、同步、导入文件、按需查的工具）——停用的插件的数据源照样在
//   设置 · 数据源里列出、写"X插件没启用"，断开并删照样删得掉它导入的（登记表 data-sources/registry.ts，见 data-sources/service.ts）。
// - agent 贡献（128 号票）：插件给 agent 的工具（守卫的登记随工具走）、每轮的上下文块、钩子订阅经 ctx.agent 登记进 agent 贡献模块
//   （agent-host/contributions.ts），和别的登记一样返回撤销函数、停用时撤掉；上下文块、钩子订阅的 id 前面加上插件名（"reminders:…"）。
//   工具由宿主包一层（211 号票）：停用后还没按新的贡献重新装配的 agent 在正在跑的一轮里再调它，回"X插件没启用"（isError），不崩、不做。
//   系统提示的片段和占位符在定义里声明（prompts），宿主建的时候收齐（prompts()），交给系统提示的文件——和数据契约一样不管插件开没开都在
//   （用户改过的提示里写了插件的占位符不至于出错），插件的条件（比如"提醒"）只在插件运行时成立，默认的提示里讲它的段落包在条件里。
// 生命周期：createPluginHost（排顺序、定谁不装、写日志）→ views() / dormantViews()（打开事件存储之前）→ setup（全部插件的契约，
// 再按顺序装配）→ start（按顺序叫各插件的 start）→ stop（守护进程停：依赖方先停、倒着撤）。
// 运行中（211 号票，设置 · 插件的热插拔；只有自带的插件、代码一直在，不是热重载代码——ADR-0027"构建时打包，不运行时加载"）：
// - disable(name)：停用它连同依赖它的（依赖方先停，都记成停用了），视图摘下；
// - enable(name)：启用它连同它要的、没开的（按依赖排顺序装配、启动），视图登记回去、整表补齐；因为它没开而没装上的（启用着的）跟着装上；
// - remove(name)：停用它（依赖它的一起停用），它自己记成移除了；"装回"就是 enable。连数据删在宿主之外（removal.ts），删什么由插件在
//   数据契约里写明（removal.declare）。
// 配置 plugins.disabled / removed 由设置那一层写（plugins/settings.ts），宿主只管装和停。
import { forModel, type PluginInfo, type PluginStatusView, t } from "@ergo/protocol";
import type { AgentContributions, ContextContribution, HookContribution, NoteContribution, ToolContribution } from "../agent-host/contributions.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { AppRegistration, AppRegistry } from "../apps/registry.ts";
import type { BoardKind } from "../board/kinds.ts";
import type { DataSource } from "../data-sources/api.ts";
import type { DataSourceRegistry } from "../data-sources/registry.ts";
import type { CardTypeDefinition } from "../cards/registry.ts";
import { RequestRejected } from "../errors.ts";
import type { EventSubscriberKind } from "../event-sources/triggers.ts";
import type { DerivedView } from "../events/event-store.ts";
import type { PurgeQuotes, PurgeRewriter } from "../events/purge.ts";
import type { RequestHandlers } from "../gateway/gateway.ts";
import type { MaterialSource } from "../materials/capture.ts";
import type { OperationMeans } from "../projects/api.ts";
import type { PluginPrompts } from "../prompts/index.ts";
import type { AgentRuntime, RuntimeRegistry } from "../runtime/index.ts";
import type { QuickActionExecutor } from "../quick-actions/registry.ts";
import type { InternalJob } from "../scheduler/internal-jobs.ts";
import type { PluginDataRemoval } from "./removal.ts";

/** 撤销函数 */
export type Undo = () => void;

/** 一个服务的名字，带着它的类型（取的时候不用断言） */
export interface ServiceKey<T> {
  readonly id: string;
  /** 只给类型推导用，没有值 */
  readonly __service?: T;
}

export function serviceKey<T>(id: string): ServiceKey<T> {
  return { id };
}

/** 内核在 setup 时交给宿主的一个服务 */
export interface BoundService {
  readonly key: ServiceKey<unknown>;
  readonly value: unknown;
}

export function bindService<T>(key: ServiceKey<T>, value: T): BoundService {
  return { key, value };
}

/** 网关的请求里可选的那些（插件经契约登记的只能是它们） */
type OptionalKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never }[keyof T];
export type PluginRequestName = OptionalKeys<RequestHandlers>;
export type PluginRequests = { [K in PluginRequestName]?: RequestHandlers[K] };

/** 内核的登记表（每次登记返回撤销函数）：宿主把插件的登记转给它们、记下撤销函数 */
export interface PluginSurfaces {
  cardTypes: { register(definition: CardTypeDefinition): Undo };
  purge: { register(...rewriters: PurgeRewriter[]): Undo; registerQuotes(...quotes: PurgeQuotes[]): Undo };
  materialSources: { register(source: MaterialSource): Undo };
  quickActions: { register(executor: QuickActionExecutor): Undo };
  internalJobs: { register(job: InternalJob): Undo };
  boardKinds: { register(kind: BoardKind<unknown>): Undo };
  eventSubscribers: { register(kind: EventSubscriberKind): Undo };
  /** 运营手段（130 号票，operations/means.ts）：运营方案里每一条用的手段 */
  operationMeans: { register(means: OperationMeans): Undo };
  /** agent 贡献（128 号票）：工具、每轮的上下文块、钩子订阅；212 号票加了输入附注 */
  agent: Pick<AgentContributions, "tools" | "context" | "hooks" | "notes">;
  /** 转发登记表（132 号票）：/apps/<应用名>/ 转发到本机的哪个地址 */
  apps: Pick<AppRegistry, "register">;
  /**
   * 运行中停用插件时，它的视图从事件存储上摘下（EventStore.detachView）；运行中启用时登记回去、整表补齐（EventStore.attachView，211 号票）
   */
  views: { detach(name: string): void; attach(view: DerivedView): void };
  /** agent 运行时的登记表（286 号票，runtime/runtimes.ts）：插件在数据契约里登记的运行时进这里，带上插件名和"在不在运行" */
  runtimes: Pick<RuntimeRegistry, "register">;
  /** 数据源的登记表（295 号票，data-sources/registry.ts）：插件在数据契约里登记的数据源进这里，带上插件名和"在不在运行" */
  dataSources: Pick<DataSourceRegistry, "register">;
}

/** 插件自己的 start/stop：宿主按依赖顺序叫 start，停用时（依赖它的先停）叫 stop */
export interface PluginLifecycle {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/** 数据契约的登记：不管插件开没开都登记，停用不撤（见文件头） */
export interface ContractContext {
  readonly plugin: string;
  readonly cardTypes: { register(definition: CardTypeDefinition): void };
  readonly purge: { register(...rewriters: PurgeRewriter[]): void; registerQuotes(...quotes: PurgeQuotes[]): void };
  /**
   * 插件拥有的事件怎么变成素材（129 号票）：声明进内核的素材库（materials/）。素材库按它给本人的话留原话副本（停用也照样，用户的数据承诺），
   * 记忆插件开着时按它采成素材
   */
  readonly materialSources: { register(source: MaterialSource): void };
  /** 前端请求（网关的 RequestHandlers 里可选的那些）：一个请求只能有一个插件登记 */
  readonly requests: { register<K extends PluginRequestName>(name: K, handler: NonNullable<RequestHandlers[K]>): void };
  /**
   * 移除时"连它的数据一起彻底删除"删什么（211 号票，removal.ts）：它拥有的事件、卡片类型、待我处理里的通知、自己的文件，
   * 和给人看的"删哪些""删不掉的"。一个插件写一次；不写的插件在设置里没有这个勾选
   */
  readonly removal: { declare(spec: PluginDataRemoval): void };
  /**
   * agent 运行时（286 号票，"运行时"贡献点，runtime/runtimes.ts 的 AgentRuntime）：id、给人看的名字、子进程入口（实现宿主协议）、
   * 能力清单、可选模型和设置项、列本机能接管的会话。和别的契约一样不管插件开没开都登记（维护者记着的运行时在插件停用时也认得，
   * 写得出"X插件没启用"）；能不能用跟着插件在不在运行——停用时用它的维护者不启动、执行中的任务转等我，启用后接着。
   * 要用插件服务的（列会话）在函数里经 active() 现取
   */
  readonly runtimes: { register(runtime: AgentRuntime): void };
  /**
   * 数据源（295 号票，"数据源"贡献点，data-sources/api.ts 的 DataSource）：id、名字、敏感类别、两种用法（按需查 / 导入）和默认、
   * 定期导入的时间、它导入的记录（事件）、认导入文件夹里哪种文件，连同连接状态、填设置、同步、导入一个文件、断开时的清理、按需查的工具。
   * 和别的契约一样不管插件开没开都登记（设置 · 数据源照样列出、写"X插件没启用"，断开并删照样删得掉、条数照样数得出）；
   * 要插件在运行的函数里经 active() 现取，内核只在插件在运行时叫它们
   */
  readonly dataSources: { register(source: DataSource): void };
  /**
   * 本插件提供的服务：插件在运行时给出；没在运行（配置里停用了、缺依赖没装、装配出错、停用了）时抛 RequestRejected
   * （not_allowed，"X插件没启用"）。卡片动作、前端请求里现取（不要存起来）
   */
  active<T>(key: ServiceKey<T>): T;
}

/** 装配时宿主给插件的上下文：每次登记返回撤销函数，同时记在插件名下 */
export interface PluginContext {
  readonly plugin: string;
  log(line: string): void;
  /** needs 里声明了的服务（内核的或别的插件的）；插件活着时一直在 */
  use<T>(key: ServiceKey<T>): T;
  /** wants（或 needs）里声明了的服务，现取：提供它的插件没装、停了是 undefined。不要存起来 */
  optional<T>(key: ServiceKey<T>): T | undefined;
  /** provides 里声明了的服务：登记它的值（停用时拿掉） */
  provide<T>(key: ServiceKey<T>, value: T): void;
  readonly cardTypes: { register(definition: CardTypeDefinition): Undo };
  readonly purge: { register(...rewriters: PurgeRewriter[]): Undo; registerQuotes(...quotes: PurgeQuotes[]): Undo };
  readonly quickActions: { register(executor: QuickActionExecutor): Undo };
  readonly internalJobs: { register(job: InternalJob): Undo };
  readonly boardKinds: { register(kind: BoardKind<unknown>): Undo };
  readonly eventSubscribers: { register(kind: EventSubscriberKind): Undo };
  /** 运营手段（130 号票）：运营方案里每一条用的手段（校验、给人看的说法、生效、撤销、暂停和恢复）；停用后交新方案时不认它 */
  readonly operationMeans: { register(means: OperationMeans): Undo };
  /**
   * agent 贡献（128 号票，见 agent-host/contributions.ts）：给 agent 的工具（HostTool 自带守卫的登记）、每轮的上下文块、钩子订阅，
   * 按"给谁"（哪种 agent、哪种会话、工具包）写明；上下文块（wake）、钩子订阅的 id 在插件里不重复，宿主在前面加上"插件名:"
   */
  readonly agent: {
    readonly tools: { register(contribution: ToolContribution): Undo };
    readonly context: { register(contribution: ContextContribution): Undo };
    readonly hooks: { register(contribution: HookContribution): Undo };
    /** 输入附注（212 号票）：接在交给 agent 的那条输入自己的文字末尾（浏览侧边栏、悬浮按钮发的消息后面那段网页上下文） */
    readonly notes: { register(contribution: NoteContribution): Undo };
  };
  /**
   * 转发登记表（132 号票，apps/registry.ts）：登记一个应用名对应本机的一个地址，网关把 /apps/<应用名>/… 转发过去；
   * 撤销（停用）以后 404、开着的 WebSocket 断开
   */
  readonly apps: { register(app: AppRegistration): Undo };
  /** 定时器、订阅、事件监听这类：执行 execute，记下它返回的撤销函数（store.onAppend、workdayCalendar.onChange 直接交进来） */
  effect(execute: () => Undo | void): Undo;
  /** 插件自己的 start/stop（可以叫几次，按先后 start、倒着 stop） */
  lifecycle(hooks: PluginLifecycle): void;
}

/** 一个插件 */
export interface PluginDefinition {
  /** 插件名：小写英文，配置 plugins.disabled 里写的就是它，定了别改 */
  name: string;
  /** 中文名："提醒"（日志、"提醒插件没启用"里用） */
  title: string;
  /** 设置 · 插件里一句话说它是做什么的（211 号票）：取值函数，跟着当前语言 */
  readonly summary?: string;
  /**
   * 设置 · 插件里列的"它带来了什么"（211 号票，守护进程这一半）：给 agent 的工具、卡片、定时作业给人看的名字。取值函数，跟着当前语言。
   * 工具的个数要和它实际登记的对上（主切面测试比对秘书拿到的）；网页上的页面、栏目由网页插件自己写
   */
  readonly brings?: { readonly tools?: readonly string[]; readonly cards?: readonly string[]; readonly jobs?: readonly string[] };
  /** 要的服务（内核的或别的插件的）：缺一个就不装 */
  needs?: readonly ServiceKey<unknown>[];
  /** 可选的服务：在的话先装提供它的插件；不在照装 */
  wants?: readonly ServiceKey<unknown>[];
  /** 提供的服务（装配时 provide；没登记齐算装配出错） */
  provides?: readonly ServiceKey<unknown>[];
  /** 派生视图：宿主在打开事件存储之前收齐 */
  views?: readonly DerivedView[];
  /**
   * 它要的外部组件（不随二狗分发、用的人自己装的，315 号票：Claude Code 的 Agent SDK）没装时给人看的一句：没装什么、怎么装；装着是 undefined。
   * 每次装配之前问一次：没装的不装配（记成没装上，设置 · 插件里写"没装"和这一句、启用不了），运行时写这一句而不是"没启用"；
   * 装好以后启用（或重启守护进程）就装上。数据契约照常登记
   */
  missing?(ctx: MissingContext): string | undefined;
  /** 数据契约：不管插件开没开都登记，停用不撤 */
  contracts?(ctx: ContractContext): void;
  /**
   * 系统提示里的（128 号票）：一个条件（插件运行时成立）、公用的占位符（工具名）、片段。和数据契约一样不管插件开没开都在，
   * 宿主建的时候收齐交给系统提示的文件；plugin 要写成这个插件的名字
   */
  prompts?: PluginPrompts;
  /** 装配：经 ctx 登记、提供服务、声明 start/stop */
  setup(ctx: PluginContext): void | Promise<void>;
}

/** 插件的状况（健康信息、启动日志） */
export interface PluginReport {
  /** 在运行的，按装的顺序 */
  running: string[];
  /** 配置里停用的（和运行中停用的，连同跟着一起停的） */
  disabled: string[];
  /** 没装上的和原因：缺依赖、循环依赖、装配或启动出错、依赖的插件停了 */
  skipped: Array<{ plugin: string; reason: string }>;
  /** 移除了的（211 号票；没有就不写） */
  removed?: string[];
}

/** 问"外部组件装没装"时宿主给的（318 号票）：组件区在哪（用的人在设置 · 组件里装的东西放那里） */
export interface MissingContext {
  componentsDir?: string;
}

export interface PluginHostOptions {
  /** 插件清单 */
  plugins: readonly PluginDefinition[];
  /** 配置里停用的插件名（plugins.disabled） */
  disabled?: readonly string[];
  /** 配置里移除了的插件名（plugins.removed，211 号票；两边都写了的算移除） */
  removed?: readonly string[];
  /** 内核提供的服务（setup 时要一个不少地交来） */
  kernel: readonly ServiceKey<unknown>[];
  /** 组件区（数据目录的 components\，318 号票）：问插件要的外部组件装没装时交给它（PluginDefinition.missing） */
  componentsDir?: string;
  log: (line: string) => void;
}

export interface KernelBinding {
  services: readonly BoundService[];
  surfaces: PluginSurfaces;
}

export interface PluginHost {
  /** 要装的插件声明的视图（打开事件存储时登记） */
  views(): DerivedView[];
  /** 不装的插件声明的视图名（事件存储记成停着的） */
  dormantViews(): string[];
  /** 全部插件的契约，再按依赖顺序装配要装的 */
  setup(kernel: KernelBinding): Promise<void>;
  /** 按顺序叫各插件的 start */
  start(): Promise<void>;
  /**
   * 运行中停用一个插件，连同依赖它的（依赖它的先停，都记成停用了）；视图摘下。返回状况变了的（按装的先后）。
   * 没装上的停用：记成停用了；移除了的不动
   */
  disable(name: string): Promise<string[]>;
  /**
   * 运行中启用一个插件（211 号票；移除了的就是装回），连同它要的、没开的：按依赖排顺序装配、启动，视图登记回去、整表补齐；
   * 因为它没开而没装上的（启用着的）跟着装上。返回装上了的（按装的先后）；装配、启动出错的记成没装上（原因在 info/status 里）。
   * 启用不了（要的服务没有谁提供、循环依赖）抛 RequestRejected（not_allowed，给人看的原因）
   */
  enable(name: string): Promise<string[]>;
  /** 移除一个插件（211 号票）：停用它（依赖它的一起停用），它自己记成移除了。返回状况变了的（按装的先后，它自己最后） */
  remove(name: string): Promise<string[]>;
  /** 守护进程停：在运行的倒着停（依赖方先停），最后撤契约 */
  stop(): Promise<void>;
  /** 内核按名字取插件提供的服务（也能取内核的）：插件没装、停了是 undefined。现取，不要存起来 */
  service<T>(key: ServiceKey<T>): T | undefined;
  /**
   * 同 service，但提供它的插件没在运行（配置里停用了、没装上、运行中停用、移除了）时抛 RequestRejected（not_allowed，"X插件没启用"，
   * X 是提供它的插件给人看的名字）：内核替插件接前端请求时用（213 号票：网关的 GET /api/calendar 回"日历插件没启用"）。
   * 谁都不提供的服务是写错了代码（抛 Error）。现取，不要存起来
   */
  active<T>(key: ServiceKey<T>): T;
  /** 契约登记的前端请求（合进网关的请求处理） */
  requests(): PluginRequests;
  /** 清单里各插件在系统提示里的（条件、占位符、片段；停用的也在），按清单的先后 */
  prompts(): PluginPrompts[];
  /** 这个插件在运行（装配好了、启动了）没有：系统提示里插件的条件按它 */
  running(name: string): boolean;
  /** 清单里有没有这个插件 */
  has(name: string): boolean;
  report(): PluginReport;
  /**
   * 清单里每个插件现在的状况，按清单的先后（193 号票：插件频道上推给网页，网页按它装、停自己的网页插件）。
   * 给人看的名字按当前语言现取；没装上的带原因
   */
  status(): PluginStatusView[];
  /** 设置 · 插件的清单（211 号票）：清单里每个插件给人看的样子，按清单的先后 */
  info(): PluginInfo[];
  /** 插件在数据契约里写明的"连数据删"（211 号票）；没写的、不认得的是 undefined */
  removalOf(name: string): PluginDataRemoval | undefined;
  /** 插件在定义里声明的派生视图（215 号票：移除并连数据删之后，设置那一层把它停着的视图按改写后的日志补一遍）；不认得的是空的 */
  viewsOf(name: string): readonly DerivedView[];
  /** 插件的状况变了（运行中停用、启用、移除）时叫 fn；返回取消登记的函数 */
  onChange(fn: () => void): () => void;
}

type SlotState = "pending" | "ready" | "running" | "disabled" | "skipped" | "stopped" | "removed";

interface Slot {
  def: PluginDefinition;
  state: SlotState;
  /** 给开发者看的原因（日志、健康检查） */
  reason?: string;
  /** 没装上时给人看的说法（211 号票，设置 · 插件）：取值函数，跟着当前语言 */
  problem?: () => string;
  /** 没装上是因为它要的外部组件没装（315 号票，PluginDefinition.missing）：那时的那一句 */
  missing?: string;
  /** 这一次装配：活着的时候才能经它登记；停了以后它给 agent 的工具回"没启用"。每次装配换一个 */
  life: { alive: boolean };
  /** 登记的撤销函数，按登记的先后 */
  undos: Array<{ label: string; undo: () => void | Promise<void> }>;
  lifecycles: PluginLifecycle[];
}

const KERNEL_OWNER = "";
/** 一组服务名 */
const ids = (keys: readonly ServiceKey<unknown>[] | undefined) => (keys ?? []).map((k) => k.id);
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 没装上、启用不了时给人看的说法（211 号票）：取值函数，跟着当前语言 */
const problems = {
  missingService: (service: string) => () => t("plugins.problem.missingService", { service }),
  providerOff: (provider: Slot) => () => t("plugins.problem.providerOff", { title: provider.def.title }),
  providerFailed: (provider: Slot) => () => t("plugins.problem.providerFailed", { title: provider.def.title }),
  cycle: (cycle: readonly Slot[]) => () => t("plugins.problem.cycle", { plugins: cycle.map((s) => s.def.title).join(" → ") }),
  failed: (stage: "setup" | "start", message: string) => () => t(stage === "setup" ? "plugins.problem.setupFailed" : "plugins.problem.startFailed", { message }),
};

/** 停用后正在跑的一轮里再调它给 agent 的工具：交回模型的话（给模型看的，不翻） */
const toolOffText = (title: string, tool: string) => `${title}插件没启用：现在用不了 ${tool}（用户停用了这个插件）。如实告诉用户，不要说已经做好了。`; // @i18n-ignore model：交给 agent 的工具结果

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const { log } = options;
  const missingCtx: MissingContext = options.componentsDir === undefined ? {} : { componentsDir: options.componentsDir };
  const slots: Slot[] = [];
  const byName = new Map<string, Slot>();
  for (const def of options.plugins) {
    if (byName.has(def.name)) throw new Error(`插件清单里有两个 ${def.name}`);
    if (def.prompts && def.prompts.plugin !== def.name) throw new Error(`插件 ${def.name} 在系统提示里的贡献写成了 ${def.prompts.plugin} 的`);
    const slot: Slot = { def, state: "pending", life: { alive: false }, undos: [], lifecycles: [] };
    slots.push(slot);
    byName.set(def.name, slot);
  }

  // 谁提供哪个服务（停用了的插件也算上，原因才写得清）
  const providers = new Map<string, string>();
  for (const key of options.kernel) providers.set(key.id, KERNEL_OWNER);
  for (const slot of slots) {
    for (const id of ids(slot.def.provides)) {
      const other = providers.get(id);
      if (other !== undefined) throw new Error(`服务 ${id} 有两个提供者：${other === KERNEL_OWNER ? "内核" : `插件 ${other}`}、插件 ${slot.def.name}`);
      providers.set(id, slot.def.name);
    }
  }

  const disabled = new Set(options.disabled ?? []);
  const removed = new Set(options.removed ?? []);
  for (const [key, names] of [
    ["disabled", disabled],
    ["removed", removed],
  ] as const) {
    const unknown = [...names].filter((name) => !byName.has(name));
    if (unknown.length > 0) log(`配置 plugins.${key} 里的 ${unknown.join("、")} 不是认得的插件（认得的：${slots.map((s) => s.def.name).join("、") || "没有"}），不管它`);
  }
  for (const slot of slots) {
    if (removed.has(slot.def.name)) {
      slot.state = "removed";
      slot.reason = "配置里移除了";
    } else if (disabled.has(slot.def.name)) {
      slot.state = "disabled";
      slot.reason = "配置里停用了";
    }
  }

  const skip = (slot: Slot, reason: string, problem: () => string) => {
    slot.state = "skipped";
    slot.reason = reason;
    slot.problem = problem;
  };
  const pluginOf = (id: string): Slot | undefined => {
    const owner = providers.get(id);
    return owner === undefined || owner === KERNEL_OWNER ? undefined : byName.get(owner);
  };
  /** 停用了或移除了（用户关掉的） */
  const off = (slot: Slot) => slot.state === "disabled" || slot.state === "removed";

  /** 要的服务缺了的不装（反复看，直到不再有变化：不装的插件提供的服务也算缺） */
  const dropMissing = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const slot of slots.filter((s) => s.state === "pending")) {
        for (const id of ids(slot.def.needs)) {
          const owner = providers.get(id);
          const provider = pluginOf(id);
          if (owner === undefined) skip(slot, `要的服务 ${id} 没有谁提供`, problems.missingService(id));
          else if (provider && provider.state !== "pending") {
            const why = off(provider) ? `它在配置里${provider.state === "removed" ? "移除" : "停用"}了` : `它没装（${provider.reason}）`;
            skip(slot, `要的服务 ${id} 由插件 ${provider.def.name} 提供，${why}`, off(provider) ? problems.providerOff(provider) : problems.providerFailed(provider));
          } else continue;
          changed = true;
          break;
        }
      }
    }
  };

  /** 依赖的插件（还要装的）：needs 的，加上 withWants 时 wants 的 */
  const depsOf = (slot: Slot, withWants: boolean): Slot[] =>
    [...ids(slot.def.needs), ...(withWants ? ids(slot.def.wants) : [])].flatMap((id) => {
      const provider = pluginOf(id);
      return provider && provider !== slot && provider.state === "pending" ? [provider] : [];
    });

  /** 按依赖排顺序（同等的按清单的先后）；排不下去的（循环依赖）把那一圈标成不装，再来 */
  const order: Slot[] = [];
  /** 循环依赖的（启用不了）：插件 → 那一圈 */
  const cycles = new Map<Slot, Slot[]>();
  for (;;) {
    dropMissing();
    const pending = slots.filter((s) => s.state === "pending");
    const placed = new Set<Slot>();
    const out: Slot[] = [];
    while (out.length < pending.length) {
      const ready = (withWants: boolean) => pending.find((s) => !placed.has(s) && depsOf(s, withWants).every((d) => placed.has(d)));
      // 可选依赖只管先后：排不下去时不看它
      const next = ready(true) ?? ready(false);
      if (!next) break;
      placed.add(next);
      out.push(next);
    }
    if (out.length === pending.length) {
      order.push(...out);
      break;
    }
    // 找一圈：从一个排不下去的出发，顺着必需的依赖走，回到走过的就是一圈
    const stuck = pending.filter((s) => !placed.has(s));
    const path: Slot[] = [];
    let at: Slot | undefined = stuck[0];
    while (at && !path.includes(at)) {
      path.push(at);
      at = depsOf(at, false).find((d) => !placed.has(d));
    }
    const cycle = at ? path.slice(path.indexOf(at)) : stuck;
    const text = [...cycle, cycle[0]!].map((s) => s.def.name).join(" → ");
    for (const slot of cycle) {
      skip(slot, `循环依赖：${text}`, problems.cycle([...cycle, cycle[0]!]));
      cycles.set(slot, cycle);
    }
  }

  for (const slot of slots) {
    if (slot.state === "disabled") log(`插件 ${slot.def.name}（${slot.def.title}）在配置里停用了`);
    else if (slot.state === "removed") log(`插件 ${slot.def.name}（${slot.def.title}）在配置里移除了`);
    else if (slot.state === "skipped") log(`插件 ${slot.def.name}（${slot.def.title}）没装：${slot.reason}`);
  }

  // 装配之后
  const services = new Map<string, { owner: string; value: unknown }>();
  const contractUndos: Undo[] = [];
  const requests: PluginRequests = {};
  /** 插件在数据契约里写明的"连数据删"（211 号票） */
  const removals = new Map<string, PluginDataRemoval>();
  let surfaces: PluginSurfaces | undefined;
  let setupDone = false;
  let stopped = false;
  const changeListeners = new Set<() => void>();
  const changed = () => {
    for (const fn of changeListeners) fn();
  };

  const active = (slot: Slot) => slot.state === "ready" || slot.state === "running";

  const lookup = <T>(key: ServiceKey<T>): T | undefined => {
    const entry = services.get(key.id);
    if (!entry) return undefined;
    if (entry.owner !== KERNEL_OWNER && !active(byName.get(entry.owner)!)) return undefined;
    return entry.value as T;
  };

  /** 依赖这个插件（必需）的插件，连同它们的依赖方，按装的顺序（只算在运行的） */
  const dependentsOf = (root: Slot): Slot[] => {
    const found = new Set<Slot>([root]);
    for (let changing = true; changing; ) {
      changing = false;
      for (const slot of order) {
        if (found.has(slot) || !active(slot)) continue;
        if (
          ids(slot.def.needs).some((id) => {
            const provider = pluginOf(id);
            return provider !== undefined && found.has(provider);
          })
        ) {
          found.add(slot);
          changing = true;
        }
      }
    }
    found.delete(root);
    return order.filter((s) => found.has(s));
  };

  /**
   * 启用一个插件要一起装的（211 号票）：它和它要的、没在运行的（顺着必需的依赖走），按依赖排好（同等的按清单的先后）；
   * 要的服务没有谁提供、循环依赖的启用不了，交回给人看的原因
   */
  const enablePlan = (root: Slot): { targets: Slot[] } | { problem: () => string } => {
    const cycle = cycles.get(root);
    if (cycle) return { problem: problems.cycle([...cycle, cycle[0]!]) };
    const found = new Set<Slot>();
    const stack = [root];
    while (stack.length > 0) {
      const slot = stack.pop()!;
      if (found.has(slot)) continue;
      found.add(slot);
      for (const id of ids(slot.def.needs)) {
        if (!providers.has(id)) return { problem: problems.missingService(id) };
        const provider = pluginOf(id);
        if (provider && !active(provider)) {
          const inCycle = cycles.get(provider);
          if (inCycle) return { problem: problems.cycle([...inCycle, inCycle[0]!]) };
          stack.push(provider);
        }
      }
    }
    const within = (slot: Slot, withWants: boolean) =>
      [...ids(slot.def.needs), ...(withWants ? ids(slot.def.wants) : [])].flatMap((id) => {
        const provider = pluginOf(id);
        return provider && provider !== slot && found.has(provider) ? [provider] : [];
      });
    const targets: Slot[] = [];
    const placed = new Set<Slot>();
    while (targets.length < found.size) {
      const ready = (withWants: boolean) => slots.find((s) => found.has(s) && !placed.has(s) && within(s, withWants).every((d) => placed.has(d)));
      const next = ready(true) ?? ready(false);
      // 排不下去：运行中不会出现（循环依赖的启动时就记下了），保险起见当成循环依赖
      if (!next) return { problem: problems.cycle([...found].filter((s) => !placed.has(s))) };
      placed.add(next);
      targets.push(next);
    }
    // 它（或它要的）用的外部组件没装（315 号票）：装好之前启用不了
    for (const slot of targets) {
      const what = slot.def.missing?.(missingCtx);
      if (what !== undefined) return { problem: () => slot.def.missing?.(missingCtx) ?? what };
    }
    return { targets };
  };

  /** 撤掉一个插件登记的全部（倒着撤；单个出错只记日志） */
  const dispose = async (slot: Slot) => {
    slot.life.alive = false;
    for (const { label, undo } of slot.undos.splice(0).toReversed()) {
      try {
        await undo();
      } catch (err) {
        log(`插件 ${slot.def.name} 撤销 ${label} 出错：${describe(err)}`);
      }
    }
  };

  /** 停掉一组插件（依赖方先停：倒着装的顺序），各自记下状况 */
  const disposeAll = async (targets: readonly Slot[], mark: (slot: Slot) => { state: SlotState; reason?: string }) => {
    for (const slot of targets.toSorted((a, b) => order.indexOf(b) - order.indexOf(a))) {
      await dispose(slot);
      const { state, reason } = mark(slot);
      slot.state = state;
      if (reason === undefined) delete slot.reason;
      else slot.reason = reason;
      delete slot.problem;
      delete slot.missing;
    }
  };

  /** 视图从事件存储上摘下（记成停着的） */
  const detachViews = (targets: readonly Slot[]) => {
    for (const slot of targets) for (const view of slot.def.views ?? []) surfaces?.views.detach(view.name);
  };

  /** 装配或启动出错：这个插件连同依赖它的都撤掉，视图摘下 */
  const failed = async (slot: Slot, stage: "setup" | "start", err: unknown) => {
    const what = stage === "setup" ? "装配" : "启动";
    const reason = `${what}出错：${describe(err)}`;
    log(`插件 ${slot.def.name}（${slot.def.title}）${reason}，没装上`);
    const targets = [...dependentsOf(slot), slot];
    await disposeAll(targets, (s) => ({ state: "skipped", reason: s === slot ? reason : `依赖的插件 ${slot.def.name} ${what}出错了` }));
    for (const target of targets) target.problem = target === slot ? problems.failed(stage, describe(err)) : problems.providerFailed(slot);
    detachViews(targets);
  };

  /** 依赖的插件这次没装上（排在前面的装配出错了）：记成没装上，交回 true */
  const brokenDependency = (slot: Slot): boolean => {
    const broken = ids(slot.def.needs)
      .map(pluginOf)
      .find((p) => p !== undefined && !active(p));
    if (!broken) return false;
    skip(slot, `依赖的插件 ${broken.def.name} 没装上（${broken.reason}）`, off(broken) ? problems.providerOff(broken) : problems.providerFailed(broken));
    log(`插件 ${slot.def.name}（${slot.def.title}）没装：${slot.reason}`);
    detachViews([slot]);
    return true;
  };

  /** 它要的外部组件没装（315 号票）：给人看的那一句（跟着当前语言现取，装好了还没重装时用记下的）；不是因为这个没装上的是 undefined */
  const missingNote = (slot: Slot): string | undefined => (slot.missing === undefined ? undefined : (slot.def.missing?.(missingCtx) ?? slot.missing));

  /** 它要的外部组件没装（315 号票）：不装配，记成没装上（原因是那一句），视图摘下；交回 true。装着的交回 false */
  const notInstalled = (slot: Slot): boolean => {
    const what = slot.def.missing?.(missingCtx);
    if (what === undefined) return false;
    skip(slot, `要的外部组件没装：${what}`, () => missingNote(slot) ?? what);
    slot.missing = what;
    log(`插件 ${slot.def.name}（${slot.def.title}）没装：${slot.reason}`);
    detachViews([slot]);
    return true;
  };

  /** 装配一个插件（新的一次：登记、生命周期都从空的开始）；出错的撤掉、外部组件没装的不装，都交回 false */
  const setupOne = async (slot: Slot): Promise<boolean> => {
    slot.state = "pending";
    delete slot.reason;
    delete slot.problem;
    delete slot.missing;
    if (notInstalled(slot)) return false;
    slot.life = { alive: true };
    slot.lifecycles = [];
    try {
      await slot.def.setup(pluginContext(slot));
      const notProvided = ids(slot.def.provides).filter((id) => services.get(id)?.owner !== slot.def.name);
      if (notProvided.length > 0) throw new Error(`声明了提供服务 ${notProvided.join("、")}，装配时没有 provide`);
      slot.state = "ready";
      return true;
    } catch (err) {
      await failed(slot, "setup", err);
      return false;
    }
  };

  /** 启动一个装配好的插件；出错的撤掉 */
  const startOne = async (slot: Slot) => {
    try {
      for (const hooks of slot.lifecycles) {
        await hooks.start?.();
        const stop = hooks.stop;
        if (stop) slot.undos.push({ label: "stop", undo: () => stop.call(hooks) });
      }
      slot.state = "running";
    } catch (err) {
      await failed(slot, "start", err);
    }
  };

  const contractContext = (slot: Slot): ContractContext => {
    const own = ids(slot.def.provides);
    return {
      plugin: slot.def.name,
      cardTypes: { register: (definition) => void contractUndos.push(surfaces!.cardTypes.register(definition)) },
      purge: {
        register: (...rewriters) => void contractUndos.push(surfaces!.purge.register(...rewriters)),
        registerQuotes: (...quotes) => void contractUndos.push(surfaces!.purge.registerQuotes(...quotes)),
      },
      materialSources: { register: (source) => void contractUndos.push(surfaces!.materialSources.register(source)) },
      requests: {
        register(name, handler) {
          if (requests[name] !== undefined) throw new Error(`前端请求 ${name} 已经有插件登记了`);
          (requests as Record<string, unknown>)[name] = handler;
        },
      },
      removal: {
        declare(spec) {
          if (removals.has(slot.def.name)) throw new Error(`插件 ${slot.def.name} 的"连数据删"已经写过了`);
          removals.set(slot.def.name, spec);
        },
      },
      runtimes: {
        // 登记表记下是哪个插件的：不能用时写得出"X插件没启用"（插件给人看的名字现取，跟着语言），能不能用看插件此刻在不在运行
        register: (runtime) =>
          void contractUndos.push(
            surfaces!.runtimes.register(runtime, {
              plugin: slot.def.name,
              get title() {
                return slot.def.title;
              },
              running: () => active(slot),
              // 没装上是因为外部组件没装（315 号票）：运行时写这一句（没装什么、怎么装），不写"没启用"
              missing: () => (active(slot) ? undefined : missingNote(slot)),
            }),
          ),
      },
      dataSources: {
        // 同运行时：登记表记下是哪个插件的，能不能同步、按需查看插件此刻在不在运行
        register: (source) =>
          void contractUndos.push(
            surfaces!.dataSources.register(source, {
              plugin: slot.def.name,
              get title() {
                return slot.def.title;
              },
              running: () => active(slot),
            }),
          ),
      },
      active<T>(key: ServiceKey<T>): T {
        if (!own.includes(key.id)) throw new Error(`插件 ${slot.def.name} 的契约只能取它自己提供的服务，${key.id} 不是`);
        const entry = services.get(key.id);
        if (entry && entry.owner === slot.def.name && active(slot)) return entry.value as T;
        throw new RequestRejected("not_allowed", t("plugins.notEnabled", { title: slot.def.title }));
      },
    };
  };

  const pluginContext = (slot: Slot): PluginContext => {
    const name = slot.def.name;
    const needs = ids(slot.def.needs);
    const wants = ids(slot.def.wants);
    const provides = ids(slot.def.provides);
    /** 这一次装配（停了就不再活着；再启用是新的一次） */
    const life = slot.life;
    /**
     * 给 agent 的工具包一层（211 号票）：这一次装配停了以后（运行中停用），还没按新的贡献重新装配的 agent 在正在跑的一轮里再调它，
     * 回"X插件没启用"（isError），不做。同一个工具包出来的是同一个
     */
    const wrapped = new WeakMap<HostTool, HostTool>();
    const guardTool = (tool: HostTool): HostTool => {
      let out = wrapped.get(tool);
      if (!out) {
        out = { ...tool, run: (args, call) => (life.alive ? tool.run(args, call) : { text: toolOffText(forModel(() => slot.def.title), tool.spec.name), isError: true }) };
        wrapped.set(tool, out);
      }
      return out;
    };
    /** 记下一次登记；返回的撤销函数可以提前叫（只撤一次） */
    const record = (what: string, undo: () => void | Promise<void>): Undo => {
      const entry = { label: what, undo };
      slot.undos.push(entry);
      return () => {
        const at = slot.undos.indexOf(entry);
        if (at < 0) return;
        slot.undos.splice(at, 1);
        void undo();
      };
    };
    /** 停了（或还没开始装）以后再登记：报错 */
    const guard = (what: string) => {
      if (!life.alive) throw new Error(`插件 ${name} 已经停了，不能再${what}`);
    };
    const registrar =
      <A extends unknown[]>(what: (...args: A) => string, register: (...args: A) => Undo) =>
      (...args: A): Undo => {
        guard(`登记${what(...args)}`);
        return record(what(...args), register(...args));
      };
    return {
      plugin: name,
      log,
      use<T>(key: ServiceKey<T>): T {
        if (!needs.includes(key.id)) throw new Error(`插件 ${name} 要用服务 ${key.id}：先在 needs 里声明`);
        return services.get(key.id)!.value as T;
      },
      optional<T>(key: ServiceKey<T>): T | undefined {
        if (!wants.includes(key.id) && !needs.includes(key.id)) throw new Error(`插件 ${name} 要用服务 ${key.id}：先在 wants 里声明`);
        return lookup(key);
      },
      provide<T>(key: ServiceKey<T>, value: T) {
        guard(`提供服务 ${key.id}`);
        if (!provides.includes(key.id)) throw new Error(`插件 ${name} 要提供服务 ${key.id}：先在 provides 里声明`);
        if (services.has(key.id)) throw new Error(`服务 ${key.id} 已经有了`);
        services.set(key.id, { owner: name, value });
        record(`服务 ${key.id}`, () => {
          if (services.get(key.id)?.owner === name) services.delete(key.id);
        });
      },
      cardTypes: { register: registrar((d: CardTypeDefinition) => `卡片类型 ${d.type}`, (d) => surfaces!.cardTypes.register(d)) },
      purge: {
        register: registrar(
          (...rewriters: PurgeRewriter[]) => `改写函数 ${rewriters.map((r) => r.eventType).join("、")}`,
          (...rewriters) => surfaces!.purge.register(...rewriters),
        ),
        registerQuotes: registrar(
          (...quotes: PurgeQuotes[]) => `引用 ${quotes.map((q) => q.eventType).join("、")}`,
          (...quotes) => surfaces!.purge.registerQuotes(...quotes),
        ),
      },
      quickActions: { register: registrar((e: QuickActionExecutor) => `快速动作 ${e.type}`, (e) => surfaces!.quickActions.register(e)) },
      internalJobs: { register: registrar((j: InternalJob) => `内部作业 ${j.name}`, (j) => surfaces!.internalJobs.register(j)) },
      boardKinds: { register: registrar((k: BoardKind<unknown>) => `看板种类 ${k.label}`, (k) => surfaces!.boardKinds.register(k)) },
      eventSubscribers: { register: registrar((k: EventSubscriberKind) => `事件触发的订阅方 ${k.kind}`, (k) => surfaces!.eventSubscribers.register(k)) },
      operationMeans: { register: registrar((m: OperationMeans) => `运营手段 ${m.id}`, (m) => surfaces!.operationMeans.register(m)) },
      agent: {
        tools: { register: registrar((_c: ToolContribution) => "给 agent 的工具", (c) => surfaces!.agent.tools.register({ ...c, tools: (target) => c.tools(target).map(guardTool) })) },
        context: {
          register: registrar(
            (c: ContextContribution) => (c.when === "wake" ? `给 agent 的上下文块 ${name}:${c.id}` : "给 agent 的每轮上下文"),
            (c) => surfaces!.agent.context.register(c.when === "wake" ? { ...c, id: `${name}:${c.id}` } : c),
          ),
        },
        hooks: { register: registrar((c: HookContribution) => `钩子订阅 ${name}:${c.id}`, (c) => surfaces!.agent.hooks.register({ ...c, id: `${name}:${c.id}` })) },
        notes: { register: registrar((_c: NoteContribution) => "给 agent 的输入附注", (c) => surfaces!.agent.notes.register(c)) },
      },
      apps: { register: registrar((a: AppRegistration) => `转发的应用 ${a.name}`, (a) => surfaces!.apps.register(a)) },
      effect(execute) {
        guard("登记定时器、订阅或监听");
        return record("定时器、订阅或监听", execute() ?? (() => {}));
      },
      lifecycle(hooks) {
        guard("声明 start/stop");
        slot.lifecycles.push(hooks);
      },
    };
  };

  /** 运行中停用（连同依赖它的）：依赖方先停，都记成停用了，视图摘下。交回停了的（按装的先后） */
  const disableRunning = async (slot: Slot): Promise<Slot[]> => {
    const targets = [...dependentsOf(slot), slot];
    await disposeAll(targets, (s) => ({ state: "disabled", reason: s === slot ? "运行中停用了" : `随插件 ${slot.def.name} 一起停用了` }));
    detachViews(targets);
    log(`插件停用了：${targets.map((s) => s.def.name).join("、")}`);
    return order.filter((s) => targets.includes(s));
  };

  /** 运行中的操作一个一个来（停用、启用、移除不交叠） */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const usable = (name: string): Slot => {
    const slot = byName.get(name);
    if (!slot) throw new RequestRejected("not_found", t("plugins.unknown", { name }));
    if (!setupDone || stopped) throw new Error(`插件宿主${stopped ? "已经停了" : "还没装配"}，不能运行中停用、启用、移除插件`);
    return slot;
  };

  /** 状况给网页的样子 */
  const stateOf = (s: Slot): PluginStatusView["state"] => (active(s) ? "running" : s.state === "disabled" ? "disabled" : s.state === "removed" ? "removed" : "skipped");
  /** 一组服务由哪些插件提供（插件名，按清单的先后） */
  const pluginsProviding = (keys: readonly ServiceKey<unknown>[] | undefined) => {
    const wanted = new Set(ids(keys).flatMap((id) => (pluginOf(id) ? [pluginOf(id)!] : [])));
    return slots.filter((s) => wanted.has(s)).map((s) => s.def.name);
  };

  return {
    views: () => order.flatMap((s) => s.def.views ?? []),
    dormantViews: () => slots.filter((s) => s.state === "disabled" || s.state === "skipped" || s.state === "removed").flatMap((s) => (s.def.views ?? []).map((v) => v.name)),

    async setup(kernel) {
      if (setupDone) throw new Error("插件宿主已经装配过了");
      setupDone = true;
      surfaces = kernel.surfaces;
      for (const { key, value } of kernel.services) services.set(key.id, { owner: KERNEL_OWNER, value });
      const missing = options.kernel.filter((k) => !services.has(k.id)).map((k) => k.id);
      if (missing.length > 0) throw new Error(`内核没给服务 ${missing.join("、")}`);
      // 契约：全部插件的（停用的、没装上的也登记）
      for (const slot of slots) slot.def.contracts?.(contractContext(slot));
      for (const slot of order) {
        if (slot.state !== "pending") continue;
        // 依赖的插件装配出错了（排在前面）
        if (brokenDependency(slot)) continue;
        await setupOne(slot);
      }
    },

    async start() {
      for (const slot of order) if (slot.state === "ready") await startOne(slot);
    },

    disable: (name) =>
      serial(async () => {
        const slot = usable(name);
        if (slot.state === "skipped") {
          slot.state = "disabled";
          slot.reason = "停用了";
          delete slot.problem;
          delete slot.missing;
          changed();
          return [name];
        }
        if (!active(slot)) return [];
        const stoppedNow = await disableRunning(slot);
        changed();
        return stoppedNow.map((s) => s.def.name);
      }),

    enable: (name) =>
      serial(async () => {
        const root = usable(name);
        if (active(root)) return [];
        const plan = enablePlan(root);
        if ("problem" in plan) throw new RequestRejected("not_allowed", plan.problem());
        const installed: Slot[] = [];
        const install = async (slot: Slot) => {
          // 装的顺序：排到最后（它要的都在前面），停的时候它先停
          if (order.includes(slot)) order.splice(order.indexOf(slot), 1);
          order.push(slot);
          if (brokenDependency(slot)) return;
          for (const view of slot.def.views ?? []) surfaces!.views.attach(view);
          if (!(await setupOne(slot))) return;
          await startOne(slot);
          if (active(slot)) installed.push(slot);
        };
        for (const slot of plan.targets) await install(slot);
        // 因为它（们）没开而没装上的、启用着的插件：要的这次装上了、别的也都在了就跟着装上（反复看，直到不再有）
        for (let more = true; more; ) {
          more = false;
          for (const slot of slots) {
            if (slot.state !== "skipped" || cycles.has(slot)) continue;
            const needs = ids(slot.def.needs);
            const waited = needs.some((id) => installed.some((s) => s === pluginOf(id)));
            const ready = needs.every((id) => {
              if (!providers.has(id)) return false;
              const provider = pluginOf(id);
              return provider === undefined || active(provider);
            });
            if (!waited || !ready) continue;
            await install(slot);
            if (active(slot)) more = true;
          }
        }
        log(`插件启用了：${installed.map((s) => s.def.name).join("、") || "没有"}`);
        changed();
        return installed.map((s) => s.def.name);
      }),

    remove: (name) =>
      serial(async () => {
        const slot = usable(name);
        if (slot.state === "removed") return [];
        const stoppedNow = active(slot) ? await disableRunning(slot) : [];
        slot.state = "removed";
        slot.reason = "移除了";
        delete slot.problem;
        delete slot.missing;
        log(`插件移除了：${name}`);
        changed();
        return [...stoppedNow.filter((s) => s !== slot).map((s) => s.def.name), name];
      }),

    async stop() {
      if (stopped) return;
      stopped = true;
      await queue;
      await disposeAll(
        order.filter((s) => active(s)),
        () => ({ state: "stopped" }),
      );
      for (const undo of contractUndos.splice(0).toReversed()) {
        try {
          undo();
        } catch (err) {
          log(`撤销插件的契约出错：${describe(err)}`);
        }
      }
    },

    service: lookup,
    active<T>(key: ServiceKey<T>): T {
      const value = lookup(key);
      if (value !== undefined) return value;
      const provider = pluginOf(key.id);
      if (!provider) throw new Error(`服务 ${key.id} 不是内核或哪个插件提供的`);
      throw new RequestRejected("not_allowed", t("plugins.notEnabled", { title: provider.def.title }));
    },
    requests: () => ({ ...requests }),
    prompts: () => slots.flatMap((s) => (s.def.prompts ? [s.def.prompts] : [])),
    running(name) {
      const slot = byName.get(name);
      return slot !== undefined && active(slot);
    },
    has: (name) => byName.has(name),
    status: () =>
      slots.map((s): PluginStatusView => {
        const base = { name: s.def.name, title: s.def.title };
        const state = stateOf(s);
        if (state !== "skipped") return { ...base, state };
        return { ...base, state, reason: s.reason ?? (s.state === "stopped" ? "守护进程停了" : "还没装好") };
      }),
    info: () =>
      slots.map((s): PluginInfo => {
        const state = stateOf(s);
        const plan = active(s) ? undefined : enablePlan(s);
        const removal = removals.get(s.def.name);
        const own = new Set(ids(s.def.provides));
        return {
          name: s.def.name,
          title: s.def.title,
          summary: s.def.summary ?? "",
          state,
          ...(state === "skipped" ? { problem: s.problem?.() ?? s.reason ?? "" } : {}),
          ...(state === "skipped" && s.missing !== undefined ? { missing: true as const } : {}),
          brings: { tools: [...(s.def.brings?.tools ?? [])], cards: [...(s.def.brings?.cards ?? [])], jobs: [...(s.def.brings?.jobs ?? [])] },
          needs: pluginsProviding(s.def.needs),
          neededBy: slots.filter((o) => o !== s && ids(o.def.needs).some((id) => own.has(id))).map((o) => o.def.name),
          stopsWith: active(s) ? dependentsOf(s).map((d) => d.def.name) : [],
          startsWith: plan && "targets" in plan ? plan.targets.filter((d) => d !== s).map((d) => d.def.name) : [],
          ...(plan && "problem" in plan ? { cannotEnable: plan.problem() } : {}),
          ...(removal ? { removal: { deletes: [...removal.deletes], keeps: [...removal.keeps] } } : {}),
        };
      }),
    removalOf: (name) => removals.get(name),
    viewsOf: (name) => byName.get(name)?.def.views ?? [],
    onChange(fn) {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
    report: () => {
      const gone = slots.filter((s) => s.state === "removed").map((s) => s.def.name);
      return {
        running: order.filter((s) => active(s)).map((s) => s.def.name),
        disabled: slots.filter((s) => s.state === "disabled").map((s) => s.def.name),
        skipped: slots.filter((s) => s.state === "skipped").map((s) => ({ plugin: s.def.name, reason: s.reason ?? "" })),
        ...(gone.length > 0 ? { removed: gone } : {}),
      };
    },
  };
}
