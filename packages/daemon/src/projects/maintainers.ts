// 项目的维护者（规格第 3、11 节）：每个项目一个，会话频道 maintainer:<维护者 id>，里面的消息都带上所属的项目
// （做工单时还带上所属的任务；素材的"任务或项目"取自这里）。和任务的维护者一样直接用 AgentSession
// （conversation/agent-session.ts），只配置差异：
// - 平时休眠：工单开始、用户在它的会话里说话（或运行时给它一条通知）时唤起，闲置退出后再来输入时重新唤起；
// - 会话分段（16 号票，分段本身由派单器 work-orders/ 管）：每段一个新的 pi 会话，接哪个由当前这一段明确指定（会话的名字；
//   第一段对话段还没有这个会话时接着以前的会话，子进程报回接的是哪个，记进这一段）；
//   换段时等它手头这一条处理完，停掉子进程、按新的一段装配拉起（refresh）。只处理属于当前这一段的输入，别的留在队里；
//   闲置退出时告诉派单器（对话段在维护者闲置退出时结束）；
// - 装配按当前这一段和项目现在的样子：
//   - 对话段（含立项问答）：读写项目档案和工作目录，工具包按项目的（立项书确认前不带 bash、不联网），"提交立项书"；
//   - 起草计划的工单段：和任务自己的维护者起草计划时一样只读（read、ls），不带 bash、不联网，"提交计划"；写回要的进展用
//     "写回进展"（write_progress），摘要用"写这一段的摘要"；调用不属于任务（按对话里的处置判）；
//   - 执行的工单段：和任务自己的维护者执行时是同一套装配（maintainers/assembly.ts 的 executionSetup），工具包是任务授权和
//     项目工具包的交集，围栏多了项目档案，另加"向派单方提问"、"写这一段的摘要"；
//   每段的系统提示是项目维护者的那一段加上这一段开头的固定上下文（work-orders/fixed-context.ts）；
//   各段都有"写这一段的摘要"，工单段还有"向派单方提问"；执行的工单段另有子 agent 模块给的工具（20 号票：提议并行）；
//   装配每次唤起算一次（拉起参数、代为执行的工具、守卫都取这一份）；
// - 子 agent（20 号票）的装配从项目维护者执行时的装配收窄（assemblyOf，形状是 maintainers/assembly.ts 的 MaintainerAssembly）；
// - 项目的这些事实变了（立项书确认、开工）：按新的装配重新拉起（接着同一个会话）；执行的工单段里任务现在生效的计划的工具包
//   变了（14 号票：计划变更确认、自行调整计划之后）也一样；
// - 任务转为项目：不新建维护者，原任务的维护者由这里接过来（任务的维护者模块先放手，子进程结束后这里再拉起，
//   第一个对话段接着原会话）；
// - 删除项目（deletion.ts）：先停掉它、不再唤起（suspend）；删除中止了就恢复成能唤起（resume）；项目删掉之后再删会话区里
//   它的会话（removeSession）。
// 每次工具调用都经守卫。
import fs from "node:fs";
import {
  CHANNELS,
  emptyToolkit,
  EVENT_TYPES,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessagesPurgedEventPayload,
  type PlanToolkit,
  type Project,
  type ProjectEventPayload,
  projectToolkit,
  type SegmentEventPayload,
  type TaskEventPayload,
} from "@ergou/protocol";
import { agentSessionDir, type AgentManager } from "../agent-manager/agent-manager.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import { AgentSession, type AgentSessionSpawn, type AgentVoiceReplies } from "../conversation/agent-session.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import { assembledTools, conversationTools, type ExecutionSetup, executionSetup, followExecutingTask, type MaintainerAssembly, maintainerGuardAgent } from "../maintainers/assembly.ts";
import { PLANNING_PI_TOOLS } from "../maintainers/maintainers.ts";
import { submitPlanTool } from "../maintainers/tools.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import { effectiveToolkit, type MaintainerScope, type TaskExecution } from "../tasks/execution.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { TaskThresholds } from "../tasks/thresholds.ts";
import type { TypedShell } from "../typed-shell/index.ts";
import { realPathOf } from "../util/real-path.ts";
import { fixedContextText } from "../work-orders/fixed-context.ts";
import { askClarificationTool, writeProgressTool, writeSegmentSummaryTool } from "../work-orders/tools.ts";
import type { WorkOrders } from "../work-orders/work-orders.ts";
import type { MaintainerSuspension } from "./deletion.ts";
import type { ProjectService } from "./projects.ts";
import { projectMaintainerSystemPrompt } from "./system-prompt.ts";
import { submitCharterTool } from "./tools.ts";

/** 项目维护者对话段的 pi 内置工具：读写项目档案和工作目录；工具包带 bash 时加上 bash */
export const PROJECT_MAINTAINER_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls];

/** 项目里决定维护者装配的那几项（类型、工作目录、工具包、立项书确认没有） */
const shapeOf = (project: Project) => JSON.stringify([project.kind, project.workdir, project.toolkit, project.charterConfirmed]);

/**
 * 维护者在执行的任务（执行的工单段）现在生效的计划的工具包：计划变更确认、自行调整计划之后会变（14 号票），
 * 变了按新的装配重新拉起。别的段没有
 */
const executingToolkit = (options: Pick<ProjectMaintainersOptions, "workOrders" | "tasks">, maintainerId: string): PlanToolkit | undefined => {
  const wo = options.workOrders.currentWorkOrder(maintainerId);
  return wo?.kind === "execute" ? options.tasks.confirmedPlan(wo.taskId)?.plan.toolkit : undefined;
};

/** 这些项目变化改了维护者的装配（项目类型、工作目录、工具包）：子进程按旧的装配拉起的，按新的装配重新拉起 */
const RESHAPING_CHANGES: ReadonlySet<ProjectEventPayload["change"]> = new Set(["charter_confirmed", "building_started"]);

export interface ProjectMaintainersOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  guards: GuardRuntime;
  media: MediaStore;
  projects: ProjectService;
  /** 任务（项目的维护者起草计划、执行的那些） */
  tasks: TaskService;
  /** 任务执行（执行的工单段：阶段的工具、守卫看到的任务、重注入块） */
  execution: TaskExecution;
  /** 派单器：工单和会话分段 */
  workOrders: WorkOrders;
  /** 带类型的 bash 工具（28）：这一段的工具包开了 bash 时随之出现 */
  typedShell: TypedShell;
  /** 系统提示里给维护者讲的阈值（14 号票：执行时和任务自己的维护者一样） */
  thresholds: TaskThresholds;
  /** 任务的维护者模块：任务转为项目时先让它放手 */
  taskMaintainers: { release(maintainerId: string): Promise<void> };
  /** 执行的工单段另给维护者的工具（20 号票：提议并行），绑定在它执行的任务上 */
  subAgentTools?: (scope: MaintainerScope) => HostTool[];
  /** 项目的工具包变了、维护者正在执行某个任务：它的子 agent 按新的交集重新装配（20 号票的 subAgents.reassemble） */
  reassembleSubAgents?: (taskId: string) => void;
  layout: DataDirLayout;
  /** 维护者的模型；spawn 是这是它第几次被唤起（测试按它给 faux 剧本） */
  model: (maintainerId: string, spawn: number) => ModelSpec;
  vision: (model: ModelSpec) => boolean;
  credentials: Record<string, string>;
  timeZone: string;
  sessionRewriteFor?: (purges: readonly MessagesPurgedEventPayload[]) => Omit<SessionRewriteRequest, "sessionDir">;
  /** 语音回复（32 号票）：每一段的装配里多一个口语总结工具，用户发语音时输入后面跟一条说明，回复长又没写总结时追问一句 */
  voiceReplies?: AgentVoiceReplies;
  log: (line: string) => void;
}

export interface ProjectMaintainers extends MaintainerSuspension {
  /** 开始接输入：还有输入等着的项目维护者唤起 */
  start(): void;
  /**
   * 执行这个任务的项目维护者此刻的装配（20 号票：子 agent 从它收窄）：只在维护者手上是这个任务的执行工单段时有；
   * 任务自己的维护者的在 maintainers/ 的 assemblyOf
   */
  assemblyOf(taskId: string): MaintainerAssembly | undefined;
  stop(): Promise<void>;
}

export function createProjectMaintainers(options: ProjectMaintainersOptions): ProjectMaintainers {
  const { store, projects, workOrders } = options;
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
  /** 每个维护者现在的子进程是按哪一段、项目的什么样子拉起的：换了段、项目的装配变了才重新拉起 */
  const spawnedFor = new Map<string, { segmentId: string | undefined; shape: string }>();
  let unsubscribe: (() => void) | undefined;
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

  /** 当前这一段的任务变了：换上最新的重注入块，暂停、取消时中止手头这一轮，看一眼排着的输入 */
  const onTask = ({ task, from }: TaskEventPayload) => {
    const session = sessions.get(task.maintainerId);
    if (!session) return;
    if (workOrders.current(task.maintainerId)?.taskId === task.id) followExecutingTask(session, options.execution, task, from);
    session.poke();
  };

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
    assemblyOf(taskId) {
      const task = options.tasks.get(taskId);
      const project = task && projects.projectOf(task);
      if (!project || workOrders.currentWorkOrder(project.maintainerId)?.taskId !== taskId) return undefined;
      const now = assemble(options, project);
      return now.executing ? now.assembly : undefined;
    },
    removeSession(maintainerId) {
      // 项目已删除、子进程已经结束：会话也删掉
      fs.rmSync(agentSessionDir(options.layout, maintainerId), { recursive: true, force: true });
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
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

/** 一次唤起的装配：拉起参数（pi 的工具、系统提示、接哪个会话、重注入块）、代为执行的工具、守卫看到的会话；子 agent 收窄用的那一份 */
interface Assembly extends Omit<ExecutionSetup, "contextBlock"> {
  spawn: Omit<AgentSessionSpawn, "model">;
  /** 是不是执行的工单段（只有它能派子 agent） */
  executing: boolean;
  /** 按哪一段拉起的 */
  segmentId: string | undefined;
}

/** 项目维护者此刻的装配：按当前这一段和项目现在的样子 */
function assemble(options: ProjectMaintainersOptions, first: Project): Assembly {
  const { workOrders, tasks } = options;
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
  // 现在生效的计划（14 号票：计划变更提出的一版在确认之前不算）
  const confirmed = wo?.kind === "execute" ? tasks.confirmedPlan(wo.taskId) : undefined;
  const executing = wo !== undefined && confirmed !== undefined;

  let toolkit: PlanToolkit;
  let setup: ExecutionSetup;
  if (wo && confirmed && executing) {
    // 执行的工单段：和任务自己的维护者执行时同一套装配，工具包是任务授权和项目工具包的交集
    toolkit = effectiveToolkit(confirmed.plan.toolkit, projectToolkit(p));
    setup = executionSetup(options, {
      taskId: wo.taskId,
      maintainerId,
      cwd,
      toolkit,
      source: `项目「${p.name}」· 任务「${wo.taskTitle}」`,
      projectRecords,
      development,
      extraTools: [askClarificationTool(workOrders, maintainerId), summary],
    });
  } else {
    // 起草计划的工单段：只读（同任务自己的维护者起草计划时），进展经"写回进展"写；对话段（含立项问答）：工具包按项目的。
    // 调用都不属于任务（按对话里的处置判），效果日志和时序规则按这一段划范围
    const drafting = wo !== undefined;
    toolkit = drafting ? emptyToolkit() : projectToolkit(p);
    const hostTools = [
      ...(drafting
        ? [submitPlanTool(tasks, { taskId: wo.taskId, maintainerId }), writeProgressTool(options.projects, workOrders, maintainerId), askClarificationTool(workOrders, maintainerId), summary]
        : [submitCharterTool(options.projects, { projectId: p.id, maintainerId }), summary, ...options.typedShell.toolsFor({ cwd, toolkit })]),
      ...conversationTools(options),
    ];
    const assembly: MaintainerAssembly = {
      cwd,
      toolkit: { bash: toolkit.bash, network: toolkit.network },
      piTools: drafting ? [...PLANNING_PI_TOOLS] : [...PROJECT_MAINTAINER_PI_TOOLS, ...(toolkit.bash ? [TOOL.bash] : [])],
      hostTools: hostTools.map((t) => t.spec.name),
      projectRecords,
      workingDirs: [cwd],
      development,
    };
    setup = {
      assembly,
      hostTools,
      guard: { agent: maintainerGuardAgent(maintainerId, assembly), source: wo ? `项目「${p.name}」· 任务「${wo.taskTitle}」` : `项目「${p.name}」`, segmentId: `${maintainerId}:${segment?.segmentId ?? "chat"}` },
      contextBlock: undefined,
    };
  }
  const { assembly, contextBlock } = setup;
  const fixed = segment
    ? fixedContextText({
        segment,
        toolkit,
        // 这一段能用的工具：和守卫看到的同一份
        tools: assembledTools(assembly),
        records: { spec: read(paths.spec), progress: read(paths.progress), glossary: read(paths.glossary) },
        previous: workOrders.previous(maintainerId),
        workOrder: wo,
      })
    : undefined;
  return {
    spawn: {
      tools: [...assembly.piTools],
      cwd,
      systemPrompt: [projectMaintainerSystemPrompt(p, paths, cwd, options.thresholds), ...(fixed ? [fixed] : [])].join("\n\n"),
      // 接当前这一段的会话（按名字明确指定，不靠修改时间）；第一段对话段还没有这个会话时接着以前的会话（子进程报回接的是哪个）。
      // 没有在进行的段时不会有输入要处理（accepts 只认当前段的），万一拉起了也开一个新会话，不去猜接哪个
      ...(segment ? { session: segment.session, continueSession: segment.continueEarlier === true } : { continueSession: false }),
      credentials: options.credentials,
      network: toolkit.network,
      ...(contextBlock === undefined ? {} : { contextBlock }),
    },
    hostTools: setup.hostTools,
    guard: setup.guard,
    executing,
    segmentId: segment?.segmentId,
    // 子 agent 从这里收窄（20 号票）：工具包是交集之后的，围栏是项目档案和工作目录；开发类按立项书的项目类型
    assembly,
  };
}

/** 一个项目维护者的会话：按当前这一段和项目现在的样子装配 */
function projectMaintainerSession(options: ProjectMaintainersOptions, first: Project, hooks: { nextSpawn: () => number; outdated: () => boolean }): AgentSession {
  const { workOrders } = options;
  const maintainerId = first.maintainerId;
  /** 这次唤起的装配：拉起时（spawn）算一次，代为执行的工具、守卫都取这一份 */
  let spawned: Assembly | undefined;
  const current = () => spawned ?? assemble(options, first);

  return new AgentSession({
    agents: options.agents,
    store: options.store,
    streams: options.streams,
    guards: options.guards,
    media: options.media,
    timeZone: options.timeZone,
    log: options.log,
    agentId: maintainerId,
    conversation: maintainerChannel(maintainerId),
    label: "维护者",
    // 会话里的消息属于当前这一段：项目，做工单时还有所属的任务。用量（24 号票）按正在处理的那条输入记：
    // 工单段里交给它的输入带着任务，记在任务名下；对话段记在项目名下
    scope: () => workOrders.scopeOf(maintainerId) ?? { projectId: first.id },
    ledgerRole: "maintainer",
    spawn: () => {
      spawned = assemble(options, first);
      return { ...spawned.spawn, model: options.model(maintainerId, hooks.nextSpawn()) };
    },
    // 子进程报回它打开的是哪个会话：第一段对话段接着以前的会话时记进这一段
    onReady: ({ session }) => {
      if (spawned?.segmentId !== undefined) workOrders.recordSession(maintainerId, spawned.segmentId, session);
    },
    outdated: hooks.outdated,
    hostTools: () => current().hostTools,
    guard: () => current().guard,
    // 只处理属于当前这一段的输入（别的留在队里）
    accepts: (input) => workOrders.accepts(maintainerId, input),
    interject: true,
    onIdleExit: () => workOrders.idleExited(maintainerId),
    vision: options.vision,
    interruptedNote: (quoted) => `上一条输入${quoted ? `「${quoted}」` : ""}处理时中断了，维护者没有接着处理；需要的话请重发。`,
    ...(options.sessionRewriteFor ? { sessionRewriteFor: options.sessionRewriteFor } : {}),
    ...(options.voiceReplies ? { voiceReplies: options.voiceReplies } : {}),
  });
}
