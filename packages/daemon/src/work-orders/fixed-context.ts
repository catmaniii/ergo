// 负责人每段会话开头的固定上下文：工具包说明、项目规范（第一阶段是一段内置的简短说明；后面
// 接本项目的规范改写和"有新版规范"的提示）、
// 项目档案快照（规格摘要、进展、术语表）、上一段的摘要、这次的工单（对话段没有）。重注入块（执行任务时）另由运行时
// 作为上下文消息注入，不在这里。纯函数：读项目档案、取上一段由调用方做好交进来。
// 每段是一个新的 pi 会话，更早的分段不进上下文：负责人对项目的理解靠项目档案和上一段的摘要。
// @i18n-ignore-file model：会话分段开始时交给负责人的固定上下文
import {
  isJobRunWorkOrder,
  type MaintainerSegment,
  type PlanToolkit,
  type ProjectStandardView,
  standardHasNewer,
  standardOverrideText,
  WORK_ORDER_KIND_LABEL,
  WORK_ORDER_SOURCE_LABEL,
  type WorkOrder,
  forModel,
} from "@ergo/protocol";
import { TOOL } from "../guard/index.ts";
import { PROPOSE_STANDARD_CHANGE_TOOL } from "../projects/tool-names.ts";
import { WORK_ORDER_TOOL } from "./tool-names.ts";

/** 快照里每份文档最多放这么多字（超出的提示用 read 读全文） */
export const SNAPSHOT_MAX_CHARS = 3000;

export interface FixedContextInput {
  segment: MaintainerSegment;
  /**
   * 项目规范：第一阶段是一段内置的简短说明（完整的项目规范模板是第二阶段）。文字在系统提示的文件里
   * （prompts/project-standard.md，用户改的在数据目录配置区的 prompts/），由调用方读好交进来
   */
  standard: string;
  /** 这个项目的规范现在的样子（本项目的规范改写、有没有新版）；不给就不写 */
  projectStandard?: Pick<ProjectStandardView, "version" | "latest" | "overrides"> | undefined;
  /** 这一段的工具包（执行任务时是任务授权和项目工具包的交集） */
  toolkit: Pick<PlanToolkit, "skills" | "mcp" | "bash" | "network">;
  /** 这一段能用的工具名（pi 的工具和代为执行的工具） */
  tools: readonly string[];
  /** 已登记的 MCP 清单：起草计划、申请工具包变更时对得上；没有就不写 */
  registeredMcp?: string | undefined;
  /** 项目档案里的几份文档的内容（读不到是空串） */
  records: { spec: string; progress: string; glossary: string };
  /** 上一段（重置负责人开的段、第一段没有） */
  previous: Pick<MaintainerSegment, "segmentId" | "workOrderId" | "summary"> | undefined;
  /** 工单段：这次的工单 */
  workOrder: WorkOrder | undefined;
  /** 这个项目前面的阶段估的和实际的工具调用次数：负责人起草计划时照这个比例估；关着预算控制、没有记录时没有 */
  callHistory?: readonly string[];
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
  if (input.segment.reset) return "上一段的摘要：没有。用户重置了负责人：只凭项目档案重建理解。";
  const p = input.previous;
  if (!p) return "上一段的摘要：没有（这是第一段）。";
  if (!p.summary) return `上一段的摘要：上一段（${p.segmentId}）没有留下摘要。`;
  return `上一段的摘要（${p.segmentId}${p.workOrderId ? `，工单 ${p.workOrderId}` : "，对话段"}）：\n${p.summary}`;
}

function workOrderLines(wo: WorkOrder | undefined): string[] {
  if (!wo) return ["这一段是对话段：没有工单，用户直接和你说话。告一段落时照样写回项目档案、写这一段的摘要。"];
  const belongs = isJobRunWorkOrder(wo) ? `定时触发（触发登记 ${wo.scheduledJobId}）的一次运行 ${wo.runId}` : `所属任务 ${wo.taskId}「${wo.taskTitle}」`;
  return [
    `这次的工单：${wo.id}「${wo.title}」，来自${forModel(() => WORK_ORDER_SOURCE_LABEL[wo.source])}，${belongs}，要做的是${forModel(() => WORK_ORDER_KIND_LABEL[wo.kind])}。`,
    ...(wo.instructions ? [`工单的内容：\n${wo.instructions}`] : []),
    ...(wo.kind === "plan"
      ? [`这一段只起草计划：工作目录和项目档案只读（和任务自己的负责人起草计划时一样）；写回要的进展用 ${WORK_ORDER_TOOL.writeProgress} 写，摘要用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写。`]
      : []),
    // 别的任务的负责人派来的改动：所属阶段、验收标准，做完交回执
    ...(wo.source === "task_maintainer"
      ? [
          `所属阶段：${wo.stageId}${wo.planned ? "" : "（计划外的工单，用户确认过才派来）"}。这张工单的验收标准：${wo.acceptance.join("；")}。`,
          `这个改动会伤害本项目时可以退回（写明理由）；做完、退回或做不了都用 ${WORK_ORDER_TOOL.submitReceipt} 交回执，回执交给派单的任务负责人。拿不准要问的用 ${WORK_ORDER_TOOL.askClarification}（问题交给任务负责人，不直接问用户）。`,
        ]
      : []),
  ];
}

/** 本项目的规范改写、模板出了新版：接在项目规范后面的几行；都没有是空的 */
export function standardNoteLines(view: FixedContextInput["projectStandard"]): string[] {
  if (!view) return [];
  return [
    ...(view.overrides.length > 0
      ? ["本项目的规范改写（用户确认过的，照它做；全文和变更记录在项目档案的 standard-overrides.md）：", ...view.overrides.map((o) => `- ${forModel(() => standardOverrideText(o))}`)]
      : []),
    ...(standardHasNewer(view) ? [`框架里有新版规范 ${view.latest}（这个项目用的是 ${view.version}）：不自动跟；用户要跟时用 ${PROPOSE_STANDARD_CHANGE_TOOL} 提出（upgrade）。`] : []),
  ];
}

/** 一段会话开头的固定上下文（拼在项目负责人的系统提示后面） */
export function fixedContextText(input: FixedContextInput): string {
  return [
    `【固定上下文】这是会话分段 ${input.segment.segmentId} 开始时运行时给你的；以项目档案为准。`,
    toolkitLine(input.toolkit, input.tools),
    ...(input.registeredMcp ? [input.registeredMcp] : []),
    input.standard,
    ...standardNoteLines(input.projectStandard),
    "项目档案快照：",
    snapshot("规格", "spec.md", input.records.spec),
    snapshot("进展", "progress.md", input.records.progress),
    snapshot("术语表", "glossary.md", input.records.glossary),
    previousLine(input),
    ...(input.callHistory ?? []),
    ...workOrderLines(input.workOrder),
  ].join("\n");
}
