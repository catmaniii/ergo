// 改时间的对话框（98 号票）：任务操作菜单里运营中的定时任务点"改时间"弹出。和发起任务对话框同一套时间表编辑（TimedScheduleEditor：
// 按时间表反复做 / 某个时间做一次，含"按我的工作日"），从现在的时间表起草（state/reschedule.ts）；某个时间做一次的时间已过、没改的不能存。
// 只换时间表：任务、会话、运行记录都不变。保存交给用的地方（发请求、提示改成了什么）。
import { useState } from "react";
import { describeSchedule, draftSchedule, onceAtInFuture, type ReminderSchedule, rescheduleBlocked, rescheduleDraft, rescheduleHint } from "../state/index.ts";
import { Sheet } from "./common.tsx";
import { TimedScheduleEditor } from "./timed-schedule-editor.tsx";

/** 某个时间做一次的那个时间已经过了 */
const PASSED_HINT = "这个时间已经过了：定一个将来的时间。";

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
    <Sheet title="改时间" onClose={onCancel} center>
      <div className="modal-body reschedule-now">
        「{title}」现在是 <b>{describeSchedule(current)}</b>
        {paused ? "（暂停着）" : ""}
      </div>
      <fieldset className="field when-picker">
        <legend>改成</legend>
        <TimedScheduleEditor
          mode={draft.mode}
          onMode={(mode) => change({ mode })}
          repeat={draft.repeat}
          onRepeat={(repeat) => change({ repeat })}
          at={draft.at}
          onAt={(at) => change({ at })}
          passed={passed ? PASSED_HINT : undefined}
        />
      </fieldset>
      <div className="hint">{rescheduleHint(draft.mode, paused)}</div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={blocked !== undefined} title={blocked} onClick={() => onSave(draftSchedule(draft))}>
          保存
        </button>
      </div>
    </Sheet>
  );
}
