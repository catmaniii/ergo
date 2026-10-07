// 守卫判定的输入和输出（规格第 9 节）。
// 输入：一次工具调用、发起的 agent 及其工具包、所属任务的计划、当前阶段和授权项、效果日志、
// 全局与本任务的关注类别设置、调用方现取后传入的环境事实、当前时间。
// 输出：硬拒绝、按规则退回、处置、命中的关注类别、是否通用 bash、命中的时序规则、是否属于授权内、给模型的说明。
import type { Disposition } from "./disposition.ts";
import type { ShellOrderStep } from "./shell/split.ts";
import type { TemporalRule, TemporalRuleHit } from "./temporal-rules.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { WatchCategorySettings } from "./watch-categories.ts";

// ───────────────────────── 输入 ─────────────────────────

/** 一次工具调用：模型给出的工具名和参数（守卫从不原地改参数） */
export interface ToolCall {
  toolName: string;
  args: unknown;
}

/** 工具包里和判定有关的部分（ADR-0003） */
export interface GuardToolkit {
  bash: boolean;
  /** 联网开关。秘书不论传入什么，一律按关着判 */
  network: boolean;
  /**
   * 工具包给的工具（会话装配的工具白名单，bash 和带类型的 bash 工具由 bash 开关管）。
   * 传了就检查：不在里面的工具硬拒绝；不传表示由会话装配保证，这里不查。
   */
  tools?: readonly string[];
}

/** 发起调用的 agent */
export type GuardAgent = SecretaryAgent | ExecutingAgent;

export interface SecretaryAgent {
  kind: "secretary";
  agentId: string;
  /** 工作目录：相对路径的基准（固定在草稿区） */
  cwd: string;
  toolkit: GuardToolkit;
  /** 草稿区：秘书的文件工具只能写这里 */
  scratchDir: string;
}

/** 干活的 agent：维护者或子 agent。子 agent 不能写项目档案 */
export interface ExecutingAgent {
  kind: "maintainer" | "sub_agent";
  agentId: string;
  cwd: string;
  toolkit: GuardToolkit;
  /** 项目档案（单项目一个；任务维护者是任务自己的档案） */
  projectRecords: string[];
  /** 工作目录（含绑定的外部路径） */
  workingDirs: string[];
}

/** 数据目录里和守卫有关的各区，以及程序目录、用户主目录 */
export interface GuardPlaces {
  dataDir: {
    root: string;
    /** 配置区：受保护 */
    config: string;
    /** 密钥区：受保护，连读都拒绝 */
    secrets: string;
    /** 数据库区：受保护 */
    db: string;
    /** 项目区：秘书只读 */
    projects: string;
  };
  /** 二狗程序目录：受保护 */
  programDir: string;
  /** 用户主目录：展开 `~`、`$HOME` 用 */
  homeDir: string;
}

/** 授权项：操作种类 + 对象范围 + 次数 + 所属阶段 + 有效期（规格第 9 节） */
export interface Grant {
  grantId: string;
  /** 操作种类：工具名。带类型的工具和从 bash 拆出的同一种伪工具调用同名 */
  tool: string;
  /**
   * 对象范围：参数名 → 允许的值。路径类参数按"在这个目录之内（或就是它）"匹配，其余按全等（任一）。
   * 空对象表示不限对象。
   */
  scope: Record<string, string | string[]>;
  /** 次数上限；不填表示不限次数。按效果日志里实际生效的效果计数 */
  maxUses?: number;
  /** 所属阶段：只在这个阶段内有效 */
  stageId: string;
  /** 授予时间（毫秒） */
  grantedAt: number;
  /** 到期时间（毫秒）；不填时为授予后 7 天 */
  expiresAt?: number;
}

/** 计划里和判定有关的部分 */
export interface GuardPlan {
  /** 全部授权项（各带所属阶段） */
  grants: Grant[];
  /** 本任务要提醒的关注类别：只在全局设置之上增加 */
  watchCategories?: WatchCategorySettings;
  /** 各阶段挂的时序规则和所属阶段组（只列和判定有关的部分） */
  stages?: GuardStage[];
  /** 阶段组：共用的时序规则套给组里的每个阶段 */
  stageGroups?: GuardStageGroup[];
}

export interface GuardStage {
  stageId: string;
  /** 所属阶段组 */
  groupId?: string;
  /** 这个阶段的时序规则（planguard 格式） */
  temporalRules?: TemporalRule[];
}

export interface GuardStageGroup {
  groupId: string;
  /** 组里每个阶段执行期间都检查的时序规则 */
  temporalRules?: TemporalRule[];
}

/** 调用所属的任务；对话里为 null */
export interface GuardTask {
  taskId: string;
  plan: GuardPlan;
  currentStageId: string;
}

/**
 * 效果日志的一条：只有执行成功的调用才追加（规格第 9 节）。用 effectRecordsFor(input, judgement, …) 生成：
 * 真实工具调用记它自己，通用 bash 记拆出来的每条伪工具调用。时序规则和授权项计次都只看它。
 */
export interface EffectRecord {
  /** 序号 */
  seq: number;
  /** 任务；对话里为 null */
  taskId: string | null;
  /** 阶段；对话里为 null */
  stageId: string | null;
  agentId: string;
  /** 会话段（秘书会话、维护者的工单段或对话段）：不属于任务的调用，时序规则只看同一段里的效果 */
  segmentId?: string;
  /** 工具或伪工具 */
  tool: string;
  /**
   * 规范化参数（rule-steps.ts 的 normalizeArgs）：参数名照工具注册表，路径是绝对路径，没法确定的值存成 `{"$unknown": 原文}`，
   * 空值去掉。带类型的工具和 bash 里的同一操作是同一种形式（推送还补上了当时的 headCommit）
   */
  args: Record<string, unknown>;
  /** 效果摘要（比如提交号、涉及的文件、测试是否通过） */
  summary: string;
  /** 时间（毫秒） */
  at: number;
}

/** 环境事实：调用方现取后传入，判定函数自己不读文件、不跑命令 */
export interface EnvironmentFacts {
  /** 文件元数据，键是绝对路径（大小写、分隔符不敏感） */
  files?: Record<string, FileFact>;
  /** git 状态，键是仓库根目录（05 号票的"当下必须满足某条件"用） */
  git?: Record<string, GitFact>;
  /** 要跑的脚本扫描结果，键是脚本的绝对路径 */
  scripts?: Record<string, ScriptFact>;
  /**
   * 别的环境事实（比如 MCP 工具的领域事实：通讯录、文档列表），原样放进时序规则的 $facts（不会盖掉 files、git、scripts）。
   * 规则要用它们，校验时要在 RuleValidationOptions.facts 里声明。
   */
  extra?: Readonly<Record<string, unknown>>;
}

export interface FileFact {
  exists: boolean;
  isDirectory?: boolean;
  /** 真实路径（展开符号链接、目录联接和 8.3 短名）；给了就一并检查 */
  realPath?: string;
  /**
   * 调用方确知这个文件当前的内容已有备份（v1 模板"删除或覆盖之前必须已备份或已提交"用）；不给按没有。
   * 项目档案里的文件被整体重写或删除前，运行时会自动留一份旧版本（15 号票），所以 07、15 号票对项目档案里的文件传 true
   */
  backedUp?: boolean;
}

/**
 * 一个目录的 git 状态，键是仓库根目录。v1 模板"删除或覆盖之前必须已备份或已提交"用：
 * 路径落在某个仓库里、它和它下面都不在 uncommittedPaths 里，才算已提交；没有包含它的 git 事实时判断不了。
 */
export interface GitFact {
  /**
   * 有未提交改动的文件（绝对路径）：`git status --porcelain` 列出的全部（改动、暂存、未跟踪；未跟踪的目录写目录本身）。
   * 被忽略的文件不在里面，算可以重新生成的东西。
   */
  uncommittedPaths: string[];
  /** false：这个目录不在任何 git 仓库里（这时它下面的文件都不算已提交）。不写就是仓库 */
  repository?: boolean;
  /** HEAD 的提交号：v1 模板"不重复发"用它判断两次推送的内容是不是一样；不给时第二次推送到同一处判断不了 */
  head?: string;
}

export interface ScriptFact {
  /** 脚本里用到的联网库或函数（如 `requests`、`fetch`）；空数组表示没扫到 */
  networkUsage: string[];
}

export interface GuardInput {
  call: ToolCall;
  agent: GuardAgent;
  places: GuardPlaces;
  /** 所属任务；对话里为 null */
  task: GuardTask | null;
  /** 这次调用所在的会话段（秘书会话、维护者的工单段或对话段），追加效果日志时记进去 */
  segmentId?: string;
  /**
   * 效果日志。时序规则只看范围之内的：任务里只看同一个任务的；不属于任务的只看同一个 agent、同一段会话的
   * （维护者会话跨工单延续，一次读 .env 不能永久生效）。07、13 号票按这个范围传，判定时也再过滤一遍。
   * 授权项计次另有自己的范围（同一任务、授权项所属阶段）。
   */
  effectLog: readonly EffectRecord[];
  /** 全局的关注类别设置（数据目录配置区的注册表） */
  settings: WatchCategorySettings;
  facts: EnvironmentFacts;
  /** 工具注册表 */
  tools: ToolRegistry;
  /** 当前时间（毫秒），由调用方传入 */
  now: number;
  /**
   * 调用方另给的时序规则（planguard 格式）。v1 模板、计划里当前阶段和它所属阶段组的规则由判定函数自动加上，不用放在这里。
   */
  temporalRules?: readonly TemporalRule[];
}

// ───────────────────────── 输出 ─────────────────────────

/** 被判定的一次调用：真实工具调用本身，或从通用 bash 拆出的伪工具调用 */
export interface JudgedCall {
  tool: string;
  args: Record<string, unknown>;
  /** tool：模型直接调用的工具；shell：从通用 bash 拆出来的 */
  origin: "tool" | "shell";
  /** 从 bash 拆出时，对应的那段命令原文 */
  text?: string;
  /** 从 bash 拆出时，它在命令结构里的位置：时序规则判断同一条命令里谁在谁之前（shell/split.ts 的 mayRunBefore） */
  order?: readonly ShellOrderStep[];
}

/**
 * 硬拒绝（Hard Refusal）的原因：守卫对越出能力或边界的调用的直接拒绝，不问用户，批准和授权项都改变不了。
 * 它不是处置的一档。
 * - fence：文件工具写路径围栏外；
 * - secrets_area：碰数据目录的密钥区（连读都拒绝）；
 * - network_off：联网开关关着时联网；
 * - no_bash：工具包没开 bash（含带类型的 bash 工具）；
 * - not_in_toolkit：工具包没给这个工具；
 * - sub_agent_records：子 agent 写项目档案（文件工具和 bash 都算）。
 */
export type HardRefusalId = "fence" | "secrets_area" | "network_off" | "no_bash" | "not_in_toolkit" | "sub_agent_records";

/** 一条处置依据 */
export interface DispositionFinding {
  /** protected_area：写受保护区域（永不）；notify：工具带"做完告诉我"标记 */
  kind: "category" | "bottom_line" | "protected_area" | "notify" | "temporal_rule";
  /** 关注类别 id、底线 id、受保护区域、工具名或规则 id */
  id: string;
  /** 这条依据带来的处置（"计划里列了才做"已按授权项落成放行或先问） */
  disposition: Disposition;
  /** 授权项落定了"计划里列了才做"时，类别本身的处置 */
  categoryDisposition?: Disposition;
  /** 这个类别是因为哪些参数命中的：授权项的对象范围要管到这些参数才能放行它 */
  objectArgs?: string[];
  /** 放行它的授权项 */
  grantId?: string;
  message: string;
  /** 对应 `calls` 里的第几条 */
  call: number;
}

/** 一条硬拒绝的原因 */
export interface HardRefusalFinding {
  kind: "hard_refusal";
  id: HardRefusalId;
  message: string;
  call: number;
}

/**
 * 一条"按规则退回"的原因：agent 自己能补救的前提没满足。id 是时序规则的 id，或守卫自己的
 * SCRIPT_NOT_CHECKED（联网开关关着时，要跑的脚本执行前没法检查：还不存在、读不了或看不出是哪个，比如同一条命令里现写现跑）
 */
export interface PullBackFinding {
  kind: "pull_back";
  id: string;
  message: string;
  call: number;
}

/** 守卫自己的"按规则退回"：联网开关关着时，要跑的脚本执行前没法检查（先用 write 写好再跑） */
export const SCRIPT_NOT_CHECKED = "script_not_checked";

export type GuardFinding = DispositionFinding | HardRefusalFinding | PullBackFinding;

export interface GuardJudgement {
  /**
   * 生效的硬拒绝：不为 null 时这次调用直接拒绝，不问用户、不出审批卡。
   * 硬拒绝优先于一切处置，只有两条底线例外：同时命中底线时按底线走，这里为 null，硬拒绝只作为附带原因留在 findings 里。
   */
  hardRefusal: HardRefusalId[] | null;
  /**
   * 生效的"按规则退回"（拉回）：时序规则的前提没满足、agent 自己能补救（先提交、先单独跑测试、先写好脚本再跑……），
   * 列出这些规则的 id（守卫自己的是 SCRIPT_NOT_CHECKED）。
   * 不为 null 时这次调用不执行，不问用户，给模型的说明写明怎么补救；它不是处置的一档，不算被判过"永不"，
   * 计入拉回次数（13、14 号票）。硬拒绝或"永不"同时生效时为 null（那两样更硬），原因仍留在 findings 里。
   */
  pullBack: string[] | null;
  /** 处置（六档之一）：各条处置依据取最严。hardRefusal、pullBack 不为 null 时调用不会执行，这里仍给出按处置会怎么判 */
  disposition: Disposition;
  /** 命中的关注类别 id（去重，按出现顺序） */
  categories: string[];
  /** 是否通用 bash */
  genericShell: boolean;
  /** 命中的时序规则 */
  temporalRules: TemporalRuleHit[];
  /** 是否属于授权内：会执行（没有硬拒绝、没有退回），并且有"计划里列了才做"的命中是靠授权项放行的 */
  withinGrant: boolean;
  /** 给模型的说明：命中了什么、为什么、接下来该怎么做 */
  explanation: string;
  findings: GuardFinding[];
  calls: JudgedCall[];
}
