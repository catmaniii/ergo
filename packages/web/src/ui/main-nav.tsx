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
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Navigate, Route } from "../app/route.ts";
import { fitNav, NAV_ITEMS, nextNavFit, NAV_LABELS, navBadgeCount, type NavFit, type NavItem, type NavMeasures } from "../state/index.ts";

export type NavEntry = NavItem | "more";

/** 每一项的图标和点了去哪（写的字在状态层的 NAV_LABELS，都是两个字；代码和领域术语照旧叫秘书、待我处理） */
const ENTRIES: Record<NavEntry, { icon: string; route: Route }> = {
  secretary: { icon: "💬", route: { tab: "secretary" } },
  tasks: { icon: "📋", route: { tab: "tasks" } },
  projects: { icon: "📦", route: { tab: "projects" } },
  inbox: { icon: "🔔", route: { tab: "inbox" } },
  calendar: { icon: "📅", route: { tab: "calendar" } },
  usage: { icon: "📊", route: { tab: "more", page: "usage" } },
  memory: { icon: "🧠", route: { tab: "more", page: "memory" } },
  settings: { icon: "⚙️", route: { tab: "more", page: "settings" } },
  more: { icon: "⋯", route: { tab: "more" } },
};

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

/** 还没量过时（挂上导航条的那一刻就量，在第一帧之前）先当全都放得下 */
const UNMEASURED: NavFit = { shown: [...NAV_ITEMS], folded: [] };

/**
 * 主导航现在直接显示哪些、收进"更多"的有哪些。放在主框架里：导航条（MainNav 的 onMeasure 报长度）和"更多"页
 * （只列收进去的）都要用。拖动窗口时长度一直在变，收放的结果变了才更新（顺序固定，比直接显示几项就够了）
 */
export function useNavFit(): { fit: NavFit; onMeasure(m: NavMeasures): void } {
  const [fit, setFit] = useState(UNMEASURED);
  const last = useRef<NavMeasures>(undefined);
  const onMeasure = useCallback((m: NavMeasures) => {
    last.current = m;
    const next = fitNav(m);
    setFit((old) => nextNavFit(old, next, isEditing()));
  }, []);
  // 打字时没收起的，输入框失去焦点（输入法收回）后按最近一次量的结果重算
  useEffect(() => {
    const onFocusOut = () =>
      setTimeout(() => {
        const m = last.current;
        if (m) setFit((old) => nextNavFit(old, fitNav(m), isEditing()));
      });
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, []);
  return { fit, onMeasure };
}

export function MainNav({
  orientation,
  fit,
  highlight,
  badge,
  navigate,
  onMeasure,
}: {
  orientation: NavOrientation;
  fit: NavFit;
  highlight: NavEntry | undefined;
  badge: NavBadge;
  navigate: Navigate;
  onMeasure(m: NavMeasures): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const vertical = orientation === "rail";

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
      const sizes = Object.fromEntries(NAV_ITEMS.map((item, i) => [item, along(samples[i]!)])) as Record<NavItem, number>;
      onMeasure({ available: along(list) + EPSILON, sizes, more: along(samples[NAV_ITEMS.length]!) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    for (const el of Array.from(probe.children)) ro.observe(el);
    return () => ro.disconnect();
  }, [vertical, onMeasure]);

  const entries: NavEntry[] = fit.folded.length > 0 ? [...fit.shown, "more"] : fit.shown;
  const tabs = entries.map((entry) => <NavTab key={entry} entry={entry} on={highlight === entry} badge={badge} onClick={() => navigate(ENTRIES[entry].route)} />);
  // 样本：全部导航项加"更多"，顺序和 NAV_ITEMS 一致，"更多"在最后
  const probe = (
    <div className="nav-probe" ref={probeRef} aria-hidden="true" inert>
      {[...NAV_ITEMS, "more" as const].map((entry) => (
        <NavTab key={entry} entry={entry} on={false} badge={NO_BADGE} />
      ))}
    </div>
  );
  return vertical ? (
    <nav className="siderail" aria-label="主导航">
      <div className="siderail-brand">二狗</div>
      <div className="nav-list" ref={listRef}>
        {tabs}
      </div>
      {probe}
    </nav>
  ) : (
    <nav className="tabbar" aria-label="主导航">
      <div className="nav-list" ref={listRef}>
        {tabs}
      </div>
      {probe}
    </nav>
  );
}

const NO_BADGE: NavBadge = { unread: 0, seenPending: 0 };

/**
 * 一个 tab：图标在上、名字在下；待办带提示。样本里的不给 onClick。data-nav 是哪一项（视觉风格可以按它换图标，39 号票）。
 * 设置里风格的预览（pages/more/StylePreview.tsx）也用它画那排导航图标
 */
export function NavTab({ entry, on, badge, onClick }: { entry: NavEntry; on: boolean; badge: NavBadge; onClick?: () => void }) {
  const { icon } = ENTRIES[entry];
  const pending = entry === "inbox" && (badge.unread > 0 || badge.seenPending > 0);
  const news = entry === "secretary" && badge.secretary === true;
  return (
    <button type="button" className={`tab${on ? " on" : ""}`} data-nav={entry} aria-current={on ? "page" : undefined} onClick={onClick}>
      <span className="tab-icon" aria-hidden="true">
        {icon}
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
        {NAV_LABELS[entry]}
        {pending && (
          <span className="sr-only">
            （{badge.unread} 条未读，{badge.seenPending} 条看过没处理）
          </span>
        )}
        {news && <span className="sr-only">（有没看过的新消息）</span>}
      </span>
    </button>
  );
}
