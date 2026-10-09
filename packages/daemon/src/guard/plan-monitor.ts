// 流程执行时的计划检查（59 号票，ADR 0019）：照搬 AgentSense 固定计划的执行时检查——
// `web/src/agent/planguardMonitor.ts`（PlanMonitor：监控器的外壳，按已执行的调用重放）和
// `web/src/agent/guard.ts`（evaluateCall：两道判定合到一起；tryAutoFix：能修的不打扰用户、按计划修回）。纯函数。
//
// 两道都要过：第一道是现有的守卫判定（关注类别、处置、授权项、时序规则，judge.ts），第二道是这里——和用户已授权的那份计划比对
// （引擎是照搬的 planguard/monitor.ts）：
// - 计划外（off_plan）：计划里没有这个工具的步骤。只读的只记下；会改东西的（注册表没标"只读或幂等"的，通用 bash 按拆出来的
//   每一条算）问用户；第一道判出落进了关注类别的，每次都问（AgentSense 的 offPlan && ops，不看点没点过头）；
// - 超范围（out_of_scope）：和这个工具的每一步都对不上，问用户；用户点一次头只放过这次碰的那一个对象（callObject，见 findingKey）。比对口径和 58 号票的授权项一样从严：只认步骤里写了的参数
//   （调用多带、少带参数都算对不上）、每个参数的值都要一样（数组不论先后、个数也要一样），路径按真实路径比（调用里的路径取判定前
//   现取的真实路径，步骤里的取规划时记下的，取不到的对不上）；通用 bash 的步骤只比到命令这一层（commandKey：首尾空白不算）；
//   调用和步骤的工具要一样，从通用 bash 拆出来的同类操作对不上带类型工具的步骤（不被 bash 绕过）；
// - 顺序错（out_of_order）：对上的步骤的前置步骤还没执行（说明跳过的不算），问用户；
// - 重复（repeat）：只许做一次的步骤做了第二次，直接拦下。只许做一次的是对外发出去的：登记了对外发送（outbound）或带
//   "以我的名义对外发送"标签的带类型工具（推送、建远端仓库），以及这次命中了"以我的名义对外发送"的通用 bash 命令（发布、
//   gh release、gh pr create……）；
// - 禁止（forbidden）：审查修补时从这一步剔除的对象（ReviewedStep.excluded，按真实路径比），直接拦下。
// 时序规则在第一道判（框架的 v1 模板 + 计划里写的条件），这里把它的结果当成 planguard 的 rule:<id> / rule_unknown:<id>，
// 只为了自动修回（AgentSense 的规则也在监控器里判；二狗的规则引擎就是同一个 planguard，结果一样，不重复判一遍）。
//
// 自动修回（tryAutoFix）：查出的问题都是能修的（超范围、顺序错、违反时序规则），并且没有直接拦下的（重复、禁止），先试着不打扰用户：
// 1. 引回前置步骤：这次调用对上了计划里的某一步，前置步骤还没做（顺序错，或规则声明的修法是"先插一步 X / 挪到 X 之后"，
//    而计划里正好有还没做的 X）——这次先不执行，告诉维护者先做那一步；
// 2. 按计划改回参数：同一工具、还没做完的步骤里，不认对象的参数和计划写的不一样，改回计划的值，改后两道重新判一遍，
//    完全没问题才放行（认对象的参数不改——换对象不是小偏差，见 identityArgsOf）。
// 同一个"工具 + 步骤"最多修 MAX_AUTO_FIX 次，修不了、超过次数的交回常规流程（拦下或问用户）。
//
// 和 AgentSense 的不同（用户 2026-10-09 接受）：二狗没有场景文档，比对规则（conformance）按注册表现生成（workflowConformance），
// 比对口径照 58 号票的授权项从严（见上）；超范围点过头按"工具 + 这次碰的对象"记（用户定，比 AgentSense 严）；引回时"计划里正好有
// X 那一步"对通用 bash 的步骤按拆出来的命令认（bash 里的 npm test 算跑测试）。
import { scopeValueText } from "./content-digest.ts";
import { commandKey } from "./grants.ts";
import { isReadOnlyOrIdempotentCall, judgementExecutes } from "./judge.ts";
import { comparable, resolveAgentPath, type ShellEnv } from "./paths.ts";
import { isUnknown, Unknown } from "./planguard/expr.ts";
import { type MonitorFinding, Monitor, type Verdict } from "./planguard/monitor.ts";
import type { Scenario } from "./planguard/spec.ts";
import type { TemporalRule } from "./temporal-rules.ts";
import { findTool, TOOL, type ToolRegistry } from "./tool-registry.ts";
import type { GuardJudgement, GuardWorkflow, GuardWorkflowStep } from "./types.ts";
import { isUnknownArg, plainArgs, stepCalls } from "./workflow-steps.ts";

/** 自动纠偏在工具结果里的开头（AgentSense plan.ts 的 CORRECTION_PREFIX） */
export const CORRECTION_PREFIX = "【自动纠偏】";
/** 计划检查替维护者补的提醒的开头（AgentSense plan.ts 的 NUDGE_PREFIX） */
export const NUDGE_PREFIX = "【计划检查】";
/** 同一个步骤自动修了这么多次还对不上，就说明不是小偏差，交给用户（AgentSense guard.ts） */
export const MAX_AUTO_FIX = 2;

/** 一条计划检查的判定（AgentSense plan.ts 的 PlanFinding）：off_plan / forbidden / out_of_scope / repeat / out_of_order / rule:<id> / rule_unknown:<id> / checker_error */
export interface PlanFinding {
  kind: string;
  message: string;
  verdict: Verdict;
  step?: string;
  /** 超范围：这次调用碰的对象（callObject）。判定的身份带着它（findingKey） */
  object?: string;
}

/** 和已授权计划的一致性问题（相对"违反时序规则"而言） */
export const CONFORMANCE_KINDS: ReadonlySet<string> = new Set(["off_plan", "forbidden", "out_of_scope", "repeat", "out_of_order"]);

/**
 * 一条判定的身份 = 类别 + 原话（AgentSense guard.ts 的 findingKey），超范围的另带这次碰的对象：用户点过头的判定按它记，同样的不再问。
 * 原话里带不带对象看是哪一种：时序规则的原话里带着对象（哪个文件、哪个收件人）；顺序错、重复说的是哪一步；计划外只说哪个工具。
 * 超范围的原话也只说哪个工具（"write 的参数超出了计划声明的范围"），AgentSense 点过一次头之后同一个工具后面的越界调用都不再问；
 * 二狗另带上这次碰的对象（callObject），点一次头只放过那一个对象，换了别的文件、别的命令、别的远端或分支照样问
 * ——用户 2026-10-09 定的，和 AgentSense 不一样
 */
export const findingKey = (f: Pick<PlanFinding, "kind" | "message" | "object">): string => `${f.kind}|${f.message}${f.object === undefined ? "" : `|${f.object}`}`;

/**
 * 超范围时这次调用碰的对象（用户定，口径和 58 号票授权项的对象范围一样）：通用 bash 是整条命令（commandKey）；带类型的工具是
 * 认对象的那几个参数（identityArgsOf）的值——路径按真实路径（取不到的按写的路径解析成的绝对路径、注明没取到），数组不论先后
 */
export function callObject(tool: string, args: Readonly<Record<string, unknown>>, ctx: { tools: ToolRegistry; env: ShellEnv; realPathOf: (path: string) => string | undefined }): string {
  if (tool === TOOL.bash) return JSON.stringify({ command: typeof args.command === "string" ? commandKey(args.command) : scopeValueText(args.command) });
  const descriptor = findTool(ctx.tools, tool);
  const out: Record<string, string[]> = {};
  for (const name of identityArgsOf(ctx.tools, tool).toSorted()) {
    const value = args[name];
    if (!given(value)) continue;
    const isPath = descriptor?.args[name]?.kind === "path";
    out[name] = (Array.isArray(value) ? value : [value]).map((v) => objectValue(v, isPath, ctx)).toSorted();
  }
  return JSON.stringify(out);
}

/** 对象里一个值的写法：路径按真实路径，别的按 scopeValueText */
function objectValue(value: unknown, isPath: boolean, ctx: { env: ShellEnv; realPathOf: (path: string) => string | undefined }): string {
  if (!isPath || typeof value !== "string") return scopeValueText(value);
  const resolved = resolveAgentPath(value, ctx.env);
  if (resolved.kind !== "absolute") return `（解析不了的路径）${value}`;
  const real = ctx.realPathOf(resolved.path);
  return real === undefined ? `（没取到真实路径）${comparable(resolved.path)}` : comparable(real);
}

/**
 * 执行时的自动纠偏（AgentSense plan.ts 的 Correction）：修回的是用户已经授权过的那份计划，所以不需要再问：
 * - rewrite：参数和计划对不上，按计划改回来再执行（只改属性，不换对象）；
 * - redirect：前置步骤还没做，这次先不执行，让维护者先做计划里的那一步；
 * - nudge：一轮收尾时计划还有步骤既没做也没说跳过，提醒维护者补上或说明（执行控制器发，tasks/workflow-run.ts）
 */
export interface PlanCorrection {
  kind: "rewrite" | "redirect" | "nudge";
  /** 纠偏前查出来的问题 */
  findings: PlanFinding[];
  /** 这次调用对应的计划步骤 */
  stepId?: string;
  /** rewrite：改了哪些参数 */
  changes?: Array<{ arg: string; from: unknown; to: unknown }>;
  /** redirect：改为先执行的计划步骤 */
  target?: { id: string; title?: string; tool: string };
  /** nudge：还欠着的步骤 */
  pending?: string[];
  /** 给人看的一句话 */
  text: string;
}

/** 一次调用的计划检查记录（AgentSense plan.ts 的 PolicyAssessment 里计划检查的那几项） */
export interface PlanAssessment {
  /** 这次调用算在哪一步（AgentSense 的 stepId：对上的那一步，没对上时是同一工具的第一步，给人看的） */
  stepId?: string;
  /** 比对时真正对上的那一步（参数和步骤写的一样）：执行成功后只记它，没对上的不记（不算做过任何一步） */
  matchedStep?: string;
  /** 计划里没有这个工具的步骤 */
  offPlan: boolean;
  findings?: PlanFinding[];
  correction?: PlanCorrection;
}

/** 一次已经成功执行过的调用（监控器的轨迹，AgentSense planguardMonitor.ts 的 ExecutedCall）：对上的是哪一步 */
export interface PlanExecutedCall {
  tool: string;
  step: string | null;
}

// ───────────────────────── 计划比对的规则文档（AgentSense 的 scenario.planguard.conformance） ─────────────────────────

/** 认对象的参数的种类：路径、收件人、网址、命令 */
const IDENTITY_KINDS = new Set(["path", "recipient", "url", "command"]);
/** 带类型的工具里另外认对象的参数（不在上面那几种里）：推送到哪个远端、哪个分支，合并哪个分支，建哪个仓库，装哪些包 */
const IDENTITY_OTHER: Readonly<Record<string, readonly string[]>> = {
  [TOOL.git_push]: ["remote", "branch"],
  [TOOL.git_merge]: ["branch"],
  [TOOL.create_remote_repo]: ["name"],
  [TOOL.install_deps]: ["packages"],
};

/** 这个工具靠哪些参数认对象（自动纠偏改回参数时不改它们）：通用 bash 只有命令；别的按注册表的参数种类，加上 IDENTITY_OTHER */
export function identityArgsOf(tools: ToolRegistry, tool: string): string[] {
  if (tool === TOOL.bash) return ["command"];
  const descriptor = findTool(tools, tool);
  if (!descriptor) return [];
  return Object.entries(descriptor.args)
    .filter(([name, rule]) => IDENTITY_KINDS.has(rule.kind) || (IDENTITY_OTHER[tool] ?? []).includes(name))
    .map(([name]) => name);
}

/** 比对时参数的写法里，写了哪些参数（按名字排好）：它对不上就是多带或少带了参数 */
const WRITTEN = "__written";

/** 参数算不算给了值：undefined、null、空数组算没给（和 58 号票的授权项一样） */
const given = (v: unknown) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);

/** 审查时从步骤里剔除的对象：调用里有一个就是 */
const excludedObject = (name: string) => ({ any: { from: { as_list: `$call.args.${name}` }, where: { in: ["$row", { as_list: `$step.excluded.${name}` }] } } });

/** 这次调用的样子：哪个工具，只读不只读，往不往外送（第一道判出命中了"以我的名义对外发送"） */
export interface CurrentCall {
  tool: string;
  readOnly: boolean;
  outward: boolean;
}

/** 只许做一次的带类型工具（也包括 pi 工具、MCP 工具）：登记了对外发送的、带"以我的名义对外发送"标签的 */
function onceTools(tools: ToolRegistry): string[] {
  return Object.values(tools)
    .filter((t) => (t.outbound === true || t.categories.includes("external_send")) && t.source !== "pseudo" && t.source !== "host")
    .map((t) => t.name);
}

/**
 * 这份计划的比对规则（AgentSense 场景文档的 conformance：sensitive、within、forbid、once），按注册表和这次调用现生成：
 * - within：通用 bash 比命令；别的工具比写了哪些参数、每个参数的值（参数的写法见 conformanceArgs）；
 * - forbid：审查剔除的对象；
 * - sensitive：没标"只读或幂等"的工具，这次调用只读的不算；
 * - once：对外发出去的带类型工具，这次调用往外送的也算（通用 bash 的发布、gh release……）
 */
export function workflowConformance(workflow: GuardWorkflow, tools: ToolRegistry, current: CurrentCall): Record<string, unknown> {
  const within: Record<string, unknown> = {};
  const forbid: Record<string, unknown> = {};
  for (const tool of new Set(workflow.steps.map((s) => s.tool))) {
    if (tool === TOOL.bash) within[tool] = { eq: ["$call.args.command", "$step.args.command"] };
    else {
      const names = new Set([...Object.keys(findTool(tools, tool)?.args ?? {}), ...workflow.steps.filter((s) => s.tool === tool).flatMap((s) => Object.keys(s.args))]);
      within[tool] = { and: [WRITTEN, ...names].map((n) => ({ eq: [`$call.args.${n}`, `$step.args.${n}`] })) };
    }
    const excluded = [...new Set(workflow.steps.filter((s) => s.tool === tool).flatMap((s) => Object.keys(s.excluded ?? {})))];
    if (excluded.length > 0) forbid[tool] = { or: excluded.map(excludedObject) };
  }
  const sensitive = Object.values(tools)
    .filter((t) => t.readOnlyOrIdempotent !== true)
    .map((t) => t.name)
    .filter((name) => !(name === current.tool && current.readOnly));
  const once = [...onceTools(tools), ...(current.outward ? [current.tool] : [])];
  return { sensitive, within, forbid, once };
}

/**
 * 比对时参数的写法（和 58 号票授权项的精确比较一个口径，见 grants.ts 的 scopeProblems、exactArgsProblems、realScopeProblems）：
 * 只留给了值的参数；每个参数写成一组值（单个值算一个，数组不论先后、个数也要一样：排好序）；路径换成真实路径
 * （先按工作目录解析成绝对路径，realOf 取它的真实路径，不分大小写、正反斜杠），伪设备、解析不了、取不到真实路径的是"未知"；
 * 别的值按 scopeValueText；有一个值是"未知"的，这个参数就是未知（未知和什么都对不上）；通用 bash 的命令按 commandKey；
 * 另记一项写了哪些参数（WRITTEN）
 */
function conformanceArgs(tool: string, args: Readonly<Record<string, unknown>>, ctx: { tools: ToolRegistry; env: ShellEnv }, realOf: (path: string) => string | undefined): Record<string, unknown> {
  const descriptor = findTool(ctx.tools, tool);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (!given(value)) continue;
    if (tool === TOOL.bash && name === "command") {
      out[name] = typeof value === "string" ? commandKey(value) : new Unknown(value);
      continue;
    }
    const isPath = descriptor?.args[name]?.kind === "path";
    const items = (Array.isArray(value) ? value : [value]).map((v) => exactValue(v, isPath, ctx.env, realOf));
    out[name] = items.some(isUnknown) ? new Unknown(value) : (items as string[]).toSorted();
  }
  out[WRITTEN] = Object.keys(out).toSorted();
  return out;
}

/** 一个值精确比较时的样子（见 conformanceArgs）；比不了的是"未知" */
function exactValue(value: unknown, isPath: boolean, env: ShellEnv, realOf: (path: string) => string | undefined): string | Unknown {
  if (isUnknownArg(value)) return new Unknown(value);
  if (!isPath) return scopeValueText(value);
  if (typeof value !== "string") return new Unknown(value);
  const resolved = resolveAgentPath(value, env);
  const real = resolved.kind === "absolute" ? realOf(resolved.path) : undefined;
  return real === undefined ? new Unknown(value) : comparable(real);
}

/** 一步里规划时记下的真实路径（写的路径解析成的绝对路径 → 真实路径），按规范化后的路径查 */
const stepRealOf = (step: GuardWorkflowStep) => {
  const reals = new Map(Object.entries(step.realPaths ?? {}).map(([p, real]) => [comparable(p), real]));
  return (path: string) => reals.get(comparable(path));
};

// ───────────────────────── 监控器的外壳（AgentSense planguardMonitor.ts 的 PlanMonitor） ─────────────────────────

/**
 * 监控器的外壳：引擎的 Monitor 在构造时把计划和比对规则固定下来，这里每次判定按当下的计划、把之前成功执行过的调用按序重放进去、
 * 再把说明跳过的步骤标上。出错的策略照 AgentSense：监控失败一律当作"需要用户当场确认"，不能因为检查器坏了就放行
 */
export class PlanMonitor {
  private inner: Monitor | undefined;
  /** 构造监控器时出的错；有值表示每次检查都要退化成"当场确认" */
  private failure: string | undefined;
  private readonly log: PlanExecutedCall[];
  private readonly skipped: Set<string>;
  private readonly tools: ToolRegistry;
  private readonly env: ShellEnv;
  /** 这次调用里路径的真实路径（判定前现取的） */
  private readonly realOf: (path: string) => string | undefined;

  constructor(
    workflow: GuardWorkflow,
    history: readonly PlanExecutedCall[],
    ctx: { tools: ToolRegistry; env: ShellEnv; current: CurrentCall; realPathOf: (path: string) => string | undefined },
  ) {
    this.tools = ctx.tools;
    this.env = ctx.env;
    this.realOf = ctx.realPathOf;
    this.log = [...history];
    this.skipped = new Set(workflow.skipped);
    try {
      // 规则在第一道判（见文件开头），这里只有计划比对
      const scenario: Scenario = { rules: [], facts: {}, conformance: workflowConformance(workflow, ctx.tools, ctx.current) };
      const steps = workflow.steps.map((s) => ({
        id: s.id,
        title: s.title,
        tool: s.tool,
        args: conformanceArgs(s.tool, s.args, ctx, stepRealOf(s)),
        after: [...s.after],
        ...(s.excluded ? { excluded: conformanceArgs(s.tool, s.excluded, ctx, stepRealOf(s)) } : {}),
      }));
      const monitor = new Monitor(scenario, { goal: workflow.goal, steps });
      for (const c of this.log) monitor.commit(c.tool, {}, c.step);
      for (const s of this.skipped) monitor.skip(s);
      this.inner = monitor;
    } catch (error) {
      this.inner = undefined;
      this.failure = (error as Error)?.message ?? String(error);
    }
  }

  check(tool: string, args: Readonly<Record<string, unknown>>): { verdict: Verdict; step: string | null; findings: MonitorFinding[] } {
    if (!this.inner) {
      // 检查器坏了：往严格的方向退，交给用户当场判断
      return { verdict: "confirm", step: null, findings: [{ kind: "checker_error", message: `计划检查器没能运行：${this.failure}`, verdict: "confirm" }] };
    }
    try {
      return this.inner.check(tool, conformanceArgs(tool, args, { tools: this.tools, env: this.env }, this.realOf));
    } catch (error) {
      return { verdict: "confirm", step: null, findings: [{ kind: "checker_error", message: `计划检查出错：${(error as Error)?.message ?? error}`, verdict: "confirm" }] };
    }
  }

  /** 已经执行过（至少一次）的计划步骤 */
  doneSteps(): Set<string> {
    return new Set(this.log.map((c) => c.step).filter((s): s is string => s !== null));
  }

  skippedSteps(): Set<string> {
    return new Set(this.skipped);
  }

  /** 这个工具在计划里靠哪些参数认对象：自动纠偏只改属性不换对象 */
  identityArgs(tool: string): Set<string> {
    return new Set(identityArgsOf(this.tools, tool));
  }
}

/**
 * 收尾时还没执行、也没说明跳过的计划步骤（AgentSense 的 monitor.end()）：只看步骤和轨迹里对上的步骤，不用比参数
 * （引擎照样是 planguard 的 Monitor）
 */
export function planPending(workflow: GuardWorkflow, history: readonly PlanExecutedCall[]): PlanFinding[] {
  try {
    const steps = workflow.steps.map((s) => ({ id: s.id, title: s.title, tool: s.tool, args: {}, after: [...s.after] }));
    const monitor = new Monitor({ rules: [], facts: {} }, { goal: workflow.goal, steps });
    for (const c of history) monitor.commit(c.tool, {}, c.step);
    for (const s of workflow.skipped) monitor.skip(s);
    return monitor.end();
  } catch {
    return [];
  }
}

// ───────────────────────── 两道合到一起（AgentSense guard.ts 的 evaluateCall） ─────────────────────────

export interface PlanCheckInput {
  /** 用户已授权的那份计划（审查修补后的），连同说明跳过的步骤 */
  workflow: GuardWorkflow;
  /** 这个流程里已经成功执行过的调用，按执行先后 */
  history: readonly PlanExecutedCall[];
  /** 用户已经就哪些判定点过头了（findingKey）；换计划就作废 */
  confirmed: ReadonlySet<string>;
  /** 每个"工具|步骤"已经自动纠偏过几次 */
  corrections: ReadonlyMap<string, number>;
  call: { toolName: string; args: Readonly<Record<string, unknown>> };
  /** 第一道：现有的守卫判定（关注类别、处置、授权项、时序规则） */
  judgement: GuardJudgement;
  tools: ToolRegistry;
  env: ShellEnv;
  /** 这次调用里路径的真实路径（判定前现取的环境事实）；取不到的是 undefined */
  realPathOf(path: string): string | undefined;
  /** 这次判定生效的时序规则（取规则声明的修法：插一步 / 挪到某步之后） */
  rules: readonly TemporalRule[];
  /** 改了参数之后重判第一道（同样的环境事实：改的只有不认对象的参数，路径没变） */
  rejudge(args: Record<string, unknown>): GuardJudgement;
}

/**
 * 计划检查的结论（第一道的结论另外看）：
 * - pass：和计划对得上，或者对不上但不用问（只读的计划外、用户点过头的），照第一道走；
 * - ask：要用户当场确认（askAbout 是这次真正要问的判定）；第一道也要问的合成一次；
 * - block：直接拦下，不打扰用户（审查时已经排除的对象、只许做一次的事）；
 * - redirect：这次先不执行，把 text 交给维护者，让它先做计划里的前置步骤；
 * - rewrite：按计划把参数改回来再执行（judgement 是改后第一道的判定，已经确认会执行）。
 * 自动修了的给出 spent：用掉了哪个"工具|步骤"的一次修回额度
 */
export type PlanCheckOutcome =
  | { kind: "pass"; assessment: PlanAssessment }
  | { kind: "ask"; assessment: PlanAssessment; askAbout: PlanFinding[] }
  | { kind: "block"; assessment: PlanAssessment; reason: string }
  | { kind: "redirect"; assessment: PlanAssessment; text: string; spent: string }
  | { kind: "rewrite"; assessment: PlanAssessment; args: Record<string, unknown>; judgement: GuardJudgement; spent: string };

/** 这几类能按计划修回来；计划外动作、判不了（未知）、检查器出错都只能问人 */
const correctable = (f: PlanFinding) => f.kind === "out_of_scope" || f.kind === "out_of_order" || f.kind.startsWith("rule:");
/** 审查时已经排除的对象、只许做一次的事：直接拦，没什么可修的 */
const HARD_BLOCK = new Set(["forbidden", "repeat"]);

/** 第一道判出的时序规则（违反了、判断不了）写成 planguard 的判定：一律禁止的是拦下，别的是当场确认 */
function ruleFindings(judgement: GuardJudgement): PlanFinding[] {
  return judgement.temporalRules.map((hit) => ({
    kind: `${hit.status === "violated" ? "rule" : "rule_unknown"}:${hit.ruleId}`,
    message: hit.message,
    verdict: hit.status === "violated" && hit.outcome === "never" ? "block" : "confirm",
  }));
}


export function evaluatePlanCall(input: PlanCheckInput, autoFix = true): PlanCheckOutcome {
  const { workflow, call, judgement, tools, env } = input;
  const toolName = call.toolName;
  const current: CurrentCall = { tool: toolName, readOnly: isReadOnlyOrIdempotentCall(tools, toolName, judgement), outward: judgement.categories.includes("external_send") };
  const monitor = new PlanMonitor(workflow, input.history, { tools, env, current, realPathOf: input.realPathOf });
  const step = workflow.steps.find((s) => s.tool === toolName);
  const offPlan = !step;
  const compared = monitor.check(toolName, call.args);
  // 超范围带上这次碰的对象：点过头只放过这一个对象（见 findingKey）
  const object = () => callObject(toolName, call.args, { tools, env, realPathOf: input.realPathOf });
  const findings: PlanFinding[] = [...compared.findings.map((f) => (f.kind === "out_of_scope" ? { ...f, object: object() } : f)), ...ruleFindings(judgement)];
  // planguard 能按"工具 + 范围"精确匹配到步骤，比按工具名找第一个准
  const stepId = compared.step ?? step?.id;
  const assessment: PlanAssessment = {
    ...(stepId === undefined ? {} : { stepId }),
    ...(compared.step === null ? {} : { matchedStep: compared.step }),
    offPlan,
    ...(findings.length > 0 ? { findings } : {}),
  };

  // 已经点过头的判定不再重复打断
  const fresh = findings.filter((f) => f.verdict !== "allow" && !input.confirmed.has(findingKey(f)));
  const hard = findings.some((f) => f.verdict === "block" && HARD_BLOCK.has(f.kind));
  if (autoFix && !hard && fresh.length > 0 && fresh.every(correctable)) {
    const fixed = tryAutoFix(input, monitor, compared.step, fresh);
    if (fixed?.kind === "rewrite") {
      return { kind: "rewrite", assessment: { ...fixed.assessment, correction: fixed.correction }, args: fixed.args, judgement: fixed.judgement, spent: fixed.spent };
    }
    if (fixed?.kind === "redirect") return { kind: "redirect", assessment: { ...assessment, correction: fixed.correction }, text: fixed.text, spent: fixed.spent };
  }

  // 直接拦下的只有计划比对自己的（重复、禁止）；时序规则的"一律禁止"第一道已经拦下了
  if (compared.verdict === "block") {
    const blocked = compared.findings
      .filter((f) => f.verdict === "block")
      .map((f) => f.message)
      .join("；");
    return { kind: "block", assessment, reason: blocked };
  }

  // 要问用户的：计划比对查出的（时序规则的第一道自己问）
  const askAbout = fresh.filter((f) => !f.kind.startsWith("rule") && f.verdict === "confirm");
  // 计划外的动作落进了关注类别：每次都问（AgentSense guard.ts 的 offPlan && ops.length > 0，不看之前点没点过头）
  if (offPlan && judgement.categories.length > 0 && !askAbout.some((f) => f.kind === "off_plan")) {
    const off = findings.find((f) => f.kind === "off_plan");
    askAbout.push(off ? { ...off, verdict: "confirm" } : { kind: "off_plan", message: `计划里没有 ${toolName} 这一步`, verdict: "confirm" });
  }
  return askAbout.length > 0 ? { kind: "ask", assessment, askAbout } : { kind: "pass", assessment };
}

type AutoFix =
  | { kind: "rewrite"; correction: PlanCorrection; assessment: PlanAssessment; args: Record<string, unknown>; judgement: GuardJudgement; spent: string }
  | { kind: "redirect"; correction: PlanCorrection; text: string; spent: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type RepairDoc = { insert?: { tool?: string; position?: string }; move_after?: { tool?: string | string[] } };
const ruleOf = (rules: readonly TemporalRule[], kind: string) => rules.find((r) => `rule:${r.id}` === kind) as { repairs?: RepairDoc[] } | undefined;

/** 规则声明的修法里，哪些工具应当排在这一步之前：插在前面的步骤、要挪到其后的锚点 */
function toolsWantedBefore(rules: readonly TemporalRule[], problems: readonly PlanFinding[]): Set<string> {
  const out = new Set<string>();
  for (const f of problems) {
    for (const r of ruleOf(rules, f.kind)?.repairs ?? []) {
      if (r.insert?.tool && (r.insert.position ?? "before") === "before") out.add(r.insert.tool);
      const anchors = r.move_after?.tool;
      for (const t of Array.isArray(anchors) ? anchors : anchors ? [anchors] : []) out.add(t);
    }
  }
  return out;
}

/** 这一步做的是不是某个工具：步骤的工具就是它，或者通用 bash 的步骤里拆出来有它（bash 里的 npm test 算跑测试） */
const stepDoes = (s: GuardWorkflowStep, tool: string, env: ShellEnv) => s.tool === tool || (s.tool === TOOL.bash && stepCalls(s, env).some((c) => c.tool === tool));

const brief = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * 能不打扰用户就把这次调用拉回已授权的计划（AgentSense guard.ts 的 tryAutoFix）。修的依据只有计划本身——审查插进去的步骤、
 * 改写过的参数——所以不会做出用户没见过的事。修不了返回 undefined，交回常规流程（拦下或问用户）
 */
function tryAutoFix(input: PlanCheckInput, monitor: PlanMonitor, stepId: string | null, problems: PlanFinding[]): AutoFix | undefined {
  const { workflow, call, env } = input;
  const tool = call.toolName;
  const args = call.args;
  const steps = workflow.steps;
  const done = monitor.doneSteps();
  const skipped = monitor.skippedSteps();
  const open = (s: GuardWorkflowStep) => !done.has(s.id) && !skipped.has(s.id);
  const current = steps.find((s) => s.id === stepId) ?? steps.find((s) => s.tool === tool && open(s));
  const budgetKey = `${tool}|${current?.id ?? "?"}`;
  if ((input.corrections.get(budgetKey) ?? 0) >= MAX_AUTO_FIX) return undefined;
  const why = problems.map((f) => f.message).join("；");

  // 1. 先补前置步骤。前提是这次调用确实对上了计划里的某一步——对象都不在计划里（超出范围）的话，先做别的步骤也不会让它变得合规；
  //    每个问题也都得是"补一步就能好"的：顺序错，或规则声明的修法是先插一步 / 挪到某步之后
  const fixableByOrder = (f: PlanFinding) => f.kind === "out_of_order" || toolsWantedBefore(input.rules, [f]).size > 0;
  if (current && stepId !== null && problems.every(fixableByOrder)) {
    const earlier = steps.slice(0, steps.indexOf(current)).filter((s) => open(s) && s.tool !== tool);
    const deps = problems.some((f) => f.kind === "out_of_order") ? earlier.filter((s) => current.after.includes(s.id)) : [];
    // 规则自己声明的修法是"先插一步 X"或"挪到 X 之后"，而计划里正好有还没做的 X：那就是它
    const wanted = toolsWantedBefore(input.rules, problems);
    const target = deps[0] ?? earlier.find((s) => [...wanted].some((t) => stepDoes(s, t, env)));
    if (target && monitor.check(target.tool, target.args).verdict !== "block") {
      const title = target.title || target.tool;
      const shown = plainArgs(target.args);
      return {
        kind: "redirect",
        spent: budgetKey,
        correction: {
          kind: "redirect",
          findings: problems,
          stepId: current.id,
          target: { id: target.id, title: target.title, tool: target.tool },
          text: `缺了前置步骤：先让维护者做「${title}」，再回来执行这一步`,
        },
        text:
          `${CORRECTION_PREFIX}这一步先不执行：${why}。按用户已授权的计划，应先执行步骤 ${target.id}「${title}」：` +
          `调用 ${target.tool}${Object.keys(shown).length ? `，参数 ${JSON.stringify(shown)}` : ""}。` +
          "做完再回来执行原来这一步。这是按计划纠偏，不需要询问用户。",
      };
    }
  }

  // 2. 按计划改参数
  const identity = monitor.identityArgs(tool);
  for (const s of steps.filter((x) => x.tool === tool && open(x))) {
    const changes: NonNullable<PlanCorrection["changes"]> = [];
    const fixedArgs: Record<string, unknown> = { ...args };
    for (const [k, v] of Object.entries(plainArgs(s.args))) {
      if (identity.has(k) || !(k in args) || same(args[k], v)) continue;
      fixedArgs[k] = v;
      changes.push({ arg: k, from: args[k], to: v });
    }
    if (!changes.length) continue;
    // 改后两道都要过：第一道照常会执行，计划检查不再有要拦、要问的
    const judgement = input.rejudge(fixedArgs);
    if (!judgementExecutes(judgement)) continue;
    const retry = evaluatePlanCall({ ...input, call: { toolName: tool, args: fixedArgs }, judgement }, false);
    if (retry.kind !== "pass") continue;
    return {
      kind: "rewrite",
      spent: budgetKey,
      correction: {
        kind: "rewrite",
        findings: problems,
        stepId: s.id,
        changes,
        text: `参数和计划对不上，已按计划改回：${changes.map((c) => `${c.arg} ${brief(c.from)} → ${brief(c.to)}`).join("，")}`,
      },
      assessment: retry.assessment,
      args: fixedArgs,
      judgement,
    };
  }
  return undefined;
}
