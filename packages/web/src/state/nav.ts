// 主导航按空间自适应（纯函数，33 号票）：导航项按固定顺序排，放得下的直接显示，放不下的从末尾起收进"更多"。
// 35 号票在待我处理之后加了日历。
// 横屏是左侧竖栏（量高度），竖屏是底部横栏（量宽度），规则相同。长度由界面量好了传进来（ResizeObserver），这里只算。
// 43 号票：导航上每一项的名字都是两个字（对得齐，竖栏也窄，NAV_LABELS）——待我处理在界面上叫"待办"，
// 秘书那一项 89 号票起固定写"秘书"（用户起的名字只在秘书页的标题和正文里）；待办的数字太大时写"99+"（navBadgeCount）。

/** 主导航的项，按固定顺序；放不下时从末尾起收进"更多" */
export const NAV_ITEMS = ["secretary", "tasks", "projects", "inbox", "calendar", "usage", "memory", "settings"] as const;

export type NavItem = (typeof NAV_ITEMS)[number];

/**
 * 再挤也直接显示的前几项：秘书、任务、项目、待我处理（待我处理的小红点因此总在导航条上）。
 * 连它们加"更多"都放不下时，导航条自己滚动
 */
export const NAV_MIN_SHOWN = 4;

/**
 * 导航上每一项写的字（"更多"也在内），一律两个字。秘书那一项固定写"秘书"（89 号票，用户 2026-10-11 定：不随起的名字变，
 * 和别的项一样是普通的字、不带名字标签；名字在秘书页的标题"个人秘书：<名字>"里，见 assistant-name.ts 的 secretaryTitle）；
 * 待我处理在界面上叫"待办"
 */
export const NAV_LABELS: Record<NavItem | "more", string> = {
  secretary: "秘书",
  tasks: "任务",
  projects: "项目",
  inbox: "待办",
  calendar: "日历",
  usage: "消耗",
  memory: "记忆",
  settings: "设置",
  more: "更多",
};

/** 图标右上角的数字最多写到多少，再多写成"99+" */
export const NAV_BADGE_MAX = 99;

export function navBadgeCount(count: number): string {
  return count > NAV_BADGE_MAX ? `${NAV_BADGE_MAX}+` : String(count);
}

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
