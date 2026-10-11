// 计划变更和自行调整计划（规格第 8 节"计划变更"，14 号票）的纯函数：维护者交来一份新计划，和当前确认的计划比，
// 列出新增或改动的部分（PlanChangeItem），并判断每一处是否扩大授权或改了目标、验收：
// - 扩大的（新增授权项、放宽对象范围或次数、延长有效期、授权项换阶段、加工具包能力、加项目、改目标或任务的验收标准、
//   改阶段的验收或交付件、加预算、删改时序规则、换进有授权的阶段组或离开有规则的阶段组）走计划变更：用户在计划变更卡上确认，
//   只有受影响的阶段停下来等；
// - 不扩大的（拆阶段、调顺序、改步骤和标题、收窄或去掉授权项、加时序规则）维护者自行调整，记进时间线。
// 维护者交的新计划里没有本任务的关注类别、用户的限制、定时作业和记忆范围：执行中这几样沿用当前计划
// （类别只能由用户在计划变更卡上加，限制是用户说过的话），所以只比其余部分。
// 每种改动的说法、对应的授权项、落在哪些阶段上在协议包 plan.ts 的 PLAN_CHANGE_KINDS 一张表里。
// 已验收的阶段不能改（要改让用户返工）。授权项的有效期（授予时间、到期时间）在变更之后怎么算也在这里（grantTimesAfter）。
import {
  type AcceptanceCriterion,
  budgetRaised,
  type Plan,
  type PlanChangeItem,
  type PlanChangeOwner,
  planChangeGrant,
  planChangeStages,
  type PlanGrant,
  type PlanProject,
  type PlanStage,
  type PlanTemporalRule,
  planGrants,
  type PolicyOwner,
  sameToolkit,
  type TaskStage,
  toolkitExpansions,
} from "@ergou/protocol";
import { type ToolRegistry, validateGrantChange } from "../guard/index.ts";
import { type GrantTime, grantValidityMs, planGrantIdOf, toGuardGrant, toGuardPlan } from "./plan.ts";

/** 维护者在执行中交来的计划：本任务的关注类别、用户的限制、记忆范围沿用当前计划，不在里面 */
export type PlanDraft = Omit<Plan, "watchCategories" | "userLimits" | "memoryScope">;

/** 维护者交来的计划合上当前计划沿用的几样，成为一份完整的计划 */
export function mergeDraft(current: Plan, draft: PlanDraft): Plan {
  return {
    ...draft,
    watchCategories: current.watchCategories,
    ...(current.userLimits === undefined ? {} : { userLimits: current.userLimits }),
    ...(current.memoryScope === undefined ? {} : { memoryScope: current.memoryScope }),
  };
}

const ownerRef = (owner: PolicyOwner): PlanChangeOwner =>
  owner.kind === "stage" ? { kind: "stage", id: owner.stageId, title: owner.title } : { kind: "group", id: owner.groupId, title: owner.title };

/** 阶段和阶段组上的授权项 */
const stageGrants = (plan: Plan) => planGrants(plan).map(({ grant, owner }) => ({ grant, owner: ownerRef(owner) }));

const sameOwner = (a: PlanChangeOwner, b: PlanChangeOwner) => a.kind === b.kind && a.id === b.id;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 一项授权放宽了没有（和守卫判"运行中授权只能收窄"同一道检查：对象范围、次数、有效期） */
function widened(before: PlanGrant, after: PlanGrant, tools: ToolRegistry): boolean {
  return !validateGrantChange([toGuardGrant(before, "x", 0)], [toGuardGrant(after, "x", 0)], tools).ok;
}

/** 多重集合的差：a 里有、b 里没有的（按 key） */
function minus<T>(a: readonly T[], b: readonly T[], key: (x: T) => string): T[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(key(x), (left.get(key(x)) ?? 0) + 1);
  const out: T[] = [];
  for (const x of a) {
    const k = key(x);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else out.push(x);
  }
  return out;
}

const criterionKey = (x: { criterion: AcceptanceCriterion }) =>
  JSON.stringify([x.criterion.criterion, x.criterion.method, x.criterion.script ?? null, x.criterion.expectOutput ?? null]);

/**
 * 多出来的项目或项目的改动。涉及多个项目的任务（17 号票）一个项目可以在几个阶段各有一行：按项目和所属阶段对上
 * （挪到别的阶段算多出来的）；去掉的行不算
 */
function projectAdditions(before: readonly PlanProject[], after: readonly PlanProject[]): string[] {
  const out: string[] = [];
  for (const p of after) {
    const was = before.find((b) => b.project === p.project && b.stageId === p.stageId);
    if (!was) out.push(p.project);
    else if (p.changes.some((c) => !was.changes.includes(c))) out.push(p.project);
  }
  return out;
}

const totals = (plan: Plan) => ({
  tokens: plan.stages.reduce((n, s) => n + s.budget.tokens, 0),
  toolCalls: plan.stages.reduce((n, s) => n + s.budget.toolCalls, 0),
});

/** 任务书里改得了的两样（目标、任务的验收标准）：维护者在计划变更里写了新的才比 */
export interface BriefChange {
  goal?: { before: string; after: string };
  criteria?: { before: readonly string[]; after: readonly string[] };
}

export interface PlanDiffInput extends BriefChange {
  before: Plan;
  after: Plan;
  tools: ToolRegistry;
}

/** 整份计划里的验收标准、交付件（带所在阶段） */
const criteria = (plan: Plan) => plan.stages.flatMap((s) => s.acceptance.map((criterion) => ({ stageId: s.stageId, criterion })));
const deliverables = (plan: Plan) => plan.stages.flatMap((s) => s.deliverables.map((text) => ({ stageId: s.stageId, text })));

/** 各阶段、阶段组上的时序规则 */
const rulesOf = (plan: Plan) => [
  ...plan.stages.map((s) => ({ owner: { kind: "stage" as const, id: s.stageId, title: s.title }, rules: s.policy.temporalRules })),
  ...plan.stageGroups.map((g) => ({ owner: { kind: "group" as const, id: g.groupId, title: g.title }, rules: g.policy.temporalRules })),
];

/** plan 里也在 other 里的阶段，按 plan 里的顺序 */
const kept = (plan: Plan, other: Plan) => plan.stages.map((s) => s.stageId).filter((id) => other.stages.some((o) => o.stageId === id));

const cleanList = (xs: readonly string[]) => xs.map((x) => x.trim()).filter(Boolean);

/** 相对当前计划新增或改动的部分（按授权项、工具包、项目、目标、验收、交付件、预算、时序规则、阶段的顺序列） */
export function diffPlan({ before, after, goal, criteria: briefCriteria, tools }: PlanDiffInput): PlanChangeItem[] {
  const items: PlanChangeItem[] = [];

  // ── 授权项：按 id 对上 ──
  const was = new Map(stageGrants(before).map((g) => [g.grant.id, g]));
  const now = new Map(stageGrants(after).map((g) => [g.grant.id, g]));
  for (const [id, a] of now) {
    const b = was.get(id);
    if (!b) items.push({ kind: "grant_added", expands: true, owner: a.owner, grant: a.grant });
    else if (!sameOwner(a.owner, b.owner)) items.push({ kind: "grant_moved", expands: true, from: b.owner, to: a.owner, grant: a.grant });
    else if (widened(b.grant, a.grant, tools)) items.push({ kind: "grant_widened", expands: true, owner: a.owner, before: b.grant, after: a.grant });
    else if (!same(b.grant, a.grant)) items.push({ kind: "grant_narrowed", expands: false, owner: a.owner, before: b.grant, after: a.grant });
  }
  for (const [id, b] of was) if (!now.has(id)) items.push({ kind: "grant_removed", expands: false, owner: b.owner, grant: b.grant });

  // ── 工具包、项目、任务书（目标、任务的验收标准） ──
  // 只有开 bash、加 MCP、开联网算扩大（27 号票）：skill 只是说明书，不增加权限，维护者自己增减
  if (!sameToolkit(before.toolkit, after.toolkit)) items.push({ kind: "toolkit", expands: toolkitExpansions(before.toolkit, after.toolkit).length > 0, before: before.toolkit, after: after.toolkit });
  if (!same(before.projects, after.projects)) items.push({ kind: "projects", expands: projectAdditions(before.projects, after.projects).length > 0, before: before.projects, after: after.projects });
  if (goal && goal.after.trim() !== "" && goal.after.trim() !== goal.before.trim()) items.push({ kind: "goal", expands: true, before: goal.before, after: goal.after.trim() });
  if (briefCriteria && cleanList(briefCriteria.after).length > 0 && !same(cleanList(briefCriteria.before), cleanList(briefCriteria.after))) {
    items.push({ kind: "criteria", expands: true, before: [...briefCriteria.before], after: cleanList(briefCriteria.after) });
  }

  // ── 阶段的验收标准、交付件：整份计划里的多重集合（拆阶段时挪到新阶段不算改） ──
  const addedCriteria = minus(criteria(after), criteria(before), criterionKey);
  const removedCriteria = minus(criteria(before), criteria(after), criterionKey);
  if (addedCriteria.length > 0 || removedCriteria.length > 0) items.push({ kind: "acceptance", expands: true, added: addedCriteria, removed: removedCriteria });
  const addedDeliverables = minus(deliverables(after), deliverables(before), (x) => x.text);
  const removedDeliverables = minus(deliverables(before), deliverables(after), (x) => x.text);
  if (addedDeliverables.length > 0 || removedDeliverables.length > 0) items.push({ kind: "deliverables", expands: true, added: addedDeliverables, removed: removedDeliverables });

  // ── 预算：总数加了、或者原有阶段的预算加了，都算扩大 ──
  const budgetStages = after.stages.flatMap((s) => {
    const old = before.stages.find((b) => b.stageId === s.stageId);
    return old && same(old.budget, s.budget) ? [] : [{ stageId: s.stageId, title: s.title, ...(old ? { before: old.budget } : {}), after: s.budget }];
  });
  const removedBudget = before.stages.filter((b) => !after.stages.some((s) => s.stageId === b.stageId)).map((b) => ({ stageId: b.stageId, title: b.title, before: b.budget }));
  if (budgetStages.length > 0 || removedBudget.length > 0) {
    const t0 = totals(before);
    const t1 = totals(after);
    const raised = budgetRaised(t0, t1) || budgetStages.some((s) => s.before && budgetRaised(s.before, s.after));
    items.push({ kind: "budget", expands: raised, before: t0, after: t1, stages: [...budgetStages, ...removedBudget] });
  }

  // ── 时序规则：原有的主人（还在的阶段、阶段组）上的规则只能加，不能删改 ──
  const beforeRules = rulesOf(before);
  for (const { owner, rules } of rulesOf(after)) {
    const old = beforeRules.find((r) => sameOwner(r.owner, owner));
    const prior: readonly PlanTemporalRule[] = old?.rules ?? [];
    const removed = prior.filter((r) => !rules.some((x) => same(x, r)));
    const added = rules.filter((r) => !prior.some((x) => same(x, r)));
    // 新阶段、新阶段组上的规则算新加的（收紧）
    if (removed.length > 0 || added.length > 0) items.push({ kind: "rules", expands: old !== undefined && removed.length > 0, owner, removed: old ? removed : [], added });
  }
  for (const { owner, rules } of beforeRules) {
    if (owner.kind === "group" && rules.length > 0 && !after.stageGroups.some((g) => g.groupId === owner.id)) items.push({ kind: "rules", expands: true, owner, removed: [...rules], added: [] });
  }

  // ── 阶段：加了、去掉了、顺序、各自改了什么 ──
  for (const s of after.stages) if (!before.stages.some((b) => b.stageId === s.stageId)) items.push({ kind: "stage_added", expands: false, stageId: s.stageId, title: s.title });
  for (const b of before.stages) if (!after.stages.some((s) => s.stageId === b.stageId)) items.push({ kind: "stage_removed", expands: false, stageId: b.stageId, title: b.title });
  if (!same(kept(before, after), kept(after, before))) items.push({ kind: "stage_order", expands: false, before: before.stages.map((s) => s.stageId), after: after.stages.map((s) => s.stageId) });
  for (const s of after.stages) {
    const b = before.stages.find((x) => x.stageId === s.stageId);
    if (!b) continue;
    const fields = stageFieldChanges(b, s);
    if (fields.length === 0) continue;
    const groupMove = b.groupId !== s.groupId;
    // 离开有时序规则的阶段组：组的规则不再管它，算扩大（进了有授权项的组见下面的 stage_grants）
    const leavesRules = groupMove && b.groupId !== undefined && (before.stageGroups.find((g) => g.groupId === b.groupId)?.policy.temporalRules.length ?? 0) > 0;
    items.push({
      kind: "stage_changed",
      expands: leavesRules,
      stageId: s.stageId,
      title: s.title,
      fields,
      ...(groupMove ? { group: { ...(b.groupId === undefined ? {} : { before: b.groupId }), ...(s.groupId === undefined ? {} : { after: s.groupId }) } } : {}),
    });
  }

  // 守卫眼里的授权项（阶段组的授权项展开到组里各阶段）：上面按计划里的授权项没认出来的放宽（新阶段进了有授权项的组、
  // 原有阶段换进有授权项的组），按阶段列出来
  const explained = new Set(items.filter((i) => i.expands).flatMap((i) => planChangeGrant(i)?.id ?? []));
  const guardBefore = toGuardPlan(before, { confirmedAt: 0 }).grants;
  const widenedStages = toGuardPlan(after, { confirmedAt: 0 })
    .grants.filter((g) => !explained.has(planGrantIdOf(g.grantId)))
    .filter((g) => {
      const old = guardBefore.find((x) => x.grantId === g.grantId);
      return !old || !validateGrantChange([old], [g], tools).ok;
    })
    .map((g) => g.stageId);
  if (widenedStages.length > 0) items.push({ kind: "stage_grants", expands: true, stageIds: [...new Set(widenedStages)] });
  return items;
}

/** 一个阶段除了验收标准、交付件、预算、授权项和时序规则（单独比）以外改了哪些 */
function stageFieldChanges(b: PlanStage, s: PlanStage): string[] {
  return [
    ...(b.title !== s.title ? ["名字"] : []),
    ...(b.mode !== s.mode || !same(b.steps ?? [], s.steps ?? []) ? ["步骤"] : []),
    ...(!same(b.dependsOn.toSorted(), s.dependsOn.toSorted()) ? ["前置阶段"] : []),
    ...(b.groupId !== s.groupId ? ["所属阶段组"] : []),
  ];
}

/** 扩大了授权、或者改了目标和验收的那几处（要用户确认） */
export const expanding = (items: readonly PlanChangeItem[]) => items.filter((i) => i.expands);

/**
 * 改动碰到了哪些已验收的阶段（不能改：要改让用户返工）：已验收阶段的定义（验收标准、交付件、授权项、规则、预算、步骤……）
 * 原样留着才算没碰
 */
export function touchedAcceptedStages(before: Plan, after: Plan, list: readonly TaskStage[]): string[] {
  return list
    .filter((s) => s.state === "accepted")
    .map((s) => s.stageId)
    .filter((id) => !same(stageDefinition(before, id), stageDefinition(after, id)));
}

/** 一个阶段的定义，编号（93 号票）除外：编号不是维护者定的，不算改动（维护者交来的没有编号，现在生效的那份有） */
function stageDefinition(plan: Plan, id: string) {
  const stage = plan.stages.find((x) => x.stageId === id);
  return stage && { ...stage, code: undefined };
}

/**
 * 计划变更要停下哪些阶段：扩大的改动落在哪些阶段上（PLAN_CHANGE_KINDS 里各种改动的 stages：授权项挂的阶段、阶段组里的各阶段、
 * 改了验收或交付件的阶段、加了预算的阶段、删改了规则的阶段……），加上维护者点名的；都不落在现有阶段上的（工具包、项目、目标）
 * 停下手头在做的那个。只停现有的、还没验收的阶段（新加的阶段确认之后才有）
 */
export function affectedStages(items: readonly PlanChangeItem[], after: Plan, list: readonly TaskStage[], declared: readonly string[], current: string | undefined): string[] {
  const widening = expanding(items);
  const ids = new Set<string>([...declared, ...widening.flatMap((item) => planChangeStages(item, after))]);
  const live = (id: string) => list.some((s) => s.stageId === id && s.state !== "accepted");
  const out = [...ids].filter(live);
  if (out.length === 0 && widening.length > 0 && current !== undefined && live(current)) out.push(current);
  return list.map((s) => s.stageId).filter((id) => out.includes(id));
}

/**
 * 计划改了之后每项授权（守卫的 id：阶段组的写成"授权项 id@阶段 id"）的授予时间和到期时间：
 * 原样留着或收窄了的照旧（次数接着算、到期时间不变）；放宽了的授予时间照旧（次数接着算），有效期从这次确认起重新算
 * （取晚的）；新加的从这次确认起算。before 没给的（13 号票确认的计划）按确认时刻和各自的有效期算
 */
export function grantTimesAfter(input: { before: Plan; beforeTimes: Readonly<Record<string, GrantTime>> | undefined; beforeConfirmedAt: number; after: Plan; at: number; tools: ToolRegistry }): Record<string, GrantTime> {
  const { before, after, at } = input;
  const oldTimes = input.beforeTimes ?? initialGrantTimes(before, input.beforeConfirmedAt);
  const oldGrants = new Map(toGuardPlan(before, { confirmedAt: 0 }).grants.map((g) => [g.grantId, g]));
  const out: Record<string, GrantTime> = {};
  for (const g of toGuardPlan(after, { confirmedAt: 0 }).grants) {
    const old = oldGrants.get(g.grantId);
    const time = oldTimes[g.grantId];
    if (!old || !time || old.stageId !== g.stageId) {
      out[g.grantId] = { grantedAt: at, expiresAt: extendedExpiry(after, g.grantId, at) };
      continue;
    }
    const wider = !validateGrantChange([old], [g], input.tools).ok;
    out[g.grantId] = wider ? { grantedAt: time.grantedAt, expiresAt: Math.max(time.expiresAt, extendedExpiry(after, g.grantId, at)) } : time;
  }
  return out;
}

/**
 * 一项授权（守卫的 id）从 from 起再给一期有效期之后的到期时间（新加、放宽的授权项从确认时起算；续期从原来的到期时间起算，
 * 过了就从现在起算）：有效期按计划里这一项写的天数，没写按默认 7 天
 */
export function extendedExpiry(plan: Plan, guardGrantId: string, from: number): number {
  const id = planGrantIdOf(guardGrantId);
  return from + grantValidityMs(planGrants(plan).find((g) => g.grant.id === id)?.grant);
}

/** 确认时的授予时间、到期时间（13 号票的计划：从确认时刻、按各自的有效期算） */
export function initialGrantTimes(plan: Plan, confirmedAt: number): Record<string, GrantTime> {
  return Object.fromEntries(toGuardPlan(plan, { confirmedAt }).grants.map((g) => [g.grantId, { grantedAt: g.grantedAt, expiresAt: g.expiresAt ?? extendedExpiry(plan, g.grantId, g.grantedAt) }]));
}

/** 计划改了之后执行中各阶段的样子：原有的阶段留着执行状态（验收标准没变的连结果一起留），新加的未开始，去掉的不要了 */
export function stagesAfter(list: readonly TaskStage[], after: Plan): TaskStage[] {
  return after.stages.map((s) => {
    const old = list.find((x) => x.stageId === s.stageId);
    const acceptance = s.acceptance.map((a) => {
      const was = old?.acceptance.find((x) => x.criterion === a.criterion && x.method === a.method);
      return was?.result ? { criterion: a.criterion, method: a.method, result: was.result } : { criterion: a.criterion, method: a.method };
    });
    // 编号照计划里存的（93 号票：已有的不变，新加的是计划调整时给的号）
    const code = s.code === undefined ? {} : { code: s.code };
    if (!old) return { stageId: s.stageId, title: s.title, state: "pending", dependsOn: [...s.dependsOn], acceptance, attempts: 0, ...code };
    return { ...old, title: s.title, dependsOn: [...s.dependsOn], acceptance, ...code };
  });
}
