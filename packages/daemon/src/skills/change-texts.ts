// skill 变更给人和模型看的话，都在这里组织（编排在 change.ts，只给结构化的数据）：
// 工具名、工具说明，卡的纯文本（动作、是谁提的、文件和脚本、在用它的工具包、自检结果），待办里的标题和来源，
// 时间线上的一句话和明细，审批决定的说法，交给负责人的通知。
// 给用户看的（工具的名字、卡、待办、时间线、审批决定、自检结果）走 t()；给负责人的（工具说明、工具结果、通知）照旧中文。
import { ASSISTANT_NAME_MARK, type SkillChangeAction, type SkillChangeCardPayload, type SkillChangeCheck, type SkillChangeSubmitter, type SkillChangeUser, type SkillDecidedPayload, t } from "@ergo/protocol";

/** 几个名字之间 */
const listOf = (names: readonly string[]) => names.join(t("skills.listSep"));

/** 一个提交的人的叫法（"项目「X」的负责人"、"任务「T」的负责人"，项目内部的任务带上项目；秘书写名字占位，前端按用户起的名字显示） */
export function whoText(submitter: SkillChangeSubmitter): string {
  if (submitter.kind === "secretary") return t("skills.change.who.secretary", { assistant: ASSISTANT_NAME_MARK });
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

// ───────────────────────── 工具（给秘书） ─────────────────────────

export const proposeSkillTitle = () => t("skills.tool.proposeSkill");
// @i18n-ignore-start model：工具说明和参数说明（给秘书）
export const PROPOSE_SKILL_DESCRIPTION = [
  "把一套做法写成 skill 提交进 skill 库：出一张“skill 变更”卡放进用户的待办，**要用户确认**。什么时候值得提交：用户让你记成 skill 的、以后反复要照着做的一套固定做法、查清的用法、踩过的坑；一次性的事、只是记一句偏好的不用（记偏好走记忆）。",
  "内容直接给，不用先写文件：name（skill 名，库里唯一，也是斜杠命令：小写字母、数字、短横线）、description（一句话写清什么时候用它、用了它你会怎么做——用户在卡上看的“它会改变什么行为”就是这句）、body（SKILL.md 的正文：照着就能做的步骤，Markdown，不写开头的 frontmatter）、why（为什么要它）。只是说明文字：不带脚本，不要写密钥。",
  "运行时替你拼成 SKILL.md、当场校验，不过就回原因、不出卡；过了出卡，卡上有 SKILL.md 全文和同名检查。库里已经有同名的也照样出卡，用户在卡上选覆盖、改名或放弃，不用你先换名字。用户确认之后运行时才写进 skill 区、自检，配进你用的 skill，下一轮起就能用（不配进任何项目的工具包）；拒绝则什么都不变。结果会通知你。",
  "不要自己往 skill 区写（受保护区域，守卫会拦下），也不要把内容贴在聊天里让用户手工存。改、删库里已有的 skill 不归你：告诉用户去设置的 skill 库页。",
].join("");
export const PROPOSE_SKILL_PARAMS = {
  name: "skill 名：小写字母、数字和短横线，最长 64（也是 skill 区里的目录名、斜杠命令）",
  description: "一句话：什么时候用它、用了它你会怎么做（写进 SKILL.md 的 description，用户在卡上看得到）",
  body: "SKILL.md 的正文（Markdown，不写 frontmatter）：别的 agent 或你自己以后照着就能做的步骤",
  why: "为什么要它（用户在卡上看得到）",
} as const;
// @i18n-ignore-end

/** 秘书给的说明、正文去掉空白之后是空的 */
export const emptyFieldText = (field: "description" | "body") => t(field === "description" ? "skills.change.emptyDescription" : "skills.change.emptyBody");
/** 秘书提交的卡上的覆盖、改名只给秘书提交的加 skill 用 */
export const resolutionNotForThisText = () => t("skills.change.resolution.notForThis");
/** 覆盖不了（不是能改的单个 skill、同名的已经没了） */
export const cannotOverwriteText = (problem: string) => t("skills.change.resolution.cannotOverwrite", { problem });
/** 改名、覆盖之后还是进不了库：卡留着，换一个选择 */
export const resolutionFailedText = (problem: string) => t("skills.change.resolution.failed", { problem });

// @i18n-ignore-start model：工具结果（给秘书）
export const proposedText = (payload: SkillChangeCardPayload) =>
  `已提交“skill 变更”卡：${changeText(payload.action, payload.name)}。用户确认之前 skill 库一个字节都不变；确认后运行时才写进去、自检，配进你用的 skill，下一轮起能用；拒绝也会通知你。${payload.sameName ? `库里已经有同名的（${payload.sameName.owner}）：卡上让用户选${payload.sameName.overwritable ? "覆盖、" : ""}改名或放弃，不用你再提。` : ""}`;
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

/** 同名检查的一句话：没撞上的（秘书提交的卡上）写没有同名的；撞上的写是谁、能不能覆盖 */
export function sameNameText(sameName: SkillChangeCardPayload["sameName"]): string {
  if (!sameName) return t("skills.change.sameName.none");
  return sameName.overwritable ? t("skills.change.sameName.overwritable", { owner: sameName.owner }) : t("skills.change.sameName.fixed", { owner: sameName.owner, problem: sameName.problem ?? "" });
}

/** 卡的纯文本里的明细：文件和脚本、不带的东西、依赖目录（秘书提交的只有一份 SKILL.md，不列，写同名检查）、在用它的工具包 */
function bodyLines(payload: SkillChangeCardPayload): string[] {
  const { source, usedBy } = payload;
  if (payload.submitter.kind === "secretary") return [sameNameText(payload.sameName), ...(usedBy && usedBy.length > 0 ? [t("skills.change.body.usedBy", { list: listOf(usedBy.map(userText)) })] : [])];
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

/** 配没配进提交人的工具包（秘书提交的：配进它用的 skill）；都没有时是空串 */
export function toolkitText(payload: Pick<SkillChangeCardPayload, "submitter" | "addedToToolkit" | "toolkitProblem">): string {
  const secretary = payload.submitter.kind === "secretary";
  if (payload.addedToToolkit === true) return secretary ? t("skills.change.toolkit.addedSecretary", { assistant: ASSISTANT_NAME_MARK }) : t("skills.change.toolkit.added");
  if (payload.toolkitProblem === undefined) return "";
  return secretary ? t("skills.change.toolkit.failedSecretary", { assistant: ASSISTANT_NAME_MARK, problem: payload.toolkitProblem }) : t("skills.change.toolkit.failed", { problem: payload.toolkitProblem });
}

/** 和库里同名时用户选了什么（覆盖了同名的、改名为 y）；没选的是空串 */
export function resolutionText(payload: Pick<SkillChangeCardPayload, "resolution" | "renamedTo">): string {
  if (payload.resolution === "overwrite") return t("skills.change.resolution.overwritten");
  if (payload.resolution === "rename") return t("skills.change.resolution.renamed", { name: payload.renamedTo ?? "" });
  return "";
}

/** "skill 变更"卡的纯文本降级 */
export function cardText(payload: SkillChangeCardPayload): string {
  const toolkitLine = toolkitText(payload);
  const result = [resolutionText(payload), payload.problem !== undefined ? t("skills.change.notAppliedNote", { name: payload.name, problem: payload.problem }) : payload.check ? checkText(payload.action, payload.check) : "", toolkitLine].filter(Boolean).join("\n");
  const head = t("skills.change.cardText", { who: whoText(payload.submitter), change: changeText(payload.action, payload.name) });
  return [payload.why ? t("skills.change.cardTextWhy", { head, why: payload.why }) : head, payload.description, ...bodyLines(payload), ...(result ? [result] : [])].join("\n");
}

// ───────────────────────── 时间线、审批决定 ─────────────────────────

/** 一次决定改了什么（"加 skill y"）；和库里同名时选了覆盖、改名的带上（"改 skill x（覆盖了库里同名的）"、"加 skill y（改名自 x）"） */
function decidedChangeText(p: Pick<SkillDecidedPayload, "action" | "name" | "resolution" | "renamedFrom">): string {
  const change = changeText(p.action, p.name);
  if (p.resolution === "overwrite") return t("skills.decision.overwrite", { change });
  if (p.resolution === "rename") return t("skills.decision.renamed", { change, from: p.renamedFrom ?? "" });
  return change;
}

/** 时间线上的一句话：批准了什么、自检结果；拒绝的写拒绝；批准了但没改成的写原因 */
export const timelineSummary = (p: Pick<SkillDecidedPayload, "decision" | "action" | "name" | "submitter" | "check" | "problem" | "resolution" | "renamedFrom">) => {
  const head = t("skills.change.timeline", { who: whoText(p.submitter), change: decidedChangeText(p), decision: p.decision === "approved" ? t("skills.change.timeline.approved") : t("skills.change.timeline.denied") });
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
  const change = decidedChangeText(p);
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

/** 交给秘书的：用户批准了它提交的 skill */
export const secretaryApprovedNotice = (p: SkillDecidedPayload, toolkit: { added: boolean; problem?: string | undefined }) => {
  const said = p.note ? `用户说：${p.note}。` : "";
  const check = p.check ? `，${checkText(p.action, p.check)}` : "";
  const how = p.resolution === "overwrite" ? "（覆盖了库里同名的，旧版运行时留了一份）" : p.resolution === "rename" ? `（库里有同名的，用户改名为 ${p.name} 进库，原来叫 ${p.renamedFrom ?? ""}）` : "";
  const placed = toolkit.added ? `已经配进你用的 skill，下一轮起就能用${p.resolution === "rename" ? `（名字是 ${p.name}）` : ""}；没配进任何项目的工具包，项目要用自己配。` : `没配进你用的 skill（${toolkit.problem ?? "原因不明"}）：用户可以在设置的 skill 库页勾上。`;
  return `用户批准了你提交的 skill：${changeText(p.action, p.name)}${how}${check}。${said}${placed}跟用户说一声就行。`;
};
export const secretaryDeniedNotice = (p: SkillDecidedPayload) => `用户没要你提交的 skill（${changeText(p.action, p.name)}）${p.note ? `：${p.note}` : ""}。skill 库不变。`;
export const secretaryNotAppliedNotice = (p: SkillDecidedPayload) => `用户批准了你提交的 skill（${changeText(p.action, p.name)}），但没进库：${p.problem ?? ""}。skill 库不变；要的话改好之后用 propose_skill 重新提交。`;
// @i18n-ignore-end
