// 证据来源接口：PoC 读合成数据（synthetic.ts），接二狗时加一个读素材库的适配器，字段一一对应（第 4.1 节）。
import type { EvidenceDraft } from "../domain/types.ts";

export interface EvidenceSource {
  /** 来源的名字（synthetic、materials……），出现在报告里 */
  readonly name: string;
  /** 这批证据的"现在"（合成数据集的 now）；接真数据时就是现在 */
  readonly now: string;
  /** 全部证据草稿，按来源里的顺序 */
  read(): EvidenceDraft[];
}
