// 看板分组收起 / 展开（纯函数，90 号票）：每组标题点一下收起或展开（▾ / ▸），收起后标题行照样有个数；每台设备记住（存在这台设备的
// 浏览器里，读写在 app/board-fold-setting.ts）；默认"已归档"收起、其它展开（原来"已归档 N 展开 ▸"并进这个做法）。
// 记住的写法：收起的那几组，用逗号连起来（"ended,archived"）；什么都不收起是空串；和默认一样时不记（擦掉）。认不出的组名丢掉。
// 104 号票的项目一览（按项目状态分组）照同一个做法，组名、默认收起的不同（state/project-page.ts）：认、写、点一下这三样是共用的
// foldedOf / foldedText / toggleFolded。
import { BOARD_GROUPS, type BoardGroup } from "./protocol.ts";

/** 没记过时收起的组 */
export const BOARD_FOLDED_DEFAULT: readonly BoardGroup[] = ["archived"];

/** 这台设备记住的值怎么认：没记过按默认；记过的按记的（空串是全展开），认不出的组名丢掉 */
export function foldedOf<G extends string>(raw: string | null, groups: readonly G[], defaults: readonly G[]): ReadonlySet<G> {
  if (raw === null) return new Set(defaults);
  const known = (x: string): x is G => (groups as readonly string[]).includes(x);
  return new Set(raw.split(",").filter(known));
}

/** 要记下的值：和默认一样时是 undefined（擦掉，回到默认），否则按组的先后用逗号连起来 */
export function foldedText<G extends string>(folded: ReadonlySet<G>, groups: readonly G[], defaults: readonly G[]): string | undefined {
  const list = groups.filter((g) => folded.has(g));
  const same = list.length === defaults.length && defaults.every((g) => folded.has(g));
  return same ? undefined : list.join(",");
}

/** 点一下这一组的标题：收起的展开，展开的收起 */
export function toggleFolded<G extends string>(folded: ReadonlySet<G>, group: G): Set<G> {
  const next = new Set(folded);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  return next;
}

/** 看板记住的值怎么认：没记过按默认（已归档收起） */
export function boardFoldedOf(raw: string | null): ReadonlySet<BoardGroup> {
  return foldedOf(raw, BOARD_GROUPS, BOARD_FOLDED_DEFAULT);
}

/** 看板要记下的值：和默认一样时是 undefined，否则按看板上的先后连起来 */
export function boardFoldedText(folded: ReadonlySet<BoardGroup>): string | undefined {
  return foldedText(folded, BOARD_GROUPS, BOARD_FOLDED_DEFAULT);
}

/** 点一下看板这一组的标题 */
export function toggleBoardGroup(folded: ReadonlySet<BoardGroup>, group: BoardGroup): Set<BoardGroup> {
  return toggleFolded(folded, group);
}
