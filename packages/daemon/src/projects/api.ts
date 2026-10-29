// 项目系统对外的入口（277 号票，方案 C，docs/research/29-plugin-expansion-review.html）。项目系统是 projects/、work-orders/、
// operations/、project-ops/、project-services/ 五个目录；组合根 daemon.ts 以外的内核模块只从这里拿项目系统的东西，不 import 这五个
// 目录里的别的文件（test/projects/boundary.test.ts 检查）。五个目录共用这一个入口：调用方只学一个文件。组合根自己也只经组装函数
// projects/system.ts（278 号票）装项目系统。
//
// 这里露的是窄接口——每个调用方要什么给什么，不把项目服务、派单器、项目的服务、project_ops 这些内部服务原样转出去：
// 1. 工具名：系统提示的占位符（prompts/registry.ts）、交给维护者的通知（tasks/internal-tools.ts）；运营层的四个从它自己的入口
//    project-ops/api.ts 转出（280 号票）。守卫运行时给 project_ops 的参数打码 280 号票起看工具自己的登记（maskArgs），不再要工具名；
// 2. 只读查派生视图：没删掉的项目（看板 board/kinds.ts、秘书转达 secretary/relay.ts）、工单（范围审视）、占着执行名额的运行工单
//    （tasks/slots.ts）；
// 3. 各调用方的小接口（下面的类型）：项目服务、派单器、运营层由组装函数（projects/system.ts）装好，照这些小接口交给它们；
//    任务模块要的 TaskProjects、TaskWorkOrders（tasks/tasks.ts），执行控制器要的 ProjectTasks、MultiProjectTasks（tasks/execution.ts）
//    本来就是窄接缝，由任务模块自己声明，这里不重复；
// 4. 运营手段的类型：插件宿主的登记口 ctx.operationMeans（plugins/host.ts）；
// 5. 运营层（project-ops/、project-services/，280 号票照插件的纪律写，自己的入口是 project-ops/api.ts）用项目系统的其余部分也只经这里：
//    operations 频道和它上面的事件（服务、运营接口清单的事件也记在这个频道上；方案确认了要重截服务首页）、项目档案各文件的位置。
//
// 只放常量、只读查询和类型，不 import 项目系统的服务实现：提示词表、插件宿主、运营层也引用这里，别把整个项目系统拉进它们的依赖。
import type { JobRun, JobRunWorkOrder, PlanToolkit, Project, ScheduledJob, Task, WorkOrder, WorkOrderOutcome } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { NewEvent } from "../events/event-store.ts";
import type { ProjectService, ToolkitChange, ToolkitChanged } from "./projects.ts";

// —— 1. 工具名 ——
export { PROPOSE_CHARTER_CHANGE_TOOL, PROPOSE_GO_LIVE_TOOL, PROPOSE_STANDARD_CHANGE_TOOL, READ_PROJECT_RECORDS_TOOL, SUBMIT_CHARTER_TOOL, SUGGEST_PROJECT_TOOL } from "./tool-names.ts";
export { MULTI_PROJECT_TOOL, WORK_ORDER_TOOL } from "../work-orders/tool-names.ts";
export { PROPOSE_OPERATIONS_TOOL } from "../operations/tool-names.ts";
export { CHECK_OPS_TOOL, OPEN_SERVICE_TOOL, PROJECT_OPS_TOOL, SWITCH_SERVICES_TOOL } from "../project-ops/api.ts";

// —— 2. 只读查派生视图（db 是事件存储的派生视图）——
// getProject：一个没删掉的项目；listProjects：没删掉的项目，按建出的先后
export { getProject, listProjects } from "./views.ts";
// getWorkOrder：一张工单；workOrderInternal：工单属于哪个项目内部（它的任务或定时作业上的标记）；
// countActiveRunWorkOrders：在做的（进行中、等澄清）定时运行工单有几张，各占一个全局执行名额
export { countActiveRunWorkOrders, getWorkOrder, workOrderInternal } from "../work-orders/views.ts";

// —— 3. 各调用方的小接口 ——

/**
 * 按编号、按任务找没删掉的项目：触发底座（scheduled-jobs/）、计划里涉及的项目的核对（tasks/plan-projects.ts）用它，
 * 工具包、范围审视的小接口也从它长出来。projectOf 和任务模块的 TaskProjects 里的是同一个
 */
export interface ProjectLookup {
  /** 没删掉的项目（删掉了的、没有的是 undefined） */
  get(projectId: string): Project | undefined;
  /** 任务属于哪个项目（16 号票）：由这个项目的维护者执行的任务（只涉及一个项目的）；任务自己的维护者执行的、项目删掉了的没有 */
  projectOf(task: Task): Project | undefined;
}

/** 工具包（toolkit/）要的：找项目，改项目的工具包（项目页上直接改、维护者增减 skill 和减少能力、"工具包变更"卡批准） */
export interface ToolkitProjects extends ProjectLookup {
  /**
   * 改项目的工具包（27 号票）：整个换成 toolkit（名字的合法性由调用方查过）。立项书确认之前没有工具包、已归档的项目，不能改。
   * 和项目事件同一事务追加维护者会话时间线上的一笔和 change.events；没有改动时什么都不追加
   */
  changeToolkit(projectId: string, toolkit: PlanToolkit, change: ToolkitChange): ToolkitChanged;
  /** 同 changeToolkit，但不追加：给出要追加的事件（卡片动作和卡片更新同一事务追加） */
  buildToolkitChange(projectId: string, toolkit: PlanToolkit, change: ToolkitChange): ToolkitChanged & { events: NewEvent[] };
}

export type { ToolkitChange, ToolkitChanged };

/** 范围审视（scope-review/）要的：项目的名字和立项书（对照物）、范围记录写进哪个项目档案 */
export interface ScopeReviewProjects extends Pick<ProjectLookup, "get"> {
  /** 某个维护者的项目（删掉的也认：deleted 为 true） */
  ofMaintainer(maintainerId: string): { project: Project; deleted: boolean } | undefined;
  /** 项目档案里立项书、范围记录两份文件的位置 */
  records(projectId: string): { charter: string; scopeRecords: string };
}

/** 触发底座（scheduled-jobs/）要的派单器：属于项目的一次运行是项目维护者的一张工单（19、76 号票） */
export interface JobWorkOrders {
  /**
   * 派一张定时作业的一次运行的工单（19 号票，不追加）：发给已归档项目的直接退回；维护者空着、前面没有排着的、
   * 又有全局执行名额，就同一事务开始。key 是派出的幂等键（作业模块给）
   */
  dispatchRun(input: { job: ScheduledJob; run: JobRun; project: Project; instructions: string; key: string }): { workOrder: JobRunWorkOrder; events: NewEvent[] };
  /** 排队合并（76 号票，不追加）：这次运行又并进了几次触发，它的工单还排着就换成新的内容（已经开始的不动：并进来的是下一次的） */
  updateRun(workOrderId: string, instructions: string, key: string): NewEvent[];
  /** 定时作业的这次运行的活做完了（19 号票）：工单所在的这一段收尾，写回之后工单以 outcome 结束 */
  finishRun(workOrderId: string, outcome: WorkOrderOutcome, reason?: string): void;
  /** 定时作业暂停、取消了（19 号票，不追加）：这次运行的工单还排着就退回（附原因）；已经开始的照常做完 */
  dropRun(workOrderId: string, reason: string): NewEvent[];
  get(workOrderId: string): WorkOrder | undefined;
  /** 维护者手上这一段的工单（工单段的；对话段、没有段时没有） */
  currentWorkOrder(maintainerId: string): WorkOrder | undefined;
}

/**
 * 秘书的工具里项目系统给的那几样（secretary/tool-list.ts；装法在 projects/secretary-tools.ts）。先后是秘书看到的工具顺序
 * （测试比对它）：建议立项排在任务工具后面、查看板前面；其余五个接在查看板后面
 */
export interface SecretaryProjects {
  /** 建议立项（15 号票，suggest_project）：只出一张建议立项卡 */
  suggestTool(): HostTool;
  /** 查看板时多的一节"项目的服务"（133 号票）；没有要列的是 undefined */
  boardSection(): string | undefined;
  /**
   * 读项目档案（22）、给出服务入口（133：open_service）、启停项目的服务（257：switch_project_services）、调使用中的项目的操作
   * （260、268：project_ops）、提转入使用（259：propose_go_live，只出确认卡）：按这个先后
   */
  tools(): HostTool[];
}

/**
 * 从运行时已有的会话接管（290 号票，takeover/takeover.ts）要的：列项目（找二狗自己在管的会话）、按维护者找、接管成项目（不经秘书直接建出）、
 * 改写入锁（交还 / 收回；292 号票：交给官方 App，二狗自己开的会话第一次交出去时记下）、维护者的工作目录（292 号票：后台会话在那里开）
 */
export type TakeoverProjects = Pick<ProjectService, "list" | "maintainedBy" | "takeOver" | "setTakeover" | "workdir">;

// —— 4. 运营手段的类型（插件宿主的 ctx.operationMeans 登记口，130 号票，ADR-0028）——
export type { OperationMeans } from "../operations/means.ts";

// —— 5. 运营层要的（280 号票）——
export { OPERATIONS_CHANNEL, OPERATIONS_EVENTS, type OperationsDecidedPayload } from "../operations/events.ts";
export type { ProjectRecordsPaths } from "./records.ts";
