// 发起任务的工具（秘书的，58 号票；项目的维护者的，64 号票：共用这一份）：
// - start_workflow / create_task：用户这一轮（agent 正在处理的那条用户消息）点明了这一种才建，否则把原因交回 agent
//   （launch-intent.ts 的 launchRefusal：秘书和项目的维护者共用一份判定）。建什么由调用方给：秘书建全局任务、或者替用户建
//   某个项目的内部任务；项目的维护者建这个项目的内部任务；
// - 建议卡（suggest_task）一轮最多一张：oncePerTurn。
// 都只产生卡片或改任务看板，不落入任何关注类别；任务号不对、状态不对之类被拒时，原因以出错的工具结果交回 agent（guarded）。
import { type PlannedTaskKind, type Static, type TSchema, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import type { UserTurn } from "../quick-actions/index.ts";
import { launchRefusal } from "./launch-intent.ts";
import { TASK_TOOL } from "./tool-names.ts";

/** 发起哪种任务用哪个工具（交回 agent 的原因里引用） */
export const LAUNCH_TOOLS = { workflow: TASK_TOOL.startWorkflow, long_running: TASK_TOOL.createTask, suggest: TASK_TOOL.suggestTask } as const;

/** 发起工具的参数：标题和用户要做的事；秘书的另有涉及的项目 */
export const LAUNCH_PARAMS = {
  title: Type.String({ minLength: 1, maxLength: 80, description: "任务的标题（短）" }),
  summary: Type.String({ minLength: 1, maxLength: 2000, description: "用户要做的事，照用户的话概括" }),
};

/** 用户正在处理的那条消息里说了什么（quick-actions 的 readUserTurn） */
export type UserTurnOf = (inputMessageId: string | undefined) => UserTurn;

/** 任务号不对、状态不对之类：把原因交回 agent，让它改了再试 */
export function guarded(f: () => HostToolOutput): HostToolOutput {
  try {
    return f();
  } catch (err) {
    if (err instanceof RequestRejected) return { text: err.message, isError: true };
    throw err;
  }
}

/** 发起一种任务的工具：用户这一轮点明了这一种才建（create 建出、返回交回 agent 的话），否则把原因交回 agent */
export function launchTool<S extends TSchema>(userTurn: UserTurnOf, kind: PlannedTaskKind, spec: { title: string; description: string; parameters: S; create(args: Static<S>): string }): HostTool {
  return defineHostTool({
    name: LAUNCH_TOOLS[kind],
    title: spec.title,
    description: spec.description,
    parameters: spec.parameters,
    // 每调用一次多一个任务
    readOnlyOrIdempotent: false,
    run: (args, call) =>
      guarded(() => {
        const refused = launchRefusal(userTurn(call.inputMessageId), kind, LAUNCH_TOOLS);
        if (refused) return { text: refused, isError: true };
        return { text: spec.create(args) };
      }),
  });
}

/** 一轮最多一张建议卡：这一轮（用户的一条消息、一条通知）已经给过了返回 true（同时记下这一轮） */
export function oncePerTurn(): (inputMessageId: string | undefined) => boolean {
  const seen = new Set<string>();
  return (inputMessageId) => {
    if (inputMessageId === undefined) return false;
    if (seen.has(inputMessageId)) return true;
    seen.add(inputMessageId);
    return false;
  };
}
