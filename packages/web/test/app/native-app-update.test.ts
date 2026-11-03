// 在 App 里更新 App（票 399）在网页这一侧：新版安卓 App 的原生桥上有 installAppUpdate，进度经 window.__ergoAppUpdate 推过来；
// App 回的形状不一定对，一律核对；旧版 App 没有这个方法时是 undefined（页面退回成从二狗直接下载）。
import { describe, expect, test } from "vitest";
import { detectNativeApp } from "../../src/app/native-app.ts";
import { type AppUpdateProgress, type AppUpdateScope, parseAppUpdateProgress, wrapNativeAppUpdate } from "../../src/app/native-app-update.ts";

const REQUEST = { url: "https://ergo.example.com/api/app-update/android.apk", sha256: "a".repeat(64), version: "0.4.3", code: 1003, size: 3 };

describe("App 回的进度", () => {
  test("认得的几步", () => {
    expect(parseAppUpdateProgress('{"state":"downloading","percent":37.6}')).toEqual({ state: "downloading", percent: 37 });
    expect(parseAppUpdateProgress('{"state":"downloading","percent":300}')).toEqual({ state: "downloading" });
    expect(parseAppUpdateProgress('{"state":"authorizing"}')).toEqual({ state: "authorizing" });
    expect(parseAppUpdateProgress('{"state":"confirming"}')).toEqual({ state: "confirming" });
    expect(parseAppUpdateProgress('{"state":"installing"}')).toEqual({ state: "installing" });
    expect(parseAppUpdateProgress('{"state":"installed"}')).toEqual({ state: "installed" });
  });

  test("没装上：认得的原因照用，不认得的算别的，系统的话截短", () => {
    expect(parseAppUpdateProgress('{"state":"failed","reason":"signature"}')).toEqual({ state: "failed", reason: "signature" });
    expect(parseAppUpdateProgress('{"state":"failed","reason":"weird","detail":" INSTALL_FAILED_X "}')).toEqual({ state: "failed", reason: "failed", detail: "INSTALL_FAILED_X" });
    expect((parseAppUpdateProgress(JSON.stringify({ state: "failed", reason: "failed", detail: "x".repeat(500) })) as { detail: string }).detail).toHaveLength(200);
  });

  test("形状不对的当没有", () => {
    for (const bad of [undefined, "", "not json", "[]", "null", '{"state":"done"}', 42]) expect(parseAppUpdateProgress(bad)).toBeUndefined();
  });
});

describe("包装原生桥", () => {
  test("旧版 App 没有这个方法：没有", () => {
    expect(wrapNativeAppUpdate({ appVersion: () => "0.4.2" }, {})).toBeUndefined();
  });

  test("交给 App 的是要装的那个包；一路的进度交给页面；回最后一步；结束后撤掉推进度的函数", async () => {
    const scope: AppUpdateScope = {};
    let sent: unknown;
    const bridge = {
      installAppUpdate(json: string) {
        sent = JSON.parse(json);
        scope.__ergoAppUpdate!('{"state":"downloading","percent":50}');
        scope.__ergoAppUpdate!('{"state":"authorizing"}');
        scope.__ergoAppUpdate!("乱推的");
        return Promise.resolve('{"state":"failed","reason":"cancelled"}');
      },
    };
    const progress: AppUpdateProgress[] = [];
    const update = wrapNativeAppUpdate(bridge, scope)!;
    const result = await update.install(REQUEST, (p) => progress.push(p));
    expect(sent).toEqual(REQUEST);
    expect(progress).toEqual([{ state: "downloading", percent: 50 }, { state: "authorizing" }]);
    expect(result).toEqual({ state: "failed", reason: "cancelled" });
    expect(scope.__ergoAppUpdate).toBeUndefined();
  });

  test("App 回的不对、抛错：算没装上", async () => {
    expect(await wrapNativeAppUpdate({ installAppUpdate: () => Promise.resolve("") }, {})!.install(REQUEST, () => {})).toEqual({ state: "failed", reason: "failed" });
    const thrown = await wrapNativeAppUpdate(
      {
        installAppUpdate: () => {
          throw new Error("bridge gone");
        },
      },
      {},
    )!.install(REQUEST, () => {});
    expect(thrown).toEqual({ state: "failed", reason: "failed", detail: "bridge gone" });
  });

  test("认 App 时一起认：新版安卓 App 有 appUpdate，旧版没有", () => {
    const ua = { navigator: { userAgent: "Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64; wv)" } };
    const fresh = detectNativeApp({ ...ua, ergoNative: { appVersion: () => "0.4.3", installAppUpdate: () => Promise.resolve("") } });
    expect(fresh?.appUpdate).toBeDefined();
    const old = detectNativeApp({ ...ua, ergoNative: { appVersion: () => "0.4.2" } });
    expect(old).toBeDefined();
    expect(old?.appUpdate).toBeUndefined();
  });
});
