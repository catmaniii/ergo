// 秘书来了新消息要让用户知道（109 号票，纯函数；规格第 19 节"秘书来了新消息"）。起因：定时任务跑完，秘书在主线里念了一段语音，
// 用户完全没察觉——秘书说话不弹提醒、不进待办、"秘书"页签没有红点，语音只在页面开着、当场收到时才自动播放。
//
// - 没看过的：秘书会话里已读位置之后、用户看得到的那几样（文字回复、语音气泡、卡片；工具调用、思考、系统说明不算），
//   按会话条目层（chat-items.ts）的条目算。已读位置存在守护进程（ui-state 的 readMarks：已读位置频道上的 read_mark，
//   几台设备同步；这台设备刚看到的先记上），还没收到过时当作全部看过。导航上"秘书"那一项有没看过的就亮红点（secretaryNavDot）。
// - 怎么算看过：用户在秘书页、页面在前台、补发推完了，对话层滚到了那条（视口 40% 高处那一条和它之前的）、或者停在最底部
//   （seenThrough 算到哪个序号，界面报 mark_read）。
// - 顶上提醒（106 号票的轮播框）：用户不在看秘书会话时（在别的页面、页面在后台），秘书说完一轮、发出了看得到的东西，
//   提醒一条（secretaryTurnAlert）："<名字>：<这一轮第一段文字或语音的开头>"，"查看"去秘书会话里那一条；一轮只出一条；
//   这一轮的语音还在合成（第一段到了也算）、合成好了消息还没到时先等它出来。打开、切回前台、重连上（补发推完了）时还有没看过的，出一条"<名字>有 N 条新消息"
//   （secretaryUnreadAlert，只在顶上框里出、不另发系统通知），"查看"去第一条没看过的。在看秘书会话时都不出。别的设备上看过了（已读位置到了）提醒随之拿掉（ui-state）。
// - 不在时念的语音（missedVoicesOnOpen / missedVoiceBar）：打开秘书会话时有没看过、这台设备上也没放过的语音气泡（不在时到的，
//   没自动播），输入框上面出一条小栏"你不在时<名字>念了 1 段语音（1 分 06 秒）"，点播放从第一段接着放，点定位滚到那条气泡；
//   放过（点了播放、点了那条气泡）就拿掉，都拿掉了小栏就没了。不直接自动播（用户可能在不方便出声的地方，浏览器也要点一下才肯出声）。
// 界面上的话照 43、89 号票说秘书用户起的名字：写名字占位（ASSISTANT_NAME_MARK），框里画成名字标签、系统通知里换成名字本身。
// 计时、页面在不在前台、播放器在 app/secretary-unread.ts，这里只管算。
import { type ChatItem, chatItems } from "./chat-items.ts";
import { ASSISTANT_NAME_MARK, CHANNELS, t } from "./protocol.ts";
import { type PageAlert, pathMessages, SECRETARY_UNREAD_ALERT, type UiState } from "./ui-state.ts";

const SECRETARY = CHANNELS.secretary;

/** 秘书说完一轮的提醒的 id 开头（后面接这一轮第一条的条目 id：几个窗口里是同一个，浏览器通知只弹一条） */
export const SECRETARY_TURN_ALERT = "secretary:";

/** 提醒、小栏上一行字最多写多长（框里放不下的再由样式省略） */
const LINE_MAX = 60;

/** 秘书会话的已读位置（这之前的都看过了）；还没收到过是 undefined（当作全部看过） */
export function secretaryReadSeq(state: UiState): number | undefined {
  return state.readMarks[SECRETARY];
}

/** 用户看得到的秘书的一条：文字回复、语音气泡、卡片 */
function visibleToUser(item: ChatItem): boolean {
  return item.kind === "reply" || item.kind === "card" || (item.kind === "voice" && item.speaker === "agent");
}

/** 已读位置之后有没有不是用户自己说的消息（从后往前看，大多数时候一条都不用算条目） */
function anythingAfter(state: UiState, mark: number): boolean {
  const messages = state.conversations[SECRETARY]?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.seq <= mark) return false;
    if ("message" in m && m.message.speaker !== "user") return true;
  }
  return false;
}

/** 秘书会话里用户还没看过的（已读位置之后的文字回复、语音气泡、卡片），按先后；还没有已读位置时当作全部看过 */
export function secretaryUnread(state: UiState): ChatItem[] {
  const mark = secretaryReadSeq(state);
  if (mark === undefined || !anythingAfter(state, mark)) return [];
  return chatItems(state, SECRETARY).filter((it) => it.seq !== undefined && it.seq > mark && visibleToUser(it));
}

/** 导航上"秘书"那一项亮不亮红点：有没看过的 */
export function secretaryNavDot(state: UiState): boolean {
  return secretaryUnread(state).length > 0;
}

/**
 * 对话层看到哪了（ZoomHistory 报的：视口 40% 高处的那一条、是不是停在最底部）→ 看过了的最后一个序号：停在最底部是会话收到的
 * 最后一个序号（cursor），不然是那一条和它之前的条目里最大的序号；那一条不在条目里是 undefined
 */
export function seenThrough(items: readonly ChatItem[], chatId: string | undefined, atBottom: boolean, cursor: number | undefined): number | undefined {
  const upTo = atBottom ? items.length - 1 : chatId === undefined ? -1 : items.findIndex((it) => it.id === chatId);
  let through: number | undefined = atBottom ? cursor : undefined;
  for (const it of items.slice(0, upTo + 1)) if (it.seq !== undefined) through = Math.max(through ?? 0, it.seq);
  return through;
}

/** 决定在顶上提醒不提醒时页面的样子 */
export interface SecretaryAlertEnv {
  /** 用户正在看秘书会话：在秘书页，页面在前台 */
  readonly viewing: boolean;
}

/**
 * 秘书说完的这一轮（since 是这一轮开始的序号，ui-state 的 secretaryTurns）：在顶上提醒一条；这一轮的语音还没出来
 * （"wait"，见 voicePending）；不提醒（undefined：正在看秘书会话、这一轮没有看得到的东西、已经看过了）
 */
export function secretaryTurnAlert(state: UiState, since: number, env: SecretaryAlertEnv): PageAlert | "wait" | undefined {
  if (env.viewing) return undefined;
  if (voicePending(state, since)) return "wait";
  // 这一轮：这一轮开始之后、下一轮开始之前（语音回复合成好的那条在回合结束之后才到）
  const until = (state.turnStarts[SECRETARY] ?? []).find((seq) => seq > since) ?? Infinity;
  const items = secretaryUnread(state).filter((it) => it.seq! > since && it.seq! < until);
  const first = items[0];
  if (!first) return undefined;
  const voice = first.kind === "voice" ? t("state.secretaryUnread.voice", { duration: spokenDuration(first.part.durationMs ?? 0) }) : undefined;
  const more = items.length > 1 ? t("state.secretaryUnread.more", { count: items.length - 1 }) : undefined;
  const body = [voice, more].filter((x) => x !== undefined).join(t("state.secretaryUnread.bodySep"));
  return {
    id: `${SECRETARY_TURN_ALERT}${first.id}`,
    title: t("state.secretaryUnread.said", { name: ASSISTANT_NAME_MARK, text: headline(state, first) }),
    ...(body ? { body } : {}),
    secretary: { at: targetOf(first), through: lastSeq(items) },
  };
}

/**
 * 这一轮（语音对象上记的 turnSeq）的语音还没出来：还在回复、写口语稿、合成（不管第一段到没到），或者合成好了、载着它的消息还没到
 * （合成好的那一版先到，消息晚一帧）。这时这一轮的文字已经算进语音、气泡还没有，看着像"没有看得到的"，要接着等；没合成出来的不等
 */
function voicePending(state: UiState, since: number): boolean {
  const messages = state.conversations[SECRETARY]?.messages ?? [];
  const arrived = (id: string) => messages.some((m) => "message" in m && m.message.id === id);
  return Object.values(state.agentVoices).some((v) => {
    if (v.conversation !== SECRETARY || v.turnSeq !== since) return false;
    if (v.status === "replying" || v.status === "summarizing" || v.status === "synthesizing") return true;
    return (v.status === "done" || v.status === "partial") && v.messageId !== undefined && !arrived(v.messageId);
  });
}

/** 打开、切回前台、重连上（补发推完了）时：还有没看过的，顶上出"<名字>有 N 条新消息"，"查看"去第一条没看过的；正在看秘书会话时不出 */
export function secretaryUnreadAlert(state: UiState, env: SecretaryAlertEnv): PageAlert | undefined {
  if (env.viewing) return undefined;
  const items = secretaryUnread(state);
  const first = items[0];
  if (!first) return undefined;
  const through = lastSeq(items);
  return { id: `${SECRETARY_UNREAD_ALERT}${through}`, title: t("state.secretaryUnread.newMessages", { name: ASSISTANT_NAME_MARK, count: items.length }), body: t("state.secretaryUnread.said", { name: ASSISTANT_NAME_MARK, text: headline(state, first) }), secretary: { at: targetOf(first), through } };
}

/**
 * 顶上的这一条要不要另发系统通知（浏览器通知、鸿蒙 App 的通知栏，110 号票的出口）："<名字>有 N 条新消息"不发，只在顶上框里出——
 * 它是切回前台、刷新页面时才生成的，说到的那几轮在后台时各自已经发过一条；别的照发
 */
export function alertNotifiesSystem(alert: PageAlert): boolean {
  return !alert.id.startsWith(SECRETARY_UNREAD_ALERT);
}

/** 提醒说到的最后一条的序号：几条里最大的（118 号票起附件挪到了文字后面，排在最后的不一定序号最大） */
function lastSeq(items: readonly ChatItem[]): number {
  return Math.max(...items.map((it) => it.seq!));
}

/** "查看"去会话里的哪一条（地址里 /at/ 后面的，会话组件的 revealTargetId 认）：卡片是卡片 id，别的是条目 id */
function targetOf(item: ChatItem): string {
  return item.kind === "card" ? item.cardId : item.id;
}

/** 提醒上写的开头：文字回复的第一行、语音念的稿子的第一行（还没有稿子写"念了一段语音"）、卡片的第一行 */
function headline(state: UiState, item: ChatItem): string {
  if (item.kind === "reply") return firstLine(item.text) || t("state.secretaryUnread.sentAttachment");
  if (item.kind === "voice") {
    const said = item.part.type === "tts_audio" ? state.agentVoices[item.part.voiceId]?.text : undefined;
    return (said && firstLine(said)) || t("state.secretaryUnread.sentVoice");
  }
  return item.keyLine;
}

/** 第一个非空行（去掉 Markdown 的记号），太长截短 */
function firstLine(text: string): string {
  const line = text
    .replace(/[#*`>|]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "").slice(0, LINE_MAX);
}

/** 语音的时长念起来的样子："8 秒"、"1 分 06 秒" */
export function spokenDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t("state.secretaryUnread.seconds", { seconds });
  return t("state.secretaryUnread.minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, "0") });
}

/** 秘书会话里没看过的 agent 语音气泡（已读位置之后的），语音 id 按先后 */
function unseenVoices(state: UiState): string[] {
  return secretaryUnread(state).flatMap((it) => (it.kind === "voice" && it.part.type === "tts_audio" ? [it.part.voiceId] : []));
}

/**
 * 打开秘书会话时（挂上、切回前台、补发推完了）小栏里的语音（不在时念的）：原来栏里还没放过的，加上这会儿没看过、这台设备上
 * 也没放过（heard）的，按先后。打开之后才到的（用户看着的时候到的）不加——那时用户在看，开着自动播放的当场就播了
 */
export function missedVoicesOnOpen(state: UiState, kept: readonly string[], heard: ReadonlySet<string>): readonly string[] {
  // 会话回退之后（150 号票）：落在废弃分支上的不再补播
  const abandoned = abandonedVoices(state, kept);
  const stay = kept.filter((id) => !heard.has(id) && !abandoned.has(id));
  const next = [...stay, ...unseenVoices(state).filter((id) => !heard.has(id) && !stay.includes(id))];
  return next.length === kept.length && next.every((id, i) => id === kept[i]) ? kept : next;
}

/** 这几段语音里载着它的消息落在废弃分支上的（150 号票：会话回退之后不再补播；还没到的消息不算） */
function abandonedVoices(state: UiState, ids: readonly string[]): ReadonlySet<string> {
  if (ids.length === 0 || (state.conversations[SECRETARY]?.branches?.branches.length ?? 1) <= 1) return new Set();
  const all = new Set((state.conversations[SECRETARY]?.messages ?? []).flatMap((m) => ("message" in m ? [m.message.id] : [])));
  const onPath = new Set(pathMessages(state, SECRETARY).map((m) => m.message.id));
  return new Set(
    ids.filter((id) => {
      const messageId = state.agentVoices[id]?.messageId;
      return messageId !== undefined && all.has(messageId) && !onPath.has(messageId);
    }),
  );
}

/** 放过了的（点了播放、点了那条气泡、自动播了）拿掉；都拿掉了小栏就没了 */
export function missedVoicesAfterHeard(ids: readonly string[], heard: ReadonlySet<string>): readonly string[] {
  return ids.some((id) => heard.has(id)) ? ids.filter((id) => !heard.has(id)) : ids;
}

/** 输入框上面那条小栏：哪几段（还在的）、写什么、"定位"去的那条气泡（会话条目层的条目 id） */
export interface MissedVoiceBar {
  readonly voiceIds: readonly string[];
  /** "你不在时<名字>念了 1 段语音（1 分 06 秒）"（名字是占位，界面画成名字标签） */
  readonly text: string;
  /** 第一段在会话里的条目（还没加载到的是 undefined，不能定位） */
  readonly firstItemId: string | undefined;
}

/** 小栏上的样子；语音都不在了（比如被彻底删除）是 undefined */
export function missedVoiceBar(state: UiState, ids: readonly string[]): MissedVoiceBar | undefined {
  const abandoned = abandonedVoices(state, ids);
  const voices = ids.flatMap((id) => {
    if (abandoned.has(id)) return [];
    const v = state.agentVoices[id];
    return v ? [v] : [];
  });
  if (voices.length === 0) return undefined;
  const total = voices.reduce((sum, v) => sum + (v.durationMs ?? 0), 0);
  const first = voices[0]!.id;
  const item = chatItems(state, SECRETARY).find((it) => it.kind === "voice" && it.part.type === "tts_audio" && it.part.voiceId === first);
  return { voiceIds: voices.map((v) => v.id), text: t("state.secretaryUnread.missedVoices", { name: ASSISTANT_NAME_MARK, count: voices.length, duration: spokenDuration(total) }), firstItemId: item?.id };
}
