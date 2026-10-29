// @i18n-ignore-file model：证据原文里的场景一行、几条合成一条时的抬头是给整理模型读的数据（进推理库），不随界面语言变
// 数据源素材读成证据（303 号票，issue 25 第 2 节"按来源定证据的性质""数据源顺带给场景""量大的先整理"）。
// evidence-source.ts 的 MaterialsEvidenceSource 用这里的几样：
//
// - 证据的性质跟着素材的种类走，不在这里另判：观察到的本人行为是本人做的（来源本人 + "做" → 事实的出处 observed，能撑关于用户的结论）、
//   别人写给你的是别人转述的（来源外部 → third_party_reported，canSupportUserClaims 不认，只当背景）、本人写的是本人说的（user_stated）。
//   @ergo/memory 本来就按来源等级和说或做定出处（kg/graph.ts 的 assertionFor），这里只把种类对上证据的种类。
// - 场景带过去（sceneParts、sceneTags）：原文后面加一行"［场景］时间 14:00–17:00 · 地点 望京的公司 · 和 张三"，抽事实的模型看得到
//   时间段、地点、和谁（证据没有放地点和人的字段，@ergo/memory 不改）；场景标签取插件给的场景维度标签（不认得的丢掉），加上那天是工作日
//   还是周末（按日子：周一到周五算工作日，节假日不认），插件没给方面（work、social……）时再从原文按关键词推。
//   地点算位置这一类：位置没打开推断时这一行不带地点、也不拿它推场景。
// - 每晚整理的预算（groupDataSourceItems）：同一个数据源、同一种素材、同一天超过 DIGEST_OVER 条的合成一条证据（每条一行），
//   出处写成 digest:<素材 id,…>（materialIdsOfRef 拆回素材 id，删除、"回忆了 N 条记忆"都按它找）；当天的先不读，等这一天过完再合；
//   每晚最多读进 DATA_SOURCE_EVIDENCE_PER_NIGHT 条（合成的算一条），多的按时间先后留到下一夜——用户说的话照旧全读，不被挤掉。
import { CONTEXT_DIMENSIONS, clauseContext, type Evidence, isKnownContextTag, localDate, toMs } from "@ergo/memory";
import type { Material, MaterialKind } from "../materials/types.ts";

/** 证据原文里场景那一行的开头 */
export const SCENE_LINE_PREFIX = "［场景］";
/** 几条数据源素材合成的一条证据，出处的开头（后面是逗号隔开的素材 id） */
export const DIGEST_REF_PREFIX = "digest:";
/** 同一个数据源、同一种素材，一天超过这么多条就合成一条证据 */
export const DIGEST_OVER = 3;
/** 每晚最多读进几条数据源的证据（合成的一条算一条）；多的按时间先后留到下一夜 */
export const DATA_SOURCE_EVIDENCE_PER_NIGHT = 12;
/** 合成一条时每一条最多留多少字（一条邮件、一段笔记太长时截断） */
const DIGEST_ITEM_CHARS = 200;

const DAYTYPE = CONTEXT_DIMENSIONS.daytype ?? [];
const ASPECT = [...(CONTEXT_DIMENSIONS.domain ?? []), ...(CONTEXT_DIMENSIONS.trip ?? [])];

/** 证据的出处 → 背后的素材 id：一条素材的是它自己，合成的拆开，别的（表态、问题的回答）没有 */
export function materialIdsOfRef(ref: string | null | undefined): string[] {
  if (ref === null || ref === undefined) return [];
  if (ref.startsWith(DIGEST_REF_PREFIX)) return ref.slice(DIGEST_REF_PREFIX.length).split(",").filter((id) => id.length > 0);
  return ref.startsWith("mat-") ? [ref] : [];
}

/** 几条素材合成的一条证据的出处 */
export function digestRef(materialIds: readonly string[]): string {
  return `${DIGEST_REF_PREFIX}${materialIds.join(",")}`;
}

/**
 * 推理库里已经读进来的素材（每晚整理按它跳过）：每条证据背后的素材都算；
 * 只有合成的那条被忘掉了（其中一条素材被用户忘掉）时，它的别的素材不算——下一夜它们重新合成一条
 */
export function ingestedMaterialIds(evidence: readonly Pick<Evidence, "sourceRef" | "status">[]): Set<string> {
  const ids = new Set<string>();
  for (const e of evidence) {
    if (e.status === "forgotten" && e.sourceRef?.startsWith(DIGEST_REF_PREFIX)) continue;
    for (const id of materialIdsOfRef(e.sourceRef)) ids.add(id);
  }
  return ids;
}

/** 素材的种类 → 证据的种类（数据源的三种；别的在 evidence-source.ts） */
export const DATA_SOURCE_EVIDENCE_KIND = {
  observed_behavior: "action",
  received_writing: "utterance",
  own_writing: "utterance",
} as const satisfies Partial<Record<MaterialKind, Evidence["kind"]>>;

/** "2026-10-07T14:00:00.000+08:00" → "14:00"；和 day 不是同一天的带上月日 "10-08 01:00" */
function clock(iso: string, day: string): string {
  const time = iso.slice(11, 16);
  return localDate(iso) === day ? time : `${iso.slice(5, 10)} ${time}`;
}

/** 场景的几项：时间（段）、地点（位置没打开推断时不带）、和谁 */
export function sceneParts(material: Pick<Material, "time" | "origin">, placeAllowed: boolean): string[] {
  const scene = material.origin?.scene ?? {};
  const day = localDate(material.time);
  const parts = [`时间 ${clock(material.time, day)}${scene.end === undefined ? "" : `–${clock(scene.end, day)}`}`];
  if (placeAllowed && scene.place !== undefined) parts.push(`地点 ${scene.place}`);
  if (scene.people !== undefined && scene.people.length > 0) parts.push(`和 ${scene.people.join("、")}`);
  return parts;
}

/** 一条数据源素材的证据原文：原文后面一行场景 */
export function withSceneLine(text: string, parts: readonly string[]): string {
  return `${text}\n${SCENE_LINE_PREFIX}${parts.join(" · ")}`;
}

/** 几条合成一条的证据原文：抬头写哪个数据源、哪天、几条，下面一条一行（原文压成一行、太长截断，场景接在括号里） */
export function digestText(dataSource: string, day: string, items: ReadonlyArray<{ text: string; parts: readonly string[] }>): string {
  const lines = items.map(({ text, parts }) => {
    const flat = text.replace(/\s+/g, " ").trim();
    const clipped = flat.length > DIGEST_ITEM_CHARS ? `${flat.slice(0, DIGEST_ITEM_CHARS)}…` : flat;
    return `- ${clipped}（${parts.join(" · ")}）`;
  });
  return [`［数据源 ${dataSource} · ${day} · ${items.length} 条］`, ...lines].join("\n");
}

/** 那天是周末还是工作日（按日子：周六、周日算周末；节假日、调休不认） */
function daytypeOf(iso: string): string {
  const [y, m, d] = localDate(iso).split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday === 0 || weekday === 6 ? "weekend" : "workday";
}

/**
 * 数据源证据的场景标签：插件给的标签里认得的（场景维度）；没给一天是哪种的，按日子补上工作日 / 周末；
 * 没给在哪方面、出行是哪种的，再从证据原文按关键词推（clauseContext 那套词）
 */
export function sceneTags(tags: readonly string[], time: string, text: string): string[] {
  const result = [...new Set(tags.filter((tag) => isKnownContextTag(tag)))];
  if (!result.some((tag) => DAYTYPE.includes(tag))) result.push(daytypeOf(time));
  if (!result.some((tag) => ASPECT.includes(tag))) {
    for (const tag of clauseContext([], text)) if (ASPECT.includes(tag) && !result.includes(tag)) result.push(tag);
  }
  return result;
}

/** 合成一条的分组：同一个数据源、同一种素材、同一天 */
export function digestGroupKey(material: Pick<Material, "kind" | "time" | "origin">): string {
  return [material.origin?.dataSource ?? "", material.kind, localDate(material.time)].join("\u0000");
}

/**
 * 这一夜读哪些数据源素材、怎么合（素材已经按能不能推断筛过）：当天（today 及以后）的先不读；
 * 同一组超过 DIGEST_OVER 条的合成一组（组里按时间排），别的一条一组；按每组第一条的时间排，最多 limit 组
 */
export function groupDataSourceItems<T extends Pick<Material, "kind" | "time" | "origin">>(materials: readonly T[], today: string, limit = Number.POSITIVE_INFINITY): T[][] {
  const groups = new Map<string, T[]>();
  for (const m of materials) {
    if (localDate(m.time) >= today) continue;
    const key = digestGroupKey(m);
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const byTime = (a: T, b: T) => toMs(a.time) - toMs(b.time);
  const units = [...groups.values()].flatMap((group) => (group.length > DIGEST_OVER ? [group.toSorted(byTime)] : group.map((m) => [m])));
  return units.toSorted((a, b) => byTime(a[0]!, b[0]!)).slice(0, limit);
}
