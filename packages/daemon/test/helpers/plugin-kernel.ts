// 插件的假内核（215 号票；插件开发手册 docs/guides/plugin-development.md 的"怎么测"）：把插件按**真的**插件宿主（plugins/host.ts）装起来，
// 内核那一边换成临时目录里的真实现——事件存储（连同插件声明的视图、停着的视图）、卡片类型和卡片、彻底删除的改写函数、素材库（只保管，
// 不采成素材）、快速动作、内部作业、看板种类、事件触发的订阅方、运营手段、agent 贡献、转发登记表、待我处理——外加设置 · 插件那一层
// （plugins/settings.ts：停用、启用、移除写临时数据目录里的 ergo.json，移除时连数据删走 plugins/removal.ts 和"删除参与方"登记表）。
// 不起守护进程、不拉 agent 子进程，一条用例几十毫秒；写插件时先在这里把装上、停用、启用、移除测对。
// 走组合根和插件清单的那条路另在主切面测（test/main/，startTestDaemon 的 plugins / extraPlugins）：只在这里测过的插件不算上线过
// （ADR-0027：dsh 的复盘 0001，手挂插件的单元测试全过、上线即崩）。
// 内核给插件的服务默认绑上 KERNEL 里的事件存储、时钟、调度器、卡片、待我处理；插件 needs 里还要别的，用 services 补（extraService）。
// 295 号票起还有设置 · 数据源那一层（data-sources/：登记表、密钥区、用法开关、导入文件夹，断开并删走同一张"删除参与方"登记表；
// 不定时看导入文件夹、起来时不看，测试自己叫 scan；在电脑上打开文件夹换成记下来的 openedFolders）。
import fs from "node:fs";
import path from "node:path";
import { workdayCalendar } from "@ergo/protocol";
import { onTestFinished } from "vitest";
import { createAgentContributions } from "../../src/agent-host/contributions.ts";
import { createAppRegistry } from "../../src/apps/registry.ts";
import { BoardKindRegistry } from "../../src/board/kinds.ts";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceRegistry, createDataSources, createDataSourceSecrets, createDataSourceSettings, registerDataSourceDeletion } from "../../src/data-sources/index.ts";
import { EventSubscriberRegistry } from "../../src/event-sources/index.ts";
import { DeletionParticipants } from "../../src/deletion/participants.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { type EventStore, openEventStore } from "../../src/events/event-store.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { openMaterials } from "../../src/materials/materials.ts";
import { PurgeRewriters } from "../../src/memory/rewriters.ts";
import { OperationMeansRegistry } from "../../src/operations/index.ts";
import { bindService, createPluginHost, type PluginDefinition, type ServiceKey } from "../../src/plugins/host.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { createPluginSettings } from "../../src/plugins/settings.ts";
import { QuickActionRegistry } from "../../src/quick-actions/index.ts";
import { createRuntimeRegistry, piRuntime } from "../../src/runtime/index.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { createInternalJobs, internalJobsView } from "../../src/scheduler/internal-jobs.ts";
import { createScheduler } from "../../src/scheduler/scheduler.ts";
import { ManualClock } from "./clock.ts";
import { makeTempDir } from "./temp-dir.ts";

export interface PluginKernelOptions {
  /** 插件清单（按这个先后，和 plugins/manifest.ts 一样） */
  plugins: readonly PluginDefinition[];
  /** 配置里停用的（plugins.disabled）：起来时就写进临时的 ergo.json */
  disabled?: readonly string[];
  /** 配置里移除了的（plugins.removed） */
  removed?: readonly string[];
  /** 再绑上的内核服务（插件 needs 里写的、默认没有的），用 extraService 写 */
  services?: readonly ExtraService[];
  /** 假时钟的起点（默认 2026-10-24 09:00 本地时间） */
  at?: Date;
}

/** 默认之外再绑上的一个内核服务：名字，和按假内核现建的值 */
export interface ExtraService {
  readonly key: ServiceKey<unknown>;
  make(kernel: { store: EventStore; clock: ManualClock; dir: string }): unknown;
}

export function extraService<T>(key: ServiceKey<T>, make: (kernel: { store: EventStore; clock: ManualClock; dir: string }) => T): ExtraService {
  return { key, make };
}

/** 起一套假内核、装上插件（用例结束时停宿主、关库、删临时目录） */
export async function startPluginKernel(options: PluginKernelOptions) {
  const dir = makeTempDir("ergo-plugin-kernel-");
  const layout = dataDirLayout(dir);
  const clock = new ManualClock(options.at ?? new Date("2026-10-24T09:00:00+08:00"));
  const now = () => clockIso(clock);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const config = { disabled: [...(options.disabled ?? [])], removed: [...(options.removed ?? [])] };
  for (const d of [path.dirname(layout.configFile), layout.db, layout.materials]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(layout.configFile, JSON.stringify({ plugins: config }, null, 2));

  // 宿主先建（排顺序、定谁不装），再按它收齐的视图打开事件存储——和组合根 daemon.ts 一样
  const extras = options.services ?? [];
  const kernelKeys = [KERNEL.store, KERNEL.clock, KERNEL.scheduler, KERNEL.cards, KERNEL.inbox, ...extras.map((s) => s.key)];
  const plugins = createPluginHost({ plugins: options.plugins, disabled: config.disabled, removed: config.removed, kernel: kernelKeys, log });
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [cardsView, inboxView, internalJobsView, ...plugins.views()], dormantViews: plugins.dormantViews(), now, log });

  const scheduler = createScheduler({ clock, log });
  const cardTypes = new CardTypeRegistry();
  const cards = createCardService({ store, registry: cardTypes, now });
  const purge = new PurgeRewriters();
  const quickActions = new QuickActionRegistry();
  const boardKinds = new BoardKindRegistry([]);
  const eventSubscribers = new EventSubscriberRegistry();
  const operationMeans = new OperationMeansRegistry();
  const agent = createAgentContributions({ log });
  const apps = createAppRegistry();
  const internalJobs = createInternalJobs({ store, scheduler, clock, log, scheduleContext: () => ({ calendar: workdayCalendar([], { rules: [], marks: [] }) }) });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now, log });
  const materials = openMaterials({ store, dbDir: layout.db, materialsDir: layout.materials, log });
  // agent 运行时（286 号票）：内核自带的 pi 照接口登记，插件在数据契约里登记的进这里
  const runtimes = createRuntimeRegistry({ log });
  runtimes.register(piRuntime);
  // 数据源（295 号票）：插件在数据契约里登记的数据源进这里
  const dataSourceRegistry = createDataSourceRegistry();
  const participants = new DeletionParticipants({ store, cards, rewriters: purge });
  registerDataSourceDeletion(participants, { imports: layout.imports, log });
  const openedFolders: string[] = [];
  const dataSources = createDataSources({
    registry: dataSourceRegistry,
    store,
    secrets: createDataSourceSecrets({ dir: layout.dataSourceSecrets, log }),
    settings: createDataSourceSettings({ file: layout.dataSourcesFile, log }),
    internalJobs,
    scheduler,
    contributions: agent,
    participants,
    folder: { imports: layout.imports, imported: layout.importedDir },
    inferable: () => [],
    materials,
    now,
    openFolder: (folder) => {
      openedFolders.push(folder);
      return Promise.resolve();
    },
    log,
    scanEveryMs: false,
    settleMs: 0,
  });

  let closed = false;
  /** 停宿主、关库（只做一次；用例结束时自动叫） */
  const close = async () => {
    if (closed) return;
    closed = true;
    await dataSources.stop();
    await plugins.stop();
    await internalJobs.stop();
    await materials.stop();
    scheduler.stop();
    store.close();
  };
  onTestFinished(close);

  await plugins.setup({
    services: [
      bindService(KERNEL.store, store),
      bindService(KERNEL.clock, clock),
      bindService(KERNEL.scheduler, scheduler),
      bindService(KERNEL.cards, cards),
      bindService(KERNEL.inbox, inbox),
      ...extras.map((s) => ({ key: s.key, value: s.make({ store, clock, dir }) })),
    ],
    surfaces: {
      cardTypes,
      purge,
      materialSources: materials,
      quickActions,
      internalJobs,
      boardKinds,
      eventSubscribers,
      operationMeans,
      agent,
      apps,
      views: { detach: (name) => store.detachView(name), attach: (view) => store.attachView(view) },
      runtimes,
      dataSources: dataSourceRegistry,
    },
  });
  await plugins.start();
  materials.start();
  // 设置 · 数据源：插件运行中停用、启用时定期导入、按需查跟着变
  dataSources.start({ scan: false });
  plugins.onChange(() => dataSources.refresh());

  // 设置 · 插件那一层：写配置、移除时连数据删
  const settings = createPluginSettings({ host: plugins, configFile: layout.configFile, config, purge: { store, participants, dataDir: dir, now, log }, log });
  /** 数据目录配置文件里现在的 plugins（设置那一层写的） */
  const pluginsConfig = (): { disabled?: string[]; removed?: string[] } => (JSON.parse(fs.readFileSync(layout.configFile, "utf8")) as { plugins?: { disabled?: string[]; removed?: string[] } }).plugins ?? {};

  return { dir, layout, clock, logs, store, host: plugins, settings, pluginsConfig, scheduler, cardTypes, cards, purge, quickActions, boardKinds, eventSubscribers, operationMeans, agent, apps, runtimes, dataSourceRegistry, dataSources, openedFolders, internalJobs, inbox, materials, close };
}

export type PluginKernel = Awaited<ReturnType<typeof startPluginKernel>>;
