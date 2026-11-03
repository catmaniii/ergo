// 二狗带着的安卓安装包（pairing/app-package.ts，票 399）：版本以 frontend/app-version.json 为准，
// 仓库里 downloads/README.md 写的版本对不上就当没有；摆好的版本目录看 ergo-android.json。SHA-256 文件变了才重算，没带的原因只写一次日志。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppPackages, locateAndroidApp, packagedVersionIn } from "../../src/pairing/app-package.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function put(root: string, rel: string, body: string): void {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** 像仓库那样：frontend/app-version.json、downloads/README.md、downloads/ 里的安装包 */
function repo(appVersion: string, readmeVersion: string | undefined): string {
  const root = makeTempDir("ergo-app-package-");
  dirs.push(root);
  put(root, "frontend/app-version.json", JSON.stringify({ version: appVersion, code: 1003 }));
  put(root, "downloads/README.md", readmeVersion === undefined ? "# 手机安装包\n" : `# 手机安装包 / Phone packages\n\n版本 / Version: ${readmeVersion}\n`);
  put(root, "downloads/ergo-android-debug.apk", "apk v1");
  return root;
}

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

describe("找安卓安装包", () => {
  it("仓库：README 的版本和 App 版本一样就是它，版本、versionCode 取 frontend/app-version.json", () => {
    const root = repo("0.4.3", "0.4.3");
    expect(locateAndroidApp(root)).toEqual({ file: path.join(root, "downloads", "ergo-android-debug.apk"), version: "0.4.3", code: 1003 });
  });

  it("仓库：README 写的版本对不上（升了 App 版本、downloads/ 还没换）、没写版本：当作没有，说清为什么", () => {
    expect(locateAndroidApp(repo("0.4.3", "0.4.2"))).toEqual({ reason: expect.stringContaining("对不上") });
    expect(locateAndroidApp(repo("0.4.3", undefined))).toEqual({ reason: expect.stringContaining("没写版本") });
  });

  it("摆好的版本目录：看 ergo-android.json（摆的时候核过）；写法不对的当没有", () => {
    const root = makeTempDir("ergo-app-package-");
    dirs.push(root);
    put(root, "downloads/ergo-android-debug.apk", "apk");
    put(root, "downloads/ergo-android.json", JSON.stringify({ version: "0.5.0", code: 1010 }));
    expect(locateAndroidApp(root)).toMatchObject({ version: "0.5.0", code: 1010 });
    put(root, "downloads/ergo-android.json", JSON.stringify({ version: "0.5.0" }));
    expect(locateAndroidApp(root)).toEqual({ reason: expect.stringContaining("写法不对") });
  });

  it("没有安装包", () => {
    const root = makeTempDir("ergo-app-package-");
    dirs.push(root);
    expect(locateAndroidApp(root)).toEqual({ reason: expect.stringContaining("没有安卓安装包") });
  });

  it("README 的版本那一行（打包脚本也用它）", () => {
    expect(packagedVersionIn("# x\n\n版本 / Version: 0.4.2\n")).toBe("0.4.2");
    expect(packagedVersionIn("# x\n")).toBeUndefined();
  });
});

describe("问二狗带着哪一版", () => {
  it("给版本、versionCode、大小、SHA-256；文件换了重算", () => {
    const root = repo("0.4.3", "0.4.3");
    const packages = createAppPackages({ programDir: root, log: () => {} });
    expect(packages.view()).toEqual({ android: { version: "0.4.3", code: 1003, size: 6, sha256: sha("apk v1") } });
    const file = path.join(root, "downloads", "ergo-android-debug.apk");
    fs.writeFileSync(file, "apk v2 longer");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(packages.view().android).toMatchObject({ size: 13, sha256: sha("apk v2 longer") });
    expect(packages.android()?.file).toBe(file);
  });

  it("没带：什么都不给；同一个原因日志只写一次", () => {
    const log: string[] = [];
    const packages = createAppPackages({ programDir: repo("0.4.3", "0.4.2"), log: (line) => log.push(line) });
    expect(packages.view()).toEqual({});
    expect(packages.view()).toEqual({});
    expect(packages.android()).toBeUndefined();
    expect(log.filter((line) => line.includes("对不上"))).toHaveLength(1);
  });
});
