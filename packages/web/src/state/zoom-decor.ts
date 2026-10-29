// 缩小后条外的装饰（55 号票，规格第 19 节"会话区"）：右侧标注、底色带、书脊、左侧的卡、回退点，
// 画法照搬（界面在 ui/zoom/ZoomHistory.tsx），数据换成二狗的会话条目（chat-items.ts）。纯函数，界面只管画和摆。
// - 右侧标注的 ×N（repeatCounts）：缩小后的一块块矩形按先后看（条目；工具调用组缩小后拆成组里每一块，57 号票），
//   连着几块的标注一模一样时只在第一块标出、写 ×N；思考不打断，别的没有标注的块打断。
// - 底色带（zoomBands）："一个计划从提出到执行完"铺一整块浅黄底，相邻两块深浅错开，左缘竖排"任务 N · 是什么事"。
//   二狗按会话分（规格第 19 节、25 号票全局层的分组 timelineGrouping）：
//   - 任务的维护者会话：每个任务一整块，起止照 planSpans——从这个任务的第一条到最后一条按计划执行的（带阶段的）或者计划卡，
//     不越过下一个任务的开头；没有计划、也没开始执行的任务不铺；
//   - 项目维护者的会话：每张工单那一段一块（工单分隔线起一段，到下一条分隔线之前；对话段不是工单段，不铺）；
//   - 定时触发的任务的会话（76 号票）：每次运行一块（运行的分隔线起一段，到下一条之前；第一次运行之前的不铺）；
//   - 秘书主线：每天一块。
//   分段和 globalView 的按段、按天一样（测试里对过），只是落在会话条目上（底色带的上下沿要对到缩小后的矩形）。
// - 书脊（zoomSpines）：照 milestoneSpines，长程任务的每个阶段，一轮（从开始做到交上来验收）一段；交上来被退回、重做的那一轮另起一段，
//   中间插着别的阶段就断成几段，颜色都按这一轮的结果：通过、退回、未通过、在做、没做完（作废）、已重开。二狗的数据：
//   - 一条属于哪个阶段看它的归属（MessageScope 的 stageId，消息、记录都带着；验收结论的进度卡看卡上写的阶段）；
//     验收通过了的阶段，之后还带着它的条目（任务做完后的说明、回复：归属是"当前阶段"）不算新的一轮，返工重开了才算；
//   - 一轮的结果是这一轮末尾那张验收结论的进度卡：通过的是通过；没通过的是退回，紧跟着这一支停下找你（同一事务里的那条"偏离"记录，
//     14 号票：退回 2 次、第 3 次还不过）的是未通过（第 3 次还不过，请用户拍板）；
//   - 还没交上来验收的那一轮：任务已经结束、或者这个阶段已经不在现行计划里（计划变更去掉了），是没做完；否则是在做；
//   - 返工（看板频道上的 task 事件，ui-state.ts 的 taskReopens）重开的阶段，返工之前的那几轮是已重开。
//   只画长程任务（流程、普通任务没有阶段，固定计划没有书脊），只画在执行它的维护者的会话里（验收结论的进度卡在那里；
//   涉及多个项目的任务派给项目的工单，项目维护者那边没有验收结论）；看板上没收到过的任务照画。
// - 左侧（zoomLeftCards）：每个任务的第一条左边一张任务卡，只写一句总结（计划的目标，没有就是任务），点开看这件事的完整情况。
//   二狗：任务的维护者会话里每个任务的第一条一张任务卡；项目维护者的会话里每张工单的分隔线一张工单卡；秘书主线没有。
// - 回退点（zoomRollbacks，150 号票）——
//   每条用户消息"撤回到这条请求之前"、每条分支摘要"撤回到这条分支开始前"，挂在那一条左边（条左侧 ↶ 加引线）；只在当前这段会话里
//   （最近一次清空、换模型之后，用户定的第 5 条）；系统通知、网页上下的指令、排队一起交出的一批里第一条之后的不是；
//   只在能回退的会话里有（150 号票先做秘书主会话）。
//   152 号票起任务、项目维护者的会话也有，外加长程任务每个阶段开始"撤回到阶段「…」开始前"（同固定计划的"撤回到步骤
//   「…」开始前"）：维护者会话频道上 stage_start 的记号写明维护者是怎么知道这个阶段开始的，回退点挂在守护进程截的那一处——那条通知、
//   "开始阶段"那条回复（没说话的是那次调用）、别的调用（验收通过接着开始的）的结果之后那一条；项目维护者的会话最新那一段结束了就没有。
//   153 号票：流程每个步骤开始"撤回到步骤「…」开始前"（同一条记号带 stepId，挂在含那次 report_step 的回复上，没说话的是那次调用）；
//   定时、事件触发的一次运行就是一段会话（分段线之前的没有回退点）。
// - 分叉点（zoomForks，150 号票）：照 deriveSessionView 的 forks——废弃分支挂在当前路径上"序号不小于分叉处的第一条"右边（⑂ 小方块），
//   和回退点落在同一条边界上，一左一右。点开预览、详情、切换在 151 号票（数据在 abandoned-branch.ts）；分叉在这段会话之前的
//   （清空、换模型之前分出去的）切不过去（switchable）。
import {
  rollbackSegmentStart,
  branchForks,
  type ConversationId,
  ROLLBACK_LABEL,
  rollbackEnabled,
  type RollbackTarget,
  type StageStartEventPayload,
  startRollbackLabel,
  onBranchPath,
  ENDED_TASK_STATES,
  maintainerChannel,
  type PlanCardPayload,
  type ProgressCardPayload,
  taskKind,
  type WorkflowPlanCardPayload,
  t,
  tTable,
} from "./protocol.ts";
import { type ChatItem, type ContentKind, isCallGroup, zoomBlocks } from "./chat-items.ts";
import { genericBashLabel, MARK_KIND_LABEL, OP_REASON, type TimelineMark, timelineGrouping } from "./timeline.ts";
import { taskStageCodes } from "./stage-codes.ts";
import { pathMessages, pathStageStarts, segmentOpen, type UiState } from "./ui-state.ts";
import { workOrderView } from "./work-orders.ts";
import { workflowPlanCategoryCount } from "./workflow-card.ts";
import { workflowProgress } from "./workflow-view.ts";

// ───────────────────────── 右侧标注的字和 ×N ─────────────────────────

/**
 * 一条标注上写的字（54 号票定的写法；审批批了没有由界面接在后面）：
 * - 操作（工具调用、操作记录）：样式的说法、命中的关注类别（⚠）、通用 bash、结果；
 * - 审批：要批的事；验收：结论；时间线记录（偏离、范围变更、越界……）：种类
 */
export function markChipText(mark: TimelineMark): string {
  const style = mark.reason ? OP_REASON[mark.reason].label : undefined;
  const cats = mark.categories.map((c) => `⚠${c}`);
  const bash = mark.genericBash ? [genericBashLabel()] : [];
  const parts =
    mark.kind === "tool"
      ? [style, ...cats, ...bash, mark.outcome]
      : mark.kind === "operation"
        ? [t("state.zoomDecor.operationChip", { label: MARK_KIND_LABEL.operation, short: mark.short }), style, ...cats]
        : mark.kind === "acceptance"
          ? [mark.title]
          : [MARK_KIND_LABEL[mark.kind], ...cats];
  return parts.filter((x): x is string => !!x).join(" · ");
}

/**
 * 缩小后条右侧标出的要点（和条右上角的小圆点）：验收通过的不标（"验收通过不在右边标：左边书脊那一段变绿
 * 就是通过了；没通过的才值得多看一眼"），用户 2026-10-10 定。没通过的照旧标
 */
export function sideMarks(marks: readonly TimelineMark[]): readonly TimelineMark[] {
  return marks.some((m) => m.kind === "acceptance" && m.passed) ? marks.filter((m) => !(m.kind === "acceptance" && m.passed)) : marks;
}

/** 缩小后的一块矩形：条目，或者工具调用组里的一块（57 号票）。repeatCounts 按这个先后看 */
export interface ZoomRect {
  readonly id: string;
  readonly content: ContentKind;
  readonly marks: readonly TimelineMark[];
}

/** 缩小后的矩形，按先后：工具调用组拆成组里每次调用、每段思考（zoomBlocks），别的条目各一块；带着右侧要标的要点（sideMarks） */
export function zoomRects(items: readonly ChatItem[]): ZoomRect[] {
  return items.flatMap((item): ZoomRect[] => {
    const blocks = zoomBlocks(item);
    if (blocks.length === 0) return [{ id: item.id, content: item.content, marks: sideMarks(item.marks) }];
    return blocks.map((b) => (b.kind === "call" ? { id: b.id, content: "tool", marks: b.marks } : { id: b.id, content: "thinking", marks: [] }));
  });
}

/** 两条标注算不算一样：写的字一样；审批还要批没批、怎么批的一样（不然一批一拒会被并成 ×2） */
function markRepeatKey(state: UiState, mark: TimelineMark): string {
  const card = mark.cardId ? state.cards[mark.cardId]?.card : undefined;
  return card ? `${markChipText(mark)}#${card.status}:${card.outcome?.action ?? ""}` : markChipText(mark);
}

/**
 * 连续几块的标注完全一样时，只在第一块显示并标 ×N：第一块记 N（≥2），后面几块记 0（不显示标注）。
 * 只有思考不打断连续；别的没有标注的块说明已经不相邻了
 */
export function repeatCounts(state: UiState, items: readonly ChatItem[]): Map<string, number> {
  const rects = zoomRects(items);
  const keys = new Map(rects.map((r) => [r.id, r.marks.map((m) => markRepeatKey(state, m)).join("|")]));
  const counts = new Map<string, number>();
  let head: string | undefined;
  for (const r of rects) {
    const k = keys.get(r.id)!;
    if (!k) {
      if (r.content !== "thinking") head = undefined;
      continue;
    }
    if (head !== undefined && k === keys.get(head)) {
      counts.set(head, (counts.get(head) ?? 1) + 1);
      counts.set(r.id, 0);
    } else head = r.id;
  }
  return counts;
}

// ───────────────────────── 底色带 ─────────────────────────

/** 底色带的上下沿：从哪一条到哪一条（条目 id；工具调用组缩小后对到组里第一块、最后一块，由界面找） */
interface Span {
  readonly firstId: string;
  readonly lastId: string;
}

/**
 * 一块底色：任务（任务的维护者会话）、工单段（项目维护者的会话）、一天（秘书主线）。
 * index 是第几块（相邻两块按奇偶深浅错开）；左缘竖排的标签：任务写"任务 N · 是什么事"（N 是这个会话里的第几个任务），
 * 工单写"工单 N · 是什么事"（N 是工单编号里的数，和分隔线上的编号对得上），一天写"10月8日"
 */
export type ZoomBand = Span & { readonly key: string; readonly index: number } & (
    | { readonly kind: "task"; readonly taskId: string; readonly no: string; readonly title: string }
    | { readonly kind: "work_order"; readonly workOrderId: string; readonly no: string; readonly title: string }
    | { readonly kind: "run"; readonly runId: string; readonly no: string; readonly title: string }
    | { readonly kind: "day"; readonly day: string; readonly month: number; readonly date: number }
  );

/** 编号里的数（t-3 → 3、wo-2 → 2）；不是这种写法的原样 */
const numberOf = (id: string) => /-(\d+)$/.exec(id)?.[1] ?? id;

/** 一条是不是某个任务的计划卡（长程任务的计划卡、流程计划卡） */
function isPlanCardOf(state: UiState, item: ChatItem, taskId: string): boolean {
  if (item.kind !== "card") return false;
  const card = state.cards[item.cardId]?.card;
  if (card?.type !== "plan" && card?.type !== "workflow_plan") return false;
  return (card.payload as { taskId?: unknown }).taskId === taskId;
}

/** 条目里出现过的任务，按第一次出现的先后：任务 id → 第一条的位置 */
function taskStarts(items: readonly ChatItem[]): [string, number][] {
  const firsts = new Map<string, number>();
  items.forEach((it, i) => {
    const taskId = it.scope.taskId;
    if (taskId !== undefined && !firsts.has(taskId)) firsts.set(taskId, i);
  });
  return [...firsts];
}

/**
 * 任务的维护者会话：每个任务一块。起点是这个任务的第一条，终点是最后一条按计划执行的（落在阶段的某一轮里的，
 * roundSteps）、没有就是计划卡；不越过下一个任务的开头。计划之前的来回包进来（从第一条算起），执行完之后的零散对话不包；
 * 没有计划、也没开始执行的任务不铺
 */
function taskSpans(state: UiState, items: readonly ChatItem[]): Omit<Extract<ZoomBand, { kind: "task" }>, "index" | "no">[] {
  const starts = taskStarts(items);
  return starts.flatMap(([taskId, first], k) => {
    const end = starts[k + 1]?.[1] ?? items.length;
    // 计划卡，和按计划执行的（落在阶段的某一轮里的，见 roundSteps：做完之后的说明、回复不算）
    let last = -1;
    for (let i = first; i < end; i++) if (isPlanCardOf(state, items[i]!, taskId)) last = i;
    for (const step of roundSteps(state, taskId, items)) if (step.index < end) last = Math.max(last, step.index);
    if (last < 0) return [];
    const title = (state.tasks[taskId]?.title ?? planCardOf(state, taskId, items)?.payload.taskTitle ?? taskId).replace(/\s+/g, " ").trim();
    return [{ key: `task:${taskId}`, kind: "task" as const, taskId, title, firstId: items[first]!.id, lastId: items[last]!.id }];
  });
}

/** 项目维护者的会话：每张工单那一段一块，从它的分隔线到下一条分隔线之前（对话段的分隔线结束上一块、自己不铺） */
function workOrderSpans(items: readonly ChatItem[]): Omit<Extract<ZoomBand, { kind: "work_order" }>, "index">[] {
  const out: Omit<Extract<ZoomBand, { kind: "work_order" }>, "index">[] = [];
  let current: (typeof out)[number] | undefined;
  for (const it of items) {
    if (it.kind === "divider" && it.divider.type === "work_order_divider") {
      const { workOrderId, title } = it.divider;
      current = workOrderId ? { key: `work_order:${it.id}`, kind: "work_order", workOrderId, no: numberOf(workOrderId), title, firstId: it.id, lastId: it.id } : undefined;
      if (current) out.push(current);
      continue;
    }
    if (current) out[out.length - 1] = current = { ...current, lastId: it.id };
  }
  return out;
}

/** 定时触发的任务的会话（76 号票）：每次运行一块，从它的分隔线到下一条之前；标签是"运行 N · 怎么触发的"（N 是第几次运行） */
function runSpans(items: readonly ChatItem[]): Omit<Extract<ZoomBand, { kind: "run" }>, "index">[] {
  const out: Omit<Extract<ZoomBand, { kind: "run" }>, "index">[] = [];
  for (const it of items) {
    if (it.kind === "divider" && it.divider.type === "run_divider") {
      const { runId, title } = it.divider;
      out.push({ key: `run:${runId}`, kind: "run", runId, no: /-r(\d+)$/.exec(runId)?.[1] ?? runId, title: title.split(" · ").slice(1).join(" · "), firstId: it.id, lastId: it.id });
      continue;
    }
    const current = out.at(-1);
    if (current) out[out.length - 1] = { ...current, lastId: it.id };
  }
  return out;
}

/** 秘书主线：每天一块（"10月8日"）；还没有时间的（正在生成的回复）跟着上一块 */
function daySpans(items: readonly ChatItem[]): Omit<Extract<ZoomBand, { kind: "day" }>, "index">[] {
  const out: Omit<Extract<ZoomBand, { kind: "day" }>, "index">[] = [];
  for (const it of items) {
    const day = it.time?.slice(0, 10);
    const current = out.at(-1);
    if (current && (day === undefined || day === current.day)) {
      out[out.length - 1] = { ...current, lastId: it.id };
      continue;
    }
    if (day === undefined) continue;
    const [, month, date] = day.split("-");
    out.push({ key: `day:${day}`, kind: "day", day, month: Number(month), date: Number(date), firstId: it.id, lastId: it.id });
  }
  return out;
}

/** 这个会话的底色带：任务的维护者会话按任务，项目维护者的会话按工单段，秘书主线按天（timelineGrouping 的三种分组） */
export function zoomBands(state: UiState, conversation: ConversationId, items: readonly ChatItem[]): ZoomBand[] {
  const grouping = timelineGrouping(state, conversation);
  if (grouping === "stage") return taskSpans(state, items).map((s, index) => ({ ...s, index, no: String(index + 1) }));
  const spans: Omit<ZoomBand, "index">[] = grouping === "day" ? daySpans(items) : grouping === "run" ? runSpans(items) : workOrderSpans(items);
  return spans.map((s, index) => ({ ...s, index }) as ZoomBand);
}

// ───────────────────────── 书脊 ─────────────────────────

/** 一轮的结果：验收通过、退回、未通过、在做、没做完（作废）、已重开（图例列前四种：通过 / 退回 / 在做 / 作废） */
export const SPINE_STATES = ["ok", "retry", "failed", "live", "off", "stale"] as const;
export type SpineState = (typeof SPINE_STATES)[number];
export const SPINE_STATE_LABEL: Readonly<Record<SpineState, string>> = tTable({
  ok: "state.zoomDecor.spine.ok",
  retry: "state.zoomDecor.spine.retry",
  failed: "state.zoomDecor.spine.failed",
  live: "state.zoomDecor.spine.live",
  off: "state.zoomDecor.spine.off",
  stale: "state.zoomDecor.spine.stale",
});

/** 书脊的一段：某个任务某个阶段的一轮（被别的阶段隔开时是其中一截），从哪一条到哪一条 */
export interface ZoomSpine extends Span {
  readonly key: string;
  readonly taskId: string;
  readonly stageId: string;
  /** 书脊上写的阶段名：阶段的编号（91 号票：依赖图的编号，并行的 4a、4b），认不出时是阶段 id */
  readonly label: string;
  readonly state: SpineState;
}

/** 验收结论的进度卡：哪个阶段、过没过 */
function acceptanceOf(state: UiState, item: ChatItem): { stageId: string; passed: boolean } | undefined {
  if (item.kind !== "card") return undefined;
  const card = state.cards[item.cardId]?.card;
  if (card?.type !== "progress") return undefined;
  const p = card.payload as ProgressCardPayload;
  return p.kind === "acceptance" && p.acceptance ? { stageId: p.stageId, passed: p.acceptance.passed } : undefined;
}

/** 这一支停下找你的"偏离"记录（14 号票的 stopBranch，和没通过的验收结论同一事务、紧跟在它后面） */
function isStopRecord(item: ChatItem | undefined, taskId: string, stageId: string): boolean {
  return item?.kind === "record" && item.record.type === "timeline" && item.record.timeline.kind === "deviation" && item.scope.taskId === taskId && item.scope.stageId === stageId;
}

/**
 * 在这个会话里画不画这个任务的书脊：长程任务，执行它的维护者就是这个会话的（涉及多个项目的任务，项目维护者那边只有工单，
 * 没有验收结论）。看板上没收到过这个任务的照画（不知道是不是结束了、计划改没改，没交上来的那一轮算在做）
 */
function drawsSpines(state: UiState, conversation: ConversationId, taskId: string): boolean {
  const task = state.tasks[taskId];
  return !task || (taskKind(task) === "long_running" && maintainerChannel(task.maintainerId) === conversation);
}

/** 这一条在返工之前，而它的阶段被这次返工重开了 */
function reopenedLater(state: UiState, taskId: string, stageId: string, time: string | undefined): boolean {
  if (time === undefined) return false;
  const at = Date.parse(time);
  return (state.taskReopens[taskId] ?? []).some((r) => r.stageIds.includes(stageId) && at < Date.parse(r.time));
}

/** 验收通过（after 那一刻）之后、这一条（at）之前，这个阶段被返工重开过 */
function reopenedBetween(state: UiState, taskId: string, stageId: string, after: string | undefined, at: string | undefined): boolean {
  if (at === undefined) return false;
  const from = after === undefined ? -Infinity : Date.parse(after);
  const to = Date.parse(at);
  return (state.taskReopens[taskId] ?? []).some((r) => r.stageIds.includes(stageId) && from < Date.parse(r.time) && Date.parse(r.time) <= to);
}

/** 一条属于哪个阶段：验收结论的进度卡看卡上写的，别的看归属 */
const stageOf = (state: UiState, item: ChatItem) => acceptanceOf(state, item)?.stageId ?? item.scope.stageId;

/** 某个任务的一条落在哪个阶段的哪一轮（round 是"阶段#第几轮"）；这一轮末尾的验收结论带着结果 */
interface RoundStep {
  readonly index: number;
  readonly stageId: string;
  readonly round: string;
  readonly verdict?: SpineState;
}

/**
 * 一个任务按阶段的轮次走一遍条目：带阶段的条目落进这个阶段当前这一轮；
 * 验收结论的进度卡结束这一轮（没通过、紧跟着这一支停下找你的那条"偏离"记录算在这一轮里，是未通过）。
 * 没有阶段的条目跳过。另有一条：验收通过了的阶段，之后还带着它的条目
 * （任务做完后的说明、回复——归属是"当前阶段"，做完了就是最后那个）不算新的一轮，除非返工重开了它
 */
function roundSteps(state: UiState, taskId: string, items: readonly ChatItem[]): RoundStep[] {
  const out: RoundStep[] = [];
  const round = new Map<string, number>();
  /** 验收通过了的阶段 → 通过的那一刻 */
  const accepted = new Map<string, string | undefined>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.scope.taskId !== taskId) continue;
    const stageId = stageOf(state, it);
    if (stageId === undefined) continue;
    if (accepted.has(stageId)) {
      if (!reopenedBetween(state, taskId, stageId, accepted.get(stageId), it.time)) continue;
      accepted.delete(stageId);
    }
    const r = `${stageId}#${round.get(stageId) ?? 0}`;
    const verdict = acceptanceOf(state, it);
    if (!verdict) {
      out.push({ index: i, stageId, round: r });
      continue;
    }
    if (verdict.passed) {
      accepted.set(stageId, it.time);
      out.push({ index: i, stageId, round: r, verdict: "ok" });
    } else if (isStopRecord(items[i + 1], taskId, stageId)) {
      // 没通过、紧跟着这一支停下找你：第 3 次还不过（未通过）
      out.push({ index: i, stageId, round: r }, { index: ++i, stageId, round: r, verdict: "failed" });
    } else out.push({ index: i, stageId, round: r, verdict: "retry" });
    round.set(stageId, (round.get(stageId) ?? 0) + 1);
  }
  return out;
}

/**
 * 书脊：同一个阶段的一轮（从开始做到交上来验收）是一段。交上来被退回，重做的那一轮另起一段；
 * 中间插着别的阶段，就断成几段，颜色都按这一轮的结果
 */
export function zoomSpines(state: UiState, conversation: ConversationId, items: readonly ChatItem[]): ZoomSpine[] {
  const out: ZoomSpine[] = [];
  for (const [taskId] of taskStarts(items)) {
    if (!drawsSpines(state, conversation, taskId)) continue;
    const task = state.tasks[taskId];
    const steps = roundSteps(state, taskId, items);
    const outcome = new Map(steps.flatMap((s) => (s.verdict ? [[s.round, s.verdict] as const] : [])));
    const pieces: { key: string; stageId: string; round: string; first: number; last: number }[] = [];
    for (const step of steps) {
      const cur = pieces.at(-1);
      if (cur?.round === step.round) cur.last = step.index;
      else pieces.push({ key: `${taskId}:${step.round}:${pieces.length}`, stageId: step.stageId, round: step.round, first: step.index, last: step.index });
    }
    // 计划调整去掉的阶段：没交上来的那一轮就是不做了
    const kept = task?.stages?.list ? new Set(task.stages.list.map((s) => s.stageId)) : undefined;
    const codes = taskStageCodes(state, taskId);
    const finished = task !== undefined && ENDED_TASK_STATES.includes(task.state);
    for (const p of pieces) {
      const open: SpineState = finished || (kept !== undefined && !kept.has(p.stageId)) ? "off" : "live";
      const color = reopenedLater(state, taskId, p.stageId, items[p.first]!.time) ? "stale" : (outcome.get(p.round) ?? open);
      out.push({ key: p.key, taskId, stageId: p.stageId, label: codes.get(p.stageId) ?? p.stageId, firstId: items[p.first]!.id, lastId: items[p.last]!.id, state: color });
    }
  }
  return out;
}

/**
 * 重开之前的那几轮里的条目（已废弃，留在原处、淡一点）：返工重开的阶段，返工之前落在它某一轮里的条目
 * （roundSteps）。工具调用组连同缩小后组里的每一块
 */
export function zoomStaleItems(state: UiState, conversation: ConversationId, items: readonly ChatItem[]): Set<string> {
  const out = new Set<string>();
  for (const [taskId] of taskStarts(items)) {
    if (!drawsSpines(state, conversation, taskId)) continue;
    for (const step of roundSteps(state, taskId, items)) {
      const it = items[step.index]!;
      if (!reopenedLater(state, taskId, step.stageId, it.time)) continue;
      out.add(it.id);
      for (const b of zoomBlocks(it)) out.add(b.id);
    }
  }
  return out;
}

// ───────────────────────── 左侧的任务卡、工单卡 ─────────────────────────

/**
 * 条左边的一张卡：任务卡写一句总结（计划的目标，没有就是任务的标题），工单卡写工单的标题；live = 还没结束。
 * 任务卡的 no 是它那块底色上的"任务 N"（没铺底色的没有），点开的标题跟着写
 */
export type ZoomLeftCard =
  | { readonly kind: "task"; readonly taskId: string; readonly no: string | undefined; readonly summary: string; readonly live: boolean }
  | { readonly kind: "work_order"; readonly workOrderId: string; readonly summary: string; readonly live: boolean };

/**
 * 任务最新的计划卡（长程任务的计划卡或流程计划卡）：看板上任务记着的那张，看板上没有这个任务时取会话里最后一张；
 * 还没交过计划、没收到卡时没有
 */
function planCardOf(
  state: UiState,
  taskId: string,
  items: readonly ChatItem[],
): { type: "plan"; payload: PlanCardPayload } | { type: "workflow_plan"; payload: WorkflowPlanCardPayload } | undefined {
  const shown = items.findLast((it) => isPlanCardOf(state, it, taskId));
  const cardId = state.tasks[taskId]?.planCardId ?? (shown?.kind === "card" ? shown.cardId : undefined);
  const card = cardId === undefined ? undefined : state.cards[cardId]?.card;
  if (card?.type === "plan") return { type: "plan", payload: card.payload as PlanCardPayload };
  if (card?.type === "workflow_plan") return { type: "workflow_plan", payload: card.payload as WorkflowPlanCardPayload };
  return undefined;
}

/** 条目 id → 它左边的那张卡：任务的维护者会话里每个任务的第一条一张任务卡，项目维护者的会话里每张工单的分隔线一张工单卡；秘书主线没有 */
export function zoomLeftCards(state: UiState, conversation: ConversationId, items: readonly ChatItem[]): Map<string, ZoomLeftCard> {
  const out = new Map<string, ZoomLeftCard>();
  const grouping = timelineGrouping(state, conversation);
  if (grouping === "segment") {
    for (const it of items) {
      if (it.kind !== "divider" || it.divider.type !== "work_order_divider" || !it.divider.workOrderId) continue;
      const workOrder = state.workOrders[it.divider.workOrderId];
      out.set(it.id, { kind: "work_order", workOrderId: it.divider.workOrderId, summary: it.divider.title, live: workOrder !== undefined && workOrder.state !== "ended" });
    }
  } else if (grouping === "stage") {
    const bands = zoomBands(state, conversation, items);
    for (const [taskId, first] of taskStarts(items)) {
      const task = state.tasks[taskId];
      const summary = planCardOf(state, taskId, items)?.payload.goal ?? task?.title ?? taskId;
      const band = bands.find((b) => b.kind === "task" && b.taskId === taskId);
      out.set(items[first]!.id, { kind: "task", taskId, no: band?.kind === "task" ? band.no : undefined, summary, live: task !== undefined && !ENDED_TASK_STATES.includes(task.state) });
    }
  }
  return out;
}

/** 卡上一行行事实的名字（170 号票起按当前语言现取） */
const FACT = tTable({
  asked: "state.zoomDecor.fact.asked",
  goal: "state.zoomDecor.fact.goal",
  plan: "state.zoomDecor.fact.plan",
  grants: "state.zoomDecor.fact.grants",
  alongTheWay: "state.zoomDecor.fact.alongTheWay",
  categories: "state.zoomDecor.fact.categories",
  workOrder: "state.zoomDecor.fact.workOrder",
  from: "state.zoomDecor.fact.dispatcher",
  kind: "state.zoomDecor.fact.kind",
  task: "state.zoomDecor.fact.task",
  job: "state.zoomDecor.fact.job",
  instructions: "state.zoomDecor.fact.instructions",
  status: "state.zoomDecor.fact.status",
});

/** 点开左边那张卡看到的：标题（"任务 3""工单 2"）、还没结束、一行行事实；任务的还有能进它计划详情的那张计划卡（条目 id） */
export interface ZoomCardFacts {
  readonly title: string;
  readonly live: boolean;
  readonly rows: readonly (readonly [string, string])[];
  readonly planItemId?: string;
}

/**
 * 任务的完整情况：你交代的、目标、计划进度、授权、过程中找过你几次；能直接进计划详情。
 * 二狗：长程任务的计划写"已验收几个阶段"，流程写"做完几步"；"检查介入"是守卫拦下的调用，"当场找你"是问过你、等你批准、你拒绝了的
 */
export function zoomTaskFacts(state: UiState, taskId: string, items: readonly ChatItem[], no?: string): ZoomCardFacts {
  const task = state.tasks[taskId];
  const plan = planCardOf(state, taskId, items);
  // 看板上没收到过这个任务时，取计划卡上写的任务
  const rows: [string, string][] = [[FACT.asked, task?.summary || task?.title || plan?.payload.taskTitle || taskId]];
  const calls = items.flatMap((it) => (it.kind === "tool_group" && it.scope.taskId === taskId ? it.calls : []));
  const asked = calls.filter((c) => c.issue === "asked" || c.issue === "waiting" || c.issue === "denied").length;
  if (plan?.type === "plan") {
    const p = plan.payload;
    const revision = state.taskPlans[taskId]?.revision ?? p.revision;
    const list = task?.stages?.list;
    const progress = list ? t("state.zoomDecor.accepted", { done: list.filter((s) => s.state === "accepted").length, total: list.length }) : t("state.zoomDecor.stages", { count: p.plan.stages.length });
    const kinds = new Set(Object.values(state.taskPlans[taskId]?.grantInfo ?? p.grantInfo).map((g) => g.toolTitle)).size;
    const fixed = calls.filter((c) => c.part.blockedBy !== undefined).length;
    rows.push([FACT.goal, p.goal]);
    rows.push([FACT.plan, t("state.zoomDecor.longPlan", { revision, progress })]);
    rows.push([FACT.grants, kinds > 0 ? t("state.zoomDecor.grantKinds", { count: kinds }) : t("state.zoomDecor.viewOnly")]);
    if (fixed > 0 || asked > 0) rows.push([FACT.alongTheWay, [fixed > 0 && t("state.zoomDecor.guardStepped", { count: fixed }), asked > 0 && t("state.zoomDecor.askedYou", { count: asked })].filter(Boolean).join(" · ")]);
  } else if (plan?.type === "workflow_plan") {
    const p = plan.payload;
    // 做完几步和标题栏的进度条同一个口径（workflowProgress：跳过的不算，定时触发的按这一次运行）；还没授权的按 0 算
    const progress = workflowProgress(state, taskId);
    const watched = workflowPlanCategoryCount(p.plan);
    const fixed = calls.filter((c) => c.part.blockedBy === "plan_redirect").length;
    rows.push([FACT.goal, p.goal]);
    const run = progress?.run ? t("state.zoomDecor.runPrefix", { no: progress.run.no }) : "";
    const total = progress?.total ?? p.plan.steps.length;
    rows.push([FACT.plan, t("state.zoomDecor.workflowPlan", { revision: p.revision, run, done: progress?.done ?? 0, total, count: total })]);
    rows.push([FACT.categories, watched > 0 ? t("state.zoomDecor.categoriesInvolved", { count: watched }) : t("state.zoomDecor.none")]);
    if (fixed > 0 || asked > 0) rows.push([FACT.alongTheWay, [fixed > 0 && t("state.zoomDecor.autoFixed", { count: fixed }), asked > 0 && t("state.zoomDecor.askedYou", { count: asked })].filter(Boolean).join(" · ")]);
  } else rows.push([FACT.plan, t("state.zoomDecor.noPlan")]);
  const planItem = items.findLast((it) => isPlanCardOf(state, it, taskId));
  return {
    title: no === undefined ? t("state.zoomDecor.task") : t("state.zoomDecor.taskNo", { no }),
    live: task !== undefined && !ENDED_TASK_STATES.includes(task.state),
    rows,
    ...(planItem ? { planItemId: planItem.id } : {}),
  };
}

/** 工单的情况（二狗的工单卡点开看）：派单方、要做的事、所属任务（和它现在到哪了）、交代的内容、状态 */
export function zoomWorkOrderFacts(state: UiState, workOrderId: string, summary: string): ZoomCardFacts {
  const view = workOrderView(state, workOrderId);
  if (!view) return { title: t("state.zoomDecor.workOrderNo", { no: numberOf(workOrderId) }), live: false, rows: [[FACT.workOrder, summary]] };
  const { workOrder } = view;
  const rows: [string, string][] = [
    [FACT.workOrder, workOrder.title],
    [FACT.from, view.source],
    [FACT.kind, view.kind],
  ];
  if ("taskId" in workOrder) rows.push([FACT.task, view.stage ? t("state.zoomDecor.taskAtStage", { title: workOrder.taskTitle, stage: view.stage }) : workOrder.taskTitle]);
  if (view.job) rows.push([FACT.job, view.job.title]);
  if (workOrder.instructions) rows.push([FACT.instructions, workOrder.instructions]);
  rows.push([FACT.status, view.status]);
  return { title: t("state.zoomDecor.workOrderNo", { no: numberOf(workOrderId) }), live: workOrder.state !== "ended", rows };
}

// ───────────────────────── 回退点、分叉点（150 号票） ─────────────────────────

/** 一个回退点：给人看的说法（确认框的标题）、回到哪一条之前；长程任务阶段开始的还有是哪个任务的哪个阶段（152 号票） */
export interface ZoomRollbackPoint {
  readonly label: string;
  readonly before: RollbackTarget;
  readonly stage?: { readonly taskId: string; readonly stageId: string };
  /** 流程一个步骤开始的回退点（155 号票：确认框里写"撤回之后停在这一步，等你说一句再接着做"） */
  readonly step?: { readonly taskId: string; readonly stepId: string };
}

/** 分叉处挂着的一条废弃分支；switchable：能切过去（151 号票：在这段会话里分出去的，清空、换模型之前分出去的不能） */
export interface ZoomFork {
  readonly branchId: string;
  readonly switchable: boolean;
}

/**
 * 当前分支上这段会话从哪开始（最近一条"agent 新开一段会话"的消息、定时和事件触发的一次运行的分段线的序号；没有是 0）：
 * 153 号票起一次运行就是一段会话（rollbackSegmentStart，和守护进程 rollback.ts 同一个口径）
 */
function segmentStart(state: UiState, conversation: ConversationId): number {
  const messages = pathMessages(state, conversation);
  for (let i = messages.length - 1; i >= 0; i--) if (rollbackSegmentStart(messages[i]!.message)) return messages[i]!.seq;
  return 0;
}

/**
 * 条目 id → 挂在它左边的回退点：这段会话里每条用户消息（文字、语音）
 * "撤回到这条请求之前"，每条分支摘要"撤回到这条分支开始前"。排着队的、发送中的、网页上下的指令不是；排队一起交出的一批只有第一条是
 */
export function zoomRollbacks(state: UiState, conversation: ConversationId, items: readonly ChatItem[]): Map<string, ZoomRollbackPoint[]> {
  const out = new Map<string, ZoomRollbackPoint[]>();
  if (!rollbackEnabled(conversation)) return out;
  // 项目维护者的会话（152 号票）：最新那一段结束了就没有回退点（只在当前这一段里，用户定的第 5 条）
  if (timelineGrouping(state, conversation) === "segment" && segmentOpen(state, conversation) === false) return out;
  const start = segmentStart(state, conversation);
  // 排队交出的一批（144 号票）：同一批里第一条之后的（它们和第一条一起交给 agent，会话文件里是一条）
  const seen = new Set<string>();
  const batched = new Set<string>();
  for (const m of pathMessages(state, conversation)) {
    if (m.delivery === undefined) continue;
    if (seen.has(m.delivery)) batched.add(m.message.id);
    seen.add(m.delivery);
  }
  for (const it of items) {
    if (it.seq === undefined || it.seq <= start) continue;
    // 293 号票：接管时导进来的前情（290 号票，prelude）不是交给 agent 的输入，撤回不到它之前
    if (
      (it.kind === "user" || (it.kind === "voice" && it.speaker === "user")) &&
      !it.queued &&
      it.pending === undefined &&
      it.message.pageCommand === undefined &&
      it.message.prelude !== true &&
      !batched.has(it.message.id)
    ) {
      out.set(it.id, [{ label: ROLLBACK_LABEL.message, before: { messageId: it.message.id } }]);
    } else if (it.kind === "system" && it.branch) {
      out.set(it.id, [{ label: ROLLBACK_LABEL.branch, before: { branchId: it.branch.id } }]);
    }
  }
  // 长程任务阶段开始（152 号票）、流程步骤开始（153 号票，固定计划"撤回到步骤「…」开始前"）：挂在守护进程截的那一处
  // （stageCut）往后第一块上。步骤的不带 stage（不是阶段框上的那一个，确认框里也不说"撤回之后接着做"：固定计划撤回之后不接着做），
  // 带 step（155 号票：确认框里写明撤回之后停在这一步，等你说一句再接着做）
  for (const { seq, mark } of pathStageStarts(state, conversation)) {
    if (seq <= start) continue;
    const cut = stageCut(state, conversation, seq, mark);
    const id = cut === undefined || cut <= start ? undefined : firstRectFrom(items, cut);
    if (id === undefined) continue;
    const point: ZoomRollbackPoint = {
      label: startRollbackLabel(mark),
      before: { stageStart: mark.id },
      ...(mark.stepId === undefined ? { stage: { taskId: mark.taskId, stageId: mark.stageId } } : { step: { taskId: mark.taskId, stepId: mark.stepId } }),
    };
    out.set(id, [...(out.get(id) ?? []), point]);
  }
  return out;
}

/**
 * 撤回到这个阶段开始前截在会话频道上哪个序号（和守护进程 rollback.ts 的 stagePlan 同一个口径）：维护者从一条通知知道的，截在那条通知；
 * "开始阶段"那次调用，截在那条回复说的话（calls 里有这次调用的，没说话的截在这次调用的记录）；别的调用，截在这次调用的记录后面那一条。
 * 那一条不在手里（还没翻到、彻底删除了）是 undefined
 */
function stageCut(state: UiState, conversation: ConversationId, markSeq: number, mark: StageStartEventPayload): number | undefined {
  const messages = pathMessages(state, conversation);
  const { via } = mark;
  if ("notice" in via) return messages.find((m) => m.message.id === via.notice)?.seq;
  const record = messages.find((m) => m.seq > markSeq && m.message.parts.some((p) => p.type === "tool_call" && p.callId === via.call))?.seq;
  if (via.after) {
    // 那次调用之后的那一段已经撤回过了（它后面那一条不在当前分支上）：这个阶段的这次开始不算了，没有回退点（新分支上重新开始的有自己的）
    const tree = state.conversations[conversation]?.branches;
    if (record === undefined || (tree !== undefined && tree.branches.length > 1 && !onBranchPath(tree, record + 1))) return undefined;
    return record + 1;
  }
  return messages.findLast((m) => m.seq < markSeq && m.message.calls?.includes(via.call) === true)?.seq ?? record;
}

/**
 * 缩小后序号不小于 seq 的第一块：工具调用组（187 号票起连同调用记忆）拆成里面画出来的每一块（顺利执行的内部工具不画、跳过；
 * 一块都不画的组整个是一块），别的条目一块
 */
function firstRectFrom(items: readonly ChatItem[], seq: number): string | undefined {
  for (const it of items) {
    if (!isCallGroup(it)) {
      if (it.seq !== undefined && it.seq >= seq) return it.id;
      continue;
    }
    const drawn = new Set(zoomBlocks(it).map((b) => b.id));
    for (const step of it.steps) {
      const at = step.kind === "call" ? step.call.seq : step.seq;
      if (at === undefined || at < seq) continue;
      if (drawn.size === 0) return it.id;
      const id = step.kind === "call" ? step.call.id : step.id;
      if (drawn.has(id)) return id;
    }
  }
  return undefined;
}

/**
 * 条目 id → 挂在它右边的废弃分支：分叉处之后当前路径上的第一条（有序号的）。
 * 工具调用组缩小后那一行藏着，挂到组里第一块（照左边的卡）
 */
export function zoomForks(state: UiState, conversation: ConversationId, items: readonly ChatItem[]): Map<string, ZoomFork[]> {
  const out = new Map<string, ZoomFork[]>();
  const tree = state.conversations[conversation]?.branches;
  if (!tree || tree.branches.length <= 1) return out;
  const start = segmentStart(state, conversation);
  for (const fork of branchForks(tree)) {
    const at = items.find((it) => it.seq !== undefined && it.seq >= fork.at);
    if (!at) continue;
    const blocks = zoomBlocks(at);
    const id = blocks[0]?.id ?? at.id;
    out.set(id, [...(out.get(id) ?? []), ...fork.branches.map((branchId) => ({ branchId, switchable: fork.at > start }))]);
  }
  return out;
}

// ───────────────────────── 合起来 ─────────────────────────

/** 一个会话缩小后条外的全部装饰（界面一次取齐） */
export interface ZoomDecor {
  readonly bands: readonly ZoomBand[];
  readonly spines: readonly ZoomSpine[];
  /** 右侧标注的 ×N（repeatCounts：矩形 id → N，后面并掉的是 0） */
  readonly repeats: ReadonlyMap<string, number>;
  /** 条左边的卡（条目 id → 卡） */
  readonly left: ReadonlyMap<string, ZoomLeftCard>;
  /** 重开之前的那几轮里的条目、组里的块（已废弃） */
  readonly stale: ReadonlySet<string>;
  /** 条左边的回退点（条目 id → 回退点，150 号票） */
  readonly rollbacks: ReadonlyMap<string, readonly ZoomRollbackPoint[]>;
  /** 条右边的废弃分支（条目、块的 id → 分支，150 号票） */
  readonly forks: ReadonlyMap<string, readonly ZoomFork[]>;
}

export function zoomDecor(state: UiState, conversation: ConversationId, items: readonly ChatItem[]): ZoomDecor {
  return {
    bands: zoomBands(state, conversation, items),
    spines: zoomSpines(state, conversation, items),
    repeats: repeatCounts(state, items),
    left: zoomLeftCards(state, conversation, items),
    stale: zoomStaleItems(state, conversation, items),
    rollbacks: zoomRollbacks(state, conversation, items),
    forks: zoomForks(state, conversation, items),
  };
}
