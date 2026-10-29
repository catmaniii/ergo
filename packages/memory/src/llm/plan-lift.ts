// 预计费用里的往上抽、编策略两步（201 号票）。照 plan.ts 的做法：用规则版整理出来的结构拼模型版真实会发的请求估输入 token，
// 输出按经验值估；往高里算：
// - 需求层：下层断言（规则版的成立的偏好、状态）合起来过了门槛才估一次（门槛不过，模型版也不会问）；
// - 价值层：需求层要问，就估一次——规则版也抽出了需求时用真实的请求，没有就按"价值层的提示词 + 需求层请求正文的一半"估；
// - 往上抽的追问模型在往上抽时一起写，不另问；每层按 2 条追问、每条按轮数估判定；
// - 编策略：需求层要问，就估一次——规则版有成立的需求、价值时用真实的请求，没有就按"提示词 + 300"估。
import type { MemoryEngine } from "../engine.ts";
import { LIFT_SYSTEM_VALUE } from "../rg/llm-lift.ts";
import { STRATEGY_SYSTEM, strategyRequest } from "../rg/llm-strategies.ts";
import type { LlmReasoner } from "../rg/llm-reasoner.ts";
import { JUDGE_SYSTEM } from "../rg/llm-reasoner.ts";
import type { ChatRequest } from "./chat.ts";
import { estimateTokens, type PlannedCall } from "./estimate.ts";

/** 往上抽、编策略的输出 token 和几样猜的数 */
export const LIFT_GUESS = { liftOutput: 900, strategiesOutput: 500, probesPerLevel: 2, judgeOutput: 250, judgeInputExtra: 400, strategiesInputExtra: 300 } as const;

const tokensOf = (r: ChatRequest) => estimateTokens(r.system) + estimateTokens(r.user);

export function planLiftCalls(engine: MemoryEngine, reasoner: LlmReasoner, rounds: number): { calls: PlannedCall[]; notes: string[] } {
  const rg = engine.rg;
  const view = rg.view();
  // 218：往上抽分批，一批一个请求
  const needRequests = reasoner.liftRequests("need", rg.liftInputs("need", view), view);
  const need = needRequests[0];
  if (!need) return { calls: [], notes: ["往上抽：成立的偏好、状态合起来没过门槛（两种以上场景、两个以上月份、至少 3 条证据），模型版不会问，不估往上抽和编策略"] };
  const calls: PlannedCall[] = needRequests.map((r) => ({ purpose: "lift", inputTokens: tokensOf(r), outputTokens: LIFT_GUESS.liftOutput }));
  const valueInputs = rg.liftInputs("value", view);
  const value = valueInputs.length > 0 ? reasoner.liftRequests("value", valueInputs, view)[0] : undefined;
  calls.push({ purpose: "lift", inputTokens: value ? tokensOf(value) : estimateTokens(LIFT_SYSTEM_VALUE) + Math.ceil(estimateTokens(need.user) / 2), outputTokens: LIFT_GUESS.liftOutput });
  for (let level = 0; level < 2; level++) {
    for (let p = 0; p < LIFT_GUESS.probesPerLevel * rounds; p++) calls.push({ purpose: "judge", inputTokens: estimateTokens(JUDGE_SYSTEM) + LIFT_GUESS.judgeInputExtra, outputTokens: LIFT_GUESS.judgeOutput });
  }
  const bases = engine.strategies.basisInputs(view.at);
  calls.push({
    purpose: "strategies",
    inputTokens: bases.length > 0 ? tokensOf(strategyRequest(bases)) : estimateTokens(STRATEGY_SYSTEM) + LIFT_GUESS.strategiesInputExtra,
    outputTokens: LIFT_GUESS.strategiesOutput,
  });
  return {
    calls,
    notes: [
      `往上抽：需求层、价值层各估一次（价值层${value ? "用规则版抽出的需求拼的真实请求" : "按需求层请求的一半估"}）；追问随往上抽一起写，判定每层按 ${LIFT_GUESS.probesPerLevel} 条追问、${rounds} 轮估`,
      `编策略：估一次（${bases.length > 0 ? `规则版有 ${bases.length} 个成立的依据，用真实请求` : "按提示词加 300 token 估"}）`,
    ],
  };
}
