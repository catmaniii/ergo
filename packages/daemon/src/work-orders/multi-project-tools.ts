// 涉及多个项目的任务（17 号票）里工单往来的工具（守护进程代为执行，工具名在 tool-names.ts）：
// - 任务维护者的固定工具包（规格第 11 节"固定工具包"）：读项目档案（只能读这个任务涉及的项目）、派工单（dispatch_work_order，
//   规划期间被拒）、汇总回执（summarize_receipts）；回答项目维护者的提问（answer_work_order）算"派工单"那一样的工单往来；
//   答不了转问用户（forward_to_user，指明工单）是运行时控制，和 16 号票里维护者问用户同一条路（提问卡进待我处理）。
//   这几样都只改二狗自己的状态、产生卡片，不写文件、不跑 bash、不联网，改不了任何项目；
// - 项目维护者交回执（submit_receipt）：完成、退回（会伤害本项目的改动）或做不了，退回、做不了必须写理由。
// 计划外的工单命中"计划外工单"类别的判定不在守卫接入运行时那一步（派工单这个工具本身不落入任何类别），而在派单器里按派出的内容判
// （unplanned.ts），要确认的出工单卡，这次调用马上返回（不等用户确认）。
// @i18n-ignore-file model：工具说明、参数说明、结果和拒绝的原因给模型看（173 号票）；工具的名字走 t()
import { QuestionDraft, Type, t } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import { readProjectRecordsTool } from "../projects/records-tool.ts";
import type { ProjectService } from "../projects/projects.ts";
import type { MaintainerScope } from "../tasks/execution.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { EXECUTION_TOOL } from "../tasks/tool-names.ts";
import { MULTI_PROJECT_TOOL, WORK_ORDER_TOOL } from "./tool-names.ts";
import type { WorkOrders } from "./work-orders.ts";

function guarded(f: () => HostToolOutput): HostToolOutput {
  try {
    return f();
  } catch (err) {
    if (err instanceof RequestRejected) return { text: err.message, isError: true };
    throw err;
  }
}

const DispatchParams = Type.Object(
  {
    project: Type.String({ minLength: 1, description: "收件项目：项目编号（p-1）或项目名" }),
    stageId: Type.Optional(Type.String({ minLength: 1, description: "所属阶段；不写是你现在在做的阶段" })),
    instructions: Type.String({ minLength: 1, maxLength: 8000, description: "要这个项目做什么（第一行当工单的标题）；重新派单时写清这次怎么调整" }),
    acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "这张工单自己的验收标准：计划内的不写就照计划里那一行的；计划外的必须写" })),
  },
  { additionalProperties: false },
);

const ReceiptsParams = Type.Object({ stageId: Type.Optional(Type.String({ minLength: 1, description: "只看这个阶段的；不写是全部" })) }, { additionalProperties: false });

const AnswerParams = Type.Object(
  {
    workOrderId: Type.String({ minLength: 1, description: "在等澄清的工单（wo-N）" }),
    answer: Type.String({ minLength: 1, maxLength: 4000, description: "给项目维护者的回答" }),
  },
  { additionalProperties: false },
);

const ForwardParams = Type.Object(
  {
    workOrderId: Type.String({ minLength: 1, description: "项目维护者在问的那张工单（wo-N）" }),
    intro: Type.Optional(Type.String({ maxLength: 500, description: "卡片开头的一句话：为什么要问用户" })),
    questions: Type.Array(QuestionDraft, { minItems: 1, maxItems: 10, description: "要问用户的问题，每题带推荐答案" }),
  },
  { additionalProperties: false },
);

const ReceiptParams = Type.Object(
  {
    outcome: Type.Union([Type.Literal("done"), Type.Literal("returned"), Type.Literal("unable")], {
      description: "done 完成；returned 退回（这个改动会伤害本项目）；unable 做不了",
    }),
    summary: Type.String({ minLength: 1, maxLength: 4000, description: "回执：做了什么、改在哪、对照验收标准的结果（交给派单的任务维护者）" }),
    reason: Type.Optional(Type.String({ maxLength: 2000, description: "退回、做不了必须写：会伤害本项目的什么、为什么做不了" })),
  },
  { additionalProperties: false },
);

/** 任务维护者的固定工具包：读项目档案、派工单、汇总回执；绑定在它执行的任务上 */
export function multiProjectTools(deps: { workOrders: () => WorkOrders; projects: ProjectService; tasks: TaskService }, scope: MaintainerScope): HostTool[] {
  const multi = () => deps.workOrders().multiProject;
  const involved = () => {
    const task = deps.tasks.get(scope.taskId);
    return task ? multi().involvedProjects(task) : [];
  };
  return [
    readProjectRecordsTool(deps.projects, {
      projects: involved,
      description: "读这个任务涉及的某个项目的项目档案：立项书、规格、术语表、决策记录、进展、项目清单、范围记录。只读：你改不了任何项目，各项目的改动都靠派给它的维护者的工单。",
    }),
    defineHostTool({
      name: MULTI_PROJECT_TOOL.dispatchWorkOrder,
      title: t("workOrders.tools.dispatch"),
      description:
        `执行中给某个项目派一张工单，项目的维护者照它改自己的项目，完成或退回时交回执。计划里这个阶段有这个项目的一行的直接派出（可以改写内容；本阶段它上次退回、做不了的，这次重新派单是调整做法，算一次验收退回）；` +
        `没有的是计划外的工单，要用户确认后才派出（这次调用马上返回，确认的结果作为通知交给你）。规划期间不派工单（在计划里逐行写出每个项目的改动）。`,
      parameters: DispatchParams,
      readOnlyOrIdempotent: false,
      run: (args) =>
        guarded(() => {
          const r = multi().dispatch(scope, {
            project: args.project,
            instructions: args.instructions,
            ...(args.stageId === undefined ? {} : { stageId: args.stageId }),
            ...(args.acceptance === undefined ? {} : { acceptance: args.acceptance }),
          });
          const { wo, projectName } = r.order;
          if (r.unplanned && "direct" in r.unplanned) {
            if (wo.state === "ended") return { text: `工单 ${wo.id} → 项目「${projectName}」派出时就退回了：${wo.reason ?? ""}` };
            return {
              text: `已派出工单 ${wo.id} → 项目「${projectName}」：它是计划外的（阶段 ${wo.stageId} 没有这个项目的一行），命中「${r.unplanned.categories.join("、")}」，超出授权先不管、直接派出了，进了它的维护者的队列。等回执。`,
            };
          }
          if (r.unplanned) {
            return {
              text: `工单 ${wo.id} → 项目「${projectName}」是计划外的（阶段 ${wo.stageId} 没有这个项目的一行），命中「${r.unplanned.categories.join("、")}」：待用户确认，工单卡放进了用户的待我处理。用户确认后才派出，拒绝就不派；结果会作为通知交给你。`,
              cardIds: [r.unplanned.cardId],
            };
          }
          if (wo.state === "ended") return { text: `工单 ${wo.id} → 项目「${projectName}」派出时就退回了：${wo.reason ?? ""}` };
          return { text: `已派出工单 ${wo.id} → 项目「${projectName}」（计划内，阶段 ${wo.stageId}），进了它的维护者的队列。${r.countedReturn ? "这次是调整做法，算一次验收退回。" : ""}等回执。` };
        }),
    }),
    defineHostTool({
      name: MULTI_PROJECT_TOOL.summarizeReceipts,
      title: t("workOrders.tools.summarizeReceipts"),
      description: `汇总这个任务的工单（按阶段）：发给哪个项目、计划内还是计划外、现在怎样、验收标准、回执和理由，以及本阶段的回执到没到齐、能不能用 ${EXECUTION_TOOL.completeStage} 宣布完成。只读。`,
      parameters: ReceiptsParams,
      readOnlyOrIdempotent: true,
      nature: "look",
      run: (args) => guarded(() => ({ text: multi().receipts(scope, args.stageId) })),
    }),
  ];
}

/** 回答项目维护者在工单里问的（执行时才有工单可答；算"派工单"那一样的工单往来） */
export function answerWorkOrderTool(workOrders: () => Pick<WorkOrders, "answerWorkOrder">, scope: MaintainerScope): HostTool {
  return defineHostTool({
    name: MULTI_PROJECT_TOOL.answerWorkOrder,
    title: t("workOrders.tools.answer"),
    description: "回答项目维护者在工单里问的（工单在等澄清）：回答交回它，工单回到进行中。用户回答了你转问的问题之后，也用它把回答交回项目维护者。",
    parameters: AnswerParams,
    readOnlyOrIdempotent: false,
    run: (args) =>
      guarded(() => {
        const wo = workOrders().answerWorkOrder(scope, args.workOrderId, args.answer);
        return { text: `回答交给了项目维护者，工单 ${wo.id} 回到进行中。` };
      }),
  });
}

/** 任务维护者答不了项目维护者的提问时转问用户（运行时控制，和 16 号票里维护者问用户同一条路：提问卡进待我处理） */
export function forwardToUserTool(workOrders: () => Pick<WorkOrders, "forwardClarification">, scope: MaintainerScope): HostTool {
  return defineHostTool({
    name: MULTI_PROJECT_TOOL.forwardToUser,
    title: t("workOrders.tools.forward"),
    description: `项目维护者在工单里问的你答不了、要用户拍板：指明是哪张工单，把问题成批放进一张提问卡（每题带推荐答案），进用户的待我处理；这张工单所属阶段这一支先停下。用户回答后回答作为通知交给你，再用 ${MULTI_PROJECT_TOOL.answerWorkOrder} 交回项目维护者。`,
    parameters: ForwardParams,
    readOnlyOrIdempotent: false,
    run: (args) =>
      guarded(() => {
        const { cardId, workOrderId } = workOrders().forwardClarification(scope, { workOrderId: args.workOrderId, questions: args.questions, ...(args.intro === undefined ? {} : { intro: args.intro }) });
        return { text: `工单 ${workOrderId} 的问题转问了用户，提问卡放进了用户的待我处理。等回答（会作为通知交给你）。`, cardIds: [cardId] };
      }),
  });
}

/** 项目维护者交回执（任务维护者派来的工单段里才有） */
export function submitReceiptTool(workOrders: Pick<WorkOrders, "multiProject">, maintainerId: string): HostTool {
  return defineHostTool({
    name: WORK_ORDER_TOOL.submitReceipt,
    title: t("workOrders.tools.submitReceipt"),
    description:
      `做完任务维护者派来的工单时交回执：done 完成（写清做了什么、对照验收标准的结果）；这个改动会伤害本项目就 returned 退回，做不了就 unable，这两种必须写明理由。` +
      `交回执之后这一段收尾：照常把进展写回项目档案、用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写摘要，写回之后工单结束，回执交给派单的任务维护者。`,
    parameters: ReceiptParams,
    readOnlyOrIdempotent: false,
    run: (args) =>
      guarded(() => {
        const wo = workOrders.multiProject.submitReceipt(maintainerId, { outcome: args.outcome, summary: args.summary, ...(args.reason === undefined ? {} : { reason: args.reason }) });
        return { text: `工单 ${wo.id} 的回执记下了。这一段写回项目档案、写好摘要之后工单结束，回执交给任务维护者。` };
      }),
  });
}
