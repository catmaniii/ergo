// 浏览侧边栏里点了二狗自己的页面（447，plugins/browsing/side-handoff.ts）：侧边栏那一页记下要去的地址再收起，主页面收到收起时
// 取出、跳过去。只认 #/ 开头的二狗地址、写下后 8 秒以内的，取了就删；点的时候按了 Ctrl / ⌘ / Shift / Alt、不是左键、
// 组件自己处理了的不管。真浏览器里两页一起走一遍在 page-opens.test.ts（"浏览侧边栏里点地图卡片"）。
import { describe, expect, test } from "vitest";
import { isAppHash, SIDE_GOTO_FRESH_MS, SIDE_GOTO_KEY, sideLinkHash, takeSideGoto, writeSideGoto } from "../../src/plugins/browsing/side-handoff.ts";

function memoryStorage() {
  const items = new Map<string, string>();
  return { items, getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
}

const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false };

describe("侧边栏点了二狗自己的页面，交给主页面", () => {
  test("记下、取出：取了就删，再取没有", () => {
    const storage = memoryStorage();
    expect(writeSideGoto(storage, "#/more/map/card/c-map-route", 1000)).toBe(true);
    expect(JSON.parse(storage.items.get(SIDE_GOTO_KEY)!)).toEqual({ hash: "#/more/map/card/c-map-route", at: 1000 });
    expect(takeSideGoto(storage, 1500)).toBe("#/more/map/card/c-map-route");
    expect(storage.items.has(SIDE_GOTO_KEY)).toBe(false);
    expect(takeSideGoto(storage, 1600)).toBeUndefined();
  });

  test("过了时的（上次没取走的残留）、时钟倒着的、写坏的不跳，照样删掉", () => {
    const storage = memoryStorage();
    writeSideGoto(storage, "#/more/map/2026-11-06", 1000);
    expect(takeSideGoto(storage, 1000 + SIDE_GOTO_FRESH_MS + 1)).toBeUndefined();
    expect(storage.items.has(SIDE_GOTO_KEY)).toBe(false);
    writeSideGoto(storage, "#/more/map/2026-11-06", 5000);
    expect(takeSideGoto(storage, 4000)).toBeUndefined();
    for (const raw of ["{", "null", '"#/more/map"', JSON.stringify({ hash: "https://evil.example/", at: 1 }), JSON.stringify({ hash: "#/more/map", at: "1" })]) {
      storage.items.set(SIDE_GOTO_KEY, raw);
      expect(takeSideGoto(storage, 2)).toBeUndefined();
      expect(storage.items.has(SIDE_GOTO_KEY)).toBe(false);
    }
  });

  test("只认二狗自己的地址：#/ 开头、不太长、没有空白", () => {
    expect(isAppHash("#/more/map/card/c-1")).toBe(true);
    expect(isAppHash("#/secretary")).toBe(true);
    for (const bad of ["", "#", "#/", "#more", "/more/map", "https://example.cn/#/x", "#/a b", `#/${"x".repeat(400)}`]) expect(isAppHash(bad)).toBe(false);
    const storage = memoryStorage();
    expect(writeSideGoto(storage, "https://example.cn/", 1)).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  test("存不了（隐私模式）不抛错", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(writeSideGoto(broken, "#/more/map", 1)).toBe(false);
    expect(takeSideGoto(broken, 1)).toBeUndefined();
  });

  test("点的是不是要交出去的链接：左键、没按修饰键、组件没自己处理的 #/ 链接才是", () => {
    expect(sideLinkHash(click, "#/more/map/card/c-map-route")).toBe("#/more/map/card/c-map-route");
    expect(sideLinkHash(click, "https://example.cn/")).toBeUndefined();
    expect(sideLinkHash(click, null)).toBeUndefined();
    expect(sideLinkHash({ ...click, button: 1 }, "#/more/map")).toBeUndefined();
    expect(sideLinkHash({ ...click, ctrlKey: true }, "#/more/map")).toBeUndefined();
    expect(sideLinkHash({ ...click, metaKey: true }, "#/more/map")).toBeUndefined();
    expect(sideLinkHash({ ...click, shiftKey: true }, "#/more/map")).toBeUndefined();
    expect(sideLinkHash({ ...click, altKey: true }, "#/more/map")).toBeUndefined();
    expect(sideLinkHash({ ...click, defaultPrevented: true }, "#/more/map")).toBeUndefined();
  });
});
