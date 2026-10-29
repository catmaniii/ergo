// 218 号票：模型输出被截断、解析不了时不让整步失败（出假设、往上抽、编策略共用；追问、判证据、抽事实只记数，不走这一套）。
// 217 号票第三轮建库时，每次都有一个人的库几乎是空的：出假设那一步一次调用塞进全部观察，输出被 8000 token 截断或者解析不了，
// 整步什么都没留下。这里的做法：
// - 分批：调用方按估算的输出长度把输入切成几批（askInBatches 的 batches），每批独立，一批坏了不连累别的批；
// - 判截断：回应的 finish_reason = length（ChatResponse.truncated），或者 JSON 的括号、引号没收口；
// - 宽松解析：整段解析不了时，从列表（groups、strategies）里把已经完整的条目一条条取出来，丢掉最后半条（salvageList）；
// - 剩下的（这一批里没被救回的条目用上的输入）对半切小重试，最多两层（MAX_SPLIT_DEPTH）；切不动、两层还不行的那批放弃；
// - 每一步记进 dropped（截断、解析不了、救回几条、对半切、放弃，写明原因和涉及的输入），不悄悄吞掉；
// - 每一步记数（StageCallStats，进 reflect 的报告和建库的统计）。
// 空回答（调用失败、MeteredChat 封顶交回的空串）不重试：切小了也一样发不出去。
import type { DroppedOutput, ModelBudget } from "../rg/types.ts";
import type { ChatModel, ChatRequest, ChatResponse } from "./chat.ts";
import { parseModelJson } from "./json.ts";

/** 对半切小重试最多几层 */
export const MAX_SPLIT_DEPTH = 2;

/** 一步（extract、propose、probes、judge、lift、strategies）的模型调用统计 */
export interface StageCallStats {
  /** 真发出去的调用（扣了预算的，含重试） */
  calls: number;
  /** 一开始切了几批（走分批的步骤才有） */
  batches: number;
  /** 输出被截断（finish_reason = length，或者括号没收口） */
  truncated: number;
  /** 没被截断、但整段解析不了 */
  unparsed: number;
  /** 空回答（调用失败、封顶） */
  empty: number;
  /** 从截断、解析不了的输出里救回几条完整的条目 */
  salvaged: number;
  /** 对半切小重试发了几次 */
  retries: number;
  /** 截断、解析不了的那次最后都有着落（救回的加上重试的把这批的输入都做完了） */
  recovered: number;
  /** 放弃的批：切了两层还不行、切不动，或者空回答 */
  lost: number;
  /** 预算用完没问的批 */
  unasked: number;
  /** 272 号票：问过、没变化就没再问的输入（出假设的观察、往上抽的下层断言），按条数 */
  unchanged: number;
}

export type StageName = DroppedOutput["stage"];
export type StageStatsMap = Partial<Record<StageName, StageCallStats>>;

export const emptyStageStats = (): StageCallStats => ({ calls: 0, batches: 0, truncated: 0, unparsed: 0, empty: 0, salvaged: 0, retries: 0, recovered: 0, lost: 0, unasked: 0, unchanged: 0 });

/** 取出（没有就建）这一步的统计；不给 map 时给一份用完就扔的 */
export function stageStats(map: StageStatsMap | undefined, stage: StageName): StageCallStats {
  if (!map) return emptyStageStats();
  return (map[stage] ??= emptyStageStats());
}

/** 把 from 的每一步加进 into */
export function addStageStats(into: StageStatsMap, from: StageStatsMap | undefined): StageStatsMap {
  for (const [stage, s] of Object.entries(from ?? {}) as [StageName, StageCallStats][]) {
    const t = stageStats(into, stage);
    // 以前存下的统计没有后来加的字段（272 号票的 unchanged）：当 0
    for (const k of Object.keys(t) as (keyof StageCallStats)[]) t[k] += s[k] ?? 0;
  }
  return into;
}

export type OutputOutcome = "ok" | "truncated" | "unparsed" | "empty";

/** 从一个位置起扫一个 JSON 值，返回它后面的位置；到了结尾还没收口返回 -1 */
function scanValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') return i + 1;
    }
    return -1;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        const end = scanValue(text, i);
        if (end < 0) return -1;
        i = end - 1;
      } else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  // 数字、true、false、null：到逗号、右括号、空白为止
  for (let i = start; i < text.length; i++) if (/[,\]}\s]/.test(text[i]!)) return i;
  return -1;
}

/** 从第一个 { 起括号、引号收没收口（没收口说明是写到一半被截断的） */
export function isUnclosed(content: string): boolean {
  const start = content.indexOf("{");
  if (start < 0) return false;
  return scanValue(content, start) < 0;
}

export interface Salvaged {
  /** 列表里已经完整、解析得了的条目 */
  items: unknown[];
  /** 最后半条（没收口）丢掉了 */
  partial: boolean;
  /** 完整但解析不了、丢掉的条目 */
  bad: number;
}

/** 宽松解析：从 "key": [ ... 里把完整的条目一条条取出来，丢掉最后半条；找不到这个列表就什么都没有 */
export function salvageList(content: string, key: string): Salvaged {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(content);
  if (!m) return { items: [], partial: false, bad: 0 };
  const items: unknown[] = [];
  let bad = 0;
  let i = m.index + m[0].length;
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "," || /\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "]") return { items, partial: false, bad };
    const end = scanValue(content, i);
    if (end < 0) return { items, partial: true, bad };
    // 237 号票：这里的 i 必须往前走。模型偶尔把列表的 ] 写成 }（"groups": [{…}} 这种），
    // scanValue 碰到"该是条目的地方是个 }"会原地返回 i；以前直接 i = end，while 就原地转，
    // 整段建库卡死（CPU 打满、不再调模型，229 号票 p2 卡了 22 分钟）。这种残破的列表后面
    // 没有完整的条目可救：记一条解析不了的，停下，剩下的交给 askInBatches 切小重试。
    if (end <= i) return { items, partial: false, bad: bad + 1 };
    try {
      items.push(JSON.parse(content.slice(i, end)));
    } catch {
      bad++;
    }
    i = end;
  }
  return { items, partial: false, bad };
}

export interface InspectedOutput {
  outcome: OutputOutcome;
  /** 整段解析出来的对象（ok 时） */
  parsed?: Record<string, unknown>;
  /** 列表里能用的条目：ok 时是整个列表，截断、解析不了时是救回的 */
  items: unknown[];
  partial: boolean;
  bad: number;
  /** 解析不了的原因 */
  detail: string;
}

/** 看一次回应：整段能解析就是 ok；不能就判是截断还是解析不了（或者空回答），再宽松解析救回完整的条目 */
export function inspectOutput(response: ChatResponse, listKey: string): InspectedOutput {
  const content = response.content ?? "";
  if (content.trim() === "") return { outcome: "empty", items: [], partial: false, bad: 0, detail: "模型没有回答（调用失败、到了次数或花费上限）" };
  try {
    const parsed = parseModelJson(content);
    const list = parsed[listKey];
    return { outcome: "ok", parsed, items: Array.isArray(list) ? list : [], partial: false, bad: 0, detail: "" };
  } catch (err) {
    const s = salvageList(content, listKey);
    const truncated = response.truncated === true || isUnclosed(content);
    return { outcome: truncated ? "truncated" : "unparsed", items: s.items, partial: s.partial, bad: s.bad, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** 只记数的那几步（追问、判证据、抽事实）：一次回应算哪一类，记进统计 */
export function countOutcome(stats: StageCallStats, response: ChatResponse): OutputOutcome {
  stats.calls++;
  const content = response.content ?? "";
  if (content.trim() === "") {
    stats.empty++;
    return "empty";
  }
  try {
    parseModelJson(content);
    return "ok";
  } catch {
    const truncated = response.truncated === true || isUnclosed(content);
    if (truncated) stats.truncated++;
    else stats.unparsed++;
    return truncated ? "truncated" : "unparsed";
  }
}

/** 一步怎么分批问：请求怎么拼、一条条目用上了哪些输入 */
export interface BatchPlan<U> {
  stage: StageName;
  /** 输出里的列表（groups、strategies） */
  listKey: string;
  /** 输入单位的说法（"条观察"、"条下层断言"、"个依据"），写进 dropped */
  unitLabel: string;
  unitId(u: U): string;
  /** 一批的请求；prior 是这一步前面几批已经拿到的条目（让模型别重复）；不用问时 undefined */
  request(units: readonly U[], prior: readonly unknown[]): ChatRequest | undefined;
  /** 一条救回的条目用上了哪些输入（没用上的才重试） */
  covers(item: unknown): readonly string[];
}

export interface BatchContext {
  budget: ModelBudget;
  dropped: DroppedOutput[];
  stats?: StageStatsMap;
}

export interface BatchResult {
  /** 各批交回的条目（救回的也在里面），按顺序；校验由调用方做 */
  items: unknown[];
  /** 真发出去几次 */
  asked: number;
  /**
   * 272 号票：有着落的输入（unitId）：所在那批模型回了话（解析得了，或者截断时救回的条目盖住了它、切小重试问成了）。
   * 预算用完没问的、空回答、放弃的不算
   */
  settled: string[];
}

/** 把一批输入对半切（顺序不变：调用方切批时已经把相近的排在一起） */
export function halves<U>(units: readonly U[]): U[][] {
  const mid = Math.ceil(units.length / 2);
  return [units.slice(0, mid), units.slice(mid)].filter((h) => h.length > 0);
}

/** 把输入按每批最多 size 个切成几批，各批一样大（差不超过一个） */
export function chunkEvenly<U>(units: readonly U[], size: number): U[][] {
  if (units.length === 0) return [];
  const n = Math.ceil(units.length / Math.max(1, size));
  const out: U[][] = [];
  for (let i = 0; i < n; i++) out.push(units.slice(Math.floor((i * units.length) / n), Math.floor(((i + 1) * units.length) / n)));
  return out;
}

/** 按批问模型（见文件开头）：每批独立；截断、解析不了的救回完整的条目，剩下的对半切小重试，最多两层 */
export async function askInBatches<U>(model: ChatModel, plan: BatchPlan<U>, batches: readonly (readonly U[])[], ctx: BatchContext): Promise<BatchResult> {
  const stats = stageStats(ctx.stats, plan.stage);
  const items: unknown[] = [];
  let asked = 0;
  const settled = new Set<string>();
  const drop = (reason: string, units: readonly U[]) => ctx.dropped.push({ stage: plan.stage, reason, item: units.map((u) => plan.unitId(u)) });
  const count = (n: number) => `${n} ${plan.unitLabel}`;

  /** 问一批；返回这批的输入是不是都有着落了 */
  const run = async (units: readonly U[], depth: number): Promise<boolean> => {
    const request = plan.request(units, items);
    if (!request) return true;
    if (!ctx.budget.take()) {
      stats.unasked++;
      if (depth > 0) drop(`预算用完，没重试：${count(units.length)}这次没出结果`, units);
      return false;
    }
    asked++;
    stats.calls++;
    if (depth > 0) stats.retries++;
    const response = await model.complete(request);
    const out = inspectOutput(response, plan.listKey);
    if (out.outcome === "ok") {
      items.push(...out.items);
      for (const u of units) settled.add(plan.unitId(u));
      return true;
    }
    stats[out.outcome]++;
    if (out.outcome === "empty") {
      stats.lost++;
      drop(`模型没有回答：${out.detail}，${count(units.length)}这次没出结果`, units);
      return false;
    }
    items.push(...out.items);
    stats.salvaged += out.items.length;
    const covered = new Set(out.items.flatMap((item) => plan.covers(item)));
    for (const u of units) if (covered.has(plan.unitId(u))) settled.add(plan.unitId(u));
    const rest = units.filter((u) => !covered.has(plan.unitId(u)));
    const head = out.outcome === "truncated" ? `模型输出被截断：到了上限 maxTokens ${request.maxTokens}` : `模型输出解析不了：${out.detail}`;
    const salvage = [`救回 ${out.items.length} 条完整的`, out.partial ? "丢掉最后半条" : "", out.bad > 0 ? `${out.bad} 条解析不了丢掉` : ""].filter(Boolean).join("，");
    drop(`${head}（${salvage}；这批 ${count(units.length)}，剩 ${rest.length} 没着落）`, units);
    if (rest.length === 0) {
      stats.recovered++;
      return true;
    }
    // 切不动（只剩一个、而且就是原样的这批）或者已经切了两层：放弃
    if (depth >= MAX_SPLIT_DEPTH || (rest.length < 2 && rest.length === units.length)) {
      stats.lost++;
      drop(`放弃：${depth >= MAX_SPLIT_DEPTH ? `对半切了 ${MAX_SPLIT_DEPTH} 层还是不行` : "只剩一个、切不动"}，${count(rest.length)}这次没出结果`, rest);
      return false;
    }
    const parts = rest.length < 2 ? [rest] : halves(rest);
    drop(`对半切小重试：剩下的 ${count(rest.length)}切成 ${parts.length} 批再问（第 ${depth + 1} 层）`, rest);
    let all = true;
    for (const part of parts) all = (await run(part, depth + 1)) && all;
    if (all) stats.recovered++;
    return all;
  };

  stats.batches += batches.length;
  for (const batch of batches) await run(batch, 0);
  return { items, asked, settled: [...settled] };
}
