// 守护进程的组装：读配置、找到数据目录、打开事件存储、建 Job 对象、立起 agent 管家和秘书、
// 任务和维护者（12 号票）、项目和项目的维护者（15 号票）、token 账本（24 号票）、开本机端口和外网端口（设备配对在 10 号票）；
// skill 库、MCP 登记和工具包（27 号票）。
// 126 号票（ADR-0027）起这里只装内核，插件按插件清单（plugins/manifest.ts）经插件宿主（plugins/host.ts）装：
// 插件的视图在打开事件存储之前收齐，内核的登记表（卡片类型、改写函数、素材来源、快速动作、内部作业、看板种类、事件触发的订阅方）
// 建好之后、素材开始采集之前装配和启动插件，停的时候插件按依赖倒着停。
// 129 号票起素材库（materials.db 和原文副本的保管）是内核的，采成素材、记忆命令、记忆删除卡、向量索引和检索是记忆插件的（插件清单里列它）。
// 214 号票起语音也是插件：识别、合成、语音回复、预热、参考音色都在语音插件里；语音对象的两个视图是内核的数据契约（voice-records/），
// 插件停用了照样登记、照样投影。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEEPSEEK_DEFAULT_MODEL, type ChatModel } from "@ergo/memory";
import {
  CHANNELS,
  COMPONENT_FEATURES,
  type ConversationId,
  EVENT_TYPES,
  type EventFrame,
  type ExternalCalendarEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  type MessageScope,
  type PluginStatusEventPayload,
  rollbackEnabled,
  type ModelAgent,
  operationsItemLock,
  archiveCancelsFirst,
  type ProjectEventPayload,
  t,
  type Task,
  type TaskActionParams,
  type TaskActionResult,
  type TaskEventPayload,
  UNFINISHED_TASK_STATES,
} from "@ergo/protocol";
import { activityView, createActivityLog } from "./activity/activity.ts";
import { agentSessionDir, createAgentManager, type AgentManager } from "./agent-manager/agent-manager.ts";
import type { HostTool, HostToolCall } from "./agent-manager/host-tools.ts";
import { bashTmpMount } from "./agent-manager/work-temp.ts";
import { approvalCardType, type ApprovalService, createApprovalService } from "./approvals/approvals.ts";
import { approvalDecisionPurge, approvalDecisionSource, approvalRequestPurge } from "./approvals/material-source.ts";
import { approvalsView } from "./approvals/views.ts";
import { type BackupService, createBackupService } from "./backup/backup.ts";
import type { SnapshotFiles } from "./backup/files.ts";
import { BoardKindRegistry, type BoardKinds } from "./board/kinds.ts";
import { CALENDAR } from "./calendar/api.ts";
import { cardPurge, type CardService, createCardService } from "./cards/cards.ts";
import { createRuntimeQuestions, runtimeQuestionCardType } from "./conversation/runtime-questions.ts";
import { createSessionRollbacks, type RollbackSession, type SessionRollbackHook } from "./conversation/rollback.ts";
import { isConversationChannel } from "./conversation/history.ts";
import { type CardTypeDefinition, CardTypeRegistry } from "./cards/registry.ts";
import { cardsView } from "./cards/views.ts";
import { DEFAULT_MEMORY_PROVIDER, loadConfig, readTokenPrices, type ErgoConfig, writeFreshInstallDefaults } from "./config/config.ts";
import { oldNameNotes } from "./config/old-names.ts";
import { dataDirLayout, type DataDirLayout } from "./config/data-dir.ts";
import { modelConfigKey } from "./config/model-key.ts";
import { createSafetySettings, type SafetySettingsService, withLiveBudgetControl } from "./config/safety-settings.ts";
import { createSetupState, type SetupStateService } from "./config/setup-state.ts";
import { defaultSvcDataDir } from "./cli/context.ts";
import { type DoctorService, createDoctor, diskProbe, externalProbe, missingDefaultFeatures, nodeProbe, piVersionProbe, portsProbe, supervisorProbe } from "./doctor/doctor.ts";
import { modelCredentials, tavilyKey } from "./config/secrets.ts";
import { messagePurge, timelineRecordPurge } from "./conversation/purge.ts";
import { createReadMarks } from "./conversation/read-marks.ts";
import { createStreamHub } from "./conversation/stream-hub.ts";
import { conversationViews } from "./conversation/views.ts";
import { inAbandonedBranch } from "./conversation/session-branches.ts";
import { createQueueDelivery } from "./conversation/message-queue.ts";
import { RequestRejected } from "./errors.ts";
import { createEphemeralBus } from "./events/ephemeral.ts";
import { type EventStore, openEventStore } from "./events/event-store.ts";
import { DeletionParticipants } from "./deletion/participants.ts";
import { type ComponentProbes, type Components, componentTransport, createComponentProbes, createComponents, type LoadedManifest, loadManifest, shippedManifestVerifier, type Transport } from "./components/index.ts";
import { createDataSourceRegistry, createDataSources, createDataSourceSecrets, createDataSourceSettings, type DataSources, openFolderOnDesktop, registerDataSourceDeletion } from "./data-sources/index.ts";
import { startGateway } from "./gateway/gateway.ts";
import { createHttpApi } from "./gateway/http-api.ts";
import { createLanguageService, createLocales, type LanguageService, type Locales, withLanguageLine } from "./i18n/index.ts";
import { createAgentSettings } from "./agent-settings/index.ts";
import { openAgentRoles, type AgentRoles } from "./agent-roles/index.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardPlaces, protectedAreasOf, type ToolRegistry } from "./guard/index.ts";
import { createToolCallDetailRetention, type ToolCallDetailRetention } from "./guard-runtime/detail-retention.ts";
import { effectLogView, effectRecordPurge } from "./guard-runtime/effect-log.ts";
import { executionPurges, executionsView, interruptedToolResults } from "./guard-runtime/executions.ts";
import { toolCallDetailPurge, toolCallDetailsView } from "./guard-runtime/tool-call-details.ts";
import { registerGuardRuntimeDeletion } from "./guard-runtime/deletion.ts";
import { createGuardRuntime, type GuardRuntime } from "./guard-runtime/guard-runtime.ts";
import { createHandOverService } from "./hand-over/hand-over.ts";
import { createInboxService, type InboxService, inboxItemPurge } from "./inbox/inbox.ts";
import { registerInboxDeletion } from "./inbox/deletion.ts";
import { contextUsageView, createTokenLedger, ledgerView, type TokenLedger, webCallsView } from "./ledger/index.ts";
import { createAgentContributions } from "./agent-host/contributions.ts";
import { createAppProxy } from "./apps/proxy.ts";
import { type AppRegistry, createAppRegistry } from "./apps/registry.ts";
import { type AgentHost, createAgentHost } from "./agent-host/host.ts";
import { createRuntimeGate } from "./agent-host/runtime-gate.ts";
import { createTakeoverService } from "./takeover/index.ts";
import { createMaintainers, userMessageScope, type Maintainers } from "./maintainers/maintainers.ts";
import { inboxView } from "./inbox/views.ts";
import { openMediaStore } from "./media/media-store.ts";
import { cardDismissedPurge, createBgeM3Embedder, type Embedder, type Materials, openMaterials } from "./materials/index.ts";
import { migrateMaterialsDb } from "./materials/migrate-materials.ts";
import {
  createBulkMaterialDeletion,
  createMaterialBrowser,
  createMemoryGraphReader,
  createMemorySettings,
  internalRecordOf,
  type MaterialOwners,
  backfillPurgedQuotes,
  lookupPurgedEvidence,
  purgedEvidenceIds,
  PurgeRewriters,
  registerMaterialsDeletion,
  sessionRewriteFor,
  startPurgedMediaCleanup,
} from "./memory/index.ts";
import { startMemoryCurator, MEMORY_CURATOR_AGENT_ID, MEMORY_CURATOR_CONVERSATION, type MemoryCurator } from "./memory/curator.ts";
import { kernelEmbedderAdapter } from "./memory/embedder-adapter.ts";
import { MEMORY, MEMORY_INTERVIEWS, MEMORY_NIGHTLY, type MemoryNightlyService } from "./memory/api.ts";
import { latestNightlyRecord } from "./memory/nightly-record.ts";
import { migrateReasoningDb } from "./memory/migrate-rg.ts";
// 337 号票第一段：记忆插件槽（会意 / Subtext 是第一个实现）。宿主只决定谁在跑、把调用转给当前插件——
// 这一段只起来、不接工具和简报（下一段），所以现有行为一行都不变
import { createMemoryHost, createMemoryProviderRegistry, type MemoryHost } from "./memory/provider/host.ts";
import { subtextProviderFactory } from "./memory/provider/subtext.ts";
import { createSubtextRuntime } from "./memory/provider/subtext-runtime.ts";
import { pairingCardType } from "./pairing/card.ts";
import { createPromptLibrary, type PromptLibrary } from "./prompts/index.ts";
import { conversationWhere, type UserWordsDeps } from "./conversation/user-words.ts";
// 项目系统（278 号票）：组合根只经组装函数装它（projects/system.ts），内部服务的类型给 Daemon 句柄
import {
  type CharterChanges,
  createProjectDirectory,
  createProjectSystem,
  type ProjectSystem,
  type OperationMeansRegistry,
  type Operations,
  PROJECT_SYSTEM_VIEWS,
  type ProjectOps,
  type ProjectService,
  type ProjectServices,
  type StandardChanges,
  type WorkOrders,
} from "./projects/system.ts";
import { createPairingService, type PairingService } from "./pairing/pairing.ts";
import { pairingView } from "./pairing/views.ts";
import { bindService, createPluginHost, type PluginDefinition, type PluginHost } from "./plugins/host.ts";
import { KERNEL, KERNEL_SERVICES } from "./plugins/kernel.ts";
import { PLUGIN_MANIFEST } from "./plugins/manifest.ts";
import { createPluginSettings, type PluginSettings } from "./plugins/settings.ts";
import { createEventTriggers, dataDirTitle, EventSubscriberRegistry, eventSourceImplementations, type EventTriggers } from "./event-sources/index.ts";
import { daemonBusy, mayChangeBusy } from "./lsm/busy.ts";
import { linkToLsm, type LsmLink } from "./lsm/link.ts";
import { daemonRunning, removePidFile, writePidFile } from "./process/pid-file.ts";
import { ownersText, portProblem } from "./process/port-owner.ts";
import { createJobObject, type JobObject } from "./process/job-object.ts";
import { recoverAfterRestart, scanBeforeStart } from "./recovery/recovery.ts";
import {
  createQuickActionService,
  operationRecordPurge,
  quickActionCardType,
  type QuickActionExecutor,
  QuickActionRegistry,
  type QuickActionService,
  quickActionToolName,
} from "./quick-actions/index.ts";
import { createRuntimeRegistry, type ModelSpec, piRuntime, SLASH_TRANSLATE_ENTRY, TRANSLATION_TIMEOUT_MS, type TranslationRequest, type TranslationResult } from "./runtime/index.ts";
import { createWorkFolders } from "./work-folders/index.ts";
import { type Clock, clockIso, systemClock } from "./scheduler/clock.ts";
import { createInternalJobs, type InternalJobs, internalJobsView } from "./scheduler/internal-jobs.ts";
import { createScheduler, type Scheduler } from "./scheduler/scheduler.ts";
import { createJobMaintainers, createScheduledJobs, getJob, isJobMaintainerId, registerJobDeletion, type ScheduledJobs, scheduledJobsView } from "./scheduled-jobs/index.ts";
import { relayActions } from "./secretary/relay.ts";
import { type Secretary, SECRETARY_AGENT_ID, SECRETARY_TARGET, startSecretary } from "./secretary/secretary.ts";
import { AUTHORIZED_FOLDERS_BLOCK_ID, authorizeFoldersAction, secretaryFoldersBlock } from "./folders/authorize-folders.ts";
import { createFolderBrowser } from "./folders/folder-browser.ts";
import { openLocalFolders } from "./folders/local-folders.ts";
import { secretaryToolList } from "./secretary/tool-list.ts";
import { BROWSING, savedPageOf } from "./browsing/api.ts";
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
import { taskControlActions, taskDeleteAction, taskRunActions } from "./tasks/task-control.ts";
import { createTaskDeletion, type TaskDeletion } from "./tasks/deletion.ts";
import { registerTaskDeletion } from "./tasks/deletion-participants.ts";
import { allAccepted, taskMessageScope } from "./tasks/stages.ts";
import {
  clarificationAnswerPurge,
  clarificationAnswerSource,
  grantRenewalPurge,
  outputReactionPurge,
  grantRenewalSource,
  reworkNoticeHeldPurge,
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
import { registerSubAgentDeletion } from "./sub-agents/deletion.ts";
import { createSubAgents, type SubAgents } from "./sub-agents/sub-agents.ts";
import { subAgentsView } from "./sub-agents/views.ts";
import { planProjectsCheck } from "./tasks/plan-projects.ts";
import { createTaskService, type TaskService } from "./tasks/tasks.ts";
import { tasksView } from "./tasks/views.ts";
import { workTimesView } from "./tasks/own-work.ts";
import { createTypedShell, type ShellToolkit } from "./typed-shell/index.ts";
import { realPathOf } from "./util/real-path.ts";
import { type AssistantNameService, createAssistantNameService } from "./assistant/index.ts";
import { createUserNameService, type UserNameService } from "./user-name/index.ts";
import {
  annualPortOf,
  createPersonalFilesService,
  type FieldReplaced,
  PERSONAL_FILE_ACTION,
  type PersonalFilesService,
  personalFileAction,
  personalFileCardType,
  personalFilePurge,
  personalFilesView,
  registerCandidateDeletion,
} from "./personal-files/index.ts";
import { createModelSettings, type ModelSettingsService } from "./model-settings/index.ts";
import { createHolidayUpdates, createWorkdayCalendarService, type HolidayUpdates, type WorkdayCalendarService, workdayCalendarAction } from "./workday/index.ts";
import { createWatchCategoryService, type WatchCategoryService } from "./watch-categories/watch-categories.ts";
import {
  type AppBrowserTurn,
  appBrowserTurnNote,
  createBrowserLocator,
  createDeepSeekTools,
  createWebAccess,
  createWebSettings,
  playwrightDriver,
  type WebAccess,
  type WebBilledCall,
  type WebSettingsService,
  webTools,
} from "./web/index.ts";
import type { SessionTools } from "./conversation/session-tools.ts";
// 语音（214 号票起是插件，按插件清单装）：组合根只登记内核的数据契约（语音对象的两个视图、设置里成批删除时没有素材的语音），
// 语音回复、输入队列的挡板、本机接口经语音插件对外的服务现取（voice/api.ts 的 VOICE）
import { agentVoicesView, voicePurgeTargets, voicesView } from "./voice-records/index.ts";
import { VOICE, voiceOffReason } from "./voice/api.ts";
import { createMcpService, defaultMcpCwd, type McpService } from "./mcp/mcp.ts";
import { createMcpChangeService, mcpChangeCardType } from "./mcp/change.ts";
import { createMcpCallService } from "./mcp/call.ts";
import { mcpDecisionPurge, mcpDecisionSource } from "./mcp/material-source.ts";
import * as mcpTexts from "./mcp/texts.ts";
import { mcpQuickAction } from "./mcp/quick-action.ts";
import { BUILTIN_SKILLS_DIR, createSkillLibrary, type SkillLibrary } from "./skills/library.ts";
import { createSecretarySkills, type SecretarySkills } from "./skills/secretary-skills.ts";
import { skillDirProblems } from "./skills/skill-command.ts";
import { conversationSlashCommands } from "./slash-commands/list.ts";
import { createSlashTranslations, SLASH_TRANSLATION_SESSION } from "./slash-commands/translations.ts";
import { toolkitDecisionPurge, toolkitDecisionSource } from "./toolkit/material-source.ts";
import { createToolkitService, toolkitChangeCardType, type ToolkitService } from "./toolkit/toolkit.ts";
import { createScopeReview, type MaintainerScopeReview, registerScopeRecordDeletion, scopeRecordPurge, scopeRecordQuotes, scopeRecordsView } from "./scope-review/index.ts";

/** Web UI 的构建产物（npm run build:web 生成 packages/web/dist/index.html） */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));

// 各 agent 的模型（规格第 1 节）：73 号票起按设置里的"模型"取（model-settings/：默认模型和思考档位、按 agent 的覆盖），
// 拉起时现取、只用于新开的会话；没有设置文件时和以前写死的一样，全是 DeepSeek V4.1 Flash、思考档位高
// （范围审视用的"便宜模型"第一阶段也是它，在维护者自己的子进程里另开一次调用）。

/** 一条验收脚本最多跑多久 */
const ACCEPTANCE_SCRIPT_TIMEOUT_MS = 10 * 60_000;

/** 同一个数据目录已经有守护进程在运行：这次不启动（message 写明是哪个） */
export class DaemonAlreadyRunning extends Error {}

/** 起不来、要用户动手的（315 号票：端口被占）：message 是给人看的一整句（入口原样写进日志，不打调用栈） */
export class StartupProblem extends Error {}

/**
 * 两个端口能不能用（315 号票）：被占着、绑不了的抛 StartupProblem，说清是谁占着、怎么改（配置文件里的 ports）。
 * 端口写 0（测试：由系统挑）的不查。本机端口在前：两个都被占时先说它
 */
async function checkPorts(localPort: number, externalPort: number, configFile: string): Promise<void> {
  // @i18n-ignore-start log：起动失败的说明进日志（LSM 里看），这时用户选的语言还没加载
  const which = { local: "本机端口", external: "外网端口" } as const;
  const ports = [
    ["local", localPort],
    ["external", externalPort],
  ] as const;
  const problems = await Promise.all(ports.map(([, port]) => (port > 0 ? portProblem(port) : undefined)));
  for (const [i, [kind, port]] of ports.entries()) {
    const problem = problems[i];
    if (!problem) continue;
    const who = ownersText(problem.owners);
    const what =
      problem.kind === "reserved"
        ? `${which[kind]} ${port} 用不了（没有程序在听，但绑不上，多半是被系统保留了，可以用 netsh interface ipv4 show excludedportrange protocol=tcp 看保留的端口段）`
        : `${which[kind]} ${port} 被占着${who ? `：${who}` : ""}`;
    const sample = JSON.stringify({ ports: { local: kind === "local" ? port + 10 : localPort, external: kind === "external" ? port + 10 : externalPort } });
    throw new StartupProblem(
      `${what}，二狗起不来。` +
        (problem.kind === "in_use" ? "要么先关掉占着它的程序（是另一个二狗的话先在 LSM 里停掉它），要么" : "") +
        `在配置文件 ${configFile} 里换一个端口，比如 ${sample}；经 LSM 起的话，LSM 条目里的端口、探活地址跟着改。`,
    );
  }
  // @i18n-ignore-end
}

/** 守护进程的版本（报给 LSM；124 号票起设置里的关于二狗也经 daemon_info 取） */
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
  /** 交给官方 App 的会话多久只读跟随一次（毫秒，292 号票）；不填 60 秒。测试调短 */
  remoteFollowMs?: number;
  /** 多久看一眼 ~/.ergo/locales 里的语言文件变没变（毫秒，168 号票）；不填 2 秒。测试调短 */
  localesPollMs?: number;
  /** 二狗程序目录（守卫的受保护区域之一）；不填用这份代码所在的检出目录。测试换成临时目录，不碰真实仓库 */
  programDir?: string;
  /** 设置 · 数据源的"在电脑上打开"导入文件夹（295 号票）；不填用系统的文件管理器。测试换成记下来的假的 */
  openFolder?: (dir: string) => Promise<void>;
  /** 秘书的模型；不填按设置里的"模型"（73 号票）。测试换成 faux provider */
  secretaryModel?: ModelSpec;
  /**
   * 翻斜杠命令的说明用的模型（310 号票）：不填跟随秘书的（二狗的模型，没配 key 时不翻、显示原文）；null 是不翻。
   * 测试默认 null（不让秘书的剧本被翻译吃掉），要测翻译时换成 faux provider
   */
  slashTranslationModel?: ModelSpec | null;
  /**
   * 记忆管理员的模型（242 号票）；不填跟随秘书的（和秘书用同一个模型；单独配模型等 241 号票落地再说）。
   * 测试换成 faux provider
   */
  curatorModel?: ModelSpec;
  /** 秘书不在运行超过这么久，/healthz 就报不健康；默认 30 秒 */
  secretaryDownThresholdMs?: number;
  /**
   * 任务做完告诉秘书（99 号票）：做完一件之后安静多久（毫秒）没有新做完的才交给秘书，几件差不多同时做完的并成一条；
   * 不填用 secretary/task-done.ts 的 TASK_DONE_SETTLE_MS（2 秒）。按时钟算
   */
  taskDoneSettleMs?: number;
  /** 守护进程的日志；不填写到 stderr */
  log?: (line: string) => void;
  /** 时钟（调度器、插件、事件时间都跟着它）；不填用系统时钟。测试换成手动拨的 */
  clock?: Clock;
  /** 测试用：额外登记（或替换）的卡片类型 */
  extraCardTypes?: readonly CardTypeDefinition[];
  /**
   * 测试用：接在插件清单后面的插件，和清单里的走同一条装配路径（比如装不上的，测降级，126 号票）；和清单里同名的换掉清单里那个、
   * 位置不变（287 号票：主切面把 Claude Code 插件换成子进程接假 SDK 的）
   */
  extraPlugins?: readonly PluginDefinition[];
  /** 素材的向量函数；不填用数据目录模型区里的 bge-m3。测试注入假的 */
  embedder?: Embedder;
  /**
   * 设置 · 组件（323 号票）的几样换成测试的：清单（自己编的小文件）、检测（有没有 N 卡、别处有没有）、下载那一层（本机的假下载服务）、
   * 磁盘还剩多少、多久算卡住、探速等多久；不填用正式的（随程序发布的清单、走系统代理连真的下载地址）
   */
  components?: {
    manifest?: LoadedManifest;
    probes?: ComponentProbes;
    transport?: Transport;
    freeBytes?: (dir: string) => number;
    stallMs?: number;
    probeTimeoutMs?: number;
  };
  /**
   * 记忆整理用的模型（225 号票）：不填时记忆插件按 DEEPSEEK_API_KEY 建 DeepSeekChat；
   * 测试注入假的，守护进程里永远不连真的 DeepSeek
   */
  memoryModel?: () => ChatModel;
  /** 测试用：备份往备份区写文件的实现（模拟空间不够、复制出错） */
  backupFiles?: SnapshotFiles;
  /** 测试用：秘书额外的自定义工具（比如带"花钱"类别的，测"交给我做"） */
  extraSecretaryTools?: readonly HostTool[];
  /** 测试用：额外登记（或替换）的快速动作 */
  extraQuickActions?: readonly QuickActionExecutor[];
  /**
   * 会话回退之后的撤销接口（150 号票）：真正撤销本机效果、补救对外效果以后接（85 号票）；
   * 不填是什么都不做的那个
   */
  sessionRollbackHook?: SessionRollbackHook;
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
  /** 设置页选文件夹的框列的各个盘（138 号票）；不填是这台电脑上的盘。测试换成假的 */
  folderDrives?: () => Promise<string[]>;
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
  /**
   * 测试用：语音识别进程（程序和参数），换成假的，不加载真模型、不占显卡；不填用配置里的 Python 跑 recognizer.py（31 号票）。
   * 214 号票起和下面几项一起经内核服务 voiceEngines 交给语音插件
   */
  recognizerCommand?: readonly string[];
  /** 测试用：参考音色导入时转码用的 ffmpeg（程序和前面的固定参数），换成假的，不真跑 ffmpeg；不填用 PATH 上的 ffmpeg（230 号票） */
  ffmpegCommand?: readonly string[];
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
   * 测试用：DeepSeek 的联网搜索、读网页接口（154 号票）的地址换成本机的假服务；不填是正式的 https://api.deepseek.com。
   * 给了 webAccess 时联网工具不经它（设置页上的"余额不足"仍取自这个客户端）
   */
  webDeepseekBaseUrl?: string;
  /**
   * 测试用：项目的服务首页的缩略图怎么截（140 号票：给地址回 JPEG，截不了的抛错）；不填用正式的（playwright-core 驱动无头浏览器，
   * 1280×800 排版、0.5 倍出图，见 project-services/thumbnails.ts）
   */
  serviceThumbnail?: (url: string, signal: AbortSignal) => Promise<Buffer>;
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

/** 随程序发布的组件清单（323）；坏了（发版的错）不挡守护进程起来：记日志，组件页是空的 */
function shippedComponentManifest(env: NodeJS.ProcessEnv, log: (line: string) => void): LoadedManifest {
  try {
    // 发布包里清单带签名（318）：按程序里的发布公钥验，验不过不用；开发时没有签名文件，不验
    const verify = shippedManifestVerifier(env);
    return loadManifest(verify ? { verify } : {});
  } catch (err) {
    log(`组件清单读不了，组件页先空着：${err instanceof Error ? err.message : String(err)}`);
    return { manifest: { format: 1, release: "?", components: [] }, signed: false };
  }
}

export interface Daemon {
  readonly config: ErgoConfig;
  readonly layout: DataDirLayout;
  readonly store: EventStore;
  readonly cards: CardService;
  readonly inbox: InboxService;
  /**
   * 插件宿主（126 号票）：装了哪些插件、为什么没装（report），按名字取插件提供的服务（service：插件没装、停了是 undefined）；
   * disable / enable / remove 是运行中停用、启用、移除（211 号票：用户经设置 · 插件做，那一层另写配置，见 pluginSettings）
   */
  readonly plugins: PluginHost;
  /** 设置 · 插件（211 号票）：列出、运行中停用、启用、移除（连数据删），写配置 plugins.disabled / removed */
  readonly pluginSettings: PluginSettings;
  /** 看板上有哪几种（内核的任务、定时触发的任务，加上插件登记的，126 号票） */
  readonly boardKinds: BoardKinds;
  /** 个人工作日历：节假日数据加个人规则和手动标记（29 号票） */
  readonly workdayCalendar: WorkdayCalendarService;
  /** 个人助理的名字（43 号票）：配置区里的文件是真相，改名经设置接口，秘书的系统提示里有它 */
  readonly assistantName: AssistantNameService;
  /**
   * 我的名字（249 号票）：用户自己的名字（和上面助理的名字是两回事），配置区里的文件是真相，经设置接口 GET/PUT 现取现写；
   * 各 agent 的系统提示里知道该称呼用户什么，界面上能用则用
   */
  readonly userName: UserNameService;
  /** 个人档案（281 号票）：本人和重要的人各一份，放内核；本人的姓名就是上面的"我的名字" */
  readonly personalFiles: PersonalFilesService;
  /** 有哪些语言（168 号票）：自带的加上 ~/.ergo/locales 里放的，放一个文件就能加新语言、改译法 */
  readonly locales: Locales;
  /** 全局语言设置（168 号票）：配置区里的文件是真相，经设置接口改；t() 按实际在用的语言，各 agent 的系统提示末尾跟着它 */
  readonly language: LanguageService;
  /** 设置里的"模型"（73 号票）：配置区里的文件是真相，经设置接口改，拉起 agent 时按 agent 现取（只用于新开的会话） */
  readonly modelSettings: ModelSettingsService;
  /** 设置里 agent 的联网搜索、读网页（154 号票；162 号票起是三种方式的队列）：配置区里的文件是真相，经设置接口改 */
  readonly webSettings: WebSettingsService;
  /** 安全和预算的两个开关（315 号票）：先问我、任务的预算；配置文件是真相，设置里改了写回去、马上生效 */
  readonly safetySettings: SafetySettingsService;
  /**
   * 首次设置向导（319 号票）：五步（称呼、模型 Key、组件、手机配对、安全默认值）哪几步做完了；
   * 配置文件是真相，向导里标"以后再说"/"看过了"就写回去，各步的条件现算
   */
  readonly setup: SetupStateService;
  /** 节假日数据的续期（29 号票）：每月检查、发起更新任务、任务完成后导入交付件（importForTask，13 号票的任务完成回调调它） */
  readonly holidayUpdates: HolidayUpdates;
  /** 素材库：原文副本、关键词和向量检索（materials.db 只有它写）；采成素材由记忆插件开，没开时只保管（129） */
  readonly materials: Materials;
  /**
   * 记忆插件槽（337 号票）：现在在用哪套记忆系统、按 id 启用哪一套。生产里只有会意 / Subtext 一个；
   * 这一段只起来、不接工具和简报——现有的检索、简报、整理、删除照旧走各自的路（下一段才改接）
   */
  readonly memoryHost: MemoryHost;
  /** 设置 · 数据源（295 号票）：插件登记的数据源、立即同步、断开、用法开关、导入文件夹 */
  readonly dataSources: DataSources;
  /** 设置 · 组件（323 号票）：模型、语音这些大件按需下载——装、删、更新、暂停、继续、取消、离线导入 */
  readonly components: Components;
  /** 设备配对：配对请求、凭证、已配对设备 */
  readonly pairing: PairingService;
  /** 审批表和审批卡 */
  readonly approvals: ApprovalService;
  /** 任务：发起、任务书、计划的提交和确认（12 号票） */
  readonly tasks: TaskService;
  /** 项目：立项、立项书、项目状态、项目档案、删除（15 号票） */
  readonly projects: ProjectService;
  /** 立项要求变更（125 号票）：现在的立项书（用户确认了的改动之后）、它的全文（范围审视的对照物） */
  readonly charterChanges: CharterChanges;
  /** 本项目的规范改写（261 号票）：维护者提、用户在"规范改写"卡上确认才生效，确认的写进项目档案的 standard-overrides.md */
  readonly standardChanges: StandardChanges;
  /** 运营方案（130 号票）：维护者交运营方案、"首版做完了"卡上确认并转入使用时生效、使用中的出"运营方案变更"卡 */
  readonly operations: Operations;
  /** 运营手段登记表（130 号票）：内核登记的定时、事件触发的任务、项目自己的服务（133）和要用户手动的公网入口，插件经插件宿主登记的 */
  readonly operationMeans: OperationMeansRegistry;
  /** 项目的服务（133 号票）：运营手段"服务"生效之后到 LSM 上线、撤下，LSM 推来的状态，给前端、秘书看的样子 */
  readonly projectServices: ProjectServices;
  /** 使用中的项目的操作（260、268 号票）：运营接口清单的验收和登记（带版本号）、秘书的 project_ops、维护者的 check_ops */
  readonly projectOps: ProjectOps;
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
  /**
   * 转发登记表（132 号票）：登记一个应用名对应本机的一个地址，网关把 /apps/<应用名>/… 转发过去，返回撤销函数。
   * 133 号票服务上线时登记；插件经插件宿主的 ctx.apps 登记（记在插件名下）
   */
  readonly apps: AppRegistry;
  /** 停止：关端口、停秘书、关闭 Job 对象（还活着的子进程和孙进程全部结束）、关库 */
  stop(): Promise<void>;
}

export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let config = loadConfig({ env: options.env, homeDir: options.homeDir });
  const layout = dataDirLayout(config.dataDir);
  // 312 号票：用的是旧的环境变量名、旧的数据目录、数据目录里旧名字的文件时提示一次（照样能用）
  for (const note of oldNameNotes(config, layout, options.env)) log(note);
  const localPort = options.localPort ?? config.ports.local;
  const externalPort = options.externalPort ?? config.ports.external;
  // 一个数据目录只有一个实例（23 号票）：已经有一个在跑（被重复启动了）就立即退出，什么状态都不碰——
  // 不然下面的恢复会把正在跑的实例里正在执行的调用当成被杀时中断的
  const running = await daemonRunning(layout.pidFile, 0);
  if (running) throw new DaemonAlreadyRunning(`数据目录 ${layout.root} 已经有一个守护进程在运行（${running}），这次不启动`); // @i18n-ignore log：启动时的说明
  // 两个端口被占着（315 号票）：说清是谁占着、怎么改端口，同样什么状态都不碰（本机端口上有人在听，也可能是 pid 文件丢了的同一个二狗）
  await checkPorts(localPort, externalPort, layout.configFile);
  // 数据目录不存在时建好（315 号票：第一次装的人什么都不用先建）
  if (!fs.existsSync(layout.root)) log(`数据目录 ${layout.root} 还没有，新建一个`); // @i18n-ignore log：启动时的说明
  // 新装（315 号票）：数据目录里还没有事件库（312 号票之前的旧名字也算有）——对话审批、任务的预算控制两项收紧，明着写进配置文件
  // （里面已经写了的不碰），再读一遍配置。已有的数据目录不写：没写这两项的照旧是代码里的默认（关着）
  const freshInstall = !fs.existsSync(layout.eventsDb);
  for (const dir of [layout.config, layout.db, layout.sessions, layout.tmp, layout.scratch, layout.logs]) fs.mkdirSync(dir, { recursive: true });
  if (freshInstall) {
    const written = writeFreshInstallDefaults(layout.configFile);
    if (written.length > 0) {
      log(`新装：在配置文件 ${layout.configFile} 里打开了 ${written.join("、")}（设置 · 关注类别里能关）`); // @i18n-ignore log：启动时的说明
      config = loadConfig({ env: options.env, homeDir: options.homeDir });
    }
  }
  // 338 号票：会意的推理库搬进插件自己的数据目录（<数据目录>/memory/subtext/rg.db）。
  // 放在这么早、这么显眼的地方，是因为**顺序要紧**：记忆插件在下面 plugins.start() 里就会打开推理库（openReasoningDb），
  // 它一打开，再搬就晚了——所以任何引擎起来之前先搬完。这一段搬的是老位置 db/rg.db（225 号票起引擎一直开的是它），
  // 目标已经有了就不再动（幂等），两边都没有是"新装"、什么都不做。素材库 db/materials.db 和事件日志归内核，这一段不搬
  // （素材库自己的改名在下面打开素材库之前那一段，见 materials/migrate-materials.ts）。
  // 目标是 rgDb 所在的那一格（memoryProviderDir("subtext")）——引擎开的也是它，搬过去就一定能读到；不按配置里选的
  // provider 猜：这份老库只属于会意，用户选了别的插件时它照样回到会意那一格，切回来还能用。
  // 搬不成（文件被占用、权限、磁盘满）不能让守护进程起不来：记一条日志、照"还没搬"往下走，引擎会自己建一个新的空库。
  // 那条日志就是用户看到"记忆是空的"时能查到的线索，所以写得明白一点（不 i18n：只有日志看得到）
  const reasoningProviderDir = path.dirname(layout.rgDb);
  try {
    const migration = migrateReasoningDb({ dataDir: layout.root, from: layout.legacyRgDb, toDir: reasoningProviderDir, storeName: path.basename(layout.rgDb), log });
    // 目标已经有了、老文件却还在（比如迁移之后又有人往 db/ 里放了一份）：不覆盖、不再搬，说一句省得以后有人对着两个库发懵
    if (migration === "skipped" && fs.existsSync(layout.legacyRgDb) && fs.existsSync(layout.rgDb)) {
      log(`推理库已经在新位置（${layout.rgDb}），老位置的 ${layout.legacyRgDb} 还在：没覆盖、也没再搬，用新的那一份。旧的确认不要了可以自己删掉`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `推理库没搬成：${layout.legacyRgDb} → ${layout.rgDb}（${reason}）。` +
        `这次按"还没搬"继续，记忆插件会新建一个空库——以前的结论、证据看不到；` +
        `多半是文件被别的程序占着或者没有权限，处理完重启守护进程就会再搬一次（老库一个字节没动）`,
    );
  }
  // 安全和预算的两个开关（315 号票）：设置里改了写回配置文件、马上生效——下面交给守卫、任务执行、项目的工单判定、系统提示的都是现取的
  const safety = createSafetySettings({ configFile: layout.configFile, initial: { conversationApprovals: config.guard.conversationApprovals, budgetControl: config.tasks.thresholds.budgetControl }, log });
  const taskThresholds = withLiveBudgetControl(config.tasks.thresholds, safety);
  // 插件（126 号票，ADR-0027）：按清单排好依赖顺序；配置 plugins.disabled 里停用的、缺依赖的不装（原因写进日志，健康信息里也有）。
  // 要装的插件声明的视图和内核的一起登记；不装的插件的视图记成停着的（表留着、不再更新，以后装上时整表补一遍）。
  // 建它没有副作用（只排顺序、写日志）；128 号票起排在系统提示前面：插件在系统提示里的条件、占位符、片段要先收齐
  const plugins = createPluginHost({
    plugins: withExtraPlugins(PLUGIN_MANIFEST, options.extraPlugins ?? []),
    disabled: config.plugins.disabled,
    removed: config.plugins.removed,
    kernel: KERNEL_SERVICES,
    // 插件要的外部组件装在组件区里也算装了（318）
    componentsDir: layout.components,
    log,
  });
  // 角色（248 号票）：名字 + 音色绑成一个角色，设置 · 角色与声音里维护、每个 agent 只选一个；配置区里的 agent-roles.json。
  // 默认角色的名字就是全局名字（43 号票），音色就是全局选中的参考音色（31 号票）。它要这两样和语音插件的参考音色，
  // 都在后面才建：这里先把位置留给系统提示（角色提示末尾那句"用户叫你…"要按它现取），名字服务建好之后、插件起来之后再建它并迁移。
  let roleService: AgentRoles | undefined;
  // 我的名字（249 号票）：用户自己的名字，配置区里的 user-name.json；比系统提示先建——前缀后面那句"用户叫「…」"要现取。
  // 没设就一个字都不加（提示和以前逐字节一样）
  const userName = createUserNameService({ layout, log });
  userName.start();
  // 记忆的设置（264 号票）：顺口问开不开，配置区里的 memory-settings.json；网关的设置接口和记忆插件共用这一份
  const memorySettings = createMemorySettings({ file: layout.memorySettingsFile, log });
  memorySettings.start();
  // 各 agent 的系统提示（71 号票）：默认的在本包的 prompts/，用户改的在配置区的 prompts/，每次装配 agent 时现读。
  // 启动时先查一遍：占位符写错、片段不认得……报清楚是哪个文件哪一行，不启动（不默默用空串）
  // 114 号票：每个 agent 单独的提示词（会话里的 ⚙）在配置区的 agent-prompts/，装配那个 agent 时带上
  // 128 号票：插件贡献的条件（插件在运行时成立，装配时现算）、占位符、片段（停用的插件的也在，用户改过的提示里写了不至于出错）
  // 248 号票：给某个 agent 指定了角色的，它的角色提示（秘书那份除外）末尾加一句"用户叫你「…」"（跟默认的 agent 不加）
  // 249 号票：用户自己设了名字的，每个 agent 的系统提示最前面（前缀后面）加一句"用户叫「…」"
  const prompts = createPromptLibrary({
    userDir: layout.prompts,
    agentsDir: layout.agentPrompts,
    plugins: { prompts: plugins.prompts(), running: (name) => plugins.running(name) },
    agentName: (agentId) => roleService?.assignedNameOf(agentId),
    userName: () => userName.current(),
    log,
  });
  prompts.check();

  // 已经立起来的部分，停的时候按相反的顺序收掉（启动中途失败时也用它收拾）
  const teardown: Array<() => void | Promise<void>> = [];
  teardown.push(() => userName.stop());
  const shutdown = async () => {
    for (const step of teardown.splice(0).toReversed()) await step();
  };

  try {
    const clock = options.clock ?? systemClock;
    const now = () => clockIso(clock);
    // 什么时候起来的（124 号票：设置里的关于二狗显示守护进程已运行多久）
    const startedAt = now();
    // 启用着（没在 plugins.disabled 里）的插件没装上（缺依赖、循环依赖、装配或启动出错）：/healthz 和报给 LSM 的健康都算降级，写明哪个、为什么；
    // 配置里主动停用的不算
    const pluginProblems = () => plugins.report().skipped.map(({ plugin, reason }) => `插件 ${plugin} 没装上：${reason}`); // @i18n-ignore log：健康检查的说明（LSM 里看）
    const store = openEventStore({
      file: layout.eventsDb,
      views: [
        ...conversationViews,
        cardsView,
        inboxView,
        pairingView,
        internalJobsView,
        approvalsView,
        effectLogView,
        executionsView,
        toolCallDetailsView,
        tasksView,
        workTimesView,
        activityView,
        // 项目系统（278）：项目和立项书、工单和会话分段、运营方案（130）、项目的服务（133：每个服务该在 LSM 上还是撤下、做完的结果）
        ...PROJECT_SYSTEM_VIEWS,
        ledgerView,
        // 按次计费的联网调用（154）：DeepSeek 的联网搜索、读网页每次成功的一条
        webCallsView,
        // 插件追加在输入后面的上下文估的 token（266：每条消息的记忆简报），用量页单列
        contextUsageView,
        // 个人档案（281）：本人和重要的人的字段、历史、记下的事（内部频道 personal_files）
        personalFilesView,
        subAgentsView,
        // 语音对象（31、32）：内核的数据契约（214 号票起语音是插件，插件停用了照样更新、照样投影）
        voicesView,
        agentVoicesView,
        scopeRecordsView,
        scheduledJobsView,
        ...plugins.views(),
      ],
      dormantViews: plugins.dormantViews(),
      now,
      log,
    });
    teardown.push(() => store.close());
    const scheduler = createScheduler({ clock, log });
    teardown.push(() => scheduler.stop());
    const notifications = createEphemeralBus();
    // 个人工作日历（29）：节假日数据加配置区里的个人设置；"按我的工作日"的时间表（内部作业、定时作业、插件的）按它算
    const workdayCalendar = createWorkdayCalendarService({ store, layout, log });
    workdayCalendar.start();
    teardown.push(() => workdayCalendar.stop());
    // 个人助理的名字（43）：照工作日历的个人设置存和推；秘书的系统提示里有它
    const assistantName = createAssistantNameService({ store, layout, log });
    assistantName.start();
    teardown.push(() => assistantName.stop());
    // 角色（248 号票）：名字 + 音色绑成一个角色，每个 agent 只选一个；默认角色的名字就是全局名字（43）、音色就是全局选中的参考音色（31）。
    // 参考音色在语音插件里，现取（插件没启用时没有音色可改，名字和角色照常）；插件的迁移在 plugins.start() 之后做（那时才读得到音色）
    const agentRoles = openAgentRoles({
      file: layout.agentRolesFile,
      legacyFile: layout.agentProfilesFile,
      assistantName: () => assistantName.current(),
      // 默认角色改名 = 改全局名字（秘书的系统提示、名字占位跟着变），和设置顶上那个名字输入框改的是同一个值
      setAssistantName: (name) => void assistantName.change(name, "settings"),
      voices: () => plugins.service(VOICE)?.referenceVoices,
      // 默认角色换音色 = 在语音页里选一个（31 号票），"跟默认音色"的那些角色跟着它
      selectVoice: (voiceId) => void plugins.service(VOICE)?.referenceVoices.select(voiceId),
      log,
    });
    roleService = agentRoles;
    // 全局名字改了（设置顶上那个输入框、角色页的默认角色）：默认角色在文件里那份镜像跟着记，下次读还是同一个名字
    teardown.push(assistantName.onChange(() => agentRoles.refreshGlobals()));
    // 角色改了：指定了这个角色的 agent 手头这一条处理完后按新的名字重新装配（和单独的提示词改了走同一条通知）
    teardown.push(
      agentRoles.onChange((agentIds) => {
        for (const agentId of agentIds) prompts.agentChanged(agentId);
      }),
    );
    // 多语言（168）：自带的语言加上 ~/.ergo/locales 里放的；全局语言设置照个人助理的名字存和推，装上正在用的语言（t() 从此按它），
    // 实际在用的语言、语言文件变了在语言频道上推临时事件 locale
    const locales = createLocales({ userDir: layout.locales, ...(options.localesPollMs === undefined ? {} : { pollMs: options.localesPollMs }), log });
    locales.start();
    teardown.push(() => locales.stop());
    const language = createLanguageService({ store, layout, locales, publish: (frame) => notifications.publish(frame), log });
    language.start();
    teardown.push(() => language.stop());
    /** 实际在用的语言（连同给模型的名字）：变了维护者交下一条输入之前按新的系统提示重新拉起 */
    const languageKey = () => {
      const meta = language.effective();
      return `${meta.id}/${meta.modelName}`;
    };
    /** 拉起 agent 时实际给的系统提示：前缀（71）+ 角色的提示 + 不是中文时末尾那句"用 <语言> 回答用户"（168） */
    const effectiveSystemPrompt = (systemPrompt: string) => withLanguageLine(prompts.withPrefix(systemPrompt), language.effective());
    // 秘书会话的已读位置（109）：几台设备同步"看到哪一条了"；还没有记录时记一条，升级上来的历史消息当作都看过
    const readMarks = createReadMarks({ store, now });
    readMarks.start();

    // 卡片类型注册表：各票往这里登记自己的卡（10：配对请求卡；插件的卡经插件宿主登记，126）
    const registry = new CardTypeRegistry();
    const cards = createCardService({ store, registry, now });
    const inbox = createInboxService({ store, notifications, now, log });
    // "按我的工作日"的内部作业、定时作业按当时的工作日历算下一次
    const scheduleContext = () => ({ calendar: workdayCalendar.current() });
    // 看板上有哪几种（22）：内核的任务、定时触发的任务，插件经插件宿主登记自己的那一种（126）
    const boardKinds = new BoardKindRegistry();
    // 事件触发（77）的订阅方：事件触发的任务是内核的，别的由插件经插件宿主登记（126）
    const eventSubscribers = new EventSubscriberRegistry();
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
    // 守卫：各区用真实路径（展开符号链接、目录联接和 8.3 短名），agent 的工作目录也用真实路径，路径比较才对得上
    // （129 号票挪到这里：快速动作判处置要用，快速动作的服务要在插件装配之前建好）
    const bashTmp = bashTmpMount(options.env);
    const places: GuardPlaces = {
      dataDir: { root: realLayout.root, config: realLayout.config, secrets: realLayout.secrets, db: realLayout.db, projects: realLayout.projects },
      programDir,
      // agent 的 bash 里 `~` 是 HOME（Git Bash 没有 HOME 时取 USERPROFILE）
      homeDir: real(options.env.HOME ?? options.env.USERPROFILE ?? options.homeDir),
      // 二狗自己的端口（139）：网关开好之前按配置的，开好之后换成实际监听的（见下面 places.ownPorts 那里）
      ownPorts: [localPort, options.externalPort ?? config.ports.external],
    };
    // 唯一的后接接线点（解循环依赖）：任务模块要派单器派起草计划的工单（项目系统要任务模块，建在它之后；278 号票起项目系统自己的后接线
    // 收在 projects/system.ts 里，这里只剩这一处），任务控制快速动作要执行控制器（22，执行控制器建在快速动作登记之后）。
    // 子 agent（20）：任务执行控制器要知道哪些阶段有子 agent 在做，维护者要"提议并行"工具（经 agent 宿主），子 agent 模块建在它们之后。
    // 执行控制器从某个阶段重做前要停稳维护者手头这一轮（84）：经 agent 宿主（127，它建在执行控制器之后）问三种维护者。
    // 用到时现取，模块都建好之后在下面"接上"处一起填
    // 定时作业（19）：执行控制器数全局名额时要算上正在运行的作业，作业模块建在项目系统（它的派单器）之后；工作日历变了作业跟着重算。
    // 工具调用完整内容的清理（65）要认得的工具的登记（280：清掉后剩的参数摘要按工具自己声明的"参数要打码"擦），秘书的工具建在它之后
    const wiring: {
      agentHost?: AgentHost;
      projectSystem?: ProjectSystem;
      maintainers?: Maintainers;
      taskExecution?: TaskExecution;
      subAgents?: SubAgents;
      scheduledJobs?: ScheduledJobs;
      eventTriggers?: EventTriggers;
      taskDeletion?: TaskDeletion;
      ledger?: TokenLedger;
      knownTools?: () => ToolRegistry;
      /** 283：个人档案（建在插件装配之后；记忆插件经 KERNEL.personalFiles 现转） */
      personalFiles?: PersonalFilesService;
      /** 299：数据源的服务（建在插件装配之后；日历插件经 KERNEL.externalCalendars 现转） */
      dataSources?: DataSources;
      /** 337：记忆插件槽的宿主（建在插件装配之后；记忆插件经 KERNEL.memorySlot 现转） */
      memorySlot?: MemoryHost;
    } = {};
    const wired = <K extends keyof typeof wiring>(key: K): NonNullable<(typeof wiring)[K]> => {
      const target = wiring[key];
      if (!target) throw new Error(`${key} 还没接上`); // @i18n-ignore log：编程错误
      return target as NonNullable<(typeof wiring)[K]>;
    };
    /** 283：记忆插件订阅的"档案的字段换了新值"（插件装配时档案还没建，先记在这里，档案建好后转过来） */
    const fieldReplacedListeners = new Set<(change: FieldReplaced) => void>();
    // 彻底删除的改写函数表（21）：拥有一类事件的模块写它的改写函数；以后接入新的素材来源也要在这里登记。
    // 删除项目（15）也用它改写属于项目的事件
    const purgeRewriters = new PurgeRewriters();
    purgeRewriters.register(
      messagePurge,
      timelineRecordPurge,
      cardPurge(cards),
      // 卡片被关闭（长期没处理的、"记住"的记忆命令由记忆插件的数据契约登记，129）
      cardDismissedPurge,
      approvalDecisionPurge,
      approvalRequestPurge,
      effectRecordPurge,
      ...executionPurges,
      toolCallDetailPurge,
      operationRecordPurge,
      // 立项书、立项要求变更（125）、规范改写（261）、运营方案（130）、工单和工单卡上的决定（16、17）的由项目系统登记（278，createProjectSystem）
      inboxItemPurge,
      outputReactionPurge,
      // 重做时存下、等复验的交代（276）：随那条重做的反应连带换成"已删除"
      reworkNoticeHeldPurge,
      // 计划的决定、提问卡的回答、授权续期的决定（80）
      planDecisionPurge,
      clarificationAnswerPurge,
      grantRenewalPurge,
      parallelDecisionPurge,
      // 用户的语音（31）的改写函数由语音插件的数据契约登记（214）
      taskWaitNotePurge,
      scopeRecordPurge,
      toolkitDecisionPurge,
      // MCP 登记变更（239）：用户在卡上写的话
      mcpDecisionPurge,
      // "浏览"里存进素材的网页（165）的改写函数 212 号票起由浏览插件的数据契约登记
    );
    // 范围记录引着用户在维护者会话里的话、审批卡上的批准（18）：彻底删除那些时连带改写
    purgeRewriters.registerQuotes(...scopeRecordQuotes);
    // "删除参与方"登记表（279，方案 C）：删项目（15）、删任务（186）、移除插件时连数据删（211）走同一张表——拥有属于项目、任务、插件的
    // 事件的模块各自登记怎么找、怎么改写。项目系统的在组装函数里登记，内核的在下面项目系统建好之后，插件写明的由设置 · 插件登记
    const deletionParticipants = new DeletionParticipants({ store, cards, rewriters: purgeRewriters });
    // 项目列表的只读视图（278）：按编号、按维护者、按任务、按名字找没删掉的项目，只读派生视图、不要项目服务——
    // 任务模块建在项目系统之前（项目系统要它），核对项目名、任务属于哪个项目这些从这里拿，不用后接线；后面要找项目的内核模块也用它
    const projectDirectory = createProjectDirectory({ store, projectsDir: realLayout.projects });
    // 任务（12）："建议发起任务"卡、提问卡、计划卡；计划里的授权项和时序规则照内置的工具注册表查。
    // 点"发起任务"时选的项目要在项目列表里（15）；计划里涉及的项目要对得上任务（17：提交计划、计划变更、自行调整都查）
    const planProjects = planProjectsCheck(() => projectDirectory);
    // agent 运行时的登记表（286）：说明见下面运行时闸门那里。289 号票起新建任务、项目时就要核对选的运行时，所以建在任务模块之前
    // 新建时选工作文件夹（305）：能选的运行时（登记表里 workFolder 的）新建时的默认文件夹存在配置区；不许用的地方和本机文件夹变化
    // 不许监视的同一份（受保护区域和整个数据目录）。登记表给网页的样子里带上默认文件夹
    const workFolders = createWorkFolders({
      file: realLayout.workFoldersFile,
      forbidden: () => [...protectedAreasOf(places), { dir: places.dataDir.root, title: dataDirTitle() }],
      supports: (runtimeId) => agentRuntimes.get(runtimeId)?.workFolder === true,
      log,
    });
    const agentRuntimes = createRuntimeRegistry({ log, defaultFolder: (runtimeId) => workFolders.defaultOf(runtimeId) });
    agentRuntimes.register(piRuntime);
    /** 新建任务、项目时选的运行时现在能不能用（289）：不能用的原因写明现在能用的有哪些（秘书据此改了再试） */
    const runtimeRefusal = (runtime: string): string | undefined => {
      const off = agentRuntimes.unavailable(runtime);
      if (!off) return undefined;
      const usable = agentRuntimes
        .view()
        .runtimes.filter((r) => r.available)
        .map((r) => (r.id === r.title ? r.id : t("runtime.registry.usableItem", { id: r.id, title: r.title })))
        .join(t("common.listSeparator"));
      return t("runtime.registry.refused", { reason: off.reason, usable });
    };
    const tasks = createTaskService({
      store,
      cards,
      inbox,
      now,
      watchSettings,
      planTools: BUILTIN_TOOL_REGISTRY,
      // 计划的工具包里只能是 skill 库里的 skill、登记了的 MCP（27）
      toolkitProblems: (toolkit) => toolkits.nameProblems(toolkit),
      // 只涉及一个项目的任务一律是这个项目的内部任务，由它的维护者执行（16、64）：项目要在项目列表里、立项书已确认（首个建设任务例外）、没归档
      projects: () => projectDirectory,
      // 项目的任务的任务书、打回意见派成起草计划的工单（16）；涉及多个项目的任务的计划确认时每一行建成工单（17）。派单器在项目系统里，
      // 项目系统建在任务模块之后：现取
      workOrders: () => wired("projectSystem").taskWorkOrders,
      // 计划里涉及的项目要对得上任务（17）
      planProjects,
      // 升级前交、升级后才确认的长程任务计划里的定时作业（76）：照迁移的办法建成定时触发的普通任务
      legacyPlanJobs: (task, stored, grantInfo) => wired("scheduledJobs").legacyPlanConfirmed(task, stored, grantInfo),
      // 事件触发的任务（77）：事件触发方式经事件来源的分发查（登记表、文件夹能不能监视）
      checkEventTrigger: (trigger) => wired("eventTriggers").check(trigger),
      // 点"发起任务"时选的运行时（289）：现在能用的才行
      runtimeRefusal,
      // 在哪个文件夹做（305）：能选工作文件夹的运行时才定，新开的建任务时建出
      workFolder: (runtime, choice, title) => workFolders.settle(runtime, choice, title),
    });
    registry.register(suggestTaskCardType(tasks));
    registry.register(planCardType(tasks));
    // 流程计划卡（58 号票）：一次授权执行，或拒绝
    registry.register(workflowPlanCardType(tasks, () => wired("taskExecution")));
    // 被杀后的恢复（23）第 1 步：任何 agent 会话开始之前，记下上次被杀时正处理到一半的任务维护者
    const restart = scanBeforeStart(store, tasks);
    // 素材引着的任务、审批、卡片和待我处理的事项：认出项目内部的记录（64：秘书检索不到；66：删除项目时随项目删）
    const materialOwners: MaterialOwners = {
      task: (taskId) => tasks.get(taskId),
      approvalOrigin: (approvalId) => approvals.get(approvalId)?.origin,
      cardPayload: (cardId) => cards.get(cardId)?.payload,
      inboxItemsOfCard: (cardId) => inbox.itemsForCard(cardId),
    };
    // 素材库（08；129 起是内核的那一半）：materials.db 和原文副本的保管，从事件日志补采（停着时追加的）、照做记忆命令的删除和标记、读和检索。
    // 采成素材（写进库和索引、向量、回避信号）由记忆插件装配时开（collect）；没开时只保管：本人的话照样留原文副本、删除照做。
    // 建它只打开库（129 挪到项目模块前面：删除项目时随项目删的素材直接问它），start 在插件装配之后
    // ADR-0035：素材库的文件名从 db/memory.db 改成 db/materials.db（老名字和记忆插件的数据目录撞了）。**顺序要紧**：
    // 这一段必须在 openMaterials 之前——它一打开新位置，老库就轮不到搬了。搬的是同一个目录里的两个文件名
    // （db/memory.db → db/materials.db，连同 -wal / -shm），内容一个字节不动；新位置已经有了就不动（幂等），
    // 两边都没有是新装、什么都不做。搬不成（文件被占用、权限、磁盘满）不能让守护进程起不来：记一条日志、照"还没搬"往下走，
    // 素材库会打开一个新的空库、从事件日志重建素材（原文副本一条不动）；老库原样留着，处理完重启会再试一次。
    // 那条日志就是用户发现"素材是空的"时能查到的线索，所以写得明白一点（不 i18n：只有日志看得到）
    try {
      const migration = migrateMaterialsDb({ dataDir: layout.root, from: layout.legacyMemoryDb, to: layout.materialsDb, log });
      // 新位置已经有了、老文件却还在（比如迁移之后又有人往 db/ 里放了一份）：不覆盖、不再搬，说一句省得以后有人对着两个库发懵
      if (migration === "skipped" && fs.existsSync(layout.legacyMemoryDb) && fs.existsSync(layout.materialsDb)) {
        log(`素材库已经在新名字（${layout.materialsDb}），老名字的 ${layout.legacyMemoryDb} 还在：没覆盖、也没再搬，用新的那一份。旧的确认不要了可以自己删掉`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(
        `素材库没改名：${layout.legacyMemoryDb} → ${layout.materialsDb}（${reason}）。` +
          `这次按"还没搬"继续：会用新的空库（${layout.materialsDb}），以前的素材要从事件日志重建——` +
          `对话里说过的话都会重新采回来，原文副本一条不动；` +
          `多半是文件被别的程序占着或者没有权限，处理完重启守护进程就会再搬一次（老库一个字节没动）`,
      );
    }
    const materials = openMaterials({ store, dbDir: layout.db, materialsDir: layout.materials, log });
    // 被删素材在推理库里的证据编号（265 号票）：问记忆的结果按证据编号引原话，彻底删除时按它找到那次调用的记录、完整内容和会话文件里的行
    // （272 号票起删项目、删任务时连带彻底删除的系统记录也按它找，所以建在项目系统前面）
    const purgedEvidence = (materialIds: readonly string[]) => purgedEvidenceIds(layout.rgDb, materialIds, log);
    // 运行时核实用户原话（125）：维护者引用的用户消息由守护进程核对（还在、是用户说的、是它会话里的，秘书转达的换成原话）；
    // 会话写成给人看的说法（秘书会话、项目的维护者会话、任务的会话）
    const userWords: UserWordsDeps = {
      store,
      whereOf: conversationWhere({
        projectOf: (maintainerId) => projectDirectory.maintainedBy(maintainerId),
        taskOf: (maintainerId) => tasks.ofMaintainer(maintainerId),
      }),
    };
    // 转发登记表（132）：/apps/<应用名>/ 转发到本机的哪个地址。先建好给项目的服务（133）、插件登记，网关按它转发
    const apps = createAppRegistry();
    // 项目系统（15、16、17、125、130、133、259–262、268；278 号票收成一个组装函数，方案 C）：项目、立项要求变更、规范改写、补齐规范、
    // 运营方案和运营手段、项目的服务、project_ops、派单器都在 projects/system.ts 里装，它登记自己的卡片类型、改写函数、素材来源；
    // 这里只给内核的依赖。内核模块要它的什么，照各自的小接口从它拿（下面工具包、秘书的工具、执行控制器、任务的维护者、触发底座……）。
    // 建在它之后的内核模块在下面 connect 交进去（派单器那时开始），项目的维护者在 start 里建出、项目开始，项目的服务接入 LSM 之后开始
    const projectSystem = createProjectSystem({
      store,
      cards,
      inbox,
      tasks,
      cardTypes: registry,
      rewriters: purgeRewriters,
      materialSources: materials,
      deletion: deletionParticipants,
      userWords,
      notifications,
      apps,
      places,
      watchSettings,
      // 对话审批的开关现取（315 号票：设置里改了马上生效）
      get conversationApprovals() {
        return safety.current().conversationApprovals;
      },
      nudges: config.tasks.thresholds.nudges,
      clock,
      now,
      layout,
      realDirs: { projects: realLayout.projects, data: realLayout.root, secrets: realLayout.secrets, program: programDir },
      ports: { local: localPort, external: options.externalPort ?? config.ports.external },
      ...(options.serviceThumbnail ? { serviceThumbnail: options.serviceThumbnail } : {}),
      // 服务首页的缩略图（140）：浏览器和联网工具同一个（下面的浏览器探测）
      browser: () => playwrightDriver({ executablePath: browserPath, missing: () => browserLocator.missingReason() }),
      // project_ops 跟维护者说一句：和秘书转达、网关发消息同一条路（下面 userMessageScopeOf、userMessagePreludeOf）
      relay: { scopeOf: (c, taskId) => sayingScopeOf(c, taskId), preludeOf: (c, key, taskId) => userMessagePreludeOf(c, key, taskId) },
      newJob: () => (process.platform === "win32" ? createJobObject() : undefined),
      // 触发底座、事件来源的分发要项目系统的派单器，建在它之后：现转给它们
      scheduledJobs: () => wired("scheduledJobs"),
      checkEventTrigger: (trigger) => wired("eventTriggers").check(trigger),
      // 点"新建项目"、秘书出建议立项卡时写的运行时（289）：现在能用的才行
      runtimeRefusal,
      // 在哪个文件夹做（305）：点"新建项目"时先核对，点"立项"时定下（新开的这时建出）
      workFolder: workFolders,
      log,
    });
    wiring.projectSystem = projectSystem;
    // 删除参与方（279）里内核的那几份：任务（内部任务和它们的记录、卡片；删任务时它自己的）、子 agent（并行）、触发底座（定时作业）、
    // 守卫接入（审批、效果日志、执行记录、完整内容）、范围审视（范围记录）、待我处理（属于它的事项）、素材库（随删除彻底删的系统记录，66；
    // 129 起记忆插件停用时照常：素材库只保管时也找得到只在原文副本里的）。登记在项目系统的之后：字段级改写的卡追加新版本的先后照原来
    registerTaskDeletion(deletionParticipants);
    registerSubAgentDeletion(deletionParticipants);
    registerJobDeletion(deletionParticipants);
    registerGuardRuntimeDeletion(deletionParticipants);
    registerScopeRecordDeletion(deletionParticipants);
    registerInboxDeletion(deletionParticipants);
    // 断开数据源时连已导入的一起删（295）：它导入的记录、同步记录、"已导入"里它的文件；由这些记录采成的素材由下面素材库那一份删
    registerDataSourceDeletion(deletionParticipants, { imports: layout.imports, log });
    registerMaterialsDeletion(deletionParticipants, {
      store,
      cards,
      rewriters: purgeRewriters,
      materials: () => materials.list(),
      internalRecords: (projectId) => materials.list().filter((m) => internalRecordOf(m, materialOwners)?.projectId === projectId),
      // 随项目、任务彻底删除的系统记录在推理库里的证据编号（272）：问记忆的结果按证据编号引原话
      evidenceOf: purgedEvidence,
    });
    // 项目的服务停在插件之后（停的时候倒着来）
    teardown.push(() => projectSystem.stopServices());
    // 提问卡上的回答：项目维护者为工单问的交回它（16，派单器的澄清给通知）
    registry.register(questionsCardType(projectSystem.clarificationReply));
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
    const toolkits = createToolkitService({ store, cards, inbox, projects: projectSystem.toolkitProjects, tasks, execution: () => wired("taskExecution"), skills, mcp, now, log });
    // MCP 登记变更（239）：维护者用 request_mcp_change 提加、改、删一条登记，用户在卡上确认之后运行时才写 mcp.json 并自检。
    // 登记变了：让提交的人的会话按新的装配重新拉起（维护者和项目的两个模块各试一次，不是它的会话时不做事）
    const mcpChanges = createMcpChangeService({
      store,
      cards,
      inbox,
      mcp,
      write: { file: layout.mcpFile, historyDir: layout.mcpHistoryDir },
      projectOf: (projectId) => {
        const project = projectDirectory.get(projectId);
        return project && { id: project.id, name: project.name };
      },
      taskOf: (taskId) => {
        const task = tasks.get(taskId);
        return task && { id: task.id, title: task.title, maintainerId: task.maintainerId, ...(task.internal === undefined ? {} : { projectId: task.internal.projectId, projectName: task.internal.projectName }) };
      },
      mcpChanged: (submitter, name) => {
        log(`MCP ${name} 的登记变了：让 ${submitter.maintainerId} 的会话按新的装配重新拉起`);
        const notice = mcpTexts.reassembledNotice(name);
        wiring.maintainers?.reassemble(submitter.maintainerId, notice);
        projectSystem.reassemble(submitter.maintainerId, notice);
      },
      now,
      log,
    });
    // skill 的目录名就是斜杠命令（82）：不合规的（手放的、更早导入的）不自动改名，启动时记一条日志，skill 库页上也提示
    const skillDirIssues = skillDirProblems(skills.skills());
    if (skillDirIssues.length > 0) log(`skill 的目录名有 ${skillDirIssues.length} 处要留意：${skillDirIssues.join("；")}`);
    registry.register(toolkitChangeCardType(toolkits));
    // "MCP 登记变更"卡（239）：批准之后写配置区的 mcp.json 并自检
    registry.register(mcpChangeCardType(mcpChanges));
    // 秘书带参调 MCP（240）：登记过就调，参数原样发过去；不出卡、不分读写（用户 2026-10-21 定"别加限制"）
    const mcpCalls = createMcpCallService({ store, mcp, now, log });
    registry.register(progressCardType());
    // 素材来源（08）：拥有事件的模块声明"这类事件怎么变成素材"，内核的在这里、start 之前 materials.register(...)；
    // 插件的在它的数据契约里（ctx.materialSources，129：停用也照样声明，素材库按它留原话副本）。用户发言、卡片被关闭是素材库自带的
    // 审批决定（07）：用户在审批卡上批准、拒绝
    materials.register(approvalDecisionSource);
    // 点"发起任务"时写的原话（用户发言）、澄清问题的回答（提问卡）、计划卡上的确认和打回（12）
    materials.register(startTaskRequestSource);
    materials.register(clarificationAnswerSource);
    materials.register(planDecisionSource);
    // 立项书卡上的确认（15）、立项要求变更（125）、规范改写（261）、运营方案（130）、工单卡（17）上的决定由项目系统登记（278，createProjectSystem）
    // 任务结局（完成、失败、取消）、用户对产出的反应（由我验收的结论、要求返工）（13）
    materials.register(taskOutcomeSource);
    materials.register(outputReactionSource);
    // 并行确认卡上的决定（审批决定，20）
    materials.register(parallelDecisionSource);
    // 用户的语音（31）：识别完成时算用户发言，文字是识别出的文字——214 号票起由语音插件在数据契约里声明
    // 授权到期续期事项上的续期、不续（审批决定，14）；计划变更卡上的确认、拒绝走上面的 planDecisionSource
    materials.register(grantRenewalSource);
    // 工具包变更卡上的批准、拒绝，项目页和任务详情里直接改工具包（审批决定，27）
    materials.register(toolkitDecisionSource);
    // MCP 登记变更卡上的批准、拒绝（239）：审批决定
    materials.register(mcpDecisionSource);
    // "浏览"的 ⋮ 菜单里存进素材的网页（165）212 号票起由浏览插件在数据契约里声明
    // 内部作业：每晚备份、每周校验、每天清理临时区（错过的马上补一次）。建它没有副作用，先建好给插件登记；
    // 停的时候先停内部作业（中止正在跑的、等它停下），再停备份（中止手动的那些）
    const internalJobs = createInternalJobs({ store, scheduler, clock, log, scheduleContext });
    // 快速动作的执行器注册表（21）：先建好给插件登记，内核的执行器在下面登记。处置由守卫的判定函数定（动作作为伪工具调用
    // quick_action:<类型>，用户的自定义类别也适用）。快速动作的服务建它没有副作用，129 起也在插件装配之前建好（记忆删除卡上确认时用）
    const quickActionRegistry = new QuickActionRegistry();
    const quickActions = createQuickActionService({
      store,
      cards,
      inbox,
      registry: quickActionRegistry,
      guard: { places, scratchDir: realLayout.scratch, settings: watchSettings, now: () => clock.now() },
      log,
    });
    // agent 贡献（128）：插件给 agent 的工具、每轮的上下文块、钩子订阅登记在这里，秘书和 agent 宿主装配时按"给谁"筛。先建好给插件登记
    const agentContributions = createAgentContributions({ log });
    // 媒体库（附件、语音的录音和合成出的音频）、授权的文件夹（134、138：秘书在聊天里和浏览插件的找文件共用一份，每次现读）：
    // 214、212 号票起语音插件、浏览插件装配时要用，在插件之前打开
    const media = openMediaStore({ mediaDir: layout.media, uploadsDir: layout.uploads, maxUploadBytes: config.media.maxUploadBytes });
    const localFolders = openLocalFolders({ file: layout.localFoldersFile, log });
    // 向量函数（正式运行是数据目录模型区里的 bge-m3，测试注入假的）：记忆插件、记忆管理员共用一份
    // （打开推理库时 manifest 里记着它的名字；管理员改一条结论时不能把它写成"没有"）
    const memoryEmbedder = options.embedder ?? createBgeM3Embedder(layout.root);
    // agent 运行时（286，ADR-0027 的"运行时"贡献点）：维护者用哪个运行时跑它的会话。登记表在插件装配之前建好（插件在数据契约里登记它们的），
    // 内核自带的 pi 照同一个接口登记（不是插件、不能停用）。维护者的运行时存在任务、项目上（Task.runtime、Project.runtime，没写是 pi）：
    // 项目的维护者照项目的（没写照转来的任务的），任务自己的、定时作业自己的维护者照它执行的那个任务的。运行时闸门交给 agent 宿主（拉起哪个
    // 子进程入口、拉不拉得起、停用时停掉子进程）和执行控制器（执行中的任务转等我、启用后接着），登记表交给 agent 管家（解析子进程入口）；
    // 插件的状况变了（运行中停用、启用）登记表通知一声。下面执行控制器、agent 宿主、网关那几处各接一行
    const runtimeGate = createRuntimeGate({
      registry: agentRuntimes,
      runtimeOf: (maintainerId) => {
        const owned = projectDirectory.ofMaintainer(maintainerId);
        if (owned) return owned.project.runtime ?? (owned.project.fromTaskId === undefined ? undefined : tasks.get(owned.project.fromTaskId)?.runtime);
        return tasks.ofMaintainer(maintainerId)?.runtime;
      },
      // 给运行时选的值（289）：项目的维护者照项目的，任务自己的照任务的（⚙ 里选的，拉起时交给子进程）
      optionsOf: (maintainerId) => {
        const owned = projectDirectory.ofMaintainer(maintainerId);
        if (owned) return owned.project.runtimeOptions;
        return tasks.ofMaintainer(maintainerId)?.runtimeOptions;
      },
      // 接管来的会话（290）：项目、任务上记着的（二狗管着的拉起时接着它，交还了的不拉起）
      takeoverOf: (maintainerId) => {
        const owned = projectDirectory.ofMaintainer(maintainerId);
        if (owned) return owned.project.takeover;
        return tasks.ofMaintainer(maintainerId)?.takeover;
      },
      log,
    });
    teardown.push(plugins.onChange(() => agentRuntimes.changed()));
    // 数据源（295，ADR-0027 的"数据源"贡献点）：登记表在插件装配之前建好（插件在数据契约里登记它们的数据源）；
    // 服务（设置 · 数据源、定期导入、按需查的工具、导入文件夹）在插件起来之后建，插件的状况变了跟着变
    const dataSourceRegistry = createDataSourceRegistry();
    // 319 号票：记忆整理（225）从 KERNEL.env 里读 DEEPSEEK_API_KEY，给记忆插件的是守护进程环境的这一份副本（现取的就是副本里的，
    // 网页上填了 key 之后组合根换掉它，下一次整理就用新的）；别处还是用 options.env，不受影响
    const memoryEnv: Record<string, string | undefined> = { ...options.env };
    // 插件（126）：内核的登记表都建好了、素材开始采集之前装配（先登记全部插件的数据契约，再按依赖顺序装配要装的），
    // 再按顺序启动（各插件自己的 start）。停的时候依赖方先停、倒着撤
    teardown.push(() => plugins.stop());
    await plugins.setup({
      services: [
        bindService(KERNEL.config, config),
        bindService(KERNEL.store, store),
        bindService(KERNEL.clock, clock),
        bindService(KERNEL.scheduler, scheduler),
        bindService(KERNEL.cards, cards),
        bindService(KERNEL.inbox, inbox),
        bindService(KERNEL.workdayCalendar, workdayCalendar),
        // 事件来源的分发建在触发底座之后（插件装配时还没有）：现转给它
        bindService(KERNEL.eventTriggers, { check: (trigger) => wired("eventTriggers").check(trigger) }),
        // 日历插件要的（213）：定时作业在日历上的展开。定时作业建在后面：现转给它
        bindService(KERNEL.scheduledJobs, { calendar: (from, to) => wired("scheduledJobs").calendar(from, to) }),
        // 记忆插件要的（129）：素材库、素材引着的记录、快速动作、改写函数表、向量函数（测试注入假的）
        bindService(KERNEL.materials, materials),
        bindService(KERNEL.materialOwners, materialOwners),
        bindService(KERNEL.quickActions, quickActions),
        bindService(KERNEL.purgeRewriters, purgeRewriters),
        bindService(KERNEL.embedder, memoryEmbedder),
        // 记忆插件要的（225）：守护进程的环境（整理读 DEEPSEEK_API_KEY；319 号票起网页上填了 key 也换进这一份）和整理用的模型（测试注入假的）
        bindService(KERNEL.env, memoryEnv),
        bindService(KERNEL.memoryModel, options.memoryModel),
        // 记忆插件要的（264）：记忆的设置（秘书顺口问开不开），设置接口改了下一条输入就按新的
        bindService(KERNEL.memorySettings, memorySettings),
        // 记忆插件要的（266）：账本记记忆简报估的 token（用量页单列）。账本建在插件之后：现转给它
        bindService(KERNEL.usage, { recordContextUsage: (usage) => wired("ledger").recordContextUsage(usage) }),
        // 记忆插件要的（283）：个人档案里的人、档案摘要、不进整理提示的值、字段换了新值、收候选。档案建在插件之后：现转给它
        bindService(KERNEL.personalFiles, {
          people: () => wired("personalFiles").forMemory.people(),
          background: () => wired("personalFiles").forMemory.background(),
          withheld: () => wired("personalFiles").forMemory.withheld(),
          // 订阅在插件装配时就发生（档案还没建）：先记在这里，档案建好以后由它转过来
          onFieldReplaced: (listener) => {
            fieldReplacedListeners.add(listener);
            return () => void fieldReplacedListeners.delete(listener);
          },
          replacedValues: () => wired("personalFiles").forMemory.replacedValues(),
          addCandidates: (origin, inputs) => wired("personalFiles").forMemory.addCandidates(origin, inputs),
          composeCandidates: (opts) => wired("personalFiles").forMemory.composeCandidates(opts),
        }),
        // 语音插件要的（214）：媒体库、数据目录、临时事件的推送、识别进程的环境（测试换成假的识别进程、合成服务）；
        // 241 号票起还有每个 agent 自己配的名字和音色（说话的是哪个 agent 就用它的参考音色）
        bindService(KERNEL.media, media),
        bindService(KERNEL.layout, layout),
        bindService(KERNEL.notifications, notifications),
        bindService(KERNEL.agentRoles, agentRoles),
        bindService(KERNEL.voiceEngines, {
          env: options.env,
          recognizerCommand: options.recognizerCommand,
          ffmpegCommand: options.ffmpegCommand,
          speechUrl: options.speechUrl,
          recognizerRetryMs: options.recognizerRetryMs,
          recognizerStableMs: options.recognizerStableMs,
          sendVoiceWaitMs: options.sendVoiceWaitMs,
        }),
        // 浏览插件要的（212）：媒体库、数据目录（同上）、授权的文件夹；后面两样建在插件之后（agent 管家、联网设置），用到时现转
        bindService(KERNEL.localFolders, localFolders),
        bindService(KERNEL.thumbnails, (request) => agents.thumbnails(request)),
        bindService(KERNEL.oneShot, <T>(entry: string, request: unknown, label: string, timeoutMs: number) => agents.runOneShot<T>(entry, request, label, timeoutMs)),
        bindService(KERNEL.webSearch, { appBrowserNote: () => appBrowserTurnNote(webSettings.view().effective) }),
        // 日历插件要的（299）：外部日历（数据源交来的日程）。数据源的服务建在插件之后：现转给它
        bindService(KERNEL.externalCalendars, { events: (from, to) => wiring.dataSources?.calendarEvents(from, to) ?? [], version: () => wiring.dataSources?.calendarVersion() ?? 0 }),
        // 记忆插件要的（337）：记忆插件槽——用户说"帮我记一句"时把原话交给在跑的那个记忆插件，每条消息的简报问它要。
        // 宿主建在插件之后：现转给它
        bindService(KERNEL.memorySlot, { remember: (input) => wired("memorySlot").remember(input), brief: (input) => wired("memorySlot").brief(input) }),
      ],
      surfaces: {
        cardTypes: registry,
        purge: purgeRewriters,
        materialSources: materials,
        quickActions: quickActionRegistry,
        internalJobs,
        boardKinds,
        eventSubscribers,
        // 运营手段（130）：项目系统的登记表，插件登记的和内核的（定时、事件触发、项目的服务、公网入口）在一起
        operationMeans: projectSystem.operationMeans,
        agent: agentContributions,
        apps,
        // 运行中停用摘下、运行中启用登记回去并整表补齐（211）
        views: { detach: (name) => store.detachView(name), attach: (view) => store.attachView(view) },
        // agent 运行时（286）：插件在数据契约里登记的运行时
        runtimes: agentRuntimes,
        // 数据源（295）：插件在数据契约里登记的数据源
        dataSources: dataSourceRegistry,
      },
    });
    await plugins.start();
    // 角色表（248 号票）：插件起来了，参考音色读得到——这时候做一次迁移（agent-roles.json 还没有就按 241 号票的旧配置 + 全局名字 + 全局音色造角色）
    agentRoles.start();
    // 设置 · 插件（211）：运行中停用、启用、移除，写配置；移除时连数据删走彻底删除的口子
    const pluginSettings = createPluginSettings({
      host: plugins,
      configFile: layout.configFile,
      config: config.plugins,
      purge: { store, participants: deletionParticipants, dataDir: layout.root, media, now, log },
      log,
    });
    // 插件的状况（193）：插件频道上的临时事件，订阅时补推（网关的 snapshot），运行中停用、启用、移除（211）、换了语言（给人看的名字跟着变）再推
    const pluginStatusFrame = (): EventFrame => ({ channel: CHANNELS.plugins, seq: store.lastSeq(CHANNELS.plugins), type: EVENT_TYPES.pluginStatus, payload: { plugins: plugins.status() } satisfies PluginStatusEventPayload });
    teardown.push(plugins.onChange(() => notifications.publish(pluginStatusFrame())));
    teardown.push(language.onChange(() => notifications.publish(pluginStatusFrame())));
    materials.start();
    teardown.push(() => materials.stop());
    // 设置 · 数据源（295）：一处列出插件登记的数据源（连接状态、上次同步和条数、立即同步、断开、两种用法的开关、敏感类别）；
    // 密钥在密钥区的 data-sources/、用法开关在配置区的 data-sources.json；定期导入挂内部作业，按需查的工具经 agent 贡献给秘书；
    // 共用的导入文件夹在数据目录的 imports/（每分钟、文件夹一有变化就看一遍，认得的交给数据源导入、挪进"已导入"）。
    // 素材开始采集之后再起：起来时看一遍导入文件夹，导进来的记录照常采成素材
    const dataSources = createDataSources({
      registry: dataSourceRegistry,
      store,
      secrets: createDataSourceSecrets({ dir: layout.dataSourceSecrets, log }),
      settings: createDataSourceSettings({ file: layout.dataSourcesFile, log }),
      internalJobs,
      scheduler,
      contributions: agentContributions,
      participants: deletionParticipants,
      folder: { imports: layout.imports, imported: layout.importedDir },
      inferable: () => config.memory.sensitiveCategories,
      materials,
      now,
      openFolder: options.openFolder ?? openFolderOnDesktop,
      log,
    });
    wiring.dataSources = dataSources;
    // 外部日历变了（306）：工作日历频道上的临时事件 external_calendar 带新的版本，订阅时补推（网关的 snapshot）；开着的日历页据此重新取
    const externalCalendarFrame = (): EventFrame => ({
      channel: CHANNELS.workdayCalendar,
      seq: store.lastSeq(CHANNELS.workdayCalendar),
      type: EVENT_TYPES.externalCalendar,
      payload: { version: dataSources.calendarVersion() } satisfies ExternalCalendarEventPayload,
    });
    teardown.push(dataSources.onCalendarChange(() => notifications.publish(externalCalendarFrame())));
    dataSources.start();
    teardown.push(() => dataSources.stop());
    // 设置 · 组件（323）：清单随程序发布；下载在守护进程里一份（排队一次下一个），下了一半的留在组件区的 .staging/，
    // 守护进程停下时中止正在下的（下次是"暂停了"，点继续接着下）
    const components = createComponents({
      root: layout.root,
      componentsDir: layout.components,
      manifest: options.components?.manifest ?? shippedComponentManifest(options.env, log),
      probes: options.components?.probes ?? createComponentProbes({ config, env: options.env }),
      transport: options.components?.transport ?? componentTransport(options.env, "ergo-components"),
      ...(options.components?.freeBytes ? { freeBytes: options.components.freeBytes } : {}),
      ...(options.components?.stallMs !== undefined ? { stallMs: options.components.stallMs } : {}),
      ...(options.components?.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.components.probeTimeoutMs } : {}),
      hfEndpoint: options.env.HF_ENDPOINT,
      log,
    });
    teardown.push(() => components.stop());
    teardown.push(plugins.onChange(() => dataSources.refresh()));
    // 待批的配对请求到点过期（守护进程重启后照常）
    pairing.start();
    teardown.push(() => pairing.stop());
    // 工作日历变了（个人设置、节假日数据）："按我的工作日"的作业按新的工作日历重算下一次（插件要跟着重算的自己登记，126）
    workdayCalendar.onChange(() => {
      internalJobs.rearm();
      wiring.scheduledJobs?.rearm();
    });
    const backup = createBackupService({ layout, config: config.backup, inbox, clock, internalJobs, log, ...(options.backupFiles ? { files: options.backupFiles } : {}) });
    teardown.push(() => backup.stop());
    teardown.push(() => internalJobs.stop());
    backup.start();
    // 节假日数据的续期（29）：每月检查（12 月起查下一年），缺了放进待我处理；用户点"发起更新任务"就发起一个联网任务
    const holidayUpdates = createHolidayUpdates({ workdayCalendar, inbox, store, tasks, internalJobs, clock, layout, config: config.holidayCheck, log });
    holidayUpdates.start();
    teardown.push(() => holidayUpdates.stop());
    // 工具调用完整内容的保留期和总量上限（65）：每天定时清，错过了开机后补一次（内部作业，异步跑，不挡启动）。
    // 清掉后剩的参数摘要按工具自己的登记打码（280），认得的工具在秘书的工具装好之后才齐：用到时现取（下面"接上"处填）
    const toolCallRetention = createToolCallDetailRetention({ store, internalJobs, clock, limits: config.toolCallDetails, tools: () => wired("knownTools")(), log });
    toolCallRetention.start();
    const streams = createStreamHub({ lastSeq: (channel) => store.lastSeq(channel) });
    teardown.push(() => streams.close());
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
    wiring.ledger = ledger;
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
      // 维护者按运行时拉起哪个子进程入口（286）
      runtimes: agentRuntimes,
      // 前缀（71）：拉起时加在每个 agent 的系统提示最前面，每次现读；不是中文时末尾加"用 <语言> 回答用户"（168）
      systemPromptPrefix: effectiveSystemPrompt,
      log,
    });
    // 先关 Job：子进程连同它们起的孙进程一起结束；再等子进程的句柄收尾
    teardown.push(async () => {
      job?.close();
      await agents.shutdown();
    });

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
      // 任务的 agent 超出授权先不管，都照常记录、标关注类别；开着时一切照原样。315 号票起现取（设置里改了，下一次判定就按新的）
      get conversationApprovals() {
        return safety.current().conversationApprovals;
      },
      // 子进程里的调用在等用户批准：这个 agent 的活动状态是"等你"（25）
      userWaits: agents,
      // 项目档案（不含工作目录和历史区）里的文件被整体重写或删除前，运行时先留一份旧版本（15），所以守卫对它传 backedUp
      autoVersioning: projectSystem.autoVersioning,
      // 子 agent 的调用挂起后才被决定：通知进维护者的会话，说法由子 agent 那边给（20）
      lateNotice: (decision) => wiring.subAgents?.lateNotice(decision),
      log,
    });
    teardown.push(() => guards.stop());
    // 运行时自己要问用户的（288：Claude Code 的 AskUserQuestion、退出计划模式的批准，宿主协议 23 的 ask_user）：提问卡进维护者的会话和待我处理，
    // 卡上答了交回子进程；在等你回答时这个 agent 的活动状态是"等你"
    const runtimeQuestions = createRuntimeQuestions({ store, cards, inbox, userWaits: agents, log });
    registry.register(runtimeQuestionCardType(runtimeQuestions));

    const deletionDeps = { store, cards, rewriters: purgeRewriters, now, evidenceOf: purgedEvidence };
    // 快速动作：执行器按动作类型登记（29：改工作日历；22 号票的任务控制、27 号票的 MCP 调用照这个加；
    // 插件的经插件宿主登记，126：记忆命令 129 起是记忆插件的，插件装配时登记、排在这些前面）
    // 改工作日历（29）：一律先确认，确认后由运行时改配置区里的个人设置
    quickActionRegistry.register(workdayCalendarAction(workdayCalendar));
    // 任务控制（22）：暂停、继续、取消，推断出来的一律先问；执行走执行控制器（算用户改的状态）
    for (const executor of taskControlActions({ tasks, execution: () => wired("taskExecution") })) quickActionRegistry.register(executor);
    // 立即运行一次、跑完自动播报（100）：用户说"把 t-5 再跑一次""以后 t-5 跑完直接念给我"
    for (const executor of taskRunActions({ tasks, scheduledJobs: () => wired("scheduledJobs") })) quickActionRegistry.register(executor);
    // 删除任务（186）：用户说"把 t-3 删了"，总会先出卡确认；执行走删除任务的模块（先停维护者、等子进程退出，所以要等结果）
    quickActionRegistry.register(taskDeleteAction({ tasks, deletion: () => wired("taskDeletion") }));
    // 秘书转达（103）：按用户的话往已有的任务、项目维护者的会话里插一句，和用户在那里直接说话同一条路（下面 userMessageScopeOf、
    // userMessagePreludeOf，网关发消息也用它们），消息标上秘书转达
    for (const executor of relayActions({ store, tasks, scopeOf: (c, taskId) => sayingScopeOf(c, taskId), preludeOf: (c, key, taskId) => userMessagePreludeOf(c, key, taskId) })) {
      quickActionRegistry.register(executor);
    }
    // 授权的文件夹（134 号票叫登记的本机文件夹，138 号票起秘书在聊天里和"浏览"里共用这一份，在插件装配之前打开）：设置页、秘书的快速动作都改它
    // 授权文件夹（138）：用户在聊天里授权、取消授权文件夹，一律出卡，用户点"执行"才改（任何 agent 自己都不能改）
    quickActionRegistry.register(authorizeFoldersAction(localFolders));
    // 秘书被唤起时带上现在授权了哪几个文件夹、聊天里授权用快速动作（138，agent 贡献的上下文块；每次唤起现取）
    agentContributions.context.register({ to: { agents: ["secretary"] }, when: "wake", id: AUTHORIZED_FOLDERS_BLOCK_ID, text: () => secretaryFoldersBlock(localFolders.view()) });
    // 调用授权给秘书快速动作的 MCP 工具（27）：参数按登记固定，由守护进程转给 MCP 服务进程，不拉起 agent
    quickActionRegistry.register(mcpQuickAction(mcp));
    // ── 个人档案（281）：内核的个人数据（停用记忆插件也照常）。本人的姓名就是"我的名字"（userName）；写进档案只有两条路——
    // 档案页里直接改（网关的 /api/personal-files），秘书的快速动作 personal_file（号码出核对卡逐位列出，原话里明说了的直接写）；
    // 彻底删除照删素材的口径（deletionDeps：改写函数表、卡片、证据编号），连出处一起删时用素材库。秘书读档案的工具在秘书的工具清单里
    purgeRewriters.register(personalFilePurge);
    const timeZoneDay = new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    // 283：生日、纪念日每年要记着的日子经插件宿主现取那个插件的服务（personal-files/annual-port.ts；插件没启用时档案页写明，起来时补建）；
    // "二狗了解到的"经记忆插件的服务现取
    const personalFiles = createPersonalFilesService({
      store,
      cards,
      inbox,
      userName,
      deletion: { ...deletionDeps, materials },
      today: () => timeZoneDay.format(new Date(clock.now())),
      now,
      annual: annualPortOf(plugins),
      memory: () => plugins.service(MEMORY),
      log,
    });
    wiring.personalFiles = personalFiles;
    teardown.push(
      personalFiles.forMemory.onFieldReplaced((change) => {
        for (const listener of fieldReplacedListeners) listener(change);
      }),
    );
    quickActionRegistry.register(personalFileAction(personalFiles));
    registry.register(personalFileCardType(quickActions));
    // 283：候选核对卡（记忆管理员攒的候选）
    registry.register(personalFiles.suggestCardType());
    // 283：对一遍生日、纪念日每年要记着的日子（插件停用期间开的补建）、跟着素材的删除作废候选
    teardown.push(personalFiles.start());
    // 299：断开数据源并删已导入的时，从它来的候选（手机通讯录挑的人）还没写进档案的连卡上的值一起删
    teardown.push(registerCandidateDeletion(deletionParticipants, { store, cards, compose: () => void personalFiles.candidates.compose() }));
    // ── 个人档案的接线到这里
    for (const executor of options.extraQuickActions ?? []) quickActionRegistry.register(executor, { replace: true });
    registry.register(quickActionCardType(quickActions));
    for (const definition of options.extraCardTypes ?? []) registry.register(definition, { replace: true });
    // 设置里按会话、按时间段删除素材（21）；彻底删除之后没人引用的媒体文件删掉
    const materialDeletion = createBulkMaterialDeletion({ ...deletionDeps, materials, unmaterializedPurgeTargets: (scope, found) => voicePurgeTargets(store, scope, found) });
    // 设置里看素材（158）：范围里的素材列表、一条的完整内容和来源；标出在废弃分支里的（150）、项目内部的记录（64）
    const materialBrowser = createMaterialBrowser({
      store,
      materials,
      abandoned: (m) => inAbandonedBranch(store.reader, m.ref.event),
      internal: (m) => internalRecordOf(m, materialOwners),
    });
    // 网页"记忆"页的结论、证据与推理、问题箱（233）：推理库的只读视图，每次打开一次引擎、读完整理关掉。
    // 最新一夜的整理记录在 ergo.db 的派生视图里（记忆插件的），插件没启用过时没有这张表，读不到就不带那一行
    const memoryGraph = createMemoryGraphReader({
      file: layout.rgDb,
      clock,
      log,
      latestNightly: () => {
        try {
          return latestNightlyRecord(store.reader);
        } catch {
          return undefined;
        }
      },
    });
    // 记忆插件槽（337 号票第二段）：把现有这套包成一个插件（会意 / Subtext）、登记进注册表、在这里启起来。
    // 这一段接上了每条消息的简报（记忆插件的 message-brief.ts 经 KERNEL.memorySlot 问宿主要）和"记一句"；工具、curator、purge、
    // 访谈、网页还是走原来的路（下一段才改接）。
    // 插件自己不带引擎：引擎（缓存一份只读的）和推理库那一侧的彻底删除都由 memory/provider/subtext-runtime.ts 备齐，
    // 组合根只 import memory/provider/ 这个槽（memory/ 里插件内部的那些文件只有插件清单 import，见 test/memory/boundary.test.ts）。
    // 插件的数据目录 <数据目录>/memory/subtext/ 由宿主在 activate 时建好；338 号票起会意的推理库也在里面
    // （启动时从 db/rg.db 搬过去的，见上面那一段），素材库 materials.db 和事件日志仍归内核、留在 db 区。
    const subtextRuntime = createSubtextRuntime({ file: layout.rgDb, clock, model: DEEPSEEK_DEFAULT_MODEL, embedder: kernelEmbedderAdapter(memoryEmbedder), config: config.memory, store, materials, log });
    teardown.push(() => subtextRuntime.close());
    const memoryProviderRegistry = createMemoryProviderRegistry();
    memoryProviderRegistry.register(subtextProviderFactory(subtextRuntime.deps));
    const memoryHost = createMemoryHost({
      rootDir: layout.root,
      registry: memoryProviderRegistry,
      // 语言、用户称呼、助手名字都现取（和系统提示一样：设置里改了马上跟着变）
      identity: () => {
        const name = userName.current();
        return { language: language.effective().id, ...(name === undefined ? {} : { userName: name }), assistantName: assistantName.current() };
      },
      now: () => new Date(clock.now()),
      log,
    });
    teardown.push(() => memoryHost.deactivate());
    // 337 号票：记忆插件的"记一句"工具和每条消息的简报经 KERNEL.memorySlot 现取这个宿主（插件装配在它之前，所以这里接上）
    wiring.memorySlot = memoryHost;
    // 数据目录已经建好（上面 mkdir）：启用配置里选的那一个（默认会意）。配置写了个不认得的 id 时只记一行、不让守护进程起不来
    // （插件没起来时简报就不带：宿主那边"没有在跑"回 undefined）
    try {
      await memoryHost.activate(config.memory.provider ?? DEFAULT_MEMORY_PROVIDER);
    } catch (err) {
      log(`记忆插件没启用：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：启动时的说明
    }
    // 彻底删除的一次性补抹（272 号票）：265 号票以前删过的素材，事件日志里问记忆、问记忆管理员的结果还引着原话的那几行换成删除标记，
    // 秘书的会话上追加 messages_purged（会话文件跟着补）。插件起来以后、秘书起来以前跑；做完记一笔，以后不再跑
    backfillPurgedQuotes({ store, evidenceOf: (materialIds) => lookupPurgedEvidence(layout.rgDb, materialIds, log), now, log });
    teardown.push(startPurgedMediaCleanup({ store, media, materials, log }));

    const credentials = modelCredentials(options.env);
    // 设置里的"模型"（73）：按 agent 现取、只用于新开的会话（接着的会话子进程照它开始时的）；看图能力设置页改的优先于配置文件
    let lsmEnabled = false;
    const modelSettings = createModelSettings({
      layout,
      config,
      credentials,
      // 319 号票：网页上填的 key 写进文件、换进 credentials 之后，记忆整理读的那份环境也换成新的
      // （子进程的环境只带系统变量白名单，process/child-env.ts；key 照旧经 stdin 的"启动"命令进去，不从这里漏出去）
      keyApplied: (provider, key) => {
        memoryEnv[provider.keyEnv] = key;
      },
      probe: (request) => agents.probeModels(request),
      lsm: () => lsmEnabled,
      secretarySession: () => secretary.sessionModel,
      // 单独配了模型的维护者是谁（120）：设置页上列在项目维护者、任务维护者那一行下面，点了去它的 ⚙
      maintainerOwner: (agentId) => {
        const project = projectDirectory.maintainedBy(agentId);
        if (project) return { agent: "project_maintainer", owner: { kind: "project", id: project.id, title: project.name } };
        const task = tasks.ofMaintainer(agentId);
        return task ? { agent: "task_maintainer", owner: { kind: "task", id: task.id, title: task.title } } : undefined;
      },
      ...(options.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: options.catalogBaseUrl }),
      log,
    });
    // 首次设置向导（319 号票）：五步哪几步做完了。真相是配置文件的 setup 节；各步的条件现算，都是现成的服务——
    // 我的名字（249）、模型的 key 配没配（315 的 keyView，和 GET /api/model-settings/key 同一个判法）、
    // 记忆的向量模型那个组件装好了没有（323 的组件视图，按功能门：装在这儿或者别处已经有了都算）、
    // 至少一台没被吊销的已配对设备（10；吊销了还没删的算"现在用不上"，不算做完）；
    // safety 没有条件，只有用户看过了（或者点了"以后再说"）才算 done
    const setup = createSetupState({
      configFile: layout.configFile,
      initial: config.setup,
      ready: {
        language: () => userName.current() !== undefined,
        model: () => modelSettings.keyView().apiKey.configured,
        components: () => components.view().features.some((feature) => feature.feature === COMPONENT_FEATURES.memorySemantic && feature.ready),
        phone: () => pairing.list().some((device) => !device.revoked),
      },
      log,
    });
    // 体检（319 号票的 319b）：八项检查现算（GET /api/doctor），组合根把各项要的东西凑齐交给它——
    // 端口是网关实际监听的那两个（生产里就是配置里的 ports.local / ports.external；测试里是系统挑的，免得体检去碰本机真的 8810 / 8811），
    // 所以先建，网关起来之后把真实端口填进去（view 是请求到时才现算的）；pi 的版本、服务管家的命令行都在二狗的程序目录里；
    // 组件缺不缺按清单的默认（missingDefaultFeatures）；最外面那项只看服务管家注册表里配没配，不真连出去
    let boundPorts = { local: config.ports.local, external: options.externalPort ?? config.ports.external };
    const svcDataDir = options.env.LSM_DATA_DIR?.trim() ? path.resolve(options.env.LSM_DATA_DIR.trim()) : defaultSvcDataDir(options.env);
    const doctor: DoctorService = createDoctor({
      probes: {
        ports: portsProbe(() => boundPorts),
        node: nodeProbe,
        pi: piVersionProbe(path.join(programDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")),
        supervisor: supervisorProbe({ node: process.execPath, script: path.join(programDir, "packages", "supervisor", "bin", "lsm.mjs"), dataDir: svcDataDir }),
        model: () => ({ configured: modelSettings.keyView().apiKey.configured }),
        components: () => {
          const view = components.view();
          // 组件清单读坏了（随程序发布的那份，组件页是空的）：看不出缺什么，这一项算"查不了"（网页写"这次没查出来"），
          // 不假装"该装的都装好了"
          if (view.components.length === 0) throw new Error("shipped component manifest is empty");
          return { missing: missingDefaultFeatures(view) };
        },
        disk: diskProbe(layout.root),
        external: externalProbe({ svcDataDir }),
      },
      now: () => clock.now(),
    });
    const agentModel = (agent: ModelAgent) => modelSettings.modelFor(agent);
    // 项目归档（含放弃）、删除，任务归档：这个维护者单独配的模型一起清掉（120）。任务转为项目后原任务的维护者成了项目的维护者，
    // 原任务归档时不清（它单独配的模型跟着项目走）
    teardown.push(
      store.onAppend((event) => {
        if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) {
          const { project, change } = event.payload as ProjectEventPayload;
          // @i18n-ignore-next log：改回跟随的原因只进日志
          if (change === "archived" || change === "abandoned" || change === "deleted") modelSettings.followRole(project.maintainerId, `项目「${project.name}」${change === "deleted" ? "删除了" : "归档了"}`);
        } else if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) {
          const { task, change } = event.payload as TaskEventPayload;
          if (change === "archived" && !projectDirectory.maintainedBy(task.maintainerId)) modelSettings.followRole(task.maintainerId, `任务 ${task.id}「${task.title}」归档了`); // @i18n-ignore log：改回跟随的原因只进日志
        }
      }),
    );
    const configuredVision = () => modelSettings.configuredVision();
    // 联网搜索、读网页（70）：秘书、任务维护者（起草和执行）、项目维护者、定时作业的维护者、子 agent 都配上（评审子 agent 不配）；
    // 联网开关关着的会话里守卫拒绝。154 起几种方式并列：浏览器（DDG → Bing → Google）、DeepSeek 的搜索接口（key 和模型共用，
    // 每次现取）、Tavily（key 只从环境里取，只在指定时用）。162 起按设置里的队列（DeepSeek、浏览器、agent-browser，能排序、能停用）：
    // 不指定时依次试启用的，没成换下一个；读网页先直接请求，被拦了按队列交给 DeepSeek 读网页、浏览器。工具说明跟着队列写，每次装配现做，
    // 设置改了秘书重新装配。DeepSeek 只有一个客户端，账号级的限速所有 agent 共用。
    // 319 号票：key 从 credentials 现取（网页上填了就地换），所以联网设置里"DeepSeek 的 key 配没配"也跟着变
    const deepseekTools = createDeepSeekTools({ key: () => credentials.deepseek, baseUrl: options.webDeepseekBaseUrl, log });
    const webSettings = createWebSettings({
      file: layout.webSettingsFile,
      deepseekKey: () => deepseekTools.available(),
      lsm: () => lsmEnabled,
      balanceLowAt: () => deepseekTools.balanceLowAt(),
      log,
    });
    const webAccess =
      options.webAccess ??
      createWebAccess({
        browser: playwrightDriver({ executablePath: browserPath, missing: () => browserLocator.missingReason() }),
        tavilyKey: () => tavilyKey(options.env),
        deepseek: deepseekTools,
        settings: () => webSettings.current(),
        log,
      });
    // DeepSeek 成了的调用按次计费（每次 0.005 元）：记进账本，记在发起调用的 agent 名下（它此刻的归属，和它的 token 用量一样）
    const onBilled = (billed: WebBilledCall) => {
      const id = billed.agentId ?? "unknown";
      ledger.recordWebCall({ agentId: id, attribution: agents.attributionOf(id), service: billed.service, kind: billed.kind });
    };
    // 每个会话都配的工具（装配用的一个对象）：联网搜索、读网页（按此刻的队列现做），语音回复（32）
    // 182：鸿蒙 App 的内置浏览器在这一轮用不用得了——和秘书的网页工具同一个准入（侧边栏、悬浮按钮那一轮，发消息那台设备还连着），
    // 用得了带上那台设备"浏览"里的搜索引擎（拼结果页的地址）。212 号票起由浏览插件判（BROWSING），插件没在运行时联网搜索不算它：
    // 装配时就不提（秘书按插件的贡献变了重新装配），装配之后插件停了的那一轮回 undefined
    const appBrowserTurn = (call: HostToolCall): AppBrowserTurn | undefined => plugins.service(BROWSING)?.appBrowserTurn(call);
    const sessionTools: SessionTools = {
      web: (agent) =>
        webTools(webAccess, {
          onBilled,
          setup: { queue: webSettings.view().effective, tavily: tavilyKey(options.env) !== undefined },
          agentBrowser: agent.bash,
          ...(agent.browse && plugins.service(BROWSING) ? { appBrowser: appBrowserTurn } : {}),
        }),
      onWebChange: (listener) => webSettings.onChange(listener),
      // 语音回复（32）、输入队列的挡板（214）：语音插件在运行时由它给（现取：停用了是 undefined，挡板按内核的）；
      // 它运行中停用、启用了，秘书手头这一条处理完按新的重新装配，各会话再看一眼队首
      get voiceReplies() {
        return plugins.service(VOICE)?.replies;
      },
      inputGate: (message) => plugins.service(VOICE)?.gate(message),
      onVoiceChange: (listener) => {
        let on = plugins.service(VOICE) !== undefined;
        return plugins.onChange(() => {
          const running = plugins.service(VOICE) !== undefined;
          if (running === on) return;
          on = running;
          listener();
        });
      },
    };
    const secretaryModel = () => options.secretaryModel ?? agentModel("secretary");
    const firstSecretaryModel = secretaryModel();
    if (firstSecretaryModel.kind === "catalog" && !credentials[firstSecretaryModel.provider]) {
      // 315 号票：照常起来；跟秘书说话时回"还没配模型、去设置 · 模型看怎么配"，网页的会话页上也有一条提示
      log(`没有 ${firstSecretaryModel.provider} 的模型 key：秘书能起来，跟它说话时回"还没配模型"、会话页上有提示（key 由 LSM 从数据目录的密钥区注入）`);
    }
    // 秘书的工具（守护进程代为执行的，内核的那些清单在 secretary/tool-list.ts；126 号票从这里挪过去）；插件给秘书的（128）经 agent 贡献，
    // 浏览侧边栏、悬浮按钮那一轮的网页工具（147、149）212 号票起是浏览插件的
    const secretaryTools = secretaryToolList({
      store,
      cards,
      inbox,
      tasks,
      // 277 号票：项目系统给秘书的几样经入口的小接口（SecretaryProjects）交给秘书的工具清单
      projects: projectSystem.secretary,
      quickActions,
      // 读个人档案（281）
      personalFiles,
      mcpCalls,
      boardKinds,
      // 秘书建任务时写的运行时（289）：现在能用的才行
      runtimeRefusal,
      now,
      log,
    });
    // 自定义关注类别能匹配的工具（设置页的候选，也用来查写错的名字）：内置的和 bash 拆出的伪工具、秘书代为执行的工具、快速动作的伪工具
    const watchToolChoices = () => {
      const all = [
        ...Object.values(BUILTIN_TOOL_REGISTRY),
        // 插件给秘书的工具（128）排在内核的前面、写着 at: "end" 的（212：浏览插件）排在内核的后面：和秘书看到的先后一样
        ...agentContributions.toolsFor(SECRETARY_TARGET).map((tool) => tool.descriptor),
        ...secretaryTools.map((tool) => tool.descriptor),
        ...agentContributions.toolsFor(SECRETARY_TARGET, "end").map((tool) => tool.descriptor),
        ...(options.extraSecretaryTools ?? []).map((tool) => tool.descriptor),
        // 登记的 MCP 工具（27）
        ...mcp.descriptors(),
        ...quickActionRegistry.list().map((e) => ({ name: quickActionToolName(e.type), title: t("daemon.quickActionTool", { title: e.title }) })),
      ];
      return [...new Map(all.map((tool) => [tool.name, { name: tool.name, title: tool.title }])).values()];
    };
    // 读一遍设置文件：频道上还没有事件、或者文件在停机时被改过，记一条（设置页据此显示）
    watchCategories.start();
    // 回复中用户发的话排的队（144）：秘书、维护者的会话在这一轮结束时一起交出去，归属、要先开的对话段照网关发消息时的认
    // （这两个在派单器接上之后才有：之前交出去的照排进来时的归属，秘书的会话不用认）
    const queueDelivery = createQueueDelivery(store, {
      scopeOf: (conversation, taskId) => userMessageScopeOf(conversation, taskId),
      preludeOf: (conversation, key, taskId) => userMessagePreludeOf(conversation, key, taskId),
      log,
    });
    const secretary = startSecretary({
      agents,
      store,
      streams,
      model: secretaryModel,
      credentials,
      tools: secretaryTools,
      ...(options.extraSecretaryTools ? { extraTools: options.extraSecretaryTools } : {}),
      // 插件给秘书的工具、上下文块、钩子订阅（128）：每次拉起现取，插件运行中停用时手头这一条处理完就重新装配
      contributions: agentContributions,
      boardKinds,
      media,
      configuredVision,
      guards,
      scratchDir: realLayout.scratch,
      // 秘书的会话文件里还有问记忆的结果（265 号票）：按被删素材的证据编号换行
      sessionRewriteFor: (purges) => sessionRewriteFor(purges, { evidenceOf: purgedEvidence }),
      timeZone: config.timeZone,
      sessionTools,
      assistantName,
      // 秘书自己指定的角色（248 号票）：在它的 ⚙ / 角色页里选的优先，跟默认就是全局的名字（43）
      profileName: () => agentRoles.assignedNameOf(CHANNELS.secretary),
      // 换了语言（168）：手头这一条处理完按新的系统提示重新拉起
      language,
      // 改了"我的名字"（249）：系统提示最前面那句跟着变，同样从下一轮起
      userName,
      skills: secretarySkills,
      // 用户打 /目录名 时展开秘书装配了的 skill（82）
      skillCommands: () => toolkits.skillCommands(),
      // 对话审批的开关现取（315 号票）：设置里改了，交下一条输入之前按新的系统提示重新拉起
      get conversationApprovals() {
        return safety.current().conversationApprovals;
      },
      prompts,
      // 任务做完、定时 / 事件触发的任务每运行完一次告诉秘书（99）：交付的文件在任务的产出区里找
      taskDone: { clock, settleMs: options.taskDoneSettleMs ?? TASK_DONE_SETTLE_MS, outputsDir: realLayout.outputs },
      queue: queueDelivery,
      log,
      ...(options.secretaryDownThresholdMs === undefined ? {} : { downThresholdMs: options.secretaryDownThresholdMs }),
    });
    teardown.push(() => secretary.stop());

    // 242 号票：记忆管理员——03:00 被唤醒去整理（同一份 runNow）、平时在记忆页（#/more/memory/curator）可以找它说话。
    // 记忆插件在运行时才有（从它那里取"每晚整理"的服务）：插件停用后管理员也跟着停，再启用时重新拉起（同一个会话），
    // 素材、结论照旧在数据目录里。243 号票起它按需拉起：守护进程起来时只建壳（会话、⚙、工具、提示），不拉起 pi 子进程——
    // 网页看历史不需要它活着，也不占 agents.maxLive 的名额（常驻时那一个名额让 8 条主切面测试跟着变了语义）。
    // 第一次有人跟它说话、或者 03:00 的作业唤醒它时由会话拉起，闲置到 agents.idleMinutes 后退出。
    let memoryCurator: MemoryCurator | undefined;
    const startCurator = (nightly: MemoryNightlyService): MemoryCurator =>
      startMemoryCurator({
        agents,
        store,
        streams,
        guards,
        media,
        prompts,
        // 改了"我的名字"（249）：系统提示最前面那句跟着变，同样从下一轮起
        userName,
        ledger,
        clock,
        timeZone: config.timeZone,
        // 它没有文件工具、也没有 bash：cwd 只是守卫眼里的一个真实路径
        cwd: realLayout.root,
        file: layout.rgDb,
        embedder: kernelEmbedderAdapter(memoryEmbedder),
        materials,
        // 和秘书那一份同一个认法：项目内部的记录看不到；存的网页按正文读；在废弃分支里的标出来
        materialOptions: {
          hidden: (m) => internalRecordOf(m, materialOwners) !== undefined,
          abandoned: (m) => inAbandonedBranch(store.reader, m.ref.event),
          savedPage: (m) => savedPageOf(store, m),
        },
        nightly,
        config: config.memory,
        // 283：个人档案的摘要当情境（号码、住址不列），档案改了下一轮起按新的
        background: () => personalFiles.forMemory.background(),
        // 模型那一行先跟随秘书的（242 号票；单独配模型等 241 落地）
        modelSpec: () => options.curatorModel ?? secretaryModel(),
        credentials,
        configuredVision,
        ...(sessionRewriteFor === undefined ? {} : { sessionRewriteFor }),
        // 284 号票：了解你访谈（记忆插件的服务，和每晚整理一样插件在跑才有）；访谈里听到的档案信息出 281 的核对卡
        // （快速动作 personal_file，提在管理员的会话里、总是出卡）；按住说话时回话合成语音（每个会话都配的那一份）
        ...(plugins.service(MEMORY_INTERVIEWS) === undefined ? {} : { interviews: plugins.service(MEMORY_INTERVIEWS)! }),
        proposePersonalFile: (params, call) =>
          quickActions.propose({
            type: PERSONAL_FILE_ACTION,
            params,
            conversation: MEMORY_CURATOR_CONVERSATION,
            ...(call.inputMessageId === undefined ? {} : { inputMessageId: call.inputMessageId }),
            toolCallId: call.toolCallId,
            alwaysAsk: true,
          }),
        sessionTools,
        log,
      });
    const stopCurator = () => {
      const current = memoryCurator;
      memoryCurator = undefined;
      return current?.stop();
    };
    const nightlyNow = plugins.service(MEMORY_NIGHTLY);
    if (nightlyNow === undefined) log("记忆插件没在运行：不起记忆管理员（记忆页也没有那一层）"); // @i18n-ignore log
    else memoryCurator = startCurator(nightlyNow);
    teardown.push(() => void stopCurator());
    // 设置 · 插件里运行中停用、启用（211 号票）：管理员跟着起、停
    teardown.push(
      plugins.onChange(() => {
        const nightly = plugins.service(MEMORY_NIGHTLY);
        if (nightly !== undefined && memoryCurator === undefined) {
          memoryCurator = startCurator(nightly);
          log("记忆插件启用了：拉起记忆管理员"); // @i18n-ignore log
        } else if (nightly === undefined && memoryCurator !== undefined) {
          void stopCurator()?.catch((err: unknown) => log(`停记忆管理员出错：${err instanceof Error ? err.message : String(err)}`)); // @i18n-ignore log
          log("记忆插件停用了：记忆管理员跟着停"); // @i18n-ignore log
        }
      }),
    );

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
    const letters = createSecretaryLetters({ store, clock, media });
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
      // 拉回、催促、验收退回、预算、累计被拒的阈值（14）；预算控制那一项现取设置里的（315 号票：改了下一次核对就按新的）
      thresholds: taskThresholds,
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
      stopTurn: (task, how) => wired("agentHost").stopTaskTurn(task, how),
      ...(options.reworkStopTimeoutMs === undefined ? {} : { reworkStopTimeoutMs: options.reworkStopTimeoutMs }),
      toolkitProblems: (toolkit) => toolkits.nameProblems(toolkit),
      outputsDir: realLayout.outputs,
      acceptance: {
        // 脚本照带类型 bash 工具的启动器起（闸门进程先进这次调用的 Job 对象，28）
        runScript: ({ cwd, script, expectOutput, network, signal }) =>
          runAcceptanceScript(typedShell, { cwd, script, ...(expectOutput ? { expectOutput } : {}), network, timeoutMs: ACCEPTANCE_SCRIPT_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
        review: createReviewer({ agents, guards, model: reviewerModel, credentials, prompts, letters, typedShell, log }),
      },
      subAgentsOn: (taskId) => wired("subAgents").busyStages(taskId),
      // 只涉及一个项目的任务（16）：在项目的工作目录里做，工具包取任务授权和项目工具包的交集，项目的维护者正忙时留在排队中
      projectTasks: projectSystem.projectTasks,
      // 计划变更、自行调整之后维护者的工具包变了：活着的子 agent 按新的交集重新装配（14 接 20）
      toolkitChanged: (taskId) => wired("subAgents").reassemble(taskId),
      // 涉及多个项目的任务（17）：维护者的工具包固定，本阶段的回执全部到齐且都完成才能宣布阶段完成
      multiProject: projectSystem.multiProjectTasks,
      planProjects,
      // 维护者宣布完成、计划变更、自行调整时引用的用户原话（125）：运行时核实过的单独一栏
      userWords,
      // 执行它的维护者用的运行时没启用（286）：执行中的转等我，启用后接着
      runtimeHold: { held: (task) => runtimeGate.held(task.maintainerId)?.reason, off: (task) => runtimeGate.off(task.maintainerId)?.reason },
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
    // 任务完成（全部阶段验收通过）后：节假日数据的更新任务（29）导入交付件；项目的建设任务（15、112）由项目系统接（下面 connect，排在它后面）
    taskExecution.onCompleted((completed) => holidayUpdates.taskCompleted(completed));

    // 范围审视（18）：对照物和近期范围记录交给维护者的子进程（审视在子进程里做），审视的结果存成范围记录、写进项目档案或任务的产出区
    // 125：对照物里的立项书按现在的（用户确认了的立项要求变更改过的，从事件算），用户的话按运行时核实过的格式
    const scopeReviewService = createScopeReview({ store, inbox, projects: projectDirectory, tasks, outputsDir: realLayout.outputs, charterText: (projectId) => projectSystem.charterText(projectId), userWords, now, log });
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
    // agent 宿主（127）：三种维护者（任务自己的、定时作业自己的、项目的）共用的装配和会话，只建这一次；下面三个维护者模块各是它的一种配置，
    // 只给自己的差异。子 agent 要维护者此刻的装配、执行控制器从某个阶段重做前停稳手头这一轮、设置里的 ⚙ 都经它问
    const agentHost = createAgentHost({
      agents,
      store,
      queue: queueDelivery,
      streams,
      guards,
      media,
      tasks,
      execution: taskExecution,
      typedShell,
      sessionTools,
      // 插件给维护者的工具、上下文块、钩子订阅（128）：装配时按哪种维护者、哪种会话、工具包筛
      contributions: agentContributions,
      // 工具包里的 skill、MCP，执行时增减 skill 的工具（27），登记 MCP 的工具（239）
      toolkits: {
        skillPaths: toolkits.skillPaths,
        mcpTools: toolkits.mcpTools,
        skillTool: (scope) => toolkits.skillTool({ kind: "task", scope }),
        mcpChangeTool: (scope) => mcpChanges.requestTool({ kind: "task", taskId: scope.taskId, maintainerId: scope.maintainerId }),
        skillCommands: () => toolkits.skillCommands(),
      },
      letters,
      // 执行时的"提议并行"（20）：子 agent 模块建在宿主之后
      subAgentTools: (scope) => wired("subAgents").toolsFor(scope),
      // 流程（58、64）：交来的计划先审查修补
      workflowReview,
      prompts,
      // 换了语言（168）：维护者交下一条输入之前按新的系统提示重新拉起
      language: languageKey,
      // 改了"我的名字"（249）：同样交下一条输入之前按新的系统提示重新拉起
      userName: () => userName.current(),
      // 系统提示里给维护者讲的阈值（14）、连续失败几次自动暂停（19、76）、工作目录外的说法跟着对话审批的开关（70、75）
      thresholds: taskThresholds,
      runFailureLimit: config.scheduledJobs.jobFailures,
      get conversationApprovals() {
        return safety.current().conversationApprovals;
      },
      scopeReview,
      // Git Bash 里 /tmp 挂到哪（177）：按守护进程自己的 TMP / TEMP（agent 的 bash 进程本身带着的就是这一份），守卫按它解析 /tmp
      bashTmp,
      outputsDir: realLayout.outputs,
      // 维护者的模型（73）：项目、任务的维护者单独配了模型的按它的，不然按它那一行（120）；定时作业自己的维护者算任务维护者（作业来自任务的计划），
      // 照那一行。子 agent、评审、范围审视照各自那一行（上面的 agentModel）
      model: (maintainer, maintainerId, spawn) =>
        options.maintainerModel
          ? options.maintainerModel(maintainerId, spawn)
          : maintainer === "job"
            ? agentModel("task_maintainer")
            : modelSettings.modelFor(maintainer === "project" ? "project_maintainer" : "task_maintainer", maintainerId),
      configuredVision,
      credentials,
      timeZone: config.timeZone,
      sessionRewriteFor,
      // 维护者的运行时（286）：拉起哪个子进程入口、拉不拉得起；有活拉不起来时活动状态"等你"（写明哪个插件没启用）
      runtimes: runtimeGate,
      onRuntimeWait: (agentId, wait) =>
        activity.runtimeWait(agentId, wait === undefined ? undefined : wait.remote ? { kind: "in_remote", runtime: wait.plugin } : wait.returned ? { kind: "handed_back", runtime: wait.plugin } : { kind: "runtime_off", plugin: wait.plugin }),
      // 中途换运行时（289）：换完了改项目、任务上记着的运行时和选的值；写交接摘要最多等单次模型调用的超时
      commitRuntime: (maintainerId, runtime, chosen) => {
        const owned = projectDirectory.ofMaintainer(maintainerId);
        if (owned) projectSystem.handles.projects.setRuntime(owned.project.id, runtime, chosen);
        else {
          const task = tasks.ofMaintainer(maintainerId);
          if (task) tasks.setRuntime(task.id, runtime, chosen, "user");
        }
      },
      handoffTimeoutMs: config.agentLimits.modelCallMs,
      questions: runtimeQuestions,
      log,
    });
    wiring.agentHost = agentHost;
    // 会话回退（150）：秘书的主线会话先用；任务、项目维护者的会话在 152 号票接上（它们的 agentHandle 给了 rollback 就能回退）
    const rollbacks = createSessionRollbacks({ store, cards, hook: options.sessionRollbackHook, log });
    const rollbackSessionOf = (conversation: ConversationId): RollbackSession => {
      const handle =
        conversation === CHANNELS.secretary
          ? secretary.agentHandle()
          : conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)
            ? agentHost.agentHandle(conversation.slice(MAINTAINER_CHANNEL_PREFIX.length))
            : undefined;
      if (!rollbackEnabled(conversation) || !handle?.rollback) throw new RequestRejected("not_allowed", t("daemon.noRollback"));
      return handle.rollback;
    };
    // 维护者（12：任务自己的维护者；13：执行时按计划装配）：会话里来了输入就唤起；秘书先起来，占着它预留的名额
    const maintainers = createMaintainers({
      host: agentHost,
      ...(options.maintainerToolkit ? { toolkit: options.maintainerToolkit } : {}),
      // 项目的维护者（含任务转为项目后原任务的维护者）由项目模块接；作业自己的维护者（jm-<n>，76 号票之前的定时作业迁移成
      // 定时触发的普通任务后照旧由它做）由作业维护者模块接
      excluded: (maintainerId) => projectDirectory.ofMaintainer(maintainerId) !== undefined || isJobMaintainerId(maintainerId),
      // 涉及多个项目的任务（17）：维护者的工具包固定为三样（读项目档案、派工单、汇总回执），加上转问用户
      multiProject: projectSystem.multiProjectMaintainer,
      // 普通任务（75）的 agent：skill 用助理的那一份（每次唤起现取）
      plainSkills: () => secretarySkills.view().skills,
      // 定时触发的任务（76）：触发底座建在维护者模块之后，现取（每次运行一段、"报告这次运行失败"、流程的授权）
      triggers: () => wiring.scheduledJobs,
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
      // 维护者此刻的装配（任务自己的维护者、执行项目的任务的项目维护者，16）：经 agent 宿主问
      maintainerAssembly: (taskId) => agentHost.assemblyOf(taskId),
      projectOf: (taskId) => {
        const task = tasks.get(taskId);
        return task && projectDirectory.projectOf(task)?.id;
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
    /**
     * 用户往维护者的会话里说话时消息的归属：项目的（15）带上项目，任务的（13）带上任务；别的会话不认（收不了的抛出原因）。
     * taskId 是用户在哪个任务的详情里说的（75：项目内部的普通任务做完了接着说，消息属于它）。网关发消息、秘书转达（103）、排队的消息交出去（144）共用
     */
    // 242 号票：记忆管理员的会话不是谁的活（不归属任务、项目）；它没起来时不认（像没有这个维护者一样）
    // 284 号票：了解你访谈开着时，用户在管理员会话里说的话带上访谈编号和管理员问的那一句（素材据此标"来自访谈"、把问的那句放进上下文；
    // 语音对象跟着带）
    const curatorScope = (): MessageScope => plugins.service(MEMORY_INTERVIEWS)?.messageScope() ?? {};
    const userMessageScopeOf = (conversation: ConversationId, taskId?: string) =>
      memoryCurator !== undefined && conversation === MEMORY_CURATOR_CONVERSATION
        ? curatorScope()
        : (projectSystem.conversationScope(conversation, taskId) ?? userMessageScope(tasks, conversation));
    /** 用户、秘书转达往会话里说一句时认的归属（290：交还了的会话不收，先收回；回复中排进队的交出去时照旧认） */
    const sayingScopeOf = (conversation: ConversationId, taskId?: string) => {
      refuseReturned(conversation);
      return userMessageScopeOf(conversation, taskId);
    };
    // 从运行时已有的会话接管（290）：列本机会话（运行时登记的）、二狗自己的写入锁（任务、项目上记着的接管）、接管成任务或项目、
    // 交还和收回（交还了的维护者运行时闸门不拉起；交还等它的子进程退干净）
    const takeoverService = createTakeoverService({
      store,
      runtimes: agentRuntimes,
      tasks,
      projects: () => projectSystem.handles.projects,
      gate: runtimeGate,
      live: (maintainerId) => agents.live().some((a) => a.agentId === maintainerId),
      tools: BUILTIN_TOOL_REGISTRY,
      // 会话原来的工作目录在数据目录、二狗程序目录里的不接（305）
      checkFolder: (folder) => workFolders.check(folder),
      // 交给官方 App（292）：在做一轮的先打断；现在接着的会话看维护者会话目录里运行时记的；在官方 App 里的定时只读跟随
      stopTurn: (maintainerId) => agentHost.agentHandle(maintainerId)?.stopReply() ?? false,
      sessionDir: (maintainerId) => agentSessionDir(layout, maintainerId),
      ...(options.remoteFollowMs === undefined ? {} : { followMs: options.remoteFollowMs }),
      now,
      log,
    });
    teardown.push(takeoverService.startFollowing());
    /** 交还了的会话（290）、交给了官方 App 的（292）：用户在维护者的会话里说话被拒（先收回） */
    const refuseReturned = (conversation: ConversationId) => {
      if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return;
      const refusal = takeoverService.sendRefusal(conversation.slice(MAINTAINER_CHANNEL_PREFIX.length));
      if (refusal !== undefined) throw new RequestRejected("not_allowed", refusal);
    };
    /** 项目维护者手上没有在进行的段时，用户的话开一个对话段（分隔线在这句话之前，16）；在项目内部的普通任务的详情里说的不开（75） */
    const userMessagePreludeOf = (conversation: ConversationId, key: string, taskId?: string) =>
      conversation.startsWith(MAINTAINER_CHANNEL_PREFIX) ? projectSystem.messagePrelude(conversation.slice(MAINTAINER_CHANNEL_PREFIX.length), key, taskId) : [];
    // 项目系统接上建在它之后的内核模块（278）：执行控制器、agent 宿主、执行名额、任务的维护者、子 agent、工具包、MCP 登记变更都建好了。
    // 接着（和原来同一个位置）：项目的建设任务做完了出"首版做完了"卡（任务完成回调）、运营方案跟着项目停用启用（订阅项目事件）、派单器开始
    // （派单器写回最多催几次和执行中的催促同一个阈值，14；工单结束时的范围审视由项目的维护者做，18）
    projectSystem.connect({ execution: taskExecution, agentHost, slots, taskMaintainers: maintainers, subAgents, toolkits, mcpChanges }, teardown);
    // 任务的维护者在派单器接上之后再起：重启时马上要拉起的涉及多个项目的任务的维护者，一起来就可能派工单（17）
    maintainers.start();
    teardown.push(() => maintainers.stop());
    // 定时作业（19）：确认计划后登记，到点时一次运行进队列，真正开始时占一个全局名额（属于项目的派工单给项目维护者，
    // 不属于项目的交给作业自己的维护者）。先接上事件（项目维护者、作业维护者开始接输入时把被打断的运行标成中断，这里要看到），
    // 补跑错过的放在恢复之后
    const scheduledJobs = createScheduledJobs({
      store,
      tasks,
      projects: projectDirectory,
      workOrders: projectSystem.jobWorkOrders,
      inbox,
      scheduler,
      clock,
      now,
      scheduleContext,
      slots,
      failureLimit: config.scheduledJobs.jobFailures,
      maxRunSteps: config.eventSources.maxRunSteps,
      // 155 号票：运行中撤回会话、切换分支被中止的那一轮，这次运行记"已撤回"、不算失败
      navigating: (conversation) => rollbacks.navigating(conversation),
      log,
    });
    wiring.scheduledJobs = scheduledJobs;
    scheduledJobs.attach();
    teardown.push(() => scheduledJobs.stop());
    // 事件触发（77）：事件来源登记表里每个来源一份实现（event-sources/sources.ts）——二狗内部事件、本机文件夹变化（fs.watch，
    // 比对底子在数据目录的 event-sources/）；事件来了交给触发底座（事件触发的任务）或插件登记的订阅方（126）。
    // 不许监视的地方：守卫的受保护区域（同一份 protectedAreasOf：配置区、密钥区、数据库区、程序目录），最后是整个数据目录
    const eventTriggers = createEventTriggers({
      store,
      scheduledJobs,
      subscribers: eventSubscribers,
      sources: eventSourceImplementations({
        store,
        clock,
        stateDir: realLayout.eventSources,
        forbidden: () => [...protectedAreasOf(places), { dir: places.dataDir.root, title: dataDirTitle() }],
        thresholds: config.eventSources,
      }),
      log,
    });
    wiring.eventTriggers = eventTriggers;
    teardown.push(() => eventTriggers.stop());
    // 定时作业自己的维护者（19；76 号票之前的作业）：agent 宿主的一种配置，每次运行的装配由作业模块给
    const jobMaintainers = createJobMaintainers({
      host: agentHost,
      runAssembly: (jobId, maintainerId) => scheduledJobs.runAssembly(jobId, maintainerId),
      currentRun: (jobId) => scheduledJobs.currentRun(jobId),
    });
    jobMaintainers.start();
    teardown.push(() => jobMaintainers.stop());
    // 每周的归档清单（19）：任务模块的内部作业（错过了开机后补一次），选"继续改"时走执行控制器
    registry.register(archiveListCardType({ tasks, execution: () => taskExecution }));
    const archiveList = createArchiveList({ store, tasks, cards, inbox, internalJobs, clock, afterDays: config.tasks.thresholds.archiveAfterDays });
    // 维护者接上之后再开始执行：排着的任务按名额开始，交给维护者的通知由它们接着处理
    taskExecution.start();
    // agent 运行时（286）：运行时能不能用变了、运行时不能用的维护者做完了手头那一轮，执行中的任务转等我或接着执行；
    // 起来时看一遍（配置里停用了运行时插件的）
    teardown.push(runtimeGate.onChange(() => taskExecution.followRuntimes()));
    taskExecution.followRuntimes();

    // 接上（上面的唯一接线点）
    wiring.taskExecution = taskExecution;
    // 认得的工具的登记（280）：工具调用的完整内容清掉之后剩的参数摘要按它打码——工具自己声明了参数要打码的（秘书的 mcp_call、project_ops）。
    // 秘书会话里的那些：内置的、插件给的、内核的、测试加的、登记的 MCP；每清一次现取（插件运行中停用、启用了跟着变）
    wiring.knownTools = (): ToolRegistry => {
      const hostTools = [...agentContributions.toolsFor(SECRETARY_TARGET), ...secretaryTools, ...agentContributions.toolsFor(SECRETARY_TARGET, "end"), ...(options.extraSecretaryTools ?? [])];
      const descriptors = [...Object.values(BUILTIN_TOOL_REGISTRY), ...hostTools.map((tool) => tool.descriptor), ...mcp.descriptors()];
      return Object.fromEntries(descriptors.map((d) => [d.name, d]));
    };
    // 项目系统开始（278；和原来同一个位置）：建出项目的维护者（15：用户在它的会话里说话时唤起，任务转为项目时从任务的维护者模块接过来；
    // 登记进 agent 宿主排在任务的、定时作业的维护者后面），项目对一遍档案、立项要求变更、规范改写、补齐规范（规范上线记一次、给缺文档的现有项目出卡）、
    // 项目的维护者开始接输入
    projectSystem.start(teardown);
    // 被杀后的恢复（23）第 2 步：各模块都接上之后（执行控制器订阅好了，agent 会话标好了中断的输入），
    // 待审批的从审批表恢复（记成挂起，不新建卡、不再提示），被杀时正在执行的有副作用的调用记成中断，被打断的维护者接着做
    recoverAfterRestart({ store, approvals, inbox, tasks, now, log }, restart);
    // 错过的定时触发（规格第 13、17 节）：恢复做完之后，重启前在跑的运行对一遍，停机期间错过的作业只补跑一次；
    // 每周的归档清单登记成内部作业（错过了同样补一次）
    scheduledJobs.start();
    archiveList.start();
    // 事件触发（77）：触发登记、插件都起来之后按现在的订阅开始盯（文件夹先和比对底子比一遍，补发停机期间的变化）
    eventTriggers.start();


    /** 项目在用时运营方案里的一条（141）的那句说明；不是的 undefined */
    const operationsLockOf = (task: Task | undefined) => (task?.internal ? operationsItemLock(task, projectDirectory.get(task.internal.projectId)) : undefined);
    /**
     * 项目在用时运营方案里的一条（141）：用户只能暂停、恢复，取消、归档、删除（186）拒绝并写明原因（任务页、多选、项目页的作业行都经这里）。
     * 运营方案变更确认后去掉的那条由变更流程取消（运营手段的 revoke），不经这里
     */
    const rejectIfOperationsItem = (taskId: string | undefined) => {
      const locked = operationsLockOf(taskId === undefined ? undefined : tasks.get(taskId));
      if (locked) throw new RequestRejected("not_allowed", locked);
    };

    /**
     * 删除任务（186）：先停（没结束的照下面 taskAction 的取消走；维护者停稳这一轮、停掉；子 agent 停下），再在一个事务里删任务、
     * 维护者会话和属于它的记录，最后删会话文件和工作目录
     */
    const taskDeletion = createTaskDeletion({
      store,
      participants: deletionParticipants,
      // 任务自己的维护者（tm-N）、迁移来的定时任务的作业维护者（jm-N）：两个模块各管各的，停、恢复都交给两边
      maintainers: {
        suspend: async (maintainerId) => {
          await Promise.all([maintainers.suspend(maintainerId), jobMaintainers.suspend(maintainerId)]);
        },
        resume: (maintainerId) => {
          maintainers.resume(maintainerId);
          jobMaintainers.resume(maintainerId);
        },
      },
      subAgents: () => subAgents,
      // 在跑的验收（宣布完成时的、交给评审的、重做后复验）：验收脚本、评审子 agent 在任务的工作目录里，先停下才删得掉
      stopAcceptance: (taskId) => taskExecution.stopAcceptance(taskId),
      projectOf: (maintainerId) => projectDirectory.maintainedBy(maintainerId),
      operationsLock: operationsLockOf,
      cancel: (taskId, idempotencyKey) => taskAction({ taskId, action: "cancel" }, idempotencyKey),
      sessionDir: (agentId) => agentSessionDir(layout, agentId),
      taskDir: (taskId) => path.join(realLayout.outputs, taskId),
      now,
      log,
    });
    wiring.taskDeletion = taskDeletion;

    /**
     * 维护者工具包里的 skill 交给运行时之后的斜杠命令（291）：和装配时一样现取工具包里的 skill 目录（同样的先后），运行时给出它那边的命令名
     * （Claude Code：/ergo:<目录名>），显示的名字、说明照 skill 库。运行时不管 skill 的（pi）是空的
     */
    const runtimeSkillCommands = (runtime: string, maintainerId: string): Array<{ command: string; name: string; description: string }> => {
      const named = agentRuntimes.get(runtime)?.toolkitSkillCommands;
      if (!named) return [];
      const dirs = toolkits.skillPaths(projectSystem.skillsOf(maintainerId) ?? maintainers.skillsOf(maintainerId) ?? []);
      const commands = named(dirs);
      const library = new Map(toolkits.skillCommands().map((s) => [s.dir, s]));
      return dirs.flatMap((dir, i) => {
        const command = commands[i];
        if (command === undefined) return [];
        const skill = library.get(dir);
        return [{ command, name: skill?.name ?? path.basename(dir), description: skill?.description ?? "" }];
      });
    };

    /**
     * 斜杠命令的说明换成用户的语言（310）：表里没有的英文说明用二狗的模型（跟随秘书那一行）在一次性子进程里翻，只交原文；
     * 缓存在缓存区；用量记成二狗的系统开销（purpose: translation）。模型没配 key 时不翻（显示原文）
     */
    const slashTranslationModel = (): ModelSpec | undefined => (options.slashTranslationModel === null ? undefined : (options.slashTranslationModel ?? secretaryModel()));
    const slashTranslations = createSlashTranslations({
      file: layout.slashTranslationsFile,
      available: () => {
        const model = slashTranslationModel();
        return model !== undefined && (model.kind !== "catalog" || credentials[model.provider] !== undefined);
      },
      translate: async (texts, languageName) => {
        const model = slashTranslationModel();
        if (!model) return texts.map(() => null);
        const request: TranslationRequest = { model, credentials, language: languageName, texts: [...texts] };
        const result = await agents.runOneShot<TranslationResult>(SLASH_TRANSLATE_ENTRY, request, t("runtime.translation.label"), TRANSLATION_TIMEOUT_MS);
        for (const report of result.usage) ledger.record({ agentId: SECRETARY_AGENT_ID, sessionId: SLASH_TRANSLATION_SESSION, model: modelConfigKey(model), attribution: { owner: null, role: "secretary" }, report });
        for (const error of result.errors) log(`斜杠命令的一条说明没翻成：${error}`);
        return result.texts;
      },
      now: () => Date.now(),
      log,
    });

    /** 没结束的任务点"归档"（186）：先照取消那条路取消（运营中的定时任务落到触发上），取消成了再归档；取消不了的抛出，不归档 */
    const cancelThenArchive = async (taskId: string, idempotencyKey: string): Promise<TaskActionResult> => {
      await taskAction({ taskId, action: "cancel" }, `${idempotencyKey}#cancel`);
      return taskExecution.act({ taskId, action: "archive" }, idempotencyKey);
    };

    /**
     * 用户对一个任务的控制（task_action）：定时触发的任务（76）运营中时的暂停、恢复、取消落到它的触发上（取消时任务随之取消）；
     * 没结束的归档先取消（186）；删除交给删除任务的模块（186）
     */
    const taskAction = (params: TaskActionParams, idempotencyKey: string): TaskActionResult | Promise<TaskActionResult> => {
      if (params.action === "cancel" || params.action === "archive" || params.action === "delete") rejectIfOperationsItem(params.taskId);
      if (params.action === "delete") return taskDeletion.delete(params.taskId, idempotencyKey);
      const task = tasks.get(params.taskId);
      if (params.action === "archive" && task && archiveCancelsFirst(task)) return cancelThenArchive(task.id, idempotencyKey);
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
      // 订阅项目列表频道时补推项目的服务现在的样子（133：临时事件不补发）；订阅语言频道时补推实际在用的语言和词典的版本（168）；
      // 订阅插件频道时补推插件的状况（193）；订阅工作日历频道时补推外部日历现在的版本（306）
      snapshot: (channel) =>
        channel === CHANNELS.projects
          ? [projectSystem.servicesFrame()]
          : channel === CHANNELS.language
            ? [language.snapshot()]
            : channel === CHANNELS.plugins
              ? [pluginStatusFrame()]
              : channel === CHANNELS.workdayCalendar
                ? [externalCalendarFrame()]
                : [],
      requests: {
        cardAction: (params, idempotencyKey) => cards.act({ ...params, idempotencyKey }),
        inboxAction: (params, idempotencyKey) => inbox.act({ ...params, idempotencyKey }),
        revokeDevice: (params, idempotencyKey) => pairing.revoke(params.deviceId, idempotencyKey),
        // 设置里多选的延期、吊销、删除（123）：能做的都做、逐台回报
        deviceBatchAction: (params, idempotencyKey) => pairing.batch(params, idempotencyKey),
        startTask: (params, idempotencyKey) => ({ taskId: tasks.startFromButton(params, idempotencyKey).id }),
        updateWatchCategories: (params, idempotencyKey) => watchCategories.update(params, idempotencyKey),
        // 定时触发的任务（76）运营中时的暂停、恢复、取消落到它的触发上（取消时任务随之取消）
        taskAction,
        // 看板多选（90）：一个一个交给上面那条路，各自成败、逐条回报
        taskBatchAction: createTaskBatch({ act: taskAction, log }),
        scheduledJobAction: (params, idempotencyKey) => {
          // 项目页作业行上的取消：运营方案里的一条不行（141）
          if (params.action === "cancel") rejectIfOperationsItem(scheduledJobs.get(params.jobId)?.ownerTaskId);
          return scheduledJobs.act(params, idempotencyKey);
        },
        // 任务操作菜单里的"改时间"（98）：只换定时触发的任务的时间表，任务、会话、运行记录不变
        rescheduleJob: (params, idempotencyKey) => scheduledJobs.reschedule(params, idempotencyKey),
        // 任务操作菜单里的"立即运行一次"（100）：触发记成手动，不改时间表；上一次还没跑完的拒绝
        runJobNow: (params, idempotencyKey) => scheduledJobs.runNow(params, idempotencyKey),
        // 任务操作菜单里的"跑完自动播报：开 / 关"（100）：开着的做完秘书直接念成语音，不问
        setVoiceAnnounce: (params, idempotencyKey) => tasks.setVoiceAnnounce(params, idempotencyKey),
        // 秘书页上看到哪一条了（109）：只往后挪，几台设备同步
        markRead: (params, idempotencyKey) => readMarks.markRead(params, idempotencyKey),
        // 设置里的关于二狗、Debug 工具集（124）：版本、起来的时间、此刻的时间（守护进程的钟）
        daemonInfo: () => ({ version: DAEMON_VERSION, startedAt, now: now() }),
        // 会话回退（150）：缩小视图里点 ↶、确认之后回到某条之前（秘书先用，152 号票接上任务、项目维护者）
        rollbackSession: (params, idempotencyKey) => rollbacks.rollback(params.conversation, params.before, rollbackSessionOf(params.conversation), idempotencyKey),
        // 切换分支（151）：展开的 ⑂ 预览上点"切换到这条分支"（同回退：秘书先用，152 号票接上任务、项目维护者）
        switchBranch: (params, idempotencyKey) => rollbacks.switchBranch(params.conversation, params.branchId, rollbackSessionOf(params.conversation), idempotencyKey),
        // 废弃分支详情里的「申请撤回」（151）：记一笔、调撤销接口
        requestEffectUndo: (params) => rollbacks.requestEffectUndo(params.conversation, params.branchId, params.callId, rollbackSessionOf(params.conversation)),
        // 输入框旁的"停止"（144）：秘书、任务自己的维护者、项目维护者各自停自己的这一轮
        stopReply: (params) => {
          const handle =
            params.conversation === CHANNELS.secretary
              ? secretary.agentHandle()
              : params.conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)
                ? agentHost.agentHandle(params.conversation.slice(MAINTAINER_CHANNEL_PREFIX.length))
                : undefined;
          return { stopped: handle?.stopReply() ?? false };
        },
        // 用户往维护者的会话里说话：归属和要先追加的事件（秘书转达也走这两个，103）
        messageScope: sayingScopeOf,
        messagePrelude: userMessagePreludeOf,
        // 新建项目、任务转为项目、项目页上的动作、重置维护者、项目卡片和项目页上的"启动""关闭"（257）：项目系统给
        ...projectSystem.requests,
        // 发消息时收下语音 part、气泡菜单里的"重新识别"（31）：214 号票起由语音插件在数据契约里登记（下面 plugins.requests()）
        setToolkit: (params, idempotencyKey) => toolkits.set(params, idempotencyKey),
        // 插件的数据契约登记的（126）：插件没启用时回"X插件没启用"
        ...plugins.requests(),
      },
      webRoot: options.webRoot ?? DEFAULT_WEB_ROOT,
      // 插件（126）：在运行的、配置里停用的、没装上的和原因；启用着的插件没装上算降级（status: degraded，照旧 200）
      health: () => {
        const s = secretary.health();
        return { ok: s.ok, degraded: pluginProblems(), details: { secretary: s.status, plugins: plugins.report() }, reasons: s.reason === undefined ? [] : [s.reason] };
      },
      api: createHttpApi({
        media,
        store,
        // 浏览插件给的（212，现取，插件没启用时回"内置浏览器插件没启用"）：悬浮按钮上说的一段送识别（149：认出的字作为消息发进秘书的主会话）、
        // 要交的文件的取件码（134）、候选的缩略图（149）、"浏览"的 ⋮ 菜单里"存进二狗的素材"（165）
        browsing: () => plugins.service(BROWSING),
        // 授权的文件夹（内核的）；设置页选文件夹的框列子文件夹（138：常用位置按守卫看到的用户目录，测试里列盘换成假的）
        localFolders,
        folderBrowser: createFolderBrowser({ homeDir: () => places.homeDir, ...(options.folderDrives ? { drives: options.folderDrives } : {}) }),
        materialDeletion,
        materialBrowser,
        // 网页"记忆"页的概览、结论、证据、问题箱（233）：推理库的只读视图
        memoryGraph,
        // 记忆的设置（264）：GET / PUT /api/memory/settings，秘书顺口问开不开
        memorySettings,
        // 了解你访谈（284）：GET / POST /api/memory/interview（记忆插件的服务，现取；没启用时回"记忆插件没启用"）
        memoryInterviews: () => plugins.service(MEMORY_INTERVIEWS),
        workdayCalendar,
        assistantName,
        // 我的名字（249）：GET / PUT /api/user-name，不走事件
        userName,
        // 个人档案（281）：档案页的列表、一份、加人、改、删
        personalFiles,
        // 设置 · 语言、网页的词典、换语言（168）
        language,
        // 主导航的日历（35）：213 起是日历插件的服务，现取；日历插件没启用时回"日历插件没启用"
        calendar: { month: (month) => plugins.active(CALENDAR).month(month) },
        ledger,
        // 设置 · 语音（参考音色、两个模型的状态）、分段合成的段、Debug 工具集的语音组（214 号票起经语音插件的服务现取）
        voice: () => plugins.service(VOICE),
        toolkits,
        secretarySkills,
        // 输入框里打 / 弹出的候选（82）：这个会话能用的二狗的命令和 skill，和装配时一样现取
        // 310：带参数提示；不是用户语言的说明换成用户语言的（运行时自带的说明表、二狗的模型翻的缓存）；记忆管理员的会话也有命令
        slashCommands: (conversation) => {
          const list = conversationSlashCommands(
            {
              table: () => toolkits.skillCommands(),
              secretarySkills: () => secretarySkills.view().skills,
              projectSkills: (maintainerId) => projectSystem.skillsOf(maintainerId),
              taskSkills: (maintainerId) => maintainers.skillsOf(maintainerId),
              // 维护者用的运行时转交斜杠命令的（289）：候选是它报的命令；工具包里的 skill 按运行时里的写法（291：Claude Code 是 /ergo:<目录名>）
              runtimeCommands: (maintainerId) => {
                const runtime = runtimeGate.runtimeOf(maintainerId);
                if (!runtimeGate.supports(runtime, "slash_passthrough")) return undefined;
                const commandText = agentRuntimes.get(runtime)?.commandText;
                return {
                  title: runtimeGate.title(runtime),
                  commands: agentRuntimes.commandsOf(runtime, maintainerId) ?? [],
                  skills: runtimeSkillCommands(runtime, maintainerId),
                  ...(commandText ? { builtin: commandText } : {}),
                };
              },
              // 310：记忆管理员在运行时它的会话有 /interview（记忆插件给了访谈服务时）、/consolidate
              curator: () => (memoryCurator === undefined ? undefined : { interview: plugins.service(MEMORY_INTERVIEWS) !== undefined }),
            },
            conversation,
          );
          return list && slashTranslations.localize(list);
        },
        toolCallStorage: toolCallRetention,
        // 设置里的"备份"（335）：现在的状况、"立即备份"
        backup,
        // 设置里的系统提示（71）：看、改、恢复默认
        systemPrompts: prompts,
        modelSettings,
        // 设置里 agent 的联网搜索、读网页（154）
        webSettings,
        // 安全和预算的两个开关（315）：设置 · 关注类别、设置向导（319）用
        safetySettings: safety,
        // 首次设置向导（319）：五步哪几步做完了（GET /api/setup），标"以后再说"/"看过了"（POST /api/setup）
        setup,
        // 体检（319b）：八项检查现在的样子（GET /api/doctor）
        doctor,
        // 设置 · 插件（211）：列出、运行中停用、启用、移除
        plugins: pluginSettings,
        // agent 运行时（286）：登记了的运行时连同能力清单、能不能用（网页接通，289 号票起有界面）
        runtimes: agentRuntimes,
        // 从运行时已有的会话接管（290）：列本机会话、接管成任务或项目
        takeover: takeoverService,
        // 新建时的默认工作文件夹（305）
        workFolders,
        // 设置 · 数据源和导入文件夹（295）
        dataSources,
        // 设置 · 组件（323）：装、删、更新、暂停、继续、取消、离线导入
        components,
        // 长程任务的阶段详情（84）：授权已用几次、从这里重做的范围、已经做了的事
        taskStage: (taskId, stageId) => taskExecution.stageView(taskId, stageId),
        // 回退前的确认（150）：这一段已经做了的事
        rollbackPreview: (conversation, before) => {
          if (!isConversationChannel(conversation)) throw new RequestRejected("bad_params", t("daemon.notConversation", { conversation }));
          return rollbacks.preview(conversation, before, rollbackSessionOf(conversation));
        },
        // 一条分支的样子（151）：废弃分支的预览、详情，切换之后别的设备补取
        branchView: (conversation, branchId, against) => {
          if (!isConversationChannel(conversation)) throw new RequestRejected("bad_params", t("daemon.notConversation", { conversation }));
          return rollbacks.branchView(conversation, branchId, against, rollbackSessionOf(conversation));
        },
        // 每个 agent 的会话里的 ⚙（114）：秘书、任务自己的维护者、项目维护者各自认自己的
        agentSettings: createAgentSettings({
          // ⚙ 面板里"实际生效的"系统提示和拉起时一样：前缀 + 角色的 + 不是中文时末尾那句（168）
          prompts: { ...prompts, withPrefix: effectiveSystemPrompt },
          ledger,
          agents,
          // 项目、任务的维护者单独配模型（120）
          models: modelSettings,
          // 角色（248 号票）：配置区里的 agent-roles.json；没指定角色就跟默认角色（名字是全局的名字、音色是全局选中的参考音色）
          roles: agentRoles,
          // 秘书跟默认时用全局的名字（43）；维护者的默认名字是角色称呼
          assistantName: () => assistantName.current(),
          // 能配的有哪些：秘书、每个在的项目维护者、每个在的任务维护者，以及记忆管理员（242 起在跑就有）；
          // 以后按 agent id 自动有的也不写死在这里：认不得的（删了的任务、项目的维护者）跳过
          candidates: () => [
            CHANNELS.secretary,
            ...projectDirectory.list().map((project) => project.maintainerId),
            ...tasks.list().map((task) => task.maintainerId),
            ...(memoryCurator === undefined ? [] : [MEMORY_CURATOR_AGENT_ID]),
          ],
          // 语音插件没启用：音色改不了（名字照常）
          voiceUnavailable: () => (plugins.service(VOICE) === undefined ? voiceOffReason() : undefined),
          // 项目、任务的维护者用哪个运行时、给它选的值（289）：按登记表核对
          runtimes: agentRuntimes,
          // 接管来的会话交还、收回（290）
          takeover: takeoverService,
          // 241 号票：名字和音色按 agent id 现取；242 号票：记忆管理员也有自己的 ⚙（提示词、清空、上下文用量；模型那行先跟随秘书的）
          resolve: (agentId) =>
            agentId === SECRETARY_AGENT_ID
              ? secretary.agentHandle()
              : memoryCurator !== undefined && agentId === MEMORY_CURATOR_AGENT_ID
                ? memoryCurator.agentHandle()
                : agentHost.agentHandle(agentId),
        }),
        // 项目的服务首页的缩略图（140）：取图顺带算"有人在看"，旧了的补截
        serviceThumbnail: (projectId, name) => projectSystem.serviceThumbnail(projectId, name),
        // 项目规范的只读视图（258）
        projectStandard: (projectId) => projectSystem.projectStandard(projectId),
        log,
      }),
      attachments: media,
      // 转发本机服务的页面（132）：登记过的才转，鉴权和二狗自己的页面一样
      apps: createAppProxy({ registry: apps, log }),
      // 浏览侧边栏（147）：连接报的浏览器、回的结果（212 号票起交给浏览插件，现取；没启用时回"内置浏览器插件没启用"）
      browsers: () => plugins.service(BROWSING)?.links,
      log,
    });
    teardown.push(() => gateway.close());
    // 体检（319b）里的端口那项：换成网关实际监听的（生产里就是配置里的那两个；测试里是系统挑的）
    boundPorts = { local: gateway.port, external: gateway.externalPort };
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
    // 守卫眼里二狗自己的端口（139）换成实际监听的（测试里是系统随机挑的）：判定时都从这一份 places 现取
    places.ownPorts = [gateway.port, gateway.externalPort];
    const lsm = linkToLsm({
      env: options.env,
      port: gateway.port,
      version: DAEMON_VERSION,
      busy: lsmBusy,
      // 秘书不在运行、启用着的插件没装上（126）都报 degraded：LSM 上亮黄灯
      health: () => (secretary.health().ok && pluginProblems().length === 0 ? "ok" : "degraded"),
      onShutdown: () => (options.onLsmStop ?? stopDaemon)(),
      onConflict: (reason) => (options.onLsmConflict ? options.onLsmConflict(reason) : void stopDaemon()),
      log,
    });
    lsmEnabled = lsm.enabled;
    // 项目的服务（133）：接入层建好了，开始做（上线了的先登记转发、没做完的接着做、接 LSM 推来的状态）；之后按网关实际监听的端口
    projectSystem.startServices({ lsm: lsm.services, ports: { local: gateway.port, external: gateway.externalPort } });
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
      plugins,
      pluginSettings,
      boardKinds,
      workdayCalendar,
      assistantName,
      userName,
      personalFiles,
      locales,
      language,
      modelSettings,
      webSettings,
      safetySettings: safety,
      setup,
      holidayUpdates,
      materials,
      memoryHost,
      dataSources,
      components,
      pairing,
      approvals,
      tasks,
      projects: projectSystem.handles.projects,
      charterChanges: projectSystem.handles.charterChanges,
      standardChanges: projectSystem.handles.standardChanges,
      operations: projectSystem.handles.operations,
      operationMeans: projectSystem.handles.operationMeans,
      projectServices: projectSystem.handles.projectServices,
      projectOps: projectSystem.handles.projectOps,
      taskExecution,
      subAgents,
      ledger,
      workOrders: projectSystem.handles.workOrders,
      scheduledJobs,
      eventTriggers,
      archiveList,
      guards,
      quickActions,
      watchCategories,
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
      apps,
      stop: stopDaemon,
    };
  } catch (err) {
    await shutdown();
    throw err;
  }
}

/** 插件清单加上测试给的插件：和清单里同名的换掉清单里那个（位置不变），别的接在后面 */
function withExtraPlugins(manifest: readonly PluginDefinition[], extra: readonly PluginDefinition[]): PluginDefinition[] {
  const replacing = new Map(extra.map((plugin) => [plugin.name, plugin]));
  return [...manifest.map((plugin) => replacing.get(plugin.name) ?? plugin), ...extra.filter((plugin) => !manifest.some((m) => m.name === plugin.name))];
}
