// 角色（248 号票）：把"名字 + 音色"绑成一个角色，设置里统一维护一张角色表，每个 agent 只选一个角色。
// 用户 2026-10-22 定：名字和音色不再分开设，统一成"角色"——可以设很多个角色，选一个角色就同时启用它的名字和音色；
// 比如秘书配一个角色、别的 agent 配另一个，在设置里提前配好；其他 agent 有默认使用的角色，具体一个 agent 的设置里还能另选。
// 角色只给 agent 用：名字影响界面上的称呼、它自己的系统提示、语音播报的开头；音色影响它说出来的所有话。
//
// 存哪：数据目录配置区的 agent-roles.json，形状 { format: 1, defaultRoleId, roles: [...], assignments: {...} }。
// - roles 里有一行是**默认角色**（defaultRoleId 指的那个）：跟默认的 agent 都用它。默认角色的名字就是 43 号票的全局名字，
//   音色就是 31 号票全局选中的那个参考音色——改名、换音色统一改这两个全局的，所以界面上、系统提示里、占位符里永远是同一个名字；
//   把别的角色设成默认时，全局名字和音色跟着变成那个角色的（旧的默认角色留下自己原来的名字）。
// - 每个角色：id（生成、稳定）、name（照 43 号票的 checkAssistantName 查）、voiceId（可空 = 不指定、跟当前默认音色；
//   写不存在的音色 400）。
// - assignments：没写 = 跟默认角色。
// - 第一次读到 agent-roles.json 不存在时，从旧的 agent-profiles.json（241 号票）+ 全局名字 + 全局选中音色迁移一次，旧文件保留。
//
// 这里是纯函数和常量（不引用 TypeBox）：配置文件、请求体、视图的 schema 在 agent-roles-schema.ts。
// "名字 / 音色是从哪来的"那份视图沿用 241 号票的 AgentIdentityView（agent-profiles-schema.ts），不另起一套。
import { t } from "./i18n/runtime.ts";

/** 配置文件的格式版本（config/agent-roles.json） */
export const AGENT_ROLE_FORMAT = 1;

/** 迁移出来的那个默认角色的 id（之后用户可以把别的角色设成默认，这个 id 不变） */
export const DEFAULT_AGENT_ROLE_ID = "role-default";

/** 新角色的 id 前缀（daemon 生成 role-<8 位>；不用中文，手改坏了也认得出来） */
export const AGENT_ROLE_ID_PREFIX = "role-";

/** 角色 id 的规矩：role- 开头，只有字母、数字、减号、下划线（手改坏的那一行当成没有） */
export const AGENT_ROLE_ID = /^role-[A-Za-z0-9_-]{1,40}$/;

/** 这一句话是给界面和接口用的"跟默认（<默认角色的名字>）"：角色下拉里第一项 */
export const followDefaultRoleLabel = (defaultRoleName: string) => t("protocol.agentRoles.followDefault", { name: defaultRoleName });
