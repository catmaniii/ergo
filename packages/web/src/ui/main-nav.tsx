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
 * - 名字一律两个字，所以对得齐、竖栏也窄（layout.css 的 .siderail）：秘书那一项是用户起的名字（两个字以内）或者"助理"
 *   （state/nav.ts 的 navAssistantLabel），带名字的底色标签（.assistant-name），完整名字在 title 和 aria-label 里；
 *   待我处理在界面上叫"待办"；
 * - 待办的提示叠在图标右上角（.tab-badges：看过没处理的灰色数字 .tab-count，太大时写"99+"；有未读时一个小红点 .tab-dot），
 *   不另占横向的地方。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Navigate, Route } from "../app/route.ts";
import { fitNav, NAV_ITEMS, navAssistantLabel, navBadgeCount, type NavFit, type NavItem, type NavMeasures } from "../state/index.ts";
import { useAssistantName } from "./assistant-name.tsx";

export type NavEntry = NavItem | "more";

/**
 * 每一项的名字（都是两个字）、图标和点了去哪。秘书那一项没有固定的名字，显示用户起的名字或者"助理"（43 号票，见 tabLabel）；
 * 代码和领域术语照旧叫秘书、待我处理
 */
const ENTRIES: Record<NavEntry, { label?: string; icon: string; route: Route }> = {
  secretary: { icon: "💬", route: { tab: "secretary" } },
  tasks: { label: "任务", icon: "📋", route: { tab: "tasks" } },
  projects: { label: "项目", icon: "📦", route: { tab: "projects" } },
  inbox: { label: "待办", icon: "🔔", route: { tab: "inbox" } },
  calendar: { label: "日历", icon: "📅", route: { tab: "calendar" } },
  usage: { label: "消耗", icon: "📊", route: { tab: "more", page: "usage" } },
  memory: { label: "记忆", icon: "🧠", route: { tab: "more", page: "memory" } },
  settings: { label: "设置", icon: "⚙️", route: { tab: "more", page: "settings" } },
  more: { label: "更多", icon: "⋯", route: { tab: "more" } },
};

/** 待办的提示：未读亮小红点，看过没处理的显示灰色数字（都在图标右上角） */
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

/**
 * 一项上写的字。秘书那一项（没有固定名字的那一项）：两个字以内的名字或者"助理"，带名字的底色，
 * fullName 是完整的名字（放在 title 和 aria-label 里）
 */
function tabLabel(entry: NavEntry, name: string): { text: string; fullName?: string } {
  const { label } = ENTRIES[entry];
  return label === undefined ? { text: navAssistantLabel(name), fullName: name } : { text: label };
}

/**
 * 一个 tab：图标在上、名字在下；待办带提示。样本里的不给 onClick。data-nav 是哪一项（视觉风格可以按它换图标，39 号票）。
 * 设置里风格的预览（pages/more/StylePreview.tsx）也用它画那排导航图标
 */
export function NavTab({ entry, on, badge, onClick }: { entry: NavEntry; on: boolean; badge: NavBadge; onClick?: () => void }) {
  const { icon } = ENTRIES[entry];
  const { text, fullName } = tabLabel(entry, useAssistantName());
  const pending = entry === "inbox" && (badge.unread > 0 || badge.seenPending > 0);
  return (
    <button type="button" className={`tab${on ? " on" : ""}`} data-nav={entry} aria-current={on ? "page" : undefined} onClick={onClick} title={fullName} aria-label={fullName}>
      <span className="tab-icon" aria-hidden="true">
        {icon}
        {pending && (
          <span className="tab-badges">
            {badge.seenPending > 0 && <i className="tab-count">{navBadgeCount(badge.seenPending)}</i>}
            {badge.unread > 0 && <i className="tab-dot" />}
          </span>
        )}
      </span>
      <span className="tab-label">
        {fullName === undefined ? text : <span className="assistant-name">{text}</span>}
        {pending && (
          <span className="sr-only">
            （{badge.unread} 条未读，{badge.seenPending} 条看过没处理）
          </span>
        )}
      </span>
    </button>
  );
}
