// 模型版跑之前的预计：要调几次模型、多少 token、多少钱。不调模型、不联网：
// 先在内存库里用规则版把同一份数据整理一遍，拿到结构（多少条证据、几组假设、几条追问、每条追问搜到几条），
// 再照模型版真实会发的请求（LlmFactExtractor.requestFor、LlmReasoner 的 propose / probes / judge 请求）估输入 token，
// 输出 token 按每类请求的经验值估（见 OUTPUT_GUESS）。追问按两轮算（往高里算）。
// planEvalModelRun（192 号票）：评测的"真模型"开关跑之前的预计——评测要建的每个库各估一遍推理的请求（证据、时间一样的库只算一次：
// 同样的请求只问一次），抽事实按全部证据算一遍（所有库共用一个抽取器，抽过的不再问），扰动以后再整理一次按"每条追问再判一轮 + 出一次假设、一次追问"估。
// 201 号票：加上往上抽（需求层、价值层）和编交互策略两步（plan-lift.ts）。
import type { Evidence, EvidenceDraft } from "../domain/types.ts";
import { MemoryEngine } from "../engine.ts";
import type { EvidenceSource } from "../evidence/source.ts";
import { LlmFactExtractor } from "../kg/llm-extractor.ts";
import { isJointGroup } from "../rg/joint.ts";
import { LlmReasoner, proposeOutputEstimate } from "../rg/llm-reasoner.ts";
import type { GroupView } from "../rg/types.ts";
import type { ChatModel, ChatRequest } from "./chat.ts";
import { DEEPSEEK_DEFAULT_MODEL } from "./deepseek.ts";
import { estimateCost, estimateTokens, PRICE_SOURCE, type CostEstimate, type PlannedCall } from "./estimate.ts";
import { planLiftCalls } from "./plan-lift.ts";

/**
 * 每类请求的输出 token 估计。192 号票照第一次真跑的实际数改大了：抽事实每批平均写了 2167 个（每条证据约 300 个还常被截断），
 * propose 每次都写满了 2000 的上限——原来的 150 / 条、300 / 组（至少 600）估少了好几倍
 */
export const OUTPUT_GUESS = { extractPerEvidence: 400, proposePerGroup: 800, proposeMin: 4000, probes: 600, judge: 500 } as const;

export interface ModelRunPlan {
  model: string;
  evidence: number;
  groups: number;
  probes: number;
  calls: PlannedCall[];
  estimate: CostEstimate;
  notes: string[];
}

/** 只用来拼请求的"模型"：从来不会被调用 */
const NEVER: ChatModel = {
  name: DEEPSEEK_DEFAULT_MODEL,
  complete: () => Promise.reject(new Error("预计费用时不调模型")),
};

const tokensOf = (r: ChatRequest) => estimateTokens(r.system) + estimateTokens(r.user);

export async function planModelRun(source: EvidenceSource, options: { model?: string; batchSize?: number; rounds?: number } = {}): Promise<ModelRunPlan> {
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
  const rounds = options.rounds ?? 2;
  const engine = MemoryEngine.open({ file: ":memory:", clock: () => source.now });
  try {
    engine.ingestFrom(source);
    await engine.reflect();
    const evidence = engine.store.listEvidence({ status: "active" });
    const calls = [...extractCalls(evidence, engine, model, options.batchSize)];
    const r = await reasonerCalls(engine, model, rounds);
    calls.push(...r.calls);
    // 往上抽、编策略（201 号票）
    const lifting = planLiftCalls(engine, new LlmReasoner({ ...NEVER, name: model }), rounds);
    calls.push(...lifting.calls);
    return {
      model,
      evidence: evidence.length,
      groups: r.groups,
      probes: r.probes,
      calls,
      estimate: estimateCost(model, calls),
      notes: [
        "token 按字数估：中文约 0.6 个 / 字，其余约 0.3 个 / 字符；输出按经验值估",
        `价格：${PRICE_SOURCE}，输入按缓存未命中算`,
        `结构照规则版的结果（${r.groups} 组、${r.probes} 条追问），追问按 ${rounds} 轮算；模型版实际的组数、追问数会不一样`,
        ...lifting.notes,
      ],
    };
  } finally {
    engine.close();
  }
}

/** 抽事实：按批（每批的请求照 LlmFactExtractor.requestFor 拼） */
function extractCalls(evidence: readonly Evidence[], engine: MemoryEngine, model: string, batchSize?: number): PlannedCall[] {
  const calls: PlannedCall[] = [];
  const extractor = new LlmFactExtractor({ ...NEVER, name: model }, { batchSize });
  for (let i = 0; i < evidence.length; i += extractor.batchSize) {
    const batch = evidence.slice(i, i + extractor.batchSize);
    calls.push({ purpose: "extract", inputTokens: tokensOf(extractor.requestFor(batch, engine.kg.view())), outputTokens: OUTPUT_GUESS.extractPerEvidence * batch.length });
  }
  return calls;
}

/** 一个整理过（规则版）的库：模型版推理要发的请求——出一次假设、每组出追问、每条追问判 rounds 轮 */
async function reasonerCalls(engine: MemoryEngine, model: string, rounds: number): Promise<{ calls: PlannedCall[]; groups: number; probes: number; judgeCalls: PlannedCall[]; propose: PlannedCall | null; probeCalls: PlannedCall[] }> {
  const calls: PlannedCall[] = [];
  const reasoner = new LlmReasoner({ ...NEVER, name: model });
  const rg = engine.rg;
  const view = rg.view();
  const facts = engine.store.factsValidAt(view.at).filter((f) => view.usableFact(f));
  const groups = rg.registry
    .listGroups({ live: true })
    // 199 号票：联动的组（对比模式、矛盾根源）由代码判，不发请求
    .filter((g) => !isJointGroup(g))
    .map((g) => rg.groupView(g.key))
    .filter((g): g is GroupView => g !== undefined);
  // 218：出假设分批，一批一个请求；每批的输出按 proposeOutputEstimate 估（组数封顶）
  const proposeCalls = reasoner.proposeBatches(facts, { view, existingGroups: [] }).map((batch) => ({
    purpose: "propose",
    inputTokens: tokensOf(reasoner.proposeBatchRequest(batch, facts, { view, existingGroups: [] })),
    outputTokens: proposeOutputEstimate(batch.length),
  }));
  calls.push(...proposeCalls);
  const propose = proposeCalls.length > 0 ? { purpose: "propose", inputTokens: proposeCalls.reduce((s, c) => s + c.inputTokens, 0), outputTokens: proposeCalls.reduce((s, c) => s + c.outputTokens, 0) } : null;
  let probes = 0;
  const judgeCalls: PlannedCall[] = [];
  const probeCalls: PlannedCall[] = [];
  for (const group of groups) {
    const pc = { purpose: "probes", inputTokens: tokensOf(reasoner.probesRequest(group)), outputTokens: OUTPUT_GUESS.probes };
    probeCalls.push(pc);
    calls.push(pc);
    for (const { probeId } of rg.registry.probesOf(group.key)) {
      const probe = engine.store.getProbe(probeId);
      if (!probe) continue;
      probes += 1;
      const hits = rg.toJudgeHits(await rg.probeSearch(probe.queries, view.at, probe.id), view);
      const jc = { purpose: "judge", inputTokens: tokensOf(reasoner.judgeRequest(probe, group, hits, view)), outputTokens: OUTPUT_GUESS.judge };
      judgeCalls.push(jc);
      for (let r = 0; r < rounds; r++) calls.push(jc);
    }
  }
  return { calls, groups: groups.length, probes, judgeCalls, propose, probeCalls };
}

/** 评测要建的一个库：哪些证据、时钟；扰动的库做完扰动还要再整理一次 */
export interface PlannedEngine {
  key: string;
  drafts: EvidenceDraft[];
  clock: string;
  postOp?: boolean;
}

export interface EvalModelRunPlan extends ModelRunPlan {
  /** 评测要建几个库、去掉证据和时间一样的以后几个 */
  engines: number;
  uniqueEngines: number;
}

/** 评测的"真模型"开关跑之前的预计（见文件开头）。不调模型、不联网 */
export async function planEvalModelRun(specs: readonly PlannedEngine[], options: { model?: string; batchSize?: number; rounds?: number } = {}): Promise<EvalModelRunPlan> {
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
  const rounds = options.rounds ?? 2;
  const calls: PlannedCall[] = [];
  const signature = (s: PlannedEngine) => `${s.clock}|${s.drafts.map((d) => d.id).toSorted().join(",")}`;
  const done = new Map<string, Awaited<ReturnType<typeof reasonerCalls>>>();
  const union = new Map<string, EvidenceDraft>();
  let groups = 0;
  let probes = 0;
  let extracted = false;
  for (const spec of specs) {
    for (const d of spec.drafts) union.set(d.id!, d);
    const sig = signature(spec);
    let r = done.get(sig);
    if (!r) {
      const engine = MemoryEngine.open({ file: ":memory:", clock: () => spec.clock });
      try {
        engine.store.transaction(() => spec.drafts.forEach((d) => engine.ingestEvidence(d)));
        await engine.reflect();
        r = await reasonerCalls(engine, model, rounds);
      } finally {
        engine.close();
      }
      done.set(sig, r);
      calls.push(...r.calls);
      groups += r.groups;
      probes += r.probes;
    }
    if (spec.postOp) {
      // 扰动以后再整理一次：每条追问再判一轮，再出一次假设、一次追问（往高里算）
      calls.push(...r.judgeCalls);
      if (r.propose) calls.push(r.propose);
      if (r.probeCalls[0]) calls.push(r.probeCalls[0]);
    }
    extracted = true;
  }
  if (extracted) {
    const engine = MemoryEngine.open({ file: ":memory:", clock: () => specs[0]!.clock });
    try {
      engine.store.transaction(() => [...union.values()].forEach((d) => engine.ingestEvidence(d)));
      calls.unshift(...extractCalls(engine.store.listEvidence({ status: "active" }), engine, model, options.batchSize));
    } finally {
      engine.close();
    }
  }
  return {
    model,
    evidence: union.size,
    groups,
    probes,
    calls,
    engines: specs.length,
    uniqueEngines: done.size,
    estimate: estimateCost(model, calls),
    notes: [
      "token 按字数估：中文约 0.6 个 / 字，其余约 0.3 个 / 字符；输出按经验值估",
      `价格：${PRICE_SOURCE}，输入按缓存未命中算`,
      `评测要建 ${specs.length} 个库，证据和时间一样的只算一次（同样的请求只问一次），剩 ${done.size} 个；抽事实按 ${union.size} 条证据算一遍（所有库共用一个抽取器）`,
      `结构照规则版的结果（这些库一共 ${groups} 组、${probes} 条追问，含往上抽的组：模型版不往上抽，算作余量），追问按 ${rounds} 轮算；扰动以后每个库再整理一次按"每条追问再判一轮 + 出一次假设、一次追问"算`,
    ],
  };
}

const yuan = (n: number) => `¥${n.toFixed(n < 0.1 ? 4 : 2)}`;

export function formatPlan(plan: ModelRunPlan, label: string): string {
  const rows = Object.entries(plan.estimate.byPurpose).map(([purpose, p]) => `| ${purpose} | ${p.calls} | ${p.inputTokens} | ${p.outputTokens} |`);
  return [
    `模型版预计（不调用模型）：${label}，${plan.evidence} 条证据`,
    `模型：${plan.model}`,
    "| 用途 | 次数 | 输入 token | 输出 token |",
    "|---|---|---|---|",
    ...rows,
    `合计：${plan.estimate.calls} 次调用，输入约 ${plan.estimate.inputTokens} token，输出约 ${plan.estimate.outputTokens} token`,
    `预计费用：高峰约 ${yuan(plan.estimate.peakYuan)}，空闲约 ${yuan(plan.estimate.offPeakYuan)}（往高里算看高峰）`,
    ...plan.notes.map((n) => `- ${n}`),
  ].join("\n");
}
