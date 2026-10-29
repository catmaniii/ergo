// MCP 登记变更（239 号票）和秘书带参调用（240 号票）的卡、事件和审批决定的 schema（240 号票的在文件后半）。
// 239 号票：维护者用 request_mcp_change 提"加、改、删一条 MCP 登记"，运行时出一张"MCP 登记变更"卡进待我处理，
// 用户确认之后由运行时按 name 合并写进数据目录配置区的 mcp.json（mcp/writer.ts），拒绝则一个字节都不动。
// 卡上要显示：启动命令、args、env（密钥只写引用 { fromEnv }，卡上写"来自环境变量 X"）、暴露的工具和只读/联网标注、快速动作。
// 这里的登记 schema 是给界面和卡片负载用的（比守护进程 registration.ts 的宽：那边多一层校验、写之前还会按它再校一遍，
// 见 mcp/change.ts）；工具里那一层（类别、底线、参数规则、inputSchema）不在这里列，additionalProperties 放行。
import { type Static, Type } from "typebox";
import { MCP_NAME_PATTERN } from "./toolkit.ts";

/** 三种动作：加一条、改一条（按 name 换掉）、删一条（也要确认） */
export const MCP_CHANGE_ACTIONS = ["add", "update", "remove"] as const;
export type McpChangeAction = (typeof MCP_CHANGE_ACTIONS)[number];

const Name = Type.String({ pattern: MCP_NAME_PATTERN, maxLength: 64 });

/** 环境变量的值：写字符串是原样的值；写 { fromEnv } 是按名字从守护进程的环境里取（凭据只写这种，不写明文） */
export const McpChangeEnvValue = Type.Union([Type.String(), Type.Object({ fromEnv: Type.String({ minLength: 1 }) }, { additionalProperties: false })]);
export type McpChangeEnvValue = Static<typeof McpChangeEnvValue>;

/** 卡上列出的一行工具：中文名、说明、只读或幂等、要不要联网、授权给秘书的快速动作 */
export const McpChangeToolView = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.Optional(Type.String()),
    readOnlyOrIdempotent: Type.Optional(Type.Boolean()),
    network: Type.Optional(Type.Boolean()),
    quickAction: Type.Optional(
      Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }), args: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: true },
);
export type McpChangeToolView = Static<typeof McpChangeToolView>;

/** 一条 MCP 登记（卡上显示的和确认后写进 mcp.json 的同一份） */
export const McpChangeRegistration = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 60 })),
    command: Type.String({ minLength: 1 }),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.String()),
    /** 单次调用、自检最多等多久（毫秒） */
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    env: Type.Optional(Type.Record(Type.String(), McpChangeEnvValue)),
    tools: Type.Record(Name, McpChangeToolView),
  },
  { additionalProperties: false },
);
export type McpChangeRegistration = Static<typeof McpChangeRegistration>;

/**
 * 是谁提的：项目的维护者（对话段）还是任务的维护者。项目内部的（64 号票）带上所属的项目。
 * 卡上的标题、待我处理里的来源、时间线记录、审批决定素材都由它写
 */
export const McpChangeSubmitter = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("project"),
      projectId: Type.String({ minLength: 1 }),
      projectName: Type.String(),
      maintainerId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("task"),
      taskId: Type.String({ minLength: 1 }),
      taskTitle: Type.String(),
      maintainerId: Type.String({ minLength: 1 }),
      /** 项目内部任务的所属项目 */
      projectId: Type.Optional(Type.String()),
      projectName: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);
export type McpChangeSubmitter = Static<typeof McpChangeSubmitter>;

/** 批准之后的自检结果：真把这条 MCP 拉起来一次（tools/list），拉不起来时写原因（登记留着，不自动回滚） */
export const McpRegistrationCheck = Type.Object({
  ok: Type.Boolean(),
  /** 服务进程报的工具名 */
  tools: Type.Array(Type.String()),
  /** 没拉起来的原因（ok 为 false 时有） */
  problem: Type.Optional(Type.String()),
  time: Type.String(),
});
export type McpRegistrationCheck = Static<typeof McpRegistrationCheck>;

/**
 * "MCP 登记变更"卡（mcp_change）：维护者提的加、改、删一条 MCP 登记。批准（approve）后运行时写进配置区的 mcp.json 并自检，
 * 拒绝（deny）则不变。批准、拒绝都是"审批决定"素材
 */
export const McpChangeCardPayload = Type.Object({
  action: Type.Enum(MCP_CHANGE_ACTIONS),
  name: Name,
  /** 要写进去的登记；remove 时不带 */
  registration: Type.Optional(McpChangeRegistration),
  submitter: McpChangeSubmitter,
  /** 维护者为什么要这么改（卡上显示） */
  why: Type.Optional(Type.String()),
  /** 批准之后由运行时补上 */
  check: Type.Optional(McpRegistrationCheck),
  /** 批准之后由运行时补上：已经按卡写进 mcp.json 了 */
  applied: Type.Optional(Type.Boolean()),
});
export type McpChangeCardPayload = Static<typeof McpChangeCardPayload>;

/**
 * `mcp_decided` 事件（守护进程内部的 mcp 频道，前端不订阅）：用户批准（运行时已经写进文件，并列出自检结果）或拒绝了
 * 一张"MCP 登记变更"卡。"审批决定"素材的来源
 */
export const McpDecidedPayload = Type.Object({
  decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
  action: Type.Enum(MCP_CHANGE_ACTIONS),
  name: Type.String(),
  submitter: McpChangeSubmitter,
  /** 卡片 */
  cardId: Type.Optional(Type.String()),
  /** 用户附带的说明 */
  note: Type.Optional(Type.String()),
  /** 写进 mcp.json 了没有（批准时有） */
  applied: Type.Boolean(),
  check: Type.Optional(McpRegistrationCheck),
  time: Type.String(),
});
export type McpDecidedPayload = Static<typeof McpDecidedPayload>;

// ───────────────────────── 秘书带参调用 MCP（240 号票） ─────────────────────────

/**
 * 一次带参调用的结局（240 号票）：done 调到了（服务进程的结果在这条里）、failed 没调成（服务进程报的错原样带回来）。
 * 不分"读 / 写 / 底线"：用户 2026-10-21 定"MCP call 不要加那么多限制，让秘书能调用 MCP 的所有功能"；
 * 平台自己的守卫照旧判这次工具调用（那是所有工具一视同仁的规则，不是给 MCP 加的）
 */
export const MCP_CALL_OUTCOMES = ["done", "failed"] as const;
export type McpCallOutcome = (typeof MCP_CALL_OUTCOMES)[number];

/** 服务进程回来的结果（时间线、事件日志里的那一份；已经擦掉注入的凭据、截短） */
export const McpCallResultView = Type.Object({
  ok: Type.Boolean(),
  /** 服务进程给的文字 */
  text: Type.String(),
  time: Type.String(),
});
export type McpCallResultView = Static<typeof McpCallResultView>;

/**
 * `mcp_called` 事件（守护进程内部的 mcp 频道，前端不订阅）：秘书用 mcp_call 带参调了一次登记过的 MCP 工具（240 号票）。
 * 哪个 MCP、哪个工具、参数、为什么、服务端结果都在这里；参数是**脱敏之后**的（按登记注入的凭据值换成"来自环境变量 X"，
 * 名字看着是密钥的换成星号），密钥类的原值不写进事件日志
 */
export const McpCalledPayload = Type.Object({
  outcome: Type.Enum(MCP_CALL_OUTCOMES),
  /** MCP 的名字（登记里的键） */
  server: Type.String(),
  /** MCP 的中文名（登记里的 title，没写就是名字） */
  serverTitle: Type.String(),
  /** 工具名 */
  tool: Type.String(),
  /** 工具的中文名（登记里的 title） */
  toolTitle: Type.String(),
  /** 脱敏之后的参数 */
  args: Type.Record(Type.String(), Type.Unknown()),
  /** 秘书为什么这么调 */
  why: Type.Optional(Type.String()),
  /** 服务进程回来的结果 */
  result: McpCallResultView,
  time: Type.String(),
});
export type McpCalledPayload = Static<typeof McpCalledPayload>;