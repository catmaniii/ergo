// 运营层的装配（280 号票，方案 C 第 4 点；对外的入口是 api.ts）：照插件的 setup(ctx) 写，但不是插件、一直开着、不给开关。
// 只有项目系统的组装函数（projects/system.ts）装它，像插件清单装 plugin.ts（test/projects/boundary.test.ts 守着）。
// - 登记都走宿主现成的登记口（OpsLayerContext，就是插件宿主给插件的 ctx 里那几样，每次登记返回撤销函数）：服务入口卡（cardTypes）、
//   运营手段"服务"（operationMeans，133 号票；原来是组装函数替它插进内核的运营手段）、上线了的服务的 /apps/<应用名>/ 转发
//   （apps，132 号票；原来交给它的是整张转发登记表）；
// - 要的项目系统的东西、内核的服务都在 OpsLayerDeps 里由组装函数给（像插件 needs 里的服务），它自己不 import 项目系统的内部文件
//   （只经项目系统的入口 projects/api.ts）；
// - 交出去的是各调用方的小接口：转入使用那一套（项目服务、提转入使用的工具）、秘书的工具、维护者的 check_ops、网关的启停请求、
//   订阅时补推的服务、缩略图；接入 LSM 之后 start（组合根原来的位置，经组装函数的 startServices），停机时 stop。
// 建这些都没有副作用（订阅事件、接 LSM 都在 start 里），所以组装函数在原来建项目的服务的位置装它：卡片类型、运营手段登记的先后照原来。
import { CHANNELS, EVENT_TYPES, type EventFrame, type OperationsPlanView, type Project, type ProjectServiceView } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { checkAppPrefix } from "../apps/prefix-check.ts";
import type { CardService } from "../cards/cards.ts";
import type { EphemeralBus } from "../events/ephemeral.ts";
import type { DerivedView, EventStore } from "../events/event-store.ts";
import { LOCAL_HOST, type RequestHandlers } from "../gateway/gateway.ts";
import { DISABLED_LSM_SERVICES, type LsmServices } from "../lsm/link.ts";
import type { JobObject } from "../process/job-object.ts";
import type { PluginContext } from "../plugins/host.ts";
import type { ProjectRecordsPaths } from "../projects/api.ts";
import type { Clock } from "../scheduler/clock.ts";
import { runsOfJob, type ScheduledJobs } from "../scheduled-jobs/index.ts";
import { realPathOf } from "../util/real-path.ts";
import type { BrowserDriver } from "../web/index.ts";
import { serviceMeans } from "../project-services/means.ts";
import { createProjectServices, type ProjectServices } from "../project-services/project-services.ts";
import { openServiceTool, serviceBoardSection, serviceEntryCardType, switchServicesTool } from "../project-services/secretary-tool.ts";
import { captureServiceHome } from "../project-services/thumbnails.ts";
import { projectServicesView } from "../project-services/views.ts";
import type { OpsGoLive, OpsSecretary } from "./api.ts";
import type { BuiltinContext } from "./builtin.ts";
import type { RunContext } from "./runner.ts";
import { createProjectOps, type ProjectOps } from "./tool.ts";

// 组合根的 Daemon 句柄（测试、调试用）要的内部服务的类型：经组装函数转出
export type { ProjectOps, ProjectServices };

/** 运营层的派生视图（打开事件存储时和项目系统的一起登记，像插件定义里的 views）：项目的服务 */
export const OPS_LAYER_VIEWS: readonly DerivedView[] = [projectServicesView];

/**
 * 运营层装配时的登记口：插件宿主给插件的那几样（plugins/host.ts 的 PluginContext），每次登记返回撤销函数。组装函数交进来的是内核的卡片类型
 * 登记表、项目系统的运营手段登记表（插件宿主的 ctx.operationMeans 也登记进这一张）、转发登记表（插件宿主的 ctx.apps 也是它）
 */
export type OpsLayerContext = Pick<PluginContext, "cardTypes" | "operationMeans" | "apps">;

/** 运营层用到的触发底座（project_ops 的通用操作：这个项目的定时 / 事件触发的任务，立即运行一次、暂停恢复、改时间表） */
export type OpsLayerJobs = Pick<ScheduledJobs, "ofProject"> & BuiltinContext["scheduler"];

export interface OpsLayerDeps {
  store: EventStore;
  cards: CardService;
  /**
   * 项目：按编号找没删掉的（项目列表的只读视图）、没删掉的全部、项目档案各文件的位置、项目现在的工作目录（项目服务的；真实路径这里另取）
   */
  projects: { get(projectId: string): Project | undefined; list(): Project[]; records(projectId: string): ProjectRecordsPaths; workdir(project: Project): string };
  /** 建设中的项目要随转入使用生效的那份运营方案（验收时 http 的调用口看它里面的服务）；运营方案建在运营层之后，用到时现取 */
  pendingPlan: (projectId: string) => OperationsPlanView | undefined;
  /** 触发底座（建在项目系统之后）：用到时现取 */
  scheduledJobs: () => OpsLayerJobs;
  /** project_ops 的"跟维护者说一句"：和秘书转达（tell_project）同一条路，插进项目维护者的会话 */
  tellMaintainer: BuiltinContext["tellMaintainer"];
  /** project_ops 转给维护者当工单：建一个项目内部的普通任务；check 只看收不收 */
  delegate: RunContext["delegate"];
  /** 档案里的 ops.json 是不是规范模板原样 */
  isTemplate: (text: string) => boolean;
  /** 使用中的项目自动验收没过：给维护者的会话放一条通知（会唤起它） */
  notifyMaintainer: (project: Project, text: string, key: string) => void;
  /** 一次验收做完了：刷新还在等的转入使用确认卡 */
  onChecked: (project: Project) => void;
  /** 临时事件的推送：项目的服务给前端看的样子变了推项目列表频道（133） */
  notifications: Pick<EphemeralBus, "publish">;
  /** 数据目录的密钥区（真实路径）：服务定义里密钥的引用换成这里的文件 */
  secretsDir: string;
  /** 服务首页的缩略图的缓存区（140） */
  thumbnailsDir: string;
  /** 服务首页的缩略图怎么截（测试注入假的）；不给就用 browser() 驱动无头浏览器截 */
  serviceThumbnail?: (url: string, signal: AbortSignal) => Promise<Buffer>;
  browser: () => BrowserDriver;
  /** 二狗自己的端口：接入 LSM（start 交来实际监听的）之前按配置的 */
  ports: { local: number; external: number };
  /** project_ops 跑脚本时进的 Job 对象（只在 Windows 上有） */
  newJob: () => JobObject | undefined;
  clock: Clock;
  now: () => string;
  log: (line: string) => void;
}

export interface OpsLayer {
  /** 转入使用那一套：项目服务、提转入使用的两个工具 */
  readonly goLive: OpsGoLive;
  /** 秘书的工具里运营层给的、查看板时那一节 */
  readonly secretary: OpsSecretary;
  /** 项目维护者的 check_ops（268）：绑在它维护的项目上 */
  checkTool(scope: { projectId: string; maintainerId: string }): HostTool;
  /** 网关：项目卡片、项目页上的"启动""关闭"（257）：经 LSM 把项目的服务全部拉起、全部关掉（秘书的工具走同一个入口） */
  readonly requests: Required<Pick<RequestHandlers, "projectServicesAction">>;
  /** 订阅项目列表频道时补推的项目的服务现在的样子（133：临时事件不补发） */
  servicesFrame(): EventFrame;
  /** 项目的服务首页的缩略图（140） */
  thumbnail(projectId: string, name: string): { file: string; takenAt: string } | undefined;
  /** 接入 LSM 之后：开始做（上线了的先登记转发、没做完的接着做、接 LSM 推来的状态）；之后按网关实际监听的端口 */
  start(link: { lsm: LsmServices; ports: { local: number; external: number } }): void;
  stop(): void;
  /** 交给 Daemon 句柄的内部服务（测试、调试用） */
  readonly handles: { readonly projectServices: ProjectServices; readonly projectOps: ProjectOps };
}

/** 真实路径（取不到就原样） */
const real = (p: string) => realPathOf(p) ?? p;

export function createOpsLayer(ctx: OpsLayerContext, deps: OpsLayerDeps): OpsLayer {
  const { store, cards, projects, clock, now, log } = deps;
  /** 项目列表频道上"项目的服务"这一帧（变了推的、订阅时补推的同一个样子） */
  const servicesFrameOf = (services: ProjectServiceView[]): EventFrame => ({ channel: CHANNELS.projects, seq: store.lastSeq(CHANNELS.projects), type: EVENT_TYPES.projectServices, payload: { services } });

  // 项目的服务（133）：运营手段"服务"生效之后替它到 LSM 上线、撤下，接 LSM 推来的状态，有网页的经转发登记口登记 /apps/<应用名>/；
  // 给前端看的样子变了推项目列表频道的临时事件。接入层建在最后（开好端口之后）：start 交来，那时才开始做
  let lsm: LsmServices | undefined;
  let ports: { local: number; external: number } | undefined;
  const projectServices = createProjectServices({
    store,
    lsm: () => lsm ?? DISABLED_LSM_SERVICES,
    apps: ctx.apps,
    secretsDir: deps.secretsDir,
    nodePath: process.execPath,
    project: (projectId) => projects.get(projectId),
    prefixCheck: checkAppPrefix,
    publish: (services) => deps.notifications.publish(servicesFrameOf(services)),
    clock,
    now,
    log,
    // 服务首页的缩略图（140）：守护进程自己截，经二狗本机端口的转发（网关开好之后才有地址），存在缓存区；浏览器和联网工具同一个
    thumbnails: {
      dir: deps.thumbnailsDir,
      capture: deps.serviceThumbnail ?? ((url, signal) => captureServiceHome(deps.browser(), url, signal)),
      baseUrl: () => (ports ? `http://${LOCAL_HOST}:${ports.local}` : undefined),
    },
  });
  // 服务入口卡（133）：秘书给出服务的入口时放进聊天
  ctx.cardTypes.register(serviceEntryCardType());

  // 运营手段"服务"（133）：项目自己的服务登记到 LSM 上线。经运营手段的登记口登记（插件也是这个口子）；组装函数在内核的定时、事件触发之后、
  // 公网入口之前装运营层，交运营方案的工具说明里列手段的先后照原来
  ctx.operationMeans.register(
    serviceMeans({
      store,
      paths: (project) => ({ workdir: real(projects.workdir(project)), records: real(projects.records(project.id).root) }),
      // 二狗自己的端口（测试里是随机挑的：网关开好之后取实际的）
      daemonPorts: () => ports ?? deps.ports,
      status: (app) => projectServices.status(app),
      prefixCheck: checkAppPrefix,
      now,
    }),
  );

  // 秘书调使用中的项目的操作（260）；268：白送的通用操作、参数校验、能念的 say、四种实现方式（http / script / ergo / maintainer）、
  // 清单照 112 号票的自动验收和版本号（转运营检查清单那一项、转入使用时登记、维护者的 check_ops）
  const projectOps = createProjectOps({
    store,
    projects: { list: () => projects.list(), records: (projectId) => projects.records(projectId), workdir: (project) => projects.workdir(project) },
    services: projectServices,
    pendingPlan: (projectId) => deps.pendingPlan(projectId),
    jobs: { ofProject: (projectId) => deps.scheduledJobs().ofProject(projectId), runsOf: (jobId) => runsOfJob(store.reader, jobId) },
    scheduler: () => deps.scheduledJobs(),
    tellMaintainer: deps.tellMaintainer,
    delegate: deps.delegate,
    isTemplate: deps.isTemplate,
    notifyMaintainer: deps.notifyMaintainer,
    onChecked: deps.onChecked,
    now,
    log,
    newJob: deps.newJob,
  });

  const projectName = (projectId: string) => projects.get(projectId)?.name;

  return {
    goLive: {
      checklistItem: (project) => projectOps.checklistItem(project),
      goLiveEvents: (project) => projectOps.goLiveEvents(project),
      prepareGoLive: (projectId) => projectOps.prepareGoLive(projectId),
    },
    secretary: {
      boardSection: () => serviceBoardSection(projectServices),
      tools: () => [
        openServiceTool({ services: projectServices, cards, projectName }),
        // 257 号票：启动、关闭项目的服务（用户说了就是确认）
        switchServicesTool({ services: projectServices, projectName }),
        // 260 号票：调使用中的项目的操作（使用中的项目不用确认；268 号票补齐通用操作、参数校验、say、四种实现方式、验收和版本号）
        projectOps.tool(),
      ],
    },
    checkTool: (scope) => projectOps.checkTool(scope),
    requests: {
      projectServicesAction: (params, idempotencyKey) => projectServices.power(params.projectId, params.action, "user", idempotencyKey),
    },
    servicesFrame: () => servicesFrameOf(projectServices.view()),
    thumbnail: (projectId, name) => projectServices.thumbnail(projectId, name),
    start(link) {
      ports = link.ports;
      lsm = link.lsm;
      projectServices.start();
    },
    stop: () => projectServices.stop(),
    handles: { projectServices, projectOps },
  };
}
