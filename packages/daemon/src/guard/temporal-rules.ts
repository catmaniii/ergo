// 时序规则：05 号票在这里接上 AgentSense planguard 的引擎核心（expr + spec + checker）。
//
// 接入点：判定函数对每次判定调用一次 `checkTemporalRules`，把返回的命中合并进处置（取最严）、
// 列进输出的"命中的时序规则"、写进给模型的说明。05 号票只需要实现这个函数
// （以及按需往 GuardInput / GuardPlan 上加规则的来源，比如阶段和阶段组上的规则、v1 模板），不用改判定函数。
//
// 本票不实现引擎：传入了规则时，每条规则都按"判断不了"处理，先问用户（规格："判断不了就问用户"）。
import type { EffectRecord, GuardAgent, GuardTask, EnvironmentFacts, JudgedCall } from "./types.ts";

/** 一条时序规则（planguard 规则格式：id、title、trigger、require、message、on_violation……） */
export type TemporalRule = { readonly id: string; readonly title?: string } & Readonly<Record<string, unknown>>;

/** 命中的一条时序规则 */
export interface TemporalRuleHit {
  ruleId: string;
  /** 违反：拦下；判断不了：先问 */
  status: "violated" | "unknown";
  disposition: "rejected" | "ask_first";
  message: string;
  /** 对应判定输出 `calls` 里的第几条 */
  call: number;
}

export interface TemporalRuleContext {
  rules: readonly TemporalRule[];
  calls: readonly JudgedCall[];
  /** 只看效果日志里已经成功执行过的调用 */
  effectLog: readonly EffectRecord[];
  facts: EnvironmentFacts;
  task: GuardTask | null;
  agent: GuardAgent;
  now: number;
}

export function checkTemporalRules(context: TemporalRuleContext): TemporalRuleHit[] {
  if (context.calls.length === 0) return [];
  return context.rules.map((rule) => ({
    ruleId: rule.id,
    status: "unknown" as const,
    disposition: "ask_first" as const,
    message: `时序规则「${rule.title ?? rule.id}」暂时无法判断（规则引擎尚未接入），先问用户`,
    call: 0,
  }));
}
