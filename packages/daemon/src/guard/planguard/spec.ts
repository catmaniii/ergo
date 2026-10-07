// planguard 的规则文档格式和参数规范化：照搬 AgentSense `web/src/agent/planguard/spec.ts`（来源和哈希见同目录 VERSION）。
// 只搬了规则能写的键、修补的种类和参数规范化。prepareScenario 对规则文档的检查由 ../rule-validation.ts 覆盖（查得更细）；
// 二狗只在执行时检查，没有搬规划时用的 normalizePlan。语义不改。
import { Unknown, isNumber } from "./expr.ts";

/** 一份 planguard 场景文档（规则、工具的参数规则、事实……），自由形式的 JSON */
export type Scenario = Record<string, any>;

/** 规则能写的键 */
export const RULE_KEYS = new Set(["id", "title", "trigger", "modes", "for_each", "when", "unless", "require", "message", "severity", "on_violation", "repairs"]);
/** 规划时修补的种类（二狗执行时不用，只为规则格式兼容） */
export const REPAIR_KINDS = ["insert", "rewrite", "move_after", "confirm", "replan"] as const;

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
