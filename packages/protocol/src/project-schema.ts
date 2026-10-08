// 项目、立项和它们的卡片的 schema（规格第 11 节，15 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型。
// - 项目列表频道上的 project 事件：项目的最新状态（Project）；
// - 立项书（Charter）：维护者在立项问答之后用"提交立项书"工具交出的结构化数据（工具的参数），立项书卡由代码从它生成；
// - 两种卡的负载：建议立项卡（suggest_project）、立项书卡（charter）；
// - 三个请求：点"新建项目"（new_project）、任务转为项目（convert_task_to_project）、项目页上的动作（project_action）。
// 名字（状态、类型、动作、变化）在 projects.ts。
import { type Static, Type } from "typebox";
import { PROJECT_ACTIONS, PROJECT_CHANGES, PROJECT_KINDS, PROJECT_ORIGINS, PROJECT_STATES } from "./projects.ts";
import { PlanToolkit } from "./task-schema.ts";
import { TASK_ACTORS } from "./tasks.ts";

const ProjectStateSchema = Type.Enum(PROJECT_STATES);

/** 项目名、一句话目标的长度 */
export const PROJECT_NAME_MAX = 40;
export const PROJECT_GOAL_MAX = 300;

/**
 * 工作目录：默认在项目档案里面（external 为 false）；开发类项目的立项书确认绑定外部路径后，就是这个外部路径。
 * 外部路径不随二狗备份（靠项目自己的 git 远端），绑定关系记在项目档案里
 */
export const ProjectWorkdir = Type.Object({ external: Type.Boolean(), path: Type.Optional(Type.String()) });
export type ProjectWorkdir = Static<typeof ProjectWorkdir>;

/** 项目列表上的一个项目（project 事件里是它的最新状态） */
export const Project = Type.Object({
  /** 项目编号：p-1、p-2…… */
  id: Type.String(),
  name: Type.String(),
  /** 一句话目标（建议立项卡上的；任务转为项目时取任务书里的目标或任务的说明） */
  goal: Type.String(),
  state: ProjectStateSchema,
  origin: Type.Enum(PROJECT_ORIGINS),
  /** 项目的维护者（立项时产生；任务转为项目时就是原任务的维护者）；它的会话频道是 maintainer:<维护者 id> */
  maintainerId: Type.String(),
  /** 由哪个任务转来的 */
  fromTaskId: Type.Optional(Type.String()),
  /** 项目类型：立项书确认时生效（之前没有） */
  kind: Type.Optional(Type.Enum(PROJECT_KINDS)),
  workdir: ProjectWorkdir,
  /** 项目的工具包：立项书确认时，维护者提议的工具包成为项目的工具包（之前没有） */
  toolkit: Type.Optional(PlanToolkit),
  /** 最新一张立项书卡（维护者交过立项书才有） */
  charterCardId: Type.Optional(Type.String()),
  /** 立项书已确认（"只确认，稍后开工"后项目留在筹备中，标"立项书已确认"） */
  charterConfirmed: Type.Boolean(),
  /** 首个建设任务（开工时建出；只有它的完成会让项目进入使用中） */
  buildTaskId: Type.Optional(Type.String()),
  /** 归档前的状态（已归档时才有）：取消归档回到它 */
  archivedFrom: Type.Optional(ProjectStateSchema),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type Project = Static<typeof Project>;

/** `project` 事件（项目列表频道）：项目的最新状态，这次是什么变化、从哪个状态来（建出时为 null）、谁改的 */
export const ProjectEventPayload = Type.Object({
  project: Project,
  change: Type.Enum(PROJECT_CHANGES),
  from: Type.Union([ProjectStateSchema, Type.Null()]),
  by: Type.Enum(TASK_ACTORS),
});
export type ProjectEventPayload = Static<typeof ProjectEventPayload>;

// ───────────────────────── 立项书 ─────────────────────────

/** 立项书（立项问答的结论）：范围、目标、首版要做到什么程度、项目类型、是否把工作目录绑定到一个外部路径 */
export const Charter = Type.Object(
  {
    goal: Type.String({ minLength: 1, maxLength: 2000, description: "目标" }),
    scope: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 30, description: "范围：做哪些、不做哪些，一条一句" }),
    firstVersion: Type.String({ minLength: 1, maxLength: 2000, description: "首版要做到什么程度" }),
    kind: Type.Enum(PROJECT_KINDS, { description: "项目类型：dev 开发类（写代码的），other 其他" }),
    bindExternal: Type.Boolean({ description: "是否把工作目录绑定到一个外部路径（只有开发类可以；不绑定时工作目录在项目档案里）" }),
    externalPath: Type.Optional(Type.String({ minLength: 3, maxLength: 260, description: "绑定的外部路径（绝对路径，比如 D:\\code\\ledger）；bindExternal 为 true 时必填" })),
  },
  { additionalProperties: false },
);
export type Charter = Static<typeof Charter>;

/** 立项书卡的负载：立项书和维护者提议的工具包（开发类默认带 bash）；确认后记下怎么确认的、首个建设任务 */
export const CharterCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  /** 第几版立项书（维护者重新提交加 1；旧的那张随之过期） */
  revision: Type.Integer({ minimum: 1 }),
  charter: Charter,
  toolkit: PlanToolkit,
  /** 确认之后：确认并开工（start）还是只确认、稍后开工（later），开工时建出的首个建设任务 */
  confirmed: Type.Optional(Type.Object({ start: Type.Boolean(), buildTaskId: Type.Optional(Type.String()) })),
});
export type CharterCardPayload = Static<typeof CharterCardPayload>;

/** "建议立项"卡：秘书收口，写名字和一句话目标；用户点"立项"后项目诞生（带上项目编号） */
export const SuggestProjectCardPayload = Type.Object({
  name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX }),
  goal: Type.String({ minLength: 1, maxLength: PROJECT_GOAL_MAX }),
  projectId: Type.Optional(Type.String()),
});
export type SuggestProjectCardPayload = Static<typeof SuggestProjectCardPayload>;

// ───────────────────────── 请求 ─────────────────────────

/** 点"新建项目"：写想立个什么项目；不经"是不是项目"的判断，秘书直接收口出建议立项卡 */
export const NewProjectParams = Type.Object({ request: Type.String({ minLength: 1, maxLength: 4000 }) });
export type NewProjectParams = Static<typeof NewProjectParams>;

/** 点"新建项目"的结果：交给秘书的那条通知（同一幂等键重发拿到同一个结果） */
export const NewProjectResult = Type.Object({ messageId: Type.String() });
export type NewProjectResult = Static<typeof NewProjectResult>;

/**
 * 把一个未结束的任务转为项目：不新建维护者，原任务以"已完成 · 已转为项目"结束。
 * 项目名由用户定（界面预填任务标题，可以改）；和没删掉的项目重名时被拒，换个名字再转
 */
export const ConvertTaskParams = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX }),
});
export type ConvertTaskParams = Static<typeof ConvertTaskParams>;

export const ConvertTaskResult = Type.Object({ projectId: Type.String() });
export type ConvertTaskResult = Static<typeof ConvertTaskResult>;

/** 项目页上的动作（能不能做按 projects.ts 的 projectActions） */
export const ProjectActionParams = Type.Object({ projectId: Type.String({ minLength: 1 }), action: Type.Enum(PROJECT_ACTIONS) });
export type ProjectActionParams = Static<typeof ProjectActionParams>;

/** 动作之后项目的状态；删除时是待我处理里那条二次确认的事项 */
export const ProjectActionResult = Type.Object({ projectId: Type.String(), state: ProjectStateSchema, confirmItemId: Type.Optional(Type.String()) });
export type ProjectActionResult = Static<typeof ProjectActionResult>;

/** 重置维护者（16 号票，projects.ts 的 canResetMaintainer）：项目状态不变，维护者新开一段会话 */
export const ResetMaintainerParams = Type.Object({ projectId: Type.String({ minLength: 1 }) });
export type ResetMaintainerParams = Static<typeof ResetMaintainerParams>;

/** 新开的那一段会话 */
export const ResetMaintainerResult = Type.Object({ projectId: Type.String(), segmentId: Type.String() });
export type ResetMaintainerResult = Static<typeof ResetMaintainerResult>;
