// 时序规则（规格第 9 节）：引擎核心是 planguard（planguard/ 下的 expr + spec + checker），规则格式与它兼容。
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
// - 效果日志里内容类的参数（写入的全文、编辑的新旧片段）只记了长度和摘要哈希（68 号票），读不到原文：
//   规则求值时一碰到（取值、比对象、转文字……）就算这一步对这条规则"判断不了"，见 checkRule；
//   规则校验也不许 $prior 读它们，规划时就会被拦下（rule-validation.ts）；
// - 一次 bash 拆出的几条调用一起判：对"之前不能做过"，同一条命令里真正可能在前面执行的也算（`a && b`、`a; b` 里的 a，
//   同一条管道或同一条简单命令里的其他调用，见 shell/split.ts 的 mayRunBefore）；对"之前必须做过"，它们还没执行，不算。
//
// 违反了怎么办（rule-doc.ts 的 violationOutcome）：on_violation 写 block 为"永不"，写 pull_back 为"按规则退回"
// （不是处置的一档，判定输出单列），写 confirm 或不写为"先问我"。
// 判断不了的（缺少需要的环境事实、参数没法规范化、规则要的值取不到、规则求值出错、规则校验不通过）一律"先问我"，
// 既不放行也不拦下。和 planguard 不同，trigger.where 判断不了时也算判断不了，不当成不触发。
// 规则里能用的东西（$current、$prior、$facts、$agent、$task、$now）见 rule-validation.ts 开头的说明。
import { t } from "@ergo/protocol";
import type { Disposition } from "./disposition.ts";
import { isDigested } from "./content-digest.ts";
import { digestsAsUnknown } from "./effect-log.ts";
import type { ShellEnv } from "./paths.ts";
import { check } from "./planguard/checker.ts";
import { MISSING, fromJson, isPlainObject, test, type Env } from "./planguard/expr.ts";
import { ruleForm, ruleTitle, toolList, triggerTools, violationOutcome, type RuleDoc } from "./rule-doc.ts";
import { ruleEnv } from "./rule-env.ts";
import { installErgoOps } from "./rule-ops.ts";
import { ruleStep, type RuleStep, type RuleView } from "./rule-steps.ts";
import { v1RuleTemplates } from "./rule-templates.ts";
import { ruleProblems } from "./rule-validation.ts";
import { mayRunBefore } from "./shell/split.ts";
import { describeCall, findTool, type ToolRegistry } from "./tool-registry.ts";
import type { EffectRecord, EnvironmentFacts, GuardAgent, GuardTask, JudgedCall } from "./types.ts";

// 规则求值之前，先把二狗的扩展运算（path_within）注册进引擎
installErgoOps();

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
  /** 是不是任务、项目自己的临时文件（111 号票，判定函数认出来的，own-temp.ts）：规则看到的路径上的 ownTemp；不给都是 false */
  ownTemp?: (path: string) => boolean;
}

export function checkTemporalRules(context: TemporalRuleContext): TemporalRuleHit[] {
  if (context.calls.length === 0) return [];
  const rules = rulesInEffect(context);
  const templates = new Set<unknown>(v1RuleTemplates(context.tools));

  const view: RuleView = { tools: context.tools, env: context.env, agent: context.agent, facts: context.facts };
  const history: Prior[] = context.effectLog
    .filter((e) => inScope(e, context))
    .map((e) => {
      const step = ruleStep(
        view,
        {
          id: `e${e.seq}`,
          tool: e.tool,
          args: argsOf(fromJson(digestsAsUnknown(e.args))),
          at: e.at,
          taskId: e.taskId,
          stageId: e.stageId,
          agentId: e.agentId,
          segmentId: e.segmentId,
          unseenInput: e.unseenInput,
        },
        true,
      );
      const digested = Object.keys(e.args).filter((name) => [e.args[name]].flat().some(isDigested));
      const descriptor = findTool(context.tools, e.tool);
      return { step, digested, digestedContent: digested.some((name) => descriptor?.args[name]?.kind === "content") };
    });
  // 任务、项目自己的临时文件（111 号票）只标在这次要判定的调用上
  const currentView: RuleView = context.ownTemp ? { ...view, ownTemp: context.ownTemp } : view;
  const current = context.calls.map((c, i) =>
    ruleStep(currentView, { id: `c${i + 1}`, tool: c.tool, args: c.args, origin: c.origin, text: c.text, unseenInput: c.unseenInput }),
  );
  const env = ruleEnv(context.agent, context.task, context.facts, context.now);
  const hits = new HitCollector();

  current.forEach((step, index) => {
    const call = context.calls[index]!;
    const what = describeCall(call, findTool(context.tools, call.tool));
    // 同一条命令里真正可能在它前面执行的调用（"之前不能做过"要算上它们）
    const earlier = current.filter((_, j) => j !== index && mayRunBefore(context.calls[j]!.order, call.order)).map(asPrior);
    for (const rule of rules) {
      const triggers = triggerTools(rule);
      // 校验不通过的规则：不知道它本来要管什么，触发它的工具对得上（或者 trigger 本身写坏了）时一律判断不了
      const problems = templates.has(rule) ? [] : problemsOf(rule, context);
      if (problems.length > 0) {
        if (!triggers || triggers.includes(step.tool)) {
          hits.add(rule, "unknown", t("guard.rules.invalid", { what, title: ruleTitle(rule), problems: problems.join(t("guard.sep")) }), index);
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
        for (const r of checkRule(rule, prior, step, env)) {
          hits.add(rule, r.status, r.digested ? digestedMessage(rule, what) : r.status === "unknown" ? unknownMessage(rule, what) : violationMessage(rule, r.message, what), index);
        }
      } catch (error) {
        hits.add(rule, "unknown", t("guard.rules.failed", { what, title: ruleTitle(rule), error: (error as Error).message }), index);
      }
    }
  });
  return hits.list();
}

/** 这次判定要检查的规则：v1 模板、当前阶段的、它所属阶段组的、调用方另给的（59 号票：计划检查取修法也用它） */
export function rulesInEffect(context: Pick<TemporalRuleContext, "rules" | "task" | "tools">): RuleDoc[] {
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
  return t("guard.rules.unknown", { what, title: ruleTitle(rule) });
}

function digestedMessage(rule: RuleDoc, what: string): string {
  return t("guard.rules.digested", { what, title: ruleTitle(rule) });
}

/** 违反了哪条、怎样才能满足（rendered 是 planguard 按规则的 message 填好占位符的那句） */
function violationMessage(rule: RuleDoc, rendered: string, what: string): string {
  const detail = typeof rule.message === "string" ? rendered : formHint(rule);
  return t("guard.rules.violated", { what, title: ruleTitle(rule), detail });
}

/** 效果日志里的一步（或者同一条命令里先执行的一段），记着哪些参数只记了长度和摘要哈希（68 号票） */
interface Prior {
  step: RuleStep;
  /** 缩过的参数名 */
  digested: readonly string[];
  /** 拼起来的对外内容（step.content）里有缩过的参数 */
  digestedContent: boolean;
}

/** 同一条命令里先执行的一段：参数是这次调用的，没有缩过的 */
const asPrior = (step: RuleStep): Prior => ({ step, digested: [], digestedContent: false });

/** 判一条规则的结论：违反、判断不了；digested 是因为读到了只记了长度和摘要哈希的内容才判断不了 */
interface RuleOutcome {
  status: "violated" | "unknown";
  message: string;
  digested?: true;
}

/**
 * 判一条规则（照 planguard 的 check）。效果日志里只记了长度和摘要哈希的内容读不到原文（68 号票）：
 * 求值时读到它（取值、比对象、转文字都算，靠读的时候记，不靠规则的写法）的那几步，对这条规则一律算"判断不了"，
 * 不能当成满足——去掉它们再判一遍，按三值逻辑合起来：
 * - before：去掉之后还满足的照旧满足（别的步满足了）；不满足的判断不了（去掉的那几步也许满足）；
 * - not_before：去掉之后还违反的照旧违反（别的步违反了）；不违反的判断不了（去掉的那几步也许违反）。
 * 去掉之后再判又读到别的缩过的步，接着去掉，直到不再读到
 */
function checkRule(rule: RuleDoc, prior: readonly Prior[], step: RuleStep, env: Env): RuleOutcome[] {
  const excluded = new Set<Prior>();
  for (;;) {
    const touched = new Set<Prior>();
    const kept = prior.filter((p) => !excluded.has(p));
    const steps = kept.map((p) => (p.digested.length > 0 ? tracked(p, () => touched.add(p)) : p.step));
    const findings = check([...steps, step], { rules: [rule] }, "runtime", env, [steps.length]).map((f) => ({ status: f.status, message: f.message }));
    if (touched.size > 0) {
      for (const p of touched) excluded.add(p);
      continue;
    }
    if (excluded.size === 0) return findings;
    const violated = ruleForm(rule) === "not_before" ? findings.filter((f) => f.status === "violated") : [];
    if (violated.length > 0) return violated;
    if (ruleForm(rule) === "before" && findings.length === 0) return [];
    return [{ status: "unknown", message: "", digested: true }];
  }
}

/** 一步的样子不变，只是读它缩过的参数（和由它拼起来的对外内容）时记一下 */
function tracked(prior: Prior, touch: () => void): RuleStep {
  const read = <T>(value: T) => () => {
    touch();
    return value;
  };
  const args = { ...prior.step.args };
  for (const name of prior.digested) Object.defineProperty(args, name, { enumerable: true, configurable: true, get: read(prior.step.args[name]) });
  const out: RuleStep = { ...prior.step, args };
  if (prior.digestedContent) Object.defineProperty(out, "content", { enumerable: true, configurable: true, get: read(prior.step.content) });
  return out;
}

/** 规则没写 message 时，按形态说怎样才能满足 */
function formHint(rule: RuleDoc): string {
  const form = ruleForm(rule);
  const tools = (kind: "before" | "not_before") => (toolList(isPlainObject(rule.require?.[kind]) ? rule.require[kind].tool : undefined) ?? []).join(t("pages.common.listSep"));
  if (form === "before") return t("guard.rules.formBefore", { tools: tools("before") });
  if (form === "not_before") return t("guard.rules.formNotBefore", { tools: tools("not_before") });
  if (form === "check") return t("guard.rules.formCheck");
  return t("guard.rules.formNever");
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
    if (status === same.status && !same.message.includes(message)) same.message += t("guard.sep") + message;
  }

  list(): TemporalRuleHit[] {
    return [...this.hits.values()];
  }
}
