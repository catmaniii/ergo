// 作业自己的维护者（规格第 13 节，19 号票）：76 号票之前登记的、不属于项目的定时作业由它执行，id 是 jm-<n>（j-<n> 的），
// 会话频道 maintainer:jm-<n>，pi 会话在会话区 sessions/jm-<n>/（接着同一个长期会话：每次运行是会话里的一条输入）。
// 76 号票起定时作业并进定时触发的任务：新登记的由任务自己的 agent（tm-<n>，maintainers/）或项目的维护者做，不经这里；
// 以前的作业迁移成定时触发的普通任务之后照旧由它做（会话、授权都沿用），用户在任务详情里对它说的话它也接着处理。
// 127 号票起是 agent 宿主（agent-host/host.ts）的一种配置（会话经 host.session，装配经 host.assemble），只给差异：
// - 平时休眠：每次运行时定时作业模块往它的会话里追加一条带作业身份的通知，有输入才唤起，闲置退出后再来输入时重新唤起；
// - 装配：和执行任务时同一套动手的装配（宿主的"一次运行"），要的东西由定时作业模块给（JobRunAssembly）：
//   工具包照建它的任务现在生效的计划（skill、MCP 照样落进会话，27 号票），工作目录是那个任务的产出区（outputs/<任务 id>），
//   另有"报告这次运行失败"；守卫按此刻的工具包判（宿主收窄），工具包变了下一次唤起按新的装配；
//   守卫按作业的授权判（授权项、时序规则、本任务的关注类别），效果日志、时序规则、授权项的次数按"<维护者>:<这次运行>"划范围：
//   每次运行是一段，子进程按哪一次运行拉起的记着，换了一次运行就重新拉起（outdated），会话照样接着；
// - 会话里的消息都带着作业身份（scheduledJobId）：24 号票的账本据此把它的用量记在作业名下；
// - 76 号票之前用户不直接和它对话；迁移成定时触发的普通任务之后，用户可以在任务详情里对它说话（不在运行里，按"不在运行"那一段装配）。
//   不接语音回复（32 号票），不收插话（宿主按"定时作业的维护者"配）；
// - 模型：迁移来的定时作业的 agent 算任务维护者（73 号票），照那一行（不单独配，120 号票）；
// - 换模型（83 号票）：一个会话固定一个模型，设置里改了，下一次运行开头（交它这次运行的通知之前）
//   新开会话、附交接摘要（AgentSession 的 modelSwitch）；一次运行做到一半不换。
import fs from "node:fs";
import path from "node:path";
import { emptyToolkit, EVENT_TYPES, MAINTAINER_CHANNEL_PREFIX, maintainerChannel, type MessageEventPayload, type ScheduledJob, t } from "@ergo/protocol";
import type { AgentHost } from "../agent-host/host.ts";
import type { ExecutionSetup, JobRunAssembly } from "../agent-host/assembly.ts";
import type { AgentSession } from "../conversation/agent-session.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { jobKeys } from "./keys.ts";
import { isJobMaintainerId } from "./jobs.ts";
import { jobMaintainerSystemPrompt } from "./system-prompt.ts";
import { interruptedReason, runLabel } from "./texts.ts";
import { jobSender } from "../secretary/letters.ts";
import { listJobs } from "./views.ts";

/** 定时作业自己的维护者：agent 宿主的一种配置 */
export interface JobMaintainersOptions {
  /** agent 宿主：装配、会话、系统提示都从它取（127 号票） */
  host: AgentHost;
  /** 一次运行要的装配（定时作业模块给）：工具包、工具、来源、守卫看到的作业的授权 */
  runAssembly(jobId: string, maintainerId: string): JobRunAssembly | undefined;
  /** 作业现在正在运行的那一次（运行号）；没有是 undefined */
  currentRun(jobId: string): string | undefined;
}

export interface JobMaintainers {
  /** 开始接输入：上次被打断的输入标成中断，还有输入等着的维护者唤起 */
  start(): void;
  /**
   * 删除迁移来的定时任务（186 号票）：停掉它的作业维护者——马上不再接输入、之后来的也不唤起，等子进程结束；删除中止时 resume 恢复
   */
  suspend(maintainerId: string): Promise<void>;
  resume(maintainerId: string): void;
  stop(): Promise<void>;
}

/** 这个维护者执行的作业（不属于项目的、作业自己的维护者 jm-<n> 的；76 号票起新登记的由任务自己的 agent 做，不归这里） */
const jobOf = (store: EventStore, maintainerId: string): ScheduledJob | undefined =>
  isJobMaintainerId(maintainerId) ? listJobs(store.reader).find((j) => j.projectId === undefined && j.maintainerId === maintainerId) : undefined;

export function createJobMaintainers(options: JobMaintainersOptions): JobMaintainers {
  const { store } = options.host;
  const sessions = new Map<string, AgentSession>();
  /** 正在删除的任务的作业维护者（186 号票）：不再唤起 */
  const suspended = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let stopped = false;

  const sessionFor = (maintainerId: string): AgentSession | undefined => {
    if (stopped || suspended.has(maintainerId)) return undefined;
    const existing = sessions.get(maintainerId);
    if (existing) return existing;
    const job = jobOf(store, maintainerId);
    if (!job) return undefined;
    const session = jobMaintainerSession(options, job);
    sessions.set(maintainerId, session);
    session.start();
    return session;
  };

  return {
    start() {
      // 交给作业维护者的输入（一次运行的通知）进了它的会话，或者会话里有消息被彻底删除了：建好它的会话
      unsubscribe = store.onAppend((event) => {
        if (!event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) return;
        if (event.type === EVENT_TYPES.message || event.type === EVENT_TYPES.messagesPurged) sessionFor(event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length));
      });
      // 守护进程重启前还有输入没处理完的（处理到一半的会话开始时标成中断）
      for (const job of listJobs(store.reader)) {
        if (job.projectId !== undefined || !isJobMaintainerId(job.maintainerId)) continue;
        const conversation = maintainerChannel(job.maintainerId);
        if (startedInputs(store.reader, conversation).length > 0 || pendingInputs(store.reader, conversation).length > 0) sessionFor(job.maintainerId);
      }
    },
    async suspend(maintainerId) {
      suspended.add(maintainerId);
      const session = sessions.get(maintainerId);
      if (!session) return;
      sessions.delete(maintainerId);
      await session.stop();
    },
    resume(maintainerId) {
      if (!suspended.delete(maintainerId)) return;
      const conversation = maintainerChannel(maintainerId);
      if (startedInputs(store.reader, conversation).length > 0 || pendingInputs(store.reader, conversation).length > 0) sessionFor(maintainerId);
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      await Promise.all([...sessions.values()].map((s) => s.stop()));
    },
  };
}

/** 一个作业维护者的会话：每次唤起按这次运行装配（作业所在计划的工具包、作业的授权） */
function jobMaintainerSession(options: JobMaintainersOptions, job: ScheduledJob): AgentSession {
  const { host } = options;
  const maintainerId = job.maintainerId;
  const cwd = host.taskDir(job.taskId, { create: true });
  /** 这一段：作业正在运行的那一次（没有在运行的，比如重启后处理被打断的那条，算作业的） */
  const segmentOf = (runId: string | undefined) => `${maintainerId}:${runId ?? job.id}`;
  /** 此刻的工具包：作业所在计划现在生效的那一份（没有作业了是空的） */
  const toolkitNow = () => options.runAssembly(job.id, maintainerId)?.toolkit ?? emptyToolkit();
  const setup = (runId: string | undefined): ExecutionSetup => {
    const run = options.runAssembly(job.id, maintainerId);
    return host.assemble({
      session: "run",
      maintainer: "job",
      agentId: maintainerId,
      cwd,
      toolkit: run?.toolkit ?? emptyToolkit(),
      source: run?.source ?? job.title,
      segmentId: segmentOf(runId),
      projectRecords: [],
      development: fs.existsSync(path.join(cwd, ".git")),
      tools: run?.tools ?? [],
      ...(run ? { guardTask: run.guardTask } : {}),
      // 给秘书发消息时信上写的（102 号票）：哪个作业的维护者、第几次运行时
      sender: jobSender(job, maintainerChannel(maintainerId), runId === undefined ? undefined : runLabel({ runId })),
    });
  };
  /** 这次唤起是按哪一次运行、哪一份工具包拉起的：换了就重新拉起 */
  let spawned: { runId: string | undefined; toolkit: string } | undefined;

  return host.session({
    maintainer: "job",
    agentId: maintainerId,
    // 消息都带着作业身份：用量记在作业名下（24 号票）
    scope: { scheduledJobId: job.id },
    setup: () => setup(options.currentRun(job.id)),
    launch: () => {
      const runId = options.currentRun(job.id);
      spawned = { runId, toolkit: JSON.stringify(toolkitNow()) };
      return {
        setup: setup(runId),
        cwd,
        // 系统提示（71 号票起每次唤起时现读系统提示的文件）：里面的次数、对话审批的说法取配置
        systemPrompt: jobMaintainerSystemPrompt(host.prompts, host.runFailureLimit, host.conversationApprovals),
        // 接着同一个长期会话（第一次是新会话）
        continueSession: true,
      };
    },
    // 换了一次运行、工具包变了：按这一次、新的工具包重新拉起（守卫的这一段跟着换），会话照样接着
    outdated: () => spawned !== undefined && (spawned.runId !== options.currentRun(job.id) || spawned.toolkit !== JSON.stringify(toolkitNow())),
    // 守卫按此刻的工具包判（27 号票）：之后去掉的能力，重新拉起之前也用不到
    toolkitNow,
    interruptedNote: (quoted) =>
      quoted ? t("scheduledJobs.interruptedNoteQuoted", { quoted, reason: interruptedReason() }) : t("scheduledJobs.interruptedNote", { reason: interruptedReason() }),
    // 换模型就新开会话、附交接摘要（83 号票）：只在一次运行的开头（这次运行的通知交给它之前）换，运行做到一半不换
    switchModel: (input) => {
      const runId = options.currentRun(job.id);
      return runId !== undefined && runNoticeId(host.store, runId) === input.messageId;
    },
  });
}

/** 一次运行交给作业维护者的那条通知的消息 id（没有是 undefined） */
function runNoticeId(store: EventStore, runId: string): string | undefined {
  return (store.eventByIdempotencyKey(jobKeys.runNotice(runId))?.payload as Partial<MessageEventPayload> | undefined)?.message?.id;
}
