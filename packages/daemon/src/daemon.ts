// 守护进程的组装：读配置、找到数据目录、打开事件存储、建 Job 对象、立起 agent 管家和秘书、
// 开本机端口和外网端口（设备配对在 10 号票）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "@ergou/protocol";
import { createAgentManager, type AgentManager } from "./agent-manager/agent-manager.ts";
import type { HostTool } from "./agent-manager/host-tools.ts";
import { approvalCardType, type ApprovalService, createApprovalService } from "./approvals/approvals.ts";
import { approvalDecisionPurge, approvalDecisionSource } from "./approvals/material-source.ts";
import { approvalsView } from "./approvals/views.ts";
import { type BackupService, createBackupService } from "./backup/backup.ts";
import type { SnapshotFiles } from "./backup/files.ts";
import { cardPurge, type CardService, createCardService } from "./cards/cards.ts";
import { type CardTypeDefinition, CardTypeRegistry } from "./cards/registry.ts";
import { cardsView } from "./cards/views.ts";
import { loadConfig, modelVision, type ErgouConfig } from "./config/config.ts";
import { dataDirLayout, type DataDirLayout } from "./config/data-dir.ts";
import { modelCredentials } from "./config/secrets.ts";
import { messagePurge } from "./conversation/purge.ts";
import { createStreamHub } from "./conversation/stream-hub.ts";
import { conversationViews } from "./conversation/views.ts";
import { createEphemeralBus } from "./events/ephemeral.ts";
import { type EventStore, openEventStore } from "./events/event-store.ts";
import { startGateway } from "./gateway/gateway.ts";
import { createHttpApi } from "./gateway/http-api.ts";
import { type GuardPlaces, loadWatchCategorySettings } from "./guard/index.ts";
import { effectLogView, effectRecordPurge } from "./guard-runtime/effect-log.ts";
import { createGuardRuntime, type GuardRuntime } from "./guard-runtime/guard-runtime.ts";
import { createHandOverService } from "./hand-over/hand-over.ts";
import { createInboxService, type InboxService } from "./inbox/inbox.ts";
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
import { createPairingService, type PairingService } from "./pairing/pairing.ts";
import { pairingView } from "./pairing/views.ts";
import { reminderCardType } from "./reminders/card.ts";
import { createReminderService, type ReminderService } from "./reminders/reminders.ts";
import { reminderTools } from "./reminders/tools.ts";
import { remindersView } from "./reminders/views.ts";
import { createJobObject, type JobObject } from "./process/job-object.ts";
import {
  createQuickActionService,
  operationRecordPurge,
  proposeQuickActionTool,
  quickActionCardType,
  type QuickActionExecutor,
  QuickActionRegistry,
  type QuickActionService,
} from "./quick-actions/index.ts";
import type { ModelSpec } from "./runtime/index.ts";
import { type Clock, clockIso, systemClock } from "./scheduler/clock.ts";
import { createInternalJobs, type InternalJobs, internalJobsView } from "./scheduler/internal-jobs.ts";
import { createScheduler, type Scheduler } from "./scheduler/scheduler.ts";
import { type Secretary, startSecretary } from "./secretary/secretary.ts";
import { realPathOf } from "./util/real-path.ts";

/** 秘书的模型：DeepSeek V4.1 Flash，显式设置思考档位（规格第 1、7 节） */
export const SECRETARY_MODEL: ModelSpec = { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" };

/** Web UI 的构建产物（npm run build:web 生成 packages/web/dist/index.html） */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));

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
}

export interface Daemon {
  readonly config: ErgouConfig;
  readonly layout: DataDirLayout;
  readonly store: EventStore;
  readonly cards: CardService;
  readonly inbox: InboxService;
  readonly reminders: ReminderService;
  /** 素材：采集、原文副本、关键词和向量检索（memory.db 只有它写） */
  readonly materials: Materials;
  /** 设备配对：配对请求、凭证、已配对设备 */
  readonly pairing: PairingService;
  /** 审批表和审批卡 */
  readonly approvals: ApprovalService;
  /** 守卫接入：agent 的工具调用经它判定 */
  readonly guards: GuardRuntime;
  /** 快速动作：执行器注册表、提议和执行（21 号票） */
  readonly quickActions: QuickActionService;
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
  /** 停止：关端口、停秘书、关闭 Job 对象（还活着的子进程和孙进程全部结束）、关库 */
  stop(): Promise<void>;
}

export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const config = loadConfig({ env: options.env, homeDir: options.homeDir });
  const layout = dataDirLayout(config.dataDir);
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
      views: [...conversationViews, cardsView, inboxView, remindersView, pairingView, internalJobsView, approvalsView, effectLogView],
      now,
      log,
    });
    teardown.push(() => store.close());
    const scheduler = createScheduler({ clock, log });
    teardown.push(() => scheduler.stop());
    const notifications = createEphemeralBus();

    // 卡片类型注册表：各票往这里登记自己的卡（06：简单提醒卡；10：配对请求卡）
    const registry = new CardTypeRegistry();
    const cards = createCardService({ store, registry, now });
    const inbox = createInboxService({ store, notifications, now, log });
    const reminders = createReminderService({ store, cards, inbox, scheduler, clock });
    registry.register(reminderCardType(reminders));
    const pairing = createPairingService({ store, cards, inbox, scheduler, clock });
    registry.register(pairingCardType(pairing));
    const approvals = createApprovalService({ store, cards, inbox, now });
    registry.register(approvalCardType(approvals));
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
    materials.start();
    teardown.push(() => materials.stop());
    // 待批的配对请求到点过期（守护进程重启后照常）
    pairing.start();
    teardown.push(() => pairing.stop());
    // 内部作业：每晚备份、每周校验、每天清理临时区（错过的马上补一次）。
    // 停的时候先停内部作业（中止正在跑的、等它停下），再停备份（中止手动的那些）
    const internalJobs = createInternalJobs({ store, scheduler, clock, log });
    const backup = createBackupService({ layout, config: config.backup, inbox, clock, internalJobs, log, ...(options.backupFiles ? { files: options.backupFiles } : {}) });
    teardown.push(() => backup.stop());
    teardown.push(() => internalJobs.stop());
    backup.start();
    const streams = createStreamHub({ lastSeq: (channel) => store.lastSeq(channel) });
    teardown.push(() => streams.close());
    const media = openMediaStore({ mediaDir: layout.media, uploadsDir: layout.uploads, maxUploadBytes: config.media.maxUploadBytes });
    const job = process.platform === "win32" ? createJobObject() : undefined;
    const agents = createAgentManager({ layout, parentEnv: options.env, job, log });
    // 先关 Job：子进程连同它们起的孙进程一起结束；再等子进程的句柄收尾
    teardown.push(async () => {
      job?.close();
      await agents.shutdown();
    });

    // 守卫：各区用真实路径（展开符号链接、目录联接和 8.3 短名），agent 的工作目录也用真实路径，路径比较才对得上
    const realLayout = dataDirLayout(real(layout.root));
    const places: GuardPlaces = {
      dataDir: { root: realLayout.root, config: realLayout.config, secrets: realLayout.secrets, db: realLayout.db, projects: realLayout.projects },
      programDir: real(options.programDir ?? DEFAULT_PROGRAM_DIR),
      // agent 的 bash 里 `~` 是 HOME（Git Bash 没有 HOME 时取 USERPROFILE）
      homeDir: real(options.env.HOME ?? options.env.USERPROFILE ?? options.homeDir),
    };
    const handOvers = createHandOverService({ store, inbox });
    teardown.push(() => handOvers.stop());
    const guards = createGuardRuntime({ store, approvals, handOvers, clock, places, layout, approvalWaitMs: config.approvalWaitMs, log });
    teardown.push(() => guards.stop());

    // 彻底删除的改写函数表（21）：拥有一类事件的模块写它的改写函数；以后接入新的素材来源也要在这里登记
    const purgeRewriters = new PurgeRewriters();
    purgeRewriters.register(messagePurge, cardPurge(cards), ...cardSignalPurge, rememberCommandPurge, approvalDecisionPurge, effectRecordPurge, operationRecordPurge);
    const deletionDeps = { store, cards, rewriters: purgeRewriters, now };
    // 快速动作：执行器按动作类型登记（21：记忆命令；22 号票的任务控制、27 号票的 MCP 调用照这个加）。
    // 处置由守卫的判定函数定（动作作为伪工具调用 quick_action:<类型>，用户的自定义类别也适用）
    const quickActionRegistry = new QuickActionRegistry();
    for (const executor of memoryCommandExecutors({ ...deletionDeps, materials })) quickActionRegistry.register(executor);
    for (const executor of options.extraQuickActions ?? []) quickActionRegistry.register(executor, { replace: true });
    const quickActions = createQuickActionService({
      store,
      cards,
      inbox,
      registry: quickActionRegistry,
      guard: { places, scratchDir: realLayout.scratch, settings: () => loadWatchCategorySettings(layout), now: () => clock.now() },
      log,
    });
    registry.register(quickActionCardType(quickActions));
    registry.register(memoryDeleteCardType(quickActions));
    for (const definition of options.extraCardTypes ?? []) registry.register(definition, { replace: true });
    // 设置里按会话、按时间段删除素材（21）；彻底删除之后没人引用的媒体文件删掉
    const materialDeletion = createBulkMaterialDeletion({ ...deletionDeps, materials });
    teardown.push(startPurgedMediaCleanup({ store, media, materials, log }));

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
    const secretary = startSecretary({
      agents,
      store,
      streams,
      model: secretaryModel,
      credentials,
      // 秘书的工具：建、改、取消提醒（06），素材检索和提议快速动作（21）
      tools: [...reminderTools(reminders, clock), searchMaterialsTool(materials), proposeQuickActionTool(quickActions, CHANNELS.secretary), ...(options.extraSecretaryTools ?? [])],
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

    const gateway = await startGateway({
      port: options.localPort ?? config.ports.local,
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
      },
      webRoot: options.webRoot ?? DEFAULT_WEB_ROOT,
      health: () => {
        const s = secretary.health();
        return { ok: s.ok, details: { secretary: s.status }, reasons: s.reason === undefined ? [] : [s.reason] };
      },
      api: createHttpApi({ media, store, materialDeletion, log }),
      attachments: media,
      log,
    });
    teardown.push(() => gateway.close());

    let stopping: Promise<void> | undefined;
    return {
      config,
      layout,
      store,
      cards,
      inbox,
      reminders,
      materials,
      pairing,
      approvals,
      guards,
      quickActions,
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
      stop() {
        stopping ??= shutdown();
        return stopping;
      },
    };
  } catch (err) {
    await shutdown();
    throw err;
  }
}
