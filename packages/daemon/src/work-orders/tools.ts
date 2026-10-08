// 项目维护者在工单和会话分段上的工具（守护进程代为执行，16 号票）：
// - write_segment_summary：写（或改）这一段的摘要。一段结束时运行时检查它写了没有、进展文档改了没有，下一段固定上下文里的
//   "上一段摘要"就是它；
// - write_progress：起草计划的工单段里写回进展（这一段工作目录和项目档案只读，和 12 号票"起草计划的维护者只读"一致；
//   写回要的只有进展文档和段摘要）：整份换掉 progress.md，旧版本运行时先留进历史区；
// - ask_clarification：做工单时遇到要问派单方的（用户发起的单项目任务就问用户）：工单转等澄清，问题以提问卡进待我处理，
//   执行中的这一支停下；回答作为通知交回维护者。
// 这几个工具都只改二狗自己的状态（写回进展是运行时要求的写回）、产生卡片，不落入任何关注类别，照样先经守卫。
import { QuestionDraft, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import type { ProjectService } from "../projects/projects.ts";
import { WORK_ORDER_TOOL } from "./tool-names.ts";
import type { WorkOrders } from "./work-orders.ts";

const SummaryParams = Type.Object(
  { summary: Type.String({ minLength: 1, maxLength: 4000, description: "这一段的摘要：做了什么、定了什么、没做完的、下一步是什么（给下一段的你看）" }) },
  { additionalProperties: false },
);

const ProgressParams = Type.Object(
  { content: Type.String({ minLength: 1, maxLength: 20_000, description: "进展 progress.md 的全文：做到哪了、下一步做什么（整份换掉原来的）" }) },
  { additionalProperties: false },
);

const ClarificationParams = Type.Object(
  {
    intro: Type.Optional(Type.String({ maxLength: 500, description: "卡片开头的一句话：为什么要问" })),
    questions: Type.Array(QuestionDraft, { minItems: 1, maxItems: 10, description: "要问的问题，每题带推荐答案" }),
  },
  { additionalProperties: false },
);

function guarded(f: () => HostToolOutput): HostToolOutput {
  try {
    return f();
  } catch (err) {
    if (err instanceof RequestRejected) return { text: err.message, isError: true };
    throw err;
  }
}

export function writeSegmentSummaryTool(workOrders: Pick<WorkOrders, "writeSummary">, maintainerId: string): HostTool {
  return defineHostTool({
    name: WORK_ORDER_TOOL.writeSegmentSummary,
    title: "写这一段的摘要",
    description: "写（或改）这一段会话的摘要：做了什么、定了什么、没做完的、下一步是什么。下一段会话开头的“上一段的摘要”就是它。一段结束前一定要写，进展 progress.md 也要更新。",
    parameters: SummaryParams,
    // 再写一次就是换成新的摘要
    readOnlyOrIdempotent: true,
    run: ({ summary }) =>
      guarded(() => {
        const segment = workOrders.writeSummary(maintainerId, summary);
        return { text: `已记下这一段（${segment.segmentId}）的摘要。进展 progress.md 也要写回，这一段才算完成。` };
      }),
  });
}

export function writeProgressTool(projects: Pick<ProjectService, "writeProgress">, workOrders: Pick<WorkOrders, "current">, maintainerId: string): HostTool {
  return defineHostTool({
    name: WORK_ORDER_TOOL.writeProgress,
    title: "写回进展",
    description: `起草计划这一段工作目录和项目档案只读，进展 progress.md 用它写回：给出全文（做到哪了、下一步做什么），整份换掉原来的（旧版本运行时自动留进历史区）。写完再用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写这一段的摘要。`,
    parameters: ProgressParams,
    // 同样的内容再写一次没有额外效果
    readOnlyOrIdempotent: true,
    run: ({ content }) =>
      guarded(() => {
        const segment = workOrders.current(maintainerId);
        if (!segment) throw new RequestRejected("not_allowed", "现在没有在进行的会话段");
        projects.writeProgress(segment.projectId, content);
        return { text: "进展 progress.md 已写回（旧版本留进了历史区）。" };
      }),
  });
}

export function askClarificationTool(workOrders: Pick<WorkOrders, "askClarification">, maintainerId: string): HostTool {
  return defineHostTool({
    name: WORK_ORDER_TOOL.askClarification,
    title: "向派单方提问",
    description:
      "做工单时遇到必须由派单方拍板的问题（用户发起的任务就是问用户；别的任务的维护者派来的工单是问那个任务维护者）：把问题成批交出（每题带推荐答案），工单转“等澄清”。问用户时提问卡进用户的待我处理，执行中的这一支先停下。回答作为通知交给你，接着做；用户关掉提问卡就按你自己的理解接着做。能自己定的不要问。",
    parameters: ClarificationParams,
    readOnlyOrIdempotent: false,
    run: (args) =>
      guarded(() => {
        const asked = workOrders.askClarification(maintainerId, { ...(args.intro === undefined ? {} : { intro: args.intro }), questions: args.questions });
        // 任务维护者派来的工单（17 号票）：问题交给派单的任务维护者，不出提问卡
        if (asked.cardId === undefined) return { text: `工单 ${asked.workOrderId} 转为等澄清，问题交给了派单的任务维护者。等回答（会作为通知交给你），这一轮先到这里。` };
        return { text: `工单 ${asked.workOrderId} 转为等澄清，提问卡放进了用户的待我处理。等回答（会作为通知交给你），这一轮先到这里。`, cardIds: [asked.cardId] };
      }),
  });
}
