// 这个 agent 说话时用哪个参考音色（248 号票；241 号票起是每个 agent 自己配的，现在从它用的角色来）：
// 角色的 voiceId（没指定、被删了、语音插件刚停用）都回退到全局选中的那个（31 号票），行为和以前一模一样。
// 说话的是哪个 agent 从会话认：秘书的主线是 secretary，维护者的会话是 maintainer:<agent id>（tm-<n>、pm-<n>，以后还有记忆管理员）。
// 改完角色、改完某个 agent 指定的角色，下一次合成就生效：这里的解析在"定这一轮用不用语音 / 合成前"现做，不缓存。
import { CHANNELS, MAINTAINER_CHANNEL_PREFIX } from "@ergo/protocol";
import type { AgentRoles } from "../agent-roles/index.ts";
import type { ResolvedReferenceVoice } from "./reference-voices.ts";

/** 这个会话里说话的是哪个 agent（秘书、维护者）；别的（不该发生）是 undefined */
export function agentIdOfConversation(conversation: string): string | undefined {
  // 秘书的 agent id 就是它的会话名（daemon 的 SECRETARY_AGENT_ID 和协议包的 CHANNELS.secretary 都是 "secretary"，不引那两个大模块）
  if (conversation === CHANNELS.secretary) return CHANNELS.secretary;
  return conversation.startsWith(MAINTAINER_CHANNEL_PREFIX) ? conversation.slice(MAINTAINER_CHANNEL_PREFIX.length) : undefined;
}

/** 现取参考音色的那两样（语音插件自己的 ReferenceVoices 满足它） */
export interface VoiceLookup {
  /** 某一个参考音色（连同参考录音的位置）；没有是 undefined */
  get(voiceId: string): ResolvedReferenceVoice | undefined;
  /** 语音回复现在用的（全局选中的，没选过用最早导入的）；一个都没有是 undefined */
  current(): ResolvedReferenceVoice | undefined;
}

/**
 * 这个 agent 说话时用哪个参考音色：它用的角色指定了（还在）就用它，没指定 / 被删了 / 语音插件没启用就回全局选中的那个；
 * 一个参考音色都没有时 undefined（这次不用语音，和以前一样）
 */
export function voiceOfAgent(agentId: string | undefined, { roles, voices }: { roles?: Pick<AgentRoles, "voiceIdOf"> | undefined; voices: VoiceLookup }): ResolvedReferenceVoice | undefined {
  const ownId = agentId === undefined ? undefined : roles?.voiceIdOf(agentId);
  const own = ownId === undefined ? undefined : voices.get(ownId);
  return own ?? voices.current();
}
