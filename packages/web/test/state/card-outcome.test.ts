// 卡片处理后的短提示（state/card-outcome.ts）：原来放在原型的 proto-store 里，安装版也要；中英都有，很早以前处理过的不再提示。
import { afterEach, describe, expect, test } from "vitest";
import { activeLocaleFrom, type Card, type CardAction, cardOutcomeToast, DEFAULT_LANGUAGE, handledLongAgo, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const card = (type: string, payload: unknown = {}, handledAt?: string): Card => ({ id: "c-1", type, payload, ...(handledAt ? { handledAt } : {}) }) as unknown as Card;
const toast = (type: string, action: string, payload?: unknown) => cardOutcomeToast(card(type, payload), action as CardAction);

afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

describe("卡片处理后提示什么", () => {
  test("各种卡按动作说各自的话，名字带上", () => {
    expect(toast("suggest_project", "kickoff", { name: "菜谱" })).toBe("项目「菜谱」诞生了（筹备中），负责人随之产生");
    expect(toast("suggest_task", "start_task", { title: "写周报" })).toBe("已发起任务「写周报」（规划中）");
    expect(toast("schedule_task", "confirm", { title: "每天收邮件" })).toBe("已建好定时任务「每天收邮件」，在任务看板的「运营中」");
    expect(toast("charter", "confirm_start")).toBe("已开工：发起了首个建设任务，项目进入建设中");
    expect(toast("charter", "confirm")).toBe("立项书已确认，项目留在筹备中");
    expect(toast("charter_change", "confirm")).toBe("立项书改好了，末尾记了这次变更");
    expect(toast("charter_change", "reject")).toBe("已拒绝，立项书不变");
    expect(toast("standard_change", "confirm")).toBe("规范改好了，记进了项目档案");
    expect(toast("standard_change", "reject")).toBe("已拒绝，规范不变");
    expect(toast("standard_backfill", "confirm")).toBe("改用了规范，建了任务交给负责人补");
    expect(toast("standard_backfill", "decline")).toBe("不补了，不会再问");
    expect(toast("pairing", "approve")).toBe("已批准，新设备拿到凭证");
  });

  test("别的不提示", () => {
    expect(toast("suggest_project", "dismiss", { name: "菜谱" })).toBeUndefined();
    expect(toast("pairing", "reject")).toBeUndefined();
    expect(toast("plan", "confirm")).toBeUndefined();
    // 定时任务卡点了取消：什么都没建，不提示
    expect(toast("schedule_task", "cancel", { title: "每天收邮件" })).toBeUndefined();
  });

  test("英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(toast("suggest_project", "kickoff", { name: "Recipes" })).toBe("Project “Recipes” is born (in preparation), and its owner comes with it");
    expect(toast("pairing", "approve")).toBe("Approved, the new device got its credentials");
    expect(toast("schedule_task", "confirm", { title: "Daily email check" })).toBe("Scheduled task “Daily email check” created. It is under Operating on the task board");
  });
});

describe("很早以前处理过的不提示", () => {
  const now = Date.parse("2026-11-02T10:00:00.000Z");

  test("两分钟以前处理的算早就处理过", () => {
    expect(handledLongAgo(card("pairing", {}, "2026-11-02T09:57:59.000Z"), now)).toBe(true);
    expect(handledLongAgo(card("pairing", {}, "2026-11-02T09:58:30.000Z"), now)).toBe(false);
  });

  test("没有处理时间的照弹", () => {
    expect(handledLongAgo(card("pairing"), now)).toBe(false);
  });
});
