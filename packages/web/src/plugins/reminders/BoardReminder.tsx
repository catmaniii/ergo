// 看板上的简单提醒卡（12 号票；156 号票的菜单和多选，185 号票的归档、删除）。193 号票：从任务页（pages/TasksPage.tsx）挪进提醒插件，
// 登记成看板条目 reminder 的画法（plugins/reminders/plugin.tsx）：
// - ReminderBoardScope 包在整个看板外面一次：菜单点了以后要做的（useReminderActs 的改时间、删除确认的对话框画在看板那一栏的最后，
//   和搬过来之前同一个位置）、要动手的那条提醒（useReminderTarget）；
// - ReminderBoardEntry 是每一张：长按 / 右键出菜单（state/reminder-menu.ts 算、reminder-menu.tsx 画和做），多选时点卡片是勾选
//   （和任务混着选由核心的看板管，批量动作在 pages/board-select.tsx）。
// 提醒插件停用时核心不画这张卡，同一组里连着的几条合成一行占位"（提醒插件没启用，N 条内容暂时看不到）"。
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import type { ReminderSummary } from "../../model/types.ts";
import { useProto } from "../../prototype/proto-store.tsx";
import { describeSchedule, isRepeating, nextClockTime, nowIso, REMINDER_STATUS_LABEL, type ReminderAction, type ReminderMenuItem, reminderMenu, scheduleClockTime, t } from "../../state/index.ts";
import { nextTimeLabel, timeLabel } from "../../util/time.ts";
import { useLongPress } from "../../ui/long-press.ts";
import { CardCheck } from "../../ui/select-mode.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { BoardEntryProps } from "../api.ts";
import { type ReminderActsTarget, ReminderMenuPopup, useReminderActs } from "./reminder-menu.tsx";

/** 简单提醒卡的菜单和多选（156 号票）：和任务卡一样，菜单项是提醒的（state/reminder-menu.ts） */
interface ReminderChoice {
  readonly menu: readonly ReminderMenuItem[];
  onPick(item: ReminderMenuItem): void;
  readonly selecting: boolean;
  readonly checked: boolean;
  onToggle(): void;
}

/** 看板这一份：点了菜单里的一项之后做什么、要动手的是哪条提醒 */
interface BoardActs {
  run(target: ReminderActsTarget, item: ReminderMenuItem): void;
  targetOf(r: ReminderSummary): ReminderActsTarget;
}

const BoardActsContext = createContext<BoardActs | undefined>(undefined);

/** 包在整个看板外面一次：改时间、删除确认的对话框画在看板那一栏的最后 */
export function ReminderBoardScope({ children }: { children: ReactNode }) {
  const acts = useReminderActs();
  const targetOf = useReminderTarget();
  return (
    <BoardActsContext.Provider value={{ run: acts.run, targetOf }}>
      {children}
      {acts.dialogs}
    </BoardActsContext.Provider>
  );
}

/** 看板上的一张简单提醒卡 */
export function ReminderBoardEntry({ entry, selecting, checked, onToggle, onSelect }: BoardEntryProps) {
  const acts = useContext(BoardActsContext);
  if (entry.kind !== "reminder") return null;
  const choice: ReminderChoice = {
    menu: reminderMenu(entry),
    onPick: (item) => (item.kind === "select" ? onSelect() : acts?.run(acts.targetOf(entry), item)),
    selecting,
    checked,
    onToggle,
  };
  return <ReminderCard r={entry} choice={choice} />;
}

/**
 * 要动手的那条简单提醒（156 号票，看板卡的菜单、多选共用）：真提醒的改时间、取消落在它的提醒卡上（改时间是卡片动作 save 带新的时间表，
 * 取消是 cancel_reminder；被拒的原因由页面底部的提示说），185 号票起归档、删除交 reminder_action（没成的原因提示一句）；
 * 原型的假提醒在页面上演（取消了挪进最近结束，归档了挪进已归档，删了从看板上拿掉，改时间换掉时间表、下一次按新的钟点粗算），做完提示一句
 */
function useReminderTarget(): (r: ReminderSummary) => ReminderActsTarget {
  const { ui, cardAction, reminderAction } = useStore();
  const { update } = useProto();
  const toast = useToast();
  return (r) => {
    const subject = { status: r.status, schedule: r.schedule, archived: r.archived };
    if (ui.reminders[r.id] && r.cardId) {
      const cardId = r.cardId;
      const act = (action: ReminderAction) =>
        void reminderAction([r.id], action).then(
          ({ results }) => {
            const failed = results.find((x) => !x.ok);
            if (failed && !failed.ok) toast(failed.message);
          },
          // 整个被拒的原因页面底部已经提示了
          () => undefined,
        );
      return {
        title: r.title,
        subject,
        cancel: () => cardAction(cardId, "cancel_reminder"),
        reschedule: (schedule) => cardAction(cardId, "save", undefined, { schedule }),
        archive: () => act("archive"),
        remove: () => act("delete"),
      };
    }
    const patch = (change: Partial<ReminderSummary>) => update((s) => ({ ...s, board: s.board.map((e) => (e.kind === "reminder" && e.id === r.id ? { ...e, ...change } : e)) }));
    return {
      title: r.title,
      subject,
      toast: true,
      cancel: () => patch({ status: "cancelled" }),
      reschedule: (schedule) => patch({ schedule, nextAt: schedule.kind === "once" ? schedule.at : nowIso(nextClockTime(scheduleClockTime(schedule), new Date())) }),
      archive: () => patch({ archived: true }),
      remove: () => update((s) => ({ ...s, board: s.board.filter((e) => !(e.kind === "reminder" && e.id === r.id)) })),
    };
  };
}

/**
 * 简单提醒卡：长按 / 右键出菜单（156 号票：照提醒能做的——改时间、取消提醒，185 号票起归档、删除提醒，后面"多选"；写法照任务卡，
 * state/reminder-menu.ts 算、reminder-menu.tsx 画和做）；多选时点卡片就是勾选（和任务混着选，批量动作只给两者都能做的）。
 * 平时点卡片不打开什么。状态：运营中 · 待触发，简单提醒 · 已触发 / 已取消（185 号票起已取消的也在最近结束、能归档）
 */
function ReminderCard({ r, choice }: { r: ReminderSummary; choice: ReminderChoice }) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const press = useLongPress(() => setMenu(true), { disabled: choice.selecting });
  return (
    <div
      ref={ref}
      className={`bcard bcard-static bcard-reminder${choice.checked ? " picked on" : ""}`}
      role={choice.selecting ? "button" : undefined}
      tabIndex={choice.selecting ? 0 : undefined}
      aria-pressed={choice.selecting ? choice.checked : undefined}
      onClick={choice.selecting ? choice.onToggle : undefined}
      onKeyDown={(e) => {
        if (!choice.selecting || e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        choice.onToggle();
      }}
      {...press}
    >
      {menu && <ReminderMenuPopup anchor={ref} align="start" items={choice.menu} onPick={choice.onPick} onClose={() => setMenu(false)} />}
      <div className="bcard-row">
        {choice.selecting && <CardCheck checked={choice.checked} />}
        <span className="bcard-title">⏰ {r.title}</span>
      </div>
      <div className="bcard-meta bcard-status-row">
        <span className={`st ${r.status === "cancelled" ? "st-cancelled" : "st-ops"}`}>
          {r.status === "pending" ? t("pages.tasks.reminder.operating", { status: REMINDER_STATUS_LABEL.pending }) : t("pages.tasks.reminder.fired", { status: REMINDER_STATUS_LABEL[r.status] })}
        </span>
        {r.schedule ? <span className="bcard-num">{isRepeating(r.schedule) ? describeSchedule(r.schedule) : t("pages.tasks.reminder.once")}</span> : <span>{t("pages.tasks.reminder.onEvent")}</span>}
        {/* 待触发的写下一次；响过的写那一次；取消了的一次性写原来定的那一刻，重复的不写 */}
        {r.schedule && (r.status === "pending" || r.status === "fired" || !isRepeating(r.schedule)) ? (
          <span className="bcard-num">{r.status === "pending" ? t("pages.tasks.next", { time: nextTimeLabel(r.nextAt) }) : timeLabel(r.nextAt)}</span>
        ) : null}
      </div>
      {/* 事件发生时提醒的（77 号票）：在等什么事件、最近一次 */}
      {r.waitingFor && <div className="bcard-waiting">{t("pages.tasks.waitingFor", { what: r.waitingFor })}</div>}
      {r.lastEvent && (
        <div className="bcard-waiting muted">
          {t("pages.tasks.reminder.lastEvent", { event: r.lastEvent, time: timeLabel(r.nextAt) })}
        </div>
      )}
    </div>
  );
}
