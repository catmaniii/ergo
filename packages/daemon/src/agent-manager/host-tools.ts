// 守护进程代为执行的工具（宿主工具）在守护进程这一侧：定义工具、接上一个 agent 子进程。
// 子进程发来 host_tool_call，按工具名找到实现、执行，回 host_tool_result。工具的声明（名字、说明、参数的 JSON Schema）
// 在拉起时随装配参数交给子进程（SpawnAgentRequest.hostTools）。
// 哪个 agent 有哪些工具、工具能碰什么，由拉起它的模块决定（比如秘书的"读取附件"只能读秘书会话里的附件）。
// 现在的工具：秘书建、改、取消简单提醒（06，reminders/tools.ts），读取附件、把文件作为附件发出（09，media/attachment-tools.ts）；
// 建议发起任务、建任务卡、提问卡、写任务书（12，tasks/secretary-tools.ts）、维护者的提交计划（12，maintainers/tools.ts）；
// 建议立项（15）、提议快速动作（21）照这个加。
// 每个工具同时写明它在守卫的工具注册表里的登记（来源 host）：调用和别的工具一样先经守卫判定（07 号票）。
import { schemaChecker, type Static, type TSchema } from "@ergou/protocol";
import type { ArgRule, BottomLineId, BuiltinCategoryId, ToolDescriptor } from "../guard/index.ts";
import type { HostToolResult, HostToolSpec, JsonValue } from "../runtime/index.ts";
import type { AgentLink } from "./agent-manager.ts";

/** 一次调用：pi 给这次工具调用的 id，以及拉起这个 agent 的模块补上的情境 */
export interface HostToolCall {
  toolCallId: string;
  /** 调用发生时 agent 正在处理的那条用户消息（快速动作据此判定"用户明确点了"，21 号票） */
  inputMessageId?: string;
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
  /** 要出现在聊天里的卡片：拉起这个 agent 的模块往它的会话里追加一条只有卡片引用的消息（serveHostTools 的 onCards） */
  cardIds?: string[];
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
    },
    spec: {
      name: definition.name,
      description: definition.description,
      parameters: JSON.parse(JSON.stringify(definition.parameters)) as JsonValue,
    },
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    run(args, call) {
      if (!checker.check(args)) return { text: `参数不对：${checker.firstError(args) ?? "不合 schema"}`, isError: true };
      return definition.run(args, call);
    },
  };
}

export interface ServeHostToolsOptions {
  log: (line: string) => void;
  /** 工具产生了卡片（在把结果交回模型之前调用） */
  onCards?: (cardIds: string[]) => void;
  /** 每次调用时补上的情境（比如正在处理哪条用户消息） */
  context?: () => Omit<HostToolCall, "toolCallId">;
}

/** 接上一个 agent 子进程的工具；返回取消的函数 */
export function serveHostTools(agent: AgentLink, tools: readonly HostTool[], options: ServeHostToolsOptions): () => void {
  const { log } = options;
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
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
      reply({ text: "这个工具出错了，没做成", isError: true });
    };
    const tool = byName.get(report.toolName);
    if (!tool) return reply({ text: `没有这个工具：${report.toolName}`, isError: true });
    // 情境在调用到达时取（之后 agent 可能已经换到下一条输入）
    const controller = new AbortController();
    running.set(report.toolCallId, controller);
    const call: HostToolCall = { ...options.context?.(), toolCallId: report.toolCallId, signal: controller.signal };
    Promise.resolve()
      .then(() => tool.run(report.args, call))
      .then((out) => {
        if (out.cardIds?.length) options.onCards?.(out.cardIds);
        reply({ text: out.text, isError: out.isError ?? false });
      })
      .catch(failed)
      .finally(() => {
        if (running.get(report.toolCallId) === controller) running.delete(report.toolCallId);
      });
  });
}
