// 系统通知的统一出口（110 号票）：到点的提醒这类"马上告诉用户"的事，浏览器里弹浏览器通知（用户允许了才弹），
// 鸿蒙 App 里（新版 App）经原生桥发到系统通知栏；同一件事只发一条；点了通知去那一项的地址。
// 浏览器的 Notification、原生桥都换成假的。
import { describe, expect, test } from "vitest";
import { detectNativeApp } from "../../src/app/native-app.ts";
import type { NativeNotifyShown } from "../../src/app/native-notify.ts";
import { alertNotice, type BrowserNotifications, clipNotice, createSystemNotifier, NOTICE_BODY_MAX, NOTICE_TITLE_MAX, type SystemNotice, type SystemNotifyEnv } from "../../src/app/system-notify.ts";
import type { NotifyRecord } from "../../src/state/index.ts";

const noop = () => {};

/** 名字占位换成名字（假的：页面上是 useNamedPlain） */
const plain = (text: string) => text.replace("{{assistant}}", "二狗");

/** 假的浏览器通知：记下弹了什么；permission 是用户给没给（granted / denied / default） */
function fakeBrowser(initial = "granted", opts: { throws?: boolean } = {}) {
  let permission = initial;
  const shown: { title: string; body: string; tag: string; click(): void; closed: boolean }[] = [];
  const browser: BrowserNotifications = {
    permission: () => permission,
    show(title, options) {
      if (opts.throws) throw new TypeError("Illegal constructor: use ServiceWorkerRegistration.showNotification()");
      let onClick = noop;
      const n = { title, body: options.body, tag: options.tag, click: () => onClick(), closed: false };
      shown.push(n);
      return {
        onClick: (fn) => {
          onClick = fn;
        },
        close: () => {
          n.closed = true;
        },
      };
    },
  };
  return {
    browser,
    shown,
    allow() {
      permission = "granted";
    },
  };
}

/** 假的 App 通知：记下交给 App 的 */
function fakeApp() {
  const shown: SystemNotice[] = [];
  return { shown, show: (notice: SystemNotice) => void shown.push(notice) };
}

/** 页面那一侧：去过哪些地址、拉到前面几次 */
function page(env: Partial<SystemNotifyEnv>) {
  const went: string[] = [];
  let focused = 0;
  const notifier = createSystemNotifier({
    focus: () => {
      focused += 1;
    },
    go: (route) => void went.push(route),
    ...env,
  });
  return { notifier, went, focused: () => focused };
}

const reminder: SystemNotice = { id: "n-1", title: "到点了：给妈妈打电话", body: "今天 19:00", route: "#/inbox/i-1" };

describe("浏览器里", () => {
  test("用户允许了浏览器通知：弹一条，tag 用通知的 id（同一件事几个窗口里只出一条）", () => {
    const b = fakeBrowser("granted");
    page({ browser: b.browser }).notifier.show(reminder);
    expect(b.shown).toMatchObject([{ title: "到点了：给妈妈打电话", body: "今天 19:00", tag: "n-1" }]);
  });

  test("用户还没允许、拒了：不弹；之后允许了，还挂着的那一条照样能弹", () => {
    const b = fakeBrowser("default");
    const { notifier } = page({ browser: b.browser });
    notifier.show(reminder);
    expect(b.shown).toEqual([]);
    b.allow();
    notifier.show(reminder);
    expect(b.shown).toHaveLength(1);
  });

  test("浏览器不支持通知：什么都不做，不抛错", () => {
    expect(() => page({}).notifier.show(reminder)).not.toThrow();
  });

  test("有的浏览器（比如手机上）只许在 Service Worker 里发、直接抛错：不抛错，同一条不再试", () => {
    const b = fakeBrowser("granted", { throws: true });
    const { notifier } = page({ browser: b.browser });
    expect(() => notifier.show(reminder)).not.toThrow();
    expect(() => notifier.show(reminder)).not.toThrow();
    expect(b.shown).toEqual([]);
  });

  test("同一件事只发一条：同一个 id 再来（页面重渲染）不再弹；别的 id 各一条", () => {
    const b = fakeBrowser("granted");
    const { notifier } = page({ browser: b.browser });
    notifier.show(reminder);
    notifier.show(reminder);
    notifier.show({ ...reminder, id: "n-2", title: "到点了：交电费" });
    expect(b.shown.map((n) => n.tag)).toEqual(["n-1", "n-2"]);
  });

  test("点了浏览器通知：窗口拉到前面、去那一项的地址、这条通知关掉，订阅的知道点了哪一条", () => {
    const b = fakeBrowser("granted");
    const p = page({ browser: b.browser });
    const opened: string[] = [];
    p.notifier.onOpen((id) => opened.push(id));
    p.notifier.show(reminder);
    b.shown[0]!.click();
    expect(p.focused()).toBe(1);
    expect(p.went).toEqual(["#/inbox/i-1"]);
    expect(b.shown[0]!.closed).toBe(true);
    expect(opened).toEqual(["n-1"]);
  });
});

describe("在鸿蒙 App 里", () => {
  test("新版 App 能发通知：交给 App（系统通知栏），不弹浏览器通知（哪怕浏览器那边允许了）", () => {
    const app = fakeApp();
    const b = fakeBrowser("granted");
    page({ app, browser: b.browser }).notifier.show(reminder);
    expect(app.shown).toEqual([reminder]);
    expect(b.shown).toEqual([]);
  });

  test("同一件事只发一条：同一个 id 只交给 App 一次", () => {
    const app = fakeApp();
    const { notifier } = page({ app });
    notifier.show(reminder);
    notifier.show(reminder);
    notifier.show({ ...reminder, id: "n-2" });
    expect(app.shown.map((n) => n.id)).toEqual(["n-1", "n-2"]);
  });

  test("旧版 App 没有通知这一组方法：照旧走浏览器通知", () => {
    const old = detectNativeApp({ ergoNative: { appVersion: () => "0.1.0", log() {} } });
    expect(old).toBeDefined();
    const b = fakeBrowser("granted");
    page({ app: old?.notify, browser: b.browser }).notifier.show(reminder);
    expect(b.shown.map((n) => n.tag)).toEqual(["n-1"]);
  });

  test("用户点了通知栏里的那一条（App 交回来）：去那一项的地址，订阅的知道；退订之后不再收到", () => {
    const p = page({ app: fakeApp() });
    const opened: string[] = [];
    const off = p.notifier.onOpen((id) => opened.push(id));
    p.notifier.open("n-1", "#/inbox/i-1");
    off();
    p.notifier.open("n-2", "#/secretary/at/m-9");
    expect(p.went).toEqual(["#/inbox/i-1", "#/secretary/at/m-9"]);
    expect(opened).toEqual(["n-1"]);
    // App 里点通知不用拉窗口：App 自己到了前台
    expect(p.focused()).toBe(0);
  });
});

describe("发出去的字", () => {
  test("标题、正文太长截短，末尾省略号；首尾空白去掉", () => {
    const long = clipNotice({ id: "n-1", title: `  ${"长".repeat(NOTICE_TITLE_MAX + 10)}  `, body: "字".repeat(NOTICE_BODY_MAX + 1), route: "#/inbox" });
    expect(long.title).toHaveLength(NOTICE_TITLE_MAX);
    expect(long.title.endsWith("…")).toBe(true);
    expect(long.title.startsWith("长")).toBe(true);
    expect(long.body).toHaveLength(NOTICE_BODY_MAX);
    expect(long.body.endsWith("…")).toBe(true);
    expect(clipNotice({ ...reminder, title: " 到点了 " })).toEqual({ ...reminder, title: "到点了" });
  });

  test("交给 App、浏览器的是截短过的", () => {
    const app = fakeApp();
    page({ app }).notifier.show({ ...reminder, body: "字".repeat(NOTICE_BODY_MAX * 2) });
    expect(app.shown[0]!.body).toHaveLength(NOTICE_BODY_MAX);
  });

  test("到点的提醒：点了去待办里那一项；没有对应事项的去待办列表；名字占位换成名字", () => {
    expect(alertNotice({ id: "n-1", title: "{{assistant}}提醒你：给妈妈打电话", body: "今天 19:00", itemId: "i-1" }, plain)).toEqual({
      id: "n-1",
      title: "二狗提醒你：给妈妈打电话",
      body: "今天 19:00",
      route: "#/inbox/i-1",
    });
    expect(alertNotice({ id: "n-2", title: "备份失败" }, plain)).toEqual({ id: "n-2", title: "备份失败", body: "", route: "#/inbox" });
  });

  test("秘书新消息（109 号票）：同一个出口，点了去秘书会话里那一条", () => {
    const alert = { id: "secretary:m-1", title: "{{assistant}}：今天的 AI 日报念好了", body: "语音 1 分 06 秒", secretary: { at: "m-1", through: 7 } };
    expect(alertNotice(alert, plain)).toEqual({ id: "secretary:m-1", title: "二狗：今天的 AI 日报念好了", body: "语音 1 分 06 秒", route: "#/secretary/at/m-1" });
  });
});

/** 通知记录（124 号票）：记下的每一条，走哪条路、结果（时间、标题照样记，只看第一条） */
function recorded(env: Partial<SystemNotifyEnv>) {
  const records: NotifyRecord[] = [];
  const p = page({ ...env, record: (r) => void records.push(r), now: () => "2026-10-14T21:00:00.000+08:00" });
  return { ...p, records, brief: () => records.map((r) => `${r.id} ${r.via ?? "-"} ${r.outcome}${r.forced ? " 强制" : ""}${r.detail ? ` ${r.detail}` : ""}`) };
}

/** 等 App 回的结果 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("通知记录（124 号票：Debug 工具集）", () => {
  test("浏览器：已发、没授权、重复跳过、出错、浏览器不支持各记一条", () => {
    const ok = recorded({ browser: fakeBrowser("granted").browser });
    ok.notifier.show(reminder);
    ok.notifier.show(reminder);
    expect(ok.brief()).toEqual(["n-1 browser sent", "n-1 browser duplicate"]);
    expect(ok.records[0]).toMatchObject({ at: "2026-10-14T21:00:00.000+08:00", title: "到点了：给妈妈打电话" });

    const denied = recorded({ browser: fakeBrowser("default").browser });
    denied.notifier.show(reminder);
    expect(denied.brief()).toEqual(["n-1 browser denied 浏览器通知没允许（default）"]);

    const broken = recorded({ browser: fakeBrowser("granted", { throws: true }).browser });
    broken.notifier.show(reminder);
    expect(broken.brief()[0]).toMatch(/^n-1 browser error Illegal constructor/);

    const none = recorded({});
    none.notifier.show(reminder);
    expect(none.brief()).toEqual(["n-1 - unsupported 这个浏览器不支持通知"]);
  });

  test("App：照 App 回的结果记（已发、前台不发、没授权、出错）；旧版 App 不回结果的记 App 没回结果", async () => {
    const replies: (NativeNotifyShown | undefined)[] = [{ outcome: "sent", detail: "通知编号 42" }, { outcome: "foreground" }, { outcome: "denied", detail: "1600004" }, { outcome: "error", detail: "boom" }, undefined];
    const p = recorded({ app: { show: () => Promise.resolve(replies.shift()) } });
    for (const id of ["n-1", "n-2", "n-3", "n-4", "n-5"]) p.notifier.show({ ...reminder, id });
    await settle();
    expect(p.brief()).toEqual(["n-1 app sent 通知编号 42", "n-2 app foreground", "n-3 app denied 1600004", "n-4 app error boom", "n-5 app no_reply"]);
    // 旧版 App 的 notifyShow 什么都不回（不是 Promise）
    const old = recorded({ app: { show: () => undefined } });
    old.notifier.show(reminder);
    old.notifier.show(reminder);
    await settle();
    expect(old.brief()).toEqual(["n-1 app no_reply", "n-1 app duplicate"]);
  });

  test("前台也强制发（Debug 工具集）：交给 App 时带上，记录里注明", async () => {
    const forced: boolean[] = [];
    const app = {
      show: (_notice: SystemNotice, options?: { force?: boolean }) => {
        forced.push(options?.force === true);
        return Promise.resolve<NativeNotifyShown>({ outcome: "sent" });
      },
    };
    const p = recorded({ app });
    p.notifier.show(reminder, { force: true });
    p.notifier.show({ ...reminder, id: "n-2" });
    await settle();
    expect(forced).toEqual([true, false]);
    expect(p.brief()).toEqual(["n-1 app sent 强制", "n-2 app sent"]);
  });
});
