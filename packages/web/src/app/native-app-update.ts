// 安卓 App 在 App 里一键更新（票 399）在网页这一侧。新版安卓 App 的原生桥上有 installAppUpdate（只给主页面，侧边栏那份没有）：
// - installAppUpdate(json)：json 是 { url, sha256, version, code, size }（二狗带的那个安装包，GET /api/app-update 给的）。
//   App 自己带着设备凭证下到它的缓存目录，核 SHA-256，再核包名一样、versionCode 比装着的高、签名证书和装着的一样，
//   然后用系统的 PackageInstaller 装（第一次先带用户去系统设置允许安装；安卓 12 起系统允许就不弹确认）。
//   回 Promise<string>：最后一步（failed 和原因；系统说装好了是 installed）。装的时候系统会关掉 App，多半等不到 installed。
// - 一路上的进度 App 调网页登记的 window.__ergoAppUpdate(json)：downloading（percent）、authorizing（等你去系统设置里允许）、
//   confirming（等你在系统的确认框里点）、installing（系统在装）。
// 旧版 App（0.4.2 及以前）没有这个方法：页面退回成从二狗直接下载 APK（ui/app-update.tsx）。
// App 回的东西形状不一定对：一律核对，不对就当没有。
import { exposeToApp } from "./app-names.ts";

/** 原生桥上的方法名（frontend/android 的 NativeBridge.kt 里也是它；鸿蒙没有） */
export const NATIVE_APP_UPDATE_METHOD = "installAppUpdate";

/** 没装上的原因：网络、校验值不对、不是二狗的包、版本不比装着的新、签名不一样、你取消了、空间不够、没允许安装、正在更新、别的（detail 里是系统说的） */
export const APP_UPDATE_FAILURES = ["network", "checksum", "package", "version", "signature", "cancelled", "storage", "permission", "busy", "failed"] as const;
export type AppUpdateFailure = (typeof APP_UPDATE_FAILURES)[number];

/** 更新走到哪一步了 */
export type AppUpdateProgress =
  | { readonly state: "downloading"; readonly percent?: number }
  | { readonly state: "authorizing" }
  | { readonly state: "confirming" }
  | { readonly state: "installing" }
  | { readonly state: "installed" }
  | { readonly state: "failed"; readonly reason: AppUpdateFailure; readonly detail?: string };

/** 交给 App 的：要装的安装包 */
export interface AppUpdateRequest {
  /** 安装包的地址（二狗自己的，App 只认配好的那个来源） */
  readonly url: string;
  readonly sha256: string;
  readonly version: string;
  readonly code: number;
  readonly size: number;
}

export interface NativeAppUpdate {
  /** 下载、核对、调起系统安装；一路的进度交给 onProgress。回最后一步（failed、installed）；装的时候 App 会被系统关掉，多半不回 */
  install(request: AppUpdateRequest, onProgress: (progress: AppUpdateProgress) => void): Promise<AppUpdateProgress>;
}

/** App 推进度时调的函数挂在页面的全局对象上 */
export interface AppUpdateScope {
  __ergoAppUpdate?: (json: string) => void;
}

/** detail 最长多少（系统给的话，显示在页面上） */
const DETAIL_MAX = 200;

/** App 回的、推过来的进度（JSON 字符串）；不对就是 undefined */
export function parseAppUpdateProgress(json: unknown): AppUpdateProgress | undefined {
  if (typeof json !== "string" || json === "") return undefined;
  let raw: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    raw = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  switch (raw.state) {
    case "downloading": {
      const percent = raw.percent;
      return typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? { state: "downloading", percent: Math.floor(percent) } : { state: "downloading" };
    }
    case "authorizing":
    case "confirming":
    case "installing":
    case "installed":
      return { state: raw.state };
    case "failed": {
      const reason = (APP_UPDATE_FAILURES as readonly unknown[]).includes(raw.reason) ? (raw.reason as AppUpdateFailure) : "failed";
      const detail = typeof raw.detail === "string" && raw.detail.trim() !== "" ? raw.detail.trim().slice(0, DETAIL_MAX) : undefined;
      return detail === undefined ? { state: "failed", reason } : { state: "failed", reason, detail };
    }
    default:
      return undefined;
  }
}

type BridgeObject = Record<string, unknown>;

/** 原生桥上有 installAppUpdate（新版安卓 App）时的包装；没有是 undefined */
export function wrapNativeAppUpdate(bridge: BridgeObject, scope: AppUpdateScope): NativeAppUpdate | undefined {
  const fn = bridge[NATIVE_APP_UPDATE_METHOD];
  if (typeof fn !== "function") return undefined;
  return {
    async install(request, onProgress) {
      // 同一时间只有一次更新：后登记的盖掉前一个（前一个已经结束了，页面上同一时间只有一个按钮在跑）
      const unexpose = exposeToApp(scope, "__ergoAppUpdate", (json: string) => {
        const progress = parseAppUpdateProgress(json);
        if (progress) onProgress(progress);
      });
      try {
        const reply: unknown = await (fn as (json: string) => unknown).call(bridge, JSON.stringify(request));
        return parseAppUpdateProgress(reply) ?? { state: "failed", reason: "failed" };
      } catch (err) {
        return { state: "failed", reason: "failed", detail: err instanceof Error ? err.message : String(err) };
      } finally {
        unexpose();
      }
    },
  };
}
