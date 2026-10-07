// 守护进程的组装：读配置、找到数据目录、打开事件存储、建 Job 对象、立起 agent 管家和秘书、开本机端口。
// 外网端口在 10 号票。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentManager, type AgentManager } from "./agent-manager/agent-manager.ts";
import { type CardService, createCardService } from "./cards/cards.ts";
import { type CardTypeDefinition, CardTypeRegistry } from "./cards/registry.ts";
import { cardsView } from "./cards/views.ts";
import { loadConfig, type ErgouConfig } from "./config/config.ts";
import { dataDirLayout, type DataDirLayout } from "./config/data-dir.ts";
import { modelCredentials } from "./config/secrets.ts";
import { createStreamHub } from "./conversation/stream-hub.ts";
import { conversationViews } from "./conversation/views.ts";
import { createEphemeralBus } from "./events/ephemeral.ts";
import { type EventStore, openEventStore } from "./events/event-store.ts";
import { startGateway } from "./gateway/gateway.ts";
import { createInboxService, type InboxService } from "./inbox/inbox.ts";
import { inboxView } from "./inbox/views.ts";
import { reminderCardType } from "./reminders/card.ts";
import { createReminderService, type ReminderService } from "./reminders/reminders.ts";
import { reminderTools } from "./reminders/tools.ts";
import { remindersView } from "./reminders/views.ts";
import { createJobObject, type JobObject } from "./process/job-object.ts";
import type { ModelSpec } from "./runtime/index.ts";
import { type Clock, clockIso, systemClock } from "./scheduler/clock.ts";
import { createScheduler, type Scheduler } from "./scheduler/scheduler.ts";
import { type Secretary, startSecretary } from "./secretary/secretary.ts";

/** 秘书的模型：DeepSeek V4.1 Flash，显式设置思考档位（规格第 1、7 节） */
export const SECRETARY_MODEL: ModelSpec = { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" };

/** Web UI 的构建产物（npm run build:web 生成 packages/web/dist/index.html） */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));

export interface StartDaemonOptions {
  /** 守护进程自己的环境（通常是 process.env） */
  env: Readonly<Record<string, string | undefined>>;
  /** 用户主目录（通常是 os.homedir()），用来算默认的数据目录 */
  homeDir: string;
  /** 本机端口；不填用配置里的 ports.local。测试传 0，由系统挑一个空闲端口 */
  localPort?: number;
  /** Web UI 构建产物所在的目录；不填用 packages/web/dist */
  webRoot?: string;
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
}

export interface Daemon {
  readonly config: ErgouConfig;
  readonly layout: DataDirLayout;
  readonly store: EventStore;
  readonly cards: CardService;
  readonly inbox: InboxService;
  readonly reminders: ReminderService;
  readonly scheduler: Scheduler;
  readonly agents: AgentManager;
  readonly secretary: Secretary;
  /** 二狗自建的 Job 对象（只在 Windows 上有） */
  readonly job: JobObject | undefined;
  /** 本机端口的地址，如 http://127.0.0.1:8810 */
  readonly localUrl: string;
  /** 本机端口实际监听的端口 */
  readonly localPort: number;
  /** 停止：关端口、停秘书、关闭 Job 对象（还活着的子进程和孙进程全部结束）、关库 */
  stop(): Promise<void>;
}

export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const config = loadConfig({ env: options.env, homeDir: options.homeDir });
  const layout = dataDirLayout(config.dataDir);
  for (const dir of [layout.config, layout.db, layout.sessions, layout.tmp, layout.logs]) fs.mkdirSync(dir, { recursive: true });

  // 已经立起来的部分，停的时候按相反的顺序收掉（启动中途失败时也用它收拾）
  const teardown: Array<() => void | Promise<void>> = [];
  const shutdown = async () => {
    for (const step of teardown.splice(0).toReversed()) await step();
  };

  try {
    const clock = options.clock ?? systemClock;
    const now = () => clockIso(clock);
    const store = openEventStore({ file: path.join(layout.db, "ergou.db"), views: [...conversationViews, cardsView, inboxView, remindersView], now, log });
    teardown.push(() => store.close());
    const scheduler = createScheduler({ clock, log });
    teardown.push(() => scheduler.stop());
    const notifications = createEphemeralBus();

    // 卡片类型注册表：各票往这里登记自己的卡（本票：简单提醒卡）
    const registry = new CardTypeRegistry();
    const cards = createCardService({ store, registry, now });
    const inbox = createInboxService({ store, notifications, now });
    const reminders = createReminderService({ store, cards, inbox, scheduler, clock });
    registry.register(reminderCardType(reminders));
    for (const definition of options.extraCardTypes ?? []) registry.register(definition, { replace: true });
    // 还没到点的提醒登记进调度器（守护进程重启后照常触发）
    reminders.start();
    teardown.push(() => reminders.stop());
    const streams = createStreamHub({ lastSeq: (channel) => store.lastSeq(channel) });
    teardown.push(() => streams.close());
    const job = process.platform === "win32" ? createJobObject() : undefined;
    const agents = createAgentManager({ layout, parentEnv: options.env, job, log });
    // 先关 Job：子进程连同它们起的孙进程一起结束；再等子进程的句柄收尾
    teardown.push(async () => {
      job?.close();
      await agents.shutdown();
    });

    const credentials = modelCredentials(options.env);
    const secretaryModel = options.secretaryModel ?? SECRETARY_MODEL;
    if (secretaryModel.kind === "catalog" && !credentials[secretaryModel.provider]) {
      log(`没有 ${secretaryModel.provider} 的模型 key：秘书能起来，但每次回复都会出错（key 由 LSM 从数据目录的密钥区注入）`);
    }
    const secretary = startSecretary({
      agents,
      store,
      streams,
      model: secretaryModel,
      credentials,
      tools: reminderTools(reminders, clock),
      log,
      ...(options.secretaryDownThresholdMs === undefined ? {} : { downThresholdMs: options.secretaryDownThresholdMs }),
    });
    teardown.push(() => secretary.stop());

    const gateway = await startGateway({
      port: options.localPort ?? config.ports.local,
      store,
      streams,
      notifications,
      requests: {
        cardAction: (params, idempotencyKey) => cards.act({ ...params, idempotencyKey }),
        inboxAction: (params, idempotencyKey) => inbox.act({ ...params, idempotencyKey }),
      },
      webRoot: options.webRoot ?? DEFAULT_WEB_ROOT,
      health: () => {
        const s = secretary.health();
        return { ok: s.ok, details: { secretary: s.status }, reasons: s.reason === undefined ? [] : [s.reason] };
      },
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
      scheduler,
      agents,
      secretary,
      job,
      localUrl: gateway.url,
      localPort: gateway.port,
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
