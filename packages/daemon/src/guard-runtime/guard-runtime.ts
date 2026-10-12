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
// - 先问我：一次性授权、提交审批、等用户（approval-waits.ts）；任务里"没预料到的类别"（14 号票）提交审批后不等，
//   这一支马上停下（记挂起，控制器让别的阶段接着做）。对话审批关着（70 号票，配置 guard.conversationApprovals 默认 off；
//   101 号票改了范围）时，秘书除了特别敏感的、任务的 agent 超出授权的"先问我"由判定函数按"直接做"判（照常记录、照常标关注类别），
//   不出审批卡；
// - 任务里按规则退回的（拉回）记一条 pulled_back，控制器据此计拉回次数（14 号票）；
// - 判定出错：拦下，作为单独的结果（未执行，原因"判定出错"），不当成"永不"。
// 不论结果，每次调用在 tool_call_end 时往会话里追加一条工具调用记录（tool-call-record.ts），之前先另存一份完整的参数和返回
// （tool-call-details.ts，53 号票：详情页按调用 id 取；经过同一份隐私处理，太长的截断）。
// 流程（59 号票，plan-check.ts）：执行中的流程里，判定之后再和授权的计划比对（两道都要过）——前置步骤没做的引回（不执行，
// 告诉维护者先做哪一步）、参数和计划对不上的按计划改回再放行（子进程按改后的参数执行，结果前面写明）、重复和审查剔除的对象
// 直接拦下、计划外会改东西的和超出范围的问用户（和第一道要问的合成一张审批卡）；执行成功的记下对上了哪一步，修回记进时间线。
// 被杀后的恢复（23 号票，executions.ts）：放行、开始执行的有副作用的调用记 tool_call_started，结束时记 tool_call_finished
// （成功与否、结果摘要），agent 又出了一条助手消息、或者这一轮结束时（结果都写进会话了）记 tool_calls_settled；
// 子进程意外退出时还没结束的记 tool_call_interrupted（守护进程被杀时没机会记，重启时由 recovery/ 补记）。
// 守护进程停止时（stop 之后）子进程被结束不算中断：没结束的留着，下次启动时按被杀恢复。
import { type ConversationId, internalMark, nowIso, type ProjectInternal } from "@ergou/protocol";
import type { ApprovalService } from "../approvals/approvals.ts";
import type { MessageScope } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import {
  agentShellEnv,
  attributedTask,
  type ConversationApprovals,
  effectRecordsFor,
  findingKey,
  type GuardAgent,
  type GuardInput,
  type GuardJudgement,
  type GuardPlaces,
  type GuardTask,
  type GuardTaskContext,
  judgeToolCall,
  judgementExecutes,
  replacedPaths,
  neverObjectsOf,
  taskAgentLeeway,
  type ToolRegistry,
  type WatchCategorySettings,
} from "../guard/index.ts";
import type { HandOverService } from "../hand-over/hand-over.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { AgentLink, UserWaits } from "../agent-manager/agent-manager.ts";
import type { AgentReport, GuardVerdict } from "../runtime/index.ts";
import type { Clock } from "../scheduler/clock.ts";
import { createApprovalWaits, type LateDecision } from "./approval-waits.ts";
import { callFingerprint, type CategoryTitles, categoryTitle, summarizeArgs, toolTitle } from "./describe.ts";
import { listEffects, recordEffects } from "./effect-log.ts";
import {
  type CallOrigin,
  type ExecutionRecord,
  GUARD_CHANNEL,
  GUARD_EVENTS,
  originScope,
  type NeverRecordedPayload,
  type PlanCallCommittedPayload,
  type PulledBackPayload,
  type ToolCallFinishedPayload,
  type ToolCallsSettledPayload,
  type ToolCallStartedPayload,
} from "./events.ts";
import { callText, interruptionEvents, needsExecutionRecord, unsettledExecutions } from "./executions.ts";
import { gatherFacts } from "./facts.ts";
import {
  checkAgainstPlan,
  correctionRecord,
  createPlanMemories,
  planAskReason,
  planBlockedText,
  planCategories,
  type PlanChecked,
  rewriteResultPrefix,
} from "./plan-check.ts";
import { createReadSecrets, scopeOf } from "./read-secrets.ts";
import { recordToolCallDetail, toolCallDetail } from "./tool-call-details.ts";
import { appendToolCallRecord, type CallState, newCallState, type ToolCallEnd, toolCallPart } from "./tool-call-record.ts";

/** 一个接上守卫的 agent 会话 */
export interface GuardedSession {
  /** 发起调用的 agent（工作目录、工具包、围栏）：子进程拉起时的那一份 */
  agent: GuardAgent;
  /**
   * 此刻的 agent（27 号票评审后定）：工具包每次判定现取（和关注类别设置每次现读一样），工具包一改，子进程重新装配之前
   * 发起的下一次调用、等审批的调用被批准时都按新的判。不给就用 agent
   */
  currentAgent?: () => GuardAgent;
  /** 这个会话的工具注册表（内置的，加上它的守护进程代为执行的工具、MCP 工具） */
  tools: ToolRegistry;
  /** 对话里调用所在的会话：工具调用记录、审批卡、给 agent 的通知都追加在这里；任务里由 13 号票定 */
  conversation: ConversationId | null;
  /** 审批卡、"交给我做"事项上的来源："秘书对话"，任务里写任务和阶段 */
  source: string;
  /** 项目内部的会话（64 号票）：审批卡、"交给我做"、中断不确定这些事项带上它 */
  internal?: ProjectInternal;
  /** 会话段（不属于任务的调用）：效果日志和时序规则按它划范围 */
  segmentId?: string;
  /** 调用所属的任务（13 号票接）；对话里为 null。判定时交给它发起调用的 agent（77 号票：事件触发的流程按它推出这次运行的授权） */
  task?: (ctx?: GuardTaskContext) => GuardTask | null;
  /**
   * 维护者会话：工具调用记录这些消息带上的归属（任务、项目，素材的"任务或项目"取自这里，12 号票起；任务里还有阶段，25 号票）。
   * 每次判定时取一次，这次调用的记录用那一刻的（宣布阶段完成的那次，记录时已经换到下一个阶段了）
   */
  messageScope?: () => MessageScope;
  /**
   * 这一轮作废了（84 号票：从某个阶段重做时手头那一轮没在限定时间里停下，照 AgentSense 重开时的 generation）：给出原因时，
   * 这一轮之后的调用一律不放行，结果交回原因
   */
  superseded?: () => string | undefined;
}

export interface GuardRuntimeOptions {
  store: EventStore;
  approvals: ApprovalService;
  handOvers: HandOverService;
  /** 子进程意外退出时被中断的、不属于任务的调用在这里放一条"中断不确定"（23 号票） */
  inbox: InboxService;
  clock: Clock;
  /** 守卫看到的数据目录各区、程序目录、用户主目录（都是真实路径） */
  places: GuardPlaces;
  /** 全局的关注类别设置：每次判定现取（数据目录配置区的文件，改了设置立即生效；文件坏了时抛错，这次判定出错） */
  settings: () => WatchCategorySettings;
  /** 子进程里等审批最多等多久（毫秒） */
  approvalWaitMs: number;
  /**
   * 对话审批的开关（70 号票，配置 guard.conversationApprovals，默认 off；101 号票改了 off 的范围）：off 时秘书除了特别敏感的、
   * 任务的 agent 超出授权的"先问我"都由判定函数按"直接做"判（见守卫的 GuardInput.conversationApprovals）；流程的逐步核对
   * （plan-check.ts）不受影响。不给按 on
   */
  conversationApprovals?: ConversationApprovals;
  /**
   * 运行时自动留旧版本的地方（15 号票：项目档案，不含工作目录和历史区）：
   * - covers：守卫的环境事实里对这些路径传 backedUp（v1 模板"删除或覆盖前须已备份或已提交"因此满足）；
   * - preserve：放行一次调用之前（直接放行、一次性授权、用户批准都算），它要删除或整体重写的、covers 认的路径
   *   先交给它留旧版本。抛错就不放行，模型收到原因
   */
  autoVersioning?: { covers(path: string): boolean; preserve(paths: readonly string[]): void };
  /** 子进程里某个 agent 的一次调用开始、不再等用户批准：活动状态的"等你"（25 号票） */
  userWaits?: UserWaits;
  /** 不在等的审批被决定时给 agent 的通知换个说法（20 号票：子 agent 的调用，见 approval-waits.ts） */
  lateNotice?: (decision: LateDecision) => string | undefined;
  log: (line: string) => void;
}

export interface GuardRuntime {
  /** 接上一个 agent 子进程（拉起后、送输入之前）：它的 guard_request 由这里判定。返回撤销的函数 */
  attach(proc: AgentLink, session: GuardedSession): () => void;
  /**
   * 停止：撤掉等审批的计时器；之后来的判定请求一律不放行，子进程退出也不再当成中断（守护进程停止时最先叫它，
   * 还在执行的调用留到下次启动时按被杀恢复）
   */
  stop(): void;
}

/** 流程的计划检查要问的里面，算"超出授权"的（101 号票）：计划外会改东西的、超出步骤写的对象 */
const PLAN_BEYOND_GRANT: ReadonlySet<string> = new Set(["off_plan", "out_of_scope"]);

interface Judged {
  input: GuardInput;
  judgement: GuardJudgement;
  /** 判定用到的关注类别设置（全局的，加上本任务的）：类别 id 换成显示用的名字 */
  settings: CategoryTitles[];
}

export function createGuardRuntime(options: GuardRuntimeOptions): GuardRuntime {
  const { store, handOvers, clock, places, log } = options;
  const waits = createApprovalWaits({
    store,
    approvals: options.approvals,
    clock,
    approvalWaitMs: options.approvalWaitMs,
    ...(options.userWaits ? { userWaits: options.userWaits } : {}),
    ...(options.lateNotice ? { lateNotice: options.lateNotice } : {}),
  });
  /** 守护进程在停止：子进程退出不算中断，新的调用不放行 */
  let stopping = false;
  const time = () => nowIso(new Date(clock.now()));
  /** 读过的密钥值：只在内存里（read-secrets.ts） */
  const readSecrets = createReadSecrets();
  /** 流程执行时：用户点过头的判定、每个"工具|步骤"修过几次（59 号票，只在内存里） */
  const planMemories = createPlanMemories();

  /** 放行之前：这次要删除或整体重写的、自动留旧版本的地方认的路径，先留旧版本（抛错就不放行） */
  const preserveBeforeAllow = (input: GuardInput, judgement: GuardJudgement) => {
    const versioning = options.autoVersioning;
    if (!versioning) return;
    const targets = replacedPaths(judgement.calls, input.tools, agentShellEnv(input.agent, input.places.homeDir)).filter((p) => versioning.covers(p));
    if (targets.length > 0) versioning.preserve(targets);
  };

  /** 这个任务里被判过"永不"的对外对象 */
  const neverObjectsIn = (taskId: string): string[] => [
    ...new Set(
      store
        .read(GUARD_CHANNEL, 0, GUARD_EVENTS.neverRecorded)
        .map((e) => e.payload as NeverRecordedPayload)
        .filter((p) => p.taskId === taskId)
        .flatMap((p) => p.objects),
    ),
  ];

  /** 任务里一次对外调用被判"永不"：记下它的对象（带着授权的会话段不是任务，不记） */
  const recordNever = (state: CallState, { input, judgement }: Judged) => {
    if (!attributedTask(input.task) || !input.task || judgement.disposition !== "never") return;
    const objects = neverObjectsOf(input, judgement);
    if (objects.length === 0) return;
    const payload: NeverRecordedPayload = { taskId: input.task.taskId, objects, tool: state.toolName, time: nowIso(new Date(clock.now())) };
    store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.neverRecorded, payload });
  };

  /** 任务里一次调用被按规则退回（拉回）：记下来，控制器据此计拉回次数（14 号票） */
  const recordPullBack = (state: CallState, origin: CallOrigin, ruleIds: readonly string[]) => {
    if (origin.taskId === null) return;
    const payload: PulledBackPayload = { origin, toolCallId: state.toolCallId, tool: state.toolName, ruleIds: [...ruleIds], time: nowIso(new Date(clock.now())) };
    store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.pulledBack, payload });
  };

  /** 此刻的 agent：现取的工具包；取的时候出错就用拉起时的那一份 */
  const agentNow = (session: GuardedSession): GuardAgent => {
    if (!session.currentAgent) return session.agent;
    try {
      return session.currentAgent();
    } catch (err) {
      log(`取 ${session.agent.agentId} 此刻的工具包出错，按拉起时的判：${err instanceof Error ? err.message : String(err)}`);
      return session.agent;
    }
  };

  /** 判定一次调用：先判一次看要哪些路径和脚本，现取环境事实（加上这个范围里读过的密钥值），再判一次 */
  const judge = (session: GuardedSession, toolName: string, args: unknown): Judged => {
    const agent = agentNow(session);
    const task = session.task?.({ agent, tools: session.tools, homeDir: places.homeDir }) ?? null;
    const settings = options.settings();
    const scope = scopeOf({ task, agent, segmentId: session.segmentId });
    const effectLog = listEffects(store.reader, scope);
    // 同一任务里被判过"永不"的对外对象（13 号票）：之后针对它们的调用至少按"先问我"
    const attributed = attributedTask(task);
    const neverObjects = attributed ? neverObjectsIn(attributed.taskId) : [];
    const base: GuardInput = {
      call: { toolName, args },
      agent,
      places,
      task,
      ...(neverObjects.length > 0 ? { neverObjects } : {}),
      ...(session.segmentId === undefined ? {} : { segmentId: session.segmentId }),
      effectLog,
      settings,
      facts: {},
      tools: session.tools,
      now: clock.now(),
      ...(options.conversationApprovals === undefined ? {} : { conversationApprovals: options.conversationApprovals }),
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
      /** 这次调用从哪儿来；会话里追加的消息带上判定那一刻的归属（和工具调用记录同一份） */
      /** 这次调用从哪儿来；带着授权的会话段（定时作业的一次运行）不属于任务 */
      const originOf = (task: GuardTask | null, state: CallState): CallOrigin => ({
        agentId,
        conversation: session.conversation,
        taskId: attributedTask(task)?.taskId ?? null,
        stageId: attributedTask(task)?.currentStageId ?? null,
        ...(session.segmentId === undefined ? {} : { segmentId: session.segmentId }),
        source: session.source,
        ...internalMark(session.internal),
        ...(session.messageScope === undefined ? {} : { messageScope: state.scope }),
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

      /**
       * 先问我：一次性授权或提交审批、等用户；维护者在任务里碰到没预料到的类别不等，这一支马上停下（14 号票）。
       * 子 agent（20 号票）只做它那一支：照常等用户（等的时候这一支就停着），不先挂起——挂起了它会接着往下做完、交回结果
       */
      const askUser = (state: CallState, { input, judgement, settings }: Judged, reply: (verdict: GuardVerdict) => void) => {
        const origin = originOf(input.task, state);
        const privacy = privacyOf(state);
        const suspend = attributedTask(input.task) !== null && judgement.deviation === "unanticipated" && session.agent.kind !== "sub_agent";
        // 计划检查也要问的（59 号票）：合成一次，审批卡上另列"与已授权的计划不一致"，原因里写明哪里不一致
        const plan = state.plan?.outcome.kind === "ask" ? { checked: state.plan, findings: state.plan.outcome.askAbout } : undefined;
        const asksItself = !judgementExecutes(judgement);
        const reason = [...(asksItself ? [judgement.explanation] : []), ...(plan ? [planAskReason(plan.findings)] : [])].join("\n");
        // 用户批准时再按此刻的工具包判一次（27 号票）：等审批的这段时间工具包被收窄了，没了的能力照样用不到
        const replyNow = (verdict: GuardVerdict) => {
          if (!verdict.allow) return reply(verdict);
          // 同意过一次就别再为同一件事打断：一个步骤删 12 个文件不该弹 12 次（AgentSense 的 rememberConfirmed）
          if (plan) for (const f of plan.findings) planMemories(plan.checked.taskId, plan.checked.planId).confirmed.add(findingKey(f));
          let again: Judged;
          try {
            again = judge(session, state.toolName, state.args);
          } catch (err) {
            state.outcome = "blocked";
            state.blockedBy = "judge_error";
            return reply({ allow: false, reason: `守卫判定出错，这次调用不执行：${err instanceof Error ? err.message : String(err)}` });
          }
          if (!again.judgement.hardRefusal) return reply(verdict);
          state.outcome = "blocked";
          state.blockedBy = "hard_refusal";
          return reply({ allow: false, reason: again.judgement.explanation });
        };
        waits.ask({
          ...(suspend ? { suspendNow: "计划没预料到这类操作，这一支先停下等用户" } : {}),
          origin,
          state,
          fingerprint: callFingerprint({ agentId, taskId: origin.taskId, stageId: origin.stageId, cwd: session.agent.cwd, tool: state.toolName, args: state.args }),
          categories: [...(asksItself ? judgement.categories.map((id) => ({ id, title: categoryTitle(id, settings) })) : []), ...(plan ? planCategories(plan.findings) : [])],
          toolTitle: toolTitle(session.tools, state.toolName),
          args: privacy.deep(state.args),
          argsSummary: privacy.text(summarizeArgs(state.toolName, state.args)),
          reason: privacy.text(reason),
          reply: replyNow,
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
            origin: originOf(input.task, state),
            toolCallId: state.toolCallId,
            tool: state.toolName,
            toolTitle: toolTitle(session.tools, state.toolName),
            argsSummary: privacy.text(summarizeArgs(state.toolName, state.args)),
            calls: steps,
          },
          privacy.text(judgement.explanation),
        );
      };

      /** 放行、开始执行：有副作用的记一笔（23 号票），结束之前被杀就是说不清做没做完的 */
      const startExecution = (state: CallState) => {
        if (!needsExecutionRecord(session.tools, state.toolName, state.judgement)) return;
        const execution: ExecutionRecord = {
          toolCallId: state.toolCallId,
          origin: originOf(state.input?.task ?? null, state),
          tool: state.toolName,
          toolTitle: toolTitle(session.tools, state.toolName),
          call: privacyOf(state).text(callText(session.tools, state.toolName, state.args)),
          startedAt: time(),
        };
        const payload: ToolCallStartedPayload = { execution };
        store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.toolCallStarted, payload });
        state.execution = execution;
      };

      /** 一次自动纠偏：用掉这个"工具|步骤"的一次额度，时间线上记一笔偏离 */
      const corrected = (checked: PlanChecked, spent: string, origin: CallOrigin) => {
        const memory = planMemories(checked.taskId, checked.planId);
        memory.corrections.set(spent, (memory.corrections.get(spent) ?? 0) + 1);
        const correction = checked.outcome.assessment.correction;
        if (correction && session.conversation !== null) store.append(correctionRecord(session.conversation, correction, originScope(origin)));
      };

      /**
       * 流程里和计划比对的结论先处理（59 号票）：引回、改回参数、直接拦下；硬拒绝优先于它们（越出能力或边界，补哪一步都没用）。
       * 要问用户的和第一道合成一次（askUser）；照第一道走的返回 false
       */
      const disposePlan = (state: CallState, judged: Judged, reply: (verdict: GuardVerdict) => void): boolean => {
        const checked = state.plan;
        if (!checked || judged.judgement.hardRefusal !== null) return false;
        const { outcome } = checked;
        const origin = originOf(judged.input.task, state);
        if (outcome.kind === "redirect") {
          // 前置步骤还没做：这次先不执行，把维护者引回计划；不打扰用户，不算拉回
          state.blockedBy = "plan_redirect";
          state.corrected = "redirect";
          corrected(checked, outcome.spent, origin);
          reply({ allow: false, reason: outcome.text });
          return true;
        }
        if (outcome.kind === "rewrite") {
          // 参数按计划改回来了，改后的调用两道都重新判过，直接放行；子进程按改后的参数执行，结果前面写明
          state.args = outcome.args;
          state.input = { ...judged.input, call: { toolName: state.toolName, args: outcome.args } };
          state.judgement = outcome.judgement;
          state.outcome = "allowed";
          state.corrected = "rewrite";
          corrected(checked, outcome.spent, origin);
          const correction = outcome.assessment.correction;
          reply({ allow: true, args: outcome.args, ...(correction ? { resultPrefix: rewriteResultPrefix(correction) } : {}) });
          return true;
        }
        if (outcome.kind === "block") {
          state.blockedBy = "plan_check";
          reply({ allow: false, reason: planBlockedText(outcome.reason) });
          return true;
        }
        if (outcome.kind === "ask" && judgementExecutes(judged.judgement)) {
          // 对话审批关着时任务的 agent 超出授权先不管（101 号票）：要问的只是计划外会改东西的、超出步骤写的对象，直接做，
          // 记录上照常标出（plan.findings、beyondGrant）；步骤先后、检查器出错照旧问
          if (taskAgentLeeway(judged.input) && outcome.askAbout.every((f) => PLAN_BEYOND_GRANT.has(f.kind))) {
            state.outcome = "allowed";
            state.beyondGrant = true;
            reply({ allow: true });
            return true;
          }
          askUser(state, judged, reply);
          return true;
        }
        return false;
      };

      /** 按判定处理：放行、拦下、交给我做、先问我 */
      const dispose = (state: CallState, judged: Judged, reply: (verdict: GuardVerdict) => void) => {
        const { judgement } = judged;
        if (disposePlan(state, judged, reply)) return;
        if (judgementExecutes(judgement)) {
          state.outcome = "allowed";
          reply({ allow: true });
          return;
        }
        if (judgement.hardRefusal) state.blockedBy = "hard_refusal";
        else if (judgement.pullBack) {
          state.blockedBy = "pull_back";
          recordPullBack(state, originOf(judged.input.task, state), judgement.pullBack);
        }
        else if (judgement.disposition === "never") recordNever(state, judged);
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
        const state = newCallState(report, session.messageScope?.(), time());
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
            startExecution(state);
          }
          send(verdict);
        };
        if (stopping) {
          send({ allow: false, reason: "守护进程正在停止，这次调用不执行。" });
          return;
        }
        const superseded = session.superseded?.();
        if (superseded !== undefined) {
          state.outcome = "blocked";
          state.blockedBy = "superseded";
          send({ allow: false, reason: superseded });
          return;
        }
        try {
          const judged = judge(session, report.toolName, report.args);
          Object.assign(state, judged);
          const checked = checkAgainstPlan(judged.input, judged.judgement, store, planMemories);
          if (checked) state.plan = checked;
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
        // 完整的参数和返回另存一份（53 号票，按调用 id 取），排在工具调用记录之前：前端看到记录时就取得到；
        // 也不插在记录和紧跟着的效果日志之间（彻底删除按"紧跟在后面"找效果日志）。存不下不耽误记录
        try {
          recordToolCallDetail(store, toolCallDetail(state, end, { agentId, conversation: session.conversation, toolTitle: toolTitle(session.tools, state.toolName), endedAt: time(), privacy }));
        } catch (err) {
          log(`存 ${agentId} 的 ${state.toolName} 调用的完整内容出错：${err instanceof Error ? err.message : String(err)}`);
        }
        if (session.conversation !== null) appendToolCallRecord(store, session.conversation, state, end, privacy);
        // 记过开始执行的，记它结束了：成功与否、结果摘要（成功的和效果日志同一事务）
        const ok = state.outcome === "allowed" && !end.isError;
        const finished: ToolCallFinishedPayload | undefined = state.execution && {
          toolCallId: state.toolCallId,
          agentId,
          time: time(),
          ok,
          result: toolCallPart(state, end, privacy).resultSummary ?? "",
        };
        // 流程里执行成功的：记下对上了哪一步（59 号票，下次判定时按序重放）
        const committed: PlanCallCommittedPayload | undefined =
          ok && state.plan
            ? { taskId: state.plan.taskId, planId: state.plan.planId, toolCallId: state.toolCallId, tool: state.toolName, stepId: state.plan.outcome.assessment.matchedStep ?? null, time: time() }
            : undefined;
        const also = [
          ...(finished ? [{ channel: GUARD_CHANNEL, type: GUARD_EVENTS.toolCallFinished, payload: finished }] : []),
          ...(committed ? [{ channel: GUARD_CHANNEL, type: GUARD_EVENTS.planCallCommitted, payload: committed }] : []),
        ];
        if (ok && state.input && state.judgement) {
          recordEffects(store, state.input, state.judgement, { callId: state.toolCallId, resultText: end.resultText, at: clock.now(), privacy, also });
        } else if (also.length > 0) store.appendBatch(also);
      };

      /** 子进程退出了，还有开始执行、没结束的调用：被中断了（守护进程停止时不算，下次启动时按被杀恢复） */
      const interruptRunning = () => {
        if (stopping) return;
        for (const state of calls.values()) {
          if (!state.execution) continue;
          log(`${agentId} 的子进程退出时${state.execution.call}还没结束：记成中断，说不清做没做完`);
          store.appendBatch(interruptionEvents(options.inbox, state.execution, time()));
        }
      };

      /** 又出了一条助手消息、这一轮结束了：做完了的调用结果都写进会话了，不用再记着（23 号票） */
      const settle = () => {
        const toolCallIds = unsettledExecutions(store.reader, agentId);
        if (toolCallIds.length === 0) return;
        const payload: ToolCallsSettledPayload = { agentId, toolCallIds, time: time() };
        store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.toolCallsSettled, payload });
      };

      const unsubscribeReports = proc.onReport((report) => {
        switch (report.type) {
          case "guard_request":
            onGuardRequest(report);
            return;
          case "tool_call_end":
            onToolCallEnd(report);
            return;
          case "message_final":
            settle();
            return;
          case "turn_end":
            // 回合结束时不会再有调用在等（中止时子进程已按不放行处理）
            waits.dropOwner(owner);
            settle();
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
      void proc.exited.then(() => {
        interruptRunning();
        detach();
      });
      return detach;
    },
    stop() {
      stopping = true;
      waits.stop();
    },
  };
}
