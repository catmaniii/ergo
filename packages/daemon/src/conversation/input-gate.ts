// agent 输入队列的挡板（214 号票，主会话定的第 2 条"核心留口子"）：会话交一条输入之前问"这条消息这时还要不要等"。
// - 语音插件在运行时由它回答（31、208、210 号票的规矩：第一次识别的语音挡着、进了自动重试的不挡后面的，见 voice/gate.ts）；
// - 语音插件不在（停用了、没装上）时按这里（主会话定的第 3 条）：还没识别完的语音不再挡队列——消息里只有这样的语音的不交给 agent
//   （留在队里、不挡后面的；启用回来时接着识别，有了结局照语音插件的规矩交，同守护进程重启），带附件、卡片、文字的照交，
//   语音那段投影成"识别失败"（agent-input.ts：没有结局的语音按识别失败投影，和 208 号票的失败一样）。
// 只看事件日志的派生视图（语音对象是内核的数据契约，voice-records/），守护进程重启后一样。
import type { MessageEnvelope } from "@ergo/protocol";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { onlyVoiceParts, unsettledVoicesOf } from "../voice-records/views.ts";

/**
 * 一条输入这时挡不挡：
 * - ready：能交给 agent；
 * - waiting：等着，后面的也不越过它（31 号票：语音还在第一次识别）；
 * - deferred：等着，但不挡后面的（210 号票：语音在自动重试；语音插件不在时只有语音、还没识别完的）
 */
export type InputGate = "ready" | "waiting" | "deferred";

/** 语音插件不在时的挡板：还没识别完的语音不挡队列；消息里只有这样的语音的先不交（deferred），带别的东西的照交 */
export function unattendedInputGate(db: ReadonlyDatabase, message: Pick<MessageEnvelope, "parts">): InputGate {
  if (unsettledVoicesOf(db, message).length === 0) return "ready";
  return onlyVoiceParts(message) ? "deferred" : "ready";
}
