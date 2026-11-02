// 演示页里看板、设置这些假数据的本地状态（只有演示页装 ProtoProvider，页面从 app/proto-context.ts 读）。
// 项目在前端状态层里（state/projects.ts；原型的假项目由假连接作为 project 事件推来）。
// 待办已经在前端状态层里（原型的假事项由假连接作为 inbox_item 事件推来）；
// 看板上的任务和简单提醒也在前端状态层里（state/board.ts），这里的假看板只补上还没接真数据的条目。
//
// 卡片处理后别的假数据要跟着变（确认了计划，假任务就进排队中）：这里看的是前端状态层里卡片的变化，
// 不认具体是哪个连接。卡片处理后给真卡片的短提示不在这里（app/card-outcome-toasts.tsx，安装版也要）。
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ProtoContext, type ProtoState } from "../app/proto-context.ts";
import { useStore } from "../app/store.tsx";
import type { TaskSummary } from "../model/types.ts";
import type { Card, CardAction } from "../state/index.ts";
import { useToast } from "../ui/toast.tsx";
import { fakeText, localized } from "./fake-content.ts";
import { FAKE_BOARD, FAKE_SKILLS } from "./fake-data.ts";

const INITIAL: ProtoState = {
  board: FAKE_BOARD,
  skills: FAKE_SKILLS,
};

function patchTask(s: ProtoState, id: string, patch: Partial<TaskSummary>): ProtoState {
  return { ...s, board: s.board.map((e) => (e.kind === "task" && e.id === id ? { ...e, ...patch } : e)) };
}

/** 卡片处理后，原型里别的假数据跟着变 */
function sideEffect(s: ProtoState, card: Card, action: CardAction): ProtoState {
  if (card.id === "c-plan-bills") {
    return action === "confirm"
      ? patchTask(s, "t-bills", { status: "queued", stage: { current: 1, total: 3 }, activity: "queued", activityNote: "等执行名额" })
      : patchTask(s, "t-bills", { status: "planning", activity: "working", activityNote: "按你的意见重新起草计划" });
  }
  if (card.id === "c-appr-1") {
    return patchTask(s, "t-photos", { status: "running", waitReason: undefined, activity: "working", activityNote: action === "approve" ? "同步备份端" : "在现有授权内重排这一步" });
  }
  if (card.id === "c-qa-2" && action === "execute") {
    return { ...s, board: s.board.map((e) => (e.kind === "scheduled_job" && e.id === "sj-daily-bills" ? { ...e, status: "paused" as const } : e)) };
  }
  return s;
}

/** 假的计划卡处理后的短提示（别的卡是 app/card-outcome-toasts.tsx 的） */
function toastFor(card: Card, action: CardAction): string | undefined {
  if (card.id === "c-plan-bills") return action === "confirm" ? "计划已确认，任务进入排队中" : "已打回，意见交给了起草计划的负责人";
  return undefined;
}

export function ProtoProvider({ children }: { children: ReactNode }) {
  const [proto, setProto] = useState(INITIAL);
  const { ui } = useStore();
  const toast = useToast();

  // 记下每张卡最后见过的样子；从待处理变成处理过（版本变高）的，让别的假数据跟着变。
  // 第一次见到的卡（打开页面时补发的历史）不算。
  const seen = useRef(new Map<string, Card>());
  useEffect(() => {
    for (const { card } of Object.values(ui.cards)) {
      const before = seen.current.get(card.id);
      seen.current.set(card.id, card);
      if (!before || before.version >= card.version || before.status !== "pending" || !card.outcome) continue;
      const { action } = card.outcome;
      setProto((s) => sideEffect(s, card, action));
      const text = toastFor(card, action);
      if (text) toast(fakeText(text));
    }
  }, [ui.cards, toast]);

  const value = useMemo(() => ({ proto: localized(proto), update: setProto }), [proto]);
  return <ProtoContext.Provider value={value}>{children}</ProtoContext.Provider>;
}
