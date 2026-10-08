// 维护者（规格第 3、7、8 节）：12 号票是任务自己的维护者（涉及多个项目或不涉及项目的任务在建卡时产生，id 是 tm-<n>），
// 会话频道是 maintainer:<维护者 id>，里面的消息都带上所属的任务（素材的"任务或项目"取自这里）。
//
// 维护者平时不跑：交给它一条输入 = 往它的会话里追加一条带 taskId 的系统通知（任务书、用户打回计划的意见……），
// 这里看到它的会话里来了消息，就为这个维护者建一个 AgentSession（conversation/agent-session.ts，和秘书共用）：
// 经 agent 管家唤起子进程（名额满了就排队）、接着它会话目录里最近的那个会话（第一次是新会话）、一次处理一条输入；
// 闲置到设定时间子进程退出，再来输入时重新唤起；意外退出时正在处理的那条以"中断"结束、不重送。
// 维护者会话里有消息被彻底删除（21 号票的 messages_purged）时同样建好它的会话，由会话改写会话文件里的原话。
//
// 起草计划时的维护者只能读（read、ls）和"提交计划"（tools.ts）：确认之前不动手不能只靠提示词。
// 工作目录是数据目录输出区里任务自己的一格（outputs/<任务 id>），不联网；每次工具调用都经守卫（07 号票的接入），
// 调用不属于任务（task() 不给，按对话里的处置判），会话段是"<维护者 id>:planning"。
// 计划确认后按计划里的工具包重新装配在 13 号票。工具包开了 bash 时，会话里有 pi 的 bash，
// 也有带类型的 bash 工具（28 号票，typed-shell/：git 状态和差异、提交、合并、推送、建远端仓库、跑测试、装依赖、构建）。
import fs from "node:fs";
import path from "node:path";
import { MAINTAINER_CHANNEL_PREFIX, maintainerChannel, EVENT_TYPES, type MessagesPurgedEventPayload, type Task } from "@ergou/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import { AgentSession } from "../conversation/agent-session.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { type GuardAgent, TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { ShellToolkit, TypedShell } from "../typed-shell/index.ts";
import { realPathOf } from "../util/real-path.ts";
import { TASK_MAINTAINER_SYSTEM_PROMPT } from "./system-prompt.ts";
import { submitPlanTool } from "./tools.ts";

/** 起草计划时维护者的 pi 内置工具：只能读（加上代为执行的"提交计划"） */
export const PLANNING_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.ls];

/** 起草计划时的工具包：没有 bash，不联网 */
export const PLANNING_TOOLKIT: Readonly<ShellToolkit> = Object.freeze({ bash: false, network: false });

export interface MaintainersOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  guards: GuardRuntime;
  tasks: TaskService;
  media: MediaStore;
  /** 数据目录的输出区（真实路径）：不属于任何项目的任务的产出，每个任务一格 */
  outputsDir: string;
  /** 维护者的模型；spawn 是这是它第几次被唤起（测试按它给 faux 剧本） */
  model: (maintainerId: string, spawn: number) => ModelSpec;
  /** 这个模型支不支持图片输入 */
  vision: (model: ModelSpec) => boolean;
  credentials: Record<string, string>;
  timeZone: string;
  /** 带类型的 bash 工具（28）：会话的工具包开了 bash 时随之出现 */
  typedShell: TypedShell;
  /**
   * 维护者会话的工具包（bash、联网开关）；不给时是起草计划时的（都关着）。
   * 13 号票按确认的计划重新装配；在那之前只有测试用它直接给一个开了 bash 的工具包（StartDaemonOptions.maintainerToolkit）
   */
  toolkit?: (maintainerId: string) => ShellToolkit;
  /** 彻底删除之后会话文件要改写哪些原话（记忆模块从删除事件生成） */
  sessionRewriteFor?: (purges: readonly MessagesPurgedEventPayload[]) => Omit<SessionRewriteRequest, "sessionDir">;
  /** 不归这里管的维护者（15 号票：项目的维护者，含任务转为项目后原任务的维护者，由项目模块接） */
  excluded?: (maintainerId: string) => boolean;
  log: (line: string) => void;
}

export interface Maintainers {
  /** 开始接输入：上次被打断的输入标成中断，还有输入等着的维护者唤起 */
  start(): void;
  /**
   * 放手一个维护者（任务转为项目时，项目模块接过它）：马上不再接它会话里的输入，子进程结束后兑现。
   * 正在处理的那一条按中断处理（接手的会话 start() 时标出）
   */
  release(maintainerId: string): Promise<void>;
  stop(): Promise<void>;
}

export function createMaintainers(options: MaintainersOptions): Maintainers {
  const sessions = new Map<string, AgentSession>();
  let unsubscribe: (() => void) | undefined;

  /** 这个维护者的会话（第一次用到时建好并开始接输入）；不是任务的维护者时没有 */
  const sessionFor = (maintainerId: string): AgentSession | undefined => {
    const existing = sessions.get(maintainerId);
    if (existing) return existing;
    if (options.excluded?.(maintainerId)) return undefined;
    const task = options.tasks.ofMaintainer(maintainerId);
    if (!task) return undefined;
    const session = taskMaintainerSession(options, task);
    sessions.set(maintainerId, session);
    session.start();
    return session;
  };

  return {
    start() {
      // 交给维护者的输入（任务书、打回意见……）进了它的会话，或者它会话里有消息被彻底删除了：建好它的会话
      // （会话自己接着订阅、唤起它，建好时把以前的彻底删除对一遍）
      unsubscribe = options.store.onAppend((event) => {
        if (!event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) return;
        if (event.type === EVENT_TYPES.message || event.type === EVENT_TYPES.messagesPurged) sessionFor(event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length));
      });
      // 守护进程重启前还有输入没处理完的
      for (const task of options.tasks.list()) {
        const conversation = maintainerChannel(task.maintainerId);
        if (startedInputs(options.store.reader, conversation).length > 0 || pendingInputs(options.store.reader, conversation).length > 0) sessionFor(task.maintainerId);
      }
    },
    release(maintainerId) {
      const session = sessions.get(maintainerId);
      if (!session) return Promise.resolve();
      sessions.delete(maintainerId);
      return session.stop();
    },
    async stop() {
      unsubscribe?.();
      await Promise.all([...sessions.values()].map((s) => s.stop()));
    },
  };
}

/** 任务自己的维护者的会话：起草计划时的装配 */
function taskMaintainerSession(options: MaintainersOptions, task: Task): AgentSession {
  const dir = path.join(options.outputsDir, task.id);
  fs.mkdirSync(dir, { recursive: true });
  const cwd = realPathOf(dir) ?? dir;
  const toolkit = options.toolkit?.(task.maintainerId) ?? PLANNING_TOOLKIT;
  // 开了 bash：pi 的 bash 和带类型的 bash 工具一起出现
  const piTools = toolkit.bash ? [...PLANNING_PI_TOOLS, TOOL.bash] : [...PLANNING_PI_TOOLS];
  const hostTools = [submitPlanTool(options.tasks, { taskId: task.id, maintainerId: task.maintainerId }), ...options.typedShell.toolsFor({ cwd, toolkit })];
  const guardAgent: GuardAgent = {
    kind: "maintainer",
    agentId: task.maintainerId,
    cwd,
    toolkit: { bash: toolkit.bash, network: toolkit.network, tools: [...piTools, ...hostTools.map((t) => t.spec.name)] },
    projectRecords: [],
    workingDirs: [cwd],
  };
  return new AgentSession({
    agents: options.agents,
    store: options.store,
    streams: options.streams,
    guards: options.guards,
    media: options.media,
    timeZone: options.timeZone,
    log: options.log,
    agentId: task.maintainerId,
    conversation: maintainerChannel(task.maintainerId),
    label: "维护者",
    scope: { taskId: task.id },
    spawn: (n) => ({
      model: options.model(task.maintainerId, n),
      tools: piTools,
      cwd,
      systemPrompt: TASK_MAINTAINER_SYSTEM_PROMPT,
      // 第一次唤起是新会话；闲置退出、意外退出之后再唤起接着原会话
      continueSession: true,
      credentials: options.credentials,
      network: toolkit.network,
    }),
    hostTools,
    // 计划确认之前，维护者的调用不属于任务（按对话里的处置判），效果日志和时序规则按这一段划范围
    guard: { agent: guardAgent, source: `任务「${task.title}」`, segmentId: `${task.maintainerId}:planning` },
    vision: options.vision,
    interruptedNote: (quoted) => `上一条输入${quoted ? `「${quoted}」` : ""}处理时中断了，维护者没有接着处理。`,
    ...(options.sessionRewriteFor ? { sessionRewriteFor: options.sessionRewriteFor } : {}),
  });
}
