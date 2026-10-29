// 数据源的素材写法（303 号票，issue 25 第 2 节"按来源定证据的性质"）：数据源插件在自己的采集规则里
// （数据契约里 ctx.materialSources.register 的 capture）用 dataSourceMaterial 把一条记录写成素材草稿。
// 三种素材各有固定的来源等级、说或做和切段，记忆插件读成证据时据此定证据的性质（memory/data-source-evidence.ts）：
// - 观察到的本人行为（observed_behavior）：本人做的——来源本人、"做"，能当关于用户的证据；text 是插件整理好的摘要
//   （"下午开了两个会"），切成一段"文字"（本人的切段，留原文副本）；
// - 别人写给你的（received_writing）：别人说的——来源外部（不可信）、"说"，只当背景、不撑结论；text 是摘要（"张三：周五的会改到下午"），
//   切成一段"引用块"，只留摘要当说明和内容哈希，正文不进切段、不进原文副本；要检索得到正文就给 indexText（只进索引，同 166 号票存的网页）；
// - 本人写的（own_writing）：本人说的——来源本人、"说"；text 是原话（发出的邮件、笔记），切成一段"打的字"。
// 每条带出处 origin：哪个数据源、场景（结束时间、地点、和谁、场景标签）、这条落在哪些敏感类别（不写 = 数据源登记的全部，保守）。
// 采集规则要确定性（ADR-0006）：只看事件本身——时间、场景、敏感类别都放进插件自己的事件负载，不读时钟、不读会变的设置。
import type { SensitiveCategory } from "../config/config.ts";
import type { MaterialDraft } from "../materials/capture.ts";
import { type MaterialPiece, segmentPieces } from "../materials/segments.ts";
import { DATA_SOURCE_MATERIAL_SOURCE, type DataSourceMaterialKind, type MaterialScene } from "../materials/types.ts";
import type { DataSource } from "./api.ts";

/** 数据源的一条记录要写成的素材 */
export interface DataSourceRecordMaterial {
  /** 哪种：观察到的本人行为、别人写给你的、本人写的 */
  kind: DataSourceMaterialKind;
  /** 观察到的本人行为、别人写给你的：插件整理好的摘要；本人写的：原话 */
  text: string;
  /** 发生的时间（开始，带时区偏移的 ISO）；不给用事件的时间 */
  time?: string;
  /** 场景：结束时间、地点、和谁、场景标签（work、social、travel……认得出才给） */
  scene?: MaterialScene;
  /**
   * 这条落在哪些敏感类别：其中有一类没打开推断，整条不读成证据。不写是数据源登记的全部（保守）；
   * 一条记录不涉及的（挂脖相机拍到开会，不涉及健康）写窄。地点不用为它写"位置"：地点放 scene.place，位置没打开时证据里只去掉地点
   */
  sensitive?: readonly SensitiveCategory[];
  /** 只进检索的正文（别人写给你的邮件正文这类外部内容）：不进切段、不进原文副本，推断不拿它 */
  indexText?: string;
  /** 原文在插件事件负载里的字段名（切段的位置；默认 text） */
  field?: string;
  /** 插件自己那条记录的 id（素材里指向原始记录的引用） */
  recordId?: string;
}

/** 场景整理成确定的样子：去掉空白的、重复的，空的项不写 */
function normalizedScene(scene: MaterialScene | undefined): MaterialScene {
  const place = scene?.place?.trim();
  const people = [...new Set((scene?.people ?? []).map((p) => p.trim()).filter((p) => p.length > 0))];
  const tags = [...new Set((scene?.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0))];
  return {
    ...(scene?.end === undefined ? {} : { end: scene.end }),
    ...(place === undefined || place.length === 0 ? {} : { place }),
    ...(people.length === 0 ? {} : { people }),
    ...(tags.length === 0 ? {} : { tags }),
  };
}

/** 一条记录 → 素材草稿（采集规则交回它）。source 是登记的那个数据源（取 id 和登记的敏感类别） */
export function dataSourceMaterial(source: Pick<DataSource, "id" | "sensitive">, record: DataSourceRecordMaterial): MaterialDraft {
  const locator = { field: record.field ?? "text" };
  const piece: MaterialPiece =
    record.kind === "observed_behavior"
      ? { form: "text", text: record.text, locator }
      : record.kind === "own_writing"
        ? { form: "typed", text: record.text, locator }
        : { form: "quote", text: record.indexText ?? record.text, label: record.text, locator };
  return {
    kind: record.kind,
    source: DATA_SOURCE_MATERIAL_SOURCE[record.kind],
    segments: segmentPieces([piece]),
    ...(record.time === undefined ? {} : { time: record.time }),
    ...(record.recordId === undefined ? {} : { ref: { recordId: record.recordId } }),
    ...(record.indexText === undefined ? {} : { indexText: record.indexText }),
    origin: { dataSource: source.id, scene: normalizedScene(record.scene), sensitive: [...new Set(record.sensitive ?? source.sensitive ?? [])] },
  };
}
