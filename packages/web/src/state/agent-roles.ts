// 角色（248 号票）的状态层：纯函数，界面（ui/agent-roles.tsx、pages/more/RolesPage.tsx）只管画。
// - 从接口取回的那一份（UiState.agentRoles = GET /api/agent-roles）里认这个 agent 现在用哪个角色、名字和音色是什么；
// - 写成话：⚙ 面板和角色页都写"现在：文翰 · 音色：示例音色"；
// - 改角色的名字时边打边查：和守护进程用同一个函数（协议包的 checkAssistantName），不合规的当场说、存不进去；
// - "谁在用"是角色 id → agent 的 label（秘书那个 label 是名字占位，界面上换成名字）。
import {
  type AgentIdentityView,
  AGENT_PROFILE_NAME_SOURCE_LABEL,
  AGENT_PROFILE_VOICE_SOURCE_LABEL,
  type AgentRoleView,
  type AgentRolesView,
  checkAssistantName,
  fillAssistantName,
  t,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 这个 agent 现在用的角色、名字和音色（还没取过时 undefined：界面上都按"没取到"显示） */
export function agentIdentityOf(state: UiState, agentId: string): AgentIdentityView | undefined {
  return state.agentRoles?.agents.find((entry) => entry.agentId === agentId)?.identity;
}

/** 默认角色（跟默认的 agent 都用它；取不到时 undefined） */
export function defaultRoleOf(view: AgentRolesView | undefined): AgentRoleView | undefined {
  return view?.roles.find((role) => role.isDefault);
}

/** "现在：文翰（指定的角色）" */
export function agentNameNote(identity: AgentIdentityView): string {
  return t("state.agentRoles.now", { name: identity.name, source: AGENT_PROFILE_NAME_SOURCE_LABEL[identity.nameSource] });
}

/** "音色：示例音色（角色指定的）"、"音色：还没有参考音色" */
export function agentVoiceNote(identity: AgentIdentityView): string {
  if (identity.voiceName === undefined) return t("state.agentRoles.voiceNone");
  return t("state.agentRoles.voiceNow", { name: identity.voiceName, source: AGENT_PROFILE_VOICE_SOURCE_LABEL[identity.voiceSource] });
}

/** ⚙ 面板下面那行小字："现在：文翰 · 音色：示例音色（跟默认音色）" */
export function agentIdentityLine(identity: AgentIdentityView): string {
  return t("state.agentRoles.identityLine", { name: identity.name, voice: identity.voiceName ?? t("state.agentRoles.noVoice") });
}

/** 角色下拉里"跟默认"那一项写什么：默认角色的名字 */
export function followDefaultOptionLabel(view: AgentRolesView | undefined): string {
  const name = defaultRoleOf(view)?.name;
  return name === undefined ? t("state.agentRoles.followDefaultUnknown") : t("state.agentRoles.followDefault", { name });
}

/** 某一行下拉里选中"跟默认"时显示的：跟默认（<默认角色的名字>） */
export function assignmentSelectLabel(view: AgentRolesView | undefined, identity: AgentIdentityView): string {
  return identity.ownRoleId === undefined ? followDefaultOptionLabel(view) : (view?.roles.find((role) => role.id === identity.roleId)?.name ?? identity.name);
}

/** 改名时边打边查：空着是"没改"、不管；不合规时给出原因（和守护进程同一个检查） */
export function roleNameProblem(draft: string): string | undefined {
  if (draft.trim() === "") return undefined;
  const checked = checkAssistantName(draft);
  return checked.ok ? undefined : checked.error;
}

/** 输入框里的名字存不存得下：空着、没变、不合规都不存 */
export function canSaveRoleName(current: string, draft: string): boolean {
  const name = draft.trim();
  return name !== "" && roleNameProblem(draft) === undefined && name !== current;
}

/** 新建角色时名字能不能存：非空、合规 */
export function canCreateRoleName(draft: string): boolean {
  return draft.trim() !== "" && roleNameProblem(draft) === undefined;
}

/** agent 在那个页面上的叫法（秘书是名字占位，换成现在的名字）："谁在用"那行、下拉的提示都用它 */
export function agentLabelText(state: UiState, agentId: string): string {
  const entry = state.agentRoles?.agents.find((item) => item.agentId === agentId);
  return entry === undefined ? agentId : fillAssistantName(entry.label, state.assistantName ?? "");
}

/** "谁在用"最多列几个叫法：默认角色往往所有 agent 都在用，列全了那一行长得没法看（后面写"等 N 个 agent"） */
const USED_BY_SHOWN = 3;

/** "谁在用：秘书、项目「记账本」的维护者"、"谁在用：秘书、…… 等 14 个 agent"；没人用时"还没有 agent 用（跟默认的都用默认角色）" */
export function roleUsageText(state: UiState, role: AgentRoleView): string {
  if (role.usedBy.length === 0) return t("state.agentRoles.usedByNobody");
  const labels = role.usedBy.map((agentId) => agentLabelText(state, agentId));
  const agents = labels.slice(0, USED_BY_SHOWN).join(t("common.listSeparator"));
  return labels.length <= USED_BY_SHOWN
    ? t("state.agentRoles.usedBy", { agents })
    : t("state.agentRoles.usedByMore", { agents, count: labels.length });
}

/** 角色表那一行只写个数（"14 个 agent 在用"）：是哪些 agent 放在悬停的 title 里（`roleUsageText`） */
export function roleUsageCount(role: AgentRoleView): string {
  return role.usedBy.length === 0 ? t("state.agentRoles.usedByNobody") : t("state.agentRoles.usedByCount", { count: role.usedBy.length });
}

/** 音色下拉里"跟默认音色"那一项写什么：默认的那个参考音色的名字，一个都没有时写"还没有参考音色" */
export function defaultVoiceOptionLabel(view: AgentRolesView | undefined): string {
  const voice = view?.voices?.find((item) => item.id === view.defaultVoiceId);
  return voice === undefined ? t("state.agentRoles.followDefaultVoiceNone") : t("state.agentRoles.followDefaultVoice", { name: voice.name });
}
