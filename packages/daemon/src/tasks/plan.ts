// 计划（规格第 8 节）在守护进程里的纯函数：
// - checkPlan：维护者提交时，查 schema 管不到的（schema 由 pi 按工具参数先校验，守护进程再按同一个 schema 校验一次）：
//   阶段和阶段组的引用、前置关系不成环、每份策略（授权项：id 唯一、工具登记过、对象范围的参数是这个工具的；
//   时序规则：validateTemporalRules，05 号票）、本任务的关注类别（全局的一个不能少、处置只能更严、新加的要写确定的规则）、
//   用户说过的限制（26 号票：编译出的规则过规则校验，授权收窄只能收窄、提交时就落到授权项上）；
// - grantInfoOf：每项授权在守卫眼里的样子（工具的中文名、落在哪些关注类别、任务里最严的处置），计划卡据此生成授权行和停点；
// - narrowPlan：用户在计划卡上勾掉或收窄授权项（validateGrantChange：只能收窄）、改假设栏、加本任务的关注类别（26 号票）；
// - planConfirmation：计划卡、计划变更卡（14 号票）上"确认"共用的一段：收窄、快照关注类别、重算授权行、plan_decided 的负载；
// - snapshotWatchCategories：确认计划时把本任务调严过的全局自定义类别连当时的规则一起快照进计划（26 号票）；
// - toGuardPlan：确认后的计划交给守卫的样子（GuardPlan：授权项挂到阶段上、时序规则照原样、限制编译出的规则加到每个阶段上、
//   本任务的关注类别写成 TaskWatchSettings：判定时和当前的全局设置取最严），13 号票用；14 号票起每项授权的授予时间、
//   到期时间可以单独给（GrantTime：计划变更之后原样留着的照旧、续期之后延长），守卫的授权项 id 对回计划里的用 planGrantIdOf；
// - checkRevisedPlan：计划变更和自行调整（14 号票）时对新计划的检查：阶段和策略照提交计划时查，
//   用户的限制里的授权收窄重新落到授权项上（收窄的授权项已经去掉的不管）。
// 策略（授权项加时序规则）挂在阶段上或阶段组上，列表和怎么称呼它们在协议包的 plan.ts（planPolicies、planGrants）。
import {
  DEFAULT_GRANT_VALID_DAYS,
  type GrantInfo,
  type Plan,
  type PlanConfirmInput,
  type PlanGrant,
  type PlanPolicy,
  type PlanTemporalRule,
  type PlanWatchCategory,
  planGrants,
  planPolicies,
  type PolicyOwner,
  type Task,
} from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import {
  BOTTOM_LINES,
  builtinCategory,
  builtinDisposition,
  BUILTIN_WATCH_CATEGORIES,
  DISPOSITION_INFO,
  type Disposition,
  findTool,
  type Grant,
  type GuardPlan,
  isBuiltinCategory,
  isStricter,
  strictest,
  type TaskWatchCategory,
  type TaskWatchSettings,
  type TemporalRule,
  type ToolRegistry,
  validateGrantChange,
  validateTemporalRules,
  type WatchCategorySettings,
} from "../guard/index.ts";
import { GUARD_DISPOSITION, WIRE_DISPOSITION } from "../guard-wire/dispositions.ts";
import { normalizeCategoryMatch } from "../watch-categories/match.ts";
import type { PlanDecidedPayload } from "./events.ts";
import { DAY_MS } from "./thresholds.ts";
import type { StoredPlan } from "./views.ts";

export interface PlanCheckContext {
  /** 这个任务的工具注册表（授权项、时序规则里的工具和参数照它查） */
  tools: ToolRegistry;
  /** 工具包里不在 skill 库里的 skill、没登记的 MCP（27 号票：一条一句；不给就不查） */
  toolkitProblems?: ToolkitProblems;
  /** 全局的关注类别设置（数据目录配置区） */
  settings: WatchCategorySettings;
}

/**
 * 本任务新加的关注类别的 id：<任务 id>-c<n>（t-1-c1、t-1-c2……），和全局自定义类别的 c-<n> 分开，不会撞上。
 * taken 里有的跳过（全局的 id、这一版计划里已有的）
 */
export function taskCategoryIds(taskId: string, taken: Iterable<string>): () => string {
  const used = new Set(taken);
  let n = 0;
  return () => {
    let id: string;
    do id = `${taskId}-c${++n}`;
    while (used.has(id));
    used.add(id);
    return id;
  };
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

/** 工具包里的 skill 要在 skill 库里、MCP 要登记过（27 号票，toolkit/ 给）：不合的一条一句 */
export type ToolkitProblems = (toolkit: Pick<Plan["toolkit"], "skills" | "mcp">) => string[];

/**
 * 提交计划时的检查；通过时给出补全了的计划：全局关注类别的名字由运行时补上，本任务新加的类别的规则规范化、
 * id 换成本任务的（taskCategoryIds），用户的限制里的授权收窄落到授权项上
 */
export function checkPlan(plan: Plan, ctx: PlanCheckContext & { taskId: string }): PlanCheck {
  const problems = [...stageProblems(plan), ...policyProblems(plan, ctx.tools), ...(ctx.toolkitProblems?.(plan.toolkit) ?? [])];
  const categories = checkWatchCategories(plan.watchCategories, globalWatchCategories(ctx.settings), ctx.taskId);
  problems.push(...categories.problems);
  const limits = applyUserLimits(plan, ctx.tools);
  problems.push(...limits.problems);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, plan: { ...limits.plan, watchCategories: categories.normalized } };
}

/**
 * 计划变更和自行调整时对新计划的检查（14 号票）：阶段（引用、前置不成环、定步有步骤、脚本有命令）和每份策略（授权项、时序规则）照提交计划时查；
 * 本任务的关注类别、用户的限制沿用当前计划（维护者改不了），限制里的授权收窄重新落到授权项上——收窄的授权项已经去掉了的跳过
 */
export function checkRevisedPlan(plan: Plan, tools: ToolRegistry, toolkitProblems?: ToolkitProblems): PlanCheck {
  const problems = [...stageProblems(plan), ...policyProblems(plan, tools), ...(toolkitProblems?.(plan.toolkit) ?? [])];
  if (problems.length > 0) return { ok: false, problems };
  const ids = new Set(planGrants(plan).map((g) => g.grant.id));
  const narrowings = (plan.userLimits ?? []).flatMap((l) => l.grantNarrowings).filter((n) => ids.has(n.grantId));
  if (narrowings.length === 0) return { ok: true, plan };
  const narrowed = narrowPlan(plan, { narrowGrants: narrowings }, tools);
  return narrowed.ok ? { ok: true, plan: narrowed.plan } : { ok: false, problems: narrowed.grantProblems };
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
    else problems.push(...narrowed.grantProblems.map((p) => `限制 ${limit.id}：${p}`));
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
    for (const a of stage.acceptance) {
      const where = `阶段 ${stage.stageId} 的验收标准「${a.criterion}」`;
      if (a.method === "script" && !a.script) problems.push(`${where}是脚本方式，要写 script`);
      if (a.expectOutput && a.method !== "script") problems.push(`${where}不是脚本方式，不能写期望的输出（expectOutput）`);
      if (a.expectOutput?.matches !== undefined && !isRegExp(a.expectOutput.matches)) problems.push(`${where}的期望输出 matches 不是合法的正则表达式`);
    }
  }
  const cycle = dependencyCycle(plan);
  if (cycle) problems.push(`阶段的前置关系成了环：${cycle.join(" → ")}`);
  return problems;
}

/** 期望输出的 matches 能不能当正则表达式用 */
function isRegExp(pattern: string): boolean {
  try {
    return new RegExp(pattern) instanceof RegExp;
  } catch {
    return false;
  }
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

/**
 * 本任务的关注类别：全局的一个不能少、处置只能更严、新加的要写名字、确定的规则和处置；
 * 补上全局类别的名字，新加的规则规范化、id 换成本任务的（<任务 id>-c<n>）
 */
function checkWatchCategories(
  categories: readonly PlanWatchCategory[],
  global: readonly GlobalWatchCategory[],
  taskId: string,
): { problems: string[]; normalized: PlanWatchCategory[] } {
  const problems: string[] = [];
  const byId = new Map(global.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const nextId = taskCategoryIds(taskId, byId.keys());
  const normalized: PlanWatchCategory[] = [];
  for (const c of categories) {
    if (seen.has(c.id)) problems.push(`关注类别 ${c.id} 重复`);
    seen.add(c.id);
    const g = byId.get(c.id);
    if (!g) {
      if (!c.match || c.disposition === undefined) {
        problems.push(`关注类别 ${c.id} 不是全局的：本任务新加的类别要写 title、match（确定的规则）和 disposition`);
        continue;
      }
      const checked = normalizeCategoryMatch({ title: c.title ?? "", match: c.match });
      problems.push(...checked.problems.map((p) => `关注类别 ${c.id}：${p}`));
      normalized.push({ id: nextId(), title: checked.title, match: checked.match, disposition: c.disposition });
      continue;
    }
    const mine = c.disposition === undefined ? undefined : GUARD_DISPOSITION[c.disposition];
    if (mine !== undefined && isStricter(g.task, mine)) {
      problems.push(`关注类别「${g.title}」：本任务的处置${dispositionLabel(mine)}比全局的${dispositionLabel(g.task)}松，只能往严里调`);
    }
    // 全局的类别：名字和规则以全局设置为准（调严了的，规则在确认时快照，见 snapshotWatchCategories）；只留比全局严的处置
    normalized.push({ id: c.id, title: g.title, ...(mine !== undefined && isStricter(mine, g.task) ? { disposition: c.disposition } : {}) });
  }
  for (const g of global) {
    if (!seen.has(g.id)) problems.push(`本任务的关注类别少了全局的「${g.title}」（${g.id}）：全局的类别一个都不能少，只能在其上增加`);
  }
  return { problems, normalized };
}

// ───────────────────────── 用户的原话 ─────────────────────────

/** 比较原话时的写法：去掉首尾空白和引号，连续的空白算一个空格 */
function quoteForm(text: string): string {
  return text
    .trim()
    .replace(/^[「『“"']+|[」』”"']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 用户的限制里核对得上原话的（限制 id）：quote 原样出现在 sources 的某一段里（用户自己的话：任务书的约束、
 * 发起任务时写的话、用户在这个任务的会话里的消息）。对不上的，计划卡上显示成"维护者转述"（26 号票）
 */
export function verifiedQuotes(limits: readonly { id: string; quote: string }[], sources: readonly string[]): string[] {
  const texts = sources.map((t) => t.replace(/\s+/g, " "));
  return limits.filter((l) => {
    const quote = quoteForm(l.quote);
    return quote !== "" && texts.some((t) => t.includes(quote));
  }).map((l) => l.id);
}

// ───────────────────────── 每项授权在守卫眼里的样子 ─────────────────────────

/**
 * 每项授权：工具的中文名、落在哪些关注类别、任务里这些类别最严的处置（协议的说法）。
 * 类别按工具在注册表里登记的类别标签，加上只按工具名匹配的自定义类别（全局的、本任务的）；
 * 处置按全局设置和本任务的设置（按现在的全局设置快照，snapshotWatchCategories）取最严，底线工具固定"交给我做"。
 * 只看得到工具本身：按参数才落进去的类别（比如路径越出项目目录）执行时守卫照样判
 */
export function grantInfoOf(plan: Plan, ctx: PlanCheckContext): Record<string, GrantInfo> {
  const own = taskWatchSettings(snapshotWatchCategories(plan, ctx.settings).watchCategories);
  const custom = [
    ...(ctx.settings.custom ?? []).map((c) => ({ title: c.title, match: c.match, disposition: c.task })),
    ...(own.custom ?? []),
  ];
  const info: Record<string, GrantInfo> = {};
  for (const { grant } of planGrants(plan)) {
    const tool = findTool(ctx.tools, grant.tool);
    const titles: string[] = [];
    const dispositions: Disposition[] = [];
    for (const id of tool?.categories ?? []) {
      titles.push(builtinCategory(id).title);
      dispositions.push(builtinDisposition(id, "task", [ctx.settings], own));
    }
    for (const category of custom.filter((c) => c.match.tools?.includes(grant.tool))) {
      if (!titles.includes(category.title)) titles.push(category.title);
      dispositions.push(category.disposition);
    }
    for (const id of tool?.bottomLines ?? []) dispositions.push(BOTTOM_LINES[id].disposition);
    info[grant.id] = { toolTitle: tool?.title ?? grant.tool, categoryTitles: titles, disposition: WIRE_DISPOSITION[strictest(...dispositions)] };
  }
  return info;
}

/** 现取全局关注类别设置；文件坏了读不出来时拒绝这次请求（写明原因） */
export function readWatchSettings(read: () => WatchCategorySettings): WatchCategorySettings {
  try {
    return read();
  } catch (err) {
    throw new RequestRejected("internal", `读不了关注类别设置：${err instanceof Error ? err.message : String(err)}`);
  }
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
  /** 授权项的问题（勾掉、收窄得不对：放宽了、没有这一项）和加的关注类别的问题分开给 */
  | { ok: false; grantProblems: string[]; categoryProblems: string[] };

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
    ...(grant.command === undefined ? {} : { command: grant.command }),
    ...(grant.exactArgs ? { exactArgs: true as const } : {}),
    ...(grant.realScope === undefined ? {} : { realScope: grant.realScope }),
    stageId,
    grantedAt,
    ...(grant.validDays === undefined ? {} : { expiresAt: grantedAt + grant.validDays * DAY_MS }),
  };
}

/** 一份策略的主人在守卫的授权项里挂在哪儿（只为比较放宽、收窄：阶段组的挂在组 id 上） */
const ownerKey = (owner: PolicyOwner) => (owner.kind === "stage" ? owner.stageId : owner.groupId);

/**
 * 用户在计划卡上勾掉、收窄授权项、改假设栏、加本任务的关注类别后的计划；放宽了的（次数加多、对象范围多出值……）被拒。
 * 加的类别和设置页同一套名字和确定规则的检查，id 是本任务的（taskCategoryIds，给任务 id；不给时用 "task"）
 */
export function narrowPlan(plan: Plan, input: PlanConfirmInput, tools: ToolRegistry, options: { taskId?: string } = {}): PlanNarrowing {
  const grants = planGrants(plan);
  const known = new Set(grants.map((g) => g.grant.id));
  const removedIds = input.removeGrants ?? [];
  const narrowings = input.narrowGrants ?? [];
  const additions = addedCategories(plan, input.addWatchCategories ?? [], options.taskId ?? "task");
  const unknown = [...removedIds, ...narrowings.map((n) => n.grantId)].filter((id) => !known.has(id));
  if (unknown.length > 0) return { ok: false, grantProblems: [...new Set(unknown)].map((id) => `计划里没有授权项 ${id}`), categoryProblems: additions.problems };

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
  const widened = check.ok ? [] : check.problems;
  if (widened.length > 0 || additions.problems.length > 0) return { ok: false, grantProblems: widened, categoryProblems: additions.problems };
  return {
    ok: true,
    plan: additions.added.length > 0 ? { ...after, watchCategories: [...after.watchCategories, ...additions.added] } : after,
    removed: grants.filter(({ grant }) => removedIds.includes(grant.id)).map(({ grant }) => grant),
    narrowed: narrowed.filter((id) => !removedIds.includes(id)),
    ...(edited ? { assumptions: { before: plan.assumptions, after: assumptions } } : {}),
    ...(additions.added.length > 0 ? { added: additions.added } : {}),
  };
}

/** 卡上"确认"之后（计划卡、计划变更卡共用）：确认的计划、勾掉收窄的结果、授权行、plan_decided 的负载、处理结果的一句话 */
export interface PlanConfirmation {
  /** 勾掉、收窄、加类别之后，调严过的全局自定义类别快照进去的计划 */
  plan: Plan;
  narrowing: Extract<PlanNarrowing, { ok: true }>;
  grantInfo: Record<string, GrantInfo>;
  /** plan_decided（确认）的负载；计划变更的由调用方再补上 change、grantTimes */
  decided: PlanDecidedPayload;
  /** "勾掉 1 项授权，收窄 1 项"（什么都没动是 undefined） */
  note?: string;
}

/**
 * 76 号票之前交的计划里可能还写着定时作业（scheduledJobs，协议的 Plan 里已经没有这一栏）：确认时从计划里拿掉，确认后的计划、
 * 计划卡的负载才合现在的 schema。里面的作业由触发底座照迁移的办法建成定时触发的普通任务（scheduled-jobs/legacy-plan.ts）
 */
export function withoutLegacyJobs(plan: Plan): Plan {
  if (!Object.hasOwn(plan, "scheduledJobs")) return plan;
  const { scheduledJobs: _legacy, ...rest } = plan as Plan & { scheduledJobs?: unknown };
  return rest;
}

/**
 * 卡上的"确认"（计划卡 12 号票、计划变更卡 14 号票共用）：勾掉、收窄授权项、改假设栏、加本任务的关注类别（id 是本任务的），
 * 不合的抛 RequestRejected；本任务调严过的全局自定义类别连现在的规则一起快照进确认的计划（全局后来调松、删掉，已确认的任务
 * 仍按确认时的设置检查）；加了类别可能让授权项的处置变严（落在"先问我"里就不算授权），授权行跟着重算
 */
export function planConfirmation(input: {
  task: Task;
  stored: StoredPlan;
  choice: PlanConfirmInput;
  /** 卡上原来的授权行（没加类别时照用） */
  grantInfo: Readonly<Record<string, GrantInfo>>;
  tools: ToolRegistry;
  settings: WatchCategorySettings;
  time: string;
}): PlanConfirmation {
  const { task, stored, tools, settings } = input;
  const narrowing = narrowPlan(stored.plan, input.choice, tools, { taskId: task.id });
  if (!narrowing.ok) {
    const widened = narrowing.grantProblems;
    throw new RequestRejected("bad_params", [...(widened.length > 0 ? [`授权项只能勾掉或收窄：${widened.join("；")}`] : []), ...narrowing.categoryProblems].join("；"));
  }
  const added = narrowing.added ?? [];
  const plan = snapshotWatchCategories(narrowing.plan, settings);
  const grantInfo = added.length > 0 ? grantInfoOf(plan, { tools, settings }) : { ...input.grantInfo };
  const decided: PlanDecidedPayload = {
    taskId: task.id,
    taskTitle: task.title,
    planId: stored.planId,
    revision: stored.revision,
    cardId: stored.cardId,
    decision: "confirmed",
    plan,
    removedGrants: narrowing.removed,
    narrowedGrants: narrowing.narrowed,
    grantInfo,
    ...(narrowing.assumptions ? { assumptions: narrowing.assumptions } : {}),
    ...(added.length > 0 ? { addedCategories: added } : {}),
    by: "user",
    time: input.time,
  };
  const bits = [
    narrowing.removed.length > 0 ? `勾掉 ${narrowing.removed.length} 项授权` : "",
    narrowing.narrowed.length > 0 ? `收窄 ${narrowing.narrowed.length} 项` : "",
    narrowing.assumptions ? "改了假设栏" : "",
    added.length > 0 ? `加了 ${added.length} 个关注类别` : "",
  ].filter(Boolean);
  return { plan, narrowing, grantInfo, decided, ...(bits.length > 0 ? { note: bits.join("，") } : {}) };
}

/** 卡上加的关注类别：名字和规则过同一道检查并规范化，id 接着这一版计划里已有的往下排 */
function addedCategories(plan: Plan, additions: NonNullable<PlanConfirmInput["addWatchCategories"]>, taskId: string): { added: PlanWatchCategory[]; problems: string[] } {
  const problems: string[] = [];
  const added: PlanWatchCategory[] = [];
  const nextId = taskCategoryIds(taskId, plan.watchCategories.map((c) => c.id));
  for (const a of additions) {
    const checked = normalizeCategoryMatch(a);
    if (checked.problems.length > 0) {
      problems.push(`加的关注类别「${checked.title}」：${checked.problems.join("；")}`);
      continue;
    }
    added.push({ id: nextId(), title: checked.title, match: checked.match, disposition: a.disposition });
  }
  return { added, problems };
}

/**
 * 确认计划时的快照（26 号票）：本任务调严过的全局自定义类别（处置比现在的全局严），连同现在的名字和规则一起写进计划。
 * 这样全局后来调松、改规则或删掉它，已确认的任务仍按确认时的设置检查；全局调严照样生效（判定时和全局设置取最严）。
 * 没调严的全局类别不快照，跟着全局走；内置类别的规则在代码里，处置本来就在计划里；本任务新加的类别本来就带规则
 */
export function snapshotWatchCategories(plan: Plan, settings: WatchCategorySettings): Plan {
  const global = new Map((settings.custom ?? []).map((c) => [c.id, c]));
  const watchCategories = plan.watchCategories.map((c) => {
    const g = global.get(c.id);
    if (!g || c.disposition === undefined || !isStricter(GUARD_DISPOSITION[c.disposition], g.task)) return c;
    return { ...c, title: g.title, match: g.match };
  });
  return { ...plan, watchCategories };
}

// ───────────────────────── 交给守卫 ─────────────────────────

/** 守卫眼里一项授权的授予时间、到期时间（毫秒） */
export interface GrantTime {
  grantedAt: number;
  expiresAt: number;
}

/** 守卫的授权项 id 对回计划里的授权项 id：阶段组的授权项在守卫里写成"授权项 id@阶段 id"（组里每个阶段各一份） */
export const planGrantIdOf = (guardGrantId: string): string => guardGrantId.split("@")[0]!;

/** 一项授权的有效期（毫秒）：写了天数按天数，没写按默认 7 天；没有这一项（已经去掉了）也按默认 */
export const grantValidityMs = (grant: PlanGrant | undefined): number => (grant?.validDays ?? DEFAULT_GRANT_VALID_DAYS) * DAY_MS;

/**
 * 确认后的计划交给守卫的样子（13 号票的控制器用）：
 * - 授权项挂到所属阶段上（toGuardGrant，授予时间是确认的时刻）；
 *   阶段组的策略里的授权项给组里每个阶段各一份（id 写成"授权项 id@阶段 id"），次数按阶段各算各的；
 * - 阶段和阶段组的时序规则照原样（05 号票的 stages / stageGroups 形状），用户的限制编译出的规则加到每个阶段上；
 * - 本任务的关注类别写成 TaskWatchSettings（确认时已经快照好，见 snapshotWatchCategories）：
 *   判定时和当前的全局设置取最严，所以不用全局设置，也不必跟着全局设置重算
 */
export function toGuardPlan(plan: Plan, options: { confirmedAt: number; grantTimes?: Readonly<Record<string, GrantTime>> }): GuardPlan {
  const { confirmedAt } = options;
  const groups = new Map(plan.stageGroups.map((g) => [g.groupId, g]));
  // 每项授权单独记了授予时间、到期时间的（14 号票：计划变更、续期之后）用记下的
  const timed = (g: Grant): Grant => {
    const t = options.grantTimes?.[g.grantId];
    return t ? { ...g, grantedAt: t.grantedAt, expiresAt: t.expiresAt } : g;
  };
  const grants = plan.stages.flatMap((s) => [
    ...s.policy.grants.map((g) => timed(toGuardGrant(g, s.stageId, confirmedAt))),
    ...(s.groupId === undefined ? [] : (groups.get(s.groupId)?.policy.grants ?? []).map((g) => timed(toGuardGrant(g, s.stageId, confirmedAt, `${g.id}@${s.stageId}`)))),
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
    watchCategories: taskWatchSettings(plan.watchCategories),
  };
}

/** 定时作业的一次运行在守卫眼里只有一个"阶段"：作业每次运行的授权项、时序规则都挂在它上面（19 号票） */
export const JOB_RUN_STAGE = "run";

/**
 * 定时作业每次运行的授权交给守卫的样子（19 号票，规格第 13 节"定时作业的授权"）：
 * - 授权项挂在 JOB_RUN_STAGE 上，授予时间是作业登记的时刻，作业在就一直有效（不按 7 天、不续期）；次数按每次运行算
 *   （守卫按这一次运行的会话段数效果，见 GuardTask.segmentScoped）；
 * - 时序规则：作业自己的，加上计划里用户的限制编译出的（登记时已经合在一起）；
 * - 本任务的关注类别（确认计划时快照好的）照 toGuardPlan 一样写成 TaskWatchSettings。
 * 作业暂停、取消时调用方不给授权项（收回）
 */
export function toGuardJobPlan(input: { grants: readonly PlanGrant[]; temporalRules: readonly PlanTemporalRule[]; watchCategories: readonly PlanWatchCategory[]; grantedAt: number }): GuardPlan {
  return {
    grants: input.grants.map((g) => ({ ...toGuardGrant({ ...g, validDays: undefined }, JOB_RUN_STAGE, input.grantedAt), expiresAt: Number.POSITIVE_INFINITY })),
    stages: [{ stageId: JOB_RUN_STAGE, temporalRules: [...input.temporalRules] as TemporalRule[] }],
    watchCategories: taskWatchSettings(input.watchCategories),
  };
}

/**
 * 本任务的关注类别写成守卫的 TaskWatchSettings：内置类别写了处置的记处置；带规则和处置的自定义类别（本任务新加的、
 * 确认时快照下来的全局类别）连规则一起；没带规则的全局自定义类别（没调严）不写，跟着全局走
 */
function taskWatchSettings(categories: readonly PlanWatchCategory[]): TaskWatchSettings {
  const builtin: NonNullable<TaskWatchSettings["builtin"]> = {};
  const custom: TaskWatchCategory[] = [];
  for (const c of categories) {
    if (c.disposition === undefined) continue;
    const disposition = GUARD_DISPOSITION[c.disposition];
    if (isBuiltinCategory(c.id)) builtin[c.id] = disposition;
    else if (c.match) custom.push({ id: c.id, title: c.title ?? c.id, match: c.match, disposition });
  }
  return { ...(Object.keys(builtin).length > 0 ? { builtin } : {}), ...(custom.length > 0 ? { custom } : {}) };
}
