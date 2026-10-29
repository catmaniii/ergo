// RRF（Reciprocal Rank Fusion）融合：每一路给一个排好序的列表，某条在这一路排第 r 名就得 w / (k + r)，各路加起来。
// 只看名次、不看各路分数的大小，所以 bm25、余弦、图扩展的权重这些量纲不同的分数可以直接合在一起。k 取 60（常用值，票里定的）。
// 194 号票：每一路可以有权重（精炼陈述那两路默认 0.5），某一路里场景对不上的命中再乘一个系数（offContextFactor），名次不变。
import type { ChannelScore, SearchChannel } from "./types.ts";

export const RRF_K = 60;

export interface RankedList {
  channel: SearchChannel;
  /** 已经按这一路的分数排好（第一个是第 1 名）；同一个 id 再出现只算第一次。offContext：场景对不上（这一路给它的票打折） */
  items: readonly { id: string; score: number; offContext?: boolean }[];
}

export interface Fused {
  id: string;
  fused: number;
  channels: Partial<Record<SearchChannel, ChannelScore>>;
}

export interface RrfOptions {
  k?: number;
  /** 某一路的权重（默认 1） */
  weights?: Partial<Record<SearchChannel, number>>;
  /** 场景对不上的命中，这一路给它的票乘的系数（默认 1，不打折） */
  offContextFactor?: number;
}

/** 融合；按融合分从高到低，同分的先看最好的那个名次，再看 id（结果确定） */
export function fuseRrf(lists: readonly RankedList[], options: RrfOptions = {}): Fused[] {
  const k = options.k ?? RRF_K;
  const off = options.offContextFactor ?? 1;
  const out = new Map<string, Fused>();
  for (const list of lists) {
    const w = options.weights?.[list.channel] ?? 1;
    let rank = 0;
    const seen = new Set<string>();
    for (const item of list.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rank += 1;
      const f = out.get(item.id) ?? { id: item.id, fused: 0, channels: {} };
      f.fused += (w * (item.offContext ? off : 1)) / (k + rank);
      f.channels[list.channel] = item.offContext ? { rank, score: item.score, offContext: true } : { rank, score: item.score };
      out.set(item.id, f);
    }
  }
  return [...out.values()].toSorted(compareFused);
}

const bestRank = (f: Pick<Fused, "channels">) => Math.min(...Object.values(f.channels).map((c) => c!.rank));

/** 融合分从高到低（浮点加法顺序不同的差别当同分），同分先看最好的名次，再看 id */
export function compareFused(a: Pick<Fused, "id" | "fused" | "channels">, b: Pick<Fused, "id" | "fused" | "channels">): number {
  const d = b.fused - a.fused;
  if (Math.abs(d) > 1e-12) return d;
  return bestRank(a) - bestRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
