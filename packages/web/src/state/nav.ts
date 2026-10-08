// 主导航按空间自适应（纯函数，33 号票）：导航项按固定顺序排，放得下的直接显示，放不下的从末尾起收进"更多"。
// 35 号票在待我处理之后加了日历。
// 横屏是左侧竖栏（量高度），竖屏是底部横栏（量宽度），规则相同。长度由界面量好了传进来（ResizeObserver），这里只算。

/** 主导航的项，按固定顺序；放不下时从末尾起收进"更多" */
export const NAV_ITEMS = ["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory", "settings"] as const;

export type NavItem = (typeof NAV_ITEMS)[number];

/**
 * 再挤也直接显示的前几项：秘书、任务、项目、待我处理（待我处理的小红点因此总在导航条上）。
 * 连它们加"更多"都放不下时，导航条自己滚动
 */
export const NAV_MIN_SHOWN = 4;

/** 量出来的长度：可用长度、每个导航项占的长度、"更多"占的长度（同一个方向：竖栏是高度，横栏是宽度） */
export interface NavMeasures {
  available: number;
  sizes: Record<NavItem, number>;
  more: number;
}

/** 直接显示的项和收进"更多"的项（都按固定顺序）；folded 不空才显示"更多" */
export interface NavFit {
  shown: NavItem[];
  folded: NavItem[];
}

/** 按可用长度算直接显示哪些、收进"更多"的有哪些 */
export function fitNav(m: NavMeasures): NavFit {
  const lengths = NAV_ITEMS.map((item) => m.sizes[item]);
  const total = (count: number) => lengths.slice(0, count).reduce((sum, n) => sum + n, 0);
  let count = NAV_ITEMS.length;
  if (total(count) > m.available) {
    // 有收起的就要显示"更多"，"更多"自己也要放得下
    count = NAV_ITEMS.length - 1;
    while (count > NAV_MIN_SHOWN && total(count) + m.more > m.available) count--;
  }
  return { shown: NAV_ITEMS.slice(0, count), folded: NAV_ITEMS.slice(count) };
}

/**
 * 高亮哪一项：当前页所属的项直接显示着就是它；收进了"更多"（或者就在"更多"页上）就是"更多"；
 * 全都放得下、没有"更多"时，停在"更多"页上谁也不高亮
 */
export function navHighlight(fit: NavFit, current: NavItem | "more"): NavItem | "more" | undefined {
  if (current !== "more" && fit.shown.includes(current)) return current;
  return fit.folded.length > 0 ? "more" : undefined;
}
