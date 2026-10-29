// 运行时给秘书的通知开头的标记（只有常量和一个看开头的纯函数：系统提示的占位符清单 prompts/registry.ts、发语音工具 voice/send-voice.ts
// 也引用，免得为了一个常量把整个模块拉进来）。115 号票起标记取协议包 agent-letters.ts 的那一份：Web 按它认哪些在会话里折成一行。
import { CHANNELS, LETTER_TAGS, type MessageEnvelope } from "@ergo/protocol";

/** 任务做完的通知（99 号票，task-done.ts）开头的标记：秘书的系统提示里说明它，占位符 {{任务做完标记}} */
export const TASK_DONE_TAG = LETTER_TAGS.task_done;

/**
 * 维护者给秘书发的消息（102 号票，letters.ts 收、task-done.ts 交）经运行时转交给秘书的通知开头的标记：秘书的系统提示里说明它，
 * 占位符 {{维护者来信标记}}
 */
export const MAINTAINER_LETTER_TAG = LETTER_TAGS.maintainer_letter;

/** 是不是维护者来信的通知（秘书会话里运行时发的、开头是标记的系统消息）：被打断时不出"请重发"的说明，由 task-done.ts 重新交 */
export function isMaintainerLetterNotice(message: MessageEnvelope): boolean {
  const first = message.parts[0];
  return message.conversation === CHANNELS.secretary && message.speaker === "system" && first?.type === "text" && first.text.startsWith(MAINTAINER_LETTER_TAG);
}

/**
 * 开了"跑完自动播报"的任务做完的通知（100 号票）：紧跟在 TASK_DONE_TAG 后面的标记，占位符 {{自动播报标记}}。
 * 用户事先给的授权：秘书处理这条通知的那一轮能发语音（send_voice 放行），别的运行时通知照旧不行
 */
export const AUTO_ANNOUNCE_TAG = "【跑完自动播报】"; // @i18n-ignore model：通知开头的标记，运行时按它认

/**
 * 是不是开了跑完自动播报的任务做完的通知：秘书会话里运行时发的系统消息，开头就是两个标记（标记写在开头，后面 agent 说的话里
 * 带着同样的字也不算；用户发不了系统消息）
 */
export function isAutoAnnounceNotice(message: MessageEnvelope): boolean {
  const first = message.parts[0];
  return message.conversation === CHANNELS.secretary && message.speaker === "system" && first?.type === "text" && first.text.startsWith(`${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}`);
}
