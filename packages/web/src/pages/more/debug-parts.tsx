// Debug 工具集（124 号票）几张卡共用的小部件：一张卡、一行（左边是什么、右边是值；App 专属的不在 App 里时灰掉）、一组单选的小按钮。
import type { ReactNode } from "react";
import { t } from "../../state/index.ts";

/** App 专属的项不在 App 里时写的话（按当前语言现取，171 号票） */
export const appOnly = () => t("pages.debug.appOnly");

/** 一张卡 */
export function DebugCard({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="card debug-card">
      <div className="debug-card-head">
        <h3>{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** 一行：左边是什么、右边是值（可以带按钮）；off 是灰掉的（不在 App 里、App 太旧） */
export function DebugRow({ label, children, off }: { label: string; children: ReactNode; off?: boolean | undefined }) {
  return (
    <div className={`debug-row${off ? " debug-off" : ""}`} aria-disabled={off || undefined}>
      <span className="debug-label">{label}</span>
      <span className="debug-value">{children}</span>
    </div>
  );
}

/** 一组单选的小按钮（延迟几秒） */
export function DebugChoices<T extends number>({ values, value, onChange, unit }: { values: readonly T[]; value: T; onChange(v: T): void; unit: string }) {
  return (
    <span className="debug-choices" role="radiogroup">
      {values.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {v}
          {unit}
        </button>
      ))}
    </span>
  );
}

/** 协议时间里的时分秒 */
export function clockOf(iso: string): string {
  return /T(\d{2}:\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
}
