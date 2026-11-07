// 待办里"体检发现"（416，notice doctor_problem）：种类名、两个动作——"去体检页看看"是去设置 · 体检的链接（不算处理），
// "不再提醒这件事"是按钮（点了交给守护进程记住）；修好了守护进程替你记成"已经好了"，显示成处理过的样子；中英都有。
// 原型的待办里有一条：备份有问题（截图用），英文照表换过一个中文字都没有。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { fakeText, hasChinese } from "../../src/prototype/fake-content.ts";
import { FAKE_INBOX } from "../../src/prototype/fake-data.ts";
import { activeLocale, activeLocaleFrom, DOCTOR_CORE_GROUP, DOCTOR_MUTE_ACTION, DOCTOR_OPEN_ACTION, DOCTOR_WATCH_FIXED, type NoticeInboxItem, setActiveLocale } from "../../src/state/index.ts";
import { NoticeActions, noticeLabel } from "../../src/ui/inbox-notice.tsx";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const before = activeLocale();
afterEach(() => setActiveLocale(before));

const item = (extra: Partial<NoticeInboxItem> = {}): NoticeInboxItem => ({
  id: "i-doctor-1",
  kind: "notice",
  notice: "doctor_problem",
  version: 1,
  title: "备份有问题",
  body: "最近一次没备份成",
  source: "体检",
  urgency: "non_blocking",
  pinned: false,
  createdAt: "2026-11-07T07:30:00.000Z",
  read: false,
  archived: false,
  deleted: false,
  actions: [DOCTOR_OPEN_ACTION, DOCTOR_MUTE_ACTION],
  data: { group: DOCTOR_CORE_GROUP, id: "backup", level: "warn", title: { key: "doctor.check.backup.title" } },
  ...extra,
});

const render = (notice: NoticeInboxItem) =>
  renderToStaticMarkup(createElement(StoreProvider, { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>, createElement(NoticeActions, { item: notice })));

describe("待办里的\"体检发现\"", () => {
  test("种类名是\"体检发现\"；\"去体检页看看\"是去设置 · 体检的链接，\"不再提醒这件事\"是按钮", () => {
    expect(noticeLabel("doctor_problem")).toBe("体检发现");
    const html = render(item());
    expect(html).toMatch(/<a [^>]*href="#\/more\/doctor"[^>]*>去体检页看看<\/a>/);
    expect(html).toMatch(/<button [^>]*>不再提醒这件事<\/button>/);
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("修好了（守护进程记成\"已经好了\"）、点了不再提醒：显示成处理过的样子，不再有按钮", () => {
    expect(render(item({ handled: DOCTOR_WATCH_FIXED }))).toContain("✓ 已经好了");
    expect(render(item({ handled: DOCTOR_MUTE_ACTION }))).toContain("✓ 不再提醒这件事");
    expect(render(item({ handled: DOCTOR_WATCH_FIXED }))).not.toContain("<button");
  });

  test("英文：种类名、两个动作、修好了都是英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(noticeLabel("doctor_problem")).toBe("Checkup found");
    const html = render(item());
    expect(html).toContain("Open the checkup");
    expect(html).toContain("Don&#x27;t remind me about this");
    expect(render(item({ handled: DOCTOR_WATCH_FIXED }))).toContain("Fixed now");
  });

  test("原型的待办里有一条\"备份有问题\"（备份自己的那条通知归档了）；英文照表换过没有中文", () => {
    const doctor = FAKE_INBOX.find((each) => each.kind === "notice" && each.notice === "doctor_problem") as NoticeInboxItem;
    expect(doctor).toMatchObject({ title: "备份有问题", source: "体检", actions: [DOCTOR_OPEN_ACTION, DOCTOR_MUTE_ACTION], data: { group: DOCTOR_CORE_GROUP, id: "backup", level: "warn" } });
    expect(doctor.body).toContain("从 10/7 03:31 起");
    expect(doctor.body).toContain("怎么修：");
    expect(FAKE_INBOX.find((each) => each.id === "i-backup")).toMatchObject({ archived: true });
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    for (const text of [doctor.title, doctor.body!, doctor.source]) expect(hasChinese(fakeText(text))).toBe(false);
  });
});
