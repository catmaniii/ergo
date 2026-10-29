// 悬浮按钮上按住说的一段送识别（149 号票，POST /api/page-command/voice）：用户在"浏览"里网页的框旁边按住二狗的悬浮按钮说话，
// 二狗的网页把录的这一段交到这里，认出来的字回给它——它先在按钮旁边的气泡里显示出来，再作为一条消息（带网页上下文，
// via: "button"、spoken）发进秘书的主会话（用户 2026-10-18："干脆悬浮按钮的二狗和秘书的二狗是一个实体好了"）。
// 134 号票原来在这里的一次性页面助手（runOneShotAgent）不再有：填框、找文件、看图、候选都由秘书在这一轮用网页工具做
// （browsing/secretary-tools.ts）。识别和 Debug 工具集一样直接用守护进程的识别进程，不经会话（认出来的字随消息记进会话）。
// 180 号票：认出来的字已经剔掉了模型自带的串词；剔完是空的（只有串词）回"已丢弃"，不发消息。
// 212 号票起是浏览插件的；214 号票起识别是语音插件的：经它对外的服务现取（voice/api.ts 的 VOICE.recognize，浏览插件定义里
// wants: [VOICE]，ctx.optional 现取）；语音插件没在运行时回"没认出说了什么：语音插件没启用"，不发消息。
import { type PageVoiceResult, t } from "@ergo/protocol";
import { type VoiceApi, voiceOffReason } from "../voice/api.ts";

export type PageVoice = (audio: Buffer, mime: string) => Promise<PageVoiceResult>;

/** voice：语音插件的服务，现取（插件没在运行时是 undefined） */
export function createPageVoice(voice: () => Pick<VoiceApi, "recognize"> | undefined): PageVoice {
  return async (audio, mime) => {
    const recognizer = voice();
    if (!recognizer) return { ok: false, reason: t("browsing.voice.notRecognized", { reason: voiceOffReason() }) };
    const heard = await recognizer.recognize(audio, mime);
    if (!heard.ok) return { ok: false, reason: t("browsing.voice.notRecognized", { reason: heard.reason }) };
    const text = heard.text.trim();
    if (text !== "") return { ok: true, text };
    return { ok: false, reason: heard.strippedChars ? t("browsing.voice.onlyFiller") : t("browsing.voice.empty") };
  };
}
