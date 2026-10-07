// 计划（规格第 8 节）在守护进程里的纯函数：
// - checkPlan：维护者提交时，查 schema 管不到的（schema 由 pi 按工具参数先校验，守护进程再按同一个 schema 校验一次）：
//   阶段和阶段组的引用、前置关系不成环、每份策略（授权项：id 唯一、工具登记过、对象范围的参数是这个工具的；
//   时序规则：validateTemporalRules，05 号票）、本任务的关注类别（全局的一个不能少、处置只能更严、新加的要写确定的规则）、
//   用户说过的限制（26 号票：编译出的规则过规则校验，授权收窄只能收窄、提交时就落到授权项上）；
// - grantInfoOf：每项授权在守卫眼里的样子（工具的中文名、落在哪些关注类别、任务里最严的处置），计划卡据此生成授权行和停点；
// - narrowPlan：用户在计划卡上勾掉或收窄授权项（validateGrantChange：只能收窄）、改假设栏、加本任务的关注类别（26 号票）；
// - toGuardPlan：确认后的计划交给守卫的样子（GuardPlan：授权项挂到阶段上、时序规则照原样、限制编译出的规则加到每个阶段上、
//   关注类别的追加写成设置：对全局类别的调严只记处置，规则和存废跟着全局走），13 号票用。
// 策略（授权项加时序规则）挂在阶段上或阶段组上，列表和怎么称呼它们在协议包的 plan.ts（planPolicies、planGrants）。
import {
  type GrantInfo,
  type Plan,
  type PlanConfirmInput,
  type PlanGrant,
  type PlanPolicy,
  type PlanWatchCategory,
  planGrants,
  planPolicies,
  type PolicyOwner,
  type WatchToolChoice,
} from "@ergou/protocol";
import {
  BOTTOM_LINES,
  builtinCategory,
  builtinDisposition,
  BUILTIN_WATCH_CATEGORIES,
  type CustomWatchCategory,
  customDisposition,
  DISPOSITION_INFO,
  type Disposition,
  findTool,
  type Grant,
  type GuardPlan,
  isBuiltinCategory,
  isStricter,
  strictest,
  type TemporalRule,
  type ToolRegistry,
  validateGrantChange,
  validateTemporalRules,
  type WatchCategorySettings,
} from "../guard/index.ts";
import { GUARD_DISPOSITION, WIRE_DISPOSITION } from "../guard-runtime/describe.ts";
import { normalizeCategoryMatch } from "../watch-categories/match.ts";

const DAY_MS = 86_400_000;

export interface PlanCheckContext {
  /** 这个任务的工具注册表（授权项、时序规则里的工具和参数照它查） */
  tools: ToolRegistry;
  /** 全局的关注类别设置（数据目录配置区） */
  settings: WatchCategorySettings;
}

/** 全局的一个关注类别：id、名字、任务里的处置（守卫的说法） */
export interface GlobalWatchCategory {
  id: string;
  title: string;
  task: Disposition;
}

/** 全局的关注类别：内置九类（任务里的处置按设置往严里调过）加用户自定义的 */
export function globalWatchCategories(settings: WatchCategorySettings): GlobalWatchCategory[] {
  return [
    ...BUILTIN_WATCH_CATEGORIES.map((c) => ({ id: c.id, title: c.title, task: builtinDisposition(c.id, "task", [settings]) })),
    ...(settings.custom ?? []).map((c) => ({ id: c.id, title: c.title, task: c.task })),
  ];
}

export type PlanCheck = { ok: true; plan: Plan } | { ok: false; problems: string[] };

/**
 * 提交计划时的检查；通过时给出补全了的计划：全局关注类别的名字由运行时补上，本任务新加的类别的规则规范化，
 * 用户的限制里的授权收窄落到授权项上
 */
export function checkPlan(plan: Plan, ctx: PlanCheckContext): PlanCheck {
  const problems = [...stageProblems(plan), ...policyProblems(plan, ctx.tools)];
  const categories = checkWatchCategories(plan.watchCategories, globalWatchCategories(ctx.settings), toolChoicesOf(ctx.tools));
  problems.push(...categories.problems);
  const limits = applyUserLimits(plan, ctx.tools);
  problems.push(...limits.problems);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, plan: { ...limits.plan, watchCategories: categories.normalized } };
}

/** 自定义类别的规则能写哪些工具：这个任务的工具注册表里登记的 */
function toolChoicesOf(tools: ToolRegistry): WatchToolChoice[] {
  return Object.values(tools).map((t) => ({ name: t.name, title: t.title }));
}

/**
 * 用户说过的限制（26 号票）：id 唯一；每条至少编译出一条时序规则或授权收窄（编译不了的写进假设栏）；规则过规则校验
 * （规则 id 和阶段、阶段组的规则一起在整份计划里唯一，见 policyProblems）；收窄只能收窄，依次落到授权项上
 */
function applyUserLimits(plan: Plan, tools: ToolRegistry): { plan: Plan; problems: string[] } {
  const problems: string[] = [];
  const ids = new Set<string>();
  let current = plan;
  for (const limit of plan.userLimits ?? []) {
    if (ids.has(limit.id)) problems.push(`限制 ${limit.id} 重复`);
    ids.add(limit.id);
    if (limit.temporalRules.length === 0 && limit.grantNarrowings.length === 0) {
      problems.push(`限制 ${limit.id}（「${limit.quote}」）没有编译出时序规则或授权收窄：编译不了的写进假设栏`);
    }
    for (const problem of validateTemporalRules(limit.temporalRules, { tools }).problems) problems.push(`限制 ${limit.id} 的时序规则：${problem}`);
    if (limit.grantNarrowings.length === 0) continue;
    const narrowed = narrowPlan(current, { narrowGrants: limit.grantNarrowings }, tools);
    if (narrowed.ok) current = narrowed.plan;
    else problems.push(...narrowed.problems.map((p) => `限制 ${limit.id}：${p}`));
  }
  return { plan: current, problems };
}

function stageProblems(plan: Plan): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const stage of plan.stages) {
    if (ids.has(stage.stageId)) problems.push(`阶段 ${stage.stageId} 重复`);
    ids.add(stage.stageId);
  }
  const groupIds = new Set<string>();
  for (const group of plan.stageGroups) {
    if (groupIds.has(group.groupId)) problems.push(`阶段组 ${group.groupId} 重复`);
    groupIds.add(group.groupId);
  }
  for (const stage of plan.stages) {
    for (const dep of stage.dependsOn) if (!ids.has(dep)) problems.push(`阶段 ${stage.stageId} 的前置阶段 ${dep} 不存在`);
    if (stage.groupId !== undefined && !groupIds.has(stage.groupId)) problems.push(`阶段 ${stage.stageId} 所属的阶段组 ${stage.groupId} 不存在`);
    if (stage.mode === "steps" && !stage.steps?.length) problems.push(`阶段 ${stage.stageId} 是定步的，要写 steps`);
    for (const a of stage.acceptance) if (a.method === "script" && !a.script) problems.push(`阶段 ${stage.stageId} 的验收标准「${a.criterion}」是脚本方式，要写 script`);
  }
  const cycle = dependencyCycle(plan);
  if (cycle) problems.push(`阶段的前置关系成了环：${cycle.join(" → ")}`);
  return problems;
}

/** 前置关系里的一个环（找不到是 undefined） */
function dependencyCycle(plan: Plan): string[] | undefined {
  const deps = new Map(plan.stages.map((s) => [s.stageId, s.dependsOn]));
  const done = new Set<string>();
  const visit = (id: string, path: string[]): string[] | undefined => {
    const at = path.indexOf(id);
    if (at >= 0) return [...path.slice(at), id];
    if (done.has(id)) return undefined;
    for (const dep of deps.get(id) ?? []) {
      const found = visit(dep, [...path, id]);
      if (found) return found;
    }
    done.add(id);
    return undefined;
  };
  for (const stage of plan.stages) {
    const found = visit(stage.stageId, []);
    if (found) return found;
  }
  return undefined;
}

/** 检查说明里怎么称呼一份策略的主人："阶段 s1" / "阶段组 g1" */
function ownerName(owner: PolicyOwner): string {
  return owner.kind === "stage" ? `阶段 ${owner.stageId}` : `阶段组 ${owner.groupId}`;
}

/** 每份策略：授权项和时序规则各自对不对；授权项 id、时序规则 id（连同用户的限制编译出的）在整份计划里唯一 */
function policyProblems(plan: Plan, tools: ToolRegistry): string[] {
  const problems: string[] = [];
  const grantIds = new Set<string>();
  const ruleIds = new Set<string>();
  const allRules = [...planPolicies(plan).flatMap((p) => p.policy.temporalRules), ...(plan.userLimits ?? []).flatMap((l) => l.temporalRules)];
  for (const rule of allRules) {
    if (ruleIds.has(rule.id)) problems.push(`时序规则 ${rule.id} 重复`);
    ruleIds.add(rule.id);
  }
  for (const { owner, policy } of planPolicies(plan)) {
    for (const grant of policy.grants) {
      if (grantIds.has(grant.id)) problems.push(`授权项 ${grant.id} 重复`);
      grantIds.add(grant.id);
      problems.push(...grantProblems(grant, tools));
    }
    for (const problem of validateTemporalRules(policy.temporalRules, { tools }).problems) problems.push(`${ownerName(owner)} 的时序规则：${problem}`);
  }
  return problems;
}

function grantProblems(grant: PlanGrant, tools: ToolRegistry): string[] {
  const tool = findTool(tools, grant.tool);
  if (!tool) return [`授权项 ${grant.id}：没有 ${grant.tool} 这个工具`];
  return Object.keys(grant.scope)
    .filter((param) => !Object.hasOwn(tool.args, param))
    .map((param) => `授权项 ${grant.id}：${grant.tool} 没有参数 ${param}`);
}

function dispositionLabel(d: Disposition): string {
  return `「${DISPOSITION_INFO[d].label}」`;
}

/** 本任务的关注类别：全局的一个不能少、处置只能更严、新加的要写确定的规则和处置；补上全局类别的名字、规范化新加的规则 */
function checkWatchCategories(
  categories: readonly PlanWatchCategory[],
  global: readonly GlobalWatchCategory[],
  tools: readonly WatchToolChoice[],
): { problems: string[]; normalized: PlanWatchCategory[] } {
  const problems: string[] = [];
  const byId = new Map(global.map((g) => [g.id, g]));
  const seen = new Set<string>();
  for (const c of categories) {
    if (seen.has(c.id)) problems.push(`关注类别 ${c.id} 重复`);
    seen.add(c.id);
    const g = byId.get(c.id);
    if (!g) {
      if (!c.match || Object.keys(c.match).length === 0 || c.disposition === undefined) {
        problems.push(`关注类别 ${c.id} 不是全局的：本任务新加的类别要写 match（确定的规则）和 disposition`);
      } else {
        problems.push(...normalizeCategoryMatch(c.match, tools).problems.map((p) => `关注类别 ${c.id}：${p}`));
      }
      continue;
    }
    const mine = c.disposition === undefined ? undefined : GUARD_DISPOSITION[c.disposition];
    if (mine !== undefined && isStricter(g.task, mine)) {
      problems.push(`关注类别「${g.title}」：本任务的处置${dispositionLabel(mine)}比全局的${dispositionLabel(g.task)}松，只能往严里调`);
    }
  }
  for (const g of global) {
    if (!seen.has(g.id)) problems.push(`本任务的关注类别少了全局的「${g.title}」（${g.id}）：全局的类别一个都不能少，只能在其上增加`);
  }
  const normalized = categories.map((c) => {
    if (byId.has(c.id)) return c.title === undefined ? { ...c, title: byId.get(c.id)!.title } : c;
    return c.match ? { ...c, match: normalizeCategoryMatch(c.match, tools).match } : c;
  });
  return { problems, normalized };
}

// ───────────────────────── 每项授权在守卫眼里的样子 ─────────────────────────

/**
 * 每项授权：工具的中文名、落在哪些关注类别、任务里这些类别最严的处置（协议的说法）。
 * 类别按工具在注册表里登记的类别标签，加上只按工具名匹配的自定义类别（全局的、本任务新加的）；
 * 处置按全局设置和本任务往严里调过的取最严，底线工具固定"交给我做"。
 * 只看得到工具本身：按参数才落进去的类别（比如路径越出项目目录）执行时守卫照样判
 */
export function grantInfoOf(plan: Plan, ctx: PlanCheckContext): Record<string, GrantInfo> {
  const effective = [ctx.settings, taskWatchSettings(plan.watchCategories, ctx.settings)];
  const custom = [...new Map(effective.flatMap((s) => s.custom ?? []).map((c) => [c.id, c])).values()];
  const info: Record<string, GrantInfo> = {};
  for (const { grant } of planGrants(plan)) {
    const tool = findTool(ctx.tools, grant.tool);
    const titles: string[] = [];
    const dispositions: Disposition[] = [];
    for (const id of tool?.categories ?? []) {
      titles.push(builtinCategory(id).title);
      dispositions.push(builtinDisposition(id, "task", effective));
    }
    for (const category of custom.filter((c) => c.match.tools?.includes(grant.tool))) {
      if (!titles.includes(category.title)) titles.push(category.title);
      dispositions.push(customDisposition(category, "task", effective));
    }
    for (const id of tool?.bottomLines ?? []) dispositions.push(BOTTOM_LINES[id].disposition);
    info[grant.id] = { toolTitle: tool?.title ?? grant.tool, categoryTitles: titles, disposition: WIRE_DISPOSITION[strictest(...dispositions)] };
  }
  return info;
}

// ───────────────────────── 勾掉、收窄授权项，改假设栏 ─────────────────────────

export type PlanNarrowing =
  | {
      ok: true;
      plan: Plan;
      removed: PlanGrant[];
      narrowed: string[];
      assumptions?: { before: string[]; after: string[] };
      /** 用户在卡上给这个任务加的关注类别（26 号票） */
      added?: PlanWatchCategory[];
    }
  | { ok: false; problems: string[] };

/**
 * 计划里的一项授权换成守卫的形状：挂在 stageId 上，授予时间 grantedAt，写了有效期（天）的算出到期时间
 * （不写是守卫的默认 7 天）。比较放宽、收窄时授予时间都给 0
 */
export function toGuardGrant(grant: PlanGrant, stageId: string, grantedAt: number, grantId = grant.id): Grant {
  return {
    grantId,
    tool: grant.tool,
    scope: grant.scope,
    ...(grant.maxUses === undefined ? {} : { maxUses: grant.maxUses }),
    stageId,
    grantedAt,
    ...(grant.validDays === undefined ? {} : { expiresAt: grantedAt + grant.validDays * DAY_MS }),
  };
}

/** 一份策略的主人在守卫的授权项里挂在哪儿（只为比较放宽、收窄：阶段组的挂在组 id 上） */
const ownerKey = (owner: PolicyOwner) => (owner.kind === "stage" ? owner.stageId : owner.groupId);

/**
 * 用户在计划卡上勾掉、收窄授权项、改假设栏、加本任务的关注类别后的计划；放宽了的（次数加多、对象范围多出值……）被拒。
 * 加的类别和设置页同一套确定规则，id 是"<categoryIdPrefix>-c<n>"（给计划 id，就只在这一版计划里唯一）
 */
export function narrowPlan(plan: Plan, input: PlanConfirmInput, tools: ToolRegistry, options: { categoryIdPrefix?: string } = {}): PlanNarrowing {
  const grants = planGrants(plan);
  const known = new Set(grants.map((g) => g.grant.id));
  const removedIds = input.removeGrants ?? [];
  const narrowings = input.narrowGrants ?? [];
  const unknown = [...removedIds, ...narrowings.map((n) => n.grantId)].filter((id) => !known.has(id));
  if (unknown.length > 0) return { ok: false, problems: [...new Set(unknown)].map((id) => `计划里没有授权项 ${id}`) };

  const narrowed: string[] = [];
  const replace = (grant: PlanGrant): PlanGrant => {
    const n = narrowings.find((x) => x.grantId === grant.id);
    if (!n) return grant;
    const next: PlanGrant = { ...grant, ...(n.maxUses === undefined ? {} : { maxUses: n.maxUses }), scope: n.scope ? { ...grant.scope, ...n.scope } : grant.scope };
    if (JSON.stringify(next) !== JSON.stringify(grant)) narrowed.push(grant.id);
    return next;
  };
  const keep = (policy: PlanPolicy): PlanPolicy => ({ ...policy, grants: policy.grants.filter((g) => !removedIds.includes(g.id)).map(replace) });
  const assumptions = input.assumptions?.map((a) => a.trim()).filter(Boolean);
  const edited = assumptions !== undefined && JSON.stringify(assumptions) !== JSON.stringify(plan.assumptions);
  const after: Plan = {
    ...plan,
    stages: plan.stages.map((s) => ({ ...s, policy: keep(s.policy) })),
    stageGroups: plan.stageGroups.map((g) => ({ ...g, policy: keep(g.policy) })),
    ...(edited ? { assumptions } : {}),
  };
  const check = validateGrantChange(
    grants.map(({ grant, owner }) => toGuardGrant(grant, ownerKey(owner), 0)),
    planGrants(after).map(({ grant, owner }) => toGuardGrant(grant, ownerKey(owner), 0)),
    tools,
  );
  const additions = addedCategories(plan, input.addWatchCategories ?? [], tools, options.categoryIdPrefix ?? "task");
  const problems = [...(check.ok ? [] : check.problems), ...additions.problems];
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    plan: additions.added.length > 0 ? { ...after, watchCategories: [...after.watchCategories, ...additions.added] } : after,
    removed: grants.filter(({ grant }) => removedIds.includes(grant.id)).map(({ grant }) => grant),
    narrowed: narrowed.filter((id) => !removedIds.includes(id)),
    ...(edited ? { assumptions: { before: plan.assumptions, after: assumptions } } : {}),
    ...(additions.added.length > 0 ? { added: additions.added } : {}),
  };
}

/** 卡上加的关注类别：规则过确定规则的检查并规范化，名字不能空，id 接着这一版计划里已有的往下排 */
function addedCategories(
  plan: Plan,
  additions: NonNullable<PlanConfirmInput["addWatchCategories"]>,
  tools: ToolRegistry,
  prefix: string,
): { added: PlanWatchCategory[]; problems: string[] } {
  const problems: string[] = [];
  const added: PlanWatchCategory[] = [];
  const taken = new Set(plan.watchCategories.map((c) => c.id));
  let n = 0;
  const nextId = () => {
    let id: string;
    do id = `${prefix}-c${++n}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  };
  for (const a of additions) {
    const title = a.title.trim();
    const checked = normalizeCategoryMatch(a.match, toolChoicesOf(tools));
    const own = [...(title === "" ? ["名字不能是空的"] : []), ...checked.problems];
    if (own.length > 0) {
      problems.push(`加的关注类别「${title}」：${own.join("；")}`);
      continue;
    }
    added.push({ id: nextId(), title, match: checked.match, disposition: a.disposition });
  }
  return { added, problems };
}

// ───────────────────────── 交给守卫 ─────────────────────────

/**
 * 确认后的计划交给守卫的样子（13 号票的控制器用）：
 * - 授权项挂到所属阶段上（toGuardGrant，授予时间是确认的时刻）；
 *   阶段组的策略里的授权项给组里每个阶段各一份（id 写成"授权项 id@阶段 id"），次数按阶段各算各的；
 * - 阶段和阶段组的时序规则照原样（05 号票的 stages / stageGroups 形状）；
 * - 本任务的关注类别里比全局多出来的部分写成一份设置：内置类别往严里调的、全局自定义类别往严里调的、本任务新加的
 */
export function toGuardPlan(plan: Plan, options: { confirmedAt: number; settings: WatchCategorySettings }): GuardPlan {
  const { confirmedAt } = options;
  const groups = new Map(plan.stageGroups.map((g) => [g.groupId, g]));
  const grants = plan.stages.flatMap((s) => [
    ...s.policy.grants.map((g) => toGuardGrant(g, s.stageId, confirmedAt)),
    ...(s.groupId === undefined ? [] : (groups.get(s.groupId)?.policy.grants ?? []).map((g) => toGuardGrant(g, s.stageId, confirmedAt, `${g.id}@${s.stageId}`))),
  ]);
  // 用户的限制编译出的规则在整个任务执行期间都检查：加到每个阶段上
  const limitRules = (plan.userLimits ?? []).flatMap((l) => l.temporalRules) as TemporalRule[];
  return {
    grants,
    stages: plan.stages.map((s) => ({
      stageId: s.stageId,
      ...(s.groupId === undefined ? {} : { groupId: s.groupId }),
      temporalRules: [...(s.policy.temporalRules as TemporalRule[]), ...limitRules],
    })),
    stageGroups: plan.stageGroups.map((g) => ({ groupId: g.groupId, temporalRules: g.policy.temporalRules as TemporalRule[] })),
    watchCategories: taskWatchSettings(plan.watchCategories, options.settings),
  };
}

/**
 * 本任务的关注类别里比全局多出来的部分，写成一份关注类别设置：
 * - 内置类别、全局自定义类别往严里调的：只记处置（builtin、customOverrides），规则和存废跟着全局设置走——
 *   全局改了规则就按新规则匹配，删了就不再命中（26 号票）；
 * - 本任务新加的类别（带规则）：只存在计划里，不受全局改动影响。
 * 全局里已经没有、也没带规则的 id（提交之后全局删掉了的自定义类别）只剩处置，没有可匹配的规则：不再命中
 */
function taskWatchSettings(categories: readonly PlanWatchCategory[], settings: WatchCategorySettings): WatchCategorySettings {
  const builtin: NonNullable<WatchCategorySettings["builtin"]> = {};
  const customOverrides: NonNullable<WatchCategorySettings["customOverrides"]> = {};
  const custom: CustomWatchCategory[] = [];
  for (const c of categories) {
    const d = c.disposition === undefined ? undefined : GUARD_DISPOSITION[c.disposition];
    if (d === undefined) continue;
    if (isBuiltinCategory(c.id)) builtin[c.id] = { task: d };
    else if (c.match && !(settings.custom ?? []).some((g) => g.id === c.id)) custom.push({ id: c.id, title: c.title ?? c.id, match: c.match, chat: d, task: d });
    else customOverrides[c.id] = { task: d };
  }
  return {
    ...(Object.keys(builtin).length > 0 ? { builtin } : {}),
    ...(Object.keys(customOverrides).length > 0 ? { customOverrides } : {}),
    ...(custom.length > 0 ? { custom } : {}),
  };
}
