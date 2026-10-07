// 守卫判定的输入和输出（规格第 9 节）。
// 输入：一次工具调用、发起的 agent 及其工具包、所属任务的计划、当前阶段和授权项、效果日志、
// 全局与本任务的关注类别设置、调用方现取后传入的环境事实、当前时间。
// 输出：处置、命中的关注类别、是否通用 bash、命中的时序规则、是否属于授权内、给模型的说明。
import type { GuardDisposition, Disposition } from "./disposition.ts";
import type { TemporalRule, TemporalRuleHit } from "./temporal-rules.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { WatchCategorySettings } from "./watch-categories.ts";

// ───────────────────────── 输入 ─────────────────────────

/** 一次工具调用：模型给出的工具名和参数（守卫从不原地改参数） */
export interface ToolCall {
  toolName: string;
  args: unknown;
}

/** 工具包里和判定有关的开关（ADR-0003） */
export interface ToolkitSwitches {
  bash: boolean;
  /** 联网开关。秘书不论传入什么，一律按关着判 */
  network: boolean;
}

/** 发起调用的 agent */
export type GuardAgent = SecretaryAgent | WorkerAgent;

export interface SecretaryAgent {
  kind: "secretary";
  agentId: string;
  /** 工作目录：相对路径的基准（固定在草稿区） */
  cwd: string;
  toolkit: ToolkitSwitches;
  /** 草稿区：秘书的文件工具只能写这里 */
  scratchDir: string;
}

/** 维护者或子 agent。子 agent 不能写项目档案 */
export interface WorkerAgent {
  kind: "maintainer" | "sub_agent";
  agentId: string;
  cwd: string;
  toolkit: ToolkitSwitches;
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
}

/** 调用所属的任务；对话里为 null */
export interface GuardTask {
  taskId: string;
  plan: GuardPlan;
  currentStageId: string;
}

/** 效果日志的一条：只有执行成功的调用才追加（规格第 9 节） */
export interface EffectRecord {
  seq: number;
  taskId: string | null;
  stageId: string | null;
  agentId: string;
  /** 工具或伪工具 */
  tool: string;
  /** 规范化参数（05 号票定规范化；本票按工具注册表的参数名） */
  args: Record<string, unknown>;
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
}

export interface FileFact {
  exists: boolean;
  isDirectory?: boolean;
  /** 真实路径（展开符号链接、目录联接和 8.3 短名）；给了就一并检查 */
  realPath?: string;
}

export interface GitFact {
  /** 有未提交改动的文件（绝对路径） */
  uncommittedPaths: string[];
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
  effectLog: readonly EffectRecord[];
  /** 全局的关注类别设置（数据目录配置区的注册表） */
  settings: WatchCategorySettings;
  facts: EnvironmentFacts;
  /** 工具注册表 */
  tools: ToolRegistry;
  /** 当前时间（毫秒），由调用方传入 */
  now: number;
  /** 时序规则（planguard 规则格式，05 号票接上引擎） */
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
}

/** 得出处置的一条依据 */
export interface GuardFinding {
  /** notify：工具带"做完告诉我"标记 */
  kind: "category" | "bottom_line" | "boundary" | "notify" | "temporal_rule";
  /** 关注类别 id、底线 id、硬边界 id、工具名或规则 id */
  id: string;
  /** 这条依据最终带来的处置（"计划里列了才做"已按授权项落成放行或先问） */
  disposition: GuardDisposition;
  /** 授权项改变了处置时，原来那一档 */
  tier?: Disposition;
  /** 放行它的授权项 */
  grantId?: string;
  message: string;
  /** 对应 `calls` 里的第几条 */
  call: number;
}

export interface GuardJudgement {
  /** 处置：各条依据取最严 */
  disposition: GuardDisposition;
  /** 命中的关注类别 id（去重，按出现顺序） */
  categories: string[];
  /** 是否通用 bash */
  genericShell: boolean;
  /** 命中的时序规则 */
  temporalRules: TemporalRuleHit[];
  /** 是否属于授权内：放行了，并且有"计划里列了才做"的命中是靠授权项放行的 */
  withinGrant: boolean;
  /** 给模型的说明：命中了什么、为什么、接下来该怎么做 */
  explanation: string;
  findings: GuardFinding[];
  calls: JudgedCall[];
}
