// 运行时核实用户原话（125 号票；方案"用户授权的效力"第 2 节第一层，不用签名）：维护者在宣布阶段完成、提计划变更、自行调整计划、
// 提立项要求变更时附上用户消息的 id，守护进程逐条核对，核实过的写进单独一栏（协议包 user-words.ts 的 VerifiedUserWords）：
// - 消息要在：不存在、被彻底删除了（会话消息的视图里没有了）的不认；
// - 发言方要是用户：agent 自己的话、运行时的通知不认；
// - 要是引用它的 agent 自己会话里的（它看得到的那些，交给它的用户消息末尾带着 id）：别的会话里的不认；
// - 秘书转达进来的那一句（103 号票，发言方也是用户、标着 relayedBy）：换成用户在秘书那里说的原话（relayOf）——原话要在、是用户
//   自己在秘书会话里说的；转达时没记下原话（之前转达的、秘书不是在回用户的话时转达的）的不认，转达的话是秘书写的，不算用户的原话。
// 每条写原文（语音写识别出的文字）、哪个会话、时间、从哪台设备来的（本机、设备名；之前的消息没记，写设备不详）。
// 核对不过的那条退回（写明哪一条、为什么），其余照常：调用方把 refused 交回 agent。
import {
  ASSISTANT_NAME_MARK,
  CHANNELS,
  type ConversationId,
  MAINTAINER_CHANNEL_PREFIX,
  type MessageEnvelope,
  partLabel,
  type RefusedUserWords,
  SENT_FROM_LOCAL,
  SENT_FROM_UNKNOWN,
  type SentFrom,
  settledVoiceText,
  Type,
  USER_WORDS_MAX,
  type VerifiedUserWords,
  t,
} from "@ergo/protocol";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { getDevice } from "../pairing/views.ts";
import { getVoice } from "../voice-records/views.ts";
import { buildMessage } from "./messages.ts";
import { getMessage, messageSentFrom } from "./views.ts";

/** 交给 agent 的用户消息末尾那一行（125 号票）：它引用用户原话时照抄这个 id */
export const userMessageIdLine = (id: string): string => `[用户消息 id：${id}]`; // @i18n-ignore model：交给 agent 的那一行

/**
 * 维护者的工具里"依据的用户原话"那个参数（宣布阶段完成、计划变更、自行调整、立项要求变更共用）：用户消息末尾那一行里的 id。
 * 运行时核实后单独一栏写进去；它在正文里写的"用户说了……""用户已同意"只是转述，不算数
 */
export const USER_WORDS_PARAM = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  maxItems: USER_WORDS_MAX,
  // @i18n-ignore-next model：参数说明
  description: "依据的用户原话：用户消息末尾“[用户消息 id：…]”里的 id（一条或几条；秘书转达给你的那句也有，引用它等于引用用户在秘书那里的原话）。运行时核实后单独一栏给用户、评审看；没有就不写",
});

/**
 * 卡片也出在用户说那句话的会话里（125 号票：计划变更卡、立项要求变更卡）：核实过的原话在哪些会话（秘书转达来的在秘书会话），
 * 除了 own（提出它的维护者自己的会话：工具产生的卡片本来就以卡片引用出现在那里），各放一条卡片引用（系统消息，不交给那里的 agent）
 */
export function cardRefsElsewhere(cardId: string, words: readonly VerifiedUserWords[], own: ConversationId): NewEvent[] {
  return [...new Set(words.map((w) => w.conversation as ConversationId))]
    .filter((c) => c !== own)
    .map((conversation) => buildMessage({ conversation, speaker: "system", parts: [{ type: "card_ref", cardId }] }).event);
}

export interface UserWordsDeps {
  store: Pick<EventStore, "reader">;
  /** 会话给人看的说法（"和<名字占位>的对话""项目「记账本」的维护者会话""任务 t-6「…」的会话"） */
  whereOf(conversation: ConversationId): string;
}

/**
 * 会话给人看的说法（daemon.ts 接项目和任务）：秘书会话写"和<名字占位>的对话"（43 号票：界面上是用户起的名字，交给 agent 的是
 * "和秘书的对话"）；维护者的会话按它属于哪个项目、哪个任务说；都认不出的写"维护者会话"
 */
export function conversationWhere(lookup: {
  projectOf(maintainerId: string): { name: string } | undefined;
  taskOf(maintainerId: string): { id: string; title: string } | undefined;
}): (conversation: ConversationId) => string {
  return (conversation) => {
    if (conversation === CHANNELS.secretary) return t("conversation.where.secretary", { name: ASSISTANT_NAME_MARK });
    const maintainerId = conversation.slice(MAINTAINER_CHANNEL_PREFIX.length);
    const project = lookup.projectOf(maintainerId);
    if (project) return t("conversation.where.project", { name: project.name });
    const task = lookup.taskOf(maintainerId);
    return task ? t("conversation.where.task", { id: task.id, title: task.title }) : t("conversation.where.maintainer");
  };
}

/** 核对的结果：核实过的（按引用的先后，同一句原话只算一条）、没核实过的（哪一条、为什么） */
export interface UserWordsCheck {
  verified: VerifiedUserWords[];
  refused: RefusedUserWords[];
}

export const NO_USER_WORDS: UserWordsCheck = { verified: [], refused: [] };

/** 从哪台设备来的说法 */
function deviceText(store: UserWordsDeps["store"], sentFrom: SentFrom | undefined): string {
  if (!sentFrom) return SENT_FROM_UNKNOWN;
  if (sentFrom.kind === "local") return SENT_FROM_LOCAL;
  const device = getDevice(store.reader, sentFrom.deviceId);
  return device ? t("conversation.where.device", { name: device.name }) : t("conversation.where.deletedDevice");
}

/** 一条用户消息的原文：打的字原样，语音换成识别出的文字（识别没好的写"语音，没识别出文字"），附件写名字 */
function wordsOf(store: UserWordsDeps["store"], message: MessageEnvelope): { text: string; voice: boolean } {
  let voice = false;
  const pieces = message.parts.flatMap((part) => {
    if (part.type !== "voice") {
      const label = partLabel(part).trim();
      return label ? [label] : [];
    }
    voice = true;
    const record = part.voiceId === undefined ? undefined : getVoice(store.reader, part.voiceId);
    return [(record && settledVoiceText(record)) ?? t("conversation.userWords.unrecognizedVoice")];
  });
  return { text: pieces.join(" "), voice };
}

/**
 * 核对 agent 引用的用户消息（ids）：own 是它自己的会话（它只能引用这里的；秘书转达进来的换成用户在秘书那里的原话）。
 * 一次最多 USER_WORDS_MAX 条，多的退回
 */
export function verifyUserWords(deps: UserWordsDeps, ids: readonly string[] | undefined, own: ConversationId): UserWordsCheck {
  const verified: VerifiedUserWords[] = [];
  const refused: RefusedUserWords[] = [];
  const unique = [...new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0))];
  for (const [i, id] of unique.entries()) {
    if (i >= USER_WORDS_MAX) {
      refused.push({ id, reason: `一次最多引用 ${USER_WORDS_MAX} 条` }); // @i18n-ignore model：没核实的原因交回 agent
      continue;
    }
    const checked = verifyOne(deps, id, own);
    if ("reason" in checked) refused.push({ id, reason: checked.reason });
    else if (!verified.some((w) => w.messageId === checked.messageId)) verified.push(checked);
  }
  return { verified, refused };
}

// @i18n-ignore-start model：没核实的原因交回 agent
function verifyOne(deps: UserWordsDeps, id: string, own: ConversationId): VerifiedUserWords | { reason: string } {
  const { store } = deps;
  const message = getMessage(store.reader, id);
  if (!message) return { reason: "没有这条消息（不存在，或者被彻底删除了）" };
  if (message.conversation !== own) return { reason: "不是你会话里的消息" };
  if (message.speaker !== "user") return { reason: message.speaker === "system" ? "这是运行时的通知，不是用户说的" : "这是 agent 说的，不是用户说的" };
  if (message.relayedBy === undefined) return verifiedOf(deps, message);
  // 秘书转达进来的：换成用户在秘书那里说的原话
  const original = message.relayOf === undefined ? undefined : getMessage(store.reader, message.relayOf);
  if (!original) return { reason: "这句是秘书转达的，找不到用户在秘书那里说的原话（转达时没记下，或者原话被彻底删除了）" };
  if (original.conversation !== CHANNELS.secretary || original.speaker !== "user" || original.relayedBy !== undefined) return { reason: "这句是秘书转达的，转达的依据不是用户自己说的话" };
  return { ...verifiedOf(deps, original), relayedBy: "secretary", relayMessageId: message.id };
}
// @i18n-ignore-end

function verifiedOf(deps: UserWordsDeps, message: MessageEnvelope): VerifiedUserWords {
  const { text, voice } = wordsOf(deps.store, message);
  return {
    messageId: message.id,
    text,
    ...(voice ? { voice: true as const } : {}),
    conversation: message.conversation,
    where: deps.whereOf(message.conversation),
    time: message.time,
    device: deviceText(deps.store, messageSentFrom(deps.store.reader, message.id)),
  };
}

/**
 * 一个会话里用户最近说的话，核实成同一种格式（范围审视的对照物，125 号票）：秘书转达进来的换成原话，找不到原话的不算；
 * 越早的在前。给的是这几条消息（recentMessagesOf 取的），没核实过的去掉
 */
export function verifiedRecentWords(deps: UserWordsDeps, messages: readonly MessageEnvelope[], own: ConversationId): VerifiedUserWords[] {
  return messages.flatMap((m) => {
    const checked = verifyOne(deps, m.id, own);
    return "reason" in checked ? [] : [checked];
  });
}
