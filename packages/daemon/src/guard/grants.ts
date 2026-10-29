// 授权项（规格第 9 节）：操作种类 + 对象范围 + 次数 + 所属阶段 + 有效期。
// 只对"计划里列了才做"那一档起作用；"先问我"一律当场问，授权项替它放行不了。
// 授权项不跨类别放行：一次调用命中的每个关注类别都要各自被授权项覆盖——操作种类（工具）要对得上，
// 对象范围要管到让这个类别命中的那些参数（比如因为仓库路径在项目外而命中的"越出项目目录"，授权项的对象范围里得有仓库路径）。
// 执行中授权只能收窄：validateGrantChange 校验一次修改，收窄通过，放宽被拒。
import { t } from "@ergo/protocol";
import { isDigested, scopeValueText, sha256Of } from "./content-digest.ts";
import { comparable, isWithin, resolveAgentPath, type ShellEnv } from "./paths.ts";
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
  /** 这次调用是从哪条通用 bash 命令拆出来的（模型直接调用的工具没有）：限定了命令的授权项（Grant.command）按它比 */
  shellCommand?: string;
  /** 这次调用是模型直接调用的工具（tool），还是从通用 bash 拆出来的（shell）：只认写了的参数的授权项（Grant.exactArgs）只放行直接调用 */
  origin?: "tool" | "shell";
  /** 一个绝对路径的真实路径（判定前现取的环境事实）：写了 realScope 的授权项按它比；取不到是 undefined */
  realPathOf?: (absolutePath: string) => string | undefined;
}

/**
 * 命令比较的口径（判定、收窄校验、流程推授权项合并时都用它）：只去掉首尾空白。中间的空白照原样比——
 * 引号里的空白是参数的一部分（`echo "a  b"` 和 `echo "a b"` 不是同一条命令）
 */
export const commandKey = (command: string): string => command.trim();

/** 调用里这个参数算不算给了值：undefined、null、空数组算没给 */
const hasValue = (value: unknown) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/** 几个值之间的分隔（中文是"、"） */
const list = () => t("pages.common.listSep");

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
  // 原因写进守卫的说明（按判定时的语言，173 号票）
  if (sameTool.length === 0) return { grant: undefined, reasons: [t("guard.grants.noGrant")] };
  const reasons: string[] = [];
  for (const grant of sameTool) {
    const problems: string[] = [];
    if (grant.stageId !== ctx.task.currentStageId) problems.push(t("guard.grants.notThisStage", { stage: grant.stageId, current: ctx.task.currentStageId }));
    if (grant.command !== undefined && (ctx.shellCommand === undefined || commandKey(grant.command) !== commandKey(ctx.shellCommand))) {
      problems.push(t("guard.grants.onlyCommand", { command: grant.command }));
    }
    // 拆 bash 时认不出的旗标会丢（git push --delete、commit --amend……），拆出来的调用看着和步骤一样也不能算
    if (grant.exactArgs && ctx.origin === "shell") problems.push(t("guard.grants.exactShell", { tool: grant.tool }));
    if (ctx.now >= grantExpiresAt(grant)) problems.push(t("guard.grants.expired", { at: new Date(grantExpiresAt(grant)).toISOString() }));
    const outOfScope = [...scopeProblems(grant, args, ctx), ...exactArgsProblems(grant, args), ...realScopeProblems(grant, args, ctx)];
    const unscoped = objectArgs.filter((a) => !Object.hasOwn(grant.scope, a));
    if (unscoped.length > 0) outOfScope.push(t("guard.grants.unscoped", { args: unscoped.join(list()) }));
    if (outOfScope.length > 0) problems.push(t("guard.grants.outOfScope", { problems: outOfScope.join(t("guard.sep")) }));
    if (grant.maxUses !== undefined) {
      const used = grantUses(grant, ctx);
      if (used >= grant.maxUses) problems.push(t("guard.grants.usedUp", { used, max: grant.maxUses }));
    }
    if (problems.length === 0) return { grant };
    reasons.push(t("guard.grants.reason", { grant: grant.grantId, problems: problems.join(list()) }));
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
 * 带着授权的会话段（定时作业的一次运行，19 号票）：效果日志已经只有这一段的，次数按这一段（每次运行）算。
 * 效果日志里内容类的参数只记了长度和摘要哈希（68 号票）：对象范围里的值按同一写法算哈希来比，和比原文结果一样。
 * 阶段详情的"已用 N/M"（84 号票，tasks/stage-view.ts）也用它：和判定同一个口径
 */
export function grantUses(grant: Grant, ctx: Pick<GrantContext, "task" | "effectLog" | "tools" | "env">): number {
  const mine = (e: EffectRecord) => (ctx.task.segmentScoped ? e.taskId === null : e.taskId === ctx.task.taskId && e.stageId === grant.stageId);
  return ctx.effectLog.filter(
    (e) =>
      mine(e) &&
      e.tool === grant.tool &&
      e.at >= grant.grantedAt &&
      scopeProblems(grant, e.args, ctx).length === 0,
  ).length;
}

/**
 * 对象范围：每个写了的参数，调用里的值（数组的每个值）都要落在允许的值里。空数组不算（不少工具空着就是"全部"：
 * 提交的 paths 空着是提交全部改动）。只认写了的参数的授权项（exactArgs）按内容精确比：数组少了、多了都不算，路径要是同一个。
 * 效果日志里缩过的值（content-digest.ts）按哈希比。这次要判定的调用里不会有这种值：pi 在守卫之前就按工具的 schema 校验过参数
 * （写文件的内容得是字符串，改文件的每一段得是新旧片段），缩过的样子过不了
 */
function scopeProblems(grant: Grant, args: Readonly<Record<string, unknown>>, ctx: Pick<GrantContext, "tools" | "env">): string[] {
  const problems: string[] = [];
  for (const [param, allowedRaw] of Object.entries(grant.scope)) {
    const allowed = toList(allowedRaw);
    const value = args[param];
    if (value === undefined || value === null) {
      problems.push(t("guard.grants.missingArg", { param }));
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      problems.push(t("guard.grants.emptyArg", { param }));
      continue;
    }
    const isPath = isPathParam(ctx.tools, grant.tool, param);
    if (grant.exactArgs) {
      // 有缩过的值时两边都按哈希比
      const hashed = !isPath && toList(value).some(isDigested);
      const got = toList(value).map((v) => exactKey(isPath ? absolutePathOf(v, ctx.env) : v, isPath, hashed));
      if (!sameItems(got, allowed.map((a) => exactKey(a, isPath, hashed)))) problems.push(t("guard.grants.exactMismatch", { param, value: shown(value), allowed: allowed.join(list()) }));
      continue;
    }
    for (const v of toList(value)) {
      const target = isPath ? absolutePathOf(v, ctx.env) : v;
      if (!valueCovered(target, allowed, isPath)) {
        problems.push(t("guard.grants.notAllowed", { param, value: typeof v === "string" ? v : JSON.stringify(v), allowed: allowed.join(list()) }));
      }
    }
  }
  return problems;
}

/** 只认写了的参数（Grant.exactArgs）：调用多带了对象范围里没有的参数 */
function exactArgsProblems(grant: Grant, args: Readonly<Record<string, unknown>>): string[] {
  if (!grant.exactArgs) return [];
  const extra = Object.keys(args).filter((name) => hasValue(args[name]) && !Object.hasOwn(grant.scope, name));
  return extra.length > 0 ? [t("guard.grants.extraArgs", { args: extra.join(list()) })] : [];
}

/** 按真实路径比（Grant.realScope）：调用里每个路径的真实路径都要取得到、落在规划时解析的真实路径里 */
function realScopeProblems(grant: Grant, args: Readonly<Record<string, unknown>>, ctx: GrantContext): string[] {
  const problems: string[] = [];
  for (const [param, allowedRaw] of Object.entries(grant.realScope ?? {})) {
    const allowed = toList(allowedRaw);
    const value = args[param];
    if (!hasValue(value)) continue; // 调用里没有这个参数：对象范围那里已经算超出
    for (const v of toList(value)) {
      const target = absolutePathOf(v, ctx.env);
      const real = target === undefined ? undefined : ctx.realPathOf?.(target);
      if (real === undefined) problems.push(t("guard.grants.noRealPath", { param, value: shown(v) }));
      else if (grant.exactArgs ? !allowed.some((a) => typeof a === "string" && comparable(a) === comparable(real)) : !valueCovered(real, allowed, true)) {
        problems.push(t("guard.grants.realPathOutside", { param, real, allowed: allowed.join(list()) }));
      }
    }
  }
  return problems;
}

/**
 * 精确比较时一个值的样子：路径比规范化后的写法（取不到的永远对不上），别的按 scopeValueText；
 * hashed 时比摘要哈希（缩过的值本来就是，别的按 scopeValueText 算）
 */
function exactKey(value: unknown, isPath: boolean, hashed = false): string {
  if (isPath) return typeof value === "string" ? comparable(value) : "\u0000";
  if (!hashed) return scopeValueText(value);
  return isDigested(value) ? value.$digest.sha256 : sha256Of(scopeValueText(value));
}

/** 两组值一样（不论先后，个数也要一样） */
function sameItems(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.toSorted();
  const y = b.toSorted();
  return x.every((v, i) => v === y[i]);
}

const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * 一个值落不落在允许的值里：路径类参数按"在这个目录之内（或就是它）"，其余全等。
 * 对象范围里的值都是字符串（计划里只能这么写）：调用里的值按 scopeValueText 的写法比（58 号票：流程的步骤里写死的参数全部进授权项的范围）。
 * 效果日志里缩过的值（68 号票）只有原文的摘要哈希：允许的值按同一写法算哈希来比，和比原文结果一样
 */
function valueCovered(value: unknown, allowed: readonly unknown[], isPath: boolean): boolean {
  if (isPath) return typeof value === "string" && allowed.some((a) => typeof a === "string" && isWithin(value, a));
  if (isDigested(value)) return allowed.some((a) => sha256Of(typeof a === "string" ? a : JSON.stringify(a)) === value.$digest.sha256);
  return allowed.some((a) => (typeof a === "string" ? a === scopeValueText(value) : JSON.stringify(a) === JSON.stringify(value)));
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
      // 用户在计划卡上收窄授权项时看到（173 号票：按当前语言）
      problems.push(t("guard.grants.change.added", { grant: a.grantId }));
      continue;
    }
    const p = (msg: string) => problems.push(t("guard.grants.change.prefix", { grant: a.grantId, msg }));
    if (a.tool !== b.tool) p(t("guard.grants.change.tool", { from: b.tool, to: a.tool }));
    if (a.stageId !== b.stageId) p(t("guard.grants.change.stage", { from: b.stageId, to: a.stageId }));
    if (b.command !== undefined && (a.command === undefined || commandKey(a.command) !== commandKey(b.command))) {
      p(t(a.command === undefined ? "guard.grants.change.commandRemoved" : "guard.grants.change.commandChanged"));
    }
    if (b.exactArgs && !a.exactArgs) p(t("guard.grants.change.exactRemoved"));
    for (const [param, bAllowed] of Object.entries(b.realScope ?? {})) {
      const aAllowed = a.realScope?.[param];
      if (aAllowed === undefined) {
        p(t("guard.grants.change.realScopeRemoved", { param }));
        continue;
      }
      for (const v of toList(aAllowed)) if (!valueCovered(v, toList(bAllowed), true)) p(t("guard.grants.change.realScopeWider", { param, value: String(v) }));
    }
    for (const [param, bAllowed] of Object.entries(b.scope)) {
      if (!Object.hasOwn(a.scope, param)) {
        p(t("guard.grants.change.scopeRemoved", { param }));
        continue;
      }
      const isPath = isPathParam(tools, b.tool, param);
      for (const v of toList(a.scope[param])) {
        if (!valueCovered(v, toList(bAllowed), isPath)) p(t("guard.grants.change.scopeWider", { param, value: String(v) }));
      }
    }
    if (b.maxUses !== undefined && (a.maxUses === undefined || a.maxUses > b.maxUses)) {
      p(t("guard.grants.change.uses", { from: b.maxUses, to: a.maxUses ?? t("guard.grants.change.unlimited") }));
    }
    if (grantExpiresAt(a) > grantExpiresAt(b)) p(t("guard.grants.change.expiryLater"));
    if (a.grantedAt > b.grantedAt) p(t("guard.grants.change.grantedLater"));
  }
  return { ok: problems.length === 0, problems };
}
