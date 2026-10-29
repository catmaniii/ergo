// @i18n-ignore-file model：这里的中文都是工具参数的说明（给维护者看）
// 运营方案（130 号票，ADR-0028）的 schema，用 TypeBox 定义，守护进程和 Web 共用生成的类型。名字和纯函数在 operations.ts。
// - 维护者用 propose_operations 交的一条（OperationItemDraft，工具的参数）：标识、名字、运营手段、触发（时间表或事件）、
//   怎么做（普通任务或流程；流程带它的步骤）、每次做什么、要的能力、失败时怎样；要用户手动的写明要手动做什么；
// - 运行时逐条校验之后的一条（OperationItem）：多了手段的说法、二狗能不能替用户做、触发的说法；流程的步骤换成审查修补后的计划
//   （WorkflowPlan，用户确认方案时一起授权）。卡上、事件里都是它；
// - 项目上现在生效的运营方案（ProjectOperations，Project.operations）：每一条连同它生效成的项目内部任务、没生效的原因；
// - "运营方案变更"卡（operations_change）：使用中的项目交了新的一份，和现在生效的比出的差异；
// - 确认时的输入（OperationsConfirmInput）：方案里带流程的、审查要你逐项确认的事项勾了哪些。
import { type Static, Type } from "typebox";
import { EventTrigger } from "./event-source-schema.ts";
import { OPERATION_APPROACHES, OPERATION_OUTCOMES } from "./operations.ts";
import { PROJECT_SERVICES_ACTIONS } from "./project-services.ts";
import { ReminderSchedule } from "./reminder-schedule.ts";
import { PlanTemporalRule } from "./task-schema.ts";
import { USER_WORDS_MAX, VerifiedUserWords } from "./user-words.ts";
import { WorkflowPlan, WorkflowStep } from "./workflow-schema.ts";

/** 一条的标识：英文小写、数字和短横线（daily-report）；同一条在之后的方案里不变，运行时按它比出加了、改了、去掉了哪几条 */
export const OPERATION_KEY_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";

/** 一份方案最多几条 */
export const OPERATIONS_MAX = 20;

/** 一条的名字最长几个字（就是它生效成的内部任务的标题） */
export const OPERATION_NAME_MAX = 40;

/** 要的能力：都不能超出项目的工具包（超了就拒，说明原因）；都不写是什么额外的能力都不要 */
export const OperationCapabilities = Type.Object(
  {
    network: Type.Optional(Type.Boolean({ description: "每次运行要联网（搜索、读网页、下载）" })),
    bash: Type.Optional(Type.Boolean({ description: "每次运行要跑 bash（脚本、命令）" })),
    skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 30, description: "要用的 skill（项目工具包里有的）" })),
    mcp: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 30, description: "要用的 MCP（项目工具包里有的）" })),
    tellSecretary: Type.Optional(Type.Boolean({ description: "做完要给秘书发消息（tell_secretary），让秘书转告用户" })),
  },
  { additionalProperties: false, description: "要的能力：联网、bash、skill、MCP、给秘书发消息；不能超出项目的工具包" },
);
export type OperationCapabilities = Static<typeof OperationCapabilities>;

/** 流程那一条带的步骤（目标就是"每次做什么"）：和 propose_plan 的步骤、条件同一种写法 */
export const OperationWorkflowDraft = Type.Object(
  {
    steps: Type.Array(WorkflowStep, { minItems: 1, description: "完整的步骤列表，按执行的先后排（每步一次工具调用）" }),
    rules: Type.Optional(Type.Array(PlanTemporalRule, { description: "这份计划要满足的条件（时序规则，planguard 格式）；框架自带的不用写，没有就不写" })),
  },
  { additionalProperties: false },
);
export type OperationWorkflowDraft = Static<typeof OperationWorkflowDraft>;

/**
 * 服务名（133 号票）：英文小写、数字、连字符，字母或数字开头结尾，最长 32（连着的两个连字符运行时另外拒：LSM 的名字不许 "--"）。
 * 上线后在 LSM 里、转发的应用名都是 <项目编号>-<服务名>（serviceAppName），LSM 的名字最长 48
 */
export const OPERATION_SERVICE_NAME_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$";

/** 服务的一个环境变量：普通的值（value）、密钥的引用（secret：数据目录密钥区里的文件名）、用户级环境变量（userEnv）三选一 */
export const OperationServiceEnv = Type.Object(
  {
    name: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$", description: "变量名" }),
    value: Type.Optional(Type.String({ maxLength: 1000, description: "普通的值（不许写密钥：看名字、看值像密钥的一律拒）" })),
    secret: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: "要密钥的写引用：二狗数据目录密钥区（secrets/）里的文件名，比如 openai-api-key.txt。上线时由 LSM 从那个文件读出来注入，方案里不写值",
      }),
    ),
    userEnv: Type.Optional(Type.Boolean({ description: "取用户级环境变量里同名的那个（LSM 每次启动时现读）" })),
    optional: Type.Optional(Type.Boolean({ description: "取不到也照常启动（不写是取不到就起不来）" })),
  },
  { additionalProperties: false },
);
export type OperationServiceEnv = Static<typeof OperationServiceEnv>;

/** 服务的健康检查：LSM 去打 http://127.0.0.1:<端口><path> */
export const OperationServiceHealth = Type.Object(
  {
    path: Type.String({ pattern: "^/[^\\s#]*$", maxLength: 200, description: "以 / 开头的路径，比如 /health" }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: "每次检查等多久（毫秒，默认 3000）" })),
  },
  { additionalProperties: false, description: "健康检查（可以不写：不写就只看端口有没有人听）" },
);

/** 服务的前缀约定（132 号票）：strip 转发时去掉前缀（服务当自己在根上，默认）；keep 原样带着（框架的 base 设成了 ERGO_BASE_PATH） */
export const OPERATION_SERVICE_PREFIX_MODES = ["strip", "keep"] as const;

/** 维护者写的一个服务（运营手段"服务"那一条的 service，133 号票） */
export const OperationServiceDraft = Type.Object(
  {
    name: Type.String({ pattern: OPERATION_SERVICE_NAME_PATTERN, description: "服务名（英文小写、数字、连字符，比如 web）：上线后在 LSM 里叫 <项目编号>-<服务名>，网页的地址是 /apps/<项目编号>-<服务名>/" }),
    command: Type.String({ minLength: 1, maxLength: 2000, description: "启动命令（一行，在工作目录里经 cmd 执行，要一直跑着不退出；端口写进命令或环境变量）" }),
    cwd: Type.Optional(
      Type.String({ minLength: 1, maxLength: 500, description: "工作目录：相对项目的工作目录写（不写就是工作目录本身），也可以写项目工作目录或项目档案里的绝对路径；不能出界，要已经存在" }),
    ),
    env: Type.Optional(Type.Array(OperationServiceEnv, { maxItems: 30, description: "环境变量；ERGO_BASE_PATH（有网页的）由运行时注入，不用写" })),
    port: Type.Integer({ minimum: 1024, maximum: 65535, description: "端口：由你定（LSM 不分配），和别的服务撞了会被拒；不能用二狗自己的端口" }),
    health: Type.Optional(OperationServiceHealth),
    autostart: Type.Optional(Type.Boolean({ description: "开机自启（不写是开）" })),
    autoRestart: Type.Optional(
      Type.Boolean({ description: "挂了自动重启（不写是关：LSM 默认不自动重拉，ADR-0004）。要一直在线、挂了重拉也没坏处的才开（吃 GPU、重启有副作用的别开）" }),
    ),
    web: Type.Optional(
      Type.Object(
        {
          home: Type.Optional(Type.String({ pattern: "^/", maxLength: 300, description: "首页路径（以 / 开头，默认 /）：入口打开的就是它" })),
          prefix: Type.Optional(Type.Enum(OPERATION_SERVICE_PREFIX_MODES, { description: "前缀约定：strip（默认，服务只用相对地址）或 keep（框架的 base 设成了 ERGO_BASE_PATH）" })),
        },
        { additionalProperties: false, description: "有网页的写它（没有网页的不写）：上线后经二狗转发到 /apps/<项目编号>-<服务名>/，项目卡上有入口。要守前缀约定" },
      ),
    ),
  },
  { additionalProperties: false, description: "means 是 service 时写：要上线到 LSM 的服务" },
);
export type OperationServiceDraft = Static<typeof OperationServiceDraft>;

/**
 * 运行时校验过的服务（卡上、事件里、项目上）：工作目录换成了绝对路径（真实路径），开机自启、挂了自动重启、首页、前缀约定补上了默认，
 * app 是 LSM 里的名字、转发的应用名（<项目编号>-<服务名>）
 */
export const OperationService = Type.Object({
  name: Type.String(),
  app: Type.String(),
  command: Type.String(),
  cwd: Type.String(),
  env: Type.Array(OperationServiceEnv),
  port: Type.Integer(),
  health: Type.Optional(OperationServiceHealth),
  autostart: Type.Boolean(),
  autoRestart: Type.Boolean(),
  web: Type.Optional(Type.Object({ home: Type.String(), prefix: Type.Enum(OPERATION_SERVICE_PREFIX_MODES) })),
});
export type OperationService = Static<typeof OperationService>;

/** 维护者交的一条（propose_operations 的参数） */
export const OperationItemDraft = Type.Object(
  {
    key: Type.String({ pattern: OPERATION_KEY_PATTERN, description: "这一条的标识：英文小写、数字和短横线（比如 daily-report）。同一条在之后交的方案里保持不变，运行时按它比出加了、改了、去掉了哪几条" }),
    name: Type.String({ minLength: 1, maxLength: OPERATION_NAME_MAX, description: "名字（短，用户在卡上、项目页上看到的；生效后就是这条内部任务的标题）" }),
    means: Type.String({ minLength: 1, description: "用哪种运营手段（登记表里的编号，见工具说明）" }),
    schedule: Type.Optional(ReminderSchedule),
    event: Type.Optional(EventTrigger),
    approach: Type.Optional(Type.Enum(OPERATION_APPROACHES, { description: "怎么做：plain 普通任务（默认：每次运行照 instructions 直接做）；workflow 流程（带 workflow 里的固定步骤，用户确认方案时一起授权，每次运行照步骤核对）" })),
    instructions: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: "每次做什么：每次运行交给你（项目的维护者）的工单内容，你照项目档案干活，不用把脚本细节全写进来；流程的这一条就是计划的目标。要用户手动的写要做成什么样",
    }),
    workflow: Type.Optional(OperationWorkflowDraft),
    capabilities: OperationCapabilities,
    onFailure: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "失败时怎样（可以不写：照现有规矩，连续失败 3 次自动暂停、告诉用户）" })),
    manual: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "二狗现在做不了、要用户手动的手段（公网入口）：写清用户要做哪几步" })),
    service: Type.Optional(OperationServiceDraft),
  },
  { additionalProperties: false },
);
export type OperationItemDraft = Static<typeof OperationItemDraft>;

/** 校验过的一条里，卡上、项目上、事件里都有的那几项（流程审查修补后的计划只在卡上和事件里，不在项目上） */
const ITEM_FIELDS = {
  key: Type.String(),
  name: Type.String(),
  /** 运营手段的编号，和它的说法（"定时触发的任务"） */
  means: Type.String(),
  meansLabel: Type.String(),
  /** 二狗现在能不能替用户做（定时、事件触发的能；项目自己的服务、公网入口还不能，要用户手动） */
  automatic: Type.Boolean(),
  /** 触发写成一句话（手段登记的说法）："每天 08:00"、"本机文件夹 D:\收件箱 里新增 *.pdf 文件"；要用户手动的写手段的名字 */
  triggerText: Type.String(),
  schedule: Type.Optional(ReminderSchedule),
  event: Type.Optional(EventTrigger),
  approach: Type.Enum(OPERATION_APPROACHES),
  instructions: Type.String(),
  capabilities: OperationCapabilities,
  onFailure: Type.Optional(Type.String()),
  manual: Type.Optional(Type.String()),
  /** 运营手段"服务"（133 号票）：要上线到 LSM 的服务 */
  service: Type.Optional(OperationService),
};

/** 运行时校验过的一条（卡上、事件里）：流程的那条带着审查修补后的计划（用户确认方案时一起授权） */
export const OperationItem = Type.Object({ ...ITEM_FIELDS, workflow: Type.Optional(WorkflowPlan) });
export type OperationItem = Static<typeof OperationItem>;

/** 一份运营方案（"首版做完了"卡上带着的）：第几版、每一条、维护者的一句说明、引用的运行时核实过的用户原话 */
export const OperationsPlanView = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
  items: Type.Array(OperationItem),
  why: Type.Optional(Type.String()),
  userWords: Type.Optional(Type.Array(VerifiedUserWords, { maxItems: USER_WORDS_MAX })),
});
export type OperationsPlanView = Static<typeof OperationsPlanView>;

/** 一条生效之后的结局：建成的内部任务（建成、就地改、撤了重建的）、没生效的原因 */
export const OperationResult = Type.Object({
  key: Type.String(),
  name: Type.String(),
  outcome: Type.Enum(OPERATION_OUTCOMES),
  taskId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
});
export type OperationResult = Static<typeof OperationResult>;

/** 项目上现在生效的一条：连同它生效成的项目内部任务（taskId）、没生效的原因（failed） */
export const ProjectOperationItem = Type.Object({
  ...ITEM_FIELDS,
  /** 流程的那条有几步（步骤本身在它的内部任务的计划里） */
  steps: Type.Optional(Type.Integer({ minimum: 1 })),
  taskId: Type.Optional(Type.String()),
  failed: Type.Optional(Type.String()),
});
export type ProjectOperationItem = Static<typeof ProjectOperationItem>;

/** 项目上现在生效的运营方案（用户确认过的那一版）：项目页"运营方案"那一节照它列出每一条和状态 */
export const ProjectOperations = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
  confirmedAt: Type.String(),
  items: Type.Array(ProjectOperationItem),
});
export type ProjectOperations = Static<typeof ProjectOperations>;

/**
 * "运营方案变更"卡（operations_change，130 号票）：使用中（或已停用）的项目，维护者交了新的一份运营方案，和现在生效的比出差异——
 * 加了哪几条、改了哪几条（就地改时间的标 inPlace）、去掉哪几条、照旧却没跑着的重新开起来。用户确认一次就照差异生效：
 * 建、改、取消对应的内部任务；拒绝什么都不动。附维护者引用的、运行时核实过的用户原话（照 125 号票的立项要求变更卡）
 */
export const OperationsChangeCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  /** 这份运营方案是这个项目的第几版（交上来就算，被拒的也占号） */
  revision: Type.Integer({ minimum: 1 }),
  /** 和哪一版比的（现在生效的那一版；还没有生效的方案时没有） */
  baseRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  why: Type.String(),
  added: Type.Array(OperationItem),
  changed: Type.Array(Type.Object({ before: OperationItem, after: OperationItem, inPlace: Type.Boolean() })),
  removed: Type.Array(OperationItem),
  restored: Type.Array(OperationItem),
  /** 照旧的（只列名字和触发） */
  kept: Type.Array(Type.Object({ key: Type.String(), name: Type.String(), triggerText: Type.String() })),
  userWords: Type.Optional(Type.Array(VerifiedUserWords, { maxItems: USER_WORDS_MAX })),
  /** 处理之后：确认了没有、什么时候、每一条的结局 */
  decided: Type.Optional(Type.Object({ confirmed: Type.Boolean(), at: Type.String(), results: Type.Optional(Type.Array(OperationResult)) })),
});
export type OperationsChangeCardPayload = Static<typeof OperationsChangeCardPayload>;

/**
 * 确认运营方案（"首版做完了"卡的"确认并转入使用"、"运营方案变更"卡的"确认"）时的输入：方案里带流程的、审查要你逐项确认的事项
 * 勾了哪些（operationConfirmationKey 的写法）。没有要确认的可以不给
 */
export const OperationsConfirmInput = Type.Union([
  Type.Undefined(),
  Type.Object({ confirmations: Type.Array(Type.String(), { maxItems: 200 }) }, { additionalProperties: false }),
]);
export type OperationsConfirmInput = Static<typeof OperationsConfirmInput>;

/**
 * 服务入口卡（service_entry，133 号票）：秘书给出的某个项目的服务的入口（用户说"打开简报站""简报站的页面在哪"），放进聊天，
 * 出来就是已处理（没有要用户选的）。卡上写"打开「X」"，点了在内置浏览器里打开 url；在不在线按前端手里的服务状态现画
 */
export const ServiceEntryCardPayload = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  /** 运营方案里这一条的 key */
  key: Type.String(),
  /** 这一条的名字（"打开「X」"的 X） */
  title: Type.String(),
  /** LSM 里的名字、转发的应用名 */
  app: Type.String(),
  /** 有网页的：转发的首页地址（/apps/<应用名>/…）；没有网页的没有 */
  url: Type.Optional(Type.String()),
});
export type ServiceEntryCardPayload = Static<typeof ServiceEntryCardPayload>;

/**
 * 项目的服务全部启动 / 全部关闭（project_services_action，257 号票）：项目卡片、项目页上的"启动""关闭"。只有使用中、有在 LSM 上的服务、
 * LSM 连着的项目能做；关闭之后一直关着（取消开机自启），直到再启动
 */
export const ProjectServicesActionParams = Type.Object({ projectId: Type.String({ minLength: 1 }), action: Type.Enum(PROJECT_SERVICES_ACTIONS) });
export type ProjectServicesActionParams = Static<typeof ProjectServicesActionParams>;

/** 交给 LSM 了（真的拉起、停掉随后经 project_services 推来）：这个项目有几个服务 */
export const ProjectServicesActionResult = Type.Object({ projectId: Type.String(), action: Type.Enum(PROJECT_SERVICES_ACTIONS), services: Type.Integer({ minimum: 0 }) });
export type ProjectServicesActionResult = Static<typeof ProjectServicesActionResult>;
