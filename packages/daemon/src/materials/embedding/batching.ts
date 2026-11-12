// 交给向量模型的一批怎么切（439）：守护进程曾经占到 8.7 GB，就是向量模型一批 16 条、按最长那条（1904 token）补齐后一起算——
// bge-m3 的注意力层要按"条数 × 头数 × 长度²"开中间结果（每格 4 字节，同时活着约两份），一批补齐到近两千 token 就是好几 GB，
// 推理库（onnxruntime）还会把这么大的内存留在自己的池子里，直到线程闲 10 分钟卸掉。所以在推理后端里统一切：
// - 每条最多算开头 EMBED_MAX_TOKENS 个 token（bge-m3 本来能吃 8192 个，一条 8192 的单独算也要好几 GB）；
// - 按 token 数从长到短排，凑批时"条数 × 最长的²"不超过 BATCH_MAX_ATTENTION、"条数 × 最长的"不超过 BATCH_MAX_TOKENS，
//   长的单独一批，短的照样一批算很多条（补齐浪费也少了）；
// - 算完按原来的顺序交回。
// 所有调用方（素材的向量索引、记忆引擎的证据、事实、结论、查询）都经过推理后端，一处管住；调用方自己凑的批（每批 16 条、
// 素材的 EMBED_MAX_CHARS）照旧，这里只是再按 token 切细。
// 这里只有纯函数，不引用 transformers.js（推理后端 bge-m3-backend.ts 引用它，工作线程里加载）。

/** 每条最多算开头多少 token（超出的截掉） */
export const EMBED_MAX_TOKENS = 2048;
/** 一次交给模型的一批：条数 × 最长的 token 数²（注意力中间结果的格数；2048² 约占 0.5 GB）不超过它 */
export const BATCH_MAX_ATTENTION = 2048 * 2048;
/** 一次交给模型的一批：条数 × 最长的 token 数不超过它（前馈层的中间结果跟着它涨） */
export const BATCH_MAX_TOKENS = 8192;

export interface BatchLimits {
  maxAttention: number;
  maxTokens: number;
}

const DEFAULT_LIMITS: BatchLimits = { maxAttention: BATCH_MAX_ATTENTION, maxTokens: BATCH_MAX_TOKENS };

/**
 * 按每条的 token 数（已经按 EMBED_MAX_TOKENS 截过）切批：从长到短排，一批"条数 × 最长²"、"条数 × 最长"都不超过上限
 * （一条本身就超过的单独一批）。交回每批里各条在原来列表里的下标
 */
export function tokenBatches(lengths: readonly number[], limits: BatchLimits = DEFAULT_LIMITS): number[][] {
  const order = lengths.map((_, i) => i).toSorted((a, b) => lengths[b]! - lengths[a]! || a - b);
  const batches: number[][] = [];
  for (const index of order) {
    const last = batches.at(-1);
    // 从长到短排的：这一批第一条最长
    const longest = last === undefined ? 0 : Math.max(1, lengths[last[0]!]!);
    const rows = (last?.length ?? 0) + 1;
    if (last !== undefined && rows * longest * longest <= limits.maxAttention && rows * longest <= limits.maxTokens) last.push(index);
    else batches.push([index]);
  }
  return batches;
}

/**
 * 一批文字 → 向量（顺序和输入一致）：先数每条的 token 数（count，已截到 EMBED_MAX_TOKENS），按 tokenBatches 切开，
 * 一批一批交给 run（run 自己按 EMBED_MAX_TOKENS 截断、补齐到这一批最长的），再按原来的顺序拼回
 */
export async function embedInBatches(
  texts: readonly string[],
  count: (text: string) => number,
  run: (texts: string[]) => Promise<Float32Array[]>,
  limits: BatchLimits = DEFAULT_LIMITS,
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = Array.from({ length: texts.length });
  for (const batch of tokenBatches(texts.map(count), limits)) {
    const out = await run(batch.map((i) => texts[i]!));
    if (out.length !== batch.length) throw new Error(`向量模型给回 ${out.length} 条，要的是 ${batch.length} 条`); // @i18n-ignore log：编程错误
    batch.forEach((index, row) => (vectors[index] = out[row]!));
  }
  return vectors;
}
