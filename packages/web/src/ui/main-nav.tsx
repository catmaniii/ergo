/**
 * 主导航（33 号票）：横屏是左侧竖栏，竖屏是底部横栏。按固定顺序排秘书、任务、项目、待我处理、日历（35 号票）、消耗、记忆、设置，
 * 放得下的直接显示，放不下的从末尾起收进"更多"——算哪些放得下是状态层的纯函数 fitNav，这里只量长度。
 *
 * 怎么量：导航条里藏着一份全部导航项加"更多"的样本（不可见、不占地方、读屏和 Tab 键都跳过），和真的 tab 用同一套样式，
 * 竖栏里和真的 tab 一样宽（名字换不换行一样），横栏里按自然宽度排。ResizeObserver 盯着可用长度和样本里的每一项，
 * 窗口变了、字体变了才重新量；显示哪些 tab 不影响样本和可用长度，所以不会量一次变一次地来回跳。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Navigate, Route } from "../app/route.ts";
import { fitNav, NAV_ITEMS, type NavFit, type NavItem, type NavMeasures } from "../state/index.ts";

type NavEntry = NavItem | "more";

/**
 * 每一项的名字、图标和点了去哪。名字里的零宽空格是允许换行的地方（"个人 / 助理""待我 / 处理"），别处不拆字。
 * 秘书在界面上叫"个人助理"（36 号票，用户 2026-10-08 定）；代码和领域术语照旧叫秘书
 */
const ENTRIES: Record<NavEntry, { label: string; icon: string; route: Route }> = {
  secretary: { label: "个人\u200b助理", icon: "💬", route: { tab: "secretary" } },
  tasks: { label: "任务", icon: "📋", route: { tab: "tasks" } },
  projects: { label: "项目", icon: "📦", route: { tab: "projects" } },
  inbox: { label: "待我\u200b处理", icon: "🔔", route: { tab: "inbox" } },
  calendar: { label: "日历", icon: "📅", route: { tab: "calendar" } },
  usage: { label: "消耗", icon: "📊", route: { tab: "more", page: "usage" } },
  memory: { label: "记忆", icon: "🧠", route: { tab: "more", page: "memory" } },
  settings: { label: "设置", icon: "⚙️", route: { tab: "more", page: "settings" } },
  more: { label: "更多", icon: "⋯", route: { tab: "more" } },
};

/** 待我处理的提示：未读亮小红点，看过没处理的显示灰色数字 */
export interface NavBadge {
  unread: number;
  seenPending: number;
}

/** 横屏竖栏、竖屏横栏 */
export type NavOrientation = "rail" | "bar";

/** 量出来的数是浮点；累加有一点舍入误差，差这一点也算放得下 */
const EPSILON = 0.01;

/** 还没量过时（挂上导航条的那一刻就量，在第一帧之前）先当全都放得下 */
const UNMEASURED: NavFit = { shown: [...NAV_ITEMS], folded: [] };

/**
 * 主导航现在直接显示哪些、收进"更多"的有哪些。放在主框架里：导航条（MainNav 的 onMeasure 报长度）和"更多"页
 * （只列收进去的）都要用。拖动窗口时长度一直在变，收放的结果变了才更新（顺序固定，比直接显示几项就够了）
 */
export function useNavFit(): { fit: NavFit; onMeasure(m: NavMeasures): void } {
  const [fit, setFit] = useState(UNMEASURED);
  const onMeasure = useCallback((m: NavMeasures) => {
    const next = fitNav(m);
    setFit((old) => (old.shown.length === next.shown.length ? old : next));
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

/** 一个 tab：图标在上、名字在下；待我处理带提示。样本里的不给 onClick */
function NavTab({ entry, on, badge, onClick }: { entry: NavEntry; on: boolean; badge: NavBadge; onClick?: () => void }) {
  const { label, icon } = ENTRIES[entry];
  const inbox = entry === "inbox";
  return (
    <button type="button" className={`tab${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={onClick}>
      <span className="tab-icon" aria-hidden="true">
        {icon}
        {inbox && badge.unread > 0 && <i className="tab-dot" />}
        {inbox && badge.seenPending > 0 && <i className="tab-count">{badge.seenPending}</i>}
      </span>
      <span className="tab-label">
        {label}
        {inbox && (badge.unread > 0 || badge.seenPending > 0) && (
          <span className="sr-only">
            （{badge.unread} 条未读，{badge.seenPending} 条看过没处理）
          </span>
        )}
      </span>
    </button>
  );
}
