// 用手机地图导航在网页这一侧的原生那一半（434）：新版鸿蒙 App 的原生桥上有 openNavigation 时，NativeApp.navigation 是它的包装，
// 交过去的是坐标（数）、名字和走法（字），App 回 "ok" 才算拉起了系统面板；旧版 App 没有这个方法。原生桥换成假的。
import { describe, expect, test } from "vitest";
import { detectNativeApp } from "../../src/app/native-app.ts";
import { NATIVE_NAVIGATION_METHOD, wrapNativeNavigation } from "../../src/app/native-navigation.ts";

describe("原生桥上的 openNavigation", () => {
  test("有这个方法：交坐标、名字（没有给空串）、走法（没有当开车）；回 ok 是 true，别的、拒绝了（空串）、出错都是 false", async () => {
    const calls: unknown[][] = [];
    let answer: unknown = "ok";
    const bridge = { [NATIVE_NAVIGATION_METHOD]: (...args: unknown[]) => (calls.push(args), Promise.resolve(answer)) };
    const nav = wrapNativeNavigation(bridge)!;
    expect(await nav({ lat: 30.25, lon: 120.15, name: "西湖边", mode: "walking" })).toBe(true);
    expect(await nav({ lat: 1.28, lon: 103.84 })).toBe(true);
    expect(calls).toEqual([
      [30.25, 120.15, "西湖边", "walking"],
      [1.28, 103.84, "", "driving"],
    ]);
    answer = "failed:16000050";
    expect(await nav({ lat: 30.25, lon: 120.15 })).toBe(false);
    answer = "";
    expect(await nav({ lat: 30.25, lon: 120.15 })).toBe(false);
    const throwing = wrapNativeNavigation({ [NATIVE_NAVIGATION_METHOD]: () => Promise.reject(new Error("boom")) })!;
    expect(await throwing({ lat: 30.25, lon: 120.15 })).toBe(false);
  });

  test("认出新旧 App：有 openNavigation 的 NativeApp.navigation 在，旧版 App（和安卓 App）没有", () => {
    const base = { appVersion: () => "0.4.4" };
    expect(detectNativeApp({ ergoNative: { ...base, openNavigation: () => Promise.resolve("ok") } })?.navigation).toBeTypeOf("function");
    expect(detectNativeApp({ ergoNative: base })?.navigation).toBeUndefined();
    expect(wrapNativeNavigation({})).toBeUndefined();
  });
});
