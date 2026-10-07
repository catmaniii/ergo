// 一条时序规则（planguard 规则文档）的形状：形态、触发它的工具、违反时怎么办。检查和校验共用。
import type { RuleDoc } from "./planguard/checker.ts";
import { isPlainObject } from "./planguard/expr.ts";

export type { RuleDoc };

/** 四种形态：B 之前必须做过 A、B 之前不能做过 A、当下必须满足某条件、一律禁止（不写 require） */
export type RuleForm = "before" | "not_before" | "check" | "forbid";
const REQUIRE_FORMS = ["before", "not_before", "check"] as const;

/** 规则的形态；require 写坏了（不止一种、一种也没有、多了别的键）返回 undefined */
export function ruleForm(rule: RuleDoc): RuleForm | undefined {
  const require: unknown = rule.require;
  if (require === undefined || require === null) return "forbid";
  if (!isPlainObject(require)) return undefined;
  const keys = Object.keys(require);
  if (keys.length !== 1) return undefined;
  return REQUIRE_FORMS.find((f) => f === keys[0]);
}

/**
 * 违反了怎么办（on_violation）：
 * - block：永不（一律禁止的、对外内容含密钥的）；
 * - pull_back：按规则退回（二狗扩展）——前提没满足、agent 自己能补救（先提交、先跑测试），不是处置的一档；
 * - confirm，或者不写：先问我（和 planguard 一样）。
 */
export const ON_VIOLATION = ["block", "confirm", "pull_back"] as const;

export function violationOutcome(rule: RuleDoc): "never" | "ask_first" | "pull_back" {
  if (rule.on_violation === "block") return "never";
  if (rule.on_violation === "pull_back") return "pull_back";
  return "ask_first";
}

/** 工具名或一组工具名；写错了返回 undefined */
export function toolList(spec: unknown): string[] | undefined {
  if (typeof spec === "string" && spec !== "") return [spec];
  if (Array.isArray(spec) && spec.length > 0 && spec.every((t) => typeof t === "string" && t !== "")) return spec as string[];
  return undefined;
}

/** 触发它的工具；trigger 写坏了返回 undefined */
export function triggerTools(rule: RuleDoc): string[] | undefined {
  return toolList(isPlainObject(rule.trigger) ? rule.trigger.tool : undefined);
}

/** 说明里怎么称呼它：标题，没写时是 id */
export function ruleTitle(rule: RuleDoc): string {
  return typeof rule.title === "string" ? rule.title : String(rule.id);
}
