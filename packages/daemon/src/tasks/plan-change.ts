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
// 121 号票：维护者只交要改的就行——没写到的阶段、没写的栏从当前计划原样带上（mergeDraft），交来的已验收阶段以现在的定义为准
// （有出入的记下哪几处，交给维护者的结果里说明，不整份拒掉）；要去掉阶段写在 removeStages（removalProblems）；
// 不一样的地方说得出具体哪一处（stageDifferences："验收标准第 2 条"）。
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
  tellSecretaryField,
  sendAttachmentField,
  toolkitExpansions,
  canTellSecretary,
  canSendAttachment,
  t,
} from "@ergo/protocol";
import { type ToolRegistry, validateGrantChange } from "../guard/index.ts";
import { type GrantTime, grantValidityMs, planGrantIdOf, toGuardGrant, toGuardPlan } from "./plan.ts";

/**
 * 维护者在执行中交来的计划（协议包的 PlanDraft）：本任务的关注类别、用户的限制、记忆范围沿用当前计划，不在里面；
 * 121 号票起只交要改的——每一栏都可以不写（沿用当前计划），stages 里只写要改的、新加的阶段
 */
export type PlanDraft = Partial<Omit<Plan, "watchCategories" | "userLimits" | "memoryScope">>;

/** 交来的已验收阶段里和现在的定义不一样的一个（121 号票：按现在的定义保留了）：阶段 id、哪几处不一样（stageDifferences） */
export interface AcceptedDifference {
  stageId: string;
  differences: string[];
}

export interface DraftMerge {
  /** 合好的完整计划 */
  plan: Plan;
  /** 交来的已验收阶段里和现在的定义不一样、按现在的定义保留了的 */
  keptAccepted: AcceptedDifference[];
}

/**
 * 维护者交来的计划合上当前计划，成为一份完整的计划（121 号票：只交要改的就行）：
 * - stages 里写到的阶段按 stageId 换成交来的，新加的加上；没写到的从当前计划原样带上（编号、前置关系、执行状态都不变），
 *   removeStages 里的去掉（能不能去掉先过 removalProblems）。先后：写到的按交来的先后，带上的留在原来的位置，
 *   新加的阶段排在它在当前计划里的前置阶段后面（交全部阶段时就是交来的先后）；
 * - 交来的已验收阶段（accepted）以现在的定义为准、忽略交来的那份（已验收的阶段不能改，要改让用户返工）：和现在不一样的
 *   列进 keptAccepted（哪几处不一样），交给维护者的结果里说明，不再整份拒掉；
 * - 别的栏（阶段组、工具包、项目、假设栏、停点、token 粗估）不写是沿用当前计划，写了整栏按写的算；
 * - 本任务的关注类别、用户的限制、记忆范围沿用当前计划。工具包里"给秘书发消息"（102 号票）、"发附件"（117 号票）
 *   不写是沿用现在的（不是默认开：用户在任务详情里关掉之后，维护者自行调整计划没写这一项不能把它悄悄打开）；写了照写的算，打开算扩大
 */
export function mergeDraft(current: Plan, draft: PlanDraft, options: { accepted?: readonly string[]; removeStages?: readonly string[] } = {}): DraftMerge {
  const accepted = new Set(options.accepted ?? []);
  const keptAccepted: AcceptedDifference[] = [];
  const submitted = (draft.stages ?? []).map((s) => {
    const now = current.stages.find((x) => x.stageId === s.stageId);
    if (!now || !accepted.has(s.stageId)) return s;
    const differences = stageDifferences(now, s);
    if (differences.length > 0) keptAccepted.push({ stageId: s.stageId, differences });
    return now;
  });
  const { tellSecretary, sendAttachment, ...toolkit } = draft.toolkit ?? current.toolkit;
  const plan: Plan = {
    stages: mergeStages(current.stages, submitted, new Set(options.removeStages ?? [])),
    stageGroups: draft.stageGroups ?? current.stageGroups,
    toolkit: {
      ...toolkit,
      ...tellSecretaryField(tellSecretary ?? canTellSecretary(current.toolkit)),
      ...sendAttachmentField(sendAttachment ?? canSendAttachment(current.toolkit)),
    },
    projects: draft.projects ?? current.projects,
    watchCategories: current.watchCategories,
    ...(current.userLimits === undefined ? {} : { userLimits: current.userLimits }),
    assumptions: draft.assumptions ?? current.assumptions,
    stops: draft.stops ?? current.stops,
    tokenEstimate: draft.tokenEstimate ?? current.tokenEstimate,
    ...(current.memoryScope === undefined ? {} : { memoryScope: current.memoryScope }),
  };
  return { plan, keptAccepted };
}

/**
 * 交来的阶段合进当前计划的阶段（mergeDraft）：交来的按交来的先后；当前计划里没交、也不去掉的原样带上，留在原来的位置——
 * 排到交来的某个原有阶段之前时，先把当前计划里排在它前面的带上；新加的阶段先把它的前置阶段（以及当前计划里排在前置之前的）带上
 */
function mergeStages(current: readonly PlanStage[], submitted: readonly PlanStage[], removed: ReadonlySet<string>): PlanStage[] {
  const position = new Map(current.map((s, i) => [s.stageId, i]));
  const submittedIds = new Set(submitted.map((s) => s.stageId));
  const carried = current.filter((s) => !submittedIds.has(s.stageId) && !removed.has(s.stageId));
  const out: PlanStage[] = [];
  let next = 0;
  /** 带上当前计划里排在 limit 之前的 */
  const carryBefore = (limit: number) => {
    while (next < carried.length && position.get(carried[next]!.stageId)! < limit) out.push(carried[next++]!);
  };
  for (const s of submitted) {
    const at = position.get(s.stageId);
    carryBefore(at ?? Math.max(-1, ...s.dependsOn.map((d) => position.get(d) ?? -1)) + 1);
    out.push(s);
  }
  carryBefore(Number.POSITIVE_INFINITY);
  return out;
}

/** 内容一样就算一样：对象的字段先后不算（维护者照抄时字段先后常常不同），undefined 的字段当没写 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).toSorted().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
}

const sameContent = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// 交来的和现在哪几处不一样、去不掉的阶段：交回维护者（工具结果），照旧中文
// @i18n-ignore-start model
/** 两个列表逐条比，不一样的那几条（第几条；一边多出来的也算）："验收标准第 2 条" */
function itemDifferences(label: string, before: readonly unknown[], after: readonly unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) if (!sameContent(before[i], after[i])) out.push(`${label}第 ${i + 1} 条`);
  return out;
}

/** 按 id 比的（授权项、时序规则）：改了、多了、少了的："授权项 push" */
function idDifferences<T extends { id: string }>(label: string, before: readonly T[], after: readonly T[]): string[] {
  const ids = [...new Set([...before.map((x) => x.id), ...after.map((x) => x.id)])];
  return ids.filter((id) => !sameContent(before.find((x) => x.id === id), after.find((x) => x.id === id))).map((id) => `${label} ${id}`);
}

/** 一个阶段维护者写的各栏（编号除外：编号由守护进程定，93 号票） */
const STAGE_FIELDS = new Set(["stageId", "title", "deliverables", "acceptance", "mode", "modeReason", "steps", "roughIdea", "dependsOn", "policy", "budget", "groupId", "code"]);

/** 阶段里上面那几栏以外的（之前存下的计划里可能有）：也要一样 */
const otherFields = (s: PlanStage) => Object.fromEntries(Object.entries(s).filter(([k]) => !STAGE_FIELDS.has(k)));

/**
 * 一个阶段交来的定义和现在的哪几处不一样（121 号票：被拒、按现在的定义保留时说清是哪一处）："名字""验收标准第 2 条""授权项 push"……
 * 内容一样就算一样（字段先后、前置阶段的先后不算），编号不算
 */
export function stageDifferences(before: PlanStage, after: PlanStage): string[] {
  return [
    ...(before.title !== after.title ? ["名字"] : []),
    ...(before.mode !== after.mode ? ["做法"] : []),
    ...(!sameContent(before.steps ?? [], after.steps ?? []) ? ["步骤"] : []),
    ...(before.modeReason !== after.modeReason ? ["选这种做法的理由"] : []),
    ...(before.roughIdea !== after.roughIdea ? ["初步思路"] : []),
    ...(!sameContent(before.dependsOn.toSorted(), after.dependsOn.toSorted()) ? ["前置阶段"] : []),
    ...(before.groupId !== after.groupId ? ["所属阶段组"] : []),
    ...itemDifferences("交付件", before.deliverables, after.deliverables),
    ...itemDifferences("验收标准", before.acceptance, after.acceptance),
    ...(!sameContent(before.budget, after.budget) ? ["预算"] : []),
    ...idDifferences("授权项", before.policy.grants, after.policy.grants),
    ...idDifferences("时序规则", before.policy.temporalRules, after.policy.temporalRules),
    ...(!sameContent(otherFields(before), otherFields(after)) ? ["其他写法"] : []),
  ];
}

/** "阶段 s1 的名字、验收标准第 2 条和现在不一样" */
export const acceptedDifferenceText = (d: AcceptedDifference) => `阶段 ${d.stageId} 的${d.differences.join("、")}和现在不一样`;

/**
 * 要去掉的阶段（removeStages，121 号票：没写到的阶段是带上，不是去掉）能不能去掉，不行的一条一句：已验收的不能去掉（要改让用户返工），
 * 在等用户或在验收的不能去掉，计划里没有的、同时又写在 stages 里的说清楚
 */
export function removalProblems(current: Plan, draft: PlanDraft, removeStages: readonly string[], list: readonly TaskStage[]): string[] {
  return [...new Set(removeStages)].flatMap((id) => {
    const stage = list.find((s) => s.stageId === id);
    if (!current.stages.some((s) => s.stageId === id)) return [`计划里没有阶段 ${id}，去不掉`];
    if (stage?.state === "accepted") return [`已验收的阶段 ${id} 不能去掉（要改让用户在任务详情里返工）`];
    if (stage?.state === "waiting" || stage?.state === "accepting") return [`阶段 ${id} 在等用户或在验收，不能去掉`];
    if (draft.stages?.some((s) => s.stageId === id)) return [`阶段 ${id} 既写在 stages 里又要去掉`];
    return [];
  });
}
// @i18n-ignore-end

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
  // 开 bash、加 MCP、开联网（27 号票）、打开给秘书发消息（102 号票）算扩大：skill 只是说明书，不增加权限，维护者自己增减
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

/** 一个阶段除了验收标准、交付件、预算、授权项和时序规则（单独比）以外改了哪些（存进计划变更卡，按当时的语言写） */
function stageFieldChanges(b: PlanStage, s: PlanStage): string[] {
  return [
    ...(b.title !== s.title ? [t("tasks.planChange.field.title")] : []),
    ...(b.mode !== s.mode || !same(b.steps ?? [], s.steps ?? []) ? [t("tasks.planChange.field.steps")] : []),
    ...(!same(b.dependsOn.toSorted(), s.dependsOn.toSorted()) ? [t("tasks.planChange.field.dependsOn")] : []),
    ...(b.groupId !== s.groupId ? [t("tasks.planChange.field.group")] : []),
  ];
}

/** 扩大了授权、或者改了目标和验收的那几处（要用户确认） */
export const expanding = (items: readonly PlanChangeItem[]) => items.filter((i) => i.expands);

/**
 * 改动碰到了哪些已验收的阶段（不能改：要改让用户返工）：已验收阶段的定义（验收标准、交付件、授权项、规则、预算、步骤……）
 * 内容原样留着才算没碰（stageDifferences：编号、字段先后不算）。mergeDraft 已经把交来的已验收阶段换回现在的定义，
 * 这里是兜底的检查
 */
export function touchedAcceptedStages(before: Plan, after: Plan, list: readonly TaskStage[]): string[] {
  return list.filter((s) => s.state === "accepted" && touchedText(before, after, s.stageId) !== undefined).map((s) => s.stageId);
}

/** 一个阶段改了哪儿，一句话（没改是 undefined）："阶段 s1 的验收标准第 2 条和现在不一样""阶段 s1 去掉了" */
export function touchedText(before: Plan, after: Plan, id: string): string | undefined {
  const was = before.stages.find((x) => x.stageId === id);
  const now = after.stages.find((x) => x.stageId === id);
  if (!was && !now) return undefined;
  if (!was || !now) return now ? `阶段 ${id} 是新加的` : `阶段 ${id} 去掉了`; // @i18n-ignore model：交回维护者
  const differences = stageDifferences(was, now);
  return differences.length > 0 ? acceptedDifferenceText({ stageId: id, differences }) : undefined;
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
