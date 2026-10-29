// 卡片的公共外壳：类型标签、标题、处理结果；按钮点了先显示"处理中"，收到卡片更新事件后变成已处理。
import type { ReactNode } from "react";
import { useStore } from "../../app/store.tsx";
import { CARD_TYPE_LABEL, outcomeLabel } from "../../model/cards.ts";
import { type CardAction, type CardState, isCardType, t } from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";

export interface CardProps<P> {
  state: CardState;
  payload: P;
  /** 已经处理过（或关掉、过期），按钮和输入都停用 */
  done: boolean;
  /** 点按钮：note 是附带的说明，input 是结构化输入（比如改提醒的新时间） */
  act(action: CardAction, note?: string, input?: unknown): void;
}

export function useCardActions(state: CardState) {
  const { cardAction } = useStore();
  return {
    done: state.card.status !== "pending",
    act: (action: CardAction, note?: string, input?: unknown) => cardAction(state.card.id, action, note, input),
  };
}

export function CardShell({
  state,
  title,
  children,
  actions,
  tag,
  label,
  doneLabel,
  doneActions,
}: {
  state: CardState;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** 标题前面再加的小签 */
  tag?: ReactNode;
  /** 类型标签的文字，默认按卡片类型（工具包变更这类子类可以换掉） */
  label?: string;
  /** 处理完之后显示的文字，默认按处理结果（比如提醒卡到点后写"已触发"） */
  doneLabel?: string;
  /** 处理完之后还能做的（185 号票：提醒卡响过、取消了以后还能归档、删除；不是卡片动作，各自交请求） */
  doneActions?: ReactNode;
}) {
  const { card, pending } = state;
  const done = card.status !== "pending";
  return (
    <div className={`card xcard xcard-${card.type}${done ? " xcard-done" : ""}`}>
      <div className="xcard-head">
        <span className={`xcard-tag xt-${card.type}`}>{label ?? (isCardType(card.type) ? CARD_TYPE_LABEL[card.type] : card.type)}</span>
        {tag}
        <span className="xcard-title">{title}</span>
      </div>
      {children && <div className="xcard-body">{children}</div>}
      {done ? (
        <>
          <div className={`auth-result card-done-mark ${card.status === "handled" ? "ok" : "muted"}`}>
            {card.status === "handled" ? "✓ " : ""}
            {/* 处理结果里的说明可能是守护进程写的（"<名字>按你的话取消了"）：名字占位按现在的名字显示 */}
            <NamedText text={doneLabel ?? outcomeLabel(card)} />
          </div>
          {doneActions && <div className="auth-actions card-done-actions">{doneActions}</div>}
        </>
      ) : pending?.status === "sending" ? (
        <div className="auth-result muted">{t("ui.cardShell.sending")}</div>
      ) : (
        <>
          {pending?.status === "failed" && <div className="error card-error">{t("ui.cardShell.failed", { error: pending.error })}</div>}
          {actions && <div className="auth-actions">{actions}</div>}
        </>
      )}
    </div>
  );
}
