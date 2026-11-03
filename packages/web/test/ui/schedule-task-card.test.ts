// 定时任务卡（ui/cards/ScheduleTaskCard.tsx）：助理提议的定时触发的普通任务。用 React 在 Node 里渲染出来查：
// - 还没确认的：多久一次（规则文字）、第一次和之后两次、每次到点启动一个 agent 照任务书干活、任务书全文（纯文本）、用的模型；
//   有确认、取消两个按钮；界面上不出现字面的"秘书"；
// - 每次大概花多少：估得出的写 token（有单价的再写钱数）和按几次算的；估不出的照实说，不写数字；
// - 别的运行时写它的名字、模型按它自己的设置；
// - 确认了：不再列接下来几次，给去任务的链接；英文也齐。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { activeLocaleFrom, type Card, type CardState, DEFAULT_LANGUAGE, type ScheduleTaskCardPayload, setActiveLocale } from "../../src/state/index.ts";
import { ScheduleTaskCard } from "../../src/ui/cards/ScheduleTaskCard.tsx";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;

afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

/** 本地时间 2026 年 10 月 d 日 hh:mm 的协议时间（2026-10-08 是周四） */
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm).toISOString();

const MAIL: ScheduleTaskCardPayload = {
  title: "每天收邮件",
  instructions: "收一遍新邮件：\n1. 挑出要回的；\n2. <b>广告</b>不用管。",
  schedule: { kind: "daily", time: "08:10" },
  upcoming: [at(8, 8, 10), at(9, 8, 10), at(10, 8, 10)],
  model: "deepseek-flash",
};

function state(p: ScheduleTaskCardPayload, status: Card["status"], outcome?: Card["outcome"]): CardState {
  return { card: { id: "c-1", type: "schedule_task", typeVersion: 1, version: status === "pending" ? 1 : 2, status, payload: p, text: "定时任务", createdAt: "2026-10-08T08:00:00+08:00", ...(outcome ? { outcome } : {}) } } as CardState;
}

const render = (p: ScheduleTaskCardPayload, status: Card["status"] = "pending", outcome?: Card["outcome"]) =>
  renderToStaticMarkup(createElement(StoreProvider, offline, createElement(ScheduleTaskCard, { state: state(p, status, outcome), payload: p, done: status !== "pending", act: () => {} })));

describe("定时任务卡", () => {
  test("还没确认：多久一次、第一次和之后两次、每次启动一个 agent 照任务书干活、任务书全文、用的模型；确认和取消两个按钮", () => {
    const html = render(MAIL);
    expect(html).toContain("每天收邮件");
    expect(html).toContain("<dt>多久一次</dt><dd>每天 08:10</dd>");
    expect(html).toContain("<dt>第一次</dt><dd>10 月 8 日（周四）08:10</dd>");
    expect(html).toContain("<dt>之后</dt><dd>10 月 9 日（周五）08:10、10 月 10 日（周六）08:10</dd>");
    expect(html).toContain("每次到点会启动一个 agent，照这份任务书干活：");
    // 任务书当纯文本（换行靠样式留着，不渲染里面的标签）
    expect(html).toContain('<div class="schedule-task-brief">收一遍新邮件：\n1. 挑出要回的；\n2. &lt;b&gt;广告&lt;/b&gt;不用管。</div>');
    expect(html).toContain("用的模型：deepseek-flash");
    expect(html).toContain("还没有同类的运行记录，估不出每次花多少");
    expect(html).toContain("点「确认」才建，建好后在任务看板的「运营中」；点「取消」什么都不建。");
    expect(html).toContain(">取消</button>");
    expect(html).toContain(">确认，建定时任务</button>");
    expect(html).not.toContain("秘书");
  });

  test("每次大概花多少：有单价的写 token 和钱数，没有的只写 token；都写按几次同类运行算", () => {
    expect(render({ ...MAIL, estimate: { runs: 6, tokens: 31_800, cost: { amount: 0.046, currency: "CNY" } } })).toContain("每次大约 3.2 万 token，约 ¥0.05（按最近 6 次同类运行算）");
    const tokensOnly = render({ ...MAIL, estimate: { runs: 1, tokens: 800 } });
    expect(tokensOnly).toContain("每次大约 800 token（按最近 1 次同类运行算）");
    expect(tokensOnly).not.toContain("¥");
  });

  test("别的运行时：写它的名字，模型按它自己的设置（不写二狗的模型）；每 N 天写从哪天起", () => {
    const { model: _model, ...piless } = MAIL;
    const html = render({ ...piless, runtime: "claude-code", schedule: { kind: "everyNDays", time: "20:00", interval: 3, anchor: "2026-10-12" } });
    expect(html).toContain("用 claude-code 跑，模型按 claude-code 自己的设置");
    expect(html).not.toContain("用的模型");
    expect(html).toContain("<dd>每 3 天 20:00，从 10 月 12 日起</dd>");
  });

  test("确认了：不再列接下来几次，给去任务的链接；取消了的什么都不链", () => {
    const done = render({ ...MAIL, taskId: "t-3" }, "handled", { action: "confirm" });
    expect(done).toContain("<dd>每天 08:10</dd>");
    expect(done).not.toContain("第一次");
    expect(done).not.toContain("点「确认」才建");
    expect(done).toContain("去看定时任务 t-3 ▸");
    expect(done).toContain("已确认");
    const cancelled = render(MAIL, "dismissed", { action: "cancel" });
    expect(cancelled).toContain("已取消");
    expect(cancelled).not.toContain("去看定时任务");
  });

  test("英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = render({ ...MAIL, title: "Daily email check", instructions: "Check new mail and pick out the ones to answer.", estimate: { runs: 2, tokens: 31_800, cost: { amount: 0.05, currency: "USD" } } });
    expect(html).toContain("<dt>How often</dt>");
    expect(html).toContain("<dt>First run</dt>");
    expect(html).toContain("Each time it&#x27;s due, an agent starts and works from this brief:");
    expect(html).toContain("Model: deepseek-flash");
    expect(html).toContain("About 32K tokens, roughly $0.05, per run (based on the last 2 similar runs)");
    expect(html).toContain(">Confirm and schedule</button>");
    expect(html).not.toMatch(/[一-鿿]/u);
  });
});
