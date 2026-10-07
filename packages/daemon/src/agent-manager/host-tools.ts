// 守护进程代为执行的工具（宿主工具）在守护进程这一侧：定义工具、接上一个 agent 子进程。
// 子进程发来 host_tool_call，按工具名找到实现、执行，回 host_tool_result。工具的声明（名字、说明、参数的 JSON Schema）
// 在拉起时随装配参数交给子进程（SpawnAgentRequest.hostTools）。
// 哪个 agent 有哪些工具、工具能碰什么，由拉起它的模块决定（比如秘书的"读取附件"只能读秘书会话里的附件）。
// 现在的工具：秘书建、改、取消简单提醒（06，reminders/tools.ts），读取附件、把文件作为附件发出（09，media/attachment-tools.ts）；
// 建议发起任务（12）、建议立项（15）、提议快速动作（21）照这个加。
import { schemaChecker, type Static, type TSchema } from "@ergou/protocol";
import type { AgentProcess, HostToolResult, HostToolSpec, JsonValue } from "../runtime/index.ts";

/** 一次调用：pi 给这次工具调用的 id */
export interface HostToolCall {
  toolCallId: string;
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
  /** 执行一次调用。抛错等同于出错的结果（错误记日志，模型只看到"没做成"） */
  run(args: JsonValue, call: HostToolCall): HostToolOutput | Promise<HostToolOutput>;
}

/**
 * 定义一个工具：参数用 TypeBox 写（共享协议包转出的 Type），序列化成 JSON Schema 交给子进程（pi 先按它校验）；
 * 守护进程这边再按同一个 schema 校验一次（不信任子进程转来的参数）。
 */
export function defineHostTool<S extends TSchema>(definition: {
  name: string;
  description: string;
  parameters: S;
  run(args: Static<S>, call: HostToolCall): HostToolOutput | Promise<HostToolOutput>;
}): HostTool {
  const checker = schemaChecker(definition.parameters);
  return {
    spec: { name: definition.name, description: definition.description, parameters: JSON.parse(JSON.stringify(definition.parameters)) as JsonValue },
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
}

/** 接上一个 agent 子进程的工具；返回取消的函数 */
export function serveHostTools(agent: AgentProcess, tools: readonly HostTool[], options: ServeHostToolsOptions): () => void {
  const { log } = options;
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  return agent.onReport((report) => {
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
    Promise.resolve()
      .then(() => tool.run(report.args, { toolCallId: report.toolCallId }))
      .then((out) => {
        if (out.cardIds?.length) options.onCards?.(out.cardIds);
        reply({ text: out.text, isError: out.isError ?? false });
      })
      .catch(failed);
  });
}
