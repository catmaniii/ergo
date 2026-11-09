// fake-doctor.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_DOCTOR: Phrases = {
  "向量索引": "Vector index",
  "1284 条素材都算好了向量": "Vectors are ready for all 1284 materials",
  "推理库": "Reasoning DB",
  "能用，问记忆和记忆简报在用（12.4 MB）": "Usable; asking memory and memory briefs are using it (12.4 MB)",
  "记忆系统": "Memory system",
  "会意在跑：523 条有效证据，上次整理完是 {}，占 12.4 MB": "Subtext is running: active evidence: 523, last consolidated on {}, 12.4 MB on disk",
  "记忆简报": "Memory brief",
  "{} 以来问了 30 次，超时 12 次、出错 0 次（占 40%）；最近一次用了 3 秒": "Since {}: 30 asked, 12 timed out, 0 failed (40%); the last one took 3 s",
  "超过 3 秒的那一轮就不带记忆了。多半是向量模型算得慢、推理库太大：重启二狗后再看；一直这样就把这句反馈给我们":
    "A turn that takes longer than 3 s goes without memory. Usually the vector model is slow or the reasoning DB is large: restart ergo and check again, and report this to us if it keeps happening",
  "每晚整理": "Nightly consolidation",
  "上次跑成是 60 小时前（{}），之后一直没跑成": "The last successful consolidation was 60 hours ago ({}); none has succeeded since",
  "夜里 03:00 二狗要开着；去记忆管理员那页看整理记录，找没跑成的原因": "Ergo needs to be running at 03:00; check the consolidation records on the memory curator's page for why it didn't succeed",
  "整理前导入数据源": "Data source import before consolidation",
  "{} 整理之前都导好了：Google · 日历（新进来 3 条）": "Before the consolidation on {}, everything was imported: Google · Calendar (3 new)",
  "语音合成": "Speech synthesis",
  "语音合成服务没开（http://127.0.0.1:8090）：你发语音时的回复都合成不了，退回只发文字":
    "The speech synthesis service isn't running (http://127.0.0.1:8090): replies to your voice messages can't be synthesized and fall back to text only",
  "到设置 · 服务把「audiocpp」开起来，再查一遍": "Start “audiocpp” in Settings · Services, then run the checkup again",
  "语音识别": "Speech recognition",
  "服务管家托管的识别服务（127.0.0.1:8091）：模型加载好了（large-v3）": "The recognition service run by the service manager (127.0.0.1:8091): model loaded (large-v3)",
  "参考音色": "Reference voices",
  "有 2 条，语音回复用「示例音色」": "2 available; voice replies use “Sample voice”",
  "找到了：C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe": "Found: C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe",
  "N 卡": "NVIDIA GPU",
  "没装 Codex：到设置 · 组件里装「Codex 接入」（或者在终端里跑 npm i -g @openai/codex），装好后在设置 · 插件里启用": "Codex isn't installed: install \"Codex integration\" under Settings · Components (or run npm i -g @openai/codex in a terminal), then enable it in Settings · Plugins",
  "tailnet 节点离线": "tailnet node offline",
  "进程退出（代码 3221225477）": "process exited (code 3221225477)",
  "家里的平板": "Home tablet",
  "存一份到本地": "Keep a local copy",
  "出了问题：vlog 没存：Looki 换了接口：这个接口停用了（HTTP 400：This endpoint is deprecated）。照片、日记照常存，二狗跟着改好之前 vlog 先存不了":
    "Ran into a problem: Vlogs not saved: Looki changed its API: this endpoint has been retired (HTTP 400: This endpoint is deprecated). Photos and journals still save; vlogs wait until ergo catches up",
  "去设置 · 数据源 · Looki 的「存一份到本地」那一块看原因：位置、磁盘、权限的问题照它说的改；写着 Looki 回的不对（比如换了接口）的，等二狗更新，照片、日记照常存":
    'Open the "Keep a local copy" panel in Settings · Data sources · Looki to see why: fix folder, disk or permission problems as it says; if Looki answered something unexpected (say, it changed its API), wait for an ergo update — photos and journals keep saving',
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
  "这次开机以来缩了 12 批图，都没出错": "Shrank 12 batches of images since ergo started, no errors",
  "Agent SDK 0.3.296；本机装了 Claude Code（claude.exe），会话、接管、交给官方 App 都用它":
    "Agent SDK 0.3.296; Claude Code (claude.exe) is installed on this computer and is used for sessions, takeovers and handing off to the official app",
  "登录": "Sign-in",
  "登录了（Claude Max 订阅）": "Signed in (Claude Max subscription)",
};
