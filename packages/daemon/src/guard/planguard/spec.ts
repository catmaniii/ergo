// planguard 的规则文档格式、场景文档的检查和计划的参数规范化：照搬 AgentSense `web/src/agent/planguard/spec.ts`
// （来源和哈希见同目录 VERSION），语义不改。
// 05 号票只搬了规则能写的键、修补的种类和参数规范化（执行时检查用）；58 号票为流程的规划时审查（reviewer.ts）
// 补搬了 prepareScenario 和 normalizePlan。二狗对规则的细查仍在 ../rule-validation.ts（查得更细），
// prepareScenario 留着是为了和 planguard 的用例、审查的写法一致。
import { SpecError, Unknown, clone, fromJson, isNumber } from "./expr.ts";

/** 计划里的一步：工具名、参数、前置步骤（after），以及调用方附带的其他字段 */
export type Step = { id: string; title?: string; tool: string; args: Record<string, unknown>; after: string[]; [k: string]: unknown };
/** 交给审查的计划：目标和步骤（步骤是自由形式的 JSON，normalizePlan 补齐 args、after） */
export type Plan = { goal?: string; steps: Array<Record<string, unknown>> };

/** 一份 planguard 场景文档（规则、工具的参数规则、事实……），自由形式的 JSON */
export type Scenario = Record<string, any>;

/** 规则能写的键 */
export const RULE_KEYS = new Set(["id", "title", "trigger", "modes", "for_each", "when", "unless", "require", "message", "severity", "on_violation", "repairs"]);
/** 规划时修补的种类：插入一步、改写参数、调顺序、交给用户确认、退回重写 */
export const REPAIR_KINDS = ["insert", "rewrite", "move_after", "confirm", "replan"] as const;

/** 检查场景文档里的规则（键、require、修补的写法），并把事实从 JSON 转成引擎的值。返回新对象 */
export function prepareScenario(doc: Scenario): Scenario {
  for (const rule of doc.rules ?? []) {
    const unknown = Object.keys(rule).filter((k) => !RULE_KEYS.has(k));
    if (unknown.length) throw new SpecError(`rule ${rule.id}: unknown keys ${unknown.toSorted().join(",")}`);
    if (rule.require !== undefined && rule.require !== null) {
      const kinds = Object.keys(rule.require).filter((k) => ["before", "not_before", "check"].includes(k));
      if (kinds.length !== 1) throw new SpecError(`rule ${rule.id}: require needs exactly one of before/not_before/check`);
    }
    for (const option of rule.repairs ?? []) {
      if (REPAIR_KINDS.filter((k) => k in option).length !== 1) throw new SpecError(`rule ${rule.id}: repair needs exactly one kind`);
    }
  }
  return { ...doc, facts: fromJson(doc.facts ?? {}) };
}

/** 场景文档里 `tools.<工具>.args.<参数>` 的写法 */
export type ArgSchema = { type?: string; pattern?: string; list?: boolean };

function conforms(value: unknown, schema: ArgSchema): boolean {
  if ((schema.type ?? "string") === "number") return isNumber(value);
  if (typeof value !== "string") return false;
  return schema.pattern === undefined || new RegExp(schema.pattern).test(value);
}

/** 按参数规则规范化一个参数值：不符合类型或 pattern 的换成"未知" */
export function normalizeValue(value: unknown, schema: ArgSchema): unknown {
  if (value instanceof Unknown) return value;
  if (schema.list) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => normalizeValue(item, { ...schema, list: false }));
  }
  return conforms(value, schema) ? value : new Unknown(value);
}

/** 计划的步骤按场景文档里工具的参数规则规范化（补齐 args、after；"未知"的 JSON 写法转成引擎的值） */
export function normalizePlan(plan: Plan, scenario: Scenario): Step[] {
  const schemas = scenario.tools ?? {};
  return plan.steps.map((raw) => {
    const step = fromJson(clone(raw)) as Step;
    step.args ??= {};
    step.after ??= [];
    const argSchemas: Record<string, ArgSchema> = schemas[step.tool]?.args ?? {};
    for (const [name, schema] of Object.entries(argSchemas)) {
      if (Object.prototype.hasOwnProperty.call(step.args, name)) step.args[name] = normalizeValue(step.args[name], schema);
    }
    return step;
  });
}
