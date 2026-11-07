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
  "在装二狗的那台电脑上打开服务管家，把「audiocpp」开起来，再查一遍": "On the computer running ergo, open the service manager, start “audiocpp”, then run the checkup again",
  "语音识别": "Speech recognition",
  "服务管家托管的识别服务（127.0.0.1:8091）：模型加载好了（large-v3）": "The recognition service run by the service manager (127.0.0.1:8091): model loaded (large-v3)",
  "参考音色": "Reference voices",
  "有 2 条，语音回复用「示例音色」": "2 available; voice replies use “Sample voice”",
  "找到了：C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe": "Found: C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe",
  "N 卡": "NVIDIA GPU",
  "没装 Codex：在终端里跑 npm i -g @openai/codex，装好后在设置 · 插件里启用": "Codex isn't installed: run npm i -g @openai/codex in a terminal, then enable it in Settings · Plugins",
  "tailnet 节点离线": "tailnet node offline",
  "进程退出（代码 3221225477）": "process exited (code 3221225477)",
  "家里的平板": "Home tablet",
};
