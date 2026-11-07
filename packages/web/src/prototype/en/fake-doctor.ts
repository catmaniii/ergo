// fake-doctor.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_DOCTOR: Phrases = {
  "推理库": "Reasoning store",
  "能打开；昨晚 03:12 整理过": "Opens fine; tidied up at 03:12 last night",
  "记忆简报": "Memory briefing",
  "语音合成服务": "Speech synthesis service",
  "连不上 127.0.0.1:8090（从 15:42 起），语音回复都没合成": "Can't reach 127.0.0.1:8090 (since 15:42); no voice replies were synthesized",
  "在服务管家里把语音合成服务开起来，再查一遍": "Start the speech synthesis service in the service manager, then run the checkup again",
  "语音识别服务": "Speech recognition service",
  "在听（127.0.0.1:8091）": "Listening (127.0.0.1:8091)",
  "没装 Codex：在终端里跑 npm i -g @openai/codex，装好后在设置 · 插件里启用": "Codex isn't installed: run npm i -g @openai/codex in a terminal, then enable it in Settings · Plugins",
  "对话长度": "Conversation length",
  "主对话已经用了 935k token，过了自动压缩点 700k 还没压下去": "The main conversation is at 935k tokens, past its auto-compaction point of 700k, and hasn't been compacted",
  "点「现在压缩」；压完再查一遍": 'Press "Compact now", then run the checkup again once it\'s done',
  "存一份到本地": "Keep a local copy",
  "出了问题：vlog 没存：Looki 换了接口：这个接口停用了（HTTP 400：This endpoint is deprecated）。照片、日记照常存，二狗跟着改好之前 vlog 先存不了":
    "Ran into a problem: Vlogs not saved: Looki changed its API: this endpoint has been retired (HTTP 400: This endpoint is deprecated). Photos and journals still save; vlogs wait until ergo catches up",
  "去设置 · 数据源 · Looki 的「存一份到本地」那一块看原因：位置、磁盘、权限的问题照它说的改；写着 Looki 回的不对（比如换了接口）的，等二狗更新，照片、日记照常存":
    'Open the "Keep a local copy" panel in Settings · Data sources · Looki to see why: fix folder, disk or permission problems as it says; if Looki answered something unexpected (say, it changed its API), wait for an Ergo update — photos and journals keep saving',
  "「工作」：地址失效了（Google 回了 404）": '"Work": the address no longer works (Google returned 404)',
  "每个日历地址": "Each calendar address",
  "「工作」连着 2 次没拉到：地址失效了（Google 回了 404）：可能在 Google 日历里重置过私密地址，去 Google 日历的设置里重新复制「iCal 格式的私密地址」":
    '"Work" failed 2 times in a row: the address no longer works (Google returned 404): the private address may have been reset in Google Calendar; copy the "Secret address in iCal format" again from its settings',
  "地址失效、没权限的要重新复制：Google 日历网页版 → 这个日历的设置 → 「iCal 格式的私密地址」，在设置 · 数据源 · Google · 日历里删掉旧的、加上新的":
    'Addresses that expired or lost permission need copying again: Google Calendar on the web → this calendar\'s settings → "Secret address in iCal format", then remove the old one and add the new one in Settings · Data sources · Google · Calendar',
  "手机 App": "Phone app",
  "最近一次交来东西是 11/7 14:12": "Last sent something at 11/7 14:12",
  "手机日历交来 0 条": "Phone calendar sent 0 events",
  "最近没有交来 0 条": "No sends with 0 events lately",
  "时区": "Time zone",
  "和这台电脑一样（Asia/Shanghai）": "Same as this computer (Asia/Shanghai)",
  "数据源交来的日程": "Events from data sources",
  "都拿得到": "All coming through",
  "缩略图": "Thumbnails",
  "这次开机以来缩了 12 批图，都没出错": "Shrank 12 batches of images since Ergo started, no errors",
  "Agent SDK 0.3.296；本机装了 Claude Code（claude.exe），会话、接管、交给官方 App 都用它":
    "Agent SDK 0.3.296; Claude Code (claude.exe) is installed on this computer and is used for sessions, takeovers and handing off to the official app",
};
