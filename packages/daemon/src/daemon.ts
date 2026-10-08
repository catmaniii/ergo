// 守护进程的组装：读配置、找到数据目录、打开事件存储、建 Job 对象、立起 agent 管家和秘书、
// 任务和维护者（12 号票）、项目和项目的维护者（15 号票）、token 账本（24 号票）、开本机端口和外网端口（设备配对在 10 号票）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, UNFINISHED_TASK_STATES } from "@ergou/protocol";
import { activityView, createActivityLog } from "./activity/activity.ts";
import { createAgentManager, type AgentManager } from "./agent-manager/agent-manager.ts";
import type { HostTool } from "./agent-manager/host-tools.ts";
import { approvalCardType, type ApprovalService, createApprovalService } from "./approvals/approvals.ts";
import { approvalDecisionPurge, approvalDecisionSource, approvalRequestPurge } from "./approvals/material-source.ts";
import { approvalsView } from "./approvals/views.ts";
import { type BackupService, createBackupService } from "./backup/backup.ts";
import type { SnapshotFiles } from "./backup/files.ts";
import { viewBoardTool } from "./board/tool.ts";
import { cardPurge, type CardService, createCardService } from "./cards/cards.ts";
import { type CardTypeDefinition, CardTypeRegistry } from "./cards/registry.ts";
import { cardsView } from "./cards/views.ts";
import { isPlaceholder, loadConfig, modelVision, readTokenPrices, type ErgouConfig } from "./config/config.ts";
import { dataDirLayout, type DataDirLayout } from "./config/data-dir.ts";
import { modelCredentials } from "./config/secrets.ts";
import { messagePurge } from "./conversation/purge.ts";
import { createStreamHub } from "./conversation/stream-hub.ts";
import { conversationViews } from "./conversation/views.ts";
import { createEphemeralBus } from "./events/ephemeral.ts";
import { type EventStore, openEventStore } from "./events/event-store.ts";
import { startGateway } from "./gateway/gateway.ts";
import { createHttpApi } from "./gateway/http-api.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardPlaces } from "./guard/index.ts";
import { effectLogView, effectRecordPurge } from "./guard-runtime/effect-log.ts";
import { executionPurges, executionsView, interruptedToolResults } from "./guard-runtime/executions.ts";
import { createGuardRuntime, type GuardRuntime } from "./guard-runtime/guard-runtime.ts";
import { createHandOverService } from "./hand-over/hand-over.ts";
import { createInboxService, type InboxService, inboxItemPurge } from "./inbox/inbox.ts";
import { inboxTools } from "./inbox/secretary-tools.ts";
import { createTokenLedger, ledgerView, type TokenLedger } from "./ledger/index.ts";
import { createMaintainers, userMessageScope } from "./maintainers/maintainers.ts";
import { inboxView } from "./inbox/views.ts";
import { openMediaStore } from "./media/media-store.ts";
import { cardSignalPurge, createBgeM3Embedder, type Embedder, type Materials, openMaterials, rememberCommandPurge } from "./materials/index.ts";
import {
  createBulkMaterialDeletion,
  memoryCommandExecutors,
  memoryDeleteCardType,
  PurgeRewriters,
  searchMaterialsTool,
  sessionRewriteFor,
  startPurgedMediaCleanup,
} from "./memory/index.ts";
import { pairingCardType } from "./pairing/card.ts";
import { charterCardType, suggestProjectCardType } from "./projects/cards.ts";
import { createProjectMaintainers, type ProjectMaintainers } from "./projects/maintainers.ts";
import { charterDecisionSource, charterPurges } from "./projects/material-sources.ts";
import { createProjectService, type ProjectService } from "./projects/projects.ts";
import { isAutoVersioned, preserveVersions } from "./projects/records.ts";
import { readProjectRecordsTool } from "./projects/records-tool.ts";
import { suggestProjectTool } from "./projects/tools.ts";
import { projectsView } from "./projects/views.ts";
import { createPairingService, type PairingService } from "./pairing/pairing.ts";
import { pairingView } from "./pairing/views.ts";
import { reminderCardType } from "./reminders/card.ts";
import { createReminderService, type ReminderService } from "./reminders/reminders.ts";
import { reminderTools } from "./reminders/tools.ts";
import { remindersView } from "./reminders/views.ts";
import { daemonBusy, mayChangeBusy } from "./lsm/busy.ts";
import { linkToLsm, type LsmLink } from "./lsm/link.ts";
import { buildChildEnv } from "./process/child-env.ts";
import { daemonRunning, removePidFile, writePidFile } from "./process/pid-file.ts";
import { createJobObject, type JobObject } from "./process/job-object.ts";
import { recoverAfterRestart, scanBeforeStart } from "./recovery/recovery.ts";
import {
  createQuickActionService,
  operationRecordPurge,
  proposeQuickActionTool,
  quickActionCardType,
  type QuickActionExecutor,
  QuickActionRegistry,
  type QuickActionService,
  quickActionToolName,
} from "./quick-actions/index.ts";
import type { ModelSpec } from "./runtime/index.ts";
import { type Clock, clockIso, systemClock } from "./scheduler/clock.ts";
import { createInternalJobs, type InternalJobs, internalJobsView } from "./scheduler/internal-jobs.ts";
import { createScheduler, type Scheduler } from "./scheduler/scheduler.ts";
import { type Secretary, startSecretary } from "./secretary/secretary.ts";
import { planCardType, questionsCardType, suggestTaskCardType } from "./tasks/cards.ts";
import { runAcceptanceScript } from "./tasks/acceptance.ts";
import { createTaskExecution, type TaskExecution } from "./tasks/execution.ts";
import { taskControlActions } from "./tasks/task-control.ts";
import { allAccepted, taskMessageScope } from "./tasks/stages.ts";
import {
  clarificationAnswerSource,
  outputReactionPurge,
  outputReactionSource,
  planDecisionSource,
  startTaskRequestSource,
  taskOutcomeSource,
  taskWaitNotePurge,
} from "./tasks/material-sources.ts";
import { progressCardType } from "./tasks/progress-card.ts";
import { createReviewer } from "./tasks/review.ts";
import { parallelCardType } from "./sub-agents/card.ts";
import { parallelDecisionPurge, parallelDecisionSource } from "./sub-agents/material-source.ts";
import { createSubAgents, type SubAgents } from "./sub-agents/sub-agents.ts";
import { subAgentsView } from "./sub-agents/views.ts";
import { taskTools } from "./tasks/secretary-tools.ts";
import { createTaskService, type TaskService } from "./tasks/tasks.ts";
import { tasksView } from "./tasks/views.ts";
import { createTypedShell, type ShellToolkit } from "./typed-shell/index.ts";
import { realPathOf } from "./util/real-path.ts";
import { createHolidayUpdates, createWorkdayCalendarService, type HolidayUpdates, type WorkdayCalendarService, workdayCalendarAction } from "./workday/index.ts";
import { createWatchCategoryService, type WatchCategoryService } from "./watch-categories/watch-categories.ts";
import {
  createProcessRecognizer,
  createVoiceService,
  RECOGNIZER_ENV,
  RECOGNIZER_HINT,
  RECOGNIZER_SCRIPT,
  unavailableRecognizer,
  voiceMaterialSource,
  voicePurge,
  voicePurgeTargets,
  type VoiceService,
  voicesView,
} from "./voice/index.ts";

/** 秘书的模型：DeepSeek V4.1 Flash，显式设置思考档位（规格第 1、7 节） */
export const SECRETARY_MODEL: ModelSpec = { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" };

/** 维护者的模型：同样是 DeepSeek V4.1 Flash（规格第 1 节） */
export const MAINTAINER_MODEL: ModelSpec = { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" };

/** Web UI 的构建产物（npm run build:web 生成 packages/web/dist/index.html） */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));

/** 评审子 agent 的模型：和维护者一样（规格第 1 节） */
export const REVIEWER_MODEL: ModelSpec = MAINTAINER_MODEL;

/** 一条验收脚本最多跑多久 */
const ACCEPTANCE_SCRIPT_TIMEOUT_MS = 10 * 60_000;

/** 同一个数据目录已经有守护进程在运行：这次不启动（message 写明是哪个） */
export class DaemonAlreadyRunning extends Error {}

/** 守护进程的版本（报给 LSM） */
const DAEMON_VERSION = (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** 二狗程序目录（仓库的检出目录）：守卫的受保护区域之一 */
export const DEFAULT_PROGRAM_DIR = fileURLToPath(new URL("../../../", import.meta.url));

/** 真实路径（取不到就原样） */
const real = (p: string) => realPathOf(p) ?? p;

export interface StartDaemonOptions {
  /** 守护进程自己的环境（通常是 process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /** 用户主目录（通常是 os.homedir()），用来算默认的数据目录 */
  homeDir: string;
  /** 本机端口；不填用配置里的 ports.local。测试传 0，由系统挑一个空闲端口 */
  localPort?: number;
  /** 外网端口（隧道的目标）；不填用配置里的 ports.external。测试传 0，由系统挑一个空闲端口 */
  externalPort?: number;
  /** WebSocket 心跳的间隔（毫秒）；不填 30 秒。测试调短，测半开连接 */
  heartbeatIntervalMs?: number;
  /** Web UI 构建产物所在的目录；不填用 packages/web/dist */
  webRoot?: string;
  /** 二狗程序目录（守卫的受保护区域之一）；不填用这份代码所在的检出目录。测试换成临时目录，不碰真实仓库 */
  programDir?: string;
  /** 秘书的模型；不填用 deepseek-flash。测试换成 faux provider */
  secretaryModel?: ModelSpec;
  /** 秘书不在运行超过这么久，/healthz 就报不健康；默认 30 秒 */
  secretaryDownThresholdMs?: number;
  /** 守护进程的日志；不填写到 stderr */
  log?: (line: string) => void;
  /** 时钟（调度器、提醒、事件时间都跟着它）；不填用系统时钟。测试换成手动拨的 */
  clock?: Clock;
  /** 测试用：额外登记（或替换）的卡片类型 */
  extraCardTypes?: readonly CardTypeDefinition[];
  /** 素材的向量函数；不填用数据目录模型区里的 bge-m3。测试注入假的 */
  embedder?: Embedder;
  /** 测试用：备份往备份区写文件的实现（模拟空间不够、复制出错） */
  backupFiles?: SnapshotFiles;
  /** 测试用：秘书额外的自定义工具（比如带"花钱"类别的，测"交给我做"） */
  extraSecretaryTools?: readonly HostTool[];
  /** 测试用：额外登记（或替换）的快速动作 */
  extraQuickActions?: readonly QuickActionExecutor[];
  /** 维护者的模型（spawn 是第几次唤起它）；不填用 deepseek-flash。测试换成 faux provider */
  maintainerModel?: (maintainerId: string, spawn: number) => ModelSpec;
  /**
   * 测试用：起草计划时维护者会话的工具包（bash、联网开关），不填都关着；执行时一律照确认的计划（13 号票）。
   * 28 号票的测试靠它给起草中的维护者一个开了 bash 的会话，驱动带类型的 bash 工具
   */
  maintainerToolkit?: (maintainerId: string) => ShellToolkit;
  /** 测试用：GitHub 命令行（程序和它前面的固定参数），换成假的，建远端仓库不真的连 GitHub；不填用 PATH 上的 gh */
  ghCommand?: readonly string[];
  /** 评审子 agent 的模型（reviewId 是它的 agent id：review-<任务>-<阶段>-<第几次>）；不填用 deepseek-flash。测试换成 faux provider */
  reviewerModel?: (reviewId: string) => ModelSpec;
  /** 并行派出的子 agent 的模型（agentId 是它的 id：sa-<n>）；不填和维护者一样。测试换成 faux provider（20 号票） */
  subAgentModel?: (agentId: string) => ModelSpec;
  /** 测试用：语音识别进程（程序和参数），换成假的，不加载真模型、不占显卡；不填用配置里的 Python 跑 recognizer.py（31 号票） */
  recognizerCommand?: readonly string[];
  /**
   * LSM 经 link 协议要求停机（立即，或等不忙了，23 号票）时做什么：停完 resolve。不给就只停守护进程（测试）；
   * main.ts 给的是"停守护进程、删 pid 文件、退出进程"
   */
  onLsmStop?: () => Promise<void>;
  /** LSM 说同一个服务已经有活跃的实例（被重复启动了）时做什么。不给就只停守护进程；main.ts 退出进程 */
  onLsmConflict?: (reason: string) => void;
}

export interface Daemon {
  readonly config: ErgouConfig;
  readonly layout: DataDirLayout;
  readonly store: EventStore;
  readonly cards: CardService;
  readonly inbox: InboxService;
  readonly reminders: ReminderService;
  /** 个人工作日历：节假日数据加个人规则和手动标记（29 号票） */
  readonly workdayCalendar: WorkdayCalendarService;
  /** 节假日数据的续期（29 号票）：每月检查、发起更新任务、任务完成后导入交付件（importForTask，13 号票的任务完成回调调它） */
  readonly holidayUpdates: HolidayUpdates;
  /** 素材：采集、原文副本、关键词和向量检索（memory.db 只有它写） */
  readonly materials: Materials;
  /** 设备配对：配对请求、凭证、已配对设备 */
  readonly pairing: PairingService;
  /** 审批表和审批卡 */
  readonly approvals: ApprovalService;
  /** 任务：发起、任务书、计划的提交和确认（12 号票） */
  readonly tasks: TaskService;
  /** 项目：立项、立项书、项目状态、项目档案、删除（15 号票） */
  readonly projects: ProjectService;
  /** 任务执行（13 号票）：排队和执行名额、阶段推进、验收、用户的控制、任务完成后的回调（onCompleted） */
  readonly taskExecution: TaskExecution;
  /** 子 agent 并行（20 号票）：提议、并行确认卡、拉起子 agent、结果交回维护者；ownerOf 给出子 agent 属于哪个任务的哪个阶段 */
  readonly subAgents: SubAgents;
  /** token 账本（24 号票）：每次模型调用的用量、按任务 / 阶段 / agent / 天的汇总、消耗页的粗估成本 */
  readonly ledger: TokenLedger;
  /** 守卫接入：agent 的工具调用经它判定 */
  readonly guards: GuardRuntime;
  /** 快速动作：执行器注册表、提议和执行（21 号票） */
  readonly quickActions: QuickActionService;
  /** 关注类别设置：设置页的修改、现读配置区的文件（26 号票） */
  readonly watchCategories: WatchCategoryService;
  /** 语音消息：收下语音、在后台识别、重新识别（31 号票） */
  readonly voice: VoiceService;
  readonly scheduler: Scheduler;
  /** 内部作业（每晚备份、每周校验、每天清理临时区……）；whenIdle() 等正在跑的做完 */
  readonly internalJobs: InternalJobs;
  /** 备份：立即备份、校验最新快照、清理临时区 */
  readonly backup: BackupService;
  readonly agents: AgentManager;
  readonly secretary: Secretary;
  /** 二狗自建的 Job 对象（只在 Windows 上有） */
  readonly job: JobObject | undefined;
  /** 本机端口的地址，如 http://127.0.0.1:8810 */
  readonly localUrl: string;
  /** 本机端口实际监听的端口 */
  readonly localPort: number;
  /** 外网端口的地址（隧道连这里），如 http://127.0.0.1:8811 */
  readonly externalUrl: string;
  readonly externalPort: number;
  /** 接入 LSM 的 link 协议（23 号票）：没有 LSM 注入的身份时 enabled 为 false、什么都不做 */
  readonly lsm: LsmLink;
  /** 停止：关端口、停秘书、关闭 Job 对象（还活着的子进程和孙进程全部结束）、关库 */
  stop(): Promise<void>;
}

export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const config = loadConfig({ env: options.env, homeDir: options.homeDir });
  const layout = dataDirLayout(config.dataDir);
  const localPort = options.localPort ?? config.ports.local;
  // 一个数据目录只有一个实例（23 号票）：已经有一个在跑（被重复启动了）就立即退出，什么状态都不碰——
  // 不然下面的恢复会把正在跑的实例里正在执行的调用当成被杀时中断的
  const running = await daemonRunning(layout.pidFile, localPort);
  if (running) throw new DaemonAlreadyRunning(`数据目录 ${layout.root} 已经有一个守护进程在运行（${running}），这次不启动`);
  for (const dir of [layout.config, layout.db, layout.sessions, layout.tmp, layout.scratch, layout.logs]) fs.mkdirSync(dir, { recursive: true });

  // 已经立起来的部分，停的时候按相反的顺序收掉（启动中途失败时也用它收拾）
  const teardown: Array<() => void | Promise<void>> = [];
  const shutdown = async () => {
    for (const step of teardown.splice(0).toReversed()) await step();
  };

  try {
    const clock = options.clock ?? systemClock;
    const now = () => clockIso(clock);
    const store = openEventStore({
      file: path.join(layout.db, "ergou.db"),
      views: [...conversationViews, cardsView, inboxView, remindersView, pairingView, internalJobsView, approvalsView, effectLogView, executionsView, tasksView, activityView, projectsView, ledgerView, subAgentsView, voicesView],
      now,
      log,
    });
    teardown.push(() => store.close());
    const scheduler = createScheduler({ clock, log });
    teardown.push(() => scheduler.stop());
    const notifications = createEphemeralBus();
    // 个人工作日历（29）：节假日数据加配置区里的个人设置；"按我的工作日"的提醒和内部作业按它算
    const workdayCalendar = createWorkdayCalendarService({ store, layout, log });
    workdayCalendar.start();
    teardown.push(() => workdayCalendar.stop());

    // 卡片类型注册表：各票往这里登记自己的卡（06：简单提醒卡；10：配对请求卡）
    const registry = new CardTypeRegistry();
    const cards = createCardService({ store, registry, now });
    const inbox = createInboxService({ store, notifications, now, log });
    // "按我的工作日"的提醒和内部作业按当时的工作日历算下一次
    const scheduleContext = () => ({ calendar: workdayCalendar.current() });
    const reminders = createReminderService({ store, cards, inbox, scheduler, clock, scheduleContext });
    registry.register(reminderCardType(reminders));
    const pairing = createPairingService({ store, cards, inbox, scheduler, clock });
    registry.register(pairingCardType(pairing));
    const approvals = createApprovalService({ store, cards, inbox, now });
    registry.register(approvalCardType(approvals));
    // 关注类别设置（26）：设置页改配置区的文件；守卫、任务、快速动作都经它现读（文件被手改、改坏了会记一条事件，设置页跟着变）。
    // 能匹配的工具在秘书的工具、快速动作登记好之后才齐，start() 放在后面。设置文件坏了时放待我处理事项；
    // 新的自定义类别 id 要躲开计划里的，删除、调松时说明还有几个进行中的任务按确认时的快照检查它（任务模块在下面建，现取）
    const watchCategories = createWatchCategoryService({
      store,
      inbox,
      layout,
      now,
      tools: () => watchToolChoices(),
      categoryIdsInPlans: () => tasks.planWatchCategories().flatMap((p) => p.categories.map((c) => c.id)),
      heldByTasks: (categoryId) =>
        new Set(
          tasks
            .planWatchCategories()
            .filter((p) => p.confirmed && p.ongoing && p.categories.some((c) => c.id === categoryId && c.match !== undefined))
            .map((p) => p.taskId),
        ).size,
    });
    const watchSettings = () => watchCategories.current();
    const realLayout = dataDirLayout(real(layout.root));
    const programDir = real(options.programDir ?? DEFAULT_PROGRAM_DIR);
    // 唯一的后接接线点（解循环依赖）：任务模块要核对项目名（项目模块建在任务模块之后），项目模块删除时要停维护者
    // （项目维护者模块建在项目模块之后），任务控制快速动作要执行控制器（22，执行控制器建在快速动作登记之后）。
    // 子 agent（20）：任务执行控制器要知道哪些阶段有子 agent 在做，维护者要"提议并行"工具，子 agent 模块建在它们之后。
    // 两边先拿转手的对象，模块都建好之后在下面"接上"处一起填
    const wiring: { projects?: ProjectService; projectMaintainers?: ProjectMaintainers; taskExecution?: TaskExecution; subAgents?: SubAgents } = {};
    const wired = <K extends keyof typeof wiring>(key: K): NonNullable<(typeof wiring)[K]> => {
      const target = wiring[key];
      if (!target) throw new Error(`${key} 还没接上`);
      return target as NonNullable<(typeof wiring)[K]>;
    };
    // 彻底删除的改写函数表（21）：拥有一类事件的模块写它的改写函数；以后接入新的素材来源也要在这里登记。
    // 删除项目（15）也用它改写属于项目的事件
    const purgeRewriters = new PurgeRewriters();
    purgeRewriters.register(
      messagePurge,
      cardPurge(cards),
      ...cardSignalPurge,
      rememberCommandPurge,
      approvalDecisionPurge,
      approvalRequestPurge,
      effectRecordPurge,
      ...executionPurges,
      operationRecordPurge,
      ...charterPurges,
      inboxItemPurge,
      outputReactionPurge,
      parallelDecisionPurge,
      voicePurge,
      taskWaitNotePurge,
    );
    // 任务（12）："建议发起任务"卡、提问卡、计划卡；计划里的授权项和时序规则照内置的工具注册表查。
    // 点"发起任务"时选的项目要在项目列表里（15）
    const tasks = createTaskService({
      store,
      cards,
      inbox,
      now,
      watchSettings,
      planTools: BUILTIN_TOOL_REGISTRY,
      projects: { check: (names) => wired("projects").checkTaskProjects(names), idsOf: (names) => wired("projects").projectIdsOf(names) },
    });
    registry.register(suggestTaskCardType(tasks));
    registry.register(questionsCardType());
    registry.register(planCardType(tasks));
    // 被杀后的恢复（23）第 1 步：任何 agent 会话开始之前，记下上次被杀时正处理到一半的任务维护者
    const restart = scanBeforeStart(store, tasks);
    // 项目（15）："建议立项"卡、立项书卡；项目档案在数据目录的项目区
    const projects = createProjectService({
      store,
      cards,
      inbox,
      tasks,
      rewriters: purgeRewriters,
      maintainers: {
        suspend: (id) => wired("projectMaintainers").suspend(id),
        resume: (id) => wired("projectMaintainers").resume(id),
        removeSession: (id) => wired("projectMaintainers").removeSession(id),
      },
      now,
      projectsDir: realLayout.projects,
      dataDir: realLayout.root,
      programDir,
      log,
    });
    registry.register(suggestProjectCardType(projects));
    registry.register(charterCardType(projects));
    registry.register(progressCardType());
    // 还没到点的提醒登记进调度器（守护进程重启后照常触发）
    reminders.start();
    teardown.push(() => reminders.stop());
    // 素材：从事件日志采集（停着时追加的先补采、只在原文副本里的补回），回避信号计时，向量在后台补算（启动后过一会儿才开始）
    const materials = openMaterials({
      store,
      dbDir: layout.db,
      materialsDir: layout.materials,
      embedder: options.embedder ?? createBgeM3Embedder(layout.root),
      scheduler,
      clock,
      inbox,
      staleCardDays: config.materials.staleCardDays,
      log,
    });
    // 其他票在这里、start 之前登记自己的素材来源：materials.register(...)
    // 审批决定（07）：用户在审批卡上批准、拒绝
    materials.register(approvalDecisionSource);
    // 点"发起任务"时写的原话（用户发言）、澄清问题的回答（提问卡）、计划卡上的确认和打回（12）
    materials.register(startTaskRequestSource);
    materials.register(clarificationAnswerSource);
    materials.register(planDecisionSource);
    // 立项书卡上的确认（用户对产出的反应，15）
    materials.register(charterDecisionSource);
    // 任务结局（完成、失败、取消）、用户对产出的反应（由我验收的结论、要求返工）（13）
    materials.register(taskOutcomeSource);
    materials.register(outputReactionSource);
    // 并行确认卡上的决定（审批决定，20）
    materials.register(parallelDecisionSource);
    // 用户的语音（31）：识别完成时算用户发言，文字是识别出的文字
    materials.register(voiceMaterialSource);
    materials.start();
    teardown.push(() => materials.stop());
    // 待批的配对请求到点过期（守护进程重启后照常）
    pairing.start();
    teardown.push(() => pairing.stop());
    // 内部作业：每晚备份、每周校验、每天清理临时区（错过的马上补一次）。
    // 停的时候先停内部作业（中止正在跑的、等它停下），再停备份（中止手动的那些）
    const internalJobs = createInternalJobs({ store, scheduler, clock, log, scheduleContext });
    // 工作日历变了（个人设置、节假日数据）："按我的工作日"的提醒和作业按新的工作日历重算下一次
    workdayCalendar.onChange(() => {
      reminders.recalculate();
      internalJobs.rearm();
    });
    // 启动时节假日数据可能变了（框架发版、导入过新的）：按现在的工作日历对一遍
    reminders.recalculate();
    const backup = createBackupService({ layout, config: config.backup, inbox, clock, internalJobs, log, ...(options.backupFiles ? { files: options.backupFiles } : {}) });
    teardown.push(() => backup.stop());
    teardown.push(() => internalJobs.stop());
    backup.start();
    // 节假日数据的续期（29）：每月检查（12 月起查下一年），缺了放进待我处理；用户点"发起更新任务"就发起一个联网任务
    const holidayUpdates = createHolidayUpdates({ workdayCalendar, inbox, store, tasks, internalJobs, clock, layout, config: config.holidayCheck, log });
    holidayUpdates.start();
    teardown.push(() => holidayUpdates.stop());
    const streams = createStreamHub({ lastSeq: (channel) => store.lastSeq(channel) });
    teardown.push(() => streams.close());
    const media = openMediaStore({ mediaDir: layout.media, uploadsDir: layout.uploads, maxUploadBytes: config.media.maxUploadBytes });
    const job = process.platform === "win32" ? createJobObject() : undefined;
    // 活动状态：上次被杀时还在干活、排队的改记休眠（有待处理的审批卡、提问卡的是等你）；之后 agent 管家报的和待处理的卡片合起来，
    // 变了就记一条；干活中在做什么节流后作为临时事件推送（25）
    const activity = createActivityLog({ store, now, publish: (frame) => notifications.publish(frame) });
    activity.settle();
    teardown.push(() => activity.stop());
    // token 账本（24）：子进程每次模型调用报的用量记一条；任务名下的记上任务的当前阶段（结束了、全部验收之后的收尾调用不算进阶段）；
    // 当前阶段是维护者的（20：它最后一次开始的那个，taskMessageScope 按任务里记的 focus 算）；
    // 子 agent、评审子 agent 拉起时自己带上阶段，不走这里。成本按现读的配置里的单价算
    const ledger = createTokenLedger({
      store,
      now,
      currentStage: (taskId) => {
        const task = tasks.get(taskId);
        const list = task?.stages?.list;
        if (!task || !list || list.length === 0 || !UNFINISHED_TASK_STATES.includes(task.state) || allAccepted(list)) return undefined;
        // "当前阶段"只在 taskMessageScope 一处算（25）
        return taskMessageScope(task).stageId;
      },
      prices: () => readTokenPrices(layout.configFile),
      log,
    });
    const agents = createAgentManager({
      layout,
      parentEnv: options.env,
      job,
      limits: config.agentLimits,
      onActivity: activity.record,
      onProgress: activity.progress,
      onUsage: ledger.record,
      // 接着会话时给被中断的工具调用补上的结果（23）：等审批的、有副作用说不清做没做完的，按事件日志现取
      interruptedToolResults: (agentId) => interruptedToolResults(store.reader, agentId),
      log,
    });
    // 先关 Job：子进程连同它们起的孙进程一起结束；再等子进程的句柄收尾
    teardown.push(async () => {
      job?.close();
      await agents.shutdown();
    });

    // 守卫：各区用真实路径（展开符号链接、目录联接和 8.3 短名），agent 的工作目录也用真实路径，路径比较才对得上
    const places: GuardPlaces = {
      dataDir: { root: realLayout.root, config: realLayout.config, secrets: realLayout.secrets, db: realLayout.db, projects: realLayout.projects },
      programDir,
      // agent 的 bash 里 `~` 是 HOME（Git Bash 没有 HOME 时取 USERPROFILE）
      homeDir: real(options.env.HOME ?? options.env.USERPROFILE ?? options.homeDir),
    };
    const handOvers = createHandOverService({ store, inbox });
    teardown.push(() => handOvers.stop());
    const guards = createGuardRuntime({
      store,
      approvals,
      handOvers,
      inbox,
      clock,
      places,
      settings: watchSettings,
      approvalWaitMs: config.approvalWaitMs,
      // 子进程里的调用在等用户批准：这个 agent 的活动状态是"等你"（25）
      userWaits: agents,
      // 项目档案（不含工作目录和历史区）里的文件被整体重写或删除前，运行时先留一份旧版本（15），所以守卫对它传 backedUp
      autoVersioning: { covers: (p) => isAutoVersioned(realLayout.projects, p), preserve: (paths) => preserveVersions(realLayout.projects, paths, now()) },
      // 子 agent 的调用挂起后才被决定：通知进维护者的会话，说法由子 agent 那边给（20）
      lateNotice: (decision) => wiring.subAgents?.lateNotice(decision),
      log,
    });
    teardown.push(() => guards.stop());

    const deletionDeps = { store, cards, rewriters: purgeRewriters, now };
    // 快速动作：执行器按动作类型登记（21：记忆命令；29：改工作日历；22 号票的任务控制、27 号票的 MCP 调用照这个加）。
    // 处置由守卫的判定函数定（动作作为伪工具调用 quick_action:<类型>，用户的自定义类别也适用）
    const quickActionRegistry = new QuickActionRegistry();
    for (const executor of memoryCommandExecutors({ ...deletionDeps, materials })) quickActionRegistry.register(executor);
    // 改工作日历（29）：一律先确认，确认后由运行时改配置区里的个人设置
    quickActionRegistry.register(workdayCalendarAction(workdayCalendar));
    // 任务控制（22）：暂停、继续、取消，推断出来的一律先问；执行走执行控制器（算用户改的状态）
    for (const executor of taskControlActions({ tasks, execution: () => wired("taskExecution") })) quickActionRegistry.register(executor);
    for (const executor of options.extraQuickActions ?? []) quickActionRegistry.register(executor, { replace: true });
    const quickActions = createQuickActionService({
      store,
      cards,
      inbox,
      registry: quickActionRegistry,
      guard: { places, scratchDir: realLayout.scratch, settings: watchSettings, now: () => clock.now() },
      log,
    });
    registry.register(quickActionCardType(quickActions));
    registry.register(memoryDeleteCardType(quickActions));
    for (const definition of options.extraCardTypes ?? []) registry.register(definition, { replace: true });
    // 设置里按会话、按时间段删除素材（21）；彻底删除之后没人引用的媒体文件删掉
    const materialDeletion = createBulkMaterialDeletion({ ...deletionDeps, materials, unmaterializedPurgeTargets: (scope, found) => voicePurgeTargets(store, scope, found) });
    teardown.push(startPurgedMediaCleanup({ store, media, materials, log }));

    // 语音消息（31）：按需拉起的识别进程（放进它自己的 Job，环境照 agent 子进程的白名单）
    const voiceConfig = config.voice;
    const recognizer =
      !options.recognizerCommand && isPlaceholder(voiceConfig.recognizer.python)
        ? unavailableRecognizer("数据目录配置里的 voice.recognizer.python 还是示例里的占位符")
        : createProcessRecognizer({
            command: options.recognizerCommand ?? [voiceConfig.recognizer.python, RECOGNIZER_SCRIPT],
            env: buildChildEnv(options.env, RECOGNIZER_ENV),
            cwd: layout.tmp,
            init: { primary: voiceConfig.recognizer.primary, fallback: voiceConfig.recognizer.fallback },
            idleMs: voiceConfig.recognizer.idleMs,
            timeout: voiceConfig.recognizer.timeout,
            newJob: () => (process.platform === "win32" ? createJobObject() : undefined),
            log,
          });
    const voice = createVoiceService({
      store,
      media,
      inbox,
      recognizer,
      recognition: { language: voiceConfig.recognizer.language, initialPrompt: voiceConfig.recognizer.initialPrompt },
      unavailableHint: RECOGNIZER_HINT,
      log,
    });
    voice.start();
    teardown.push(() => voice.stop());

    const credentials = modelCredentials(options.env);
    const secretaryModel = options.secretaryModel ?? SECRETARY_MODEL;
    if (secretaryModel.kind === "catalog" && !credentials[secretaryModel.provider]) {
      log(`没有 ${secretaryModel.provider} 的模型 key：秘书能起来，但每次回复都会出错（key 由 LSM 从数据目录的密钥区注入）`);
    }
    // 消息前的时间标记按配置的 timeZone，简单提醒的时间（06）按本机时区算：两者不一致时秘书写的提醒时间会差开
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const configuredZone = Intl.DateTimeFormat("en-US", { timeZone: config.timeZone }).resolvedOptions().timeZone;
    if (configuredZone !== localZone) {
      log(`配置的 timeZone 是 ${configuredZone}，本机时区是 ${localZone}：秘书看到的消息时间按前者，简单提醒的时间按本机时区算，两者会差开；不需要另设时区时把 timeZone 去掉`);
    }
    // 秘书的工具：建、改、取消提醒（06），素材检索和提议快速动作（21），任务发起的四个（12），建议立项（15），
    // 只读的查看板、读项目档案、列出待我处理和把卡片放进聊天（22；没有任何对卡片做动作的工具）
    const secretaryTools = [
      ...reminderTools(reminders, clock),
      searchMaterialsTool(materials),
      proposeQuickActionTool(quickActions, CHANNELS.secretary),
      ...taskTools(tasks, cards),
      suggestProjectTool(cards),
      viewBoardTool(store),
      readProjectRecordsTool(projects),
      ...inboxTools(inbox, cards),
      ...(options.extraSecretaryTools ?? []),
    ];
    // 自定义关注类别能匹配的工具（设置页的候选，也用来查写错的名字）：内置的和 bash 拆出的伪工具、秘书代为执行的工具、快速动作的伪工具
    const watchToolChoices = () => {
      const all = [
        ...Object.values(BUILTIN_TOOL_REGISTRY),
        ...secretaryTools.map((t) => t.descriptor),
        ...quickActionRegistry.list().map((e) => ({ name: quickActionToolName(e.type), title: `快速动作：${e.title}` })),
      ];
      return [...new Map(all.map((t) => [t.name, { name: t.name, title: t.title }])).values()];
    };
    // 读一遍设置文件：频道上还没有事件、或者文件在停机时被改过，记一条（设置页据此显示）
    watchCategories.start();
    const secretary = startSecretary({
      agents,
      store,
      streams,
      model: secretaryModel,
      credentials,
      tools: secretaryTools,
      media,
      vision: modelVision(config, secretaryModel),
      guards,
      scratchDir: realLayout.scratch,
      sessionRewriteFor,
      timeZone: config.timeZone,
      log,
      ...(options.secretaryDownThresholdMs === undefined ? {} : { downThresholdMs: options.secretaryDownThresholdMs }),
    });
    teardown.push(() => secretary.stop());

    // 带类型的 bash 工具（28）：工具包开了 bash 的会话里随之出现（秘书的固定工具里没有）。
    // 工具起的进程只带系统变量白名单（没有密钥），跑测试、构建、装依赖声明更长的超时
    const typedShell = createTypedShell({
      parentEnv: options.env,
      homeDir: places.homeDir,
      timeouts: { defaultMs: config.agentLimits.toolCallMs, longMs: config.shellTools.longCallMs },
      ...(options.ghCommand ? { ghCommand: options.ghCommand } : {}),
      log,
    });

    // 任务执行（13）：确认过的任务排队、按名额开始执行，阶段推进和验收（脚本在工作目录里跑，评审派只读的评审子 agent）
    const reviewerModel = options.reviewerModel ?? (() => REVIEWER_MODEL);
    const taskExecution = createTaskExecution({
      store,
      tasks,
      cards,
      inbox,
      now,
      maxRunning: config.tasks.maxRunning,
      watchSettings,
      planTools: BUILTIN_TOOL_REGISTRY,
      outputsDir: realLayout.outputs,
      acceptance: {
        // 脚本照带类型 bash 工具的启动器起（闸门进程先进这次调用的 Job 对象，28）
        runScript: ({ cwd, script, expectOutput, network }) =>
          runAcceptanceScript(typedShell, { cwd, script, ...(expectOutput ? { expectOutput } : {}), network, timeoutMs: ACCEPTANCE_SCRIPT_TIMEOUT_MS }),
        review: createReviewer({ agents, guards, model: reviewerModel, credentials, log }),
      },
      subAgentsOn: (taskId) => wired("subAgents").busyStages(taskId),
      log,
    });
    teardown.push(() => taskExecution.stop());
    // 任务完成（全部阶段验收通过）后：节假日数据的更新任务（29）导入交付件；项目的首个建设任务（15）让项目进入使用中
    taskExecution.onCompleted((completed) => holidayUpdates.taskCompleted(completed));
    taskExecution.onCompleted(({ task }) => projects.taskCompleted(task));

    // 维护者（12：任务自己的维护者；13：执行时按计划装配）：会话里来了输入就唤起；秘书先起来，占着它预留的名额
    const maintainers = createMaintainers({
      agents,
      store,
      streams,
      guards,
      tasks,
      execution: taskExecution,
      media,
      outputsDir: realLayout.outputs,
      model: options.maintainerModel ?? (() => MAINTAINER_MODEL),
      vision: (model) => modelVision(config, model),
      credentials,
      timeZone: config.timeZone,
      typedShell,
      ...(options.maintainerToolkit ? { toolkit: options.maintainerToolkit } : {}),
      sessionRewriteFor,
      // 项目的维护者（含任务转为项目后原任务的维护者）由项目模块接
      excluded: (maintainerId) => projects.ofMaintainer(maintainerId) !== undefined,
      subAgentTools: (scope) => wired("subAgents").toolsFor(scope),
      log,
    });
    // 子 agent 并行（20）：维护者提议、用户在并行确认卡上同意后拉起子 agent（占子进程名额，不占任务的执行名额），
    // 装配从维护者此刻的装配收窄，结果交回维护者的会话
    const subAgents = createSubAgents({
      store,
      cards,
      inbox,
      tasks,
      execution: taskExecution,
      agents,
      guards,
      typedShell,
      maintainerAssembly: (taskId) => maintainers.assemblyOf(taskId),
      watchSettings,
      planTools: BUILTIN_TOOL_REGISTRY,
      model: options.subAgentModel ?? (() => MAINTAINER_MODEL),
      credentials,
      now,
      log,
    });
    registry.register(parallelCardType(subAgents));
    wiring.subAgents = subAgents;
    subAgents.start();
    teardown.push(() => subAgents.stop());
    maintainers.start();
    teardown.push(() => maintainers.stop());
    // 维护者接上之后再开始执行：排着的任务按名额开始，交给维护者的通知由它们接着处理
    taskExecution.start();

    // 项目的维护者（15）：用户在它的会话里说话时唤起；任务转为项目时从任务的维护者模块接过来
    const projectMaintainers = createProjectMaintainers({
      agents,
      store,
      streams,
      guards,
      media,
      projects,
      taskMaintainers: maintainers,
      layout,
      model: options.maintainerModel ?? (() => MAINTAINER_MODEL),
      vision: (model) => modelVision(config, model),
      credentials,
      timeZone: config.timeZone,
      sessionRewriteFor,
      log,
    });
    // 接上（上面的唯一接线点）
    wiring.projects = projects;
    wiring.projectMaintainers = projectMaintainers;
    wiring.taskExecution = taskExecution;
    projects.start();
    teardown.push(() => projects.stop());
    projectMaintainers.start();
    teardown.push(() => projectMaintainers.stop());
    // 被杀后的恢复（23）第 2 步：各模块都接上之后（执行控制器订阅好了，agent 会话标好了中断的输入），
    // 待审批的从审批表恢复（记成挂起，不新建卡、不再提示），被杀时正在执行的有副作用的调用记成中断，被打断的维护者接着做
    recoverAfterRestart({ store, approvals, inbox, tasks, now, log }, restart);

    const gateway = await startGateway({
      port: localPort,
      externalPort: options.externalPort ?? config.ports.external,
      pairing,
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      store,
      streams,
      notifications,
      requests: {
        cardAction: (params, idempotencyKey) => cards.act({ ...params, idempotencyKey }),
        inboxAction: (params, idempotencyKey) => inbox.act({ ...params, idempotencyKey }),
        revokeDevice: (params, idempotencyKey) => pairing.revoke(params.deviceId, idempotencyKey),
        startTask: (params, idempotencyKey) => ({ taskId: tasks.startFromButton(params, idempotencyKey).id }),
        updateWatchCategories: (params, idempotencyKey) => watchCategories.update(params, idempotencyKey),
        taskAction: (params, idempotencyKey) => taskExecution.act(params, idempotencyKey),
        // 维护者的会话：项目的（15）带上项目，任务的（13）带上任务；别的会话不认
        messageScope: (conversation) => projects.conversationScope(conversation) ?? userMessageScope(tasks, conversation),
        newProject: (params, idempotencyKey) => projects.newProject(params, idempotencyKey),
        convertTaskToProject: (params, idempotencyKey) => projects.convertTask(params, idempotencyKey),
        projectAction: (params, idempotencyKey) => projects.act(params, idempotencyKey),
        voiceIntake: voice.intake,
        retryVoice: (params, idempotencyKey) => voice.retry(params, idempotencyKey),
      },
      webRoot: options.webRoot ?? DEFAULT_WEB_ROOT,
      health: () => {
        const s = secretary.health();
        return { ok: s.ok, details: { secretary: s.status }, reasons: s.reason === undefined ? [] : [s.reason] };
      },
      api: createHttpApi({ media, store, materialDeletion, workdayCalendar, ledger, log }),
      attachments: media,
      log,
    });
    teardown.push(() => gateway.close());
    // 停止时先告诉守卫接入：之后子进程被结束不算中断（还在执行的调用留到下次启动时按被杀恢复，23）
    teardown.push(() => guards.stop());

    let stopping: Promise<void> | undefined;
    // pid 文件（LSM 的 stop 钩子、恢复命令、下一个实例的单实例检查用）：开好端口之后写，全部停完才删；
    // 和 LSM 的连接也最后断（停完了再发 bye），只在这里断
    writePidFile(layout.pidFile, gateway.port);
    const stopDaemon = () =>
      (stopping ??= shutdown().finally(() => {
        removePidFile(layout.pidFile);
        lsm.close();
      }));
    // 接入 LSM 的 link 协议（23）：有任务在执行、有正在执行的有副作用的调用就报"忙"（忙闲变了马上补一次心跳）；
    // 管理器要求停机时优雅停止。没有 LSM 注入的身份（测试、手动起的）时什么都不做
    const lsmBusy = () => daemonBusy(tasks, store.reader);
    const lsm = linkToLsm({
      env: options.env,
      port: gateway.port,
      version: DAEMON_VERSION,
      busy: lsmBusy,
      health: () => (secretary.health().ok ? "ok" : "degraded"),
      onShutdown: () => (options.onLsmStop ?? stopDaemon)(),
      onConflict: (reason) => (options.onLsmConflict ? options.onLsmConflict(reason) : void stopDaemon()),
      log,
    });
    let busyNow = lsmBusy().busy;
    teardown.push(
      store.onAppend((event) => {
        if (!mayChangeBusy(event)) return;
        const busy = lsmBusy().busy;
        if (busy === busyNow) return;
        busyNow = busy;
        lsm.notifyBusy();
      }),
    );

    return {
      config,
      layout,
      store,
      cards,
      inbox,
      reminders,
      workdayCalendar,
      holidayUpdates,
      materials,
      pairing,
      approvals,
      tasks,
      projects,
      taskExecution,
      subAgents,
      ledger,
      guards,
      quickActions,
      watchCategories,
      voice,
      scheduler,
      internalJobs,
      backup,
      agents,
      secretary,
      job,
      localUrl: gateway.url,
      localPort: gateway.port,
      externalUrl: gateway.externalUrl,
      externalPort: gateway.externalPort,
      lsm,
      stop: stopDaemon,
    };
  } catch (err) {
    await shutdown();
    throw err;
  }
}
