// 安卓 App 的"更新"（票 399）：二狗带着同一版的安卓安装包（GET /api/app-update），手机上点一下就装。
// - 新版安卓 App（原生桥上有 installAppUpdate）：App 自己下载、核对、调起系统安装，这里显示进度和结果；
// - 旧版 App（0.4.2 及以前）、浏览器：退回成从二狗直接下载 APK（服务端给对了类型和 .apk 文件名，旧 App 也存成 .apk），
//   存好后在手机的"文件"里点开安装。
// 设置 · 设备配对里这台手机那一行、App 太旧时的提示条都用它。同一时间只有一次更新，进度在两处一样（模块里一份）。
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DaemonHttp } from "../app/daemon-http.ts";
import type { AppUpdateFailure, AppUpdateProgress, NativeAppUpdate } from "../app/native-app-update.ts";
import { pageNativeApp } from "../app/page-native.ts";
import { useOptionalStore } from "../app/store.tsx";
import { type AndroidAppPackage, androidPackageFileName, type AppUpdateView, HTTP_PATHS, t } from "../state/index.ts";

/** 二狗带着哪一版：问到了一个页面只问一次（换了一版二狗页面会刷新）；问不到（旧的守护进程没有这个接口、刚断线）当没带，下次再问 */
const views = new WeakMap<DaemonHttp, Promise<AppUpdateView | undefined>>();
function loadView(http: DaemonHttp): Promise<AppUpdateView | undefined> {
  let view = views.get(http);
  if (!view) {
    view = http.appUpdate().catch(() => {
      views.delete(http);
      return undefined;
    });
    views.set(http, view);
  }
  return view;
}

/** 二狗带着哪一版手机 App 安装包；enabled 为假时不问（不在 App 里、用不上的地方）。没有连接（只画样子）时当没带 */
export function useAppUpdateView(enabled = true): AppUpdateView | undefined {
  const http = useOptionalStore()?.http;
  const [view, setView] = useState<AppUpdateView>();
  useEffect(() => {
    if (!enabled || !http) return;
    let alive = true;
    void loadView(http).then((v) => {
      if (alive) setView(v);
    });
    return () => {
      alive = false;
    };
  }, [http, enabled]);
  return view;
}

/** 这一次更新走到哪了（整个页面一份） */
let current: AppUpdateProgress | undefined;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const snapshot = () => current;
function setProgress(progress: AppUpdateProgress): void {
  current = progress;
  for (const fn of listeners) fn();
}

/** 还在跑（没失败、系统也没说装好） */
const running = (p: AppUpdateProgress | undefined) => p !== undefined && p.state !== "failed" && p.state !== "installed";

/** 交给 App 装：同一时间只有一次 */
function startAppUpdate(update: NativeAppUpdate, pkg: AndroidAppPackage): void {
  if (running(current)) return;
  setProgress({ state: "downloading" });
  const url = new URL(HTTP_PATHS.androidAppPackage, window.location.href).href;
  void update.install({ url, sha256: pkg.sha256, version: pkg.version, code: pkg.code, size: pkg.size }, setProgress).then(setProgress);
}

/** 没装上的原因（别的原因看 detail） */
const FAILED_TEXT: Readonly<Record<Exclude<AppUpdateFailure, "failed">, () => string>> = {
  network: () => t("ui.appUpdate.failed.network"),
  checksum: () => t("ui.appUpdate.failed.checksum"),
  package: () => t("ui.appUpdate.failed.package"),
  version: () => t("ui.appUpdate.failed.version"),
  signature: () => t("ui.appUpdate.failed.signature"),
  cancelled: () => t("ui.appUpdate.failed.cancelled"),
  storage: () => t("ui.appUpdate.failed.storage"),
  permission: () => t("ui.appUpdate.failed.permission"),
  busy: () => t("ui.appUpdate.failed.busy"),
};

/** 走到哪一步的那句话 */
export function appUpdateText(p: AppUpdateProgress): string {
  switch (p.state) {
    case "downloading":
      return p.percent === undefined ? t("ui.appUpdate.downloadingStart") : t("ui.appUpdate.downloading", { percent: p.percent });
    case "authorizing":
      return t("ui.appUpdate.authorizing");
    case "confirming":
      return t("ui.appUpdate.confirming");
    case "installing":
      return t("ui.appUpdate.installing");
    case "installed":
      return t("ui.appUpdate.installed");
    case "failed":
      if (p.reason !== "failed") return FAILED_TEXT[p.reason]();
      return p.detail === undefined ? t("ui.appUpdate.failed.failed") : t("ui.appUpdate.failed.failedDetail", { detail: p.detail });
  }
}

/** "更新"按钮和它后面的进度：新版安卓 App 在 App 里装；旧版 App、浏览器是从二狗直接下载安装包的链接 */
export function AppUpdateAction({ pkg }: { pkg: AndroidAppPackage }) {
  const progress = useSyncExternalStore(subscribe, snapshot, snapshot);
  const app = pageNativeApp();
  const update = app?.appUpdate;
  if (!update) {
    return (
      <span className="app-update">
        <a className="btn primary small" href={HTTP_PATHS.androidAppPackage} download={androidPackageFileName(pkg.version)} data-action="app-update-download">
          {t("ui.appUpdate.update")}
        </a>
        {app && <span className="app-update-note muted">{t("ui.appUpdate.oldAppHint")}</span>}
      </span>
    );
  }
  return (
    <span className="app-update">
      <button type="button" className="btn primary small" disabled={running(progress)} data-action="app-update" onClick={() => startAppUpdate(update, pkg)}>
        {t("ui.appUpdate.update")}
      </button>
      {progress && (
        <span className={`app-update-note${progress.state === "failed" ? " app-update-failed" : ""}`} role="status">
          {appUpdateText(progress)}
        </span>
      )}
    </span>
  );
}
