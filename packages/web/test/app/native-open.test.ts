// 核心留给浏览插件的口子（212 号票，app/native-open.ts）：132 号票的内置浏览器在鸿蒙 App 里改开原生浏览器，
// 浏览插件装上时登记打开的办法，停用时撤掉；没登记时返回 false，调用方照旧（嵌入框叠层、外部网站新开窗口）。
import { describe, expect, test } from "vitest";
import { openInPageNativeBrowser, setPageNativeOpener } from "../../src/app/native-open.ts";

describe("核心留的口子：在 App 的原生浏览器里打开", () => {
  test("没登记（不在 App 里、浏览插件没启用）：返回 false", () => {
    expect(openInPageNativeBrowser("https://example.org/")).toBe(false);
  });

  test("登记了就交给它；撤销后又是 false；后登记的盖掉先登记的，先登记的撤销不影响后登记的", () => {
    const opened: string[] = [];
    const undo = setPageNativeOpener((url) => (opened.push(url), true));
    expect(openInPageNativeBrowser("https://a.example/")).toBe(true);
    const undo2 = setPageNativeOpener((url) => (opened.push(`2:${url}`), true));
    expect(openInPageNativeBrowser("https://b.example/")).toBe(true);
    undo();
    expect(openInPageNativeBrowser("https://c.example/")).toBe(true);
    undo2();
    expect(openInPageNativeBrowser("https://d.example/")).toBe(false);
    expect(opened).toEqual(["https://a.example/", "2:https://b.example/", "2:https://c.example/"]);
  });
});
