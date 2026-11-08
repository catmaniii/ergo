// 二狗按钮上按住说的一段认成字（内核的，444 从浏览插件挪过来）：用户按住二狗的按钮说话——"浏览"里网页上的悬浮按钮、地图右下角的二狗按钮——
// 二狗的网页把录的这一段交过来，认出来的字回给它：它先在按钮旁边的气泡里显示出来，再作为一条消息（带网页 / 地图上下文、标着是说的）
// 发进秘书的主会话。识别和 Debug 工具集一样直接用识别进程，不经会话（认出来的字随消息记进会话）。
// 认出来的字已经剔掉了模型自带的串词；剔完是空的（只有串词）回"已丢弃"，不发消息。
// 识别是语音插件的：经它对外的服务现取（voice/api.ts 的 VOICE.recognize）；语音插件没在运行时回"没认出说了什么：语音插件没启用"。
// 两个入口用的都是这一个：浏览插件的 POST /api/page-command/voice（浏览插件停用时照旧回"内置浏览器插件没启用"）、
// 内核的 POST /api/talk-voice（地图的二狗按钮用，只依赖语音插件）。
import { type PageVoiceResult, t } from "@ergo/protocol";
import { type VoiceApi, voiceOffReason } from "../voice/api.ts";

export type TalkVoice = (audio: Buffer, mime: string) => Promise<PageVoiceResult>;

/** voice：语音插件的服务，现取（插件没在运行时是 undefined） */
export function createTalkVoice(voice: () => Pick<VoiceApi, "recognize"> | undefined): TalkVoice {
  return async (audio, mime) => {
    const recognizer = voice();
    if (!recognizer) return { ok: false, reason: t("conversation.talkVoice.notRecognized", { reason: voiceOffReason() }) };
    const heard = await recognizer.recognize(audio, mime);
    if (!heard.ok) return { ok: false, reason: t("conversation.talkVoice.notRecognized", { reason: heard.reason }) };
    const text = heard.text.trim();
    if (text !== "") return { ok: true, text };
    return { ok: false, reason: heard.strippedChars ? t("conversation.talkVoice.onlyFiller") : t("conversation.talkVoice.empty") };
  };
}
