// 悬浮按钮上按住说的一段送识别（POST /api/page-command/voice）：用户在"浏览"里网页的框旁边按住二狗的悬浮按钮说话，
// 二狗的网页把录的这一段交到这里，认出来的字回给它——它先在按钮旁边的气泡里显示出来，再作为一条消息（带网页上下文，
// via: "button"、spoken）发进秘书的主会话（"干脆悬浮按钮的二狗和秘书的二狗是一个实体好了"）。
// 原来在这里的一次性页面助手（runOneShotAgent）不再有：填框、找文件、看图、候选都由秘书在这一轮用网页工具做
// （browsing/secretary-tools.ts）。
// 识别、剔串词、几句说法是内核的（conversation/talk-voice.ts，地图右下角的二狗按钮也用它，444 挪过去）；这里只是浏览插件的那个入口：
// 识别是语音插件的，经它对外的服务现取（voice/api.ts 的 VOICE.recognize，浏览插件定义里 wants: [VOICE]，ctx.optional 现取）；
// 语音插件没在运行时回"没认出说了什么：语音插件没启用"，不发消息。
import { createTalkVoice, type TalkVoice } from "../conversation/talk-voice.ts";
import type { VoiceApi } from "../voice/api.ts";

export type PageVoice = TalkVoice;

/** voice：语音插件的服务，现取（插件没在运行时是 undefined） */
export function createPageVoice(voice: () => Pick<VoiceApi, "recognize"> | undefined): PageVoice {
  return createTalkVoice(voice);
}
