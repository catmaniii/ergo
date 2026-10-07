// 原型里看板、项目、设置这些假数据的本地状态。
// 这些频道的事件和归并在后面的票里接进前端状态层（看板 12、项目 15……），到时候这个文件整个删掉。
// 待我处理 06 号票起已经在前端状态层里（原型的假事项由假连接作为 inbox_item 事件推来）。
//
// 卡片处理后别的假数据要跟着变（点了"立项"就多一个项目）：这里看的是前端状态层里卡片的变化，
// 不认具体是哪个连接，所以 App.tsx 里换掉连接也照样工作。
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../app/store.tsx";
import type { BoardEntry, PairedDevice, ProjectSummary, ReminderSummary, SkillEntry, TaskSummary, WatchCategory } from "../model/types.ts";
import type { Card, CardAction, Reminder, UiState } from "../state/index.ts";
import { useToast } from "../ui/toast.tsx";
import { nowIso } from "../util/time.ts";
import type { ExtraRule, ManualMark } from "./calendar.ts";
import { FAKE_BOARD, FAKE_DEVICES, FAKE_PROJECTS, FAKE_SKILLS, FAKE_WATCH_CATEGORIES } from "./fake-data.ts";

export interface ProtoState {
  board: BoardEntry[];
  projects: ProjectSummary[];
  categories: WatchCategory[];
  devices: PairedDevice[];
  skills: SkillEntry[];
  calendar: { rules: ExtraRule[]; marks: Record<string, ManualMark> };
}

const INITIAL: ProtoState = {
  board: FAKE_BOARD,
  projects: FAKE_PROJECTS,
  categories: FAKE_WATCH_CATEGORIES,
  devices: FAKE_DEVICES,
  skills: FAKE_SKILLS,
  calendar: {
    rules: [{ id: "rule-1", kind: "last_weekday", weekday: 6 }],
    marks: { "2026-10-12": "rest", "2026-10-17": "work" },
  },
};

interface Proto {
  proto: ProtoState;
  update(f: (s: ProtoState) => ProtoState): void;
}

const ProtoContext = createContext<Proto | null>(null);

function patchTask(s: ProtoState, id: string, patch: Partial<TaskSummary>): ProtoState {
  return { ...s, board: s.board.map((e) => (e.kind === "task" && e.id === id ? { ...e, ...patch } : e)) };
}

/** 卡片处理后，原型里别的假数据跟着变 */
function sideEffect(s: ProtoState, card: Card, action: CardAction): ProtoState {
  const payload = card.payload as Record<string, unknown>;
  const now = nowIso();
  if (card.type === "suggest_project" && action === "kickoff") {
    const project: ProjectSummary = { id: `p-new-${card.id}`, name: String(payload.name), goal: String(payload.goal), status: "preparing", activity: "working", activityNote: "立项问答", activeTasks: 0 };
    return { ...s, projects: [project, ...s.projects] };
  }
  if (card.type === "suggest_task" && action === "start_task") {
    const task: TaskSummary = { kind: "task", id: `t-new-${card.id}`, title: String(payload.title), status: "planning", activity: "working", activityNote: "和你对齐意图", tokens: 0, projects: [], updatedAt: now };
    return { ...s, board: [task, ...s.board] };
  }
  if (card.id === "c-charter-1") {
    const started = action === "confirm_start" ? { status: "building" as const, activeTasks: 1, activity: "working" as const, activityNote: "首个建设任务" } : {};
    return { ...s, projects: s.projects.map((p) => (p.id === "p-appliance" ? { ...p, charterConfirmed: true, ...started } : p)) };
  }
  if (card.id === "c-plan-bills") {
    return action === "confirm"
      ? patchTask(s, "t-bills", { status: "queued", stage: { current: 1, total: 3 }, activity: "queued", activityNote: "等执行名额" })
      : patchTask(s, "t-bills", { status: "planning", activity: "working", activityNote: "按你的意见重新起草计划" });
  }
  if (card.id === "c-appr-1") {
    return patchTask(s, "t-photos", { status: "running", waitReason: undefined, activity: "working", activityNote: action === "approve" ? "同步备份端" : "在现有授权内重排这一步" });
  }
  if (card.type === "pairing" && action === "approve") {
    const device: PairedDevice = { id: `d-${card.id}`, name: String(payload.deviceName), pairedAt: now, lastUsedAt: now, expiresAt: "2027-10-07" };
    return { ...s, devices: [device, ...s.devices] };
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
  if (card.id === "c-charter-1") return action === "confirm_start" ? "已开工：发起了首个建设任务，项目进入建设中" : "立项书已确认，项目留在筹备中";
  if (card.id === "c-plan-bills") return action === "confirm" ? "计划已确认，任务进入排队中" : "已打回，意见交给了起草计划的维护者";
  if (card.type === "pairing" && action === "approve") return "已批准，新设备拿到凭证";
  return undefined;
}

/** 看板上的一条简单提醒（已取消的不上看板）。12 号票接看板时换成正式的看板视图 */
function reminderEntry(r: Reminder): ReminderSummary | undefined {
  if (r.status === "cancelled") return undefined;
  return { kind: "reminder", id: r.id, title: r.text, status: r.status === "fired" ? "fired" : "pending", nextAt: r.nextAt ?? r.lastFiredAt ?? r.updatedAt, schedule: r.schedule };
}

function realReminderEntries(ui: UiState): ReminderSummary[] {
  return Object.values(ui.reminders).flatMap((r) => reminderEntry(r) ?? []);
}

/**
 * realReminders：看板频道接了真数据（由守护进程提供页面时）。看板上的简单提醒换成前端状态层里真的提醒
 * （待触发的在"运营中"，已触发的一次性提醒在"最近结束"），任务和定时作业仍是假数据。
 */
export function ProtoProvider({ children, realReminders = false }: { children: ReactNode; realReminders?: boolean }) {
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
      if (text) toast(text);
    }
  }, [ui.cards, toast]);

  const value = useMemo(() => {
    const board = realReminders ? [...proto.board.filter((e) => e.kind !== "reminder"), ...realReminderEntries(ui)] : proto.board;
    return { proto: { ...proto, board }, update: setProto };
  }, [proto, realReminders, ui]);
  return <ProtoContext.Provider value={value}>{children}</ProtoContext.Provider>;
}

export function useProto(): Proto {
  const p = useContext(ProtoContext);
  if (!p) throw new Error("useProto 必须在 ProtoProvider 里用");
  return p;
}
