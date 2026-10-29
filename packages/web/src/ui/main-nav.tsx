/**
 * 主导航（33 号票）：横屏是左侧竖栏，竖屏是底部横栏。按固定顺序排秘书、任务、项目、待我处理、日历（35 号票）、消耗、记忆、设置，
 * 放得下的直接显示，放不下的从末尾起收进"更多"——算哪些放得下是状态层的纯函数 fitNav，这里只量长度。
 *
 * 怎么量：导航条里藏着一份全部导航项加"更多"的样本（不可见、不占地方、读屏和 Tab 键都跳过），和真的 tab 用同一套样式，
 * 竖栏里和真的 tab 一样宽，横栏里按自然宽度排。ResizeObserver 盯着可用长度和样本里的每一项，
 * 窗口变了、字体变了才重新量；显示哪些 tab 不影响样本和可用长度，所以不会量一次变一次地来回跳。
 *
 * 43 号票定的结构（所有风格都用它，风格只换样子，39 号票）：
 * - 每一项 <button class="tab"> 里是图标 <span class="tab-icon"> 在上、名字 <span class="tab-label"> 在下，竖栏和横栏一样；
 * - 名字一律两个字，所以对得齐、竖栏也窄（layout.css 的 .siderail）：写什么在状态层（state/nav.ts 的 NAV_LABELS）——
 *   秘书那一项固定写"秘书"（89 号票：和别的项一样是普通的两个字，不带名字标签、不随起的名字变），待我处理在界面上叫"待办"；
 * - 待办的提示叠在图标右上角（.tab-badges：看过没处理的灰色数字 .tab-count，太大时写"99+"；有未读时一个小红点 .tab-dot），
 *   不另占横向的地方。109 号票起"秘书"那一项也有小红点：秘书会话里有没看过的消息（照待办的红点，各套风格跟着 .tab-dot）。
 *
 * 134 号票：鸿蒙 App 里（有原生的内置浏览器）在待办后面多一项"浏览"，再挤也直接显示；哪几项由外面给（items，state/nav.ts 的 navItemsFor），
 * 样本也只放这几项。
 *
 * 168 号票：写的字按当前语言（NAV_LABELS 现取、读屏的说明走 t()）。英文的名字不止两个字，竖栏按样本里最长的那项名字加宽
 * （量出来写进 --rail-label-width，layout.css 取它和两个字的宽度里大的那个），中文时和原来一样宽；横栏本来就按自然宽度量。
 *
 * 193 号票：网页插件的页面（plugins/slots.ts 的 PageSlot，比如记忆插件的"记忆"）也是导航里的一项：写的字、退路的图标、点了去哪
 * 由它自己给（pages），data-nav 是页面的 id（11 套风格按它画的导航图标照样生效）。
 * 213 号票：日历也是网页插件的页面（日历插件），点了去它自己的地址 #/calendar（PageSlot.route）；字、图标、data-nav 和原来一样。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "../app/locale.ts";
import type { Navigate, Route } from "../app/route.ts";
import type { PageSlot } from "../plugins/slots.ts";
import { type CoreNavItem, fitNav, nextNavFit, NAV_LABELS, navBadgeCount, type NavFit, type NavItem, type NavMeasures, t } from "../state/index.ts";
import { Icon, type IconName } from "./icons.tsx";

export type NavEntry = NavItem | "more";

/**
 * 每一项的图标和点了去哪（写的字在状态层的 NAV_LABELS，都是两个字；代码和领域术语照旧叫秘书、待我处理）。
 * 图标是共用的线条图标（ui/icons.tsx，122 号票起；原来是表情符号）：只是没画导航图标的风格的退路——现在 11 套风格
 * 都按 data-nav 在自己的 style.css 里画了导航图标（经典是 119 号票的实心图标），.tab-icon 的字号设成 0，这里的线条图标跟着藏掉
 */
const ENTRIES: Record<CoreNavItem | "more", { icon: IconName; route: Route }> = {
  secretary: { icon: "chat", route: { tab: "secretary" } },
  tasks: { icon: "tasks", route: { tab: "tasks" } },
  projects: { icon: "folder", route: { tab: "projects" } },
  inbox: { icon: "bell", route: { tab: "inbox" } },
  browse: { icon: "globe", route: { tab: "browse" } },
  usage: { icon: "chart", route: { tab: "more", page: "usage" } },
  settings: { icon: "gear", route: { tab: "more", page: "settings" } },
  more: { icon: "dots", route: { tab: "more" } },
};

/** 核心的那几项（和"更多"）的图标、点了去哪；网页插件的页面没有（由它自己给） */
const coreEntry = (entry: NavEntry) => (Object.hasOwn(ENTRIES, entry) ? ENTRIES[entry as CoreNavItem | "more"] : undefined);

/**
 * 导航里一项的图标、写的字、点了去哪：核心的查表，网页插件的页面（193 号票）照它登记的——有自己地址的（213 号票：日历）去那里，
 * 别的去 #/more/<页面 id>
 */
function entryOf(entry: NavEntry, pages: readonly PageSlot[]): { icon: IconName; label: string; route: Route } {
  const core = coreEntry(entry);
  if (core) return { ...core, label: NAV_LABELS[entry as CoreNavItem | "more"] };
  const page = pages.find((p) => p.id === entry);
  return { icon: page?.icon ?? "dots", label: page?.navLabel ?? entry, route: page?.route ?? { tab: "more", page: entry } };
}

/**
 * 导航某一项的图标，用在导航以外、指的是同一项的地方（122 号票："更多"页菜单里的日历、消耗、记忆、设置，记忆页的占位；
 * 日历、记忆是网页插件的页面，退路的图标由它给）：
 * 和导航一样是 .tab-icon 挂 data-nav，每套风格给导航画的图标（经典的实心、别的风格各自的线条）在这里一样生效，跟着风格走。
 * 风格的规则只认 .tab-icon 和 [data-nav="…"]，不认外面是不是 .tab，所以放在哪都画得出来；图标框 22×22（风格的 ::before 定的）
 */
export function NavIcon({ entry, icon, className }: { entry: NavEntry; icon?: IconName; className?: string }) {
  return (
    <span className={`tab-icon${className ? ` ${className}` : ""}`} data-nav={entry} aria-hidden="true">
      {/* 网页插件的页面（193 号票）给自己的退路图标 */}
      <Icon name={coreEntry(entry)?.icon ?? icon ?? "dots"} />
    </span>
  );
}

/** 待办的提示：未读亮小红点，看过没处理的显示灰色数字（都在图标右上角）；秘书会话里有没看过的消息时"秘书"也亮小红点（109 号票） */
export interface NavBadge {
  unread: number;
  seenPending: number;
  secretary?: boolean;
}

/** 横屏竖栏、竖屏横栏 */
export type NavOrientation = "rail" | "bar";

/** 量出来的数是浮点；累加有一点舍入误差，差这一点也算放得下 */
const EPSILON = 0.01;

/** 正在往输入框里打字（焦点在可编辑的元素上，触屏设备上这时输入法弹着） */
function isEditing(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(el.type));
}

/**
 * 主导航现在直接显示哪些、收进"更多"的有哪些。放在主框架里：导航条（MainNav 的 onMeasure 报长度）和"更多"页
 * （只列收进去的）都要用。拖动窗口时长度一直在变，收放的结果变了才更新（顺序固定，比直接显示几项就够了）。
 * items 是这次有的导航项（134 号票：鸿蒙 App 里多"浏览"），开着的时候不变
 */
export function useNavFit(items: readonly NavItem[]): { fit: NavFit; onMeasure(m: NavMeasures): void } {
  // 还没量过时（挂上导航条的那一刻就量，在第一帧之前）先当全都放得下
  const [fit, setFit] = useState<NavFit>(() => ({ shown: [...items], folded: [] }));
  const last = useRef<NavMeasures>(undefined);
  const onMeasure = useCallback(
    (m: NavMeasures) => {
      last.current = m;
      const next = fitNav(m, items);
      setFit((old) => nextNavFit(old, next, isEditing()));
    },
    [items],
  );
  // 打字时没收起的，输入框失去焦点（输入法收回）后按最近一次量的结果重算
  useEffect(() => {
    const onFocusOut = () =>
      setTimeout(() => {
        const m = last.current;
        if (m) setFit((old) => nextNavFit(old, fitNav(m, items), isEditing()));
      });
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, [items]);
  return { fit, onMeasure };
}

export function MainNav({
  orientation,
  items,
  pages,
  fit,
  highlight,
  badge,
  navigate,
  onMeasure,
}: {
  orientation: NavOrientation;
  /** 这次有的导航项（样本按它放） */
  items: readonly NavItem[];
  /** 在用的网页插件的页面（193 号票）：它们那几项的字、图标、去哪 */
  pages: readonly PageSlot[];
  fit: NavFit;
  highlight: NavEntry | undefined;
  badge: NavBadge;
  navigate: Navigate;
  onMeasure(m: NavMeasures): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const vertical = orientation === "rail";
  // 换了语言名字的长短变了：重新量（竖栏的样本和竖栏一样宽，名字变长它的尺寸不变，ResizeObserver 不报）
  const localeRev = useLocale();

  useLayoutEffect(() => {
    const list = listRef.current;
    const probe = probeRef.current;
    if (!list || !probe) return;
    const along = (el: Element) => {
      const r = el.getBoundingClientRect();
      return vertical ? r.height : r.width;
    };
    // ResizeObserver 的回调在布局之后，这时读尺寸不会额外触发布局；挂上时先量一次，第一帧就按量好的显示
    const measure = () => {
      const samples = Array.from(probe.children);
      // 竖栏的宽度（168 号票）：按最长的那项名字定（中文两个字时和原来一样宽；英文等不止两个字的跟着加宽，layout.css 的 --rail-label-width）
      if (vertical) fitRailWidth(railRef.current, probe, localeRev);
      const sizes: Partial<Record<NavItem, number>> = Object.fromEntries(items.map((item, i) => [item, along(samples[i]!)]));
      onMeasure({ available: along(list) + EPSILON, sizes, more: along(samples[items.length]!) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    for (const el of Array.from(probe.children)) ro.observe(el);
    return () => ro.disconnect();
  }, [vertical, onMeasure, items, localeRev]);

  const entries: NavEntry[] = fit.folded.length > 0 ? [...fit.shown, "more"] : fit.shown;
  const tabs = entries.map((entry) => {
    const info = entryOf(entry, pages);
    return <NavTab key={entry} entry={entry} label={info.label} icon={info.icon} on={highlight === entry} badge={badge} onClick={() => navigate(info.route)} />;
  });
  // 样本：这次有的全部导航项加"更多"，顺序和 items 一致，"更多"在最后
  const probe = (
    <div className="nav-probe" ref={probeRef} aria-hidden="true" inert>
      {[...items, "more" as const].map((entry) => {
        const info = entryOf(entry, pages);
        return <NavTab key={entry} entry={entry} label={info.label} icon={info.icon} on={false} badge={NO_BADGE} />;
      })}
    </div>
  );
  return vertical ? (
    <nav className="siderail" aria-label={t("shell.nav.label")} ref={railRef}>
      <div className="siderail-brand">{t("shell.brand")}</div>
      <div className="nav-list" ref={listRef}>
        {tabs}
      </div>
      {probe}
    </nav>
  ) : (
    <nav className="tabbar" aria-label={t("shell.nav.label")}>
      <div className="nav-list" ref={listRef}>
        {tabs}
      </div>
      {probe}
    </nav>
  );
}

const NO_BADGE: NavBadge = { unread: 0, seenPending: 0 };

/**
 * 竖栏按最长的那项名字加宽（168 号票）：样本里各项名字的完整宽度（scrollWidth，截成省略号的也是全长）比两个字宽出一截才写
 * --rail-label-width，不然擦掉——中文两个字时一点不变（量出来的小数不会让竖栏多出零点几个像素）
 */
function fitRailWidth(rail: HTMLElement | null, probe: HTMLElement, localeRev: number): void {
  if (!rail) return;
  // 记下是按哪一版词典量的（换了语言要重新量，见调用处）
  rail.dataset.localeRev = String(localeRev);
  const labels = Array.from(probe.querySelectorAll<HTMLElement>(".tab-label"));
  const font = labels[0] ? parseFloat(getComputedStyle(labels[0]).fontSize) : 0;
  const widest = Math.max(0, ...labels.map((el) => el.scrollWidth));
  if (font > 0 && widest > font * 2 + 1) rail.style.setProperty("--rail-label-width", `${widest}px`);
  else rail.style.removeProperty("--rail-label-width");
}

/**
 * 一个 tab：图标在上、名字在下；待办带提示。样本里的不给 onClick。data-nav 是哪一项（视觉风格可以按它换图标，39 号票）。
 * 设置里风格的预览（pages/more/StylePreview.tsx）也用它画那排导航图标。网页插件的页面（193 号票）给 label、icon
 */
export function NavTab({ entry, label, icon: pluginIcon, on, badge, onClick }: { entry: NavEntry; label?: string; icon?: IconName; on: boolean; badge: NavBadge; onClick?: () => void }) {
  const core = coreEntry(entry);
  const icon = core?.icon ?? pluginIcon ?? "dots";
  const pending = entry === "inbox" && (badge.unread > 0 || badge.seenPending > 0);
  const news = entry === "secretary" && badge.secretary === true;
  return (
    <button type="button" className={`tab${on ? " on" : ""}`} data-nav={entry} aria-current={on ? "page" : undefined} onClick={onClick}>
      <span className="tab-icon" aria-hidden="true">
        <Icon name={icon} />
        {pending && (
          <span className="tab-badges">
            {badge.seenPending > 0 && <i className="tab-count">{navBadgeCount(badge.seenPending)}</i>}
            {badge.unread > 0 && <i className="tab-dot" />}
          </span>
        )}
        {news && (
          <span className="tab-badges">
            <i className="tab-dot" />
          </span>
        )}
      </span>
      <span className="tab-label">
        {core ? NAV_LABELS[entry as CoreNavItem | "more"] : (label ?? entry)}
        {pending && <span className="sr-only">{t("shell.nav.inboxBadge", { unread: badge.unread, seen: badge.seenPending })}</span>}
        {news && <span className="sr-only">{t("shell.nav.secretaryNews")}</span>}
      </span>
    </button>
  );
}
