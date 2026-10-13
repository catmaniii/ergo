// 系统通知的统一出口（110 号票）：到点的提醒这类"马上告诉用户"的事，浏览器里弹浏览器通知（用户允许了才弹），
// 鸿蒙 App 里（新版 App）经原生桥发到系统通知栏；同一件事只发一条；点了通知去那一项的地址。
// 浏览器的 Notification、原生桥都换成假的。
import { describe, expect, test } from "vitest";
import { detectNativeApp } from "../../src/app/native-app.ts";
import { alertNotice, type BrowserNotifications, clipNotice, createSystemNotifier, NOTICE_BODY_MAX, NOTICE_TITLE_MAX, type SystemNotice, type SystemNotifyEnv } from "../../src/app/system-notify.ts";

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
    const old = detectNativeApp({ ergouNative: { appVersion: () => "0.1.0", log() {} } });
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
});
