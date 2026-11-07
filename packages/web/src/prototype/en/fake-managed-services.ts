// fake-managed-services.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_MANAGED_SERVICES: Phrases = {
  "短剧站": "Drama site",
  "二狗的外网隧道": "ergo's internet tunnel",
  "tailnet 网关": "tailnet gateway",
  "语音合成（audio.cpp）": "Speech synthesis (audio.cpp)",
  "进程启动 3 秒后退出（退出码 1）：显存不够": "Exited 3 seconds after starting (exit code 1): not enough video memory",
  "语音识别": "Speech recognition",
  "记账本 · 网页": "Ledger · web page",
  "画图": "Drawing",
  "画图的隧道": "Drawing tunnel",
  "笔记同步": "Notes sync",
  "调用方自己": "The caller itself",
  "ergo-daemon 的公网隧道（exposure.via）": "ergo-daemon's public tunnel (exposure.via)",
  "tailnet 网关（ergo-daemon 开着 tailnet 入口）": "tailnet gateway (ergo-daemon has a tailnet entry)",
  "服务管家 30 秒没回话": "The service manager didn't answer for 30 seconds",
  "命令行输出": "Command-line output",
  "{} 没有第 {} 份日志": "{} has no log number {}",
};
