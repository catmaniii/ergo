// @i18n-ignore-file model：这里的中文都是 schema 里给模型看的参数说明
// 项目、立项和它们的卡片的 schema（规格第 11 节，15 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型。
// - 项目列表频道上的 project 事件：项目的最新状态（Project）；
// - 立项书（Charter）：维护者在立项问答之后用"提交立项书"工具交出的结构化数据（工具的参数），立项书卡由代码从它生成；
// - 五种卡的负载：建议立项卡（suggest_project）、立项书卡（charter）、"首版做完了"卡（build_done，112 号票；130 号票起带着
//   维护者建设期间交的运营方案；259 号票起带着转运营检查清单）、"转入使用"确认卡（go_live，259 号票）、"立项要求变更"卡
//   （charter_change，125 号票）；"运营方案变更"卡在 operations-schema.ts；
// - 三个请求：点"新建项目"（new_project）、任务转为项目（convert_task_to_project）、项目页上的动作（project_action）。
// 名字（状态、类型、动作、变化）在 projects.ts。
import { type Static, Type } from "typebox";
import { OperationResult, OperationsPlanView, ProjectOperations } from "./operations-schema.ts";
import { STANDARD_CHECKLIST_ITEMS } from "./project-standard.ts";
import { BUILD_DONE_CHOICES, GO_LIVE_BY, GO_LIVE_CHOICES, PROJECT_ACTIONS, PROJECT_CHANGES, PROJECT_KINDS, PROJECT_ORIGINS, PROJECT_STATES } from "./projects.ts";
import { RuntimeOptions, RuntimeTakeover, WorkFolderChoice } from "./runtime-schema.ts";
import { PlanToolkit } from "./task-schema.ts";
import { TASK_ACTORS } from "./tasks.ts";
import { USER_WORDS_MAX, VerifiedUserWords } from "./user-words.ts";

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
  /**
   * 项目的维护者用的 agent 运行时（286 号票，runtimes.ts）：内核自带的 pi，或者插件登记的运行时的 id；没写时照转来的任务的（Task.runtime），
   * 再没有是 pi。登记它的插件停用时维护者不启动（活动状态"等你"，写明哪个插件没启用），启用后接着。289 号票起新建时选（点"新建项目"时选的
   * 写在建议立项卡上，点"立项"时定下），之后在维护者的 ⚙ 里换（手头这一条做完、原来的写好交接摘要才改成新的，记一条 runtime_set）
   */
  runtime: Type.Optional(Type.String({ minLength: 1 })),
  /** 给运行时选的值（289 号票，⚙ 里：运行时自己的模型、权限模式、思考档位……）；没有是都跟运行时自己的默认 */
  runtimeOptions: Type.Optional(RuntimeOptions),
  /**
   * 从运行时已有的会话接管来的（290 号票，RuntimeTakeover：哪个会话、交还了没有；也是二狗的写入锁）。接管来的项目工作目录是会话原来的
   * （workdir 是外部路径，删项目时不删），立项书确认时不改它。不是接管来的没有
   */
  takeover: Type.Optional(RuntimeTakeover),
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
  /**
   * 首个建设任务（开工时建出）；112 号票起它做完时出"首版做完了"卡，用户选继续建设时换成建出的下一轮建设任务
   * （它做完时再出一张）。项目的状态只在用户选了之后变
   */
  buildTaskId: Type.Optional(Type.String()),
  /** 归档前的状态（已归档时才有）：取消归档回到它 */
  archivedFrom: Type.Optional(ProjectStateSchema),
  /**
   * 现在生效的运营方案（130 号票）：用户在"首版做完了"卡上确认并转入使用、在"运营方案变更"卡上确认之后记上——每一条连同它生效成的
   * 项目内部任务、没生效的原因。还没确认过运营方案的没有
   */
  operations: Type.Optional(ProjectOperations),
  /**
   * 建档时用的项目规范模板版本（258 号票，PROJECT_STANDARD_LATEST）：立项时记上，之后不变（模板升级不自动带旧项目，261 号票只提示）。
   * 规范上线之前建的项目没有（262 号票出"补齐文档"的任务）
   */
  standardVersion: Type.Optional(Type.String()),
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
    operations: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2000,
        description: "运营方式（选填）：项目做完后打算怎么运转（比如每天定时出什么、盯着什么事件），写个大概。它不算授权：项目做完时交运营方案，用户确认那一次才算",
      }),
    ),
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

/** 立项要求变更里的一处（协议包 projects.ts 的 CharterChangeItem）：目标、首版写前后两句；范围写去掉的和加上的条目 */
export const CharterChangeItemSchema = Type.Union([
  Type.Object({ field: Type.Union([Type.Literal("goal"), Type.Literal("firstVersion")]), before: Type.String(), after: Type.String() }),
  Type.Object({ field: Type.Literal("scope"), removed: Type.Array(Type.String()), added: Type.Array(Type.String()) }),
]);

/**
 * "立项要求变更"卡（charter_change，125 号票）：立项书确认之后，用户在会话里说要改立项要求（目标、范围、首版），维护者用
 * propose_charter_change 提出——只交改动的几处，附上它引用、运行时核实过的用户原话。卡上逐条对照新旧，进待办，也出在用户说话的
 * 那个会话里；用户确认后改写立项书（末尾记一条变更记录：哪天、改了什么、依据的用户原话、用户确认），拒绝的立项书不变。
 * 项目类型、工作目录、工具包不走这条路（卡上写明）
 */
export const CharterChangeCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  /** 这个项目的第几次立项要求变更（提出的就算，被拒的也占号） */
  revision: Type.Integer({ minimum: 1 }),
  /** 维护者为什么要改（它的说法） */
  why: Type.String(),
  /** 逐条对照新旧 */
  changes: Type.Array(CharterChangeItemSchema),
  /** 改之前、改之后的整份立项书（项目类型、工作目录这几项原样） */
  before: Charter,
  after: Charter,
  /** 维护者引用、运行时核实过的用户原话（卡上单独一栏，标明"运行时核实"） */
  userWords: Type.Optional(Type.Array(VerifiedUserWords, { maxItems: USER_WORDS_MAX })),
  /** 处理之后：确认了没有、什么时候 */
  decided: Type.Optional(Type.Object({ confirmed: Type.Boolean(), at: Type.String() })),
});
export type CharterChangeCardPayload = Static<typeof CharterChangeCardPayload>;

/**
 * 转运营检查清单里的一项（259 号票，形状同 project-standard.ts 的 StandardChecklistItem）：卡上列出来，没做到的写差什么。
 * 卡上的是出卡（或刷新）那一刻算的；用户确认时运行时按那时的再算一遍，缺的写进决定里
 */
export const GoLiveChecklistItem = Type.Object({
  id: Type.Enum(STANDARD_CHECKLIST_ITEMS),
  label: Type.String(),
  done: Type.Boolean(),
  detail: Type.Optional(Type.String()),
});
export type GoLiveChecklistItem = Static<typeof GoLiveChecklistItem>;

/**
 * "首版做完了"卡（build_done，112 号票）：项目的建设任务做完了（首个建设任务，或者继续建设的下一轮），写明做成了什么——
 * 建设任务最后的总结、每个阶段的验收结果一行一个、交付件在哪；用户选转入使用、继续建设（附一句这一轮要做什么）或放弃并归档。
 * 不选就一直挂在待我处理里，项目停在建设中
 */
export const BuildDoneCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  buildTaskId: Type.String(),
  buildTaskTitle: Type.String(),
  /** 第几轮建设：1 是首版；继续建设之后的一轮加 1 */
  round: Type.Integer({ minimum: 1 }),
  /** 建设任务最后的总结：最后验收通过的那个阶段宣布完成时维护者写的那一两句；没写的没有 */
  summary: Type.Optional(Type.String()),
  /** 每个阶段一行：编号（"1a"）、名字、验收结果（"通过：脚本 1 条、评审 2 条"）、交付件 */
  stages: Type.Array(Type.Object({ code: Type.String(), title: Type.String(), result: Type.String(), deliverables: Type.Array(Type.String()) })),
  /** 交付件在哪：项目的工作目录 */
  workdir: Type.String(),
  /**
   * 维护者建设期间交的运营方案（130 号票，版本 2）：卡上多一节"转入使用后会开起来的"，主按钮换成"确认并转入使用"——项目进入使用中、
   * 方案里每一条生效。卡出了以后维护者再交，卡跟着更新（版本加 1，照旧的按钮按新的这份）。没交的没有，卡照 112 号票
   */
  operations: Type.Optional(OperationsPlanView),
  /**
   * 转运营检查清单（259 号票，版本 4）：出卡时算的建设中 → 使用中那一份（架构图、ops.json、服务、/apps/、进展），没做到的写差什么；
   * "转入使用"照样能点（缺的写进决定里）。维护者、秘书又提转入使用、运营方案又交了一份时刷新。旧卡没有
   */
  checklist: Type.Optional(Type.Array(GoLiveChecklistItem)),
  /** 清单是什么时候算的 */
  checkedAt: Type.Optional(Type.String()),
  /** 选了以后：选了哪个；继续建设时写的那句话和建出的下一轮建设任务；确认并转入使用时方案里每一条的结局、确认时清单里还缺的几项 */
  decided: Type.Optional(
    Type.Object({
      choice: Type.Enum(BUILD_DONE_CHOICES),
      request: Type.Optional(Type.String()),
      nextTaskId: Type.Optional(Type.String()),
      operations: Type.Optional(Type.Array(OperationResult)),
      missing: Type.Optional(Type.Array(GoLiveChecklistItem)),
    }),
  ),
});
export type BuildDoneCardPayload = Static<typeof BuildDoneCardPayload>;

/**
 * "转入使用"确认卡（go_live，259 号票；issue 19 第 8 条：转运营不管谁发起都必须用户确认）。用户在项目页点"转入使用"、维护者用
 * propose_go_live 提、秘书照用户说的代办，都只出这张卡（"首版做完了"卡还在等的就用那一张），用户在卡上确认才转：
 * - by：谁发起的；why：维护者、秘书写的为什么现在能转（用户自己点的没有）；
 * - checklist：建设中 → 使用中的检查清单（出卡、刷新时算的），没做到的照样能确认，确认时按那时的再算一遍、缺的写进决定；
 * - operations：维护者建设期间交的运营方案（同"首版做完了"卡：确认时一起生效；方案又交了一份时卡跟着更新）；
 * - decided：确认转入使用（方案里每一条的结局、确认时清单里还缺的几项）还是先不转
 */
export const GoLiveCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  by: Type.Enum(GO_LIVE_BY),
  why: Type.Optional(Type.String({ maxLength: 2000 })),
  checklist: Type.Array(GoLiveChecklistItem),
  checkedAt: Type.String(),
  operations: Type.Optional(OperationsPlanView),
  decided: Type.Optional(
    Type.Object({
      choice: Type.Enum(GO_LIVE_CHOICES),
      operations: Type.Optional(Type.Array(OperationResult)),
      missing: Type.Optional(Type.Array(GoLiveChecklistItem)),
    }),
  ),
});
export type GoLiveCardPayload = Static<typeof GoLiveCardPayload>;

/** "建议立项"卡：秘书收口，写名字和一句话目标；用户点"立项"后项目诞生（带上项目编号） */
export const SuggestProjectCardPayload = Type.Object({
  name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX }),
  goal: Type.String({ minLength: 1, maxLength: PROJECT_GOAL_MAX }),
  projectId: Type.Optional(Type.String()),
  /** 项目的维护者用的运行时（289 号票：用户点"新建项目"时选的，秘书照写；没写是 pi）；点"立项"时定进项目 */
  runtime: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /**
   * 在哪个文件夹做（305 号票：用户点"新建项目"时选的、秘书照写；能选工作文件夹的运行时才认）：点"立项"时定下项目的工作目录
   * （在外面，删项目不删它，立项书确认时不改）；没写是在默认文件夹下按项目名新开一个（没设默认文件夹的照旧在项目档案里）
   */
  folder: Type.Optional(WorkFolderChoice),
});
export type SuggestProjectCardPayload = Static<typeof SuggestProjectCardPayload>;

// ───────────────────────── 请求 ─────────────────────────

/** 点"新建项目"：写想立个什么项目；不经"是不是项目"的判断，秘书直接收口出建议立项卡 */
export const NewProjectParams = Type.Object({
  request: Type.String({ minLength: 1, maxLength: 4000 }),
  /** 项目的维护者用的运行时（289 号票：pi 或者现在能用的运行时插件登记的）：不写是 pi；不认得、插件没启用的被拒。秘书照写在建议立项卡上 */
  runtime: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /** 在哪个文件夹做（305 号票，同 StartTaskParams.folder）：用已有文件夹的这时就核对路径；秘书照写在建议立项卡上 */
  folder: Type.Optional(WorkFolderChoice),
});
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

/** 动作之后项目的状态；删除时是待我处理里那条二次确认的事项；转入使用（259 号票）时是要用户确认的那张卡（go_live 或"首版做完了"卡） */
export const ProjectActionResult = Type.Object({
  projectId: Type.String(),
  state: ProjectStateSchema,
  confirmItemId: Type.Optional(Type.String()),
  confirmCardId: Type.Optional(Type.String()),
});
export type ProjectActionResult = Static<typeof ProjectActionResult>;

/** 重置维护者（16 号票，projects.ts 的 canResetMaintainer）：项目状态不变，维护者新开一段会话 */
export const ResetMaintainerParams = Type.Object({ projectId: Type.String({ minLength: 1 }) });
export type ResetMaintainerParams = Static<typeof ResetMaintainerParams>;

/** 新开的那一段会话 */
export const ResetMaintainerResult = Type.Object({ projectId: Type.String(), segmentId: Type.String() });
export type ResetMaintainerResult = Static<typeof ResetMaintainerResult>;
