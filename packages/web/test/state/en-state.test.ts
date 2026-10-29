// 170 号票：状态层其余几块在英文下的说法——时序规则的公式（ltl）、"什么时候做"（triggers）、日历的格子和详情、改时间、提醒卡菜单、
// 看板多选取消、外观、语音模型、关注类别的检查、授权的文件夹、会话的要点那一行、时间线按天分块、调试工具、语音手势。
// 都是英文、没有中文；换回中文又和原来一样（常量表取值时现查）。
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  activeLocaleFrom,
  boardBatchCancelConfirm,
  boardBatchDeleteConfirm,
  boardBatchWhy,
  calendarCells,
  categoryRuleOf,
  clearedDividerText,
  closeReasonText,
  DEFAULT_LANGUAGE,
  folderListNote,
  lastRunText,
  reminderDeleteConfirm,
  reminderMenu,
  reminderRescheduledToast,
  reminderRescheduleHint,
  rescheduleBlocked,
  rescheduledToast,
  rescheduleHint,
  secretaryTitle,
  setActiveLocale,
  START_WHEN_LABEL,
  THEME_CHOICE_LABEL,
  THEME_CHOICES,
  TIMED_MODE_HINT,
  uptimeText,
  voiceModelSummary,
  workflowMarkView,
} from "../../src/state/index.ts";
import { costText, formulaOf, objectiveText, repairsOf } from "../../src/state/ltl.ts";
import { monthWord } from "../../src/state/date-words.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

/** 中文（汉字、中文标点、全角符号） */
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿！-｠]/;

beforeAll(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en")));
afterAll(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

describe("英文下的状态层", () => {
  test("时序规则的公式、修法、代价、择优目标", () => {
    const rule = { trigger: { tool: ["file_delete", "file_move"] }, require: { before: { tool: "backup", where: { eq: ["$prior.args.path", "$current.args.path"] } } } };
    const f = formulaOf(rule);
    expect(f.antecedent).toBe("call(file_delete or file_move)");
    expect(f.formula).toBe("G( call(file_delete or file_move)  →  O(call(backup) ∧ prior.args.path = current.args.path) )");
    expect(formulaOf({ trigger: { tool: "send" } }).consequent).toBe("(violation as soon as it triggers)");
    expect(repairsOf({ repairs: [{ insert: { tool: "backup", title: "back up first" }, cost: { ops: 1 } }, { confirm: { text: "Delete it?" } }] }).map((r) => r.title)).toEqual([
      "Insert step backup (back up first)",
      "Ask you to confirm: Delete it?",
    ]);
    expect(costText({ interaction: 1, ops: 2 })).toBe("interrupts you 1, extra actions 2");
    expect(costText({})).toBe("No extra cost");
    expect(objectiveText({ objective: [{ maximize: "freed" }] })).toEqual([
      "Meet the hard goals first, then pick the cheapest fix (interrupting you > exposing more info > extra actions)",
      "Then make freed as large as possible",
    ]);
  });

  test("什么时候做、最近一次运行、改时间、提醒卡菜单", () => {
    expect(Object.values(START_WHEN_LABEL)).toEqual(["Once, now", "On a schedule", "When something happens", "Just remind me"]);
    expect(TIMED_MODE_HINT.at).not.toMatch(CJK);
    expect(lastRunText({ runId: "j-1-r1", state: "succeeded", queuedAt: "2026-10-09T09:00:00.000+08:00", trigger: "schedule" } as never)?.text).toMatch(/^Last run: /);
    const once = { kind: "once" as const, at: "2020-01-01T09:00:00.000+08:00" };
    expect(rescheduleBlocked({ mode: "at", repeat: { kind: "daily", time: "09:00" }, at: once }, { kind: "daily", time: "09:00" }, Date.parse("2026-10-19T09:00:00Z"))).toBe(
      "That time has passed. Pick a time in the future",
    );
    expect(rescheduleHint("repeat", false)).toBe(
      "Only the schedule changes: the task, its session and run history stay as they are, and the next run follows the new time. A run in progress finishes as usual.",
    );
    expect(rescheduleHint("at", true)).toMatch(/runs once at this time.*It's paused now/);
    expect(rescheduledToast({ state: "paused", schedule: { kind: "daily", time: "08:00" }, nextAt: undefined } as never)).toMatch(/^Changed to .*It's paused and follows the new time once resumed$/);
    expect(reminderMenu({ status: "pending", schedule: { kind: "daily", time: "08:00" } }).map((i) => i.label)).toEqual(["Change time", "Cancel reminder", "Delete reminder", "Select"]);
    // 185 号票：结束了的能归档；删除先确认
    expect(reminderMenu({ status: "fired" }).map((i) => i.label)).toEqual(["Archive", "Delete reminder", "Select"]);
    expect(reminderDeleteConfirm("Call Mom", { status: "fired" }).title).toBe("Delete reminder “Call Mom”?");
    expect(reminderRescheduleHint()).toBe("Only the time changes: the reminder stays the same, and the next one follows the new time.");
    expect(reminderRescheduledToast({ kind: "daily", time: "08:00" })).toMatch(/^Changed to /);
  });

  test("看板多选取消：单复数、任务和提醒混选", () => {
    expect(boardBatchWhy([{ kind: "reminder", id: "r1", reminder: { status: "pending" } }] as never)).toBe(
      "Reminders can be cancelled, archived or deleted together. To change a time, use each card's menu",
    );
    expect(boardBatchDeleteConfirm({ reminders: 1 }).title).toBe("Delete 1 reminder?");
    expect(boardBatchDeleteConfirm({ reminders: 2 }).body).toMatch(/^2 reminders will be deleted: /);
    // 186 号票：任务也能删，混选写清几个任务、几条提醒；不能删的写明为什么
    const both = boardBatchDeleteConfirm({ tasks: 2, running: 1, reminders: 1, blocked: [{ title: "Bookkeeping", why: "managed by the project" }] });
    expect(both.title).toBe("Delete 2 tasks and 1 reminder?");
    expect(both.body).toBe(
      "2 tasks will be deleted along with their maintainers' conversations, working folders and outputs (1 of them hasn't ended yet and will be stopped first). What you said in them is kept as material; to erase it for good, delete it in “Memory · Materials”. 1 reminder will be deleted: those that haven't fired yet won't, and they disappear from the board, calendar and inbox. 1 can't be deleted: “Bookkeeping”: managed by the project. This can't be undone. To just hide them from the board, use “Archive”.",
    );
    expect(boardBatchCancelConfirm({ tasks: 0, reminders: 1, skipped: 0 }).title).toBe("Cancel 1 reminder?");
    const mixed = boardBatchCancelConfirm({ tasks: 2, reminders: 1, skipped: 1 });
    expect(mixed.title).toBe("Cancel 2 tasks and 1 reminder?");
    expect(mixed.body).toMatch(/^2 tasks and 1 reminder will be cancelled; 1 skipped \(already ended, or can't be cancelled right now\)\. /);
    expect(boardBatchCancelConfirm({ tasks: 3, reminders: 0, skipped: 0 }).body).toMatch(/^3 tasks will be cancelled\. /);
  });

  test("日历的格子：月份简写、单复数", () => {
    const cells = calendarCells({
      year: 2026,
      month: 10,
      asOf: {},
      days: [{ date: "2026-10-08", verdict: { workday: true, reasons: [], holidays: [], missing: [] }, reminders: [{}, {}], jobs: [] }],
    } as never);
    expect(cells[0]!.label).toMatch(/^Oct 8 · workday · .* · 2 reminders$/);
    expect(monthWord(10)).toBe("Oct");
  });

  test("外观、语音模型、关注类别、授权的文件夹、秘书页标题、流程卡的敏感标注", () => {
    expect(THEME_CHOICES.map((c) => THEME_CHOICE_LABEL[c])).toEqual(["Light", "Dark", "System"]);
    expect(voiceModelSummary({ status: "unloaded" } as never).detail).toBe("Unloaded after sitting idle; it loads again with the next voice message");
    expect(voiceModelSummary({ status: "ready", model: "small", loadMs: 1500 } as never).detail).toBe("small · Loaded in 1.5 s");
    expect(categoryRuleOf({ title: "", tools: "", paths: "", recipients: "", amountOver: "x" }).problems).toEqual([
      "Give it a name",
      "Amount must be a number (it matches when the amount is above it)",
    ]);
    expect(folderListNote({ kind: "folder", path: "C:\\", folders: [{ name: "a", path: "C:\\a" }], total: 5 } as never)).toBe(
      "5 folders in all, only the first 1 are listed. If yours isn't here, paste its full path below",
    );
    expect(secretaryTitle("Ergo").plain).toBe("Secretary: Ergo");
    expect(workflowMarkView({ category: "delete", title: "Delete files", authorized: true, disposition: "ask_first" } as never).text).toBe("✓ Delete files: approved in the plan");
  });

  test("会话里清空的分隔线、调试工具、都没有中文", () => {
    expect(clearedDividerText("2026-10-13T14:02:00.000+08:00")).toBe("New conversation below · cleared 10/13 14:02");
    expect(closeReasonText(1006, undefined)).not.toMatch(CJK);
    expect(uptimeText(30_000)).toBe("Under 1 minute");
  });

  test("换回中文：和原来一字不差", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    try {
      expect(costText({ interaction: 1, ops: 2 })).toBe("打扰用户 1、多做动作 2");
      expect(formulaOf({ trigger: { tool: "send" } }).consequent).toBe("（触发即违规）");
      expect(THEME_CHOICES.map((c) => THEME_CHOICE_LABEL[c])).toEqual(["浅色", "深色", "跟随系统"]);
      expect(boardBatchCancelConfirm({ tasks: 2, reminders: 1, skipped: 1 }).title).toBe("取消 2 个任务、1 条提醒？");
      expect(secretaryTitle("二狗").plain).toBe("个人秘书：二狗");
      expect(clearedDividerText("2026-10-13T14:02:00.000+08:00")).toBe("以下是新对话 · 10-13 14:02 清空");
    } finally {
      setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    }
  });
});
