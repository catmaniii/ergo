// 主导航按空间自适应（纯函数，33 号票）：导航项按固定顺序排，放得下的直接显示，放不下的从末尾起收进"更多"。
// 35 号票在待我处理之后加了日历。
// 横屏是左侧竖栏（量高度），竖屏是底部横栏（量宽度），规则相同。长度由界面量好了传进来（ResizeObserver），这里只算。
// 43 号票：导航上每一项的名字都是两个字（对得齐，竖栏也窄，NAV_LABELS）——待我处理在界面上叫"待办"，
// 秘书那一项 89 号票起固定写"秘书"（用户起的名字只在秘书页的标题和正文里）；待办的数字太大时写"99+"（navBadgeCount）。
// 134 号票：鸿蒙 App 里在待办后面多一项"浏览"（原生的内置浏览器），电脑和手机浏览器里没有（navItemsFor）；有它时它也再挤也直接显示。
// 193 号票：网页插件的页面（plugins/slots.ts 的 PageSlot，比如记忆插件的"记忆"）按自己的 order 插进核心的几项里（CORE_NAV_ORDER），
// 插件停用了就没有这一项；默认全开时还是秘书、任务、项目、待办、（浏览、）日历、消耗、记忆、设置。
// 213 号票：日历也挪进了插件（日历插件的页面，order 60），核心的几项里不再有它；默认全开时位置和以前一样。

import { tTable } from "./protocol.ts";

/** 核心的导航项（不归哪个插件），按固定顺序；放不下时从末尾起收进"更多"。"浏览"只在鸿蒙 App 里有（navItemsFor） */
export const CORE_NAV_ITEMS = ["secretary", "tasks", "projects", "inbox", "browse", "usage", "settings"] as const;

export type CoreNavItem = (typeof CORE_NAV_ITEMS)[number];

/** 导航项：核心的几项，或者网页插件的页面（页面的 id，比如记忆插件的 memory，193 号票） */
export type NavItem = CoreNavItem | (string & {});

/**
 * 核心的几项排在哪：网页插件的页面按自己的 order 插进来（日历插件是 60：待办、浏览后面，消耗前面，213 号票；
 * 记忆插件是 80：消耗后面、设置前面）
 */
export const CORE_NAV_ORDER: Readonly<Record<CoreNavItem, number>> = { secretary: 10, tasks: 20, projects: 30, inbox: 40, browse: 50, usage: 70, settings: 90 };

/** 是不是核心的导航项 */
export function isCoreNavItem(item: string): item is CoreNavItem {
  return (CORE_NAV_ITEMS as readonly string[]).includes(item);
}

/** 只在鸿蒙 App 里出现的项（134 号票）：电脑和手机浏览器里管不了外部网站，二狗控制的浏览器放第二期 */
export const APP_ONLY_NAV_ITEMS: readonly NavItem[] = ["browse"];

/** 浏览器里打开二狗时核心的导航项（没有"浏览"） */
export const WEB_NAV_ITEMS: readonly NavItem[] = CORE_NAV_ITEMS.filter((item) => !APP_ONLY_NAV_ITEMS.includes(item));

/**
 * 这次打开有哪些导航项：browse 是有没有原生的内置浏览器（新版鸿蒙 App）；plugins 是在用的网页插件的页面（id 和排在哪），
 * 按 order 插进核心的几项里
 */
export function navItemsFor(options: { browse: boolean; plugins?: readonly { readonly id: string; readonly order: number }[] }): readonly NavItem[] {
  const core = (options.browse ? CORE_NAV_ITEMS : WEB_NAV_ITEMS).map((item) => ({ id: item as NavItem, order: CORE_NAV_ORDER[item as CoreNavItem] }));
  return [...core, ...(options.plugins ?? [])].toSorted((a, b) => a.order - b.order).map((x) => x.id);
}

/**
 * 再挤也直接显示的前几项：秘书、任务、项目、待我处理（待我处理的小红点因此总在导航条上）。
 * 连它们加"更多"都放不下时，导航条自己滚动。有"浏览"时它也算进去（navMinShown）
 */
export const NAV_MIN_SHOWN = 4;

/** 这组导航项里再挤也直接显示几项：前四项；有"浏览"（134 号票，紧跟在待办后面）时连它一起，不收进"更多" */
export function navMinShown(items: readonly NavItem[]): number {
  return Math.max(NAV_MIN_SHOWN, items.indexOf("browse") + 1);
}

/**
 * 导航上每一项写的字（"更多"也在内），一律两个字。秘书那一项固定写"秘书"（89 号票，用户 2026-10-11 定：不随起的名字变，
 * 和别的项一样是普通的字、不带名字标签；名字在秘书页的标题"个人秘书：<名字>"里，见 assistant-name.ts 的 secretaryTitle）；
 * 待我处理在界面上叫"待办"。168 号票起按当前语言现取（语言文件 shell.json 的 shell.nav.*；英文不止两个字，竖栏按最长的那项加宽，见 ui/main-nav.tsx）。
 * 网页插件的页面写它自己的（PageSlot 的 navLabel，193 号票）
 */
export const NAV_LABELS: Readonly<Record<CoreNavItem | "more", string>> = tTable({
  secretary: "shell.nav.secretary",
  tasks: "shell.nav.tasks",
  projects: "shell.nav.projects",
  inbox: "shell.nav.inbox",
  browse: "shell.nav.browse",
  usage: "shell.nav.usage",
  settings: "shell.nav.settings",
  more: "shell.nav.more",
});

/** 图标右上角的数字最多写到多少，再多写成"99+" */
export const NAV_BADGE_MAX = 99;

export function navBadgeCount(count: number): string {
  return count > NAV_BADGE_MAX ? `${NAV_BADGE_MAX}+` : String(count);
}

/** 量出来的长度：可用长度、每个导航项占的长度（这次有的那几项）、"更多"占的长度（同一个方向：竖栏是高度，横栏是宽度） */
export interface NavMeasures {
  available: number;
  sizes: Partial<Record<NavItem, number>>;
  more: number;
}

/** 直接显示的项和收进"更多"的项（都按固定顺序）；folded 不空才显示"更多" */
export interface NavFit {
  shown: NavItem[];
  folded: NavItem[];
}

/**
 * 新量出来的结果要不要换上：正在往输入框里打字时（editing）只放出不收起，不往"更多"里收。
 * 平板横屏在左侧竖栏量高度，一点输入框弹出输入法，页面矮了一半，设置等项就收进"更多"；设置收没收起页面结构不同
 * （MorePage），输入框被换掉、输入法收回，页面又变高、设置又放出来——一点就"刷新"，没法编辑（2026-10-12 用户在平板上碰到）。
 * 输入框失去焦点后再按最近一次量的结果重算
 */
export function nextNavFit(old: NavFit, next: NavFit, editing: boolean): NavFit {
  // 193 号票起导航项会变（网页插件装、停）：直接显示几项一样、项不一样也要换
  if (sameItems(old.shown, next.shown) && sameItems(old.folded, next.folded)) return old;
  return editing && next.shown.length < old.shown.length ? old : next;
}

const sameItems = (a: readonly NavItem[], b: readonly NavItem[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 按可用长度算直接显示哪些、收进"更多"的有哪些；items 是这次有的导航项（不给是浏览器里的那些，没有"浏览"） */
export function fitNav(m: NavMeasures, items: readonly NavItem[] = WEB_NAV_ITEMS): NavFit {
  const lengths = items.map((item) => m.sizes[item] ?? 0);
  const total = (count: number) => lengths.slice(0, count).reduce((sum, n) => sum + n, 0);
  const min = navMinShown(items);
  let count = items.length;
  if (total(count) > m.available) {
    // 有收起的就要显示"更多"，"更多"自己也要放得下
    count = items.length - 1;
    while (count > min && total(count) + m.more > m.available) count--;
  }
  return { shown: items.slice(0, count), folded: items.slice(count) };
}

/**
 * 高亮哪一项：当前页所属的项直接显示着就是它；收进了"更多"（或者就在"更多"页上）就是"更多"；
 * 全都放得下、没有"更多"时，停在"更多"页上谁也不高亮
 */
export function navHighlight(fit: NavFit, current: NavItem | "more"): NavItem | "more" | undefined {
  if (current !== "more" && fit.shown.includes(current)) return current;
  return fit.folded.length > 0 ? "more" : undefined;
}
