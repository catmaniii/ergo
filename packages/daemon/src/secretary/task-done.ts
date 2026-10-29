// 任务做完告诉秘书（99 号票，规格第 7 节"任务做完告诉秘书"）：任务做完（普通任务、流程、长程任务变成已完成），定时 / 事件触发的任务
// 每运行完一次（看板频道 scheduled_job 的 run_finished，运行成功的；176 号票起还有部分完成的），运行时给秘书一条系统通知（开头是
// TASK_DONE_TAG），写明哪个任务（编号、标题、做法；运行的写第几次、怎么触发的）和做出来的结果（做它的 agent 最后说的那段话、交付的文件名，
// 太长截短并写明截了）。部分完成的写明哪几步没做成（运行记录上的原因），要秘书说清楚、问用户要不要补批或补做。
// 秘书收到后在主线里主动说一声、问用户要不要念出来，要就用发语音（send_voice，86 号票）念；规矩写在它的系统提示里（prompts/secretary.md）。
// - 项目内部的任务、作业不告诉（64、66 号票：秘书看不到项目内部的细节）。项目内部的普通任务做完照旧只说在哪个项目里做完了
//   （tasks/plain.ts 的 internalPlainDoneNotice，75 号票）。失败、等我的照旧走待我处理，不在这里。
// - 并成一条：做完一件先攒着，安静 settleMs（守护进程的 taskDoneSettleMs，默认 2 秒）没有新做完的才交；几件差不多同时做完的并成一条。
// - 等 agent 说完：流程报完最后一步、长程任务最后一个阶段验收通过时，做它的 agent 这一轮多半还没说完（最后那段话还没出来）：
//   等做完那一刻它在处理的那条输入结束再交（最多等 AGENT_WAIT_MS）。结果在交的时候才写，只算做完的那一轮（普通任务做完了
//   用户接着说、还没交就又做完的，各算各的：话和文件按这一轮开始、下一轮开始的那两条看板事件划开）。
// - 秘书忙时排在后面：秘书闲着才交——正在和用户说话的，这一轮完了再说；没起来的（拉起中、意外退出后等着重新拉起），起来闲着了再说。
//   交了就是秘书会话里一条排进输入队列的系统消息（和别的运行时通知一样），秘书处理它的那一轮在主线里说一声。
// - 不丢：通知的幂等键带着并进去的最后一条看板事件的全局序号（TASK_DONE_KEY_PREFIX）。守护进程启动时从事件日志里找最后一条，
//   它之后做完的（攒着还没交就停机了的）补上；一条都没交过的（刚升级上来）不往回翻。
// - 交成功才算交过：秘书处理这条通知到一半被打断（子进程崩溃、守护进程重启），AgentSession 照样把它标成中断出队，但不出
//   "请重发"的说明（redeliveredOnInterrupt，用户没法重发系统通知）；这里等秘书起来闲着了把同一段话再交一次（幂等键后面加 #第几次）。
//   只看每件通知最后交的那一次：那一次处理完了就不再交，不会说两遍。
// - 跑完自动播报（100 号票）：任务开着 voiceAnnounce 的，那一件写明"这件开了跑完自动播报"、带上产出区的位置（秘书可以读文件），
//   开着的单独交一条（不和关着的并在一起），开头在标记后面紧跟 AUTO_ANNOUNCE_TAG（秘书处理这一条的一轮能发语音，见
//   voice/send-voice.ts），要它不问、直接把要点念成语音，念不成退回文字、说原因；开没开看交的时候任务的开关。
//   一次运行只播报一次：交通知的去重照旧；被打断后重新交时看上次那一轮（noticeTurnVoices，按这一轮的序号认）的语音——
//   还在合成的等它有了结局再交，合成好了（done、partial）的去掉这个标记、写明念过了（ALREADY_ANNOUNCED），没念成的原样再交。
// - 维护者来信（102 号票，letters.ts）：维护者用 tell_secretary 发出的一条（secretary_letters 频道上的 maintainer_letter）照同一套交——
//   先攒着、安静了再交，秘书闲着才交、忙时排在后面、没起来的起来后补、被打断了重交、重启不重复。交的时候自成一条
//   （开头 MAINTAINER_LETTER_TAG，几条差不多同时到的并在一起），和同时攒着的任务做完的通知一起交、各是各的；幂等键是
//   LETTER_NOTICE_KEY_PREFIX 加并进去的最后一封信的全局序号，和任务做完的共用"交到哪了"（全局序号）：启动时两种都从那之后补；
//   一条都没交过的，信从头补（信是这时才有的，不会翻出一大堆）。
// - 会话里折成一行（115 号票）：交的通知上存一句话总结（任务做完的由这里拼："t-5「AI 日报」第 2 次运行做完了，交了 1 个文件"；
//   维护者来信是它给的总结），秘书会话里显示它，点开看全文；交给秘书的照旧是全文。被打断后重新交的总结照旧。
// - 交付的文件作为附件（115 号票，用户 2026-10-13 想在聊天里点开日报看）：任务做完的那几件交付的文件里能预览的（113 号票的
//   textPreviewOf：Markdown、纯文本）、不超过附件上限的，由运行时入库（媒体库按内容寻址，同样的内容只存一份），作为一条给人看的
//   系统消息（只有文件 part，不排进秘书的输入队列）紧跟在通知后面、同一事务追加，用户点"预览"去报告页。只在第一次交的时候放：
//   被打断后重新交、重启后补交的不再放一遍。不能预览的、太大的照旧只在通知的全文里写路径。
// - 来信带的附件（117 号票，letters.ts）：维护者用 tell_secretary 带来的文件写信时已经入库，交的时候照上面一样作为一排附件卡片
//   紧跟在那条来信通知后面（同一套：同一事务、同一个幂等键前缀、只在第一次交的时候放），不折进来信那一行；通知的全文里写附了
//   哪几个、附件引用（秘书要看内容用 read_attachment）。同一次交的几条里同一个文件（媒体 id 一样）只放一张：几封信带了同一个的、
//   维护者带着信发了交付件、紧接着任务做完又交了同一份的，放在先到的那条后面。
import fs from "node:fs";
import path from "node:path";
import {
  type AgentVoiceRecord,
  attachmentPartFrom,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  type FilePartValue,
  isDeletedEventPayload,
  isProjectInternal,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  runEvents,
  type ScheduledJobEventPayload,
  TASK_KIND_LABEL,
  type TaskEventPayload,
  taskKind,
  textPreviewOf,
  type MessageEnvelope,
  type JobRun,
  type ScheduledJob,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
  t,
  forModel,
} from "@ergo/protocol";
import { buildAgentNotice, buildMessage } from "../conversation/messages.ts";
import { getMessage, inputOf, startedInputs } from "../conversation/views.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import { mimeFromName } from "../media/file-types.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { jobKeys } from "../scheduled-jobs/keys.ts";
import { ownerName, runLabel } from "../scheduled-jobs/texts.ts";
import { TASK_RECORDS_FILE } from "../scope-review/scope-review.ts";
import { ignoredDeliveryDir, ignoredDeliveryFile } from "../tasks/delivery-ignore.ts";
import { taskWorkdir } from "../tasks/task-workdir.ts";
import { getTask } from "../tasks/views.ts";
import { toolVoicesOfTurn } from "../voice-records/agent-views.ts";
import { SEND_VOICE_TOOL } from "../voice-records/names.ts";
import { letterNoticeSummary, letterNoticeText } from "./letter-texts.ts";
import { describeLetter, isLetterToSecretary, letterAttachments, LETTERS_CHANNEL } from "./letters.ts";
import { AUTO_ANNOUNCE_TAG, isMaintainerLetterNotice, MAINTAINER_LETTER_TAG, TASK_DONE_TAG } from "./notice-tags.ts";

export { AUTO_ANNOUNCE_TAG, TASK_DONE_TAG };

/** 并成一条：做完一件之后安静多久（毫秒）没有新做完的才交给秘书 */
export const TASK_DONE_SETTLE_MS = 2000;

/** 做它的 agent 这一轮还没说完时最多等多久（毫秒）：到了就照现有的写 */
export const AGENT_WAIT_MS = 60_000;

/** 通知的幂等键：后面是并进去的最后一条看板事件的全局序号（启动时从这里接着补）；被打断后重新交的再加 #第几次 */
export const TASK_DONE_KEY_PREFIX = "task-done:";
/**
 * 跟在任务做完的通知后面的附件（115 号票）、跟在来信通知后面的附件（117 号票）的幂等键：后面的序号和那条通知第一次交时的一样，
 * 同一件只放一次
 */
export const TASK_DONE_FILES_KEY_PREFIX = "task-done-files:";
/** 维护者来信的通知（102 号票）的幂等键：后面是并进去的最后一封信的全局序号，被打断后重新交的同样加 #第几次 */
export const LETTER_NOTICE_KEY_PREFIX = "maintainer-letter:";

/** 两种通知：开头的标记、幂等键的前缀 */
const NOTICE_KINDS = [
  { tag: TASK_DONE_TAG, prefix: TASK_DONE_KEY_PREFIX },
  { tag: MAINTAINER_LETTER_TAG, prefix: LETTER_NOTICE_KEY_PREFIX },
] as const;
type NoticePrefix = (typeof NOTICE_KINDS)[number]["prefix"];

/** 第几次交这件通知的幂等键（第一次不带 #） */
const noticeKey = (prefix: NoticePrefix, seq: number, attempt: number) => `${prefix}${seq}${attempt > 1 ? `#${attempt}` : ""}`;

/** 是不是任务做完的通知（秘书会话里运行时发的、开头是标记的系统消息）：被打断时不出"请重发"的说明，由这里重新交 */
export function isTaskDoneNotice(message: MessageEnvelope): boolean {
  const first = message.parts[0];
  return message.speaker === "system" && first?.type === "text" && first.text.startsWith(TASK_DONE_TAG);
}

/** 被打断了由这里重新交的通知（任务做完、维护者来信）：秘书的 AgentSession 据此不出"请重发"的说明（redeliveredOnInterrupt） */
export function isRedeliveredNotice(message: MessageEnvelope): boolean {
  return isTaskDoneNotice(message) || isMaintainerLetterNotice(message);
}

/** 最后说的那段话最多带多少字 */
const SAID_MAX = 1000;
/** 交付的文件最多列几个 */
const FILES_MAX = 10;
/** 找交付的文件最多看多少个目录项（产出区里装了一大堆依赖的不全翻） */
const FILES_SCAN_MAX = 500;
/** 找最后说的话时往回最多看多少条消息 */
const SAID_LOOKBACK = 200;

/** 攒着的一件做完的事 */
interface Done {
  /** 看板频道上的那条事件（任务的 completed、运行的 run_finished） */
  event: StoredEvent;
  /**
   * 做完的那一刻做它的 agent 还在处理的输入（流程报完最后一步、长程任务最后一个阶段验收通过时那一轮还没完）：等它们结束再交。
   * 运行结束、普通任务做完时那一轮已经完了，没有；之后又来的新一轮（做完了用户接着说）不等
   */
  waitFor?: { agent: ConversationId; inputs: readonly string[] };
  /** 什么时候攒下的（时钟上的毫秒）：等 agent 说完最多等到 at + agentWaitMs */
  at: number;
}

/**
 * 看板频道上的一条事件是不是一件要告诉秘书的"做完了"：任务变成已完成、一次运行成功或部分完成（176 号票；项目内部的都不是）。
 * 定时任务改成某个时间做一次、那一次做成了，任务从运营中算完成（98 号票）：和那次运行的 run_finished 同一事务，
 * 只按那次运行说一件（写明任务随之完成），任务这一条不再另算
 */
export function isTaskDone(e: StoredEvent): boolean {
  if (e.channel !== CHANNELS.board || isDeletedEventPayload(e.payload)) return false;
  if (e.type === EVENT_TYPES.task) {
    const { task, change, from } = e.payload as TaskEventPayload;
    return change === "completed" && task.state === "done" && from !== "operating" && !isProjectInternal(task);
  }
  if (e.type === EVENT_TYPES.scheduledJob) {
    const { job, change, run } = e.payload as ScheduledJobEventPayload;
    return change === "run_finished" && (run?.state === "done" || run?.state === "partial") && !isProjectInternal(job);
  }
  return false;
}

/** 消息里的文字 */
const textOf = (p: MessageEventPayload) =>
  p.message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

/**
 * 这个会话里全局序号在 range 之间（after 之后、until 之前，没有 until 是到现在）、属于它的最后一条 agent 说的话（没有是 undefined）
 */
function lastSaid(store: EventStore, channel: ConversationId, range: { after: number; until?: number | undefined }, belongs: (p: MessageEventPayload) => boolean): string | undefined {
  let before = store.lastSeq(channel) + 1;
  let seen = 0;
  while (seen < SAID_LOOKBACK) {
    const page = store.readBefore(channel, before, 50, EVENT_TYPES.message);
    if (page.length === 0) return undefined;
    for (const e of page.toReversed()) {
      if (e.globalSeq <= range.after) return undefined;
      if (range.until !== undefined && e.globalSeq >= range.until) continue;
      seen += 1;
      if (isDeletedEventPayload(e.payload)) continue;
      const p = e.payload as MessageEventPayload;
      if (p.message.speaker !== "agent" || !belongs(p)) continue;
      const text = textOf(p);
      if (text) return text;
    }
    before = page[0]!.seq;
  }
  return undefined;
}

/**
 * 做完的这一轮从哪条看板事件开始（done 之前最后一次开始执行或接着做），下一轮从哪条开始（done 之后第一次接着做：
 * 普通任务做完了用户接着说是新的一轮，还没交就又做完了的，这一轮的话和文件不算上下一轮的）
 */
function roundOf(store: EventStore, taskId: string, done: number): { start?: StoredEvent | undefined; next?: StoredEvent | undefined } {
  let start: StoredEvent | undefined;
  for (const e of store.read(CHANNELS.board, 0, EVENT_TYPES.task)) {
    if (isDeletedEventPayload(e.payload)) continue;
    const p = e.payload as TaskEventPayload;
    if (p.task.id !== taskId || (p.change !== "started" && p.change !== "continued")) continue;
    if (e.globalSeq > done) return { start, next: e };
    start = e;
  }
  return { start };
}

/**
 * 交付的文件：产出区（dir）里这一轮（since 之后，有下一轮的到 until 为止）改过的文件，相对路径、按名字排。不看隐藏的、链接，
 * 也不看运行时自己写的范围记录；311 号票起缓存、依赖、编译产物也不看（tasks/delivery-ignore.ts：__pycache__、*.pyc、node_modules……）；
 * 目录不在是空的
 */
function deliveredFiles(dir: string, since: string | undefined, until?: string | undefined): string[] {
  // 开始那条事件总在 agent 动手之前落盘（时间到毫秒），不用放宽
  const sinceMs = since === undefined ? 0 : Date.parse(since);
  const untilMs = until === undefined ? Infinity : Date.parse(until);
  const found: string[] = [];
  let scanned = 0;
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      scanned += 1;
      if (scanned > FILES_SCAN_MAX) return;
      if (entry.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDeliveryDir(entry.name)) walk(child);
      } else if (entry.isFile() && !ignoredDeliveryFile(entry.name) && !(rel === "" && entry.name === TASK_RECORDS_FILE)) {
        try {
          const { mtimeMs } = fs.statSync(path.join(dir, child));
          if (mtimeMs >= sinceMs && mtimeMs < untilMs) found.push(child);
        } catch {
          // 刚好被删了：不算
        }
      }
    }
  };
  walk("");
  return found;
}

/**
 * 通知里的一件：哪个任务做完了，它最后说的话（太长截短并写明），交付的文件。dir 是交付的文件所在的产出区（开了跑完自动播报的给，
 * 100 号票：秘书要直接念，写明在哪、可以读）
 */
export function taskDoneItemText(head: string, said: string | undefined, files: readonly string[], dir?: string): string {
  // @i18n-ignore-start model：交给秘书的通知
  const lines = [head];
  if (said === undefined) lines.push("它没有留下结果的说明。");
  else if (said.length > SAID_MAX) lines.push(`它最后说（太长，这里只留了前 ${SAID_MAX} 字，原文在任务详情里）：`, `${said.slice(0, SAID_MAX)}……`);
  else lines.push("它最后说：", said);
  const where = dir === undefined ? "在任务的产出区里" : `在任务的产出区 ${dir} 里，要细节可以读`;
  if (files.length > 0) lines.push(`交付的文件（${where}）：${files.slice(0, FILES_MAX).join("、")}${files.length > FILES_MAX ? ` 等 ${files.length} 个` : ""}`);
  // @i18n-ignore-end
  return lines.join("\n");
}

/** 通知里的一件：写好的一段，这件开没开跑完自动播报（100 号票），是不是部分完成的一次运行（176 号票） */
export interface TaskDoneItem {
  text: string;
  announce: boolean;
  partial?: boolean;
}

/** 交的时候写好的一件（115 号票起多了会话里那一行的总结、交付的文件） */
interface DescribedDone extends TaskDoneItem {
  /** 一句话总结里这一件的称呼："t-1「下歌」"、"t-5「AI 日报」第 2 次运行"（76 号票之前的定时作业写作业的编号） */
  name: string;
  /** 这一件的一句话总结 */
  summary: string;
  /** 交付的文件（绝对路径，按通知里列的先后）：能预览的作为附件放进秘书会话 */
  files: readonly string[];
}

/** 一件的一句话总结（115 号票）："t-5「AI 日报」第 2 次运行做完了，交了 1 个文件"；部分完成的一次运行写"部分完成"（176 号票） */
export function taskDoneItemSummary(name: string, files: number, partial = false): string {
  if (files === 0) return t(partial ? "secretary.taskDone.partial" : "secretary.taskDone.done", { name });
  return t(partial ? "secretary.taskDone.partialWithFiles" : "secretary.taskDone.doneWithFiles", { name, count: files, files });
}

/** 通知那一行的一句话总结（115 号票）：一件就是它的；几件并在一起的写几件、各是哪件（一行放不下的由界面省略） */
export function taskDoneSummary(items: readonly { name: string; summary: string }[]): string {
  return items.length === 1 ? items[0]!.summary : t("secretary.taskDone.several", { count: items.length, names: items.map((i) => i.name).join(t("pages.common.listSep")) });
}

// @i18n-ignore-start model：交给秘书的通知和规矩
/** 开了跑完自动播报的那一件在通知里的标注（写在这件的第一句后面） */
const ANNOUNCE_MARK = "这件开了跑完自动播报。";

/** 直接念的规矩（100 号票，用户定：要点 5 条以内，链接表格代码不念，细节看报告；念不成退回文字、说原因） */
const ANNOUNCE_RULES =
  `把结果的要点念给用户听——5 条以内，像平常说话一样；链接、表格、代码不念，说一句“链接在任务里”；细节让他去看任务里的报告。` +
  `要点从它最后说的话里挑，不够就先读交付的文件。${SEND_VOICE_TOOL} 回失败（语音服务没开、忙、超时、没有参考音色、太长）就把要点用文字发在主线里，再用一句话说为什么没念成。`;

/**
 * 部分完成的那几件（176 号票，用户 2026-10-19 定）：说清哪一步没做成、要不要用户补批或补做。审批挂起之后卡还在待办里，
 * 用户批了运行时会告诉做它的 agent 可以重做那一步；交给他亲手做的事项也在待办里
 */
export const PARTIAL_RULES =
  "标着“部分完成”的（有一步没做成，别的做完了），说的时候讲清哪一步没做成：没等到批准的，审批卡还在待办里，问他要不要去补批（批了会通知它重做那一步）；要他亲手做的，问他要不要去待办里补做。";

/** 语音插件不在时（214 号票）：只用文字说一声，不问要不要念（秘书没有发语音工具） */
const tellText = (what: string) => `在主线里主动跟用户说一声：用一两句话说${what}做完了、结果大概是什么。`;

/** 问要不要念（99 号票） */
const askText = (what: string) =>
  `在主线里主动跟用户说一声：用一两句话说${what}做完了、结果大概是什么，然后问“要我念给你听吗？”。他说要，就用 ${SEND_VOICE_TOOL} 把结果的口语稿念给他听；说不用就算了。`;

/**
 * 交给秘书的通知：几件差不多同时做完的并在一条里；最后一句照系统提示里的规矩说要它做什么。开了跑完自动播报的（100 号票）单独一条
 * （交的时候分开，不和关着的并在一起）：开头在任务做完的标记后面紧跟 AUTO_ANNOUNCE_TAG（秘书处理这一轮能发语音），要它不问、直接念。
 * 混着交进来的（不该发生）按关着的写：不放行语音。speaks 为 false（214 号票：语音插件没在运行）时不问要不要念，只用文字说一声
 * （这时不会有开了自动播报的：describeDone 按它记成关着）
 */
export function taskDoneNoticeText(items: readonly TaskDoneItem[], speaks = true): string {
  const announce = items.length > 0 && items.every((i) => i.announce);
  const tag = announce ? `${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}` : TASK_DONE_TAG;
  const head =
    items.length === 1
      ? `${tag}后台有一件事${items[0]!.partial ? "部分完成" : "做完"}了（运行时发来的，不是用户说的）：`
      : `${tag}后台有 ${items.length} 件事差不多同时做完了，并在这一条里（运行时发来的，不是用户说的）：`;
  const body = items.length === 1 ? items.map((i) => i.text) : items.map((item, i) => `${i + 1}. ${item.text}`);
  const what = items.length === 1 ? "这件" : "这几件";
  const ask = announce ? `${what}开了跑完自动播报（用户事先说好了的）：不用问，直接用 ${SEND_VOICE_TOOL} ${ANNOUNCE_RULES}` : speaks ? askText(what) : tellText(what);
  return [head, ...body, ask, ...(items.some((i) => i.partial) ? [PARTIAL_RULES] : [])].join("\n\n");
}

/** 被打断后重新交时，上次那一轮已经念过了（100 号票：一次运行只播报一次）：去掉自动播报的标记，末尾加这句 */
export const ALREADY_ANNOUNCED = `上次处理这条通知时已经用 ${SEND_VOICE_TOOL} 念过了（语音气泡在主线里），这次不要再念、也不用再问；没说完的话用文字补一句就行。`;
// @i18n-ignore-end

/**
 * 一件做完的事写成通知里的一段（交的时候才写：agent 最后说的话那时才齐）；开没开跑完自动播报看任务现在的开关
 * （214 号票：语音插件没在运行——speaks 为 false——时当作关着，念不了）。连同会话里那一行的总结和交付的文件（115 号票）
 */
function describeDone(store: EventStore, outputsDir: string, e: StoredEvent, speaks: boolean): DescribedDone {
  if (e.type === EVENT_TYPES.task) {
    const { task } = e.payload as TaskEventPayload;
    const { start, next } = roundOf(store, task.id, e.globalSeq);
    const said = lastSaid(store, maintainerChannel(task.maintainerId), { after: start?.globalSeq ?? 0, until: next?.globalSeq }, (p) => p.taskId === undefined || p.taskId === task.id);
    // 交付的文件在它干活的地方（选了工作文件夹的、接管来的在外面那个文件夹，305、290 号票）
    const dir = taskWorkdir(task, outputsDir);
    const files = deliveredFiles(dir, start?.time, next?.time);
    const announce = speaks && getTask(store.reader, task.id)?.voiceAnnounce === true;
    const head = `${forModel(() => TASK_KIND_LABEL[taskKind(task)])} ${task.id}「${task.title}」在后台做完了。${announce ? ANNOUNCE_MARK : ""}`; // @i18n-ignore model
    // 会话里那一行的称呼给用户看（173 号票）
    const name = t("secretary.taskDone.name", { id: task.id, title: task.title });
    return {
      text: taskDoneItemText(head, said, files, announce ? dir : undefined),
      announce,
      name,
      summary: taskDoneItemSummary(name, files.length),
      files: files.map((f) => path.join(dir, f)),
    };
  }
  const { job, run } = e.payload as ScheduledJobEventPayload;
  const owner = job.ownerTaskId === undefined ? undefined : getTask(store.reader, job.ownerTaskId);
  const start = store.eventByIdempotencyKey(jobKeys.runStart(run!.runId));
  const events = runEvents(run!);
  const when = events.length === 1 ? events[0]!.summary : `${events[0]!.summary}等 ${events.length} 次触发，合成这一次运行`; // @i18n-ignore model
  // 最后说的话：这次运行收工那一轮里它说的（之后催写回的几轮不算；运行记录里存的是压成一行的那一两句，找不到时用它）
  const until = closingTurnEnd(store, job, run!, start) ?? e.globalSeq;
  const said = lastSaid(store, maintainerChannel(job.maintainerId), { after: start?.globalSeq ?? e.globalSeq, until }, (p) => p.scheduledJobId === job.id) ?? run!.summary;
  // 交付的文件：这次运行开始到结束之间改过的（几次运行并在一条里时各算各的）；属于项目的（迁移来的定时作业）在项目的工作目录里做，不列
  const dir = path.join(outputsDir, job.taskId);
  const files = job.projectId === undefined ? deliveredFiles(dir, start?.time, e.time) : [];
  // 改成某个时间做一次的（98 号票）：那一次做成了，任务随之完成
  const closes = job.schedule?.kind === "once" && owner?.state === "done" ? "这是定在那个时间做的一次，做成了，任务随之完成。" : ""; // @i18n-ignore model
  const announce = speaks && owner?.voiceAnnounce === true;
  // 部分完成（176 号票）：写明哪几步没做成（运行记录上的原因）
  const partial = run!.state === "partial";
  // @i18n-ignore-next model
  const outcome = partial ? `部分完成了（触发：${when}）。${announce ? ANNOUNCE_MARK : ""}\n没做成的：${run!.reason ?? "没有写"}` : `做完了（触发：${when}）。${closes}${announce ? ANNOUNCE_MARK : ""}`;
  const head = forModel(() => `${ownerName(job, owner)}的${runLabel(run!)}${outcome}`); // @i18n-ignore model
  const name = t("secretary.taskDone.runName", { id: owner ? owner.id : job.id, title: owner ? owner.title : job.title, run: runLabel(run!) });
  return {
    text: taskDoneItemText(head, said, files, announce ? dir : undefined),
    announce,
    ...(partial ? { partial } : {}),
    name,
    summary: taskDoneItemSummary(name, files.length, partial),
    files: files.map((f) => path.join(dir, f)),
  };
}

/**
 * 这次运行收工那一轮在哪结束（turn_end 的全局序号），照 scheduled-jobs/jobs.ts 记运行摘要的做法：这次运行开始之后（有收尾提醒的，
 * 提醒之后）执行它的 agent 处理这个作业的系统通知的第一轮。属于项目的要等工单写回才算运行结束，之后催写回的几轮不算；没有是 undefined
 */
function closingTurnEnd(store: EventStore, job: ScheduledJob, run: JobRun, start: StoredEvent | undefined): number | undefined {
  const after = store.eventByIdempotencyKey(jobKeys.runNudge(run.runId))?.globalSeq ?? start?.globalSeq ?? 0;
  for (const end of store.read(maintainerChannel(job.maintainerId), 0, EVENT_TYPES.turnEnd)) {
    if (end.globalSeq <= after || isDeletedEventPayload(end.payload)) continue;
    const id = (end.payload as TurnEndEventPayload).inputMessageId;
    if (inputOf(store.reader, id)?.scope.scheduledJobId === job.id && getMessage(store.reader, id)?.speaker === "system") return end.globalSeq;
  }
  return undefined;
}

/** 秘书会话里交过的一次通知（任务做完、维护者来信）：哪种、哪件（并进去的最后一条事件的全局序号）、第几次交、消息 */
interface NoticeAttempt {
  prefix: NoticePrefix;
  seq: number;
  attempt: number;
  messageId: string;
  text: string;
  /** 会话里那一行的总结（115 号票之前交的没有）：重新交的照旧带上 */
  summary: string | undefined;
}

/** 秘书会话里交过的全部通知（任务做完的、维护者来信的；同一种里按先后） */
function noticeAttempts(store: EventStore): NoticeAttempt[] {
  const out: NoticeAttempt[] = [];
  for (const { tag, prefix } of NOTICE_KINDS) {
    for (const e of store.mentioning(EVENT_TYPES.message, tag)) {
      const key = e.idempotencyKey;
      if (e.channel !== CHANNELS.secretary || !key?.startsWith(prefix) || isDeletedEventPayload(e.payload)) continue;
      const [seq, attempt] = key.slice(prefix.length).split("#").map(Number);
      if (seq === undefined || !Number.isInteger(seq)) continue;
      const { message } = e.payload as MessageEventPayload;
      out.push({ prefix, seq, attempt: attempt ?? 1, messageId: message.id, text: message.parts.map((p) => (p.type === "text" ? p.text : "")).join(""), summary: message.summary });
    }
  }
  return out;
}

/** 开了跑完自动播报的通知开头 */
const ANNOUNCE_HEAD = `${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}`;

/**
 * 秘书处理这条通知的那一轮里发语音工具建出的语音（100 号票）：按这一轮开始的序号认（turn_start 的 inputMessageId 是它，
 * 语音上记的 turnSeq 是那条 turn_start 的序号）——这一轮里收下了用户的插话、语音记在插话那条上的也算；别的轮的不算
 */
export function noticeTurnVoices(store: EventStore, messageId: string): AgentVoiceRecord[] {
  return store
    .read(CHANNELS.secretary, 0, EVENT_TYPES.turnStart)
    .filter((e) => (e.payload as TurnStartEventPayload).inputMessageId === messageId)
    .flatMap((e) => toolVoicesOfTurn(store.reader, CHANNELS.secretary, e.seq));
}

/**
 * 上次那一轮念过没有：合成好的（done、只合成了一部分的 partial）算念过；还在合成的要等它有了结局再定（pending）；
 * 没有、没发出去的（failed、跳过的）算没念
 */
export function announcedState(voices: readonly Pick<AgentVoiceRecord, "status">[]): "announced" | "pending" | "none" {
  if (voices.some((v) => v.status === "done" || v.status === "partial")) return "announced";
  if (voices.some((v) => v.status === "synthesizing" || v.status === "replying" || v.status === "summarizing")) return "pending";
  return "none";
}

/**
 * 被打断后重新交的那段话（99 号票：原样再交一次）。100 号票：开了跑完自动播报的，上次那一轮的语音合成好了（announced）——
 * 去掉自动播报的标记（这一轮不再放行语音）、末尾写明念过了，一次运行只播报一次；没念成的原样再交（再念一次）
 */
function redeliveredText(a: NoticeAttempt, announced: boolean): string {
  if (!a.text.startsWith(ANNOUNCE_HEAD) || !announced) return a.text;
  return `${TASK_DONE_TAG}${a.text.slice(ANNOUNCE_HEAD.length)}\n\n${ALREADY_ANNOUNCED}`;
}

/** 每件通知最后交的那一次（同一件只看它） */
function latestAttempts(attempts: readonly NoticeAttempt[]): NoticeAttempt[] {
  const latest = new Map<string, NoticeAttempt>();
  for (const a of attempts) {
    const key = `${a.prefix}${a.seq}`;
    if ((latest.get(key)?.attempt ?? 0) < a.attempt) latest.set(key, a);
  }
  return [...latest.values()];
}

/** 秘书处理这条输入的结局（还没处理完是 undefined） */
function outcomeOf(store: EventStore, messageId: string): TurnEndEventPayload["outcome"] | undefined {
  let outcome: TurnEndEventPayload["outcome"] | undefined;
  for (const end of store.read(CHANNELS.secretary, 0, EVENT_TYPES.turnEnd)) {
    const p = end.payload as TurnEndEventPayload;
    if (p.inputMessageId === messageId) outcome = p.outcome;
  }
  return outcome;
}

export interface TaskDoneNoticesOptions {
  store: EventStore;
  /** 安静多久、等 agent 说完都按它算（测试换成手动拨的） */
  clock: Clock;
  /** 做完一件之后安静多久没有新做完的才交（毫秒） */
  settleMs: number;
  /** 任务的产出区（数据目录 outputs/）：交付的文件在 outputs/<任务> 里找 */
  outputsDir: string;
  /** 秘书现在闲着吗（闲着才交） */
  secretaryIdle: () => boolean;
  /** 做它的 agent 这一轮还没说完时最多等多久（毫秒）；不给是 AGENT_WAIT_MS */
  agentWaitMs?: number;
  /** 媒体库（115 号票）：交付的文件里能预览的入库，作为附件跟在通知后面；不给就不放附件 */
  media?: MediaStore | undefined;
  /**
   * 秘书现在能发语音吗（214 号票：语音插件在运行）：不能时通知里不问要不要念、开了跑完自动播报的也当作关着，只用文字说一声。
   * 交的时候现取；不给当作能
   */
  speaks?: () => boolean;
  log: (line: string) => void;
}

export interface TaskDoneNotices {
  /** 秘书闲下来了：攒着的够安静了就交给它 */
  idle(): void;
  stop(): void;
}

export function startTaskDoneNotices(options: TaskDoneNoticesOptions): TaskDoneNotices {
  const { store, clock, settleMs } = options;
  const agentWaitMs = options.agentWaitMs ?? AGENT_WAIT_MS;
  let pending: Done[] = [];
  /** 安静到什么时候（最后攒下的那件的时刻 + settleMs） */
  let quietAt = 0;
  let cancelTimer: (() => void) | undefined;
  let stopped = false;

  /** 做完的那一刻做它的 agent 在处理的输入还没结束（还没到最多等的时候） */
  const talking = (d: Done) =>
    d.waitFor !== undefined && clock.now() < d.at + agentWaitMs && startedInputs(store.reader, d.waitFor.agent).some((q) => d.waitFor!.inputs.includes(q.messageId));

  /** 到点再看一眼：安静够了的时刻；有 agent 还在说的，最多等到它的时限 */
  const arm = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    if (stopped || pending.length === 0) return;
    const limits = pending.filter(talking).map((d) => d.at + agentWaitMs);
    cancelTimer = clock.setTimer(Math.max(quietAt, ...limits), check);
  };

  /**
   * 交付的文件里作为附件放进秘书会话的（115 号票）：能预览的（textPreviewOf：Markdown、纯文本，类型按扩展名认，和发消息时一样）、
   * 不超过附件上限的，最多 FILES_MAX 个，入库（媒体库按内容寻址：同样的内容只存一份）成文件 part。读不到、入库失败的跳过（照旧只在全文里写路径）
   */
  const attachable = async (files: readonly string[]): Promise<FilePartValue[]> => {
    const media = options.media;
    if (!media) return [];
    const parts: FilePartValue[] = [];
    for (const file of files) {
      if (parts.length >= FILES_MAX) break;
      const name = path.basename(file);
      const mime = mimeFromName(name);
      if (mime === undefined || textPreviewOf({ name, mime }) === undefined) continue;
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > media.maxUploadBytes) continue;
        const part = attachmentPartFrom(await media.ingestFile(file, { name, mime }));
        if (part.type === "file") parts.push(part);
      } catch (err) {
        options.log(`交付的文件 ${name} 没能作为附件放进秘书会话：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return parts;
  };

  /** 正在交（附件入库要等一下）：这期间再看的先不交，交完了再看一眼 */
  let flushing = false;
  const flush = async () => {
    const items = pending;
    pending = [];
    cancelTimer?.();
    cancelTimer = undefined;
    flushing = true;
    try {
      const speaks = options.speaks?.() ?? true;
      const described = items.filter((d) => !isLetterToSecretary(d.event)).map((d) => ({ seq: d.event.globalSeq, item: describeDone(store, options.outputsDir, d.event, speaks) }));
      // 开了跑完自动播报的单独一条（100 号票：只有那一条的一轮放行语音），关着的并在另一条
      const taskGroups = [described.filter((x) => !x.item.announce), described.filter((x) => x.item.announce)]
        .filter((g) => g.length > 0)
        .map((g) => ({
          prefix: TASK_DONE_KEY_PREFIX as NoticePrefix,
          last: Math.max(...g.map((x) => x.seq)),
          text: taskDoneNoticeText(g.map((x) => x.item), speaks),
          summary: taskDoneSummary(g.map((x) => x.item)),
          files: g.flatMap((x) => x.item.files),
          attachments: [] as MessagePart[],
        }));
      // 维护者来信（102 号票）自成一条，几封并在一起
      const letterEvents = items.filter((d) => isLetterToSecretary(d.event));
      const letters = letterEvents.map((d) => describeLetter(d.event));
      // 来信带的附件（117 号票）：写信时已入库
      const letterFiles = letterEvents.flatMap((d) => letterAttachments(d.event));
      const letterGroups =
        letters.length > 0
          ? [
              {
                prefix: LETTER_NOTICE_KEY_PREFIX as NoticePrefix,
                last: Math.max(...letterEvents.map((d) => d.event.globalSeq)),
                text: letterNoticeText(letters.map((l) => l.text), letterFiles.length > 0, speaks),
                summary: letterNoticeSummary(letters.map((l) => l.summary)),
                files: [] as string[],
                attachments: letterFiles,
              },
            ]
          : [];
      // 先到的那一组在前
      const groups = [...taskGroups, ...letterGroups].toSorted((a, b) => a.last - b.last);
      // 同一次交的几条里同一个文件只放一张，放在先到的那条后面
      const placed = new Set<string>();
      const once = (part: MessagePart) => {
        if (!("mediaId" in part)) return true;
        if (placed.has(part.mediaId)) return false;
        placed.add(part.mediaId);
        return true;
      };
      const attached = (await Promise.all(groups.map(async (g): Promise<MessagePart[]> => [...g.attachments, ...(await attachable(g.files))]))).map((parts) => parts.filter(once));
      // 等入库的时候停机了：不交（起来后从上一条通知之后补）
      if (stopped) return;
      store.appendBatch(
        groups.flatMap((g, i): NewEvent[] => [
          buildAgentNotice(CHANNELS.secretary, g.text, noticeKey(g.prefix, g.last, 1), {}, { summary: g.summary }).event,
          // 附件紧跟在它那条通知后面（给人看的系统消息，不排进秘书的输入队列）
          ...(attached[i]!.length > 0
            ? [buildMessage({ conversation: CHANNELS.secretary, speaker: "system", parts: attached[i]! }, { idempotencyKey: `${TASK_DONE_FILES_KEY_PREFIX}${g.last}` }).event]
            : []),
        ]),
      );
    } catch (err) {
      options.log(`任务做完、维护者来信的通知没交给秘书：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      flushing = false;
      checkLater();
    }
  };

  /** 被打断了要重新交的（秘书闲着时交，不用等安静） */
  let redeliver: NoticeAttempt[] = [];
  /**
   * 交能交的：开了跑完自动播报的，上次那一轮的语音还在合成的先不交（等它有了结局再定念过没有：合成会话频道上的 agent_voice 事件
   * 来了再看一眼）。交了至少一条的是 true
   */
  const redeliverNow = (): boolean => {
    let sent = false;
    for (const a of redeliver.splice(0)) {
      const announced = a.text.startsWith(ANNOUNCE_HEAD) ? announcedState(noticeTurnVoices(store, a.messageId)) : "none";
      if (announced === "pending") {
        redeliver.push(a);
        continue;
      }
      try {
        store.append(buildAgentNotice(CHANNELS.secretary, redeliveredText(a, announced === "announced"), noticeKey(a.prefix, a.seq, a.attempt + 1), {}, { summary: a.summary }).event);
        sent = true;
      } catch (err) {
        options.log(`被打断的任务做完、维护者来信的通知没能重新交给秘书：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return sent;
  };
  /** 秘书处理到一半被打断的那几件（每件最后交的那一次被标成中断）：等它起来闲着了重新交；only 是只看这一条 */
  const collectInterrupted = (only?: string) => {
    for (const a of latestAttempts(noticeAttempts(store))) {
      if ((only !== undefined && a.messageId !== only) || redeliver.some((r) => r.prefix === a.prefix && r.seq === a.seq)) continue;
      if (outcomeOf(store, a.messageId) === "interrupted") redeliver.push(a);
    }
  };

  /** 能交了就交：安静够了、做它的 agent 都说完了、秘书闲着（不闲着的等它闲下来时再看：idle） */
  const check = () => {
    // 正在交（附件入库）：交完了会再看一眼
    if (stopped || flushing) return;
    // 被打断了要重新交的先交（交了秘书就忙了，新做完的等它下次闲下来）
    if (redeliver.length > 0 && options.secretaryIdle() && redeliverNow()) return;
    if (pending.length === 0) return;
    // 还没安静够、还有 agent 在说：按现在的样子重新定下次看的时刻（agent 先说完了的，不用再等到它的时限）
    if (clock.now() < quietAt || pending.some(talking)) return arm();
    if (!options.secretaryIdle()) return;
    void flush();
  };
  /** 不在别人追加事件、改状态的那段代码里交（交的时候要追加事件） */
  const checkLater = () => {
    if (!stopped && (pending.length > 0 || redeliver.length > 0)) setImmediate(check);
  };

  const add = (event: StoredEvent) => {
    const now = clock.now();
    const agent = event.type === EVENT_TYPES.task ? maintainerChannel((event.payload as TaskEventPayload).task.maintainerId) : undefined;
    const inputs = agent === undefined ? [] : startedInputs(store.reader, agent).map((q) => q.messageId);
    pending.push({ event, at: now, ...(agent !== undefined && inputs.length > 0 ? { waitFor: { agent, inputs } } : {}) });
    quietAt = now + settleMs;
    arm();
  };

  // 停机前攒着还没交的：上一条通知之后做完的补上（一条都没交过的不往回翻）；信也从那之后补（一条都没交过的从头补，102 号票）
  const attempts = noticeAttempts(store);
  const told = attempts.length > 0 ? Math.max(...attempts.map((a) => a.seq)) : undefined;
  const missed = [
    ...(told === undefined ? [] : store.read(CHANNELS.board, 0).filter((e) => e.globalSeq > told && isTaskDone(e))),
    ...store.read(LETTERS_CHANNEL, 0).filter((e) => e.globalSeq > (told ?? 0) && isLetterToSecretary(e)),
  ].toSorted((a, b) => a.globalSeq - b.globalSeq);
  for (const e of missed) add(e);
  // 停机时秘书正处理到一半的（拉起秘书时已经标成中断）：起来闲着了重新交
  collectInterrupted();

  const unsubscribe = store.onAppend((e) => {
    if (stopped) return;
    if (isTaskDone(e) || isLetterToSecretary(e)) add(e);
    // 上次那一轮的语音有了结局（100 号票）：等着它的重新交看一眼
    else if (e.type === EVENT_TYPES.agentVoice) {
      if (e.channel === CHANNELS.secretary && redeliver.length > 0) checkLater();
    } else if (e.type !== EVENT_TYPES.turnEnd) return;
    // 秘书处理任务做完、维护者来信的通知到一半被打断了（子进程崩溃）：起来闲着了重新交
    else if (e.channel === CHANNELS.secretary && (e.payload as TurnEndEventPayload).outcome === "interrupted") {
      const id = (e.payload as TurnEndEventPayload).inputMessageId;
      const message = getMessage(store.reader, id);
      if (message && isRedeliveredNotice(message)) collectInterrupted(id);
    }
    // 做完的任务的 agent 这一轮说完了
    else if (pending.some((d) => d.waitFor?.agent === e.channel)) checkLater();
  });

  return {
    idle: checkLater,
    stop() {
      stopped = true;
      unsubscribe();
      cancelTimer?.();
      cancelTimer = undefined;
      pending = [];
      redeliver = [];
    },
  };
}
