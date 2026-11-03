// 主切面：手机 App 的更新（票 399）。二狗带着同一版的安卓安装包（程序目录的 downloads/），GET /api/app-update 说是哪一版，
// GET /api/app-update/android.apk 发安装包本身：类型是安卓安装包、文件名 .apk 结尾、带长度，版本和 SHA-256 也在响应头里。
// 外网端口上要设备凭证，没配对的拒；本机端口直接给。没带安装包时说没有。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ANDROID_PACKAGE_MIME, APP_PACKAGE_HEADERS, type AppUpdateView, CHANNELS, HTTP_PATHS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { httpRequest } from "../helpers/browser-http.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice, TestDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const BODY = "fake android package body";
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/** 摆好的版本目录那样：downloads/ 里的安装包和 ergo-android.json */
function programWithApk(): string {
  const dir = makeTempDir("ergo-program-");
  fs.mkdirSync(path.join(dir, "downloads"));
  fs.writeFileSync(path.join(dir, "downloads", "ergo-android-debug.apk"), BODY);
  fs.writeFileSync(path.join(dir, "downloads", "ergo-android.json"), JSON.stringify({ version: "0.4.3", code: 1003 }));
  return dir;
}

describe("手机 App 的更新：二狗发安卓安装包", () => {
  it("配对了的设备：问得到是哪一版，下得到安装包（类型、文件名、长度、版本和校验值的响应头）", async () => {
    const test = await startTestDaemon({ programDir: programWithApk() });
    const pc = await TestFrontend.connect(test.url);
    await pc.subscribe({ [CHANNELS.cards]: 0 });
    const phone = await pairDevice(test.externalUrl, pc, { name: "我的手机" });

    const view = await phone.request(HTTP_PATHS.appUpdate);
    expect(view.status).toBe(200);
    expect(view.json<AppUpdateView>()).toEqual({ android: { version: "0.4.3", code: 1003, sha256: sha(BODY), size: BODY.length } });

    const apk = await phone.request(HTTP_PATHS.androidAppPackage);
    expect(apk.status).toBe(200);
    expect(apk.body).toBe(BODY);
    expect(apk.headers["content-type"]).toBe(ANDROID_PACKAGE_MIME);
    expect(apk.headers["content-length"]).toBe(String(BODY.length));
    expect(apk.headers["content-disposition"]).toMatch(/^attachment; filename="ergo-android-0\.4\.3\.apk"/);
    expect(apk.headers[APP_PACKAGE_HEADERS.version.toLowerCase()]).toBe("0.4.3");
    expect(apk.headers[APP_PACKAGE_HEADERS.code.toLowerCase()]).toBe("1003");
    expect(apk.headers[APP_PACKAGE_HEADERS.sha256.toLowerCase()]).toBe(sha(BODY));
    expect(apk.headers["cache-control"]).toBe("no-store");

    // HEAD：只有头
    const head = await phone.request(HTTP_PATHS.androidAppPackage, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(String(BODY.length));
  });

  it("没配对的拒：外网端口上不带凭证、带着乱写的凭证都是 401，拿不到安装包", async () => {
    const test = await startTestDaemon({ programDir: programWithApk() });
    const stranger = new TestDevice(test.externalUrl);
    for (const pathname of [HTTP_PATHS.appUpdate, HTTP_PATHS.androidAppPackage]) {
      const res = await stranger.request(pathname);
      expect(res.status).toBe(401);
      expect(res.body).not.toContain(BODY);
    }
    const forged = await httpRequest(test.externalUrl, HTTP_PATHS.androidAppPackage, { headers: { cookie: "__Host-ergo_device=0000" } });
    expect(forged.status).toBe(401);
  });

  it("本机端口（电脑上）直接给", async () => {
    const test = await startTestDaemon({ programDir: programWithApk() });
    const res = await httpRequest(test.url, HTTP_PATHS.androidAppPackage);
    expect(res.status).toBe(200);
    expect(res.body).toBe(BODY);
  });

  it("没带安装包：说没有（页面照旧给发布页的链接），下载地址 404；日志写明为什么", async () => {
    const log: string[] = [];
    const test = await startTestDaemon({ log: (line) => log.push(line) });
    const view = await httpRequest(test.url, HTTP_PATHS.appUpdate);
    expect(view.status).toBe(200);
    expect(view.json<AppUpdateView>()).toEqual({});
    const apk = await httpRequest(test.url, HTTP_PATHS.androidAppPackage);
    expect(apk.status).toBe(404);
    expect(log.some((line) => line.includes("没有安卓安装包"))).toBe(true);
  });
});
