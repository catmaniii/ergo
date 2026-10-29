// 维护者的运行时闸门（286 号票）：维护者用哪个 agent 运行时（pi 或者插件登记的，runtime/runtimes.ts）、它现在能不能用、
// 此刻该不该停在"等我"。组合根建一份，交给 agent 宿主（拉起哪个子进程入口、拉不起时不拉）和执行控制器（执行中的任务转等我、接着执行）。
// - 运行时属性存在任务、项目上（Task.runtime、Project.runtime，没写是 pi），由组合根按维护者 id 找（runtimeOf）：项目的维护者照项目的
//   （没写照转来的任务的），任务自己的、定时作业自己的维护者照它执行的那个任务的；
// - off：维护者用的运行时现在不能用（登记它的插件没在运行；不认得的运行时也算），给出原因（"Claude Code插件没启用"）；
// - held：停在"等我"——运行时不能用，而且维护者手头没有在做的一轮（插件停用时正在做的那一轮做完才算，免得做到一半的调用被
//   "任务不在执行中"拒掉）；agent 宿主按会话的状态报"在做"（setBusy）；
// - runtime：维护者用的运行时本身（288 号票：拉起时守卫加上它自带的工具的登记）；
// - onChange：能不能用变了（插件运行中停用、启用：登记表的 changed），或者运行时不能用的维护者做完了手头那一轮；
//   289 号票起维护者换了运行时（recheck）也算。
// - 289 号票：给运行时选的值（optionsOf：任务、项目上记着的 runtimeOptions，拉起时交给子进程）、运行时能不能做某项会话操作（supports：
//   斜杠命令转交）、给人看的名字（title）。309 号票：范围审视由二狗另起的运行时（recordedScopeReview）、运行时报过的斜杠命令（commandsOf）。
// - 290 号票：接管来的会话（任务、项目上记着的 takeover，takeoverOf 按维护者找）——二狗管着、没交还的，拉起时把会话 id 交给子进程
//   （resumeOf：宿主协议的 resumeRuntimeSession）；交还了的同运行时不能用一样不拉起、执行中的任务转等我（off 带 returned，
//   原因写"已交还给 X"），收回后（recheck）接着。维护者手头在不在做一轮（busy）给接管服务判能不能交还。
// - 292 号票：交给官方 App 的（takeover 上 remote.since）同交还一样不拉起，原因写"在 X 的官方 App 里"（off 另带 remote）；二狗自己开的会话
//   （takeover.own：交给官方 App 时才记下的）拉起时不交会话 id（照常接着会话目录里的，项目维护者换段照旧新开）。正在交（handing：接管服务在关
//   二狗的进程、开后台会话，还没记下）的也当它在官方 App 里，免得中途显示成"已交还"；交不出去时放开、接着。
import { PI_RUNTIME_ID, type RuntimeChoice, type RuntimeOperation, type RuntimeTakeover, t, takeoverPlaceOf } from "@ergo/protocol";
import type { AgentRuntime, RuntimeRegistry, RuntimeUnavailable } from "../runtime/index.ts";

export interface RuntimeGate {
  /** 维护者用的运行时的 id（没写是 pi） */
  runtimeOf(maintainerId: string): string;
  /** 维护者用的运行时现在不能用：原因和没启用的插件给人看的名字；能用是 undefined */
  off(maintainerId: string): RuntimeUnavailable | undefined;
  /**
   * 维护者用的运行时（288 号票：拉起时给守卫加上它自带的工具的登记、工具包标上 runtimeTools）；pi、不认得的运行时是 undefined
   */
  runtime(maintainerId: string): AgentRuntime | undefined;
  /** 停在"等我"：运行时不能用，维护者手头也没有在做的一轮；不用停是 undefined */
  held(maintainerId: string): RuntimeUnavailable | undefined;
  /** agent 宿主报：维护者手头在不在做一轮（会话的状态是 busy） */
  setBusy(maintainerId: string, busy: boolean): void;
  /** 能不能用变了，或者运行时不能用的维护者做完了手头那一轮：叫 listener；返回取消订阅 */
  onChange(listener: () => void): () => void;
  /** 给维护者的运行时选的值（289 号票：任务、项目上记着的）；没选是 undefined */
  optionsOf(maintainerId: string): RuntimeChoice | undefined;
  /** 这个运行时能不能做某项会话操作（289 号票：能力清单） */
  supports(runtime: string, operation: RuntimeOperation): boolean;
  /** 这个运行时的范围审视由二狗按自己记下的事件另起一次做（309 号票：AgentRuntime.recordedScopeReview，Claude Code） */
  recordedScopeReview(runtime: string): boolean;
  /**
   * 运行时报过的斜杠命令名（不带 /，309 号票：用户打的 /<目录名> 和它同名时运行时的优先、不换成 /ergo:<目录名>）：这个维护者最近报的，
   * 它还没跑过时是这个运行时最近报的；都没有是空的
   */
  commandsOf(runtime: string, maintainerId: string): readonly string[];
  /** 运行时给人看的名字（不认得的原样写 id） */
  title(runtime: string): string;
  /** 维护者换了运行时（289 号票：任务、项目上改好了）：订阅的各自看一眼（停用中的接着、执行中的转等我……）；290 号票的交还、收回也叫它 */
  recheck(): void;
  /** 维护者手头在不在做一轮（290 号票：在做的不能交还） */
  busy(maintainerId: string): boolean;
  /** 正在交给官方 App（292 号票，接管服务给）：这期间同交给了官方 App 一样不拉起；on 是 false 时放开（交成了的看任务、项目上记着的） */
  handing(maintainerId: string, on: boolean): void;
  /** 拉起时交给子进程的接管的会话 id（290 号票：接管来的、二狗管着、没交还、维护者还用那个运行时；292 号票：二狗自己开的不交）；不是是 undefined */
  resumeOf(maintainerId: string): string | undefined;
}

export interface RuntimeGateOptions {
  registry: Pick<RuntimeRegistry, "unavailable" | "onChange" | "get"> & Partial<Pick<RuntimeRegistry, "supports" | "commandsOf">>;
  /** 维护者的运行时属性（项目、任务上写的）；没写、不认得这个维护者是 undefined（按 pi） */
  runtimeOf(maintainerId: string): string | undefined;
  /** 给维护者的运行时选的值（289 号票，项目、任务上写的）；不给是都没选 */
  optionsOf?(maintainerId: string): RuntimeChoice | undefined;
  /** 维护者是从哪个会话接管来的（290 号票，项目、任务上写的 takeover）；不是接管来的、不给是 undefined */
  takeoverOf?(maintainerId: string): RuntimeTakeover | undefined;
  log: (line: string) => void;
}

export function createRuntimeGate(options: RuntimeGateOptions): RuntimeGate {
  const { registry } = options;
  const busy = new Set<string>();
  /** 正在交给官方 App 的维护者（292 号票） */
  const handing = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        options.log(`运行时闸门通知出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
  };
  registry.onChange(emit);

  const runtimeOf = (maintainerId: string) => options.runtimeOf(maintainerId) ?? PI_RUNTIME_ID;
  /** 接管来的、还用那个运行时（换了别的运行时就不算了） */
  const takeoverOf = (maintainerId: string): RuntimeTakeover | undefined => {
    const takeover = options.takeoverOf?.(maintainerId);
    return takeover && takeover.runtime === runtimeOf(maintainerId) ? takeover : undefined;
  };
  const off = (maintainerId: string): RuntimeUnavailable | undefined => {
    const runtime = runtimeOf(maintainerId);
    if (runtime === PI_RUNTIME_ID) return undefined;
    const unavailable = registry.unavailable(runtime);
    if (unavailable) return unavailable;
    // 交还了（290 号票）、交给了官方 App、正在交（292 号票）：同不能用一样不拉起
    const takeover = takeoverOf(maintainerId);
    if (handing.has(maintainerId) || takeover?.returnedAt !== undefined) {
      const title = registry.get(runtime)?.title ?? runtime;
      if (handing.has(maintainerId) || (takeover && takeoverPlaceOf(takeover) === "remote")) return { reason: t("runtime.takeover.inRemote", { runtime: title }), plugin: title, returned: true, remote: true };
      return { reason: t("runtime.takeover.handedBack", { runtime: title }), plugin: title, returned: true };
    }
    return undefined;
  };

  return {
    runtimeOf,
    off,
    runtime: (maintainerId) => {
      const id = runtimeOf(maintainerId);
      return id === PI_RUNTIME_ID ? undefined : registry.get(id);
    },
    held: (maintainerId) => (busy.has(maintainerId) ? undefined : off(maintainerId)),
    setBusy(maintainerId, now) {
      if (busy.has(maintainerId) === now) return;
      if (now) busy.add(maintainerId);
      else busy.delete(maintainerId);
      // 运行时不能用的维护者做完了手头那一轮：执行中的任务这时才转等我
      if (!now && off(maintainerId)) emit();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    optionsOf: (maintainerId) => options.optionsOf?.(maintainerId),
    supports: (runtime, operation) => registry.supports?.(runtime, operation) === true,
    recordedScopeReview: (runtime) => registry.get(runtime)?.recordedScopeReview === true,
    commandsOf: (runtime, maintainerId) => (registry.commandsOf?.(runtime, maintainerId) ?? []).map((c) => c.name),
    title: (runtime) => registry.get(runtime)?.title ?? runtime,
    recheck: emit,
    busy: (maintainerId) => busy.has(maintainerId),
    handing(maintainerId, on) {
      if (handing.has(maintainerId) === on) return;
      if (on) handing.add(maintainerId);
      else handing.delete(maintainerId);
      emit();
    },
    resumeOf: (maintainerId) => {
      const takeover = takeoverOf(maintainerId);
      return takeover && takeover.returnedAt === undefined && takeover.own !== true ? takeover.sessionId : undefined;
    },
  };
}
