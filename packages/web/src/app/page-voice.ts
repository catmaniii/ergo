// 这个页面上的语音播放（31、36 号票）：把播放器（app/voice-playback.ts）接到浏览器的 <audio> 上、把"自动播放 agent 的语音"
// 开关（app/voice-autoplay-setting.ts）接到 localStorage 上，给界面几个 hook；还有"开着哪些会话"（会话组件挂上时登记，
// 自动播放只播开着的会话里的）。单独一个文件，那两个模块就不碰浏览器的全局变量，能在 Node 里测。
import { useEffect, useSyncExternalStore } from "react";
import type { ConversationId } from "../state/index.ts";
import { type AutoplaySetting, autoplaySettingIn } from "./voice-autoplay-setting.ts";
import { type VoicePlayer, voicePlayerIn } from "./voice-playback.ts";

let player: VoicePlayer | undefined;
let setting: AutoplaySetting | undefined;

/** 整个页面共用的播放器 */
export function pageVoicePlayer(): VoicePlayer {
  player ??= voicePlayerIn({ createAudio: () => new Audio() });
  return player;
}

/** 这台设备上的"自动播放 agent 的语音"开关 */
export function pageAutoplaySetting(): AutoplaySetting {
  setting ??= autoplaySettingIn(() => localStorage);
  return setting;
}

/** 点气泡：播放或暂停这一条（按媒体 id 认） */
export function toggleVoice(id: string, url: string): void {
  pageVoicePlayer().toggle(id, url);
}

/** 在用户手势里调（按住说话松手、点发送）：先让播放器出一次声，之后的自动播放才不被手机浏览器拦下 */
export function unlockVoicePlayback(): void {
  pageVoicePlayer().unlock();
}

/** 这一条在不在播 */
export function useVoicePlaying(id: string): boolean {
  const p = pageVoicePlayer();
  return useSyncExternalStore(p.subscribe, () => p.isPlaying(id));
}

/** 这一条的自动播放被浏览器拦下了（气泡上提示"点一下播放"） */
export function useVoiceBlocked(id: string): boolean {
  const p = pageVoicePlayer();
  return useSyncExternalStore(p.subscribe, () => p.isBlocked(id));
}

/** 有没有哪一条语音在播（语音模式里麦克风的兜底 (a) 看它，见 voice-fallbacks.ts） */
export function useVoiceAnyPlaying(): boolean {
  const p = pageVoicePlayer();
  return useSyncExternalStore(p.subscribe, p.anyPlaying);
}

/** 正按着"按住 说话" */
export function useVoiceCapturing(): boolean {
  const p = pageVoicePlayer();
  return useSyncExternalStore(p.subscribe, p.capturing);
}

/** 自动播放的开关开着吗 */
export function useAutoplayEnabled(): boolean {
  const s = pageAutoplaySetting();
  return useSyncExternalStore(s.subscribe, s.enabled);
}

/** 开着的会话（会话组件挂着的；宽屏上可能不止一个），每个记着挂了几处 */
const openCount = new Map<ConversationId, number>();
let openNow: readonly ConversationId[] = [];

/** 会话组件挂着时登记"开着这个会话" */
export function useOpenConversation(conversation: ConversationId): void {
  useEffect(() => {
    openCount.set(conversation, (openCount.get(conversation) ?? 0) + 1);
    openNow = [...openCount.keys()];
    return () => {
      const left = (openCount.get(conversation) ?? 1) - 1;
      if (left > 0) openCount.set(conversation, left);
      else openCount.delete(conversation);
      openNow = [...openCount.keys()];
    };
  }, [conversation]);
}

/** 现在开着哪些会话 */
export function openConversations(): readonly ConversationId[] {
  return openNow;
}
