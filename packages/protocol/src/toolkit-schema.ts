// 工具包、skill 库和 MCP 登记的 schema（规格第 20、21 节，27 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型：
// - 工具包里能选的东西（ToolkitCatalog，设置里的 skill 库页、项目页和任务详情的工具包区用）：skill 库里的 skill（框架自带的、
//   用户导入的）和配置区里登记的 MCP（每个工具的中文名、要不要联网、能不能当秘书的快速动作）。走 HTTP（GET）；
// - 导入 skill（POST）：把一个含 SKILL.md 的目录复制一份进数据目录的 skill 区；
// - 用户在项目页或任务详情里直接改工具包（set_toolkit 请求）：扩大、减少都直接写进工具包，不出计划变更卡；
// - "工具包变更"卡（toolkit_change）：项目维护者不在任务里时要开 bash、加 MCP、开联网，提交它进待我处理，用户批准或拒绝。
// 名字和纯函数在 toolkit.ts。
import { type Static, Type } from "typebox";
import { PlanToolkit } from "./task-schema.ts";

/** skill 库里的一个 skill：名字（SKILL.md 的 name）、说明、来源（框架自带的、你导入的） */
export const SkillEntry = Type.Object({
  name: Type.String(),
  description: Type.String(),
  origin: Type.Union([Type.Literal("framework"), Type.Literal("imported")]),
});
export type SkillEntry = Static<typeof SkillEntry>;

/** 登记的一个 MCP 工具（给界面看的部分） */
export const McpToolEntry = Type.Object({
  /** 登记的工具名（MCP 服务里的名字） */
  name: Type.String(),
  /** 中文名 */
  title: Type.String(),
  /** 要联网：工具包联网关着时会话里没有它 */
  network: Type.Boolean(),
  /** 只读或幂等 */
  readOnlyOrIdempotent: Type.Boolean(),
  /** 授权给秘书的快速动作（参数按登记固定）：快速动作的说法 */
  quickAction: Type.Optional(Type.String()),
});
export type McpToolEntry = Static<typeof McpToolEntry>;

/** 配置区里登记的一个 MCP */
export const McpServerEntry = Type.Object({
  name: Type.String(),
  title: Type.String(),
  tools: Type.Array(McpToolEntry),
});
export type McpServerEntry = Static<typeof McpServerEntry>;

/** 工具包里能选的东西：skill 库和登记的 MCP（GET HTTP_PATHS.toolkitCatalog 的响应） */
export const ToolkitCatalog = Type.Object({
  skills: Type.Array(SkillEntry),
  mcp: Type.Array(McpServerEntry),
  /** MCP 登记文件读不了、写错了时的说明（这时 mcp 是空的） */
  mcpProblem: Type.Optional(Type.String()),
});
export type ToolkitCatalog = Static<typeof ToolkitCatalog>;

/** 导入 skill（POST HTTP_PATHS.skillImport 的请求体）：含 SKILL.md 的目录的绝对路径 */
export const ImportSkillBody = Type.Object({ path: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });
export type ImportSkillBody = Static<typeof ImportSkillBody>;

/** 导入的结果：导入进来的 skill */
export const ImportSkillResult = Type.Object({ skill: SkillEntry });
export type ImportSkillResult = Static<typeof ImportSkillResult>;

/** 改谁的工具包：一个项目，或者一个任务（任务的是它现在生效的计划里的工具包） */
export const ToolkitTarget = Type.Union([
  Type.Object({ kind: Type.Literal("project"), projectId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("task"), taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
export type ToolkitTarget = Static<typeof ToolkitTarget>;

/** 用户在项目页或任务详情里直接改工具包（set_toolkit 请求）：给出改完的整个工具包 */
export const SetToolkitParams = Type.Object({ target: ToolkitTarget, toolkit: PlanToolkit }, { additionalProperties: false });
export type SetToolkitParams = Static<typeof SetToolkitParams>;

/** 改完之后的工具包，以及改了什么（没有改动时 changed 为 false） */
export const SetToolkitResult = Type.Object({ toolkit: PlanToolkit, changed: Type.Boolean() });
export type SetToolkitResult = Static<typeof SetToolkitResult>;

/**
 * "工具包变更"卡（toolkit_change）：项目维护者不在任务里时要开 bash、加 MCP、开联网，提交它进待我处理。
 * 批准（approve）后这几样加进项目的工具包、维护者按新工具包重新装配；拒绝（deny）则工具包不变。
 * 批准、拒绝都是"审批决定"素材
 */
export const ToolkitChangeCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  maintainerId: Type.String(),
  /** 维护者为什么要加 */
  why: Type.String(),
  /** 提交时项目的工具包 */
  before: PlanToolkit,
  /** 要加的能力（开 bash、加 MCP、开联网）加上去之后的样子 */
  after: PlanToolkit,
  /** 卡上"工具包变更"一栏：要加的能力的说法（"联网"、"MCP exif"……） */
  additions: Type.Array(Type.String()),
  /** 批准之后项目的工具包（批准时现在的工具包加上要加的能力） */
  applied: Type.Optional(PlanToolkit),
});
export type ToolkitChangeCardPayload = Static<typeof ToolkitChangeCardPayload>;

/**
 * `toolkit_change_decided` 事件（守护进程内部的 toolkits 频道，前端不订阅）：用户批准或拒绝了一张"工具包变更"卡，
 * 或者在项目页、任务详情里直接扩大、减少了工具包。"审批决定"素材的来源（08 号票的采集按事件类型登记）
 */
export const ToolkitDecidedPayload = Type.Object({
  /** 卡上批准（approved）、拒绝（denied），或者用户直接改的（edited） */
  decision: Type.Union([Type.Literal("approved"), Type.Literal("denied"), Type.Literal("edited")]),
  target: ToolkitTarget,
  /** 项目名或任务标题 */
  targetTitle: Type.String(),
  before: PlanToolkit,
  after: PlanToolkit,
  /** 卡片（批准、拒绝时有） */
  cardId: Type.Optional(Type.String()),
  /** 用户附带的说明 */
  note: Type.Optional(Type.String()),
  time: Type.String(),
});
export type ToolkitDecidedPayload = Static<typeof ToolkitDecidedPayload>;
