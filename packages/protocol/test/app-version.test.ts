// 手机 App 的版本：按数字段比，读不到的最旧；从浏览器标识认哪种 App；太旧了去哪升级；报版本的参数怎么校验。
import { describe, expect, test } from "vitest";
import { ANDROID_APP_URL, appOutdatedItemId, appPlatformOf, appUpgradeLink, appVersionOutdated, compareAppVersions, METHODS, MIN_APP_VERSION, parseRequest } from "../src/index.ts";

describe("比版本号", () => {
  test.each([
    ["0.4.1", "0.4.1", 0],
    ["0.4.2", "0.4.1", 1],
    ["0.4.0", "0.4.1", -1],
    // 按数字段比，不按字符串
    ["0.10.0", "0.9.9", 1],
    ["0.9.9", "0.10.0", -1],
    ["1.0.0", "0.99.99", 1],
    // 缺的段算 0
    ["0.4", "0.4.0", 0],
    ["0.4", "0.4.1", -1],
    // 后面带的不看
    ["0.4.1-beta", "0.4.1", 0],
    // 读不到的最旧
    ["", "0.0.1", -1],
    ["乱写的", "0.0.1", -1],
    ["0.0.1", "", 1],
    ["", "乱写的", 0],
  ])("%s 比 %s", (a, b, sign) => {
    expect(Math.sign(compareAppVersions(a, b))).toBe(sign);
  });
});

describe("够不够新", () => {
  test("低于最低版本算太旧，等于、高于都够", () => {
    expect(appVersionOutdated("0.4.0", "0.4.1")).toBe(true);
    expect(appVersionOutdated("0.4.1", "0.4.1")).toBe(false);
    expect(appVersionOutdated("0.10.0", "0.9.0")).toBe(false);
  });

  test("读不到版本的 App 算最旧", () => {
    expect(appVersionOutdated("")).toBe(true);
    expect(appVersionOutdated("没有版本")).toBe(true);
  });

  test("不给要求时按现在的最低版本", () => {
    expect(appVersionOutdated(MIN_APP_VERSION)).toBe(false);
    expect(appVersionOutdated("0.0.1")).toBe(true);
  });

  test("待办的编号：一台设备一个要求一条", () => {
    expect(appOutdatedItemId("d-1", "0.4.1")).not.toBe(appOutdatedItemId("d-1", "0.5.0"));
    expect(appOutdatedItemId("d-1", "0.4.1")).not.toBe(appOutdatedItemId("d-2", "0.4.1"));
  });
});

describe("哪种 App", () => {
  test.each([
    ["鸿蒙", "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile", "harmony"],
    ["安卓", "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36", "android"],
    ["认不出", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", undefined],
    ["没有标识", "", undefined],
  ])("%s", (_name, ua, platform) => {
    expect(appPlatformOf(ua)).toBe(platform);
  });
});

describe("去哪升级", () => {
  test("安卓是 APK 链接", () => {
    expect(appUpgradeLink("android", "zh-CN")).toEqual({ kind: "download", url: ANDROID_APP_URL });
    expect(ANDROID_APP_URL).toMatch(/ergo-android-debug\.apk$/);
  });

  test("安卓走发布页的地址：raw/main 那个回的类型会让已经装好的 App 把安装包存成 .bin", () => {
    expect(ANDROID_APP_URL).toContain("/releases/latest/download/");
    expect(ANDROID_APP_URL).not.toContain("/raw/");
  });

  test("鸿蒙是手机安装教程，跟着语言", () => {
    expect(appUpgradeLink("harmony", "zh-CN")).toEqual({ kind: "guide", url: expect.stringMatching(/docs\/user-guide\/mobile\.md#鸿蒙-app$/) });
    expect(appUpgradeLink("harmony", "en")).toEqual({ kind: "guide", url: expect.stringMatching(/docs\/user-guide\/mobile\.en\.md#harmonyos-app$/) });
  });

  test("认不出哪种 App：去装 App 那一节", () => {
    expect(appUpgradeLink(undefined, "zh-CN").url).toMatch(/mobile\.md#装-app$/);
    expect(appUpgradeLink(undefined, "en").url).toMatch(/mobile\.en\.md#install-the-app$/);
  });
});

const parse = (params: unknown) => parseRequest(JSON.stringify({ id: "r1", method: METHODS.reportAppVersion, params }));

describe("报版本的请求", () => {
  test("不带幂等键；读不到版本报空串也行；哪种 App 可以不写", () => {
    expect(parse({ version: "0.4.2", platform: "android" })).toMatchObject({ ok: true });
    expect(parse({ version: "" })).toMatchObject({ ok: true });
  });

  test("形状不对的不收", () => {
    expect(parse({ version: 1 })).toMatchObject({ ok: false, error: { code: "bad_params" } });
    expect(parse({ version: "0.4.2", platform: "ios" })).toMatchObject({ ok: false, error: { code: "bad_params" } });
    expect(parse({ version: "9".repeat(33) })).toMatchObject({ ok: false, error: { code: "bad_params" } });
  });
});
