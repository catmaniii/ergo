// fake-doctor.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_DOCTOR: Phrases = {
  "推理库": "Reasoning store",
  "能打开；昨晚 03:12 整理过": "Opens fine; tidied up at 03:12 last night",
  "记忆简报": "Memory briefing",
  "语音合成": "Speech synthesis",
  "语音合成服务没开（http://127.0.0.1:8090）：你发语音时的回复都合成不了，退回只发文字":
    "The speech synthesis service isn't running (http://127.0.0.1:8090): replies to your voice messages can't be synthesized and fall back to text only",
  "在装二狗的那台电脑上打开服务管家，把「语音合成服务（audio.cpp）」（ergo-daemon--audiocpp）开起来，再查一遍":
    "On the computer running ergo, open the service manager, start “Speech synthesis service (audio.cpp)” (ergo-daemon--audiocpp), then run the checkup again",
  "语音识别": "Speech recognition",
  "服务管家托管的识别服务（127.0.0.1:8091）：模型加载好了（large-v3）": "The recognition service run by the service manager (127.0.0.1:8091): model loaded (large-v3)",
  "参考音色": "Reference voices",
  "有 2 条，语音回复用「示例音色」": "2 available; voice replies use “Sample voice”",
  "找到了：C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe": "Found: C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe",
  "N 卡": "NVIDIA GPU",
  "有 N 卡：语音合成、识别跑在显卡上": "NVIDIA GPU present: speech synthesis and recognition run on the GPU",
  "没装 Codex：在终端里跑 npm i -g @openai/codex，装好后在设置 · 插件里启用": "Codex isn't installed: run npm i -g @openai/codex in a terminal, then enable it in Settings · Plugins",
  "对话长度": "Conversation length",
  "主对话已经用了 935k token，过了自动压缩点 700k 还没压下去": "The main conversation is at 935k tokens, past its auto-compaction point of 700k, and hasn't been compacted",
  "点「现在压缩」；压完再查一遍": 'Press "Compact now", then run the checkup again once it\'s done',
};
