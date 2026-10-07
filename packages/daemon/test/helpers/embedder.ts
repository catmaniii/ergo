// 假的向量函数：测试里不下载、不跑真的 bge-m3。
// 按"概念"出向量：同一组里的词（搬家 / 换个地方住……）落在同一维上，所以不共享关键词的两句话也能"语义相近"；
// 另外把每个字散列到几维上，权重很小，只是让不同的句子向量不完全一样。
// 还能模拟模型文件不在（available），以及把计算卡住、等测试放行（hold），测"写入在向量算出之前就返回"。
import type { Embedder } from "../../src/materials/embedding/embedder.ts";
import type { Materials } from "../../src/materials/materials.ts";
import { waitUntil } from "./process.ts";

/** 默认的概念组：每组里的词算同一个意思 */
export const FAKE_CONCEPTS: readonly (readonly string[])[] = [
  ["搬家", "换个地方住", "换房子", "搬到", "新住处"],
  ["跑步", "健身", "锻炼", "运动"],
  ["吃饭", "餐厅", "晚饭", "外卖", "做饭"],
  ["照片", "相册", "图片", "拍照"],
  ["上班", "工作", "加班", "老板"],
];

const HASH_DIMS = 16;

export interface FakeEmbedderOptions {
  model?: string;
  available?: boolean;
  concepts?: readonly (readonly string[])[];
}

export class FakeEmbedder implements Embedder {
  readonly model: string;
  /** 每次 embed 收到的文字 */
  readonly calls: string[][] = [];
  private present: boolean;
  private readonly concepts: readonly (readonly string[])[];
  private gate: Promise<void> | undefined;
  private releaseGate: (() => void) | undefined;
  /** close() 一次加 1：关掉时正在算的那批出错，之后的照常（和真的一样，关掉后再用会重新拉起） */
  private generation = 0;

  constructor(options: FakeEmbedderOptions = {}) {
    this.model = options.model ?? "fake-embed@1";
    this.present = options.available ?? true;
    this.concepts = options.concepts ?? FAKE_CONCEPTS;
  }

  available(): boolean {
    return this.present;
  }

  /** 模拟用户把模型文件放进（或拿出）模型区 */
  setAvailable(present: boolean): void {
    this.present = present;
  }

  unavailableHint(): string {
    return `测试用的向量模型 ${this.model} 不在`;
  }

  /** 之后的计算都卡住，直到调用返回的 release */
  hold(): () => void {
    let release!: () => void;
    this.gate = new Promise((resolve) => {
      release = resolve;
    });
    this.releaseGate = () => {
      this.gate = undefined;
      release();
    };
    return this.releaseGate;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    const generation = this.generation;
    while (this.gate) await this.gate;
    if (generation !== this.generation) throw new Error("向量函数已关闭");
    return texts.map((text) => this.vectorOf(text));
  }

  /** 和真的一样：关掉时正在算的那批出错 */
  async close(): Promise<void> {
    this.generation += 1;
    this.releaseGate?.();
  }

  private vectorOf(text: string): Float32Array {
    const v = new Float32Array(this.concepts.length + HASH_DIMS);
    this.concepts.forEach((words, i) => {
      for (const w of words) if (text.includes(w)) v[i]! += 1;
    });
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      v[this.concepts.length + (code % HASH_DIMS)]! += 0.05;
    }
    return v;
  }
}

/**
 * 等后台的向量补算告一段落：没有要算的了，或者在等模型文件、出错了等重试。
 * 测试接缝（照 countAgentSpawns 的做法，不在正式接口里）：只看 vectorStatus()。
 * 守护进程启动后的补算是过一会儿（BACKFILL_DELAY_MS）才开始的：重启后要等补算，先把 ManualClock 拨过去。
 */
export async function vectorsSettled(materials: Materials, timeoutMs = 10_000): Promise<void> {
  await waitUntil(
    () => {
      const s = materials.vectorStatus();
      return s.state === "waiting_for_model" || s.state === "error" || (s.state === "idle" && s.pending === 0);
    },
    { timeoutMs, intervalMs: 10, describe: () => JSON.stringify(materials.vectorStatus()) },
  );
}
