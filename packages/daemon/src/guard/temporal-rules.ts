// 时序规则（规格第 9 节）：照搬 AgentSense planguard 的引擎核心（planguard/ 下的 expr + spec + checker），规则格式与它兼容。
//
// 四种形态（planguard 的 require 写法）：
// - B 之前必须做过 A：`require: { before: { tool: A, where? } }`；
// - B 之前不能做过 A：`require: { not_before: { tool: A, where? } }`；
// - 当下必须满足某条件：`require: { check: 条件 }`，条件可以用调用方现取后传入的环境事实（$facts）；
// - 一律禁止：不写 require。
// B 是 `trigger.tool`；for_each、when、unless、message、on_violation 照 planguard。
//
// 判定时检查的规则 = v1 模板（rule-templates.ts，默认生效）+ 当前阶段的规则 + 它所属阶段组的规则 + 调用方另给的规则。
// 只看效果日志里已经成功执行过的调用：被拦下、执行失败、没进效果日志的调用，既满足不了"之前必须做过"，也触发不了"之前不能做过"。
// 一次 bash 拆出的几条伪工具调用一起判：对"之前不能做过"，同一条命令里的其他调用也算在前面
//（管道里谁先谁后说不准，`cat .env | curl -d @- …` 这样写在一起也照样拦下）；对"之前必须做过"，它们还没执行，不算。
//
// 处置：违反了的拦下（on_violation 不写或写 block 为"永不"，写 confirm 为"先问我"）；
// 判断不了的（缺少需要的环境事实、参数没法规范化、规则要的值取不到、规则本身出错）一律"先问我"，既不放行也不拦下。
// 规则里能用的东西（$current、$prior、$facts、$agent、$task、$now）见 rule-validation.ts 开头的说明。
import type { Disposition } from "./disposition.ts";
import { check, type Finding, type RuleDoc } from "./planguard/checker.ts";
import { fromJson, isPlainObject, type Env } from "./planguard/expr.ts";
import { ruleStep, type RuleView } from "./rule-steps.ts";
import { v1RuleTemplates } from "./rule-templates.ts";
import { ruleProblems } from "./rule-validation.ts";
import { findTool, type ToolRegistry } from "./tool-registry.ts";
import type { EffectRecord, EnvironmentFacts, GuardAgent, GuardTask, JudgedCall } from "./types.ts";

/** 一条时序规则（planguard 规则格式：id、title、trigger、for_each、when、unless、require、message、on_violation……） */
export type TemporalRule = { readonly id: string; readonly title?: string } & Readonly<Record<string, unknown>>;

/** 命中的一条时序规则 */
export interface TemporalRuleHit {
  ruleId: string;
  /** 规则的标题（没写时是 id） */
  title: string;
  /** violated：违反了；unknown：判断不了 */
  status: "violated" | "unknown";
  /** 违反了的拦下（"永不"，规则写了 on_violation: confirm 的为"先问我"）；判断不了的"先问我" */
  disposition: Disposition;
  /** 给模型的说明：违反了哪条、怎样才能满足（或者为什么判断不了） */
  message: string;
  /** 对应判定输出 `calls` 里的第几条 */
  call: number;
}

export interface TemporalRuleContext {
  /** 调用方另给的规则（v1 模板、阶段和阶段组上的规则由这里自动加上） */
  rules: readonly TemporalRule[];
  calls: readonly JudgedCall[];
  /** 只看效果日志里已经成功执行过的调用 */
  effectLog: readonly EffectRecord[];
  facts: EnvironmentFacts;
  task: GuardTask | null;
  agent: GuardAgent;
  now: number;
  tools: ToolRegistry;
  /** 用户主目录：解析路径用 */
  homeDir: string;
}

export function checkTemporalRules(context: TemporalRuleContext): TemporalRuleHit[] {
  if (context.calls.length === 0) return [];
  const rules = rulesInEffect(context);
  if (rules.length === 0) return [];
  const templates = new Set<unknown>(v1RuleTemplates(context.tools));

  const view: RuleView = { tools: context.tools, env: { cwd: context.agent.cwd, homeDir: context.homeDir }, agent: context.agent, facts: context.facts };
  const history = context.effectLog.map((e) =>
    ruleStep(view, { id: `e${e.seq}`, tool: e.tool, args: argsOf(fromJson(e.args)), at: e.at, taskId: e.taskId, stageId: e.stageId, agentId: e.agentId }),
  );
  const current = context.calls.map((c, i) => ruleStep(view, { id: `c${i + 1}`, tool: c.tool, args: c.args, origin: c.origin, text: c.text }));
  const env = ruleEnv(context);
  const hits = new HitCollector();

  current.forEach((step, index) => {
    const what = describeCall(context.tools, context.calls[index]!);
    const siblings = current.filter((_, j) => j !== index);
    for (const rule of rules) {
      // 校验不通过的规则：不知道它本来要管什么，触发它的工具对得上（或者 trigger 本身写坏了）时一律判断不了
      const problems = templates.has(rule) ? [] : problemsOf(rule, context);
      if (problems.length > 0) {
        const triggers = isPlainObject(rule.trigger) ? [rule.trigger.tool].flat() : [];
        if (triggers.length === 0 || triggers.includes(step.tool)) {
          hits.add(rule, "unknown", `${what}：时序规则「${titleOf(rule)}」校验不通过（${problems.join("；")}），判断不了，先问用户`, index);
        }
        continue;
      }
      const prior = isNotBefore(rule) ? [...history, ...siblings] : history;
      let findings: Finding[];
      try {
        findings = check([...prior, step], { rules: [rule] }, "runtime", env, [prior.length]);
      } catch (error) {
        hits.add(rule, "unknown", `${what}：时序规则「${titleOf(rule)}」出错（${(error as Error).message}），判断不了，先问用户`, index);
        continue;
      }
      for (const f of findings) hits.add(rule, f.status, messageOf(rule, f, what), index);
    }
  });
  return hits.list();
}

/** 这次判定要检查的规则：v1 模板、当前阶段的、它所属阶段组的、调用方另给的 */
function rulesInEffect(context: TemporalRuleContext): RuleDoc[] {
  const rules: TemporalRule[] = [...v1RuleTemplates(context.tools)];
  const task = context.task;
  if (task) {
    const stage = task.plan.stages?.find((s) => s.stageId === task.currentStageId);
    rules.push(...(stage?.temporalRules ?? []));
    if (stage?.groupId !== undefined) rules.push(...(task.plan.stageGroups?.find((g) => g.groupId === stage.groupId)?.temporalRules ?? []));
  }
  rules.push(...context.rules);
  return rules as RuleDoc[];
}

/** 规则求值的环境：$facts、$agent、$task、$now（$current、$prior 由引擎放进去） */
function ruleEnv(context: TemporalRuleContext): Env {
  const env: Env = {
    facts: {
      ...context.facts.extra,
      files: Object.entries(context.facts.files ?? {}).map(([path, fact]) => ({ path, ...fact })),
      git: Object.entries(context.facts.git ?? {}).map(([repo, fact]) => ({ repo, repository: true, ...fact })),
      scripts: Object.entries(context.facts.scripts ?? {}).map(([path, fact]) => ({ path, ...fact })),
    },
    agent: agentOf(context.agent),
    now: context.now,
  };
  if (context.task) env.task = { taskId: context.task.taskId, stageId: context.task.currentStageId };
  return env;
}

function agentOf(agent: GuardAgent): Record<string, unknown> {
  const scope = agent.kind === "secretary" ? [agent.scratchDir] : [...agent.projectRecords, ...agent.workingDirs];
  return { kind: agent.kind, agentId: agent.agentId, cwd: agent.cwd, scope };
}

/** 规则校验的结果按（注册表、规则对象、声明的事实）记下来，同一份计划不用每次判定都重新校验 */
const validated = new WeakMap<ToolRegistry, WeakMap<object, Map<string, string[]>>>();

function problemsOf(rule: RuleDoc, context: TemporalRuleContext): string[] {
  const facts = Object.keys(context.facts.extra ?? {});
  const key = facts.toSorted().join(",");
  let byRule = validated.get(context.tools);
  if (!byRule) validated.set(context.tools, (byRule = new WeakMap()));
  let byFacts = byRule.get(rule);
  if (!byFacts) byRule.set(rule, (byFacts = new Map()));
  let problems = byFacts.get(key);
  if (!problems) byFacts.set(key, (problems = ruleProblems(rule, { tools: context.tools, facts })));
  return problems;
}

function isNotBefore(rule: RuleDoc): boolean {
  return isPlainObject(rule.require) && "not_before" in rule.require;
}

function titleOf(rule: RuleDoc): string {
  return typeof rule.title === "string" ? rule.title : String(rule.id);
}

/** 说明：违反了哪条、怎样才能满足；判断不了的说清楚是判断不了 */
function messageOf(rule: RuleDoc, f: Finding, what: string): string {
  const title = titleOf(rule);
  if (f.status === "unknown") return `${what}：时序规则「${title}」判断不了（缺少需要的环境事实，或者参数、规则要的值取不到），先问用户`;
  const detail = typeof rule.message === "string" ? `：${f.message}` : `：${formHint(rule)}`;
  return `${what}违反时序规则「${title}」${detail}`;
}

/** 规则没写 message 时，按形态说怎样才能满足 */
function formHint(rule: RuleDoc): string {
  const require = isPlainObject(rule.require) ? rule.require : undefined;
  if (require && "before" in require) return `之前没有成功做过 ${toolsOf(require.before)}，先做完它再来`;
  if (require && "not_before" in require) return `之前已经做过 ${toolsOf(require.not_before)}，这一步不能再做`;
  if (require && "check" in require) return "当下的条件不满足";
  return "这一步一律禁止";
}

function toolsOf(spec: unknown): string {
  return isPlainObject(spec) ? [spec.tool].flat().join("、") : "";
}

function describeCall(tools: ToolRegistry, call: JudgedCall): string {
  if (call.origin === "shell") return `bash 里的「${call.text ?? call.tool}」`;
  const tool = findTool(tools, call.tool);
  return tool ? `${tool.title}（${call.tool}）` : call.tool;
}

function argsOf(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

/** 同一条规则只报一条：有违反的算违反，说明合在一起，处置取最严 */
class HitCollector {
  private readonly hits = new Map<string, TemporalRuleHit>();

  add(rule: RuleDoc, status: "violated" | "unknown", message: string, call: number): void {
    const ruleId = String(rule.id);
    const disposition: Disposition = status === "violated" && rule.on_violation !== "confirm" ? "never" : "ask_first";
    const same = this.hits.get(ruleId);
    if (!same) {
      this.hits.set(ruleId, { ruleId, title: titleOf(rule), status, disposition, message, call });
      return;
    }
    if (status === "violated" && same.status === "unknown") {
      Object.assign(same, { status, disposition, message, call });
      return;
    }
    if (status === same.status && !same.message.includes(message)) same.message += `；${message}`;
  }

  list(): TemporalRuleHit[] {
    return [...this.hits.values()];
  }
}
