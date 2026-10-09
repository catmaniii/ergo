// 任务、计划和它们的卡片的 schema（规格第 8 节），用 TypeBox 定义，守护进程和 Web 共用生成的类型。
// - 任务看板频道上的 task 事件：任务的最新状态（Task）；
// - 计划（Plan）：维护者用"提交计划"工具交出的结构化数据（工具的参数就是这个 schema），存在二狗自己的存储里；
//   计划卡由代码从它生成；
// - 任务书（TaskBrief）：秘书写给执行的维护者的一页说明；
// - 三种卡的负载和动作输入：计划卡（plan）、提问卡（questions）、"建议发起任务"卡（suggest_task）；
// - 发起任务的请求（start_task）。
// 名字（状态、分组、枚举）在 tasks.ts，计划的纯函数（授权项列表、生成的文字、停点）在 plan.ts。
import { type Static, Type } from "typebox";
import { DISPOSITIONS } from "./constants.ts";
import { ProjectInternal } from "./schema.ts";
import { ReminderSchedule } from "./reminder-schedule.ts";
import {
  ACCEPTANCE_METHODS,
  PLAN_ID_PATTERN,
  PROGRESS_CARD_KINDS,
  STAGE_MODES,
  STAGE_STATES,
  TASK_ACTIONS,
  TASK_ACTORS,
  TASK_CHANGES,
  TASK_END_KINDS,
  TASK_KINDS,
  TASK_ORIGINS,
  TASK_PAUSE_REASONS,
  TASK_PROJECT_SCOPES,
  TASK_STATES,
  TASK_WAIT_REASONS,
} from "./tasks.ts";
import { WATCH_CATEGORY_TITLE_MAX } from "./watch-categories.ts";
import { WORKFLOW_STEP_STATES } from "./workflow.ts";
import { WatchCategoryMatch } from "./watch-category-schema.ts";

const Id = (description: string) => Type.String({ pattern: PLAN_ID_PATTERN, description });
const Text = (description: string) => Type.String({ minLength: 1, description });
const Texts = (description: string, minItems = 0) => Type.Array(Type.String({ minLength: 1 }), { minItems, description });

// ───────────────────────── 任务 ─────────────────────────

const TaskStateSchema = Type.Enum(TASK_STATES);
const WaitReasonSchema = Type.Enum(TASK_WAIT_REASONS);

/** 一条验收标准在执行时的样子：标准本身、方式，验收过了就带上结果 */
export const TaskStageAcceptance = Type.Object({
  criterion: Type.String(),
  method: Type.Enum(ACCEPTANCE_METHODS),
  /** 最近一次验收的结果（重开阶段时清掉） */
  result: Type.Optional(Type.Object({ passed: Type.Boolean(), note: Type.Optional(Type.String()), at: Type.String() })),
});
export type TaskStageAcceptance = Static<typeof TaskStageAcceptance>;

/** 执行中一个阶段的状态（13 号票）：控制器保管，阶段抽屉和看板的"第 N/M 阶段"取自这里 */
export const TaskStage = Type.Object({
  stageId: Type.String(),
  title: Type.String(),
  state: Type.Enum(STAGE_STATES),
  /** 前置阶段：都验收了才能开始 */
  dependsOn: Type.Array(Type.String()),
  /** 这一支在等用户的原因（state 为 waiting 时） */
  waitReason: Type.Optional(WaitReasonSchema),
  /** 在等的是什么：审批 id、待我处理事项 id（这一支停在哪儿，用户处理了它就接着走） */
  waitingOn: Type.Optional(Type.String()),
  acceptance: Type.Array(TaskStageAcceptance),
  /** 维护者宣布完成过几次（验收退回后再宣布算一次） */
  attempts: Type.Integer({ minimum: 0 }),
  /** 第一次开始的时间：做到一半停下（等过用户、换去做别的阶段）的阶段，能开始时优先接着做 */
  startedAt: Type.Optional(Type.String()),
  /**
   * 阈值的计数（14 号票）：被拉回（按规则退回）几次、验收（脚本、评审）退回几次、同一次停滞里催了几次。
   * 超过阈值这一支停下找用户（卡住求助）；用户让它接着走时清零，催促有了进展也清零。没有就是 0
   */
  pullBacks: Type.Optional(Type.Integer({ minimum: 0 })),
  returns: Type.Optional(Type.Integer({ minimum: 0 })),
  nudges: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 这一支为什么停下等用户（14 号票：阈值写明超了什么、做不了的原因、超预算用了多少；state 为 waiting 时） */
  waitNote: Type.Optional(Type.String()),
});
export type TaskStage = Static<typeof TaskStage>;

/** 流程执行时一步的状态（58 号票）：维护者用 report_step 自报，任务看板上的 Task.steps.list */
export const TaskStep = Type.Object({
  stepId: Type.String(),
  title: Type.String(),
  state: Type.Enum(WORKFLOW_STEP_STATES),
  /** 做完时的一句话要点、跳过或失败的原因 */
  gist: Type.Optional(Type.String()),
  /**
   * 状态是推断出来的，不是维护者报的（59 号票，照 AgentSense sessionView 的 inferred）：开始了下一步、上一步还报着在做的，
   * 算做完；一轮收工时（计划里的步骤都执行过或说明跳过了），还报着在做的、执行过却没报的，算做完
   */
  inferred: Type.Optional(Type.Literal(true)),
});
export type TaskStep = Static<typeof TaskStep>;

/** 任务看板上的一个任务（task 事件里是它的最新状态） */
export const Task = Type.Object({
  /** 任务编号：t-1、t-2……（短，秘书好引用） */
  id: Type.String(),
  title: Type.String(),
  /** 一句话说明：用户点按钮时写的，或者秘书按用户的要求概括的 */
  summary: Type.String(),
  state: TaskStateSchema,
  origin: Type.Enum(TASK_ORIGINS),
  /**
   * 任务的种类（58 号票，ADR 0019）：流程或长程任务，建卡时定下、不能换。两种分开之前建的任务没有这一项，
   * 都算长程任务（用 taskKind 取）
   */
  kind: Type.Optional(Type.Enum(TASK_KINDS)),
  /** 执行的维护者（12 号票：任务自己的维护者，建卡时产生）；它的会话频道是 maintainer:<维护者 id> */
  maintainerId: Type.String(),
  /** 涉及的项目：用户点"发起任务"时选的，有了计划后取自计划 */
  projects: Type.Array(Type.String()),
  /** 涉及的项目的编号（15 号票起：项目名按当时的项目列表认出来的；项目列表按它数进行中的任务） */
  projectIds: Type.Optional(Type.Array(Type.String())),
  /**
   * 涉及几个项目（17 号票）：建卡时定下（建卡时没写项目的，第一版任务书定下），之后不随计划改动重新判断。
   * 17 号票之前建的任务没有，按 taskProjectScope 推
   */
  projectScope: Type.Optional(Type.Enum(TASK_PROJECT_SCOPES)),
  /**
   * 项目内部任务（64 号票）：项目的维护者在自己项目里发起（或秘书替用户在这个项目里建）、由它执行的（单项目任务，projectIds 就是这个项目），
   * 只在项目内部看得到——不上全局任务看板，在项目页的"内部任务"一栏（见 project-internal.ts 的 isProjectInternal）。建卡时定下，不能换
   */
  internal: Type.Optional(ProjectInternal),
  /**
   * 阶段：total 取自计划（还没有计划时没有这一项）；current 是正在第几阶段（按计划里的顺序，开始执行后才有，13 号票）；
   * list 是执行中各阶段的状态（开始执行后才有，13 号票）；focus 是维护者最后一次开始的阶段（它 start_stage 的、运行时替它开始的；
   * 用户同意并行时交给子 agent 的不算，20 号票）：几个阶段同时在做时，维护者的当前阶段按它定
   */
  stages: Type.Optional(
    Type.Object({
      total: Type.Integer({ minimum: 1 }),
      current: Type.Optional(Type.Integer({ minimum: 1 })),
      list: Type.Optional(Type.Array(TaskStage)),
      focus: Type.Optional(Type.String()),
    }),
  ),
  /**
   * 流程的步骤（58 号票）：total 取自提交的计划（还没有计划时没有这一项），done 是做完（含跳过）的步数；
   * list 是执行中各步的状态（开始执行后才有）。流程的进度是 done / total
   */
  steps: Type.Optional(
    Type.Object({
      total: Type.Integer({ minimum: 1 }),
      done: Type.Integer({ minimum: 0 }),
      list: Type.Optional(Type.Array(TaskStep)),
    }),
  ),
  /** 最新一张计划卡（提交过计划才有） */
  planCardId: Type.Optional(Type.String()),
  /** 已完成的任务是怎么结束的（不写是做完了）：转为项目显示成"已完成 · 已转为项目" */
  endKind: Type.Optional(Type.Enum(TASK_END_KINDS)),
  /** 等我的原因（状态是等我时；任务卡、待我处理上写明） */
  waitReason: Type.Optional(WaitReasonSchema),
  /** 等我的补充说明：卡住求助时维护者写的原因 */
  waitNote: Type.Optional(Type.String()),
  /** 失败的原因（维护者判失败时必须写） */
  failReason: Type.Optional(Type.String()),
  /** 系统暂停的原因（14 号票：累计被拒太多次）；用户继续时清掉 */
  pauseReason: Type.Optional(Type.Enum(TASK_PAUSE_REASONS)),
  /** 累计被用户拒绝了几次（审批、计划变更，14 号票）；满了任务转已暂停，用户继续时清零 */
  rejections: Type.Optional(Type.Integer({ minimum: 0 })),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type Task = Static<typeof Task>;

/** `task` 事件（任务看板频道）：任务的最新状态，这次是什么变化、从哪个状态来（建出时为 null）、谁改的 */
export const TaskEventPayload = Type.Object({
  task: Task,
  change: Type.Enum(TASK_CHANGES),
  from: Type.Union([TaskStateSchema, Type.Null()]),
  by: Type.Enum(TASK_ACTORS),
  /** 这次变化说的是哪个阶段（阶段的开始、验收、等用户、返工……） */
  stageId: Type.Optional(Type.String()),
});
export type TaskEventPayload = Static<typeof TaskEventPayload>;

/**
 * 用户对任务的控制（task_action，13 号票）：暂停、继续、取消、失败后重试、返工（stageId 是要重开的阶段，连同它的下游）、
 * 由我验收的阶段验收通过或退回（stageId 是那个阶段）。note 是用户附的话（返工、退回的原因），交给维护者
 */
export const TaskActionParams = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  action: Type.Enum(TASK_ACTIONS),
  stageId: Type.Optional(Type.String({ minLength: 1 })),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type TaskActionParams = Static<typeof TaskActionParams>;

/** 控制之后任务的状态（同一幂等键重发拿到同一个结果） */
export const TaskActionResult = Type.Object({ taskId: Type.String(), state: TaskStateSchema });
export type TaskActionResult = Static<typeof TaskActionResult>;

/**
 * 进度卡（progress，13 号票）：任务时间线上的一张卡，出现在维护者的会话里。
 * - progress：维护者"报告进展"，写所属任务、第 N/M 阶段、进展说明；
 * - acceptance：一个阶段的验收结论（每条标准的方式和结果），judgedBy 是谁判的（评审方式的标"评审判定"）
 */
export const ProgressCardPayload = Type.Object({
  taskId: Type.String(),
  taskTitle: Type.String(),
  stageId: Type.String(),
  stageTitle: Type.String(),
  /** 第 N/M 阶段：N 按计划里的顺序 */
  stageIndex: Type.Integer({ minimum: 1 }),
  stageTotal: Type.Integer({ minimum: 1 }),
  kind: Type.Enum(PROGRESS_CARD_KINDS),
  text: Type.String(),
  acceptance: Type.Optional(
    Type.Object({
      passed: Type.Boolean(),
      judgedBy: Type.Enum(ACCEPTANCE_METHODS),
      results: Type.Array(Type.Object({ criterion: Type.String(), method: Type.Enum(ACCEPTANCE_METHODS), passed: Type.Boolean(), note: Type.Optional(Type.String()) })),
    }),
  ),
});
export type ProgressCardPayload = Static<typeof ProgressCardPayload>;

/**
 * 点"发起任务"按钮：写要做什么（第一行当标题），可以选涉及的项目（多选，从项目列表里选；不选是不涉及项目）。
 * 用户写的原话记成"用户发言"素材；选的项目写进任务，秘书写任务书时以它为依据
 */
export const StartTaskParams = Type.Object({
  request: Type.String({ minLength: 1, maxLength: 4000 }),
  projects: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 })),
  /** 发起对话框里先选的种类（58 号票）：流程或长程任务；不写是长程任务 */
  kind: Type.Optional(Type.Enum(TASK_KINDS)),
});
export type StartTaskParams = Static<typeof StartTaskParams>;

/** 发起任务的结果：建出的任务编号（同一幂等键重发拿到同一个结果） */
export const StartTaskResult = Type.Object({ taskId: Type.String() });
export type StartTaskResult = Static<typeof StartTaskResult>;

// ───────────────────────── 计划 ─────────────────────────

/** 任务书（规格第 7 节）：秘书在意图澄清之后写给执行的维护者的一页说明 */
export const TaskBrief = Type.Object(
  {
    goal: Type.String({ minLength: 1, maxLength: 2000, description: "目标" }),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "验收标准：做到什么样算完成" }),
    constraints: Type.Array(Type.String({ minLength: 1 }), { description: "约束（用户说过的限制、不能做的事），尽量用用户的原话：维护者据此编译成规则，计划卡上和原话一起列出" }),
    projects: Type.Array(Type.String({ minLength: 1 }), { description: "涉及的项目（不涉及就写空数组；用户发起时选了项目的，以它为依据）" }),
    memoryScope: Type.String({ maxLength: 500, description: "记忆范围提议：执行时可能要用到哪些关于用户的记忆（第一阶段只占位）" }),
  },
  { additionalProperties: false },
);
export type TaskBrief = Static<typeof TaskBrief>;

/** 时序规则（planguard 格式：id、title、trigger、require、when、unless、message、on_violation……），存计划时校验 */
export const PlanTemporalRule = Type.Unsafe<{ id: string; title?: string } & Record<string, unknown>>(
  Type.Object(
    { id: Text("规则 id（不能以 v1. 开头）"), title: Type.Optional(Type.String()) },
    { additionalProperties: true, description: "时序规则（planguard 格式），比如 { id, title, trigger: { tool }, require: { before: { tool } }, on_violation }" },
  ),
);
export type PlanTemporalRule = Static<typeof PlanTemporalRule>;

/** 授权项：操作种类（工具名）+ 对象范围 + 次数；所属阶段是它挂在哪个阶段（或阶段组）上，有效期默认 7 天 */
export const PlanGrant = Type.Object(
  {
    id: Id("授权项 id，整份计划里唯一"),
    tool: Text("操作种类：工具名（带类型的工具和 bash 拆出的伪工具同名，比如 git_push、web_fetch）"),
    title: Text("给用户看的一句话：做什么、对谁，比如“推送到 origin 的 main 分支”"),
    scope: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })]), {
      description: "对象范围：参数名 → 允许的值（路径类参数按“在这个目录之内”）；空对象表示不限对象",
    }),
    maxUses: Type.Optional(Type.Integer({ minimum: 1, description: "次数上限；不写表示不限次数" })),
    command: Type.Optional(
      Type.String({ minLength: 1, description: "只放行从这条通用 bash 命令拆出来的调用（流程里通用 bash 的步骤由运行时推出，58 号票）；不写表示不限" }),
    ),
    exactArgs: Type.Optional(Type.Literal(true, { description: "只认对象范围里写了的参数：调用多带了别的参数就超出（流程的步骤由运行时推出，58 号票）" })),
    realScope: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })]), {
        description: "路径类参数的真实路径（展开符号链接、目录联接）：调用里的路径的真实路径也要落在它里面，取不到的不放行（流程的步骤由运行时推出，58 号票）",
      }),
    ),
    validDays: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 365, description: "有效期（天）；不写是 7 天" })),
  },
  { additionalProperties: false },
);
export type PlanGrant = Static<typeof PlanGrant>;

export const AcceptanceCriterion = Type.Object(
  {
    criterion: Text("验收标准"),
    method: Type.Enum(ACCEPTANCE_METHODS, { description: "验收方式：script 脚本（附 script）、review 独立评审、user 由用户验收" }),
    script: Type.Optional(Text("method 为 script 时：在工作目录里运行的命令，退出码 0 算通过")),
    expectOutput: Type.Optional(
      Type.Object(
        {
          contains: Type.Optional(Text("输出（标准输出和标准错误合在一起）里要有这段文字")),
          matches: Type.Optional(Text("输出要匹配这个正则表达式（JavaScript 写法，不带两边的斜杠）")),
        },
        { additionalProperties: false, minProperties: 1, description: "method 为 script 时可选：期望的输出，和退出码一起判定；不写只看退出码" },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AcceptanceCriterion = Static<typeof AcceptanceCriterion>;

/**
 * 策略（术语表）：时序规则加授权项。挂在单个阶段上，或者定义一次、套给整个阶段组；
 * 检查（守护进程 tasks/plan.ts）和交给守卫时的展开都按它走
 */
export const PlanPolicy = Type.Object(
  {
    grants: Type.Array(PlanGrant, { description: "授权项（只对“计划里列了才做”那一档有效；“先问我”类的操作列进来执行时也照样问）" }),
    temporalRules: Type.Array(PlanTemporalRule, { description: "执行期间检查的时序规则" }),
  },
  { additionalProperties: false, description: "策略：授权项和时序规则" },
);
export type PlanPolicy = Static<typeof PlanPolicy>;

export const PlanStage = Type.Object(
  {
    stageId: Id("阶段 id，比如 s1"),
    title: Text("阶段名"),
    deliverables: Texts("交付件", 1),
    acceptance: Type.Array(AcceptanceCriterion, { minItems: 1, description: "验收标准，每条写明方式" }),
    mode: Type.Enum(STAGE_MODES, { description: "steps 定步（附 steps）、open 开放" }),
    steps: Type.Optional(Texts("mode 为 steps 时的步骤", 1)),
    dependsOn: Type.Array(Type.String(), { description: "前置阶段的 id（它们验收通过后才开始）" }),
    policy: PlanPolicy,
    budget: Type.Object(
      { tokens: Type.Integer({ minimum: 0 }), toolCalls: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false, description: "预算：token 和工具调用次数" },
    ),
    groupId: Type.Optional(Type.String({ description: "所属阶段组的 id" })),
  },
  { additionalProperties: false },
);
export type PlanStage = Static<typeof PlanStage>;

export const PlanStageGroup = Type.Object(
  {
    groupId: Id("阶段组 id，比如 g1"),
    title: Text("阶段组名"),
    policy: PlanPolicy,
  },
  { additionalProperties: false },
);
export type PlanStageGroup = Static<typeof PlanStageGroup>;

export const PlanToolkit = Type.Object(
  {
    skills: Type.Array(Type.String(), { description: "skill 名单" }),
    mcp: Type.Array(Type.String(), { description: "MCP 名单" }),
    bash: Type.Boolean({ description: "能不能用 bash" }),
    network: Type.Boolean({ description: "能不能联网" }),
  },
  { additionalProperties: false, description: "工具包" },
);
export type PlanToolkit = Static<typeof PlanToolkit>;

/**
 * 涉及的一个项目和它的改动（确认后变成工单，16、17 号票）。涉及多个项目的任务（17 号票）每一行写明所属阶段和这张工单自己的验收标准：
 * 用户确认计划时每一行建成一张发往这个项目的工单，所属阶段开始时才派出；同一阶段同一项目只写一行
 */
export const PlanProject = Type.Object(
  {
    project: Text("项目名"),
    changes: Texts("要改的地方", 1),
    stageId: Type.Optional(Type.String({ pattern: PLAN_ID_PATTERN, description: "涉及多个项目的任务必填：这一行属于哪个阶段（这个阶段开始时派出工单）" })),
    acceptance: Type.Optional(Texts("涉及多个项目的任务必填：这张工单自己的验收标准（项目维护者照它做，交回执时对照）", 1)),
  },
  { additionalProperties: false },
);
export type PlanProject = Static<typeof PlanProject>;

/**
 * 本任务要提醒的一个关注类别。默认取全局（任务书里列着全局的类别），只能在其上增加：
 * 全局的每一个都要在，处置只能比全局严；本任务新加的类别写 match 和 disposition
 */
export const PlanWatchCategory = Type.Object(
  {
    id: Text("类别 id"),
    title: Type.Optional(Type.String({ description: "名字；全局类别不用写" })),
    disposition: Type.Optional(Type.Enum(DISPOSITIONS, { description: "本任务里的处置：只能比全局严；新加的类别必须写" })),
    match: Type.Optional(WatchCategoryMatch),
  },
  { additionalProperties: false },
);
export type PlanWatchCategory = Static<typeof PlanWatchCategory>;

/** 收窄一项授权：次数改少、对象范围里去掉一些值（只能收窄，放宽的被拒） */
export const GrantNarrowing = Type.Object(
  {
    grantId: Type.String(),
    maxUses: Type.Optional(Type.Integer({ minimum: 1 })),
    scope: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String(), { minItems: 1 }))),
  },
  { additionalProperties: false },
);
export type GrantNarrowing = Static<typeof GrantNarrowing>;

/**
 * 用户说过的一条限制（对话里说的、任务书约束里写的），由起草计划的维护者编译成时序规则或授权收窄（26 号票）：
 * 每条附上用户的原话；规则在整个任务执行期间都检查（交给守卫时加到每个阶段上），先过规则校验；
 * 收窄对计划里的授权项再收窄（只能收窄），提交时就落到授权项上。计划卡上把它们和原话一起列出
 */
export const PlanUserLimit = Type.Object(
  {
    id: Id("限制 id，比如 l1"),
    quote: Type.String({ minLength: 1, maxLength: 1000, description: "用户的原话：对话里说的、任务书约束里写的那句，原样抄" }),
    temporalRules: Type.Array(PlanTemporalRule, { description: "由这句话编译出的时序规则（整个任务执行期间都检查；违反时怎么办写 on_violation，不写是先问用户）；没有就写空数组" }),
    grantNarrowings: Type.Array(GrantNarrowing, { description: "由这句话编译出的授权收窄：对上面某个授权项次数改少、对象范围只留一部分值（只能收窄）；没有就写空数组" }),
  },
  { additionalProperties: false },
);
export type PlanUserLimit = Static<typeof PlanUserLimit>;

/**
 * 定时作业的定义（可选）：确认计划后作业登记、进入运营中（19 号票）。每次运行要的授权项和时序规则写在 policy 里，
 * 随计划卡一起确认；作业在就一直有效（不按 7 天续期，有效期不写），暂停、取消作业即收回。计划里用户的限制也管每次运行
 */
export const PlanScheduledJob = Type.Object(
  {
    title: Text("作业名"),
    schedule: ReminderSchedule,
    each: Text("每次要做的事"),
    project: Type.Optional(Text("属于哪个项目；不属于项目就不写")),
    policy: Type.Optional(
      Type.Object(
        {
          grants: Type.Array(PlanGrant, { description: "每次运行要的授权项（授权项 id 和阶段的一起在整份计划里唯一；作业在就一直有效，不写有效期）" }),
          temporalRules: Type.Array(PlanTemporalRule, { description: "每次运行都检查的时序规则（规则 id 在整份计划里唯一）" }),
        },
        { additionalProperties: false, description: "每次运行的策略：授权项和时序规则；不需要授权的作业不写" },
      ),
    ),
  },
  { additionalProperties: false },
);
export type PlanScheduledJob = Static<typeof PlanScheduledJob>;

/** 计划（规格第 8 节）：维护者起草、用"提交计划"工具交出，存在二狗的存储里；计划卡由代码从它生成 */
export const Plan = Type.Object(
  {
    stages: Type.Array(PlanStage, { minItems: 1, description: "阶段列表" }),
    stageGroups: Type.Array(PlanStageGroup, { description: "阶段组（没有就写空数组）" }),
    toolkit: PlanToolkit,
    projects: Type.Array(PlanProject, { description: "涉及的项目和每个项目的改动（不涉及项目就写空数组）" }),
    memoryScope: Type.Optional(Type.String({ description: "记忆范围（第一阶段只占位，写了也不生效）" })),
    watchCategories: Type.Array(PlanWatchCategory, { minItems: 1, description: "本任务要提醒的关注类别：全局的一个都不能少，只能加" }),
    userLimits: Type.Optional(
      Type.Array(PlanUserLimit, {
        description: "用户说过的限制（任务书的约束、对话里说的），每条编译成时序规则或授权收窄并附上原话；编译不了的写进假设栏。没有就不写",
      }),
    ),
    scheduledJobs: Type.Array(PlanScheduledJob, { description: "定时作业定义（没有就写空数组）" }),
    assumptions: Texts("假设栏：计划基于哪些假设"),
    stops: Type.Object(
      {
        count: Type.Integer({ minimum: 0, description: "授权后还会在几处停下来问用户（“先问我”类的操作即使列进授权项也照样问，要算进去）" }),
        where: Texts("每一处是什么"),
      },
      { additionalProperties: false },
    ),
    tokenEstimate: Type.Integer({ minimum: 0, description: "整个任务的 token 粗估" }),
  },
  { additionalProperties: false },
);
export type Plan = Static<typeof Plan>;

/**
 * 一项授权在守卫眼里的样子（守护进程按工具注册表和关注类别设置算，卡上的文字和停点由它生成）：
 * 工具的中文名、落在哪些关注类别（显示用的名字）、任务里这些类别最严的处置。
 * 处置是"先问我""交给我做""永不"的，这项授权不算授权：执行时照样停下（或者不做）
 */
export const GrantInfo = Type.Object({
  toolTitle: Type.String(),
  categoryTitles: Type.Array(Type.String()),
  disposition: Type.Enum(DISPOSITIONS),
});
export type GrantInfo = Static<typeof GrantInfo>;

/** 计划卡的负载：任务、任务书里的目标、计划本身（授权项被勾掉、收窄后就是确认的那份），全局的关注类别 */
export const PlanCardPayload = Type.Object({
  taskId: Type.String(),
  taskTitle: Type.String(),
  /** 第几版计划（打回后重新提交的版本号加 1） */
  revision: Type.Integer({ minimum: 1 }),
  planId: Type.String(),
  /** 任务书里的目标 */
  goal: Type.String(),
  plan: Plan,
  /** 全局的关注类别 id（卡上删不掉的那些） */
  globalCategories: Type.Array(Type.String()),
  /** 每项授权（授权项 id → GrantInfo） */
  grantInfo: Type.Record(Type.String(), GrantInfo),
  /** 用户确认时勾掉的授权项（原样；确认后的计划里已经没有它们了） */
  removedGrants: Type.Optional(Type.Array(PlanGrant)),
  /** 用户确认时收窄了的授权项 id */
  narrowedGrants: Type.Optional(Type.Array(Type.String())),
  /** 用户确认时改过假设栏 */
  assumptionsEdited: Type.Optional(Type.Boolean()),
  /** 用户确认时在卡上给这个任务加的关注类别 id（在 plan.watchCategories 里；26 号票） */
  addedCategories: Type.Optional(Type.Array(Type.String())),
  /**
   * 用户的限制里核对得上原话的（限制 id）：quote 原样出现在任务书的约束、用户发起任务时写的话或用户在这个任务的会话里的消息里。
   * 不在这里的，卡上显示成"维护者转述"（26 号票）
   */
  verifiedQuotes: Type.Optional(Type.Array(Type.String())),
});
export type PlanCardPayload = Static<typeof PlanCardPayload>;

/** 计划卡上给这个任务加的一个关注类别：和设置页同一套确定规则，只存在这个任务的计划里（26 号票） */
export const PlanCategoryAddition = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: WATCH_CATEGORY_TITLE_MAX }),
    match: WatchCategoryMatch,
    disposition: Type.Enum(DISPOSITIONS),
  },
  { additionalProperties: false },
);
export type PlanCategoryAddition = Static<typeof PlanCategoryAddition>;

/** 计划卡上"确认"的输入：勾掉的授权项、收窄的授权项、改过的假设栏（整栏）、加的关注类别（都不给就是原样确认） */
export const PlanConfirmInput = Type.Object(
  {
    removeGrants: Type.Optional(Type.Array(Type.String())),
    narrowGrants: Type.Optional(Type.Array(GrantNarrowing)),
    addWatchCategories: Type.Optional(Type.Array(PlanCategoryAddition, { maxItems: 20 })),
    assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 50 })),
  },
  { additionalProperties: false },
);
export type PlanConfirmInput = Static<typeof PlanConfirmInput>;

// ───────────────────────── 计划变更（14 号票） ─────────────────────────

/**
 * 维护者在执行中交来的计划（"提交计划变更"和"自行调整计划"两个工具的参数）：本任务的关注类别、用户的限制、定时作业、记忆范围
 * 执行中沿用当前计划，不在里面
 */
export const PlanDraft = Type.Omit(Plan, ["watchCategories", "userLimits", "scheduledJobs", "memoryScope"]);
export type PlanDraft = Static<typeof PlanDraft>;

/** 计划变更里的一处改动挂在哪儿：一个阶段，或一个阶段组（套给组里各阶段） */
export const PlanChangeOwner = Type.Object({ kind: Type.Union([Type.Literal("stage"), Type.Literal("group")]), id: Type.String(), title: Type.String() });
// （定时作业的策略不进计划变更：计划变更、自行调整沿用当前计划里的作业定义，见 PlanDraft）
export type PlanChangeOwner = Static<typeof PlanChangeOwner>;

const PlanBudget = Type.Object({ tokens: Type.Integer({ minimum: 0 }), toolCalls: Type.Integer({ minimum: 0 }) });
const Expands = Type.Boolean({ description: "这一处扩大了授权，或者改了目标、验收（要用户确认）" });
const StageRef = { stageId: Type.String(), title: Type.String() };

/**
 * 计划变更里的一处改动（相对当前计划新增或改动的部分；卡上的文字由协议包 plan.ts 的 planChangeItemText 生成）。
 * expands：扩大授权（新增授权项、放宽对象范围或次数、延长有效期、换阶段、加工具包能力）、加项目、改目标或任务的验收标准、改阶段的验收或交付件、
 * 加预算、删改时序规则——要用户在计划变更卡上确认；其余（拆阶段、调顺序、改步骤、收窄或去掉授权项、加规则）维护者自行调整计划
 */
export const PlanChangeItem = Type.Union([
  Type.Object({ kind: Type.Literal("grant_added"), expands: Expands, owner: PlanChangeOwner, grant: PlanGrant }),
  Type.Object({ kind: Type.Literal("grant_widened"), expands: Expands, owner: PlanChangeOwner, before: PlanGrant, after: PlanGrant }),
  Type.Object({ kind: Type.Literal("grant_narrowed"), expands: Expands, owner: PlanChangeOwner, before: PlanGrant, after: PlanGrant }),
  Type.Object({ kind: Type.Literal("grant_moved"), expands: Expands, from: PlanChangeOwner, to: PlanChangeOwner, grant: PlanGrant }),
  Type.Object({ kind: Type.Literal("grant_removed"), expands: Expands, owner: PlanChangeOwner, grant: PlanGrant }),
  Type.Object({ kind: Type.Literal("toolkit"), expands: Expands, before: PlanToolkit, after: PlanToolkit }),
  Type.Object({ kind: Type.Literal("projects"), expands: Expands, before: Type.Array(PlanProject), after: Type.Array(PlanProject) }),
  Type.Object({ kind: Type.Literal("goal"), expands: Expands, before: Type.String(), after: Type.String() }),
  /** 改任务书里的验收标准（任务这一级的，不是哪个阶段的） */
  Type.Object({ kind: Type.Literal("criteria"), expands: Expands, before: Type.Array(Type.String()), after: Type.Array(Type.String()) }),
  Type.Object({
    kind: Type.Literal("acceptance"),
    expands: Expands,
    added: Type.Array(Type.Object({ stageId: Type.String(), criterion: AcceptanceCriterion })),
    removed: Type.Array(Type.Object({ stageId: Type.String(), criterion: AcceptanceCriterion })),
  }),
  Type.Object({
    kind: Type.Literal("deliverables"),
    expands: Expands,
    added: Type.Array(Type.Object({ stageId: Type.String(), text: Type.String() })),
    removed: Type.Array(Type.Object({ stageId: Type.String(), text: Type.String() })),
  }),
  Type.Object({
    kind: Type.Literal("budget"),
    expands: Expands,
    before: PlanBudget,
    after: PlanBudget,
    stages: Type.Array(Type.Object({ ...StageRef, before: Type.Optional(PlanBudget), after: Type.Optional(PlanBudget) })),
  }),
  Type.Object({ kind: Type.Literal("rules"), expands: Expands, owner: PlanChangeOwner, removed: Type.Array(PlanTemporalRule), added: Type.Array(PlanTemporalRule) }),
  Type.Object({ kind: Type.Literal("stage_added"), expands: Expands, ...StageRef }),
  Type.Object({ kind: Type.Literal("stage_removed"), expands: Expands, ...StageRef }),
  Type.Object({ kind: Type.Literal("stage_order"), expands: Expands, before: Type.Array(Type.String()), after: Type.Array(Type.String()) }),
  Type.Object({
    kind: Type.Literal("stage_changed"),
    expands: Expands,
    ...StageRef,
    /** 改了哪些：名字、步骤、前置阶段、所属阶段组 */
    fields: Type.Array(Type.String()),
    group: Type.Optional(Type.Object({ before: Type.Optional(Type.String()), after: Type.Optional(Type.String()) })),
  }),
  /** 守卫眼里这些阶段多了授权（进了有授权项的阶段组） */
  Type.Object({ kind: Type.Literal("stage_grants"), expands: Expands, stageIds: Type.Array(Type.String()) }),
]);
export type PlanChangeItem = Static<typeof PlanChangeItem>;

/**
 * 计划变更卡（plan_change，14 号票）：维护者执行中要扩大授权、加能力、加项目、改目标或验收时提交，进待我处理。
 * 卡上只列相对当前计划新增或改动的部分（changes），只有受影响的阶段（affectedStages）停下来等确认。
 * 确认（可以像计划卡一样勾掉、收窄授权项，加本任务的关注类别）后计划和授权项随之更新，受影响的阶段恢复；
 * 拒绝后维护者在现有授权内重排受影响的阶段，做不到就标做不了、任务转等我
 */
export const PlanChangeCardPayload = Type.Object({
  taskId: Type.String(),
  taskTitle: Type.String(),
  /** 这次变更提的那一版计划：id 和版本（接着计划的版本往下排） */
  planId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  /** 基于哪一版确认的计划 */
  basePlanId: Type.String(),
  /** 维护者为什么要改 */
  why: Type.String(),
  /** 相对当前计划新增或改动的部分（卡上只列这些） */
  changes: Type.Array(PlanChangeItem),
  /** 停下来等确认的阶段 */
  affectedStages: Type.Array(Type.Object(StageRef)),
  /** 变更后的整份计划（确认后是勾掉、收窄之后的那份；任务详情的阶段抽屉取自它） */
  plan: Plan,
  /** 每项授权在守卫眼里的样子（授权行由它生成） */
  grantInfo: Type.Record(Type.String(), GrantInfo),
  /** 用户确认时勾掉的授权项（原样）、收窄了的授权项 id、加的关注类别 id（和计划卡同名同形） */
  removedGrants: Type.Optional(Type.Array(PlanGrant)),
  narrowedGrants: Type.Optional(Type.Array(Type.String())),
  addedCategories: Type.Optional(Type.Array(Type.String())),
});
export type PlanChangeCardPayload = Static<typeof PlanChangeCardPayload>;

/**
 * `task_plan` 事件（任务看板频道，14 号票）：执行中任务现在生效的计划换了一版（计划变更确认、维护者自行调整计划）时推一条。
 * 任务详情的阶段抽屉按它显示（交付件、预算、授权都按这一版：去掉、收窄的授权项不再显示，新加的阶段也有）；
 * 没收到过的任务按它的计划卡
 */
export const TaskPlanEventPayload = Type.Object({
  taskId: Type.String(),
  planId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  plan: Plan,
  /** 每项授权在守卫眼里的样子（授权行由它生成） */
  grantInfo: Type.Record(Type.String(), GrantInfo),
});
export type TaskPlanEventPayload = Static<typeof TaskPlanEventPayload>;

// ───────────────────────── 提问卡、建议发起任务卡 ─────────────────────────

export const Question = Type.Object(
  {
    id: Id("题号，比如 q1"),
    question: Type.String({ minLength: 1, maxLength: 300, description: "问题" }),
    options: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 8, description: "现成的选项（没有就写空数组；用户也可以自己写）" }),
    recommended: Type.String({ minLength: 1, maxLength: 200, description: "推荐的答案（每题必须带；有选项时一般是其中之一）" }),
    why: Type.Optional(Type.String({ maxLength: 300, description: "为什么推荐它" })),
  },
  { additionalProperties: false },
);
export type Question = Static<typeof Question>;

/** 秘书提问时写的一道题：题号由运行时给 */
export const QuestionDraft = Type.Omit(Question, ["id"]);
export type QuestionDraft = Static<typeof QuestionDraft>;

export const QuestionAnswer = Type.Object({ questionId: Type.String(), answer: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false });
export type QuestionAnswer = Static<typeof QuestionAnswer>;

/**
 * 提问卡：成批提问，每题带推荐；回答了就带上答案。秘书澄清用户意图时问；16 号票起项目维护者干活中遇到要问的也用它
 * （工单转等澄清，askedBy 记着是谁为哪张工单问的，回答交回它，不交给秘书）
 */
export const QuestionsCardPayload = Type.Object({
  /** 澄清的是哪个任务 */
  taskId: Type.Optional(Type.String()),
  /** 项目维护者为工单提问（16 号票）：哪个维护者、哪个项目、哪张工单 */
  askedBy: Type.Optional(Type.Object({ maintainerId: Type.String(), projectId: Type.String(), workOrderId: Type.String() })),
  intro: Type.Optional(Type.String()),
  questions: Type.Array(Question, { minItems: 1 }),
  answers: Type.Optional(Type.Array(QuestionAnswer)),
});
export type QuestionsCardPayload = Static<typeof QuestionsCardPayload>;

/** 提问卡上"提交回答"（answer）的输入：每题一个答案（"全按推荐"就是每题都填推荐的那个） */
export const QuestionsAnswerInput = Type.Object({ answers: Type.Array(QuestionAnswer, { minItems: 1 }) }, { additionalProperties: false });
export type QuestionsAnswerInput = Static<typeof QuestionsAnswerInput>;

/** `questions_answered` 事件（卡片频道）：用户回答了提问卡。"澄清问题的回答"素材的来源 */
export const QuestionsAnsweredPayload = Type.Object({
  cardId: Type.String(),
  taskId: Type.Optional(Type.String()),
  /** 项目维护者为工单问的（16 号票）：所属的项目（素材的"任务或项目"） */
  projectId: Type.Optional(Type.String()),
  answers: Type.Array(
    Type.Object({
      questionId: Type.String(),
      question: Type.String(),
      answer: Type.String(),
      recommended: Type.String(),
      /** 答案就是推荐的那个 */
      followedRecommendation: Type.Boolean(),
      /** 答案是卡上现成的选项（含推荐的那个）；false 是用户自己写的 */
      chosenOption: Type.Boolean(),
    }),
  ),
  time: Type.String(),
});
export type QuestionsAnsweredPayload = Static<typeof QuestionsAnsweredPayload>;

/**
 * "建议发起任务"卡：秘书觉得该发起、但用户没点明的事。卡上两个按钮"作为流程""作为长程任务"（58 号票），
 * 用户点了才建任务（建出后带上任务编号和种类）
 */
export const SuggestTaskCardPayload = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 80 }),
  why: Type.String({ minLength: 1, maxLength: 1000 }),
  /** 涉及的项目（项目列表里的名字，16 号票）：恰好一个时建出的任务由这个项目的维护者起草并执行 */
  projects: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  taskId: Type.Optional(Type.String()),
  /** 用户点的是哪个按钮：建出的任务的种类（58 号票） */
  kind: Type.Optional(Type.Enum(TASK_KINDS)),
  /**
   * 项目的维护者在自己的会话里给的建议卡（64 号票）：点了建出的是这个项目的内部任务（项目的维护者执行、只在项目里看得到），
   * 通知交给它而不是秘书。秘书给的建议卡没有这一项
   */
  internal: Type.Optional(ProjectInternal),
});
export type SuggestTaskCardPayload = Static<typeof SuggestTaskCardPayload>;
