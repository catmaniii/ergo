// 每个 agent 自己的名字和音色（241 号票，用户 2026-10-21 提的需求："我可以每个 agent 单独配置它的语音和姓名……这些名称和音色的对应关系
// 也是集中在设置里面。之前姓名设置是一个全局的单独设置，现在和语音绑在一起合理"）：
// - 名字影响：界面上的称呼、这个 agent 自己的系统提示、语音播报的开头；
// - 音色影响：这个 agent 说出来的所有话（语音回复、发语音、跑完自动播报、让它念网页 / 念报告），不再分场景；
// - 范围：秘书（secretary）、每个项目维护者（pm-<n>）、每个任务维护者（tm-<n>），以及以后按 agent id 自动能配的"记忆管理员"——
//   这里不认名单，认的是"谁是哪个 agent"（agent-settings.ts 的 AGENT_SETTINGS_KINDS），一上线就能配。
//
// 全局的名字（43 号票）和全局选中的音色（31 号票）仍然只有一份，是**默认**：每个 agent 配的是覆盖，没配就跟默认，行为一个字节不变。
// 存哪：数据目录配置区的 agent-profiles.json，形状 { format: 1, agents: { "<agent id>": { name?, voiceId? } } }；
// 慢点读（每次现读，改了下一轮生效），写坏了只影响那一个 agent（回退默认），不让守护进程起不来。
// 名字照 assistant-name.ts 的规则查（复用 checkAssistantName：1–8 个字、没有换行 / 控制字符 / ⟦⟧、去掉首尾空白）；
// voiceId 要是 voices/ 里现在有的参考音色，写不存在的拒收；参考音色后来被删了的，也算没配（回退全局默认）。
// 事件里的名字占位（ASSISTANT_NAME_MARK）这条老路**不动**：历史消息还是"存占位、显示时取名字"，交给 agent 的话里照样换领域术语"秘书"；
// 这次只保证新说的话、新的系统提示用新名字。
// 这里是纯函数和常量（不引用 TypeBox）：配置文件、接口请求体、视图的 schema 在 agent-profiles-schema.ts。
import { t, tTable } from "./i18n/runtime.ts";
import type { AgentSettingsKind } from "./agent-settings.ts";

/** 配置文件的格式版本（config/agent-profiles.json） */
export const AGENT_PROFILE_FORMAT = 1;

/** 名字现在是从哪来的：自己配的、跟默认 */
export const AGENT_PROFILE_NAME_SOURCES = ["own", "default"] as const;
export type AgentProfileNameSource = (typeof AGENT_PROFILE_NAME_SOURCES)[number];

/** 音色现在是从哪来的：自己配的、跟默认（全局选中的那个）、还没有参考音色 */
export const AGENT_PROFILE_VOICE_SOURCES = ["own", "default", "none"] as const;
export type AgentProfileVoiceSource = (typeof AGENT_PROFILE_VOICE_SOURCES)[number];

export const AGENT_PROFILE_NAME_SOURCE_LABEL: Readonly<Record<AgentProfileNameSource, string>> = tTable({
  own: "protocol.agentProfiles.nameSource.own",
  default: "protocol.agentProfiles.nameSource.default",
});

export const AGENT_PROFILE_VOICE_SOURCE_LABEL: Readonly<Record<AgentProfileVoiceSource, string>> = tTable({
  own: "protocol.agentProfiles.voiceSource.own",
  default: "protocol.agentProfiles.voiceSource.default",
  none: "protocol.agentProfiles.voiceSource.none",
});

/** 维护者（任务、项目的）跟默认时的名字：角色称呼 */
export const agentMaintainerName = () => t("protocol.agentProfiles.maintainerName");

/**
 * 跟默认时的名字：秘书的是全局的名字（assistantName 给），维护者是角色称呼。
 * 界面上的"跟默认：<...>"、恢复跟默认之后的样子都按它
 */
export function defaultAgentName(kind: AgentSettingsKind, assistantName: string): string {
  return kind === "secretary" ? assistantName : agentMaintainerName();
}
