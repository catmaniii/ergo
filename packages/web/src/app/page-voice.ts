// 这个页面上的语音播放（31、36 号票）：把播放器（app/voice-playback.ts）接到浏览器的 <audio> 上、把"自动播放 agent 的语音"
// 开关（app/voice-autoplay-setting.ts）接到 localStorage 上，给界面几个 hook；还有"开着哪些会话"（会话组件挂上时登记，
// 自动播放只播开着的会话里的）。单独一个文件，那两个模块就不碰浏览器的全局变量，能在 Node 里测。
// 38 号票：分段合成的 agent 语音边收边播用 Web Audio（webAudioScheduler：取段、解码、按时间排程，接缝淡入淡出）；
// agentVoiceUrls 把 DaemonHttp 接成状态层 agentVoicePlayback 要的拼地址的两个函数。
import { useEffect, useSyncExternalStore } from "react";
import { AGENT_VOICE_SEGMENT_FADE_MS, type AgentVoiceUrls, type ConversationId, t } from "../state/index.ts";
import type { DaemonHttp } from "./daemon-http.ts";
import { type AutoplaySetting, autoplaySettingIn } from "./voice-autoplay-setting.ts";
import { type LoadedSegment, type SegmentScheduler, type VoicePlayer, voicePlayerIn, type VoiceSource } from "./voice-playback.ts";

let player: VoicePlayer | undefined;
let setting: AutoplaySetting | undefined;

/** 段的头尾淡入淡出多久（秒）：和守护进程拼完整音频时一样，段的头尾不在零点上时接到静音不出爆音 */
const FADE_SECONDS = AGENT_VOICE_SEGMENT_FADE_MS / 1000;

/** 浏览器的 Web Audio：边收边播分段合成的语音 */
function webAudioScheduler(): SegmentScheduler {
  const context = new AudioContext();
  return {
    now: () => context.currentTime,
    running: () => context.state === "running",
    resume: () => context.resume(),
    async load(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(t("app.pageVoice.segmentFailed", { status: res.status }));
      return await context.decodeAudioData(await res.arrayBuffer());
    },
    play(segment: LoadedSegment, when, onEnded) {
      const buffer = segment as AudioBuffer;
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      const fade = Math.min(FADE_SECONDS, buffer.duration / 2);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + fade);
      gain.gain.setValueAtTime(1, when + buffer.duration - fade);
      gain.gain.linearRampToValueAtTime(0, when + buffer.duration);
      source.connect(gain).connect(context.destination);
      source.addEventListener("ended", onEnded, { once: true });
      source.start(when);
      return () => {
        try {
          source.stop();
        } catch {
          // 已经停了
        }
      };
    },
  };
}

/** 整个页面共用的播放器 */
export function pageVoicePlayer(): VoicePlayer {
  player ??= voicePlayerIn({ createAudio: () => new Audio(), createScheduler: webAudioScheduler });
  return player;
}

/** agent 语音的地址经 DaemonHttp 拼（状态层的 agentVoicePlayback 用） */
export function agentVoiceUrls(http: DaemonHttp): AgentVoiceUrls {
  return { segment: (voiceId, index) => http.agentVoiceSegmentUrl(voiceId, index), media: (mediaId) => http.mediaUrl(mediaId, t("app.pageVoice.fileName")) };
}

/** 这台设备上的"自动播放 agent 的语音"开关 */
export function pageAutoplaySetting(): AutoplaySetting {
  setting ??= autoplaySettingIn(() => localStorage);
  return setting;
}

/** 点气泡：播放或暂停这一条（用户的语音按媒体 id 认，agent 的语音按语音 id 认） */
export function toggleVoice(id: string, source: VoiceSource): void {
  pageVoicePlayer().toggle(id, source);
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

/** 这一条被语音输入暂停在半路了（209 号票：气泡上标"已暂停"，点一下从那里接着放） */
export function useVoicePaused(id: string): boolean {
  const p = pageVoicePlayer();
  return useSyncExternalStore(p.subscribe, () => p.isPaused(id));
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

/** 正在语音输入（聊天窗口按住说话、悬浮按钮按着） */
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
