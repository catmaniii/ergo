// 鸿蒙 App 的原生内置浏览器（134 号票）在网页这一侧：包装原生桥上的浏览器这一组方法（app/native-browser.ts）、
// 开场接上它和外链改到"浏览"里打开（app/browser-shell.ts）。原生桥、页面的 document 都是假的。
// 164 号票：看能点的东西、按编号点经 browserPage 的 snapshot、click；旧版 App 不认（回空串、页面桥照样在）的认成"App 太旧"。
// 184 号票：看的结果里多文本框、上传框、下拉框（现在的值、多行、accept、multiple、选项、藏起来的）；按编号找框经 browserPage 的 refField；
// 交文件能按编号交（先找框、再交进它的框编号）。
import { describe, expect, test } from "vitest";
import { followExternalLinks, type LinkClick, type LinkLike, openInNativeBrowser, watchNativeBrowser } from "../../src/app/browser-shell.ts";
import { detectNativeApp } from "../../src/app/native-app.ts";
import { BLANK_BROWSER, isExternalWebUrl, type NativeBrowserScope, parseBrowserState, parsePageEvent, wrapNativeBrowser } from "../../src/app/native-browser.ts";

const ORIGIN = "https://ergo.example.sslip.io";

/** 假的原生桥：浏览器这一组方法记下调用；attach 回 attachReply */
function fakeBridge(attachReply: unknown = JSON.stringify({ url: "", title: "", progress: 0, loading: false, canGoBack: false, canGoForward: false })) {
  const calls: string[] = [];
  return {
    calls,
    appVersion: () => "0.3.0",
    browserAttach: () => {
      calls.push("attach");
      return attachReply;
    },
    browserLayout: (json: string) => void calls.push(`layout ${json}`),
    browserLoad: (url: string) => void calls.push(`load ${url}`),
    browserNav: (action: string) => void calls.push(`nav ${action}`),
  };
}

const state = (over: Record<string, unknown>) => JSON.stringify({ type: "state", state: { url: "", title: "", progress: 0, loading: false, canGoBack: false, canGoForward: false, ...over } });

describe("包装原生桥上的浏览器", () => {
  test("四个方法都在（新版 App）：NativeApp.browser 有；少一个（旧版 App）就没有，导航里不出'浏览'", () => {
    expect(detectNativeApp({ ergoNative: fakeBridge() })?.browser).toBeDefined();
    const old: Record<string, unknown> = fakeBridge();
    delete old.browserNav;
    expect(detectNativeApp({ ergoNative: old })?.browser).toBeUndefined();
  });

  test("attach、layout、load、nav 照原样交给 App；layout 是 JSON", () => {
    const bridge = fakeBridge();
    const browser = wrapNativeBrowser(bridge, {})!;
    expect(browser.attach()).toEqual(BLANK_BROWSER);
    browser.layout({ visible: true, x: 0, y: 49, width: 390, height: 600, dpr: 3 });
    browser.load("https://example.com/");
    browser.nav("back");
    expect(bridge.calls).toEqual(["attach", 'layout {"visible":true,"x":0,"y":49,"width":390,"height":600,"dpr":3}', "load https://example.com/", "nav back"]);
  });

  test("App 回的样子不对、方法抛错：当没有，不抛", () => {
    expect(wrapNativeBrowser(fakeBridge("不是 JSON"), {})!.attach()).toBeUndefined();
    const throwing = { ...fakeBridge(), browserLoad: () => {
      throw new Error("refused");
    } };
    expect(() => wrapNativeBrowser(throwing, {})!.load("https://example.com/")).not.toThrow();
  });

  test("样子：地址不是 http(s)（about:blank）当空，进度夹在 0–100", () => {
    expect(parseBrowserState({ url: "about:blank", title: "", progress: 140, loading: true, canGoBack: true })).toEqual({ url: "", title: "", progress: 100, loading: true, canGoBack: true, canGoForward: false });
    expect(parseBrowserState("[]")).toBeUndefined();
  });

  test("App 推的经 window.__ergoBrowser 交给订阅的：state、open；认不得的丢掉", () => {
    const scope: NativeBrowserScope = {};
    const browser = wrapNativeBrowser(fakeBridge(), scope)!;
    const seen: unknown[] = [];
    browser.subscribe((e) => seen.push(e));
    scope.__ergoBrowser!(state({ url: "https://example.com/", title: "例子", loading: true, progress: 30 }));
    scope.__ergoBrowser!(JSON.stringify({ type: "open", url: "https://example.org/a" }));
    scope.__ergoBrowser!(JSON.stringify({ type: "open", url: "javascript:alert(1)" }));
    scope.__ergoBrowser!("坏的");
    expect(seen).toEqual([
      { type: "state", state: { url: "https://example.com/", title: "例子", progress: 30, loading: true, canGoBack: false, canGoForward: false } },
      { type: "open", url: "https://example.org/a" },
    ]);
  });

  test("外部网站的网页：http(s) 且和二狗不同源", () => {
    expect(isExternalWebUrl("https://example.com/x", ORIGIN)).toBe(true);
    expect(isExternalWebUrl("http://example.com/x", ORIGIN)).toBe(true);
    expect(isExternalWebUrl(`${ORIGIN}/apps/intel/`, ORIGIN)).toBe(false);
    expect(isExternalWebUrl("/apps/intel/", ORIGIN)).toBe(false);
    expect(isExternalWebUrl("mailto:a@b.c", ORIGIN)).toBe(false);
    expect(isExternalWebUrl("javascript:void(0)", ORIGIN)).toBe(false);
  });
});

/** 假的原生浏览器：推送由测试手动发 */
function fakeBrowser(initial?: unknown) {
  const scope: NativeBrowserScope = {};
  const bridge = fakeBridge(initial === undefined ? undefined : JSON.stringify(initial));
  const browser = wrapNativeBrowser(bridge, scope)!;
  return { browser, calls: bridge.calls, push: (json: string) => scope.__ergoBrowser!(json) };
}

describe("开场接上原生浏览器", () => {
  test("马上 attach（App 由此知道网页有'浏览'页签了），样子跟着推的变", () => {
    const b = fakeBrowser({ url: "https://example.com/", title: "例子", progress: 100, loading: false, canGoBack: true, canGoForward: false });
    const watch = watchNativeBrowser(b.browser, { visited: () => {} }, () => {});
    expect(b.calls).toEqual(["attach"]);
    expect(watch.state()).toMatchObject({ url: "https://example.com/", canGoBack: true });
    let changed = 0;
    watch.subscribe(() => changed++);
    b.push(state({ url: "https://example.com/next", loading: true, progress: 10 }));
    expect(changed).toBe(1);
    expect(watch.state()).toMatchObject({ url: "https://example.com/next", loading: true });
  });

  test("加载完一页记进最近访问（加载中不记；标题后到的再记一次，同一个地址只留一条由最近访问去重）", () => {
    const b = fakeBrowser();
    const visited: string[] = [];
    watchNativeBrowser(b.browser, { visited: (url, title) => void visited.push(`${url} ${title}`) }, () => {});
    b.push(state({ url: "https://example.com/", loading: true, progress: 10 }));
    b.push(state({ url: "https://example.com/", loading: false, progress: 100 }));
    b.push(state({ url: "https://example.com/", title: "例子", loading: false, progress: 100 }));
    b.push(state({ url: "https://example.com/", title: "例子", loading: false, progress: 100 }));
    expect(visited).toEqual(["https://example.com/ ", "https://example.com/ 例子"]);
  });

  test("App 在浏览器里打开了主页面上点的外链（open）：切到'浏览'", () => {
    const b = fakeBrowser();
    const opened: string[] = [];
    watchNativeBrowser(b.browser, { visited: () => {} }, (url) => opened.push(url));
    b.push(JSON.stringify({ type: "open", url: "https://example.com/" }));
    expect(opened).toEqual(["https://example.com/"]);
  });
});

describe("在原生浏览器里打开", () => {
  test("二狗转发的服务页面（/apps/…）拼成完整地址交给浏览器（带着 App 里的设备凭证），切到'浏览'", () => {
    const b = fakeBrowser();
    let shown = 0;
    expect(openInNativeBrowser(b.browser, "/apps/intel/reports?id=3", ORIGIN, () => shown++)).toBe(true);
    expect(b.calls).toContain(`load ${ORIGIN}/apps/intel/reports?id=3`);
    expect(shown).toBe(1);
  });

  test("外部网站照原样；不是 http(s) 的打不开", () => {
    const b = fakeBrowser();
    expect(openInNativeBrowser(b.browser, "https://example.com/a", ORIGIN, () => {})).toBe(true);
    expect(openInNativeBrowser(b.browser, "mailto:a@b.c", ORIGIN, () => {})).toBe(false);
    expect(b.calls.filter((c) => c.startsWith("load"))).toEqual(["load https://example.com/a"]);
  });
});

/** 假的 document：点一下，返回有没有被拦下 */
function fakeDoc() {
  const listeners = new Set<(e: LinkClick) => void>();
  return {
    addEventListener: (_t: "click", l: (e: LinkClick) => void) => void listeners.add(l),
    removeEventListener: (_t: "click", l: (e: LinkClick) => void) => void listeners.delete(l),
    click(link: LinkLike | undefined, over: Partial<LinkClick> = {}): boolean {
      let prevented = false;
      const e: LinkClick = { defaultPrevented: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: link, preventDefault: () => void (prevented = true), ...over };
      for (const l of listeners) l(e);
      return prevented;
    },
    get count() {
      return listeners.size;
    },
  };
}
const link = (href: string, attrs: string[] = []): LinkLike => ({ href, target: "_blank", hasAttribute: (name) => attrs.includes(name) });

describe("页面里点外链改到'浏览'里打开", () => {
  test("外部网站的链接（聊天里的、target=_blank 的）：拦下来交给原生浏览器", () => {
    const doc = fakeDoc();
    const opened: string[] = [];
    followExternalLinks(doc, ORIGIN, (t) => t as LinkLike | undefined, (url) => opened.push(url));
    expect(doc.click(link("https://example.com/news"))).toBe(true);
    expect(opened).toEqual(["https://example.com/news"]);
  });

  test("二狗自己的链接、带下载的、mailto、按着修饰键、被别人处理过的：不管", () => {
    const doc = fakeDoc();
    const opened: string[] = [];
    followExternalLinks(doc, ORIGIN, (t) => t as LinkLike | undefined, (url) => opened.push(url));
    expect(doc.click(link(`${ORIGIN}/#/tasks`))).toBe(false);
    expect(doc.click(link("https://example.com/a.pdf", ["download"]))).toBe(false);
    expect(doc.click(link("mailto:a@b.c"))).toBe(false);
    expect(doc.click(link("https://example.com/"), { ctrlKey: true })).toBe(false);
    expect(doc.click(link("https://example.com/"), { defaultPrevented: true })).toBe(false);
    expect(doc.click(undefined)).toBe(false);
    expect(opened).toEqual([]);
  });

  test("停下后不再拦", () => {
    const doc = fakeDoc();
    const stop = followExternalLinks(doc, ORIGIN, (t) => t as LinkLike | undefined, () => {});
    stop();
    expect(doc.count).toBe(0);
  });
});

describe("浏览侧边栏用到的页面桥（147 号票）", () => {
  const PAGE = { title: "报名", url: "https://form.example.cn/apply" };
  const NAME = { id: "f2", kind: "text", label: "姓名" };

  test("侧边栏由 App 画（有 browserSide 才有）：报的位置是 JSON；App 推的 side（收起、×、外部链接、开合）照转，认不得的丢掉", () => {
    const calls: string[] = [];
    const scope: NativeBrowserScope = {};
    const bridge = { ...fakeBridge(), browserSide: (json: string) => void calls.push(json) };
    const browser = wrapNativeBrowser(bridge, scope)!;
    expect(wrapNativeBrowser(fakeBridge(), {})!.side).toBeUndefined();
    const report = { dpr: 2, side: { visible: true, x: 680, y: 50, width: 400, height: 700 }, view: "{}" };
    browser.side!(report);
    expect(calls.map((c) => JSON.parse(c))).toEqual([report]);
    const seen: unknown[] = [];
    browser.subscribe((e) => seen.push(e));
    for (const action of ["close", "clearSelection", "link", "toggle", "explode"]) scope.__ergoBrowser!(JSON.stringify({ type: "side", action }));
    expect(seen).toEqual(["close", "clearSelection", "link", "toggle"].map((action) => ({ type: "side", action })));
  });

  test("页面桥报的选中的框（selected，null 是没选中）、气泡上的去侧边栏看（bubble sidebar）；形状不对的丢掉", () => {
    expect(parsePageEvent(JSON.stringify({ type: "selected", field: NAME, page: PAGE }))).toEqual({ type: "selected", field: NAME, page: PAGE });
    expect(parsePageEvent(JSON.stringify({ type: "selected", field: null, page: PAGE }))).toEqual({ type: "selected", field: null, page: PAGE });
    expect(parsePageEvent(JSON.stringify({ type: "bubble", action: "sidebar" }))).toEqual({ type: "bubble", action: "sidebar" });
    expect(parsePageEvent(JSON.stringify({ type: "sidebar" }))).toBeUndefined();
    expect(parsePageEvent(JSON.stringify({ type: "selected", field: { id: "x", kind: "text", label: "" }, page: PAGE }))).toBeUndefined();
    expect(parsePageEvent(JSON.stringify({ type: "selected", field: NAME, page: { title: "", url: "javascript:1" } }))).toBeUndefined();
  });

  test("现问选中的框、取整页文字、取消选中：经 browserPage 的 selected、text、clearSelection；回的不对当页面桥不在", async () => {
    const calls: string[] = [];
    let reply = "";
    const methods = {
      browserAttach: () => "{}",
      browserLayout: () => undefined,
      browserLoad: () => undefined,
      browserNav: () => undefined,
      browserPage: (op: string, args: string) => (calls.push(`${op} ${args}`), Promise.resolve(reply)),
      browserFileChunk: () => Promise.resolve('{"ok":true}'),
      browserFiles: () => Promise.resolve('{"ok":true}'),
      browserChooser: () => Promise.resolve('{"ok":true}'),
    };
    const page = wrapNativeBrowser(methods, {})!.page!;
    reply = JSON.stringify({ page: PAGE, field: NAME });
    expect(await page.selected()).toEqual({ page: PAGE, field: NAME });
    reply = JSON.stringify({ page: PAGE, field: null });
    expect(await page.selected()).toEqual({ page: PAGE, field: null });
    reply = JSON.stringify({ ok: true, page: PAGE, text: "正文", truncated: true, total: 30000 });
    expect(await page.text()).toEqual({ page: PAGE, text: "正文", truncated: true, total: 30000 });
    reply = '{"ok":true}';
    expect(await page.clearSelection()).toEqual({ ok: true });
    reply = "";
    expect(await page.selected()).toBeUndefined();
    expect(await page.text()).toBeUndefined();
    expect(calls).toEqual(["selected []", "selected []", "text []", "clearSelection []", "selected []", "text []"]);
  });
});

describe("看能点的东西、按编号点（164 号票）", () => {
  const PAGE = { title: "小店", url: "https://shop.example.cn/home" };
  /** 假的原生桥：browserPage 照 replies 回（按操作名），记下调用 */
  function pageBridge(replies: Record<string, string>) {
    const calls: string[] = [];
    const bridge = {
      ...fakeBridge(),
      browserPage: (op: string, args: string) => (calls.push(`${op} ${args}`), Promise.resolve(replies[op] ?? "")),
      browserFileChunk: () => Promise.resolve('{"ok":true}'),
      browserFiles: () => Promise.resolve('{"ok":true}'),
      browserChooser: () => Promise.resolve('{"ok":true}'),
    };
    return { page: wrapNativeBrowser(bridge, {})!.page!, calls };
  }

  test("看：经 browserPage 的 snapshot（要几个是字符串）；形状不对的元素丢掉、文字截到 200、地址只认 http(s)", async () => {
    const elements = [
      { ref: "e1", role: "link", text: "商品列表", href: "https://shop.example.cn/list" },
      { ref: "e2", role: "button", text: "字".repeat(300), disabled: true },
      { ref: "e3", role: "link", text: "坏地址", href: "javascript:alert(1)" },
      { ref: "x9", role: "button", text: "编号不对" },
      { ref: "e4", role: "checkbox", text: "种类不对" },
      { ref: "e5", role: "submit" },
    ];
    const { page, calls } = pageBridge({ snapshot: JSON.stringify({ ok: true, page: PAGE, elements, total: 9 }) });
    expect(await page.snapshot(40)).toEqual({
      ok: true,
      page: PAGE,
      elements: [
        { ref: "e1", role: "link", text: "商品列表", href: "https://shop.example.cn/list" },
        { ref: "e2", role: "button", text: "字".repeat(200), disabled: true },
        { ref: "e3", role: "link", text: "坏地址" },
      ],
      total: 9,
    });
    expect(calls).toEqual(['snapshot ["40"]']);
  });

  test("点：经 browserPage 的 click（编号、地址）；页面桥说不成的原样回原因", async () => {
    const { page, calls } = pageBridge({ click: JSON.stringify({ ok: true, role: "link", text: "商品列表", page: PAGE }) });
    expect(await page.click("e1", PAGE.url)).toEqual({ ok: true, role: "link", text: "商品列表", page: PAGE });
    expect(calls).toEqual([`click ${JSON.stringify(["e1", PAGE.url])}`]);
    const refused = pageBridge({ click: JSON.stringify({ ok: false, reason: "换了网页，编号失效，请重新 snapshot" }) });
    expect(await refused.page.click("e1", PAGE.url)).toEqual({ ok: false, reason: "换了网页，编号失效，请重新 snapshot" });
  });

  test("回空串：页面桥照样在（selected 回得出来）是旧版 App（不认 snapshot、click），回 old；页面桥也不在回 undefined", async () => {
    const old = pageBridge({ selected: JSON.stringify({ page: PAGE, field: null }) });
    expect(await old.page.snapshot(40)).toBe("old");
    expect(await old.page.click("e1", PAGE.url)).toBe("old");
    expect(old.calls).toEqual(['snapshot ["40"]', "selected []", `click ${JSON.stringify(["e1", PAGE.url])}`, "selected []"]);
    const gone = pageBridge({});
    expect(await gone.page.snapshot(40)).toBeUndefined();
    expect(await gone.page.click("e1", PAGE.url)).toBeUndefined();
  });
});

describe("按编号填字、交文件（184 号票）", () => {
  const PAGE = { title: "换背景", url: "https://studio.example.cn/app/bg" };
  const PROMPT = { id: "f3", kind: "textarea", label: "提示词" };
  const PRODUCT = { id: "f7", kind: "file", label: "产品图", accept: "image/*" };
  /** 假的原生桥：browserPage 照 replies 回（按操作名）、browserFiles 照 files 回，都记下调用 */
  function pageBridge(replies: Record<string, string>, files = '{"ok":true,"count":1}') {
    const calls: string[] = [];
    const bridge = {
      ...fakeBridge(),
      browserPage: (op: string, args: string) => (calls.push(`${op} ${args}`), Promise.resolve(replies[op] ?? "")),
      browserFileChunk: () => Promise.resolve('{"ok":true}'),
      browserFiles: (json: string) => (calls.push(`files ${json}`), Promise.resolve(files)),
      browserChooser: () => Promise.resolve('{"ok":true}'),
    };
    return { page: wrapNativeBrowser(bridge, {})!.page!, calls };
  }

  test("看：文本框带现在的值（截到 40）、多行；上传框带 accept、multiple、藏起来的；下拉框带选项（不是字的丢掉，最多 20 个、每个最长 100）；形状不对的字段不要", async () => {
    const elements = [
      { ref: "e1", role: "textbox", text: "提示词", valuePreview: "字".repeat(60), multiline: true },
      { ref: "e2", role: "upload", text: "产品图", accept: "image/*", multiple: true, hidden: true },
      { ref: "e3", role: "select", text: "尺寸", valuePreview: "3:4", options: ["1:1", 2, "选".repeat(150), ...Array.from({ length: 30 }, (_, i) => `第${i}个`)] },
      { ref: "e4", role: "textbox", text: "种子", valuePreview: 42, multiline: "yes", hidden: 1, options: "a" },
    ];
    const { page } = pageBridge({ snapshot: JSON.stringify({ ok: true, page: PAGE, elements, total: 4 }) });
    const snap = await page.snapshot(40);
    expect(snap).toMatchObject({ ok: true, total: 4 });
    const list = snap !== "old" && snap?.ok ? snap.elements : [];
    expect(list[0]).toEqual({ ref: "e1", role: "textbox", text: "提示词", valuePreview: "字".repeat(40), multiline: true });
    expect(list[1]).toEqual({ ref: "e2", role: "upload", text: "产品图", accept: "image/*", multiple: true, hidden: true });
    expect(list[2]).toMatchObject({ ref: "e3", role: "select", text: "尺寸", valuePreview: "3:4" });
    expect(list[2]!.options).toHaveLength(20);
    expect(list[2]!.options!.slice(0, 3)).toEqual(["1:1", "选".repeat(100), "第0个"]);
    expect(list[3]).toEqual({ ref: "e4", role: "textbox", text: "种子" });
  });

  test("按编号找框：经 browserPage 的 refField（编号、地址、要哪种）；回框的说法；页面桥说不成的原样回原因；回空串时页面桥在是旧版 App（old），不在是 undefined", async () => {
    const { page, calls } = pageBridge({ refField: JSON.stringify({ ok: true, page: PAGE, field: PROMPT }) });
    expect(await page.refField("e4", PAGE.url, "textbox")).toEqual({ ok: true, page: PAGE, field: PROMPT });
    expect(calls).toEqual([`refField ${JSON.stringify(["e4", PAGE.url, "textbox"])}`]);
    const refused = pageBridge({ refField: JSON.stringify({ ok: false, reason: "e1 不是文本框，不能填字" }) });
    expect(await refused.page.refField("e1", PAGE.url, "textbox")).toEqual({ ok: false, reason: "e1 不是文本框，不能填字" });
    const bad = pageBridge({ refField: JSON.stringify({ ok: true, page: PAGE, field: { id: 3 } }) });
    expect(await bad.page.refField("e1", PAGE.url, "textbox")).toMatchObject({ ok: false });
    const old = pageBridge({ selected: JSON.stringify({ page: PAGE, field: null }) });
    expect(await old.page.refField("e1", PAGE.url, "upload")).toBe("old");
    expect(await pageBridge({}).page.refField("e1", PAGE.url, "upload")).toBeUndefined();
  });

  test("按编号交文件：先按编号找上传框，再交进它的框编号；找不到回原因、不交；旧版 App 回装新版；页面桥不在回原因", async () => {
    const files = [{ id: "s1", name: "mug.png", mime: "image/png" }];
    const { page, calls } = pageBridge({ refField: JSON.stringify({ ok: true, page: PAGE, field: PRODUCT }) });
    expect(await page.deliver({ ref: "e2", url: PAGE.url }, files)).toEqual({ ok: true, count: 1 });
    expect(calls).toEqual([`refField ${JSON.stringify(["e2", PAGE.url, "upload"])}`, `files ${JSON.stringify({ target: "field", fieldId: "f7", files })}`]);
    const refused = pageBridge({ refField: JSON.stringify({ ok: false, reason: "网页换了，编号对不上了" }) });
    expect(await refused.page.deliver({ ref: "e2", url: PAGE.url }, files)).toEqual({ ok: false, reason: "网页换了，编号对不上了" });
    expect(refused.calls.filter((c) => c.startsWith("files"))).toEqual([]);
    const old = pageBridge({ selected: JSON.stringify({ page: PAGE, field: null }) });
    expect(await old.page.deliver({ ref: "e2", url: PAGE.url }, files)).toEqual({ ok: false, reason: "这台设备上的二狗 App 太旧，装新版才能按编号交文件" });
    expect(await pageBridge({}).page.deliver({ ref: "e2", url: PAGE.url }, files)).toEqual({ ok: false, reason: "网页上的页面桥不在了" });
    // 照旧按框编号、交给对话框的不找框
    const plain = pageBridge({});
    expect(await plain.page.deliver({ fieldId: "f5" }, files)).toEqual({ ok: true, count: 1 });
    expect(plain.calls).toEqual([`files ${JSON.stringify({ target: "field", fieldId: "f5", files })}`]);
  });
});

describe("能渲染的文件（160 号票）：App 报来的文件、经 browserDoc 取内容、下载、系统浏览器打开", () => {
  test("有 browserDoc 才有 docs（新版 App）；enable、source、save、outside、drop 都经 browserDoc(操作, 编号)，source 回 App 回的字符串", async () => {
    expect(wrapNativeBrowser(fakeBridge(), {})!.docs).toBeUndefined();
    const calls: string[] = [];
    let reply: unknown = '{"ok":true,"kind":"text","text":"hi"}';
    const bridge = { ...fakeBridge(), browserDoc: (op: string, id: string) => (calls.push(`${op} ${id}`), Promise.resolve(reply)) };
    const docs = wrapNativeBrowser(bridge, {})!.docs!;
    docs.enable();
    expect(await docs.source("p3")).toBe('{"ok":true,"kind":"text","text":"hi"}');
    docs.save("p3");
    docs.outside("d4");
    docs.drop("d4");
    reply = 42;
    expect(await docs.source("p3")).toBe("");
    expect(calls).toEqual(["enable ", "source p3", "save p3", "outside d4", "drop d4", "source p3"]);
    const throwing = { ...fakeBridge(), browserDoc: () => Promise.reject(new Error("refused")) };
    expect(await wrapNativeBrowser(throwing, {})!.docs!.source("p1")).toBe("");
  });

  test("App 推的 document（页面上显示的、拦下的下载）：编号、地址（http(s)）、类型、文件名、大小形状对的交给订阅的；不对的丢掉", () => {
    const scope: NativeBrowserScope = {};
    const browser = wrapNativeBrowser({ ...fakeBridge(), browserDoc: () => Promise.resolve("") }, scope)!;
    const seen: unknown[] = [];
    browser.subscribe((e) => seen.push(e));
    const doc = (d: Record<string, unknown>) => scope.__ergoBrowser!(JSON.stringify({ type: "document", doc: d }));
    doc({ id: "p1", url: "https://raw.example.com/README.md", mime: "text/plain", via: "page" });
    doc({ id: "d2", url: "https://files.example.com/get?id=7", mime: "application/octet-stream", name: "日报.md", via: "download", bytes: 2048 });
    doc({ id: "p3", url: "file:///etc/passwd", mime: "text/plain", via: "page" });
    doc({ id: "x", url: "https://a.example/", mime: "text/plain", via: "page" });
    doc({ id: "p4", url: "https://a.example/", mime: "text/plain", via: "sideways" });
    expect(seen).toEqual([
      { type: "document", doc: { id: "p1", url: "https://raw.example.com/README.md", mime: "text/plain", name: "", via: "page" } },
      { type: "document", doc: { id: "d2", url: "https://files.example.com/get?id=7", mime: "application/octet-stream", name: "日报.md", via: "download", bytes: 2048 } },
    ]);
  });
});

/** 假的 browserTool：记下操作和参数，按操作回 replies 里的 */
function toolBridge(replies: Record<string, unknown> = {}) {
  const calls: [string, unknown][] = [];
  return {
    calls,
    bridge: {
      ...fakeBridge(),
      browserTool: (op: string, json: string) => {
        calls.push([op, JSON.parse(json)]);
        return Promise.resolve(op in replies ? replies[op] : '{"ok":true}');
      },
    },
  };
}

describe("⋮ 菜单用到的原生工具（165 号票）：经 browserTool(操作, JSON)", () => {
  test("有 browserTool 才有 tools（新版 App）；查找、下一个、清掉高亮、按网站的设置照原样交过去", () => {
    expect(wrapNativeBrowser(fakeBridge(), {})!.tools).toBeUndefined();
    const { calls, bridge } = toolBridge();
    const tools = wrapNativeBrowser(bridge, {})!.tools!;
    tools.find("新闻");
    tools.findNext(false);
    tools.findClear();
    tools.findBar(true);
    tools.sites({ desktopUserAgent: "UA", desktop: ["a.com"], zoom: { "b.com": 120 } });
    expect(calls).toEqual([
      ["find", { text: "新闻" }],
      ["findNext", { forward: false }],
      ["findClear", {}],
      ["findBar", { open: true }],
      ["sites", { desktopUserAgent: "UA", desktop: ["a.com"], zoom: { "b.com": 120 } }],
    ]);
  });

  test("分享、清数据、打开和删下载记录：回的结果按形状认；回的不对当失败，不抛", async () => {
    const { calls, bridge } = toolBridge({ share: '{"ok":true}', clear: '{"ok":true,"notes":["缓存只能整个清"]}', openDownload: '{"ok":false,"reason":"文件不在了"}', removeDownloads: "坏的" });
    const tools = wrapNativeBrowser(bridge, {})!.tools!;
    expect(await tools.share({ title: "新闻", url: "https://a.com/" })).toEqual({ ok: true });
    expect(await tools.clear({ cache: true, cookies: false, scope: "all", url: "" })).toEqual({ ok: true, notes: ["缓存只能整个清"] });
    expect(await tools.openDownload("dl-1")).toEqual({ ok: false, reason: "文件不在了" });
    expect((await tools.removeDownloads(["dl-1", "dl-2"])).ok).toBe(false);
    expect(calls.map(([op, args]) => `${op} ${JSON.stringify(args)}`)).toEqual([
      'share {"title":"新闻","url":"https://a.com/"}',
      'clear {"cache":true,"cookies":false,"scope":"all","url":""}',
      'openDownload {"id":"dl-1"}',
      'removeDownloads {"ids":["dl-1","dl-2"]}',
    ]);
    const throwing = { ...fakeBridge(), browserTool: () => Promise.reject(new Error("refused")) };
    expect((await wrapNativeBrowser(throwing, {})!.tools!.share({ title: "", url: "https://a.com/" })).ok).toBe(false);
  });

  test("下载记录：形状对的认（名字、大小、时间、存在哪、类型），新的在前；不对的丢掉", async () => {
    const list = [
      { id: "dl-1", name: "报告.pdf", size: 2048, time: 100, uri: "file://docs/storage/Users/currentUser/Download/%E6%8A%A5%E5%91%8A.pdf", mime: "application/pdf" },
      { id: "dl-2", name: "表.csv", size: 80, time: 200, uri: "file://docs/storage/Users/currentUser/Download/a.csv", mime: "" },
      { id: "", name: "坏的", size: 1, time: 1, uri: "x", mime: "" },
      { id: "dl-3", name: "没有地址", size: 1, time: 1, mime: "" },
      5,
    ];
    const { bridge } = toolBridge({ downloads: JSON.stringify({ ok: true, downloads: list }) });
    expect(await wrapNativeBrowser(bridge, {})!.tools!.downloads()).toEqual([list[1], list[0]]);
    const broken = toolBridge({ downloads: "坏的" });
    expect(await wrapNativeBrowser(broken.bridge, {})!.tools!.downloads()).toEqual([]);
  });

  test("App 推的 find（查找结果）：第几个、一共几个、数完了没有；find-close（查找栏开着时按了返回）；形状不对的丢掉", () => {
    const scope: NativeBrowserScope = {};
    const browser = wrapNativeBrowser(toolBridge().bridge, scope)!;
    const seen: unknown[] = [];
    browser.subscribe((e) => seen.push(e));
    scope.__ergoBrowser!(JSON.stringify({ type: "find", active: 2, total: 7, done: true }));
    scope.__ergoBrowser!(JSON.stringify({ type: "find", active: -1, total: 0, done: false }));
    scope.__ergoBrowser!(JSON.stringify({ type: "find", active: "x", total: 7, done: true }));
    scope.__ergoBrowser!(JSON.stringify({ type: "find-close" }));
    expect(seen).toEqual([
      { type: "find", result: { active: 2, total: 7, done: true } },
      { type: "find", result: { active: 0, total: 0, done: false } },
      { type: "find-close" },
    ]);
  });
});
