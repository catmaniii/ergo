// 了解你访谈（284 号票，CONTEXT.md"了解你访谈"；计划 .scratch/ergo-memory/plan-2026-10-25-phase2.md 第 4 节第二批）：
// 记忆管理员和用户约的访谈，一次一个主题，用来冷启动对用户的了解。用户 2026-10-25 定：由记忆管理员来做，每周约一次，用户也能随时开。
//
// 这个文件是访谈的记录和发起（记忆插件装配，服务 MEMORY_INTERVIEWS）：
// - 记录（事件溯源，守护进程内部的 internal 频道、事件类型 memory_interview，按 change 分）：约了一次（invited）、开始（started：
//   哪次、什么主题、从哪开的）、结束（ended：这个主题聊透了没有）。现在的样子（开着的那次、聊过哪几个主题、上次约 / 聊是什么时候）
//   每次从这几条现算（一周一两条，不另建视图）。开了 3 小时还没收尾的当它放下了（之后说的话不再算访谈，主题也不算聊过）；
// - 怎么发起：
//   - 每周六 10:00 的内部作业（错过了开机后补一次）：约访开着（设置 · 记忆，默认开）、没在聊、离上次约 / 聊满 6 天（五个主题都聊过以后
//     改成满 27 天、主题换成"最近有什么变化"），就在待办里放一张不卡事的约访卡（卡片类型 interview，上一张还没点的过期）；
//   - 约访卡上的"开始"（同一事务里记开始、往管理员的会话里放开场的系统消息）、"下次再说"（下周照常约）、"不想做了"（关掉约访，
//     设置 · 记忆里能重新打开；卡片不算回避信号：状态是已处理，不是关掉）；
//   - 记忆页的"找管理员聊聊"（POST /api/memory/interview）、跟秘书说"我想做个访谈"（快速动作 start_interview，用户原话里有"访谈"就直接开）、
//     在管理员的会话里直接说（它的工具 begin_interview，见 interview-tools.ts）——都进同一个访谈：已经开着就是那一次，不重开；
// - 访谈开着时，用户在管理员的会话里说的话（打的字、语音）归属里带着访谈编号和管理员问的那一句（MessageScope.interviewId、
//   interviewQuestion，组合根的 userMessageScopeOf 现取 messageScope()），素材的采集规则据此标上"来自访谈"（INTERVIEW_CONTEXT）、
//   把问的那句作为上下文排在用户的话前面（标明是管理员问的，不算本人的话），当晚整理照常读成本人的证据；
// - 档案信息（用户 2026-10-25 定）：管理员聊的时候听到了用 propose_personal_file 记下（collectFile：校验过、只记在内存里，不出卡），
//   收尾时这次记下的合成一张档案核对卡（卡片类型 interview_files），逐条"确认""不记"；确认的经 281 号票的快速动作 personal_file 的
//   执行器写进档案（同一个写入口、同样留痕，写"记忆管理员提议、用户确认的"）。283 号票的"每天一张"不并进来；
// - 结束（管理员的 finish_interview）：记一条 ended，会话里放一句给用户看的说明（记下了几段、主题算不算聊过），有档案信息的同一事务出那张核对卡。
//   管理员的总结只是它的回复，不进素材、不写成结论。
// 用量：访谈就在管理员的会话里，模型调用照常记在记忆管理员名下（账本的角色 curator，消耗页上"记忆管理员"那一行）。
import { randomUUID } from "node:crypto";
import {
  type ActiveInterviewView,
  type Card,
  forModel,
  type InterviewCadence,
  interviewCadence,
  InterviewCardPayload,
  type InterviewFileItem,
  InterviewFileItemInput,
  type InterviewFileState,
  InterviewFilesCardPayload,
  INTERVIEW_FILES_MAX,
  INTERVIEW_QUESTION_MAX,
  INTERVIEW_TOPIC_LABEL,
  INTERVIEW_TOPICS,
  type InterviewInviteResult,
  type InterviewMainTopic,
  type InterviewStarter,
  type InterviewStatusView,
  type InterviewTopic,
  isInterviewMainTopic,
  MEMORY_CURATOR_CONVERSATION,
  type MemorySettingsBody,
  type MemorySettingsView,
  type MessageEventPayload,
  type MessageScope,
  nextInterviewTopic,
  type PersonalFileCardField,
  type PersonalFileCardRemind,
  PURGED_TEXT,
  type ReminderSchedule,
  spelledNumber,
  t,
  tTable,
  Type,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { listPendingCards } from "../cards/views.ts";
import { buildAgentNotice, buildMessage } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Materials } from "../materials/index.ts";
import { PERSONAL_FILE_ACTION } from "../personal-files/tool-names.ts";
import { actionContext, defineQuickAction, foundIn, type QuickActionExecutor, type QuickActionService } from "../quick-actions/index.ts";
import { clockIso, type Clock } from "../scheduler/clock.ts";
import { INTERNAL_CHANNEL, type InternalJob } from "../scheduler/internal-jobs.ts";
import { interviewFileCollectedText, interviewOpening } from "./interview-guide.ts";

/** internal 频道上的事件类型：访谈的记录 */
export const INTERVIEW_EVENT = "memory_interview";

/** 每周约访的内部作业 */
export const INTERVIEW_JOB = "memory_interview_invite";
/** 每周六上午 10:00 看一眼该不该约（周末更有空聊十分钟） */
export const INTERVIEW_INVITE_SCHEDULE: ReminderSchedule = { kind: "weekly", time: "10:00", weekdays: [6] };

/** 离上次约 / 聊至少隔多久才再约：每周的隔 6 天（同一个周六不约两次）、每月的隔 27 天 */
const MIN_GAP_MS: Readonly<Record<InterviewCadence, number>> = { weekly: 6 * 86_400_000, monthly: 27 * 86_400_000 };

/** 开了多久还没收尾就当放下了（之后说的话不再算访谈；一次访谈本来十来分钟） */
export const INTERVIEW_EXPIRE_MS = 3 * 60 * 60_000;

/** 访谈的一条记录（事件负载就是它） */
export type InterviewRecord =
  /** 约了一次（待办里放了一张约访卡） */
  | { change: "invited"; at: string; cardId: string; kind: InterviewCadence; topic: InterviewTopic }
  /** 开始了一次：哪次、什么主题、从哪开的（约访卡的带卡片；放了开场的系统消息的带它的消息编号） */
  | { change: "started"; at: string; interviewId: string; topic: InterviewTopic; by: InterviewStarter; cardId?: string; openingMessageId?: string }
  /** 结束了：这个主题聊透了没有（covered：五个主题之一记成聊过）；记了几段用户的话；出了档案核对卡的带卡片编号 */
  | { change: "ended"; at: string; interviewId: string; covered: boolean; answers: number; filesCardId?: string };

/** 开着的那次（以及最近一次，不管开没开） */
export interface InterviewSession {
  id: string;
  topic: InterviewTopic;
  by: InterviewStarter;
  startedAt: string;
  /** 开场的系统消息（从约访卡、记忆页、秘书那里开的才有）：问法跟在交它的那一轮后面 */
  openingMessageId?: string;
  /** 结束了（finish_interview）或者放下了（开了 3 小时还没收尾） */
  ended: boolean;
}

/** 从记录算出来的样子 */
export interface InterviewSnapshot {
  active: InterviewSession | undefined;
  latest: InterviewSession | undefined;
  /** 五个主题里聊过的（按聊完的先后） */
  covered: InterviewMainTopic[];
  /** 上次约（放卡）或者开始聊的时间 */
  lastContactAt: string | undefined;
}

/** 记录 → 样子（纯函数）：now 用来认"放下了"的 */
export function interviewSnapshot(records: readonly InterviewRecord[], now: number): InterviewSnapshot {
  const sessions = new Map<string, InterviewSession>();
  const covered: InterviewMainTopic[] = [];
  let lastContactAt: string | undefined;
  let latest: InterviewSession | undefined;
  for (const record of records) {
    if (record.change === "invited" || record.change === "started") lastContactAt = record.at;
    if (record.change === "started") {
      latest = { id: record.interviewId, topic: record.topic, by: record.by, startedAt: record.at, ...(record.openingMessageId === undefined ? {} : { openingMessageId: record.openingMessageId }), ended: false };
      sessions.set(record.interviewId, latest);
    } else if (record.change === "ended") {
      const session = sessions.get(record.interviewId);
      if (session) session.ended = true;
      if (session && record.covered && isInterviewMainTopic(session.topic) && !covered.includes(session.topic)) covered.push(session.topic);
    }
  }
  const expired = (s: InterviewSession) => now - Date.parse(s.startedAt) >= INTERVIEW_EXPIRE_MS;
  const active = latest !== undefined && !latest.ended && !expired(latest) ? latest : undefined;
  return { active, latest: latest === undefined ? undefined : { ...latest, ended: latest.ended || expired(latest) }, covered, lastContactAt };
}

/** 开一次访谈要的：从哪开的、想聊哪个主题（不给是下一个没聊过的）、约访卡 */
export interface InterviewStartRequest {
  by: InterviewStarter;
  topic?: InterviewTopic | undefined;
  cardId?: string;
}

/** 开一次访谈的结果：要追加的事件（已经开着时是空的） */
export interface PreparedInterviewStart {
  interviewId: string;
  topic: InterviewTopic;
  /** 已经开着：进的是那一次，没有新事件 */
  already: boolean;
  events: NewEvent[];
}

/** 记忆插件提供的访谈服务（MEMORY_INTERVIEWS，见 api.ts） */
export interface MemoryInterviews {
  /** 现在的样子（GET /api/memory/interview） */
  status(): InterviewStatusView;
  /** 开着的那次；没有是 undefined（组合根按它给用户在管理员会话里说的话标访谈编号） */
  active(): InterviewSession | undefined;
  /** 最近一次（开着或者刚结束的；管理员"这个别记"按它找用户的话） */
  latest(): InterviewSession | undefined;
  /**
   * 开一次访谈要追加的事件（不追加）：记开始；从约访卡、记忆页、秘书那里开的另往管理员的会话里放一条开场的系统消息（把它叫起来问第一个问题），
   * 管理员自己开的（begin_interview）不放——它这一轮就在开场。已经开着就交回那一次、不重开
   */
  prepareStart(request: InterviewStartRequest): PreparedInterviewStart;
  /** 开一次并追加（记忆管理员对话里的"开始访谈"、管理员的 begin_interview） */
  start(request: InterviewStartRequest): PreparedInterviewStart;
  /**
   * 结束开着的那次：记一条 ended、会话里放一句给用户看的说明；这次记下了档案信息的同一事务出一张档案核对卡（进会话由工具交回的卡片编号放）。
   * 交回这次的主题、记了几段、聊没聊透、核对卡上几条；没在聊是 undefined
   */
  finish(covered: boolean): InterviewFinish | undefined;
  /** 访谈里用户在管理员会话里说的话（这一次的，按先后）：消息编号 */
  answersOf(interviewId: string): string[];
  /**
   * 用户此刻在管理员的会话里说话的归属（组合根的 userMessageScopeOf 现取）：访谈开着时是访谈编号和管理员这次访谈里最近的一段话
   * （问的那一句，取末尾 INTERVIEW_QUESTION_MAX 字；还没开口就没有）；没在聊是空的
   */
  messageScope(): MessageScope;
  /**
   * 管理员在访谈里听到的档案信息（propose_personal_file 的参数，和 personal_file 快速动作同一份）：按 personal_file 的执行器校验、
   * 拆成一人一项记在内存里（同一个人的同一项以后记的为准），收尾时合成一张核对卡。交回给管理员的话；没在聊（或者没有 personal_file 的执行器）
   * 是 undefined——调用方照 281 号票出一人一张的核对卡
   */
  collectFile(params: PersonalFileParams, call: { inputMessageId?: string | undefined; toolCallId?: string | undefined }): { text: string; isError?: boolean } | undefined;
  /**
   * 档案核对卡上点了"确认"：这一条经 personal_file 的执行器写进档案（同一事务记操作记录、卡片更新）；remind 是生日、纪念日的每年提醒
   * 勾了没有、提前几天（283 号票；不给照卡上默认的建）
   */
  confirmFile(card: Card, payload: InterviewFilesCardPayload, itemId: string, remind?: ReadonlyArray<{ field: string; daysBefore: number }>): CardActionEffect<InterviewFilesCardPayload>;
  /** 现在该约就约一次（内部作业到点时做的就是它）：放了卡交回卡片编号 */
  invite(): string | undefined;
  /** 约访卡上点了"不想做了"：关掉约访（设置 · 记忆里能重新打开） */
  stopInvites(): void;
  /** 每周约访的内部作业 */
  readonly job: InternalJob;
}

/** finish 的结果 */
export interface InterviewFinish {
  interviewId: string;
  topic: InterviewTopic;
  covered: boolean;
  answers: number;
  remaining: InterviewMainTopic[];
  /** 档案核对卡（这次记下了档案信息才有）和卡上几条 */
  filesCardId?: string;
  files: number;
}

/** propose_personal_file 的参数（和 personal_file 快速动作同一份：谁、关系、字段名和照抄的值、记下的一件事） */
export interface PersonalFileParams {
  person: string;
  relation?: string | undefined;
  fields?: readonly { field: string; value: string }[] | undefined;
  note?: string | undefined;
  noteDate?: string | undefined;
}

export interface MemoryInterviewsOptions {
  store: Pick<EventStore, "append" | "appendBatch" | "read" | "readBefore" | "lastSeq" | "reader">;
  cards: Pick<CardService, "buildCreate" | "buildUpdate">;
  inbox: Pick<InboxService, "buildAdd">;
  clock: Clock;
  /** 素材库：数这次记了几段（忘掉了的不算） */
  materials: Pick<Materials, "list">;
  /** 记忆的设置（约访开没开；"不想做了"关掉它）；没有（测试、内核没给）就当开着、关不了 */
  settings: () => { current(): MemorySettingsView; change(body: MemorySettingsBody): MemorySettingsView } | undefined;
  /** 快速动作（档案信息按 personal_file 的执行器校验、确认时经它写进档案）；没有（测试）就记不了档案信息 */
  quickActions?: Pick<QuickActionService, "registry" | "execute">;
  log: (line: string) => void;
}

/** 一条访谈记录的事件（同一件事只记一次的给幂等键） */
const record = (payload: InterviewRecord, key?: string): NewEvent => ({ channel: INTERNAL_CHANNEL, type: INTERVIEW_EVENT, payload, ...(key === undefined ? {} : { idempotencyKey: key }) });

/** 访谈里记下的一项档案信息（只在内存里：收尾时进核对卡） */
interface FileCandidate {
  /** 这一项的动作编号（qa-…） */
  id: string;
  /** 同一个人的同一项认它（以后记的替掉以前的） */
  key: string;
  raw: InterviewFileItem["raw"];
  inputMessageId?: string;
  toolCallId?: string;
}

/** 一次 propose_personal_file 的参数拆成一人一项：每个字段一项，记下的事一项 */
function splitFileParams(params: PersonalFileParams): InterviewFileItem["raw"][] {
  const base = { person: params.person, ...(params.relation === undefined || params.relation.trim() === "" ? {} : { relation: params.relation }) };
  return [
    ...(params.fields ?? []).map((f) => ({ ...base, fields: [{ field: f.field, value: f.value }] })),
    ...(params.note === undefined ? [] : [{ ...base, note: params.note, ...(params.noteDate === undefined ? {} : { noteDate: params.noteDate }) }]),
  ];
}

/** 规范化之后的 personal_file 参数里卡片要的那几样（quick-action.ts 的 PersonalFileParams） */
interface NormalizedFile {
  personId?: string;
  person: string;
  isNew: boolean;
  relation?: string;
  fields: PersonalFileCardField[];
  note?: { text: string; date: string };
  /** 283 号票：生日、纪念日的每年提醒（默认勾着） */
  remind?: PersonalFileCardRemind[];
}

/** 一段话的末尾（问题一般在最后）：超过上限的截掉开头、写个省略号 */
function tailOf(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `…${chars.slice(chars.length - max + 1).join("")}`;
}

/** 核对卡上一条改了状态以后的卡：都定了就是已处理，还有没定的照旧待处理 */
function settleFile(payload: InterviewFilesCardPayload, itemId: string, state: InterviewFileState, result?: string): CardActionEffect<InterviewFilesCardPayload> {
  const items = payload.items.map((item) => (item.id === itemId ? { ...item, state, ...(result === undefined ? {} : { result }) } : item));
  return { status: items.every((item) => item.state !== "pending") ? "handled" : "pending", payload: { ...payload, items } };
}

/** 卡上的这一条（还没定的） */
function pendingFile(payload: InterviewFilesCardPayload, itemId: string): InterviewFileItem {
  const item = payload.items.find((i) => i.id === itemId);
  if (!item) throw new RequestRejected("bad_params", t("memory.interview.files.unknownItem"));
  if (item.state !== "pending") throw new RequestRejected("conflict", t("memory.interview.files.decided"));
  return item;
}

/** 约访卡的标题（待办、卡片上写） */
export function interviewCardTitle(payload: Pick<InterviewCardPayload, "kind" | "topic">): string {
  return payload.kind === "monthly" ? t("memory.interview.card.monthlyTitle") : t("memory.interview.card.weeklyTitle", { topic: INTERVIEW_TOPIC_LABEL[payload.topic] });
}

export function createMemoryInterviews(options: MemoryInterviewsOptions): MemoryInterviews {
  const { store, cards, inbox, clock, log } = options;
  const conversation = MEMORY_CURATOR_CONVERSATION;

  const records = (): InterviewRecord[] => store.read(INTERNAL_CHANNEL, 0, INTERVIEW_EVENT).map((event) => event.payload as InterviewRecord);
  const snapshot = () => interviewSnapshot(records(), clock.now());
  const invitesOn = () => options.settings()?.current().interviewInvites ?? true;

  /** 这一次访谈里用户在管理员会话里说的话（用户本人发的；秘书转达的不算） */
  const answersOf = (interviewId: string): string[] =>
    store
      .read(conversation, 0, "message")
      .map((event) => event.payload as { message?: { id: string; speaker?: string; relayedBy?: string }; interviewId?: string })
      .filter((p) => p.interviewId === interviewId && p.message?.speaker === "user" && p.message.relayedBy === undefined)
      .map((p) => p.message!.id);

  const prepareStart = (request: InterviewStartRequest): PreparedInterviewStart => {
    const now = snapshot();
    if (now.active) return { interviewId: now.active.id, topic: now.active.topic, already: true, events: [] };
    const topic = request.topic ?? nextInterviewTopic(now.covered);
    const interviewId = `iv-${randomUUID().slice(0, 8)}`;
    const at = clockIso(clock);
    // 开场的系统消息：把管理员叫起来问第一个问题（用户在会话里看得到，只有一行"这次聊：……"；从哪开的、访谈编号、问法跟在交它的那一轮后面）。
    // 管理员自己开的（begin_interview）不放——它这一轮就在开场
    const notice = request.by === "curator" ? undefined : buildAgentNotice(conversation, interviewOpening(topic), `memory-interview:${interviewId}:opening`, { interviewId });
    const openingMessageId = notice?.message.id;
    const started: InterviewRecord = {
      change: "started",
      at,
      interviewId,
      topic,
      by: request.by,
      ...(request.cardId === undefined ? {} : { cardId: request.cardId }),
      ...(openingMessageId === undefined ? {} : { openingMessageId }),
    };
    const events: NewEvent[] = [record(started, `memory-interview:${interviewId}:started`), ...(notice === undefined ? [] : [notice.event])];
    log(`了解你访谈：开始 ${interviewId}（${topic}，从 ${request.by} 开的）`);
    return { interviewId, topic, already: false, events };
  };

  /** 管理员这次访谈里最近的一段话（问的那一句在末尾）：开场的系统消息、这次开始以前的不往前找 */
  const questionOf = (session: InterviewSession): string | undefined => {
    const since = Date.parse(session.startedAt);
    const recent = store.readBefore(conversation, store.lastSeq(conversation) + 1, 40, "message");
    for (const event of recent.toReversed()) {
      const message = (event.payload as Partial<MessageEventPayload>).message;
      if (!message) continue;
      if (message.id === session.openingMessageId || Date.parse(message.time) < since) return undefined;
      if (message.speaker !== "agent") continue;
      const text = message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();
      if (text !== "") return tailOf(text, INTERVIEW_QUESTION_MAX);
    }
    return undefined;
  };

  /** 访谈里记下的档案信息（访谈编号 → 一人一项，按先后）：只在内存里，收尾时进核对卡（守护进程中途重启就没了） */
  const candidates = new Map<string, FileCandidate[]>();
  const personalFileExecutor = () => options.quickActions?.registry.get(PERSONAL_FILE_ACTION);

  const collectFile: MemoryInterviews["collectFile"] = (params, call) => {
    const session = snapshot().active;
    const executor = personalFileExecutor();
    if (!session || !executor) return undefined;
    const list = candidates.get(session.id) ?? [];
    const titles: string[] = [];
    const problems: string[] = [];
    for (const raw of splitFileParams(params)) {
      let normalized: NormalizedFile;
      let title: string;
      try {
        // 交回管理员的按中文（执行器的出错说明、动作名）
        const checked = forModel(() => executor.normalizeChecked(raw));
        normalized = checked.params as unknown as NormalizedFile;
        title = checked.title;
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      const who = normalized.personId ?? `new:${normalized.person}`;
      const key = normalized.note === undefined ? `${who}|${normalized.fields[0]?.field ?? ""}` : `${who}|note:${list.length}`;
      // 新建的人：关系谁记了都算这个人的（确认第一条时用它建档案）
      if (normalized.isNew && raw.relation !== undefined) for (const c of list) if (c.key.startsWith(`${who}|`) && c.raw.relation === undefined) c.raw = { ...c.raw, relation: raw.relation };
      const relation = raw.relation ?? (normalized.isNew ? list.find((c) => c.key.startsWith(`${who}|`) && c.raw.relation !== undefined)?.raw.relation : undefined);
      const candidate: FileCandidate = {
        id: `qa-${randomUUID()}`,
        key,
        raw: { ...raw, ...(relation === undefined ? {} : { relation }) },
        ...(call.inputMessageId === undefined ? {} : { inputMessageId: call.inputMessageId }),
        ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      };
      // 同一个人的同一项：以后记的替掉以前的（位置不变）
      const at = list.findIndex((c) => c.key === key);
      if (at >= 0) list[at] = candidate;
      else if (list.length >= INTERVIEW_FILES_MAX) {
        problems.push(`${title}：一次访谈最多记 ${INTERVIEW_FILES_MAX} 条`); // @i18n-ignore model：交回管理员
        continue;
      } else list.push(candidate);
      titles.push(title);
    }
    candidates.set(session.id, list);
    log(`了解你访谈：${session.id} 记下档案信息 ${titles.length} 条${problems.length > 0 ? `，没记下 ${problems.length} 条` : ""}（现在一共 ${list.length} 条）`);
    return { text: interviewFileCollectedText(titles, problems), ...(titles.length === 0 ? { isError: true } : {}) };
  };

  /** 收尾时这次记下的档案信息 → 核对卡上的几条（按用户的语言再规范化一遍：卡上的名字、字段名、原来的值是现在的；已经是这个值的不上卡） */
  const fileItems = (interviewId: string): InterviewFileItem[] => {
    const executor = personalFileExecutor();
    const list = candidates.get(interviewId) ?? [];
    if (!executor) return [];
    return list.flatMap((c): InterviewFileItem[] => {
      let n: NormalizedFile;
      try {
        n = executor.normalizeChecked(c.raw).params as unknown as NormalizedFile;
      } catch (err) {
        log(`了解你访谈：${interviewId} 的一条档案信息没上核对卡：${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
      return [
        {
          id: c.id,
          person: { name: n.person, isNew: n.isNew, ...(n.relation === undefined ? {} : { relation: n.relation }) },
          ...(n.fields[0] === undefined ? {} : { field: n.fields[0] }),
          ...(n.note === undefined ? {} : { note: n.note }),
          ...(n.remind?.[0] === undefined ? {} : { remind: n.remind[0] }),
          ...(c.inputMessageId === undefined ? {} : { inputMessageId: c.inputMessageId }),
          ...(c.toolCallId === undefined ? {} : { toolCallId: c.toolCallId }),
          state: "pending",
          raw: c.raw,
        },
      ];
    });
  };

  const invite = (): string | undefined => {
    if (!invitesOn()) return undefined;
    const now = snapshot();
    if (now.active) return undefined;
    const kind = interviewCadence(now.covered);
    if (now.lastContactAt !== undefined && clock.now() - Date.parse(now.lastContactAt) < MIN_GAP_MS[kind]) return undefined;
    const payload: InterviewCardPayload = { kind, topic: nextInterviewTopic(now.covered) };
    // 上一张还没点的过期（新的一张约的是同一件事）
    const expired = listPendingCards(store.reader, ["interview"]).map((card) => cards.buildUpdate(card.id, { status: "expired" }).event);
    const card = cards.buildCreate({ type: "interview", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: interviewCardTitle(payload), source: t("memory.curator.label"), urgency: "non_blocking", origin: { conversation } });
    store.appendBatch([...expired, card.event, item.event, record({ change: "invited", at: clockIso(clock), cardId: card.card.id, kind, topic: payload.topic })]);
    log(`了解你访谈：约了一次（${kind}，${payload.topic}）`);
    return card.card.id;
  };

  return {
    status() {
      const now = snapshot();
      const active: ActiveInterviewView | undefined = now.active && { id: now.active.id, topic: now.active.topic, startedAt: now.active.startedAt, by: now.active.by };
      return { ...(active === undefined ? {} : { active }), covered: now.covered, next: nextInterviewTopic(now.covered), cadence: interviewCadence(now.covered), invites: invitesOn() };
    },
    active: () => snapshot().active,
    latest: () => snapshot().latest,
    prepareStart,
    start(request) {
      const prepared = prepareStart(request);
      if (prepared.events.length > 0) store.appendBatch(prepared.events);
      return prepared;
    },
    finish(covered) {
      const now = snapshot();
      const session = now.active;
      if (!session) return undefined;
      const answers = answersOf(session.id).filter((messageId) => options.materials.list({ messageId }).length > 0).length;
      const coveredNow = covered && isInterviewMainTopic(session.topic);
      const topicLabel = INTERVIEW_TOPIC_LABEL[session.topic];
      // 给用户看的一句（不进管理员的输入队列）：记下了几段、主题算不算聊过
      const note = buildMessage(
        { conversation, speaker: "system", parts: [{ type: "text", text: t(coveredNow ? "memory.interview.endedCovered" : "memory.interview.endedOpen", { topic: topicLabel, n: answers, count: answers }) }] },
        { idempotencyKey: `memory-interview:${session.id}:ended-note` },
      );
      // 这次记下的档案信息合成一张核对卡（同一事务，进待办；进会话由 finish_interview 交回的卡片编号放）
      const items = fileItems(session.id);
      const files =
        items.length === 0
          ? undefined
          : (() => {
              const payload: InterviewFilesCardPayload = { interviewId: session.id, topic: session.topic, conversation, items };
              const card = cards.buildCreate({ type: "interview_files", urgency: "non_blocking", payload });
              const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: t("memory.interview.files.inboxTitle"), source: t("memory.curator.label"), urgency: "non_blocking", origin: { conversation } });
              return { cardId: card.card.id, events: [card.event, item.event] };
            })();
      const ended: InterviewRecord = { change: "ended", at: clockIso(clock), interviewId: session.id, covered: coveredNow, answers, ...(files === undefined ? {} : { filesCardId: files.cardId }) };
      store.appendBatch([record(ended, `memory-interview:${session.id}:ended`), note.event, ...(files?.events ?? [])]);
      candidates.delete(session.id);
      const after = coveredNow && !now.covered.includes(session.topic as InterviewMainTopic) ? [...now.covered, session.topic as InterviewMainTopic] : now.covered;
      log(`了解你访谈：${session.id} 结束（${session.topic}${coveredNow ? "，聊过了" : "，没聊完"}，记了 ${answers} 段，档案核对卡 ${items.length} 条）`);
      return {
        interviewId: session.id,
        topic: session.topic,
        covered: coveredNow,
        answers,
        remaining: INTERVIEW_TOPICS.filter((topic) => !after.includes(topic)),
        ...(files === undefined ? {} : { filesCardId: files.cardId }),
        files: items.length,
      };
    },
    answersOf,
    messageScope() {
      const session = snapshot().active;
      if (!session) return {};
      const question = questionOf(session);
      return { interviewId: session.id, ...(question === undefined ? {} : { interviewQuestion: question }) };
    },
    collectFile,
    confirmFile(card, payload, itemId, remind) {
      const item = pendingFile(payload, itemId);
      const executor = personalFileExecutor();
      if (!options.quickActions || !executor) throw new RequestRejected("not_allowed", t("quickActions.unknownType", { type: PERSONAL_FILE_ACTION }));
      // 确认这一刻再规范化一遍：前面一条刚新建了这个人，这一条就写进他那份；档案里已经是这个值了就不再写
      let checked: ReturnType<typeof executor.normalizeChecked>;
      try {
        checked = executor.normalizeChecked(item.raw);
      } catch (err) {
        if (err instanceof RequestRejected) return settleFile(payload, item.id, "unchanged");
        throw new RequestRejected("bad_params", t("memory.interview.files.failed", { reason: err instanceof Error ? err.message : String(err) }));
      }
      const context = actionContext(card, { actionId: item.id, conversation: payload.conversation, ...(item.inputMessageId === undefined ? {} : { inputMessageId: item.inputMessageId }) });
      // 283 号票：勾了的每年提醒（只认这一条卡上列着的字段）；没带照规范化给的默认（勾着、提前 3 天）
      const offered = new Set((checked.params as unknown as NormalizedFile).remind?.map((r) => r.field) ?? []);
      const params = remind === undefined ? checked.params : { ...(checked.params as object), chosen: remind.filter((r) => offered.has(r.field)) };
      const outcome = options.quickActions.execute(executor, params, context, checked.title);
      const settled = settleFile(payload, item.id, "written", outcome.summary);
      return {
        ...settled,
        events: outcome.events,
        ...(outcome.purge === undefined ? {} : { purge: outcome.purge }),
        ...(outcome.afterCommit === undefined ? {} : { afterCommit: outcome.afterCommit }),
      };
    },
    invite,
    stopInvites() {
      options.settings()?.change({ interviewInvites: false });
      log("了解你访谈：用户点了不想做了，约访关掉");
    },
    job: {
      name: INTERVIEW_JOB,
      schedule: INTERVIEW_INVITE_SCHEDULE,
      run: async () => {
        invite();
      },
    },
  };
}

/** 约访卡点过以后纯文本降级里写的结局 */
const INVITE_RESULT_TEXT: Readonly<Record<InterviewInviteResult, string>> = tTable({
  started: "memory.interview.card.result.started",
  later: "memory.interview.card.result.later",
  declined: "memory.interview.card.result.declined",
});

/**
 * 约访卡（卡片类型 interview）：开始（开一次访谈，同一事务里记开始、放开场的系统消息；已经在聊就进那一次）、下次再说、不想做了
 * （约访关掉，设置 · 记忆里能重新打开）。三个都把卡记成已处理（不是关掉：不算回避信号）。卡上没有用户的话，彻底删除不用改写它。
 * 记忆插件的数据契约登记（停用也登记），动作现取服务，插件没启用时回"记忆插件没启用"
 */
export function interviewCardType(service: () => MemoryInterviews) {
  return defineCardType({
    type: "interview",
    version: 1,
    payload: InterviewCardPayload,
    actions: {
      start: {
        input: undefined,
        run: ({ card, payload }): CardActionEffect<InterviewCardPayload> => {
          const prepared = service().prepareStart({ by: "card", topic: payload.topic, cardId: card.id });
          return { status: "handled", payload: { ...payload, result: "started" as const, interviewId: prepared.interviewId }, events: prepared.events };
        },
      },
      later: { input: undefined, run: ({ payload }) => ({ status: "handled", payload: { ...payload, result: "later" as const } }) },
      decline: {
        input: undefined,
        run: ({ payload }) => {
          // 先取服务（插件没启用时照常回"记忆插件没启用"），卡片落盘之后再关约访
          const interviews = service();
          return { status: "handled", payload: { ...payload, result: "declined" as const }, afterCommit: () => interviews.stopInvites() };
        },
      },
    },
    toText: (p) => {
      const head = interviewCardTitle(p);
      if (p.result === undefined) return t("memory.interview.card.pendingText", { title: head });
      return t("memory.interview.card.doneText", { title: head, result: INVITE_RESULT_TEXT[p.result] });
    },
  });
}

/** 档案核对卡的标题（待办、卡片上写）：这次访谈听到的几条 */
export function interviewFilesTitle(payload: Pick<InterviewFilesCardPayload, "items">): string {
  return t("memory.interview.files.title", { n: payload.items.length });
}

/** 档案核对卡上的一条，一行字（纯文本降级）：谁 · 字段：值（号码另写一位一位的）/ 记下的事，状态 */
function fileLine(item: InterviewFileItem): string {
  const who = item.person.isNew
    ? item.person.relation === undefined
      ? t("memory.interview.files.newPerson", { name: item.person.name })
      : t("memory.interview.files.newPersonRelation", { name: item.person.name, relation: item.person.relation })
    : item.person.name;
  const what = item.field
    ? item.field.number && item.field.value !== PURGED_TEXT
      ? t("memory.interview.files.numberLine", { label: item.field.label, value: item.field.value, digits: spelledNumber(item.field.value) })
      : t("memory.interview.files.fieldLine", { label: item.field.label, value: item.field.value })
    : t("memory.interview.files.noteLine", { text: item.note?.text ?? "" });
  return t("memory.interview.files.line", { who, what, state: FILE_STATE_TEXT[item.state] });
}

const FILE_STATE_TEXT: Readonly<Record<InterviewFileState, string>> = tTable({
  pending: "memory.interview.files.state.pending",
  written: "memory.interview.files.state.written",
  skipped: "memory.interview.files.state.skipped",
  unchanged: "memory.interview.files.state.unchanged",
});

/**
 * 访谈的档案核对卡（卡片类型 interview_files）：一次访谈收尾时这次听到的档案信息合成一张，一条一条"确认"（经 personal_file 的执行器写进档案，
 * 同一事务记操作记录；动作现取访谈的服务，插件没启用时回"记忆插件没启用"）、"不记"。还有没定的卡照旧待处理，都定了是已处理。
 * 彻底删除档案里的值时（按档案留痕里的动作编号、卡片编号找到这张）卡上的名字、值、记下的事、结果、原样参数都换成删除标记（字段名留着）
 */
export function interviewFilesCardType(service: () => MemoryInterviews) {
  return defineCardType({
    type: "interview_files",
    version: 1,
    payload: InterviewFilesCardPayload,
    actions: {
      confirm: {
        input: InterviewFileItemInput,
        run: ({ card, payload, input }) => service().confirmFile(card, payload, input.item, input.remind),
      },
      reject: {
        input: InterviewFileItemInput,
        run: ({ payload, input }) => settleFile(payload, pendingFile(payload, input.item).id, "skipped"),
      },
    },
    toText: (p) => [interviewFilesTitle(p), ...p.items.map(fileLine)].join("\n"),
    purge: (p) => ({
      ...p,
      // 每年提醒的勾带着生日的月、日：整个去掉
      items: p.items.map(({ remind: _remind, ...item }) => ({
        ...item,
        person: { ...item.person, name: PURGED_TEXT, ...(item.person.relation === undefined ? {} : { relation: PURGED_TEXT }) },
        ...(item.field === undefined ? {} : { field: { ...item.field, value: PURGED_TEXT, ...(item.field.previous === undefined ? {} : { previous: PURGED_TEXT }) } }),
        ...(item.note === undefined ? {} : { note: { ...item.note, text: PURGED_TEXT } }),
        ...(item.result === undefined ? {} : { result: PURGED_TEXT }),
        raw: {
          person: PURGED_TEXT,
          ...(item.raw.fields === undefined ? {} : { fields: item.raw.fields.map((f) => ({ field: f.field, value: PURGED_TEXT })) }),
          ...(item.raw.note === undefined ? {} : { note: PURGED_TEXT }),
        },
      })),
    }),
  });
}

/** 快速动作的类型（秘书在"提议快速动作"里写它） */
export const START_INTERVIEW_ACTION = "start_interview";

// @i18n-ignore-start model：参数说明（给秘书）
const StartParams = Type.Object(
  {
    topic: Type.Optional(
      Type.Enum(INTERVIEW_TOPICS, { description: "想聊哪个主题（用户点了名才写）：family 家里的人、work_day 工作和一天、choices 几次重要的选择、cares 在意和烦恼、help 想让二狗怎么帮；不写是下一个没聊过的" }),
    ),
  },
  { additionalProperties: false },
);
// @i18n-ignore-end

/**
 * 跟秘书说"我想做个访谈"（快速动作 start_interview）：开一次访谈（就是约访卡上的"开始"那一套），管理员在自己的会话里开场；
 * 已经开着就进那一次。用户这一轮自己说了"访谈"算点明，直接开（聊天里留"已执行"的回执卡，网页上有去和管理员聊的入口）；
 * 没说的出卡问一句
 */
export function startInterviewAction(service: () => MemoryInterviews): QuickActionExecutor {
  return defineQuickAction({
    type: START_INTERVIEW_ACTION,
    get title() {
      return t("memory.interview.action.title");
    },
    // @i18n-ignore-next model：给秘书的用法（写进"提议快速动作"工具的说明）
    usage: "用户说想做个访谈、想让记忆管理员多了解自己时用：开一次了解你访谈，记忆管理员在「记忆 · 管理员」那里一问一答（已经在聊就进那一次）。访谈不用你来问",
    params: StartParams,
    watch: { categories: [] },
    confirm: "ask_when_inferred",
    normalize({ topic }) {
      const current = service().status();
      const shown: InterviewTopic = current.active?.topic ?? topic ?? current.next;
      const params: { topic?: string } = topic === undefined ? {} : { topic };
      return { params, title: t("memory.interview.action.cardTitle", { topic: INTERVIEW_TOPIC_LABEL[shown] }) };
    },
    explicit(_action, turn) {
      const found = foundIn(turn, t("memory.interview.action.cue")) ?? foundIn(turn, "访谈"); // @i18n-ignore data：中文的说法照样认
      return found && (found.source === "typed" || found.source === "voice") ? found : undefined;
    },
    execute(params) {
      const topic = (params as { topic?: InterviewMainTopic }).topic;
      const prepared = service().prepareStart({ by: "secretary", ...(topic === undefined ? {} : { topic }) });
      const label = INTERVIEW_TOPIC_LABEL[prepared.topic];
      return { events: prepared.events, summary: t(prepared.already ? "memory.interview.action.already" : "memory.interview.action.done", { topic: label }) };
    },
  });
}
