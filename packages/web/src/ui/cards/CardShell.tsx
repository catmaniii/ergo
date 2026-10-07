// 卡片的公共外壳：类型标签、标题、处理结果；按钮点了先显示"处理中"，收到卡片更新事件后变成已处理。
import type { ReactNode } from "react";
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL, type CardType } from "../../model/cards.ts";
import type { CardView } from "../../state/index.ts";

export interface CardProps<P> {
  view: CardView;
  payload: P;
  /** 已经处理过（或关掉、过期），按钮和输入都停用 */
  done: boolean;
  act(action: string, note?: string): void;
}

export function useCardActions(view: CardView) {
  const { cardAction } = useStore();
  return {
    done: view.card.status !== "pending",
    act: (action: string, note?: string) => cardAction(view.card.id, action, note),
  };
}

export function CardShell({ view, title, children, actions, tag }: { view: CardView; title: ReactNode; children?: ReactNode; actions?: ReactNode; tag?: ReactNode }) {
  const { card, pending } = view;
  const done = card.status !== "pending";
  return (
    <div className={`card xcard xcard-${card.type}${done ? " xcard-done" : ""}`}>
      <div className="xcard-head">
        <span className={`xcard-tag xt-${card.type}`}>{CARD_TYPE_LABEL[card.type as CardType] ?? card.type}</span>
        {tag}
        <span className="xcard-title">{title}</span>
      </div>
      {children && <div className="xcard-body">{children}</div>}
      {done ? (
        <div className={`auth-result card-done-mark ${card.status === "handled" ? "ok" : "muted"}`}>
          {card.status === "handled" ? "✓ " : ""}
          {card.outcome ?? (card.status === "expired" ? "已过期" : "已关闭")}
        </div>
      ) : pending?.status === "sending" ? (
        <div className="auth-result muted">处理中…</div>
      ) : (
        <>
          {pending?.status === "failed" && <div className="error card-error">没处理成：{pending.error}</div>}
          {actions && <div className="auth-actions">{actions}</div>}
        </>
      )}
    </div>
  );
}
