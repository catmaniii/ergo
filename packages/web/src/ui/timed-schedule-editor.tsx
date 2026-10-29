// "定时"的时间表编辑（76 号票发起任务对话框里的那一段，98 号票抽出来和任务操作菜单里的"改时间"共用）：
// 按时间表反复做 / 某个时间做一次两种（state/triggers.ts 的 TIMED_MODES），下面一行是选中那种的说明；反复的用 ScheduleEditor 的
// repeatOnly（每天、每周几、每月几号、按我的工作日），某个时间做一次用 onceOnly（日期和时间）；那个时间已经过了时写一句。
// 受控：选哪种、两种各自的时间表都由用的地方存着（切来切去不丢；发起对话框按写的话自动填也是改这几样）。渲染时不取时钟，过没过由用的地方算好给。
import { type ReminderSchedule, t, TIMED_MODE_HINT, TIMED_MODE_LABEL, TIMED_MODES, type TimedMode } from "../state/index.ts";
import { ScheduleEditor } from "./cards/cards.tsx";

export function TimedScheduleEditor({
  mode,
  onMode,
  repeat,
  onRepeat,
  at,
  onAt,
  passed,
}: {
  mode: TimedMode;
  onMode(mode: TimedMode): void;
  /** 按时间表反复做：重复的时间表 */
  repeat: ReminderSchedule;
  onRepeat(schedule: ReminderSchedule): void;
  /** 某个时间做一次：一次性的时间表 */
  at: ReminderSchedule;
  onAt(schedule: ReminderSchedule): void;
  /** 某个时间做一次的那个时间已经过了：写的那一句（没过的不给） */
  passed?: string | undefined;
}) {
  return (
    <>
      <div className="seg timed-seg" role="radiogroup" aria-label={t("ui.timedScheduleEditor.label")}>
        {TIMED_MODES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={`seg-btn${mode === m ? " on" : ""}`} title={TIMED_MODE_HINT[m]} onClick={() => onMode(m)}>
            {TIMED_MODE_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="sc-mode-hint">{TIMED_MODE_HINT[mode]}</div>
      {/* 两种各是一个编辑框（key 分开：切换时不沿用另一种的输入框） */}
      {mode === "repeat" ? <ScheduleEditor key="repeat" value={repeat} onChange={onRepeat} repeatOnly label={t("ui.timedScheduleEditor.repeatLabel")} /> : <ScheduleEditor key="at" value={at} onChange={onAt} onceOnly label={t("ui.timedScheduleEditor.atLabel")} />}
      {mode === "at" && passed && <div className="hint">{passed}</div>}
    </>
  );
}
