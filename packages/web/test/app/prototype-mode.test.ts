// 页面用不用原型的假数据（316 号票，app/prototype-mode.ts）：直接打开构建产物（file://）和在线演示页那份构建（`--mode demo`，
// 放在 GitHub Pages 上是 https）用；守护进程提供的页面（本机 http、外网 https）照常连守护进程。
import { describe, expect, test } from "vitest";
import { DEMO_BUILD_MODE, isPrototypePage } from "../../src/app/prototype-mode.ts";

describe("页面用不用原型的假数据", () => {
  test("直接打开构建产物（file://）：不管哪份构建都是原型", () => {
    expect(isPrototypePage("file:", "production")).toBe(true);
    expect(isPrototypePage("file:", DEMO_BUILD_MODE)).toBe(true);
  });

  test("在线演示页那份构建：https、http 上也是原型，不去连守护进程", () => {
    expect(DEMO_BUILD_MODE).toBe("demo");
    expect(isPrototypePage("https:", "demo")).toBe(true);
    expect(isPrototypePage("http:", "demo")).toBe(true);
  });

  test("平常那份构建由守护进程提供（本机 http、外网 https）：连守护进程", () => {
    expect(isPrototypePage("http:", "production")).toBe(false);
    expect(isPrototypePage("https:", "production")).toBe(false);
    expect(isPrototypePage("https:", undefined)).toBe(false);
  });
});
