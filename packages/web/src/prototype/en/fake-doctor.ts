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
  "tailnet 节点离线": "tailnet node offline",
  "进程退出（代码 3221225477）": "process exited (code 3221225477)",
  "家里的平板": "Home tablet",
};
