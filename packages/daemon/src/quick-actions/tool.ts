// 秘书的"提议快速动作"工具（规格第 7 节五种回复形态之一，第 14 节）：只产生卡片，由守护进程代为执行。
// 秘书写清做什么（type）和这种动作的参数（params，形状由执行器自带的 schema 定，工具说明里逐个列出）。
// 是直接执行还是先问用户，由运行时判定（quick-actions.ts），秘书在参数里自称"用户点明了"不作数。
// @i18n-ignore-file model：工具的说明、参数说明给秘书（模型）看（174 号票）；工具的名字走 t()
import { t, type TSchema, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { QuickActionService } from "./quick-actions.ts";

export const PROPOSE_QUICK_ACTION = "propose_quick_action";

const Params = Type.Object(
  {
    type: Type.String({ minLength: 1, description: "动作类型，见工具说明里的列表" }),
    params: Type.Object({}, { additionalProperties: true, description: "这种动作的参数，见工具说明里每种动作的参数" }),
    explicit: Type.Optional(Type.Boolean({ description: "你是否认为用户这一句话里已经点明了对象和内容。只作参考：运行时自己核对用户的原话" })),
  },
  { additionalProperties: false },
);

/** 一种动作的参数怎么写（从它的 schema 里取参数名、说明、是否必填） */
function paramsHint(schema: TSchema): string {
  const json = JSON.parse(JSON.stringify(schema)) as { properties?: Record<string, { description?: string }>; required?: string[] };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {})
    .map(([name, p]) => `${name}${required.has(name) ? "" : "（可不填）"}：${p.description ?? ""}`)
    .join("；");
}

/** 秘书在某个会话里用的"提议快速动作"工具 */
export function proposeQuickActionTool(service: QuickActionService, conversation: string): HostTool {
  const executors = service.registry.list();
  const types = executors.map((e) => `- ${e.type}（${e.title}）：${e.usage}。params：${paramsHint(e.params)}`).join("\n");
  // 动作自带的提示（129 号票：记忆插件的"先用 search_materials 检索"），同一句只写一次
  const hints = [...new Set(executors.flatMap((e) => (e.proposeHint === undefined ? [] : [e.proposeHint])))].join("");
  return defineHostTool({
    name: PROPOSE_QUICK_ACTION,
    title: t("quickActions.tool.propose"),
    description: [
      "提议一个快速动作：一步就能做完、不需要别人干活的操作，由运行时直接执行（不拉起别的 agent、不上任务看板）。",
      "写清做什么（type）和参数（params）。用户这一句话里原样说了对象和内容的，运行时直接执行，聊天里留一张\"已执行\"的卡；",
      `否则出一张卡请用户确认后才执行。${hints}`,
      `能用的动作：\n${types}`,
    ].join("\n"),
    parameters: Params,
    // 只产生卡片（或执行用户点明了的动作），不落入任何类别：动作本身作为伪工具调用由快速动作模块交给类别匹配（judge.ts）。
    // 每调用一次多一张卡（或多执行一次），不是幂等的
    readOnlyOrIdempotent: false,
    run: (args, call) =>
      service.propose({
        type: args.type,
        params: args.params,
        conversation,
        ...(call.inputMessageId === undefined ? {} : { inputMessageId: call.inputMessageId }),
        toolCallId: call.toolCallId,
        ...(args.explicit === undefined ? {} : { claimedExplicit: args.explicit }),
      }),
  });
}
