// 各页面共用的小部件。Splitter 和 useElementWidth 的写法来自 AgentSense 的 App.tsx。
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from "react";
import { useBackLayer } from "../app/page-back.ts";
import { ACTIVITY_LABEL } from "../model/labels.ts";
import type { ActivityState } from "../model/types.ts";

/** 量一个元素的宽度（宽窄屏按内容区的实际宽度判断，原型的"手机宽度"预览也能用） */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** 被点名的那一项（比如日历里点作业过来，看板上的这张作业卡）：挂上时滚到看得见的地方。返回给那个元素用的 ref */
export function useRevealed<T extends HTMLElement>(on: boolean): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: "center" });
  }, [on]);
  return ref;
}

/** 每隔一段时间走一次的"现在"（毫秒）：倒计时、按时间判断过没过期的显示用 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** 可拖动的分栏线，中间有可视的抓手 */
export function Splitter({ onDrag }: { onDrag(dx: number): void }) {
  const last = useRef<number | undefined>(undefined);
  return (
    <div
      className="splitter"
      onPointerDown={(e) => {
        last.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (last.current === undefined) return;
        onDrag(e.clientX - last.current);
        last.current = e.clientX;
      }}
      onPointerUp={() => (last.current = undefined)}
      onPointerCancel={() => (last.current = undefined)}
    >
      <span className="splitter-grip" />
    </div>
  );
}

/** 主栏里的页面要列表栏先让开（56 号票：窗宽不够时阶段栏、会话、详情三栏已经挤满，AgentSense 的会话列表同样让开） */
const ListYield = createContext<(yields: boolean) => void>(() => {});

/** 主栏里的页面说一声列表栏要不要让开（不在 ListDetail 里时什么也不做） */
export function useListYield(yields: boolean): void {
  const set = useContext(ListYield);
  useEffect(() => {
    set(yields);
    return () => set(false);
  }, [set, yields]);
}

/** 宽屏：列表栏 + 主栏；窄屏：有选中项时只显示主栏，否则只显示列表 */
export function ListDetail({ wide, list, detail, listWidth = 320 }: { wide: boolean; list: ReactNode; detail?: ReactNode; listWidth?: number }) {
  const [w, setW] = useState(listWidth);
  const [yields, setYields] = useState(false);
  if (!wide) return <>{detail ?? list}</>;
  return (
    <div className="panes">
      {!(yields && detail) && (
        <>
          <div className="pane pane-list" style={{ width: w }}>
            {list}
          </div>
          <Splitter onDrag={(dx) => setW((x) => Math.min(520, Math.max(220, x + dx)))} />
        </>
      )}
      <div className="pane pane-main">
        <ListYield.Provider value={setYields}>{detail ?? <div className="page-placeholder">从左边选一项</div>}</ListYield.Provider>
      </div>
    </div>
  );
}

/** 一栏的标题栏：窄屏时带返回（鸿蒙 App 的系统返回键也走它：挂一层 page，62 号票） */
export function TopBar({ title, sub, onBack, children }: { title: ReactNode; sub?: ReactNode; onBack?: () => void; children?: ReactNode }) {
  useBackLayer("page", onBack !== undefined, onBack);
  return (
    <header className="topbar">
      {onBack && (
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          ‹
        </button>
      )}
      <div className="title">
        {title}
        {sub && <span className="title-sub">{sub}</span>}
      </div>
      {children}
    </header>
  );
}

/** 底部弹层（竖屏）或居中对话框（开着时鸿蒙 App 的系统返回键先关它：挂一层 overlay，62 号票） */
export function Sheet({ title, onClose, children, center }: { title: ReactNode; onClose(): void; children: ReactNode; center?: boolean }) {
  useBackLayer("overlay", true, onClose);
  return (
    <div className={`modal-mask${center ? " modal-center" : ""}`} onClick={onClose}>
      <div className="modal" role="dialog" aria-label={typeof title === "string" ? title : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="modal-title">{title}</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 活动状态小圆点：休眠、干活中、等你、排队 */
export function ActivityDot({ state, note }: { state: ActivityState; note?: string }) {
  const label = note ? `${ACTIVITY_LABEL[state]}：${note}` : ACTIVITY_LABEL[state];
  return (
    <span className={`act act-${state}`} title={label}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * 分段切换。role：切换下面显示的内容是 tab（默认）；选一个设置项（比如外观）是 radio，label 是这一组的名字
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  role = "tab",
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange(v: T): void;
  role?: "tab" | "radio";
  label?: string;
}) {
  return (
    <div className="seg" role={role === "tab" ? "tablist" : "radiogroup"} aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={role}
            {...(role === "tab" ? { "aria-selected": on } : { "aria-checked": on })}
            className={on ? "on" : ""}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** 页面里的一节 */
export function Section({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec">
      <div className="sec-head">
        <h3>{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** 第二阶段才有、现在不可用的入口上的标注 */
export function LaterBadge() {
  return <span className="later">第二阶段</span>;
}
