// 流程计划的审查修补（58 号票，ADR 0019）：照 AgentSense 的 planguardReviewer.ts，计划交给用户授权之前先让 planguard 的
// 规划时审查（planguard/reviewer.ts + search.ts）看一遍——按规则找出违规，能修的地方给出修补（插一步、改写参数、调顺序），
// 修不了的退回维护者或判定不可执行。修补后的计划才是拿去请用户授权的那份。纯函数（不读文件、不看时钟）。
//
// 二狗在 AgentSense 的做法外面加的（引擎本身不动，ADR 0005 的口径）：
// - 规则 = 框架的 v1 模板（rule-templates.ts，默认生效）+ 维护者写进计划的规则。模板和计划规则都是 planguard 格式；
// - 计划里的一步交给引擎之前先变成规则看到的"一步"（rule-steps.ts 的 ruleStep：参数规范化，推出 paths、recipients、outward……），
//   和执行时同一种形式，所以同一条规则规划时、执行时判的是同一样东西；审查插入的步骤只有修补方案给的参数，没有推出来的字段；
// - 规划时不取环境事实（文件在不在、git 状态……）：要用到它们的规则判不了，推迟到执行时再查（AgentSense 的 deferred），
//   执行时守卫照常现取事实再判；
// - 规则没写修补方案（repairs）的，按违反时怎么办补一个：on_violation 写 pull_back 的（agent 自己能补救）退回维护者重写，
//   写 confirm 或不写的（先问我）交给用户确认，写 block 的（永不）没有修补——计划判定不可执行；
// - 时间预算比 AgentSense 宽（它是端侧 50 毫秒，这里默认 1 秒），超了一律"没审查"（skipped），不把整个流程卡死。
// 照 AgentSense 的 perRule 另把规则逐条单独扫一遍（同一个引擎、不重跑求解），记下每条花了多久、查出几处违反、几处判不了
// （rules），连同各阶段耗时（phases：编译规则、扫描求解、逐条复测；规划时不取事实，facts 恒为 0）。
// 另外给出每一步要满足的条件（触发它的规则）和规划时查出的结果，计划卡上逐步列出。
import { check } from "./planguard/checker.ts";
import { fromJson, isPlainObject, test, toJson, type Env } from "./planguard/expr.ts";
import { type Backend, review } from "./planguard/reviewer.ts";
import { searchBackend } from "./planguard/search.ts";
import { normalizePlan, prepareScenario, type Scenario } from "./planguard/spec.ts";
import { agentScope, type ShellEnv } from "./paths.ts";
import { ruleTitle, triggerTools, type RuleDoc } from "./rule-doc.ts";
import { ruleStep, type RuleView } from "./rule-steps.ts";
import { v1RuleTemplates } from "./rule-templates.ts";
import type { TemporalRule } from "./temporal-rules.ts";
import type { ToolRegistry } from "./tool-registry.ts";
import type { GuardAgent } from "./types.ts";
import { isUnknownArg } from "./workflow-steps.ts";

/** 审查的时间预算（毫秒）：纯搜索是穷举，违规一多组合数会炸，超了就不等了 */
export const WORKFLOW_REVIEW_BUDGET_MS = 1000;

/** 维护者起草的一步 */
export interface WorkflowDraftStep {
  id: string;
  title: string;
  tool: string;
  args?: Readonly<Record<string, unknown>>;
  after?: readonly string[];
}

/** 审查修补之后的一步：参数是交给维护者照着做的那版（没改过的参数照维护者写的） */
export interface ReviewedStep {
  id: string;
  title: string;
  tool: string;
  args: Record<string, unknown>;
  after: string[];
  /** 审查插进来的 */
  inserted?: true;
  /** 审查对这一步做的改写（引擎的摘要；给人看的说法在 actions 的 title） */
  patches?: string[];
}

export interface ReviewFinding {
  stepId: string;
  /** 规则 id */
  property: string;
  message: string;
  key?: string;
}

export interface ReviewAction {
  kind: string;
  title: string;
  covers: string[];
  stepId?: string;
  costs?: Record<string, number>;
}

export type ReviewStatus = "pass" | "patched" | "needs_confirmation" | "needs_replan" | "blocked";

/** 单条规则单独扫一遍的结果（AgentSense plan.ts 的 RuleProbe，另带规则的标题和来源） */
export interface RuleProbe {
  id: string;
  title: string;
  /** 框架的 v1 模板，还是计划里写的 */
  template: boolean;
  ms: number;
  violated: number;
  unknown: number;
  error?: string;
}

/** 审查结果（AgentSense plan.ts 的 PlanReviewResult 里二狗用到的部分） */
export interface WorkflowReviewOutcome {
  verdict: "pass" | "fail" | "skipped";
  status?: ReviewStatus;
  violations: ReviewFinding[];
  actions: ReviewAction[];
  confirmations: string[];
  deferred: ReviewFinding[];
  replans: string[];
  scanned: { rules: number; steps: number };
  /** 各阶段耗时（毫秒）：取事实（规划时不取，恒为 0）/ 编译规则 / 扫描求解 / 逐条复测 */
  phases?: { facts: number; compile: number; solve: number; probe: number };
  /** 逐条规则的耗时与各自的判定（原计划，没修补之前） */
  rules: RuleProbe[];
  ms: number;
  note?: string;
}

/** 一步要满足的一个条件，和规划时查出的结果 */
export interface StepCondition {
  ruleId: string;
  title: string;
  /** 框架的 v1 模板，还是计划里写的 */
  template: boolean;
  status: "pass" | "violated" | "unknown";
  /** 违反、判不了时规则给的说明 */
  message?: string;
}

export interface WorkflowReviewInput {
  goal: string;
  steps: readonly WorkflowDraftStep[];
  /** 计划里写的规则（已经过规则校验） */
  rules: readonly TemporalRule[];
  tools: ToolRegistry;
  /** 执行这份计划的 agent（守卫眼里的样子：工作目录、项目档案和工作目录）：参数里的相对路径按它的工作目录解析 */
  agent: GuardAgent;
  /** 用户主目录（展开 ~） */
  homeDir: string;
  /** 这次审查用了多久（调用方给的计时器；纯函数自己不看时钟） */
  elapsed?: () => number;
  /** 时间预算（毫秒），默认 WORKFLOW_REVIEW_BUDGET_MS */
  budgetMs?: number;
  /** 求解后端（测试用），默认纯搜索 */
  backend?: Backend;
}

export interface WorkflowReviewResult {
  review: WorkflowReviewOutcome;
  /** 修补后的步骤（没修补时就是原来的，补齐了 args、after）；判定不可执行、退回维护者时也是原来的 */
  steps: ReviewedStep[];
  /** 每一步要满足的条件（按 steps 的 id） */
  conditions: Record<string, StepCondition[]>;
}

class ReviewTimeout extends Error {}

/** 规则在规划时用的样子：没写修补方案的按违反时怎么办补一个（见文件开头） */
export function withDefaultRepairs(rule: TemporalRule): RuleDoc {
  const doc = rule as RuleDoc;
  if (Array.isArray(doc.repairs) && doc.repairs.length > 0) return doc;
  const text = typeof doc.message === "string" ? doc.message : `${ruleTitle(doc)}：步骤 {current.id} 不满足这条规则`;
  if (doc.on_violation === "block") return doc;
  if (doc.on_violation === "pull_back") return { ...doc, repairs: [{ replan: { text } }] };
  return { ...doc, repairs: [{ confirm: { text } }] };
}

/** 交给引擎的一步：规则看到的样子（JSON 形式："未知"写成 {"$unknown": …}，引擎读回来再变回去） */
function engineStep(view: RuleView, step: { id: string; title: string; tool: string; args: Readonly<Record<string, unknown>>; after: readonly string[] }): Record<string, unknown> {
  const ruled = ruleStep(view, { id: step.id, tool: step.tool, args: step.args });
  return toJson({ ...ruled, title: step.title, after: [...step.after] }) as Record<string, unknown>;
}

/**
 * 修补后的参数交回维护者的那版：原来的步骤里没被改写的参数照维护者写的（不换成规范化之后的绝对路径），
 * 改写过的取修补后的值；规范化时补上的（默认取工作目录的路径、推送补的 headCommit）和"未知"的不要
 * （去掉"未知"的口径同 workflow-steps.ts 的 plainArgs）
 */
function handBackArgs(original: Readonly<Record<string, unknown>> | undefined, normalized: Readonly<Record<string, unknown>> | undefined, patched: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(patched)) {
    const same = normalized !== undefined && Object.hasOwn(normalized, name) && JSON.stringify(normalized[name]) === JSON.stringify(value);
    if (same) {
      if (original && Object.hasOwn(original, name)) out[name] = original[name];
      continue;
    }
    if (isUnknownArg(value)) continue;
    if (Array.isArray(value)) {
      const kept = value.filter((v) => !isUnknownArg(v));
      if (kept.length > 0) out[name] = kept;
      continue;
    }
    out[name] = value;
  }
  // 原来就有、修补后被拿掉的参数（rewrite 的 remove 成了空数组之类）以修补后的为准；修补后没有的不补回
  return out;
}

/**
 * 逐条规则单独扫一遍（照 AgentSense planguardReviewer.ts 的 perRule）：引擎一次扫全部规则，拆不出单条耗时；
 * 这里把规则按条拆开各跑一次，用的是同一个引擎、同一份（空的）事实，不改引擎语义；求解不重跑
 */
function perRule(rules: readonly TemporalRule[], templates: readonly TemporalRule[], goal: string, steps: Array<Record<string, unknown>>, clock: () => number): RuleProbe[] {
  const out: RuleProbe[] = [];
  for (const original of rules) {
    const rule = withDefaultRepairs(original);
    const started = clock();
    let violated = 0;
    let unknown = 0;
    let error: string | undefined;
    try {
      const spec = prepareScenario({ rules: [rule], facts: {} });
      const normalized = normalizePlan({ goal, steps }, spec);
      for (const f of check(normalized, spec, "plan", { facts: spec.facts ?? {}, plan: { goal, steps: normalized } })) {
        if (f.status === "violated") violated++;
        else if (f.status === "unknown") unknown++;
      }
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
    }
    out.push({ id: String(rule.id), title: ruleTitle(rule), template: templates.includes(original), ms: round(clock() - started), violated, unknown, ...(error === undefined ? {} : { error }) });
  }
  return out;
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

export async function reviewWorkflow(input: WorkflowReviewInput): Promise<WorkflowReviewResult> {
  const elapsed = input.elapsed ?? (() => 0);
  const budget = input.budgetMs ?? WORKFLOW_REVIEW_BUDGET_MS;
  const env: ShellEnv = { cwd: input.agent.cwd, homeDir: input.homeDir };
  const view: RuleView = { tools: input.tools, env, agent: input.agent, facts: {} };
  const templates = v1RuleTemplates(input.tools);
  const rules = [...templates, ...input.rules];
  const original = input.steps.map((s) => ({ id: s.id, title: s.title, tool: s.tool, args: { ...s.args }, after: [...(s.after ?? [])] }));
  const engineSteps = original.map((s) => engineStep(view, s));
  const doc: Scenario = { rules: rules.map(withDefaultRepairs), facts: {} };
  const scanned = { rules: rules.length, steps: original.length };

  const started = elapsed();
  const t0 = elapsed();
  const guard = () => {
    if (elapsed() - started > budget) throw new ReviewTimeout();
  };
  const base = input.backend ?? searchBackend;
  const backend: Backend = {
    solve: (problem, relaxed, blocked) => {
      guard();
      return base.solve(problem, relaxed, blocked);
    },
    unsatCore: (problem, blocked) => {
      guard();
      return base.unsatCore(problem, blocked);
    },
  };
  const conditionsOf = (steps: ReviewedStep[]) => stepConditions(steps, rules, templates, view);

  let raw: Record<string, any>;
  let probes: RuleProbe[];
  let phases: WorkflowReviewOutcome["phases"];
  try {
    // 编译规则（和 review 里同一个 prepareScenario）：单独计一次，只为分出各阶段耗时
    prepareScenario(doc);
    const t1 = elapsed();
    raw = (await review(doc, { goal: input.goal, steps: engineSteps }, [], backend)) as Record<string, any>;
    const t2 = elapsed();
    probes = perRule(rules, templates, input.goal, engineSteps, elapsed);
    phases = { facts: 0, compile: round(t1 - t0), solve: round(t2 - t1), probe: round(elapsed() - t2) };
  } catch (error) {
    const ms = round(elapsed() - started);
    const note = error instanceof ReviewTimeout ? `审查超过 ${budget}ms 的预算` : `审查出错：${(error as Error)?.message ?? String(error)}`;
    return { review: { verdict: "skipped", violations: [], actions: [], confirmations: [], deferred: [], replans: [], scanned, rules: [], ms, note }, steps: original, conditions: conditionsOf(original) };
  }
  const ms = round(elapsed() - started);
  const status = String(raw.status) as ReviewStatus;
  const patched = raw.patched_plan as { steps: Array<Record<string, any>> } | null;
  const steps: ReviewedStep[] = patched
    ? patched.steps.map((s) => {
        const before = original.find((o) => o.id === s.id);
        const normalized = engineSteps.find((e) => e.id === s.id)?.args as Record<string, unknown> | undefined;
        return {
          id: String(s.id),
          title: String(s.title ?? s.tool),
          tool: String(s.tool),
          args: handBackArgs(before?.args, normalized, (s.args ?? {}) as Record<string, unknown>),
          after: Array.isArray(s.after) ? s.after.map(String) : [],
          ...(s.inserted ? { inserted: true as const } : {}),
          ...(Array.isArray(s.patches) && s.patches.length > 0 ? { patches: s.patches.map(String) } : {}),
        };
      })
    : original;
  return {
    review: {
      verdict: status === "pass" ? "pass" : "fail",
      status,
      violations: findings(raw.violations),
      actions: actions(raw.actions),
      confirmations: (raw.confirmations ?? []).map(String),
      deferred: findings(raw.deferred),
      replans: (raw.replans ?? []).map(String),
      scanned,
      ...(phases ? { phases } : {}),
      rules: probes,
      ms,
      ...(status === "blocked" ? { note: String(raw.reason ?? "") } : {}),
    },
    steps,
    conditions: conditionsOf(steps),
  };
}

const findings = (rows: Array<Record<string, unknown>> | undefined): ReviewFinding[] =>
  (rows ?? []).map((f) => ({
    stepId: String(f.step ?? ""),
    property: String(f.rule ?? ""),
    message: String(f.message ?? ""),
    // 引擎用这个 key 把违规和修补动作的 covers 对上
    ...(f.key ? { key: String(f.key) } : {}),
  }));

const actions = (rows: Array<Record<string, any>> | undefined): ReviewAction[] =>
  (rows ?? []).map((a) => ({
    kind: String(a.kind),
    title: String(a.title || a.text || a.summary || a.kind),
    covers: (a.covers ?? []).map(String),
    ...(a.step ? { stepId: String(a.step) } : {}),
    ...(a.costs ? { costs: a.costs as Record<string, number> } : {}),
  }));

/**
 * 每一步要满足的条件：触发它的规则（工具对得上、trigger.where 不是明确不成立的），每条在规划时查出的结果——
 * 满足、违反、判不了（推迟到执行时再查）。"之前"是计划里排在它前面的步骤
 */
export function stepConditions(steps: readonly ReviewedStep[], rules: readonly TemporalRule[], templates: readonly TemporalRule[], view: RuleView): Record<string, StepCondition[]> {
  const engineSteps = steps.map((s) => fromJson(engineStep(view, s)) as { id: string; tool: string; args: Record<string, unknown>; [k: string]: unknown });
  const env: Env = { facts: {}, agent: { kind: view.agent.kind, agentId: view.agent.agentId, cwd: view.agent.cwd, scope: agentScope(view.agent) }, plan: { steps: engineSteps } };
  const out: Record<string, StepCondition[]> = {};
  engineSteps.forEach((step, index) => {
    const list: StepCondition[] = [];
    for (const original of rules) {
      const rule = original as RuleDoc;
      if (!triggerTools(rule)?.includes(step.tool)) continue;
      if (isPlainObject(rule.trigger) && "where" in rule.trigger && whereOf(rule, step, env) === false) continue;
      let status: StepCondition["status"] = "pass";
      let message: string | undefined;
      try {
        for (const f of check(engineSteps, { rules: [rule] }, "plan", env, [index])) {
          if (f.status === "violated" || status === "pass") {
            status = f.status;
            message = f.message;
          }
        }
      } catch (error) {
        status = "unknown";
        message = `规则出错：${(error as Error).message}`;
      }
      list.push({ ruleId: String(rule.id), title: ruleTitle(rule), template: templates.includes(original), status, ...(message === undefined ? {} : { message }) });
    }
    out[step.id] = list;
  });
  return out;
}

/** trigger.where 对这一步成不成立（判不了的照样列出这条条件） */
function whereOf(rule: RuleDoc, step: Record<string, unknown>, env: Env): boolean | "unknown" {
  try {
    const value = test((rule.trigger as Record<string, unknown>).where, { ...env, current: step, step });
    return value === true || value === false ? value : "unknown";
  } catch {
    return "unknown";
  }
}
