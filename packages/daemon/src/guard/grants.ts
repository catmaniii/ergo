// 授权项（规格第 9 节）：操作种类 + 对象范围 + 次数 + 所属阶段 + 有效期。
// 只对"计划里列了才做"那一档起作用；"先问我"一律当场问，授权项替它放行不了。
// 授权项不跨类别放行：一次调用命中的每个关注类别都要各自被授权项覆盖——操作种类（工具）要对得上，
// 对象范围要管到让这个类别命中的那些参数（比如因为仓库路径在项目外而命中的"越出项目目录"，授权项的对象范围里得有仓库路径）。
// 执行中授权只能收窄：validateGrantChange 校验一次修改，收窄通过，放宽被拒。
import { isWithin, resolveAgentPath, type ShellEnv } from "./paths.ts";
import { BUILTIN_TOOL_REGISTRY, findTool, type ToolRegistry } from "./tool-registry.ts";
import type { EffectRecord, Grant, GuardPlan, GuardTask } from "./types.ts";

/** 授权项默认有效期：7 天 */
export const DEFAULT_GRANT_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

export function grantExpiresAt(grant: Grant): number {
  return grant.expiresAt ?? grant.grantedAt + DEFAULT_GRANT_VALIDITY_MS;
}

export interface GrantContext {
  task: GuardTask;
  effectLog: readonly EffectRecord[];
  now: number;
  tools: ToolRegistry;
  /** 解析调用里的相对路径 */
  env: ShellEnv;
}

export type GrantCheck = { grant: Grant } | { grant: undefined; reasons: string[] };

/**
 * 找一条能放行这次调用的授权项；找不到时给出原因。
 * objectArgs：让这个类别命中的参数，授权项的对象范围必须管到它们（不能用一条只管远端的授权项放行项目外的仓库路径）。
 */
export function findCoveringGrant(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  objectArgs: readonly string[],
  ctx: GrantContext,
): GrantCheck {
  const sameTool = ctx.task.plan.grants.filter((g) => g.tool === tool);
  if (sameTool.length === 0) return { grant: undefined, reasons: ["计划里没有覆盖它的授权项"] };
  const reasons: string[] = [];
  for (const grant of sameTool) {
    const problems: string[] = [];
    if (grant.stageId !== ctx.task.currentStageId) problems.push(`不属于当前阶段（它属于 ${grant.stageId}，当前是 ${ctx.task.currentStageId}）`);
    if (ctx.now >= grantExpiresAt(grant)) problems.push(`已过期（${new Date(grantExpiresAt(grant)).toISOString()} 到期）`);
    const outOfScope = scopeProblems(grant, args, ctx);
    const unscoped = objectArgs.filter((a) => !Object.hasOwn(grant.scope, a));
    if (unscoped.length > 0) outOfScope.push(`对象范围没管到 ${unscoped.join("、")}`);
    if (outOfScope.length > 0) problems.push(`超出对象范围（${outOfScope.join("；")}）`);
    if (grant.maxUses !== undefined) {
      const used = usesOf(grant, ctx);
      if (used >= grant.maxUses) problems.push(`次数已用完（${used}/${grant.maxUses}）`);
    }
    if (problems.length === 0) return { grant };
    reasons.push(`授权项 ${grant.grantId} ${problems.join("、")}`);
  }
  return { grant: undefined, reasons };
}

/**
 * 计划对这个关注类别有没有授权项（14 号票，"超出授权"和"没预料到的类别"的分界）：计划里（不论哪个阶段）有一条授权项，
 * 它的操作种类就是这次调用的工具（这次是超出了它的对象范围、次数或有效期），或者它的工具登记的类别标签里有这个类别，
 * 或者这个类别是按工具名匹配到它的自定义类别（customTools 给出这个自定义类别规则里的工具）。都没有就是计划完全没涉及
 */
export function planConcernsCategory(plan: GuardPlan, categoryId: string, callTool: string, tools: ToolRegistry, customTools?: readonly string[]): boolean {
  return plan.grants.some((g) => g.tool === callTool || (findTool(tools, g.tool)?.categories as readonly string[] | undefined)?.includes(categoryId) === true || customTools?.includes(g.tool) === true);
}

/**
 * 已经用掉的次数：本任务、授权项所属阶段、授予之后、同一工具、对象范围之内的实际生效的效果。
 * 带着授权的会话段（定时作业的一次运行，19 号票）：效果日志已经只有这一段的，次数按这一段（每次运行）算
 */
function usesOf(grant: Grant, ctx: GrantContext): number {
  const mine = (e: EffectRecord) => (ctx.task.segmentScoped ? e.taskId === null : e.taskId === ctx.task.taskId && e.stageId === grant.stageId);
  return ctx.effectLog.filter(
    (e) =>
      mine(e) &&
      e.tool === grant.tool &&
      e.at >= grant.grantedAt &&
      scopeProblems(grant, e.args, ctx).length === 0,
  ).length;
}

/** 对象范围：每个写了的参数，调用里的值（数组的每个值）都要落在允许的值里 */
function scopeProblems(grant: Grant, args: Readonly<Record<string, unknown>>, ctx: GrantContext): string[] {
  const problems: string[] = [];
  for (const [param, allowedRaw] of Object.entries(grant.scope)) {
    const allowed = toList(allowedRaw);
    const value = args[param];
    if (value === undefined || value === null) {
      problems.push(`调用里没有 ${param}`);
      continue;
    }
    const isPath = isPathParam(ctx.tools, grant.tool, param);
    for (const v of toList(value)) {
      const target = isPath ? absolutePathOf(v, ctx.env) : v;
      if (!valueCovered(target, allowed, isPath)) {
        problems.push(`${param} 为 ${typeof v === "string" ? v : JSON.stringify(v)}，允许的是 ${allowed.join("、")}`);
      }
    }
  }
  return problems;
}

/** 一个值落不落在允许的值里：路径类参数按"在这个目录之内（或就是它）"，其余全等 */
function valueCovered(value: unknown, allowed: readonly unknown[], isPath: boolean): boolean {
  if (isPath) return typeof value === "string" && allowed.some((a) => typeof a === "string" && isWithin(value, a));
  return allowed.some((a) => (typeof a === "string" && typeof value === "string" ? a === value : JSON.stringify(a) === JSON.stringify(value)));
}

function absolutePathOf(value: unknown, env: ShellEnv): string | undefined {
  if (typeof value !== "string") return undefined;
  const resolved = resolveAgentPath(value, env);
  return resolved.kind === "absolute" ? resolved.path : undefined;
}

function isPathParam(tools: ToolRegistry, tool: string, param: string): boolean {
  return findTool(tools, tool)?.args[param]?.kind === "path";
}

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

// ───────────────────────── 授权项的修改 ─────────────────────────

export interface GrantChangeResult {
  ok: boolean;
  /** 每一处放宽，写明是哪条授权项 */
  problems: string[];
}

/**
 * 校验对授权项的一次修改（运行中授权只能收窄）：删掉授权项、缩小对象范围、减少次数、提前到期都算收窄；
 * 新加授权项、换工具或阶段、去掉或放大对象范围、加次数、去掉次数上限、延后到期、把授予时间往后挪（等于把次数清零）都算放宽。
 */
export function validateGrantChange(before: readonly Grant[], after: readonly Grant[], tools: ToolRegistry = BUILTIN_TOOL_REGISTRY): GrantChangeResult {
  const problems: string[] = [];
  for (const a of after) {
    const b = before.find((g) => g.grantId === a.grantId);
    if (!b) {
      problems.push(`新加了授权项 ${a.grantId}：执行中只能收窄，要放宽得回来问用户`);
      continue;
    }
    const p = (msg: string) => problems.push(`授权项 ${a.grantId}：${msg}`);
    if (a.tool !== b.tool) p(`操作种类从 ${b.tool} 改成了 ${a.tool}`);
    if (a.stageId !== b.stageId) p(`所属阶段从 ${b.stageId} 改成了 ${a.stageId}`);
    for (const [param, bAllowed] of Object.entries(b.scope)) {
      if (!Object.hasOwn(a.scope, param)) {
        p(`去掉了对象范围里的 ${param}`);
        continue;
      }
      const isPath = isPathParam(tools, b.tool, param);
      for (const v of toList(a.scope[param])) {
        if (!valueCovered(v, toList(bAllowed), isPath)) p(`对象范围 ${param} 多了 ${String(v)}`);
      }
    }
    if (b.maxUses !== undefined && (a.maxUses === undefined || a.maxUses > b.maxUses)) {
      p(`次数从 ${b.maxUses} 改成了 ${a.maxUses ?? "不限"}`);
    }
    if (grantExpiresAt(a) > grantExpiresAt(b)) p("到期时间往后延了");
    if (a.grantedAt > b.grantedAt) p("授予时间往后挪了（之前用掉的次数不再计数）");
  }
  return { ok: problems.length === 0, problems };
}
