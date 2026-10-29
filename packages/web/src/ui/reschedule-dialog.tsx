// 改时间的对话框（98 号票）：任务操作菜单里运营中的定时任务点"改时间"弹出。和发起任务对话框同一套时间表编辑（TimedScheduleEditor：
// 按时间表反复做 / 某个时间做一次，含"按我的工作日"），从现在的时间表起草（state/reschedule.ts）；某个时间做一次的时间已过、没改的不能存。
// 只换时间表：任务、会话、运行记录都不变。保存交给用的地方（发请求、提示改成了什么）。
// 156 号票：看板上简单提醒卡的菜单里"改时间"也弹这样一个对话框（ReminderRescheduleDialog）：样子一样，时间表编辑用提醒卡上同一个
// （ScheduleEditor：一次性 / 每天、每周几、每月几号、按我的工作日），没改的、一次性的时间已过的不能存。
import { useState } from "react";
import {
  describeSchedule,
  draftSchedule,
  onceAtInFuture,
  reminderRescheduleHint,
  type ReminderSchedule,
  reminderRescheduleBlocked,
  rescheduleBlocked,
  rescheduleDraft,
  rescheduleHint,
  t,
} from "../state/index.ts";
import { ScheduleEditor } from "./cards/cards.tsx";
import { Sheet } from "./common.tsx";
import { T } from "./i18n.tsx";
import { TimedScheduleEditor } from "./timed-schedule-editor.tsx";

/** 某个时间做一次的那个时间已经过了 */
const passedHint = (): string => t("ui.rescheduleDialog.passed");

export function RescheduleDialog({
  title,
  current,
  paused,
  onCancel,
  onSave,
}: {
  /** 任务的标题 */
  title: string;
  /** 现在的时间表（预填） */
  current: ReminderSchedule;
  /** 触发暂停着：说明改完照旧暂停 */
  paused: boolean;
  onCancel(): void;
  onSave(schedule: ReminderSchedule): void;
}) {
  const [draft, setDraft] = useState(() => rescheduleDraft(current, new Date()));
  /** 改了"某个时间做一次"时的此刻（改的时候现取；渲染时不取时钟） */
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const blocked = rescheduleBlocked(draft, current, checkedAt);
  const passed = draft.mode === "at" && !onceAtInFuture(draft.at, checkedAt);
  const change = (next: Partial<typeof draft>) => {
    setDraft({ ...draft, ...next });
    setCheckedAt(Date.now());
  };
  return (
    <Sheet title={t("ui.rescheduleDialog.title")} onClose={onCancel} center>
      <div className="modal-body reschedule-now">
        <T k="ui.rescheduleDialog.now" params={{ title, schedule: <b>{describeSchedule(current)}</b> }} />
        {paused ? t("ui.rescheduleDialog.paused") : ""}
      </div>
      <fieldset className="field when-picker">
        <legend>{t("ui.rescheduleDialog.changeTo")}</legend>
        <TimedScheduleEditor
          mode={draft.mode}
          onMode={(mode) => change({ mode })}
          repeat={draft.repeat}
          onRepeat={(repeat) => change({ repeat })}
          at={draft.at}
          onAt={(at) => change({ at })}
          passed={passed ? passedHint() : undefined}
        />
      </fieldset>
      <div className="hint">{rescheduleHint(draft.mode, paused)}</div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("ui.rescheduleDialog.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={blocked !== undefined} title={blocked} onClick={() => onSave(draftSchedule(draft))}>
          {t("ui.rescheduleDialog.save")}
        </button>
      </div>
    </Sheet>
  );
}

/** 简单提醒的改时间（156 号票）：title 是提醒的内容，current 是现在的时间表（预填）；存了交给用的地方（落在提醒卡的 save 上） */
export function ReminderRescheduleDialog({ title, current, onCancel, onSave }: { title: string; current: ReminderSchedule; onCancel(): void; onSave(schedule: ReminderSchedule): void }) {
  const [draft, setDraft] = useState(current);
  /** 改的时候现取此刻（渲染时不取时钟） */
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const blocked = reminderRescheduleBlocked(draft, current, checkedAt);
  return (
    <Sheet title={t("ui.rescheduleDialog.title")} onClose={onCancel} center>
      <div className="modal-body reschedule-now">
        <T k="ui.rescheduleDialog.now" params={{ title, schedule: <b>{describeSchedule(current)}</b> }} />
      </div>
      <div className="field when-picker">
        <ScheduleEditor
          value={draft}
          onChange={(next) => {
            setDraft(next);
            setCheckedAt(Date.now());
          }}
        />
      </div>
      {draft.kind === "once" && !onceAtInFuture(draft, checkedAt) && <div className="hint">{passedHint()}</div>}
      <div className="hint">{reminderRescheduleHint()}</div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("ui.rescheduleDialog.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={blocked !== undefined} title={blocked} onClick={() => onSave(draft)}>
          {t("ui.rescheduleDialog.save")}
        </button>
      </div>
    </Sheet>
  );
}
