// 流程（58 号票，ADR 0019）的 schema，用 TypeBox 定义，守护进程和 Web 共用生成的类型。名字和纯函数在 workflow.ts。
// 照搬 AgentSense 的固定计划（web/src/agent/plan.ts）：
// - 维护者用 propose_plan 交出的计划（WorkflowPlanDraft）：目标、一串步骤（PlanStep：id、标题、工具、参数、前置步骤），
//   连同这份计划要满足的条件（rules：时序规则，planguard 格式；AgentSense 的条件在场景的规则文档里，二狗由维护者写进计划，
//   框架的 v1 规则模板也算）；
// - 审查修补之后、交给用户授权的计划（WorkflowPlan，AgentSense 的 AnnotatedPlan）：每步加上敏感标注（marks）、
//   要满足的条件和审查时查出的结果（conditions），整份带上审查结果（review）和版本；审查插入、改写过的步骤带 inserted、patches；
// - 流程计划卡（workflow_plan）的负载和"授权"的输入：需要你确认的事项逐条勾完，一次授权；
// - 执行时每一步的状态（Task.steps，维护者用 report_step 自报）在 task-schema.ts（任务的一部分）。
import { type Static, Type } from "typebox";
import { DISPOSITIONS } from "./constants.ts";
import { ReminderSchedule } from "./reminder-schedule.ts";
import { PlanTemporalRule, PlanToolkit } from "./task-schema.ts";
import { PLAN_ID_PATTERN } from "./tasks.ts";
import { WORKFLOW_CONDITION_SOURCES, WORKFLOW_CONDITION_STATUSES, WORKFLOW_REVIEW_STATUSES } from "./workflow.ts";

const Id = (description: string) => Type.String({ pattern: PLAN_ID_PATTERN, description });
const Text = (description: string) => Type.String({ minLength: 1, description });

// ───────────────────────── 维护者起草的 ─────────────────────────

/** 计划里的一步：一次工具调用（照 AgentSense plan.ts 的 PlanStep） */
export const WorkflowStep = Type.Object(
  {
    id: Id("步骤 id，比如 s1、s2"),
    title: Text("给用户看的一句话步骤描述"),
    tool: Text("这一步调用的工具名：read、write、edit、ls、grep、find、bash，或带类型的工具（git_status_diff、git_commit、git_merge、git_push、create_remote_repo、run_tests、install_deps、start_build）"),
    args: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "已知的关键参数（只用工具真实的参数名；一个参数放多个值用数组；还不知道的整个省掉，不要填“待定”这类占位文字）",
      }),
    ),
    after: Type.Optional(Type.Array(Type.String(), { description: "前置步骤的 id：必须排在这些步骤之后（审查也可能补上）" })),
  },
  { additionalProperties: false },
);
export type WorkflowStep = Static<typeof WorkflowStep>;

/** 维护者用 propose_plan 交出的流程计划（AgentSense 的 Plan 去掉版本号，版本由运行时给） */
export const WorkflowPlanDraft = Type.Object(
  {
    goal: Text("目标：这份计划要做成什么"),
    steps: Type.Array(WorkflowStep, { minItems: 1, description: "完整的步骤列表，按执行的先后排" }),
    rules: Type.Array(PlanTemporalRule, {
      description:
        "这份计划要满足的条件（时序规则，planguard 格式）：之前必须做过（require.before）、之前不能做过（require.not_before）、当下必须满足（require.check）、一律禁止（不写 require）；框架自带的规则（推送前要跑过测试、删除或覆盖前要已提交或已备份……）不用写；没有就写空数组",
    }),
  },
  { additionalProperties: false },
);
export type WorkflowPlanDraft = Static<typeof WorkflowPlanDraft>;

// ───────────────────────── 审查修补之后（AgentSense 的 AnnotatedPlan） ─────────────────────────

/** 一步的敏感标注：落进了哪个关注类别、那个类别在任务里的处置、计划授权了没有（授权后执行时不再问） */
export const WorkflowStepMark = Type.Object({
  category: Type.String(),
  /** 类别的名字（"以我的名义对外发送或发布"……） */
  title: Type.String(),
  /** 这个类别在任务里的处置 */
  disposition: Type.Enum(DISPOSITIONS),
  /** 计划里列了这一步就算授权（"计划里列了才做"那一档）：授权后执行时不再问；false 是执行时仍会问、交给你做或永不 */
  authorized: Type.Boolean(),
});
export type WorkflowStepMark = Static<typeof WorkflowStepMark>;

/** 一步要满足的一个条件：哪条时序规则（写成人话）、从哪里来、审查时查出的结果 */
export const WorkflowCondition = Type.Object({
  ruleId: Type.String(),
  /** 规则的标题（没写时是 id） */
  title: Type.String(),
  /** 写成人话的条件（协议包 plan.ts 的 temporalRuleText） */
  text: Type.String(),
  source: Type.Enum(WORKFLOW_CONDITION_SOURCES),
  /** 审查时查出的结果：满足、不满足、现在判不了（推迟到执行时再查） */
  status: Type.Enum(WORKFLOW_CONDITION_STATUSES),
  /** 不满足、判不了时规则给的说明 */
  note: Type.Optional(Type.String()),
});
export type WorkflowCondition = Static<typeof WorkflowCondition>;

/** 审查修补之后的一步（AgentSense 的 AnnotatedStep） */
export const WorkflowStepView = Type.Object({
  id: Type.String(),
  title: Type.String(),
  tool: Type.String(),
  args: Type.Record(Type.String(), Type.Unknown()),
  /** 前置步骤 */
  after: Type.Array(Type.String()),
  /** 这一步是审查插进去的 */
  inserted: Type.Optional(Type.Boolean()),
  /** 审查对这一步做的改写，每条一句话 */
  patches: Type.Optional(Type.Array(Type.String())),
  marks: Type.Array(WorkflowStepMark),
  conditions: Type.Array(WorkflowCondition),
  /**
   * 这一步里真实路径落在项目、工作区之外的路径（规划时解析：展开符号链接、目录联接）：参数名、写的路径（绝对）、真实路径。
   * 计划卡上标出来（58 号票复审：步骤写的是项目里的 sub，sub 实际指向项目外）
   */
  outside: Type.Optional(Type.Array(Type.Object({ arg: Type.String(), path: Type.String(), realPath: Type.String() }))),
  /**
   * 审查修补时从这一步的数组参数里剔除的对象（59 号票，参数名 → 剔除的值，规范化后的写法）：执行时再碰它们直接拦下
   * （AgentSense 的 conformance.forbid：审查时明确排除在计划之外的对象）
   */
  excluded: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Unknown()))),
  /**
   * 这一步（连同剔除的对象）里的路径规划时现取的真实路径（解析成的绝对路径 → 真实路径）：执行时每次调用和这一步比对，
   * 路径按真实路径比（59 号票，和 58 号票的授权项一个口径）。界面不显示
   */
  realPaths: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type WorkflowStepView = Static<typeof WorkflowStepView>;

/** 审查查出的一处违规（AgentSense 的 ReviewFinding） */
export const WorkflowReviewFinding = Type.Object({
  stepId: Type.String(),
  /** 规则 id */
  property: Type.String(),
  message: Type.String(),
  /** 引擎给这条违规的唯一标识，用来和修补动作的 covers 对上 */
  key: Type.Optional(Type.String()),
});
export type WorkflowReviewFinding = Static<typeof WorkflowReviewFinding>;

/** 一个修补动作（AgentSense 的 ReviewAction） */
export const WorkflowReviewAction = Type.Object({
  /** insert / rewrite / move_after / confirm / replan */
  kind: Type.String(),
  title: Type.String(),
  /** 这个动作修掉了哪几条违规 */
  covers: Type.Array(Type.String()),
  /** 被插入到哪一步之前、或被改写的是哪一步 */
  stepId: Type.Optional(Type.String()),
  /** 这个修补的代价：interaction > 0 表示它本身就需要用户点头 */
  costs: Type.Optional(Type.Record(Type.String(), Type.Number())),
});
export type WorkflowReviewAction = Static<typeof WorkflowReviewAction>;

/** 单条规则单独扫一遍的结果（AgentSense 的 RuleProbe，另带规则的标题和来源） */
export const WorkflowRuleProbe = Type.Object({
  id: Type.String(),
  title: Type.String(),
  source: Type.Enum(WORKFLOW_CONDITION_SOURCES),
  ms: Type.Number(),
  violated: Type.Integer({ minimum: 0 }),
  unknown: Type.Integer({ minimum: 0 }),
  error: Type.Optional(Type.String()),
});
export type WorkflowRuleProbe = Static<typeof WorkflowRuleProbe>;

/** 审查结果（AgentSense 的 PlanReviewResult 里二狗用到的部分：没有目标、数量、求解器替计划定的选择） */
export const WorkflowReview = Type.Object({
  /** pass = 审查通过；skipped = 没审查或审查出错；其余都算 fail */
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("skipped")]),
  status: Type.Optional(Type.Enum(WORKFLOW_REVIEW_STATUSES)),
  violations: Type.Array(WorkflowReviewFinding),
  actions: Type.Array(WorkflowReviewAction),
  /** 必须由用户逐项明确同意的事项 */
  confirmations: Type.Array(Type.String()),
  /** 事实不足、推迟到执行时再查的 */
  deferred: Type.Array(WorkflowReviewFinding),
  /** 退回给维护者的补充要求 */
  replans: Type.Array(Type.String()),
  /** 这次扫了多少：几条规则、原计划几步 */
  scanned: Type.Object({ rules: Type.Integer({ minimum: 0 }), steps: Type.Integer({ minimum: 0 }) }),
  /** 各阶段耗时（毫秒）：取事实（规划时不取，恒为 0）/ 编译规则 / 扫描求解 / 逐条复测（照 AgentSense 的 phases） */
  phases: Type.Optional(Type.Object({ facts: Type.Number(), compile: Type.Number(), solve: Type.Number(), probe: Type.Number() })),
  /** 逐条规则单独扫一遍的结果（照 AgentSense 的 RuleProbe）：每条规则查了多久、原计划里查出几处违反、几处判不了 */
  rules: Type.Array(WorkflowRuleProbe),
  /**
   * 这次审查真正用的那一份规则原文（60 号票，AgentSense 的 RuleBook 从场景的规则文档里取）：框架的 v1 模板加维护者写进计划的，
   * 没写修补方案的已按违反时怎么办补上（planguard 格式）。计划详情的"检测项全览"据此写出每条的形式化写法、可选的修法和代价。
   * 60 号票之前的计划、审查没跑成的没有
   */
  docs: Type.Optional(Type.Array(PlanTemporalRule)),
  /** 这次审查花了多少毫秒 */
  ms: Type.Number(),
  /** 审查没跑成、判定不可执行的原因 */
  note: Type.Optional(Type.String()),
});
export type WorkflowReview = Static<typeof WorkflowReview>;

/** 审查修补之后、交给用户授权的流程计划（AgentSense 的 AnnotatedPlan） */
export const WorkflowPlan = Type.Object({
  /** 第几版（打回后重新提交加 1；审查修补后的计划沿用同一个版本） */
  version: Type.Integer({ minimum: 1 }),
  goal: Type.String(),
  steps: Type.Array(WorkflowStepView),
  /** 维护者写进计划的条件（时序规则）；框架的 v1 模板不在这里，但会出现在各步的 conditions 里 */
  rules: Type.Array(PlanTemporalRule),
  review: WorkflowReview,
  /** 按步骤推出来的工具包：用到 bash 或带类型的 bash 工具才开 bash，用到要联网的才开联网 */
  toolkit: PlanToolkit,
});
export type WorkflowPlan = Static<typeof WorkflowPlan>;

// ───────────────────────── 流程计划卡 ─────────────────────────

/** 审查没让这版计划交给你授权的两种情形：退回维护者补充（它会改好重新提交）、判定不可执行 */
export const WORKFLOW_REFUSALS = ["needs_replan", "blocked"] as const;

/**
 * 流程计划卡（workflow_plan）：审查结果、步骤和每一步的条件、需要你确认的事项，一次授权。
 * 审查退回维护者、判定不可执行的那一版也出一张（refused，照 AgentSense 把这版计划显示出来）：不能授权，
 * 写明原因和下一步——退回的等维护者改好重新提交（可以取消任务），不可执行的让维护者改（可以附说明）或者取消任务
 */
export const WorkflowPlanCardPayload = Type.Object({
  taskId: Type.String(),
  taskTitle: Type.String(),
  /** 第几版计划（和 plan.version 一样） */
  revision: Type.Integer({ minimum: 1 }),
  planId: Type.String(),
  /** 任务书里的目标 */
  goal: Type.String(),
  plan: WorkflowPlan,
  /** 授权时逐项勾了的确认事项（workflowConfirmationItems 的 key） */
  confirmed: Type.Optional(Type.Array(Type.String())),
  /** 审查没让这版交给你授权：退回维护者补充、判定不可执行（这样的卡只能"让维护者改""知道了"或者取消任务） */
  refused: Type.Optional(Type.Enum(WORKFLOW_REFUSALS)),
  /**
   * 定时触发的流程（76 号票）：它的时间表。卡上写明按时间表反复运行、授权一直有效，直到暂停或取消（TIMED_WORKFLOW_GRANT_TEXT）。
   * 现在做一次的流程没有
   */
  schedule: Type.Optional(ReminderSchedule),
});
export type WorkflowPlanCardPayload = Static<typeof WorkflowPlanCardPayload>;

/** 流程计划卡上"授权执行"的输入：逐项勾了的确认事项（要把审查要你确认的全勾上） */
export const WorkflowConfirmInput = Type.Object(
  { confirmations: Type.Array(Type.String(), { maxItems: 100 }) },
  { additionalProperties: false },
);
export type WorkflowConfirmInput = Static<typeof WorkflowConfirmInput>;
