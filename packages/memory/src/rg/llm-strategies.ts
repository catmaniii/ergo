// 模型版编交互策略（201 号票）：把成立的需求、价值交给模型写成"什么场合 → 怎么做"。
// - 一次请求写好几个依据（每个依据是同一主题的成立的需求、价值，带 key）；key 照抄回来，伪造的丢掉；
// - 措辞要具体、可执行：提示词里讲清楚，代码再挡一道——"注意他的感受""尊重他的需求""适当安排"这类空话、太短的做法丢掉，
//   做法全丢光的那条不要；领域只认 8 个（rg/domains.ts）；
// - 写出来的照旧是 proposed，本人确认才 active（rg/strategies.ts 的 StrategyBook.writeWithModel 落库）。
// - 218 号票：输出上限按依据个数估（STRATEGY_OUTPUT_PER_BASIS，1500 到 8000），依据多于 STRATEGY_BATCH_BASES 个时分批；
//   截断、解析不了的照 llm/robust.ts 救回完整的几条、剩下的对半切小重试（LlmReasoner.writeStrategies）。
import type { ChatRequest } from "../llm/chat.ts";
import { isStringArray } from "../llm/json.ts";
import { DOMAINS } from "./domains.ts";
import type { DroppedOutput, StrategyBasisInput, WrittenStrategy } from "./types.ts";

export const STRATEGY_SYSTEM = `你是记忆系统的助手，把对一个人已经成立的需求、价值观写成和他合作时的交互策略。规则：
- 每条策略写"什么场合 → 怎么做"：when 是触发场合（具体到哪类事、哪类日子）；actions 是 1 到 3 条具体、可执行的做法，写清做什么、做到什么程度（比如"每天至少留出半天不排事""替他约人前先发消息问他"）；
- 不写空话："注意他的感受""尊重他的需求""适当安排""合理安排"这类不要；
- 策略只调整"怎么做"，不推翻他这次明说的要求；不编造依据；
- domains 是适用领域，只能从 ${DOMAINS.join("、")} 里选；
- key 照抄给你的，每个 key 最多一条；写不出具体做法的 key 就不写。
只输出 JSON：{"strategies": [{"key": "...", "when": "...", "actions": ["..."], "domains": ["..."]}]}`;

/** 空话：只表态度、不说做什么 */
export const VAGUE_ACTION =
  /注意(?:用户|他|她)?的?(?:感受|情绪|需求|想法)|尊重(?:用户|他|她)?的?(?:需求|意愿|想法|选择|感受)|考虑(?:到)?(?:用户|他|她)?的?(?:需求|感受|偏好|价值观|想法)|关注(?:用户|他|她)?的?(?:需求|感受|情绪)|照顾(?:用户|他|她)?的?(?:感受|情绪)|(?:满足|理解)(?:用户|他|她)?的?需求|适当(?:地)?(?:安排|调整|处理)|合理(?:地)?(?:安排|调整)|酌情/;
/** 218 号票：一个依据估多少输出 token（一条策略：场合、1 到 3 条做法、领域；真跑时四五个依据写了 1000–1240 token） */
export const STRATEGY_OUTPUT_PER_BASIS = 250;
/** 一批最多几个依据 */
export const STRATEGY_BATCH_BASES = 12;
/** 输出上限：按这一批的依据个数估的 1.8 倍，1500 到 8000 */
export const strategyMaxTokens = (bases: number): number => Math.min(8000, Math.max(1500, Math.ceil(bases * STRATEGY_OUTPUT_PER_BASIS * 1.8)));

/** 做法、场合最少几个字 */
const MIN_CHARS = 6;
const MAX_ACTIONS = 3;

/** 编策略的请求：每行一个依据 */
export function strategyRequest(bases: readonly StrategyBasisInput[]): ChatRequest {
  const lines = bases.map((b) =>
    JSON.stringify({
      key: b.key,
      claims: b.claims.map((c) => ({ claim_id: c.claimId, tier: c.tier, statement: c.statement, label: c.label, confidence: c.confidence })),
      scenes: b.scenes,
      activities: b.activities,
      domains: b.domains,
    }),
  );
  return { purpose: "strategies", system: STRATEGY_SYSTEM, user: `成立的需求、价值（每行一个依据）：\n${lines.join("\n")}`, maxTokens: strategyMaxTokens(bases.length) };
}

/** 解析、校验模型写的策略（见文件开头）；不合格的丢掉、记进 dropped（stage = strategies） */
export function parseStrategies(parsed: Record<string, unknown>, bases: readonly StrategyBasisInput[], dropped: DroppedOutput[]): WrittenStrategy[] {
  const keys = new Set(bases.map((b) => b.key));
  const out: WrittenStrategy[] = [];
  for (const raw of Array.isArray(parsed.strategies) ? parsed.strategies : []) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const drop = (reason: string, item: unknown = raw) => dropped.push({ stage: "strategies", reason, item });
    const key = typeof s.key === "string" ? s.key : "";
    if (!keys.has(key)) {
      drop(`伪造的依据 key：${key || String(s.key)}`);
      continue;
    }
    if (out.some((x) => x.key === key)) {
      drop(`同一个 key 写了两条：${key}`);
      continue;
    }
    const when = typeof s.when === "string" ? s.when.trim() : "";
    if (Array.from(when).length < MIN_CHARS || VAGUE_ACTION.test(when)) {
      drop(`触发场合不具体：${when}`);
      continue;
    }
    const actions: string[] = [];
    for (const a of (isStringArray(s.actions) ? s.actions : []).map((x) => x.trim())) {
      if (VAGUE_ACTION.test(a)) drop(`空话：${a}`, a);
      else if (Array.from(a).length < MIN_CHARS) drop(`做法太短，不具体：${a}`, a);
      else if (!actions.includes(a)) actions.push(a);
    }
    if (actions.length === 0) {
      drop(`做法都不具体：${key}`);
      continue;
    }
    const domains: string[] = [];
    for (const d of isStringArray(s.domains) ? s.domains : []) {
      if ((DOMAINS as readonly string[]).includes(d)) {
        if (!domains.includes(d)) domains.push(d);
      } else drop(`不认得的领域：${d}`, d);
    }
    out.push({ key, when, actions: actions.slice(0, MAX_ACTIONS), domains });
  }
  if (out.length === 0) dropped.push({ stage: "strategies", reason: "模型没写出能用的策略" });
  return out;
}
