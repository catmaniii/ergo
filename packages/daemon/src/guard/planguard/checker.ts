// planguard 的过去时规则检查：照搬 AgentSense `web/src/agent/planguard/checker.ts`（来源和哈希见同目录 VERSION），语义不改。
// 对一串步骤里选中的每一步，套上触发它的规则：for_each 展开、when / unless 过滤、require 判定（before / not_before / check，
// 没有 require 就是一律禁止），违反或判断不了的记成一条 Finding。
import { type Env, MISSING, type Tri, UNKNOWN, Unknown, display, evaluate, render, test } from "./expr.ts";
import type { Scenario } from "./spec.ts";

/** 一步：工具名、参数，以及调用方附带的其他字段 */
export type Step = { id: string; tool: string; args: Record<string, unknown>; [k: string]: unknown };

/** 一条规则，自由形式的 JSON */
export type RuleDoc = Record<string, any>;

const triAnd = (...values: Tri[]): Tri => (values.some((v) => v === false) ? false : values.some((v) => v !== true) ? UNKNOWN : true);
const triNot = (v: Tri): Tri => (v instanceof Unknown ? UNKNOWN : !v);

export class Finding {
  readonly rule: RuleDoc;
  readonly index: number;
  readonly step: Step;
  readonly status: "violated" | "unknown";
  readonly bindings: Env;
  readonly env: Env;
  readonly message: string;
  readonly label: string;

  constructor(rule: RuleDoc, index: number, step: Step, status: "violated" | "unknown", bindings: Env, env: Env, message: string, label: string) {
    this.rule = rule;
    this.index = index;
    this.step = step;
    this.status = status;
    this.bindings = bindings;
    this.env = env;
    this.message = message;
    this.label = label;
  }

  get ruleId(): string {
    return this.rule.id;
  }

  get key(): string {
    return `${this.ruleId}@${this.step.id}${this.label ? `[${this.label}]` : ""}`;
  }

  toDict() {
    return { rule: this.ruleId, step: this.step.id, status: this.status, message: this.message, key: this.key };
  }
}

const tools = (spec: unknown): unknown[] => (Array.isArray(spec) ? spec : [spec]);

function requirement(require: any, env: Env, history: Step[]): Tri {
  if (require === undefined || require === null) return false;
  if ("check" in require) return test(require.check, env);
  const kind = "before" in require ? "before" : "not_before";
  const spec = require[kind];
  const names = tools(spec.tool);
  let found: Tri = false;
  for (const prior of history) {
    if (!names.includes(prior.tool)) continue;
    const v = test(spec.where ?? true, { ...env, prior });
    if (v === true) {
      found = true;
      break;
    }
    if (v !== false) found = UNKNOWN;
  }
  return kind === "before" ? found : triNot(found);
}

export function check(steps: Step[], scenario: Scenario, mode: "plan" | "runtime", baseEnv: Env, indices?: number[]): Finding[] {
  const selected = new Set(indices ?? steps.map((_, i) => i));
  const findings: Finding[] = [];
  steps.forEach((step, index) => {
    if (!selected.has(index)) return;
    const env: Env = { ...baseEnv, current: step };
    if (mode === "plan") env.step = step;
    else if (!("step" in env)) env.step = MISSING;
    for (const rule of scenario.rules ?? []) {
      if (!(rule.modes ?? ["plan", "runtime"]).includes(mode)) continue;
      if (!tools(rule.trigger.tool).includes(step.tool)) continue;
      if ("where" in rule.trigger && test(rule.trigger.where, env) !== true) continue;
      findings.push(...evaluateRule(rule, index, step, env, steps.slice(0, index)));
    }
  });
  return findings;
}

function evaluateRule(rule: RuleDoc, index: number, step: Step, env: Env, history: Step[]): Finding[] {
  let bindings: Array<[Env, string]> = [[{}, ""]];
  if ("for_each" in rule) {
    const spec = rule.for_each;
    const name: string = spec.var;
    let items = evaluate(spec.in, env);
    if (items instanceof Unknown) items = [UNKNOWN];
    else if (items === MISSING || items === null || items === undefined) items = [];
    bindings = (items as unknown[]).map((item, position) => {
      const key = "key" in spec ? evaluate(spec.key, { ...env, [name]: item }) : item;
      const text = key !== null && typeof key === "object" && !(key instanceof Unknown) && key !== MISSING ? `#${position}` : display(key);
      return [{ [name]: item }, `${name}=${text}`];
    });
  }
  const results: Finding[] = [];
  for (const [binding, label] of bindings) {
    const scoped = { ...env, ...binding };
    const when: Tri = "when" in rule ? test(rule.when, scoped) : true;
    if (when === false) continue;
    const unless: Tri = "unless" in rule ? test(rule.unless, scoped) : false;
    if (unless === true) continue;
    const holds = requirement(rule.require, scoped, history);
    const violated = triAnd(when, triNot(unless), triNot(holds));
    if (violated === false) continue;
    results.push(
      new Finding(rule, index, step, violated === true ? "violated" : "unknown", binding, scoped, render(rule.message ?? rule.title ?? rule.id, scoped), label),
    );
  }
  return results;
}
