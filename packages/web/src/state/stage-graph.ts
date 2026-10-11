// 长程任务的依赖图（91 号票，用户 2026-10-11："项目的多个阶段有可能是并行的……这部分完全参照 AgentSense 的长程任务来做"）。
// 照 AgentSense（D:\code\claudecode\user_agent_sense_of_security，bedf5a5）web/src/agent/milestone/check.ts 的 stageNumbers、
// idRuleProblems（编号），web/src/ui/milestone.tsx 的 layers、MilestoneGraph、FillGraph、planNodes、PlanLayer、shownPlan，
// web/src/ui/drawer.tsx 的 StepRail，写成纯函数；界面（ui/conversation/StageGraph.tsx）只管画。
// - 第几阶段 = 最长那条前置链的长度（没有前置的是第 1 阶段），同号的就是并行的；同一阶段有几个时按计划里的先后编 4a、4b、4c
//   （stageCodes：AgentSense 把它写进里程碑编号 M4a，二狗的阶段 id 是维护者起的 s1、s2，编号现算）。图、阶段标签、聊天里的阶段框、
//   阶段条写"第 4 阶段"（AgentSense 也只写阶段号），阶段详情、待办、时间线这些说的是某一个阶段的地方写"第 4a 阶段"；
// - 图：自上而下分层、同一层按计划里的先后并排居中，线从上游底边的中点连到下游顶边的中点（三次贝塞尔，下端留 3px 箭头位）；
//   节点大小按栏的宽高算（fillNodeSize），放不下时整张图缩小到栏宽（fillScale），栏里能上下滑时字不缩小；
// - 画哪一份（taskStageGraph，AgentSense 的 shownPlan + PlanLayer）：有等你确认的计划就画它——计划卡等你确认时每个阶段都没开始；
//   计划变更等你确认时画变更后的那份，状态照执行中的，新加的标"新"、改过的标"改"，去掉的也画上（淡化划掉）；每个阶段标出要你留意的
//   几样（敏 / 权 / 外 / 问的个数）。否则画现在生效的那份：执行中的状态、这一阶段出过的状况（图标），被计划变更去掉的阶段也留在图上；
// - 二狗的阶段组是共用一套策略的几个阶段（不是 AgentSense 的二选一分叉，AgentSense 的图上也不画分叉），图上不画；
//   并行的阶段执行时照旧一次一个（AgentSense 也是），图上只画并排。
import { stagePolicies, type Plan, type PlanChangeCardPayload, type PlanChangeOwner, type PlanCardPayload, type StageDeps, stageCodes, stageNumbers, type TaskWaitReason, taskKind } from "./protocol.ts";
import type { ChatItem } from "./chat-items.ts";
import { type Incident, incidentsIn, itemsByStage } from "./stage-detail.ts";
import { effectivePlanOf, type StageMarks, stageMarks, taskStages } from "./task-detail.ts";
import type { UiState } from "./ui-state.ts";

// ───────────────────────── 第几阶段、编号 ─────────────────────────
// 阶段号、编号在协议包（plan.ts 的 stageNumbers、stageCodes，守护进程以后要写一样的号也用它），这里接着往下用

/** "第 4a 阶段"；不在这份计划里的阶段写它的 id（"阶段 s9"） */
export function stageCodeLabel(codes: ReadonlyMap<string, string>, id: string): string {
  const code = codes.get(id);
  return code === undefined ? `阶段 ${id}` : `第 ${code} 阶段`;
}

// ───────────────────────── 图的排法 ─────────────────────────

/** 节点之间横向、纵向的间隔，图四周的留白（AgentSense MilestoneGraph 的 GX、GY、PAD） */
const GX = 14;
const GY = 26;
const PAD = 8;

/** 按最长路径分层：第几层 = 从起点到它最多经过几个阶段；同一层按给的先后 */
export function graphRows(nodes: readonly StageDeps[]): string[][] {
  const no = stageNumbers(nodes);
  const out: string[][] = [];
  for (const n of nodes) (out[no.get(n.id)! - 1] ??= []).push(n.id);
  return out.filter(Boolean);
}

/** 一张图的几何：整张图的宽高、每个节点的左上角和在第几层（从 0 数）、每条线的路径 */
export interface GraphGeometry {
  readonly width: number;
  readonly height: number;
  readonly pos: ReadonlyMap<string, { readonly x: number; readonly y: number; readonly layer: number }>;
  readonly edges: readonly { readonly key: string; readonly from: string; readonly to: string; readonly layer: number; readonly d: string }[];
}

/** 节点宽 w、高 h 时的排法：同一层在图里居中，线从上游底边的中点连到下游顶边的中点 */
export function graphGeometry(nodes: readonly StageDeps[], w: number, h: number): GraphGeometry {
  const rows = graphRows(nodes);
  const widest = Math.max(1, ...rows.map((r) => r.length));
  const width = widest * (w + GX) - GX + PAD * 2;
  const height = rows.length * (h + GY) - GY + PAD * 2;
  const pos = new Map<string, { x: number; y: number; layer: number }>();
  rows.forEach((row, li) => {
    const rowW = row.length * (w + GX) - GX;
    const x0 = PAD + (width - PAD * 2 - rowW) / 2;
    row.forEach((id, i) => pos.set(id, { x: x0 + i * (w + GX), y: PAD + li * (h + GY), layer: li }));
  });
  const edges = nodes.flatMap((n) =>
    n.after
      .filter((a) => pos.has(a))
      .map((a) => {
        const from = pos.get(a)!;
        const to = pos.get(n.id)!;
        const x1 = from.x + w / 2;
        const y1 = from.y + h;
        const x2 = to.x + w / 2;
        const y2 = to.y;
        const my = (y1 + y2) / 2;
        return { key: `${a}-${n.id}`, from: a, to: n.id, layer: to.layer, d: `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2 - 3}` };
      }),
  );
  return { width, height, pos, edges };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * 节点多大（AgentSense FillGraph）：按放图那块的宽 W、高 H 铺满，宽在 96 到 280 之间，高在 76 到 150 之间；
 * scroll（阶段栏、抽屉里放不下时上下滑）最矮 100，字不缩小
 */
export function fillNodeSize(box: { readonly W: number; readonly H: number }, nodes: readonly StageDeps[], scroll: boolean): { w: number; h: number } {
  const rows = graphRows(nodes);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  return {
    w: clamp(Math.floor((box.W - 16 - (cols - 1) * GX) / cols), 96, 280),
    h: clamp(Math.floor((box.H - 16 - (rows.length - 1) * GY) / rows.length), scroll ? 100 : 76, 150),
  };
}

/** 整张图缩小多少（AgentSense FillGraph 的 k）：比放图那块宽就缩到它的宽；不滑的也缩到它的高；不放大 */
export function fillScale(box: { readonly W: number; readonly H: number }, inner: { readonly width: number; readonly height: number }, scroll: boolean): number {
  return Math.min(1, box.W / inner.width, scroll ? 1 : box.H / inner.height);
}

// ───────────────────────── 节点 ─────────────────────────

/** 图上一个阶段的状态：执行中的几种，加上原型里的没通过、不做了，计划变更去掉的 */
export type GraphNodeState = "pending" | "running" | "accepting" | "waiting" | "accepted" | "failed" | "stopped" | "removed";

/**
 * 一个状态的样子：图标、两三个字（AgentSense PlanLayer 的 PL_STATE），边框的样式类 st-*（AgentSense look.css 的线型：
 * 没开始虚线、在做（含验收中、等你）蓝框呼吸、完成绿底、没通过红框、不做了和去掉的淡化划掉）
 */
export interface GraphLook {
  readonly icon: string;
  readonly text: string;
  readonly st: "pending" | "in_progress" | "submitted" | "accepted" | "failed" | "stopped" | "abandoned";
}

const LOOK: Readonly<Record<GraphNodeState, GraphLook>> = {
  pending: { icon: "○", text: "未开始", st: "pending" },
  running: { icon: "◐", text: "进行中", st: "in_progress" },
  accepting: { icon: "◑", text: "验收中", st: "submitted" },
  waiting: { icon: "◐", text: "等你", st: "submitted" },
  accepted: { icon: "✓", text: "完成", st: "accepted" },
  failed: { icon: "✕", text: "没通过", st: "failed" },
  stopped: { icon: "⏹", text: "不做了", st: "stopped" },
  removed: { icon: "⊘", text: "已取消", st: "abandoned" },
};

/** 等你验收的写"待验收"（AgentSense 的 submitted），别的等你写"等你" */
export function graphLook(state: GraphNodeState, waitReason?: string): GraphLook {
  return state === "waiting" && waitReason === "acceptance" ? { icon: "◑", text: "待验收", st: "submitted" } : LOOK[state];
}

/** 画一个阶段要的（真任务从看板和会话算，原型从假阶段给） */
export interface GraphStageInput {
  readonly id: string;
  readonly title: string;
  readonly after: readonly string[];
  readonly state: GraphNodeState;
  readonly waitReason?: TaskWaitReason | string | undefined;
  /** 这一阶段出过的状况（执行中的计划才有） */
  readonly incidents?: readonly Incident[] | undefined;
  /** 要你留意的几样（等你确认的计划才标） */
  readonly marks?: StageMarks | undefined;
  /** 计划变更里新加的、改过的 */
  readonly mark?: "新" | "改" | undefined;
}

/** 图上的一个阶段 */
export interface StageGraphNode {
  readonly id: string;
  /** 前置阶段（只留图上有的） */
  readonly after: readonly string[];
  readonly title: string;
  /** 第几阶段（依赖层，并行的同号） */
  readonly n: number;
  /** 编号：4、4a（去掉的写阶段号） */
  readonly code: string;
  readonly state: GraphNodeState;
  readonly look: GraphLook;
  readonly incidents: readonly Incident[];
  /** 出过状况（拉回、拦下、退回、重做、要你看一眼；只问过你、只用到敏感数据的不算）：AgentSense 的 trouble */
  readonly trouble: boolean;
  readonly marks?: StageMarks | undefined;
  readonly mark?: "新" | "改" | undefined;
}

/** 把几个阶段排成图上的节点：编号只按还在计划里的算，去掉的写它所在的阶段号；前置只留图上有的 */
export function stageGraphNodes(list: readonly GraphStageInput[]): StageGraphNode[] {
  const ids = new Set(list.map((s) => s.id));
  const all = list.map((s) => ({ id: s.id, after: s.after.filter((x) => ids.has(x)) }));
  const no = stageNumbers(all);
  const codes = stageCodes(all.filter((_, i) => list[i]!.state !== "removed"));
  return list.map((s, i) => {
    const incidents = s.incidents ?? [];
    return {
      id: s.id,
      after: all[i]!.after,
      title: s.title,
      n: no.get(s.id)!,
      code: codes.get(s.id) ?? `${no.get(s.id)!}`,
      state: s.state,
      look: graphLook(s.state, s.waitReason),
      incidents,
      trouble: incidents.some((x) => x.kind !== "ask" && x.kind !== "data"),
      ...(s.marks ? { marks: s.marks } : {}),
      ...(s.mark ? { mark: s.mark } : {}),
    };
  });
}

/** 手机抽屉半开的横向阶段条（AgentSense StepRail）：一个阶段一列，并行的叠在同一列；去掉的不画 */
export function railColumns(nodes: readonly StageGraphNode[]): StageGraphNode[][] {
  const live = nodes.filter((n) => n.state !== "removed");
  const no = stageNumbers(live);
  const cols: StageGraphNode[][] = [];
  for (const n of live) (cols[no.get(n.id)! - 1] ??= []).push(n);
  return cols.filter(Boolean);
}

// ───────────────────────── 画哪一份计划 ─────────────────────────

/**
 * 左栏、抽屉里画的那份计划：kind 是 live（现在生效的）、plan（计划卡等你确认）、change（计划变更等你确认）；
 * cardId 是等你确认的那张卡；current 是维护者正在做的那一阶段
 */
export interface StageGraph {
  readonly kind: "live" | "plan" | "change";
  readonly cardId?: string | undefined;
  readonly nodes: readonly StageGraphNode[];
  readonly current?: string | undefined;
}

/** 这个任务等你确认的计划变更卡（有几张取最新的） */
export function pendingPlanChange(state: UiState, taskId: string): { cardId: string; payload: PlanChangeCardPayload } | undefined {
  let found: { cardId: string; payload: PlanChangeCardPayload; at: string } | undefined;
  for (const { card } of Object.values(state.cards)) {
    if (card.type !== "plan_change" || card.status !== "pending") continue;
    const payload = card.payload as PlanChangeCardPayload;
    if (payload.taskId !== taskId) continue;
    if (!found || card.createdAt > found.at) found = { cardId: card.id, payload, at: card.createdAt };
  }
  return found;
}

/** 一个阶段在计划里写的（比较两版有没有改过它） */
const stageJson = (plan: Plan, id: string) => JSON.stringify(plan.stages.find((s) => s.stageId === id));

/**
 * 计划变更里落在某个阶段上的改动（改了它的授权、规则、验收、交付件、预算、名字、前置……）；改的是阶段组的授权、规则时，
 * 组里的阶段都算（AgentSense 的授权写在里程碑上；二狗的阶段组共用一份，组里每个阶段能做的跟着变）
 */
function changedStages(payload: PlanChangeCardPayload): Set<string> {
  const out = new Set<string>();
  const stagesOf = (o: PlanChangeOwner) => (o.kind === "stage" ? [o.id] : payload.plan.stages.filter((s) => s.groupId === o.id).map((s) => s.stageId));
  for (const c of payload.changes) {
    if ("owner" in c) for (const id of stagesOf(c.owner)) out.add(id);
    if (c.kind === "grant_moved") for (const o of [c.from, c.to]) for (const id of stagesOf(o)) out.add(id);
    if (c.kind === "acceptance") for (const x of [...c.added, ...c.removed]) out.add(x.stageId);
    if (c.kind === "deliverables") for (const x of [...c.added, ...c.removed]) out.add(x.stageId);
    if (c.kind === "budget") for (const x of c.stages) out.add(x.stageId);
    if (c.kind === "stage_changed") out.add(c.stageId);
    if (c.kind === "stage_grants") for (const id of c.stageIds) out.add(id);
  }
  return out;
}

/** 这几版计划里有、现在的阶段里没有的（被计划变更、自行调整去掉的），按先后、不重复 */
function removedStages(plans: readonly Plan[], kept: ReadonlySet<string>): { id: string; title: string; after: string[] }[] {
  const out = new Map<string, { id: string; title: string; after: string[] }>();
  for (const plan of plans) for (const s of plan.stages) if (!kept.has(s.stageId) && !out.has(s.stageId)) out.set(s.stageId, { id: s.stageId, title: s.title, after: [...s.dependsOn] });
  return [...out.values()];
}

/**
 * 这个任务被计划变更、自行调整去掉的阶段（kept 是现在还在的）：标题、前置照确认过的旧版计划（依赖图上画成已取消；
 * 聊天里它那一段的阶段框也从这里取标题、阶段号）
 */
export function removedTaskStages(state: UiState, taskId: string, kept: ReadonlySet<string>): { id: string; title: string; after: string[] }[] {
  return removedStages(approvedPlans(state, taskId), kept);
}

/** 一张卡确认过了（计划卡、计划变更卡） */
const confirmed = (status: string, action: string | undefined) => status === "handled" && action === "confirm";

/** 这个任务确认过的几版计划：计划卡（确认过的）、确认过的计划变更卡，加上现在生效的那份 */
function approvedPlans(state: UiState, taskId: string): Plan[] {
  const out: Plan[] = [];
  const cards = Object.values(state.cards)
    .map((c) => c.card)
    .filter((c) => (c.type === "plan" || c.type === "plan_change") && (c.payload as { taskId?: string }).taskId === taskId && confirmed(c.status, c.outcome?.action))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of cards) out.push((c.payload as PlanCardPayload | PlanChangeCardPayload).plan);
  const revised = state.taskPlans[taskId];
  if (revised) out.push(revised.plan);
  return out;
}

/**
 * 计划变更等你确认时画的那份（AgentSense planNodes 的 changed / removed）：变更后的各阶段，状态照执行中的（status：阶段 id → 现在的
 * 状态；没有的是新加的、没开始），新加的标"新"、改过的标"改"；变更前那份（base）里有、变更后没有的也画上（去掉的）；
 * 每个阶段标出要你留意的几样（按这张卡的授权说法）
 */
export function changeStageGraph(
  change: { cardId: string; payload: PlanChangeCardPayload },
  base: Plan | undefined,
  status: ReadonlyMap<string, { readonly state: GraphNodeState; readonly waitReason?: string | undefined }>,
  current: string | undefined,
): StageGraph {
  const plan = change.payload.plan;
  const touched = changedStages(change.payload);
  const had = new Set(base?.stages.map((s) => s.stageId) ?? []);
  const nodes: GraphStageInput[] = plan.stages.map((s) => {
    const now = status.get(s.stageId);
    const mark = !had.has(s.stageId) ? "新" : touched.has(s.stageId) || (base && stageJson(base, s.stageId) !== stageJson(plan, s.stageId)) ? "改" : undefined;
    return {
      id: s.stageId,
      title: s.title,
      after: s.dependsOn,
      state: now?.state ?? "pending",
      waitReason: now?.waitReason,
      marks: stageMarks(change.payload, s.stageId, stagePolicies(plan, s.stageId).flatMap((p) => p.grants)),
      mark,
    };
  });
  const kept = new Set(plan.stages.map((s) => s.stageId));
  for (const r of removedStages(base ? [base] : [], kept)) nodes.push({ id: r.id, title: r.title, after: r.after, state: "removed" });
  return { kind: "change", cardId: change.cardId, nodes: stageGraphNodes(nodes), current };
}

/** 计划卡等你确认时画的那份：每个阶段都没开始，标出要你留意的几样；这张卡不是等你确认的计划卡就没有 */
export function planCardStageGraph(state: UiState, cardId: string | undefined): StageGraph | undefined {
  const card = cardId === undefined ? undefined : state.cards[cardId]?.card;
  if (card?.type !== "plan" || card.status !== "pending") return undefined;
  const payload = card.payload as PlanCardPayload;
  const nodes = payload.plan.stages.map((s) => ({
    id: s.stageId,
    title: s.title,
    after: s.dependsOn,
    state: "pending" as const,
    marks: stageMarks(payload, s.stageId, stagePolicies(payload.plan, s.stageId).flatMap((p) => p.grants)),
  }));
  return { kind: "plan", cardId: card.id, nodes: stageGraphNodes(nodes) };
}

/**
 * 长程任务的左栏、抽屉里画什么（AgentSense shownPlan + PlanLayer）；不是长程任务、还没有计划的没有。items 是这个任务的维护者会话
 * （整段，算每个阶段出过的状况）
 */
export function taskStageGraph(state: UiState, taskId: string, items: readonly ChatItem[]): StageGraph | undefined {
  const task = state.tasks[taskId];
  if (!task || taskKind(task) !== "long_running") return undefined;
  const live = task.stages?.list;
  // 计划变更等你确认：画变更后的那份，状态照执行中的；新加的标"新"、改过的标"改"，去掉的也画上
  const change = pendingPlanChange(state, taskId);
  if (change) return changeStageGraph(change, effectivePlanOf(state, task)?.plan, new Map((live ?? []).map((s) => [s.stageId, s])), task.stages?.focus);
  // 计划卡等你确认（还没开始执行）：每个阶段都没开始，标出要你留意的
  const pending = live ? undefined : planCardStageGraph(state, task.planCardId);
  if (pending) return pending;
  // 现在生效的那份：执行中的状态、出过的状况；被计划变更去掉的阶段也留在图上
  const stages = taskStages(state, taskId);
  if (!stages.length) return undefined;
  const byStage = itemsByStage(state, items, taskId);
  const nodes: GraphStageInput[] = stages.map((s) => ({
    id: s.stageId,
    title: s.title,
    after: s.dependsOn,
    state: s.state,
    waitReason: s.waitReason,
    incidents: incidentsIn(state, byStage.get(s.stageId) ?? []),
  }));
  const kept = new Set(stages.map((s) => s.stageId));
  for (const r of removedTaskStages(state, taskId, kept)) nodes.push({ id: r.id, title: r.title, after: r.after, state: "removed" });
  return { kind: "live", nodes: stageGraphNodes(nodes), current: task.stages?.focus ?? live?.find((s) => s.state === "running")?.stageId };
}

/**
 * 原型里的假任务（没有看板事件，阶段是写死的）：有等你确认的计划变更、计划卡就画它（和真任务一样），否则照它的阶段画现在生效的那份；
 * 出过的状况照样从它的假会话里数。planCardId 是它的计划卡
 */
export function listedStageGraph(
  state: UiState,
  items: readonly ChatItem[],
  taskId: string,
  stages: readonly { id: string; title: string; after: readonly string[]; status: GraphNodeState; waitReason?: string | undefined }[],
  planCardId?: string | undefined,
): StageGraph | undefined {
  if (!stages.length) return undefined;
  const current = stages.find((s) => s.status === "running" || s.status === "accepting" || s.status === "waiting")?.id;
  const change = pendingPlanChange(state, taskId);
  if (change) {
    const base = planCardId === undefined ? undefined : state.cards[planCardId]?.card;
    const basePlan = base?.type === "plan" ? (base.payload as PlanCardPayload).plan : undefined;
    return changeStageGraph(change, basePlan, new Map(stages.map((s) => [s.id, { state: s.status, waitReason: s.waitReason }])), current);
  }
  const pending = planCardStageGraph(state, planCardId);
  if (pending) return pending;
  const byStage = itemsByStage(state, items, taskId);
  const nodes = stages.map((s) => ({ id: s.id, title: s.title, after: s.after, state: s.status, waitReason: s.waitReason, incidents: incidentsIn(state, byStage.get(s.id) ?? []) }));
  return { kind: "live", nodes: stageGraphNodes(nodes), current };
}

// ───────────────────────── 标题栏的阶段标签显示哪一阶段 ─────────────────────────

/**
 * 阶段标签、图上高亮的是哪一阶段（AgentSense App.tsx 的 followStep、shownStep）：你手动点的 > 聊天里正在看的那一段
 * （focus：视口 40% 高处那一条；停在最新一条时是正在做的那一阶段）> 正在做的 > 最后一条那一段 > 第一个。
 * stepAt 是聊天里每一条属于哪个阶段（stageAtItems），lastItemId 是会话最后一条
 */
export function shownStage(at: {
  readonly pinned?: string | undefined;
  readonly focus: { readonly id?: string | undefined; readonly bottom: boolean };
  readonly current?: string | undefined;
  readonly stepAt: ReadonlyMap<string, string>;
  readonly lastItemId?: string | undefined;
  readonly first?: string | undefined;
}): string | undefined {
  const lastStep = at.lastItemId === undefined ? undefined : at.stepAt.get(at.lastItemId);
  const follow = at.focus.bottom ? (at.current ?? lastStep) : at.focus.id !== undefined ? at.stepAt.get(at.focus.id) : undefined;
  return at.pinned ?? follow ?? at.current ?? lastStep ?? at.first;
}
