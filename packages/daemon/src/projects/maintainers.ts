// 项目的维护者（规格第 3、11 节）：每个项目一个，会话频道 maintainer:<维护者 id>，里面的消息都带上所属的项目
// （素材的"任务或项目"取自这里）。和任务的维护者一样直接用 AgentSession（conversation/agent-session.ts），只配置差异：
// - 平时休眠：用户在它的会话里说话（或运行时给它一条通知）时唤起，闲置退出后再来输入时重新唤起；
// - 装配按项目现在的样子：工作目录（默认在项目档案里，立项书确认绑定外部路径后是那个外部路径）、文件工具的围栏
//   （项目档案和工作目录）、工具包（立项书确认前不带 bash、不联网；确认后按项目的工具包）、系统提示、"提交立项书"工具；
// - 项目的这些事实变了（立项书确认、开工）：等它手头这一条处理完，停掉子进程、按新的装配重新拉起（接着同一个会话）；
// - 任务转为项目：不新建维护者，原任务的维护者由这里接过来（任务的维护者模块先放手，子进程结束后这里再拉起，接着原会话）；
// - 删除项目（deletion.ts）：先停掉它、不再唤起（suspend）；删除中止了就恢复成能唤起（resume）；项目删掉之后再删会话区里
//   它的会话文件（removeSession）。
// 每次工具调用都经守卫；调用不属于任务（立项问答是对话），会话段是"<维护者 id>:chat"。
import fs from "node:fs";
import { CHANNELS, EVENT_TYPES, MAINTAINER_CHANNEL_PREFIX, maintainerChannel, type MessagesPurgedEventPayload, type Project, type ProjectEventPayload } from "@ergou/protocol";
import { agentSessionDir, type AgentManager } from "../agent-manager/agent-manager.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import { AgentSession, type AgentSessionStatus } from "../conversation/agent-session.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { type GuardAgent, TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import { realPathOf } from "../util/real-path.ts";
import type { MaintainerSuspension } from "./deletion.ts";
import type { ProjectService } from "./projects.ts";
import { projectMaintainerSystemPrompt } from "./system-prompt.ts";
import { submitCharterTool } from "./tools.ts";

/** 项目维护者的 pi 内置工具：读写项目档案和工作目录；工具包带 bash 时加上 bash */
export const PROJECT_MAINTAINER_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.write, TOOL.edit, TOOL.ls];

/** 这些项目变化改了维护者的装配（项目类型、工作目录、工具包）：按新的装配重新拉起 */
const RESHAPING_CHANGES: ReadonlySet<ProjectEventPayload["change"]> = new Set(["charter_confirmed", "building_started"]);

export interface ProjectMaintainersOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  guards: GuardRuntime;
  media: MediaStore;
  projects: ProjectService;
  /** 任务的维护者模块：任务转为项目时先让它放手 */
  taskMaintainers: { release(maintainerId: string): Promise<void> };
  layout: DataDirLayout;
  /** 维护者的模型；spawn 是这是它第几次被唤起（测试按它给 faux 剧本） */
  model: (maintainerId: string, spawn: number) => ModelSpec;
  vision: (model: ModelSpec) => boolean;
  credentials: Record<string, string>;
  timeZone: string;
  sessionRewriteFor?: (purges: readonly MessagesPurgedEventPayload[]) => Omit<SessionRewriteRequest, "sessionDir">;
  log: (line: string) => void;
}

export interface ProjectMaintainers extends MaintainerSuspension {
  /** 开始接输入：还有输入等着的项目维护者唤起 */
  start(): void;
  stop(): Promise<void>;
}

interface Entry {
  session: AgentSession;
  projectId: string;
  /** 项目变了、等它手头这一条处理完再按新的装配重新拉起 */
  reshape: boolean;
}

export function createProjectMaintainers(options: ProjectMaintainersOptions): ProjectMaintainers {
  const { store, projects } = options;
  const sessions = new Map<string, Entry>();
  /** 正在停下的会话（子进程结束后兑现）：同一个维护者的新会话等它停下再拉起 */
  const stopping = new Map<string, Promise<void>>();
  /** 正在删除的项目的维护者：不再唤起（删除中止时恢复） */
  const suspended = new Set<string>();
  /** 每个维护者在这里被唤起了几次（重新装配换了会话对象也接着数）：模型按它给（测试的 faux 剧本） */
  const spawnCounts = new Map<string, number>();
  const nextSpawn = (maintainerId: string) => () => {
    const n = (spawnCounts.get(maintainerId) ?? 0) + 1;
    spawnCounts.set(maintainerId, n);
    return n;
  };
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
    const entry = sessions.get(maintainerId);
    if (!entry) return stopping.get(maintainerId) ?? Promise.resolve();
    sessions.delete(maintainerId);
    return trackStopping(maintainerId, entry.session.stop());
  };

  /** 有输入等着（或者以前彻底删除过、要改写会话文件）就把会话建起来 */
  const wake = (maintainerId: string) => {
    const conversation = maintainerChannel(maintainerId);
    if (pendingInputs(store.reader, conversation).length > 0 || startedInputs(store.reader, conversation).length > 0) sessionFor(maintainerId);
  };

  /** 按项目现在的样子重新装配：闲着就马上停掉（有输入等着就重新拉起），正忙就等这一条处理完 */
  const reshape = (maintainerId: string) => {
    const entry = sessions.get(maintainerId);
    if (!entry) return;
    if (entry.session.status === "busy" || entry.session.status === "restarting") {
      entry.reshape = true;
      return;
    }
    void stopSession(maintainerId);
    wake(maintainerId);
  };

  const onStatus = (maintainerId: string) => (status: AgentSessionStatus) => {
    const entry = sessions.get(maintainerId);
    if (!entry?.reshape || (status !== "idle" && status !== "asleep")) return;
    entry.reshape = false;
    void stopSession(maintainerId);
    wake(maintainerId);
  };

  /** 这个维护者的会话（第一次用到时建好并开始接输入）；不是项目的维护者、项目删掉了时没有 */
  const sessionFor = (maintainerId: string): AgentSession | undefined => {
    if (stopped || suspended.has(maintainerId)) return undefined;
    const existing = sessions.get(maintainerId);
    if (existing) return existing.session;
    const found = projects.ofMaintainer(maintainerId);
    if (!found || found.deleted) return undefined;
    const session = projectMaintainerSession(options, found.project, { onStatus: onStatus(maintainerId), nextSpawn: nextSpawn(maintainerId) });
    sessions.set(maintainerId, { session, projectId: found.project.id, reshape: false });
    // 同一个维护者的旧会话（任务的维护者、旧的装配）还没停下：等它的子进程结束再开始（接着同一个会话文件）
    const previous = stopping.get(maintainerId);
    if (previous) {
      void previous.then(() => {
        if (sessions.get(maintainerId)?.session === session) session.start();
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
    if (RESHAPING_CHANGES.has(change)) reshape(project.maintainerId);
  };

  return {
    start() {
      unsubscribe = store.onAppend((event) => {
        if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) {
          onProjectEvent(event.payload as ProjectEventPayload);
          return;
        }
        if (!event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) return;
        // 交给维护者的输入（用户说的话、运行时的通知）进了它的会话，或者会话里有消息被彻底删除了：建好它的会话
        if (event.type === EVENT_TYPES.message || event.type === EVENT_TYPES.messagesPurged) sessionFor(event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length));
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
    removeSession(maintainerId) {
      // 项目已删除、子进程已经结束：会话文件也删掉
      fs.rmSync(agentSessionDir(options.layout, maintainerId), { recursive: true, force: true });
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      await Promise.all([...[...sessions.keys()].map((id) => stopSession(id)), ...stopping.values()]);
    },
  };
}

/** 真实路径（取不到就原样）：守卫比较路径用真实路径 */
const real = (p: string) => realPathOf(p) ?? p;

/** 一个项目维护者的会话：按项目现在的样子装配 */
function projectMaintainerSession(
  options: ProjectMaintainersOptions,
  project: Project,
  hooks: { onStatus: (status: AgentSessionStatus) => void; nextSpawn: () => number },
): AgentSession {
  const paths = options.projects.records(project.id);
  const workdir = options.projects.workdir(project);
  fs.mkdirSync(workdir, { recursive: true });
  const cwd = real(workdir);
  const confirmed = project.charterConfirmed ? project.toolkit : undefined;
  const bash = confirmed?.bash === true;
  const network = confirmed?.network === true;
  const piTools = [...PROJECT_MAINTAINER_PI_TOOLS, ...(bash ? [TOOL.bash] : [])];
  const hostTools = [submitCharterTool(options.projects, { projectId: project.id, maintainerId: project.maintainerId })];
  const guardAgent: GuardAgent = {
    kind: "maintainer",
    agentId: project.maintainerId,
    cwd,
    toolkit: { bash, network, tools: [...piTools, ...hostTools.map((t) => t.spec.name)] },
    projectRecords: [real(paths.root)],
    workingDirs: [cwd],
  };
  const systemPrompt = projectMaintainerSystemPrompt(project, paths, cwd);
  return new AgentSession({
    agents: options.agents,
    store: options.store,
    streams: options.streams,
    guards: options.guards,
    media: options.media,
    timeZone: options.timeZone,
    log: options.log,
    agentId: project.maintainerId,
    conversation: maintainerChannel(project.maintainerId),
    label: "维护者",
    scope: { projectId: project.id },
    spawn: () => ({
      model: options.model(project.maintainerId, hooks.nextSpawn()),
      tools: piTools,
      cwd,
      systemPrompt,
      // 接着会话目录里最近的会话（任务转来的维护者接着原任务的会话）
      continueSession: true,
      credentials: options.credentials,
      network,
    }),
    hostTools: () => hostTools,
    // 立项问答是对话（不属于任务），效果日志和时序规则按"对话段"划范围
    guard: () => ({ agent: guardAgent, source: `项目「${project.name}」`, segmentId: `${project.maintainerId}:chat` }),
    vision: options.vision,
    interruptedNote: (quoted) => `上一条输入${quoted ? `「${quoted}」` : ""}处理时中断了，维护者没有接着处理；需要的话请重发。`,
    onStatus: hooks.onStatus,
    ...(options.sessionRewriteFor ? { sessionRewriteFor: options.sessionRewriteFor } : {}),
  });
}
