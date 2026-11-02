// 手机 App 自己一个版本号（frontend/app-version.json，ADR-0047）：安卓从它读，鸿蒙的 app.json5 读不了外部文件，这里核对几处都和它一致。
// downloads/ 里的包要和它一致：升了 App 版本，把新包放进 downloads/、改 README，一起提交。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compareAppVersions, MIN_APP_VERSION } from "../../packages/protocol/src/app-version.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => readFileSync(path.join(REPO, file), "utf8");
const app = JSON.parse(read("frontend/app-version.json")) as { version: string; code: number };

/** 鸿蒙的 versionCode 的规则：主版本 × 10⁹ + 次版本 × 10⁶ + 修订号 × 10³（0.4.2 是 4002000） */
function harmonyVersionCode(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major * 1e9 + minor * 1e6 + patch * 1e3;
}

describe("手机 App 的版本号", () => {
  test("版本文件：version 是三段数字，code 是正整数", () => {
    expect(app.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.isInteger(app.code) && app.code > 0).toBe(true);
  });

  test("安卓从版本文件读，不写死；读得出 version、code", () => {
    const gradle = read("frontend/android/app/build.gradle.kts");
    expect(gradle).toContain('rootProject.file("../app-version.json")');
    expect(gradle).toContain('versionCode = appVersionField("code").toInt()');
    expect(gradle).toContain('versionName = appVersionField("version")');
    expect(gradle).not.toMatch(/versionName = "/);
    expect(gradle).not.toMatch(/versionCode = \d/);
    // 照 Gradle 脚本里的写法（Kotlin 的字符串转义）读一遍
    const pattern = /Regex\("(.+?)"\)\.find\(appVersionJson\)/.exec(gradle)![1]!;
    const field = (name: string) => new RegExp(pattern.replaceAll("$name", name).replaceAll('\\"', '"').replaceAll("\\\\", "\\")).exec(read("frontend/app-version.json"))?.[1];
    expect(field("version")).toBe(app.version);
    expect(field("code")).toBe(String(app.code));
  });

  test("鸿蒙的 app.json5：versionName 一样，versionCode 按规则算", () => {
    const json5 = read("frontend/harmony/AppScope/app.json5");
    expect(/"versionName":\s*"([^"]+)"/.exec(json5)?.[1]).toBe(app.version);
    expect(Number(/"versionCode":\s*(\d+)/.exec(json5)?.[1])).toBe(harmonyVersionCode(app.version));
  });

  test("规则对得上已经发过的版本", () => {
    expect(harmonyVersionCode("0.4.2")).toBe(4002000);
    expect(harmonyVersionCode("0.2.1")).toBe(2001000);
    expect(harmonyVersionCode("1.0.0")).toBe(1000000000);
  });

  test("模拟器联调核对的版本一样", () => {
    expect(/ergoNative\.appVersion\(\)"\), "([^"]+)"/.exec(read("frontend/android/e2e/run.ts"))?.[1]).toBe(app.version);
  });

  test("downloads/ 里的包是这一版：升了 App 版本要把新包放进去、改 README", () => {
    expect(/^版本 \/ Version:\s*(\S+)/m.exec(read("downloads/README.md"))?.[1]).toBe(app.version);
  });

  test("最低版本不能比现在的 App 还新：要求一个还没发的版本，所有手机都升不上去", () => {
    expect(compareAppVersions(MIN_APP_VERSION, app.version)).toBeLessThanOrEqual(0);
  });
});
