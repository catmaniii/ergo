// agent 语音的自动播放（36 号票）在页面上的那一半：盯着状态层里新到的 agent 语音（agentVoiceArrivals），
// 按页面此刻的样子（开关、前台与否、开着哪些会话、是不是正按着"按住 说话"）问状态层该不该播（agentVoiceAutoplay），
// 该播的交给播放器（同一时间只播一条，在播别的就排在后面），决定过了的去掉；"松手后再播"的留着，松手时再问一次。
// 挂在主框架里（App.tsx 的 Shell），整个页面一份。
import { useEffect } from "react";
import { agentVoiceArrivals, agentVoiceAutoplay } from "../state/index.ts";
import { openConversations, pageVoicePlayer, useAutoplayEnabled, useVoiceCapturing } from "./page-voice.ts";
import { useStore } from "./store.tsx";

export function useAgentVoiceAutoplay(): void {
  const { ui, http, seeAgentVoiceArrival } = useStore();
  const enabled = useAutoplayEnabled();
  const recording = useVoiceCapturing();
  useEffect(() => {
    const env = { enabled, recording, foreground: document.visibilityState === "visible", openConversations: openConversations() };
    for (const voiceId of agentVoiceArrivals(ui)) {
      const decision = agentVoiceAutoplay(ui, voiceId, env);
      if (decision === "after_recording") continue;
      const mediaId = ui.agentVoices[voiceId]?.mediaId;
      const url = mediaId === undefined ? undefined : http.mediaUrl(mediaId, "语音");
      // 气泡按媒体 id 认自己在不在播
      if (decision === "play" && mediaId !== undefined && url !== undefined) pageVoicePlayer().autoplay(mediaId, url);
      seeAgentVoiceArrival(voiceId);
    }
  }, [ui, enabled, recording, http, seeAgentVoiceArrival]);
}
