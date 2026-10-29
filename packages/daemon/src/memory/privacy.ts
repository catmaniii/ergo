// 敏感类别（234 号票，接入设计第 7 节）：健康、情绪、财务、关系默认允许记录、不用于推断；295 号票加了位置（数据源用到的敏感类别对上这里），
// 303 号票把它接上（数据源素材的出处、场景里的地点）。
//
// "不用于推断"落在证据层（MaterialsEvidenceSource）：一条素材的场景里落进了没打开的敏感类别，就不读成证据，
// 夜里的整理不会拿它抽事实、推结论；素材库照旧记录、检索得到（默认允许记录）。
//
// 对话里的素材按场景标签生效：只有健康在场景维度里有标签（CONTEXT_DIMENSIONS.domain 的 health，从原文的"体检、跑步、生病……"
// 或素材自己的标签来）。情绪、财务、关系、位置在对话里没有场景标签，配置里打开也不改变行为——开关占位；
// 303 号票起数据源的素材另有一条路（inferableByOrigin、placeInferable）：素材的出处里写着这条落在哪些敏感类别（插件按记录写，
// 不写是数据源登记的全部），有一类没打开就整条不读；场景里的地点算位置，位置没打开时读成证据也不带地点。
// "别推断"标记独立生效（素材上有这个标记，不管哪一类都不读）。
import { SENSITIVE_CATEGORY_LABELS, type SensitiveCategory } from "../config/config.ts";
import type { MaterialOrigin } from "../materials/types.ts";

/** 敏感类别 → 场景标签（v1 只有健康有；空的几类是占位） */
export const SENSITIVE_SCENE_TAGS: Readonly<Record<SensitiveCategory, readonly string[]>> = {
  health: ["health"],
  emotion: [],
  finance: [],
  relationship: [],
  location: [],
};

/** 这组场景标签落在哪个敏感类别上（一个都没落在敏感类别上时是 undefined） */
export function sensitiveCategoryOfScene(context: readonly string[]): SensitiveCategory | undefined {
  for (const [category, tags] of Object.entries(SENSITIVE_SCENE_TAGS) as Array<[SensitiveCategory, readonly string[]]>) {
    if (tags.some((tag) => context.includes(tag))) return category;
  }
  return undefined;
}

/**
 * 这条素材能不能用来推断：没落在敏感类别上，或者这一类在允许推断的列表里。
 * 别推断的标记由调用方先看（素材上有标记一律不读）。
 */
export function inferableBySensitivity(context: readonly string[], allowed: readonly SensitiveCategory[]): boolean {
  const category = sensitiveCategoryOfScene(context);
  return category === undefined || allowed.includes(category);
}

/** 303 号票：数据源素材的出处里写的敏感类别都打开了推断（一类都没写的也算）；没有出处的（对话里的素材）不看这一条 */
export function inferableByOrigin(origin: Pick<MaterialOrigin, "sensitive"> | undefined, allowed: readonly SensitiveCategory[]): boolean {
  return origin === undefined || origin.sensitive.every((category) => allowed.includes(category));
}

/** 303 号票：场景里的地点能不能读成证据（位置这一类打开了推断才能） */
export function placeInferable(allowed: readonly SensitiveCategory[]): boolean {
  return allowed.includes("location");
}

/** 给人看的一句话（日志、以后设置页）：<类别>类内容默认只记录、不用于推断 */
export function sensitiveCategoryLabel(category: SensitiveCategory): string {
  return SENSITIVE_CATEGORY_LABELS[category];
}

/**
 * 267 号票：没打开推断的那几类敏感类别的场景标签（交给推理图谱的唯一写入口：在这些标签上不推断，用户明说的照常记）。
 * 证据层已经不读这几类的素材（MaterialsEvidenceSource），这是推理那一层的第二道
 */
export function lockedSensitiveTags(allowed: readonly SensitiveCategory[]): string[] {
  return (Object.entries(SENSITIVE_SCENE_TAGS) as Array<[SensitiveCategory, readonly string[]]>).filter(([category]) => !allowed.includes(category)).flatMap(([, tags]) => tags);
}
