// 简单提醒卡菜单的界面那一半（156 号票）：菜单项由状态层的 reminderMenu 算（state/reminder-menu.ts），这里只管画和做，
// 写法照任务菜单（ui/task-menu.tsx）：
// - ReminderMenuPopup：贴着卡片弹出（ui/popup.tsx 的 PopupMenu），样子和任务卡的菜单同一个（.row-menu.task-menu）；
// - useReminderActs：点了一项之后做什么——改时间弹出改时间的对话框（ui/reschedule-dialog.tsx 的 ReminderRescheduleDialog），
//   存了交给要动手的提醒；取消提醒直接做（和提醒卡上的按钮一样不再问）；185 号票起归档直接做，删除先确认一次（ReminderDeleteConfirm，
//   聊天里的提醒卡上的"删除"也用它）。"多选"由用的地方自己接。
// 要动手的提醒（ReminderActsTarget）：真提醒的改时间、取消落在它的提醒卡上（save / cancel_reminder），归档、删除交 reminder_action；
// 原型的假提醒在页面上演——由看板给。
import { type ReactNode, type RefObject, useState } from "react";
import { type PopupAlign, type ReminderMenuItem, type ReminderMenuSubject, type ReminderSchedule, reminderDeleteConfirm, reminderRescheduledToast, t } from "../../state/index.ts";
import { Sheet } from "../../ui/common.tsx";
import { PopupMenu } from "../../ui/popup.tsx";
import { ReminderRescheduleDialog } from "../../ui/reschedule-dialog.tsx";
import { useToast } from "../../ui/toast.tsx";

/** 要动手的那条提醒：提醒什么（对话框标题里写）、现在的样子（删除的确认按它说）、取消、换时间表、归档、删除 */
export interface ReminderActsTarget {
  readonly title: string;
  readonly subject: ReminderMenuSubject;
  cancel(): void;
  reschedule(schedule: ReminderSchedule): void;
  archive(): void;
  remove(): void;
  /** 做完要不要提示一句（原型的假提醒没有卡片会变，提示一句；真提醒的卡跟着变，被拒的原因由页面底部的提示说） */
  readonly toast?: boolean | undefined;
}

/** 贴着提醒卡弹出的菜单：点了一项菜单先关掉再做；收不回的（取消提醒、删除提醒）标红 */
export function ReminderMenuPopup({ anchor, align, items, onPick, onClose }: { anchor: RefObject<HTMLElement | null>; align: PopupAlign; items: readonly ReminderMenuItem[]; onPick(item: ReminderMenuItem): void; onClose(): void }) {
  return (
    <PopupMenu anchor={anchor} align={align} className="row-menu task-menu" onClose={onClose}>
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          role="menuitem"
          className={"tone" in item && item.tone === "danger" ? "danger-text" : undefined}
          onClick={() => {
            onClose();
            onPick(item);
          }}
        >
          {item.label}
        </button>
      ))}
    </PopupMenu>
  );
}

/** 删一条提醒之前的确认（185 号票）：写明删了以后什么样、收不回；"留着"关掉，"删除"才删 */
export function ReminderDeleteConfirm({ title, subject, onCancel, onConfirm }: { title: string; subject: ReminderMenuSubject; onCancel(): void; onConfirm(): void }) {
  const confirm = reminderDeleteConfirm(title, subject);
  return (
    <Sheet title={confirm.title} onClose={onCancel} center>
      <div className="modal-body">
        <p>{confirm.body}</p>
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("ui.reminderMenu.keep")}
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          {t("ui.reminderMenu.delete")}
        </button>
      </div>
    </Sheet>
  );
}

/** 点了提醒菜单里的一项之后做什么（"多选"除外）：run(要动手的提醒, 菜单项)；改时间、删除确认的对话框（dialogs）放在页面里 */
export function useReminderActs(): { run(target: ReminderActsTarget, item: ReminderMenuItem): void; dialogs: ReactNode } {
  const [asking, setAsking] = useState<{ target: ReminderActsTarget; schedule: ReminderSchedule }>();
  const [deleting, setDeleting] = useState<ReminderActsTarget>();
  const toast = useToast();
  const run = (target: ReminderActsTarget, item: ReminderMenuItem) => {
    switch (item.kind) {
      case "reschedule":
        return setAsking({ target, schedule: item.schedule });
      case "cancel":
        target.cancel();
        if (target.toast) toast(t("ui.reminderMenu.canceled", { title: target.title }));
        return;
      case "archive":
        target.archive();
        if (target.toast) toast(t("ui.reminderMenu.archived", { title: target.title }));
        return;
      case "delete":
        return setDeleting(target);
      case "select":
        return;
    }
  };
  const dialogs = (
    <>
      {asking && (
        <ReminderRescheduleDialog
          title={asking.target.title}
          current={asking.schedule}
          onCancel={() => setAsking(undefined)}
          onSave={(schedule) => {
            setAsking(undefined);
            asking.target.reschedule(schedule);
            if (asking.target.toast) toast(reminderRescheduledToast(schedule));
          }}
        />
      )}
      {deleting && (
        <ReminderDeleteConfirm
          title={deleting.title}
          subject={deleting.subject}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            setDeleting(undefined);
            deleting.remove();
            if (deleting.toast) toast(t("ui.reminderMenu.deleted", { title: deleting.title }));
          }}
        />
      )}
    </>
  );
  return { run, dialogs };
}
