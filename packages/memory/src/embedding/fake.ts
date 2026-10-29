// 假向量：测试和演示不下载、不跑真模型。思路照守护进程的 test/helpers/embedder.ts（不跨包引用测试文件）：
// 按"概念"出向量，同一组里的词落在同一维上，所以不共享关键词的两句话也能"语义相近"；另外把每个字散列到几维上、权重很小，
// 只是让不同的句子向量不完全一样。和守护进程那份不同的是：结果归一化（和 bge-m3 一样，余弦就是点积），
// 查询和文档分开算、查询可以加前缀（模拟要指令前缀的模型）。
import { type Embedder, type EmbedRole, normalize } from "./embedder.ts";

/** 默认的概念组：记忆 PoC 的合成数据常见的几类 */
export const FAKE_CONCEPTS: readonly (readonly string[])[] = [
  ["聚会", "饭局", "聚餐", "见朋友", "社交", "约朋友", "派对", "生日会", "团建"],
  ["休息", "放松", "歇", "躺平", "宅", "补觉", "睡懒觉"],
  ["忙", "累", "疲惫", "加班", "没空", "赶工", "压力"],
  ["周末", "周六", "周日", "星期六", "星期天", "双休"],
  ["工作日", "周一", "周二", "周三", "周四", "周五"],
  ["上班", "工作", "项目", "同事", "老板", "公司", "升职", "转岗"],
  ["技术交流", "分享会", "讲座", "技术沙龙", "meetup", "交流会"],
  ["旅行", "旅游", "出差", "度假", "酒店", "民宿"],
  ["跑步", "健身", "爬山", "徒步", "运动", "骑行"],
  ["吃饭", "餐厅", "晚饭", "外卖", "做饭", "吃辣"],
  ["远程办公", "在家办公", "混合办公", "坐班"],
  ["拒绝", "推掉", "不去", "取消", "婉拒", "没去"],
];

const HASH_DIMS = 16;

export interface FakeEmbedderOptions {
  model?: string;
  available?: boolean;
  concepts?: readonly (readonly string[])[];
  /** 查询前缀（默认不加） */
  queryPrefix?: string;
}

export class FakeEmbedder implements Embedder {
  readonly model: string;
  /** 每次算的那一批：哪种角色、实际算的文字（加过前缀的） */
  readonly calls: { role: EmbedRole; texts: string[] }[] = [];
  private present: boolean;
  private readonly concepts: readonly (readonly string[])[];
  private readonly queryPrefix: string;

  constructor(options: FakeEmbedderOptions = {}) {
    this.model = options.model ?? "fake-embed@1";
    this.present = options.available ?? true;
    this.concepts = options.concepts ?? FAKE_CONCEPTS;
    this.queryPrefix = options.queryPrefix ?? "";
  }

  available(): boolean {
    return this.present;
  }

  setAvailable(present: boolean): void {
    this.present = present;
  }

  unavailableHint(): string {
    return `测试用的向量模型 ${this.model} 不在`;
  }

  embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return this.embed("document", [...texts]);
  }

  embedQueries(texts: readonly string[]): Promise<Float32Array[]> {
    return this.embed("query", texts.map((t) => this.queryPrefix + t));
  }

  async close(): Promise<void> {}

  private async embed(role: EmbedRole, texts: string[]): Promise<Float32Array[]> {
    if (!this.present) throw new Error(this.unavailableHint());
    this.calls.push({ role, texts });
    return texts.map((t) => this.vectorOf(t));
  }

  private vectorOf(text: string): Float32Array {
    const v = new Float32Array(this.concepts.length + HASH_DIMS);
    this.concepts.forEach((words, i) => {
      for (const w of words) if (text.includes(w)) v[i]! += 1;
    });
    for (const ch of text) v[this.concepts.length + (ch.codePointAt(0)! % HASH_DIMS)]! += 0.05;
    return normalize(v);
  }
}
