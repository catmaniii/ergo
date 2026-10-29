// 运行时核实过的用户原话（125 号票；方案"用户授权的效力，与用户签名"第 2 节第一层：运行时作证，不用签名）。
// 能证明"这是用户说的"的只有守护进程：agent 正文里写的"用户说了……""用户已同意"一律只是转述，只作参考；
// 维护者引用用户消息的 id，守护进程逐条核对（消息还在、发言方是用户、没被彻底删除；秘书转达的那句换成用户在秘书那里的原话），
// 核实过的由守护进程写进单独的一栏——评审的输入、范围审视的对照物、计划变更卡、立项要求变更卡——agent 写不出来。
// 每条写：原文、哪个会话、时间、从哪台设备来的（本机 / 设备名）；经秘书转达的另记转达者（照 RFC 8693 的 act，只供审计）。
// 这里是 schema 和给人、给模型看的说法（守护进程和 Web 共用）；核对在守护进程（conversation/user-words.ts）。
import { type Static, Type } from "typebox";
import { ASSISTANT_NAME_MARK } from "./assistant-name.ts";
import { followLocale, t } from "./i18n/runtime.ts";

/** 一次最多引用几条用户原话 */
export const USER_WORDS_MAX = 10;

/** 这一栏的名字（评审的输入、范围审视的对照物、卡片上都用它） */
export let USER_WORDS_TITLE = "";

/** 卡片、阶段详情上一条原话旁边的小签：这是守护进程核实的，不是 agent 转述 */
export let USER_WORDS_BADGE = "";

/**
 * 用户的一条消息从哪发来的（125 号票，记在用户消息事件上）：PC 本机端口（local），或者外网端口上的已配对设备（device，记设备 id）。
 * 125 号票之前的消息没有这一项（设备不详）
 */
export const SentFrom = Type.Union([Type.Object({ kind: Type.Literal("local") }), Type.Object({ kind: Type.Literal("device"), deviceId: Type.String() })]);
export type SentFrom = Static<typeof SentFrom>;

/** 设备那一栏的说法：本机、已配对设备的名字、设备不详 */
export let SENT_FROM_LOCAL = "";
export let SENT_FROM_UNKNOWN = "";

// 上面几句跟着当前语言（followLocale）；给模型看的（评审、范围审视的输入）要中文的用 forModel(() => t("protocol.userWords.title"))
followLocale(() => {
  USER_WORDS_TITLE = t("protocol.userWords.title");
  USER_WORDS_BADGE = t("protocol.userWords.badge");
  SENT_FROM_LOCAL = t("protocol.userWords.local");
  SENT_FROM_UNKNOWN = t("protocol.userWords.unknownDevice");
});

/** 一条运行时核实过的用户原话 */
export const VerifiedUserWords = Type.Object({
  /** 用户原话的消息 id（经秘书转达的，是用户在秘书那里说的那句） */
  messageId: Type.String(),
  /** 原文：用户打的字；语音是识别出的文字（voice）；只发了附件的写附件的名字 */
  text: Type.String(),
  voice: Type.Optional(Type.Literal(true)),
  /** 在哪个会话里说的：会话 id，和给人看的说法（"和<名字占位>的对话""项目「记账本」的维护者会话""任务 t-6「…」的会话"） */
  conversation: Type.String(),
  where: Type.String(),
  /** 什么时候说的（消息的时间，带时区偏移的 ISO 时间） */
  time: Type.String(),
  /** 从哪台设备来的：本机、已配对设备的名字（"设备「我的手机」"）、设备不详 */
  device: Type.String(),
  /** 经秘书转达的（103 号票）：维护者引用的是转达进它会话的那一句（relayMessageId），原话在秘书会话里。转达者只供审计 */
  relayedBy: Type.Optional(Type.Literal("secretary")),
  relayMessageId: Type.Optional(Type.String()),
});
export type VerifiedUserWords = Static<typeof VerifiedUserWords>;

/** 引用的一条没核实过：哪一条、为什么（交回引用它的 agent） */
export interface RefusedUserWords {
  id: string;
  reason: string;
}

/** 时间写成"10-14 08:30"（协议时间是本地时间带偏移，前 16 个字符里就是本地的日期和时刻） */
export const userWordsTime = (iso: string): string => iso.slice(5, 16).replace("T", " ");

/**
 * 一条原话从哪来："10-14 08:30 · 项目「记账本」的维护者会话 · 本机 · 经<名字占位>转达"。提到秘书的写名字占位（43 号票）：
 * 界面上换成用户起的名字，交给 agent 的在宿主协议的出口换成"秘书"
 */
export function userWordsSource(w: Pick<VerifiedUserWords, "time" | "where" | "device" | "relayedBy" | "voice">): string {
  return [
    userWordsTime(w.time),
    w.where,
    w.device,
    ...(w.voice ? [t("protocol.userWords.voice")] : []),
    ...(w.relayedBy ? [t("protocol.userWords.relayed", { assistant: ASSISTANT_NAME_MARK })] : []),
  ].join(" · ");
}

/** 一条原话写成一行（交给评审、范围审视的模型，卡片的纯文本降级）："「不用等满一周」（10-14 08:30 · 任务 t-6 的会话 · 本机）" */
export function userWordsLine(w: VerifiedUserWords): string {
  return t("protocol.userWords.line", { text: w.text, source: userWordsSource(w) });
}

/** 没核实过的那几条交回 agent 的说法；都核实了是空串 */
export function refusedUserWordsText(refused: readonly RefusedUserWords[]): string {
  if (refused.length === 0) return "";
  return `这几条用户原话没核实过，没算进去：${refused.map((r) => `${r.id}（${r.reason}）`).join("；")}。`; // @i18n-ignore model：交回 agent
}
