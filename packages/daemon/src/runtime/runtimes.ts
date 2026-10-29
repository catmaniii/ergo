// agent 运行时的登记表（286 号票，ADR-0027 的"运行时"贡献点）：维护者用哪个运行时跑它的会话。
// - 一个运行时（AgentRuntime）：id、给人看的名字、子进程入口（实现宿主协议的脚本，守护进程用 process.execPath 拉起，每个会话一个，
//   ADR-0002、ADR-0004）、能力清单（共享协议包 RUNTIME_OPERATIONS 每一项能不能做）、可选模型和设置项、（可选）列本机能接管的会话。
// - 内核自带的 pi 由组合根照同一个接口登记（piRuntime：不是插件、不能停用）；插件的在数据契约里登记（plugins/host.ts 的
//   ContractContext.runtimes）：不管插件开没开都登记——维护者记着的运行时在插件停用时也认得、写得出"X插件没启用"；
//   能不能用跟着插件在不在运行（RuntimeOwner.running）。
// - 用它的：agent 管家拉起维护者时按它解析子进程入口（resolve：不能用的抛"X插件没启用"）；运行时闸门（agent-host/runtime-gate.ts）
//   按它判维护者能不能启动、执行中的任务要不要转等我；网页经 GET /api/runtimes 拿到全部（view）。
// - 能不能用变了（插件运行中停用、启用）由组合根在插件宿主的状况变了时叫 changed()，订阅的跟着看一眼。
// - 289 号票：有自己的模型、斜杠命令的运行时（Claude Code）在子进程起来时报回它们（宿主协议 runtime_catalog），agent 管家交给
//   noteCatalog 记下（只在内存里）：view() 的模型列表以报回的为准（还没报过用运行时自己给的 models()）；斜杠命令按维护者记
//   （commandsOf：这个维护者最近报的，它还没跑过时用这个运行时最近报的）。
// - 290 号票（接管已有会话）：能接管的运行时（能力清单 take_over）要给四个函数——列本机的会话（sessions：标题、工作目录、分支、
//   最近活动、大小，正被别处占着的写明）、核对一个会话现在有没有被别处占着（sessionBusy：接管、收回前再看一次）、分叉一份
//   （forkSession：被占着的"分叉一份接管"）、读主线最近一段（sessionHistory：前情，大会话只读尾部）。登记表经同名的方法转给接管服务
//   （takeover/），先核对运行时能用、能接管。二狗自己的写入锁（哪个任务、项目在管）不在这里，在接管服务里。
// - 292 号票（交给官方 App、再收回来）：能力清单 remote_control 的运行时要给 remoteControl（开 / 唤醒运行时自己的后台会话连上官方 App、
//   拿链接、停掉、只读跟随读新内容）和 currentSession（维护者现在接着的是哪个会话：看会话目录里运行时自己记的）。登记表经 remoteControl()、
//   currentSession() 转给接管服务，先核对运行时能用、能交；"现在在哪边"记在任务、项目上（接管服务管）。
// 宿主协议不分运行时：pi 的子进程和插件的子进程收同一条"启动"、说同一套消息（ADR-0004），所以守护进程、网页都不用知道下面是谁。
import type { RuntimeCatalogReport } from "./host-protocol.ts";
import { type AgentRuntimeView, PI_RUNTIME_ID, type ResumableSessionView, type RuntimeCapabilities, type RuntimeModelView, type RuntimeOperation, RUNTIME_OPERATIONS, type RuntimeSettingView, type RuntimesView, t } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import type { ToolDescriptor } from "../guard/tool-registry.ts";
import { PI_CHILD_ENTRY } from "./agent-process.ts";

/** 一个 agent 运行时（插件在数据契约里登记的、内核自带的 pi 都是这个形状） */
export interface AgentRuntime {
  /** 运行时的 id：小写英文、数字和连字符（维护者的运行时属性 Task.runtime、Project.runtime 里写的就是它），定了别改；pi 是 "pi" */
  readonly id: string;
  /** 给人看的名字（写成取值函数 get title()，跟着当前语言） */
  readonly title: string;
  /** 子进程入口：实现宿主协议的脚本的绝对路径（和守护进程同一种扩展名），守护进程用 process.execPath 拉起它，每个会话一个 */
  readonly entry: string;
  /** 能力清单：每一项能不能做（界面和守护进程按它决定显示什么、走哪条路） */
  readonly capabilities: RuntimeCapabilities;
  /** 可选的模型（给人看的名字按当前语言）；不给是按设置 · 模型（二狗自己的模型目录，pi 就是这样） */
  models?(): readonly RuntimeModelView[];
  /** 设置项（权限模式、思考档位……，给人看的字按当前语言）；不给是没有 */
  settings?(): readonly RuntimeSettingView[];
  /**
   * 列本机能接管的会话（能力清单里 take_over 是 true 的要给，290 号票）：最近活动的在前；正被别处占着的写明 busy
   * （查不到占没占的也写上，一律当占着）。插件没在运行时不会叫它
   */
  sessions?(): Promise<readonly ResumableSessionView[]>;
  /** 这个会话现在有没有被别处占着（take_over 要给，290 号票；接管、收回前再核对一次）：占着的给人看的说明，空闲是 undefined；查不到抛错 */
  sessionBusy?(sessionId: string): Promise<string | undefined>;
  /** 分叉一份（take_over 要给，290 号票："分叉一份接管"）：新会话的 id；原会话不动 */
  forkSession?(sessionId: string, cwd: string): Promise<string>;
  /** 读会话主线最近一段（take_over 要给，290 号票：前情）：大会话只读尾部，翻成二狗的样子 */
  sessionHistory?(sessionId: string, cwd: string): Promise<RuntimeHistory>;
  /**
   * 新建时能选工作文件夹（305 号票，Claude Code 是 true、pi 没有）：新建它的任务、项目时多"在哪个文件夹做"，设置里能定新建时的
   * 默认文件夹（work-folders/）；选定的文件夹就是维护者的工作目录
   */
  readonly workFolder?: true;
  /**
   * 范围审视由二狗按自己记下的事件另起一次做（309 号票，Claude Code 是 true、pi 没有）：运行时的子进程里调不了二狗的审视模型，压缩之前它报 compacting、
   * 工单结束时守护进程不给它送 scope_review，都由守护进程把这段会话整理好、在一次性子进程里用审视的模型做（同 pi 的提示和结果格式）。
   * 能力清单 scope_review 照样是 true（范围审视做得成）
   */
  readonly recordedScopeReview?: true;
  /**
   * 运行时自带、二狗没装配的工具在守卫工具登记表里的登记（288 号票：Claude Code 的 TodoWrite、Agent、Skill、AskUserQuestion……，来源是 runtime）。
   * 用这个运行时的维护者的会话：守卫的登记表加上它们、工具包标上 runtimeTools（这些和没登记的不按工具白名单硬拒绝，没登记的照未登记的写操作判）。
   * 能对上二狗工具的（Claude 的 Bash、Read……）由子进程在 guard_request 里映射过去，不在这里。pi 没有
   */
  readonly guardTools?: readonly ToolDescriptor[];
  /**
   * 运行时自带的工具单次调用的超时（毫秒，288 号票）：盖过守护进程的默认（配置里的单次工具调用超时）；null 是不按单次超时算
   * （Claude 的子代理一次可能跑十几分钟、它里面的每次调用照常各自计时；等用户回答的不算卡住）。没写的照默认
   */
  readonly toolTimeouts?: Readonly<Record<string, number | null>>;
  /**
   * 工具包里的 skill 交给这个运行时之后的斜杠命令（291 号票，不带 /，和 skillDirs 一一对应、同样的先后）：Claude Code 把它们拼成本地插件 ergo，
   * 命令是 ergo:<目录名>。输入框的 / 补全按它列（运行时自己报的命令里有同名的就不重复）。不给的（pi）二狗自己展开 /目录名
   */
  toolkitSkillCommands?(skillDirs: readonly string[]): readonly string[];
  /**
   * 运行时自带命令的说明、参数提示按用户的语言（310 号票：输入框的 / 补全；Claude Code 内置命令的中文说明表）：只给现在的语言里有的，
   * 没有是 undefined（照它报的原文，不是用户语言的再交给二狗的模型翻）。name 不带 /
   */
  commandText?(name: string): { description?: string; argumentHint?: string } | undefined;
  /** 交给官方 App 接着、再收回来（能力清单 remote_control 是 true 的要给，292 号票），见 RuntimeRemoteControl */
  remoteControl?: RuntimeRemoteControl;
  /**
   * 维护者现在接着的运行时会话（remote_control 要给，292 号票）：看维护者会话目录里运行时自己记的（最近用的那个）——二狗自己开的会话交给官方 App
   * 时按它，接管来的中途换过会话 id（/clear）的也按它。会话 id、开始时的工作目录；还没开始（运行时那边还没有这个会话）是 undefined
   */
  currentSession?(sessionDir: string): { sessionId: string; cwd: string } | undefined;
}

/**
 * 交给官方 App（292 号票，issue 24 用户答复第 6 条"二选一、要能互转"；调研 35）：运行时自己的那几样。二狗这一侧的顺序（打断、关掉自己的进程、
 * 记下在哪边、只读跟随、收回后接着）在接管服务（takeover/）。
 */
export interface RuntimeRemoteControl {
  /**
   * 交出去：先核对二狗自己的进程退干净了（运行时那边还看得到这个会话开着就等一会儿，到点还在抛 RequestRejected 写明在哪开着）；再开
   * （第一次：带上名字连上官方 App）或唤醒（给了 job：不带参数，带了会开出副本）运行时的后台会话。交回后台会话的短 id 和链接（一时拿不到是
   * undefined，跟随时再拿）。开出了副本的停掉副本、抛错；已经有后台会话在跑的直接认它
   */
  open(input: { sessionId: string; cwd: string; name: string; job?: string }): Promise<{ job: string; url?: string }>;
  /** 官方 App 里接着它的链接：后台会话不在跑、还没连上的是 undefined */
  link(input: { sessionId: string; job: string }): Promise<string | undefined>;
  /** 收回：停掉后台会话、等它退干净（停不掉抛 RequestRejected）；它已经不在了也算停了 */
  stop(input: { sessionId: string; job: string }): Promise<void>;
  /**
   * 只读跟随：读会话里 after 那一条之后的新内容（final：后台会话已经停了，最后那条回复也当完整的）；tail 只要会话最后一条的 id
   * （交出去那一刻定下跟随从哪接着，items 是空的）
   */
  follow(input: { sessionId: string; cwd: string; after?: string; final: boolean; tail?: boolean }): Promise<RuntimeFollow>;
}

/** 只读跟随读到的（292 号票） */
export interface RuntimeFollow {
  /** 新的几条（按先后，翻成二狗的样子，同前情）：key 是运行时那边这一条的 id（补记时按它去重），at 是那边记的时间（有就写） */
  items: Array<RuntimeHistoryItem & { key: string; at?: string }>;
  /** 下次从哪一条之后接着读；会话里还没有消息是 undefined */
  cursor?: string;
  /** after 在会话里找不到了：compacted 是那边压缩过（从压缩之后读），lost 是对不上（这次没补记，cursor 挪到最后） */
  reset?: "compacted" | "lost";
}

/**
 * 接管时读到的会话主线最近一段（290 号票，前情）：运行时自己的记录翻成二狗的样子，接管服务据此在维护者的会话里记成前情消息。
 * 按先后：用户说的一句、它的一条回复（文字、思考、工具调用：工具名照二狗守卫的登记表映射过的，结果只留摘要）、压缩过的标记。
 * truncated：更早的还有（留在运行时自己的记录里）
 */
export interface RuntimeHistory {
  items: RuntimeHistoryItem[];
  truncated: boolean;
}

export type RuntimeHistoryItem = { kind: "user"; text: string } | { kind: "agent"; parts: RuntimeHistoryPart[] } | { kind: "compacted" };

export type RuntimeHistoryPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      /** 运行时的工具调用 id */
      id: string;
      /** 映射到二狗守卫登记表之后的工具名（Bash → bash……；没映射的原样） */
      tool: string;
      /** 运行时自己的工具名 */
      native: string;
      /** 映射之后的参数（参数摘要按它写） */
      args: Record<string, unknown>;
      /** 结果（截短的原文；没有结果的没有） */
      result?: string;
      /** 结果是出错 */
      failed?: boolean;
    };

/** 登记这个运行时的插件：插件名、给人看的名字（"X插件没启用"里用）、现在在不在运行 */
export interface RuntimeOwner {
  readonly plugin: string;
  readonly title: string;
  running(): boolean;
  /** 插件没装上是因为它要的外部组件没装时（315 号票）：没装什么、怎么装；不是这样是 undefined（不给也是） */
  missing?(): string | undefined;
}

/** 运行时现在不能用：给人看的原因（"Claude Code插件没启用"），没启用的插件给人看的名字（活动状态"等你"的说明用） */
export interface RuntimeUnavailable {
  reason: string;
  plugin: string;
  /** 不是插件没启用，是接管来的会话交还给运行时了（290 号票，运行时闸门给的）：plugin 这时是运行时给人看的名字 */
  returned?: true;
  /** 交还的是交给了官方 App（292 号票，也带 returned） */
  remote?: true;
}

export interface RuntimeRegistry {
  /** 登记一个运行时（插件的带上 owner，内核的不带）；id 不合规矩、重复了、能接管却没给 sessions 都抛错。返回撤销函数 */
  register(runtime: AgentRuntime, owner?: RuntimeOwner): () => void;
  get(id: string): AgentRuntime | undefined;
  /** 这个运行时现在不能用的原因；能用是 undefined。不认得的 id（登记它的插件不在清单里了）也算不能用 */
  unavailable(id: string): RuntimeUnavailable | undefined;
  /** 拉起维护者时用：能用就交回运行时，不能用抛 RequestRejected（not_allowed，给人看的原因） */
  resolve(id: string): AgentRuntime;
  /** 能不能做某项会话操作（不认得的 id 当不能；插件停用了照它登记的说，能不能用另看 unavailable） */
  supports(id: string, operation: RuntimeOperation): boolean;
  /** 列这个运行时在本机能接管的会话（290 号票）：不能用、不能接管的抛 RequestRejected（not_allowed，给人看的原因） */
  sessions(id: string): Promise<readonly ResumableSessionView[]>;
  /** 一个会话现在有没有被别处占着（290 号票）：同上核对；占着的说明，空闲是 undefined */
  sessionBusy(id: string, sessionId: string): Promise<string | undefined>;
  /** 分叉一份（290 号票）：同上核对；新会话的 id */
  forkSession(id: string, sessionId: string, cwd: string): Promise<string>;
  /** 读主线最近一段（290 号票）：同上核对 */
  sessionHistory(id: string, sessionId: string, cwd: string): Promise<RuntimeHistory>;
  /** 交给官方 App 用的那几样（292 号票）：不能用、不能交的抛 RequestRejected（not_allowed，给人看的原因） */
  remoteControl(id: string): RuntimeRemoteControl;
  /** 维护者现在接着的运行时会话（292 号票）：同上核对；还没开始是 undefined */
  currentSession(id: string, sessionDir: string): { sessionId: string; cwd: string } | undefined;
  /** 给网页的：pi 在最前，插件的按登记的先后（停用了的插件的也在，available 是 false） */
  view(): RuntimesView;
  /** 能不能用变了（插件运行中停用、启用）：组合根在插件宿主的状况变了时叫 */
  changed(): void;
  /** 订阅"能不能用变了"；返回取消订阅 */
  onChange(listener: () => void): () => void;
  /**
   * 记下运行时的子进程报回的模型列表、斜杠命令（289 号票，宿主协议 runtime_catalog）：模型按运行时记（view 用它），命令按维护者记，
   * 也记成这个运行时最近报的
   */
  noteCatalog(runtimeId: string, agentId: string, catalog: Omit<RuntimeCatalogReport, "type">): void;
  /** 这个维护者能用的运行时斜杠命令（289 号票）：它最近报的；它还没跑过时是这个运行时最近报的；都没有是 undefined */
  commandsOf(runtimeId: string, agentId: string): RuntimeCatalogReport["commands"];
}

/** 运行时的 id 的规矩 */
const RUNTIME_ID = /^[a-z][a-z0-9-]*$/;

/**
 * 内核自带的运行时 pi（ADR-0001）：照运行时的接口登记，不是插件、不能停用。子进程入口是 agent-child/main（ADR-0004），
 * 能力清单照调研 33：二狗前端现有的会话操作它全有；斜杠命令由二狗自己展开（pi 的命令不暴露），不接管已有会话，没有 Remote Control
 */
export const piRuntime: AgentRuntime = {
  id: PI_RUNTIME_ID,
  title: "pi",
  entry: PI_CHILD_ENTRY,
  capabilities: {
    interject: true,
    compact: true,
    rollback: true,
    branch_switch: true,
    branch_summary: true,
    // 撤回不动文件（293 号票：Claude Code 的文件检查点才有）
    rewind_files: false,
    model_handoff: true,
    thinking_levels: true,
    slash_passthrough: false,
    take_over: false,
    purge_rewrite: true,
    yield: true,
    live_toolkit: false,
    scope_review: true,
    remote_control: false,
  },
};

export function createRuntimeRegistry(options: {
  log: (line: string) => void;
  /** 能选工作文件夹的运行时设的新建时的默认文件夹（305 号票，work-folders/）：view() 里带上；不给是都没设 */
  defaultFolder?: (runtimeId: string) => string | undefined;
}): RuntimeRegistry {
  const entries: Array<{ runtime: AgentRuntime; owner: RuntimeOwner | undefined }> = [];
  const listeners = new Set<() => void>();
  /** 子进程报回的（289 号票）：运行时 → 模型列表、最近报的命令；维护者 → 它的命令 */
  const catalogs = new Map<string, { models?: RuntimeModelView[]; commands?: RuntimeCatalogReport["commands"] }>();
  const agentCommands = new Map<string, { runtime: string; commands: NonNullable<RuntimeCatalogReport["commands"]> }>();
  const find = (id: string) => entries.find((e) => e.runtime.id === id);
  const workFolderView = (id: string) => {
    const folder = options.defaultFolder?.(id);
    return folder === undefined ? {} : { defaultFolder: folder };
  };

  const unavailable = (id: string): RuntimeUnavailable | undefined => {
    const entry = find(id);
    if (!entry) return { reason: t("runtime.registry.unknown", { id }), plugin: id };
    if (!entry.owner || entry.owner.running()) return undefined;
    // 外部组件没装（315 号票：Claude Code 的 Agent SDK）：说没装什么、怎么装，不说"没启用"
    return { reason: entry.owner.missing?.() ?? t("plugins.notEnabled", { title: entry.owner.title }), plugin: entry.owner.title };
  };

  const resolve = (id: string): AgentRuntime => {
    const off = unavailable(id);
    if (off) throw new RequestRejected("not_allowed", off.reason);
    return find(id)!.runtime;
  };

  /** 能接管已有会话的运行时（290 号票）：不能用、不能接管的抛 RequestRejected（not_allowed） */
  const takeOverOf = (id: string): AgentRuntime => {
    const runtime = resolve(id);
    if (!runtime.capabilities.take_over || !runtime.sessions || !runtime.sessionBusy || !runtime.forkSession || !runtime.sessionHistory) {
      throw new RequestRejected("not_allowed", t("runtime.registry.noTakeOver", { title: runtime.title }));
    }
    return runtime;
  };

  /** 能交给官方 App 的运行时（292 号票）：不能用、不能交的抛 RequestRejected（not_allowed） */
  const remoteOf = (id: string): AgentRuntime & Required<Pick<AgentRuntime, "remoteControl" | "currentSession">> => {
    const runtime = resolve(id);
    if (!runtime.capabilities.remote_control || !runtime.remoteControl || !runtime.currentSession) {
      throw new RequestRejected("not_allowed", t("runtime.registry.noRemoteControl", { title: runtime.title }));
    }
    return runtime as AgentRuntime & Required<Pick<AgentRuntime, "remoteControl" | "currentSession">>;
  };

  return {
    register(runtime, owner) {
      // @i18n-ignore-start log：编程错误
      if (!RUNTIME_ID.test(runtime.id)) throw new Error(`运行时的 id 不合规矩（小写英文、数字和连字符）：${runtime.id}`);
      if (find(runtime.id)) throw new Error(`运行时 ${runtime.id} 已经登记过了`);
      const missing = RUNTIME_OPERATIONS.filter((op) => typeof runtime.capabilities[op] !== "boolean");
      if (missing.length > 0) throw new Error(`运行时 ${runtime.id} 的能力清单没写全：${missing.join("、")}`);
      if (runtime.capabilities.take_over && (!runtime.sessions || !runtime.sessionBusy || !runtime.forkSession || !runtime.sessionHistory)) {
        throw new Error(`运行时 ${runtime.id} 说能接管已有会话，却没给全 sessions()、sessionBusy()、forkSession()、sessionHistory()`);
      }
      if (runtime.capabilities.remote_control && (!runtime.remoteControl || !runtime.currentSession)) {
        throw new Error(`运行时 ${runtime.id} 说能交给官方 App，却没给全 remoteControl、currentSession()`);
      }
      const foreign = (runtime.guardTools ?? []).filter((tool) => tool.source !== "runtime").map((tool) => tool.name);
      if (foreign.length > 0) throw new Error(`运行时 ${runtime.id} 登记的守卫工具来源要是 runtime：${foreign.join("、")}`);
      // @i18n-ignore-end
      const entry = { runtime, owner };
      entries.push(entry);
      return () => {
        const at = entries.indexOf(entry);
        if (at >= 0) entries.splice(at, 1);
      };
    },
    get: (id) => find(id)?.runtime,
    unavailable,
    resolve,
    supports: (id, operation) => find(id)?.runtime.capabilities[operation] === true,
    // 不能用、不能接管的以被拒的 Promise 交回（和别的出错一样）
    sessions: async (id) => takeOverOf(id).sessions!(),
    sessionBusy: async (id, sessionId) => takeOverOf(id).sessionBusy!(sessionId),
    forkSession: async (id, sessionId, cwd) => takeOverOf(id).forkSession!(sessionId, cwd),
    sessionHistory: async (id, sessionId, cwd) => takeOverOf(id).sessionHistory!(sessionId, cwd),
    remoteControl: (id) => remoteOf(id).remoteControl,
    currentSession: (id, sessionDir) => remoteOf(id).currentSession(sessionDir),
    view() {
      // pi（内核的）在最前，插件的按登记的先后
      const ordered = [...entries.filter((e) => !e.owner), ...entries.filter((e) => e.owner)];
      return {
        runtimes: ordered.map(({ runtime, owner }): AgentRuntimeView => {
          const off = unavailable(runtime.id);
          // 子进程报回过的模型列表优先（289 号票）
          const models = catalogs.get(runtime.id)?.models ?? runtime.models?.();
          return {
            id: runtime.id,
            title: runtime.title,
            ...(owner ? { plugin: owner.plugin } : {}),
            available: off === undefined,
            ...(off ? { unavailable: off.reason } : {}),
            capabilities: { ...runtime.capabilities },
            ...(models ? { models: models.map((m) => ({ ...m })) } : {}),
            settings: (runtime.settings?.() ?? []).map((s) => ({ ...s, options: s.options.map((o) => ({ ...o })) })),
            ...(runtime.workFolder ? { workFolder: workFolderView(runtime.id) } : {}),
          };
        }),
      };
    },
    changed() {
      for (const listener of listeners) {
        try {
          listener();
        } catch (err) {
          options.log(`运行时能不能用变了，通知时出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    noteCatalog(runtimeId, agentId, catalog) {
      const known = catalogs.get(runtimeId) ?? {};
      if (catalog.models && catalog.models.length > 0) known.models = catalog.models.map((m) => ({ id: m.id, title: m.title }));
      if (catalog.commands) {
        known.commands = catalog.commands.map((c) => ({ ...c }));
        agentCommands.set(agentId, { runtime: runtimeId, commands: known.commands });
      }
      catalogs.set(runtimeId, known);
    },
    commandsOf(runtimeId, agentId) {
      const own = agentCommands.get(agentId);
      if (own && own.runtime === runtimeId) return own.commands;
      return catalogs.get(runtimeId)?.commands;
    },
  };
}
