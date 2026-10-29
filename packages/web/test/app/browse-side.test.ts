// 浏览侧边栏（147 号票）在网页这一侧（app/browse-side.ts）：展开收起按设备记住（存储用不了默认收起）、浏览器和侧边栏摆在哪（148 号票：
// 宽屏挤压——侧边栏滑到位后浏览器让出右边，中间一条分隔条能拖、有上下限、内容区变了夹回；窄屏照旧整屏盖住）、"现在在看"跟着网页和选中的框变
// （× 取消选中）、变了报给守护进程、侧边栏发的消息带的网页上下文、侧边栏上点的（App 转回来的），以及办守护进程推来的秘书的网页工具
// （读、填、交文件、开网址）——页面桥、存储、连接都换成假的。侧边栏模式那一页（app/side-remote.ts）在后面。
// 149 号票：读网页连同选中的框里现在的内容；交文件先用预备好的（page-stage.ts）、交给拦下的选文件对话框；报给守护进程的
// 浏览器样子里选中的框不带框里的内容；侧边栏模式那一页收到的选中的框带着内容（发消息时带上）。
// 164 号票：看能点的东西（snapshot，地址去掉查询串、写明一共几个）、按编号点（click：点完等最多 3 秒看地址变没变，变了再等加载完、
// 带上新的网页）；旧版 App 回"App 太旧"，页面桥不在、页面桥说不成的回原因。
// 184 号票：按编号填字（先 refField 找到文本框、再照它的框编号填，不看选中的框）、按编号交文件（先找上传框，找不到不取字节；交的时候
// 按编号交，交之前页面桥再核对一次）；旧版 App 回"App 太旧，装新版才能按编号填和交"。
import { describe, expect, test } from "vitest";
import { BrowseSide, type BrowseSideDeps, browseFrames, browseSideWidthOf, browseSideWidthRange, dragBrowseSideWidth, newBrowserId, watchingText } from "../../src/plugins/browsing/browse-side.ts";
import { isSideMode, parseSideView, RemoteSide } from "../../src/plugins/browsing/side-remote.ts";
import { BLANK_BROWSER, type NativePageControl, type PageClick, type PageOutcome, type PageRefField, type PageSnapshot, type StagedFile } from "../../src/app/native-browser.ts";
import { PageStage } from "../../src/plugins/browsing/page-stage.ts";
import type { BrowserOutcome, BrowserStatusParams, PageField } from "../../src/state/index.ts";
import { type ThemeEnv, themeControllerIn } from "../../src/app/theme.ts";
import { BASE_STYLE, stylePageInfo, VISUAL_STYLES } from "../../src/visual-styles/index.ts";

const BROWSER = "b-00112233445566ff";
const PAGE = { title: "报名 · 示例", url: "https://form.example.cn/apply" };
const NAME: PageField = { id: "f2", kind: "text", label: "姓名" };
const AVATAR: PageField = { id: "f5", kind: "file", label: "上传头像" };

function memoryStorage() {
  const items = new Map<string, string>();
  return { items, getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
}

/** 一份网页的外观环境（275 号票的两份网页那条）：根元素的属性、存储都是假的，记下来看 */
function themeEnv(): ThemeEnv & { root: Record<string, string>; stored: Map<string, string> } {
  const root: Record<string, string> = {};
  const storage = memoryStorage();
  return {
    root,
    stored: storage.items,
    document: {
      documentElement: { setAttribute: (n, v) => void (root[n] = v), removeAttribute: (n) => void delete root[n] },
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, getAttribute: () => null, remove() {} }),
      head: { appendChild: () => undefined },
    },
    storage: () => storage,
    systemDark: { matches: false, addEventListener() {} },
    styles: stylePageInfo(VISUAL_STYLES, BASE_STYLE),
  };
}

/** 假的页面桥：现在选中的框、整页文字可以改；记下调过的 */
function fakePage() {
  const calls: string[] = [];
  const state = {
    selected: null as PageField | null,
    url: `${PAGE.url}?x=1`,
    text: "正文",
    present: true,
    // 164 号票：页面桥看能点的、点的回什么（"old" 是旧版 App）；点的时候顺便做的事（扮 App 推浏览器的样子）
    snapshot: undefined as PageSnapshot | "old" | undefined,
    click: undefined as PageClick | "old" | undefined,
    onClick: undefined as (() => void) | undefined,
    // 184 号票：按编号找框回什么
    refField: undefined as PageRefField | "old" | undefined,
  };
  const ok: PageOutcome = { ok: true };
  const page: NativePageControl = {
    fields: async () => undefined,
    fill: async (id, text) => (calls.push(`fill ${id} ${text}`), ok),
    mark: () => {},
    bubble: async () => true,
    pick: async () => true,
    putFile: async (id, bytes) => (calls.push(`put ${id} ${bytes.length}`), true),
    deliver: async (target, files: readonly StagedFile[]) => (
      calls.push(`deliver ${target === "chooser" ? "chooser" : "ref" in target ? `${target.ref}@${target.url}` : target.fieldId} ${files.map((f) => f.name).join(",")}`), { ok: true, count: files.length }
    ),
    chooser: async () => ok,
    selected: async () => (state.present ? { page: { title: PAGE.title, url: state.url }, field: state.selected } : undefined),
    text: async () => (state.present ? { page: { title: PAGE.title, url: state.url }, text: state.text, truncated: false, total: state.text.length } : undefined),
    clearSelection: async () => (calls.push("clear"), ok),
    snapshot: async (max) => (calls.push(`snapshot ${max}`), state.snapshot),
    click: async (ref, url) => {
      calls.push(`click ${ref} ${url}`);
      state.onClick?.();
      return state.click;
    },
    refField: async (ref, url, want) => (calls.push(`refField ${ref} ${url} ${want}`), state.refField),
  };
  return { page, calls, state };
}

function setup(options: { storage?: () => ReturnType<typeof memoryStorage>; narrow?: boolean; searchEngine?: () => string } = {}) {
  const storage = memoryStorage();
  const fake = fakePage();
  const reports: BrowserStatusParams[] = [];
  const replies: Array<{ id: string; outcome: BrowserOutcome }> = [];
  const loaded: string[] = [];
  const fetched: string[] = [];
  const logs: string[] = [];
  let narrow = options.narrow ?? false;
  // 手动的计时器（164 号票：点完等地址变的那几秒）
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const stage = new PageStage({
    fetch: async (token) => (fetched.push(token), new Uint8Array(token.length)),
    put: (id, bytes) => fake.page.putFile(id, bytes),
    discard: () => {},
    log: (line) => logs.push(line),
    now: () => 1_000,
  });
  const deps: BrowseSideDeps = {
    browserId: BROWSER,
    page: fake.page,
    load: (url) => void loaded.push(url),
    report: (status) => void reports.push(status),
    ...(options.searchEngine ? { searchEngine: options.searchEngine } : {}),
    reply: (id, outcome) => void replies.push({ id, outcome }),
    stage,
    storage: options.storage ?? (() => storage),
    narrow: () => narrow,
    now: () => 1_000,
    timer: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
  };
  const side = new BrowseSide(deps);
  /** 到点：还没取消的计时器都触发 */
  const fireTimers = () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
  };
  return { side, storage, fake, reports, replies, loaded, fetched, logs, stage, setNarrow: (n: boolean) => (narrow = n), deps, timers, fireTimers };
}

describe("展开、收起", () => {
  test("默认收起；展开记在这台设备上，下次进来照上次的样子；收起不留记号", () => {
    const { side, storage, deps } = setup();
    expect(side.snapshot().open).toBe(false);
    let notified = 0;
    side.subscribe(() => notified++);
    side.toggle();
    expect(side.snapshot().open).toBe(true);
    expect(notified).toBe(1);
    expect(new BrowseSide(deps).snapshot().open).toBe(true);
    side.toggle();
    expect(storage.items.size).toBe(0);
    expect(new BrowseSide(deps).snapshot().open).toBe(false);
  });

  test("存储用不了：默认收起，改了这次照样生效、不报错", () => {
    const { side } = setup({
      storage: () => {
        throw new Error("SecurityError");
      },
    });
    expect(side.snapshot().open).toBe(false);
    side.setOpen(true);
    expect(side.snapshot().open).toBe(true);
  });

  test("摆在哪（148 号票）：宽屏展开、侧边栏滑到位后浏览器让出右边——侧边栏在内容区右边，中间一条 14 宽的分隔条，三者不重叠；收起后浏览器恢复原宽", () => {
    const host = { x: 80, y: 50, width: 1000, height: 700 };
    const viewport = { width: 1080, height: 800 };
    expect(browseFrames(host, viewport, { wide: true, open: true, shown: true, settled: true, width: 400 })).toEqual({
      browser: { x: 80, y: 50, width: 586, height: 700 },
      splitter: { x: 666, y: 50, width: 14, height: 700 },
      side: { x: 680, y: 50, width: 400, height: 700, visible: true },
      cover: false,
    });
    // 收起：浏览器是整个内容区，没有分隔条；侧边栏照样给展开时的位置（App 从那里滑出去）、不显示
    expect(browseFrames(host, viewport, { wide: true, open: false, shown: true, settled: true, width: 400 })).toEqual({
      browser: { x: 80, y: 50, width: 1000, height: 700 },
      side: { x: 680, y: 50, width: 400, height: 700, visible: false },
      cover: false,
    });
    // 不在"浏览"页显示着：不显示、不挤
    const away = browseFrames(host, viewport, { wide: true, open: true, shown: false, settled: true, width: 400 });
    expect(away.side.visible).toBe(false);
    expect(away.browser).toEqual({ x: 80, y: 50, width: 1000, height: 700 });
    expect(away.splitter).toBeUndefined();
  });

  test("刚展开、侧边栏还在滑进来（settled 还没到）：浏览器先不让，侧边栏盖在它右边，没有分隔条（中间不露空隙）", () => {
    const frames = browseFrames({ x: 80, y: 50, width: 1000, height: 700 }, { width: 1080, height: 800 }, { wide: true, open: true, shown: true, settled: false, width: 400 });
    expect(frames.browser).toEqual({ x: 80, y: 50, width: 1000, height: 700 });
    expect(frames.side).toEqual({ x: 680, y: 50, width: 400, height: 700, visible: true });
    expect(frames.splitter).toBeUndefined();
  });

  test("窄屏（手机竖屏）照旧整屏盖住：浏览器不变、没有分隔条", () => {
    expect(browseFrames({ x: 0, y: 50, width: 390, height: 680 }, { width: 390, height: 844 }, { wide: false, open: true, shown: true, settled: true, width: 400 })).toEqual({
      browser: { x: 0, y: 50, width: 390, height: 680 },
      side: { x: 0, y: 0, width: 390, height: 844, visible: true },
      cover: true,
    });
  });

  test("侧边栏宽度的上下限（照\"详情\"阶段栏的口径）：最窄 320，最宽内容区的 60%（浏览器至少留 40%）；内容区窄得 60% 不到 320 时就是 320", () => {
    expect(browseSideWidthRange(1000)).toEqual({ min: 320, max: 600 });
    expect(browseSideWidthRange(1201)).toEqual({ min: 320, max: 721 });
    expect(browseSideWidthRange(500)).toEqual({ min: 320, max: 320 });
  });

  test("记住的宽度超出现在的范围（转屏、窗口变窄）：摆的时候夹回范围里", () => {
    const at = { wide: true, open: true, shown: true, settled: true } as const;
    const viewport = { width: 1080, height: 800 };
    // 平板横屏拖到 700，转成窄一些的宽屏（内容区 800）：最宽 480
    expect(browseFrames({ x: 80, y: 50, width: 800, height: 700 }, viewport, { ...at, width: 700 })).toMatchObject({
      browser: { x: 80, width: 306 },
      splitter: { x: 386, width: 14 },
      side: { x: 400, width: 480 },
    });
    // 比最窄还窄的：320
    expect(browseFrames({ x: 80, y: 50, width: 1000, height: 700 }, viewport, { ...at, width: 200 }).side).toMatchObject({ x: 760, width: 320 });
    // 内容区窄（520，比宽屏最窄的还窄一点）：侧边栏 320，浏览器还有 186
    expect(browseFrames({ x: 80, y: 50, width: 520, height: 700 }, viewport, { ...at, width: 400 })).toMatchObject({ browser: { width: 186 }, splitter: { x: 266 }, side: { x: 280, width: 320 } });
  });

  test("拖分隔条：往左拖侧边栏变宽、往右拖变窄，夹在上下限里", () => {
    expect(dragBrowseSideWidth(400, -50, 1000)).toBe(450);
    expect(dragBrowseSideWidth(400, 30, 1000)).toBe(370);
    expect(dragBrowseSideWidth(400, 120, 1000)).toBe(320);
    expect(dragBrowseSideWidth(580, -100, 1000)).toBe(600);
  });

  test("这台设备记住的宽度怎么认：认不出、比最窄还窄的按 400", () => {
    expect(browseSideWidthOf(null)).toBe(400);
    expect(browseSideWidthOf("460")).toBe(460);
    expect(browseSideWidthOf("abc")).toBe(400);
    expect(browseSideWidthOf("100")).toBe(400);
    // 比现在的最宽还宽的照样认（摆的时候夹回）
    expect(browseSideWidthOf("900")).toBe(900);
  });

  test("侧边栏上点的（App 转回来的）：收起、×、开合；侧边栏里点了外部链接：窄屏收起、宽屏不动", () => {
    const { side, fake, setNarrow } = setup();
    side.sideAction("toggle");
    expect(side.snapshot().open).toBe(true);
    side.sideAction("link");
    expect(side.snapshot().open).toBe(true);
    setNarrow(true);
    side.sideAction("link");
    expect(side.snapshot().open).toBe(false);
    side.setOpen(true);
    side.sideAction("close");
    expect(side.snapshot().open).toBe(false);
    side.pageEvent({ type: "selected", field: NAME, page: PAGE });
    side.sideAction("clearSelection");
    expect(side.snapshot().selected).toBeUndefined();
    expect(fake.calls).toEqual(["clear"]);
  });

  test("气泡的回话上点了去侧边栏看（146 号票的气泡）：展开；气泡上别的动作不管", () => {
    const { side } = setup();
    side.pageEvent({ type: "bubble", action: "close" });
    expect(side.snapshot().open).toBe(false);
    side.pageEvent({ type: "bubble", action: "sidebar" });
    expect(side.snapshot().open).toBe(true);
  });
});

describe("现在在看", () => {
  test("网页的标题和地址（去掉查询串）、选中的框跟着变，变了报给守护进程（没变不报）；换了网页选中的框没了；同一页换标题还留着", () => {
    const { side, reports } = setup();
    side.browserChanged({ ...BLANK_BROWSER, url: `${PAGE.url}?from=ad#x`, title: PAGE.title });
    expect(side.snapshot()).toEqual({ open: false, page: PAGE });
    expect(watchingText(side.snapshot().page)).toEqual({ title: "报名 · 示例", host: "form.example.cn" });
    side.pageEvent({ type: "selected", field: NAME, page: PAGE });
    expect(side.snapshot().selected).toEqual(NAME);
    side.browserChanged({ ...BLANK_BROWSER, url: `${PAGE.url}?from=ad#x`, title: "报名（已填 1 项）" });
    expect(side.snapshot().selected).toEqual(NAME);
    side.browserChanged({ ...BLANK_BROWSER, url: "https://form.example.cn/done", title: "完成" });
    expect(side.snapshot().selected).toBeUndefined();
    expect(reports).toEqual([
      { browser: BROWSER, page: PAGE },
      { browser: BROWSER, page: PAGE, selected: NAME },
      { browser: BROWSER, page: { title: "报名（已填 1 项）", url: PAGE.url }, selected: NAME },
      { browser: BROWSER, page: { title: "完成", url: "https://form.example.cn/done" } },
    ]);
    // 展开、收起也照样报一次（样子没变的不报）
    side.toggle();
    expect(reports).toHaveLength(4);
  });

  test("报的样子带上这台设备“浏览”里在用的搜索引擎（182 号票）；换了再报一次，没变不报", () => {
    let engine = "bing";
    const { side, reports } = setup({ searchEngine: () => engine });
    side.announce();
    expect(reports).toEqual([{ browser: BROWSER, searchEngine: "bing" }]);
    side.announce();
    expect(reports).toHaveLength(1);
    engine = "baidu";
    side.announce();
    expect(reports.at(-1)).toEqual({ browser: BROWSER, searchEngine: "baidu" });
  });

  test("212 号票：浏览插件停用后又启用，没变也再报一次（守护进程那边记浏览器的是新的一份）", () => {
    const { side, reports } = setup();
    side.browserChanged({ ...BLANK_BROWSER, url: PAGE.url, title: PAGE.title });
    side.announce();
    expect(reports).toHaveLength(1);
    side.reannounce();
    expect(reports).toEqual([
      { browser: BROWSER, page: PAGE },
      { browser: BROWSER, page: PAGE },
    ]);
    side.announce();
    expect(reports).toHaveLength(2);
  });

  test("× 取消选中：页面桥也取消；页面桥报没选中（框没了）也清掉", () => {
    const { side, fake } = setup();
    side.browserChanged({ ...BLANK_BROWSER, url: PAGE.url, title: PAGE.title });
    side.pageEvent({ type: "selected", field: NAME, page: PAGE });
    side.clearSelection();
    expect(side.snapshot().selected).toBeUndefined();
    expect(fake.calls).toEqual(["clear"]);
    side.pageEvent({ type: "selected", field: AVATAR, page: PAGE });
    side.pageEvent({ type: "selected", field: null, page: PAGE });
    expect(side.snapshot().selected).toBeUndefined();
    expect(watchingText(undefined)).toBeUndefined();
  });

  test("侧边栏发的消息带的上下文：哪个浏览器、网页、选中的框；还没打开网页时网页是空的", () => {
    const { side } = setup();
    expect(side.context()).toEqual({ browser: BROWSER, page: { title: "", url: "" } });
    side.browserChanged({ ...BLANK_BROWSER, url: PAGE.url, title: PAGE.title });
    side.pageEvent({ type: "selected", field: NAME, page: PAGE });
    expect(side.context()).toEqual({ browser: BROWSER, page: PAGE, selected: NAME });
    expect(newBrowserId(() => 0.999)).toBe("b-ffffffffffffffff");
    expect(newBrowserId(Math.random)).toMatch(/^b-[0-9a-f]{16}$/);
  });
});

describe("办秘书的网页工具", () => {
  test("读网页：交整页文字（地址去掉查询串），连同选中的框里现在的内容（149 号票）；页面桥不在回原因", async () => {
    const { side, fake, replies } = setup();
    await side.handle({ id: "r1", op: "read" });
    const filled: PageField = { ...NAME, value: { text: "王五", total: 2 } };
    fake.state.selected = filled;
    await side.handle({ id: "r2", op: "read" });
    fake.state.present = false;
    await side.handle({ id: "r3", op: "read" });
    expect(replies).toEqual([
      { id: "r1", outcome: { ok: true, page: PAGE, text: "正文", truncated: false, total: 2 } },
      { id: "r2", outcome: { ok: true, page: PAGE, text: "正文", truncated: false, total: 2, selected: filled } },
      { id: "r3", outcome: { ok: false, reason: expect.stringContaining("页面桥不在") } },
    ]);
  });

  test("报给守护进程的浏览器样子里选中的框不带框里的内容（149 号票：发消息、读网页时才带）；侧边栏发的消息带着", () => {
    const { side, reports } = setup();
    side.browserChanged({ ...BLANK_BROWSER, url: PAGE.url, title: PAGE.title });
    side.pageEvent({ type: "selected", field: { ...NAME, value: { text: "张", total: 1 } }, page: PAGE });
    side.pageEvent({ type: "selected", field: { ...NAME, value: { text: "张三", total: 2 } }, page: PAGE });
    expect(reports.at(-1)).toEqual({ browser: BROWSER, page: PAGE, selected: NAME });
    // 框里的字变了不再报（守护进程那边没变）
    expect(reports.filter((r) => r.selected)).toHaveLength(1);
    expect(side.context()).toEqual({ browser: BROWSER, page: PAGE, selected: { ...NAME, value: { text: "张三", total: 2 } } });
  });

  test("填字：还是这一页、还是选中的那个框才填；框变了、没选中、换了网页回原因", async () => {
    const { side, fake, replies } = setup();
    fake.state.selected = NAME;
    await side.handle({ id: "a", op: "fill", fieldId: "f2", url: PAGE.url, text: "张三" });
    fake.state.selected = AVATAR;
    await side.handle({ id: "b", op: "fill", fieldId: "f2", url: PAGE.url, text: "张三" });
    fake.state.selected = null;
    await side.handle({ id: "c", op: "fill", fieldId: "f2", url: PAGE.url, text: "张三" });
    fake.state.selected = NAME;
    fake.state.url = "https://form.example.cn/other";
    await side.handle({ id: "d", op: "fill", fieldId: "f2", url: PAGE.url, text: "张三" });
    expect(fake.calls).toEqual(["fill f2 张三"]);
    expect(replies.map((r) => [r.id, r.outcome.ok ? "ok" : r.outcome.reason])).toEqual([
      ["a", "ok"],
      ["b", "选中的框变了（用户点了别的框）"],
      ["c", "现在网页上没有选中的框（框没了，或者用户取消了选中）"],
      ["d", "浏览器已经换了网页，原来选中的框不在了"],
    ]);
  });

  test("交文件：凭取件码取字节、分段交给 App、交进那个框（候选卡交的不用是现在选中的框），预备好了的直接用（149 号票）、记耗时；换了网页回原因", async () => {
    const { side, fake, replies, fetched, stage, logs } = setup();
    const files = [
      { token: "t-1", name: "a.png", mime: "image/png", size: 3, image: true },
      { token: "t-22", name: "b.png", mime: "image/png", size: 4, image: true },
    ];
    // 候选一出来就预备了 t-1（挑图片窗口那边，page-pick.ts）
    stage.prefetch("c-1", [files[0]!]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await side.handle({ id: "x", op: "attach", fieldId: "f5", url: PAGE.url, files });
    // t-1 只取了一次（预备的那次），t-22 现取
    expect(fetched).toEqual(["t-1", "t-22"]);
    expect(fake.calls.filter((c) => c.startsWith("put"))).toHaveLength(2);
    expect(fake.calls.at(-1)).toBe("deliver f5 a.png,b.png");
    expect(logs[0]).toMatch(/^交文件（守护进程转来的）2 个，用上预备好的 1 个/);
    fake.state.url = "https://elsewhere.example/";
    await side.handle({ id: "y", op: "attach", fieldId: "f5", url: PAGE.url, files });
    expect(replies).toEqual([
      { id: "x", outcome: { ok: true, count: 2 } },
      { id: "y", outcome: { ok: false, reason: "浏览器已经换了网页，原来的上传框不在了" } },
    ]);
  });

  test("交给网页弹出、App 拦下的选文件对话框（149 号票，fieldId 是 chooser）：页面桥不在也交（App 核对对话框还等着）", async () => {
    const { side, fake, replies } = setup();
    fake.state.present = false;
    await side.handle({ id: "c", op: "attach", fieldId: "chooser", url: PAGE.url, files: [{ token: "t-3", name: "c.png", mime: "image/png", size: 3, image: true }] });
    expect(fake.calls.at(-1)).toBe("deliver chooser c.png");
    expect(replies).toEqual([{ id: "c", outcome: { ok: true, count: 1 } }]);
  });

  test("开网址：在内置浏览器里打开；窄屏上收起侧边栏，宽屏不收；不是 http(s) 的不开", async () => {
    const { side, replies, loaded, setNarrow } = setup();
    side.setOpen(true);
    await side.handle({ id: "w", op: "open", url: "https://example.org/a" });
    expect(side.snapshot().open).toBe(true);
    setNarrow(true);
    await side.handle({ id: "n", op: "open", url: "https://example.org/b" });
    expect(side.snapshot().open).toBe(false);
    await side.handle({ id: "j", op: "open", url: "javascript:alert(1)" });
    expect(loaded).toEqual(["https://example.org/a", "https://example.org/b"]);
    expect(replies.map((r) => r.outcome)).toEqual([{ ok: true }, { ok: true }, { ok: false, reason: "只能开 http、https 的网址" }]);
  });
});

describe("看能点的东西、按编号点（164 号票）", () => {
  const ELEMENTS = [
    { ref: "e1", role: "link" as const, text: "商品列表", href: "https://shop.example.cn/list" },
    { ref: "e2", role: "button" as const, text: "立即运行" },
  ];
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("看：交给页面桥要几个（不写 40 个），回网页（地址去掉查询串）、能点的、一共几个、截没截", async () => {
    const { side, fake, replies } = setup();
    fake.state.snapshot = { ok: true, page: { title: "小店", url: "https://shop.example.cn/home?utm=1" }, elements: ELEMENTS, total: 30 };
    await side.handle({ id: "s1", op: "snapshot", max: 2 });
    fake.state.snapshot = { ok: true, page: { title: "小店", url: "https://shop.example.cn/home" }, elements: ELEMENTS, total: 2 };
    await side.handle({ id: "s2", op: "snapshot" });
    expect(fake.calls).toEqual(["snapshot 2", "snapshot 40"]);
    expect(replies).toEqual([
      { id: "s1", outcome: { ok: true, page: { title: "小店", url: "https://shop.example.cn/home" }, elements: ELEMENTS, total: 30, truncated: true } },
      { id: "s2", outcome: { ok: true, page: { title: "小店", url: "https://shop.example.cn/home" }, elements: ELEMENTS, total: 2, truncated: false } },
    ]);
  });

  test("旧版 App（不认得看、点）回 App 太旧；页面桥不在、页面桥说不成的回原因", async () => {
    const { side, fake, replies } = setup();
    fake.state.snapshot = "old";
    await side.handle({ id: "a", op: "snapshot" });
    fake.state.click = "old";
    await side.handle({ id: "b", op: "click", ref: "e1", url: PAGE.url });
    fake.state.snapshot = undefined;
    await side.handle({ id: "c", op: "snapshot" });
    fake.state.click = undefined;
    await side.handle({ id: "d", op: "click", ref: "e1", url: PAGE.url });
    fake.state.click = { ok: false, reason: "页面变了（这个元素上的字变了），请重新 snapshot" };
    await side.handle({ id: "e", op: "click", ref: "e1", url: PAGE.url });
    expect(replies.map((r) => [r.id, r.outcome.ok ? "ok" : r.outcome.reason])).toEqual([
      ["a", "这台设备上的二狗 App 太旧，装新版才能点（看网页上能点的东西、点击都要新版 App）"],
      ["b", "这台设备上的二狗 App 太旧，装新版才能点（看网页上能点的东西、点击都要新版 App）"],
      ["c", expect.stringContaining("页面桥不在")],
      ["d", expect.stringContaining("页面桥不在")],
      ["e", "页面变了（这个元素上的字变了），请重新 snapshot"],
    ]);
  });

  test("点：交给页面桥编号和看的时候的地址；点完地址变了（App 推来的），等加载完、带上新的网页", async () => {
    const { side, fake, replies, timers } = setup();
    side.browserChanged({ ...BLANK_BROWSER, url: "https://shop.example.cn/home?utm=1", title: "小店" });
    fake.state.click = { ok: true, role: "link", text: "商品列表", page: { title: "小店", url: "https://shop.example.cn/home" } };
    const done = side.handle({ id: "k", op: "click", ref: "e1", url: "https://shop.example.cn/home" });
    await flush();
    expect(replies).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(3000);
    // App 推来：开始加载新的一页（标题还没到），再是加载完
    side.browserChanged({ ...BLANK_BROWSER, url: "https://shop.example.cn/list?page=1", title: "", loading: true });
    await flush();
    expect(replies).toEqual([]);
    side.browserChanged({ ...BLANK_BROWSER, url: "https://shop.example.cn/list?page=1", title: "商品列表 · 小店", loading: false });
    await done;
    expect(fake.calls).toEqual(["click e1 https://shop.example.cn/home"]);
    expect(replies).toEqual([{ id: "k", outcome: { ok: true, clicked: "link:商品列表", navigated: true, page: { title: "商品列表 · 小店", url: "https://shop.example.cn/list" } } }]);
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });

  test("点：3 秒里地址没变（弹出了菜单、弹层）回没跳，带上现在的网页；只改了 # 也算跳了", async () => {
    const { side, fake, replies, fireTimers } = setup();
    side.browserChanged({ ...BLANK_BROWSER, url: "https://shop.example.cn/home", title: "小店" });
    fake.state.click = { ok: true, role: "button", text: "展开", page: { title: "小店", url: "https://shop.example.cn/home" } };
    const done = side.handle({ id: "m", op: "click", ref: "e2", url: "https://shop.example.cn/home" });
    await flush();
    fireTimers();
    await done;
    // 只改了 #（App 推来的就是改了的地址）：算跳了，没在加载就不等
    fake.state.onClick = () => side.browserChanged({ ...BLANK_BROWSER, url: "https://shop.example.cn/home#reviews", title: "小店" });
    await side.handle({ id: "n", op: "click", ref: "e2", url: "https://shop.example.cn/home" });
    expect(replies).toEqual([
      { id: "m", outcome: { ok: true, clicked: "button:展开", navigated: false, page: { title: "小店", url: "https://shop.example.cn/home" } } },
      { id: "n", outcome: { ok: true, clicked: "button:展开", navigated: true, page: { title: "小店", url: "https://shop.example.cn/home" } } },
    ]);
  });

  test("点：跳了但 5 秒还没加载完，不再等，带上现在知道的网页", async () => {
    const { side, fake, replies, fireTimers } = setup();
    side.browserChanged({ ...BLANK_BROWSER, url: "https://shop.example.cn/home", title: "小店" });
    fake.state.click = { ok: true, role: "link", text: "慢的", page: { title: "小店", url: "https://shop.example.cn/home" } };
    fake.state.onClick = () => side.browserChanged({ ...BLANK_BROWSER, url: "https://slow.example.cn/", title: "", loading: true });
    const done = side.handle({ id: "z", op: "click", ref: "e3", url: "https://shop.example.cn/home" });
    await flush();
    fireTimers();
    await done;
    expect(replies).toEqual([{ id: "z", outcome: { ok: true, clicked: "link:慢的", navigated: true, page: { title: "", url: "https://slow.example.cn/" } } }]);
  });
});

describe("整页文字收拾（页面桥的 rules.ts）", () => {
  test("每行去掉首尾空白、行内连着的空白并成一个，空行并成一个，太长截掉、写明一共多少字", async () => {
    const { tidyPageText } = await import("../../src/page-bridge/rules.ts");
    expect(tidyPageText("  标题 \n\n\n\t第一段   有  空格  \n \n第二段\n\n")).toEqual({ text: "标题\n\n第一段 有 空格\n\n第二段", truncated: false, total: 17 });
    expect(tidyPageText("一二三四五", 3)).toEqual({ text: "一二三", truncated: true, total: 5 });
  });
});

describe("侧边栏模式那一页（App 另开的 Web 组件，?ergo=side）", () => {
  test("地址带 ?ergo=side 才是", () => {
    expect(isSideMode("?ergo=side")).toBe(true);
    expect(isSideMode("?x=1&ergo=side")).toBe(true);
    expect(isSideMode("")).toBe(false);
    expect(isSideMode("?ergo=main")).toBe(false);
  });

  test("样子跟着 App 转过来的（\"浏览\"页那一份的 sideView）；收起、×、起来了交给 App；发消息带的上下文用\"浏览\"页的浏览器编号、选中的框连同框里的内容", () => {
    const { side } = setup();
    side.browserChanged({ ...BLANK_BROWSER, url: PAGE.url, title: PAGE.title });
    const named: PageField = { ...NAME, value: { text: "李四", total: 2 } };
    side.pageEvent({ type: "selected", field: named, page: PAGE });
    side.setOpen(true);
    const calls: string[] = [];
    const remote = new RemoteSide(() => ({ close: () => calls.push("close"), clearSelection: () => calls.push("clearSelection"), ready: () => calls.push("ready") }));
    let notified = 0;
    remote.subscribe(() => notified++);
    remote.ready();
    expect(remote.receive(JSON.stringify(side.sideView("12px")))).toEqual({ open: true, browser: BROWSER, page: PAGE, selected: named, safeBottom: "12px" });
    expect(notified).toBe(1);
    expect(remote.snapshot()).toEqual({ open: true, page: PAGE, selected: named });
    expect(remote.context()).toEqual(side.context());
    remote.setOpen(false);
    remote.clearSelection();
    expect(calls).toEqual(["ready", "close", "clearSelection"]);
    // 形状不对的不认
    expect(remote.receive("坏的")).toBeUndefined();
    expect(parseSideView(JSON.stringify({ open: true, browser: "nope" }))).toBeUndefined();
    expect(parseSideView(JSON.stringify({ open: false, browser: BROWSER, selected: { id: "x", kind: "text", label: "" } }))).toEqual({ open: false, browser: BROWSER });
  });

  // 275 号票：设置里换了界面风格（深浅色、主色），侧边栏不用重启 App 就跟着换——"浏览"页交给它的样子里带着现在的外观
  test("样子里带着\"浏览\"页那一份现在的外观，侧边栏收到就照着套（交给 onAppearance）；外观形状不对的只丢外观，别的照收", () => {
    const { side } = setup();
    side.setOpen(true);
    const adopted: unknown[] = [];
    const remote = new RemoteSide(() => undefined, { onAppearance: (a) => adopted.push(a) });
    const appearance = { theme: "dark", style: "candy" } as const;
    expect(remote.receive(JSON.stringify(side.sideView(undefined, appearance)))).toEqual({ open: true, browser: BROWSER, appearance });
    expect(adopted).toEqual([appearance]);
    remote.receive(JSON.stringify(side.sideView(undefined, { theme: "system", style: "classic", accent: "orange" })));
    expect(adopted).toEqual([appearance, { theme: "system", style: "classic", accent: "orange" }]);
    // 没带外观（旧的"浏览"页）：什么都不套
    remote.receive(JSON.stringify(side.sideView()));
    expect(adopted).toHaveLength(2);
    // 形状不对的外观
    for (const bad of [{ theme: "dusk", style: "candy" }, { theme: "dark" }, { theme: "dark", style: 3 }, { theme: "dark", style: "x".repeat(100) }, { theme: "dark", style: "candy", accent: "<b>" }, "dark", null]) {
      expect(parseSideView(JSON.stringify({ open: true, browser: BROWSER, appearance: bad }))).toEqual({ open: true, browser: BROWSER });
    }
    expect(adopted).toHaveLength(2);
  });

  test("两份网页走一遍：\"浏览\"页那一份在设置里换了风格、深浅色，经 App 转过去的样子让侧边栏那一份马上换成一样的", () => {
    const main = themeControllerIn(themeEnv());
    const sidePage = themeEnv();
    const sideTheme = themeControllerIn(sidePage);
    const { side } = setup();
    const remote = new RemoteSide(() => undefined, { onAppearance: (a) => sideTheme.adopt(a) });
    main.chooseStyle("pixel");
    main.choose("dark");
    remote.receive(JSON.stringify(side.sideView(undefined, main.appearance())));
    expect(sidePage.root).toMatchObject({ "data-style": "pixel", "data-theme": "dark" });
    main.chooseStyle("classic");
    main.choose("system");
    main.chooseAccent("orange");
    remote.receive(JSON.stringify(side.sideView(undefined, main.appearance())));
    expect(sidePage.root).toEqual({ "data-style": "classic", "data-accent": "orange" });
    expect(sidePage.stored.size).toBe(0);
  });

  test("还没收到\"浏览\"页的样子：上下文带一个认不出的浏览器（秘书的网页工具会说浏览器关了）；App 没给对象也不抛", () => {
    const remote = new RemoteSide(() => undefined);
    expect(remote.context()).toEqual({ browser: "b-0000000000000000", page: { title: "", url: "" } });
    expect(() => remote.setOpen(false)).not.toThrow();
  });
});

describe("按编号填字、交文件（184 号票）", () => {
  const STUDIO = { title: "换背景", url: "https://studio.example.cn/app/bg" };
  const PROMPT: PageField = { id: "f3", kind: "textarea", label: "提示词" };
  const PRODUCT: PageField = { id: "f7", kind: "file", label: "产品图" };
  const FILE = { token: "t-1", name: "mug.png", mime: "image/png", size: 3, image: true };

  test("按编号填：页面桥找到文本框（核对还是那一页、编号认得、种类没变）再照它的框编号填，不看选中的框；找不到回页面桥的原因；旧版 App、页面桥不在回原因", async () => {
    const { side, fake, replies } = setup();
    fake.state.selected = NAME;
    fake.state.refField = { ok: true, page: STUDIO, field: PROMPT };
    await side.handle({ id: "a", op: "fill", ref: "e4", url: STUDIO.url, text: "海边，黄昏" });
    fake.state.refField = { ok: false, reason: "e1 不是文本框，不能填字" };
    await side.handle({ id: "b", op: "fill", ref: "e1", url: STUDIO.url, text: "x" });
    fake.state.refField = "old";
    await side.handle({ id: "c", op: "fill", ref: "e4", url: STUDIO.url, text: "x" });
    fake.state.refField = undefined;
    await side.handle({ id: "d", op: "fill", ref: "e4", url: STUDIO.url, text: "x" });
    expect(fake.calls).toEqual([
      `refField e4 ${STUDIO.url} textbox`,
      "fill f3 海边，黄昏",
      `refField e1 ${STUDIO.url} textbox`,
      `refField e4 ${STUDIO.url} textbox`,
      `refField e4 ${STUDIO.url} textbox`,
    ]);
    expect(replies.map((r) => [r.id, r.outcome.ok ? "ok" : r.outcome.reason])).toEqual([
      ["a", "ok"],
      ["b", "e1 不是文本框，不能填字"],
      ["c", "这台设备上的二狗 App 太旧，装新版才能按编号填字、交文件"],
      ["d", expect.stringContaining("页面桥不在")],
    ]);
  });

  test("按编号交文件：先找上传框（找不到不取字节），再取字节、按编号交（交之前页面桥再核对一次）", async () => {
    const { side, fake, replies, fetched } = setup();
    fake.state.refField = { ok: false, reason: "网页换了，编号对不上了" };
    await side.handle({ id: "a", op: "attach", ref: "e2", url: STUDIO.url, files: [FILE] });
    expect(fetched).toEqual([]);
    fake.state.refField = "old";
    await side.handle({ id: "b", op: "attach", ref: "e2", url: STUDIO.url, files: [FILE] });
    fake.state.refField = { ok: true, page: STUDIO, field: PRODUCT };
    await side.handle({ id: "c", op: "attach", ref: "e2", url: STUDIO.url, files: [FILE] });
    expect(fetched).toEqual(["t-1"]);
    expect(fake.calls.filter((c) => !c.startsWith("put"))).toEqual([
      `refField e2 ${STUDIO.url} upload`,
      `refField e2 ${STUDIO.url} upload`,
      `refField e2 ${STUDIO.url} upload`,
      `deliver e2@${STUDIO.url} mug.png`,
    ]);
    expect(replies.map((r) => [r.id, r.outcome.ok ? `ok ${r.outcome.count}` : r.outcome.reason])).toEqual([
      ["a", "网页换了，编号对不上了"],
      ["b", "这台设备上的二狗 App 太旧，装新版才能按编号填字、交文件"],
      ["c", "ok 1"],
    ]);
  });
});
