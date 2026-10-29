// 165 号票："浏览"页签右上角 ⋮ 菜单的纯函数（state/browse-tools.ts）：菜单项能不能用、按网站记住的文字大小和桌面版、
// 浏览记录的删、清空、按日期分组、搜，查找栏的计数，下载记录存在哪，清除浏览数据怎么分给 App 和网页。
import { describe, expect, test } from "vitest";
import {
  addRecentVisit,
  BROWSE_DISABLED,
  BROWSE_HISTORY_MAX,
  browseMenu,
  type BrowseMenuInput,
  clearPlan,
  desktopUserAgent,
  downloadWhere,
  filterVisits,
  findCountLabel,
  historyGroups,
  parseRecentVisits,
  parseSiteSettings,
  RECENTS_SHOWN,
  type RecentVisit,
  removeSiteVisits,
  removeVisits,
  siteDesktopOf,
  siteKeyOf,
  siteTuning,
  siteZoomOf,
  stepTextZoom,
  TEXT_ZOOM,
  visitTimeLabel,
  withSiteSetting,
} from "../../src/state/index.ts";

const visit = (url: string, time: number, title = ""): RecentVisit => ({ url, title, time });
/** 2026 年 10 月某天某时（本地时间） */
const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).getTime();
/** 菜单里的每一项（不分组） */
const flat = (input: BrowseMenuInput) => browseMenu(input).flatMap((g) => g.items);
/** 菜单里的一项 */
const item = (input: BrowseMenuInput, id: string) => flat(input).find((i) => i.id === id)!;

describe("浏览记录：删一条、多选删、清当前网站、按日期分组、搜", () => {
  test("完整的浏览记录最多记 500 条（原来最近访问只记 20 条）；空白页列前 20 条", () => {
    let many: RecentVisit[] = [];
    for (let i = 0; i < 520; i++) many = addRecentVisit(many, visit(`https://x${i}.com/`, i));
    expect(many).toHaveLength(BROWSE_HISTORY_MAX);
    expect(BROWSE_HISTORY_MAX).toBe(500);
    expect(RECENTS_SHOWN).toBe(20);
    expect(parseRecentVisits(JSON.stringify(many))).toHaveLength(500);
  });

  test("删几条（按地址）：别的不动、先后不变；删不存在的不变", () => {
    const list = [visit("https://a.com/", 3), visit("https://b.com/", 2), visit("https://c.com/", 1)];
    expect(removeVisits(list, ["https://b.com/"])).toEqual([list[0], list[2]]);
    expect(removeVisits(list, new Set(["https://a.com/", "https://c.com/"]))).toEqual([list[1]]);
    expect(removeVisits(list, ["https://z.com/"])).toEqual(list);
  });

  test("清当前网站的：主机名一样的都删（不分路径、http 和 https）", () => {
    const list = [visit("https://www.zhihu.com/q/1", 4), visit("http://www.zhihu.com/", 3), visit("https://zhihu.com/", 2), visit("https://b.com/", 1)];
    expect(removeSiteVisits(list, "www.zhihu.com").map((v) => v.url)).toEqual(["https://zhihu.com/", "https://b.com/"]);
  });

  test("搜：地址或标题里有（不分大小写）；空的不过滤", () => {
    const list = [visit("https://Example.com/news", 2, "今日新闻"), visit("https://b.com/", 1, "Bing")];
    expect(filterVisits(list, "example")).toEqual([list[0]]);
    expect(filterVisits(list, "  新闻 ")).toEqual([list[0]]);
    expect(filterVisits(list, "BING")).toEqual([list[1]]);
    expect(filterVisits(list, "  ")).toEqual(list);
  });

  test("按日期分组：今天、昨天、更早（按本地日期；没有的组不出现；组里新的在前）", () => {
    const now = new Date(2026, 9, 19, 15, 30).getTime();
    const list = [visit("https://a.com/", at(19, 9)), visit("https://y.com/", at(18, 23)), visit("https://t.com/", at(19, 14)), visit("https://o.com/", at(10, 8))];
    const groups = historyGroups(list, now);
    expect(groups.map((g) => [g.label, g.visits.map((v) => v.url)])).toEqual([
      ["今天", ["https://t.com/", "https://a.com/"]],
      ["昨天", ["https://y.com/"]],
      ["更早", ["https://o.com/"]],
    ]);
    expect(historyGroups([visit("https://o.com/", at(1, 1))], now).map((g) => g.label)).toEqual(["更早"]);
    expect(historyGroups([], now)).toEqual([]);
  });

  test("一条的时间：今天、昨天写时分，更早写月日，不是今年的带年份", () => {
    const now = new Date(2026, 9, 19, 15, 30).getTime();
    expect(visitTimeLabel(new Date(2026, 9, 19, 9, 5).getTime(), now)).toBe("09:05");
    expect(visitTimeLabel(new Date(2026, 9, 18, 23, 40).getTime(), now)).toBe("23:40");
    expect(visitTimeLabel(new Date(2026, 9, 2, 8, 0).getTime(), now)).toBe("10-02");
    expect(visitTimeLabel(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe("2025-12-31");
  });
});

describe("按网站记住的文字大小、桌面版", () => {
  test("网站按主机名认（小写）；不是 http(s) 的没有", () => {
    expect(siteKeyOf("https://WWW.Zhihu.com/question/1?x=1")).toBe("www.zhihu.com");
    expect(siteKeyOf("http://192.168.1.8:8080/a")).toBe("192.168.1.8");
    expect(siteKeyOf("about:blank")).toBeUndefined();
    expect(siteKeyOf("")).toBeUndefined();
  });

  test("文字大小 50%–200%，每次 10%；夹在范围里", () => {
    expect(TEXT_ZOOM).toEqual({ min: 50, max: 200, step: 10, normal: 100 });
    expect(stepTextZoom(100, 1)).toBe(110);
    expect(stepTextZoom(100, -1)).toBe(90);
    expect(stepTextZoom(200, 1)).toBe(200);
    expect(stepTextZoom(50, -1)).toBe(50);
    expect(stepTextZoom(115, 1)).toBe(120);
    expect(stepTextZoom(115, -1)).toBe(110);
  });

  test("记住一个网站的：默认值不记（文字 100%、不是桌面版），一项都不剩就整条去掉；别的网站不动", () => {
    let sites = withSiteSetting({}, "a.com", { zoom: 120 });
    sites = withSiteSetting(sites, "a.com", { desktop: true });
    sites = withSiteSetting(sites, "b.com", { desktop: true });
    expect(sites).toEqual({ "a.com": { zoom: 120, desktop: true }, "b.com": { desktop: true } });
    expect(siteZoomOf(sites, "https://a.com/x")).toBe(120);
    expect(siteZoomOf(sites, "https://c.com/")).toBe(100);
    expect(siteDesktopOf(sites, "https://b.com/")).toBe(true);
    expect(siteDesktopOf(sites, "https://a.com/")).toBe(true);
    expect(siteDesktopOf(sites, "")).toBe(false);
    sites = withSiteSetting(sites, "a.com", { zoom: 100 });
    expect(sites["a.com"]).toEqual({ desktop: true });
    sites = withSiteSetting(sites, "a.com", { desktop: false });
    expect(sites).toEqual({ "b.com": { desktop: true } });
    // 超出范围的夹回
    expect(withSiteSetting({}, "a.com", { zoom: 900 })).toEqual({ "a.com": { zoom: 200 } });
  });

  test("记住的值认不得的丢掉：不是对象、主机名不像、文字大小不是数、桌面版不是 true", () => {
    expect(parseSiteSettings(JSON.stringify({ "a.com": { zoom: 130 }, "b.com": { desktop: true, zoom: "x" }, "c.com": { desktop: 1 }, "bad host!": { zoom: 120 }, "d.com": 5 }))).toEqual({
      "a.com": { zoom: 130 },
      "b.com": { desktop: true },
    });
    expect(parseSiteSettings("坏的")).toEqual({});
    expect(parseSiteSettings(null)).toEqual({});
    expect(parseSiteSettings("[]")).toEqual({});
  });

  test("交给 App 的：桌面版的浏览器标识、哪些网站用桌面版、哪些网站的文字大小", () => {
    const sites = { "a.com": { zoom: 120, desktop: true as const }, "b.com": { desktop: true as const }, "c.com": { zoom: 80 } };
    expect(siteTuning(sites, "UA")).toEqual({ desktopUserAgent: "UA", desktop: ["a.com", "b.com"], zoom: { "a.com": 120, "c.com": 80 } });
  });

  test("桌面版的浏览器标识：照手机的标识换成电脑的（Windows），Chrome 版本照旧，去掉 Mobile；认不出版本用一个常见的", () => {
    const phone = "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36  ArkWeb/4.1.6.1 Mobile";
    const desktop = desktopUserAgent(phone);
    expect(desktop).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36");
    expect(desktop).not.toMatch(/Mobile|Phone|OpenHarmony/);
    expect(desktopUserAgent("奇怪的标识")).toMatch(/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  });
});

describe("⋮ 菜单：分组、能不能用", () => {
  const base: BrowseMenuInput = {
    url: "https://news.example.com/a",
    title: "新闻",
    side: true,
    text: true,
    tools: true,
    sites: {},
    ownOrigin: "https://ergo.example.sslip.io",
  };

  test("三组十项，顺序照用户选定的", () => {
    const groups = browseMenu(base);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([
      ["summarize", "save"],
      ["find", "zoom", "desktop", "share", "outside"],
      ["history", "downloads", "clear"],
    ]);
    expect(flat(base).map((i) => i.label)).toEqual(["让二狗总结这一页", "存进二狗的素材", "在页面里查找", "文字大小", "桌面版网站", "分享", "用系统浏览器打开", "浏览记录", "下载记录", "清除浏览数据"]);
    expect(flat(base).every((i) => i.disabled === undefined)).toBe(true);
  });

  test("还没打开网页：和这一页有关的灰掉，记录和数据照样能用", () => {
    const blank = { ...base, url: "", title: "" };
    const off = flat(blank).filter((i) => i.disabled !== undefined).map((i) => i.id);
    expect(off).toEqual(["summarize", "save", "find", "zoom", "desktop", "share", "outside"]);
    expect(item(blank, "find").disabled).toBe("还没打开网页");
  });

  test("旧版 App：原生做不了的灰掉并写'装新版 App 才能用'；清除浏览数据照样能点（浏览记录在网页里清）", () => {
    const old = { ...base, tools: false, side: false, text: false };
    const off = flat(old).filter((i) => i.disabled === BROWSE_DISABLED.needsNewApp).map((i) => i.id);
    expect(off).toEqual(["summarize", "save", "find", "zoom", "desktop", "share", "downloads"]);
    expect(item(old, "outside").disabled).toBeUndefined();
    expect(item(old, "history").disabled).toBeUndefined();
    expect(item(old, "clear").disabled).toBeUndefined();
  });

  test("文字大小那一行带现在的大小、能不能再小再大；桌面版带勾；按这一页的网站", () => {
    const sites = withSiteSetting(withSiteSetting({}, "news.example.com", { zoom: 200 }), "news.example.com", { desktop: true });
    const zoom = item({ ...base, sites }, "zoom");
    expect(zoom.zoom).toEqual({ value: 200, down: true, up: false });
    expect(item({ ...base, sites }, "desktop").checked).toBe(true);
    expect(item(base, "desktop").checked).toBe(false);
    expect(item(base, "zoom").zoom).toEqual({ value: 100, down: true, up: true });
  });

  test("二狗自己的页面（转发的服务）不分桌面版", () => {
    expect(item({ ...base, url: "https://ergo.example.sslip.io/apps/demo/" }, "desktop").disabled).toBe("二狗自己的页面不分桌面版");
  });
});

describe("查找栏的计数", () => {
  test("第 n / 共 m 个；没找到；还在数；没打字不写", () => {
    expect(findCountLabel("新闻", { active: 0, total: 5, done: true })).toBe("第 1 / 共 5 个");
    expect(findCountLabel("新闻", { active: 4, total: 5, done: true })).toBe("第 5 / 共 5 个");
    expect(findCountLabel("新闻", { active: 0, total: 0, done: true })).toBe("没有找到");
    expect(findCountLabel("新闻", { active: 0, total: 3, done: false })).toBe("第 1 / 共 3 个…");
    expect(findCountLabel("新闻", undefined)).toBe("");
    expect(findCountLabel("", { active: 0, total: 5, done: true })).toBe("");
  });
});

describe("下载记录存在哪", () => {
  test("系统'保存到'给的地址写成用户认得的位置；认不出的照原样解码", () => {
    expect(downloadWhere("file://docs/storage/Users/currentUser/Download/%E6%8A%A5%E5%91%8A.pdf")).toBe("Download/报告.pdf");
    expect(downloadWhere("file://docs/storage/Users/currentUser/Documents/a%20b.txt")).toBe("Documents/a b.txt");
    expect(downloadWhere("file://media/Photo/12/IMG_1.jpg")).toBe("media/Photo/12/IMG_1.jpg");
    expect(downloadWhere("%E5%9D%8F%")).toBe("%E5%9D%8F%");
  });
});

describe("清除浏览数据：哪些交给 App、浏览记录在网页里清", () => {
  test("全部：缓存、Cookie 和网站数据交给 App；浏览记录全清", () => {
    expect(clearPlan({ cache: true, cookies: true, history: true, scope: "all" }, "https://a.com/x")).toEqual({ native: { cache: true, cookies: true, scope: "all", url: "" }, history: { kind: "all" } });
  });

  test("只清当前网站：App 那边带上地址，浏览记录只清这个网站的", () => {
    expect(clearPlan({ cache: false, cookies: true, history: true, scope: "site" }, "https://www.zhihu.com/q/1")).toEqual({
      native: { cache: false, cookies: true, scope: "site", url: "https://www.zhihu.com/q/1" },
      history: { kind: "site", host: "www.zhihu.com" },
    });
  });

  test("只勾浏览记录的不找 App；什么都没勾的什么都不做；没开网页时'只清当前网站'不成立（按全部）", () => {
    expect(clearPlan({ cache: false, cookies: false, history: true, scope: "all" }, "")).toEqual({ history: { kind: "all" } });
    expect(clearPlan({ cache: false, cookies: false, history: false, scope: "all" }, "")).toEqual({});
    expect(clearPlan({ cache: true, cookies: false, history: true, scope: "site" }, "")).toEqual({ native: { cache: true, cookies: false, scope: "all", url: "" }, history: { kind: "all" } });
  });
});
