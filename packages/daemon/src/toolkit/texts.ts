// 工具包（27 号票）给人和模型看的话，都在这里组织（编排在 toolkit.ts，只给结构化的数据）：
// 工具名、提交计划变更的工具名一律插值常量；"增减 skill"、"申请工具包变更"两个工具的说明和结果，改工具包被拒的原因，
// 时间线上记的为什么改，交给维护者的通知，"工具包变更"卡的纯文本降级和待我处理里的标题。
// 174 号票：给用户看的（改工具包被拒的原因、时间线上记的为什么改、卡片、待我处理的标题和来源、工具的名字）走 t()；
// 给维护者的（工具说明、工具结果、通知）照旧中文，用到协议包的说法的包一层 forModel。
import { forModel, type PlanToolkit, type SkillCollectionEntry, type SkillEntry, t, toolkitChangeText, toolkitText } from "@ergo/protocol";
import { EXECUTION_TOOL } from "../tasks/tool-names.ts";
import { ADJUST_SKILLS_TOOL, REQUEST_TOOLKIT_CHANGE_TOOL } from "./tool-names.ts";

/** 几个名字之间 */
const listOf = (names: readonly string[]) => names.join(t("toolkit.listSep"));

// ───────────────────────── 名字要在 skill 库里、登记过 ─────────────────────────

/** 工具包里的 skill 不在 skill 库里 */
export const unknownSkillsText = (names: readonly string[]) => t("toolkit.unknownSkills", { names: listOf(names) });
/** 工具包里的 MCP 没有登记 */
export const unknownMcpText = (names: readonly string[]) => t("toolkit.unknownMcp", { names: listOf(names) });
/** 几条问题连起来 */
export const problemsText = (problems: readonly string[]) => problems.join(t("toolkit.sep"));

// ───────────────────────── 用户直接改（项目页、任务详情） ─────────────────────────

export const planNotConfirmedText = () => t("toolkit.planNotConfirmed");
export const projectNotFoundText = (projectId: string) => t("toolkit.projectNotFound", { projectId });
export const taskNotFoundText = (taskId: string) => t("toolkit.taskNotFound", { taskId });
/** 时间线上记的为什么改（后面接改动） */
export const editedInProjectPage = () => t("toolkit.editedInProjectPage");
export const editedInTaskDetail = () => t("toolkit.editedInTaskDetail");

// ───────────────────────── 维护者增减 skill ─────────────────────────

export const adjustSkillsTitle = () => t("toolkit.tool.adjustSkills");
// @i18n-ignore-start model：工具说明、参数说明和工具结果（给维护者）
export const adjustSkillsDescription = [
  "给自己的工具包加上或去掉 skill（只能从二狗的 skill 库里选；skill 只是说明书，不增加权限，不用用户批准）。",
  "库里整套导入的集合（比如 pstack、matt-pocock）可以写集合名，整套加上或去掉它的全部成员；也可以只写其中几个 skill 的名字。",
  "每次增减写进工具包、记进时间线。这次调用结束后运行时按新的 skill 名单重新装配你的会话，下一次模型调用里就是新的名单，你接着原来的对话干。",
  `要开 bash、加 MCP、开联网不归这个工具：在任务里用 ${EXECUTION_TOOL.proposePlanChange} 提交计划变更，不在任务里用 ${REQUEST_TOOLKIT_CHANGE_TOOL} 申请。`,
].join("");
export const ADJUST_SKILLS_PARAMS = {
  add: "要加上的 skill 名（skill 库里的）；写集合名是整套加上",
  remove: "要去掉的 skill 名；写集合名是整套去掉",
  why: "为什么（记进时间线）",
} as const;
/** 要加的 skill 不在库里：库里有哪些（集合只列集合名和几个成员，72 号票） */
export function notInLibraryText(unknown: readonly string[], library: readonly SkillEntry[], collections: readonly SkillCollectionEntry[]): string {
  const singles = library.filter((s) => !s.collection).map((s) => s.name);
  const collectionLines = collections.map((c) => `${c.name}（${c.skills.length} 个：${c.skills.join("、")}）`);
  const listed = [singles.length > 0 ? singles.join("、") : "", collectionLines.length > 0 ? `集合（写集合名整套加，或写其中的 skill 名）：${collectionLines.join("；")}` : ""].filter(Boolean).join("。");
  return `skill 库里没有 ${unknown.join("、")}。库里有：${listed || "（空的）"}`;
}
export const notYourTaskText = (taskId: string) => `任务 ${taskId} 不是你执行的`;
// @i18n-ignore-end
export const skillsAdjustedWhy = (reason: string) => t("toolkit.skillsAdjustedWhy", { reason });
// @i18n-ignore-start model：工具结果（给维护者）
/** 增减 skill 之后给维护者的话；stillFromProject：任务里去掉了、但项目的工具包里还有的（会话里还在） */
export function skillsAdjustedText(before: PlanToolkit, after: PlanToolkit, stillFromProject: readonly string[] = []): string {
  if (before.skills.length === after.skills.length && before.skills.every((s) => after.skills.includes(s))) return "skill 名单没有变化。";
  const change = forModel(() => toolkitChangeText(before, after));
  const kept = stillFromProject.length > 0 ? `项目的工具包里也有 ${stillFromProject.join("、")}，会话里还在（要去掉得在项目的对话段里调，或者请用户在项目页改）。` : "";
  return `已改：${change}。${kept}这次调用结束后运行时按新的 skill 名单重新装配你的会话（下一次模型调用里就是新的名单），你接着干。`;
}
export const notChangedText = (reason: string) => `没改成：${reason}`;
// @i18n-ignore-end

// ───────────────────────── 项目维护者申请工具包变更 ─────────────────────────

export const requestToolkitChangeTitle = () => t("toolkit.tool.requestChange");
// @i18n-ignore-start model：工具说明、参数说明和工具结果（给维护者）
export const requestToolkitChangeDescription = [
  "不在任务里时调整项目的工具包：开 bash、开联网、加已登记的 MCP 要用户批准——运行时出一张“工具包变更”卡放进用户的待我处理，批准之前工具包不变；",
  "关 bash、关联网、去掉 MCP 是减少能力，直接生效。工具包变了之后运行时按新工具包重新装配你的会话，你接着原来的对话干。",
  `增减 skill 用 ${ADJUST_SKILLS_TOOL}（不用批准）；在任务里要加能力，用 ${EXECUTION_TOOL.proposePlanChange} 提交计划变更。`,
].join("");
export const REQUEST_TOOLKIT_CHANGE_PARAMS = {
  bash: "true：申请开 bash；false：关掉 bash（直接生效）",
  network: "true：申请开联网；false：关掉联网（直接生效）",
  addMcp: "申请加上的 MCP（登记过的名字）",
  removeMcp: "去掉的 MCP（直接生效）",
  why: "为什么要调（用户在卡上看得到）",
} as const;
export const unregisteredMcpText = (unknown: readonly string[], registered: readonly string[]) => `没有登记 MCP ${unknown.join("、")}。登记了的：${registered.join("、") || "（还没有）"}`;
// @i18n-ignore-end
export const reducedWhy = (reason: string) => t("toolkit.reducedWhy", { reason });
// @i18n-ignore-start model：工具结果（给维护者）
export const reducedText = (before: PlanToolkit, after: PlanToolkit, changed: boolean) =>
  changed ? `已减少：${forModel(() => toolkitChangeText(before, after))}，直接生效。` : "要减少的能力本来就没有。";
export const NOTHING_TO_REQUEST = "工具包里本来就有这些能力，不用申请。";
export const cardWaitingText = (cardId: string) => `上一张工具包变更卡（${cardId}）还在等用户，先等它有结论再申请。`;
export const requestedText = (additions: readonly string[]) =>
  `已提交工具包变更卡：要加 ${additions.join("、")}。用户批准之前工具包不变；批准后运行时按新工具包重新装配你的会话，拒绝会通知你。`;
// @i18n-ignore-end
/** 待我处理里的标题 */
export const toolkitChangeInboxTitle = (projectName: string, additions: readonly string[]) => t("toolkit.inboxTitle", { project: projectName, additions: listOf(additions) });
export const toolkitChangeSource = (projectName: string) => t("toolkit.source", { project: projectName });

// ───────────────────────── 用户在卡上批准、拒绝 ─────────────────────────

export const approvedWhy = () => t("toolkit.approvedWhy");
// @i18n-ignore-start model：交给维护者的通知
export const deniedNotice = (additions: readonly string[], comment: string | undefined) =>
  `用户拒绝了你申请的工具包变更（要加 ${additions.join("、")}）${comment ? `：${comment}` : ""}。工具包不变：在现有的工具包里接着做，做不了就告诉用户。`;
export const approvedNotice = (before: PlanToolkit, after: PlanToolkit, comment: string | undefined) =>
  forModel(() => `用户批准了你申请的工具包变更：${toolkitChangeText(before, after)}。现在的工具包：${toolkitText(after)}。${comment ? `用户说：${comment}` : ""}`);
// @i18n-ignore-end
/** "工具包变更"卡的纯文本降级 */
export const toolkitChangeCardText = (p: { projectName: string; additions: readonly string[]; why: string; applied?: PlanToolkit }) =>
  p.applied
    ? t("toolkit.cardTextApplied", { project: p.projectName, additions: listOf(p.additions), why: p.why, toolkit: toolkitText(p.applied) })
    : t("toolkit.cardText", { project: p.projectName, additions: listOf(p.additions), why: p.why });
