// 各页面共用的小部件。Splitter 和 useElementWidth 的写法来自 AgentSense 的 App.tsx。
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
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

/** 宽屏：列表栏 + 主栏；窄屏：有选中项时只显示主栏，否则只显示列表 */
export function ListDetail({ wide, list, detail, listWidth = 320 }: { wide: boolean; list: ReactNode; detail?: ReactNode; listWidth?: number }) {
  const [w, setW] = useState(listWidth);
  if (!wide) return <>{detail ?? list}</>;
  return (
    <div className="panes">
      <div className="pane pane-list" style={{ width: w }}>
        {list}
      </div>
      <Splitter onDrag={(dx) => setW((x) => Math.min(520, Math.max(220, x + dx)))} />
      <div className="pane pane-main">{detail ?? <div className="page-placeholder">从左边选一项</div>}</div>
    </div>
  );
}

/** 一栏的标题栏：窄屏时带返回 */
export function TopBar({ title, sub, onBack, children }: { title: ReactNode; sub?: ReactNode; onBack?: () => void; children?: ReactNode }) {
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

/** 底部弹层（竖屏）或居中对话框 */
export function Sheet({ title, onClose, children, center }: { title: ReactNode; onClose(): void; children: ReactNode; center?: boolean }) {
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

/** 分段切换 */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange(v: T): void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
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
