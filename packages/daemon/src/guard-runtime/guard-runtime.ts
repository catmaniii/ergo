// 守卫接进运行时（规格第 3、9 节）：子进程里的二狗扩展在 pi 的 tool_call 钩子里把每次工具调用发成 guard_request，
// 这里现取环境事实、用守卫的判定函数（纯函数）判定，再回 guard_reply。放行才执行；拦下的调用不执行，
// 模型收到判定里的说明。守卫从不原地改参数。秘书、以后的维护者和子 agent 都走这一条路（agent 拉起后 attach）。
//
// attach 只做编排，判定之后：
// - 会执行（直接做只记录、做完告诉我）：放行；执行成功后追加效果日志（effect-log.ts 的 recordEffects），
//   读到的密钥文件里的值收进内存（read-secrets.ts，执行出错的也收），之后的判定作为环境事实 secretValues 交给守卫；
//   工具调用记录、效果日志、审批、"交给我做"写进事件日志之前，读过的密钥值换成"（密钥）"，读了密钥文件的不记结果；
// - 硬拒绝、按规则退回、永不：拦下，模型收到说明；
// - 交给我做：拦下，在待我处理里放一个"交给我做"事项（hand-over/）；
// - 先问我：一次性授权、提交审批、等用户（approval-waits.ts）；
// - 判定出错：拦下，作为单独的结果（未执行，原因"判定出错"），不当成"永不"。
// 不论结果，每次调用在 tool_call_end 时往会话里追加一条工具调用记录（tool-call-record.ts）。
import type { ConversationId } from "@ergou/protocol";
import type { ApprovalService } from "../approvals/approvals.ts";
import type { MessageScope } from "../conversation/messages.ts";
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
  replacedPaths,
  type ToolRegistry,
  type WatchCategorySettings,
} from "../guard/index.ts";
import type { HandOverService } from "../hand-over/hand-over.ts";
import type { AgentLink } from "../agent-manager/agent-manager.ts";
import type { AgentReport, GuardVerdict } from "../runtime/index.ts";
import type { Clock } from "../scheduler/clock.ts";
import { createApprovalWaits } from "./approval-waits.ts";
import { callFingerprint, type CategoryTitles, categoryTitle, summarizeArgs, toolTitle } from "./describe.ts";
import { listEffects, recordEffects } from "./effect-log.ts";
import type { CallOrigin } from "./events.ts";
import { gatherFacts } from "./facts.ts";
import { createReadSecrets, scopeOf } from "./read-secrets.ts";
import { appendToolCallRecord, type CallState, newCallState, type ToolCallEnd } from "./tool-call-record.ts";

/** 一个接上守卫的 agent 会话 */
export interface GuardedSession {
  /** 发起调用的 agent（工作目录、工具包、围栏） */
  agent: GuardAgent;
  /** 这个会话的工具注册表（内置的，加上它的守护进程代为执行的工具、MCP 工具） */
  tools: ToolRegistry;
  /** 对话里调用所在的会话：工具调用记录、审批卡、给 agent 的通知都追加在这里；任务里由 13 号票定 */
  conversation: ConversationId | null;
  /** 审批卡、"交给我做"事项上的来源："秘书对话"，任务里写任务和阶段 */
  source: string;
  /** 会话段（不属于任务的调用）：效果日志和时序规则按它划范围 */
  segmentId?: string;
  /** 调用所属的任务（13 号票接）；对话里为 null */
  task?: () => GuardTask | null;
  /** 维护者会话：工具调用记录这些消息带上所属的任务、项目（素材的"任务或项目"取自这里，12 号票起） */
  messageScope?: MessageScope;
}

export interface GuardRuntimeOptions {
  store: EventStore;
  approvals: ApprovalService;
  handOvers: HandOverService;
  clock: Clock;
  /** 守卫看到的数据目录各区、程序目录、用户主目录（都是真实路径） */
  places: GuardPlaces;
  /** 全局的关注类别设置：每次判定现取（数据目录配置区的文件，改了设置立即生效；文件坏了时抛错，这次判定出错） */
  settings: () => WatchCategorySettings;
  /** 子进程里等审批最多等多久（毫秒） */
  approvalWaitMs: number;
  /**
   * 运行时自动留旧版本的地方（15 号票：项目档案，不含工作目录和历史区）：
   * - covers：守卫的环境事实里对这些路径传 backedUp（v1 模板"删除或覆盖前须已备份或已提交"因此满足）；
   * - preserve：放行一次调用之前（直接放行、一次性授权、用户批准都算），它要删除或整体重写的、covers 认的路径
   *   先交给它留旧版本。抛错就不放行，模型收到原因
   */
  autoVersioning?: { covers(path: string): boolean; preserve(paths: readonly string[]): void };
  log: (line: string) => void;
}

export interface GuardRuntime {
  /** 接上一个 agent 子进程（拉起后、送输入之前）：它的 guard_request 由这里判定。返回撤销的函数 */
  attach(proc: AgentLink, session: GuardedSession): () => void;
  /** 停止：撤掉等审批的计时器 */
  stop(): void;
}

interface Judged {
  input: GuardInput;
  judgement: GuardJudgement;
  /** 判定用到的关注类别设置（全局的，加上本任务的）：类别 id 换成显示用的名字 */
  settings: CategoryTitles[];
}

export function createGuardRuntime(options: GuardRuntimeOptions): GuardRuntime {
  const { store, handOvers, clock, places, log } = options;
  const waits = createApprovalWaits({ store, approvals: options.approvals, clock, approvalWaitMs: options.approvalWaitMs });
  /** 读过的密钥值：只在内存里（read-secrets.ts） */
  const readSecrets = createReadSecrets();

  /** 放行之前：这次要删除或整体重写的、自动留旧版本的地方认的路径，先留旧版本（抛错就不放行） */
  const preserveBeforeAllow = (input: GuardInput, judgement: GuardJudgement) => {
    const versioning = options.autoVersioning;
    if (!versioning) return;
    const targets = replacedPaths(judgement.calls, input.tools, { cwd: input.agent.cwd, homeDir: input.places.homeDir }).filter((p) => versioning.covers(p));
    if (targets.length > 0) versioning.preserve(targets);
  };

  /** 判定一次调用：先判一次看要哪些路径和脚本，现取环境事实（加上这个范围里读过的密钥值），再判一次 */
  const judge = (session: GuardedSession, toolName: string, args: unknown): Judged => {
    const task = session.task?.() ?? null;
    const settings = options.settings();
    const agent = session.agent;
    const scope = scopeOf({ task, agent, segmentId: session.segmentId });
    const effectLog = listEffects(store.reader, scope);
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
    const facts = gatherFacts(first.calls, {
      tools: session.tools,
      agent,
      homeDir: places.homeDir,
      ...(options.autoVersioning ? { backedUp: options.autoVersioning.covers } : {}),
    });
    const secretValues = readSecrets.valuesFor(scope);
    const input: GuardInput = { ...base, facts: secretValues.length > 0 ? { ...facts, secretValues } : facts };
    const allSettings = [settings, ...(task?.plan.watchCategories ? [task.plan.watchCategories] : [])];
    return { input, judgement: judgeToolCall(input), settings: allSettings };
  };

  return {
    attach(proc, session) {
      const owner = {};
      const calls = new Map<string, CallState>();
      const agentId = session.agent.agentId;
      const originOf = (task: GuardTask | null): CallOrigin => ({
        agentId,
        conversation: session.conversation,
        taskId: task?.taskId ?? null,
        stageId: task?.currentStageId ?? null,
        ...(session.segmentId === undefined ? {} : { segmentId: session.segmentId }),
        source: session.source,
      });

      const replyTo = (requestId: string) => (verdict: GuardVerdict) => {
        try {
          proc.send({ type: "guard_reply", requestId, verdict });
        } catch (err) {
          log(`守卫判定送不回 ${agentId}：${err instanceof Error ? err.message : String(err)}`);
        }
      };

      /** 这次调用的文字写进事件日志之前怎么处理（读过的密钥值擦掉；放行执行了、读的是密钥文件的不记结果） */
      const privacyOf = (state: CallState) => {
        const scope = scopeOf(state.input ?? { task: session.task?.() ?? null, agent: session.agent, segmentId: session.segmentId });
        const executed = state.outcome === "allowed" && state.input && state.judgement ? { input: state.input, judgement: state.judgement } : undefined;
        return readSecrets.privacy(scope, executed);
      };

      /** 先问我：一次性授权或提交审批、等用户 */
      const askUser = (state: CallState, { input, judgement, settings }: Judged, reply: (verdict: GuardVerdict) => void) => {
        const origin = originOf(input.task);
        const privacy = privacyOf(state);
        waits.ask({
          origin,
          state,
          fingerprint: callFingerprint({ agentId, taskId: origin.taskId, stageId: origin.stageId, cwd: session.agent.cwd, tool: state.toolName, args: state.args }),
          categories: judgement.categories.map((id) => ({ id, title: categoryTitle(id, settings) })),
          toolTitle: toolTitle(session.tools, state.toolName),
          args: privacy.deep(state.args),
          argsSummary: privacy.text(summarizeArgs(state.toolName, state.args)),
          reason: privacy.text(judgement.explanation),
          reply,
          owner,
        });
      };

      /** 交给我做：带上这次调用的规范化摘要（实际要判定的每一条，参数是规范化之后的） */
      const handOver = (state: CallState, { input, judgement }: Judged) => {
        const privacy = privacyOf(state);
        const steps = effectRecordsFor(input, judgement, { firstSeq: 0, at: clock.now() }).map((r) => ({
          tool: r.tool,
          title: toolTitle(session.tools, r.tool),
          args: privacy.deep(r.args),
        }));
        handOvers.create(
          {
            origin: originOf(input.task),
            toolCallId: state.toolCallId,
            tool: state.toolName,
            toolTitle: toolTitle(session.tools, state.toolName),
            argsSummary: privacy.text(summarizeArgs(state.toolName, state.args)),
            calls: steps,
          },
          privacy.text(judgement.explanation),
        );
      };

      /** 按判定处理：放行、拦下、交给我做、先问我 */
      const dispose = (state: CallState, judged: Judged, reply: (verdict: GuardVerdict) => void) => {
        const { judgement } = judged;
        if (judgementExecutes(judgement)) {
          state.outcome = "allowed";
          reply({ allow: true });
          return;
        }
        if (judgement.hardRefusal) state.blockedBy = "hard_refusal";
        else if (judgement.pullBack) state.blockedBy = "pull_back";
        else if (judgement.disposition === "ask_first" || judgement.disposition === "plan_listed") {
          askUser(state, judged, reply);
          return;
        } else if (judgement.disposition === "hand_over") {
          handOver(state, judged);
          reply({ allow: false, reason: `${judgement.explanation}已在待我处理里放了一个"交给我做"事项，用户亲手完成后会通知你；这一步你不要再做。` });
          return;
        }
        reply({ allow: false, reason: judgement.explanation });
      };

      const onGuardRequest = (report: Extract<AgentReport, { type: "guard_request" }>) => {
        const state = newCallState(report);
        calls.set(report.toolCallId, state);
        const send = replyTo(report.requestId);
        // 放行之前先给项目档案里要被删除或整体重写的留旧版本；做不成就不放行
        const reply = (verdict: GuardVerdict) => {
          if (verdict.allow && state.input && state.judgement) {
            try {
              preserveBeforeAllow(state.input, state.judgement);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              log(`放行 ${agentId} 的 ${report.toolName} 之前出错：${reason}`);
              state.outcome = "blocked";
              state.blockedBy = "judge_error";
              send({ allow: false, reason: `这次调用没有执行：${reason}` });
              return;
            }
          }
          send(verdict);
        };
        try {
          const judged = judge(session, report.toolName, report.args);
          Object.assign(state, judged);
          dispose(state, judged, reply);
        } catch (err) {
          // 判定出错是单独的结果：不执行，原因"判定出错"（不当成"永不"）
          log(`守卫判定 ${agentId} 的 ${report.toolName} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          state.outcome = "blocked";
          state.blockedBy = "judge_error";
          reply({ allow: false, reason: `守卫判定出错，这次调用不执行：${err instanceof Error ? err.message : String(err)}` });
        }
      };

      const onToolCallEnd = (end: ToolCallEnd) => {
        const state = calls.get(end.toolCallId);
        if (!state) return;
        calls.delete(end.toolCallId);
        if (state.outcome === "waiting") waits.abandon(state);
        // 放行执行过的先收下读到的密钥值（出错的也收：模型可能已经看到了内容），这次调用自己的记录也按它擦
        if (state.outcome === "allowed" && state.input && state.judgement) readSecrets.capture(state.input, state.judgement);
        const privacy = privacyOf(state);
        if (session.conversation !== null) appendToolCallRecord(store, session.conversation, state, end, session.messageScope, privacy);
        if (state.outcome === "allowed" && !end.isError && state.input && state.judgement) {
          recordEffects(store, state.input, state.judgement, { resultText: end.resultText, at: clock.now(), privacy });
        }
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
            waits.dropOwner(owner);
            return;
          default:
            return;
        }
      });
      const detach = () => {
        unsubscribeReports();
        waits.dropOwner(owner);
        calls.clear();
      };
      void proc.exited.then(detach);
      return detach;
    },
    stop() {
      waits.stop();
    },
  };
}
