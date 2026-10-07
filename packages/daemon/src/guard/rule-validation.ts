// 时序规则的校验（参考 AgentSense 的 scripts/policies-check.ts）：纯函数，存计划时直接调用（13 号票），
// 对话里的限制编译成规则时也走它（26 号票）。规则写错了引擎往往不报错，只会悄悄判成"不知道"或者根本不触发，
// 所以在存的时候就拦下来，并指出是哪条规则、哪里不对。
//
// 规则里能用的东西：
// - $current：这次要判定的调用；$prior：require.before / not_before 的 where 里，之前执行成功过的那次调用。
//   字段见 rule-steps.ts 的 STEP_FIELDS：tool、args（规范化参数，参数名照工具注册表）、paths（路径参数和它们的
//   area、replaced、committed、secretFile……）、recipients、content、secrets、sends、origin、text，效果日志的 at、taskId、stageId、agentId；
// - $facts：调用方现取后传入的环境事实，files、git、scripts 三个列表（每行带 path 或 repo），以及调用方声明的别的事实；
// - $agent：kind、agentId、cwd、scope（项目档案和工作目录，秘书是草稿区）；$task：taskId、stageId（对话里没有）；$now：当前时间（毫秒）；
// - for_each 的变量、select / find / any / all 的行变量（默认 $row，as 可以改名）；
// - $step：planguard 规划时的计划步骤，二狗没有计划步骤，执行时一律"不存在"（为了和 planguard 的规则兼容才允许写）。
import { OP_ARITY, OPS, isPlainObject } from "./planguard/expr.ts";
import { REPAIR_KINDS, RULE_KEYS } from "./planguard/spec.ts";
import { STEP_FIELDS } from "./rule-steps.ts";
import { V1_TEMPLATE_IDS } from "./rule-templates.ts";
import { findTool, type ToolRegistry } from "./tool-registry.ts";

export interface RuleValidationOptions {
  tools: ToolRegistry;
  /** 调用方会传入的别的环境事实（EnvironmentFacts.extra 的键），规则才能用 $facts.<它> */
  facts?: readonly string[];
  /** 允许用 v1 模板保留的 id（只有校验模板本身时用） */
  allowReserved?: boolean;
}

export interface RuleValidationResult {
  ok: boolean;
  /** 每个问题都以"规则 <id>"开头，写明哪里不对 */
  problems: string[];
}

const BUILTIN_FACTS = ["files", "git", "scripts"];
const AGENT_FIELDS = ["kind", "agentId", "cwd", "scope"];
const TASK_FIELDS = ["taskId", "stageId"];
const ROW_OPS = new Set(["select", "find", "any", "all"]);
const RESERVED_IDS = new Set<string>(Object.values(V1_TEMPLATE_IDS));
const PLACEHOLDER = /\{([A-Za-z_][\w.]*)\}/g;

/** 校验一组规则（比如一个阶段的规则加它所属阶段组的规则） */
export function validateTemporalRules(rules: readonly unknown[], options: RuleValidationOptions): RuleValidationResult {
  const problems: string[] = [];
  const seen = new Set<string>();
  rules.forEach((rule, i) => {
    const id = isPlainObject(rule) && typeof rule.id === "string" && rule.id !== "" ? rule.id : undefined;
    if (id === undefined) {
      problems.push(`第 ${i + 1} 条规则没有 id`);
    } else {
      if (seen.has(id)) problems.push(`规则 ${id}：id ${id} 重复`);
      seen.add(id);
      if (!options.allowReserved && (RESERVED_IDS.has(id) || id.startsWith("v1."))) problems.push(`规则 ${id}：${id} 是 v1 模板保留的 id，换一个`);
    }
    problems.push(...ruleProblems(rule, options, id ?? `（第 ${i + 1} 条）`));
  });
  return { ok: problems.length === 0, problems };
}

/** 一条规则自己的问题（不看 id 是否重复、是否保留）。判定时对计划里的规则也查这一遍 */
export function ruleProblems(rule: unknown, options: RuleValidationOptions, name = isPlainObject(rule) ? String(rule.id) : "?"): string[] {
  const problems: string[] = [];
  const say = (message: string) => problems.push(`规则 ${name}：${message}`);
  if (!isPlainObject(rule)) {
    say("不是一个对象");
    return problems;
  }
  const unknownKeys = Object.keys(rule).filter((k) => !RULE_KEYS.has(k));
  if (unknownKeys.length > 0) say(`不认识的键 ${unknownKeys.join("、")}（能写的：${[...RULE_KEYS].join("、")}）`);
  if (rule.title !== undefined && typeof rule.title !== "string") say("title 要是字符串");

  const triggerTools = toolList(isPlainObject(rule.trigger) ? rule.trigger.tool : undefined);
  if (!triggerTools) say("trigger 要写 tool（工具名，或一组工具名）");
  for (const t of triggerTools ?? []) if (!findTool(options.tools, t)) say(`触发的工具 ${t} 没有登记`);

  if (rule.modes !== undefined) {
    if (!Array.isArray(rule.modes) || rule.modes.some((m) => m !== "plan" && m !== "runtime")) say("modes 只能是 plan、runtime 组成的列表");
    else if (!rule.modes.includes("runtime")) say("modes 里没有 runtime：二狗只在执行时检查，这条规则不会生效");
  }
  if (rule.on_violation !== undefined && rule.on_violation !== "block" && rule.on_violation !== "confirm") {
    say(`on_violation 只能是 block 或 confirm，写的是 ${JSON.stringify(rule.on_violation)}`);
  }

  const walker = new ExprWalker(options, triggerTools ?? [], say);
  const scope = new Set<string>();
  if (isPlainObject(rule.trigger) && "where" in rule.trigger) walker.walk(rule.trigger.where, scope);
  if (rule.for_each !== undefined) {
    const spec = rule.for_each;
    if (!isPlainObject(spec) || typeof spec.var !== "string" || !("in" in spec)) say("for_each 要写 var 和 in");
    else {
      walker.walk(spec.in, scope);
      scope.add(spec.var);
      if ("key" in spec) walker.walk(spec.key, scope);
    }
  }
  if ("when" in rule) walker.walk(rule.when, scope);
  if ("unless" in rule) walker.walk(rule.unless, scope);

  if (rule.require !== undefined && rule.require !== null) {
    const require = rule.require;
    const kinds = isPlainObject(require) ? Object.keys(require).filter((k) => ["before", "not_before", "check"].includes(k)) : [];
    const extra = isPlainObject(require) ? Object.keys(require).filter((k) => !["before", "not_before", "check"].includes(k)) : [];
    if (!isPlainObject(require) || kinds.length !== 1 || extra.length > 0) say("require 只能写 before、not_before、check 之一（一律禁止就不写 require）");
    else if ("check" in require) walker.walk(require.check, scope);
    else {
      const kind = kinds[0]!;
      const spec = require[kind];
      const priorTools = toolList(isPlainObject(spec) ? spec.tool : undefined);
      const role = kind === "before" ? "要求之前做过的工具" : "要求之前没做过的工具";
      if (!priorTools) say(`require.${kind} 要写 tool`);
      for (const t of priorTools ?? []) if (!findTool(options.tools, t)) say(`${role} ${t} 没有登记`);
      if (isPlainObject(spec) && "where" in spec) walker.walk(spec.where, scope, priorTools ?? []);
    }
  }

  if (rule.message !== undefined) {
    if (typeof rule.message !== "string") say("message 要是字符串");
    else {
      for (const [, ref] of rule.message.matchAll(PLACEHOLDER)) {
        const before = problems.length;
        walker.ref(`$${ref}`, scope, undefined);
        if (problems.length > before) problems.splice(before, problems.length - before, `规则 ${name}：message 里的占位符 {${ref}} 引用了不存在的东西`);
      }
    }
  }
  if (rule.repairs !== undefined) {
    const ok = Array.isArray(rule.repairs) && rule.repairs.every((r) => isPlainObject(r) && REPAIR_KINDS.filter((k) => k in r).length === 1);
    if (!ok) say(`repairs 每一项要写 ${REPAIR_KINDS.join("、")} 之一（二狗执行时不用它，只为和 planguard 兼容）`);
  }
  return problems;
}

function isValidRegex(pattern: string): boolean {
  try {
    return new RegExp(pattern) instanceof RegExp;
  } catch {
    return false;
  }
}

/** 工具名或一组工具名；写错了返回 undefined */
function toolList(spec: unknown): string[] | undefined {
  if (typeof spec === "string" && spec !== "") return [spec];
  if (Array.isArray(spec) && spec.length > 0 && spec.every((t) => typeof t === "string" && t !== "")) return spec as string[];
  return undefined;
}

/** 走一遍表达式：运算认不认识、操作数个数、正则、引用的东西存不存在、读的参数工具有没有 */
class ExprWalker {
  private readonly options: RuleValidationOptions;
  private readonly triggerTools: readonly string[];
  private readonly say: (message: string) => void;

  constructor(options: RuleValidationOptions, triggerTools: readonly string[], say: (message: string) => void) {
    this.options = options;
    this.triggerTools = triggerTools;
    this.say = say;
  }

  /** priorTools 不为 undefined 时在 require.before / not_before 的 where 里，可以用 $prior */
  walk(expr: unknown, scope: ReadonlySet<string>, priorTools?: readonly string[]): void {
    if (typeof expr === "string") {
      if (expr.startsWith("$")) this.ref(expr, scope, priorTools);
      return;
    }
    if (Array.isArray(expr)) {
      for (const x of expr) this.walk(x, scope, priorTools);
      return;
    }
    if (!isPlainObject(expr)) return;
    const keys = Object.keys(expr);
    if (keys.length !== 1) {
      for (const k of keys) this.walk(expr[k], scope, priorTools);
      return;
    }
    const op = keys[0]!;
    const arg = expr[op];
    if (op === "$unknown" || op === "lit") return;
    if (!Object.hasOwn(OPS, op)) {
      this.say(`不认识的运算 ${op}（能用的：${Object.keys(OPS).join("、")}）`);
      return;
    }
    const arity = OP_ARITY[op];
    const count = Array.isArray(arg) ? arg.length : 1;
    if (arity !== undefined && count !== arity) this.say(`${op} 要 ${arity} 个操作数，写了 ${count} 个：${JSON.stringify(expr)}`);
    if (ROW_OPS.has(op)) {
      if (!isPlainObject(arg) || !("from" in arg)) {
        this.say(`${op} 要写 from（和 where）`);
        return;
      }
      this.walk(arg.from, scope, priorTools);
      const inner = new Set(scope).add(typeof arg.as === "string" ? arg.as : "row");
      if ("where" in arg) this.walk(arg.where, inner, priorTools);
      if ("map" in arg) this.walk(arg.map, inner, priorTools);
      return;
    }
    if (op === "get" && Array.isArray(arg) && typeof arg[1] === "string" && !arg[1].startsWith("$")) {
      const target = arg[0];
      if (target === "$current.args" || target === "$prior.args") this.ref(`${target}.${arg[1]}`, scope, priorTools);
    }
    if (op === "matches" && Array.isArray(arg) && typeof arg[1] === "string" && !arg[1].startsWith("$") && !isValidRegex(arg[1])) {
      this.say(`正则 ${arg[1]} 写错了`);
    }
    this.walk(arg, scope, priorTools);
  }

  ref(ref: string, scope: ReadonlySet<string>, priorTools: readonly string[] | undefined): void {
    const [root = "", field, arg] = ref.slice(1).split(".");
    if (scope.has(root) || root === "now" || root === "step") return;
    if (root === "current" || root === "prior") {
      if (root === "prior" && priorTools === undefined) {
        this.say(`$prior 只能用在 require.before / require.not_before 的 where 里：${ref}`);
        return;
      }
      if (field === undefined) return;
      if (!(STEP_FIELDS as readonly string[]).includes(field)) {
        this.say(`$${root} 没有 ${field}（有的：${STEP_FIELDS.join("、")}）：${ref}`);
        return;
      }
      if (field === "args" && arg !== undefined) this.checkArg(root === "current" ? this.triggerTools : priorTools!, arg, ref);
      return;
    }
    if (root === "facts") {
      if (field !== undefined && !BUILTIN_FACTS.includes(field) && !(this.options.facts ?? []).includes(field)) {
        this.say(`$facts 没有 ${field}（有的：${[...BUILTIN_FACTS, ...(this.options.facts ?? [])].join("、")}）：${ref}`);
      }
      return;
    }
    if (root === "agent" || root === "task") {
      const fields = root === "agent" ? AGENT_FIELDS : TASK_FIELDS;
      if (field !== undefined && !fields.includes(field)) this.say(`$${root} 没有 ${field}（有的：${fields.join("、")}）：${ref}`);
      return;
    }
    this.say(`不认识的 $${root}：${ref}`);
  }

  /** 读的参数要在这些工具里至少一个上登记过（多个工具时，只有一部分工具有这个参数是正常的写法） */
  private checkArg(tools: readonly string[], arg: string, ref: string): void {
    const registered = tools.map((t) => findTool(this.options.tools, t)).filter((t) => t !== undefined);
    if (registered.length === 0) return;
    if (registered.some((t) => Object.hasOwn(t.args, arg))) return;
    const known = [...new Set(registered.flatMap((t) => Object.keys(t.args)))];
    this.say(`${registered.map((t) => t.name).join("、")} 没有参数 ${arg}（有的：${known.join("、")}）：${ref}`);
  }
}
