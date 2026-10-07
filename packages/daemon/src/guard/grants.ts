// 授权项（规格第 9 节）：操作种类 + 对象范围 + 次数 + 所属阶段 + 有效期。
// 只对"计划里列了才做"那一档起作用；"先问我"一律当场问，授权项替它放行不了。
// 执行中授权只能收窄：validateGrantChange 校验一次修改，收窄通过，放宽被拒。
import { isWithin, resolveAgentPath } from "./paths.ts";
import { BUILTIN_TOOL_REGISTRY, type ToolRegistry } from "./tool-registry.ts";
import type { EffectRecord, Grant, GuardTask } from "./types.ts";

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
  /** 相对路径的基准 */
  cwd: string;
  homeDir: string;
}

export type GrantCheck = { grant: Grant } | { grant: undefined; reasons: string[] };

/** 找一条能放行这次调用的授权项；找不到时给出原因 */
export function findCoveringGrant(tool: string, args: Readonly<Record<string, unknown>>, ctx: GrantContext): GrantCheck {
  const sameTool = ctx.task.plan.grants.filter((g) => g.tool === tool);
  if (sameTool.length === 0) return { grant: undefined, reasons: ["计划里没有覆盖它的授权项"] };
  const reasons: string[] = [];
  for (const grant of sameTool) {
    const problems: string[] = [];
    if (grant.stageId !== ctx.task.currentStageId) problems.push(`不属于当前阶段（它属于 ${grant.stageId}，当前是 ${ctx.task.currentStageId}）`);
    if (ctx.now >= grantExpiresAt(grant)) problems.push(`已过期（${new Date(grantExpiresAt(grant)).toISOString()} 到期）`);
    const outOfScope = scopeProblems(grant, args, ctx);
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

/** 已经用掉的次数：本任务、授权项所属阶段、授予之后、同一工具、对象范围之内的实际生效的效果 */
function usesOf(grant: Grant, ctx: GrantContext): number {
  return ctx.effectLog.filter(
    (e) =>
      e.taskId === ctx.task.taskId &&
      e.stageId === grant.stageId &&
      e.tool === grant.tool &&
      e.at >= grant.grantedAt &&
      scopeProblems(grant, e.args, ctx).length === 0,
  ).length;
}

/** 对象范围：每个写了的参数，调用里的值（数组的每个值）都要落在允许的值里；路径类参数按目录匹配 */
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
      const ok = isPath ? pathCovered(v, allowed, ctx) : allowed.some((a) => sameValue(a, v));
      if (!ok) problems.push(`${param} 为 ${typeof v === "string" ? v : JSON.stringify(v)}，允许的是 ${allowed.join("、")}`);
    }
  }
  return problems;
}

function pathCovered(value: unknown, allowed: readonly unknown[], ctx: GrantContext): boolean {
  if (typeof value !== "string") return false;
  const resolved = resolveAgentPath(value, ctx.cwd, ctx.homeDir);
  if (resolved.kind !== "absolute") return false;
  return allowed.some((a) => typeof a === "string" && isWithin(resolved.path, a));
}

function isPathParam(tools: ToolRegistry, tool: string, param: string): boolean {
  const descriptor = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
  return descriptor?.args[param]?.kind === "path";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
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
    for (const [param, bAllowedRaw] of Object.entries(b.scope)) {
      if (!Object.hasOwn(a.scope, param)) {
        p(`去掉了对象范围里的 ${param}`);
        continue;
      }
      const bAllowed = toList(bAllowedRaw);
      const isPath = isPathParam(tools, b.tool, param);
      for (const v of toList(a.scope[param])) {
        const covered = isPath
          ? typeof v === "string" && bAllowed.some((x) => typeof x === "string" && isWithin(v, x))
          : bAllowed.some((x) => sameValue(x, v));
        if (!covered) p(`对象范围 ${param} 多了 ${String(v)}`);
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
