// 维护者（规格第 3、7、8 节）：12 号票是任务自己的维护者（涉及多个项目或不涉及项目的任务在建卡时产生，id 是 tm-<n>），
// 会话频道是 maintainer:<维护者 id>，里面的消息都带上所属的任务（素材的"任务或项目"取自这里）。
//
// 维护者平时不跑：交给它一条输入 = 往它的会话里追加一条带 taskId 的系统通知（任务书、用户打回计划的意见……），
// 这里看到它的会话里来了消息，就为这个维护者建一个 AgentSession（conversation/agent-session.ts，和秘书共用）：
// 经 agent 管家唤起子进程（名额满了就排队）、接着它会话目录里最近的那个会话（第一次是新会话）、一次处理一条输入；
// 闲置到设定时间子进程退出，再来输入时重新唤起；意外退出时正在处理的那条以"中断"结束、不重送。
// 维护者会话里有消息被彻底删除（21 号票的 messages_purged）时同样建好它的会话，由会话改写会话文件里的原话。
//
// 起草计划时的维护者只能读（read、ls、grep、find）、联网搜索和读网页（70 号票）和"提交计划"（tools.ts）：确认之前不动手不能只靠提示词。
// 工作目录是数据目录输出区里任务自己的一格（outputs/<任务 id>），能联网（只有联网搜索、读网页会联网）；每次工具调用都经守卫（07 号票的接入），
// 调用不属于任务（task() 不给，按对话里的处置判），会话段是"<维护者 id>:planning"。
// 工具包开了 bash 时，会话里有 pi 的 bash，也有带类型的 bash 工具（28 号票，typed-shell/：git 状态和差异、提交、合并、
// 推送、建远端仓库、跑测试、装依赖、构建）。
//
// 执行（13 号票）：任务开始执行（有了阶段）后按确认的计划重新装配——
// - pi 工具：读写文件（read、write、edit、ls、grep、find），计划的工具包开了 bash 才给 bash；联网开关照计划显式给；
// - 代为执行的工具：开始阶段、宣布阶段完成、报告进展、转为等我、失败（tasks/execution-tools.ts）；
// - 守卫：调用属于任务（task() 给计划和当前阶段），效果日志、时序规则按任务划范围；
// - 重注入块：每次唤起时注入，阶段、状态变了换成最新的（压缩之后注入）；
// - 什么时候处理输入看任务的状态（共享协议包的 availableTaskActions 里维护者的 work）：规划中、待确认、执行中、等我时处理；
//   排队中、已暂停、结束了的输入留在队里；
// - 用户在任务详情里说的话（正在处理一条输入时）作为插话送进去；任务暂停、取消时中止手头这一轮。
// 起草计划和执行之间换装配（refresh）：手头这一条处理完就停掉子进程，下次唤起按新的装配拉起（接着同一个会话）。
// 并行（20 号票）：执行时多一个"提议并行"工具（subAgentTools）；子 agent 的装配从维护者此刻的装配收窄（assemblyOf）。
// 执行时的装配和项目的维护者共用（agent-host/assembly.ts 的执行，16 号票）；这里只管任务自己的差异
// （工作目录是输出区里任务的一格，工具包照确认的计划，没有项目档案）。
// 127 号票起是 agent 宿主（agent-host/host.ts）的一种配置：装配（起草计划、执行、普通任务、一次运行、固定工具包）经 host.assemble，
// 会话经 host.session（拉起参数、守卫收窄、范围审视、换模型、语音回复、斜杠命令在宿主里配好），这里只给哪种会话、工具包、系统提示和
// 跟着任务变的地方；此刻的装配、停稳手头这一轮、⚙ 登记进宿主（host.attach）。
// 14 号票：计划变更确认、自行调整计划后工具包变了（开 bash、联网……）同样换装配（工具包取现在生效的计划）；
// 27 号票：工具包（skill、MCP、bash、联网）变了立即生效——维护者正在干活时等它做完手头这一步（当前的工具调用结束、下一次模型调用之前）
// 就按新工具包重新拉起、接着原会话干，并告诉它"工具包已变更"（AgentSession.reassemble）；闲着、休眠时下次唤起按新工具包；
// 运行时无进展的催促在维护者干活时以插话送达；系统提示里的阈值照配置。
// 范围审视（18 号票，scope-review/ 的 sessionScopeReview）：装配里带审视用的模型、对照物（任务书、计划、审批卡上的批准、
// 用户说的话）和近期范围记录；压缩会话时子进程自己审视，结果存成范围记录（不属于项目的任务：写进任务的产出区）。
// 任务自己的维护者没有工单，只在压缩时审视。
// 涉及多个项目的任务（17 号票）的维护者工具包固定为三样（读项目档案、派工单、汇总回执），起草和执行都是：multi-project.ts。
// 流程（58 号票）：系统提示是流程的那一段（固定计划的工作方式）；起草时的工具是 propose_plan（步骤和条件，
// 先审查修补再交给用户授权），执行时推进它的工具是 report_step、转为等我、任务失败（agent-host/assembly.ts 的执行）。
// 普通任务（75 号票，tasks/plain.ts）：不涉及项目或涉及多个项目的普通任务的 agent 也在这里（tm-<n>）。一种装配到底（agent-host/assembly.ts 的
// 普通任务）：读写文件、bash、联网搜索和读网页、助理用的那份 skill（plainToolkit），系统提示是 plain-task.md；
// 调用不属于任务（守卫按普通对话判，受对话审批的开关管），效果日志按"<维护者 id>:plain"这一段划范围。什么时候处理输入同样看任务状态
// （执行中、等我时处理，排队中、做完了的留在队里：做完之后用户接着说，执行控制器先把任务拉回执行中）。
// 定时触发的任务（76 号票，ADR 0025）：运营中时每次运行是触发底座（scheduled-jobs/）交给它的一条通知，各次运行接着同一段会话
// （后面的运行知道前几次做了什么、结果如何；会话长了靠 pi 的压缩）。每次运行是一段：按这一次拉起（守卫的效果日志、时序规则、
// 授权项的次数按"<维护者>:<这次运行>"划范围），换了一次运行就重新拉起，会话照样接着。普通任务照普通任务的装配，多一个
// "报告这次运行失败"；流程按授权的计划装配（jobRunSetup：计划的工具包，守卫按授权的计划逐步核对，不交计划、不推进阶段）。
// 102 号票：工具包里"给秘书发消息"开着的（默认开），起草计划、执行、普通任务、每次运行都多一个 tell_secretary（信上写"长程任务 t-3「…」
// 的维护者"，定时触发的写第几次运行时）；涉及多个项目的任务的维护者工具包固定，只有这一项跟着计划里的开关。
// 117 号票：同样，工具包里"发附件"开着的（默认开）每一段都多一个 send_attachment，能把工作目录（输出区里任务的那一格）里的文件
// 作为附件发进任务的会话；tell_secretary 也能带上工作目录里的文件。涉及多个项目的任务的维护者没有（它不写文件、没有可发的东西）。
// 114 号票（任务整页的 ⚙，agent-settings/）：系统提示带上用户给这个维护者单独写的提示词（agentHandle 的通用模板按任务的种类：普通任务、
// 流程、多项目、长程任务各一份），改了从下一轮起（手头这一条处理完按新的重新拉起，接着同一个会话）；清空当前对话是新开一段会话
// （AgentSession.clear），执行时的重注入块照旧有计划、阶段和进展，起草计划、普通任务没有重注入块的，清空之后每次唤起把任务书作为
// 上下文消息给它（clearedTaskContext）；任务结束了面板只读。
import fs from "node:fs";
import path from "node:path";
import {
  availableTaskActions,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  runtimeIdOf,
  type Task,
  taskActRefusal,
  type TaskEventPayload,
  type PlanToolkit,
  sameToolkit,
  taskKind,
  isPlainTask,
  isTriggered,
  type ScheduledJob,
  toolkitChangedNotice,
  canTellSecretary,
  tellSecretaryField,
  canSendAttachment,
  sendAttachmentField,
  TASK_KIND_LABEL,
  TASK_STATE_LABEL,
  forModel,
  t,
} from "@ergo/protocol";
import type { AgentHost } from "../agent-host/host.ts";
import { type ExecutionSetup, type FixedTools, followExecutingTask, type JobRunAssembly, PLANNING_TOOLKIT } from "../agent-host/assembly.ts";
import type { AgentSession } from "../conversation/agent-session.ts";
import type { MessageScope } from "../conversation/messages.ts";
import { lastClearMarker, pendingInputs, startedInputs } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import { BUILTIN_TOOL_REGISTRY } from "../guard/index.ts";
import type { PromptId } from "../prompts/index.ts";
import { ownershipOf, type ScopeOwner } from "../scope-review/index.ts";
import { taskMessageScope } from "../tasks/stages.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { ShellToolkit } from "../typed-shell/index.ts";
import { plainToolkit } from "../tasks/plain.ts";
import { multiProjectToolkit } from "./multi-project.ts";
import { multiProjectSystemPrompt, plainTaskSystemPrompt, taskMaintainerSystemPrompt, workflowMaintainerSystemPrompt } from "./system-prompt.ts";
import { taskSender } from "../secretary/letters.ts";
import { runLabel } from "../scheduled-jobs/texts.ts";
import { realPathOf } from "../util/real-path.ts";

/** 任务在执行（有了阶段）：按确认的计划装配 */
const executing = (task: Task | undefined) => task?.stages?.list !== undefined;

/** 定时触发的任务登记好了（运营中）：每次运行按这一次装配（76 号票） */
const operating = (task: Task | undefined) => task !== undefined && task.state === "operating" && isTriggered(task);

/** 装配换不换的依据：起草计划、执行、运营中（定时触发的每次运行） */
const modeOf = (task: Task): "planning" | "executing" | "operating" => (operating(task) ? "operating" : executing(task) ? "executing" : "planning");

/** 定时触发的任务的触发底座（76 号票，scheduled-jobs/ 的 ScheduledJobs 就是它）：任务的触发登记、正在运行的那一次、一次运行的装配 */
export interface MaintainerTriggers {
  ofTask(taskId: string): ScheduledJob | undefined;
  currentRun(jobId: string): string | undefined;
  /** 一次运行交给 agent 的那条通知的消息 id：换模型只在一次运行的开头换（83 号票） */
  runNoticeId(runId: string): string | undefined;
  runAssembly(jobId: string, maintainerId: string): JobRunAssembly | undefined;
}

/** 任务自己的维护者：agent 宿主（agent-host/host.ts）的一种配置，这里只给任务自己的差异 */
export interface MaintainersOptions {
  /** agent 宿主：装配、会话、系统提示、任务和执行控制器都从它取（127 号票） */
  host: AgentHost;
  /**
   * 测试用：起草计划时维护者会话的工具包（bash、联网开关）；不给时是 PLANNING_TOOLKIT（没有 bash，70 号票起联网开着）。执行时一律照确认的计划（13 号票）。
   * 28 号票的测试靠它给起草中的维护者一个开了 bash 的会话（StartDaemonOptions.maintainerToolkit）
   */
  toolkit?: (maintainerId: string) => ShellToolkit;
  /** 不归这里管的维护者（15 号票：项目的维护者，含任务转为项目后原任务的维护者，由项目模块接） */
  excluded?: (maintainerId: string) => boolean;
  /** 涉及多个项目的任务（17 号票）：维护者的工具包固定为三样（派单器给），不写文件、不跑 bash、不联网；不给就没有这样的任务 */
  multiProject?: FixedTools;
  /**
   * 普通任务（75 号票）的 agent 用哪些 skill：助理用的那一份（设置里的 skill 库页勾的，每次唤起现取）；不给就没有 skill
   */
  plainSkills?: () => readonly string[];
  /** 定时触发的任务（76 号票）：触发底座在维护者模块之后建，现取；不给就没有定时触发的任务 */
  triggers?: () => MaintainerTriggers | undefined;
}

export interface Maintainers {
  /** 开始接输入：上次被打断的输入标成中断，还有输入等着的维护者唤起 */
  start(): void;
  /**
   * 放手一个维护者（任务转为项目时，项目模块接过它）：马上不再接它会话里的输入，子进程结束后兑现。
   * 正在处理的那一条按中断处理（接手的会话 start() 时标出）
   */
  release(maintainerId: string): Promise<void>;
  /**
   * 这个任务维护者现在的工具包里的 skill 名（82 号票：输入框里打 / 弹出的候选，和装配时一样现取；起草计划时没有）；
   * 不是这里的任务维护者（项目的维护者由项目模块管）时 undefined
   */
  skillsOf(maintainerId: string): readonly string[] | undefined;
  /**
   * 删除任务（186 号票，照删项目停维护者的做法）：停掉这个维护者——马上不再接输入、之后来的输入也不唤起它，等子进程结束（内存里的
   * 原文随之没了）。删除中止时 resume 恢复成能唤起（有输入等着就唤起）
   */
  suspend(maintainerId: string): Promise<void>;
  resume(maintainerId: string): void;
  /**
   * MCP 登记变了（239 号票）：照工具包变更的样子，手头这一条处理完停掉子进程、下次按新的装配拉起（接着同一个会话），
   * notice 是告诉它的那句话。没有会话（还没唤起过）时什么都不用做
   */
  reassemble(maintainerId: string, notice: string): void;
  stop(): Promise<void>;
}

export function createMaintainers(options: MaintainersOptions): Maintainers {
  const { host } = options;
  const sessions = new Map<string, MaintainerSession>();
  /** 正在删除的任务的维护者（186 号票）：不再唤起（删除中止时恢复） */
  const suspended = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let offOwnPrompts: (() => void) | undefined;

  /** 这个维护者的会话（第一次用到时建好并开始接输入）；不是任务的维护者、正在删除时没有 */
  const sessionFor = (maintainerId: string): MaintainerSession | undefined => {
    if (suspended.has(maintainerId)) return undefined;
    const existing = sessions.get(maintainerId);
    if (existing) return existing;
    if (options.excluded?.(maintainerId)) return undefined;
    const task = host.tasks.ofMaintainer(maintainerId);
    if (!task) return undefined;
    const session = taskMaintainerSession(options, task);
    sessions.set(maintainerId, session);
    session.session.start();
    return session;
  };

  // 登记进 agent 宿主：子 agent 要的此刻的装配（20 号票）、从某个阶段重做前停稳（84 号票）、任务整页的 ⚙（114 号票）都经宿主问
  host.attach({
    /** 任务的维护者此刻（执行时）的装配：工作目录、工具包、pi 工具、围栏（20 号票：子 agent 从它收窄）；任务不在执行时没有 */
    assemblyOf(taskId) {
      const task = host.tasks.get(taskId);
      if (!task || !executing(task) || options.excluded?.(task.maintainerId)) return undefined;
      return taskSetup(options, task, taskCwd(host, task, false)).assembly;
    },
    /** 停稳执行这个任务的维护者手头这一轮（见 AgentSession.stopTurn）：会话还没建起来时 undefined */
    async stopTaskTurn(task, how) {
      const session = sessions.get(task.maintainerId);
      if (!session) return undefined;
      const { release } = await session.session.stopTurn(how.timeoutMs, how.reason);
      return release;
    },
    /** 任务整页的 ⚙（114 号票）：任务自己的维护者（项目的维护者由项目模块给） */
    agentHandle(maintainerId) {
      if (options.excluded?.(maintainerId)) return undefined;
      const task = host.tasks.ofMaintainer(maintainerId);
      if (!task) return undefined;
      const conversation = maintainerChannel(maintainerId);
      const now = () => host.tasks.get(task.id) ?? task;
      return {
        agentId: maintainerId,
        kind: "task",
        label: isPlainTask(task)
          ? t("maintainers.label.plain", { id: task.id, title: task.title })
          : t("maintainers.label.task", { kind: TASK_KIND_LABEL[taskKind(task)], id: task.id, title: task.title }),
        template: taskPromptRole(options, task),
        readOnly: availableTaskActions(task, "user").includes("message") ? undefined : t("maintainers.readOnly", { state: TASK_STATE_LABEL[task.state] }),
        systemPrompt: () => taskSystemPrompt(options, now()),
        clearKind: "new_session",
        clear: (key) => void sessionFor(maintainerId)?.session.clear(key),
        compact: () => sessionFor(maintainerId)?.session.compactNow(),
        cannotCompact: () => undefined,
        since: () => {
          const cleared = lastClearMarker(host.store.reader, conversation);
          return cleared ? { seq: cleared.globalSeq, clearedAt: cleared.time } : { seq: 0 };
        },
        panel: () => sessions.get(maintainerId)?.session.panel,
        stopReply: () => sessions.get(maintainerId)?.session.stopReply() ?? false,
        // 会话回退（152 号票，和秘书同一套）：只在清空、换模型之后这段里；长程任务、流程的阶段、计划跟着保留的分支推导
        rollback: {
          agentId: maintainerId,
          navigate: (request, commit) => {
            const session = sessionFor(maintainerId);
            if (!session) throw new RequestRejected("not_allowed", t("maintainers.movedToProject"));
            return session.session.navigateSession(request, commit);
          },
          effectTools: () => sessionFor(maintainerId)?.session.effectTools() ?? BUILTIN_TOOL_REGISTRY,
          refusal: () => host.execution.sessionFollowRefusal(task.id),
          follow: (input) => host.execution.followSession({ ...input, taskId: task.id }),
        },
        // 单独配模型（120 号票）：盖过任务维护者那一行；定时、事件触发的下一次运行开头换，一次性的一个任务一个会话、执行中途不换
        model: { agent: "task_maintainer", switchAt: isTriggered(task) ? "next_run" : "new_session" },
        // 运行时（289 号票）：换运行时等手头这一条做完、原来的写交接摘要，换完才记进任务；只改选的值从下一轮起
        runtime: {
          current: () => ({ id: runtimeIdOf(now().runtime), options: now().runtimeOptions }),
          switchTo: (to, chosen) => sessionFor(maintainerId)?.session.switchRuntime(to, chosen),
          setOptions: (chosen) => {
            host.tasks.setRuntime(task.id, now().runtime, chosen, "user");
            sessions.get(maintainerId)?.session.refresh();
          },
          // 接管来的（290 号票）：还用那个运行时才算；工作目录是会话原来的
          takeover: () => {
            const current = now();
            return current.takeover && current.takeover.runtime === runtimeIdOf(current.runtime) ? { takeover: current.takeover, cwd: taskCwd(host, current, false) } : undefined;
          },
          // 305 号票：维护者的工作目录（新建时选的文件夹，没选的是产出区）
          workdir: () => taskCwd(host, now(), false),
        },
      };
    },
  });

  return {
    start() {
      // 交给维护者的输入（任务书、打回意见……）进了它的会话，或者它会话里有消息被彻底删除了：建好它的会话
      // （会话自己接着订阅、唤起它，建好时把以前的彻底删除对一遍）
      // 任务变了（开始执行、阶段推进、暂停、取消……）：看要不要换装配、中止手头这一轮、处理排着的输入
      unsubscribe = host.store.onAppend((event) => {
        if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) {
          const { task, from, change } = event.payload as TaskEventPayload;
          sessions.get(task.maintainerId)?.taskChanged(task, from, change);
          return;
        }
        if (!event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) return;
        if (event.type === EVENT_TYPES.message || event.type === EVENT_TYPES.messagesPurged) sessionFor(event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length));
      });
      // 在任务的 ⚙ 里改了维护者单独的提示词（114 号票）：手头这一条处理完按新的重新拉起（休眠的下次唤起自然按新的）
      offOwnPrompts = host.prompts.onAgentChange((maintainerId) => sessions.get(maintainerId)?.session.refresh());
      // 守护进程重启前还有输入没处理完的
      for (const task of host.tasks.list()) {
        const conversation = maintainerChannel(task.maintainerId);
        if (startedInputs(host.store.reader, conversation).length > 0 || pendingInputs(host.store.reader, conversation).length > 0) sessionFor(task.maintainerId);
      }
    },
    skillsOf(maintainerId) {
      if (options.excluded?.(maintainerId)) return undefined;
      const task = host.tasks.ofMaintainer(maintainerId);
      return task && taskToolkit(options, task).skills;
    },
    release(maintainerId) {
      const session = sessions.get(maintainerId);
      if (!session) return Promise.resolve();
      sessions.delete(maintainerId);
      return session.session.stop();
    },
    async suspend(maintainerId) {
      suspended.add(maintainerId);
      const session = sessions.get(maintainerId);
      if (!session) return;
      sessions.delete(maintainerId);
      await session.session.stop();
    },
    resume(maintainerId) {
      if (!suspended.delete(maintainerId)) return;
      const conversation = maintainerChannel(maintainerId);
      if (startedInputs(host.store.reader, conversation).length > 0 || pendingInputs(host.store.reader, conversation).length > 0) sessionFor(maintainerId);
    },
    reassemble(maintainerId, notice) {
      sessions.get(maintainerId)?.session.reassemble(notice);
    },
    async stop() {
      unsubscribe?.();
      offOwnPrompts?.();
      await Promise.all([...sessions.values()].map((s) => s.session.stop()));
    },
  };
}

/** 任务自己的维护者的通用模板是哪一份（114 号票：⚙ 里单独的提示词按它查、从它复制）：普通任务、流程（含定时触发的）、多项目、长程任务 */
function taskPromptRole(options: MaintainersOptions, task: Task): PromptId {
  if (isPlainTask(task)) return "plain-task";
  if (operating(task)) return "workflow-maintainer";
  // 和装配（taskSetup）同一个先后：涉及多个项目的先认
  if (options.multiProject && multiProjectToolkit(task)) return "multi-project-maintainer";
  return taskKind(task) === "workflow" ? "workflow-maintainer" : "task-maintainer";
}

/**
 * 任务自己的维护者这次唤起的系统提示，都带上它单独的提示词（114 号票）。和装配（taskSetup）同一个先后：
 * 普通任务（75 号票，plain-task.md；定时触发的多一段每次运行怎么做）、运营中的流程（76 号票）、涉及多个项目的（17 号票）、
 * 流程（58 号票，固定计划的工作方式；定时触发的流程起草时也知道它会按时间表反复运行，triggered-runs 那一段）、长程任务
 */
function taskSystemPrompt(options: MaintainersOptions, task: Task): string {
  const { host } = options;
  const failureLimit = host.runFailureLimit;
  if (isPlainTask(task)) return plainTaskSystemPrompt(host.prompts, host.conversationApprovals, isTriggered(task) ? { failureLimit } : undefined, task.maintainerId);
  if (operating(task)) return workflowMaintainerSystemPrompt(host.prompts, host.thresholds, { failureLimit }, task.maintainerId);
  if (options.multiProject && multiProjectToolkit(task)) return multiProjectSystemPrompt(host.prompts, host.thresholds, task.maintainerId);
  if (taskKind(task) === "workflow") return workflowMaintainerSystemPrompt(host.prompts, host.thresholds, isTriggered(task) ? { failureLimit } : undefined, task.maintainerId);
  return taskMaintainerSystemPrompt(host.prompts, host.thresholds, task.maintainerId);
}

/**
 * 清空过对话的任务维护者（114 号票）：起草计划时、普通任务没有重注入块，新开的那一段里就不知道在做什么了——每次唤起时把任务书作为
 * 一条上下文消息给它（和重注入块同一种注入）；执行时的重注入块里本来就有计划、阶段和进展，用不着它
 */
// @i18n-ignore-start model：注入给维护者的上下文
function clearedTaskContext(tasks: TaskService, task: Task): string {
  return forModel(() => clearedTaskLines(tasks, task));
}

function clearedTaskLines(tasks: TaskService, task: Task): string {
  const current = tasks.brief(task.id);
  const label = `${TASK_KIND_LABEL[taskKind(task)]} ${task.id}「${task.title}」`;
  return [
    "【运行时注入】这个对话清空过：之前聊的不在你的上下文里了（记录照样留着）。正在做的事照下面接着做。",
    `${label}，现在${TASK_STATE_LABEL[task.state]}。`,
    ...(current
      ? [`任务书（第 ${current.revision} 版）：`, `目标：${current.brief.goal}`, `验收标准：${bulletList(current.brief.acceptanceCriteria)}`, `约束：${bulletList(current.brief.constraints)}`]
      : [`要做的事：${task.summary}`]),
  ].join("\n");
}

/** 一串写成"- …"的几行（没有写"无"） */
const bulletList = (items: readonly string[]) => (items.length === 0 ? "无" : items.map((i) => `\n- ${i}`).join(""));
// @i18n-ignore-end

/**
 * 任务维护者的会话（任务详情里和维护者说话，13 号票）：消息带上所属的任务；任务现在收不收用户的话看
 * availableTaskActions 里用户的 message（已完成、已取消、已归档的不再收）。没有这个维护者时拒绝（not_found），
 * 不是维护者的会话不认（undefined）。项目维护者的会话先由项目模块认（daemon.ts）
 */
export function userMessageScope(tasks: TaskService, conversation: ConversationId): MessageScope | undefined {
  if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return undefined;
  const task = tasks.ofMaintainer(conversation.slice(MAINTAINER_CHANNEL_PREFIX.length));
  if (!task) throw new RequestRejected("not_found", t("maintainers.noMaintainer", { conversation }));
  if (!availableTaskActions(task, "user").includes("message")) throw new RequestRejected("not_allowed", taskActRefusal(task, "message"));
  // 开始执行之后带上当时的阶段（时间线的全局层按阶段聚色块，25 号票）
  return taskMessageScope(task);
}

/**
 * 维护者现在的工具包：执行时照现在生效的计划（14 号票：计划变更确认之前提出的那一版不算；27 号票起含 skill、MCP），
 * 起草计划时是 PLANNING_TOOLKIT（没有 bash、skill、MCP，联网开着）（测试可以经 options.toolkit 给 bash、联网开关）
 */
function taskToolkit(options: MaintainersOptions, task: Task): PlanToolkit {
  const { tasks } = options.host;
  // 普通任务（75 号票）：一种装配到底，读写、bash、联网都开着，skill 用助理的那一份（涉及几个项目都一样：它不动项目）
  if (isPlainTask(task)) return plainToolkit(options.plainSkills?.() ?? []);
  // 定时触发的流程（76 号票）：每次运行照授权的计划里的工具包
  if (operating(task)) {
    const planned = tasks.confirmedPlan(task.id)?.plan.toolkit;
    return plannedToolkit(planned);
  }
  // 涉及多个项目的任务（17 号票）：固定的那一份，起草和执行都是（计划里的工具包是给各项目维护者做工单的授权，不是它的）
  const fixed = options.multiProject ? multiProjectToolkit(task) : undefined;
  // 给秘书发消息（102 号票）这一项跟着计划里的开关（起草时还没有计划：开着）。它不写文件、没有可发的东西，装配里不给发附件（117 号票，固定工具包）
  if (fixed) return { ...fixed, skills: [...fixed.skills], mcp: [...fixed.mcp], ...tellSecretaryField(canTellSecretary(tasks.confirmedPlan(task.id)?.plan.toolkit ?? {})) };
  if (!executing(task)) return { skills: [], mcp: [], ...(options.toolkit?.(task.maintainerId) ?? PLANNING_TOOLKIT) };
  return plannedToolkit(tasks.confirmedPlan(task.id)?.plan.toolkit);
}

/** 照计划里的工具包（还没有计划时：bash、联网关着，给秘书发消息、发附件开着） */
function plannedToolkit(planned: PlanToolkit | undefined): PlanToolkit {
  return {
    skills: [...(planned?.skills ?? [])],
    mcp: [...(planned?.mcp ?? [])],
    bash: planned?.bash === true,
    network: planned?.network === true,
    ...tellSecretaryField(planned === undefined || canTellSecretary(planned)),
    ...sendAttachmentField(planned === undefined || canSendAttachment(planned)),
  };
}

/** 定时触发的任务现在正在运行的那一次（没有在运行的是 undefined） */
function runNow(options: MaintainersOptions, task: Task): { jobId: string; runId: string | undefined } | undefined {
  const job = operating(task) ? options.triggers?.()?.ofTask(task.id) : undefined;
  return job && { jobId: job.id, runId: options.triggers?.()?.currentRun(job.id) };
}

/**
 * 任务维护者此刻的装配（经 agent 宿主）：会话每次唤起算一次（拉起参数、代为执行的工具、守卫都取这一份）；子 agent 从 assemblyOf 现算的一份收窄（20 号票）。
 * cwd 是维护者的工作目录（数据目录输出区里任务自己的一格，真实路径）；任务自己的维护者没有项目档案，工作目录是 git 仓库时按开发类算。
 * - 普通任务（75 号票）：调用不属于任务（守卫看不到计划，按普通对话判），没有推进任务的工具、重注入块；定时触发的多一个"报告这次运行失败"；
 * - 定时触发的流程（76 号票）：授权一次，每次运行按授权的计划装配；守卫按授权的计划逐步核对（每次运行一段），不交计划、不推进阶段；
 * - 涉及多个项目的任务（17 号票）：固定工具包（三样），起草和执行都是；
 * - 执行时：照确认的计划的工具包，装配和项目的维护者共用；
 * - 起草计划时：只能读和交计划（流程是 propose_plan，长程任务是 submit_plan），工具包都关着（测试可以经 options.toolkit 给，
 *   开了 bash 时带类型的 bash 工具一起出现）；调用不属于任务（按对话里的处置判），效果日志和时序规则按"<维护者>:planning"这一段划范围
 */
function taskSetup(options: MaintainersOptions, task: Task, cwd: string): ExecutionSetup {
  const { host } = options;
  // 定时触发的任务（76 号票）：每次运行一段（"<维护者>:<这次运行>"；不在运行里的——用户在详情里说的——算"<维护者>:operating"）
  const run = runNow(options, task);
  const segmentId = run ? `${task.maintainerId}:${run.runId ?? "operating"}` : undefined;
  const runAssembly = run ? options.triggers?.()?.runAssembly(run.jobId, task.maintainerId) : undefined;
  // 给秘书发消息时信上写的（102 号票）：哪个任务的维护者，定时触发的写第几次运行时
  const sender = taskSender(task, taskKind(task), maintainerChannel(task.maintainerId), run?.runId === undefined ? undefined : runLabel({ runId: run.runId }));
  const base = { maintainer: "task", agentId: task.maintainerId, cwd, toolkit: taskToolkit(options, task), sender } as const;
  // 临时文件（111 号票）：普通任务、它的每次运行都按这个任务认（项目里的在 projects/maintainers.ts 按项目）
  const ownWork = () => host.execution.ownWork(task.id);
  const development = () => fs.existsSync(path.join(cwd, ".git"));
  if (isPlainTask(task)) {
    return host.assemble({
      ...base,
      session: "plain",
      source: t("maintainers.source.plain", { title: task.title }),
      segmentId: segmentId ?? `${task.maintainerId}:plain`,
      projectRecords: [],
      development: development(),
      tools: runAssembly?.tools ?? [],
      ownWork,
    });
  }
  if (operating(task)) {
    return host.assemble({
      ...base,
      session: "run",
      source: runAssembly?.source ?? t("maintainers.source.workflow", { title: task.title }),
      segmentId: segmentId ?? `${task.maintainerId}:operating`,
      projectRecords: [],
      development: development(),
      tools: runAssembly?.tools ?? [],
      ...(runAssembly ? { guardTask: runAssembly.guardTask, shellEnv: runAssembly.shellEnv } : {}),
      ownWork,
    });
  }
  const source = t("maintainers.source.task", { title: task.title });
  if (options.multiProject && multiProjectToolkit(task)) {
    return host.assemble({ ...base, session: "fixed", source, taskId: task.id, executing: executing(task), fixed: options.multiProject });
  }
  if (executing(task)) {
    return host.assemble({ ...base, session: "execution", source, taskId: task.id, projectRecords: [], development: development(), workflow: taskKind(task) === "workflow" });
  }
  return host.assemble({ ...base, session: "planning", source, taskId: task.id, segmentId: `${task.maintainerId}:planning`, projectRecords: [], development: development(), executor: { cwd } });
}

/**
 * 任务自己的维护者的工作目录：在数据目录外面的（290 号票：从已有的会话接管来的，会话原来的工作目录，Task.workdir）就是它，
 * 别的是输出区里任务自己的那一格（create 时建好）
 */
function taskCwd(host: AgentHost, task: Task, create: boolean): string {
  if (task.workdir !== undefined) return realPathOf(task.workdir) ?? task.workdir;
  return host.taskDir(task.id, create ? { create: true } : {});
}

/** 一个任务维护者的会话，和它跟着任务变的地方 */
interface MaintainerSession {
  session: AgentSession;
  /** 任务变了：起草计划和执行之间换装配；暂停、取消时中止手头这一轮；换上最新的重注入块；看一眼排着的输入 */
  taskChanged(task: Task, from: Task["state"] | null, change?: TaskEventPayload["change"]): void;
}

/** 任务自己的维护者的会话（agent 宿主的一种配置）：起草计划时只能读，执行时按确认的计划装配 */
function taskMaintainerSession(options: MaintainersOptions, first: Task): MaintainerSession {
  const { host } = options;
  const { execution } = host;
  const taskId = first.id;
  const maintainerId = first.maintainerId;
  const cwd = taskCwd(host, first, true);
  const current = () => host.tasks.get(taskId) ?? first;
  /** 当前的装配是哪一套（起草、执行、运营中）、按哪个工具包装配的（换的时候 refresh） */
  let assembled = modeOf(first);
  let assembledToolkit = taskToolkit(options, first);
  /** 范围审视的归属：任务（执行时带上当时的阶段） */
  const owner = (): ScopeOwner => ({ ownership: ownershipOf({ maintainerId, taskId }), scope: taskMessageScope(current()) });

  /** 唤起过了；定时触发的任务（76 号票）：这次唤起是按哪一次运行拉起的，换了一次运行就重新拉起（守卫的这一段跟着换），会话照样接着 */
  let launched = false;
  let spawnedRun: string | undefined;
  const runKey = () => {
    const run = runNow(options, current());
    return run ? (run.runId ?? "") : undefined;
  };

  const session = host.session({
    maintainer: "task",
    agentId: maintainerId,
    // 执行时的消息带上当时的阶段（时间线的全局层按阶段聚色块，25 号票）；工具调用记录取守卫判定那一刻的
    scope: () => taskMessageScope(current()),
    setup: () => taskSetup(options, current(), cwd),
    launch: () => {
      launched = true;
      spawnedRun = runKey();
      const setup = taskSetup(options, current(), cwd);
      return {
        setup,
        cwd,
        systemPrompt: taskSystemPrompt(options, current()),
        // 第一次唤起是新会话；闲置退出、意外退出、换装配之后再唤起接着原会话
        continueSession: true,
        // 清空过对话（114 号票）、又没有重注入块（起草计划、普通任务）：每次唤起把任务书给它
        contextBlock: setup.contextBlock ?? (lastClearMarker(host.store.reader, maintainerChannel(maintainerId)) ? clearedTaskContext(host.tasks, current()) : undefined),
      };
    },
    // 定时触发的任务换了一次运行：按这一次重新拉起（76 号票）
    outdated: () => launched && operating(current()) && spawnedRun !== runKey(),
    // 守卫每次判定按任务此刻的工具包收窄（27 号票）
    toolkitNow: () => taskToolkit(options, current()),
    // 范围审视（18 号票）：压缩时子进程自己做的存成范围记录（写进任务的产出区）
    scopeOwner: owner,
    canProcess: () => availableTaskActions(current(), "maintainer").includes("work"),
    interruptedNote: (quoted) => (quoted ? t("maintainers.interruptedQuoted", { quoted }) : t("maintainers.interrupted")),
    // 换模型就新开会话、附交接摘要（83 号票）：只有定时触发的任务、只在一次运行的开头（这次运行的通知交给它之前）换
    switchModel: (input) => {
      const runId = runNow(options, current())?.runId;
      return runId !== undefined && options.triggers?.()?.runNoticeId(runId) === input.messageId;
    },
  });

  return {
    session,
    taskChanged(task, from, change) {
      if (task.id !== taskId) return;
      // 起草和执行之间：手头这一条处理完换装配；执行中工具包变了（14 号票的计划变更、27 号票的直接改和增减 skill）：
      // 等它做完手头这一步就按新工具包重新拉起、接着干（子 agent 的由执行控制器叫 subAgents.reassemble）
      const toolkit = taskToolkit(options, task);
      if (modeOf(task) !== assembled) {
        assembled = modeOf(task);
        assembledToolkit = toolkit;
        session.refresh();
      } else if (!sameToolkit(toolkit, assembledToolkit)) {
        const before = assembledToolkit;
        assembledToolkit = toolkit;
        session.reassemble(toolkitChangedNotice(before, toolkit, "任务的工具包改了")); // @i18n-ignore model：给维护者的通知
      }
      // 用户暂停、取消、从某个阶段重做（84 号票）：中止手头这一轮（排着的输入留在队里）；执行时换上最新的重注入块
      if (executing(task) && !operating(task)) followExecutingTask(session, execution, task, from, change);
      else if ((task.state === "paused" || task.state === "cancelled") && from !== task.state) session.abortTurn();
      session.poke();
    },
  };
}
