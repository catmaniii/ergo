// 项目系统的组装（278 号票，方案 C，docs/research/29-plugin-expansion-review.html 第 4 节）：组合根 daemon.ts 里原来约 225 行项目接线、
// 35 处后接线（wired("...")）里为项目系统设的 17 处收到这里。项目系统是 projects/、work-orders/、operations/、project-ops/、
// project-services/ 五个目录；组合根只 import 这个文件（test/projects/boundary.test.ts 守着），内核别的模块只经入口 api.ts。
// 交出去的都是各调用方自己要的小接口（入口 api.ts 里的类型、任务模块和执行控制器自己声明的那几个），内部服务只在 handles 里交给组合根
// 放进 Daemon 句柄（测试、调试用），内核模块不从那里拿。
//
// 组合根里分四步，各在原来的位置（不能随手挪）：
// 1. createProjectSystem(deps)：任务模块建好之后、工具包和插件之前。装好项目、立项要求变更、规范改写、补齐规范、运营方案和运营手段、运营层
//    （项目的服务、project_ops：280 号票照插件的纪律写，只经它的装配 project-ops/layer.ts 装、经它的入口 project-ops/api.ts 用，
//    它的登记走宿主现成的登记口）、派单器，登记卡片类型、改写函数、素材来源。建这些都没有副作用（订阅事件都在 start 里）；
// 2. connect(kernel, stops)：执行控制器、agent 宿主、执行名额、任务的维护者、子 agent、工具包、MCP 登记变更都建好之后，原来派单器开始的那一刻：
//    交进这些建在项目系统之后的内核模块；任务完成回调、运营方案跟着项目停用启用、派单器开始；
// 3. start(stops)：执行控制器开始之后，原来项目维护者建出、项目开始的那一刻：建出项目的维护者，项目、立项要求变更、规范改写、补齐规范、项目维护者开始；
// 4. startServices(link)：接入 LSM 之后：运营层（项目的服务）开始。它的收尾（stopServices）组合根在建出之后就排上（停的时候在插件之后）。
// 为什么不合成一步：同一条事件按订阅的先后交给各订阅者，订阅者在里面追加的事件按这个先后编号；订阅、开始的先后挪了，事件的顺序就可能变
// （录制要重录）。只把能说清不影响先后的合到了一处（connect、start 里写着），别的照原来的位置。
//
// 原来组合根为项目系统设的 17 处后接线，解开了 12 处：
// - 任务 → 项目（2 处）：任务模块要的 TaskProjects、计划里涉及的项目的核对只读项目列表，改由项目列表的只读视图（directory.ts）给，
//   组合根在任务模块之前建一份，不用等项目系统；
// - 执行控制器（4 处）、任务的维护者（3 处）、提问卡、工单卡 → 派单器（共 9 处）：派单器在这里第一步就建好，交出去的小接口是现成的对象
//   （触发底座要的派单器原来就直接给，现在给的也是现成的 jobWorkOrders）；
// - project_ops → 运营方案（1 处）：运营方案先建，直接给。
// 解不开的 5 处（1 处留在组合根，4 处收在这里），连同组装带来的几处现取：
// - 任务模块 → 派单器：任务模块建在项目系统之前（项目系统要它），起草计划的工单只能现取——组合根唯一一处为项目系统设的后接线；
// - 派单器 ⇄ 执行控制器：派单器要执行控制器（项目空出来了排队的能不能开始、等澄清、守卫看到的任务），执行控制器要派单器（admit、阶段的回执门槛）；
//   执行控制器建在项目系统之后，connect 交进来，派单器到那时才开始；计划外工单的判定要 agent 宿主、定时运行的工单要执行名额，同理；
// - 项目 ⇄ 派单器、项目 ⇄ 运营方案（这两处原来就是后接线）、项目 ⇄ project_ops（原来是一个引用）：互相要（首个建设任务派工单 / 工单要项目，
//   转入使用时方案生效 / 方案的转运营清单，运营接口清单那一项 / project_ops 要项目档案），项目服务先建，另外三样用到时现取；
// - 项目、派单器 → 项目的维护者（原来 2 处）：删项目要先停维护者、工单结束时它做范围审视；项目的维护者要 agent 宿主（建在项目系统之后），
//   start 里才建；
// - 触发底座、事件来源的分发：它们要派单器（建在项目系统之后），组合根给的是现取的函数（deps.scheduledJobs、deps.checkEventTrigger）。
import fs from "node:fs";
import {
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  type EventFrame,
  type EventTrigger,
  maintainerChannel,
  type ProjectEventPayload,
  projectToolkit,
} from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { FixedTools } from "../agent-host/assembly.ts";
import { maintainerGuardAgent } from "../agent-host/assembly.ts";
import type { AgentHost } from "../agent-host/host.ts";
import type { AppRegistry } from "../apps/registry.ts";
import type { CardService } from "../cards/cards.ts";
import type { CardTypeRegistry } from "../cards/registry.ts";
import type { GuardConfig } from "../config/config.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import type { DeletionParticipants } from "../deletion/participants.ts";
import { buildAgentNotice, type MessageScope } from "../conversation/messages.ts";
import type { UserWordsDeps } from "../conversation/user-words.ts";
import type { EphemeralBus } from "../events/ephemeral.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { RequestHandlers } from "../gateway/gateway.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardPlaces, type WatchCategorySettings } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { LsmServices } from "../lsm/link.ts";
import { multiProjectToolkit } from "../maintainers/multi-project.ts";
import type { Materials } from "../materials/index.ts";
import type { McpChangeService } from "../mcp/change.ts";
import type { PurgeRewriters } from "../memory/rewriters.ts";
import type { JobObject } from "../process/job-object.ts";
import { readUserTurn } from "../quick-actions/index.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { ScheduledJobs } from "../scheduled-jobs/index.ts";
import { type RelayDeps, relayEvents } from "../secretary/relay.ts";
import type { SubAgents } from "../sub-agents/sub-agents.ts";
import type { WorkOrderReply } from "../tasks/cards.ts";
import type { MultiProjectTasks, ProjectTasks, TaskExecution } from "../tasks/execution.ts";
import { internalTaskTools } from "../tasks/internal-tools.ts";
import type { ExecutionSlots } from "../tasks/slots.ts";
import type { TaskService, TaskWorkOrders } from "../tasks/tasks.ts";
import { reviewWorkflowDraft } from "../tasks/workflow-plan.ts";
import type { ToolkitService } from "../toolkit/toolkit.ts";
import { realPathOf } from "../util/real-path.ts";
import type { BrowserDriver } from "../web/index.ts";
import { builtinOperationMeans, createOperations, OperationMeansRegistry, type Operations, operationsChangeCardType, operationsDecisionSource, operationsPurges, operationsView, registerOperationsDeletion } from "../operations/index.ts";
import { createOpsLayer, OPS_LAYER_VIEWS, type OpsLayerJobs, type ProjectOps, type ProjectServices } from "../project-ops/layer.ts";
import { workOrderCardType } from "../work-orders/card.ts";
import { workOrderDecisionPurge, workOrderDecisionSource } from "../work-orders/material-source.ts";
import { answerWorkOrderTool, forwardToUserTool, multiProjectTools } from "../work-orders/multi-project-tools.ts";
import { refusal as workOrderRefusal } from "../work-orders/multi-project-texts.ts";
import { registerWorkOrderDeletion, workOrderPurge } from "../work-orders/purge.ts";
import { judgeUnplannedWorkOrder } from "../work-orders/unplanned.ts";
import { workOrdersView } from "../work-orders/views.ts";
import { createWorkOrders, type WorkOrders } from "../work-orders/work-orders.ts";
import type { JobWorkOrders, SecretaryProjects, ToolkitProjects } from "./api.ts";
import { buildDoneCardType, charterCardType, goLiveCardType, suggestProjectCardType } from "./cards.ts";
import { type CharterChanges, charterChangeCardType, charterChangeDecisionSource, charterChangePurges, createCharterChanges } from "./charter-change.ts";
import { registerProjectDeletion } from "./deletion-participants.ts";
import { createProjectDirectory } from "./directory.ts";
import { maintainerGoLiveTool } from "./go-live-tools.ts";
import { createProjectMaintainers, type ProjectMaintainers } from "./maintainers.ts";
import { charterDecisionSource, charterPurges } from "./material-sources.ts";
import { createProjectService, type ProjectService, type ProjectWorkFolder } from "./projects.ts";
import { isAutoVersioned, preserveVersions } from "./records.ts";
import { createSecretaryProjects } from "./secretary-tools.ts";
import { standardTemplates } from "./standard.ts";
import { backfillOfferPending, createStandardBackfill, standardBackfillCardType } from "./standard-backfill.ts";
import { createStandardChanges, type StandardChanges, standardChangeCardType, standardChangeDecisionSource, standardChangePurges } from "./standard-change.ts";
import { projectsView } from "./views.ts";

// 组合根的 Daemon 句柄（测试、调试用）要的内部服务的类型；组合根只 import 这个文件
export type { CharterChanges, OperationMeansRegistry, Operations, ProjectOps, ProjectService, ProjectServices, StandardChanges, WorkOrders };
// 项目列表的只读视图：组合根在任务模块之前建一份（任务 → 项目不用后接线）
export { createProjectDirectory, type ProjectDirectory } from "./directory.ts";

/** 项目系统的派生视图（打开事件存储时和内核的一起登记）：项目和立项书、工单和会话分段、运营方案，运营层的（项目的服务）。各写各的表，先后不影响 */
export const PROJECT_SYSTEM_VIEWS = [projectsView, workOrdersView, operationsView, ...OPS_LAYER_VIEWS];

/** 项目系统用到的触发底座的几样（运营方案里的定时、事件触发、project_ops 的通用操作、定时作业的一次运行的工单段） */
export type ProjectSystemJobs = Pick<ScheduledJobs, "runAssembly" | "cancelTaskEvents" | "rescheduleTaskEvents"> & OpsLayerJobs;

export interface ProjectSystemDeps {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  tasks: TaskService;
  /** 内核的登记表：项目系统的卡片类型、彻底删除的改写函数、素材来源、删除参与方登记进去 */
  cardTypes: Pick<CardTypeRegistry, "register">;
  rewriters: PurgeRewriters;
  materialSources: Pick<Materials, "register">;
  /**
   * "删除参与方"登记表（279 号票）：项目、工单、运营方案的参与方登记进去；删项目时按整张表算改写单（内核模块的参与方组合根登记，
   * 素材库那一份带着随项目彻底删除的素材）
   */
  deletion: Pick<DeletionParticipants, "register" | "plan">;
  /** 运行时核实用户原话（125 号票）：立项要求变更、规范改写、运营方案里维护者引用的 */
  userWords: UserWordsDeps;
  /** 临时事件的推送：项目的服务给前端看的样子变了推项目列表频道（133） */
  notifications: Pick<EphemeralBus, "publish">;
  /** 转发登记表的登记口（132）：运营层的服务上线时登记 /apps/<项目>-<服务>/（和插件宿主的 ctx.apps 同一个口子，280） */
  apps: Pick<AppRegistry, "register">;
  /** 守卫的各区、关注类别设置：运营方案里的流程先审查修补（130）、计划外工单交给守卫判定（17） */
  places: GuardPlaces;
  watchSettings: () => WatchCategorySettings;
  /** 对话审批的开关（配置 guard.conversationApprovals，101）：off 时计划外工单超出授权先不管、直接派出 */
  conversationApprovals: GuardConfig["conversationApprovals"];
  /** 一段收尾时最多催几次写回：同执行中的催促阈值（14） */
  nudges: number;
  clock: Clock;
  now: () => string;
  /** 数据目录：项目维护者的会话目录、服务首页缩略图的缓存区 */
  layout: DataDirLayout;
  /** 真实路径：数据目录的项目区（项目档案）、数据目录、密钥区，二狗程序目录（外部工作目录不能在它们里面） */
  realDirs: { projects: string; data: string; secrets: string; program: string };
  /** 二狗自己的端口：接入 LSM（startServices 交来实际监听的）之前按配置的 */
  ports: { local: number; external: number };
  /** 服务首页的缩略图怎么截（140；测试注入假的）；不给就用 browser() 驱动无头浏览器截 */
  serviceThumbnail?: (url: string, signal: AbortSignal) => Promise<Buffer>;
  browser: () => BrowserDriver;
  /** project_ops 的"跟维护者说一句"：和秘书转达（tell_project）、网关发消息同一条路（消息的归属、要先开的段） */
  relay: Pick<RelayDeps, "scopeOf" | "preludeOf">;
  /** project_ops 跑脚本时进的 Job 对象（只在 Windows 上有） */
  newJob: () => JobObject | undefined;
  /** 触发底座（它要派单器，建在项目系统之后）：用到时现取 */
  scheduledJobs: () => ProjectSystemJobs;
  /** 事件触发方式对不对（事件来源的分发建在触发底座之后）：运营方案里事件触发的那几条，用到时现取 */
  checkEventTrigger: (trigger: EventTrigger) => string[];
  /** 点"新建项目"、秘书出建议立项卡时写的运行时现在能不能用（289）：不能用的原因；不给就不查 */
  runtimeRefusal?: (runtime: string) => string | undefined;
  /** 在哪个文件夹做（305，work-folders/ 的 precheck、settle）：点"新建项目"、秘书出卡时核对，点"立项"时定下；不给就都照旧 */
  workFolder?: ProjectWorkFolder;
  log: (line: string) => void;
}

/** connect 交进来的、建在项目系统之后的内核模块 */
export interface ProjectSystemKernel {
  /** 执行控制器：派单器要（项目空出来了看排队的、等澄清、守卫看到的任务……），任务完成回调 */
  execution: Pick<TaskExecution, "kick" | "awaitAnswer" | "answered" | "countReturn" | "guardTask" | "onCompleted">;
  /** agent 宿主：项目的维护者是它的一种配置；计划外工单判定时问任务维护者此刻的装配 */
  agentHost: AgentHost;
  /** 全局执行名额：定时作业的运行工单排到了还要有名额才开始 */
  slots: Pick<ExecutionSlots, "hasSlot" | "onFreed">;
  /** 任务的维护者模块：任务转为项目时先让它放手 */
  taskMaintainers: { release(maintainerId: string): Promise<void> };
  /** 子 agent：项目的工具包变了、维护者正在执行某个任务，它的子 agent 重新装配 */
  subAgents: Pick<SubAgents, "reassemble">;
  /** 工具包、MCP 登记变更：项目维护者对话段里增减 skill、申请工具包变更、登记 MCP 的工具 */
  toolkits: Pick<ToolkitService, "skillTool" | "requestTool">;
  mcpChanges: Pick<McpChangeService, "requestTool">;
}

/** 收尾：各步开始了什么就排上停什么（组合根的 teardown，停的时候倒着来） */
export interface Stops {
  push(step: () => void | Promise<void>): unknown;
}

export interface ProjectSystem {
  // —— 给内核模块的小接口 ——
  /** 工具包（toolkit/） */
  readonly toolkitProjects: ToolkitProjects;
  /** 秘书的工具清单（secretary/tool-list.ts） */
  readonly secretary: SecretaryProjects;
  /** 任务模块（tasks/tasks.ts）：项目的任务的任务书、打回意见派成起草计划的工单，多项目任务的计划确认时建工单 */
  readonly taskWorkOrders: TaskWorkOrders;
  /** 执行控制器（tasks/execution.ts）：只涉及一个项目的任务 */
  readonly projectTasks: ProjectTasks;
  /** 执行控制器：涉及多个项目的任务 */
  readonly multiProjectTasks: MultiProjectTasks;
  /** 任务的维护者模块（maintainers/）：涉及多个项目的任务的维护者固定的工具（读项目档案、派工单、汇总回执、答工单、转问用户） */
  readonly multiProjectMaintainer: FixedTools;
  /** 触发底座（scheduled-jobs/）：属于项目的一次运行派成工单 */
  readonly jobWorkOrders: JobWorkOrders;
  /** 提问卡（tasks/cards.ts）上的回答：项目维护者为工单问的交回它 */
  readonly clarificationReply: WorkOrderReply;
  /** 范围审视：对照物里的立项书按现在的（立项要求变更改过的，125） */
  charterText(projectId: string): string | undefined;
  /** 守卫接入：项目档案（不含工作目录和历史区）里的文件被整体重写或删除前先留一份旧版本（15） */
  readonly autoVersioning: { covers(path: string): boolean; preserve(paths: readonly string[]): void };
  /** 运营手段登记表（130）：插件宿主的登记口 ctx.operationMeans 登记进来 */
  readonly operationMeans: { register: OperationMeansRegistry["register"] };
  /** 用户往项目维护者的会话里说话时消息的归属（15、16、75）；不是项目的会话 undefined */
  conversationScope(conversation: ConversationId, taskId?: string): MessageScope | undefined;
  /** 项目维护者手上没有在进行的段时，用户的话开一个对话段（16）：要先追加的事件 */
  messagePrelude(maintainerId: string, key: string, taskId?: string): NewEvent[];
  /** MCP 登记变了（239）：是项目维护者的会话就按新的装配重新拉起（项目的维护者还没建出时什么都不做） */
  reassemble(maintainerId: string, notice: string): void;
  /** 网关的几个请求：新建项目、任务转为项目、项目页上的动作、重置维护者、启停项目的服务（257） */
  readonly requests: Required<Pick<RequestHandlers, "newProject" | "convertTaskToProject" | "projectAction" | "resetMaintainer" | "projectServicesAction">>;
  /** 订阅项目列表频道时补推的项目的服务现在的样子（133：临时事件不补发） */
  servicesFrame(): EventFrame;
  /** 项目的服务首页的缩略图（140） */
  serviceThumbnail(projectId: string, name: string): { file: string; takenAt: string } | undefined;
  /** 项目规范的只读视图（258） */
  projectStandard: ProjectService["standard"];
  /** 项目维护者此刻能用的 skill（82：输入框里打 / 的候选）；不是项目的维护者 undefined */
  skillsOf(maintainerId: string): readonly string[] | undefined;
  // —— 生命周期（见文件开头：各在组合根原来的位置）——
  connect(kernel: ProjectSystemKernel, stops: Stops): void;
  start(stops: Stops): void;
  startServices(link: { lsm: LsmServices; ports: { local: number; external: number } }): void;
  stopServices(): void;
  // —— 组合根交给 Daemon 句柄的内部服务（测试、调试用；内核模块别从这里拿）——
  readonly handles: {
    readonly projects: ProjectService;
    readonly charterChanges: CharterChanges;
    readonly standardChanges: StandardChanges;
    readonly operations: Operations;
    readonly operationMeans: OperationMeansRegistry;
    readonly projectServices: ProjectServices;
    readonly projectOps: ProjectOps;
    readonly workOrders: WorkOrders;
  };
}

/** 真实路径（取不到就原样） */
const real = (p: string) => realPathOf(p) ?? p;

export function createProjectSystem(deps: ProjectSystemDeps): ProjectSystem {
  const { store, cards, inbox, tasks, places, watchSettings, clock, now, userWords, log } = deps;
  const directory = createProjectDirectory({ store, projectsDir: deps.realDirs.projects });

  // 建在项目系统之后的内核模块（connect 交进来）和项目的维护者（start 里建出）：用到时现取，还没接上就是编程错误
  const late: Partial<ProjectSystemKernel & { projectMaintainers: ProjectMaintainers }> = {};
  const wired = <K extends keyof typeof late>(key: K): NonNullable<(typeof late)[K]> => {
    const target = late[key];
    if (!target) throw new Error(`${key} 还没接上`); // @i18n-ignore log：编程错误
    return target as NonNullable<(typeof late)[K]>;
  };

  // 彻底删除的改写函数（21）：立项书（15）、立项要求变更（125）、规范改写（261）、运营方案（130）、工单和工单卡上的决定（16、17）
  deps.rewriters.register(...charterPurges, ...charterChangePurges, ...standardChangePurges, ...operationsPurges, workOrderPurge, workOrderDecisionPurge);

  // 项目（15）："建议立项"卡、立项书卡；项目档案在数据目录的项目区
  const projects = createProjectService({
    store,
    cards,
    inbox,
    tasks,
    deletion: deps.deletion,
    // 删除项目时先停维护者（项目的维护者在 start 里建出，删除时现取）
    maintainers: () => wired("projectMaintainers"),
    // 首个建设任务派工单、重置维护者、维护者会话里的消息属于当前这一段、有工单没结束的不能归档（16；派单器建在下面）
    workOrders: () => workOrders,
    // "首版做完了"卡上带的运营方案、确认并转入使用时每一条生效（130；运营方案建在下面）
    operations: () => operations,
    // 转运营检查清单里运营接口清单那一项照 112 号票的自动验收、转入使用时登记（268；运营层建在下面）
    projectOps: () => ops.goLive,
    ...(deps.runtimeRefusal ? { runtimeRefusal: deps.runtimeRefusal } : {}),
    ...(deps.workFolder ? { workFolder: deps.workFolder } : {}),
    now,
    projectsDir: deps.realDirs.projects,
    dataDir: deps.realDirs.data,
    programDir: deps.realDirs.program,
    log,
  });
  deps.cardTypes.register(suggestProjectCardType(projects));
  deps.cardTypes.register(charterCardType(projects));
  // 删除参与方（279）：项目自己的（维护者会话、立项书和规范改写、说的是这个项目的卡、项目之外读过它的调用）、工单、运营方案。
  // 登记在内核模块的参与方之前（组合根在组装函数之后登记）：字段级改写的卡追加新版本的先后照原来——立项书卡、规范改写卡在审批卡前面
  registerProjectDeletion(deps.deletion, { records: (projectId) => projects.records(projectId) });
  registerWorkOrderDeletion(deps.deletion);
  registerOperationsDeletion(deps.deletion);
  // 立项要求变更（125）：立项书确认之后项目的维护者提出，用户在卡上确认后改写立项书（末尾记变更记录），拒绝的不变
  const charterChanges = createCharterChanges({ store, cards, inbox, records: (projectId) => projects.records(projectId), userWords, now, log });
  deps.cardTypes.register(charterChangeCardType(charterChanges));
  // 本项目的规范改写（261）：项目的维护者提出，用户在卡上确认才生效（记进项目档案的 standard-overrides.md），拒绝的不变
  // 272：规范上线之前建的项目（没有版本）"不补"之后又要补，也走这条路（upgrade）：算缺哪几份、确认后建补齐任务，补齐卡还在等你选时不让提
  const standardChanges = createStandardChanges({
    store,
    cards,
    inbox,
    records: (projectId) => projects.records(projectId),
    userWords,
    standard: (projectId) => projects.standard(projectId),
    tasks,
    backfillPending: (projectId) => backfillOfferPending(store, cards, projectId),
    now,
    log,
  });
  deps.cardTypes.register(standardChangeCardType(standardChanges));
  // 现有项目补齐规范文档（262）：规范上线之前建的项目缺文档的各出一张卡，你选补齐才改用规范、建任务交给维护者补，选不补就不补
  const standardBackfill = createStandardBackfill({ store, cards, inbox, standard: (projectId) => projects.standard(projectId), tasks, now, log });
  deps.cardTypes.register(standardBackfillCardType(standardBackfill));
  // "首版做完了"卡（112）：建设任务做完时出，转入使用、继续建设、放弃并归档
  deps.cardTypes.register(buildDoneCardType(projects));
  // "转入使用"确认卡（259）：用户在项目页点的、维护者提的、秘书代办的转入使用，用户在卡上确认才转
  deps.cardTypes.register(goLiveCardType(projects));

  // 运营手段登记表（130）：内核的定时、事件触发的任务（生效成项目的内部任务），运营层的"服务"（133：项目自己的服务到 LSM 上线），
  // 公网入口（要用户手动）；插件经插件宿主的 ctx.operationMeans 登记自己的（停用时撤掉）。先后就是交运营方案的工具说明里列手段的先后
  // （模型看的）：运营层在内核的两段之间装、自己经登记口登记"服务"（280）。触发底座建在项目系统之后：用到时现取
  const operationMeans = new OperationMeansRegistry();
  const kernelMeans = builtinOperationMeans({ tasks, scheduledJobs: deps.scheduledJobs });
  for (const means of kernelMeans.triggered) operationMeans.register(means);

  // 运营层（280，照插件的纪律写，入口 project-ops/api.ts）：项目的服务（133：替运营手段"服务"到 LSM 上线、撤下，/apps 转发，缩略图，
  // 257 的一键启停）和 project_ops（260、268：秘书调使用中的项目的操作，运营接口清单的验收和登记，维护者的 check_ops）。
  // 它的登记走宿主现成的登记口（服务入口卡、运营手段"服务"、转发）；要的项目系统的东西在这里给。运营方案建在下面：用到时现取
  const ops = createOpsLayer(
    { cardTypes: deps.cardTypes, operationMeans, apps: deps.apps },
    {
      store,
      cards,
      projects: { get: (projectId) => directory.get(projectId), list: () => projects.list(), records: (projectId) => projects.records(projectId), workdir: (project) => projects.workdir(project) },
      pendingPlan: (projectId) => operations.pendingBuildPlan(projectId),
      scheduledJobs: () => deps.scheduledJobs(),
      // 跟维护者说一句：和秘书转达（tell_project）同一条路，插进项目维护者的会话
      tellMaintainer: ({ project, message, key, inputMessageId, check }) =>
        relayEvents(
          { store, scopeOf: (c, taskId) => deps.relay.scopeOf(c, taskId), preludeOf: (c, k, taskId) => deps.relay.preludeOf(c, k, taskId) },
          { conversation: maintainerChannel(project.maintainerId), message, key: `relay:${key}`, inputMessageId, ...(check ? { check } : {}) },
        ),
      // 转给维护者当工单：建一个项目内部的普通任务（75 号票的 delegate：排队，派一张执行的工单给维护者）
      delegate: ({ project, title, instructions, check }) => {
        if (check) {
          projects.internalHost(project.id);
          return {};
        }
        return { taskId: tasks.delegate({ title, instructions, projects: [project.name] }).id };
      },
      isTemplate: (text) => standardTemplates().isTemplate("ops.json", text),
      notifyMaintainer: (project, text, key) => store.append(buildAgentNotice(maintainerChannel(project.maintainerId), text, key, { projectId: project.id }).event),
      onChecked: (project) => projects.refreshGoLiveChecklist(project.id),
      notifications: deps.notifications,
      secretsDir: deps.realDirs.secrets,
      thumbnailsDir: deps.layout.serviceThumbnails,
      ...(deps.serviceThumbnail ? { serviceThumbnail: deps.serviceThumbnail } : {}),
      browser: deps.browser,
      ports: deps.ports,
      newJob: deps.newJob,
      clock,
      now,
      log,
    },
  );
  for (const means of kernelMeans.manual) operationMeans.register(means);

  // 运营方案（130）：项目的维护者交运营方案（逐条校验：手段登记表、要的能力不超出项目的工具包、流程的那几条和 propose_plan 一样先检查
  // 再审查修补，守卫眼里执行它的是项目的维护者）；"首版做完了"卡上确认并转入使用、"运营方案变更"卡上确认时每一条生效
  const operations = createOperations({
    store,
    cards,
    inbox,
    tasks,
    means: operationMeans,
    checkEventTrigger: deps.checkEventTrigger,
    workflowTools: BUILTIN_TOOL_REGISTRY,
    reviewWorkflow: (project, draft, version) => {
      const started = performance.now();
      const workdir = projects.workdir(project);
      fs.mkdirSync(workdir, { recursive: true });
      return reviewWorkflowDraft(draft, version, {
        tools: BUILTIN_TOOL_REGISTRY,
        settings: watchSettings(),
        places,
        maintainerId: project.maintainerId,
        cwd: real(workdir),
        projectRecords: [real(projects.records(project.id).root)],
        projectToolkit: projectToolkit(project),
        now: clock.now(),
        elapsed: () => performance.now() - started,
      });
    },
    userWords,
    // 建设期间又交了一份方案时，"首版做完了""转入使用"卡上的转运营检查清单按新的方案重算（259）
    goLiveChecklist: (projectId, plan) => projects.goLiveChecklist(projectId, plan),
    now,
    log,
  });
  deps.cardTypes.register(operationsChangeCardType(operations));

  // 秘书的工具里项目系统给的那几样（277）
  const secretary = createSecretaryProjects({
    cards,
    projects,
    ops: ops.secretary,
    goLive: ops.goLive,
    ...(deps.runtimeRefusal ? { runtimeRefusal: deps.runtimeRefusal } : {}),
    ...(deps.workFolder ? { workFolder: deps.workFolder } : {}),
  });

  // 派单器（16）：工单和项目维护者的会话分段；写回最多催几次和执行中的催促同一个阈值（14）。
  // 执行控制器、agent 宿主、执行名额建在项目系统之后：connect 交进来，派单器到那时才开始（start）。
  // 工单结束时的范围审视（18）由项目维护者模块做（子进程退出之前）：审视是异步的，到时候项目的维护者已经建出
  const workOrders = createWorkOrders({
    store,
    tasks,
    projects,
    cards,
    inbox,
    execution: {
      kick: () => wired("execution").kick(),
      awaitAnswer: (taskId, waitingOn, branch) => wired("execution").awaitAnswer(taskId, waitingOn, branch),
      answered: (waitingOn) => wired("execution").answered(waitingOn),
      countReturn: (scope, stageId, how) => wired("execution").countReturn(scope, stageId, how),
      guardTask: (taskId) => wired("execution").guardTask(taskId),
    },
    nudges: deps.nudges,
    reviewScope: (segment) => wired("projectMaintainers").reviewScope(segment),
    // 计划外工单（17）：作为伪工具调用交给守卫的判定函数（任务里、工单所属的阶段，现取的关注类别设置）
    // 派单的维护者在守卫眼里的样子取它此刻的装配（和它别的调用一样）；对话审批关着时超出授权先不管、直接派出（101）
    judgeUnplanned: ({ task, maintainerId, project }) => {
      // 涉及多个项目的任务由它自己的维护者执行：宿主问到的就是它此刻的装配
      const assembly = wired("agentHost").assemblyOf(task.taskId);
      if (!assembly) return { refused: workOrderRefusal.notExecuting(task.taskId) };
      return judgeUnplannedWorkOrder({
        agent: maintainerGuardAgent(maintainerId, assembly),
        places,
        task,
        settings: watchSettings(),
        project: project.name,
        now: clock.now(),
        conversationApprovals: deps.conversationApprovals,
      });
    },
    // 定时作业的运行工单排到了还要有名额才开始（19）
    slots: { hasSlot: (except) => wired("slots").hasSlot(except), onFreed: (listener) => wired("slots").onFreed(listener) },
    now,
    log,
  });
  // 工单卡（17）：计划外的工单待你确认，确认派出或拒绝
  deps.cardTypes.register(workOrderCardType(() => workOrders.multiProject));

  // 素材来源（08）：立项书卡上的确认（用户对产出的反应，15）；立项要求变更、规范改写、运营方案的确认和拒绝（审批决定，125、261、130）；
  // 工单卡上的决定（审批决定，17）
  deps.materialSources.register(charterDecisionSource);
  deps.materialSources.register(charterChangeDecisionSource);
  deps.materialSources.register(standardChangeDecisionSource);
  deps.materialSources.register(operationsDecisionSource);
  deps.materialSources.register(workOrderDecisionSource);

  return {
    toolkitProjects: projects,
    secretary,
    taskWorkOrders: workOrders,
    projectTasks: {
      // 只涉及一个项目的任务（16）：在项目的工作目录里做，工具包取任务授权和项目工具包的交集，项目的维护者正忙时留在排队中
      of: (task) => {
        const project = projects.projectOf(task);
        return project && { projectId: project.id, workDir: real(projects.workdir(project)), toolkit: projectToolkit(project) };
      },
      admit: (task) => workOrders.admit(task),
    },
    // 涉及多个项目的任务（17）：维护者的工具包固定，本阶段的回执全部到齐且都完成才能宣布阶段完成
    multiProjectTasks: {
      toolkit: multiProjectToolkit,
      stageGate: (task, stageId) => workOrders.multiProject.stageGate(task, stageId),
      stageLines: (task, stageId) => workOrders.multiProject.stageLines(task, stageId),
      reviewPlaces: (task, stageId) => workOrders.multiProject.reviewPlaces(task, stageId),
    },
    // 涉及多个项目的任务（17）：维护者的工具包固定为三样（读项目档案、派工单、汇总回执），加上转问用户
    multiProjectMaintainer: {
      tools: (scope): HostTool[] => multiProjectTools({ workOrders: () => workOrders, projects, tasks }, scope),
      executionTools: (scope): HostTool[] => [answerWorkOrderTool(() => workOrders, scope), forwardToUserTool(() => workOrders, scope)],
    },
    jobWorkOrders: workOrders,
    // 提问卡上的回答：项目维护者为工单问的交回它（16，派单器的澄清给通知）
    clarificationReply: (payload, answer, key) => workOrders.clarificationReply(payload, answer, key),
    charterText: (projectId) => charterChanges.text(projectId),
    autoVersioning: { covers: (p) => isAutoVersioned(deps.realDirs.projects, p), preserve: (paths) => preserveVersions(deps.realDirs.projects, paths, now()) },
    operationMeans,
    conversationScope: (conversation, taskId) => projects.conversationScope(conversation, taskId),
    messagePrelude: (maintainerId, key, taskId) => workOrders.messagePrelude(maintainerId, key, taskId),
    reassemble: (maintainerId, notice) => late.projectMaintainers?.reassemble(maintainerId, notice),
    requests: {
      newProject: (params, idempotencyKey) => projects.newProject(params, idempotencyKey),
      convertTaskToProject: (params, idempotencyKey) => projects.convertTask(params, idempotencyKey),
      projectAction: (params, idempotencyKey) => projects.act(params, idempotencyKey),
      resetMaintainer: (params, idempotencyKey) => projects.resetMaintainer(params.projectId, idempotencyKey),
      // 项目卡片、项目页上的"启动""关闭"（257）：运营层经 LSM 把项目的服务全部拉起、全部关掉（秘书的工具走同一个入口）
      ...ops.requests,
    },
    servicesFrame: () => ops.servicesFrame(),
    serviceThumbnail: (projectId, name) => ops.thumbnail(projectId, name),
    projectStandard: (projectId) => projects.standard(projectId),
    skillsOf: (maintainerId) => wired("projectMaintainers").skillsOf(maintainerId),

    connect(kernel, stops) {
      Object.assign(late, kernel);
      // 任务完成（全部阶段验收通过）后：项目的建设任务做完了出"首版做完了"卡（15、112）。原来就排在节假日更新的回调后面，中间没有别的回调
      kernel.execution.onCompleted(({ task }) => projects.taskCompleted(task));
      // 项目停用、重新启用时叫登记了 pause / resume 的运营手段（定时、事件触发的由触发底座管）。原来在子 agent 开始之前订阅，
      // 挪到这里只越过了子 agent 的订阅（它只看子 agent 和任务的事件，不看项目的），同一条项目事件交给各订阅者的先后不变
      stops.push(
        store.onAppend((event) => {
          if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) operations.onProject(event.payload as ProjectEventPayload, event.globalSeq);
        }),
      );
      workOrders.start();
      stops.push(() => workOrders.stop());
    },

    start(stops) {
      const kernel = { agentHost: wired("agentHost"), taskMaintainers: wired("taskMaintainers"), subAgents: wired("subAgents"), toolkits: wired("toolkits"), mcpChanges: wired("mcpChanges") };
      // 项目的维护者（15）：用户在它的会话里说话时唤起；任务转为项目时从任务的维护者模块接过来。
      // 建出时登记进 agent 宿主（此刻的装配、停稳手头这一轮、⚙）：排在任务的、定时作业的维护者后面，和原来一样
      const projectMaintainers = createProjectMaintainers({
        host: kernel.agentHost,
        projects,
        workOrders,
        taskMaintainers: kernel.taskMaintainers,
        // 定时作业的一次运行的工单段（19）：作业所在计划的工具包、报告这次运行失败、守卫看到的作业的授权
        jobRun: (wo, maintainerId) => deps.scheduledJobs().runAssembly(wo.scheduledJobId, maintainerId),
        reassembleSubAgents: (taskId) => void kernel.subAgents.reassemble(taskId),
        // 对话段里增减 skill、申请工具包变更的工具（27），登记 MCP 的工具（239）
        toolkits: {
          projectSkillTool: (projectId, maintainerId) => kernel.toolkits.skillTool({ kind: "project", projectId, maintainerId }),
          requestTool: (projectId, maintainerId) => kernel.toolkits.requestTool(projectId, maintainerId),
          requestMcpTool: (projectId, maintainerId) => kernel.mcpChanges.requestTool({ kind: "project", projectId, maintainerId }),
        },
        // 立项书确认之后改立项要求的工具（125）
        charterChangeTool: (projectId, maintainerId) => charterChanges.tool(projectId, maintainerId),
        // 立项书确认之后改本项目规范的工具（261）
        standardChangeTool: (projectId, maintainerId) => standardChanges.tool(projectId, maintainerId),
        // 交运营方案的工具（130）
        operationsTool: (projectId, maintainerId) => operations.tool(projectId, maintainerId),
        // 提转入使用的工具（259）：只出确认卡，用户确认才转
        goLiveTool: (projectId, maintainerId) => maintainerGoLiveTool(projects, { projectId, maintainerId }, (id) => ops.goLive.prepareGoLive(id)),
        // 验收运营接口清单的工具（268）：改了 ops.json 看过没过，使用中的全过了登记成新的一版
        checkOpsTool: (projectId, maintainerId) => ops.checkTool({ projectId, maintainerId }),
        layout: deps.layout,
        // 项目内部任务（64）：对话段里发起任务的工具（点明了才建，看维护者正在处理的那条用户消息）
        internalTaskTools: (scope) => internalTaskTools({ tasks, cards, projects, userTurn: (inputMessageId) => readUserTurn(store, cards, inputMessageId) }, scope),
      });
      late.projectMaintainers = projectMaintainers;
      projects.start();
      stops.push(() => projects.stop());
      charterChanges.start();
      stops.push(() => charterChanges.stop());
      standardChanges.start();
      stops.push(() => standardChanges.stop());
      // 项目档案对过一遍之后（projects.start）：规范上线记一次，给缺文档的现有项目出卡
      standardBackfill.start();
      stops.push(() => standardBackfill.stop());
      projectMaintainers.start();
      stops.push(() => projectMaintainers.stop());
    },

    startServices(link) {
      // 接入层建好了，开始做（上线了的先登记转发、没做完的接着做、接 LSM 推来的状态）；之后按网关实际监听的端口
      ops.start(link);
    },

    stopServices: () => ops.stop(),

    handles: { projects, charterChanges, standardChanges, operations, operationMeans, ...ops.handles, workOrders },
  };
}
