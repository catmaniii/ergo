// 守卫接进运行时（规格第 3、9 节）：子进程里的二狗扩展在 pi 的 tool_call 钩子里把每次工具调用发成 guard_request，
// 这里现取环境事实、用守卫的判定函数（纯函数）判定，再回 guard_reply。放行才执行；拦下的调用不执行，
// 模型收到判定里的说明。守卫从不原地改参数。秘书、以后的维护者和子 agent 都走这一条路（agent 拉起后 attach）。
//
// 判定之后：
// - 会执行（直接做只记录、做完告诉我）：放行；执行成功后追加效果日志（guard 频道的 effect_recorded）；
// - 硬拒绝、按规则退回、永不：拦下，模型收到说明；
// - 交给我做：拦下，建一个"交给我做"事项进待我处理（带这次调用的规范化摘要），用户点"已完成"后通知 agent；
// - 先问我：先看有没有同样调用指纹的一次性授权（事后批准的审批），有就放行一次；没有就写审批表、建审批卡、通知前端，
//   子进程里的这次调用最多等 approvalWaitMs（默认 5 分钟）。期间批准 → 接着执行；拒绝 → 拦下，模型收到"用户拒绝"；
//   超时 → 以"已提交审批，等待用户"拦下，记一条挂起事件（带任务和阶段）。之后用户批准，记成一次性授权，
//   往会话里追加一条交给 agent 的通知"某某已获批准，可以重试"。
// 不论结果，每次调用在 tool_call_end 时往会话里追加一条工具调用 part（工具名、参数摘要、命中的关注类别、判定、
// 是否授权内、是否通用 bash、结果）。
//
// 时钟可注入（等审批的 5 分钟跟着它走）。被杀重启后从审批表恢复在 23 号票。
import {
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  HAND_OVER_DONE,
  type InboxItem,
  type InboxItemEventPayload,
  type MessagePart,
} from "@ergou/protocol";
import type { ApprovalService } from "../approvals/approvals.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import { appendMessage } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import {
  effectRecordsFor,
  type GuardAgent,
  type GuardInput,
  type GuardJudgement,
  type GuardPlaces,
  type GuardTask,
  judgeToolCall,
  judgementExecutes,
  loadWatchCategorySettings,
  type ToolRegistry,
  type WatchCategorySettings,
} from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { AgentProcess, AgentReport, GuardVerdict } from "../runtime/index.ts";
import type { Clock } from "../scheduler/clock.ts";
import { callFingerprint, categoryTitle, oneLine, resultSummary, summarizeArgs, toolTitle, WIRE_DISPOSITION } from "./describe.ts";
import { listEffects, nextEffectSeq } from "./effect-log.ts";
import { type ApprovalDecidedPayload, type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "./events.ts";
import { gatherFacts } from "./facts.ts";

/** 一个接上守卫的 agent 会话 */
export interface GuardedSession {
  /** 发起调用的 agent（工作目录、工具包、围栏） */
  agent: GuardAgent;
  /** 这个会话的工具注册表（内置的，加上它的守护进程代为执行的工具、MCP 工具） */
  tools: ToolRegistry;
  /** 对话里调用所在的会话：工具调用 part、审批卡、给 agent 的通知都追加在这里；任务里由 13 号票定 */
  conversation: ConversationId | null;
  /** 审批卡、"交给我做"事项上的来源："秘书对话"，任务里写任务和阶段 */
  source: string;
  /** 会话段（不属于任务的调用）：效果日志和时序规则按它划范围 */
  segmentId?: string;
  /** 调用所属的任务（13 号票接）；对话里为 null */
  task?: () => GuardTask | null;
}

export interface GuardRuntimeOptions {
  store: EventStore;
  approvals: ApprovalService;
  inbox: InboxService;
  clock: Clock;
  /** 守卫看到的数据目录各区、程序目录、用户主目录（都是真实路径） */
  places: GuardPlaces;
  /** 关注类别设置从数据目录的配置区读（每次判定现读，改了设置立即生效） */
  layout: Pick<DataDirLayout, "watchCategoriesFile">;
  /** 子进程里等审批最多等多久（毫秒） */
  approvalWaitMs: number;
  log: (line: string) => void;
}

export interface GuardRuntime {
  /** 接上一个 agent 子进程（拉起后、送输入之前）：它的 guard_request 由这里判定。返回撤销的函数 */
  attach(proc: AgentProcess, session: GuardedSession): () => void;
  /** 停止：撤掉等审批的计时器 */
  stop(): void;
}

/** "交给我做"事项里带的东西（待我处理事项的 data） */
export interface HandOverData {
  agentId: string;
  conversation: ConversationId | null;
  taskId: string | null;
  stageId: string | null;
  toolCallId: string;
  tool: string;
  toolTitle: string;
  argsSummary: string;
  /** 这次调用的规范化摘要：实际要判定的每一条（通用 bash 拆出来的伪工具调用），参数是规范化之后的 */
  calls: { tool: string; args: Record<string, unknown> }[];
}

/** 一次工具调用从判定到结束 */
interface CallState {
  toolCallId: string;
  toolName: string;
  args: unknown;
  input?: GuardInput;
  judgement?: GuardJudgement;
  settings: WatchCategorySettings[];
  /** allowed：放行了；waiting：在等审批；denied：用户拒绝；suspended：等审批超时；blocked：别的原因拦下；aborted：等的时候回合中止 */
  outcome: "allowed" | "waiting" | "denied" | "suspended" | "blocked" | "aborted";
  blockedBy?: "hard_refusal" | "pull_back";
  approvalId?: string;
  /** 用户拒绝时附带的说明 */
  note?: string;
}

interface Wait {
  approvalId: string;
  requestId: string;
  state: CallState;
  reply: (verdict: GuardVerdict) => void;
  cancelTimer: () => void;
  /** 属于哪个接上的会话（回合结束、子进程退出时撤掉它的等待） */
  owner: object;
}

export function createGuardRuntime(options: GuardRuntimeOptions): GuardRuntime {
  const { store, approvals, inbox, clock, places, log } = options;
  const waits = new Map<string, Wait>();
  const waitLabel = options.approvalWaitMs >= 60_000 ? `${Math.round(options.approvalWaitMs / 60_000)} 分钟` : `${Math.round(options.approvalWaitMs / 1000)} 秒`;

  /** 不再等这条审批（审批本身不动） */
  const finishWait = (wait: Wait) => {
    wait.cancelTimer();
    waits.delete(wait.approvalId);
    approvals.unmarkWaiting(wait.approvalId);
  };

  const dropWaitsOf = (owner: object) => {
    // 边遍历边删：Map 的 for…of 会跳过已删掉的项，不会漏也不会重复
    for (const wait of waits.values()) if (wait.owner === owner) finishWait(wait);
  };

  /** 往会话里追加一条交给 agent 的通知（排进它的输入队列）；同一件事只追加一次 */
  const notifyAgent = (conversation: ConversationId | null, text: string, key: string) => {
    if (conversation === null) return;
    appendMessage(store, { conversation, speaker: "system", parts: [{ type: "text", text }] }, { agentInput: true, idempotencyKey: key });
  };

  const onDecided = (p: ApprovalDecidedPayload) => {
    const wait = waits.get(p.approvalId);
    if (wait) {
      finishWait(wait);
      if (p.decision === "denied") {
        wait.state.outcome = "denied";
        if (p.note !== undefined) wait.state.note = p.note;
        wait.reply({ allow: false, reason: `用户拒绝了这次调用${p.note ? `：${p.note}` : ""}。不要换个写法绕过；需要的话问问用户怎么办。` });
      } else {
        wait.state.outcome = "allowed";
        wait.reply({ allow: true });
      }
      return;
    }
    if (p.decision === "denied") return;
    const approval = approvals.get(p.approvalId);
    const what = approval ? `${approval.toolTitle}「${approval.argsSummary}」` : `「${p.argsSummary}」`;
    notifyAgent(p.conversation, `${what}已获用户批准，可以重试：原样再调用一次会直接放行（只放行一次）。`, `approval-ready:${p.approvalId}`);
  };

  const onInboxItem = (item: InboxItem) => {
    if (item.kind !== "notice" || item.notice !== "hand_over" || item.handled !== HAND_OVER_DONE) return;
    const data = item.data as Partial<HandOverData> | undefined;
    if (!data?.conversation) return;
    notifyAgent(data.conversation, `交给用户做的「${data.toolTitle ?? data.tool}：${data.argsSummary ?? ""}」用户已经亲手完成了，不用你再做。`, `hand-over-done:${item.id}`);
  };

  const unsubscribe = store.onAppend((event) => {
    if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.approvalDecided) onDecided(event.payload as ApprovalDecidedPayload);
    else if (event.channel === CHANNELS.inbox && event.type === EVENT_TYPES.inboxItem) onInboxItem((event.payload as InboxItemEventPayload).item);
  });

  /** 判定一次调用：先判一次看要哪些路径和脚本，现取环境事实，再判一次 */
  const judge = (session: GuardedSession, toolName: string, args: unknown): { input: GuardInput; judgement: GuardJudgement; settings: WatchCategorySettings[] } => {
    const task = session.task?.() ?? null;
    const settings = loadWatchCategorySettings(options.layout);
    const agent = session.agent;
    const effectLog = listEffects(store.reader, task ? { taskId: task.taskId } : { taskId: null, agentId: agent.agentId, segmentId: session.segmentId });
    const base: GuardInput = {
      call: { toolName, args },
      agent,
      places,
      task,
      ...(session.segmentId === undefined ? {} : { segmentId: session.segmentId }),
      effectLog,
      settings,
      facts: {},
      tools: session.tools,
      now: clock.now(),
    };
    const first = judgeToolCall(base);
    const facts = gatherFacts(first.calls, { tools: session.tools, agent, homeDir: places.homeDir, projectsDir: places.dataDir.projects });
    const input: GuardInput = { ...base, facts };
    const allSettings = [settings, ...(task?.plan.watchCategories ? [task.plan.watchCategories] : [])];
    return { input, judgement: judgeToolCall(input), settings: allSettings };
  };

  return {
    attach(proc, session) {
      const owner = {};
      const calls = new Map<string, CallState>();
      const agentId = session.agent.agentId;

      const replyTo = (requestId: string) => (verdict: GuardVerdict) => {
        try {
          proc.send({ type: "guard_reply", requestId, verdict });
        } catch (err) {
          log(`守卫判定送不回 ${agentId}：${err instanceof Error ? err.message : String(err)}`);
        }
      };

      const handOver = (state: CallState, input: GuardInput, judgement: GuardJudgement) => {
        const task = input.task;
        const title = toolTitle(session.tools, state.toolName);
        const argsSummary = summarizeArgs(state.toolName, state.args);
        const normalized = effectRecordsFor(input, judgement, { firstSeq: 0, at: clock.now() }).map((r) => ({ tool: r.tool, args: r.args }));
        const data: HandOverData = {
          agentId,
          conversation: session.conversation,
          taskId: task?.taskId ?? null,
          stageId: task?.currentStageId ?? null,
          toolCallId: state.toolCallId,
          tool: state.toolName,
          toolTitle: title,
          argsSummary,
          calls: normalized,
        };
        const prepared = normalized.map((c) => `${toolTitle(session.tools, c.tool)}（${c.tool}）：${JSON.stringify(c.args)}`).join("\n");
        const item = inbox.add({
          kind: "notice",
          notice: "hand_over",
          title: oneLine(`交给我做：${title} ${argsSummary}`, 60),
          body: `${session.source}里要做的这件事守卫判定为"交给我做"，请你亲手完成，做完点"${HAND_OVER_DONE}"。\n要做的事：\n${prepared}\n守卫的说明：${judgement.explanation}`,
          source: session.source,
          urgency: task ? "blocking" : "non_blocking",
          actions: [HAND_OVER_DONE],
          data,
        });
        inbox.alert(item);
      };

      const ask = (state: CallState, requestId: string, input: GuardInput, judgement: GuardJudgement, settings: WatchCategorySettings[]) => {
        const reply = replyTo(requestId);
        const task = input.task;
        const fingerprint = callFingerprint({ agentId, taskId: task?.taskId ?? null, cwd: session.agent.cwd, tool: state.toolName, args: state.args });
        const grant = approvals.oneTimeGrant(agentId, fingerprint);
        if (grant) {
          approvals.consume(grant.approvalId, state.toolCallId);
          state.outcome = "allowed";
          state.approvalId = grant.approvalId;
          reply({ allow: true });
          return;
        }
        const categories = judgement.categories.map((id) => ({ id, title: categoryTitle(id, settings) }));
        const approval = approvals.request({
          agentId,
          conversation: session.conversation,
          taskId: task?.taskId ?? null,
          stageId: task?.currentStageId ?? null,
          ...(session.segmentId === undefined ? {} : { segmentId: session.segmentId }),
          toolCallId: state.toolCallId,
          tool: state.toolName,
          args: state.args,
          toolTitle: toolTitle(session.tools, state.toolName),
          argsSummary: summarizeArgs(state.toolName, state.args),
          fingerprint,
          categories,
          reason: judgement.explanation,
          source: session.source,
        });
        state.outcome = "waiting";
        state.approvalId = approval.approvalId;
        approvals.markWaiting(approval.approvalId);
        const wait: Wait = {
          approvalId: approval.approvalId,
          requestId,
          state,
          reply,
          owner,
          cancelTimer: clock.setTimer(clock.now() + options.approvalWaitMs, () => {
            if (waits.get(approval.approvalId) !== wait) return;
            finishWait(wait);
            state.outcome = "suspended";
            approvals.suspend(approval.approvalId);
            reply({
              allow: false,
              reason:
                `已提交审批，等待用户：用户 ${waitLabel}内没有处理这次调用（${approval.toolTitle}「${approval.argsSummary}」），这次先不执行。` +
                `审批卡还在待我处理里；用户批准后你会收到"已获批准，可以重试"的通知，到时候原样重试。现在不要换个写法绕过，告诉用户在等他批准。`,
            });
          }),
        };
        waits.set(approval.approvalId, wait);
      };

      const onGuardRequest = (report: Extract<AgentReport, { type: "guard_request" }>) => {
        const state: CallState = { toolCallId: report.toolCallId, toolName: report.toolName, args: report.args, outcome: "blocked", settings: [] };
        calls.set(report.toolCallId, state);
        const reply = replyTo(report.requestId);
        try {
          const { input, judgement, settings } = judge(session, report.toolName, report.args);
          Object.assign(state, { input, judgement, settings });
          if (judgementExecutes(judgement)) {
            state.outcome = "allowed";
            reply({ allow: true });
            return;
          }
          if (judgement.hardRefusal) state.blockedBy = "hard_refusal";
          else if (judgement.pullBack) state.blockedBy = "pull_back";
          else if (judgement.disposition === "ask_first" || judgement.disposition === "plan_listed") {
            ask(state, report.requestId, input, judgement, settings);
            return;
          } else if (judgement.disposition === "hand_over") {
            handOver(state, input, judgement);
            reply({ allow: false, reason: `${judgement.explanation}已在待我处理里放了一个"交给我做"事项，用户亲手完成后会通知你；这一步你不要再做。` });
            return;
          }
          reply({ allow: false, reason: judgement.explanation });
        } catch (err) {
          log(`守卫判定 ${agentId} 的 ${report.toolName} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          reply({ allow: false, reason: `守卫判定出错，这次调用不执行：${err instanceof Error ? err.message : String(err)}` });
        }
      };

      const onToolCallEnd = (report: Extract<AgentReport, { type: "tool_call_end" }>) => {
        const state = calls.get(report.toolCallId);
        if (!state) return;
        calls.delete(report.toolCallId);
        if (state.outcome === "waiting") {
          // 等审批的时候回合被中止：子进程已经按不放行处理了。审批照旧待处理，之后批准就是一次性授权
          const wait = state.approvalId === undefined ? undefined : waits.get(state.approvalId);
          if (wait) finishWait(wait);
          state.outcome = "aborted";
        }
        if (session.conversation !== null) appendMessage(store, { conversation: session.conversation, speaker: "agent", parts: [toolCallPart(state, report)] });
        if (state.outcome === "allowed" && !report.isError && state.input && state.judgement) recordEffects(state.input, state.judgement, state);
      };

      const recordEffects = (input: GuardInput, judgement: GuardJudgement, state: CallState) => {
        const title = toolTitle(session.tools, state.toolName);
        const argsSummary = summarizeArgs(state.toolName, state.args);
        const records = effectRecordsFor(input, judgement, {
          firstSeq: nextEffectSeq(store.reader),
          at: clock.now(),
          summary: (c) => (c.origin === "shell" ? (c.text ?? c.tool) : `${title}：${argsSummary}`),
        });
        const payload: EffectRecordedPayload = { records };
        store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.effectRecorded, payload });
      };

      const unsubscribeReports = proc.onReport((report) => {
        switch (report.type) {
          case "guard_request":
            onGuardRequest(report);
            return;
          case "tool_call_end":
            onToolCallEnd(report);
            return;
          case "turn_end":
            // 回合结束时不会再有调用在等（中止时子进程已按不放行处理）
            dropWaitsOf(owner);
            return;
          default:
            return;
        }
      });
      const detach = () => {
        unsubscribeReports();
        dropWaitsOf(owner);
        calls.clear();
      };
      void proc.exited.then(detach);
      return detach;
    },
    stop() {
      unsubscribe();
      for (const wait of waits.values()) finishWait(wait);
    },
  };
}

/** 聊天里的一条工具调用 part */
function toolCallPart(state: CallState, report: Extract<AgentReport, { type: "tool_call_end" }>): MessagePart {
  const j = state.judgement;
  const outcome = state.outcome === "allowed" ? (report.isError ? "error" : "done") : state.outcome === "denied" ? "denied" : "blocked";
  const summary =
    state.outcome === "denied"
      ? `你拒绝了${state.note ? `：${state.note}` : ""}`
      : state.outcome === "suspended"
        ? "已提交审批，等待用户"
        : state.outcome === "aborted"
          ? "等审批时回合中止了"
          : resultSummary(report.resultText);
  return {
    type: "tool_call",
    callId: state.toolCallId,
    tool: state.toolName,
    argsSummary: summarizeArgs(state.toolName, state.args),
    watchCategories: (j?.categories ?? []).map((id) => categoryTitle(id, state.settings)),
    disposition: j ? WIRE_DISPOSITION[j.disposition] : "never",
    ...(state.blockedBy === undefined ? {} : { blockedBy: state.blockedBy }),
    withinGrant: j?.withinGrant ?? false,
    genericBash: j?.genericShell ?? state.toolName === "bash",
    outcome,
    ...(summary === "" ? {} : { resultSummary: summary }),
  };
}
