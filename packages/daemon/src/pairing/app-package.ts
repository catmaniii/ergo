// 二狗带着的安卓 App 安装包（票 399）：服务端准备安装包、手机上的 App 从二狗下（GET /api/app-update/android.apk），运行时不去 GitHub。
// 版本以 frontend/app-version.json 为准（version、code）。安装包在程序目录的 downloads/ 下，有两种摆法：
//   - 摆好的版本目录（发布包、源码装、开发模式，build/stage.ts 摆的）：downloads/ergo-android-debug.apk 加一份
//     downloads/ergo-android.json（{ version, code }，摆的时候已经核过版本，发布包还核过签名证书）；
//   - 直接从仓库跑（node packages/daemon/src/main.ts）：仓库的 downloads/ergo-android-debug.apk，版本看 downloads/README.md 写的
//     "版本 / Version"，和 frontend/app-version.json 对不上（比如升了 App 版本、downloads/ 还没换）就当没有，日志写明。
// SHA-256 现算（约 3 MB），文件没变（大小、修改时间）就用上一次的。没有安装包时页面照旧给 GitHub 的链接。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AndroidAppPackage, AppUpdateView } from "@ergo/protocol";

/** downloads/ 下安卓安装包的文件名（和发布附件同名，打包脚本 build/mobile.ts 的 ANDROID_PACKAGE） */
export const ANDROID_APP_FILE = "ergo-android-debug.apk";
/** 摆好的版本目录里，安装包是哪一版（摆的时候写） */
export const ANDROID_APP_DESCRIPTOR = "ergo-android.json";
/** App 自己的版本号文件（相对仓库根目录，ADR-0047） */
export const APP_VERSION_FILE = "frontend/app-version.json";
/** downloads/ 里的包是哪一版 */
export const DOWNLOADS_README = "downloads/README.md";

/** frontend/app-version.json、downloads/ergo-android.json 的样子 */
export interface AppVersionInfo {
  version: string;
  code: number;
}

/** 安装包在哪、是哪一版 */
export interface AndroidAppSource extends AppVersionInfo {
  file: string;
}

/** 二狗带着的安装包，连同大小和 SHA-256 */
export interface BundledAndroidApp extends AndroidAppPackage {
  file: string;
}

/** 读 { version, code }；写法不对是 undefined */
export function readAppVersionInfo(file: string): AppVersionInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as { version?: unknown; code?: unknown };
    if (typeof raw.version !== "string" || raw.version === "" || typeof raw.code !== "number" || !Number.isSafeInteger(raw.code) || raw.code <= 0) return undefined;
    return { version: raw.version, code: raw.code };
  } catch {
    return undefined;
  }
}

/** downloads/README.md 写的版本（"版本 / Version: 0.4.2" 那一行）；没写是 undefined */
export function packagedVersionIn(readme: string): string | undefined {
  return /^版本 \/ Version:\s*(\S+)/m.exec(readme)?.[1]; // @i18n-ignore fixed：downloads/README.md 里那一行的写法
}

/**
 * 程序目录里带的安卓安装包：摆好的版本目录看 downloads/ergo-android.json，仓库看 frontend/app-version.json 和 downloads/README.md。
 * 没有、对不上的回原因（给日志）
 */
export function locateAndroidApp(root: string): AndroidAppSource | { reason: string } {
  // @i18n-ignore-start log：没带安装包的原因只进日志
  const file = path.join(root, "downloads", ANDROID_APP_FILE);
  if (!fs.existsSync(file)) return { reason: `没有安卓安装包（${file}）` };
  const descriptor = path.join(root, "downloads", ANDROID_APP_DESCRIPTOR);
  if (fs.existsSync(descriptor)) {
    const info = readAppVersionInfo(descriptor);
    return info ? { file, ...info } : { reason: `${descriptor} 写法不对（要 version、code）` };
  }
  const want = readAppVersionInfo(path.join(root, ...APP_VERSION_FILE.split("/")));
  if (!want) return { reason: `读不到 App 的版本号（${APP_VERSION_FILE}）` };
  let packaged: string | undefined;
  try {
    packaged = packagedVersionIn(fs.readFileSync(path.join(root, ...DOWNLOADS_README.split("/")), "utf8"));
  } catch {
    packaged = undefined;
  }
  if (packaged !== want.version) return { reason: `downloads/ 里的安装包是 ${packaged ?? "没写版本的"}，App 的版本号是 ${want.version}（${APP_VERSION_FILE}）：对不上，当作没有安装包` };
  return { file, ...want };
  // @i18n-ignore-end
}

export interface AppPackages {
  /** GET /api/app-update */
  view(): AppUpdateView;
  /** 安卓安装包；没带、对不上是 undefined */
  android(): BundledAndroidApp | undefined;
}

/** 程序目录里带的手机 App 安装包：每次问都看一眼文件（便宜），变了才重算 SHA-256；没带的原因换了才写一次日志 */
export function createAppPackages(options: { programDir: string; log: (line: string) => void }): AppPackages {
  let cached: { key: string; app: BundledAndroidApp } | undefined;
  let lastReason: string | undefined;

  const android = (): BundledAndroidApp | undefined => {
    const found = locateAndroidApp(options.programDir);
    if ("reason" in found) {
      if (found.reason !== lastReason) options.log(`手机 App 的安装包：${found.reason}`); // @i18n-ignore log：没带安装包的原因只进日志
      lastReason = found.reason;
      cached = undefined;
      return undefined;
    }
    lastReason = undefined;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(found.file);
    } catch {
      return undefined;
    }
    const key = `${found.file}|${stat.size}|${stat.mtimeMs}|${found.version}|${found.code}`;
    if (cached?.key !== key) {
      const sha256 = createHash("sha256").update(fs.readFileSync(found.file)).digest("hex");
      cached = { key, app: { file: found.file, version: found.version, code: found.code, size: stat.size, sha256 } };
      options.log(`手机 App 的安装包：安卓 ${found.version}（${found.code}），${(stat.size / 1e6).toFixed(1)} MB，sha256 ${sha256}`); // @i18n-ignore log：带了哪一版只进日志
    }
    return cached.app;
  };

  return {
    android,
    view() {
      const app = android();
      return app ? { android: { version: app.version, code: app.code, sha256: app.sha256, size: app.size } } : {};
    },
  };
}
