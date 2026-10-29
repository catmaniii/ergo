// 语音插件的网页这一半（214 号票，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/voice/plugin.ts）。
// 插件名和守护进程的一样（voice）：守护进程报它在运行就装，停用了、没装上就停。登记的：
// - 输入框的语音模式（composerVoice，VoiceInput.tsx：输入框右边的"文字 / 语音"切换，语音模式下"按住 说话"，31 号票）；
// - 后台部件"自动播放 agent 的语音"（background，Autoplay.tsx：36、38 号票）；
// - 设置 · 语音的页面内容（settingsPages，VoicePage.tsx：识别、合成两个模型的状态，参考音色，"自动播放"开关；45 号票的排法）。
// 停用时：输入框里没有话筒、一律打字（浏览器里记着的语音模式留着，启用回来照旧）；新到的 agent 语音不自动播放；设置列表里没有"语音"，
// 地址 #/more/voice 写"语音插件没启用"。历史里的语音气泡（ui/conversation/VoiceBubble.tsx）是核心的：照样显示识别出的文字，
// 录音和合成好的音频照样点着听（只是读文件）。鸿蒙 App 的原生录音器不动，网页照插件的状况决定用不用（主会话定的第 5 条）。
// 录音、播放的底层（app/voice-session.ts、voice-recorder.ts、voice-native-recorder.ts、page-voice.ts 的播放器……）留在核心：
// 浏览的悬浮按钮上按住说话（212 号票，内置浏览器插件）也用同一套录音器，插件之间不互相 import。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { AgentVoiceAutoplay } from "./Autoplay.tsx";
import { VoiceInput } from "./VoiceInput.tsx";
import { VoicePage } from "./VoicePage.tsx";

export const voiceWebPlugin: WebPluginDefinition = {
  name: "voice",
  get title() {
    return t("ui.plugins.voice.title");
  },
  owns: { composerVoice: ["voice"], background: ["voice-autoplay"], settingsPages: ["voice"] },
  // 设置 · 插件里列的网页上的栏目（211 号票）
  get brings() {
    return [t("ui.plugins.voice.brings.holdToTalk"), t("ui.plugins.voice.brings.autoplay"), t("ui.plugins.voice.brings.settings")];
  },
  setup(ctx) {
    ctx.register("composerVoice", { id: "voice", Input: VoiceInput });
    ctx.register("background", { id: "voice-autoplay", Run: AgentVoiceAutoplay });
    ctx.register("settingsPages", { id: "voice", Page: VoicePage });
  },
};
