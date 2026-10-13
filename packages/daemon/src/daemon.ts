// 守护进程的组装：读配置、找到数据目录、打开事件存储、建 Job 对象、立起 agent 管家和秘书、
// 任务和维护者（12 号票）、项目和项目的维护者（15 号票）、token 账本（24 号票）、开本机端口和外网端口（设备配对在 10 号票）；
// skill 库、MCP 登记和工具包（27 号票）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, type ConversationId, EVENT_TYPES, MAINTAINER_CHANNEL_PREFIX, type ModelAgent, projectToolkit, type Task, type TaskActionParams, type TaskActionResult, UNFINISHED_TASK_STATES } from "@ergou/protocol";
import { activityView, createActivityLog } from "./activity/activity.ts";
import { createAgentManager, type AgentManager } from "./agent-manager/agent-manager.ts";
import type { HostTool } from "./agent-manager/host-tools.ts";
import { approvalCardType, type ApprovalService, createApprovalService } from "./approvals/approvals.ts";
import { approvalDecisionPurge, approvalDecisionSource, approvalRequestPurge } from "./approvals/material-source.ts";
import { approvalsView } from "./approvals/views.ts";
import { type BackupService, createBackupService } from "./backup/backup.ts";
import type { SnapshotFiles } from "./backup/files.ts";
import { viewBoardTool } from "./board/tool.ts";
import { createCalendarService } from "./calendar/calendar.ts";
import { cardPurge, type CardService, createCardService } from "./cards/cards.ts";
import { type CardTypeDefinition, CardTypeRegistry } from "./cards/registry.ts";
import { cardsView } from "./cards/views.ts";
import { isPlaceholder, loadConfig, readTokenPrices, type ErgouConfig } from "./config/config.ts";
import { dataDirLayout, type DataDirLayout } from "./config/data-dir.ts";
import { modelCredentials, tavilyKey } from "./config/secrets.ts";
import { handoffInstructions } from "./conversation/model-switch.ts";
import { messagePurge, timelineRecordPurge } from "./conversation/purge.ts";
import { createReadMarks } from "./conversation/read-marks.ts";
import { createStreamHub } from "./conversation/stream-hub.ts";
import { conversationViews } from "./conversation/views.ts";
import { createEphemeralBus } from "./events/ephemeral.ts";
import { type EventStore, openEventStore } from "./events/event-store.ts";
import { startGateway } from "./gateway/gateway.ts";
import { createHttpApi } from "./gateway/http-api.ts";
import { createAgentSettings } from "./agent-settings/index.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardPlaces, protectedAreasOf } from "./guard/index.ts";
import { createToolCallDetailRetention, type ToolCallDetailRetention } from "./guard-runtime/detail-retention.ts";
import { effectLogView, effectRecordPurge } from "./guard-runtime/effect-log.ts";
import { executionPurges, executionsView, interruptedToolResults } from "./guard-runtime/executions.ts";
import { toolCallDetailPurge, toolCallDetailsView } from "./guard-runtime/tool-call-details.ts";
import { createGuardRuntime, type GuardRuntime } from "./guard-runtime/guard-runtime.ts";
import { createHandOverService } from "./hand-over/hand-over.ts";
import { createInboxService, type InboxService, inboxItemPurge } from "./inbox/inbox.ts";
import { inboxTools } from "./inbox/secretary-tools.ts";
import { createTokenLedger, ledgerView, type TokenLedger } from "./ledger/index.ts";
import { maintainerGuardAgent } from "./maintainers/assembly.ts";
import { createMaintainers, type Maintainers, userMessageScope } from "./maintainers/maintainers.ts";
import { multiProjectToolkit } from "./maintainers/multi-project.ts";
import { inboxView } from "./inbox/views.ts";
import { openMediaStore } from "./media/media-store.ts";
import { cardSignalPurge, createBgeM3Embedder, type Embedder, type Materials, openMaterials, rememberCommandPurge } from "./materials/index.ts";
import {
  createBulkMaterialDeletion,
  internalRecordOf,
  type MaterialOwners,
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
import { createPromptLibrary, type PromptLibrary } from "./prompts/index.ts";
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
import { createEventTriggers, DATA_DIR_TITLE, eventSourceImplementations, type EventTriggers } from "./event-sources/index.ts";
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
  readUserTurn,
} from "./quick-actions/index.ts";
import type { ModelSpec } from "./runtime/index.ts";
import { type Clock, clockIso, systemClock } from "./scheduler/clock.ts";
import { createInternalJobs, type InternalJobs, internalJobsView } from "./scheduler/internal-jobs.ts";
import { createScheduler, type Scheduler } from "./scheduler/scheduler.ts";
import { createJobMaintainers, createScheduledJobs, getJob, isJobMaintainerId, jobMaintainerSystemPrompt, type ScheduledJobs, scheduledJobsView } from "./scheduled-jobs/index.ts";
import { relayActions } from "./secretary/relay.ts";
import { type Secretary, SECRETARY_AGENT_ID, startSecretary } from "./secretary/secretary.ts";
import { TASK_DONE_SETTLE_MS } from "./secretary/task-done.ts";
import { createSecretaryLetters } from "./secretary/letters.ts";
import { type ArchiveList, archiveListCardType, createArchiveList } from "./tasks/archive-list.ts";
import { createTaskBatch } from "./tasks/batch.ts";
import { planCardType, questionsCardType, suggestTaskCardType, workflowPlanCardType } from "./tasks/cards.ts";
import { reviewWorkflowDraft } from "./tasks/workflow-plan.ts";
import type { WorkflowExecutor, WorkflowReviewer } from "./tasks/workflow-tools.ts";
import { planChangeCardType } from "./tasks/plan-change-card.ts";
import { runAcceptanceScript } from "./tasks/acceptance.ts";
import { createTaskExecution, type TaskExecution } from "./tasks/execution.ts";
import { createExecutionSlots } from "./tasks/slots.ts";
import { taskControlActions, taskRunActions } from "./tasks/task-control.ts";
import { allAccepted, taskMessageScope } from "./tasks/stages.ts";
import {
  clarificationAnswerPurge,
  clarificationAnswerSource,
  grantRenewalPurge,
  outputReactionPurge,
  grantRenewalSource,
  outputReactionSource,
  planDecisionPurge,
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
import { internalTaskTools } from "./tasks/internal-tools.ts";
import { taskTools } from "./tasks/secretary-tools.ts";
import { planProjectsCheck } from "./tasks/plan-projects.ts";
import { createTaskService, type TaskService } from "./tasks/tasks.ts";
import { tasksView } from "./tasks/views.ts";
import { workTimesView } from "./tasks/own-work.ts";
import { createTypedShell, type ShellToolkit } from "./typed-shell/index.ts";
import { realPathOf } from "./util/real-path.ts";
import { type AssistantNameService, createAssistantNameService } from "./assistant/index.ts";
import { createModelSettings, type ModelSettingsService } from "./model-settings/index.ts";
import { createHolidayUpdates, createWorkdayCalendarService, type HolidayUpdates, type WorkdayCalendarService, workdayCalendarAction } from "./workday/index.ts";
import { createWatchCategoryService, type WatchCategoryService } from "./watch-categories/watch-categories.ts";
import { createBrowserLocator, createWebAccess, playwrightDriver, type WebAccess, webTools } from "./web/index.ts";
import type { SessionTools } from "./conversation/session-tools.ts";
import {
  agentVoicesView,
  createAudioCppSynthesizer,
  createProcessRecognizer,
  createVoiceReplies,
  createVoiceService,
  createVoiceWarmup,
  openReferenceVoices,
  RECOGNIZER_ENV,
  RECOGNIZER_HINT,
  RECOGNIZER_SCRIPT,
  unavailableRecognizer,
  voiceMaterialSource,
  voicePurge,
  voicePurgeTargets,
  type VoiceReplies,
  type VoiceService,
  voicesView,
} from "./voice/index.ts";
import { createMcpService, defaultMcpCwd, type McpService } from "./mcp/mcp.ts";
import { mcpQuickAction } from "./mcp/quick-action.ts";
import { BUILTIN_SKILLS_DIR, createSkillLibrary, type SkillLibrary } from "./skills/library.ts";
import { createSecretarySkills, type SecretarySkills } from "./skills/secretary-skills.ts";
import { skillDirProblems } from "./skills/skill-command.ts";
import { conversationSlashCommands } from "./slash-commands/list.ts";
import { toolkitDecisionPurge, toolkitDecisionSource } from "./toolkit/material-source.ts";
import { createToolkitService, toolkitChangeCardType, type ToolkitService } from "./toolkit/toolkit.ts";
import { workOrderCardType } from "./work-orders/card.ts";
import { workOrderDecisionPurge, workOrderDecisionSource } from "./work-orders/material-source.ts";
import { answerWorkOrderTool, forwardToUserTool, multiProjectTools } from "./work-orders/multi-project-tools.ts";
import { refusal as workOrderRefusal } from "./work-orders/multi-project-texts.ts";
import { workOrderPurge } from "./work-orders/purge.ts";
import { createScopeReview, type MaintainerScopeReview, scopeRecordPurge, scopeRecordQuotes, scopeRecordsView } from "./scope-review/index.ts";
import { judgeUnplannedWorkOrder } from "./work-orders/unplanned.ts";
import { workOrdersView } from "./work-orders/views.ts";
import { createWorkOrders, type WorkOrders } from "./work-orders/work-orders.ts";

/** Web UI 的构建产物（npm run build:web 生成 packages/web/dist/index.html） */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));

// 各 agent 的模型（规格第 1 节）：73 号票起按设置里的"模型"取（model-settings/：默认模型和思考档位、按 agent 的覆盖），
// 拉起时现取、只用于新开的会话；没有设置文件时和以前写死的一样，全是 DeepSeek V4.1 Flash、思考档位高
// （范围审视用的"便宜模型"第一阶段也是它，在维护者自己的子进程里另开一次调用）。

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
  /** 多久看一眼 index.html 换没换（毫秒，116 号票）；不填 2 秒。测试调短 */
  webVersionPollMs?: number;
  /** 二狗程序目录（守卫的受保护区域之一）；不填用这份代码所在的检出目录。测试换成临时目录，不碰真实仓库 */
  programDir?: string;
  /** 秘书的模型；不填按设置里的"模型"（73 号票）。测试换成 faux provider */
  secretaryModel?: ModelSpec;
  /** 秘书不在运行超过这么久，/healthz 就报不健康；默认 30 秒 */
  secretaryDownThresholdMs?: number;
  /**
   * 任务做完告诉秘书（99 号票）：做完一件之后安静多久（毫秒）没有新做完的才交给秘书，几件差不多同时做完的并成一条；
   * 不填用 secretary/task-done.ts 的 TASK_DONE_SETTLE_MS（2 秒）。按时钟算
   */
  taskDoneSettleMs?: number;
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
  /** 维护者的模型（spawn 是第几次唤起它）；不填按设置里的"模型"（任务维护者、定时作业的维护者、项目维护者各按各的 agent）。测试换成 faux provider */
  maintainerModel?: (maintainerId: string, spawn: number) => ModelSpec;
  /**
   * 测试用：起草计划时维护者会话的工具包（bash、联网开关），不填是起草计划时的（没有 bash，70 号票起联网开着）；执行时一律照确认的计划（13 号票）。
   * 28 号票的测试靠它给起草中的维护者一个开了 bash 的会话，驱动带类型的 bash 工具
   */
  maintainerToolkit?: (maintainerId: string) => ShellToolkit;
  /** 测试用：GitHub 命令行（程序和它前面的固定参数），换成假的，建远端仓库不真的连 GitHub；不填用 PATH 上的 gh */
  ghCommand?: readonly string[];
  /** 评审子 agent 的模型（reviewId 是它的 agent id：review-<任务>-<阶段>-<第几次>）；不填按设置里的"模型"。测试换成 faux provider */
  reviewerModel?: (reviewId: string) => ModelSpec;
  /** 并行派出的子 agent 的模型（agentId 是它的 id：sa-<n>）；不填按设置里的"模型"。测试换成 faux provider（20 号票） */
  subAgentModel?: (agentId: string) => ModelSpec;
  /**
   * 范围审视用的模型（按维护者 id 和第几次唤起它，和 maintainerModel 一起数；每次审视时现取）；不填按设置里的"模型"。
   * 测试换成 faux provider（18 号票）
   */
  scopeReviewModel?: (maintainerId: string, spawn: number) => ModelSpec;
  /** 测试用：工单结束时的范围审视最多等多久（毫秒）；不填是配置的单次模型调用超时再加半分钟（18 号票） */
  scopeReviewTimeoutMs?: number;
  /** 测试用：从某个阶段重做之前停稳维护者最多等多久（毫秒）；不填是 10 秒（84 号票，测到点没停下的那一轮作废时调短） */
  reworkStopTimeoutMs?: number;
  /** 测试用：语音识别进程（程序和参数），换成假的，不加载真模型、不占显卡；不填用配置里的 Python 跑 recognizer.py（31 号票） */
  recognizerCommand?: readonly string[];
  /** 测试用：语音合成服务（audio.cpp）的地址，换成假的 HTTP 服务；不填用配置里的 voice.speech.url（32 号票） */
  speechUrl?: string;
  /** 测试用：识别模型没加载起来、加载好很快又退出时的退避（毫秒）；不填用 warmup.ts 的 RECOGNIZER_RETRY_MS（45 号票） */
  recognizerRetryMs?: readonly number[];
  /** 测试用：识别进程加载好之后多久没崩算稳定（毫秒）；不填用 warmup.ts 的 RECOGNIZER_STABLE_MS（45 号票） */
  recognizerStableMs?: number;
  /** 测试用：发语音工具最多等合成多久就先交回"还在合成"（毫秒）；不填用 send-voice.ts 的 SEND_VOICE_WAIT_MS（86 号票） */
  sendVoiceWaitMs?: number;
  /** 框架自带的 skill 所在的目录；不填用 packages/daemon/skills（27 号票） */
  builtinSkillsDir?: string;
  /**
   * LSM 经 link 协议要求停机（立即，或等不忙了，23 号票）时做什么：停完 resolve。不给就只停守护进程（测试）；
   * main.ts 给的是"停守护进程、删 pid 文件、退出进程"
   */
  onLsmStop?: () => Promise<void>;
  /** LSM 说同一个服务已经有活跃的实例（被重复启动了）时做什么。不给就只停守护进程；main.ts 退出进程 */
  onLsmConflict?: (reason: string) => void;
  /** 测试用：联网搜索、读网页换成假的（不起浏览器、不连真网络）；不填用正式的（70 号票：playwright-core 驱动浏览器，读网页先直接请求） */
  webAccess?: WebAccess;
  /**
   * 测试用：浏览器路径的探测换成假的（返回 undefined 是没找到）；不填按 web/browser-path.ts 找（配置的 web.browserPath、
   * 环境变量 AGENT_BROWSER_EXECUTABLE_PATH、agent-browser 自带的签名 Chrome、系统 Chrome；一个进程只探一次）。联网工具用它，拉起 agent 时注入 bash 环境的 AGENT_BROWSER_EXECUTABLE_PATH 也是它
   */
  browserPath?: () => string | undefined;
  /**
   * 测试用：按设置里的"模型"拉起的目录模型（DeepSeek）和连通测试，请求都发到这个地址（本机的假 DeepSeek 服务），
   * 不连真的 DeepSeek（73 号票）；正式的不给
   */
  catalogBaseUrl?: string;
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
  /** 个人助理的名字（43 号票）：配置区里的文件是真相，改名经设置接口，秘书的系统提示里有它 */
  readonly assistantName: AssistantNameService;
  /** 设置里的"模型"（73 号票）：配置区里的文件是真相，经设置接口改，拉起 agent 时按 agent 现取（只用于新开的会话） */
  readonly modelSettings: ModelSettingsService;
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
  /** 派单器（16 号票）：工单和项目维护者的会话分段 */
  readonly workOrders: WorkOrders;
  /** 定时作业（19 号票）：登记、到点、名额、运行和结局、暂停恢复取消、启动时补跑错过的 */
  readonly scheduledJobs: ScheduledJobs;
  /** 事件触发（77 号票）：谁在等事件、事件来了交给谁、事件触发方式对不对 */
  readonly eventTriggers: EventTriggers;
  /** 每周的归档清单（19 号票）：compile() 现在汇总一次 */
  readonly archiveList: ArchiveList;
  /** 守卫接入：agent 的工具调用经它判定 */
  readonly guards: GuardRuntime;
  /** 快速动作：执行器注册表、提议和执行（21 号票） */
  readonly quickActions: QuickActionService;
  /** 关注类别设置：设置页的修改、现读配置区的文件（26 号票） */
  readonly watchCategories: WatchCategoryService;
  /** 语音消息：收下语音、在后台识别、重新识别（31 号票） */
  readonly voice: VoiceService;
  /** agent 用语音回复：跟着回合定口语稿、经 audio.cpp 合成（32 号票） */
  readonly voiceReplies: VoiceReplies;
  /** skill 库：框架自带的和用户导入的（27 号票；集合、导入并改名，72 号票） */
  readonly skills: SkillLibrary;
  /** 秘书用的 skill：设置里勾选的名单（72 号票） */
  readonly secretarySkills: SecretarySkills;
  /** MCP：登记、服务进程、转发调用（27 号票） */
  readonly mcp: McpService;
  /** 工具包：改工具包、维护者增减 skill、工具包变更卡（27 号票） */
  readonly toolkits: ToolkitService;
  readonly scheduler: Scheduler;
  /** 内部作业（每晚备份、每周校验、每天清理临时区……）；whenIdle() 等正在跑的做完 */
  readonly internalJobs: InternalJobs;
  /** 备份：立即备份、校验最新快照、清理临时区 */
  readonly backup: BackupService;
  /** 工具调用完整内容的保留期和总量上限（65 号票）：每天定时清，设置里看占了多大、"现在就清理" */
  readonly toolCallRetention: ToolCallDetailRetention;
  /** 各 agent 的系统提示（71 号票）：默认的和用户改的，设置里看、改、恢复默认 */
  readonly prompts: PromptLibrary;
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
  // 各 agent 的系统提示（71 号票）：默认的在本包的 prompts/，用户改的在配置区的 prompts/，每次装配 agent 时现读。
  // 启动时先查一遍：占位符写错、片段不认得……报清楚是哪个文件哪一行，不启动（不默默用空串）
  // 114 号票：每个 agent 单独的提示词（会话里的 ⚙）在配置区的 agent-prompts/，装配那个 agent 时带上
  const prompts = createPromptLibrary({ userDir: layout.prompts, agentsDir: layout.agentPrompts, log });
  prompts.check();

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
      views: [...conversationViews, cardsView, inboxView, remindersView, pairingView, internalJobsView, approvalsView, effectLogView, executionsView, toolCallDetailsView, tasksView, workTimesView, activityView, projectsView, ledgerView, subAgentsView, voicesView, agentVoicesView, workOrdersView, scopeRecordsView, scheduledJobsView],
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
    // 个人助理的名字（43）：照工作日历的个人设置存和推；秘书的系统提示里有它
    const assistantName = createAssistantNameService({ store, layout, log });
    assistantName.start();
    teardown.push(() => assistantName.stop());
    // 秘书会话的已读位置（109）：几台设备同步"看到哪一条了"；还没有记录时记一条，升级上来的历史消息当作都看过
    const readMarks = createReadMarks({ store, now });
    readMarks.start();

    // 卡片类型注册表：各票往这里登记自己的卡（06：简单提醒卡；10：配对请求卡）
    const registry = new CardTypeRegistry();
    const cards = createCardService({ store, registry, now });
    const inbox = createInboxService({ store, notifications, now, log });
    // "按我的工作日"的提醒和内部作业按当时的工作日历算下一次
    const scheduleContext = () => ({ calendar: workdayCalendar.current() });
    // 事件发生时提醒的（77）：事件触发方式经事件来源的分发查（它建在触发底座之后）
    const reminders = createReminderService({
      store,
      cards,
      inbox,
      scheduler,
      clock,
      scheduleContext,
      lateLimitMinutes: config.reminders.lateLimitMinutes,
      checkEvent: (trigger) => wired("eventTriggers").check(trigger),
    });
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
    // 任务模块、项目模块、执行控制器都要派单器（16，它建在它们之后）。
    // 两边先拿转手的对象，模块都建好之后在下面"接上"处一起填
    // 定时作业（19）：执行控制器数全局名额时要算上正在运行的作业，作业模块建在派单器之后；工作日历变了作业跟着重算
    const wiring: {
      maintainers?: Maintainers;
      projects?: ProjectService;
      projectMaintainers?: ProjectMaintainers;
      taskExecution?: TaskExecution;
      subAgents?: SubAgents;
      workOrders?: WorkOrders;
      scheduledJobs?: ScheduledJobs;
      materials?: Materials;
      eventTriggers?: EventTriggers;
    } = {};
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
      timelineRecordPurge,
      cardPurge(cards),
      ...cardSignalPurge,
      rememberCommandPurge,
      approvalDecisionPurge,
      approvalRequestPurge,
      effectRecordPurge,
      ...executionPurges,
      toolCallDetailPurge,
      operationRecordPurge,
      ...charterPurges,
      inboxItemPurge,
      outputReactionPurge,
      // 计划的决定、提问卡的回答、授权续期的决定（80）
      planDecisionPurge,
      clarificationAnswerPurge,
      grantRenewalPurge,
      parallelDecisionPurge,
      voicePurge,
      taskWaitNotePurge,
      workOrderPurge,
      scopeRecordPurge,
      toolkitDecisionPurge,
      workOrderDecisionPurge,
    );
    // 范围记录引着用户在维护者会话里的话、审批卡上的批准（18）：彻底删除那些时连带改写
    purgeRewriters.registerQuotes(...scopeRecordQuotes);
    // 任务（12）："建议发起任务"卡、提问卡、计划卡；计划里的授权项和时序规则照内置的工具注册表查。
    // 点"发起任务"时选的项目要在项目列表里（15）；计划里涉及的项目要对得上任务（17：提交计划、计划变更、自行调整都查）
    const planProjects = planProjectsCheck(() => wired("projects"));
    const tasks = createTaskService({
      store,
      cards,
      inbox,
      now,
      watchSettings,
      planTools: BUILTIN_TOOL_REGISTRY,
      // 计划的工具包里只能是 skill 库里的 skill、登记了的 MCP（27）
      toolkitProblems: (toolkit) => toolkits.nameProblems(toolkit),
      projects: {
        check: (names) => wired("projects").checkTaskProjects(names),
        idsOf: (names) => wired("projects").projectIdsOf(names),
        projectOf: (task) => wired("projects").projectOf(task),
        // 只涉及一个项目的任务一律是这个项目的内部任务，由它的维护者执行（16、64）：项目要在项目列表里、立项书已确认（首个建设任务例外）、没归档
        internalHost: (projectId, opts) => wired("projects").internalHost(projectId, opts),
      },
      // 项目的任务的任务书、打回意见派成起草计划的工单（16）；涉及多个项目的任务的计划确认时每一行建成工单（17）
      workOrders: {
        dispatchPlan: (task, instructions, key) => wired("workOrders").dispatchPlan(task, instructions, key),
        planConfirmed: (task, plan) => wired("workOrders").multiProject.planConfirmed(task, plan),
      },
      // 计划里涉及的项目要对得上任务（17）
      planProjects,
      // 升级前交、升级后才确认的长程任务计划里的定时作业（76）：照迁移的办法建成定时触发的普通任务
      legacyPlanJobs: (task, stored, grantInfo) => wired("scheduledJobs").legacyPlanConfirmed(task, stored, grantInfo),
      // 事件触发的任务（77）：事件触发方式经事件来源的分发查（登记表、文件夹能不能监视）
      checkEventTrigger: (trigger) => wired("eventTriggers").check(trigger),
    });
    registry.register(suggestTaskCardType(tasks));
    // 提问卡上的回答：项目维护者为工单问的交回它（16，派单器的澄清给通知）
    registry.register(questionsCardType((payload, answer, key) => wired("workOrders").clarificationReply(payload, answer, key)));
    registry.register(planCardType(tasks));
    // 流程计划卡（58 号票）：一次授权执行，或拒绝
    registry.register(workflowPlanCardType(tasks, () => wired("taskExecution")));
    // 工单卡（17）：计划外的工单待你确认，确认派出或拒绝
    registry.register(workOrderCardType(() => wired("workOrders").multiProject));
    // 被杀后的恢复（23）第 1 步：任何 agent 会话开始之前，记下上次被杀时正处理到一半的任务维护者
    const restart = scanBeforeStart(store, tasks);
    // 素材引着的任务、审批、卡片和待我处理的事项：认出项目内部的记录（64：秘书检索不到；66：删除项目时随项目删）
    const materialOwners: MaterialOwners = {
      task: (taskId) => tasks.get(taskId),
      approvalOrigin: (approvalId) => approvals.get(approvalId)?.origin,
      cardPayload: (cardId) => cards.get(cardId)?.payload,
      inboxItemsOfCard: (cardId) => inbox.itemsForCard(cardId),
    };
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
      // 删除项目时随项目彻底删除这个项目的内部任务由系统记下的素材（66；素材库建在项目模块之后）
      internalRecords: (projectId) => wired("materials").list().filter((m) => internalRecordOf(m, materialOwners)?.projectId === projectId),
      // 首个建设任务派工单、重置维护者、维护者会话里的消息属于当前这一段、有工单没结束的不能归档（16）
      workOrders: {
        dispatchPlan: (task, instructions, key) => wired("workOrders").dispatchPlan(task, instructions, key),
        reset: (project, key) => wired("workOrders").reset(project, key),
        scopeOf: (maintainerId) => wired("workOrders").scopeOf(maintainerId),
        openOf: (projectId) => wired("workOrders").openOf(projectId),
      },
      now,
      projectsDir: realLayout.projects,
      dataDir: realLayout.root,
      programDir,
      log,
    });
    registry.register(suggestProjectCardType(projects));
    registry.register(charterCardType(projects));
    // skill 库、MCP 登记和工具包（27）：skill 库是框架自带的加数据目录 skill 区里导入的；MCP 登记在配置区（只读），
    // 服务进程按需拉起、各放进自己的 Job 对象（不放 agent 管家的：那里按"从活着的 agent 走不到"回收孤儿）
    const skills = createSkillLibrary({ builtinDir: options.builtinSkillsDir ?? BUILTIN_SKILLS_DIR, userDir: realLayout.skills, dataDir: realLayout.root, now, log });
    // 秘书用的 skill（72）：名单在配置区（设置里的 skill 库页改），每次装配秘书时现取
    const secretarySkills = createSecretarySkills({ file: layout.secretarySkillsFile, library: skills, log });
    const mcp = createMcpService({
      file: layout.mcpFile,
      parentEnv: options.env,
      cwd: defaultMcpCwd(layout.tmp),
      newJob: () => (process.platform === "win32" ? createJobObject() : undefined),
      callTimeoutMs: config.agentLimits.toolCallMs,
      log,
    });
    fs.mkdirSync(defaultMcpCwd(layout.tmp), { recursive: true });
    teardown.push(() => mcp.stop());
    const toolkits = createToolkitService({ store, cards, inbox, projects, tasks, execution: () => wired("taskExecution"), skills, mcp, now, log });
    // skill 的目录名就是斜杠命令（82）：不合规的（手放的、更早导入的）不自动改名，启动时记一条日志，skill 库页上也提示
    const skillDirIssues = skillDirProblems(skills.skills());
    if (skillDirIssues.length > 0) log(`skill 的目录名有 ${skillDirIssues.length} 处要留意：${skillDirIssues.join("；")}`);
    registry.register(toolkitChangeCardType(toolkits));
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
    wiring.materials = materials;
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
    // 工单卡上的决定（审批决定，17）
    materials.register(workOrderDecisionSource);
    // 用户的语音（31）：识别完成时算用户发言，文字是识别出的文字
    materials.register(voiceMaterialSource);
    // 授权到期续期事项上的续期、不续（审批决定，14）；计划变更卡上的确认、拒绝走上面的 planDecisionSource
    materials.register(grantRenewalSource);
    // 工具包变更卡上的批准、拒绝，项目页和任务详情里直接改工具包（审批决定，27）
    materials.register(toolkitDecisionSource);
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
      wiring.scheduledJobs?.rearm();
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
    // 工具调用完整内容的保留期和总量上限（65）：每天定时清，错过了开机后补一次（内部作业，异步跑，不挡启动）
    const toolCallRetention = createToolCallDetailRetention({ store, internalJobs, clock, limits: config.toolCallDetails, log });
    toolCallRetention.start();
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
    // 子 agent、评审子 agent 拉起时自己带上阶段，不走这里。成本按现读的配置里的单价算，没配的按框架自带的价格表分时段算（94）
    const ledger = createTokenLedger({
      store,
      now,
      // 定时触发的任务（76）每次运行的用量记在任务名下（运行的输入带着触发登记的身份）；还没迁移的定时作业照旧记在作业名下
      taskOfJob: (jobId) => getJob(store.reader, jobId)?.ownerTaskId,
      currentStage: (taskId) => {
        const task = tasks.get(taskId);
        const list = task?.stages?.list;
        if (!task || !list || list.length === 0 || !UNFINISHED_TASK_STATES.includes(task.state) || allAccepted(list)) return undefined;
        // "当前阶段"只在 taskMessageScope 一处算（25）
        return taskMessageScope(task).stageId;
      },
      prices: () => readTokenPrices(layout.configFile),
      // 没配单价的用框架自带的价格表（94），它的高峰时段扣掉国内法定节假日：用工作日历的节假日数据（框架自带的加导入的）
      holidays: () => workdayCalendar.holidays(),
      log,
    });
    // 浏览器（70）：联网搜索、读网页和 agent-browser 共用一处探测（配置的 web.browserPath → 守护进程环境里的 AGENT_BROWSER_EXECUTABLE_PATH
    // → agent-browser 自带的签名 Chrome → 系统 Chrome → 系统 Edge），找到了就记住；拉起 agent 时注入 bash 的环境
    const browserLocator = createBrowserLocator({ configured: config.web.browserPath, homeDir: options.homeDir, env: options.env, log });
    const browserPath = options.browserPath ?? (() => browserLocator.path());
    const agents = createAgentManager({
      layout,
      parentEnv: options.env,
      browserPath,
      job,
      limits: config.agentLimits,
      onActivity: activity.record,
      onProgress: activity.progress,
      onUsage: ledger.record,
      // 接着会话时给被中断的工具调用补上的结果（23）：等审批的、有副作用说不清做没做完的，按事件日志现取
      interruptedToolResults: (agentId) => interruptedToolResults(store.reader, agentId),
      // 前缀（71）：拉起时加在每个 agent 的系统提示最前面，每次现读
      systemPromptPrefix: (systemPrompt) => prompts.withPrefix(systemPrompt),
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
      // 对话审批的开关（70，101 改了关着时的范围）：配置 guard.conversationApprovals，默认关着——秘书除了特别敏感的都直接做，
      // 任务的 agent 超出授权先不管，都照常记录、标关注类别；开着时一切照原样
      conversationApprovals: config.guard.conversationApprovals,
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
    // 立即运行一次、跑完自动播报（100）：用户说"把 t-5 再跑一次""以后 t-5 跑完直接念给我"
    for (const executor of taskRunActions({ tasks, scheduledJobs: () => wired("scheduledJobs") })) quickActionRegistry.register(executor);
    // 秘书转达（103）：按用户的话往已有的任务、项目维护者的会话里插一句，和用户在那里直接说话同一条路（下面 userMessageScopeOf、
    // userMessagePreludeOf，网关发消息也用它们），消息标上秘书转达
    for (const executor of relayActions({ store, tasks, scopeOf: (c, taskId) => userMessageScopeOf(c, taskId), preludeOf: (c, key, taskId) => userMessagePreludeOf(c, key, taskId) })) {
      quickActionRegistry.register(executor);
    }
    // 调用授权给秘书快速动作的 MCP 工具（27）：参数按登记固定，由守护进程转给 MCP 服务进程，不拉起 agent
    quickActionRegistry.register(mcpQuickAction(mcp));
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
    // 参考音色（32）：数据目录 voices 区里的文件就是真相，设置里的语音页经 HTTP 导入、选用、删除。
    // 语音回复（32）：用户发语音时，agent 这一轮的回复经本机 LSM 托管的 audio.cpp 合成语音（二狗不启动它）；
    // 秘书和维护者各段的装配都多一个口语总结工具（在它们拉起之前开始跟回合）
    const referenceVoices = openReferenceVoices({ dir: layout.voices, log });
    // 模型预热（45）：在后台先加载识别模型、再用参考音色试合成一句让 audio.cpp 加载合成模型；不挡启动。
    // 两个模型的状态变了推一条临时事件（活动状态频道），本机接口 GET /api/voice-models 取得到同样的
    const voiceWarmup = createVoiceWarmup({
      recognizer,
      speech: createAudioCppSynthesizer({ ...voiceConfig.speech, url: options.speechUrl ?? voiceConfig.speech.url, log }),
      references: referenceVoices,
      probeMs: voiceConfig.speech.probeMs,
      ...(options.recognizerRetryMs === undefined ? {} : { retryMs: options.recognizerRetryMs }),
      ...(options.recognizerStableMs === undefined ? {} : { stableMs: options.recognizerStableMs }),
      onChange: (payload) => notifications.publish({ channel: CHANNELS.activity, seq: store.lastSeq(CHANNELS.activity), type: EVENT_TYPES.voiceModels, payload }),
      log,
    });
    // 先于识别进程关掉（停的时候不再重拉）
    teardown.push(() => voiceWarmup.stop());
    const voiceReplies = createVoiceReplies({
      store,
      media,
      inbox,
      references: referenceVoices,
      // 试合成在做时，语音回复的合成等它做完再发
      speech: voiceWarmup.speech,
      pace: voiceConfig.reply,
      clock,
      tmpDir: layout.tmp,
      ...(options.sendVoiceWaitMs === undefined ? {} : { sendVoiceWaitMs: options.sendVoiceWaitMs }),
      log,
    });
    voiceReplies.start();
    teardown.push(() => voiceReplies.stop());
    voiceWarmup.start();

    const credentials = modelCredentials(options.env);
    // 设置里的"模型"（73）：按 agent 现取、只用于新开的会话（接着的会话子进程照它开始时的）；看图能力设置页改的优先于配置文件
    let lsmEnabled = false;
    const modelSettings = createModelSettings({
      layout,
      config,
      credentials,
      probe: (request) => agents.probeModels(request),
      lsm: () => lsmEnabled,
      secretarySession: () => secretary.sessionModel,
      ...(options.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: options.catalogBaseUrl }),
      log,
    });
    const agentModel = (agent: ModelAgent) => modelSettings.modelFor(agent);
    const configuredVision = () => modelSettings.configuredVision();
    // 联网搜索、读网页（70）：秘书、任务维护者（起草和执行）、项目维护者、定时作业的维护者、子 agent 都配上（评审子 agent 不配）；
    // 联网开关关着的会话里守卫拒绝。搜索走浏览器（DDG → Bing → Google），要 tavily 的走 Tavily（key 只从环境里取），
    // 读网页先直接请求、被拦了再走浏览器
    const web = webTools(
      options.webAccess ??
        createWebAccess({
          browser: playwrightDriver({ executablePath: browserPath, missing: () => browserLocator.missingReason() }),
          tavilyKey: () => tavilyKey(options.env),
          log,
        }),
    );
    // 每个会话都配的工具（装配用的一个对象）：联网搜索、读网页，语音回复（32）
    const sessionTools: SessionTools = { web, voiceReplies };
    const secretaryModel = () => options.secretaryModel ?? agentModel("secretary");
    const firstSecretaryModel = secretaryModel();
    if (firstSecretaryModel.kind === "catalog" && !credentials[firstSecretaryModel.provider]) {
      log(`没有 ${firstSecretaryModel.provider} 的模型 key：秘书能起来，但每次回复都会出错（key 由 LSM 从数据目录的密钥区注入）`);
    }
    // 消息前的时间标记按配置的 timeZone，简单提醒的时间（06）按本机时区算：两者不一致时秘书写的提醒时间会差开
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const configuredZone = Intl.DateTimeFormat("en-US", { timeZone: config.timeZone }).resolvedOptions().timeZone;
    if (configuredZone !== localZone) {
      log(`配置的 timeZone 是 ${configuredZone}，本机时区是 ${localZone}：秘书看到的消息时间按前者，简单提醒的时间按本机时区算，两者会差开；不需要另设时区时把 timeZone 去掉`);
    }
    // 秘书的工具：建、改、取消提醒（06），素材检索和提议快速动作（21），任务发起的四个（12）和交给后台（75：普通任务），建议立项（15），
    // 只读的查看板、读项目档案、列出待我处理和把卡片放进聊天（22；没有任何对卡片做动作的工具）
    const secretaryTools = [
      ...reminderTools(reminders, clock),
      // 项目内部的记录秘书检索不到（64）
      searchMaterialsTool(materials, materialOwners),
      proposeQuickActionTool(quickActions, CHANNELS.secretary),
      // 58 号票：发起任务要用户这一轮点明了（看秘书正在处理的那条用户消息）
      ...taskTools(tasks, cards, (inputMessageId) => readUserTurn(store, cards, inputMessageId)),
      suggestProjectTool(cards),
      viewBoardTool(store),
      readProjectRecordsTool(projects),
      // 项目内部任务的事项秘书只看到是哪个项目内部的（64）
      ...inboxTools(inbox, cards),
      ...(options.extraSecretaryTools ?? []),
    ];
    // 自定义关注类别能匹配的工具（设置页的候选，也用来查写错的名字）：内置的和 bash 拆出的伪工具、秘书代为执行的工具、快速动作的伪工具
    const watchToolChoices = () => {
      const all = [
        ...Object.values(BUILTIN_TOOL_REGISTRY),
        ...secretaryTools.map((t) => t.descriptor),
        // 登记的 MCP 工具（27）
        ...mcp.descriptors(),
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
      configuredVision,
      guards,
      scratchDir: realLayout.scratch,
      sessionRewriteFor,
      timeZone: config.timeZone,
      sessionTools,
      assistantName,
      skills: secretarySkills,
      // 用户打 /目录名 时展开秘书装配了的 skill（82）
      skillCommands: () => toolkits.skillCommands(),
      conversationApprovals: config.guard.conversationApprovals,
      prompts,
      // 任务做完、定时 / 事件触发的任务每运行完一次告诉秘书（99）：交付的文件在任务的产出区里找
      taskDone: { clock, settleMs: options.taskDoneSettleMs ?? TASK_DONE_SETTLE_MS, outputsDir: realLayout.outputs },
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

    // 给秘书发消息（102）：除了秘书，每个 agent（维护者、子 agent、评审）默认都有；发出的记在守护进程内部的频道上，
    // 交给秘书由秘书模块照任务做完的那一套交
    const letters = createSecretaryLetters({ store, clock });
    // 全局执行名额（13、19）：执行中的任务和开始了的定时作业运行共用，谁占着只在 tasks/slots.ts 里数
    const slots = createExecutionSlots({ max: config.tasks.maxRunning, store, log });
    slots.attach();
    teardown.push(() => slots.stop());
    // 任务执行（13）：确认过的任务排队、按名额开始执行，阶段推进和验收（脚本在工作目录里跑，评审派只读的评审子 agent）
    const reviewerModel = options.reviewerModel ?? (() => agentModel("reviewer"));
    const taskExecution = createTaskExecution({
      store,
      tasks,
      cards,
      inbox,
      now,
      clock,
      scheduler,
      slots,
      // 拉回、催促、验收退回、预算、累计被拒的阈值（14）
      thresholds: config.tasks.thresholds,
      // 预算比较的 token 从账本取（24）：这个阶段干活用掉的（不算评审、范围审视）
      stageTokens: (taskId, stageId) => ledger.stageTokens(taskId, stageId, { budget: true }),
      // 无进展的判定：维护者的子进程在运行才算"活着却没进展"
      agentAlive: (agentId) => agents.live().some((a) => a.agentId === agentId),
      watchSettings,
      planTools: BUILTIN_TOOL_REGISTRY,
      // 阶段详情列已经做了的事、算授权已用几次（84）：框架自带的工具加登记的 MCP
      effectTools: () => ({ ...BUILTIN_TOOL_REGISTRY, ...Object.fromEntries(mcp.descriptors().map((d) => [d.name, d])) }),
      homeDir: places.homeDir,
      // 从某个阶段重做之前先停稳维护者手头这一轮（84）：任务自己的维护者，连同手上是这个任务的工单的项目维护者
      // （单项目任务由项目维护者执行；涉及多个项目的任务，派出的工单在各项目维护者那里做）一起停
      stopTurn: async (task, how) => {
        const held = (await Promise.all([wired("maintainers").stopTaskTurn(task, how), wiring.projectMaintainers?.stopTaskTurn(task, how)])).filter((r) => r !== undefined);
        return held.length > 0 ? () => held.forEach((release) => release()) : undefined;
      },
      ...(options.reworkStopTimeoutMs === undefined ? {} : { reworkStopTimeoutMs: options.reworkStopTimeoutMs }),
      toolkitProblems: (toolkit) => toolkits.nameProblems(toolkit),
      outputsDir: realLayout.outputs,
      acceptance: {
        // 脚本照带类型 bash 工具的启动器起（闸门进程先进这次调用的 Job 对象，28）
        runScript: ({ cwd, script, expectOutput, network }) =>
          runAcceptanceScript(typedShell, { cwd, script, ...(expectOutput ? { expectOutput } : {}), network, timeoutMs: ACCEPTANCE_SCRIPT_TIMEOUT_MS }),
        review: createReviewer({ agents, guards, model: reviewerModel, credentials, prompts, letters, log }),
      },
      subAgentsOn: (taskId) => wired("subAgents").busyStages(taskId),
      // 只涉及一个项目的任务（16）：在项目的工作目录里做，工具包取任务授权和项目工具包的交集，项目的维护者正忙时留在排队中
      projectTasks: {
        of: (task) => {
          const project = projects.projectOf(task);
          return project && { projectId: project.id, workDir: real(projects.workdir(project)), toolkit: projectToolkit(project) };
        },
        admit: (task) => wired("workOrders").admit(task),
      },
      // 计划变更、自行调整之后维护者的工具包变了：活着的子 agent 按新的交集重新装配（14 接 20）
      toolkitChanged: (taskId) => wired("subAgents").reassemble(taskId),
      // 涉及多个项目的任务（17）：维护者的工具包固定，本阶段的回执全部到齐且都完成才能宣布阶段完成
      multiProject: {
        toolkit: multiProjectToolkit,
        stageGate: (task, stageId) => wired("workOrders").multiProject.stageGate(task, stageId),
        stageLines: (task, stageId) => wired("workOrders").multiProject.stageLines(task, stageId),
        reviewPlaces: (task, stageId) => wired("workOrders").multiProject.reviewPlaces(task, stageId),
      },
      planProjects,
      log,
    });
    teardown.push(() => taskExecution.stop());
    // 账本记下任务名下某个阶段的一次用量（24）：执行控制器比一比预算（14）
    teardown.push(
      ledger.onRecorded((entry) => {
        if (entry.owner?.kind === "task" && entry.stageId !== undefined) taskExecution.tokensRecorded(entry.owner.id, entry.stageId);
      }),
    );
    // 计划变更卡（14）：确认、拒绝都由执行控制器处理
    registry.register(planChangeCardType(taskExecution));
    // 任务完成（全部阶段验收通过）后：节假日数据的更新任务（29）导入交付件；项目的首个建设任务（15）让项目进入使用中
    taskExecution.onCompleted((completed) => holidayUpdates.taskCompleted(completed));
    taskExecution.onCompleted(({ task }) => projects.taskCompleted(task));

    // 范围审视（18）：对照物和近期范围记录交给维护者的子进程（审视在子进程里做），审视的结果存成范围记录、写进项目档案或任务的产出区
    const scopeReviewService = createScopeReview({ store, inbox, projects, tasks, outputsDir: realLayout.outputs, now, log });
    scopeReviewService.start();
    teardown.push(() => scopeReviewService.stop());
    const scopeReview: MaintainerScopeReview = {
      service: scopeReviewService,
      // 审视用的模型每次审视时现取（拉起维护者时、交每条输入之前、工单结束时的审视），设置里改了下一次审视就用新的（73）
      model: options.scopeReviewModel ?? (() => agentModel("scope_review")),
      // 工单结束时的审视最多等一次模型调用的超时（再多给半分钟收尾）
      prompts,
      timeoutMs: options.scopeReviewTimeoutMs ?? config.agentLimits.modelCallMs + 30_000,
    };

    // 流程（58）：交来的计划先审查修补（planguard 的规划时审查），按执行时的守卫标注每一步；审查的耗时用真实的计时器。
    // 任务自己的维护者和项目的维护者（64：项目内部的流程）共用，执行它的维护者的样子由各自给
    const workflowReview =
      (task: Task, executor: WorkflowExecutor): WorkflowReviewer =>
      (draft, version) => {
        const started = performance.now();
        return reviewWorkflowDraft(draft, version, {
          tools: BUILTIN_TOOL_REGISTRY,
          settings: watchSettings(),
          places,
          maintainerId: task.maintainerId,
          cwd: executor.cwd,
          ...(executor.projectRecords ? { projectRecords: executor.projectRecords } : {}),
          ...(executor.projectToolkit ? { projectToolkit: executor.projectToolkit } : {}),
          now: clock.now(),
          elapsed: () => performance.now() - started,
        });
      };
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
      model: options.maintainerModel ?? (() => agentModel("task_maintainer")),
      scopeReview,
      configuredVision,
      credentials,
      timeZone: config.timeZone,
      typedShell,
      // 系统提示里给维护者讲的阈值（14）
      thresholds: config.tasks.thresholds,
      prompts,
      ...(options.maintainerToolkit ? { toolkit: options.maintainerToolkit } : {}),
      sessionRewriteFor,
      // 项目的维护者（含任务转为项目后原任务的维护者）由项目模块接；作业自己的维护者（jm-<n>，76 号票之前的定时作业迁移成
      // 定时触发的普通任务后照旧由它做）由作业维护者模块接
      excluded: (maintainerId) => projects.ofMaintainer(maintainerId) !== undefined || isJobMaintainerId(maintainerId),
      subAgentTools: (scope) => wired("subAgents").toolsFor(scope),
      sessionTools,
      // 工具包里的 skill、MCP，执行时增减 skill 的工具（27）
      toolkits: {
        skillPaths: toolkits.skillPaths,
        mcpTools: toolkits.mcpTools,
        skillTool: (scope) => toolkits.skillTool({ kind: "task", scope }),
        skillCommands: () => toolkits.skillCommands(),
      },
      letters,
      // 涉及多个项目的任务（17）：维护者的工具包固定为三样（读项目档案、派工单、汇总回执），加上转问用户
      multiProject: {
        tools: (scope) => multiProjectTools({ workOrders: () => wired("workOrders"), projects, tasks }, scope),
        executionTools: (scope) => [answerWorkOrderTool(() => wired("workOrders"), scope), forwardToUserTool(() => wired("workOrders"), scope)],
      },
      // 流程（58）：交来的计划先审查修补（planguard 的规划时审查），按执行时的守卫标注每一步；审查的耗时用真实的计时器
      workflowReview,
      // 普通任务（75）的 agent：skill 用助理的那一份（每次唤起现取）；系统提示里工作目录外的说法跟着对话审批的开关
      plainSkills: () => secretarySkills.view().skills,
      conversationApprovals: config.guard.conversationApprovals,
      // 定时触发的任务（76）：触发底座建在维护者模块之后，现取（每次运行一段、"报告这次运行失败"、流程的授权）
      triggers: () => wiring.scheduledJobs && { jobOf: (taskId) => wiring.scheduledJobs!.ofTask(taskId), currentRun: (jobId) => wiring.scheduledJobs!.currentRun(jobId), runNoticeId: (runId) => wiring.scheduledJobs!.runNoticeId(runId), runAssembly: (jobId, maintainerId) => wiring.scheduledJobs!.runAssembly(jobId, maintainerId) },
      runFailureLimit: config.scheduledJobs.jobFailures,
      // 换模型时交接摘要的写法（83）：定时触发的任务下一次运行开头新开会话、附交接摘要
      handoffInstructions: () => handoffInstructions(prompts),
      log,
    });
    wiring.maintainers = maintainers;
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
      sessionTools,
      // 子 agent 也能给秘书发消息（102）：维护者有的它才有
      letters,
      // 项目的维护者执行的任务（16）由项目维护者模块给装配
      maintainerAssembly: (taskId) => maintainers.assemblyOf(taskId) ?? wired("projectMaintainers").assemblyOf(taskId),
      projectOf: (taskId) => {
        const task = tasks.get(taskId);
        return task && projects.projectOf(task)?.id;
      },
      watchSettings,
      planTools: BUILTIN_TOOL_REGISTRY,
      model: options.subAgentModel ?? (() => agentModel("sub_agent")),
      credentials,
      now,
      prompts,
      log,
    });
    registry.register(parallelCardType(subAgents));
    wiring.subAgents = subAgents;
    subAgents.start();
    teardown.push(() => subAgents.stop());
    // 派单器（16）：工单和项目维护者的会话分段（执行控制器在它之前建好，直接交给它）；写回最多催几次和执行中的催促同一个阈值（14）。
    // 工单结束时的范围审视（18）由项目维护者模块做（子进程退出之前）：审视是异步的，到时候各模块都已接上
    const workOrders = createWorkOrders({
      store,
      tasks,
      projects,
      cards,
      inbox,
      execution: taskExecution,
      nudges: config.tasks.thresholds.nudges,
      reviewScope: (segment) => wired("projectMaintainers").reviewScope(segment),
      // 计划外工单（17）：作为伪工具调用交给守卫的判定函数（任务里、工单所属的阶段，现取的关注类别设置）
      // 派单的维护者在守卫眼里的样子取它此刻的装配（和它别的调用一样）；对话审批关着时超出授权先不管、直接派出（101）
      judgeUnplanned: ({ task, maintainerId, project }) => {
        const assembly = maintainers.assemblyOf(task.taskId);
        if (!assembly) return { refused: workOrderRefusal.notExecuting(task.taskId) };
        return judgeUnplannedWorkOrder({
          agent: maintainerGuardAgent(maintainerId, assembly),
          places,
          task,
          settings: watchSettings(),
          project: project.name,
          now: clock.now(),
          conversationApprovals: config.guard.conversationApprovals,
        });
      },
      // 定时作业的运行工单排到了还要有名额才开始（19）
      slots,
      now,
      log,
    });
    wiring.workOrders = workOrders;
    workOrders.start();
    teardown.push(() => workOrders.stop());
    // 任务的维护者在派单器接上之后再起：重启时马上要拉起的涉及多个项目的任务的维护者，一起来就可能派工单（17）
    maintainers.start();
    teardown.push(() => maintainers.stop());
    // 定时作业（19）：确认计划后登记，到点时一次运行进队列，真正开始时占一个全局名额（属于项目的派工单给项目维护者，
    // 不属于项目的交给作业自己的维护者）。先接上事件（项目维护者、作业维护者开始接输入时把被打断的运行标成中断，这里要看到），
    // 补跑错过的放在恢复之后
    const scheduledJobs = createScheduledJobs({
      store,
      tasks,
      projects,
      workOrders,
      inbox,
      scheduler,
      clock,
      now,
      scheduleContext,
      slots,
      failureLimit: config.scheduledJobs.jobFailures,
      maxRunSteps: config.eventSources.maxRunSteps,
      log,
    });
    wiring.scheduledJobs = scheduledJobs;
    scheduledJobs.attach();
    teardown.push(() => scheduledJobs.stop());
    // 事件触发（77）：事件来源登记表里每个来源一份实现（event-sources/sources.ts）——二狗内部事件、本机文件夹变化（fs.watch，
    // 比对底子在数据目录的 event-sources/）；事件来了交给触发底座（事件触发的任务）或简单提醒（事件发生时提醒的）。
    // 不许监视的地方：守卫的受保护区域（同一份 protectedAreasOf：配置区、密钥区、数据库区、程序目录），最后是整个数据目录
    const eventTriggers = createEventTriggers({
      store,
      scheduledJobs,
      reminders,
      sources: eventSourceImplementations({
        store,
        clock,
        stateDir: realLayout.eventSources,
        forbidden: () => [...protectedAreasOf(places), { dir: places.dataDir.root, title: DATA_DIR_TITLE }],
        thresholds: config.eventSources,
      }),
      log,
    });
    wiring.eventTriggers = eventTriggers;
    teardown.push(() => eventTriggers.stop());
    const jobMaintainers = createJobMaintainers({
      agents,
      store,
      streams,
      guards,
      media,
      typedShell,
      sessionTools,
      // 工具包里的 skill、MCP 照样落进作业维护者的会话（27）；作业的运行里没有"增减 skill"
      toolkits: { skillPaths: toolkits.skillPaths, mcpTools: toolkits.mcpTools, skillCommands: () => toolkits.skillCommands() },
      letters,
      outputsDir: realLayout.outputs,
      runAssembly: (jobId, maintainerId) => scheduledJobs.runAssembly(jobId, maintainerId),
      currentRun: (jobId) => scheduledJobs.currentRun(jobId),
      systemPrompt: () => jobMaintainerSystemPrompt(prompts, config.scheduledJobs.jobFailures, config.guard.conversationApprovals),
      // 换模型时交接摘要的写法（83）：下一次运行开头新开会话、附交接摘要
      handoffInstructions: () => handoffInstructions(prompts),
      // 定时作业自己的维护者算任务维护者（作业来自任务的计划，73）
      model: options.maintainerModel ?? (() => agentModel("task_maintainer")),
      configuredVision,
      credentials,
      timeZone: config.timeZone,
      sessionRewriteFor,
      log,
    });
    jobMaintainers.start();
    teardown.push(() => jobMaintainers.stop());
    // 每周的归档清单（19）：任务模块的内部作业（错过了开机后补一次），选"继续改"时走执行控制器
    registry.register(archiveListCardType({ tasks, execution: () => taskExecution }));
    const archiveList = createArchiveList({ store, tasks, cards, inbox, internalJobs, clock, afterDays: config.tasks.thresholds.archiveAfterDays });
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
      tasks,
      execution: taskExecution,
      workOrders,
      typedShell,
      // 系统提示里给维护者讲的阈值（14）
      thresholds: config.tasks.thresholds,
      prompts,
      taskMaintainers: maintainers,
      // 执行的工单段里也能提议并行（20）
      subAgentTools: (scope) => subAgents.toolsFor(scope),
      // 定时作业的一次运行的工单段（19）：作业所在计划的工具包、报告这次运行失败、守卫看到的作业的授权
      jobRun: (wo, maintainerId) => scheduledJobs.runAssembly(wo.scheduledJobId, maintainerId),
      reassembleSubAgents: (taskId) => void subAgents.reassemble(taskId),
      // 工具包里的 skill、MCP，增减 skill、申请工具包变更的工具（27）
      toolkits: {
        skillPaths: toolkits.skillPaths,
        mcpTools: toolkits.mcpTools,
        skillCommands: () => toolkits.skillCommands(),
        skillTool: (scope) => toolkits.skillTool({ kind: "task", scope }),
        projectSkillTool: (projectId, maintainerId) => toolkits.skillTool({ kind: "project", projectId, maintainerId }),
        requestTool: (projectId, maintainerId) => toolkits.requestTool(projectId, maintainerId),
      },
      letters,
      layout,
      model: options.maintainerModel ?? (() => agentModel("project_maintainer")),
      scopeReview,
      configuredVision,
      credentials,
      timeZone: config.timeZone,
      sessionRewriteFor,
      sessionTools,
      // 项目内部任务（64）：对话段里发起任务的工具（点明了才建，看维护者正在处理的那条用户消息）；项目内部的流程照样先审查修补
      internalTaskTools: (scope) => internalTaskTools({ tasks, cards, projects, userTurn: (inputMessageId) => readUserTurn(store, cards, inputMessageId) }, scope),
      workflowReview,
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
    // 错过的定时触发（规格第 13、17 节）：恢复做完之后，重启前在跑的运行对一遍，停机期间错过的作业只补跑一次；
    // 每周的归档清单登记成内部作业（错过了同样补一次）
    scheduledJobs.start();
    archiveList.start();
    // 事件触发（77）：触发登记、提醒都起来之后按现在的订阅开始盯（文件夹先和比对底子比一遍，补发停机期间的变化）
    eventTriggers.start();

    /**
     * 用户往维护者的会话里说话时消息的归属：项目的（15）带上项目，任务的（13）带上任务；别的会话不认（收不了的抛出原因）。
     * taskId 是用户在哪个任务的详情里说的（75：项目内部的普通任务做完了接着说，消息属于它）。网关发消息、秘书转达（103）共用
     */
    const userMessageScopeOf = (conversation: ConversationId, taskId?: string) => projects.conversationScope(conversation, taskId) ?? userMessageScope(tasks, conversation);
    /** 项目维护者手上没有在进行的段时，用户的话开一个对话段（分隔线在这句话之前，16）；在项目内部的普通任务的详情里说的不开（75） */
    const userMessagePreludeOf = (conversation: ConversationId, key: string, taskId?: string) =>
      conversation.startsWith(MAINTAINER_CHANNEL_PREFIX) ? workOrders.messagePrelude(conversation.slice(MAINTAINER_CHANNEL_PREFIX.length), key, taskId) : [];

    /** 用户对一个任务的控制（task_action）：定时触发的任务（76）运营中时的暂停、恢复、取消落到它的触发上（取消时任务随之取消） */
    const taskAction = (params: TaskActionParams, idempotencyKey: string): TaskActionResult | Promise<TaskActionResult> => {
      const task = tasks.get(params.taskId);
      const triggerAction = params.action === "pause" || params.action === "resume" || params.action === "cancel" ? params.action : undefined;
      if (task?.state === "operating" && triggerAction && scheduledJobs.ofTask(task.id)) return scheduledJobs.actOnTask(task.id, triggerAction, idempotencyKey);
      return taskExecution.act(params, idempotencyKey);
    };

    const gateway = await startGateway({
      port: localPort,
      externalPort: options.externalPort ?? config.ports.external,
      pairing,
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.webVersionPollMs === undefined ? {} : { webVersionPollMs: options.webVersionPollMs }),
      store,
      streams,
      notifications,
      requests: {
        cardAction: (params, idempotencyKey) => cards.act({ ...params, idempotencyKey }),
        inboxAction: (params, idempotencyKey) => inbox.act({ ...params, idempotencyKey }),
        revokeDevice: (params, idempotencyKey) => pairing.revoke(params.deviceId, idempotencyKey),
        startTask: (params, idempotencyKey) => ({ taskId: tasks.startFromButton(params, idempotencyKey).id }),
        updateWatchCategories: (params, idempotencyKey) => watchCategories.update(params, idempotencyKey),
        // 定时触发的任务（76）运营中时的暂停、恢复、取消落到它的触发上（取消时任务随之取消）
        taskAction,
        // 看板多选（90）：一个一个交给上面那条路，各自成败、逐条回报
        taskBatchAction: createTaskBatch({ act: taskAction, log }),
        // 发起对话框里的"只提醒我"（76）：用户建的简单提醒（不用 agent，到点只发通知），同一幂等键重发拿到同一条
        createReminder: (params, idempotencyKey) => reminders.createFromUser(params, idempotencyKey),
        scheduledJobAction: (params, idempotencyKey) => scheduledJobs.act(params, idempotencyKey),
        // 任务操作菜单里的"改时间"（98）：只换定时触发的任务的时间表，任务、会话、运行记录不变
        rescheduleJob: (params, idempotencyKey) => scheduledJobs.reschedule(params, idempotencyKey),
        // 任务操作菜单里的"立即运行一次"（100）：触发记成手动，不改时间表；上一次还没跑完的拒绝
        runJobNow: (params, idempotencyKey) => scheduledJobs.runNow(params, idempotencyKey),
        // 任务操作菜单里的"跑完自动播报：开 / 关"（100）：开着的做完秘书直接念成语音，不问
        setVoiceAnnounce: (params, idempotencyKey) => tasks.setVoiceAnnounce(params, idempotencyKey),
        // 秘书页上看到哪一条了（109）：只往后挪，几台设备同步
        markRead: (params, idempotencyKey) => readMarks.markRead(params, idempotencyKey),
        // 用户往维护者的会话里说话：归属和要先追加的事件（秘书转达也走这两个，103）
        messageScope: userMessageScopeOf,
        messagePrelude: userMessagePreludeOf,
        newProject: (params, idempotencyKey) => projects.newProject(params, idempotencyKey),
        convertTaskToProject: (params, idempotencyKey) => projects.convertTask(params, idempotencyKey),
        projectAction: (params, idempotencyKey) => projects.act(params, idempotencyKey),
        resetMaintainer: (params, idempotencyKey) => projects.resetMaintainer(params.projectId, idempotencyKey),
        voiceIntake: voice.intake,
        retryVoice: (params, idempotencyKey) => voice.retry(params, idempotencyKey),
        setToolkit: (params, idempotencyKey) => toolkits.set(params, idempotencyKey),
      },
      webRoot: options.webRoot ?? DEFAULT_WEB_ROOT,
      health: () => {
        const s = secretary.health();
        return { ok: s.ok, details: { secretary: s.status }, reasons: s.reason === undefined ? [] : [s.reason] };
      },
      api: createHttpApi({
        media,
        store,
        materialDeletion,
        workdayCalendar,
        assistantName,
        // 主导航的日历（35）：工作日判定、提醒和定时作业按天合起来
        calendar: createCalendarService({ store, workdayCalendar, reminders, scheduledJobs, clock }),
        ledger,
        referenceVoices,
        agentVoiceSegment: (voiceId, index) => voiceReplies.segmentFile(voiceId, index),
        voiceModels: () => voiceWarmup.view(),
        toolkits,
        secretarySkills,
        // 输入框里打 / 弹出的候选（82）：这个会话能用的二狗的命令和 skill，和装配时一样现取
        slashCommands: (conversation) =>
          conversationSlashCommands(
            {
              table: () => toolkits.skillCommands(),
              secretarySkills: () => secretarySkills.view().skills,
              projectSkills: (maintainerId) => projectMaintainers.skillsOf(maintainerId),
              taskSkills: (maintainerId) => maintainers.skillsOf(maintainerId),
            },
            conversation,
          ),
        toolCallStorage: toolCallRetention,
        // 设置里的系统提示（71）：看、改、恢复默认
        systemPrompts: prompts,
        modelSettings,
        // 长程任务的阶段详情（84）：授权已用几次、从这里重做的范围、已经做了的事
        taskStage: (taskId, stageId) => taskExecution.stageView(taskId, stageId),
        // 每个 agent 的会话里的 ⚙（114）：秘书、任务自己的维护者、项目维护者各自认自己的
        agentSettings: createAgentSettings({
          prompts,
          ledger,
          agents,
          resolve: (agentId) => (agentId === SECRETARY_AGENT_ID ? secretary.agentHandle() : (projectMaintainers.agentHandle(agentId) ?? maintainers.agentHandle(agentId))),
        }),
        log,
      }),
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
    lsmEnabled = lsm.enabled;
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
      assistantName,
      modelSettings,
      holidayUpdates,
      materials,
      pairing,
      approvals,
      tasks,
      projects,
      taskExecution,
      subAgents,
      ledger,
      workOrders,
      scheduledJobs,
      eventTriggers,
      archiveList,
      guards,
      quickActions,
      watchCategories,
      voice,
      voiceReplies,
      skills,
      secretarySkills,
      mcp,
      toolkits,
      scheduler,
      internalJobs,
      backup,
      toolCallRetention,
      prompts,
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
