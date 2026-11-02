// 这份页面是哪一种（app/prototype-mode.ts）：假数据只看构建（`--mode demo`），不看地址；
// 安装版被直接打开（file://）时不是原型，只说一句要经二狗打开，语言跟系统。
import { describe, expect, test } from "vitest";
import { DEMO_BUILD_MODE, isPrototypePage, openedWithoutDaemon, systemLanguage } from "../../src/app/prototype-mode.ts";

describe("页面用不用原型的假数据", () => {
  test("演示页那份构建：不管怎么打开都是原型，不去连守护进程", () => {
    expect(DEMO_BUILD_MODE).toBe("demo");
    expect(isPrototypePage("demo")).toBe(true);
    expect(openedWithoutDaemon("file:", "demo")).toBe(false);
    expect(openedWithoutDaemon("https:", "demo")).toBe(false);
  });

  test("安装版：永远不用假数据", () => {
    expect(isPrototypePage("production")).toBe(false);
    expect(isPrototypePage(undefined)).toBe(false);
  });

  test("安装版由守护进程提供（本机 http、外网 https）：照常连守护进程", () => {
    expect(openedWithoutDaemon("http:", "production")).toBe(false);
    expect(openedWithoutDaemon("https:", "production")).toBe(false);
  });

  test("安装版被直接打开（file://）：没有守护进程可连", () => {
    expect(openedWithoutDaemon("file:", "production")).toBe(true);
    expect(openedWithoutDaemon("file:", undefined)).toBe(true);
  });
});

describe("安装版被直接打开时的语言跟系统", () => {
  test("中文的系统用中文，别的都用英文", () => {
    expect(systemLanguage("zh-CN")).toBe("zh-CN");
    expect(systemLanguage("zh-TW")).toBe("zh-CN");
    expect(systemLanguage("ZH")).toBe("zh-CN");
    expect(systemLanguage("en-US")).toBe("en");
    expect(systemLanguage("ja")).toBe("en");
    expect(systemLanguage(undefined)).toBe("en");
  });
});
