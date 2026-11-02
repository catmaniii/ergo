// 卡片处理后的短提示（立项、发起任务、批准配对……）：盯着前端状态层里卡片的变化，从待处理变成处理过（版本变高）的提示一句，
// 说什么是 state/card-outcome.ts 的。第一次见到的卡（打开页面时补发的历史）不算，很早以前处理过的也不算。整个页面一份（App.tsx）。
import { useEffect, useRef } from "react";
import { type Card, cardOutcomeToast, handledLongAgo } from "../state/index.ts";
import { useToast } from "../ui/toast.tsx";
import { useStore } from "./store.tsx";

export function CardOutcomeToasts() {
  const { ui } = useStore();
  const toast = useToast();
  const seen = useRef(new Map<string, Card>());
  useEffect(() => {
    for (const { card } of Object.values(ui.cards)) {
      const before = seen.current.get(card.id);
      seen.current.set(card.id, card);
      if (!before || before.version >= card.version || before.status !== "pending" || !card.outcome) continue;
      const text = cardOutcomeToast(card, card.outcome.action);
      if (text && !handledLongAgo(card, Date.now())) toast(text);
    }
  }, [ui.cards, toast]);
  return null;
}
