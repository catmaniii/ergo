// planguard 的执行时监控（同步记录和哈希见同目录 VERSION）。
// 59 号票：流程执行时每次调用和已授权的计划比对（接入在 ../plan-monitor.ts）。
// 一次调用和计划比对出的问题：
// - off_plan：计划里没有这个工具的步骤（敏感的工具当场确认，别的只记下）；
// - forbidden：对象在审查时被明确排除在计划之外（拦下）；
// - out_of_scope：参数超出了计划声明的范围（当场确认）；
// - repeat：只许做一次的步骤又做了一次（拦下）；
// - out_of_order：对上的步骤依赖的前置步骤还没执行（当场确认）；
// - rule:<规则 id> / rule_unknown:<规则 id>：执行时的规则检查违反了、判断不了（这次加上已经成功执行过的调用一起判）。
// 173 号票：查出的问题的话走 t()（语义不改）；守护进程比对给 agent 的那一次在中文下做，判定的身份（findingKey）因此不随语言变
import { t } from "@ergo/protocol";
import { check } from "./checker.ts";
import { type Env, MISSING, fromJson, test } from "./expr.ts";
import { candidateAssignments } from "./reviewer.ts";
import { type Plan, type Scenario, type Step, normalizePlan } from "./spec.ts";

export type Verdict = "allow" | "confirm" | "block";
export type MonitorFinding = { kind: string; message: string; verdict: Verdict; step?: string };
const RANK: Record<Verdict, number> = { allow: 0, confirm: 1, block: 2 };

export class Monitor {
  readonly steps: Step[];
  private readonly scenario: Scenario;
  private readonly conformance: Record<string, any>;
  private readonly env: Env;
  private readonly trace: Step[] = [];
  private readonly done = new Map<string, number>();
  private readonly skipped = new Set<string>();

  constructor(scenario: Scenario, plan: Plan) {
    this.scenario = scenario;
    this.conformance = scenario.conformance ?? {};
    this.steps = normalizePlan(plan, scenario);
    this.env = { facts: scenario.facts ?? {}, plan: { goal: plan.goal ?? null, steps: this.steps } };
    const choices = candidateAssignments(scenario, this.env);
    if (choices.length === 1) Object.assign(this.env, choices[0]![0]);
  }

  check(tool: string, args: Record<string, unknown>): { verdict: Verdict; step: string | null; findings: MonitorFinding[] } {
    const call: Step = { id: `c${this.trace.length + 1}`, tool, args: fromJson({ ...args }) as Record<string, unknown>, after: [] };
    const findings: MonitorFinding[] = [];
    const sensitive = (this.conformance.sensitive ?? []).includes(tool);
    const sameTool = this.steps.filter((s) => s.tool === tool);
    let matched: Step | null = null;

    if (!sameTool.length) {
      findings.push({ kind: "off_plan", message: t("guard.planguard.offPlan", { tool }), verdict: sensitive ? "confirm" : "allow" });
    } else {
      const forbid = this.conformance.forbid?.[tool];
      if (forbid !== undefined && sameTool.some((s) => test(forbid, this.scope(call, s)) === true)) {
        findings.push({ kind: "forbidden", message: t("guard.planguard.forbidden"), verdict: "block" });
      }
      const within = this.conformance.within?.[tool];
      const inside = sameTool.filter((s) => within === undefined || test(within, this.scope(call, s)) === true);
      if (!inside.length) {
        findings.push({ kind: "out_of_scope", message: t("guard.planguard.outOfScope", { tool }), verdict: "confirm" });
      } else {
        matched = inside.find((s) => !this.done.get(s.id)) ?? inside[0]!;
        if ((this.conformance.once ?? []).includes(tool) && this.done.get(matched.id)) {
          findings.push({ kind: "repeat", message: t("guard.planguard.repeat", { step: matched.id }), verdict: "block" });
        }
        const missing = matched.after.filter((d) => !this.done.get(d) && !this.skipped.has(d));
        if (missing.length) {
          findings.push({ kind: "out_of_order", message: t("guard.planguard.outOfOrder", { step: matched.id, missing: missing.join(", ") }), verdict: "confirm" });
        }
      }
    }

    const sequence = [...this.trace, call];
    const env = { ...this.env, step: matched ?? MISSING };
    for (const f of check(sequence, this.scenario, "runtime", env, [sequence.length - 1])) {
      const verdict: Verdict = f.status === "violated" ? (f.rule.on_violation ?? "confirm") : "confirm";
      findings.push({ kind: `${f.status === "violated" ? "rule" : "rule_unknown"}:${f.ruleId}`, message: f.message, verdict });
    }
    const verdict = findings.reduce<Verdict>((best, f) => (RANK[f.verdict] > RANK[best] ? f.verdict : best), "allow");
    return { verdict, step: matched?.id ?? null, findings };
  }

  commit(tool: string, args: Record<string, unknown>, step: string | null): void {
    this.trace.push({ id: `c${this.trace.length + 1}`, tool, args: fromJson({ ...args }) as Record<string, unknown>, after: [], step });
    if (step !== null) this.done.set(step, (this.done.get(step) ?? 0) + 1);
  }

  skip(step: string): void {
    this.skipped.add(step);
  }

  end(): MonitorFinding[] {
    return this.steps
      .filter((s) => !this.done.get(s.id) && !this.skipped.has(s.id))
      .map((s) => ({ kind: "skipped", message: t("guard.planguard.skipped", { step: s.id, title: s.title ?? s.tool }), verdict: "confirm", step: s.id }));
  }

  private scope(call: Step, step: Step): Env {
    return { ...this.env, call, step };
  }
}
