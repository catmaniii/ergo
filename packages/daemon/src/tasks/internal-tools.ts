// 项目的维护者在自己项目里发起任务的工具（64 号票，规格第 8 节"项目内部任务"；守护进程代为执行，只在它的对话段里有）。
// 发起的规矩和秘书一样（用户 2026-10-09 定，ADR 0019），发起的两个和秘书共用 launch-tools.ts：
// - start_workflow / create_task：用户在这个项目的维护者会话里点明了要发起流程 / 长程任务才建（点明的判断和秘书共用一份）。
//   建出的是项目内部任务：执行的就是这个维护者，只动这个项目，只在项目里看得到（不上全局看板，秘书看不到它的细节）；
// - suggest_task：用户没点明、维护者觉得该做维护时，最多给一张建议卡（一轮一张），卡上"作为流程""作为长程任务"，用户点了才建出
//   （tasks/cards.ts 的 suggestTaskCardType 认得卡上的 internal，通知交给维护者）；
// - write_task_brief：和用户对齐之后维护者自己写任务书，运行时派一张起草计划的工单给它（16 号票的单项目任务那一套：
//   这一段对话先收尾、写回，起草计划是新的一段）。
// 名字和秘书的那几个一样（点明的说法、拒绝时交回的原因都通用），说明写的是项目内部任务。
// @i18n-ignore-file model：工具说明、参数说明、工具结果都给维护者看，照旧中文；工具的中文名（title，界面上显示）跟着当前语言（172 号票）
import { forModel, t, type TaskKind, TASK_KIND_LABEL, TaskBrief, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { WORK_ORDER_TOOL } from "../projects/api.ts";
import { launchCommandText } from "./launch-intent.ts";
import { guarded, LAUNCH_PARAMS, launchTool, oncePerTurn, type UserTurnOf } from "./launch-tools.ts";
import type { TaskProjects, TaskService } from "./tasks.ts";
import { TASK_TOOL } from "./tool-names.ts";

const LaunchParams = Type.Object(LAUNCH_PARAMS, { additionalProperties: false });

const SuggestParams = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 80, description: "建议发起的任务的标题" }),
    why: Type.String({ minLength: 1, maxLength: 1000, description: "为什么建议：你注意到了什么（比如依赖好久没升级、某处重复代码越来越多）" }),
  },
  { additionalProperties: false },
);

const BriefParams = Type.Object({ taskId: Type.String({ description: "项目内部任务的编号，比如 t-3" }), ...TaskBrief.properties }, { additionalProperties: false });

/** 这个维护者在哪个项目里 */
export interface InternalTaskScope {
  projectId: string;
  maintainerId: string;
}

/** 建好之后交回维护者的话：先说出理解、对齐，再写任务书 */
export const internalCreatedText = (kind: TaskKind, task: { id: string; title: string }) =>
  `已建好项目内部${forModel(() => TASK_KIND_LABEL[kind])} ${task.id}「${task.title}」（规划中）：由你起草、执行，只在这个项目里看得到。` +
  `先说出你的理解（“我理解你要的是……，对吗？”），需要时直接问用户，对齐后用 ${TASK_TOOL.writeTaskBrief} 写任务书：` +
  `运行时把它作为一张起草计划的工单交回给你（这一段对话先收尾、写回项目档案，起草计划是新的一段）。`;

/** 发起一种项目内部任务：建在这个维护者的项目里 */
function internalLaunch(tasks: TaskService, scope: InternalTaskScope, kind: TaskKind) {
  return (args: { title: string; summary: string }) =>
    internalCreatedText(kind, tasks.createInternal({ projectId: scope.projectId, title: args.title, summary: args.summary, kind }, scope.maintainerId));
}

/** 项目维护者对话段里的发起工具：userTurn 是它正在处理的那条用户消息里用户说了什么（quick-actions 的 readUserTurn） */
export function internalTaskTools(deps: { tasks: TaskService; cards: CardService; projects: Pick<TaskProjects, "internalHost">; userTurn: UserTurnOf }, scope: InternalTaskScope): HostTool[] {
  const { tasks, cards } = deps;
  /** 一轮最多一张建议卡 */
  const suggestedThisTurn = oncePerTurn();
  return [
    launchTool(deps.userTurn, "workflow", {
      title: t("tasks.tools.startInternalWorkflow"),
      description:
        `用户在这个会话里点明了要按流程做（说了“按流程做”“发起一个流程”“作为流程”之类，或者输入 ${launchCommandText("workflow")}）时，在这个项目里建一个流程（项目内部任务，规划中）：` +
        "由你把要做的事排成步骤（每步一次工具调用，连同它要满足的条件），审查修补后用户一次授权，执行时按步骤做，执行中不能改步骤。只在这个项目里看得到。" +
        `用户没点明的不能用它（运行时会拒绝）。建好后先说出你的理解，再写任务书（${TASK_TOOL.writeTaskBrief}）。`,
      parameters: LaunchParams,
      create: internalLaunch(tasks, scope, "workflow"),
    }),
    launchTool(deps.userTurn, "long_running", {
      title: t("tasks.tools.createInternalTask"),
      description:
        `用户在这个会话里点明了要发起任务（说了“发起任务”“长程任务”“建个任务”之类，或者输入 ${launchCommandText("long_running")}；只说“发起任务”没说种类的就是它）时，在这个项目里建一个长程任务（项目内部任务，规划中）：` +
        "由你把工作拆成几个阶段，逐阶段执行和验收，执行中可以提计划变更。只在这个项目里看得到。" +
        `用户没点明的不能用它（运行时会拒绝），也不要出建议卡；点明的是流程时用 ${TASK_TOOL.startWorkflow}。建好后先说出你的理解，再写任务书（${TASK_TOOL.writeTaskBrief}）。`,
      parameters: LaunchParams,
      create: internalLaunch(tasks, scope, "long_running"),
    }),
    defineHostTool({
      name: TASK_TOOL.suggestTask,
      title: t("tasks.tools.suggestInternalTask"),
      description:
        `用户没点明要发起任务、你觉得这个项目该做一次维护（升级依赖、重构、按固定步骤发版……）时，给用户一张建议卡（一轮最多一张）。它不建任务：` +
        `卡上有“作为流程”“作为长程任务”两个按钮，用户点了才在这个项目里建出（项目内部任务），到时你会收到通知。用户点明了要发起的不要用它，直接用 ${TASK_TOOL.startWorkflow} 或 ${TASK_TOOL.createTask}。`,
      parameters: SuggestParams,
      readOnlyOrIdempotent: false,
      run: (args, call) =>
        guarded(() => {
          if (suggestedThisTurn(call.inputMessageId)) return { text: "这一轮已经给过一张建议卡了，一轮最多一张。", isError: true };
          // 卡上带着项目：点了建出的是这个项目的内部任务，通知交给你（tasks/cards.ts）；项目不能发起内部任务时（立项书还没确认、已归档）现在就说
          const host = deps.projects.internalHost(scope.projectId);
          const card = cards.create({ type: "suggest_task", payload: { title: args.title, why: args.why, internal: { projectId: host.id, projectName: host.name } } });
          return { text: "已在会话里放了一张建议卡（任务还没建）。用户点卡上的“作为流程”或“作为长程任务”才会在这个项目里建出，到时你会收到通知；不要口头答应去做。", cardIds: [card.id] };
        }),
    }),
    defineHostTool({
      name: TASK_TOOL.writeTaskBrief,
      title: t("tasks.tools.writeInternalBrief"),
      description:
        "和用户对齐意图之后，给这个项目的内部任务写任务书（目标、验收标准、约束、涉及的项目只写这个项目或空着、记忆范围提议）。" +
        "运行时把它作为一张起草计划的工单交回给你：这一段对话先收尾（写回项目档案、写这一段的摘要），起草计划是新的一段；计划卡会放进用户的待我处理，用户确认之前不动手。",
      parameters: BriefParams,
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const { taskId, ...brief } = args;
          const { task, revision } = tasks.writeBrief(taskId, brief, { maintainerId: scope.maintainerId });
          return {
            text: `${revision > 1 ? `任务书已改（第 ${revision} 版）` : "任务书已写好"}：${task.id}「${task.title}」的起草计划工单已经派给你。先把这一段对话写回项目档案（progress.md）、用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写摘要，工单才会开始。`,
          };
        }),
    }),
  ];
}
