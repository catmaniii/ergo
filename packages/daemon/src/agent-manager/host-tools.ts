// 守护进程代为执行的工具（宿主工具）在守护进程这一侧：定义工具、接上一个 agent 子进程。
// 子进程发来 host_tool_call，按工具名找到实现、执行，回 host_tool_result。工具的声明（名字、说明、参数的 JSON Schema）
// 在拉起时随装配参数交给子进程（SpawnAgentRequest.hostTools）。
// 哪个 agent 有哪些工具、工具能碰什么，由拉起它的模块决定（比如秘书的"读取附件"只能读秘书会话里的附件）。
// 现在的工具：秘书建、改、取消简单提醒（06，reminders/tools.ts），读取附件、把文件作为附件发出（09，media/attachment-tools.ts；
// 117 号票起维护者也能发附件）；
// 建议发起任务、建任务卡、提问卡、写任务书（12，tasks/secretary-tools.ts）、维护者的提交计划（12，maintainers/tools.ts）；
// 建议立项（15）、提议快速动作（21）照这个加。
// 每个工具同时写明它在守卫的工具注册表里的登记（来源 host）：调用和别的工具一样先经守卫判定（07 号票）。
import { AsyncLocalStorage } from "node:async_hooks";
import { type MemoryRecall, type MessagePart, schemaChecker, type Static, type TSchema } from "@ergo/protocol";
import type { ArgRule, BottomLineId, BuiltinCategoryId, ToolDescriptor } from "../guard/index.ts";
import type { HostToolResult, HostToolSpec, InputImage, JsonValue } from "../runtime/index.ts";
import type { AgentLink } from "./agent-manager.ts";

/** 一次调用：pi 给这次工具调用的 id，以及拉起这个 agent 的模块补上的情境 */
export interface HostToolCall {
  toolCallId: string;
  /** 发起调用的 agent（serveHostTools 按接上的子进程填；154 号票：联网工具按次计费的调用记在它名下） */
  agentId?: string;
  /** 调用发生时 agent 正在处理的那条用户消息（快速动作据此判定"用户明确点了"，21 号票）；一起交出的一批时是第一条 */
  inputMessageId?: string;
  /** 和它一起交给 agent 的另外几条（144 号票：排队交出的一批），按先后；只有一条时没有 */
  moreInputMessageIds?: readonly string[];
  /**
   * 这一轮里已经进了模型上下文的插话（用户在维护者忙时又说的话，子进程收下的；送进去了还排着的不算），按先后。
   * 子进程随 host_tool_call 报上来（宿主协议 16）。86 号票：发语音工具据此认出"用户在任务详情里说话的那一轮"。没有插话时没有
   */
  interjected?: readonly string[];
  /** 这个 agent 的模型能不能看图（79 号票：子进程在 ready 里报回的；读取附件据此决定交不交图片）。不知道时按看不了 */
  vision?: boolean;
  /**
   * 这次调用不用再做了：子进程那边已经结束了它（这一轮被中止、管家按超时中止）或者 agent 退出了。
   * 跑得久的工具（28 号票的跑测试、构建……）据此结束它起的进程；只产生卡片的工具不用理会
   */
  signal?: AbortSignal;
}

/** 工具执行完交回的：给模型看的文字、是否出错；只产生卡片的工具另外给出要出现在聊天里的卡片 */
export interface HostToolOutput {
  text: string;
  isError?: boolean;
  /** 跟在文字后面交给模型看的图片（79 号票：读取附件读图；只在模型看得了图时给） */
  images?: InputImage[];
  /** 要出现在聊天里的卡片：拉起这个 agent 的模块往它的会话里追加一条只有卡片引用的消息（serveHostTools 的 onCards） */
  cardIds?: string[];
  /**
   * 要作为 agent 的一条消息出现在聊天里的附件（09 号票的发附件；117 号票起维护者也有）：拉起这个 agent 的模块往它的会话里追加
   * 一条只有这些附件的消息，带上会话此刻的归属（serveHostTools 的 onAttachments）
   */
  attachments?: MessagePart[];
  /**
   * 调用记忆的结构化部分（187 号票：检索素材、读素材交回的为什么查、查了什么、找到读到的素材）：不给模型看，
   * 拉起这个 agent 的模块交给守卫接入，记在这次调用的工具调用 part 上（serveHostTools 的 onRecall）
   */
  recall?: MemoryRecall;
}

export interface HostTool {
  spec: HostToolSpec;
  /** 它在守卫的工具注册表里的登记（来源 host）：拉起 agent 的模块把它加进这个会话的注册表 */
  descriptor: ToolDescriptor;
  /** 执行一次调用。抛错等同于出错的结果（错误记日志，模型只看到"没做成"） */
  run(args: JsonValue, call: HostToolCall): HostToolOutput | Promise<HostToolOutput>;
  /** 单次调用要得比默认的工具调用超时长时（毫秒）；只有 agent 管家看（拉起时经 hostToolTimeouts 交给它），不进宿主协议 */
  timeoutMs?: number;
}

/** 拉起 agent 时交给管家的：声明了更长超时的工具（SpawnAgentRequest.toolTimeouts） */
export function hostToolTimeouts(tools: readonly HostTool[]): Record<string, number> {
  return Object.fromEntries(tools.flatMap((t) => (t.timeoutMs === undefined ? [] : [[t.spec.name, t.timeoutMs]])));
}

/**
 * 定义一个工具：参数用 TypeBox 写（共享协议包转出的 Type），序列化成 JSON Schema 交给子进程（pi 先按它校验）；
 * 守护进程这边再按同一个 schema 校验一次（不信任子进程转来的参数）。
 * 同时写明它在守卫的工具注册表里的登记：中文名（说明、审批卡里用）、类别标签（只产生卡片、只读的工具不落入任何类别，不写）、
 * 底线标签、要守卫检查的参数规则（路径、收件人……）、"只读或幂等"（23 号票被杀后的恢复用）。
 */
export function defineHostTool<S extends TSchema>(definition: {
  name: string;
  /** 中文名 */
  title: string;
  description: string;
  parameters: S;
  categories?: readonly BuiltinCategoryId[];
  bottomLines?: readonly BottomLineId[];
  /** 要守卫检查的参数（不写的参数守卫不看） */
  args?: Readonly<Record<string, ArgRule>>;
  /** 只读或幂等（重做一次没有额外效果）：必填，拿不准的从严写 false（23 号票被杀后的恢复据此决定能不能重做） */
  readOnlyOrIdempotent: boolean;
  /** 只看（不改任何东西、不往外送）或删改（改了或去掉了原有的东西）：见工具注册表的 nature，54 号票；不写是动手 */
  nature?: "look" | "modify";
  /** 给了这些参数（true 或非空数组）时算删改（见工具注册表的 modifiesWith，54 号票） */
  modifiesWith?: readonly string[];
  /** 被打断后由执行控制器负责恢复（见工具注册表的 recoveredByController，23 号票） */
  recoveredByController?: boolean;
  /** 单次调用要得比默认的工具调用超时（10 分钟）长时写明（毫秒）；agent 管家按它计时 */
  timeoutMs?: number;
  /** 参数要打码：参数里套着别的接口的参数、可能带着密钥，给人看的参数摘要先擦掉密钥类的值（见工具注册表的 maskArgs，280 号票） */
  maskArgs?: boolean;
  run(args: Static<S>, call: HostToolCall): HostToolOutput | Promise<HostToolOutput>;
}): HostTool {
  const checker = schemaChecker(definition.parameters);
  return {
    descriptor: {
      name: definition.name,
      title: definition.title,
      source: "host",
      categories: definition.categories ?? [],
      ...(definition.bottomLines === undefined ? {} : { bottomLines: definition.bottomLines }),
      args: definition.args ?? {},
      readOnlyOrIdempotent: definition.readOnlyOrIdempotent,
      ...(definition.nature === undefined ? {} : { nature: definition.nature }),
      ...(definition.modifiesWith === undefined ? {} : { modifiesWith: definition.modifiesWith }),
      ...(definition.recoveredByController === undefined ? {} : { recoveredByController: definition.recoveredByController }),
      ...(definition.maskArgs === undefined ? {} : { maskArgs: definition.maskArgs }),
    },
    spec: {
      name: definition.name,
      description: definition.description,
      parameters: JSON.parse(JSON.stringify(definition.parameters)) as JsonValue,
    },
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    run(args, call) {
      if (!checker.check(args)) return { text: `参数不对：${checker.firstError(args) ?? "不合 schema"}`, isError: true }; // @i18n-ignore model：工具结果
      return definition.run(args, call);
    },
  };
}

export interface ServeHostToolsOptions {
  log: (line: string) => void;
  /** 工具产生了卡片（在把结果交回模型之前调用） */
  onCards?: (cardIds: string[]) => void;
  /** 工具发出了附件（在把结果交回模型之前调用） */
  onAttachments?: (parts: MessagePart[]) => void;
  /**
   * 工具交回了调用记忆的结构化部分（187 号票；在把结果交回模型之前调用，所以子进程报这次调用结束时已经有了）：
   * 按 pi 给的工具调用 id 记下，守卫接入写工具调用记录时取（GuardedSession.takeRecall）
   */
  onRecall?: (toolCallId: string, recall: MemoryRecall) => void;
  /** 每次调用时补上的情境（比如正在处理哪条用户消息） */
  context?: () => Omit<HostToolCall, "toolCallId">;
}

/** 一次正在执行的宿主工具调用：哪个 agent、pi 给的工具调用 id、工具名 */
export interface InFlightHostCall {
  readonly agentId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

const inFlight = new AsyncLocalStorage<InFlightHostCall & { active: boolean }>();

/**
 * 此刻在哪次宿主工具调用里（152 号票：长程任务的阶段在维护者的某次工具调用里开始时，运行时记下是哪一次，会话回退据此回到这次调用的
 * 结果之后或这条回复之前）。工具执行完就不算了（执行期间起的计时器之后再触发时不算在这次调用里）；不在调用里的是 undefined
 */
export function currentHostToolCall(): InFlightHostCall | undefined {
  const call = inFlight.getStore();
  return call?.active ? { agentId: call.agentId, toolCallId: call.toolCallId, toolName: call.toolName } : undefined;
}

/**
 * 接上一个 agent 子进程的工具；返回取消的函数。tools 给函数时每次调用现取（291 号票：工具包当场换的运行时，换了之后的调用按新的找）
 */
export function serveHostTools(agent: AgentLink, tools: readonly HostTool[] | (() => readonly HostTool[]), options: ServeHostToolsOptions): () => void {
  const { log } = options;
  const fixed = typeof tools === "function" ? undefined : new Map(tools.map((t) => [t.spec.name, t]));
  const find = (name: string): HostTool | undefined => fixed?.get(name) ?? (typeof tools === "function" ? tools().find((t) => t.spec.name === name) : undefined);
  /** 还在执行的调用（pi 给的工具调用 id → 中止它）：子进程先结束了这次调用（回合中止、超时）或者 agent 退出时中止 */
  const running = new Map<string, AbortController>();
  void agent.exited.then(() => {
    for (const controller of running.values()) controller.abort();
    running.clear();
  });
  return agent.onReport((report) => {
    if (report.type === "tool_call_end") {
      running.get(report.toolCallId)?.abort();
      running.delete(report.toolCallId);
      return;
    }
    if (report.type !== "host_tool_call") return;
    const reply = (result: HostToolResult) => {
      try {
        agent.send({ type: "host_tool_result", requestId: report.requestId, result });
      } catch (err) {
        // 子进程已经退出：这次调用的结果没人要了
        log(`工具 ${report.toolName} 的结果送不回去：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const failed = (err: unknown) => {
      log(`工具 ${report.toolName} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      reply({ text: "这个工具出错了，没做成", isError: true }); // @i18n-ignore model：工具结果
    };
    const tool = find(report.toolName);
    if (!tool) return reply({ text: `没有这个工具：${report.toolName}`, isError: true }); // @i18n-ignore model：工具结果
    // 情境在调用到达时取（之后 agent 可能已经换到下一条输入）
    const controller = new AbortController();
    running.set(report.toolCallId, controller);
    const call: HostToolCall = {
      agentId: agent.agentId,
      ...options.context?.(),
      ...(report.interjected?.length ? { interjected: report.interjected } : {}),
      toolCallId: report.toolCallId,
      signal: controller.signal,
    };
    const scope = { agentId: agent.agentId, toolCallId: report.toolCallId, toolName: report.toolName, active: true };
    Promise.resolve()
      .then(() => inFlight.run(scope, () => tool.run(report.args, call)))
      .then((out) => {
        if (out.cardIds?.length) options.onCards?.(out.cardIds);
        if (out.attachments?.length) options.onAttachments?.(out.attachments);
        if (out.recall) options.onRecall?.(report.toolCallId, out.recall);
        reply({ text: out.text, isError: out.isError ?? false, ...(out.images?.length ? { images: out.images } : {}) });
      })
      .catch(failed)
      .finally(() => {
        scope.active = false;
        if (running.get(report.toolCallId) === controller) running.delete(report.toolCallId);
      });
  });
}
