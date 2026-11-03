// 安卓 App 的"更新"（ui/app-update.tsx，票 399）：每一步、每个没装上的原因中英文都有一句话；
// 不在新版 App 里（旧版 App、浏览器）时按钮是从二狗直接下载安装包的链接，文件名带版本、.apk 结尾。
// 新版 App 里点了之后的走一遍在模拟器联调 frontend/android/e2e/app-update.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import { APP_UPDATE_FAILURES, type AppUpdateProgress } from "../../src/app/native-app-update.ts";
import { activeLocale, activeLocaleFrom, HTTP_PATHS, setActiveLocale } from "../../src/state/index.ts";
import { AppUpdateAction, appUpdateText } from "../../src/ui/app-update.tsx";
import { TEST_LOCALES } from "../setup-locales.ts";

const before = activeLocale();
afterEach(() => setActiveLocale(before));

const PKG = { version: "0.4.3", code: 1003, sha256: "a".repeat(64), size: 3 };

const all: AppUpdateProgress[] = [
  { state: "downloading" },
  { state: "downloading", percent: 42 },
  { state: "authorizing" },
  { state: "confirming" },
  { state: "installing" },
  { state: "installed" },
  ...APP_UPDATE_FAILURES.map((reason) => ({ state: "failed", reason }) as const),
  { state: "failed", reason: "failed", detail: "INSTALL_FAILED_X" },
];

describe("更新走到哪一步的那句话", () => {
  test.each([["zh-CN"], ["en"]])("%s：每一步、每个原因都有，不是 key 本身", (lang) => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, lang));
    const texts = all.map(appUpdateText);
    for (const text of texts) {
      expect(text).not.toMatch(/^ui\./);
      expect(text.length).toBeGreaterThan(0);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  test("百分比、系统的话写进去", () => {
    expect(appUpdateText({ state: "downloading", percent: 42 })).toContain("42%");
    expect(appUpdateText({ state: "failed", reason: "failed", detail: "INSTALL_FAILED_X" })).toContain("INSTALL_FAILED_X");
    expect(appUpdateText({ state: "failed", reason: "signature" })).toContain("签名");
  });
});

describe("不在新版 App 里", () => {
  test("按钮是从二狗直接下载安装包的链接：同来源的地址，文件名带版本、.apk 结尾", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateAction, { pkg: PKG }));
    expect(html).toContain(`href="${HTTP_PATHS.androidAppPackage}"`);
    expect(html).toContain('download="ergo-android-0.4.3.apk"');
    expect(html).toContain(">更新<");
    expect(html).not.toContain("target=");
  });
});
