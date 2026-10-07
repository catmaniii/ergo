// 秘书的自定义工具：由守护进程代为执行（运行时的 hostTools），工具本身的逻辑和它要改的状态都在守护进程里。
// 第一阶段秘书的五种回复形态里，除了直接回答，其余四种各是一个只产生卡片的工具（规格第 7 节）：
// 建、改、取消简单提醒（06，reminders/tools.ts）；建议发起任务（12）、建议立项（15）、提议快速动作（21）由各自的票加。
// 秘书没有任何对卡片做动作的工具：卡片动作只接受来自前端的请求。
import { schemaChecker, type Static, type TSchema } from "@ergou/protocol";
import type { HostToolSpec, JsonValue } from "../runtime/index.ts";

export interface SecretaryToolResult {
  /** 给模型看的结果 */
  text: string;
  isError?: boolean;
  /** 要出现在聊天里的卡片：秘书往会话里追加一条只有卡片引用的消息 */
  cardIds?: string[];
}

export interface SecretaryTool {
  spec: HostToolSpec;
  /** 执行（参数已按 schema 校验过） */
  run(args: unknown): SecretaryToolResult;
}

/**
 * 定义一个秘书工具：参数用 TypeBox 写（共享协议包转出的 Type），序列化成 JSON Schema 交给子进程；
 * 守护进程这边再按同一个 schema 校验一次（不信任子进程转来的参数）。
 */
export function defineSecretaryTool<S extends TSchema>(definition: {
  name: string;
  description: string;
  parameters: S;
  run(args: Static<S>): SecretaryToolResult;
}): SecretaryTool {
  const checker = schemaChecker(definition.parameters);
  return {
    spec: { name: definition.name, description: definition.description, parameters: JSON.parse(JSON.stringify(definition.parameters)) as JsonValue },
    run(args) {
      if (!checker.check(args)) return { text: `参数不对：${checker.firstError(args) ?? "不合 schema"}`, isError: true };
      return definition.run(args);
    },
  };
}
