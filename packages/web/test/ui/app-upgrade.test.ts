// 手机 App 太旧的提示条：不在 App 里、够新时什么都不画；太旧时写要升到哪一版，安卓给下载链接、鸿蒙给教程，跟着语言。
// 真 Chrome 里（假的 ergoNative、手机宽）的走一遍在 page-opens.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import { activeLocale, activeLocaleFrom, MIN_APP_VERSION, type ReportAppVersionParams, setActiveLocale } from "../../src/state/index.ts";
import { AppUpgradeBar, openUpgradeOutside } from "../../src/ui/app-upgrade.tsx";
import { TEST_LOCALES } from "../setup-locales.ts";

const before = activeLocale();
afterEach(() => setActiveLocale(before));

const bar = (report: ReportAppVersionParams | undefined) => renderToStaticMarkup(createElement(AppUpgradeBar, { report }));

describe("App 太旧的提示条", () => {
  test("不在 App 里：什么都没有", () => {
    expect(bar(undefined)).toBe("");
  });

  test("够新：什么都没有，电脑版升级不等于要升 App", () => {
    expect(bar({ version: MIN_APP_VERSION, platform: "android" })).toBe("");
    expect(bar({ version: "99.0.0", platform: "harmony" })).toBe("");
  });

  test("安卓太旧：写要升到哪一版，按钮是 APK 链接，开新窗口", () => {
    const html = bar({ version: "0.0.1", platform: "android" });
    expect(html).toContain(`二狗 App 需要升级到 ${MIN_APP_VERSION}`);
    expect(html).toMatch(/href="[^"]+\/releases\/latest\/download\/ergo-android-debug\.apk"/);
    expect(html).toContain("下载新版");
    expect(html).toContain('target="_blank"');
  });

  test("不在 App 里画出来的下载链接没有交给系统浏览器的记号（照旧是外链）", () => {
    expect(bar({ version: "0.0.1", platform: "android" })).not.toContain("data-system-browser");
  });

  test("鸿蒙太旧：按钮是手机安装教程", () => {
    const html = bar({ version: "0.0.1", platform: "harmony" });
    expect(html).toContain("mobile.md#鸿蒙-app");
    expect(html).toContain("看安装教程");
  });

  test("读不到版本算最旧", () => {
    expect(bar({ version: "" })).toContain("看安装教程");
  });

  test("英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const android = bar({ version: "0.0.1", platform: "android" });
    expect(android).toContain(`The ergo app needs updating to ${MIN_APP_VERSION}`);
    expect(android).toContain("Download");
    const harmony = bar({ version: "0.0.1", platform: "harmony" });
    expect(harmony).toContain("mobile.en.md#harmonyos-app");
    expect(harmony).toContain("Installation guide");
  });
});

/** 等 App 回话（Promise）之后的那一步 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("去升级的链接交给系统浏览器（新版安卓 App，票 386）", () => {
  const URL = "https://github.com/catmaniii/ergo/releases/latest/download/ergo-android-debug.apk";

  test("App 没有 openSystemBrowser（旧版 App、鸿蒙、不在 App 里）：不管，链接照常", () => {
    const fallback: string[] = [];
    expect(openUpgradeOutside(undefined, URL, (url) => fallback.push(url))).toBe(false);
    expect(openUpgradeOutside({}, URL, (url) => fallback.push(url))).toBe(false);
    expect(fallback).toEqual([]);
  });

  test("有：交给系统浏览器，打开了就完了", async () => {
    const opened: string[] = [];
    const fallback: string[] = [];
    const app = {
      openSystemBrowser: (url: string) => {
        opened.push(url);
        return Promise.resolve(true);
      },
    };
    expect(openUpgradeOutside(app, URL, (url) => fallback.push(url))).toBe(true);
    await flush();
    expect(opened).toEqual([URL]);
    expect(fallback).toEqual([]);
  });

  test("系统浏览器打不开（手机上没有浏览器、App 出错）：退回成照旧打开", async () => {
    const fallback: string[] = [];
    expect(openUpgradeOutside({ openSystemBrowser: () => Promise.resolve(false) }, URL, (url) => fallback.push(url))).toBe(true);
    await flush();
    expect(fallback).toEqual([URL]);
  });
});
