// 维护者执行任务时的工具（守护进程代为执行，13 号票）：开始阶段、宣布阶段完成、报告进展、转为等我、失败。
// 都绑定在一个任务上（维护者只能对它执行的那个任务做），逻辑在控制器（execution.ts，返回结构化的结果）；
// 给模型看的话都在这里组织：工具结果，以及控制器交给维护者的通知（noticeText）。被拒时原因以出错的工具结果交回维护者。
// 这几个工具都不落入任何关注类别（只改二狗自己的任务状态、产生卡片），在守卫的工具注册表里照样登记、照样先经守卫判定。
import { ACCEPTANCE_VERDICT_LABEL, TASK_STATE_LABEL, TASK_WAIT_REASON_LABEL, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import { authorizationSection, boundaryLines, stageAuthorization, stageBrief } from "./context-block.ts";
import type { AcceptanceVerdict, CompleteStageResult, MaintainerScope, NextUp, StageHandoff, StartStageResult, TaskExecution } from "./execution.ts";
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

export function startStageText(r: StartStageResult): string {
  if (r.alreadyRunning) return `阶段 ${r.stage.stageId} 已经在做了。`;
  return `开始阶段 ${r.stage.stageId}。${r.setAside ? `阶段 ${r.setAside} 先放下，之后能做时优先接着做。` : ""}\n${stageText(r.stage)}`;
}

type StageRef = { stageId: string; title: string };
const stageName = (s: StageRef) => `阶段 ${s.stageId}「${s.title}」`;

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
      readOnlyOrIdempotent: false,
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
