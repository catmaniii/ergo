// 维护者执行任务时的工具（守护进程代为执行，13 号票）：开始阶段、宣布阶段完成、报告进展、转为等我、失败；
// 14 号票加了提交计划变更、自行调整计划、标做不了，以及阈值、偏离的说法（这一支为什么停下 stopReasonText、催促、说明进展）。
// 都绑定在一个任务上（维护者只能对它执行的那个任务做），逻辑在控制器（execution.ts，返回结构化的结果）；
// 给模型看的话都在这里组织：工具结果，以及控制器交给维护者的通知（noticeText）。被拒时原因以出错的工具结果交回维护者。
// 这几个工具都不落入任何关注类别（只改二狗自己的任务状态、产生卡片），在守卫的工具注册表里照样登记、照样先经守卫判定。
import { ACCEPTANCE_VERDICT_LABEL, PlanDraft, type PlanToolkit, planChangeItemText, TASK_STATE_LABEL, TASK_WAIT_REASON_LABEL, toolkitText, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import { authorizationSection, boundaryLines, stageAuthorization, stageBrief } from "./context-block.ts";
import type {
  AcceptanceVerdict,
  BranchStopReason,
  CompleteStageResult,
  InfeasibleResult,
  MaintainerScope,
  NextUp,
  PlanChangeProposal,
  PlanRevision,
  StageHandoff,
  StageRef,
  StartStageResult,
  TaskExecution,
} from "./execution.ts";
import type { StageSpend } from "./thresholds.ts";
import { EXECUTION_TOOL } from "./tool-names.ts";

/** 宣布阶段完成要跑验收（脚本、评审子 agent），比默认的工具调用超时长 */
const COMPLETE_STAGE_TIMEOUT_MS = 30 * 60_000;

// ───────────────────────── 给模型看的话 ─────────────────────────

/** 一个阶段从头说一遍：交代、授权和时序规则、边界（开始执行、换阶段、阶段变化的通知） */
export function stageText(h: StageHandoff): string {
  return [
    `现在是第 ${h.n}/${h.total} 阶段 ${h.stageId}「${h.title}」：`,
    ...stageBrief(h.plan, h.stageId),
    ...authorizationSection(stageAuthorization(h.plan, h.stageId, h.grantInfo), boundaryLines(h.plan, h.cwd)),
    `做完调用 ${EXECUTION_TOOL.completeStage} 宣布阶段完成，由运行时验收。`,
  ].join("\n");
}

const resultLines = (results: readonly AcceptanceVerdict[]) =>
  results.map((r) => `- ${r.passed ? "通过" : "没通过"}：${r.criterion}（${ACCEPTANCE_VERDICT_LABEL[r.method]}）${r.note ? `：${r.note}` : ""}`);

/** 接下来做什么（宣布完成的结论末尾） */
function nextText(next: NextUp): string {
  switch (next.kind) {
    case "completed":
      return "全部阶段验收通过，任务完成。";
    case "stage":
      return `接下来：\n${stageText(next.stage)}`;
    case "waiting":
      return `没有别的能推进的阶段，任务转等我（${TASK_WAIT_REASON_LABEL[next.reason]}）。`;
    case "continue":
      return "";
  }
}

/** 几行拼起来（空的去掉） */
const lines = (...xs: string[]) => xs.filter(Boolean).join("\n");

export function completeStageText(r: CompleteStageResult): string {
  switch (r.outcome) {
    case "void":
      return `任务现在是${TASK_STATE_LABEL[r.state]}，这次验收作废。`;
    case "returned":
      return lines(`阶段 ${r.stageId} 验收没通过（${ACCEPTANCE_VERDICT_LABEL[r.judgedBy]}）：`, ...resultLines(r.results), `改好后再调用 ${EXECUTION_TOOL.completeStage}。`);
    case "stuck":
      return lines(
        `阶段 ${r.stageId} 验收第 ${r.attempts} 次还没通过（${ACCEPTANCE_VERDICT_LABEL[r.judgedBy]}）：`,
        ...resultLines(r.results),
        "退回次数超了，这一支停下等用户拍板（待我处理里有一条卡住求助）；用户回话或点“继续执行”后你会收到通知，在那之前不要再改这个阶段。",
        nextText(r.next),
      );
    case "awaiting_user":
      return lines(
        `阶段 ${r.stageId} 能自动判的都通过了${r.results.length > 0 ? `：\n${resultLines(r.results).join("\n")}` : "。"}`,
        "还有由用户验收的标准，已放进用户的待我处理；用户验收前这个阶段不算完成。",
        nextText(r.next),
      );
    case "accepted":
      return lines(`阶段 ${r.stageId} 验收通过（${ACCEPTANCE_VERDICT_LABEL[r.judgedBy]}）：`, ...resultLines(r.results), nextText(r.next));
  }
}

const changeLines = (r: { changes: PlanChangeProposal["changes"] }) => r.changes.map((c) => `- ${planChangeItemText(c)}`);

export function proposePlanChangeText(r: PlanChangeProposal): string {
  return lines(
    `计划变更卡（${r.planId}）已放进用户的待我处理，用户确认后才生效。改动：`,
    ...changeLines(r),
    r.affected.length > 0 ? `只有这些阶段停下等确认：${r.affected.map(stageName).join("、")}；其余阶段照常推进。` : "",
    nextText(r.next),
  );
}

export function revisePlanText(r: PlanRevision): string {
  return lines(`计划已自行调整（第 ${r.revision} 版），记进了任务时间线：`, ...changeLines(r), nextText(r.next));
}

export function infeasibleText(r: InfeasibleResult): string {
  return lines(
    `已把${r.stages.map(stageName).join("、")}标为做不了，用户的待我处理里有一条卡住求助。`,
    r.next.kind === "waiting" ? "没有别的能推进的阶段，任务转等我；在用户回话或点“继续执行”之前不要接着做。" : nextText(r.next),
  );
}

export function startStageText(r: StartStageResult): string {
  if (r.alreadyRunning) return `阶段 ${r.stage.stageId} 已经在做了。`;
  return `开始阶段 ${r.stage.stageId}。${r.setAside ? `阶段 ${r.setAside} 先放下，之后能做时优先接着做。` : ""}\n${stageText(r.stage)}`;
}

const stageName = (s: StageRef) => `阶段 ${s.stageId}「${s.title}」`;

/** 用量和预算："用了 1200 token、5 次工具调用（预算 1000 token、2 次）" */
export const spendText = (used: StageSpend, budget: StageSpend) =>
  `用了 ${used.tokens} token、${used.toolCalls} 次工具调用（预算 ${budget.tokens} token、${budget.toolCalls} 次）`;

/** 这一支为什么停下（给维护者的通知、待我处理事项、任务和阶段上的说明共用一句） */
export function stopReasonText(reason: BranchStopReason): string {
  switch (reason.kind) {
    case "pull_backs":
      return `被拉回（按规则退回）${reason.count - 1} 次后又被拉回（${reason.tool}：${reason.ruleIds.join("、")}）`;
    case "stall":
      return `${reason.minutes} 分钟没有进展，催了 ${reason.nudges} 次仍没有进展`;
    case "acceptance":
      return `验收退回 ${reason.returns - 1} 次后，第 ${reason.returns} 次还没通过（${ACCEPTANCE_VERDICT_LABEL[reason.judgedBy]}）`;
    case "over_budget":
      return `${spendText(reason.used, reason.budget)}，超过预算的 ${reason.times} 倍`;
    case "infeasible":
      return `做不了：${reason.reason}`;
  }
}

/** 控制器交给维护者的通知（它会话里的系统通知） */
export const noticeText = {
  /** 第一次开始执行（排队中开始、或者没开始过就继续了） */
  started: (task: { id: string; title: string }, stage: StageHandoff | undefined) =>
    [`计划已确认，开始执行任务 ${task.id}「${task.title}」。`, ...(stage ? [stageText(stage)] : [])].join("\n"),
  /** 一支停下等用户，先做别的阶段 */
  branchWaits: (stage: StageRef, what: string, next: StageHandoff) => `${stageName(stage)}在${what}，这一支先停下。先做不依赖它的阶段：\n${stageText(next)}`,
  /** 挂起的审批批准了，可当前不是那个阶段：先切回去再重试（授权和调用指纹都按阶段） */
  approvedElsewhere: (stage: StageRef, current: StageRef & { accepting: boolean }) =>
    current.accepting
      ? `${stageName(stage)}挂起的那次调用已获批准，但现在${stageName(current)}正在验收。等它有结论后用 ${EXECUTION_TOOL.startStage} 切回 ${stage.stageId}，再原样重试（批准只在 ${stage.stageId} 里有效）。`
      : `${stageName(stage)}挂起的那次调用已获批准，但现在在做的是${stageName(current)}。要重试，先调用 ${EXECUTION_TOOL.startStage} 切回 ${stage.stageId}，再原样调用一次（批准只在 ${stage.stageId} 里有效，在别的阶段里重试会再问用户）。`,
  userAccepted: (stage: StageRef, next: StageHandoff | undefined) => [`用户验收通过了${stageName(stage)}。`, ...(next ? [stageText(next)] : [])].join("\n"),
  userReturned: (stage: StageRef, why: string | undefined) =>
    `用户验收没通过${stageName(stage)}${why ? `：「${why}」` : "（没写原因，看看用户在会话里说了什么）"}。改好后再调用 ${EXECUTION_TOOL.completeStage}。`,
  resumed: (queued: boolean) => `用户让任务继续了。${queued ? "（执行名额满了，先排队）" : ""}接着做。`,
  stuckResumed: () => "用户让你继续执行（你之前卡住求助了：看看用户在会话里说了什么、做了什么，接着做）。",
  retry: (reason: string | undefined) => `用户让你重试${reason ? `（之前判失败的原因：${reason}）` : ""}。接着做，做不下去再说明原因。`,
  rework: (stage: StageRef, note: string | undefined, reopened: readonly string[], queued: boolean) =>
    `用户要求返工${stageName(stage)}${note ? `：「${note}」` : ""}。重开了 ${reopened.join("、")}，其余阶段保持已验收。${queued ? "（执行名额满了，先排队）" : ""}`,
  acceptanceInterrupted: (stage: StageRef) => `${stageName(stage)}的验收被打断了（守护进程重启），没有结论。再调用 ${EXECUTION_TOOL.completeStage} 宣布一次完成。`,
  /** 中断不确定之后（23 号票）用户在任务详情里点了"继续"：why 是"中断：不确定 X 是否已执行" */
  interruptedResumed: (why: string) => `用户让你继续执行（之前${why}：看看用户在会话里说了什么；没说的话先查一下那次调用的效果，再决定要不要重做，别重复做）。`,
  /** 中断不确定之后用户在待我处理里说了那次调用（call）做没做 */
  interruptedAnswered: (call: string, executed: boolean) =>
    executed ? `用户确认过了：${call}已经执行了，不要重做，接着往下做。` : `用户确认过了：${call}没有执行，重做这一步，然后接着往下做。`,
  // ───── 14 号票 ─────
  /** 这一支停下找用户（阈值超了、做不了、超预算）：有别的阶段能做就交代它，没有就说任务转等我 */
  branchStopped: (stages: readonly StageRef[], reason: BranchStopReason, next: StageHandoff | undefined) => {
    const overBudget = reason.kind === "over_budget";
    const why = `${overBudget ? "超预算" : "卡住求助"}：${stopReasonText(reason)}`;
    // 超预算只有用户点"追加预算继续"才接着做：会话里的话照常回答，但不算让你接着做
    const until = overBudget
      ? "用户点“追加预算继续”后你会收到通知；在那之前用户在会话里说的话照常回答，但不要接着做"
      : "用户回话或点“继续执行”后你会收到通知，在那之前不要接着做";
    return next
      ? `${stages.map(stageName).join("、")}这一支停下等用户（${why}），先别再做它（${until}）。先做不依赖它的阶段：\n${stageText(next)}`
      : `${stages.map(stageName).join("、")}这一支停下等用户（${why}），先别再做它。没有别的能推进的阶段，任务转等我；${until}。`;
  },
  /** 用户让停下的这一支接着走 */
  branchResumed: (stages: readonly (StageRef & { waitNote?: string | undefined })[]) =>
    `用户让${stages.map(stageName).join("、")}接着做（之前停下是因为：${stages.map((s) => s.waitNote ?? "等用户").join("；")}）。看看用户在会话里说了什么，换个做法接着做；计数已经清零。`,
  /** 无进展的催促 */
  nudge: (stage: StageRef, minutes: number, n: number, max: number) =>
    `${stageName(stage)}已经 ${minutes} 分钟没有成功的工具调用、也没有推进了（第 ${n}/${max} 次催促）。说明一下卡在哪：能接着做就接着做；要用户拍板就用 ${EXECUTION_TOOL.waitForUser}；做不下去用 ${EXECUTION_TOOL.failTask}。催满 ${max} 次还没有进展，运行时会让这一支停下找用户。`,
  /** 用量超过预算：说明进展；askTimes 是超过预算的几倍时运行时让这一支停下 */
  budgetExplain: (stage: StageRef, spend: { used: StageSpend; budget: StageSpend }, askTimes: number) =>
    `${stageName(stage)}的用量已经超过预算：${spendText(spend.used, spend.budget)}。用 ${EXECUTION_TOOL.reportProgress} 说明一下进展：做到哪了、还要多少、为什么超了；用量超过预算的 ${askTimes} 倍时运行时会让这一支停下找用户。`,
  /** 用户确认了计划变更 */
  planChangeConfirmed: (r: {
    changes: readonly string[];
    removed: readonly string[];
    narrowed: readonly string[];
    toolkit: { added: readonly string[]; after: PlanToolkit } | undefined;
    resumed: readonly StageRef[];
  }) =>
    [
      "用户确认了计划变更，计划和授权已更新：",
      ...r.changes.map((c) => `- ${c}`),
      ...(r.removed.length > 0 ? [`用户勾掉了这几项授权：${r.removed.join("、")}（执行到那一步再问用户）`] : []),
      ...(r.narrowed.length > 0 ? [`用户收窄了授权项 ${r.narrowed.join("、")}（以重注入块里的为准）`] : []),
      ...(r.toolkit
        ? [`工具包已变更：${toolkitText(r.toolkit.after)}${r.toolkit.added.length > 0 ? `（新加：${r.toolkit.added.join("、")}）` : ""}。运行时会等你做完手头这一步，按新工具包重新拉起你，接着同一个会话。`]
        : []),
      ...(r.resumed.length > 0 ? [`${r.resumed.map(stageName).join("、")}可以接着做了。`] : []),
    ].join("\n"),
  /** 用户拒绝了计划变更：在现有授权内重排，做不到就标做不了 */
  planChangeRejected: (note: string | undefined, stages: readonly StageRef[]) =>
    `用户拒绝了计划变更${note ? `：「${note}」` : ""}。在现有授权内重排受影响的阶段${stages.length > 0 ? `（${stages.map(stageName).join("、")}）` : ""}：用 ${EXECUTION_TOOL.revisePlan} 自行调整计划（不扩大授权，不出卡，记进时间线）；在现有授权内做不到，就用 ${EXECUTION_TOOL.markInfeasible} 把这些阶段标做不了。`,
};

// ───────────────────────── 工具 ─────────────────────────

/** 控制器拒绝的（RequestRejected）作为出错的结果交回维护者，别的错照常抛 */
async function guarded(run: () => HostToolOutput | Promise<HostToolOutput>): Promise<HostToolOutput> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RequestRejected) return { text: err.message, isError: true };
    throw err;
  }
}

export function executionTools(execution: TaskExecution, scope: MaintainerScope): HostTool[] {
  return [
    defineHostTool({
      name: EXECUTION_TOOL.startStage,
      title: "开始阶段",
      description: "换去做另一个能开始的阶段（前置阶段都验收了的）。手头在做的阶段先放下，之后能做时优先接着做。开始执行时运行时已经替你开始了第一个阶段。",
      parameters: Type.Object({ stageId: Type.String({ minLength: 1, description: "阶段 id" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: true,
      run: ({ stageId }) => guarded(() => ({ text: startStageText(execution.startStage(scope, stageId)) })),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.completeStage,
      title: "宣布阶段完成",
      description:
        "宣布正在做的这个阶段做完了。运行时跑这个阶段的验收：脚本方式的在工作目录里运行（看退出码和计划里写的期望输出），评审方式的派评审子 agent 独立判，由用户验收的放进用户的待我处理。你自检不算验收。结果（没通过的原因、接下来做什么）在工具结果里。",
      parameters: Type.Object(
        {
          stageId: Type.String({ minLength: 1, description: "阶段 id" }),
          summary: Type.String({ description: "做了什么、交付件在哪（给用户看的一两句）" }),
        },
        { additionalProperties: false },
      ),
      // 跑验收脚本、改验收次数：不是只读或幂等。验收被打断（守护进程重启）时控制器把阶段交回维护者、让它再宣布一次
      // （13 号票），所以被杀后不当成说不清做没做完的调用（23 号票）
      readOnlyOrIdempotent: false,
      recoveredByController: true,
      timeoutMs: COMPLETE_STAGE_TIMEOUT_MS,
      run: ({ stageId, summary }) => guarded(async () => ({ text: completeStageText(await execution.completeStage(scope, stageId, summary)) })),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.reportProgress,
      title: "报告进展",
      description: "报告当前阶段的进展：任务时间线上出现一张进度卡（不打扰用户）。",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000, description: "进展说明" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: false,
      run: ({ text }) =>
        guarded(() => {
          const { cardId } = execution.reportProgress(scope, text);
          return { text: "进展已报告（进度卡出现在任务时间线上）。", cardIds: [cardId] };
        }),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.waitForUser,
      title: "转为等我",
      description: "卡住了、要用户拍板：任务转等我，原因写在任务卡和用户的待我处理里。用户回话或点“继续执行”后你会收到通知。",
      parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000, description: "卡在哪、要用户做什么决定" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: false,
      run: ({ reason }) =>
        guarded(() => {
          execution.waitForUser(scope, reason);
          return { text: "任务已转等我，原因写在任务卡和待我处理里。用户回话或点“继续执行”后你会收到通知；在那之前不要接着做。" };
        }),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.proposePlanChange,
      title: "提交计划变更",
      description:
        `执行中要扩大授权（新增授权项、放宽对象范围或次数）、加能力（开 bash、联网、加 skill 或 MCP）、加项目、改目标或验收标准时，交出改过的整份计划（本任务的关注类别、用户的限制、定时作业、记忆范围沿用当前计划，不用写）；改任务的目标、验收标准另外写在 goal、acceptanceCriteria 里。` +
        `运行时出一张计划变更卡（只列新增或改动的部分）放进用户的待我处理，只有受影响的阶段停下等用户确认，其余阶段照常推进。不扩大授权的调整用 ${EXECUTION_TOOL.revisePlan}。`,
      parameters: Type.Object(
        {
          plan: PlanDraft,
          why: Type.String({ minLength: 1, maxLength: 2000, description: "为什么要改（用户在卡上看得到）" }),
          goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "要改任务的目标时写新的目标；不改就不写" })),
          acceptanceCriteria: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 50, description: "要改任务书里的验收标准时写新的全部标准；不改就不写（各阶段的验收标准写在计划里）" }),
          ),
          stages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "另外要停下等确认的阶段 id（比如加能力只为某个阶段）；不写时由运行时按改动算" })),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      run: ({ plan, why, goal, acceptanceCriteria, stages }) =>
        guarded(() => {
          const r = execution.proposePlanChange(scope, {
            plan,
            why,
            ...(goal === undefined ? {} : { goal }),
            ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
            ...(stages === undefined ? {} : { stages }),
          });
          return { text: proposePlanChangeText(r), cardIds: [r.cardId] };
        }),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.revisePlan,
      title: "自行调整计划",
      description:
        `执行中自行调整计划：拆阶段、调顺序、改步骤、收窄或去掉授权项、加时序规则这类不扩大授权的改动，交出改过的整份计划（本任务的关注类别、用户的限制、定时作业、记忆范围沿用当前计划，不用写），直接生效、记进任务时间线。` +
        `扩大授权、加能力、加项目、改验收或交付件、加预算的会被拒，要改用 ${EXECUTION_TOOL.proposePlanChange}（计划变更）；已验收的阶段不能改。`,
      parameters: Type.Object({ plan: PlanDraft, why: Type.String({ minLength: 1, maxLength: 2000, description: "为什么调整（记进任务时间线）" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: false,
      run: ({ plan, why }) => guarded(() => ({ text: revisePlanText(execution.revisePlan(scope, { plan, why })) })),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.markInfeasible,
      title: "标做不了",
      description: "计划变更被拒、在现有授权内也重排不了时，把这些阶段标成做不了（写明原因）：这一支停下，用户的待我处理里有一条卡住求助，没有别的能推进的阶段时任务转等我。",
      parameters: Type.Object(
        {
          stageIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "做不了的阶段 id" }),
          reason: Type.String({ minLength: 1, maxLength: 1000, description: "为什么做不了、要用户怎么决定" }),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      run: ({ stageIds, reason }) => guarded(() => ({ text: infeasibleText(execution.markInfeasible(scope, { stageIds, reason })) })),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.failTask,
      title: "任务失败",
      description: "判这个任务失败（做不下去了），必须写明原因。用户会决定重试还是取消。",
      parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000, description: "为什么失败" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: false,
      run: ({ reason }) =>
        guarded(() => {
          execution.fail(scope, reason);
          return { text: "任务已标为失败，用户会看到原因，决定重试还是取消。" };
        }),
    }),
  ];
}
