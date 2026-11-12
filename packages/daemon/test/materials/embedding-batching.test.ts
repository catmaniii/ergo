// 交给向量模型的一批怎么切（439）：守护进程曾经因为一批 16 条补齐到 1904 token 占到 8.7 GB。
// - 从长到短排，一批"条数 × 最长²"、"条数 × 最长"都不超过上限，长的单独一批，短的照样一批很多条；
// - 那一夜的样子（16 条里两条 1900 token 上下）切开后每批都在上限里；
// - 算完按原来的顺序交回；模型给回的条数不对就出错。
import { describe, expect, it } from "vitest";
import { BATCH_MAX_ATTENTION, BATCH_MAX_TOKENS, EMBED_MAX_TOKENS, embedInBatches, tokenBatches } from "../../src/materials/embedding/batching.ts";

/** 一批的注意力格数、token 数（补齐到最长的） */
const cost = (lengths: readonly number[], batch: readonly number[]) => {
  const longest = Math.max(...batch.map((i) => lengths[i]!));
  return { attention: batch.length * longest * longest, tokens: batch.length * longest };
};

describe("按 token 切批", () => {
  it("11-08 那一夜的第一批：16 条里两条 1900 token 上下，切开后每批都在上限里，每条都在、只出现一次", () => {
    const night = [46, 1894, 179, 1904, 55, 71, 59, 713, 46, 12, 31, 95, 23, 14, 56, 93];
    const batches = tokenBatches(night);
    expect(batches.flat().toSorted((a, b) => a - b)).toEqual(night.map((_, i) => i));
    for (const batch of batches) {
      const { attention, tokens } = cost(night, batch);
      // 一条本身就超过的单独一批（这里没有超过的）
      expect(attention).toBeLessThanOrEqual(BATCH_MAX_ATTENTION);
      expect(tokens).toBeLessThanOrEqual(BATCH_MAX_TOKENS);
    }
    // 两条长的各自单独一批，短的凑在一起
    expect(batches[0]).toEqual([3]);
    expect(batches[1]).toEqual([1]);
    expect(batches.length).toBeLessThanOrEqual(5);
    // 原来补齐到 1904 的一整批：注意力格数是上限的十几倍
    expect(16 * 1904 * 1904).toBeGreaterThan(10 * BATCH_MAX_ATTENTION);
  });

  it("全是短的：一批照样放很多条（不超过 token 上限）；一样长的按原来的先后", () => {
    const short = Array.from({ length: 40 }, () => 50);
    const batches = tokenBatches(short);
    expect(batches[0]).toHaveLength(40);
    expect(batches[0]).toEqual(short.map((_, i) => i));
    const many = Array.from({ length: 300 }, () => 64);
    for (const batch of tokenBatches(many)) expect(batch.length * 64).toBeLessThanOrEqual(BATCH_MAX_TOKENS);
  });

  it("每条最多 EMBED_MAX_TOKENS：截到上限的一条单独一批；上限可以换", () => {
    expect(EMBED_MAX_TOKENS * EMBED_MAX_TOKENS).toBeLessThanOrEqual(BATCH_MAX_ATTENTION);
    expect(tokenBatches([EMBED_MAX_TOKENS, EMBED_MAX_TOKENS, 10])).toEqual([[0], [1], [2]]);
    expect(tokenBatches([4, 4, 4], { maxAttention: 32, maxTokens: 100 })).toEqual([[0, 1], [2]]);
    expect(tokenBatches([])).toEqual([]);
  });
});

/** 假的 token 数：字数加开头结尾两个 */
const count = (text: string) => Math.min(EMBED_MAX_TOKENS, text.length + 2);

describe("分批算、按原顺序交回", () => {
  it("长的先算，交回的顺序和输入一致；交给模型的每一批都在上限里", async () => {
    const texts = ["短", "很长".repeat(900), "中等".repeat(200), "也短"];
    const seen: string[][] = [];
    const vectors = await embedInBatches(texts, count, async (batch) => {
      seen.push(batch);
      return batch.map((text) => Float32Array.of(text.length));
    });
    expect(vectors.map((v) => v[0])).toEqual(texts.map((text) => text.length));
    expect(seen[0]).toEqual([texts[1]]);
    for (const batch of seen) {
      const longest = Math.max(...batch.map(count));
      expect(batch.length * longest * longest).toBeLessThanOrEqual(BATCH_MAX_ATTENTION);
    }
  });

  it("没有文字：不交给模型；模型给回的条数不对：出错", async () => {
    let calls = 0;
    expect(
      await embedInBatches([], () => 1, async () => {
        calls += 1;
        return [];
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
    await expect(embedInBatches(["一", "二"], () => 3, async () => [Float32Array.of(1)])).rejects.toThrow("给回 1 条");
  });
});
