// 维护者执行任务时的工具（守护进程代为执行，13 号票）：开始阶段、宣布阶段完成、报告进展、转为等我、失败；
// 14 号票加了提交计划变更、自行调整计划、标做不了，以及阈值、偏离的说法（这一支为什么停下 stopReasonText、催促、说明进展）；
// 121 号票起这两个工具只交要改的（DRAFT_RULE、removeStages），交来的已验收阶段按现在的定义保留时结果里说明（keptAcceptedText）。
// 125 号票：宣布阶段完成、计划变更、自行调整都能附用户消息的 id（userWords，USER_WORDS_PARAM）：运行时核实过的单独一栏
// （评审的输入、计划变更卡、时间线），没核实过的那几条在结果里说明（refusedUserWordsText），其余照常。
// 都绑定在一个任务上（维护者只能对它执行的那个任务做），逻辑在控制器（execution.ts，返回结构化的结果）；
// 给模型看的话都在这里组织：工具结果，以及控制器交给维护者的通知（noticeText）。被拒时原因以出错的工具结果交回维护者。
// 这几个工具都不落入任何关注类别（只改二狗自己的任务状态、产生卡片），在守卫的工具注册表里照样登记、照样先经守卫判定。
// @i18n-ignore-file model：这里的话都给维护者看（工具说明、工具结果、交给它的通知），照旧中文——用到的协议包说法也包在 forModel 里取中文。
// 给用户看的（这一支为什么停下、用量和预算、重做时改了什么）在 stop-texts.ts；工具的中文名（title）跟着当前语言（172 号票）
import {
  ACCEPTANCE_VERDICT_LABEL,
  forModel,
  PlanDraft,
  type PlanToolkit,
  planChangeItemText,
  refusedUserWordsText,
  type StageEffect,
  TASK_STATE_LABEL,
  t,
  TASK_WAIT_REASON_LABEL,
  type TaskState,
  toolkitText,
  Type,
  type VerifiedUserWords,
  WORKFLOW_STAGE_ID,
} from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { USER_WORDS_PARAM } from "../conversation/user-words.ts";
import { RequestRejected } from "../errors.ts";
import { oneLine } from "../util/text.ts";
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
import { spendText, stageEditLines, stageEditWhat, stopReasonText } from "./stop-texts.ts";
import type { StageSpend } from "./thresholds.ts";
import { type AcceptedDifference, acceptedDifferenceText } from "./plan-change.ts";
import { EXECUTION_TOOL, WORKFLOW_TOOL } from "./tool-names.ts";
import { REPORT_STEP_RULE } from "./workflow-texts.ts";

export { spendText, stageEditLines, stageEditWhat, stopReasonText };

/** 宣布阶段完成要跑验收（脚本、评审子 agent），比默认的工具调用超时长 */
const COMPLETE_STAGE_TIMEOUT_MS = 30 * 60_000;

// ───────────────────────── 给模型看的话 ─────────────────────────

/** 一个阶段从头说一遍：交代、授权和时序规则、边界（开始执行、换阶段、阶段变化的通知）；流程只有一个阶段，说的是接着按步骤做 */
export function stageText(h: StageHandoff): string {
  return forModel(() => {
    if (h.stageId === WORKFLOW_STAGE_ID) return `接着按计划的步骤做（计划和进度见重注入块）。${REPORT_STEP_RULE}`;
    return [
      `现在是第 ${h.code}/${h.layers} 阶段 ${h.stageId}「${h.title}」：`,
      ...stageBrief(h.plan, h.stageId),
      ...(h.notes ?? []),
      // 84 号票（认领时的交代）：之前交过的，带上次数和最近一次没通过的标准
      ...(h.history ? [`这个阶段之前做过 ${h.history.attempts} 次，最近一次没通过的标准：${h.history.lastFailed.join("；") || "（无）"}`] : []),
      ...authorizationSection(stageAuthorization(h.plan, h.stageId, h.grantInfo), boundaryLines(h.plan, h.cwd)),
      `做完调用 ${EXECUTION_TOOL.completeStage} 宣布阶段完成，由运行时验收。`,
    ].join("\n");
  });
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

/** 核实过的用户原话（125 号票）：结果里写一句写进了哪一栏 */
const wordsTaken = (words: readonly VerifiedUserWords[], where: string) => (words.length > 0 ? `你引用的 ${words.length} 条用户原话运行时核实过了，已写进${where}的"${t("protocol.userWords.title")}"一栏。` : "");

export function completeStageText(r: CompleteStageResult): string {
  return forModel(() => {
    return lines(refusedUserWordsText(r.refused ?? []), verdictText(r));
  });
}

function verdictText(r: CompleteStageResult): string {
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

/**
 * 交来的已验收阶段和现在不一样、按现在的定义保留了（121 号票）：
 * "已验收的阶段 s1、s3 交来的定义和现在不一样，已按现在的定义保留（阶段 s1 的验收标准第 2 条和现在不一样；…）；要改已验收的阶段请让用户返工。"
 */
export function keptAcceptedText(kept: readonly AcceptedDifference[]): string {
  return forModel(() => {
    if (kept.length === 0) return "";
    return `已验收的阶段 ${kept.map((k) => k.stageId).join("、")} 交来的定义和现在不一样，已按现在的定义保留（${kept.map(acceptedDifferenceText).join("；")}）；要改已验收的阶段请让用户在任务详情里返工。`;
  });
}

export function proposePlanChangeText(r: PlanChangeProposal): string {
  return forModel(() => {
    return lines(
      `计划变更卡（${r.planId}）已放进用户的待我处理，用户确认后才生效。`,
      wordsTaken(r.userWords.verified, "卡上"),
      refusedUserWordsText(r.userWords.refused),
      keptAcceptedText(r.keptAccepted),
      "改动：",
      ...changeLines(r),
      r.affected.length > 0 ? `只有这些阶段停下等确认：${r.affected.map(stageName).join("、")}；其余阶段照常推进。` : "",
      nextText(r.next),
    );
  });
}

export function revisePlanText(r: PlanRevision): string {
  return forModel(() => {
    return lines(
      `计划已自行调整（第 ${r.revision} 版），记进了任务时间线。`,
      wordsTaken(r.userWords.verified, "时间线那一笔"),
      refusedUserWordsText(r.userWords.refused),
      keptAcceptedText(r.keptAccepted),
      "改动：",
      ...changeLines(r),
      nextText(r.next),
    );
  });
}

export function infeasibleText(r: InfeasibleResult): string {
  return forModel(() => {
    return lines(
      `已把${r.stages.map(stageName).join("、")}标为做不了，用户的待我处理里有一条卡住求助。`,
      r.next.kind === "waiting" ? "没有别的能推进的阶段，任务转等我；在用户回话或点“继续执行”之前不要接着做。" : nextText(r.next),
    );
  });
}

export function startStageText(r: StartStageResult): string {
  return forModel(() => {
    if (r.alreadyRunning) return `阶段 ${r.stage.stageId} 已经在做了。`;
    return `开始阶段 ${r.stage.stageId}。${r.setAside ? `阶段 ${r.setAside} 先放下，之后能做时优先接着做。` : ""}\n${stageText(r.stage)}`;
  });
}

/** 已经做了的一件事，交给维护者的说法：工具名（参数摘要） */
const said = (e: StageEffect) => oneLine(`${e.toolTitle ?? e.tool}（${e.argsSummary}）`, 120);

/** 阶段的说法；流程只有一个内部的阶段，说"流程"（58 号票：流程的维护者看到的是步骤，不是阶段） */
const stageName = (s: StageRef) => (s.stageId === WORKFLOW_STAGE_ID ? "流程" : `阶段 ${s.stageId}「${s.title}」`);

/** 每句都按中文取（给模型看的；里面用到的协议包说法也是中文） */
function inChinese<T extends Record<string, (...args: never[]) => string>>(texts: T): T {
  return Object.fromEntries(Object.entries(texts).map(([k, fn]) => [k, (...args: never[]) => forModel(() => fn(...args))])) as T;
}

/** 控制器交给维护者的通知（它会话里的系统通知） */
export const noticeText = inChinese({
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
  /** 112 号票：在等用户验收的阶段按新规矩（阶段自动验收）交给评审，评审判过了 */
  handedAccepted: (stage: StageRef, next: StageHandoff | undefined) =>
    [`${stageName(stage)}原定由用户验收的标准，按新规矩（阶段自动验收）交给评审验了：通过，这个阶段验收了。`, ...(next ? [stageText(next)] : [])].join("\n"),
  handedReturned: (stage: StageRef, failed: readonly AcceptanceVerdict[]) =>
    lines(
      `${stageName(stage)}原定由用户验收的标准，按新规矩（阶段自动验收）交给评审验了，没通过：`,
      ...resultLines(failed),
      `这个阶段回到未开始；接着做它的时候改好，再调用 ${EXECUTION_TOOL.completeStage}。`,
    ),
  userReturned: (stage: StageRef, why: string | undefined) =>
    `用户验收没通过${stageName(stage)}${why ? `：「${why}」` : "（没写原因，看看用户在会话里说了什么）"}。改好后再调用 ${EXECUTION_TOOL.completeStage}。`,
  resumed: (queued: boolean) => `用户让任务继续了。${queued ? "（执行名额满了，先排队）" : ""}接着做。`,
  stuckResumed: () => "用户让你继续执行（你之前卡住求助了：看看用户在会话里说了什么、做了什么，接着做）。",
  retry: (reason: string | undefined) => `用户让你重试${reason ? `（之前判失败的原因：${reason}）` : ""}。接着做，做不下去再说明原因。`,
  /**
   * 用户从某个阶段重做（返工，84 号票起阶段开始过就能）：重开后交给维护者的那句——重开了哪几个、
   * 用户说了什么，再按依赖重新做，之前那一次的尝试记录开始阶段时会给它；这一段已经做了的事不撤回，分本机、对外说清楚（同
   * 撤回到某处时那句的说法：对外已经做了的撤不回、仍然有效，重做时不要再做一遍，内容不对就跟用户说怎么补救）。
   * state 是重做之后任务的状态：暂停着的等用户继续、排队中的等名额
   */
  rework: (
    stage: StageRef,
    note: string | undefined,
    reopened: readonly string[],
    effectsDone: readonly StageEffect[],
    how: { stopped: boolean; state: TaskState; edited?: { revision: number; lines: readonly string[] } },
  ) => {
    const local = effectsDone.filter((e) => e.reach === "local");
    const external = effectsDone.filter((e) => e.reach === "external");
    const then = how.state === "paused" ? "（任务暂停着：用户继续之后再做）" : how.state === "queued" ? "（执行名额满了，先排队）" : "";
    return [
      `用户从${stageName(stage)}重做${how.stopped ? "（你手头那一轮已经停下）" : ""}：重开了 ${reopened.join("、")}（回到未开始，验收结果清掉），其余阶段不动。${note ? `用户说：「${note}」。` : ""}`,
      // 125 号票：用户在重做时直接改了这一阶段的验收标准、交付件（这就是用户的确认，计划已经换成新的一版）
      ...(how.edited
        ? [`用户在重做时直接改了${stageName(stage)}（这就是用户的确认，计划已换成第 ${how.edited.revision} 版，评审按新的验收；以重注入块里的为准）：`, ...how.edited.lines]
        : []),
      ...(effectsDone.length > 0
        ? [
            `这一段已经做了的事没有撤回：${[local.length > 0 ? `本机 ${local.length} 件（${local.map(said).join("；")}）` : "", external.length > 0 ? `对外 ${external.length} 件（${external.map(said).join("；")}）` : ""].filter(Boolean).join("；")}。` +
              (external.length > 0 ? "对外已经做了的撤不回、仍然有效，重做时不要再做一遍，内容不对就跟用户说怎么补救。" : "本机的改动还在，重做时在它的基础上改。"),
          ]
        : []),
      `再按依赖重新开始、重做；之前那一次的尝试记录开始阶段时会给你。${then}`,
    ].join("\n");
  },
  /**
   * 用户撤回了会话之后（152 号票，撤回到阶段开始前之后让维护者接着做的那句）：任务回到那时的进度，
   * 运行时替你重新开始了一个阶段。stage：撤回到的就是这个阶段开始前；external：被放弃的那段里已经对外做了的（撤不回、仍然有效）；
   * switched：是切换到了另一条分支（151 号票，不写摘要、不作废）
   */
  rolledBack: (how: { stage?: StageRef; external: readonly { toolTitle?: string; tool: string; argsSummary: string }[]; switched?: boolean }) =>
    [
      how.switched
        ? "用户切换到了会话的另一条分支：任务回到这条分支上的进度。"
        : `用户撤回到${how.stage ? `${stageName(how.stage)}开始前` : "之前的一处"}：之后那一段作废了（被放弃的那段写了分支摘要，在上面）${
            how.external.length > 0
              ? `；对外已经做了的 ${how.external.length} 件撤不回、仍然有效（${how.external.map((e) => oneLine(`${e.toolTitle ?? e.tool}（${e.argsSummary}）`, 120)).join("；")}），重做时不要再做一遍，内容不对就跟用户说怎么补救`
              : ""
          }。`,
      how.stage ? "从这一阶段重新开始、重做；之前那一次的尝试记录开始阶段时会给你。" : "从这里接着做。",
    ].join(""),
  /**
   * 274 号票：从某个阶段重做之后，范围外已验收的阶段按各自的验收标准再核一遍，有没过的——重开后交给维护者的那句
   * "另外复验发现 M1 已经不合格，先告诉用户。"；运行时已经放进用户的待办、记进会话，不自动重做，由用户决定
   */
  reverifyFailed: (failed: ReadonlyArray<{ stage: StageRef; criteria: readonly string[] }>) =>
    `另外复验发现 ${failed.map((f) => `${stageName(f.stage)}（没过的标准：${f.criteria.join("；")}）`).join("、")} 已经不合格，先告诉用户（运行时已经放进用户的待办，由用户决定要不要也重做它）；不要自己去重做它。`,
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
    stage.stageId === WORKFLOW_STAGE_ID
      ? `流程已经 ${minutes} 分钟没有成功的工具调用、也没有做完新的步骤了（第 ${n}/${max} 次催促）。说明一下卡在哪一步：能接着做就照计划的步骤接着做（每一步用 ${WORKFLOW_TOOL.reportStep} 汇报）；要用户拍板就用 ${EXECUTION_TOOL.waitForUser}；做不下去用 ${EXECUTION_TOOL.failTask}。催满 ${max} 次还没有进展，运行时会让流程停下找用户。`
      : `${stageName(stage)}已经 ${minutes} 分钟没有成功的工具调用、也没有推进了（第 ${n}/${max} 次催促）。说明一下卡在哪：能接着做就接着做；要用户拍板就用 ${EXECUTION_TOOL.waitForUser}；做不下去用 ${EXECUTION_TOOL.failTask}。催满 ${max} 次还没有进展，运行时会让这一支停下找用户。`,
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
});

// ───────────────────────── 工具 ─────────────────────────

/** 计划变更、自行调整计划怎么交 plan（121 号票：只交要改的） */
const DRAFT_RULE =
  "plan 里只交要改的：要改某个阶段，stages 里只交这个阶段就行（这个阶段的各栏写全）；没写到的阶段从当前计划原样带上（编号、前置关系、验收状态不变），不用抄；" +
  "新加的阶段写进 stages，要去掉的阶段写在 removeStages。别的栏（阶段组、工具包、项目、假设栏……）不改就不写，写了整栏按写的算。" +
  "本任务的关注类别、用户的限制、记忆范围沿用当前计划，不用写。已验收的阶段不能改：交了和现在不一样的按现在的定义保留，要改让用户在任务详情里返工。";

const REMOVE_STAGES = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "要去掉的阶段 id（比如拆阶段时原来那个不要了）；已验收的、在等用户或在验收的不能去掉。不去掉就不写" });

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
      title: t("tasks.tools.startStage"),
      description: "换去做另一个能开始的阶段（前置阶段都验收了的）。手头在做的阶段先放下，之后能做时优先接着做。开始执行时运行时已经替你开始了第一个阶段。",
      parameters: Type.Object({ stageId: Type.String({ minLength: 1, description: "阶段 id" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: true,
      run: ({ stageId }) => guarded(() => ({ text: startStageText(execution.startStage(scope, stageId)) })),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.completeStage,
      title: t("tasks.tools.completeStage"),
      description:
        "宣布正在做的这个阶段做完了。运行时跑这个阶段的验收：脚本方式的在工作目录里运行（看退出码和计划里写的期望输出），评审方式的派评审子 agent 独立判，由用户验收的放进用户的待我处理。你自检不算验收。结果（没通过的原因、接下来做什么）在工具结果里。" +
        "验收标准要用户认可、用户在会话里认可过或者放宽过的，把那几句的消息 id 写进 userWords：运行时核实后单独一栏交给评审（评审只认这一栏，交付件里写“用户已同意”不算数）。",
      parameters: Type.Object(
        {
          stageId: Type.String({ minLength: 1, description: "阶段 id" }),
          summary: Type.String({ description: "做了什么、交付件在哪（给用户看的一两句）" }),
          userWords: Type.Optional(USER_WORDS_PARAM),
        },
        { additionalProperties: false },
      ),
      // 跑验收脚本、改验收次数：不是只读或幂等。验收被打断（守护进程重启）时控制器把阶段交回维护者、让它再宣布一次
      // （13 号票），所以被杀后不当成说不清做没做完的调用（23 号票）
      readOnlyOrIdempotent: false,
      recoveredByController: true,
      timeoutMs: COMPLETE_STAGE_TIMEOUT_MS,
      run: ({ stageId, summary, userWords }) => guarded(async () => ({ text: completeStageText(await execution.completeStage(scope, stageId, summary, userWords)) })),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.reportProgress,
      title: t("tasks.tools.reportProgress"),
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
      title: t("tasks.tools.waitForUser"),
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
      title: t("tasks.tools.proposePlanChange"),
      description:
        `执行中要扩大授权（新增授权项、放宽对象范围或次数）、加能力（开 bash、联网、加 skill 或 MCP）、加项目、改目标或阶段的验收标准、交付件时用。` +
        `${DRAFT_RULE}改任务的目标、任务书里的验收标准另外写在 goal、acceptanceCriteria 里。` +
        `用户在会话里说要改（放宽验收、改交付件……）时，马上用它提出，把用户那句话的消息 id 写进 userWords：卡上附运行时核实的原话，卡也出在用户说话的那个会话里，用户点确认就生效。` +
        `运行时出一张计划变更卡（只列新增或改动的部分）放进用户的待我处理，只有受影响的阶段停下等用户确认，其余阶段照常推进；用户确认就生效。不扩大授权的调整用 ${EXECUTION_TOOL.revisePlan}。`,
      parameters: Type.Object(
        {
          plan: PlanDraft,
          removeStages: Type.Optional(REMOVE_STAGES),
          why: Type.String({ minLength: 1, maxLength: 2000, description: "为什么要改（用户在卡上看得到）" }),
          goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "要改任务的目标时写新的目标；不改就不写" })),
          acceptanceCriteria: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 50, description: "要改任务书里的验收标准时写新的全部标准；不改就不写（各阶段的验收标准写在计划里）" }),
          ),
          stages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "另外要停下等确认的阶段 id（比如加能力只为某个阶段）；不写时由运行时按改动算" })),
          userWords: Type.Optional(USER_WORDS_PARAM),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      run: ({ plan, removeStages, why, goal, acceptanceCriteria, stages, userWords }) =>
        guarded(() => {
          const r = execution.proposePlanChange(scope, {
            plan,
            why,
            ...(removeStages === undefined ? {} : { removeStages }),
            ...(goal === undefined ? {} : { goal }),
            ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
            ...(stages === undefined ? {} : { stages }),
            ...(userWords === undefined ? {} : { userWords }),
          });
          return { text: proposePlanChangeText(r), cardIds: [r.cardId] };
        }),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.revisePlan,
      title: t("tasks.tools.revisePlan"),
      description:
        `执行中自行调整计划：拆阶段、调顺序、改步骤、收窄或去掉授权项、加时序规则这类不扩大授权的改动，直接生效、记进任务时间线。${DRAFT_RULE}` +
        `扩大授权、加能力、加项目、改验收或交付件、加预算的会被拒，要改用 ${EXECUTION_TOOL.proposePlanChange}（计划变更）。`,
      parameters: Type.Object(
        {
          plan: PlanDraft,
          removeStages: Type.Optional(REMOVE_STAGES),
          why: Type.String({ minLength: 1, maxLength: 2000, description: "为什么调整（记进任务时间线）" }),
          userWords: Type.Optional(USER_WORDS_PARAM),
        },
        { additionalProperties: false },
      ),
      // 改原有的计划
      nature: "modify",
      readOnlyOrIdempotent: false,
      run: ({ plan, removeStages, why, userWords }) =>
        guarded(() => ({
          text: revisePlanText(execution.revisePlan(scope, { plan, why, ...(removeStages === undefined ? {} : { removeStages }), ...(userWords === undefined ? {} : { userWords }) })),
        })),
    }),
    defineHostTool({
      name: EXECUTION_TOOL.markInfeasible,
      title: t("tasks.tools.markInfeasible"),
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
      title: t("tasks.tools.failTask"),
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
