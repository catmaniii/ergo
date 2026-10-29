// 项目的维护者（规格第 3、11 节）：每个项目一个，会话频道 maintainer:<维护者 id>，里面的消息都带上所属的项目
// （做工单时还带上所属的任务；素材的"任务或项目"取自这里）。和任务的维护者一样直接用 AgentSession
// （conversation/agent-session.ts），只配置差异：
// - 平时休眠：工单开始、用户在它的会话里说话（或运行时给它一条通知）时唤起，闲置退出后再来输入时重新唤起；
// - 会话分段（16 号票，分段本身由派单器 work-orders/ 管）：每段一个新的 pi 会话，接哪个由当前这一段明确指定（会话的名字；
//   第一段对话段还没有这个会话时接着以前的会话，子进程报回接的是哪个，记进这一段）；
//   换段时等它手头这一条处理完，停掉子进程、按新的一段装配拉起（refresh）。只处理属于当前这一段的输入，别的留在队里；
//   闲置退出时告诉派单器（对话段在维护者闲置退出时结束）；
// - 装配按当前这一段和项目现在的样子：
//   - 对话段（含立项问答）：读写项目档案和工作目录，工具包按项目的（立项书确认前是 PLANNING_TOOLKIT：不带 bash，70 号票起能联网），"提交立项书"；
//   - 起草计划的工单段：和任务自己的维护者起草计划时一样只读（read、ls、grep、find），不带 bash、能联网（70 号票），"提交计划"；写回要的进展用
//     "写回进展"（write_progress），摘要用"写这一段的摘要"；调用不属于任务（按对话里的处置判）；
//   - 执行的工单段：和任务自己的维护者执行时是同一套装配（agent 宿主的执行，agent-host/assembly.ts），工具包是任务授权和
//     项目工具包的交集，围栏多了项目档案，另加"向派单方提问"、"写这一段的摘要"；
//   - 别的任务的维护者派来的工单段（改动，17 号票）：同一套装配（执行的 part），做的是任务的一部分——另加"交回执"，
//     不推进任务的阶段（没有推进任务的工具、提议并行、重注入块），守卫看到的当前阶段是工单所属的阶段；
//   - 项目内部的普通任务的工单段（75 号票）：和普通任务的 agent 同一套装配（宿主的普通任务），工具包是项目的，
//     另加"写这一段的摘要"；调用不属于任务（守卫按对话里的处置判，受对话审批的开关管），系统提示后面拼上 project-plain.md；
//   - 定时作业的一次运行的工单段（19 号票）：和作业自己的维护者同一套装配（宿主的一次运行），工具包是作业所在计划的
//     和项目工具包的交集（effectiveToolkit），另加"报告这次运行失败"、"写这一段的摘要"；调用不属于任务，守卫按作业的授权
//     （授权项、时序规则、本任务的关注类别）判，超出的照常先问；
//   每段的系统提示是项目维护者的那一段加上这一段开头的固定上下文（work-orders/fixed-context.ts）；
//   各段都有"写这一段的摘要"，工单段还有"向派单方提问"；执行的工单段另有子 agent 模块给的工具（20 号票：提议并行）；
//   装配每次唤起算一次（拉起参数、代为执行的工具、守卫都取这一份）；
// - 子 agent（20 号票）的装配从项目维护者执行时的装配收窄（登记进 agent 宿主的 assemblyOf，形状是 agent-host/assembly.ts 的 MaintainerAssembly）；
// - 项目的这些事实变了（立项书确认、开工）：按新的装配重新拉起（接着同一个会话）；执行的工单段里任务现在生效的计划的工具包
//   变了（14 号票：计划变更确认、自行调整计划之后）也一样；
// - 任务转为项目：不新建维护者，原任务的维护者由这里接过来（任务的维护者模块先放手，子进程结束后这里再拉起，
//   第一个对话段接着原会话）；
// - 删除项目（deletion.ts）：先停掉它、不再唤起（suspend）；删除中止了就恢复成能唤起（resume）；项目删掉之后再删会话区里
//   它的会话（removeSession）；
// - 范围审视（18 号票，scope-review/ 的 sessionScopeReview）：装配里带审视用的模型、对照物（立项书、这一段工单的任务计划、
//   审批卡上的批准、用户说的话）和近期范围记录；
//   压缩会话时子进程自己审视，结果存成范围记录；工单结束时派单器经 reviewScope 让它在子进程退出之前审视这一段。
// - 换模型（83 号票）：设置里改了项目维护者的模型，对话段里的下一条输入之前新开会话、附交接摘要（AgentSession 的 modelSwitch），
//   新会话的名字记进这一段；工单段做到一半不换。
// 27 号票：工具包（skill、MCP、bash、联网）落进会话（agent 宿主的装配），对话段另有"增减 skill"和
// "申请工具包变更"两个工具（执行的工单段的"增减 skill"由执行装配给）；这一段的工具包变了（用户在项目页改、批准了工具包变更卡、
// 维护者增减 skill，或者执行的任务的工具包变了）立即生效：维护者正在干活时等它做完手头这一步就按新工具包重新拉起、接着原会话干，
// 并告诉它"工具包已变更"（AgentSession.reassemble）；闲着、休眠时下次唤起按新工具包。
// 每次工具调用都经守卫。
// 114 号票（项目整页的 ⚙，agent-settings/）：系统提示带上用户给这个项目维护者单独写的提示词（设置跟着项目走：存在维护者名下，
// 重置维护者、换段之后照旧用），改了从下一轮起（手头这一条处理完按新的重新拉起）；"清空当前对话"就是重置维护者（16 号票：新开一段、
// 只凭项目档案重建理解）；"现在压缩"压当前这一段的会话（没有在进行的一段时不用压：下次说话会新开一段）；项目归档了面板只读。
// 127 号票起是 agent 宿主（agent-host/host.ts）的一种配置：每一段的装配经 host.assemble（对话段、起草计划、执行、普通任务、一次运行），
// 会话经 host.session（拉起参数、守卫收窄、范围审视、换模型和交接摘要、语音回复、斜杠命令在宿主里配好），工单结束时的范围审视经
// host.reviewSegment；这里只给项目的差异：哪一段、项目的工具包、围栏、系统提示和固定上下文、接哪个会话、跟着项目和任务变的地方。
import fs from "node:fs";
import {
  CHANNELS,
  emptyToolkit,
  EVENT_TYPES,
  MAINTAINER_CHANNEL_PREFIX,
  isJobRunWorkOrder,
  type JobRunWorkOrder,
  maintainerChannel,
  type MaintainerSegment,
  type PlanToolkit,
  type Project,
  type ProjectEventPayload,
  projectToolkit,
  runtimeIdOf,
  type SegmentEventPayload,
  type TaskEventPayload,
  type TaskWorkOrder,
  internalScopeLabel,
  type ProjectInternal,
  taskKind,
  isPlainTask,
  sameToolkit,
  canTellSecretary,
  tellSecretaryField,
  canSendAttachment,
  sendAttachmentField,
  toolkitChangedNotice,
  type WorkOrder,
  t,
} from "@ergo/protocol";
import { agentSessionDir } from "../agent-manager/agent-manager.ts";
import { RequestRejected } from "../errors.ts";
import { BUILTIN_TOOL_REGISTRY } from "../guard/index.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import { assembledTools, type ExecutionSetup, followExecutingTask, type JobRunAssembly, PLANNING_TOOLKIT } from "../agent-host/assembly.ts";
import type { AgentHost, HostedLaunch } from "../agent-host/host.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import type { AgentSession } from "../conversation/agent-session.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import type { NewEvent } from "../events/event-store.ts";
import { ownershipOf, type ScopeOwner } from "../scope-review/index.ts";
import { effectiveToolkit } from "../tasks/execution.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { realPathOf } from "../util/real-path.ts";
import { fixedContextText } from "../work-orders/fixed-context.ts";
import { submitReceiptTool } from "../work-orders/multi-project-tools.ts";
import { askClarificationTool, writeProgressTool, writeSegmentSummaryTool } from "../work-orders/tools.ts";
import type { WorkOrders } from "../work-orders/work-orders.ts";
import type { MaintainerSuspension } from "./deletion.ts";
import type { ProjectService } from "./projects.ts";
import { projectMaintainerSystemPrompt, projectPlainGuide, projectStandard, projectWorkflowGuide } from "./system-prompt.ts";
import { submitCharterTool } from "./tools.ts";
import { DOING_INTERNAL, DOING_PROJECT_CHAT, doingInternalRun, doingRunWorkOrder, doingTaskWorkOrder } from "../secretary/letter-texts.ts";
import { projectSender } from "../secretary/letters.ts";
import { runLabel } from "../scheduled-jobs/texts.ts";

/** 项目里决定维护者装配的那几项（类型、工作目录、工具包、立项书确认没有） */
const shapeOf = (project: Project) => JSON.stringify([project.kind, project.workdir, project.toolkit, project.charterConfirmed]);

/** 这张工单要照任务确认的计划做：执行的（16 号票）、别的任务的维护者派来的改动（17 号票）；起草计划的不是 */
const followsPlan = (wo: WorkOrder | undefined): wo is TaskWorkOrder => wo !== undefined && (wo.source === "task_maintainer" || wo.kind === "execute");

/**
 * 维护者在做的任务（执行的工单段、改动的工单段）现在生效的计划的工具包：计划变更确认、自行调整计划之后会变（14 号票），
 * 变了按新的装配重新拉起。别的段没有
 */
const executingToolkit = (options: ProjectMaintainersOptions, maintainerId: string): PlanToolkit | undefined => {
  const wo = options.workOrders.currentWorkOrder(maintainerId);
  return followsPlan(wo) ? options.host.tasks.confirmedPlan(wo.taskId)?.plan.toolkit : undefined;
};

/** 这些项目变化改了维护者的装配（项目类型、工作目录、工具包）：子进程按旧的装配拉起的，按新的装配重新拉起 */
const RESHAPING_CHANGES: ReadonlySet<ProjectEventPayload["change"]> = new Set(["charter_confirmed", "building_started", "toolkit_changed"]);

/** 任务的这些变化可能改了它现在生效的计划里的工具包（计划变更确认、自行调整计划、直接改工具包和增减 skill） */
const PLAN_CHANGES: ReadonlySet<TaskEventPayload["change"]> = new Set(["plan_changed", "plan_revised", "toolkit_changed"]);

/** 对话段的两个工具（27 号票，toolkit/ 给）；工具包里 skill、MCP 落进会话由 agent 宿主管 */
export interface ProjectToolkits {
  /** 对话段：维护者增减项目工具包里的 skill */
  projectSkillTool(projectId: string, maintainerId: string): HostTool;
  /** 对话段：申请开 bash、加 MCP、开联网（出"工具包变更"卡），减少能力 */
  requestTool(projectId: string, maintainerId: string): HostTool;
  /** 对话段、执行的工单段：登记 MCP（加、改、删一条登记，出"MCP 登记变更"卡，239 号票） */
  requestMcpTool?(projectId: string, maintainerId: string): HostTool;
}

/** 项目的维护者：agent 宿主（agent-host/host.ts）的一种配置，这里只给项目自己的差异 */
export interface ProjectMaintainersOptions {
  /** agent 宿主：装配、会话、系统提示、任务和执行控制器都从它取（127 号票） */
  host: AgentHost;
  projects: ProjectService;
  /** 派单器：工单和会话分段 */
  workOrders: WorkOrders;
  /** 任务的维护者模块：任务转为项目时先让它放手 */
  taskMaintainers: { release(maintainerId: string): Promise<void> };
  /** 项目的工具包变了、维护者正在执行某个任务：它的子 agent 按新的交集重新装配（20 号票的 subAgents.reassemble） */
  reassembleSubAgents?: (taskId: string) => void;
  /** 对话段里增减 skill、申请工具包变更的工具（27 号票） */
  toolkits?: ProjectToolkits;
  /**
   * 定时作业的一次运行的工单段（19 号票，定时作业模块给）：作业所在计划的工具包（和项目的再取交集）、给维护者的工具
   * （报告这次运行失败）、审批卡上的来源、守卫看到的作业的授权。没有这个作业时是 undefined
   */
  jobRun?: (wo: JobRunWorkOrder, maintainerId: string) => JobRunAssembly | undefined;
  layout: DataDirLayout;
  /**
   * 项目内部任务（64 号票）：对话段里发起任务的工具（start_workflow、create_task、suggest_task、write_task_brief，
   * tasks/internal-tools.ts）。立项书确认之后才有；不给就没有
   */
  internalTaskTools?: (scope: { projectId: string; maintainerId: string }) => HostTool[];
  /** 立项书确认之后改立项要求的工具（125 号票，propose_charter_change）：对话段、执行和改动的工单段都有；不给就没有 */
  charterChangeTool?: (projectId: string, maintainerId: string) => HostTool;
  /** 立项书确认之后改本项目规范的工具（261 号票，propose_standard_change）：对话段、执行和改动的工单段都有（同立项要求变更）；不给就没有 */
  standardChangeTool?: (projectId: string, maintainerId: string) => HostTool;
  /**
   * 交运营方案的工具（130 号票，propose_operations）：立项书确认之后，对话段、执行和改动的工单段都有（流程的工单段不给：不在步骤里）——
   * 建设期间做建设任务时就能交，使用中的项目在对话段里交；不给就没有
   */
  operationsTool?: (projectId: string, maintainerId: string) => HostTool;
  /**
   * 提转入使用的工具（259 号票，propose_go_live）：立项书确认之后，对话段、执行和改动的工单段都有（流程的工单段不给），只在建设中时
   * 收下——出"转入使用"确认卡，用户确认才转；不给就没有
   */
  goLiveTool?: (projectId: string, maintainerId: string) => HostTool;
  /** 验收运营接口清单的工具（268 号票，project-ops/ 的 check_ops）：改了 ops.json 看过没过，使用中的全过了登记成新的一版 */
  checkOpsTool?: (projectId: string, maintainerId: string) => HostTool;
}

export interface ProjectMaintainers extends MaintainerSuspension {
  /** 开始接输入：还有输入等着的项目维护者唤起 */
  start(): void;
  /**
   * 这个项目维护者此刻这一段的工具包里的 skill 名（82 号票：输入框里打 / 弹出的候选，和装配时一样现取：对话段是项目的，
   * 执行的工单段是任务授权和项目的交集）；不是项目的维护者时 undefined
   */
  skillsOf(maintainerId: string): readonly string[] | undefined;
  /**
   * 工单结束时的范围审视（18 号票，派单器在这一段结束之前调）：维护者的子进程审视这一段还没审视过的工作，返回要和这一段、
   * 工单的结束同一事务追加的事件（范围记录、时间线记录、越界通知；没做成的是一条说明）
   */
  reviewScope(segment: MaintainerSegment): Promise<NewEvent[]>;
  /**
   * MCP 登记变了（239 号票）：照工具包变更的样子，手头这一段处理完停掉子进程、下次按新的装配拉起（接着同一个会话），
   * notice 是告诉它的那句话。没有会话（还没唤起过）时什么都不用做
   */
  reassemble(maintainerId: string, notice: string): void;
  stop(): Promise<void>;
}

/** 项目维护者一段工作属于哪里（范围审视的归属）：项目，工单段里还有任务和工单；没有段时只有项目 */
function segmentOwner(workOrders: WorkOrders, project: Project, segment: MaintainerSegment | undefined): ScopeOwner {
  return {
    ownership: ownershipOf({ maintainerId: project.maintainerId, projectId: project.id, taskId: segment?.taskId, workOrderId: segment?.workOrderId }),
    scope: segment ? workOrders.scopeIn(segment) : { projectId: project.id },
  };
}

export function createProjectMaintainers(options: ProjectMaintainersOptions): ProjectMaintainers {
  const { host, projects, workOrders } = options;
  const { store } = host;
  const sessions = new Map<string, AgentSession>();
  /** 正在停下的会话（子进程结束后兑现）：同一个维护者的新会话等它停下再拉起 */
  const stopping = new Map<string, Promise<void>>();
  /** 正在删除的项目的维护者：不再唤起（删除中止时恢复） */
  const suspended = new Set<string>();
  /** 每个维护者在这里被唤起了几次（换段、重新装配也接着数）：模型按它给（测试的 faux 剧本） */
  const spawnCounts = new Map<string, number>();
  const nextSpawn = (maintainerId: string) => () => {
    const n = (spawnCounts.get(maintainerId) ?? 0) + 1;
    spawnCounts.set(maintainerId, n);
    return n;
  };
  /** 每个维护者现在的子进程是按哪一段、项目的什么样子、哪个工具包拉起的：换了段、项目的装配变了才重新拉起 */
  const spawnedFor = new Map<string, { segmentId: string | undefined; shape: string; toolkit: PlanToolkit }>();
  let unsubscribe: (() => void) | undefined;
  let offOwnPrompts: (() => void) | undefined;
  let stopped = false;

  /** 记下一个正在停下的会话，停下后清掉（同一个维护者后来又记了新的就不动） */
  const trackStopping = (maintainerId: string, done: Promise<void>): Promise<void> => {
    stopping.set(maintainerId, done);
    void done.finally(() => {
      if (stopping.get(maintainerId) === done) stopping.delete(maintainerId);
    });
    return done;
  };

  /** 停掉一个会话（马上不再接输入）；子进程结束后兑现 */
  const stopSession = (maintainerId: string): Promise<void> => {
    const session = sessions.get(maintainerId);
    if (!session) return stopping.get(maintainerId) ?? Promise.resolve();
    sessions.delete(maintainerId);
    return trackStopping(maintainerId, session.stop());
  };

  /** 有输入等着（或者以前彻底删除过、要改写会话文件）就把会话建起来 */
  const wake = (maintainerId: string) => {
    const conversation = maintainerChannel(maintainerId);
    if (pendingInputs(store.reader, conversation).length > 0 || startedInputs(store.reader, conversation).length > 0) sessionFor(maintainerId);
  };

  /** 这个维护者的会话（第一次用到时建好并开始接输入）；不是项目的维护者、项目删掉了时没有 */
  const sessionFor = (maintainerId: string): AgentSession | undefined => {
    if (stopped || suspended.has(maintainerId)) return undefined;
    const existing = sessions.get(maintainerId);
    if (existing) return existing;
    const project = projects.maintainedBy(maintainerId);
    if (!project) return undefined;
    spawnedFor.delete(maintainerId);
    const now = () => ({
      segmentId: workOrders.current(maintainerId)?.segmentId,
      shape: JSON.stringify([shapeOf(projects.maintainedBy(maintainerId) ?? project), executingToolkit(options, maintainerId)]),
      toolkit: segmentToolkit(options, projects.maintainedBy(maintainerId) ?? project),
    });
    const session = projectMaintainerSession(options, project, {
      nextSpawn: () => {
        spawnedFor.set(maintainerId, now());
        return nextSpawn(maintainerId)();
      },
      // 换了一段会话、项目的装配变了（立项书确认、开工）、在执行的任务的工具包变了（14 号票）：按新的一段、新的装配重新拉起
      outdated: () => {
        const spawned = spawnedFor.get(maintainerId);
        if (!spawned) return false;
        const current = now();
        return spawned.segmentId !== current.segmentId || spawned.shape !== current.shape;
      },
    });
    sessions.set(maintainerId, session);
    // 同一个维护者的旧会话（任务的维护者）还没停下：等它的子进程结束再开始
    const previous = stopping.get(maintainerId);
    if (previous) {
      void previous.then(() => {
        if (sessions.get(maintainerId) === session) session.start();
      });
    } else session.start();
    return session;
  };

  const onProjectEvent = ({ project, change }: ProjectEventPayload) => {
    if (change === "created" && project.fromTaskId !== undefined) {
      // 任务转为项目：任务的维护者模块先放手（马上不再接它的输入），子进程结束后这里接着原会话拉起
      void trackStopping(project.maintainerId, options.taskMaintainers.release(project.maintainerId));
      return;
    }
    if (!RESHAPING_CHANGES.has(change)) return;
    // 工具包变了（27 号票）：正在干活的做完手头这一步就按新工具包重新拉起、接着干
    toolkitMaybeChanged(project.maintainerId);
    // 子进程按旧的装配拉起的：下一条输入之前按新的装配重新拉起（outdated）。工作目录在立项书确认时由项目模块建好
    sessions.get(project.maintainerId)?.poke();
    // 正在执行的任务（执行的工单段）：工具包是交集，项目的变了，子 agent 跟着重新装配
    const wo = workOrders.currentWorkOrder(project.maintainerId);
    if (wo?.kind === "execute") options.reassembleSubAgents?.(wo.taskId);
  };

  /** 维护者会话里换了一段（开了新的一段、重置、收尾）：看一眼排着的输入（子进程按上一段拉起的，交下一条之前按新的一段重新拉起） */
  const onSegment = (maintainerId: string, { change }: SegmentEventPayload) => {
    const session = change === "opened" ? sessionFor(maintainerId) : sessions.get(maintainerId);
    session?.poke();
  };

  /**
   * 这一段的工具包和子进程拉起时的不一样了（27 号票）：正在干活的做完手头这一步就按新工具包重新拉起、接着干，
   * 闲着的停掉子进程，休眠的下次唤起按新的（AgentSession.reassemble）
   */
  const toolkitMaybeChanged = (maintainerId: string) => {
    const session = sessions.get(maintainerId);
    const spawned = spawnedFor.get(maintainerId);
    const project = projects.maintainedBy(maintainerId);
    if (!session || !spawned || !project) return;
    const toolkit = segmentToolkit(options, project);
    if (sameToolkit(toolkit, spawned.toolkit)) return;
    session.reassemble(toolkitChangedNotice(spawned.toolkit, toolkit, "这一段的工具包改了")); // @i18n-ignore model：交给维护者的通知
  };

  /**
   * 当前这一段的任务变了：暂停、取消时中止手头这一轮，换上最新的重注入块，看一眼排着的输入；计划里的工具包变了按新工具包重新装配。
   * 手上的工单是这个任务的：它自己执行的（16 号票）、涉及多个项目的任务的维护者派来的（17 号票，做的是任务的一部分，没有重注入块）
   */
  const onTask = ({ task, from, change }: TaskEventPayload) => {
    for (const [maintainerId, session] of sessions) {
      const mine = workOrders.current(maintainerId)?.taskId === task.id;
      if (mine) {
        followExecutingTask(session, workOrders.currentWorkOrder(maintainerId)?.source === "task_maintainer" ? undefined : host.execution, task, from, change);
        if (PLAN_CHANGES.has(change)) toolkitMaybeChanged(maintainerId);
      }
      if (mine || maintainerId === task.maintainerId) session.poke();
    }
  };

  /** 当前这一段执行的是维护者自己执行的任务（执行的工单段：单项目任务、项目内部任务；152 号票会话回退时任务跟着走）；不是的没有 */
  const executedTask = (maintainerId: string) => {
    const wo = workOrders.currentWorkOrder(maintainerId);
    if (!wo || isJobRunWorkOrder(wo) || wo.kind !== "execute") return undefined;
    const task = host.tasks.get(wo.taskId);
    return task?.maintainerId === maintainerId ? task : undefined;
  };

  // 登记进 agent 宿主：子 agent 要的此刻的装配（20 号票）、从某个阶段重做前停稳（84 号票）、项目整页的 ⚙（114 号票）都经宿主问
  host.attach({
    /**
     * 执行这个任务的项目维护者此刻的装配（20 号票：子 agent 从它收窄）：只在维护者手上是这个任务的执行工单段时有；
     * 任务自己的维护者的由任务的维护者模块登记
     */
    assemblyOf(taskId) {
      const task = host.tasks.get(taskId);
      const project = task && projects.projectOf(task);
      const wo = project && workOrders.currentWorkOrder(project.maintainerId);
      if (!project || !wo || isJobRunWorkOrder(wo) || wo.taskId !== taskId) return undefined;
      const now = assemble(options, project);
      return now.executing ? now.setup.assembly : undefined;
    },
    /**
     * 停稳手上是这个任务的工单的项目维护者手头这一轮（见 AgentSession.stopTurn；单项目任务的执行者，涉及多个项目的任务派出的工单
     * 在做的，一起停）：没有维护者手上是这个任务的工单段时 undefined
     */
    async stopTaskTurn(task, how) {
      // 手上是这个任务的工单的都停（涉及多个项目的任务可能同时在几个项目维护者那里做）
      const mine = [...sessions].filter(([maintainerId]) => workOrders.current(maintainerId)?.taskId === task.id).map(([, session]) => session);
      if (mine.length === 0) return undefined;
      const held = await Promise.all(mine.map((session) => session.stopTurn(how.timeoutMs, how.reason)));
      return () => held.forEach(({ release }) => release());
    },
    /** 项目整页的 ⚙（114 号票）：不是项目的维护者、项目删掉了时 undefined */
    agentHandle(maintainerId) {
      const project = projects.maintainedBy(maintainerId);
      if (!project) return undefined;
      const now = () => projects.maintainedBy(maintainerId) ?? project;
      const conversation = maintainerChannel(maintainerId);
      return {
        agentId: maintainerId,
        kind: "project",
        label: t("projects.maintainer.label", { name: project.name }),
        template: "project-maintainer",
        readOnly: project.state === "archived" ? t("projects.maintainer.readOnly") : undefined,
        systemPrompt: () => assemble(options, now()).launch.systemPrompt,
        clearKind: "reset_maintainer",
        // 清空就是重置维护者（16 号票）：当前这段直接结束、新开一段，进行中的工单在新的一段接着做；幂等键照重置维护者的
        clear: (key) => void projects.resetMaintainer(project.id, `agent-clear:${key}`),
        compact: () => sessionFor(maintainerId)?.compactNow(),
        cannotCompact: () => (workOrders.current(maintainerId) ? undefined : t("projects.maintainer.cannotCompact")),
        // 这一段会话从这一段开始时算起（工单段、对话段、重置开的段都是新会话）；上一次清空就是上一次重置维护者
        since: () => {
          const opened = store.read(conversation, 0, EVENT_TYPES.segment).filter((e) => (e.payload as SegmentEventPayload).change === "opened");
          const last = opened.at(-1);
          const reset = opened.findLast((e) => (e.payload as SegmentEventPayload).segment.reset);
          return { seq: last?.globalSeq ?? 0, ...(reset ? { clearedAt: (reset.payload as SegmentEventPayload).segment.openedAt } : {}) };
        },
        panel: () => sessions.get(maintainerId)?.panel,
        stopReply: () => sessions.get(maintainerId)?.stopReply() ?? false,
        // 会话回退（152 号票）：只在当前这一段里（工单段、对话段，用户定的第 5 条）；这一段执行的是它自己执行的任务（单项目任务、
        // 项目内部的长程任务）时，任务的阶段、计划跟着保留的分支推导。别的任务派来的工单（涉及多个项目的任务的一部分）、定时触发的
        // 一次运行只回退会话：任务的状态归派单的维护者、触发登记管
        rollback: {
          agentId: maintainerId,
          navigate: (request, commit) => {
            const session = sessionFor(maintainerId);
            if (!session) throw new RequestRejected("not_allowed", t("projects.maintainer.gone"));
            return session.navigateSession(request, commit);
          },
          effectTools: () => sessionFor(maintainerId)?.effectTools() ?? BUILTIN_TOOL_REGISTRY,
          refusal: () => {
            if (!workOrders.current(maintainerId)) return t("projects.maintainer.segmentEnded");
            const task = executedTask(maintainerId);
            return task ? host.execution.sessionFollowRefusal(task.id) : undefined;
          },
          follow: (input) => {
            const task = executedTask(maintainerId);
            return task ? host.execution.followSession({ ...input, taskId: task.id }) : undefined;
          },
        },
        // 单独配模型（120 号票）：盖过项目维护者那一行；下一张工单、下一个对话段起用，对话段里下一条消息时换
        model: { agent: "project_maintainer", switchAt: "next_segment" },
        // 运行时（289 号票）：没写的照转来的任务的；换运行时等手头这一条做完、原来的写交接摘要，换完才记进项目；只改选的值从下一轮起
        runtime: {
          current: () => {
            const p = now();
            return { id: runtimeIdOf(p.runtime ?? (p.fromTaskId === undefined ? undefined : host.tasks.get(p.fromTaskId)?.runtime)), options: p.runtimeOptions };
          },
          switchTo: (to, chosen) => sessionFor(maintainerId)?.switchRuntime(to, chosen),
          setOptions: (chosen) => {
            const p = now();
            projects.setRuntime(p.id, p.runtime ?? (p.fromTaskId === undefined ? undefined : host.tasks.get(p.fromTaskId)?.runtime), chosen);
            sessions.get(maintainerId)?.refresh();
          },
          // 接管来的（290 号票）：还用那个运行时才算；工作目录是会话原来的（项目的外部工作目录）
          takeover: () => {
            const p = now();
            return p.takeover && p.takeover.runtime === runtimeIdOf(p.runtime) ? { takeover: p.takeover, cwd: projects.workdir(p) } : undefined;
          },
          // 305 号票：维护者的工作目录（新建时选的文件夹、立项书绑定的外部路径，或者项目档案里的）
          workdir: () => projects.workdir(now()),
        },
      };
    },
  });

  return {
    start() {
      unsubscribe = store.onAppend((event) => {
        if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) return onProjectEvent(event.payload as ProjectEventPayload);
        if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) return onTask(event.payload as TaskEventPayload);
        if (!event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) return;
        const maintainerId = event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length);
        if (event.type === EVENT_TYPES.segment) return onSegment(maintainerId, event.payload as SegmentEventPayload);
        // 交给维护者的输入（用户说的话、运行时的通知）进了它的会话，或者会话里有消息被彻底删除了：建好它的会话
        if (event.type === EVENT_TYPES.message || event.type === EVENT_TYPES.messagesPurged) sessionFor(maintainerId);
      });
      // 在项目的 ⚙ 里改了维护者单独的提示词（114 号票）：手头这一条处理完按新的重新拉起（休眠的下次唤起自然按新的）
      offOwnPrompts = host.prompts.onAgentChange((maintainerId) => sessions.get(maintainerId)?.refresh());
      // 守护进程重启前还有输入没处理完的
      for (const project of projects.list()) wake(project.maintainerId);
    },
    async suspend(maintainerId) {
      suspended.add(maintainerId);
      await stopSession(maintainerId);
    },
    resume(maintainerId) {
      if (!suspended.delete(maintainerId)) return;
      wake(maintainerId);
    },
    skillsOf(maintainerId) {
      const project = projects.maintainedBy(maintainerId);
      return project && segmentToolkit(options, project).skills;
    },
    reassemble(maintainerId, notice) {
      sessions.get(maintainerId)?.reassemble(notice);
    },
    async reviewScope(segment) {
      const session = sessionFor(segment.maintainerId);
      const project = projects.maintainedBy(segment.maintainerId);
      if (!session || !project) return [];
      // 这一段（派单器交来的）的归属：项目、任务和工单
      return host.reviewSegment(session, segmentOwner(workOrders, project, segment));
    },
    removeSession(maintainerId) {
      // 项目已删除、子进程已经结束：会话也删掉
      fs.rmSync(agentSessionDir(options.layout, maintainerId), { recursive: true, force: true });
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      offOwnPrompts?.();
      await Promise.all([...[...sessions.keys()].map((id) => stopSession(id)), ...stopping.values()]);
    },
  };
}

/** 项目档案里一个文档的内容（没有就是空的） */
const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** 真实路径（取不到就原样）：守卫比较路径用真实路径 */
const real = (p: string) => realPathOf(p) ?? p;

/** 项目维护者一次唤起的装配：宿主给的这一段的装配，拉起参数里自己定的（工作目录、系统提示、接哪个会话） */
interface ProjectAssembly {
  setup: ExecutionSetup;
  launch: Omit<HostedLaunch, "setup" | "spawn">;
  /** 是不是执行的工单段（只有它能派子 agent） */
  executing: boolean;
  /** 按哪一段拉起的 */
  segmentId: string | undefined;
}

/**
 * 起草计划的工单段、立项书确认之前的对话段的工具包：同任务自己的维护者起草时（PLANNING_TOOLKIT，没有 skill、MCP），
 * 给秘书发消息跟着项目的开关（102 号票：项目里关掉了，这一段的工具包也就变了，照 27 号票重新装配、守卫按它收窄），发附件也是（117 号票）
 */
const draftingToolkit = (project: Project): PlanToolkit => ({
  skills: [],
  mcp: [],
  ...PLANNING_TOOLKIT,
  ...tellSecretaryField(canTellSecretary(projectToolkit(project))),
  ...sendAttachmentField(canSendAttachment(projectToolkit(project))),
});

/**
 * 维护者当前这一段的工具包：执行的工单段是任务授权和项目工具包的交集（现在生效的计划），一次运行（19 号票的定时作业，76 号票起
 * 是定时触发的任务的每次运行）是授权的计划的和项目工具包的交集（定时触发的普通任务是项目的），起草计划的工单段和任务自己的维护者起草时一样（PLANNING_TOOLKIT：不带 bash，70 号票起能联网），
 * 对话段是项目的（立项书确认之前同起草计划时）
 */
function segmentToolkit(options: ProjectMaintainersOptions, project: Project): PlanToolkit {
  const { tasks } = options.host;
  const wo = options.workOrders.currentWorkOrder(project.maintainerId);
  if (!wo) return project.charterConfirmed ? projectToolkit(project) : draftingToolkit(project);
  if (isJobRunWorkOrder(wo)) {
    // 76 号票：定时触发的普通任务（项目内部的）每次运行和项目内部的普通任务一样，工具包就是项目的
    const run = options.jobRun?.(wo, project.maintainerId);
    return run && run.toolkit === undefined ? projectToolkit(project) : effectiveToolkit(run?.toolkit ?? emptyToolkit(), projectToolkit(project));
  }
  // 项目内部的普通任务（75 号票）：没有计划，项目的维护者在这个项目里能用什么就是什么
  if (plainTask(tasks, wo.taskId)) return projectToolkit(project);
  // 执行的工单段、别的任务的维护者派来的改动（17 号票）：任务授权和项目工具包的交集；起草计划的同任务自己的维护者起草时
  const confirmed = followsPlan(wo) ? tasks.confirmedPlan(wo.taskId) : undefined;
  return confirmed ? effectiveToolkit(confirmed.plan.toolkit, projectToolkit(project)) : draftingToolkit(project);
}

/** 这个任务是普通任务（75 号票：项目内部的普通任务由项目的维护者在执行的工单段里直接做） */
function plainTask(tasks: Pick<TaskService, "get">, taskId: string): boolean {
  const task = tasks.get(taskId);
  return task !== undefined && isPlainTask(task);
}

/** 这个任务是流程（58 号票；64 号票起项目的维护者也起草、执行流程） */
function workflowTask(tasks: Pick<TaskService, "get">, taskId: string): boolean {
  const task = tasks.get(taskId);
  return task !== undefined && taskKind(task) === "workflow";
}

/**
 * 审批卡、"交给我做"事项上的来源：项目「X」· 任务「T」；项目内部任务写明"项目「X」内部"，这些事项带上标记（64 号票：秘书看不到细节）
 */
function taskWoOrigin(tasks: Pick<TaskService, "get">, project: Project, wo: TaskWorkOrder): { source: string; internal?: ProjectInternal } {
  const internal = tasks.get(wo.taskId)?.internal;
  return internal
    ? { source: t("projects.source.internalTask", { scope: internalScopeLabel(project.name), task: wo.taskTitle }), internal }
    : { source: t("projects.source.projectTask", { name: project.name, task: wo.taskTitle }) };
}

/** 项目维护者此刻的装配（经 agent 宿主）：按当前这一段和项目现在的样子 */
function assemble(options: ProjectMaintainersOptions, first: Project): ProjectAssembly {
  const { workOrders, host } = options;
  const { tasks } = host;
  const maintainerId = first.maintainerId;
  const p = options.projects.get(first.id) ?? first;
  const paths = options.projects.records(p.id);
  const workdir = options.projects.workdir(p);
  fs.mkdirSync(workdir, { recursive: true });
  const cwd = real(workdir);
  const projectRecords = [real(paths.root)];
  const development = p.kind === "dev";
  const segment = workOrders.current(maintainerId);
  const wo = workOrders.currentWorkOrder(maintainerId);
  const summary = writeSegmentSummaryTool(workOrders, maintainerId);
  // 任务的工单（起草计划、执行）；定时作业的一次运行另走一支
  const taskWo = wo && !isJobRunWorkOrder(wo) ? wo : undefined;
  // 给秘书发消息时信上写的（102 号票）：项目的维护者，这一段在做什么（项目内部的不写是哪件事：秘书看不到项目内部的细节）
  const channel = maintainerChannel(maintainerId);
  const internalTask = taskWo !== undefined && tasks.get(taskWo.taskId)?.internal !== undefined;
  const taskSenderOf = () => projectSender(p, channel, taskWo === undefined ? undefined : internalTask ? DOING_INTERNAL : doingTaskWorkOrder(taskWo));
  // 现在生效的计划（14 号票：计划变更提出的一版在确认之前不算）
  const confirmed = followsPlan(wo) ? tasks.confirmedPlan(wo.taskId) : undefined;
  // 别的任务的维护者派来的改动（17 号票）：做的是任务的一部分（所属阶段），不推进任务的阶段
  const part = wo?.source === "task_maintainer" ? { stageId: wo.stageId } : undefined;
  // 执行的工单段（只有它能派子 agent）
  const executing = wo !== undefined && confirmed !== undefined && part === undefined;
  // 这一段的工具包；每一段都有的：围栏（项目档案、工作目录）、开发类按立项书的项目类型（16 号票）。
  // 临时文件按项目认（111 号票，用户补充"任务和项目的临时文件都是一样的"）：不论这一段在做什么——直接和用户对话、起草计划、执行、
  // 做别的任务的一部分、内部的普通任务、定时运行——项目开始之后生成的、不是交付件的都可以改、删（前几段建的靠创建时间认出来）
  const toolkit = segmentToolkit(options, p);
  const base = { maintainer: "project", agentId: maintainerId, cwd, toolkit, projectRecords, development, ownWork: () => host.execution.projectOwnWork(p.id) } as const;

  let setup: ExecutionSetup;
  if (wo && isJobRunWorkOrder(wo)) {
    // 定时作业的一次运行（19 号票）：和作业自己的维护者同一套装配，工具包是作业所在计划的和项目工具包的交集，守卫按作业的授权判
    const run = options.jobRun?.(wo, maintainerId);
    const label = runLabel({ runId: wo.runId });
    setup = host.assemble({
      ...base,
      session: "run",
      source: run?.source ?? t("projects.source.projectOrder", { name: p.name, order: wo.title }),
      // 项目内部任务的计划里定的作业（64 号票）
      internal: run?.internal,
      segmentId: `${maintainerId}:${segment?.segmentId ?? wo.id}`,
      tools: [...(run?.tools ?? []), summary],
      ...(run ? { guardTask: run.guardTask, shellEnv: run.shellEnv } : {}),
      sender: projectSender(p, channel, run?.internal ? doingInternalRun(label) : doingRunWorkOrder(wo, label)),
    });
  } else if (taskWo && wo?.source === "user_task" && plainTask(tasks, taskWo.taskId)) {
    // 项目内部的普通任务（75 号票）：直接做，工具包是项目的；调用不属于任务（按对话里的处置判），效果日志和时序规则按这一段划范围
    setup = host.assemble({
      ...base,
      session: "plain",
      ...taskWoOrigin(tasks, p, taskWo),
      segmentId: `${maintainerId}:${segment?.segmentId ?? wo.id}`,
      tools: [summary],
      sender: taskSenderOf(),
    });
  } else if (taskWo && (confirmed || part)) {
    // 执行的工单段、改动的工单段：和任务自己的维护者执行时同一套装配，工具包是任务授权和项目工具包的交集
    // 流程（64 号票起项目的维护者也执行流程）：推进它的是 report_step；执行中每次调用都和计划比对，写项目档案不在步骤里，
    // 进展经代为执行的 write_progress 写回（不算步骤，不比）
    const workflow = !part && workflowTask(tasks, taskWo.taskId);
    setup = host.assemble({
      ...base,
      session: "execution",
      taskId: taskWo.taskId,
      ...taskWoOrigin(tasks, p, taskWo),
      extraTools: [
        ...(part ? [submitReceiptTool(workOrders, maintainerId)] : []),
        ...(workflow ? [writeProgressTool(options.projects, workOrders, maintainerId)] : []),
        askClarificationTool(workOrders, maintainerId),
        summary,
        // 立项要求变更（125 号票）：做工单时用户说要改立项要求，照样提（流程不给：不在步骤里，会被当成计划外的操作）
        ...(p.charterConfirmed && !workflow && options.charterChangeTool ? [options.charterChangeTool(p.id, maintainerId)] : []),
        // 规范改写（261 号票）：同上
        ...(p.charterConfirmed && !workflow && options.standardChangeTool ? [options.standardChangeTool(p.id, maintainerId)] : []),
        // 运营方案（130 号票）：建设期间做建设任务时就交，收尾前交上来（流程不给，同上）
        ...(p.charterConfirmed && !workflow && options.operationsTool ? [options.operationsTool(p.id, maintainerId)] : []),
        // 提转入使用（259 号票）：建设做到能用了就提，出确认卡（流程不给，同上）
        ...(p.charterConfirmed && !workflow && options.goLiveTool ? [options.goLiveTool(p.id, maintainerId)] : []),
        // 验收运营接口清单（268 号票）：开发类边建边写 ops.json，写了就验（流程不给，同上）
        ...(p.charterConfirmed && !workflow && options.checkOpsTool ? [options.checkOpsTool(p.id, maintainerId)] : []),
        // 登记 MCP（239 号票）：做任务时也能提，出卡等用户确认（流程不给，同上）
        ...(p.charterConfirmed && !workflow && options.toolkits?.requestMcpTool ? [options.toolkits.requestMcpTool(p.id, maintainerId)] : []),
      ],
      ...(part ? { part } : {}),
      workflow,
      sender: taskSenderOf(),
    });
  } else if (taskWo) {
    // 起草计划的工单段：只读（同任务自己的维护者起草计划时），进展经"写回进展"写；调用不属于任务（按对话里的处置判），
    // 效果日志和时序规则按这一段划范围。流程的计划审查时，守卫眼里的维护者和执行时一样（工作目录、围栏里的项目档案、项目的工具包）
    setup = host.assemble({
      ...base,
      session: "planning",
      taskId: taskWo.taskId,
      ...taskWoOrigin(tasks, p, taskWo),
      segmentId: `${maintainerId}:${segment?.segmentId ?? "chat"}`,
      executor: { cwd, projectRecords, projectToolkit: projectToolkit(p) },
      extraTools: [writeProgressTool(options.projects, workOrders, maintainerId), askClarificationTool(workOrders, maintainerId), summary],
      sender: taskSenderOf(),
    });
  } else {
    // 对话段（含立项问答）：工具包按项目的，工具包里的 skill、MCP，增减 skill、申请工具包变更（立项书确认之后才有工具包可改）；
    // 立项书确认之后还能在项目里发起内部任务（64 号票：用户点明了才建，没点明最多给一张建议卡）、改立项要求（125 号票：立项问答里照旧交整份立项书）、
    // 交运营方案（130 号票）
    const confirmedCharter = p.charterConfirmed;
    setup = host.assemble({
      ...base,
      session: "chat",
      source: t("projects.source.project", { name: p.name }),
      segmentId: `${maintainerId}:${segment?.segmentId ?? "chat"}`,
      tools: [
        submitCharterTool(options.projects, { projectId: p.id, maintainerId }),
        ...(confirmedCharter && options.charterChangeTool ? [options.charterChangeTool(p.id, maintainerId)] : []),
        // 规范改写（261 号票）：用户说这个项目不要某一份、换写法、多一份、跟新版规范时出卡
        ...(confirmedCharter && options.standardChangeTool ? [options.standardChangeTool(p.id, maintainerId)] : []),
        // 运营方案（130 号票）：用户在会话里点明"建个定时任务""改成每天 7 点"时出卡
        ...(confirmedCharter && options.operationsTool ? [options.operationsTool(p.id, maintainerId)] : []),
        // 提转入使用（259 号票）：用户说"可以上线了"、维护者觉得建好了时出确认卡
        ...(confirmedCharter && options.goLiveTool ? [options.goLiveTool(p.id, maintainerId)] : []),
        // 验收运营接口清单（268 号票）：使用中改了 ops.json 用它验，全过了登记成新的一版
        ...(confirmedCharter && options.checkOpsTool ? [options.checkOpsTool(p.id, maintainerId)] : []),
        summary,
        ...(confirmedCharter && options.internalTaskTools ? options.internalTaskTools({ projectId: p.id, maintainerId }) : []),
      ],
      after:
        confirmedCharter && options.toolkits
          ? [options.toolkits.projectSkillTool(p.id, maintainerId), options.toolkits.requestTool(p.id, maintainerId), ...(options.toolkits.requestMcpTool ? [options.toolkits.requestMcpTool(p.id, maintainerId)] : [])]
          : [],
      sender: projectSender(p, channel, DOING_PROJECT_CHAT),
    });
  }
  const { assembly } = setup;
  const fixed = segment
    ? fixedContextText({
        segment,
        standard: projectStandard(host.prompts),
        // 261 号票：本项目的规范改写、有没有新版
        projectStandard: options.projects.standard(p.id),
        toolkit,
        // 这一段能用的工具：和守卫看到的同一份
        tools: assembledTools(assembly),
        records: { spec: read(paths.spec), progress: read(paths.progress), glossary: read(paths.glossary) },
        previous: workOrders.previous(maintainerId),
        workOrder: wo,
      })
    : undefined;
  // 这一段的工单是流程（64 号票）：系统提示另加流程的工作方式（固定计划的那一套，和任务自己的维护者同一份）
  const workflowSegment = taskWo !== undefined && wo?.source === "user_task" && workflowTask(tasks, taskWo.taskId);
  // 这一段的工单是项目内部的普通任务（75 号票）：系统提示另加普通任务的做法
  const plainSegment = taskWo !== undefined && wo?.source === "user_task" && plainTask(tasks, taskWo.taskId);
  return {
    setup,
    launch: {
      cwd,
      systemPrompt: [
        projectMaintainerSystemPrompt(host.prompts, p, paths, cwd, host.thresholds, maintainerId),
        ...(workflowSegment ? [projectWorkflowGuide(host.prompts)] : []),
        ...(plainSegment ? [projectPlainGuide(host.prompts)] : []),
        ...(fixed ? [fixed] : []),
      ].join("\n\n"),
      // 接当前这一段的会话（按名字明确指定，不靠修改时间）；第一段对话段还没有这个会话时接着以前的会话（子进程报回接的是哪个）。
      // 没有在进行的段时不会有输入要处理（accepts 只认当前段的），万一拉起了也开一个新会话，不去猜接哪个
      ...(segment ? { session: segment.session, continueSession: segment.continueEarlier === true } : { continueSession: false }),
    },
    executing,
    segmentId: segment?.segmentId,
  };
}

/** 一个项目维护者的会话（agent 宿主的一种配置）：按当前这一段和项目现在的样子装配 */
function projectMaintainerSession(options: ProjectMaintainersOptions, first: Project, hooks: { nextSpawn: () => number; outdated: () => boolean }): AgentSession {
  const { workOrders, host } = options;
  const maintainerId = first.maintainerId;
  /** 这次唤起是按哪一段拉起的（子进程报回它打开的会话时记进这一段） */
  let spawnedSegment: string | undefined;
  /** 此刻这段工作的归属（范围审视：工单段里带上任务和工单） */
  const owner = () => segmentOwner(workOrders, options.projects.maintainedBy(maintainerId) ?? first, workOrders.current(maintainerId));

  return host.session({
    maintainer: "project",
    agentId: maintainerId,
    // 会话里的消息属于当前这一段：项目，做工单时还有所属的任务。用量（24 号票）按正在处理的那条输入记：
    // 工单段里交给它的输入带着任务，记在任务名下；对话段记在项目名下
    scope: () => workOrders.scopeOf(maintainerId) ?? { projectId: first.id },
    setup: () => assemble(options, first).setup,
    launch: () => {
      const now = assemble(options, first);
      spawnedSegment = now.segmentId;
      // 模型按这个维护者在这里被唤起的次数取（换段、重新装配、会话重建都接着数）
      return { setup: now.setup, ...now.launch, spawn: hooks.nextSpawn() };
    },
    // 范围审视（18 号票）：压缩时子进程自己做的存成范围记录（归属是这时的这一段）
    scopeOwner: owner,
    // 子进程报回它打开的是哪个会话：第一段对话段接着以前的会话时记进这一段
    onReady: ({ session }) => {
      if (spawnedSegment !== undefined) workOrders.recordSession(maintainerId, spawnedSegment, session);
    },
    outdated: hooks.outdated,
    // 守卫每次判定按这一段此刻的工具包收窄（27 号票）
    toolkitNow: () => segmentToolkit(options, options.projects.get(first.id) ?? first),
    // 只处理属于当前这一段的输入（别的留在队里）
    accepts: (input) => workOrders.accepts(maintainerId, input),
    onIdleExit: () => workOrders.idleExited(maintainerId),
    interruptedNote: (quoted) => t(quoted ? "projects.maintainer.interruptedQuoted" : "projects.maintainer.interrupted", { quoted }),
    // 换模型就新开会话、附交接摘要（83 号票）：只在对话段里换（第一段对话段接着以前的长会话、重启后接着这一段时都算）；
    // 工单段（起草计划、执行任务、定时作业的一次运行）做到一半不换，下一段本来就是新会话、用新的模型。
    // 换到的新会话由子进程报回、onReady 记进这一段，之后按它接
    switchModel: () => workOrders.current(maintainerId)?.kind === "chat",
  });
}
