// 假插件宿主（235 号票的验收和测试用）：把**真的**记忆插件按真的插件宿主（plugins/host.ts）装起来，内核那一边换成临时目录里的
// 真实现——事件日志、素材库、调度器、内部作业、待我处理、快速动作登记表；不碰真实的守护进程，也不碰用户的数据目录
// （数据目录、主目录都是临时目录，跑完删掉）。
//
// 用来验证两件事（验收脚本 test/memory/acceptance.ts 和 test/memory/plugin-host.test.ts 共用）：
// - 插件开着：每晚整理的内部作业排上了；运行中停用插件后作业撤销、下一夜不再跑，rg.db 留着；
// - memory.enabled = false（235 号票）：不排作业、不建 rg.db，素材检索、简报、手动整理的入口照常登记着（手动整理点了回"关着"）。
//
// 模型永远不连真的 DeepSeek：配了 DEEPSEEK_API_KEY 也不建 DeepSeekChat——要么不给模型（整理记一条"没配 key"就跳过），
// 要么经 KERNEL.memoryModel 给一个假模型（测试注入的那个口子）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ChatModel, FakeChatModel } from "@ergo/memory";
import { workdayCalendar } from "@ergo/protocol";
import { createAgentContributions } from "../../src/agent-host/contributions.ts";
import { createAppRegistry } from "../../src/apps/registry.ts";
import { BoardKindRegistry } from "../../src/board/kinds.ts";
import type { CardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { type ErgoConfig, loadConfig } from "../../src/config/config.ts";
import { type DataDirLayout, dataDirLayout } from "../../src/config/data-dir.ts";
import { EventSubscriberRegistry } from "../../src/event-sources/index.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { type EventStore, openEventStore } from "../../src/events/event-store.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { type Materials, openMaterials } from "../../src/materials/index.ts";
import type { MaterialOwners } from "../../src/memory/index.ts";
import { MEMORY_NIGHTLY_EVENT, memoryNightlyView, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { memoryPlugin } from "../../src/memory/plugin.ts";
import { PurgeRewriters } from "../../src/memory/rewriters.ts";
import { OperationMeansRegistry } from "../../src/operations/index.ts";
import { bindService, createPluginHost, type PluginHost, type ServiceKey } from "../../src/plugins/host.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { QuickActionRegistry, type QuickActionService } from "../../src/quick-actions/index.ts";
import { createRuntimeRegistry } from "../../src/runtime/index.ts";
import { createDataSourceRegistry } from "../../src/data-sources/registry.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { createInternalJobs, type InternalJobs, INTERNAL_CHANNEL, internalJobsView } from "../../src/scheduler/internal-jobs.ts";
import { createScheduler, type Scheduler } from "../../src/scheduler/scheduler.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";

/** 内核给记忆插件的那些服务（记忆插件 needs 里写的那几个 + 可选给的模型工厂） */
const NEEDED = [
  KERNEL.config,
  KERNEL.store,
  KERNEL.clock,
  KERNEL.scheduler,
  KERNEL.cards,
  KERNEL.inbox,
  KERNEL.materials,
  KERNEL.materialOwners,
  KERNEL.quickActions,
  KERNEL.purgeRewriters,
  KERNEL.embedder,
  KERNEL.layout,
  KERNEL.env,
] as const;

export interface MemoryPluginHostOptions {
  /** 假时钟的起点（默认 2026-10-10 09:00 本地时间） */
  at?: Date;
  /** 数据目录里 config/ergo.json 的内容（和测试底座的 config 一样按顶层键合并）：比如 { memory: { enabled: false } } */
  config?: Record<string, unknown>;
  /** 整理用的假模型；不给就不给模型（没配 key，整理记一条 skipped 就跳过，不联网） */
  chat?: () => ChatModel;
  /** 建不建临时目录（默认建一个，close 时删） */
  dir?: string;
}

export interface MemoryPluginHost {
  /** 临时数据目录（db/rg.db、db/materials.db、ergo.db 都在里面） */
  readonly dir: string;
  readonly layout: DataDirLayout;
  readonly clock: ManualClock;
  readonly config: ErgoConfig;
  readonly host: PluginHost;
  readonly store: EventStore;
  readonly scheduler: Scheduler;
  readonly internalJobs: InternalJobs;
  readonly materials: Materials;
  /** 记忆插件登记的快速动作（手动整理一次、记忆命令） */
  readonly quickActions: QuickActionRegistry;
  /** 记忆插件起来时的日志 */
  readonly logs: string[];
  /** 停宿主、停内部作业和素材库、关库、删临时目录 */
  close(): Promise<void>;
}

/** 装一个假宿主（真的记忆插件）。用的人要自己 close() */
export async function createMemoryPluginHost(options: MemoryPluginHostOptions = {}): Promise<MemoryPluginHost> {
  const created = options.dir === undefined;
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ergo-memory-host-"));
  const configFile = path.join(dir, "config", "ergo.json");
  if (options.config !== undefined) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(options.config, null, 2));
  }
  const layout = dataDirLayout(dir);
  fs.mkdirSync(layout.db, { recursive: true });
  fs.mkdirSync(layout.materials, { recursive: true });
  const config = loadConfig({ env: { ERGO_DATA_DIR: dir }, homeDir: dir });
  const clock = new ManualClock(options.at ?? new Date(2026, 9, 10, 9, 0));
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const store = openEventStore({ file: path.join(layout.db, "ergo.db"), views: [cardsView, inboxView, internalJobsView], now: () => clockIso(clock), log });
  const scheduler = createScheduler({ clock, log });
  const purge = new PurgeRewriters();
  const quickActions = new QuickActionRegistry();
  const internalJobs = createInternalJobs({ store, scheduler, clock, log, scheduleContext: () => ({ calendar: workdayCalendar([], { rules: [], marks: [] }) }) });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: () => clockIso(clock) });
  const materials = openMaterials({ store, dbDir: layout.db, materialsDir: layout.materials, log });
  // 记忆插件只经 KERNEL.quickActions 取登记表的名字（提议和执行由组合根那边接），这里给一个够用的
  const quickActionService = {
    registry: quickActions,
    propose: () => ({ text: "" }),
    execute: () => ({ events: [], summary: "" }),
    performConfirmed: () => {},
  } as unknown as QuickActionService;
  // 记忆插件只经 KERNEL.materialOwners 认项目内部的记录（检索的 hidden），空的一份就够
  const owners: MaterialOwners = { task: () => undefined, approvalOrigin: () => undefined, cardPayload: () => undefined, inboxItemsOfCard: () => [] };
  const services = [
    bindService(KERNEL.config, config),
    bindService(KERNEL.store, store),
    bindService(KERNEL.clock, clock),
    bindService(KERNEL.scheduler, scheduler),
    bindService(KERNEL.cards, {} as unknown as CardService),
    bindService(KERNEL.inbox, inbox),
    bindService(KERNEL.materials, materials),
    bindService(KERNEL.materialOwners, owners),
    bindService(KERNEL.quickActions, quickActionService),
    bindService(KERNEL.purgeRewriters, purge),
    bindService(KERNEL.embedder, new FakeEmbedder()),
    bindService(KERNEL.layout, layout),
    bindService(KERNEL.env, {}),
  ];
  const kernel: ServiceKey<unknown>[] = [...NEEDED];
  if (options.chat !== undefined) {
    services.push(bindService(KERNEL.memoryModel, options.chat));
    kernel.push(KERNEL.memoryModel);
  }
  const host = createPluginHost({ plugins: [memoryPlugin], kernel, log });
  await host.setup({
    services,
    surfaces: {
      cardTypes: new CardTypeRegistry(),
      purge,
      materialSources: materials,
      quickActions,
      internalJobs,
      boardKinds: new BoardKindRegistry([]),
      eventSubscribers: new EventSubscriberRegistry(),
      operationMeans: new OperationMeansRegistry(),
      agent: createAgentContributions({ log }),
      apps: createAppRegistry(),
      views: { detach: (name) => store.detachView(name), attach: (view) => store.attachView(view) },
      runtimes: createRuntimeRegistry({ log }),
      dataSources: createDataSourceRegistry(),
    },
  });
  // 记忆插件的视图（每周整理的记录）装上：事件日志打开时没登记，这里补上；表不存在时建出来
  store.attachView(memoryNightlyView);
  await host.start();
  materials.start();
  let closed = false;
  return {
    dir,
    layout,
    clock,
    config,
    host,
    store,
    scheduler,
    internalJobs,
    materials,
    quickActions,
    logs,
    async close() {
      if (closed) return;
      closed = true;
      await host.stop();
      await internalJobs.stop();
      await materials.stop();
      scheduler.stop();
      store.close();
      if (created) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** 假宿主里记下的整理记录（internal 频道，按先后） */
export function nightlyRecords(store: Pick<EventStore, "read">): MemoryNightlyRecord[] {
  return store.read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT).map((event) => event.payload as MemoryNightlyRecord);
}

/** 一个永远不连网的假模型（整理走到模型那步时回空） */
export const silentChat = () => new FakeChatModel(() => ({}));
