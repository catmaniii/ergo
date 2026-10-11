// 流程的会话和计划详情（60 号票，ADR 0019、0025）：照搬 AgentSense 固定计划的界面要的数据，纯函数，界面只管画。
// 对照的是 AgentSense web/src/（D:\code\claudecode\user_agent_sense_of_security，bedf5a5）：
// - 顶栏的进度条（App.tsx：done = 计划里状态是"做完"的步数，total = 计划的步数；跳过的不算做完）→ workflowProgress；
// - 计划台账（ui/PlanTimeline.tsx：这个会话里提过的每一份计划，按先后；当前那份写"做完几步/共几步"，别的只写步数）→ workflowPlanLedger；
// - 历史底部"接下来的计划"（agent/sessionView.ts 的 planSlots / pendingSlots / offPlanBlocks，ui/ZoomHistory.tsx 的 zh-future）：
//   计划里每一步一格，做完的不再列，没做的画虚线、在做的转实线、跳过的划掉、失败的标红；落在这一格上的偏离翻成人话标在格里，
//   被自动修回的另写一行；还有"计划外动作 N 个"→ workflowFuture；
// - 计划详情（ui/DetailPane.tsx 的 PlanDetail：涉及的敏感信息、步骤、版本差异、计划审查、检测项全览）→ workflowPlanDetail；
//   检测项全览（ui/RuleBook.tsx）的一条条规则 → ruleBook。
// 二狗的数据：计划是流程计划卡（workflow_plan）上的那份；执行中各步的状态是看板上的 Task.steps.list（维护者 report_step 自报、
// 守护进程推断，59 号票）；每次调用和计划比对的结果在工具调用 part 的 plan 上（60 号票：算在哪一步、查出的问题、用上的自动纠偏）。
// 定时触发的流程（76 号票）每次运行一段：各步的状态记在这次运行上（JobRun.steps），进度条、虚线框都按这一次运行算——
// 正在跑的那一次；没在跑的看最近开始过的那一次；还没跑过的按计划全是没做。虚线框里的偏离也只看这一次运行的调用。
import {
  type Card,
  type JobRun,
  type Task,
  type TaskStep,
  type WorkflowPlan,
  type WorkflowPlanCardPayload,
  type WorkflowReview,
  type WorkflowStepMark,
  type WorkflowStepState,
  type WorkflowStepView,
  eventPassOf,
  isPlainTask,
  isTriggered,
  taskKind,
  WORKFLOW_REVIEW_STATUS_LABEL,
} from "./protocol.ts";
import type { ChatItem, ChatToolCall } from "./chat-items.ts";
import { apiFormulaOf, formulaOf, objectiveText, type RepairOption, repairsOf, type RuleFormula } from "./ltl.ts";
import { jobRuns } from "./scheduled-jobs.ts";
import { stepsDone, workflowPlanCategoryCount } from "./workflow-card.ts";
import { runNo, taskTriggerJob } from "./triggers.ts";
import type { UiState } from "./ui-state.ts";

// ───────────────────────── 计划卡 ─────────────────────────

/** 一张流程计划卡 */
export interface WorkflowPlanCard {
  readonly card: Card;
  readonly payload: WorkflowPlanCardPayload;
}

/** 某个任务的全部流程计划卡，按版本先后（卡片频道上收到过的，不看会话翻没翻到那里） */
export function workflowPlanCards(state: UiState, taskId: string): WorkflowPlanCard[] {
  return Object.values(state.cards)
    .filter((c) => c.card.type === "workflow_plan" && (c.card.payload as WorkflowPlanCardPayload).taskId === taskId)
    .map((c) => ({ card: c.card, payload: c.card.payload as WorkflowPlanCardPayload }))
    .toSorted((a, b) => a.payload.revision - b.payload.revision || a.card.createdAt.localeCompare(b.card.createdAt));
}

/** 授权了的那份（用户在卡上点了授权执行）：任务看板上记着的最新那张，是授权过的才算 */
export function authorizedWorkflowPlan(state: UiState, taskId: string): WorkflowPlanCard | undefined {
  const task = state.tasks[taskId];
  const card = task?.planCardId ? state.cards[task.planCardId]?.card : undefined;
  if (card?.type !== "workflow_plan" || card.outcome?.action !== "confirm") return undefined;
  return { card, payload: card.payload as WorkflowPlanCardPayload };
}

/**
 * 一份计划现在怎样（AgentSense sessionView.ts 的 planStateLabel：审查退回、审查阻止、待授权、已授权、已拒绝）。
 * 二狗多的几种：退回、不可执行的那版点了"让维护者改""取消任务""知道了"，没处理就被新的一版换掉了（已过期）
 */
export function workflowPlanStateLabel(card: Card): string {
  const p = card.payload as WorkflowPlanCardPayload;
  if (p.refused === "needs_replan") return "审查退回";
  if (p.refused === "blocked") return "审查阻止";
  if (card.status === "pending") return "待授权";
  if (card.status === "expired") return "已过期";
  if (card.status === "dismissed") return "已关掉";
  switch (card.outcome?.action) {
    case "confirm":
      return "已授权";
    case "reject":
      return "已拒绝";
    case "cancel":
      return "已取消任务";
    default:
      return "已处理";
  }
}

/** 状态的颜色：授权了的绿，拒绝、阻止的红，别的不着色（AgentSense DetailPane 的 dt-status ok / no） */
export function workflowPlanStateTone(card: Card): "ok" | "no" | "" {
  const p = card.payload as WorkflowPlanCardPayload;
  if (p.refused === "blocked" || card.outcome?.action === "reject" || card.outcome?.action === "cancel") return "no";
  return card.outcome?.action === "confirm" ? "ok" : "";
}

// ───────────────────────── 这一次的进度 ─────────────────────────

/**
 * 定时触发的流程按哪一次运行算：正在跑的那一次；没在跑的看最近开始过的那一次（它的结果）；还没跑过的没有。
 * 一次性的流程没有
 */
export function workflowCurrentRun(state: UiState, taskId: string): JobRun | undefined {
  const task = state.tasks[taskId];
  if (!task || !isTriggered(task)) return undefined;
  const job = taskTriggerJob(state, taskId);
  if (!job) return undefined;
  const runs = jobRuns(state, job.id);
  return runs.findLast((r) => r.state === "running") ?? runs.findLast((r) => r.startedAt !== undefined);
}

/** 这一次各步的状态（按步骤 id）：一次性的取看板上的任务，定时触发的取这一次运行的；还没开始的是空的（都算没做） */
export function workflowStepStates(state: UiState, taskId: string): Record<string, TaskStep> {
  const task = state.tasks[taskId];
  if (!task) return {};
  const list = isTriggered(task) ? workflowCurrentRun(state, taskId)?.steps : task.steps?.list;
  return Object.fromEntries((list ?? []).map((s) => [s.stepId, s]));
}

/**
 * 这一次要照的步骤：一次性的、定时触发的就是授权的那份计划的步骤；事件触发的（77 号票）一批里有几个事件就各走一遍——
 * 这次运行记着的步骤编号是 s1.e1、s1.e2……，按它把计划的步骤一遍遍排出来（标题用这次运行记着的，写着代入的值和第几个事件）
 */
export function stepsThisRun(state: UiState, taskId: string, steps: readonly WorkflowStepView[]): readonly WorkflowStepView[] {
  const task = state.tasks[taskId];
  const list = task && isTriggered(task) ? workflowCurrentRun(state, taskId)?.steps : undefined;
  if (!list || !list.some((s) => eventPassOf(s.stepId))) return steps;
  const byId = new Map(steps.map((s) => [s.id, s]));
  return list.flatMap((r) => {
    const pass = eventPassOf(r.stepId);
    const base = byId.get(pass?.stepId ?? r.stepId);
    if (!base) return [];
    const suffix = pass ? `.e${pass.pass}` : "";
    return [{ ...base, id: r.stepId, title: r.title, after: base.after.map((a) => `${a}${suffix}`) }];
  });
}

/** 顶栏的进度条（AgentSense App.tsx）：做完几步 / 共几步，第几版计划；定时触发的流程还带着按的是第几次运行 */
export interface WorkflowProgress {
  readonly done: number;
  readonly total: number;
  readonly version: number;
  /** 定时触发的流程：这一次是第几次运行（还没跑过的没有） */
  readonly run?: { readonly no: number };
}

/** 流程的进度：有授权了的计划才有（AgentSense 的 task?.plan）；不是流程的没有 */
export function workflowProgress(state: UiState, taskId: string): WorkflowProgress | undefined {
  const task = state.tasks[taskId];
  if (!task || taskKind(task) !== "workflow") return undefined;
  const plan = authorizedWorkflowPlan(state, taskId);
  if (!plan) return undefined;
  const states = workflowStepStates(state, taskId);
  const steps = stepsThisRun(state, taskId, plan.payload.plan.steps);
  const run = workflowCurrentRun(state, taskId);
  return {
    done: stepsDone(steps.flatMap((s) => (states[s.id] ? [states[s.id]!] : []))),
    total: steps.length,
    version: plan.payload.revision,
    ...(run ? { run: { no: runNo(run.runId) } } : {}),
  };
}

/** 看板卡上的进度：做完 / 共几个，单位是步（流程）还是阶段（长程任务）；定时触发的流程带上第几次运行 */
export interface BoardProgress {
  readonly done: number;
  readonly total: number;
  readonly unit: "step" | "stage";
  readonly run?: number;
}

/** 长程任务的计划授权了没有：计划卡（或后来确认的计划变更卡）上点了确认，或者已经开始执行（有了各阶段的状态） */
function stagePlanAuthorized(state: UiState, task: Task): boolean {
  if (task.stages?.list) return true;
  const card = task.planCardId ? state.cards[task.planCardId]?.card : undefined;
  return card?.outcome?.action === "confirm";
}

/**
 * 看板卡、项目页上的进度（照 AgentSense 会话列表的进度条：已完成 / 总数）：流程是做完的步数（stepsDone，同标题栏的进度条；
 * 定时触发的按这一次运行，带上第几次）；长程任务是已验收的阶段数（AgentSense 的 milestoneProgress；计划变更去掉的阶段已经不在
 * 看板上的那一份里）。照 AgentSense，计划授权了才有进度——之前（规划中、计划等你确认）两种做法都是 0/0，写"尚无计划"。
 * 普通任务没有（75 号票）
 */
export function taskBoardProgress(state: UiState, task: Task): BoardProgress | undefined {
  if (isPlainTask(task)) return undefined;
  if (taskKind(task) === "workflow") {
    const workflow = workflowProgress(state, task.id);
    return workflow ? { done: workflow.done, total: workflow.total, unit: "step", ...(workflow.run ? { run: workflow.run.no } : {}) } : { done: 0, total: 0, unit: "step" };
  }
  if (!stagePlanAuthorized(state, task)) return { done: 0, total: 0, unit: "stage" };
  const list = task.stages?.list;
  if (!list) return { done: 0, total: task.stages?.total ?? 0, unit: "stage" };
  return { done: list.filter((s) => s.state === "accepted").length, total: list.length, unit: "stage" };
}

// ───────────────────────── 计划台账 ─────────────────────────

/** 计划台账里的一行（AgentSense PlanTimeline 的 pt-row） */
export interface PlanLedgerRow {
  readonly cardId: string;
  /** 会话里这张卡的那一条（已经翻到的）：点了打开它的详情；没翻到的按卡打开 */
  readonly itemId: string | undefined;
  readonly version: number;
  /** 审查退回、审查阻止、待授权、已授权、已拒绝…… */
  readonly state: string;
  /** 正在执行的那份（授权了的、看板上任务记着的那张） */
  readonly live: boolean;
  /** "2/4 步"（当前那份）或"4 步" */
  readonly steps: string;
  readonly goal: string;
  /** 审查的结论、查出几处风险、自动修复几项、涉及几个关注类别、审查花了多久 */
  readonly meta: string;
}

/** 卡片 id → 会话里那一条的 id（已经翻到的） */
function cardItemIds(items: readonly ChatItem[]): Map<string, string> {
  return new Map(items.flatMap((it) => (it.kind === "card" ? [[it.cardId, it.id] as const] : [])));
}

/**
 * 计划台账（AgentSense PlanTimeline）：这个任务提过的每一份计划，按先后。顶上的进度条只说"当前这份做到第几步"，
 * 但流程可能改过好几版计划——哪一版被审查退回、哪一版是修补后授权的、哪一版被你拒了，都该能翻回去看
 */
export function workflowPlanLedger(state: UiState, taskId: string, items: readonly ChatItem[]): PlanLedgerRow[] {
  const live = authorizedWorkflowPlan(state, taskId);
  const progress = workflowProgress(state, taskId);
  const itemOf = cardItemIds(items);
  return workflowPlanCards(state, taskId).map(({ card, payload: p }) => {
    const isLive = live?.card.id === card.id;
    const rv = p.plan.review;
    const watched = workflowPlanCategoryCount(p.plan);
    const total = p.plan.steps.length;
    const meta = [
      rv.verdict === "skipped" ? "未审查" : WORKFLOW_REVIEW_STATUS_LABEL[rv.status ?? "pass"].label,
      rv.violations.length > 0 ? ` · 查出 ${rv.violations.length} 处风险` : "",
      rv.actions.length > 0 ? ` · 自动修复 ${rv.actions.length} 项` : "",
      watched > 0 ? ` · ⚠ 涉及 ${watched} 个关注类别` : "",
      ` · ${Math.round(rv.ms)}ms`,
    ].join("");
    return {
      cardId: card.id,
      itemId: itemOf.get(card.id),
      version: p.revision,
      state: workflowPlanStateLabel(card),
      live: isLive,
      steps: isLive && progress ? `${progress.done}/${total} 步` : `${total} 步`,
      goal: p.plan.goal,
      meta,
    };
  });
}

// ───────────────────────── 接下来的计划 ─────────────────────────

/** 计划里的一格：一个步骤 + 它现在走到哪了 + 实际动作有没有对上（AgentSense sessionView.ts 的 PlanSlot） */
export interface WorkflowSlot {
  readonly step: WorkflowStepView;
  readonly status: WorkflowStepState;
  /** 实际落在这一步上的动作数（被引回的没执行，不算） */
  readonly actual: number;
  /** 这一步上出现过、没被自动修回的偏差，已翻成人话 */
  readonly deviations: readonly string[];
  /** 这一步上被自动修回的偏差：参数改回 / 先补前置步骤 */
  readonly fixed: readonly string[];
}

/** 偏差的类别怎么说（AgentSense sessionView.ts 的 DEVIATION_TEXT，原样；checker_error 是二狗多的：计划检查器自己出错，当场问你） */
const DEVIATION_TEXT: Readonly<Record<string, string>> = {
  out_of_scope: "参数超出计划范围",
  out_of_order: "抢在依赖步骤之前",
  repeat: "重复执行",
  forbidden: "对象已被审查排除",
  off_plan: "计划里没有这一步",
  checker_error: "计划检查出错",
};

export function deviationText(kind: string): string {
  if (kind.startsWith("rule:")) return `违反规则 ${kind.slice(5)}`;
  if (kind.startsWith("rule_unknown:")) return `规则 ${kind.slice(13)} 判不了`;
  return DEVIATION_TEXT[kind] ?? kind;
}

/** 被自动修回的偏差怎么说（AgentSense planSlots 原话） */
const FIXED_TEXT = { rewrite: "参数已按计划改回", redirect: "先补了前置步骤" } as const;

/**
 * 一次运行在会话里的那一段（下标，左闭右开）：不属于项目的运行从它的运行分隔线（run_divider）起、到下一条运行分隔线为止；
 * 属于项目的运行是一张工单，在项目维护者的会话里从这张工单的工单段分隔线（work_order_divider，16 号票：每段开头一条）起、
 * 到下一段的分隔线为止（这一段的消息只带作业、项目的归属，不带任务）。分隔线还没翻到（或这一次还没开始）的没有
 */
function runSpan(items: readonly ChatItem[], run: JobRun): { from: number; to: number } | undefined {
  const type = run.workOrderId === undefined ? "run_divider" : "work_order_divider";
  const at = items.findIndex(
    (it) => it.kind === "divider" && it.divider.type === type && (it.divider.type === "run_divider" ? it.divider.runId === run.runId : it.divider.workOrderId === run.workOrderId),
  );
  if (at < 0) return undefined;
  const next = items.findIndex((it, i) => i > at && it.kind === "divider" && it.divider.type === type);
  return { from: at + 1, to: next < 0 ? items.length : next };
}

/**
 * 这个流程这一次的调用：一次性的是属于这个任务的全部；定时触发的流程只看这一次运行的那一段（runSpan）。
 * items 要是这个任务的整段会话（任务详情打开时把它开始以来的历史都取回来，见 historyNeededSince），数字才不随往上翻变
 */
function callsOf(items: readonly ChatItem[], taskId: string, run: JobRun | undefined): ChatToolCall[] {
  const span = run ? runSpan(items, run) : { from: 0, to: items.length };
  if (!span) return [];
  // 运行的那一段整段都是这一次的；一次性的流程按归属挑出这个任务的
  const mine = (call: ChatToolCall) => run !== undefined || call.scope.taskId === taskId;
  return items.slice(span.from, span.to).flatMap((it) => (it.kind === "tool_group" ? it.steps.flatMap((s) => (s.kind === "call" && mine(s.call) ? [s.call] : [])) : []));
}

/** 计划的执行进度：每个步骤一格（AgentSense planSlots）。对话区和缩略视图用同一份数据，"计划欠着几件事"在两个视角下永远一致 */
export function workflowSlots(state: UiState, taskId: string, items: readonly ChatItem[]): WorkflowSlot[] {
  const plan = authorizedWorkflowPlan(state, taskId);
  if (!plan) return [];
  const states = workflowStepStates(state, taskId);
  const calls = callsOf(items, taskId, workflowCurrentRun(state, taskId)).filter((c) => c.part.plan !== undefined);
  return stepsThisRun(state, taskId, plan.payload.plan.steps).map((step) => {
    const mine = calls.filter((c) => c.part.plan?.stepId === step.id);
    const kinds = new Set<string>();
    const fixed = new Set<string>();
    for (const c of mine) {
      const checked = c.part.plan!;
      if (checked.correction) {
        fixed.add(FIXED_TEXT[checked.correction]);
        continue;
      }
      for (const f of checked.findings ?? []) kinds.add(deviationText(f));
    }
    // 被引回计划的调用没执行，不算落在这一格上的动作
    const actual = mine.filter((c) => c.part.plan?.correction !== "redirect").length;
    return { step, status: states[step.id]?.state ?? "pending", actual, deviations: [...kinds], fixed: [...fixed] };
  });
}

/** 历史底部"接下来的计划"要的：还没走到的格子（待办、正在做、跳过、失败的都留在底部）、做完几步、共几步、计划外动作几个 */
export interface WorkflowFuture {
  readonly slots: readonly WorkflowSlot[];
  readonly done: number;
  readonly total: number;
  readonly offPlan: number;
}

/** 接下来的计划（AgentSense ZoomHistory 的 zh-future）：没有授权了的计划、或者步骤都做完了的，没有（不画虚线框） */
export function workflowFuture(state: UiState, taskId: string, items: readonly ChatItem[]): WorkflowFuture | undefined {
  const all = workflowSlots(state, taskId, items);
  const slots = all.filter((s) => s.status !== "done");
  if (slots.length === 0) return undefined;
  const offPlan = callsOf(items, taskId, workflowCurrentRun(state, taskId)).filter((c) => c.part.plan?.offPlan).length;
  return { slots, done: stepsDone(all.map((s) => ({ state: s.status }))), total: all.length, offPlan };
}

/**
 * 虚线框右侧要标的标注（AgentSense ZoomHistory.tsx 的 zf-risks：marks 里 kind 是 op（敏感操作）的、加上 severity 是 high 的；
 * 只有一般的敏感数据不标）。二狗计划步骤上的标注都是关注类别的命中，关注类别是一类操作——对应 AgentSense 的 op，所以全部标出；
 * 二狗的计划步骤上没有"敏感数据"那一种（读密钥文件是执行时的 🔒，不在计划上）
 */
export function slotRiskMarks(step: Pick<WorkflowStepView, "marks">): readonly WorkflowStepMark[] {
  return step.marks;
}

// ───────────────────────── 计划详情 ─────────────────────────

/** 计划详情（AgentSense DetailPane 的 PlanDetail） */
export interface WorkflowPlanDetail {
  readonly cardId: string;
  readonly version: number;
  /** 审查退回、待授权、已授权…… */
  readonly state: string;
  readonly tone: "ok" | "no" | "";
  readonly payload: WorkflowPlanCardPayload;
  /** 涉及的敏感信息：整份计划的敏感标注，同一个类别只列一次 */
  readonly marks: readonly WorkflowStepMark[];
  /** 这份是正在执行的（授权了的、看板上记着的）时各步的状态（定时触发的流程按这一次运行）；不是的没有 */
  readonly progress: Readonly<Record<string, TaskStep>> | undefined;
  /** 一共几版 */
  readonly versions: number;
  /** 相对上一版的变化（按步骤标题比：多了哪几步、少了哪几步）；第一版没有 */
  readonly diff: { readonly from: number; readonly added: readonly string[]; readonly removed: readonly string[] } | undefined;
}

/** 一份计划的步骤标题（版本差异按它比：AgentSense 的 stepTitles） */
const stepTitles = (p: WorkflowPlan) => new Set(p.steps.map((s) => s.title));

/** 某张流程计划卡的详情；不是流程计划卡的没有 */
export function workflowPlanDetail(state: UiState, cardId: string): WorkflowPlanDetail | undefined {
  const card = state.cards[cardId]?.card;
  if (card?.type !== "workflow_plan") return undefined;
  const payload = card.payload as WorkflowPlanCardPayload;
  const versions = workflowPlanCards(state, payload.taskId);
  const idx = versions.findIndex((v) => v.card.id === cardId);
  const prev = idx > 0 ? versions[idx - 1]!.payload.plan : undefined;
  const seen = new Set<string>();
  const marks = payload.plan.steps.flatMap((s) => s.marks).filter((m) => (seen.has(m.category) ? false : (seen.add(m.category), true)));
  const live = authorizedWorkflowPlan(state, payload.taskId)?.card.id === cardId;
  return {
    cardId,
    version: payload.revision,
    state: workflowPlanStateLabel(card),
    tone: workflowPlanStateTone(card),
    payload,
    marks,
    progress: live ? workflowStepStates(state, payload.taskId) : undefined,
    versions: versions.length,
    diff: prev
      ? {
          from: prev.version,
          added: payload.plan.steps.filter((s) => !stepTitles(prev).has(s.title)).map((s) => s.title),
          removed: prev.steps.filter((s) => !stepTitles(payload.plan).has(s.title)).map((s) => s.title),
        }
      : undefined,
  };
}

// ───────────────────────── 检测项全览 ─────────────────────────

/** 一条规则在本次审查里：查出问题、判不了推迟到执行时、通过（AgentSense RuleBook 的 Status） */
export type RuleBookStatus = "violated" | "deferred" | "ok";
export const RULE_BOOK_STATUS_TEXT: Readonly<Record<RuleBookStatus, string>> = { violated: "查出问题", deferred: "判不了·推迟", ok: "通过" };

type Finding = WorkflowReview["violations"][number];

/** 检测项全览里的一条规则（AgentSense RuleBook 一条 rb-rule 要的东西） */
export interface RuleBookRule {
  readonly id: string;
  readonly title: string;
  /** 框架的 v1 模板，还是计划里写的（二狗多的：AgentSense 的规则都在场景的规则文档里） */
  readonly source: "template" | "plan" | undefined;
  readonly status: RuleBookStatus;
  readonly violations: readonly Finding[];
  readonly deferred: readonly Finding[];
  /** 单独复测的结果（ms、查出几处违规、几处判不了、复测出错） */
  readonly probe: WorkflowReview["rules"][number] | undefined;
  /** 生效阶段："规划时 + 执行时" */
  readonly modes: string;
  /** 违反后怎么办：直接拦下、当场确认；二狗多一种"按规则退回"（pull_back） */
  readonly onViolation: string;
  readonly formula: RuleFormula;
  /** 同一条规则的接口写法 */
  readonly api: string;
  /** 规则声明的修法（没写的已由审查按违反时怎么办补上） */
  readonly repairs: readonly RepairOption[];
  /** 这次采用的修补动作 */
  readonly chosen: readonly WorkflowReview["actions"][number][];
  /** 规则原文按字段拆开（不甩一坨 JSON） */
  readonly parts: readonly (readonly [string, unknown])[];
}

/** 检测项全览（AgentSense RuleBook）：这次审查用的全部规则；审查结果里没有规则原文的（60 号票之前的计划、审查没跑成的）不显示 */
export interface RuleBook {
  readonly rules: readonly RuleBookRule[];
  readonly phases: WorkflowReview["phases"];
  /** 修复方案怎么挑 */
  readonly objective: readonly string[];
}

/** 违反后怎么办（AgentSense 的"直接拦截"按二狗的说法写成"直接拦下"：CONTEXT 里处置、硬拒绝都避免"拦截"，67 号票的前缀也是"被拦下"） */
const ON_VIOLATION_TEXT: Readonly<Record<string, string>> = { block: "直接拦下", pull_back: "按规则退回", confirm: "当场确认" };

export function ruleBook(review: WorkflowReview): RuleBook | undefined {
  const docs = review.docs;
  if (!docs?.length) return undefined;
  const actions = review.actions;
  return {
    phases: review.phases,
    objective: objectiveText(undefined),
    rules: docs.map((rule) => {
      const id = String(rule.id);
      const violations = review.violations.filter((v) => v.property === id);
      const deferred = review.deferred.filter((v) => v.property === id);
      const status: RuleBookStatus = violations.length ? "violated" : deferred.length ? "deferred" : "ok";
      const probe = review.rules.find((r) => r.id === id);
      const modes = Array.isArray(rule.modes) ? (rule.modes as unknown[]).map(String) : ["plan", "runtime"];
      return {
        id,
        title: rule.title ?? probe?.title ?? id,
        source: probe?.source,
        status,
        violations,
        deferred,
        probe,
        modes: modes.map((m) => (m === "plan" ? "规划时" : "执行时")).join(" + "),
        onViolation: ON_VIOLATION_TEXT[String(rule.on_violation ?? "confirm")] ?? "当场确认",
        formula: formulaOf(rule),
        api: apiFormulaOf(rule),
        repairs: repairsOf(rule),
        chosen: actions.filter((a) => violations.some((v) => v.key !== undefined && a.covers.includes(v.key))),
        parts: ruleParts(rule),
      };
    }),
  };
}

/** 规则原文按字段拆开显示（AgentSense RuleBook 的 RuleParts） */
const objectOf = (x: unknown) => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);

function ruleParts(rule: Record<string, unknown>): [string, unknown][] {
  const rows: [string, unknown][] = [];
  const obj = objectOf;
  const trigger = obj(rule.trigger);
  const forEach = obj(rule.for_each);
  const require = obj(rule.require);
  if (trigger) rows.push(["触发于", trigger.tool]);
  if (forEach) rows.push([`对每个 ${String(forEach.var)}`, forEach.in]);
  if (rule.when) rows.push(["仅当", rule.when]);
  if (rule.unless) rows.push(["除非", rule.unless]);
  if (require?.before) rows.push(["过去必须发生过", require.before]);
  if (require?.not_before) rows.push(["过去不得发生过", require.not_before]);
  if (require?.check) rows.push(["当下必须满足", require.check]);
  rows.push(["报出来的话", rule.message]);
  return rows;
}
