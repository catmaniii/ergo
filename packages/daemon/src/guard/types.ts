// 守卫判定的输入和输出。
// 输入：一次工具调用、发起的 agent 及其工具包、所属任务的计划、当前阶段和授权项、效果日志、
// 全局与本任务的关注类别设置、调用方现取后传入的环境事实、授权的文件夹和这个 agent 的目录授权、当前时间。
// 输出：硬拒绝、按规则退回、处置、命中的关注类别、是否通用 bash、命中的时序规则、是否属于授权内、给模型的说明。
import type { FolderGrantMode } from "@ergo/protocol";
import type { Disposition } from "./disposition.ts";
import type { ShellOrderStep } from "./shell/split.ts";
import type { TemporalRule, TemporalRuleHit } from "./temporal-rules.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { TaskWatchSettings, WatchCategorySettings } from "./watch-categories.ts";

// ───────────────────────── 输入 ─────────────────────────

/** 一次工具调用：模型给出的工具名和参数（守卫从不原地改参数） */
export interface ToolCall {
  toolName: string;
  args: unknown;
}

/** 工具包里和判定有关的部分（ADR-0003） */
export interface GuardToolkit {
  bash: boolean;
  /** 联网开关：关着时联网的工具和命令硬拒绝（秘书和别的 agent 一样按传入的判，秘书是开着的） */
  network: boolean;
  /**
   * 工具包给的工具（会话装配的工具白名单，bash 和带类型的 bash 工具由 bash 开关管）。
   * 传了就检查：不在里面的工具硬拒绝；不传表示由会话装配保证，这里不查。
   */
  tools?: readonly string[];
  /**
   * 会话跑在自带工具的运行时上（Claude Code）：运行时自带、二狗没装配的工具不按工具白名单硬拒绝——登记表里来源是 runtime 的
   * 照登记判，没登记的（用户自己配的 MCP、运行时以后加的工具）照"未登记的写操作"判。能对上二狗工具的（Bash → bash、Write → write……）
   * 照旧按白名单和 bash 开关（起草计划时没有 write，Claude 的 Write 一样硬拒绝）。pi 的会话不带
   */
  runtimeTools?: true;
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

/** 干活的 agent：负责人或子 agent。子 agent 不能写项目档案 */
export interface ExecutingAgent {
  kind: "maintainer" | "sub_agent";
  agentId: string;
  cwd: string;
  toolkit: GuardToolkit;
  /** 项目档案（单项目一个；任务负责人是任务自己的档案） */
  projectRecords: string[];
  /** 工作目录（含绑定的外部路径） */
  workingDirs: string[];
  /**
   * 它的 bash 起的进程带着的、值已知的环境变量（事件触发的流程这次运行的事件的值）：拆 bash 命令时按值展开（paths.ts 的 agentShellEnv）
   */
  shellVars?: Readonly<Record<string, string>>;
  /**
   * 它的 Git Bash 里 `/tmp` 挂到的 Windows 目录：Git Bash 的挂载表在同一个用户的所有 Git Bash 进程之间共用，
   * `/tmp` 跟着第一个起来的那个进程的 TMP / TEMP；二狗起的 bash 进程本身的 TMP / TEMP 都是守护进程的那一份，守护进程按它给。
   * 拆 bash 命令时 `/tmp` 按它解析（在项目外，但不再算没法确定）；不给照旧算没法确定
   */
  bashTmp?: string;
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
    /** skill 区：受保护（只由运行时写，用户导入、负责人提交走确认卡） */
    skills?: string;
  };
  /** 二狗程序目录：受保护 */
  programDir: string;
  /** 用户主目录：展开 `~`、`$HOME` 用 */
  homeDir: string;
  /**
   * 二狗自己的端口：守护进程实际监听的本机端口和外网端口（测试里是随机挑的，由守护进程传进来，不写死 8810、8811）。
   * 发往本机这两个端口的请求不算"发往本机、不算对外"的例外；用浏览器工具打开这两个端口的页面也算"以我的名义对外发送或发布"
   */
  ownPorts: readonly number[];
  /**
   * 服务管家（托管二狗自己的那一个）：守卫防 agent 用 bash 停掉二狗、杀掉服务管家（419）。不给就不认服务管家的数据目录和端口
   * （跑它的命令行、ergo 的停止重启升级、杀进程照样认）
   */
  supervisor?: GuardSupervisor;
}

/** 服务管家在守卫眼里：数据目录（受保护）和管理器端口 */
export interface GuardSupervisor {
  /**
   * 服务管家的数据目录（真实路径）：注册表（registry/）、运行状态（state.json、tailnet-routes.json）写入一律永不，
   * .secrets/ 是它的密钥区（连读都拒绝）；日志等别的照常
   */
  dataDir: string;
  /**
   * 管理器端口：现取的（EnvironmentFacts.supervisorPorts）没给时用它——守护进程起来时读的 manager.yaml 的 port（没有是 7420），
   * 加上拉起守护进程的那个管理器的（LSM_URL 里的端口；数据目录没告诉二狗、读错了地方时靠它）
   */
  ports: readonly number[];
}

/**
 * 受保护的进程（杀进程时判定用）：调用方判定前现取（lsm/guard-facts.ts）——守护进程自己、服务管家（state.json 记的 manager.pid）、
 * 命脉服务（二狗自己的登记、它的公网隧道 exposure.via、tailnet 网关；state.json 记的 pid）
 */
export interface ProtectedProcess {
  pid: number;
  /** 可执行文件名（node.exe、ssh.exe）；取不到不写 */
  exe?: string;
  /** daemon：守护进程；manager：服务管家；service：命脉服务（service 是它的 id） */
  role: "daemon" | "manager" | "service";
  service?: string;
}

/** 杀进程时判定要的事实（EnvironmentFacts.processes） */
export interface ProcessFacts {
  protected: readonly ProtectedProcess[];
  /**
   * 受保护的进程都取到了：服务管家的 state.json 在但读不了、没记管理器的进程号时是 false——这时按进程号、按名字杀的，
   * 不在已知名单里的也判不准，按"接近底线"先问
   */
  complete: boolean;
  /**
   * 受保护的进程的上级进程（父进程、父进程的父进程……，创建时间早于下级的才算，免得认到复用了进程号的别的进程）：
   * 连同子进程一起杀（taskkill /T）杀到它就连带杀到受保护的进程；不带 /T 的杀它看不准，先问
   */
  ancestors?: ReadonlyArray<{ pid: number; exe?: string; of: number }>;
}

/** 授权项：操作种类 + 对象范围 + 次数 + 所属阶段 + 有效期 */
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
  /**
   * 只放行从这条通用 bash 命令拆出来的调用（流程里通用 bash 的步骤，授权限定到命令本身）；
   * 不填表示不限是怎么调用的。比较时只去掉首尾空白（grants.ts 的 commandKey）
   */
  command?: string;
  /**
   * 只认对象范围里写了的参数：调用多带了范围里没有的参数（值不是空的）就超出（流程里非 bash 的步骤推出的授权项，
   * 步骤里没写的参数不受授权）
   */
  exactArgs?: true;
  /**
   * 路径类参数的真实路径（规划时解析：展开符号链接、目录联接、8.3 短名）：调用里的路径在判定前现取的真实路径也要落在它里面，
   * 取不到的不算在范围内（流程的步骤推出的授权项按真实路径比）。对象范围里还是写的路径，两样都要对得上
   */
  realScope?: Record<string, string | string[]>;
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
  /** 本任务要提醒的关注类别（确认计划时的快照）：只在全局设置之上增加，判定时和当前的全局设置取最严 */
  watchCategories?: TaskWatchSettings;
  /** 各阶段挂的时序规则和所属阶段组（只列和判定有关的部分） */
  stages?: GuardStage[];
  /** 阶段组：共用的时序规则套给组里的每个阶段 */
  stageGroups?: GuardStageGroup[];
  /** 流程：用户已授权的那份计划的步骤，执行时每次调用和它比对（plan-monitor.ts）；长程任务没有 */
  workflow?: GuardWorkflow;
}

/** 流程计划里的一步（审查修补后的）：守卫执行时比对用 */
export interface GuardWorkflowStep {
  id: string;
  title: string;
  tool: string;
  /** 负责人写的参数（照原样，相对路径按工作目录解析） */
  args: Readonly<Record<string, unknown>>;
  /** 前置步骤 */
  after: readonly string[];
  /** 审查修补时从这一步的数组参数里剔除的对象（参数名 → 剔除的值）：执行时再碰它们直接拦下 */
  excluded?: Readonly<Record<string, readonly unknown[]>>;
  /** 这一步（连同剔除的对象）里的路径规划时现取的真实路径（解析成的绝对路径 → 真实路径）：执行时按真实路径比，取不到的对不上 */
  realPaths?: Readonly<Record<string, string>>;
}

/** 流程的计划在守卫眼里：哪一版、目标、步骤，连同负责人说明跳过的步骤（report_step skipped） */
export interface GuardWorkflow {
  planId: string;
  goal: string;
  steps: readonly GuardWorkflowStep[];
  skipped: readonly string[];
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

/**
 * 判一次调用时运行时交给"调用所属的任务"的取法的：发起调用的 agent、它的工具注册表、用户主目录。
 * 事件触发的流程每次运行按它现取代入了事件的值之后的路径的真实路径、推出这次运行的授权项
 */
export interface GuardTaskContext {
  agent: GuardAgent;
  tools: ToolRegistry;
  homeDir: string;
}

/** 调用所属的任务；对话里为 null */
export interface GuardTask {
  taskId: string;
  plan: GuardPlan;
  currentStageId: string;
  /**
   * 任务此刻从某个阶段重做过几次（Task.reworks，重开时的 generation）：效果日志记下判定那一刻的值，
   * 重做之前判定、结束得晚的调用的效果不算进新的一轮。没重做过的不写
   */
  reworkNo?: number;
  /**
   * 不是任务、但带着自己的授权的一段（定时作业的一次运行带着作业的授权项、时序规则、本任务的关注类别）：
   * 按任务的那一套判（计划里列了才做的看授权项），但效果日志、时序规则、授权项的次数只看这一段会话（segmentId），
   * 调用和效果的归属里没有任务（taskId 是作业 id，只给规则里的 $task 用）
   */
  segmentScoped?: true;
}

/** 调用、效果归属的任务：真的任务才算（带着授权的会话段不算，见 GuardTask.segmentScoped） */
export function attributedTask(task: GuardTask | null | undefined): GuardTask | null {
  return task && !task.segmentScoped ? task : null;
}

/**
 * 效果日志的一条：只有执行成功的调用才追加。用 effectRecordsFor(input, judgement, …) 生成：
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
  /** 会话段（秘书会话、负责人的工单段或对话段）：不属于任务的调用，时序规则只看同一段里的效果 */
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
  /** 从 bash 拆出、拿到了守卫看不见的输入（JudgedCall.unseenInput）：规则里的 $prior.outward 照它算 */
  unseenInput?: true;
  /**
   * 哪次调用产生的（模型给的调用 id，记；详情页按它找一次调用的效果）。通用 bash 拆出来的几条是同一个。
   * 之前的记录没有：紧跟在那次调用的记录后面（guard-runtime/effect-log.ts 的 effectsOfCall）。彻底删除时去掉
   */
  callId?: string;
  /** 判定这次调用时任务重做过几次（GuardTask.reworkNo）：阶段的 reopenNo 比它大的，这条是重开之前那一轮的；没有就是 0 */
  reworkNo?: number;
  /**
   * 这次调用新建的路径：要写的路径参数（access 为 write）里，判定前现取的环境事实说它还不存在的（exists 为 false）。
   * 守卫据此认任务、项目自己的临时文件（GuardOwnWork）；之前的记录没有，彻底删除时去掉
   */
  created?: string[];
}

/**
 * 临时文件怎么认（"覆盖和删除的限制，只对系统已有的资源、数据、配置以及项目阶段交付件"，
 * 又补充"任务和项目的临时文件都是一样的"）：按发起调用的 agent 所属的范围给——
 * - 项目里（项目的负责人：直接和用户对话、做工单、做内部任务、定时运行，和它派的子 agent）：按项目，项目开始之后生成的、
 *   不是交付件的都算项目的临时文件，不要求是哪一个任务建的；
 * - 项目外的任务（任务自己的负责人执行、定时 / 事件触发的运行、子 agent、普通任务的 agent）：按这个任务。
 * 秘书、项目外任务的起草计划不给。删除、整体重写临时文件不落入"删除或覆盖"，也不受 v1 模板"删除或覆盖之前必须已备份或已提交"约束。
 * 认法见 own-temp.ts；不给就没有临时文件，一切照旧
 */
export interface GuardOwnWork {
  /**
   * 范围开始的时间（毫秒）：创建时间晚于它的文件才算开始之后才有的。项目外的任务是第一次进执行中或运营中；
   * 项目是立项（建出项目）的时候，工作目录绑定了外部路径的是绑定（立项书确认）的时候
   */
  startedAt: number;
  /**
   * 交出去了的阶段的交付件写到的路径（从交付件的文字里认出来的，照写的原样；相对路径按 agent 的工作目录解析）：
   * 它们（是目录的连同里面的东西）不论什么时候建的都算交付件。项目里是项目里各任务的
   */
  deliverables: readonly string[];
  /**
   * 按交出去的时间认的交付件：dir 里那时已经有了的算交付件。dir 是任务的产出区（outputs/<任务 id>）；不写 dir 是 agent 的工作目录
   * （交出去了的交付件认不出路径时：认不准就当交付件）。at 是最近一次交出去的时间（宣布阶段完成、任务做完、定时 / 事件触发的一次运行结束），
   * 不写是不论什么时候（记不起交出去的时间时）
   */
  handovers: ReadonlyArray<{ dir?: string; at?: number }>;
}

/** 环境事实：调用方现取后传入，判定函数自己不读文件、不跑命令 */
export interface EnvironmentFacts {
  /** 文件元数据，键是绝对路径（大小写、分隔符不敏感） */
  files?: Record<string, FileFact>;
  /** git 状态，键是仓库根目录（"当下必须满足某条件"用） */
  git?: Record<string, GitFact>;
  /** 要跑的脚本扫描结果，键是脚本的绝对路径 */
  scripts?: Record<string, ScriptFact>;
  /**
   * 读过的密钥值：这个任务（不属于任务的是这一段会话）里 agent 读过的 .env 和密钥文件里的值（secret-files.ts 的 secretValuesIn），
   * 出现在对外内容里就是"把凭据写进对外内容"（secrets.ts）。调用方只放在内存里；判定的说明里从不带出值本身
   */
  secretValues?: readonly string[];
  /**
   * 带通配符的路径展开成的现有路径（guard-runtime/facts.ts 用 util/wildcards.ts 的 expandWildcards 现取），
   * 键是带通配符的绝对路径（大小写、分隔符不敏感）；展不开的是通配符之前那段目录。没给的，判定时按通配符之前那段目录算
   */
  wildcards?: Record<string, readonly string[]>;
  /** 服务管家此刻的端口（manager.yaml 现读，加上 LSM_URL 里的）；不给按 GuardPlaces.supervisor.ports */
  supervisorPorts?: readonly number[];
  /** 受保护的进程（有杀进程的调用时现取）；不给是取不到：按进程号、按名字杀的都判不准，按"接近底线"先问 */
  processes?: ProcessFacts;
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
   * 项目档案里的文件被整体重写或删除前，运行时会自动留一份旧版本，所以对项目档案里的文件传 true
   */
  backedUp?: boolean;
  /**
   * 创建时间（毫秒，stat 的 birthtime）：认这个任务开始之后才有的文件（脚本里间接生成、守卫没看见的也认得出）。
   * 调用方给了 GuardOwnWork 时才取；读不到不写（认不出的按已有的算）
   */
  createdAt?: number;
  /**
   * 要删除的目录里面有什么（递归、不跟进链接）：每一项的路径和创建时间。complete 为 false 是太多、读不全或者里面有链接
   * （符号链接、目录联接），这时不算任务、项目自己的临时文件。调用方给了 GuardOwnWork、要删除的是目录时才取
   */
  contents?: DirContents;
}

/** 一个目录里面有什么（FileFact.contents） */
export interface DirContents {
  entries: ReadonlyArray<{ path: string; createdAt?: number }>;
  complete: boolean;
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
  /** 只连本机的：用到了能联网的库，但脚本里写的地址都是本机。不算联网，联网开关关着也能跑；没有就不写 */
  localOnly?: string[];
  /**
   * 脚本里写着的绝对路径（guard 的 absolutePathsIn；尽力而为）。看不出读还是写，按拆不开算：写着密钥区里的路径判"永不"，
   * 写着别的受保护区域里的路径落入"未知的写操作"（先问用户）
   */
  mentionedPaths?: string[];
}

export interface GuardInput {
  call: ToolCall;
  agent: GuardAgent;
  places: GuardPlaces;
  /** 所属任务；对话里为 null */
  task: GuardTask | null;
  /** 这次调用所在的会话段（秘书会话、负责人的工单段或对话段），追加效果日志时记进去 */
  segmentId?: string;
  /**
   * 效果日志。时序规则只看范围之内的：任务里只看同一个任务的；不属于任务的只看同一个 agent、同一段会话的
   * （负责人会话跨工单延续，一次读 .env 不能永久生效）。按这个范围传，判定时也再过滤一遍。
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
  /**
   * 同一任务里被判过"永不"的对象（控制器的硬检查，neverObjectsOf 给出）：再对它们做对外动作至少先问。
   * 对话里不传
   */
  neverObjects?: readonly string[];
  /**
   * 对话审批的开关（配置 guard.conversationApprovals，默认 off；改了 off 的范围）。
   * on：一切照原样（"先问我"出审批卡，任务里按计划授权核对）。off：
   * - 秘书：大部分"先问我"按"直接做"（依据记 approvalsOff），含判断不了的（keepAsking）；特别敏感的照旧要用户授权——以我的名义
   *   对外发送或发布、账户与安全、不可逆的提交（SECRETARY_ASKS），和写草稿区之外（writesOutsideScratch：文件工具写草稿区外原来是
   *   硬拒绝，改成先问用户；bash 确定要写、删的路径在草稿区外）；
   * - 别的 agent（任务的负责人、定时 / 事件触发的运行、子 agent、评审子 agent、项目负责人，起草计划和对话段也一样）：超出授权的
   *   一律不拦——"先问我"、"计划里列了才做"没被授权项覆盖的、判断不了的（含时序规则判断不了的）、对被判过"永不"的对象再做对外动作，
   *   都按"直接做"（依据记 beyondGrant），用到别的阶段的授权项也不拉回；任务里判断出来确实违反、要问的时序规则照旧问。
   * 两边都不变的：三条硬底线（写受保护区域、读密钥区、已经确定要把密钥内容往外送）、硬拒绝、永不、交给我做、做完告诉我、
   * 时序规则的按规则退回；可能碰到硬底线、原来靠"先问"兜着的（nearBottomLine）照旧问。流程的逐步核对在守卫接入里（plan-check.ts）：计划外会改东西的、超出步骤写的对象要问的，任务的 agent
   * 也按直接做；步骤先后、自动纠偏照旧。
   * 不传按 on（判定函数本身从严，守卫接入和计划外工单的判定按配置传）
   */
  conversationApprovals?: ConversationApprovals;
  /**
   * 临时文件怎么认（见 GuardOwnWork）：项目的 agent 按项目、项目外任务的 agent 按任务给。删除、整体重写开始之后才有的、
   * 不是交付件的文件不落入"删除或覆盖"、不受 v1 模板"删除或覆盖之前必须已备份或已提交"约束；不给一切照旧
   */
  ownWork?: GuardOwnWork;
  /**
   * 授权的文件夹（用户在设置里授权的那一份，调用方判定前现读，连同它们的真实路径：guard-runtime/facts.ts 的 authorizedFolderRoots）：
   * 文件工具和 bash 的读，真实路径落在这里面的不算越出项目目录，计划比对也不算越界。只放开读：写、删、覆盖、跑里面的脚本、git、cd 进去都照旧；
   * 密钥区、受保护区域、整个数据目录、密钥文件就算在这里面也不算；取不到真实路径的不算。不给就没有
   */
  authorizedFolders?: readonly string[];
  /**
   * 这个 agent 的目录授权表（ADR-0049：秘书、项目的负责人、任务的负责人各有一份，调用方判定前现读；没登记也给空的）。
   * 文件工具和 bash 拆出来的读、写、删，目标的真实路径落在登记目录里、做的是登记了的那种操作的，不落入"越出项目目录"
   * （文件工具写围栏外也不再硬拒绝）；没登记的那种操作照旧。登记目录里名字像密钥的文件读写一律硬拒绝（secret_file）。
   * 受保护区域、整个数据目录、项目档案的历史区、备用数据流就算在登记目录里也不算；过期的不算。
   * 不给是这个 agent 没有表（子 agent、评审、记忆管理员）：判定和说明都和以前一样
   */
  folderGrants?: readonly GuardFolderGrant[];
}

/**
 * 这个 agent 的一条目录授权（ADR-0049，folders/folder-grants.ts）：调用方判定前现读这个 agent 自己那一份交进来
 */
export interface GuardFolderGrant {
  grantId: string;
  /**
   * 登记的目录：登记时取的真实路径。判定时不再现取它的真实路径——登记之后被换成链接、目录联接的，
   * 里面的东西按真实路径比就不在它里面了
   */
  dir: string;
  /** 登记了的操作：读、写、删（删除单独登记，不带写） */
  modes: readonly FolderGrantMode[];
  /** 到期时间（毫秒）；不给是长期有效。到了（now 不早于它）就算过期 */
  expiresAt?: number;
}

/** 因为目录授权放开的一处：哪条授权、登记的目录、碰到的路径（解析出的绝对路径）、哪种操作、第几条调用 */
export interface FolderGrantUse {
  grantId: string;
  dir: string;
  path: string;
  mode: FolderGrantMode;
  call: number;
}

/**
 * 对话里因为越出项目目录要问、登记了就会放开的一处（审批卡上"以后都允许"据此登记）：碰到的路径、它的真实路径、
 * 是不是目录（调用方现取的环境事实）、要的操作、第几条调用
 */
export interface FolderGrantCandidate {
  path: string;
  realPath: string;
  isDirectory: boolean;
  mode: FolderGrantMode;
  call: number;
}

/** 对话里的审批开不开：on 是原来的样子（先问我出审批卡），off 是先问我按直接做 */
export const CONVERSATION_APPROVALS = ["off", "on"] as const;
export type ConversationApprovals = (typeof CONVERSATION_APPROVALS)[number];

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
  /** 从 bash 拆出时，这条命令拿到了守卫看不见的输入（管道喂来的标准输入、没法静态确定的词……，见 shell/split.ts 的 ShellCall） */
  unseenInput?: true;
  /** 从 bash 拆出时，这次"读"不只是读（cd 进去、别的程序的路径参数、awk -f，见 shell/split.ts 的 ShellCall）：读授权的文件夹不算它 */
  notJustRead?: true;
  /** 从 bash 拆出时，它的路径是写着 `..` 解析出来的（见 shell/split.ts 的 ShellCall）：读授权的文件夹不算它 */
  parentDir?: true;
}

/**
 * 硬拒绝（Hard Refusal）的原因：守卫对越出能力或边界的调用的直接拒绝，不问用户，批准和授权项都改变不了。
 * 它不是处置的一档。
 * - fence：文件工具写路径围栏外；
 * - secrets_area：碰数据目录的密钥区（连读都拒绝）；
 * - network_off：联网开关关着时联网；
 * - no_bash：工具包没开 bash（含带类型的 bash 工具）；
 * - not_in_toolkit：工具包没给这个工具；
 * - sub_agent_records：子 agent 写项目档案（文件工具和 bash 都算）；
 * - secret_file：碰目录授权的登记目录里名字像密钥的文件（读、写、删都算，ADR-0049）；
 * - supervisor：绕过服务管家工具碰服务管家——往它的端口发不是查询的请求、跑它的命令行（lsm、packages/supervisor/bin 里的脚本）、
 *   ergo 的停止、重启、升级、回退、卸载和 svc（419）。
 */
export type HardRefusalId = "fence" | "secrets_area" | "network_off" | "no_bash" | "not_in_toolkit" | "sub_agent_records" | "secret_file" | "supervisor";

/** 一条处置依据 */
export interface DispositionFinding {
  /**
   * protected_area：写受保护区域（永不）；notify：工具带"做完告诉我"标记；
   * never_object：对外动作的对象在这个任务里被判过"永不"（先问）；
   * process：杀进程（419）——杀到二狗自己、服务管家、命脉服务的永不（id protected_process），别的先问（id kill_process）
   */
  kind: "category" | "bottom_line" | "protected_area" | "notify" | "temporal_rule" | "never_object" | "process";
  /** 关注类别 id、底线 id、受保护区域、工具名或规则 id */
  id: string;
  /** 这条依据带来的处置（"计划里列了才做"已按授权项落成放行或先问） */
  disposition: Disposition;
  /** 授权项落定了"计划里列了才做"时，类别本身的处置 */
  categoryDisposition?: Disposition;
  /** 对话审批关着：秘书本来"先问我"的，按"直接做"放行了 */
  approvalsOff?: true;
  /**
   * 对话审批关着时，非秘书的 agent（任务的 agent）超出授权的，先不管、按"直接做"放行了：本来"先问我"的，
   * 含"计划里列了才做"没被授权项覆盖的（偏离程度 deviation 留着）、判断不了的（keepAsking）
   */
  beyondGrant?: true;
  /**
   * 牵涉密钥和受保护区域、判断不了的：要写（或看不出读写）的路径没法确定（可能落在受保护区域里）、
   * "读过 .env 或密钥文件之后不许往外送""对外内容不许含密钥"判断不了、脚本里写着受保护区域的路径。原来对话审批关着也照旧先问；
   * （现阶段安全不要搞得太敏感）起关着时只作标记留在依据上；其中可能碰到硬底线的（要写的路径没法确定、
   * 脚本里写着受保护区域的路径、确实读过密钥之后判断不了的）另标 nearBottomLine，照旧问
   */
  keepAsking?: true;
  /**
   * 秘书要写的地方在草稿区之外：文件工具写草稿区外（对话审批开着时是硬拒绝"围栏"），bash 确定要写、删草稿区外的路径，
   * 删除或覆盖的路径没法确定（可能在草稿区外）。对话审批关着时这一条照旧要用户授权（秘书特别敏感的操作之一）
   */
  writesOutsideScratch?: true;
  /** 时序规则判断不了：对话审批关着时任务的 agent 按直接做；判断出来确实违反的没有它 */
  ruleUnknown?: true;
  /**
   * 可能碰到硬底线：守卫看不准、原来靠"先问"兜着的写法——带通配符的路径可能落在受保护区域里、看不透的命令里
   * 写着数据目录或受保护区域的路径、确实读过 .env 或密钥文件之后看不透可能往外送的调用；可能停掉二狗、杀掉服务管家的（419）：
   * 要杀的进程看不准、看不透的命令里写着杀进程、服务管家的端口或命令行、用浏览器打开服务管家的页面、动它的计划任务。
   * 对话审批关着时秘书和任务的 agent 都照旧先问
   */
  nearBottomLine?: true;
  /** "以我的名义对外发送或发布"这一条只因为发往本机（127.0.0.1、localhost、::1）的请求命中：秘书的特别敏感不算它 */
  localTarget?: true;
  /** 这个类别是因为哪些参数命中的：授权项的对象范围要管到这些参数才能放行它 */
  objectArgs?: string[];
  /** 放行它的授权项 */
  grantId?: string;
  /**
   * "计划里列了才做"而没有授权项覆盖时，这一处偏离计划到什么程度：
   * exceeds_grant 超出授权（计划对这个类别有授权项，但这次超出了对象范围、次数或有效期）；
   * unanticipated 没预料到的类别（计划里完全没有这个类别的授权项）
   */
  deviation?: PlanDeviation;
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
 * SCRIPT_NOT_CHECKED（联网开关关着时，要跑的脚本执行前没法检查：还不存在、读不了或看不出是哪个，比如同一条命令里现写现跑）、
 * GRANT_OTHER_STAGE（用到的授权项属于别的阶段）
 */
export interface PullBackFinding {
  kind: "pull_back";
  id: string;
  message: string;
  call: number;
}

/** 守卫自己的"按规则退回"：联网开关关着时，要跑的脚本执行前没法检查（先用 write 写好再跑） */
export const SCRIPT_NOT_CHECKED = "script_not_checked";

/**
 * 守卫自己的"按规则退回"（控制器的硬检查"授权只在所属阶段内有效"）：用到的授权项属于别的阶段，
 * 不按授权放行，也不问用户，拉回当前阶段
 */
export const GRANT_OTHER_STAGE = "grant_other_stage";

export type GuardFinding = DispositionFinding | HardRefusalFinding | PullBackFinding;

/**
 * 任务里偏离计划的分级：授权内的只记一笔（withinGrant），
 * 超出授权（exceeds_grant）先问用户，没预料到的类别（unanticipated）先问用户并暂停这一支
 */
export type PlanDeviation = "exceeds_grant" | "unanticipated";

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
   * 计入拉回次数。硬拒绝或"永不"同时生效时为 null（那两样更硬），原因仍留在 findings 里。
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
  /**
   * 偏离计划的程度：处置是"先问我"、并且有"计划里列了才做"的命中没被授权项覆盖时才有——
   * 有一处是没预料到的类别就是 unanticipated（问用户并暂停这一支），否则 exceeds_grant（问用户）。
   * 硬拒绝、按规则退回、"先问我"类别本身、对话里都是 null
   */
  deviation: PlanDeviation | null;
  /**
   * 这次调用整个就是读授权的文件夹：拆出来的每一条都只是看（读、列、搜，只看的命令），没有命中任何关注类别，
   * 至少有一处读的是授权的文件夹。流程执行时的计划比对据此不算计划外、超范围（plan-monitor.ts）。不是的不写
   */
  authorizedRead?: true;
  /** 因为这个 agent 的目录授权放开的路径（执行了就记使用记录）；没有的不写 */
  folderGrantUses?: FolderGrantUse[];
  /** 越出项目目录、登记了就会放开的路径（对话里审批卡上的"以后都允许"据此登记）；没有的不写 */
  folderGrantCandidates?: FolderGrantCandidate[];
  /** 给模型的说明：命中了什么、为什么、接下来该怎么做 */
  explanation: string;
  findings: GuardFinding[];
  calls: JudgedCall[];
}
