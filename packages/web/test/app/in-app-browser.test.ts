// 内置浏览器（132 号票，app/in-app-browser.ts）：打开（地址写进 hash 路由，外部网站照旧新窗口）、关掉（×、Esc——框里有焦点时也认——直接关，
// 鸿蒙的返回手势和 ‹ 一致：框里能后退先退一页、退不了才关；都回到盖住之前的那一页；框里点过链接时有 Navigation API 直接回到打开之前那一条记录）、
// 顶栏的后退 / 刷新 / 新窗口打开、
// 标题和地址跟着框里的页面走。页面的 window、框、返回栈换成假的（浏览器的历史：一串记录加当前位置，框里的导航也压记录）。
import { describe, expect, test } from "vitest";
import { createBackRegistry } from "../../src/app/back-registry.ts";
import { appRouteOf, type BrowserPage, type FrameHandle, type FrameWindowLike, InAppBrowserSession, type InAppBrowserView, type KeyLike, openInAppBrowserIn } from "../../src/app/in-app-browser.ts";
import type { LinkClick } from "../../src/app/browser-shell.ts";
import { parseHash, type Route, toHash } from "../../src/app/route-hash.ts";

const ORIGIN = "https://ergo.example.sslip.io";

/** 按键监听的假目标 */
function keyTarget() {
  const listeners = new Set<(e: KeyLike) => void>();
  return {
    addEventListener: (_type: "keydown", l: (e: KeyLike) => void) => void listeners.add(l),
    removeEventListener: (_type: "keydown", l: (e: KeyLike) => void) => void listeners.delete(l),
    /** 按一个键，返回有没有人 preventDefault */
    press(key: string): boolean {
      let prevented = false;
      for (const l of listeners) l({ key, preventDefault: () => void (prevented = true) });
      return prevented;
    },
    get count() {
      return listeners.size;
    },
  };
}

/**
 * 假的页面：location.hash 赋值压一条记录（截掉前进的）、replace 换掉当前这条、history.back 退一条；
 * 框里的导航（frameNavigate）也压一条"框的记录"（顶层的地址不变），这时 history.back 先退框里的。withNavigation 给 Navigation API
 */
function fakePage(start: string, options: { withNavigation?: boolean } = {}) {
  type Entry = { hash: string; state: unknown; frame: boolean };
  const entries: Entry[] = [{ hash: start, state: null, frame: false }];
  let at = 0;
  const opened: string[] = [];
  const keys = keyTarget();
  const topEntries = () => entries.map((e, i) => ({ e, i })).filter(({ e }) => !e.frame);
  const page: BrowserPage & { press(key: string): boolean } = {
    location: {
      origin: ORIGIN,
      get hash() {
        return entries[at]!.hash;
      },
      set hash(to: string) {
        if (to === entries[at]!.hash) return;
        entries.splice(at + 1, entries.length, { hash: to, state: null, frame: false });
        at++;
      },
      replace(to: string) {
        entries[at] = { ...entries[at]!, hash: to, state: null };
      },
    },
    history: {
      get state() {
        return entries[at]!.state;
      },
      back() {
        if (at > 0) at--;
      },
      replaceState(data: unknown, _unused: string, url?: string) {
        entries[at] = { ...entries[at]!, state: data, ...(url === undefined ? {} : { hash: url }) };
      },
    },
    ...(options.withNavigation
      ? {
          navigation: {
            get currentEntry() {
              const tops = topEntries();
              const index = tops.findLastIndex(({ i }) => i <= at);
              return { key: `k${tops[index]!.i}`, index };
            },
            entries: () => topEntries().map(({ e, i }) => ({ key: `k${i}`, url: `${ORIGIN}/${e.hash}` })),
            traverseTo(key: string) {
              at = Number(key.slice(1));
              return { committed: Promise.resolve(), finished: Promise.resolve() };
            },
          },
        }
      : {}),
    open: (url: string) => void opened.push(url),
    addEventListener: keys.addEventListener,
    removeEventListener: keys.removeEventListener,
    press: (key) => keys.press(key),
  };
  return {
    page,
    opened,
    keys,
    here: () => entries[at]!.hash,
    /** 框里走到另一页：压一条框的记录（顶层的 hash 照旧） */
    frameNavigate: () => {
      entries.splice(at + 1, entries.length, { hash: entries[at]!.hash, state: entries[at]!.state, frame: true });
      at++;
    },
  };
}

/** 假的框：地址、标题、响应类型读得到（cross 为真时像跨源一样读了抛错），后退、刷新记下来；框里那一页的点击监听（160 号票）也记着 */
function fakeFrame(src: string) {
  const keys = keyTarget();
  const clicks = new Set<(e: LinkClick) => void>();
  const calls: string[] = [];
  let url = new URL(src, ORIGIN);
  let title = "";
  let contentType = "text/html";
  let cross = false;
  let canGoBack: boolean | undefined;
  const guard = <T>(v: () => T): T => {
    if (cross) throw new Error("SecurityError");
    return v();
  };
  const win: FrameWindowLike = {
    get location() {
      return guard(() => ({ pathname: url.pathname, search: url.search, hash: url.hash, href: url.href, reload: () => void calls.push("reload") }));
    },
    get document() {
      return guard(() => ({
        title,
        contentType,
        addEventListener: (_t: "click", l: (e: LinkClick) => void) => void clicks.add(l),
        removeEventListener: (_t: "click", l: (e: LinkClick) => void) => void clicks.delete(l),
      }));
    },
    get history() {
      return guard(() => ({ back: () => void calls.push("back") }));
    },
    get navigation() {
      return canGoBack === undefined ? undefined : { canGoBack };
    },
    addEventListener: (t, l) => guard(() => keys.addEventListener(t, l)),
    removeEventListener: (t, l) => keys.removeEventListener(t, l),
  };
  const handle: FrameHandle = { src, contentWindow: win };
  return {
    handle,
    keys,
    calls,
    /** 框里加载了一页（type 是响应的类型） */
    load(to: string, pageTitle = "", type = "text/html") {
      url = new URL(to, ORIGIN);
      title = pageTitle;
      contentType = type;
    },
    /** 框里那一页上点了一下（落在 target 上），返回有没有人 preventDefault */
    click(target: unknown, modifiers: Partial<Pick<LinkClick, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "defaultPrevented">> = {}): boolean {
      let prevented = modifiers.defaultPrevented ?? false;
      const e: LinkClick = {
        get defaultPrevented() {
          return prevented;
        },
        button: modifiers.button ?? 0,
        ctrlKey: modifiers.ctrlKey ?? false,
        metaKey: modifiers.metaKey ?? false,
        shiftKey: modifiers.shiftKey ?? false,
        altKey: modifiers.altKey ?? false,
        target,
        preventDefault: () => void (prevented = true),
      };
      for (const l of clicks) l(e);
      return prevented && !modifiers.defaultPrevented;
    },
    get clickListeners() {
      return clicks.size;
    },
    setTitle: (t: string) => void (title = t),
    goCross: () => void (cross = true),
    setCanGoBack: (v: boolean) => void (canGoBack = v),
  };
}

type AppRoute = Extract<Route, { tab: "app" }>;

/** 打开一个内置浏览器：页面从 from 用 openInAppBrowserIn 打开 url（Shell 认到地址后建 session、挂上框） */
function open(from: string, url: string, title?: string, options: { withNavigation?: boolean } = {}) {
  const p = fakePage(from, options);
  const back = createBackRegistry();
  expect(openInAppBrowserIn(p.page, url, title)).toBe(true);
  const route = parseHash(p.here()) as AppRoute;
  expect(route.tab).toBe("app");
  const views: InAppBrowserView[] = [];
  const session = new InAppBrowserSession({ route, page: p.page, back, leaveTo: from, onChange: (v) => views.push(v) });
  const frame = fakeFrame(session.src);
  const unmount = session.mount(frame.handle);
  return { ...p, back, route, session, frame, views, unmount };
}

describe("地址", () => {
  test("内置浏览器的地址 #/apps/<应用名>/<path>：path 原样（查询串、锚点里的 / ? # 都不拆）；应用名不对的回秘书页；不属于主导航", () => {
    expect(parseHash("#/apps/intel")).toEqual({ tab: "app", app: "intel" });
    expect(parseHash("#/apps/intel/")).toEqual({ tab: "app", app: "intel" });
    expect(parseHash("#/apps/intel/reports/1?x=a%2Fb&y=2#sec/2")).toEqual({ tab: "app", app: "intel", path: "reports/1?x=a%2Fb&y=2#sec/2" });
    expect(parseHash("#/apps/Intel/x")).toEqual({ tab: "secretary" });
    expect(parseHash("#/apps/")).toEqual({ tab: "secretary" });
    for (const r of [{ tab: "app", app: "intel" }, { tab: "app", app: "p-3-intel", path: "a/b?c=1" }] as const) expect(parseHash(toHash(r))).toEqual(r);
    expect(toHash({ tab: "app", app: "intel", path: "a?b=1" })).toBe("#/apps/intel/a?b=1");
  });

  test("哪些地址归内置浏览器：同源、在 /apps/<应用名>/ 下（相对路径、完整地址都认）；外部网站、二狗自己的页面不归它", () => {
    expect(appRouteOf("/apps/intel/", ORIGIN)).toEqual({ tab: "app", app: "intel" });
    expect(appRouteOf("/apps/intel", ORIGIN)).toEqual({ tab: "app", app: "intel" });
    expect(appRouteOf(`${ORIGIN}/apps/intel/r?id=3#top`, ORIGIN)).toEqual({ tab: "app", app: "intel", path: "r?id=3#top" });
    expect(appRouteOf("https://example.com/apps/intel/", ORIGIN)).toBeUndefined();
    expect(appRouteOf("/api/media/x", ORIGIN)).toBeUndefined();
    expect(appRouteOf("/apps/Bad/", ORIGIN)).toBeUndefined();
  });
});

describe("打开", () => {
  test("转发的地址写进 hash 路由（压一条记录、记下来处），框里打开 /apps/<应用名>/<path>；标题先显示打开时给的名字", () => {
    const b = open("#/projects/p-3", "/apps/intel/reports?id=3", "简报站");
    expect(b.here()).toBe("#/apps/intel/reports?id=3");
    expect(b.session.src).toBe("/apps/intel/reports?id=3");
    expect(b.session.view()).toEqual({ title: "简报站", canGoBack: false });
  });

  test("外部网站的链接照旧新窗口打开，不动地址", () => {
    const p = fakePage("#/secretary");
    expect(openInAppBrowserIn(p.page, "https://example.com/", "外链")).toBe(false);
    expect(p.opened).toEqual(["https://example.com/"]);
    expect(p.here()).toBe("#/secretary");
  });

  test("鸿蒙 App 里（134 号票，有原生的内置浏览器）：转发的地址、外部网站都交给它，不压内置浏览器的记录、不新开窗口", () => {
    const p = fakePage("#/projects");
    const native: string[] = [];
    const nativeOpen = (url: string) => {
      native.push(url);
      return true;
    };
    expect(openInAppBrowserIn(p.page, "/apps/intel/reports?id=3", "简报站", nativeOpen)).toBe(true);
    expect(openInAppBrowserIn(p.page, "https://example.com/", "外链", nativeOpen)).toBe(true);
    expect(native).toEqual(["/apps/intel/reports?id=3", "https://example.com/"]);
    expect(p.here()).toBe("#/projects");
    expect(p.opened).toEqual([]);
  });

  test("原生浏览器打不开的（它回 false）照旧：转发的地址进嵌入框叠层", () => {
    const p = fakePage("#/projects");
    expect(openInAppBrowserIn(p.page, "/apps/intel/", undefined, () => false)).toBe(true);
    expect(p.here()).toBe("#/apps/intel");
  });
});

describe("关掉：×、Esc 直接关，返回手势框里退到头才关，都回到盖住之前的那一页", () => {
  test("×：框里没走过，后退一步回到来处（不多出记录）", () => {
    const b = open("#/projects/p-3", "/apps/intel/", "简报站");
    b.frame.load("/apps/intel/", "简报站首页");
    b.session.frameLoaded();
    b.session.close();
    expect(b.here()).toBe("#/projects/p-3");
  });

  test("Esc：页面上的、框里那一页的都认（框里有焦点时按键落在框里），框里能后退也直接关；只关一次", () => {
    const b = open("#/tasks", "/apps/intel/");
    b.frame.load("/apps/intel/");
    b.session.frameLoaded();
    b.frameNavigate();
    b.frame.load("/apps/intel/a");
    b.session.frameLoaded();
    expect(b.session.view().canGoBack).toBe(true);
    expect(b.frame.keys.count).toBe(1);
    expect(b.frame.keys.press("a")).toBe(false);
    expect(b.frame.keys.press("Escape")).toBe(true);
    expect(b.here()).toBe("#/tasks");
    // 再按一次不会再退一步
    b.page.press("Escape");
    expect(b.here()).toBe("#/tasks");

    const c = open("#/tasks", "/apps/intel/");
    expect(c.page.press("Escape")).toBe(true);
    expect(c.here()).toBe("#/tasks");
  });

  test("返回手势（鸿蒙 App 调返回栈）和 ‹ 一致：框里能后退就退一页、不关；退到头（‹ 灰了）才关；Esc、× 不管这些", () => {
    const b = open("#/inbox", "/apps/intel/");
    b.frame.load("/apps/intel/");
    b.session.frameLoaded();
    b.frameNavigate();
    b.frame.setCanGoBack(true);
    b.frame.load("/apps/intel/a");
    b.session.frameLoaded();
    expect(b.session.view().canGoBack).toBe(true);
    expect(b.back.back()).toBe(true);
    expect(b.frame.calls).toEqual(["back"]);
    expect(b.here()).toBe("#/apps/intel/a");
    // 框里退回了第一页：‹ 灰了，再按返回手势就关掉
    b.frame.setCanGoBack(false);
    b.frame.load("/apps/intel/");
    b.session.frameLoaded();
    expect(b.session.view().canGoBack).toBe(false);
    expect(b.back.back()).toBe(true);
    expect(b.frame.calls).toEqual(["back"]);
    expect(b.here()).toBe("#/inbox");

    // × 在框里能后退时也直接关
    const c = open("#/inbox", "/apps/intel/");
    c.frame.setCanGoBack(true);
    c.frame.load("/apps/intel/a");
    c.session.frameLoaded();
    c.session.close();
    expect(c.frame.calls).toEqual([]);
    expect(c.here()).toBe("#/inbox");
  });

  test("返回手势：内置浏览器是最上面的 overlay，先轮到它（框里没走过就关掉）；拿下以后返回栈里没有它", () => {
    const b = open("#/inbox", "/apps/intel/");
    const page = b.back.open("page", () => {
      throw new Error("不该退到页面的上一级");
    });
    // 内置浏览器之后又开的弹窗先退（这里没有），然后是内置浏览器
    expect(b.back.back()).toBe(true);
    expect(b.here()).toBe("#/inbox");
    b.unmount();
    expect(b.back.overlayOpen()).toBe(false);
    expect(b.page.press("Escape")).toBe(false);
    page();
  });

  test("框里点过链接：有 Navigation API 时直接回到打开之前那一条记录（跳过框里的记录）", () => {
    const b = open("#/projects/p-3", "/apps/intel/", undefined, { withNavigation: true });
    b.frame.load("/apps/intel/");
    b.session.frameLoaded();
    b.frameNavigate();
    b.frame.load("/apps/intel/a");
    b.session.frameLoaded();
    b.frameNavigate();
    b.frame.load("/apps/intel/b");
    b.session.frameLoaded();
    b.session.close();
    expect(b.here()).toBe("#/projects/p-3");
  });

  test("框里点过链接、没有 Navigation API：后退只会退框里的一步，所以把这一条换成原来那一页", () => {
    const b = open("#/projects/p-3", "/apps/intel/");
    b.frame.load("/apps/intel/");
    b.session.frameLoaded();
    b.frameNavigate();
    b.frame.load("/apps/intel/a");
    b.session.frameLoaded();
    b.session.close();
    expect(b.here()).toBe("#/projects/p-3");
  });

  test("直接打开的（刷新、别的设备发来的链接，没有来处）：把这一条换成秘书页", () => {
    const p = fakePage("#/apps/intel/r");
    const back = createBackRegistry();
    const session = new InAppBrowserSession({ route: parseHash(p.here()) as AppRoute, page: p.page, back, leaveTo: "#/secretary", onChange: () => {} });
    session.mount(fakeFrame(session.src).handle);
    expect(session.src).toBe("/apps/intel/r");
    session.close();
    expect(p.here()).toBe("#/secretary");
  });
});

describe("顶栏和框里的页面", () => {
  test("标题取框里页面的 <title>，取不到用打开时给的名字，再没有用应用名；单页应用改标题也跟着变", () => {
    const b = open("#/secretary", "/apps/intel/", "简报站");
    b.frame.load("/apps/intel/", "  今日情报  ");
    b.session.frameLoaded();
    expect(b.session.view().title).toBe("今日情报");
    b.frame.setTitle("第二页");
    b.session.titleChanged();
    expect(b.views.map((v) => v.title)).toEqual(["今日情报", "第二页"]);
    b.frame.load("/apps/intel/raw", "");
    b.session.frameLoaded();
    expect(b.session.view().title).toBe("简报站");

    const c = open("#/secretary", "/apps/radar/");
    c.frame.load("/apps/radar/", "");
    c.session.frameLoaded();
    expect(c.session.view().title).toBe("radar");
  });

  test("框里每加载一页，地址换进 hash（不压新记录、来处记号留着），刷新、发给别的设备还是这一页；跳出前缀的不换", () => {
    const b = open("#/projects/p-3", "/apps/intel/");
    b.frame.load("/apps/intel/reports/7?tab=2#c3");
    b.session.frameLoaded();
    expect(b.here()).toBe("#/apps/intel/reports/7?tab=2#c3");
    b.frame.load("/somewhere-else");
    b.session.frameLoaded();
    expect(b.here()).toBe("#/apps/intel/reports/7?tab=2#c3");
    // 来处记号还在：框里没走过时 × 照样后退一步（这里走过了，换成原来那一页）
    b.session.close();
    expect(b.here()).toBe("#/projects/p-3");
  });

  test("后退：框里没走过时灰着；框有 Navigation API 按它，没有按加载过几页；点了退框里的一页", () => {
    const b = open("#/secretary", "/apps/intel/");
    b.frame.load("/apps/intel/");
    b.session.frameLoaded();
    expect(b.session.view().canGoBack).toBe(false);
    b.session.goBack();
    expect(b.frame.calls).toEqual([]);
    b.frame.load("/apps/intel/a");
    b.session.frameLoaded();
    expect(b.session.view().canGoBack).toBe(true);
    b.session.goBack();
    expect(b.frame.calls).toEqual(["back"]);
    b.frame.setCanGoBack(false);
    b.frame.load("/apps/intel/");
    b.session.frameLoaded();
    expect(b.session.view().canGoBack).toBe(false);
  });

  test("刷新、在新窗口打开：框里现在这一页；框里跳到了别的网站（跨源，读不到）时回到最后一次在二狗这边的那一页", () => {
    const b = open("#/secretary", "/apps/relay/");
    b.frame.load("/apps/relay/a?x=1");
    b.session.frameLoaded();
    b.session.reload();
    expect(b.frame.calls).toEqual(["reload"]);
    b.session.openOutside();
    expect(b.opened).toEqual([`${ORIGIN}/apps/relay/a?x=1`]);

    b.frame.goCross();
    b.session.frameLoaded();
    expect(b.session.view().title).toBe("relay");
    b.session.reload();
    expect(b.frame.handle.src).toBe(`${ORIGIN}/apps/relay/a?x=1`);
    b.session.openOutside();
    expect(b.opened.at(-1)).toBe(`${ORIGIN}/apps/relay/a?x=1`);
    b.session.goBack();
    expect(b.frame.handle.src).toBe(`${ORIGIN}/apps/relay/a?x=1`);
  });

  test("开着的时候地址又换成这个应用的另一页（又点了一个入口）：框里不在那一页就换过去，已经在就不动", () => {
    const b = open("#/secretary", "/apps/intel/");
    b.frame.load("/apps/intel/");
    b.session.frameLoaded();
    b.session.show({ tab: "app", app: "intel" });
    expect(b.frame.handle.src).toBe("/apps/intel/");
    b.session.show({ tab: "app", app: "intel", path: "reports" });
    expect(b.frame.handle.src).toBe("/apps/intel/reports");
  });
});

// ───────────────────────── 160 号票：能渲染的文件用二狗的渲染打开 ─────────────────────────

/** 框里页面上的一个链接（点到的元素往上找到它）：href 是浏览器给的完整地址 */
function linkTo(href: string, attrs: string[] = []) {
  const link = { href, hasAttribute: (name: string) => attrs.includes(name) };
  return { closest: (selector: string) => (selector === "a[href]" ? link : null) };
}

/** 打开内置浏览器、框里加载好第一页 */
function openLoaded(from: string, url: string) {
  const b = open(from, url);
  b.frame.load(url, "笔记");
  b.session.frameLoaded();
  return b;
}

describe("能渲染的文件（160 号票）", () => {
  test("框里点同一个服务里能渲染的文件链接：拦下来（框不跳过去、不下载），盖一层渲染；地址换成文件的（刷新还在）；标题是文件名，‹ 亮着", () => {
    const b = openLoaded("#/projects", "/apps/notes/");
    expect(b.frame.clickListeners).toBe(1);
    expect(b.frame.click(linkTo(`${ORIGIN}/apps/notes/docs/%E6%97%A5%E6%8A%A5.md`))).toBe(true);
    expect(b.session.view()).toEqual({ title: "日报.md", canGoBack: true, file: { url: `${ORIGIN}/apps/notes/docs/%E6%97%A5%E6%8A%A5.md`, name: "日报.md", inFrame: false, seq: 1 } });
    expect(b.here()).toBe("#/apps/notes/docs/%E6%97%A5%E6%8A%A5.md");
    expect(b.frame.handle.src).toBe("/apps/notes/");
    // 只换了这一条的地址，没压记录：关掉照样回到来处
    b.session.close();
    expect(b.here()).toBe("#/projects");
  });

  test("不拦的：网页、外部网站、二狗自己的别的页面、带 download 的、按着修饰键或不是左键的、页面自己处理过的", () => {
    const b = openLoaded("#/projects", "/apps/notes/");
    expect(b.frame.click(linkTo(`${ORIGIN}/apps/notes/index.html`))).toBe(false);
    expect(b.frame.click(linkTo(`${ORIGIN}/apps/notes/list`))).toBe(false);
    expect(b.frame.click(linkTo("https://example.com/README.md"))).toBe(false);
    expect(b.frame.click(linkTo(`${ORIGIN}/api/media/x.md`))).toBe(false);
    expect(b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`, ["download"]))).toBe(false);
    expect(b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`), { ctrlKey: true })).toBe(false);
    expect(b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`), { button: 1 })).toBe(false);
    expect(b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`), { defaultPrevented: true })).toBe(false);
    expect(b.frame.click({})).toBe(false);
    expect(b.session.view().file).toBeUndefined();
    // 别的能渲染的类型一样拦
    for (const name of ["a.txt", "a.json", "a.csv", "main.py"]) {
      const c = openLoaded("#/projects", "/apps/notes/");
      expect(c.frame.click(linkTo(`${ORIGIN}/apps/notes/${name}`))).toBe(true);
    }
  });

  test("‹、返回手势收起渲染层，回到框里那一页（地址换回来）；Esc、× 照旧直接关掉内置浏览器", () => {
    const b = openLoaded("#/tasks", "/apps/notes/list?page=2");
    b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`));
    b.session.goBack();
    expect(b.session.view()).toEqual({ title: "笔记", canGoBack: false });
    expect(b.here()).toBe("#/apps/notes/list?page=2");
    b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`));
    expect(b.back.back()).toBe(true);
    expect(b.session.view().file).toBeUndefined();
    expect(b.here()).toBe("#/apps/notes/list?page=2");
    b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`));
    expect(b.page.press("Escape")).toBe(true);
    expect(b.here()).toBe("#/tasks");
  });

  test("框加载完按响应类型认（服务端回 text/markdown、text/plain 的也算，没有扩展名的地址也是）：这时框里就是这个文件，‹ 是框里后退；框走开了渲染层跟着收", () => {
    const b = openLoaded("#/tasks", "/apps/notes/");
    b.frameNavigate();
    b.frame.load("/apps/notes/raw?id=3", "", "text/markdown");
    b.session.frameLoaded();
    expect(b.session.view()).toEqual({ title: "raw", canGoBack: true, file: { url: `${ORIGIN}/apps/notes/raw?id=3`, name: "raw", inFrame: true, seq: 1 } });
    expect(b.here()).toBe("#/apps/notes/raw?id=3");
    b.session.goBack();
    expect(b.frame.calls).toEqual(["back"]);
    b.frame.load("/apps/notes/", "笔记");
    b.session.frameLoaded();
    expect(b.session.view().file).toBeUndefined();
    // 网页（.md 地址回的 HTML）不算
    b.frame.load("/apps/notes/blob/README.md", "README", "text/html");
    b.session.frameLoaded();
    expect(b.session.view().file).toBeUndefined();
  });

  test("框走到别处（浏览器的后退键）：盖着的渲染层收起", () => {
    const b = openLoaded("#/tasks", "/apps/notes/");
    b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`));
    b.frame.load("/apps/notes/other", "别的");
    b.session.frameLoaded();
    expect(b.session.view().file).toBeUndefined();
    expect(b.here()).toBe("#/apps/notes/other");
  });

  test("直接打开文件的地址（刷新、发给别的设备）：框不开那个文件（免得下载），直接渲染；空框加载完不算；‹ 关掉内置浏览器", () => {
    const b = open("#/secretary", "/apps/notes/docs/README.md");
    expect(b.session.src).toBe("about:blank");
    expect(b.session.view()).toEqual({ title: "README.md", canGoBack: true, file: { url: `${ORIGIN}/apps/notes/docs/README.md`, name: "README.md", inFrame: false, seq: 1 } });
    b.session.frameLoaded();
    expect(b.session.view().file?.url).toBe(`${ORIGIN}/apps/notes/docs/README.md`);
    b.session.goBack();
    expect(b.here()).toBe("#/secretary");
  });

  test("渲染层里点链接：同一个服务里能渲染的换一个文件看；不能渲染的框跳过去、收起渲染层；外部网站、二狗的别的页面新窗口打开", () => {
    const b = openLoaded("#/tasks", "/apps/notes/");
    b.frame.click(linkTo(`${ORIGIN}/apps/notes/docs/README.md`));
    b.session.followLink(`${ORIGIN}/apps/notes/docs/guide.md`);
    expect(b.session.view().file).toEqual({ url: `${ORIGIN}/apps/notes/docs/guide.md`, name: "guide.md", inFrame: false, seq: 2 });
    expect(b.here()).toBe("#/apps/notes/docs/guide.md");
    b.session.followLink("https://example.com/x");
    b.session.followLink(`${ORIGIN}/#/tasks`);
    expect(b.opened).toEqual(["https://example.com/x", `${ORIGIN}/#/tasks`]);
    b.session.followLink(`${ORIGIN}/apps/notes/index.html`);
    expect(b.session.view().file).toBeUndefined();
    expect(b.frame.handle.src).toBe(`${ORIGIN}/apps/notes/index.html`);
  });

  test("取到的不是能渲染的（.md 地址回的网页）：框照旧打开它，收起渲染层；已经不是这一次的不管", () => {
    const b = openLoaded("#/tasks", "/apps/notes/");
    b.frame.click(linkTo(`${ORIGIN}/apps/git/blob/README.md`));
    const seq = b.session.view().file!.seq;
    b.session.fileIsPage(seq + 1);
    expect(b.session.view().file).toBeDefined();
    b.session.fileIsPage(seq);
    expect(b.session.view().file).toBeUndefined();
    expect(b.frame.handle.src).toBe(`${ORIGIN}/apps/git/blob/README.md`);
  });

  test("刷新、在新窗口打开：渲染层开着时对这个文件（刷新重新取一次）", () => {
    const b = openLoaded("#/tasks", "/apps/notes/");
    b.frame.click(linkTo(`${ORIGIN}/apps/notes/a.md`));
    b.session.reload();
    expect(b.session.view().file?.seq).toBe(2);
    expect(b.frame.calls).toEqual([]);
    b.session.openOutside();
    expect(b.opened).toEqual([`${ORIGIN}/apps/notes/a.md`]);
  });

  test("开着的时候地址又换成这个服务的一个文件（又点了一个入口）：渲染它；换回网页收起渲染层", () => {
    const b = openLoaded("#/tasks", "/apps/notes/");
    b.session.show({ tab: "app", app: "notes", path: "a.md" });
    expect(b.session.view().file?.url).toBe(`${ORIGIN}/apps/notes/a.md`);
    expect(b.frame.handle.src).toBe("/apps/notes/");
    b.session.show({ tab: "app", app: "notes", path: "list" });
    expect(b.session.view().file).toBeUndefined();
    expect(b.frame.handle.src).toBe("/apps/notes/list");
  });

  test("原型（直接打开构建产物，file://，源是 \"null\"）：文件的地址按 file:/// 解析，照样渲染", () => {
    const p = fakePage("#/secretary");
    const page: BrowserPage = { ...p.page, location: { ...p.page.location, origin: "null" } };
    expect(appRouteOf("/apps/demo/README.md", "null")).toEqual({ tab: "app", app: "demo", path: "README.md" });
    const session = new InAppBrowserSession({ route: { tab: "app", app: "demo", path: "README.md" }, page, back: createBackRegistry(), leaveTo: "#/secretary", onChange: () => {} });
    expect(session.view().file?.url).toBe("file:///apps/demo/README.md");
  });

  test("拿下时框里那一页的点击监听也拿掉", () => {
    const b = openLoaded("#/tasks", "/apps/notes/");
    expect(b.frame.clickListeners).toBe(1);
    b.unmount();
    expect(b.frame.clickListeners).toBe(0);
  });
});
