// 子 agent 并行（规格第 8 节"阶段执行"、第 11 节"子 agent"、第 21 节"并行"，20 号票）：编排。给人和模型看的话在 texts.ts。
//
// 维护者执行任务时遇到可以同时做的阶段（或一个定步阶段里的几步），用"提议并行"工具（tools.ts）提议派子 agent：
// - 提议（propose）：先过任务执行控制器的 checkParallel（任务在执行、阶段正在做或能开始、没有子 agent 已经在做），
//   子 agent 的目录要在维护者的工作目录里、彼此不重叠；开发类（维护者装配里的 development）每个子 agent 必须有自己的目录，
//   而且是建在工作目录里的这个仓库的 git worktree。定下子 agent 的 id（sa-<n>），建一张并行确认卡（card.ts）放进待我处理
//   （不卡任务：维护者照常一件一件做），同一任务上一次没处理的提议过期；
// - 用户在卡上同意（decide）：没开始的阶段随卡片更新一起开始，parallel_decided 落盘之后为每个子 agent 拉起一个一次性子进程
//   （agent-manager/one-shot.ts：经 agent 管家，占子进程名额、满了排队；不是任务，不占任务的执行名额），递送维护者给它的工作说明；
//   用户不同意：维护者收到通知，照常串行。两个决定都是"审批决定"素材（material-source.ts）；
// - 子 agent 的装配从维护者此刻的装配收窄（assembly.ts 的纯函数）。守卫按任务的计划、它被派去做的阶段判定（每次调用现取，
//   授权收窄立即生效），写项目档案一律拒绝。它的工具调用记录进维护者的会话，带上所属的任务、阶段和它自己的 id；
//   用量记在 24 号票的账本里：任务名下、它被派去做的那个阶段（角色子 agent，不看维护者此刻在哪个阶段）；
// - 维护者的工具包变了（14 号票改计划、27 号票的 MCP）：调用方调 reassemble(taskId)，装配跟着变了的活着的子 agent
//   等它做完手头这一步（当前的工具调用结束、下一次模型调用之前）就停掉、按新的交集重新拉起，接着原来的会话做
//   （交给它一条"工具包已变更"的说明）；还没开始的直接按新的装配重拉；这一步之后这一轮就做完了的照常交回结果；
// - 子 agent 做完这一轮就结束（进程退出），交回的话作为一条消息进维护者的会话（交给维护者的输入，带任务、阶段、子 agent），
//   维护者下一回合用到；出错、被打断（守护进程重启、子进程意外退出）、任务暂停或结束（子 agent 随之停下，继续后不自动重拉）
//   也交回一条说明；
// - 子 agent 的调用挂起后用户才批准或拒绝：通知进维护者的会话，说法由 lateNotice 给（批准的一次性授权只认子 agent 自己）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, ENDED_TASK_STATES, EVENT_TYPES, maintainerChannel, type ParallelAgent, type ParallelCardPayload, type TaskEventPayload, type TaskState, internalMark, taskInboxOrigin, taskKind } from "@ergou/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { SessionTools } from "../conversation/session-tools.ts";
import { type OneShot, type OneShotEnd, runOneShotAgent } from "../agent-manager/one-shot.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import type { CardService } from "../cards/cards.ts";
import { buildAgentNotice, buildMessage } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, fromShellDrivePath, isWithin, isWithinAny, registerTools, type ToolRegistry, type WatchCategorySettings } from "../guard/index.ts";
import type { LateDecision } from "../guard-runtime/approval-waits.ts";
import { uncertainExecutions } from "../guard-runtime/executions.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { type MaintainerAssembly, narrowedGuardAgent } from "../maintainers/assembly.ts";
import { type SecretaryLetters, subAgentSender } from "../secretary/letters.ts";
import type { ModelSpec } from "../runtime/index.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import { grantInfoOf } from "../tasks/plan.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { TypedShell } from "../typed-shell/index.ts";
import { oneLine } from "../util/text.ts";
import { realPathOf } from "../util/real-path.ts";
import { type SubAgentAssembly, subAgentAssembly, subAgentGuardTask } from "./assembly.ts";
import {
  type ParallelDecidedPayload,
  type ParallelProposedPayload,
  SUB_AGENT_EVENTS,
  type SubAgentFinishedPayload,
  type SubAgentOutcome,
  type SubAgentOwner,
  SUB_AGENTS_CHANNEL,
  type SubAgentStartedPayload,
} from "./events.ts";
import type { PromptRenderer } from "../prompts/index.ts";
import {
  confirmedNotice,
  declinedNotice,
  lateDecisionText,
  reassembledText,
  resultText,
  STOPPED_BY,
  subAgentSource,
  workText,
} from "./texts.ts";
import { proposeParallelTool } from "./tools.ts";
import { getSubAgent, liveSubAgents, proposalAgents, type SubAgentRecord, subAgentCounts, undecidedProposalCards } from "./views.ts";

export type { SubAgentOwner } from "./events.ts";

/** 维护者提议的一个子 agent（"提议并行"工具的参数） */
export interface ProposedAgent {
  stageId: string;
  step?: string;
  instructions: string;
  /** 它干活的目录（相对维护者的工作目录或绝对路径）；不写就是维护者的工作目录 */
  workDir?: string;
}

export interface ProposeInput {
  reason: string;
  agents: readonly ProposedAgent[];
}

export interface ProposeResult {
  proposalId: string;
  cardId: string;
  agents: ParallelAgent[];
}

export interface SubAgentsOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  tasks: TaskService;
  execution: TaskExecution;
  agents: AgentManager;
  guards: GuardRuntime;
  /** 带类型的 bash 工具（28）：维护者开了 bash 时子 agent 也有，工作目录是它自己的 */
  typedShell: TypedShell;
  /** 每个会话都配的工具（conversation/session-tools.ts）：子 agent 只要其中的联网搜索、读网页（70 号票，联网开关照维护者的）；不给就没有 */
  sessionTools?: SessionTools;
  /** 给秘书发消息（102 号票）：维护者的装配里有（工具包里开着）它才有，信上写"……的子 agent sa-1（在做阶段 s2「…」时）"；不给就没有 */
  letters?: SecretaryLetters;
  /** 维护者此刻（执行任务时）的装配；任务不在执行时没有 */
  maintainerAssembly: (taskId: string) => MaintainerAssembly | undefined;
  /** 项目的任务（16 号票：由项目的维护者执行）属于哪个项目：交回维护者会话的消息、工具调用记录还带上项目；不给就都不带 */
  projectOf?: (taskId: string) => string | undefined;
  /** 交给子 agent 的阶段授权说法要它们（和计划卡、维护者看到的一样） */
  watchSettings: () => WatchCategorySettings;
  planTools: ToolRegistry;
  /** 子 agent 的模型（agentId 是它的 id，测试按它给 faux 剧本） */
  model: (agentId: string) => ModelSpec;
  credentials: Record<string, string>;
  now: () => string;
  /** 系统提示的文件（71 号票） */
  prompts: PromptRenderer;
  log: (line: string) => void;
}

export interface SubAgents {
  /** 接上事件：用户同意了就拉起子 agent，任务暂停、结束时停下它的子 agent；守护进程重启前没做完的交回一条"被打断了" */
  start(): void;
  /** 停止：不再交回结果（子进程由 agent 管家随守护进程一起结束） */
  stop(): void;
  /** 维护者执行任务时的工具（"提议并行"），绑定在一个任务上 */
  toolsFor(scope: MaintainerScope): HostTool[];
  /** 维护者提议并行：建并行确认卡。不行的抛 RequestRejected（说明原因） */
  propose(scope: MaintainerScope, input: ProposeInput): ProposeResult;
  /** 并行确认卡上的两个动作（card.ts）：给出卡片的结果和同一事务追加的事件 */
  decide(card: { id: string; payload: ParallelCardPayload }, decision: ParallelDecidedPayload["decision"], note: string | undefined, idempotencyKey: string): CardActionEffect<ParallelCardPayload>;
  /** 有子 agent 在做的阶段（阶段 id → 子 agent），任务执行控制器用 */
  busyStages(taskId: string): ReadonlyMap<string, readonly string[]>;
  /** 这个 agent 是不是子 agent、属于哪个任务的哪个阶段（不是子 agent 的没有） */
  ownerOf(agentId: string): SubAgentOwner | undefined;
  /**
   * 维护者的工具包变了之后调（14 号票改计划、27 号票接 MCP 时）：这个任务活着的子 agent 按维护者新的装配重新算交集，
   * 变了的等它做完手头这一步（当前的工具调用结束、下一次模型调用之前）就结束子进程、按新的装配重新拉起，接着原来的会话做；
   * 还没开始（排队、还没就绪）的直接按新的装配重拉；没变的不动（授权项守卫每次现取，不用重拉）。返回要重新拉起的子 agent
   */
  reassemble(taskId: string): string[];
  /** 子 agent 的调用挂起后才被决定：给维护者的那条通知（不是子 agent 的调用返回 undefined，照常） */
  lateNotice(decision: LateDecision): string | undefined;
}

/** 一个活着（或在排队）的子 agent */
interface LiveSubAgent {
  record: SubAgentRecord;
  agent: ParallelAgent;
  shot: OneShot;
  /** 它现在的装配（重新装配时比对） */
  assembly: SubAgentAssembly;
  /** 交回过结果了 */
  finished: boolean;
  /** 随任务停下的原因 */
  stopping?: keyof typeof STOPPED_BY;
  /** 工具包变了：做完手头这一步就停掉，按新的装配重新拉起 */
  reassembling?: boolean;
}

/** 任务到了这些状态，它的子 agent 停下 */
const STOPPING_STATES: readonly TaskState[] = ["paused", ...ENDED_TASK_STATES];

const isDirectory = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** dir 是不是 repo 这个仓库的 git worktree（dir/.git 是文件，指向 repo/.git/worktrees/ 下面）；不起 git 进程 */
function isWorktreeOf(dir: string, repo: string): boolean {
  try {
    const dotGit = path.join(dir, ".git");
    if (!fs.statSync(dotGit).isFile()) return false;
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1];
    const worktrees = realPathOf(path.join(repo, ".git", "worktrees"));
    if (!gitdir || !worktrees) return false;
    const target = path.resolve(dir, gitdir);
    return isWithin(realPathOf(target) ?? target, worktrees);
  } catch {
    return false;
  }
}

/**
 * 子 agent 们的目录：不写是维护者的工作目录（和维护者共用）；写了的要已经存在、在工作目录里。
 * 自己的目录彼此不重叠；开发类每个子 agent 必须有自己的目录，而且是工作目录这个仓库的 git worktree
 */
function resolveWorkDirs(maintainer: MaintainerAssembly, wanted: ReadonlyArray<{ agentId: string; raw: string | undefined }>): Array<{ dir: string; own: boolean }> {
  // 开发类：项目的维护者按立项书的项目类型，任务自己的维护者看工作目录是不是 git 仓库（16 号票）
  const dev = "开发类";
  // 开发类的工作目录不是 git 仓库（用户绑定的外部目录；二狗给的默认工作目录立项书确认时已初始化）：建不了 worktree，说明怎么办
  if (maintainer.development && !fs.existsSync(path.join(maintainer.cwd, ".git"))) {
    throw new RequestRejected(
      "not_allowed",
      `${dev}：工作目录 ${maintainer.cwd} 不是 git 仓库，没法给每个子 agent 建自己的 git worktree——先把工作目录初始化成 git 仓库（git init，再提交一次），再用 git worktree add 为每个子 agent 建目录、写进 workDir`,
    );
  }
  const resolved = wanted.map(({ agentId, raw }) => {
    const written = raw?.trim() ?? "";
    if (written === "") {
      if (maintainer.development) throw new RequestRejected("not_allowed", `${dev}：${agentId} 要有自己的目录——先用 git worktree add 在工作目录里为它建一个，写进 workDir`);
      return { agentId, written, dir: maintainer.cwd, own: false };
    }
    const absolute = path.resolve(maintainer.cwd, fromShellDrivePath(written) ?? written);
    if (!isDirectory(absolute)) throw new RequestRejected("bad_params", `目录 ${written} 不存在：先在工作目录里建好（开发类用 git worktree add），再提议`);
    const dir = realPathOf(absolute) ?? absolute;
    if (!isWithinAny(dir, maintainer.workingDirs)) throw new RequestRejected("not_allowed", `目录 ${written} 不在工作目录（${maintainer.cwd}）里：子 agent 的目录要建在工作目录里`);
    // 就是维护者的工作目录的，算和维护者共用
    const own = !(isWithin(dir, maintainer.cwd) && isWithin(maintainer.cwd, dir));
    if (maintainer.development && !own) throw new RequestRejected("not_allowed", `${dev}：${agentId} 不能直接用工作目录——用 git worktree add 在工作目录里为它建一个自己的目录`);
    if (maintainer.development && !isWorktreeOf(dir, maintainer.cwd)) {
      throw new RequestRejected("not_allowed", `${dev}：${agentId} 的目录 ${written} 不是工作目录这个仓库的 git worktree——用 git worktree add 建`);
    }
    return { agentId, written, dir, own };
  });
  const own = resolved.filter((r) => r.own);
  for (const [i, a] of own.entries()) {
    const b = own.slice(i + 1).find((x) => isWithin(x.dir, a.dir) || isWithin(a.dir, x.dir));
    if (b) throw new RequestRejected("bad_params", `${a.agentId} 和 ${b.agentId} 的目录重叠（${a.written}、${b.written}）：每个子 agent 要有自己的目录，彼此不重叠（各建一个 worktree）`);
  }
  return resolved.map(({ dir, own: o }) => ({ dir, own: o }));
}

/** 两份装配一样不一样（工具、开关、工作目录、围栏） */
const sameAssembly = (a: SubAgentAssembly, b: SubAgentAssembly) => JSON.stringify(a.guardAgent) === JSON.stringify(b.guardAgent);

export function createSubAgents(options: SubAgentsOptions): SubAgents {
  const { store, cards, inbox, tasks, execution, log, now } = options;
  const live = new Map<string, LiveSubAgent>();
  let stopped = false;
  let unsubscribe: (() => void) | undefined;

  /** 同一任务还没处理的并行确认卡：过期（再次提议以新的为准、任务结束了） */
  const expireUndecided = (taskId: string): NewEvent[] =>
    undecidedProposalCards(store.reader, taskId).flatMap((cardId) => (cards.get(cardId)?.status === "pending" ? [cards.buildUpdate(cardId, { status: "expired" }).event] : []));

  /** 提议时卡上写的子 agent（重启后、交回说明时找它的说法；卡不在了用记录凑一个） */
  const plannedAgent = (record: SubAgentRecord): ParallelAgent =>
    (cards.get(record.cardId)?.payload as ParallelCardPayload | undefined)?.agents.find((a) => a.agentId === record.agentId) ?? {
      agentId: record.agentId,
      stageId: record.stageId,
      stageTitle: record.stageId,
      instructions: "",
      workDir: record.workDir,
      ownWorkDir: false,
    };

  /** 维护者会话里的消息在任务之外还带上的：项目的任务带上项目（16 号票） */
  const inProject = (taskId: string): { projectId?: string } => {
    const projectId = options.projectOf?.(taskId);
    return projectId === undefined ? {} : { projectId };
  };

  const propose = (scope: MaintainerScope, input: ProposeInput): ProposeResult => {
    execution.checkParallel(
      scope,
      input.agents.map((a) => a.stageId),
    );
    const task = tasks.get(scope.taskId)!;
    const plan = tasks.confirmedPlan(task.id)?.plan;
    const maintainer = options.maintainerAssembly(task.id);
    if (!plan || !maintainer) throw new RequestRejected("not_allowed", `任务 ${task.id} 现在不在执行，不能并行`);
    const counts = subAgentCounts(store.reader);
    const ids = input.agents.map((_, i) => `sa-${counts.agents + i + 1}`);
    const steps = input.agents.map((a) => {
      const stage = plan.stages.find((s) => s.stageId === a.stageId)!;
      const step = a.step?.trim();
      if (step !== undefined && !(stage.steps ?? []).includes(step)) {
        throw new RequestRejected("bad_params", `阶段 ${stage.stageId} 的步骤里没有「${step}」${stage.mode === "steps" ? `（有：${(stage.steps ?? []).join("、")}）` : "（它是开放模式，没有步骤）"}`);
      }
      return { stage, step };
    });
    const dirs = resolveWorkDirs(
      maintainer,
      input.agents.map((a, i) => ({ agentId: ids[i]!, raw: a.workDir })),
    );
    const agents: ParallelAgent[] = input.agents.map((a, i) => {
      const { stage, step } = steps[i]!;
      const { dir, own } = dirs[i]!;
      return { agentId: ids[i]!, stageId: stage.stageId, stageTitle: stage.title, ...(step ? { step } : {}), instructions: a.instructions.trim(), workDir: dir, ownWorkDir: own };
    });
    const proposalId = `par-${counts.proposals + 1}`;
    const payload: ParallelCardPayload = { proposalId, taskId: task.id, taskTitle: task.title, maintainerId: scope.maintainerId, reason: input.reason.trim(), agents };
    const card = cards.buildCreate({ type: "parallel", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`并行确认：${task.title}`, 60), ...taskInboxOrigin(task), urgency: "non_blocking" });
    const proposed: ParallelProposedPayload = { proposalId, taskId: task.id, maintainerId: scope.maintainerId, cardId: card.card.id, reason: payload.reason, agents, time: now() };
    store.appendBatch([...expireUndecided(task.id), { channel: SUB_AGENTS_CHANNEL, type: SUB_AGENT_EVENTS.parallelProposed, payload: proposed }, card.event, item.event]);
    inbox.alert(item.item);
    return { proposalId, cardId: card.card.id, agents };
  };

  const decide: SubAgents["decide"] = ({ id: cardId, payload }, decision, note, idempotencyKey) => {
    const scope: MaintainerScope = { taskId: payload.taskId, maintainerId: payload.maintainerId };
    const said = note?.trim() || undefined;
    let stageEvents: NewEvent[] = [];
    if (decision === "parallel") {
      // 提议之后维护者可能已经按顺序做到别处了：再查一遍，没开始的阶段随卡片更新一起开始
      stageEvents = execution.parallelStartEvents(
        scope,
        payload.agents.map((a) => a.stageId),
      );
      // 子 agent 的目录（开发类是 worktree）提议之后被删了：拉起时 agent 管家会建一个空目录，不如先拒绝
      const gone = payload.agents.filter((a) => a.ownWorkDir && !isDirectory(a.workDir));
      if (gone.length > 0) throw new RequestRejected("not_allowed", gone.map((a) => `子 agent ${a.agentId} 的目录 ${a.workDir} 不在了`).join("；"));
    }
    const decided: ParallelDecidedPayload = {
      proposalId: payload.proposalId,
      taskId: payload.taskId,
      taskTitle: payload.taskTitle,
      cardId,
      decision,
      agents: payload.agents.map(({ agentId, stageId, stageTitle, step, instructions }) => ({ agentId, stageId, stageTitle, ...(step === undefined ? {} : { step }), instructions })),
      ...(said ? { note: said } : {}),
      by: "user",
      time: now(),
    };
    const text = decision === "parallel" ? confirmedNotice(payload, said) : declinedNotice(payload, said);
    const notice = buildAgentNotice(maintainerChannel(payload.maintainerId), text, `${idempotencyKey}#notice`, { taskId: payload.taskId, ...inProject(payload.taskId) });
    return {
      status: "handled",
      events: [...stageEvents, { channel: SUB_AGENTS_CHANNEL, type: SUB_AGENT_EVENTS.parallelDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, notice.event],
    };
  };

  // ───────────────────────── 子 agent 的一生 ─────────────────────────

  /** 交回维护者的一条消息（交给它的输入；任务已经结束的只留说明）和子 agent 结束的事件，同一事务 */
  const finish = (record: SubAgentRecord, outcome: SubAgentOutcome, text: string) => {
    const task = tasks.get(record.taskId);
    const ended = !task || ENDED_TASK_STATES.includes(task.state);
    const message = buildMessage(
      { conversation: maintainerChannel(record.maintainerId), speaker: "system", parts: [{ type: "text", text }] },
      { ...(ended ? {} : { agentInput: true }), idempotencyKey: `sub-agent-result:${record.agentId}`, taskId: record.taskId, ...inProject(record.taskId), stageId: record.stageId, agentId: record.agentId },
    );
    const { taskId, stageId, maintainerId, proposalId } = record;
    const finished: SubAgentFinishedPayload = { agentId: record.agentId, taskId, stageId, maintainerId, proposalId, outcome, messageId: message.message.id, time: now() };
    store.appendBatch([{ channel: SUB_AGENTS_CHANNEL, type: SUB_AGENT_EVENTS.subAgentFinished, payload: finished }, message.event]);
  };

  /**
   * 被打断、随任务停下时还在执行的有副作用的调用（23 号票：说不清做没做完，守卫接入、重启恢复记成中断、放进待我处理）：
   * 交回维护者的说明里写明它们等用户确认，不要重做
   */
  const uncertainCalls = (agentId: string, outcome: SubAgentOutcome): string[] =>
    outcome === "interrupted" || outcome === "stopped" ? uncertainExecutions(store.reader, agentId).map((e) => e.call) : [];

  /** 子 agent 这一生怎么结束的：随任务停下、这一轮做完或出错、没等到这一轮结束子进程就退出了 */
  const outcomeOf = (entry: LiveSubAgent, end: OneShotEnd): { outcome: SubAgentOutcome; detail?: string } => {
    if (entry.stopping) return { outcome: "stopped", detail: STOPPED_BY[entry.stopping] };
    if (end.kind === "turn_end") {
      if (end.outcome === "completed") return { outcome: "done" };
      return { outcome: "error", detail: end.errorMessage ?? (end.outcome === "aborted" ? "这一轮被中止了" : "这一轮出错了") };
    }
    return { outcome: "interrupted", detail: end.exit.reason === "cancelled" ? "排队时被取消了" : "子进程意外退出了" };
  };

  /** 子 agent 的给秘书发消息（102 号票）：信上写哪个任务的子 agent、在做哪个阶段（项目内部的不写）；不给 letters 就没有 */
  const letterFor = (record: Pick<SubAgentRecord, "taskId" | "maintainerId">, agent: Pick<ParallelAgent, "agentId" | "stageId">): HostTool[] => {
    const task = tasks.get(record.taskId);
    if (!options.letters || !task) return [];
    const title = tasks.confirmedPlan(record.taskId)?.plan.stages.find((s) => s.stageId === agent.stageId)?.title ?? agent.stageId;
    return [options.letters.tool(subAgentSender(task, taskKind(task), agent.agentId, maintainerChannel(record.maintainerId), { stageId: agent.stageId, title }))];
  };

  /**
   * 子 agent 此刻的装配和代为执行的工具（拉起、维护者的工具包变了重新装配时都按它）：候选是带类型的 bash 工具（工作目录是
   * 子 agent 自己的）、联网搜索和读网页（70 号票）、给秘书发消息（102 号票，letters），收窄到维护者也有的
   */
  const assemble = (maintainer: MaintainerAssembly, agentId: string, workDir: string, letters: readonly HostTool[] = []): { assembly: SubAgentAssembly; hostTools: HostTool[] } => {
    const candidates = [...options.typedShell.toolsFor({ cwd: workDir, toolkit: maintainer.toolkit }), ...(options.sessionTools?.web ?? []), ...letters];
    const assembly = subAgentAssembly(maintainer, { agentId, cwd: workDir, hostTools: candidates.map((t) => t.spec.name) });
    return { assembly, hostTools: candidates.filter((t) => assembly.hostTools.includes(t.spec.name)) };
  };

  /**
   * 拉起一个用户同意了的子 agent 的子进程（一次性：做完这一轮就结束），递送工作说明。
   * relaunch：工具包变了重新拉起（不再记一次拉起）；before 是之前的装配（已经开始做了的：接着原来的会话，交给它"工具包已变更"）
   */
  const launch = (record: SubAgentRecord, agent: ParallelAgent, relaunch?: { before?: SubAgentAssembly }) => {
    const resume = relaunch?.before ? { before: relaunch.before } : undefined;
    const task = tasks.get(record.taskId);
    const maintainer = options.maintainerAssembly(record.taskId);
    if (!task || !maintainer) {
      finish(record, "error", resultText(agent, "error", "", "任务不在执行了，没能拉起"));
      return;
    }
    const { assembly, hostTools } = assemble(maintainer, agent.agentId, agent.workDir, letterFor(record, agent));
    if (!relaunch) {
      const { taskId, stageId, maintainerId, proposalId } = record;
      const started: SubAgentStartedPayload = { agentId: agent.agentId, taskId, stageId, maintainerId, proposalId, workDir: agent.workDir, time: now() };
      store.append({ channel: SUB_AGENTS_CHANNEL, type: SUB_AGENT_EVENTS.subAgentStarted, payload: started });
    }
    const plan = tasks.confirmedPlan(task.id)?.plan;
    let shot: OneShot;
    try {
      shot = runOneShotAgent({
        agents: options.agents,
        guards: options.guards,
        spawn: {
          agentId: agent.agentId,
          model: options.model(agent.agentId),
          tools: assembly.piTools,
          cwd: agent.workDir,
          // 系统提示（71 号票）：prompts/sub-agent.md，用户改的在数据目录配置区的 prompts/，每次拉起时现读
          systemPrompt: options.prompts.render("sub-agent", {}),
          continueSession: resume !== undefined,
          credentials: options.credentials,
          network: assembly.toolkit.network,
          // 用量记在任务名下、它被派去做的那个阶段（不看维护者此刻在哪个阶段，24 号票的账本）
          ledger: () => ({ owner: { kind: "task", id: record.taskId }, role: "sub_agent", stageId: agent.stageId }),
        },
        hostTools,
        guard: {
          agent: assembly.guardAgent,
          // 守卫每次判定按任务此刻的工具包收窄（27 号票）：工具包收窄了，做完手头这一步重新拉起之前的调用也按新的判
          currentAgent: () => {
            const toolkit = execution.toolkitNow(record.taskId);
            return toolkit ? narrowedGuardAgent(assembly.guardAgent, toolkit) : assembly.guardAgent;
          },
          // 带类型的 bash 工具、联网工具登记的就是框架自带的那份（来源 typed_shell、web），不用再加；给秘书发消息（102 号票）另加它的登记
          tools: registerTools(BUILTIN_TOOL_REGISTRY, ...hostTools.filter((t) => !Object.hasOwn(BUILTIN_TOOL_REGISTRY, t.spec.name)).map((t) => t.descriptor)),
          // 工具调用记录、审批卡引用进维护者的会话，带上所属的任务、阶段和子 agent
          conversation: maintainerChannel(record.maintainerId),
          source: subAgentSource(task, agent.stageId, agent.agentId),
          // 项目内部任务的子 agent（64 号票）：审批卡这些事项带上标记
          ...internalMark(task.internal),
          segmentId: `${record.maintainerId}:${record.taskId}`,
          task: () => subAgentGuardTask(execution.guardTask(record.taskId), agent.stageId),
          messageScope: () => ({ taskId: record.taskId, ...inProject(record.taskId), stageId: agent.stageId, agentId: agent.agentId }),
        },
        input: () =>
          resume
            ? reassembledText(resume.before, assembly)
            : workText({ task, agent, plan, grantInfo: plan ? grantInfoOf(plan, { tools: options.planTools, settings: options.watchSettings() }) : {}, toolkit: assembly.toolkit }),
        log,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      log(`拉起子 agent ${agent.agentId} 失败：${why}`);
      finish(record, "error", resultText(agent, "error", "", `没能拉起：${why}`));
      return;
    }
    const entry: LiveSubAgent = { record, agent, shot, assembly, finished: false };
    live.set(agent.agentId, entry);
    // 工具包变了：做完手头这一步就停掉它
    shot.onStepEnd(() => {
      if (entry.reassembling && !entry.stopping) shot.proc.kill();
    });
    void shot.ended.then(async (end) => {
      // 是被重新装配停掉的（不是这一轮做完、出错）：等旧的子进程退出，按新的装配重新拉起
      const cut = end.kind === "exited" || end.outcome === "aborted";
      if (entry.reassembling && cut && !entry.stopping && !stopped) {
        await shot.proc.exited;
        if (live.get(agent.agentId) === entry) live.delete(agent.agentId);
        if (!stopped) launch(record, agent, shot.started() ? { before: entry.assembly } : {});
        return;
      }
      if (live.get(agent.agentId) === entry) live.delete(agent.agentId);
      if (entry.finished || stopped) return;
      entry.finished = true;
      const { outcome, detail } = outcomeOf(entry, end);
      try {
        finish(record, outcome, resultText(agent, outcome, end.reply, detail, uncertainCalls(agent.agentId, outcome)));
      } catch (err) {
        log(`子 agent ${agent.agentId} 交回结果时出错：${err instanceof Error ? err.message : String(err)}`);
      }
    });
  };

  /** 用户同意了：为这次提议的每个子 agent 拉起子进程 */
  const onDecided = (p: ParallelDecidedPayload) => {
    if (p.decision !== "parallel") return;
    for (const record of proposalAgents(store.reader, p.proposalId)) {
      if (record.status === "confirmed") launch(record, plannedAgent(record));
    }
  };

  /** 任务暂停、结束：它的子 agent 停下（继续后不自动重拉）；结束了的任务，没处理的提议过期 */
  const onTask = (p: TaskEventPayload) => {
    const { task } = p;
    if (!STOPPING_STATES.includes(task.state)) return;
    for (const entry of live.values()) {
      if (entry.record.taskId !== task.id) continue;
      entry.stopping = task.state === "paused" ? "paused" : "ended";
      entry.shot.proc.kill();
    }
    if (!ENDED_TASK_STATES.includes(task.state)) return;
    const expired = expireUndecided(task.id);
    if (expired.length > 0) store.appendBatch(expired);
  };

  return {
    start() {
      unsubscribe = store.onAppend((event) => {
        try {
          if (event.channel === SUB_AGENTS_CHANNEL && event.type === SUB_AGENT_EVENTS.parallelDecided) onDecided(event.payload as ParallelDecidedPayload);
          else if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) onTask(event.payload as TaskEventPayload);
        } catch (err) {
          log(`子 agent 处理事件 ${event.type} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      });
      // 守护进程重启前还没做完的（同意了、拉起了还没结束的）：子进程已经不在了，交回一条"被打断了"
      for (const record of liveSubAgents(store.reader)) {
        try {
          finish(record, "interrupted", resultText(plannedAgent(record), "interrupted", "", "守护进程重启", uncertainCalls(record.agentId, "interrupted")));
        } catch (err) {
          log(`子 agent ${record.agentId} 记成被打断时出错：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    stop() {
      stopped = true;
      unsubscribe?.();
    },
    toolsFor: (scope) => [proposeParallelTool({ propose }, scope)],
    propose,
    decide,
    busyStages(taskId) {
      const busy = new Map<string, string[]>();
      for (const r of liveSubAgents(store.reader, taskId)) busy.set(r.stageId, [...(busy.get(r.stageId) ?? []), r.agentId]);
      return busy;
    },
    ownerOf(agentId) {
      const r = getSubAgent(store.reader, agentId);
      return r ? { taskId: r.taskId, stageId: r.stageId, maintainerId: r.maintainerId, proposalId: r.proposalId } : undefined;
    },
    reassemble(taskId) {
      const maintainer = options.maintainerAssembly(taskId);
      if (!maintainer) return [];
      const relaunched: string[] = [];
      for (const entry of live.values()) {
        if (entry.record.taskId !== taskId || entry.finished || entry.stopping || entry.reassembling) continue;
        const { agentId, workDir } = entry.agent;
        const { assembly: next } = assemble(maintainer, agentId, workDir, letterFor(entry.record, entry.agent));
        if (sameAssembly(entry.assembly, next)) continue;
        entry.reassembling = true;
        relaunched.push(agentId);
        if (entry.shot.started()) {
          log(`子 agent ${agentId} 的工具包跟着维护者变了：做完手头这一步就按新的装配重新拉起`);
        } else {
          // 还没开始（排队、还没就绪）：直接按新的装配重拉
          log(`子 agent ${agentId} 的工具包跟着维护者变了：还没开始，直接按新的装配重新拉起`);
          entry.shot.proc.kill();
        }
      }
      return relaunched;
    },
    lateNotice({ origin, decision, what, note }) {
      const record = getSubAgent(store.reader, origin.agentId);
      if (!record) return undefined;
      return lateDecisionText({
        what,
        agentId: record.agentId,
        stageId: origin.stageId ?? record.stageId,
        decision,
        ...(note === undefined ? {} : { note }),
        ended: record.status === "finished",
      });
    },
  };
}
