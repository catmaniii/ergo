// skill 变更（358 号票）给人和模型看的话，都在这里组织（编排在 change.ts，只给结构化的数据）：
// 工具名、工具说明，卡的纯文本（动作、是谁提的、文件和脚本、在用它的工具包、自检结果），待办里的标题和来源，
// 时间线上的一句话和明细，审批决定的说法，交给负责人的通知。
// 给用户看的（工具的名字、卡、待办、时间线、审批决定、自检结果）走 t()；给负责人的（工具说明、工具结果、通知）照旧中文。
import { ASSISTANT_NAME_MARK, type SkillChangeAction, type SkillChangeCardPayload, type SkillChangeCheck, type SkillChangeSubmitter, type SkillChangeUser, type SkillDecidedPayload, t } from "@ergo/protocol";

/** 几个名字之间 */
const listOf = (names: readonly string[]) => names.join(t("skills.listSep"));

/** 一个提交的人的叫法（"项目「X」的负责人"、"任务「T」的负责人"，项目内部的任务带上项目） */
export function whoText(submitter: SkillChangeSubmitter): string {
  if (submitter.kind === "project") return t("skills.change.who.project", { project: submitter.projectName });
  return submitter.projectName === undefined ? t("skills.change.who.task", { task: submitter.taskTitle }) : t("skills.change.who.taskInProject", { task: submitter.taskTitle, project: submitter.projectName });
}

/** 动作的说法（"加"、"改"、"删"） */
export function actionText(action: SkillChangeAction): string {
  if (action === "add") return t("skills.change.action.add");
  if (action === "update") return t("skills.change.action.update");
  return t("skills.change.action.remove");
}

/** 一次变更说成一行（"加 skill notes-style"）：待办、时间线、审批决定都用它 */
export const changeText = (action: SkillChangeAction, name: string) => t("skills.change.line", { action: actionText(action), name });

// ───────────────────────── 工具（给负责人） ─────────────────────────

export const requestSkillChangeTitle = () => t("skills.tool.requestChange");
// @i18n-ignore-start model：工具说明和参数说明（给负责人）
export const requestSkillChangeDescription = [
  "把一个 skill 提交进 skill 库、改库里的、从库里删（action 是 add / update / remove）。什么时候值得提交：做事沉淀下来的、别的项目也用得上的经验（一套固定做法、查清的接口用法、踩过的坑），只有这个项目用得上的不用提交。",
  "怎么写：在你的工作目录或项目档案里单独建一个目录（目录名就是斜杠命令，小写、用短横线），里面放 SKILL.md，开头是 --- 包起来的 frontmatter：name（库里唯一，改的时候不能变）、description（一句话写清什么时候用它），正文写别的 agent 照着就能做的步骤；要带的脚本、模板放同一个目录，整个目录一起进库，最大 20 MB、2000 个文件，不能有符号链接或目录联接。不要放密钥：.env、*.pem、*.key 和隐藏目录不会带进去。",
  "提交之后运行时当场校验，不过就回原因、不出卡；过了出一张“skill 变更”卡放进用户的待办：用户看得到名字、说明、文件清单、有几个脚本、SKILL.md 全文。**要用户确认**：确认之后运行时才复制进 skill 区、自检、配进你的工具包并按新装配重新拉起你的会话；别的项目要用自己配。拒绝则什么都不变。",
  "确认之前不要再动这个目录：确认时内容和提交时不一样会被拒绝，要重新提交。你自己不要往 skill 区写：那是受保护区域，守卫会拦下。框架自带的 skill、集合里的成员不能改、不能删。",
].join("");
export const REQUEST_SKILL_CHANGE_PARAMS = {
  action: "add 加一个、update 改一个（内容整个换掉，名字和斜杠命令不变，旧版运行时留一份）、remove 删一个，都要用户确认",
  name: "skill 名：update、remove 必写（库里的名字）；add 不用写，以 SKILL.md 的 name 为准",
  path: "add、update 必写：skill 所在的目录，只能是你的工作目录或项目档案里的一个子目录（绝对路径，或相对工作目录）",
  why: "为什么要这么改（用户在卡上看得到）",
} as const;
// @i18n-ignore-end

/** 找不到提交的人（项目、任务被删了？） */
export const noSubmitterText = (target: string) => t("skills.change.noSubmitter", { target });
/** add、update 没写目录 */
export const pathRequiredText = (action: SkillChangeAction) => t("skills.change.pathRequired", { action });
/** update、remove 没写名字 */
export const nameRequiredText = (action: SkillChangeAction) => t("skills.change.nameRequired", { action });
/** add 时写的名字和 SKILL.md 对不上 */
export const nameMismatchText = (given: string, actual: string) => t("skills.change.nameMismatch", { given, actual });

// @i18n-ignore-start model：工具结果（给负责人）
export const requestedText = (payload: SkillChangeCardPayload) =>
  `已提交“skill 变更”卡：${changeText(payload.action, payload.name)}。用户确认之前 skill 库一个字节都不变；确认后运行时才写进去并自检，拒绝会通知你。${payload.source ? `确认之前不要再动 ${payload.source.path}：内容变了确认时会被拒绝，要重新提交。` : ""}`;
export const cardWaitingText = (name: string, cardId: string) => `skill ${name} 的上一张变更卡（${cardId}）还在等用户，先等它有结论再提。`;
export const notChangedText = (reason: string) => `没提交成：${reason}`;
// @i18n-ignore-end

// ───────────────────────── 卡上 ─────────────────────────

/** 待办里的标题 */
export const inboxTitle = (payload: Pick<SkillChangeCardPayload, "action" | "name" | "submitter">) => t("skills.change.inboxTitle", { who: whoText(payload.submitter), change: changeText(payload.action, payload.name) });
/** 待办里的来源 */
export const sourceOf = (submitter: SkillChangeSubmitter) => t("skills.change.source", { who: whoText(submitter) });

/** 自检对不上的原因 */
export const stillThereText = (name: string) => t("skills.change.check.stillThere", { name });
export const notFoundText = (name: string) => t("skills.change.check.notFound", { name });
export const mismatchText = (expected: string, actual: string) => t("skills.change.check.mismatch", { expected, actual });

/** 大小说成给人看的（KB、MB） */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return t("skills.change.size.bytes", { n: bytes });
  if (bytes < 1024 * 1024) return t("skills.change.size.kb", { n: Math.round(bytes / 102.4) / 10 });
  return t("skills.change.size.mb", { n: Math.round(bytes / 1024 / 102.4) / 10 });
}

/** 在用它的一方的叫法（个人助理写名字占位，前端按用户起的名字显示） */
export function userText(user: SkillChangeUser): string {
  if (user.kind === "assistant") return ASSISTANT_NAME_MARK;
  return user.kind === "project" ? t("skills.change.user.project", { title: user.title ?? "" }) : t("skills.change.user.task", { title: user.title ?? "" });
}

/** 卡的纯文本里的明细：文件和脚本、不带的东西、依赖目录、在用它的工具包 */
function bodyLines(payload: SkillChangeCardPayload): string[] {
  const { source, usedBy } = payload;
  return [
    ...(source
      ? [
          t("skills.change.body.files", { count: source.fileCount, size: sizeText(source.totalBytes) }),
          ...(source.scriptCount > 0 ? [t("skills.change.body.scripts", { count: source.scriptCount })] : []),
          ...(source.excluded.length > 0 ? [t("skills.change.body.excluded", { list: listOf(source.excluded) })] : []),
          ...(source.linked.length > 0 ? [t("skills.change.body.linked", { list: listOf(source.linked) })] : []),
        ]
      : []),
    ...(usedBy && usedBy.length > 0 ? [t("skills.change.body.usedBy", { list: listOf(usedBy.map(userText)) })] : []),
    ...(payload.action === "remove" ? [t("skills.change.body.removeEffect")] : []),
  ];
}

/** 自检结果的一句话（卡的说明、时间线、审批决定都用它） */
export function checkText(action: SkillChangeAction, check: Pick<SkillChangeCheck, "ok" | "problem">): string {
  if (!check.ok) return t("skills.change.check.failed", { problem: check.problem ?? "" });
  return action === "remove" ? t("skills.change.check.removed") : t("skills.change.check.passed");
}

/** 批准了、也改好了之后卡的处理结果（自检、配没配进工具包在卡的正文和纯文本里） */
export function appliedNote(payload: Pick<SkillChangeCardPayload, "action" | "name">): string {
  const done = payload.action === "add" ? t("skills.change.done.add") : payload.action === "update" ? t("skills.change.done.update") : t("skills.change.done.remove");
  return t("skills.change.appliedNote", { name: payload.name, done });
}
/** 批准了、但没改成（来源变了、重名了）时卡的处理结果 */
export const notAppliedNote = (name: string, problem: string) => t("skills.change.notAppliedNote", { name, problem });

/** "skill 变更"卡的纯文本降级 */
export function cardText(payload: SkillChangeCardPayload): string {
  const toolkitLine = payload.addedToToolkit === true ? t("skills.change.toolkit.added") : payload.toolkitProblem === undefined ? "" : t("skills.change.toolkit.failed", { problem: payload.toolkitProblem });
  const result = [payload.problem !== undefined ? t("skills.change.notAppliedNote", { name: payload.name, problem: payload.problem }) : payload.check ? checkText(payload.action, payload.check) : "", toolkitLine].filter(Boolean).join("\n");
  const head = t("skills.change.cardText", { who: whoText(payload.submitter), change: changeText(payload.action, payload.name) });
  return [payload.why ? t("skills.change.cardTextWhy", { head, why: payload.why }) : head, payload.description, ...bodyLines(payload), ...(result ? [result] : [])].join("\n");
}

// ───────────────────────── 时间线、审批决定 ─────────────────────────

/** 时间线上的一句话：批准了什么、自检结果；拒绝的写拒绝；批准了但没改成的写原因 */
export const timelineSummary = (p: Pick<SkillDecidedPayload, "decision" | "action" | "name" | "submitter" | "check" | "problem">) => {
  const head = t("skills.change.timeline", { who: whoText(p.submitter), change: changeText(p.action, p.name), decision: p.decision === "approved" ? t("skills.change.timeline.approved") : t("skills.change.timeline.denied") });
  if (p.problem !== undefined) return t("skills.change.timeline.notApplied", { head, problem: p.problem });
  return p.check ? t("skills.change.timeline.checked", { head, check: checkText(p.action, p.check) }) : head;
};

/** 时间线上的明细：说明、文件和脚本、不带的东西、在用它的工具包、用户写的话 */
export function timelineDetail(p: SkillDecidedPayload, payload: SkillChangeCardPayload): string {
  return [payload.description, ...bodyLines(payload), ...(p.note ? [t("skills.change.timeline.note", { note: p.note })] : [])].join("\n");
}

/** 审批决定说成一句话（素材） */
export function decisionText(p: SkillDecidedPayload): string {
  const whose = whoText(p.submitter);
  const change = changeText(p.action, p.name);
  if (p.decision === "denied") return t("skills.decision.denied", { who: whose, change });
  const result = p.problem !== undefined ? t("skills.change.notAppliedShort", { problem: p.problem }) : p.check ? checkText(p.action, p.check) : "";
  return t("skills.decision.approved", { who: whose, change, result });
}

/** 配进工具包时记在项目、任务那边的"为什么"（时间线上的工具包变更一句） */
export const addedToToolkitWhy = (name: string) => t("skills.change.toolkit.why", { name });

// ───────────────────────── 交给负责人的通知 ─────────────────────────

// @i18n-ignore-start model：交给负责人的通知
export const approvedNotice = (p: SkillDecidedPayload, toolkit: { added: boolean; problem?: string | undefined }) => {
  const said = p.note ? `用户说：${p.note}。` : "";
  const check = p.check ? `，${checkText(p.action, p.check)}` : "";
  if (p.action === "remove") return `用户批准了你的 skill 变更：${changeText(p.action, p.name)}${check}。${said}旧版运行时留了一份。工具包里还列着这个名字的，装配时跳过、不报错；要清掉用 adjust_skills 去掉。`;
  const placed = toolkit.added ? "已经配进你的工具包，你的会话按新装配重新拉起，接着用；别的项目要用自己配。" : `没配进你的工具包（${toolkit.problem ?? "原因不明"}）。`;
  return `用户批准了你的 skill 变更：${changeText(p.action, p.name)}${check}。${said}${placed}`;
};
export const deniedNotice = (p: SkillDecidedPayload) => `用户拒绝了你提的 skill 变更：${changeText(p.action, p.name)}${p.note ? `：${p.note}` : ""}。skill 库不变，接着做，做不了就告诉用户。`;
/** 用户点了确认、但改不成（来源在提交之后变了、重名了）：要重新提交 */
export const notAppliedNotice = (p: SkillDecidedPayload) => `用户批准了你的 skill 变更（${changeText(p.action, p.name)}），但没改成：${p.problem ?? ""}。skill 库不变；弄好之后用 request_skill_change 重新提交一张卡。`;
/** skill 库变了、会话要按新的装配重新拉起时告诉负责人的那句 */
export const reassembledNotice = (name: string) => `skill 库变了（${name}）：运行时按新的 skill 库重新装配了你的会话，接着原来的对话干。`;
// @i18n-ignore-end
