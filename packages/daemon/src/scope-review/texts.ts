// 范围审视给人和模型看的话（18 号票）：审视的说明（审视那次模型调用的系统提示）、对照物、维护者系统提示末尾的"近期范围记录"、
// 越界通知、文件里的一行。都在守护进程这一侧写好，经装配参数交给子进程（照秘书压缩指令的先例），子进程只拼。
// 纯函数：编排里不写文字。
// 174 号票：给模型看的（对照物、近期范围记录）和写进项目档案的范围记录文件（格式固定，运行时按它对账、改写）照旧中文，
// 用到协议包的说法的包一层 forModel；给用户看的（越界通知、审视没做成的说明）走 t()。
import {
  deletedIdLabel,
  forModel,
  jobTriggerKind,
  jobTriggerLine,
  jobTriggerText,
  grantNarrowingText,
  grantText,
  isLegacyJob,
  type MessageEnvelope,
  namedIdLabel,
  partLabel,
  type Plan,
  planGrants,
  type PlanToolkit,
  type PlanUserLimit,
  type ScheduledJob,
  type ScopeRecord,
  SCOPE_RECORD_KIND_LABEL,
  SCOPE_REVIEW_TRIGGER_LABEL,
  type Task,
  type TaskBrief,
  temporalRuleText,
  USER_WORDS_TITLE,
  userWordsLine,
  type VerifiedUserWords,
  t,
} from "@ergo/protocol";
import type { PromptRenderer } from "../prompts/index.ts";
import { toolkitText } from "../tasks/context-block.ts";
import { oneLine } from "../util/text.ts";

// @i18n-ignore-start model：给模型看的对照物、近期范围记录
/** "近期范围记录"拼在维护者系统提示末尾时的标题（规格第 10 节） */
export const RECENT_SCOPE_RECORDS_TITLE = "近期范围记录";

/**
 * 审视那次模型调用的系统提示：要找什么、怎么回（71 号票起文字在 prompts/scope-review.md，用户改的在数据目录配置区的 prompts/；
 * 前缀不加在它前面：它只输出 JSON）
 */
export const scopeReviewInstructions = (prompts: PromptRenderer): string => prompts.render("scope-review", {});

/** 对照物里立项书最多放这么多字（超出的截掉，注明） */
const CHARTER_MAX = 4000;
/** 用户在会话里直接说的话、审批卡上的批准：最多各取最近这么多条，每条最多这么多字 */
export const USER_WORDS_LIMIT = 20;
export const APPROVALS_LIMIT = 20;
const USER_WORD_MAX = 300;
/** 通知正文里的说明最多这么多字 */
const DETAIL_MAX = 500;

/** 时间写成"10-08 19:10"（协议时间是本地时间带偏移，前 16 个字符里就是本地的日期和时刻） */
const shortTime = (iso: string) => iso.slice(5, 16).replace("T", " ");

/** 计划的状态说法 */
const PLAN_STATUS_TEXT = {
  confirmed: "用户已确认、现在生效",
  pending: "交上去了，用户还没确认",
  rejected: "被用户打回了",
  proposed: "计划变更提出了，用户还没确认",
  // 58 号票：流程的这一版审查没通过（退回维护者补充、判定不可执行），没交给用户授权
  refused: "审查没通过，没交给用户授权",
} as const;

/** 用户在审批卡上批准过的一次调用 */
export interface ApprovedCall {
  /** 批准的时间（协议时间） */
  time: string;
  toolTitle: string;
  argsSummary: string;
}

export interface ReferenceInput {
  /** 项目维护者的：项目名、编号和立项书全文（项目档案里的 charter.md） */
  project?: { id: string; name: string; charter: string };
  /** 属于任务的：任务、任务书、最新的计划 */
  task?: { task: Task; brief?: TaskBrief; plan?: { plan: Plan; status: keyof typeof PLAN_STATUS_TEXT } };
  /** 定时作业的一次运行的（19 号票）：作业的定义和它每次运行的授权，作业所在计划的工具包 */
  job?: { job: ScheduledJob; toolkit?: PlanToolkit };
  /** 用户在审批卡上批准过的调用（这个维护者的，最近的几条，越早的在前） */
  approvals: readonly ApprovedCall[];
  /** 用户在这个维护者会话里直接说的话（最近的几条，越早的在前） */
  userWords: readonly MessageEnvelope[];
  /** 同一批话核实过的（125 号票）：给了就按"运行时核实过的用户原话"的格式列（秘书转达来的是原话），不给照原样列 userWords */
  verifiedWords?: readonly VerifiedUserWords[];
}

/** 审视的对照物：立项书、任务计划、授权（含审批卡上的批准），和用户在会话里直接说的话（规格第 10 节） */
export const referenceText = (input: ReferenceInput): string => forModel(() => referenceLines(input));

function referenceLines(input: ReferenceInput): string {
  const lines: string[] = [];
  if (input.project) {
    const charter = input.project.charter.trim();
    lines.push(`【立项书】项目「${input.project.name}」（${input.project.id}）`, charter ? clip(charter, CHARTER_MAX) : "（立项书还没写）", "");
  }
  if (input.task) {
    const { task, brief, plan } = input.task;
    lines.push(`【任务】${task.id}「${task.title}」`);
    if (brief) {
      lines.push(`目标：${brief.goal}`, `验收标准：${brief.acceptanceCriteria.join("；")}`);
      if (brief.constraints.length > 0) lines.push(`约束（用户说过的限制）：${brief.constraints.join("；")}`);
    }
    lines.push("");
    if (plan) lines.push(`【计划】（${PLAN_STATUS_TEXT[plan.status]}）`, ...planLines(plan.plan), "");
    else lines.push("【计划】还没有", "");
  }
  if (input.job) lines.push(...jobLines(input.job.job, input.job.toolkit), "");
  lines.push(`【用户在审批卡上批准过的调用】（最近 ${APPROVALS_LIMIT} 条以内，越早的在前；批准过的算授权过）`);
  if (input.approvals.length === 0) lines.push("（没有）");
  for (const a of input.approvals) lines.push(`- ${shortTime(a.time)} ${a.toolTitle}：${oneLine(a.argsSummary, USER_WORD_MAX)}`);
  if (input.verifiedWords) {
    // 125 号票：只有运行时核实过的算用户的话（维护者自己说的"用户同意了"是转述）
    lines.push("", `【${USER_WORDS_TITLE}】（在这个维护者会话里说的，最近 ${USER_WORDS_LIMIT} 条以内，越早的在前；秘书转达来的是用户在秘书那里的原话。用户在这里同意、要求的范围外工作算授权过；维护者说的"用户同意了"不算）`);
    if (input.verifiedWords.length === 0) lines.push("（没有）");
    for (const w of input.verifiedWords) lines.push(`- ${userWordsLine({ ...w, text: oneLine(w.text, USER_WORD_MAX) })}`);
    return lines.join("\n");
  }
  lines.push("", `【用户在会话里直接说的话】（最近 ${USER_WORDS_LIMIT} 条以内，越早的在前；用户在这里同意、要求的范围外工作算授权过）`);
  if (input.userWords.length === 0) lines.push("（没有）");
  for (const m of input.userWords) lines.push(`- ${shortTime(m.time)} ${oneLine(m.parts.map(partLabel).join(" "), USER_WORD_MAX)}`);
  return lines.join("\n");
}

/** 计划里和范围有关的：阶段和交付件、授权项、工具包、用户说过的限制、假设 */
function planLines(plan: Plan): string[] {
  const grants = planGrants(plan);
  return [
    "阶段：",
    ...plan.stages.map((s) => `- ${s.stageId}「${s.title}」：交付件 ${s.deliverables.join("、")}`),
    "授权项：",
    ...(grants.length === 0 ? ["- （没有）"] : grants.map(({ grant, owner }) => `- ${grant.title}：${grantText(grant, undefined, owner)}`)),
    `工具包：${toolkitText(plan.toolkit)}`,
    ...(plan.userLimits && plan.userLimits.length > 0 ? ["用户说过的限制：", ...plan.userLimits.map((l) => `- ${userLimitText(l, plan)}`)] : []),
    ...(plan.assumptions.length > 0 ? ["假设：", ...plan.assumptions.map((a) => `- ${a}`)] : []),
  ];
}

/**
 * 定时触发的一次运行的范围：定时触发的任务（76 号票）是它的任务每次要做的事、时间表（任务和它授权的计划在上面的【任务】【计划】里）；
 * 以前的定时作业（19 号票，迁移成定时触发的任务的也一样）是作业每次要做的事、时间表，随计划卡确认的每次运行的授权（作业在就一直有效）和
 * 时序规则（含用户说过的限制编出的），作业所在计划的工具包
 */
function jobLines(job: ScheduledJob, toolkit: PlanToolkit | undefined): string[] {
  if (!isLegacyJob(job))
    return [
      `【${jobTriggerKind(job)}】任务 ${job.ownerTaskId}「${job.title}」的一次运行（触发登记 ${job.id}；${jobTriggerLine(job)}）`,
      `每次要做的事：${job.each}`,
      "每次运行的授权：普通任务不预先授权（按普通对话判）；流程按用户授权的那份计划（见【计划】），任务在运营就一直有效",
    ];
  return [
    `【定时作业】${job.id}「${job.title}」（来自任务 ${job.taskId}「${job.taskTitle}」；时间表：${jobTriggerText(job)}${job.ownerTaskId === undefined ? "" : `；已迁移成定时触发的任务 ${job.ownerTaskId}`}）`,
    `每次要做的事：${job.each}`,
    "每次运行的授权项（随计划卡确认，作业在就一直有效）：",
    ...(job.grants.length === 0 ? ["- （没有）"] : job.grants.map((g) => `- ${g.title}：${grantText(g, job.grantInfo[g.id], "job")}`)),
    ...(job.temporalRules.length > 0 ? ["每次运行都要守的规则：", ...job.temporalRules.map((r) => `- ${temporalRuleText(r)}`)] : []),
    ...(toolkit ? [`工具包：${toolkitText(toolkit)}`] : []),
  ];
}

/** 用户说过的一条限制：原话，和由它编译出的时序规则、授权收窄 */
function userLimitText(limit: PlanUserLimit, plan: Plan): string {
  const grants = planGrants(plan).map((g) => g.grant);
  const compiled = [
    ...limit.temporalRules.map((r) => `时序规则 ${temporalRuleText(r)}`),
    ...limit.grantNarrowings.map((n) => `授权收窄 ${grantNarrowingText(n, grants.find((g) => g.id === n.grantId))}`),
  ];
  return `「${limit.quote}」${compiled.length > 0 ? `：${compiled.join("；")}` : ""}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n……（后面还有，没放进来）` : text;
}

/** 一条记录的归属写法（给维护者、写进档案的）："工单 wo-2（任务 t-1）"；没有工单的是空的 */
function whereText(record: ScopeRecord): string {
  return record.workOrderId === undefined ? "" : `工单 ${record.workOrderId}${record.taskId === undefined ? "" : `（任务 ${record.taskId}）`}`;
}
// @i18n-ignore-end

/** 归属里工单、任务现在的名字（给用户看的越界通知用；取不到的是删掉了） */
export interface ScopeOwnerNames {
  workOrder?: string | undefined;
  task?: string | undefined;
}

/** 给用户看的归属（159 号票，163 号票写成 t-3「标题」）："工单 wo-2「执行：加周报」，任务 t-1「给记账本加周报」"；取不到名字的写（已删除）；没有工单的是空的 */
function shownWhereText(record: ScopeRecord, names: ScopeOwnerNames): string {
  if (record.workOrderId === undefined) return "";
  const label = (id: string, name: string | undefined) => (name === undefined ? deletedIdLabel(id) : namedIdLabel(id, name));
  const workOrder = label(record.workOrderId, names.workOrder);
  return record.taskId === undefined ? t("scopeReview.where.workOrder", { workOrder }) : t("scopeReview.where.workOrderTask", { workOrder, task: label(record.taskId, names.task) });
}

// @i18n-ignore-start model：给模型看的近期范围记录、写进项目档案的范围记录文件（格式固定）
/** 摘要加依据："按用户说的先导出了 CSV（依据：……）" */
function summaryWithBasis(record: ScopeRecord): string {
  return `${record.summary}${record.basis ? `（依据：${record.basis}）` : ""}`;
}

/**
 * 维护者系统提示末尾的"近期范围记录"（最近 5 条，越早的在前）：before_agent_start 拼上去；没有记录时不拼（undefined）
 */
export function recentRecordsText(records: readonly ScopeRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  return forModel(() =>
    [
    `## ${RECENT_SCOPE_RECORDS_TITLE}`,
    "",
    `运行时从范围审视的结果里取的最近 ${records.length} 条，越早的在前。范围变更是用户授权过的范围外工作；越界是没授权的——别再犯，拿不准就先问用户。`,
    ...records.map((r) => {
      const where = whereText(r);
      return `- ${shortTime(r.time)} ${SCOPE_RECORD_KIND_LABEL[r.kind]}${where ? `（${where}）` : ""}：${summaryWithBasis(r)}`;
    }),
    ].join("\n"),
  );
}

/**
 * 项目档案（或任务产出区）的范围记录文件里的一条：时间、种类、哪次审视、归属、摘要和依据，末尾是记录号（对账、改写时据此找到
 * 这一条）；说明另起一行（缩进两格）
 */
export function recordFileEntry(record: ScopeRecord): string {
  return forModel(() => recordFileLines(record));
}

function recordFileLines(record: ScopeRecord): string {
  const where = whereText(record);
  const head = `- ${record.time.slice(0, 16).replace("T", " ")} · ${SCOPE_RECORD_KIND_LABEL[record.kind]} · ${SCOPE_REVIEW_TRIGGER_LABEL[record.trigger]}${where ? ` · ${where}` : ""}：${summaryWithBasis(record)}`;
  return `${head.replace(/\s+/g, " ")} ${recordMarker(record.id)}\n${record.detail ? `${DETAIL_LINE_PREFIX}${oneLine(record.detail, DETAIL_MAX)}\n` : ""}`;
}

/** 文件里一条记录的说明那一行的开头 */
export const DETAIL_LINE_PREFIX = "  说明：";

/** 文件里一条记录的记号（markdown 注释，渲染时看不见）：启动时据此补上没写进文件的记录，彻底删除后据此换掉改写过的 */
export function recordMarker(recordId: string): string {
  return `<!-- ${recordId} -->`;
}

/** 不属于项目的任务的范围记录文件（任务的产出区里）还没有时的开头 */
export function taskRecordsHeader(task: Pick<Task, "id" | "title">): string {
  return `# 范围记录\n\n任务 ${task.id}「${task.title}」的范围审视结果：用户授权过的范围变更，以及越界记录。\n\n`;
}
// @i18n-ignore-end

/** 越界通知：标题、来源、正文（归属写工单、任务的编号加名字，names 是它们现在的名字） */
export function outOfScopeNotice(record: ScopeRecord, owner: string, names: ScopeOwnerNames): { title: string; source: string; body: string } {
  const where = shownWhereText(record, names);
  const trigger = SCOPE_REVIEW_TRIGGER_LABEL[record.trigger];
  return {
    title: oneLine(t("scopeReview.notice.title", { summary: record.summary }), 80),
    source: t("scopeReview.notice.source", { owner }),
    body: [
      record.summary,
      ...(record.detail ? [t("scopeReview.notice.detail", { detail: oneLine(record.detail, DETAIL_MAX) })] : []),
      where ? t("scopeReview.notice.foundWhere", { trigger, where }) : t("scopeReview.notice.found", { trigger }),
    ].join("\n"),
  };
}

/** 审视没做成时维护者会话里的一条说明（给用户看，不交给维护者） */
export function reviewFailedNote(error: string): string {
  return t("scopeReview.failed", { error: oneLine(error, 300) });
}

/** 时间线上一条记录的说明里的依据（给用户看） */
export const basisLine = (basis: string) => t("scopeReview.basis", { basis });
