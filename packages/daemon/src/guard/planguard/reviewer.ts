// planguard 的规划时审查：照搬 AgentSense `web/src/agent/planguard/reviewer.ts`（来源和哈希见同目录 VERSION），语义不改。
// 58 号票为流程的审查修补搬来。流程：建问题（buildProblem：按规则在 plan 模式下查出违规，每条违规的修补方案实例化成动作）
// → 求解（search.ts 的穷举，和 Z3 同一个字典序目标）→ 收尾（finalize：按选中的动作修补计划，再查一遍）。
// 只按本仓库的 TypeScript 和 oxlint 设置改写法：不用构造函数参数属性、下标取值加非空断言、排序用 toSorted、注释改中文。
import { type Finding, check } from "./checker.ts";
import { type Env, MISSING, SpecError, Unknown, canonical, clone, deepKnown, display, equals, evaluate, isNumber, isPlainObject, isUnknown, render, test, toJson } from "./expr.ts";
import { type Plan, REPAIR_KINDS, type Scenario, type Step, normalizePlan } from "./spec.ts";

export const COSTS = ["interaction", "disclosure", "ops"] as const;
const LINEAR_OPS = new Set(["ge", "le", "gt", "lt", "eq"]);

/** 审查的目标（场景声明的默认目标，或调用方另给的） */
export type Goal = { id: string; title?: string; expr: unknown; hard?: boolean; weight?: number };
type GoalForm = ["const", boolean | null] | ["linear", string, string, number];

/** 一个修补动作：插一步、改写一步的参数、把一步挪到某些工具之后、交给用户确认、退回重写 */
export class Action {
  readonly key: string;
  readonly kind: string;
  readonly summary: string;
  readonly costs: Record<string, number>;
  covers: string[] = [];
  tool: string | null = null;
  title = "";
  args: Record<string, unknown> = {};
  collect: Record<string, unknown[]> = {};
  position = "before";
  triggers: string[] = [];
  ops: Record<string, Record<string, unknown>> = {};
  anchors: string[] = [];
  text = "";

  constructor(key: string, kind: string, digest: string, costs: Record<string, number>) {
    this.key = key;
    this.kind = kind;
    this.summary = digest;
    this.costs = costs;
  }

  toDict(): Record<string, unknown> {
    const data: Record<string, unknown> = { kind: this.kind, summary: this.summary, covers: this.covers, costs: this.costs };
    if (this.kind === "insert") {
      Object.assign(data, { tool: this.tool, title: this.title, position: this.position, triggers: this.triggers, args: toJson({ ...this.args, ...this.collect }) });
    } else if (this.kind === "rewrite") {
      Object.assign(data, { step: this.triggers[0], ops: toJson(this.ops), title: this.title });
    } else if (this.kind === "move_after") {
      Object.assign(data, { step: this.triggers[0], after_tools: this.anchors });
    } else {
      data.text = this.text;
    }
    return data;
  }
}

export type Candidate = {
  index: number;
  assignment: Env;
  label: Record<string, string>;
  steps: Step[];
  bindChanges: Array<Record<string, unknown>>;
  env: Env;
  violations: Finding[];
  unknowns: Finding[];
  actions: Map<string, Action>;
  options: string[][][];
  base: Record<string, unknown>;
  delta: Map<string, Record<string, unknown>>;
  goals: Record<string, GoalForm>;
};

export type Problem = { scenario: Scenario; plan: Plan; goals: Goal[]; candidates: Candidate[]; objective: Array<[string, string]> };
export type Solution = { candidate: number; selection: number[]; keptGoals: string[]; relaxed: boolean };
export type Blocked = Array<[number, number[]]>;

/** 求解后端：纯搜索（search.ts）；AgentSense 端侧不接 Z3，二狗也不接 */
export interface Backend {
  solve(problem: Problem, relaxed: boolean, blocked: Blocked): Promise<Solution | null>;
  unsatCore(problem: Problem, blocked: Blocked): Promise<string[]>;
}

// ───────────────────────── 建问题 ─────────────────────────

function instantiate(option: Record<string, any>, finding: Finding): Action {
  const kind = REPAIR_KINDS.find((k) => k in option) as string;
  const spec = option[kind];
  const env = finding.env;
  const stepId = finding.step.id;
  const costs: Record<string, number> = { interaction: 0, disclosure: 0, ops: kind === "confirm" || kind === "replan" ? 0 : 1 };
  if (kind === "confirm") costs.interaction = 1;
  Object.assign(costs, option.cost ?? {});

  if (kind === "insert") {
    const tool: string = spec.tool;
    const position: string = spec.position ?? "before";
    const hasShare = "share" in spec;
    const share = hasShare ? evaluate(spec.share, env) : null;
    const tag = hasShare ? display(share) : finding.key;
    const action = new Action(`insert:${tool}:${position}:${tag}`, kind, `insert:${tool}:${hasShare ? display(share) : stepId}`, costs);
    action.tool = tool;
    action.title = render(spec.title ?? tool, env);
    action.position = position;
    action.args = evaluate(spec.args ?? {}, env) as Record<string, unknown>;
    for (const [arg, expr] of Object.entries(spec.collect ?? {})) action.collect[arg] = [evaluate(expr, env)];
    action.triggers = [stepId];
    return action;
  }
  if (kind === "rewrite") {
    const ops: Record<string, Record<string, unknown>> = {};
    for (const op of ["set", "append", "remove"]) if (op in spec) ops[op] = evaluate(spec[op], env) as Record<string, unknown>;
    const parts = Object.entries(ops).flatMap(([op, values]) => Object.entries(values).map(([arg, v]) => `${op}.${arg}=${display(v)}`));
    const action = new Action(`rewrite:${stepId}:${canonical(ops)}`, kind, `rewrite:${stepId}:${parts.join(";")}`, costs);
    action.title = render(spec.title ?? "", env);
    action.ops = ops;
    action.triggers = [stepId];
    return action;
  }
  if (kind === "move_after") {
    const anchors: string[] = Array.isArray(spec.tool) ? spec.tool : [spec.tool];
    const action = new Action(`move:${stepId}`, kind, `move:${stepId}>after:${anchors.join("|")}`, costs);
    action.anchors = anchors;
    action.triggers = [stepId];
    return action;
  }
  const text = render(isPlainObject(spec) ? String(spec.text ?? finding.message) : String(spec), env);
  const action = new Action(`${kind}:${finding.key}`, kind, `${kind}:${finding.key}`, costs);
  action.text = text;
  action.triggers = [stepId];
  return action;
}

function merge(target: Action, action: Action): void {
  for (const t of action.triggers) if (!target.triggers.includes(t)) target.triggers.push(t);
  for (const [arg, values] of Object.entries(action.collect)) {
    const bucket = (target.collect[arg] ??= []);
    for (const v of values) if (!bucket.some((x) => equals(v, x))) bucket.push(v);
  }
}

const asList = (v: unknown): unknown[] => (v === MISSING || v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
const argOf = (step: Step, name: string): unknown => (Object.prototype.hasOwnProperty.call(step.args, name) ? step.args[name] : MISSING);

/** 在一步上记一笔修补的摘要 */
const patch = (step: Step, digest: string) => ((step.patches ??= []) as string[]).push(digest);

/** 按动作修补一份计划（返回副本）：先改写，再调顺序，最后插入 */
export function applyActions(steps: Step[], actions: Action[]): Step[] {
  const result = clone(steps);
  const byId = (id: string) => result.find((s) => s.id === id) as Step;

  for (const action of actions.filter((a) => a.kind === "rewrite")) {
    const step = byId(action.triggers[0]!);
    for (const [arg, v] of Object.entries(action.ops.set ?? {})) step.args[arg] = v;
    for (const [arg, v] of Object.entries(action.ops.append ?? {})) {
      let items = asList(argOf(step, arg));
      if (!items.some((x) => equals(v, x))) items = [...items, v];
      step.args[arg] = items;
    }
    for (const [arg, v] of Object.entries(action.ops.remove ?? {})) step.args[arg] = asList(argOf(step, arg)).filter((x) => !equals(x, v));
    patch(step, action.summary);
  }

  // 后面的步骤先挪，挪过的步骤保持原来的相对顺序
  for (const action of actions.filter((a) => a.kind === "move_after").toReversed()) {
    const step = byId(action.triggers[0]!);
    const index = result.indexOf(step);
    const anchors = result.flatMap((s, i) => (s !== step && action.anchors.includes(s.tool) ? [i] : []));
    if (!anchors.length) continue;
    const target = Math.max(...anchors);
    const anchorId = result[target]!.id;
    if (index < target) {
      result.splice(index, 1);
      result.splice(target, 0, step);
    }
    if (!step.after.includes(anchorId)) step.after.push(anchorId);
    patch(step, action.summary);
  }

  const taken = new Set(result.map((s) => s.id));
  let counter = 1;
  for (const action of actions.filter((a) => a.kind === "insert")) {
    while (taken.has(`p${counter}`)) counter++;
    const newId = `p${counter++}`;
    taken.add(newId);
    const positions = result.flatMap((s, i) => (action.triggers.includes(s.id) ? [i] : []));
    const newStep: Step = {
      id: newId,
      title: action.title,
      tool: action.tool as string,
      args: { ...clone(action.args), ...clone(action.collect) },
      after: [],
      inserted: true,
    };
    if (action.position === "after") {
      let index = Math.max(...positions) + 1;
      while (index < result.length && result[index]!.inserted && result[index]!.after.some((a) => action.triggers.includes(a))) index++;
      result.splice(index, 0, newStep);
      newStep.after = [...action.triggers];
    } else {
      result.splice(Math.min(...positions), 0, newStep);
      for (const id of action.triggers) byId(id).after.push(newId);
    }
  }
  return result;
}

export function applyBinds(steps: Step[], binds: any[], env: Env): [Step[], Array<Record<string, unknown>>] {
  const result = clone(steps);
  const changes: Array<Record<string, unknown>> = [];
  for (const bind of binds) {
    for (const step of result) {
      if (step.tool !== bind.tool) continue;
      const current = argOf(step, bind.arg);
      if (current !== MISSING && !isUnknown(current)) continue;
      const value = evaluate(bind.value, { ...env, current: step, step });
      if (deepKnown(value)) {
        step.args[bind.arg] = value;
        changes.push({ step: step.id, arg: bind.arg, value: toJson(value) });
      }
    }
  }
  return [result, changes];
}

export function quantity(steps: Step[], spec: any, env: Env): unknown {
  let total = 0;
  for (const step of steps) {
    const expr = spec.per_step?.[step.tool];
    if (expr === undefined) continue;
    const v = evaluate(expr, { ...env, current: step, step });
    if (isUnknown(v) || v === MISSING) return new Unknown("quantity");
    if (!isNumber(v)) throw new SpecError(`quantity value is not a number: ${String(v)}`);
    total += v;
  }
  return total;
}

function goalForm(goal: Goal, env: Env): GoalForm {
  const expr = goal.expr;
  if (isPlainObject(expr) && Object.keys(expr).length === 1) {
    const [op, operands] = Object.entries(expr)[0]!;
    if (LINEAR_OPS.has(op) && Array.isArray(operands) && isPlainObject(operands[0]) && "quantity" in operands[0]) {
      const rhs = evaluate(operands[1], env);
      if (!isNumber(rhs)) return ["const", null];
      return ["linear", String(operands[0].quantity), op, rhs];
    }
  }
  const v = test(expr, env);
  return ["const", v === true || v === false ? v : null];
}

export const planEnv = (base: Env, plan: Plan, steps: Step[]): Env => ({ ...base, plan: { goal: plan.goal ?? null, steps } });

export function candidateAssignments(scenario: Scenario, env: Env): Array<[Env, Record<string, string>]> {
  const domains: Array<[Record<string, unknown>, unknown[]]> = [];
  for (const choice of scenario.choices ?? []) {
    if ("when" in choice && test(choice.when, env) !== true) continue;
    const fixed = "fixed" in choice ? evaluate(choice.fixed, env) : MISSING;
    const rows = isPlainObject(fixed) ? [fixed] : (evaluate(choice.domain, env) as unknown[]);
    domains.push([choice, rows]);
  }
  let combos: unknown[][] = [[]];
  for (const [, rows] of domains) combos = combos.flatMap((c) => rows.map((r) => [...c, r]));
  return combos.map((combo) => {
    const assignment: Env = {};
    domains.forEach(([choice], i) => {
      assignment[String(choice.var)] = combo[i];
    });
    const scoped = { ...env, ...assignment };
    const label: Record<string, string> = {};
    for (const [choice] of domains) label[String(choice.var)] = display(evaluate(choice.label ?? `$${String(choice.var)}`, scoped));
    return [assignment, label];
  });
}

export function buildProblem(scenario: Scenario, plan: Plan, extraGoals: Goal[] = []): Problem {
  const goals: Goal[] = [...(scenario.default_goals ?? []), ...extraGoals];
  const steps0 = normalizePlan(plan, scenario);
  const base: Env = { facts: scenario.facts ?? {} };
  const candidates: Candidate[] = candidateAssignments(scenario, planEnv(base, plan, steps0)).map(([assignment, label], index) => {
    const [steps, bindChanges] = applyBinds(steps0, scenario.binds ?? [], planEnv({ ...base, ...assignment }, plan, steps0));
    const env = planEnv({ ...base, ...assignment }, plan, steps);
    const findings = check(steps, scenario, "plan", env);
    const violations = findings.filter((f) => f.status === "violated");
    const actions = new Map<string, Action>();
    const options: string[][][] = [];
    for (const finding of violations) {
      const keys: string[][] = [];
      for (const option of finding.rule.repairs ?? []) {
        const action = instantiate(option, finding);
        const existing = actions.get(action.key);
        if (existing) merge(existing, action);
        else actions.set(action.key, action);
        const stored = actions.get(action.key) as Action;
        if (!stored.covers.includes(finding.key)) stored.covers.push(finding.key);
        keys.push([action.key]);
      }
      options.push(keys);
    }
    const quantities: Record<string, unknown> = scenario.quantities ?? {};
    const baseQ: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(quantities)) baseQ[name] = quantity(steps, spec, env);
    const delta = new Map<string, Record<string, unknown>>();
    for (const [key, action] of actions) {
      const patched = applyActions(steps, [action]);
      const patchedEnv = planEnv(env, plan, patched);
      const d: Record<string, unknown> = {};
      for (const [name, spec] of Object.entries(quantities)) {
        const after = quantity(patched, spec, patchedEnv);
        d[name] = isUnknown(after) || isUnknown(baseQ[name]) ? new Unknown() : (after as number) - (baseQ[name] as number);
      }
      delta.set(key, d);
    }
    const goalForms: Record<string, GoalForm> = {};
    for (const goal of goals) goalForms[goal.id] = goalForm(goal, env);
    return {
      index,
      assignment,
      label,
      steps,
      bindChanges,
      env,
      violations,
      unknowns: findings.filter((f) => f.status === "unknown"),
      actions,
      options,
      base: baseQ,
      delta,
      goals: goalForms,
    };
  });
  const objective = ((scenario.objective ?? []) as Array<Record<string, string>>).flatMap((item) => Object.entries(item)) as Array<[string, string]>;
  return { scenario, plan, goals, candidates, objective };
}

// ───────────────────────── 两种求解共用的 ─────────────────────────

export function usedActions(c: Candidate, selection: number[]): string[] {
  const keys = new Set<string>();
  c.options.forEach((options, j) => {
    for (const k of options[selection[j]!]!) keys.add(k);
  });
  return [...c.actions.keys()].filter((k) => keys.has(k));
}

export function quantityValues(c: Candidate, keys: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, b] of Object.entries(c.base)) {
    if (isUnknown(b) || keys.some((k) => isUnknown((c.delta.get(k) as Record<string, unknown>)[name]))) values[name] = new Unknown();
    else values[name] = keys.reduce((s, k) => s + ((c.delta.get(k) as Record<string, unknown>)[name] as number), b as number);
  }
  return values;
}

export function compareOp(value: number, op: string, rhs: number): boolean {
  return { ge: value >= rhs, le: value <= rhs, gt: value > rhs, lt: value < rhs, eq: value === rhs }[op] as boolean;
}

export function goalHolds(c: Candidate, goalId: string, values: Record<string, unknown>): boolean | null {
  const form = c.goals[goalId]!;
  if (form[0] === "const") return form[1];
  const v = values[form[1]];
  return isUnknown(v) ? null : compareOp(v as number, form[2], form[3]);
}

export function objectiveVector(problem: Problem, c: Candidate, selection: number[], penalty: number): number[] {
  const keys = usedActions(c, selection);
  const totals = COSTS.map((name) => keys.reduce((s, k) => s + ((c.actions.get(k) as Action).costs[name] ?? 0), 0));
  const values = quantityValues(c, keys);
  const extra = problem.objective.map(([sense, name]) => {
    const v = isUnknown(values[name]) ? 0 : (values[name] as number);
    return sense === "minimize" ? v : -v;
  });
  return [penalty, ...totals, ...extra, c.index, ...selection];
}

export function lessThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return a.length < b.length;
}

// ───────────────────────── 收尾 ─────────────────────────

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function finalize(problem: Problem, solution: Solution, core: string[] | null): Record<string, unknown> {
  const c = problem.candidates[solution.candidate]!;
  const actions = usedActions(c, solution.selection).map((k) => c.actions.get(k) as Action);
  const patched = applyActions(c.steps, actions);
  const { plan: _drop, ...rest } = c.env;
  const env = planEnv(rest, problem.plan, patched);
  const recheck = check(patched, problem.scenario, "plan", env);
  // 交给用户（confirm）或退回模型（replan）的违规不指望消失
  const handedOff = new Set(actions.filter((a) => a.kind === "confirm" || a.kind === "replan").flatMap((a) => a.covers));
  const remaining = recheck.filter((f) => f.status === "violated" && !handedOff.has(f.key));
  const values: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(problem.scenario.quantities ?? {})) values[name] = quantity(patched, spec, env);
  let verified = remaining.length === 0;
  const goalRows = problem.goals.map((goal) => {
    const form = goalForm(goal, env);
    let satisfied: boolean | null;
    if (form[0] === "const") satisfied = form[1];
    else satisfied = isUnknown(values[form[1]]) ? null : compareOp(values[form[1]] as number, form[2], form[3]);
    if (solution.keptGoals.includes(goal.id) && satisfied === false) verified = false;
    return { id: goal.id, title: goal.title ?? goal.id, hard: goal.hard ?? true, satisfied };
  });
  let status: string;
  if (actions.some((a) => a.kind === "replan")) status = "needs_replan";
  else if (solution.relaxed || actions.some((a) => (a.costs.interaction ?? 0) > 0)) status = "needs_confirmation";
  else if (actions.length || c.bindChanges.length) status = "patched";
  else status = "pass";
  const cost: Record<string, unknown> = {};
  for (const name of COSTS) cost[name] = actions.reduce((s, a) => s + (a.costs[name] ?? 0), 0);
  for (const [k, v] of Object.entries(values)) cost[k] = isUnknown(v) ? toJson(v) : round6(v as number);
  return {
    status,
    verified,
    choice: c.label,
    violations: c.violations.map((f) => f.toDict()),
    deferred: recheck.filter((f) => f.status === "unknown").map((f) => f.toDict()),
    remaining: remaining.map((f) => f.toDict()),
    actions: actions.map((a) => a.toDict()),
    bind_changes: c.bindChanges,
    patched_plan: { goal: problem.plan.goal ?? null, steps: toJson(patched) },
    goals: goalRows,
    conflict: solution.relaxed ? { core, relaxed: problem.goals.filter((g) => (g.hard ?? true) && !solution.keptGoals.includes(g.id)).map((g) => g.id) } : null,
    cost,
    confirmations: actions.filter((a) => a.kind === "confirm").map((a) => a.text),
    replans: actions.filter((a) => a.kind === "replan").map((a) => a.text),
    kinds: [...new Set(actions.map((a) => a.kind))].toSorted(),
  };
}

function blockedResult(problem: Problem, reason: string): Record<string, unknown> {
  const unique = new Map<string, Finding>();
  for (const c of problem.candidates) for (const f of c.violations) if (!(f.rule.repairs ?? []).length) unique.set(f.key, f);
  return {
    status: "blocked",
    verified: false,
    reason,
    choice: {},
    violations: [...unique.values()].map((f) => f.toDict()),
    deferred: [],
    remaining: [],
    actions: [],
    bind_changes: [],
    patched_plan: null,
    goals: [],
    conflict: null,
    cost: {},
    confirmations: [],
    replans: [],
    kinds: [],
  };
}

export async function review(scenario: Scenario, plan: Plan, goals: Goal[] | undefined, backend: Backend): Promise<Record<string, unknown>> {
  const problem = buildProblem(scenario, plan, goals ?? []);
  if (!problem.candidates.length) return blockedResult(problem, "no candidate value for the plan's choices");
  const blocked: Blocked = [];
  let core: string[] | null = null;
  let relaxed = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const solution = await backend.solve(problem, relaxed, blocked);
    if (solution === null && !relaxed) {
      core = await backend.unsatCore(problem, blocked);
      if (!core.length) return blockedResult(problem, "violations cannot be repaired");
      relaxed = true;
      continue;
    }
    if (solution === null) return blockedResult(problem, "no repair satisfies the goals, even relaxed");
    const result = finalize(problem, solution, core);
    if (result.verified) return result;
    blocked.push([solution.candidate, solution.selection]);
  }
  return blockedResult(problem, "no verified repair within the attempt limit");
}

/** 和求解器无关的摘要：测试和交叉核对用 */
export function summary(result: any) {
  return {
    status: result.status,
    choice: result.choice,
    violations: result.violations.map((v: { key: string }) => v.key).toSorted(),
    deferred: result.deferred.map((v: { key: string }) => v.key).toSorted(),
    actions: result.actions.map((a: { summary: string }) => a.summary).toSorted(),
    conflict: result.conflict,
  };
}
