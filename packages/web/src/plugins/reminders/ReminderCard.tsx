// 简单提醒卡（06 号票；185 号票加了归档、删除）。193 号票：挪进提醒插件，登记成卡片类型 reminder 的画法（plugins/reminders/plugin.tsx）；
// 提醒插件停用时这张卡（聊天、待办、任务详情里）显示占位（守护进程那边卡上的动作回"提醒插件没启用"，126 号票）。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { outcomeLabel } from "../../model/cards.ts";
import { describeSchedule, isRepeating, jobTriggerText, REMINDER_STATUS_LABEL, type ReminderCardPayload, type ReminderEditInput, type ReminderSchedule, t } from "../../state/index.ts";
import { nextTimeLabel, timeLabel } from "../../util/time.ts";
import { Btn, ScheduleEditor } from "../../ui/cards/cards.tsx";
import { type CardProps, CardShell } from "../../ui/cards/CardShell.tsx";
import { useToast } from "../../ui/toast.tsx";
import { ReminderDeleteConfirm } from "./reminder-menu.tsx";

/**
 * 简单提醒卡：时间或重复规则和内容，可以"改"（新的时间或重复规则，动作 save 带输入）和"取消提醒"。
 * 一次性的到点后卡片变成已触发（不能再改）；重复的到点后仍可以改，显示下一次的时间。
 * 时间的写法、钟点、换规则都用共享协议包的 reminder-schedule.ts，这里不按规则种类分支。
 * 185 号票：还没响的多一个"删除"；响过的、取消了的卡片已经处理完，结果下面还有"归档"（没归档的）、"删除"——归档、删除不是卡片动作，
 * 交 reminder_action（被拒的原因页面底部提示）；删除先确认一次（和看板菜单同一个确认）。归档了写"· 已归档"，删了写"已删除"、不再有按钮。
 */
export function ReminderCard({ state, payload: p, done, act }: CardProps<ReminderCardPayload>) {
  // 正在改的草稿；卡片有了新版本（别处改了、到点了）草稿就作废
  const [edit, setEdit] = useState<{ version: number; schedule: ReminderSchedule }>();
  const editing = edit?.version === state.card.version;
  const more = useReminderCardActs(state, p);
  // 事件发生时提醒的（77 号票）：没有时间表，卡上写在等什么事件，不能改时间（要按时间提醒就取消了另建）
  if (!p.schedule) {
    return (
      <CardShell
        state={state}
        title={p.text}
        doneLabel={more.doneLabel}
        doneActions={more.doneActions}
        actions={
          <>
            <Btn onClick={() => act("cancel_reminder")}>{t("ui.cards.reminder.cancel")}</Btn>
            {more.deleteButton}
          </>
        }
      >
        <div>
          <b>{jobTriggerText(p)}</b>
        </div>
        {p.lastFiredAt && <div className="muted">{t("ui.cards.reminder.last", { time: timeLabel(p.lastFiredAt) })}</div>}
        {more.dialogs}
      </CardShell>
    );
  }
  const schedule = p.schedule;
  const repeating = isRepeating(schedule);
  return (
    <CardShell
      state={state}
      title={p.text}
      doneLabel={more.doneLabel}
      doneActions={more.doneActions}
      actions={
        editing ? (
          <>
            <Btn onClick={() => setEdit(undefined)}>{t("ui.cards.reminder.keep")}</Btn>
            <Btn kind="primary" onClick={() => act("save", undefined, { schedule: edit.schedule } satisfies ReminderEditInput)}>
              {t("ui.cards.reminder.save")}
            </Btn>
          </>
        ) : (
          <>
            <Btn onClick={() => act("cancel_reminder")}>{t("ui.cards.reminder.cancel")}</Btn>
            {more.deleteButton}
            <Btn kind="primary" onClick={() => setEdit({ version: state.card.version, schedule })}>
              {t("ui.cards.reminder.edit")}
            </Btn>
          </>
        )
      }
    >
      <div>
        <b>{describeSchedule(schedule)}</b>
      </div>
      {repeating && p.nextAt && p.status === "pending" && <div className="muted">{t("ui.cards.reminder.next", { time: nextTimeLabel(p.nextAt) })}</div>}
      {repeating && p.lastFiredAt && <div className="muted">{t("ui.cards.reminder.last", { time: timeLabel(p.lastFiredAt) })}</div>}
      {editing && !done && <ScheduleEditor value={edit.schedule} onChange={(next) => setEdit({ version: state.card.version, schedule: next })} />}
      {more.dialogs}
    </CardShell>
  );
}

/**
 * 提醒卡上的归档、删除（185 号票）：处理完之后的那行字（已触发 · 时间 / 取消的结果，归档了加"· 已归档"，删了是"已删除"）、
 * 处理完之后的按钮（归档、删除）、还没响时的"删除"按钮、删除的确认框。交 reminder_action，没成的原因在页面底部提示
 */
function useReminderCardActs(state: CardProps<ReminderCardPayload>["state"], p: ReminderCardPayload) {
  const { reminderAction } = useStore();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = (action: "archive" | "delete") => {
    setBusy(true);
    reminderAction([p.reminderId], action)
      .then(
        ({ results }) => {
          const failed = results.find((r) => !r.ok);
          if (failed && !failed.ok) toast(failed.message);
        },
        // 整个被拒的原因页面底部已经提示了
        () => undefined,
      )
      .finally(() => setBusy(false));
  };
  const deleted = p.status === "deleted";
  const subject = { status: p.status === "deleted" ? "cancelled" : p.status, schedule: p.schedule, archived: p.archived } as const;
  const archived = p.archived ? ` · ${t("ui.cards.reminder.archived")}` : "";
  const doneLabel = deleted
    ? t("ui.cards.reminder.deleted")
    : p.status === "fired"
      ? `${REMINDER_STATUS_LABEL.fired}${p.lastFiredAt ? ` · ${timeLabel(p.lastFiredAt)}` : ""}${archived}`
      : archived
        ? `${outcomeLabel(state.card)}${archived}`
        : undefined;
  const deleteButton = !deleted && (
    <Btn kind="ghost" disabled={busy} onClick={() => setDeleting(true)}>
      {t("ui.cards.reminder.delete")}
    </Btn>
  );
  const doneActions =
    !deleted && p.status !== "pending" ? (
      <>
        {!p.archived && (
          <Btn disabled={busy} onClick={() => run("archive")}>
            {t("ui.cards.reminder.archive")}
          </Btn>
        )}
        {deleteButton}
      </>
    ) : undefined;
  const dialogs = deleting && (
    <ReminderDeleteConfirm
      title={p.text}
      subject={subject}
      onCancel={() => setDeleting(false)}
      onConfirm={() => {
        setDeleting(false);
        run("delete");
      }}
    />
  );
  return { doneLabel, doneActions, deleteButton, dialogs };
}
