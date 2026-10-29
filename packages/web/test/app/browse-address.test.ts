// "浏览"页签（134 号票）的地址栏和设备设置：打的字变成要打开的网址（app/browse-address.ts）、搜索引擎和最近访问（state/browse.ts、
// app/browse-settings.ts，存储换成假的）。
import { describe, expect, test } from "vitest";
import { addressToUrl } from "../../src/plugins/browsing/browse-address.ts";
import { browseSettingsIn } from "../../src/app/browse-settings.ts";
import { addRecentVisit, BROWSE_HISTORY_MAX, pageCommandLabel, parseRecentVisits, searchEngineOf, shortAddress } from "../../src/state/index.ts";

describe("地址栏：网址直接开，关键词拿搜索引擎搜", () => {
  test.each([
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["HTTP://Example.com", "http://example.com/"],
    ["example.com", "https://example.com/"],
    ["www.baidu.com/s?wd=二狗", "https://www.baidu.com/s?wd=%E4%BA%8C%E7%8B%97"],
    ["sub.example.cn:8443/x", "https://sub.example.cn:8443/x"],
    ["localhost:5173", "http://localhost:5173/"],
    ["192.168.1.8/admin", "http://192.168.1.8/admin"],
    ["例子.中国", "https://xn--fsqu00a.xn--fiqs8s/"],
  ])("%s → %s", (input, url) => {
    expect(addressToUrl(input, "bing")).toBe(url);
  });

  test.each([
    ["周末 杭州 天气", "https://cn.bing.com/search?q=%E5%91%A8%E6%9C%AB%20%E6%9D%AD%E5%B7%9E%20%E5%A4%A9%E6%B0%94"],
    ["二狗", "https://cn.bing.com/search?q=%E4%BA%8C%E7%8B%97"],
    ["1.5", "https://cn.bing.com/search?q=1.5"],
    ["javascript:alert(1)", "https://cn.bing.com/search?q=javascript%3Aalert(1)"],
    ["file:///C:/x", "https://cn.bing.com/search?q=file%3A%2F%2F%2FC%3A%2Fx"],
    ["https://", "https://cn.bing.com/search?q=https%3A%2F%2F"],
  ])("关键词 %s 拿必应搜", (input, url) => {
    expect(addressToUrl(input, "bing")).toBe(url);
  });

  test("换了搜索引擎按它搜；空的不开", () => {
    expect(addressToUrl("天气", "baidu")).toBe("https://www.baidu.com/s?wd=%E5%A4%A9%E6%B0%94");
    expect(addressToUrl("天气", "sogou")).toBe("https://www.sogou.com/web?query=%E5%A4%A9%E6%B0%94");
    expect(addressToUrl("天气", "google")).toBe("https://www.google.com/search?q=%E5%A4%A9%E6%B0%94");
    expect(addressToUrl("   ", "bing")).toBeUndefined();
  });
});

describe("搜索引擎和最近访问", () => {
  test("记住的搜索引擎认不得按默认（必应）", () => {
    expect(searchEngineOf(null)).toBe("bing");
    expect(searchEngineOf("yahoo")).toBe("bing");
    expect(searchEngineOf("baidu")).toBe("baidu");
    expect(searchEngineOf("google")).toBe("google");
  });

  test("最近访问：新的放最前、同一个地址只留一条、没标题留旧的、只记 http(s)、最多 500 条（165 号票起是完整的浏览记录）", () => {
    let list = addRecentVisit([], { url: "https://a.com/", title: "甲", time: 1 });
    list = addRecentVisit(list, { url: "https://b.com/", title: "乙", time: 2 });
    list = addRecentVisit(list, { url: "https://a.com/", title: "", time: 3 });
    expect(list).toEqual([
      { url: "https://a.com/", title: "甲", time: 3 },
      { url: "https://b.com/", title: "乙", time: 2 },
    ]);
    expect(addRecentVisit(list, { url: "about:blank", title: "", time: 4 })).toEqual(list);
    let many = list;
    for (let i = 0; i < 510; i++) many = addRecentVisit(many, { url: `https://x${i}.com/`, title: "", time: 10 + i });
    expect(many).toHaveLength(BROWSE_HISTORY_MAX);
    expect(many[0]!.url).toBe("https://x509.com/");
  });

  test("记住的最近访问认不得的条目丢掉；列表里的地址去掉 https:// 和末尾的斜杠", () => {
    expect(parseRecentVisits('[{"url":"https://a.com/","title":"甲","time":1},{"url":"javascript:1","title":"","time":2},5]')).toEqual([{ url: "https://a.com/", title: "甲", time: 1 }]);
    expect(parseRecentVisits("坏的")).toEqual([]);
    expect(shortAddress("https://a.com/")).toBe("a.com");
    expect(shortAddress("https://a.com/x/y")).toBe("a.com/x/y");
  });

  test("设备设置：改了记进存储、通知界面；存储用不了时按默认、不抛错", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    let t = 100;
    const settings = browseSettingsIn(() => storage, () => t++);
    let changed = 0;
    settings.subscribe(() => changed++);
    settings.setSearchEngine("baidu");
    settings.visited("https://a.com/", "甲");
    settings.visited("https://a.com/", "甲");
    expect(changed).toBe(2);
    expect(store.get("ergo-search-engine")).toBe("baidu");
    expect(browseSettingsIn(() => storage).recents()).toEqual([{ url: "https://a.com/", title: "甲", time: 100 }]);
    settings.clearRecents();
    expect(store.has("ergo-browse-recents")).toBe(false);
    const broken = browseSettingsIn(() => {
      throw new Error("SecurityError");
    });
    expect(broken.searchEngine()).toBe("bing");
    expect(() => broken.visited("https://a.com/", "")).not.toThrow();
    expect(broken.recents()).toHaveLength(1);
  });
});

describe("秘书会话里网页指令那一句下面的小字（第二部分）", () => {
  test("在哪个网页、哪个框上，说的还是打的；网页没标题写地址", () => {
    expect(pageCommandLabel({ title: "相册 · 上传", url: "https://album.example.cn/upload", field: "标题", spoken: true })).toBe("在网页「相册 · 上传」的「标题」上说");
    expect(pageCommandLabel({ title: " ", url: "https://album.example.cn/upload", field: "" })).toBe("在网页「album.example.cn/upload」的框上打字");
  });
});
