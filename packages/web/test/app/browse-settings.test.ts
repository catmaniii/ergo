// 165 号票：浏览记录的删、多选删、清空、清一个网站的，按网站记住的文字大小和桌面版——记在这台设备上的那一半
// （app/browse-settings.ts，存储换成假的）。
import { describe, expect, test } from "vitest";
import { browseSettingsIn } from "../../src/app/browse-settings.ts";

function fakeStorage() {
  const store = new Map<string, string>();
  return { store, storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
}

describe("浏览记录", () => {
  test("删几条（一条、多选的几条）：记进存储、通知界面；删的不再出现（地址栏的候选也从这里取）", () => {
    const { store, storage } = fakeStorage();
    let t = 1;
    const settings = browseSettingsIn(() => storage, () => t++);
    for (const url of ["https://a.com/", "https://b.com/", "https://c.com/"]) settings.visited(url, "");
    let changed = 0;
    settings.subscribe(() => changed++);
    settings.removeVisits(["https://b.com/"]);
    expect(settings.recents().map((v) => v.url)).toEqual(["https://c.com/", "https://a.com/"]);
    settings.removeVisits(new Set(["https://a.com/", "https://c.com/"]));
    expect(settings.recents()).toEqual([]);
    expect(changed).toBe(2);
    // 删不存在的不通知
    settings.removeVisits(["https://z.com/"]);
    expect(changed).toBe(2);
    expect(browseSettingsIn(() => storage).recents()).toEqual([]);
    expect(store.has("ergo-browse-recents")).toBe(false);
  });

  test("清一个网站的（清除浏览数据选'只清当前网站'）", () => {
    const { storage } = fakeStorage();
    const settings = browseSettingsIn(() => storage);
    settings.visited("https://www.zhihu.com/q/1", "知乎");
    settings.visited("https://b.com/", "");
    settings.visited("http://www.zhihu.com/", "");
    settings.removeSiteVisits("www.zhihu.com");
    expect(settings.recents().map((v) => v.url)).toEqual(["https://b.com/"]);
  });
});

describe("按网站记住的文字大小、桌面版", () => {
  test("改了记进存储（按主机名）、通知界面；默认值不记；下次打开照旧", () => {
    const { store, storage } = fakeStorage();
    const settings = browseSettingsIn(() => storage);
    let changed = 0;
    settings.subscribe(() => changed++);
    settings.setSiteZoom("a.com", 120);
    settings.setSiteDesktop("a.com", true);
    settings.setSiteDesktop("b.com", true);
    settings.setSiteDesktop("b.com", true);
    expect(changed).toBe(3);
    expect(settings.sites()).toEqual({ "a.com": { zoom: 120, desktop: true }, "b.com": { desktop: true } });
    expect(JSON.parse(store.get("ergo-browse-sites")!)).toEqual({ "a.com": { zoom: 120, desktop: true }, "b.com": { desktop: true } });
    expect(browseSettingsIn(() => storage).sites()).toEqual(settings.sites());
    settings.setSiteZoom("a.com", 100);
    settings.setSiteDesktop("a.com", false);
    settings.setSiteDesktop("b.com", false);
    expect(settings.sites()).toEqual({});
    expect(store.has("ergo-browse-sites")).toBe(false);
  });

  test("存储用不了：这次打开里照样生效，不抛错", () => {
    const broken = browseSettingsIn(() => {
      throw new Error("SecurityError");
    });
    expect(broken.sites()).toEqual({});
    expect(() => broken.setSiteZoom("a.com", 150)).not.toThrow();
    expect(broken.sites()).toEqual({ "a.com": { zoom: 150 } });
    expect(() => broken.removeVisits(["https://a.com/"])).not.toThrow();
  });
});
