// 给秘书发消息（102 号票，letters.ts）给人和模型看的话：工具名、说明和结果，发信的是谁、在做什么，交给秘书的通知。
// 单独放一个文件：系统提示的占位符清单（prompts/registry.ts）、子 agent 的装配要引用工具名，不必拉进整个模块。
import { ASSISTANT_NAME_MARK, TASK_KIND_LABEL, type TaskKind } from "@ergou/protocol";
import { SEND_VOICE_TOOL } from "../voice/texts.ts";
import { MAINTAINER_LETTER_TAG } from "./notice-tags.ts";

/**
 * agent 能给谁发消息（收件人写成可扩展的形式，用户 2026-10-12：现在只有秘书；以后要加别的收件人只加一项登记——工具名、
 * 给人看的称呼——再接上它的转交）。不做 agent 之间的群聊、互发（规格第 12 节"星形通信"）
 */
export const LETTER_RECIPIENTS = {
  secretary: { tool: "tell_secretary", title: ASSISTANT_NAME_MARK },
} as const;
export type LetterRecipient = keyof typeof LETTER_RECIPIENTS;

/** 给秘书发消息的工具（除了秘书，所有 agent 默认都有） */
export const TELL_SECRETARY_TOOL = LETTER_RECIPIENTS.secretary.tool;
/** 中文名（工具调用记录、审批卡上给人看：写名字占位，43 号票） */
export const TELL_SECRETARY_TITLE = `给${ASSISTANT_NAME_MARK}发消息`;

/** 一条最多多少字 */
export const LETTER_MAX_CHARS = 2000;
/** 防刷屏：同一个 agent 多长时间里（毫秒）最多发几条（每个 agent 各算） */
export const LETTER_WINDOW_MS = 10 * 60_000;
export const LETTER_LIMIT = 3;

export const tellSecretaryDescription = [
  "给秘书（用户的个人助理）发一条消息，由它在和用户的主线对话里转告用户。运行时转交：秘书闲着时交给它，它用自己的话告诉用户、问要不要念给他听。",
  "只用于用户现在就该知道的事：做到一半的发现、阶段性的结果、要他抽空看一眼的东西；项目内部的任务或工单做完了，想把结果告诉用户。",
  "不要用：要交回派你的维护者的结果（子 agent 做完的结果、评审的结论照常交回，不经秘书）；不属于项目的任务做完（运行时会自动告诉秘书，带着最后说的那段话）；要用户批准或决定的事（走审批、待我处理）；闲聊。",
  "写成说给用户听的话：哪件事、什么结果、要用户做什么就写清楚。秘书看不到项目内部的细节，只照你写的转告，所以写全；不要写密钥、密码。",
  `每个 agent ${LETTER_WINDOW_MS / 60_000} 分钟里最多发 ${LETTER_LIMIT} 条，和自己上一条一字不差的不再发：没那么急的攒一攒一起说。`,
].join("");
export const TELL_SECRETARY_PARAM = `要告诉用户的话（最多 ${LETTER_MAX_CHARS} 字）`;

// 工具的结果也进工具调用记录给人看：写名字占位（43 号票），交给 agent 时守护进程换成"秘书"
/** 交给秘书了 */
export const LETTER_SENT = `已交给${ASSISTANT_NAME_MARK}：它闲着时会在主线里转告用户（它正在和用户说话的，等这一轮说完）。`;
/** 同一次调用又来一次（被打断后恢复时重做） */
export const LETTER_ALREADY_SENT = `这条已经交给${ASSISTANT_NAME_MARK}了，不用再发。`;
/** 和上一条一字不差 */
export const LETTER_DUPLICATE = `和你上一条发给${ASSISTANT_NAME_MARK}的一字不差，没有再发。`;
/** 发得太频繁：多久之后能再发 */
export const letterTooFrequent = (waitMs: number) =>
  `发得太频繁，攒一攒一起说：${LETTER_WINDOW_MS / 60_000} 分钟里最多发 ${LETTER_LIMIT} 条，这一条没有发（大约 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后能再发）。`;
/** 只有空白 */
export const LETTER_EMPTY = "要告诉用户的话是空的，没有发。";

// ───────────────────────── 谁发的、在做什么 ─────────────────────────
// 子 agent、评审子 agent 的称呼在 letters.ts（subAgentSender、reviewerSender）

/** 任务自己的维护者："长程任务 t-3「整理发票」的维护者" */
export const taskMaintainerName = (task: { id: string; title: string }, kind: TaskKind) => `${TASK_KIND_LABEL[kind]} ${task.id}「${task.title}」的维护者`;
/** 项目的维护者："项目「家庭相册」的维护者" */
export const projectMaintainerName = (projectName: string) => `项目「${projectName}」的维护者`;
/** 定时作业自己的维护者（76 号票之前的定时作业）："定时作业 j-1「…」的维护者" */
export const jobMaintainerName = (job: { id: string; title: string }) => `定时作业 ${job.id}「${job.title}」的维护者`;

/** 在做一次运行："第 3 次运行时" */
export const doingRun = (runLabel: string) => `${runLabel}时`;
/** 子 agent 在做一个阶段："在做阶段 s2「整理」时" */
export const doingStage = (stage: { stageId: string; title: string }) => `在做阶段 ${stage.stageId}「${stage.title}」时`;
/** 评审子 agent 在验收一个阶段："在验收阶段 s2「整理」时" */
export const doingAcceptance = (stage: { stageId: string; title: string }) => `在验收阶段 ${stage.stageId}「${stage.title}」时`;
/** 项目的维护者在做一张工单："在做任务 t-5「整理照片」的工单 wo-2 时" */
export const doingTaskWorkOrder = (wo: { id: string; taskId: string; taskTitle: string }) => `在做任务 ${wo.taskId}「${wo.taskTitle}」的工单 ${wo.id} 时`;
/** 在做项目内部的事（64、66 号票：秘书看不到项目内部的细节，不写是哪个任务）：项目的维护者、项目内部任务的子 agent、评审都用它 */
export const DOING_INTERNAL = "在做项目内部的一件事时";
/** 项目的维护者在做一次定时运行的工单："在做工单 wo-4「每日资讯」（第 3 次运行）时" */
export const doingRunWorkOrder = (wo: { id: string; title: string }, runLabel: string) => `在做工单 ${wo.id}「${wo.title}」（${runLabel}）时`;
/** 项目内部的定时运行 */
export const doingInternalRun = (runLabel: string) => `在做项目内部一件定时的事（${runLabel}）时`;
/** 项目的维护者在项目页上和用户直接说话的那一段 */
export const DOING_PROJECT_CHAT = "在项目的对话里";

// ───────────────────────── 交给秘书的通知 ─────────────────────────

/** 通知里的一条：谁（在做什么时）说的，和原话 */
export const letterItemText = (from: string, doing: string | undefined, text: string) => `${from}${doing ? `（${doing}）` : ""}说：\n${text}`;

/**
 * 交给秘书的通知（照 99 号票任务做完的写法）：开头是标记；几条差不多同时到的并在一条里、逐条编号；最后一句照系统提示里的规矩说要它做什么
 * （主动转告、项目内部的不追问、问要不要念）。这一类不放行发语音（100 号票只放行开了自动播报的任务做完），所以先问、用户说要再念
 */
export function letterNoticeText(items: readonly string[]): string {
  const head =
    items.length === 1
      ? `${MAINTAINER_LETTER_TAG}后台的一个 agent 让你转告用户一件事（运行时转交的，不是用户说的）：`
      : `${MAINTAINER_LETTER_TAG}后台的 agent 有 ${items.length} 条消息差不多同时到了，并在这一条里（运行时转交的，不是用户说的）：`;
  const body = items.length === 1 ? items : items.map((item, i) => `${i + 1}. ${item}`);
  const what = items.length === 1 ? "它" : "它们";
  const ask =
    `在主线里主动用你自己的话转告用户：是哪个项目或任务的谁（维护者、子 agent、评审）、说了什么；要用户做什么就说清楚。项目内部的细节只到${what}写的这些，不要追问。` +
    `然后问“要我念给你听吗？”。他说要，就用 ${SEND_VOICE_TOOL} 把口语稿念给他听；说不用就算了。`;
  return [head, ...body, ask].join("\n\n");
}
