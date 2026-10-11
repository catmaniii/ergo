// 看板分组收起 / 展开（纯函数，90 号票）：每组标题点一下收起或展开（▾ / ▸），收起后标题行照样有个数；每台设备记住（存在这台设备的
// 浏览器里，读写在 app/board-fold-setting.ts）；默认"已归档"收起、其它展开（原来"已归档 N 展开 ▸"并进这个做法）。
// 记住的写法：收起的那几组，用逗号连起来（"ended,archived"）；什么都不收起是空串；和默认一样时不记（擦掉）。认不出的组名丢掉。
import { BOARD_GROUPS, type BoardGroup } from "./protocol.ts";

/** 没记过时收起的组 */
export const BOARD_FOLDED_DEFAULT: readonly BoardGroup[] = ["archived"];

const isGroup = (x: string): x is BoardGroup => (BOARD_GROUPS as readonly string[]).includes(x);

/** 这台设备记住的值怎么认：没记过按默认（已归档收起）；记过的按记的（空串是全展开），认不出的组名丢掉 */
export function boardFoldedOf(raw: string | null): ReadonlySet<BoardGroup> {
  if (raw === null) return new Set(BOARD_FOLDED_DEFAULT);
  return new Set(raw.split(",").filter(isGroup));
}

/** 要记下的值：和默认一样时是 undefined（擦掉，回到默认），否则按看板上的先后用逗号连起来 */
export function boardFoldedText(folded: ReadonlySet<BoardGroup>): string | undefined {
  const list = BOARD_GROUPS.filter((g) => folded.has(g));
  const same = list.length === BOARD_FOLDED_DEFAULT.length && BOARD_FOLDED_DEFAULT.every((g) => folded.has(g));
  return same ? undefined : list.join(",");
}

/** 点一下这一组的标题：收起的展开，展开的收起 */
export function toggleBoardGroup(folded: ReadonlySet<BoardGroup>, group: BoardGroup): Set<BoardGroup> {
  const next = new Set(folded);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  return next;
}
