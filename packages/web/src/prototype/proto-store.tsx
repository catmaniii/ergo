// 原型里看板、设置这些假数据的本地状态。
// 这些频道的事件和归并在后面的票里接进前端状态层（定时作业 19……），到时候这个文件整个删掉。
// 项目 15 号票起在前端状态层里（state/projects.ts；原型的假项目由假连接作为 project 事件推来）。
// 待我处理 06 号票起已经在前端状态层里（原型的假事项由假连接作为 inbox_item 事件推来）；
// 看板上的任务和简单提醒 12 号票起也在前端状态层里（state/board.ts），这里的假看板只补上还没接真数据的条目。
//
// 卡片处理后别的假数据要跟着变（确认了计划，假任务就进排队中）：这里看的是前端状态层里卡片的变化，
// 不认具体是哪个连接，所以 App.tsx 里换掉连接也照样工作。
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../app/store.tsx";
import type { BoardEntry, SkillEntry, TaskSummary } from "../model/types.ts";
import type { Card, CardAction } from "../state/index.ts";
import { useToast } from "../ui/toast.tsx";
import { FAKE_BOARD, FAKE_SKILLS } from "./fake-data.ts";

export interface ProtoState {
  board: BoardEntry[];
  skills: SkillEntry[];
}

const INITIAL: ProtoState = {
  board: FAKE_BOARD,
  skills: FAKE_SKILLS,
};

interface Proto {
  proto: ProtoState;
  update(f: (s: ProtoState) => ProtoState): void;
  /** 看板频道接了真数据（由守护进程提供页面时）：看板上的任务和简单提醒都是真的 */
  realBoard: boolean;
}

const ProtoContext = createContext<Proto | null>(null);

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

/** 卡片处理后的短提示 */
function toastFor(card: Card, action: CardAction): string | undefined {
  const payload = card.payload as Record<string, unknown>;
  if (card.type === "suggest_project" && action === "kickoff") return `项目「${String(payload.name)}」诞生了（筹备中），维护者随之产生`;
  if (card.type === "suggest_task" && action === "start_task") return `已发起任务「${String(payload.title)}」（规划中）`;
  if (card.type === "charter") return action === "confirm_start" ? "已开工：发起了首个建设任务，项目进入建设中" : "立项书已确认，项目留在筹备中";
  // 125 号票：立项要求变更
  if (card.type === "charter_change") return action === "confirm" ? "立项书改好了，末尾记了这次变更" : "已拒绝，立项书不变";
  // 261 号票：规范改写
  if (card.type === "standard_change") return action === "confirm" ? "规范改好了，记进了项目档案" : "已拒绝，规范不变";
  // 262 号票：补齐规范文档
  if (card.type === "standard_backfill") return action === "confirm" ? "改用了规范，建了任务交给维护者补" : "不补了，不会再问";
  if (card.id === "c-plan-bills") return action === "confirm" ? "计划已确认，任务进入排队中" : "已打回，意见交给了起草计划的维护者";
  if (card.type === "pairing" && action === "approve") return "已批准，新设备拿到凭证";
  return undefined;
}

/**
 * 早就处理过的卡（处理时间在两分钟以前）：新开的页面补历史时，同一张卡可能先收到待处理的旧样子、再收到处理过的，
 * 不能当成刚处理的弹提示（2026-10-18：新开的浏览侧边栏弹出很早以前批准配对的"已批准，新设备拿到凭证"）。没有处理时间的照弹
 */
function handledLongAgo(card: Card): boolean {
  return card.handledAt !== undefined && Date.now() - Date.parse(card.handledAt) > 2 * 60_000;
}

/**
 * realBoard：看板频道接了真数据（由守护进程提供页面时）。看板上的任务、简单提醒、定时作业（19 号票）都来自前端状态层，
 * 不再有假条目；没有守护进程时，假看板里的任务、提醒、定时作业都在。
 */
export function ProtoProvider({ children, realBoard = false }: { children: ReactNode; realBoard?: boolean }) {
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
      if (text && !handledLongAgo(card)) toast(text);
    }
  }, [ui.cards, toast]);

  const value = useMemo(() => {
    const board = realBoard ? [] : proto.board;
    return { proto: { ...proto, board }, update: setProto, realBoard };
  }, [proto, realBoard]);
  return <ProtoContext.Provider value={value}>{children}</ProtoContext.Provider>;
}

export function useProto(): Proto {
  const p = useContext(ProtoContext);
  if (!p) throw new Error("useProto 必须在 ProtoProvider 里用");
  return p;
}
