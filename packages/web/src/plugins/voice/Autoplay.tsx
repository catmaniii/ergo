// agent 语音的自动播放（36 号票）在页面上的那一半：盯着状态层里新到的 agent 语音（agentVoiceArrivals），
// 按页面此刻的样子（开关、前台与否、开着哪些会话、是不是正按着"按住 说话"）问状态层该不该播（agentVoiceAutoplay），
// 该播的交给播放器（同一时间只播一条，在播别的就排在后面），决定过了的去掉；"松手后再播"的留着，松手时再问一次。
// 38 号票：每次状态变了，先把每条 agent 语音此刻能播的（状态层的 agentVoicePlayback）转给播放器——边收边播的接着排、
// 排着的换成完整音频、推过的段被收回的停掉放开；再看新到的（分段合成的第一段到了就算），从头播什么由 playbackSource 定。
// 这里只转发，该给什么、要不要停都由状态层的纯函数算。播放器按语音 id 认 agent 的语音（气泡也是）。
// 214 号票起是语音插件的：经后台部件的插槽（background）挂在组合根（App.tsx），整个页面一份；语音插件停用时没有它，新到的 agent 语音
// 不自动播放（历史里的语音气泡照样点着听，播放器是核心的 app/page-voice.ts）。
import { useEffect } from "react";
import { agentVoiceUrls, openConversations, pageVoicePlayer, useAutoplayEnabled, useVoiceCapturing } from "../../app/page-voice.ts";
import { useStore } from "../../app/store.tsx";
import { agentVoiceArrivals, agentVoiceAutoplay, agentVoicePlayback, playbackSource } from "../../state/index.ts";

/** 自动播放（后台部件：不画东西） */
export function AgentVoiceAutoplay() {
  useAgentVoiceAutoplay();
  return null;
}

function useAgentVoiceAutoplay(): void {
  const { ui, http, seeAgentVoiceArrival } = useStore();
  const enabled = useAutoplayEnabled();
  const recording = useVoiceCapturing();
  useEffect(() => {
    const env = { enabled, recording, foreground: document.visibilityState === "visible", openConversations: openConversations() };
    const player = pageVoicePlayer();
    const urls = agentVoiceUrls(http);
    // 先转发每条此刻能播的（收回了的先停掉放开，重做的第一段才能按新到的再播）
    for (const voice of Object.values(ui.agentVoices)) player.update(voice.id, agentVoicePlayback(voice, urls));
    for (const voiceId of agentVoiceArrivals(ui)) {
      const decision = agentVoiceAutoplay(ui, voiceId, env);
      if (decision === "after_recording") continue;
      const voice = ui.agentVoices[voiceId];
      const source = voice === undefined ? undefined : playbackSource(agentVoicePlayback(voice, urls));
      if (decision === "play" && source !== undefined) player.autoplay(voiceId, source);
      seeAgentVoiceArrival(voiceId);
    }
  }, [ui, enabled, recording, http, seeAgentVoiceArrival]);
}
