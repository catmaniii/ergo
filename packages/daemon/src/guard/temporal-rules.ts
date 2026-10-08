// 时序规则（规格第 9 节）：照搬 AgentSense planguard 的引擎核心（planguard/ 下的 expr + spec + checker），规则格式与它兼容。
//
// 四种形态（planguard 的 require 写法，见 rule-doc.ts 的 ruleForm）：
// - B 之前必须做过 A：`require: { before: { tool: A, where? } }`；
// - B 之前不能做过 A：`require: { not_before: { tool: A, where? } }`；
// - 当下必须满足某条件：`require: { check: 条件 }`，条件可以用调用方现取后传入的环境事实（$facts）；
// - 一律禁止：不写 require。
// B 是 `trigger.tool`；for_each、when、unless、message、on_violation 照 planguard。
//
// 判定时检查的规则 = v1 模板（rule-templates.ts，默认生效）+ 当前阶段的规则 + 它所属阶段组的规则 + 调用方另给的规则。
// "之前"的范围：
// - 只看效果日志里已经成功执行过的调用：被拦下、执行失败、没进效果日志的调用，既满足不了"之前必须做过"，也触发不了"之前不能做过"；
// - 效果日志按范围过滤：任务里只看同一个任务的；不属于任务的只看同一个 agent、同一段会话的；
// - 一次 bash 拆出的几条调用一起判：对"之前不能做过"，同一条命令里真正可能在前面执行的也算（`a && b`、`a; b` 里的 a，
//   同一条管道或同一条简单命令里的其他调用，见 shell/split.ts 的 mayRunBefore）；对"之前必须做过"，它们还没执行，不算。
//
// 违反了怎么办（rule-doc.ts 的 violationOutcome）：on_violation 写 block 为"永不"，写 pull_back 为"按规则退回"
// （不是处置的一档，判定输出单列），写 confirm 或不写为"先问我"。
// 判断不了的（缺少需要的环境事实、参数没法规范化、规则要的值取不到、规则求值出错、规则校验不通过）一律"先问我"，
// 既不放行也不拦下。和 planguard 不同，trigger.where 判断不了时也算判断不了，不当成不触发。
// 规则里能用的东西（$current、$prior、$facts、$agent、$task、$now）见 rule-validation.ts 开头的说明。
import type { Disposition } from "./disposition.ts";
import type { ShellEnv } from "./paths.ts";
import { check, type Finding } from "./planguard/checker.ts";
import { MISSING, fromJson, isPlainObject, test, type Env } from "./planguard/expr.ts";
import { ruleForm, ruleTitle, toolList, triggerTools, violationOutcome, type RuleDoc } from "./rule-doc.ts";
import { ruleEnv } from "./rule-env.ts";
import { installErgouOps } from "./rule-ops.ts";
import { ruleStep, type RuleStep, type RuleView } from "./rule-steps.ts";
import { v1RuleTemplates } from "./rule-templates.ts";
import { ruleProblems } from "./rule-validation.ts";
import { mayRunBefore } from "./shell/split.ts";
import { describeCall, findTool, type ToolRegistry } from "./tool-registry.ts";
import type { EffectRecord, EnvironmentFacts, GuardAgent, GuardTask, JudgedCall } from "./types.ts";

// 规则求值之前，先把二狗的扩展运算（path_within）注册进引擎
installErgouOps();

/** 一条时序规则（planguard 规则格式：id、title、trigger、for_each、when、unless、require、message、on_violation……） */
export type TemporalRule = { readonly id: string; readonly title?: string } & Readonly<Record<string, unknown>>;

/** 命中的一条时序规则 */
export interface TemporalRuleHit {
  ruleId: string;
  /** 规则的标题（没写时是 id） */
  title: string;
  /** violated：违反了；unknown：判断不了 */
  status: "violated" | "unknown";
  /**
   * 结果：pull_back 是按规则退回（判定输出的 pullBack），否则是一档处置——违反了的看 on_violation（block 为"永不"，
   * 写 confirm 或不写为"先问我"），判断不了的一律"先问我"
   */
  outcome: "pull_back" | Disposition;
  /** 给模型的说明：违反了哪条、怎样才能满足（或者为什么判断不了） */
  message: string;
  /** 对应判定输出 `calls` 里的第几条 */
  call: number;
}

export interface TemporalRuleContext {
  /** 调用方另给的规则（v1 模板、阶段和阶段组上的规则由这里自动加上） */
  rules: readonly TemporalRule[];
  calls: readonly JudgedCall[];
  /** 效果日志：只看执行成功过的调用，并按范围过滤（见 inScope） */
  effectLog: readonly EffectRecord[];
  facts: EnvironmentFacts;
  task: GuardTask | null;
  /** 不属于任务的调用所在的会话段 */
  segmentId?: string;
  agent: GuardAgent;
  now: number;
  tools: ToolRegistry;
  /** 解析路径的环境：agent 的工作目录和用户主目录 */
  env: ShellEnv;
}

export function checkTemporalRules(context: TemporalRuleContext): TemporalRuleHit[] {
  if (context.calls.length === 0) return [];
  const rules = rulesInEffect(context);
  const templates = new Set<unknown>(v1RuleTemplates(context.tools));

  const view: RuleView = { tools: context.tools, env: context.env, agent: context.agent, facts: context.facts };
  const history = context.effectLog
    .filter((e) => inScope(e, context))
    .map((e) =>
      ruleStep(
        view,
        {
          id: `e${e.seq}`,
          tool: e.tool,
          args: argsOf(fromJson(e.args)),
          at: e.at,
          taskId: e.taskId,
          stageId: e.stageId,
          agentId: e.agentId,
          segmentId: e.segmentId,
          unseenInput: e.unseenInput,
        },
        true,
      ),
    );
  const current = context.calls.map((c, i) =>
    ruleStep(view, { id: `c${i + 1}`, tool: c.tool, args: c.args, origin: c.origin, text: c.text, unseenInput: c.unseenInput }),
  );
  const env = ruleEnv(context.agent, context.task, context.facts, context.now);
  const hits = new HitCollector();

  current.forEach((step, index) => {
    const call = context.calls[index]!;
    const what = describeCall(call, findTool(context.tools, call.tool));
    // 同一条命令里真正可能在它前面执行的调用（"之前不能做过"要算上它们）
    const earlier = current.filter((_, j) => j !== index && mayRunBefore(context.calls[j]!.order, call.order));
    for (const rule of rules) {
      const triggers = triggerTools(rule);
      // 校验不通过的规则：不知道它本来要管什么，触发它的工具对得上（或者 trigger 本身写坏了）时一律判断不了
      const problems = templates.has(rule) ? [] : problemsOf(rule, context);
      if (problems.length > 0) {
        if (!triggers || triggers.includes(step.tool)) {
          hits.add(rule, "unknown", `${what}：时序规则「${ruleTitle(rule)}」校验不通过（${problems.join("；")}），判断不了，先问用户`, index);
        }
        continue;
      }
      if (!triggers?.includes(step.tool)) continue;
      try {
        // trigger.where 判断不了（缺事实、值取不到）时算判断不了；planguard 原样会当成不触发，这里先自己判一遍
        const triggered = triggerWhere(rule, step, env);
        if (triggered === false) continue;
        if (triggered !== true) {
          hits.add(rule, "unknown", unknownMessage(rule, what), index);
          continue;
        }
        const prior = ruleForm(rule) === "not_before" ? [...history, ...earlier] : history;
        for (const f of check([...prior, step], { rules: [rule] }, "runtime", env, [prior.length])) hits.add(rule, f.status, messageOf(rule, f, what), index);
      } catch (error) {
        hits.add(rule, "unknown", `${what}：时序规则「${ruleTitle(rule)}」出错（${(error as Error).message}），判断不了，先问用户`, index);
      }
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

/** 效果日志的范围：任务里只看同一个任务的；不属于任务的（含带着授权的会话段，19 号票）只看同一个 agent、同一段会话的 */
function inScope(e: EffectRecord, context: TemporalRuleContext): boolean {
  if (context.task && !context.task.segmentScoped) return e.taskId === context.task.taskId;
  return e.taskId === null && e.agentId === context.agent.agentId && e.segmentId === context.segmentId;
}

/** trigger.where：true 触发，false 不触发，"未知"判断不了；没写时触发 */
function triggerWhere(rule: RuleDoc, step: RuleStep, env: Env): boolean | unknown {
  if (!isPlainObject(rule.trigger) || !("where" in rule.trigger)) return true;
  return test(rule.trigger.where, { ...env, current: step, step: MISSING });
}

/**
 * 规则校验的结果按（注册表、规则对象、声明的事实）记下来，同一份计划不用每次判定都重新校验。
 * 规则对象不可变（计划里的规则改了是换一个新对象），所以可以按对象记。
 */
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

function unknownMessage(rule: RuleDoc, what: string): string {
  return `${what}：时序规则「${ruleTitle(rule)}」判断不了（缺少需要的环境事实，或者参数、规则要的值取不到），先问用户`;
}

/** 说明：违反了哪条、怎样才能满足；判断不了的说清楚是判断不了 */
function messageOf(rule: RuleDoc, f: Finding, what: string): string {
  if (f.status === "unknown") return unknownMessage(rule, what);
  const detail = typeof rule.message === "string" ? f.message : formHint(rule);
  return `${what}违反时序规则「${ruleTitle(rule)}」：${detail}`;
}

/** 规则没写 message 时，按形态说怎样才能满足 */
function formHint(rule: RuleDoc): string {
  const form = ruleForm(rule);
  const tools = (kind: "before" | "not_before") => (toolList(isPlainObject(rule.require?.[kind]) ? rule.require[kind].tool : undefined) ?? []).join("、");
  if (form === "before") return `之前没有成功做过 ${tools("before")}，先做完它再来`;
  if (form === "not_before") return `之前已经做过 ${tools("not_before")}，这一步不能再做`;
  if (form === "check") return "当下的条件不满足";
  return "这一步一律禁止";
}

function argsOf(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

/** 同一条规则只报一条：有违反的算违反，说明合在一起 */
class HitCollector {
  private readonly hits = new Map<string, TemporalRuleHit>();

  add(rule: RuleDoc, status: "violated" | "unknown", message: string, call: number): void {
    const ruleId = String(rule.id);
    const outcome = status === "violated" ? violationOutcome(rule) : "ask_first";
    const same = this.hits.get(ruleId);
    if (!same) {
      this.hits.set(ruleId, { ruleId, title: ruleTitle(rule), status, outcome, message, call });
      return;
    }
    if (status === "violated" && same.status === "unknown") {
      Object.assign(same, { status, outcome, message, call });
      return;
    }
    if (status === same.status && !same.message.includes(message)) same.message += `；${message}`;
  }

  list(): TemporalRuleHit[] {
    return [...this.hits.values()];
  }
}
