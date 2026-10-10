// 维护者每段会话开头的固定上下文（规格第 11、21 节，16 号票）：工具包说明、项目规范（第一阶段是一段内置的简短说明）、
// 项目档案快照（规格摘要、进展、术语表）、上一段的摘要、这次的工单（对话段没有）。重注入块（执行任务时）另由运行时
// 作为上下文消息注入，不在这里。纯函数：读项目档案、取上一段由调用方做好交进来。
// 每段是一个新的 pi 会话，更早的分段不进上下文：维护者对项目的理解靠项目档案和上一段的摘要。
import { isJobRunWorkOrder, type MaintainerSegment, type PlanToolkit, WORK_ORDER_KIND_LABEL, WORK_ORDER_SOURCE_LABEL, type WorkOrder } from "@ergou/protocol";
import { TOOL } from "../guard/index.ts";
import { WORK_ORDER_TOOL } from "./tool-names.ts";

/** 快照里每份文档最多放这么多字（超出的提示用 read 读全文） */
export const SNAPSHOT_MAX_CHARS = 3000;

export interface FixedContextInput {
  segment: MaintainerSegment;
  /**
   * 项目规范：第一阶段是一段内置的简短说明（完整的项目规范模板是第二阶段）。71 号票起文字在系统提示的文件里
   * （prompts/project-standard.md，用户改的在数据目录配置区的 prompts/），由调用方读好交进来
   */
  standard: string;
  /** 这一段的工具包（执行任务时是任务授权和项目工具包的交集） */
  toolkit: Pick<PlanToolkit, "skills" | "mcp" | "bash" | "network">;
  /** 这一段能用的工具名（pi 的工具和代为执行的工具） */
  tools: readonly string[];
  /** 项目档案里的几份文档的内容（读不到是空串） */
  records: { spec: string; progress: string; glossary: string };
  /** 上一段（重置维护者开的段、第一段没有） */
  previous: Pick<MaintainerSegment, "segmentId" | "workOrderId" | "summary"> | undefined;
  /** 工单段：这次的工单 */
  workOrder: WorkOrder | undefined;
}

/** 一份文档放进快照：太长的截断，提示读全文 */
function snapshot(title: string, file: string, text: string): string {
  const body = text.trim();
  if (!body) return `### ${title}（${file}）\n（空）`;
  const cut = body.length > SNAPSHOT_MAX_CHARS ? `${body.slice(0, SNAPSHOT_MAX_CHARS)}\n……（后面还有 ${body.length - SNAPSHOT_MAX_CHARS} 字，用 ${TOOL.read} 读 ${file} 全文）` : body;
  return `### ${title}（${file}）\n${cut}`;
}

function toolkitLine(toolkit: FixedContextInput["toolkit"], tools: readonly string[]): string {
  return [
    `工具包：bash ${toolkit.bash ? "开" : "关"}，联网${toolkit.network ? "开" : "关"}，skill：${toolkit.skills.join("、") || "（无）"}，MCP：${toolkit.mcp.join("、") || "（无）"}。`,
    `这一段能用的工具：${tools.join("、")}。`,
  ].join("\n");
}

function previousLine(input: FixedContextInput): string {
  if (input.segment.reset) return "上一段的摘要：没有。用户重置了维护者：只凭项目档案重建理解。";
  const p = input.previous;
  if (!p) return "上一段的摘要：没有（这是第一段）。";
  if (!p.summary) return `上一段的摘要：上一段（${p.segmentId}）没有留下摘要。`;
  return `上一段的摘要（${p.segmentId}${p.workOrderId ? `，工单 ${p.workOrderId}` : "，对话段"}）：\n${p.summary}`;
}

function workOrderLines(wo: WorkOrder | undefined): string[] {
  if (!wo) return ["这一段是对话段：没有工单，用户直接和你说话。告一段落时照样写回项目档案、写这一段的摘要。"];
  const belongs = isJobRunWorkOrder(wo) ? `定时触发（触发登记 ${wo.scheduledJobId}）的一次运行 ${wo.runId}` : `所属任务 ${wo.taskId}「${wo.taskTitle}」`;
  return [
    `这次的工单：${wo.id}「${wo.title}」，来自${WORK_ORDER_SOURCE_LABEL[wo.source]}，${belongs}，要做的是${WORK_ORDER_KIND_LABEL[wo.kind]}。`,
    ...(wo.instructions ? [`工单的内容：\n${wo.instructions}`] : []),
    ...(wo.kind === "plan"
      ? [`这一段只起草计划：工作目录和项目档案只读（和任务自己的维护者起草计划时一样）；写回要的进展用 ${WORK_ORDER_TOOL.writeProgress} 写，摘要用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写。`]
      : []),
    // 别的任务的维护者派来的改动（17 号票）：所属阶段、验收标准，做完交回执
    ...(wo.source === "task_maintainer"
      ? [
          `所属阶段：${wo.stageId}${wo.planned ? "" : "（计划外的工单，用户确认过才派来）"}。这张工单的验收标准：${wo.acceptance.join("；")}。`,
          `这个改动会伤害本项目时可以退回（写明理由）；做完、退回或做不了都用 ${WORK_ORDER_TOOL.submitReceipt} 交回执，回执交给派单的任务维护者。拿不准要问的用 ${WORK_ORDER_TOOL.askClarification}（问题交给任务维护者，不直接问用户）。`,
        ]
      : []),
  ];
}

/** 一段会话开头的固定上下文（拼在项目维护者的系统提示后面） */
export function fixedContextText(input: FixedContextInput): string {
  return [
    `【固定上下文】这是会话分段 ${input.segment.segmentId} 开始时运行时给你的；以项目档案为准。`,
    toolkitLine(input.toolkit, input.tools),
    input.standard,
    "项目档案快照：",
    snapshot("规格", "spec.md", input.records.spec),
    snapshot("进展", "progress.md", input.records.progress),
    snapshot("术语表", "glossary.md", input.records.glossary),
    previousLine(input),
    ...workOrderLines(input.workOrder),
  ].join("\n");
}
