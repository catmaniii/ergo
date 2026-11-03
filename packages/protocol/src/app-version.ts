// 手机 App 的版本：App 只是壳，页面永远是服务端的，所以 App 自己一个版本号（frontend/app-version.json），和电脑版分开走（ADR-0047）。
// App 不保存、不判断服务端的版本，只报自己的：页面连上后经 report_app_version 把 appVersion() 报给守护进程，记在这台已配对设备上。
// 够不够新只看这里的 MIN_APP_VERSION：低于它，守护进程出一条待办（app_outdated），页面顶上一条提示。
// 页面就是服务端给的，所以页面里这份常量就是服务端的要求，不用另外问。
// 只有常量和纯函数，守护进程、网页、打包脚本共用。

/**
 * 要求手机 App 至少是哪一版。页面开始依赖新的原生能力时才升它，电脑版升级不用动。
 * 打包脚本（packages/daemon/build/app-version.ts）按字找这一行，比较上一个发布的值，改写法时一起改。
 * 0.4.1：长按网页元素的圆钮要的页面桥操作（elementInfo 这一组）和 browserTool 操作（elementFetch 这一组）是这一版才有的，
 * 0.4.0 的 App 没有；0.4.1 到 0.4.2 原生代码和页面桥没变
 */
export const MIN_APP_VERSION = "0.4.1";

/** 哪种 App：决定去哪升级（安卓有 APK 直接下载，鸿蒙要照教程自己签名） */
export const APP_PLATFORMS = ["android", "harmony"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/** 报上来的版本号最长多少（App 给的，不一定对） */
export const APP_VERSION_MAX_LENGTH = 32;

/** 版本号的数字段；开头不是数字的（读不到、乱写的）是空的，算最旧。后面带的 -beta 这些不看 */
function versionParts(version: string): number[] {
  const head = /^\d+(?:\.\d+)*/.exec(version.trim());
  return head ? head[0].split(".").map(Number) : [];
}

/** 比两个版本号：按数字段比（0.10.0 比 0.9.9 新），缺的段算 0；读不到的最旧。a 旧回负数，一样回 0，a 新回正数 */
export function compareAppVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? -1 : 1;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 这个版本的 App 太旧了吗：读不到版本（空串）算最旧 */
export function appVersionOutdated(version: string, min: string = MIN_APP_VERSION): boolean {
  return compareAppVersions(version, min) < 0;
}

/** 从浏览器标识认哪种 App；认不出是 undefined（鸿蒙的标识里写 OpenHarmony、ArkWeb，不写 Android） */
export function appPlatformOf(userAgent: string): AppPlatform | undefined {
  if (/OpenHarmony|HarmonyOS|ArkWeb/.test(userAgent)) return "harmony";
  return /Android/.test(userAgent) ? "android" : undefined;
}

const REPO = "https://github.com/catmaniii/ergo";

/**
 * 安卓 App 的安装包：用发布页的地址，它的响应写明了 APK 的类型和文件名。
 * 别换成手机教程里 raw/main/downloads/ 那个（那是给手机浏览器用的）：它回 application/octet-stream，App 里的下载按类型改扩展名，
 * 存下来是 ergo-android-debug.bin，点了装不上。要升级的正是旧 App，改 App 救不了它们，只能在这里给对的地址
 */
export const ANDROID_APP_URL = `${REPO}/releases/latest/download/ergo-android-debug.apk`;

/** 手机教程里的小节：中文的一份锚点是中文标题，别的语言看英文那份 */
const guideUrl = (language: string, zh: string, en: string): string => `${REPO}/blob/main/docs/user-guide/${language.startsWith("zh") ? `mobile.md#${zh}` : `mobile.en.md#${en}`}`;

/** 去哪升级：安卓是 APK 链接（kind 是 download），鸿蒙是手机安装教程；认不出哪种 App 的去"装 App"那一节（kind 都是 guide） */
export function appUpgradeLink(platform: AppPlatform | undefined, language: string): { kind: "download" | "guide"; url: string } {
  if (platform === "android") return { kind: "download", url: ANDROID_APP_URL };
  if (platform === "harmony") return { kind: "guide", url: guideUrl(language, "鸿蒙-app", "harmonyos-app") }; // @i18n-ignore fixed：教程的锚点
  return { kind: "guide", url: guideUrl(language, "装-app", "install-the-app") }; // @i18n-ignore fixed：教程的锚点
}

/**
 * 二狗带着的安卓 App 安装包（GET /api/app-update 的 android）：和这一版二狗同一版，运行时不去 GitHub 下。
 * 版本以 frontend/app-version.json 为准；没带、带的和它对不上时没有这一项（守护进程日志写明为什么）
 */
export interface AndroidAppPackage {
  /** versionName（frontend/app-version.json 的 version） */
  version: string;
  /** versionCode（frontend/app-version.json 的 code） */
  code: number;
  /** 安装包的 SHA-256，小写十六进制。App 下完先核它 */
  sha256: string;
  /** 字节数 */
  size: number;
}

/** GET /api/app-update：二狗带着的手机 App 安装包。只有安卓（鸿蒙要用户自己签名，带不了） */
export interface AppUpdateView {
  android?: AndroidAppPackage;
}

/** 下载安装包的响应头：版本、versionCode、SHA-256 也写在这里（直接下载的人、App 都看得到） */
export const APP_PACKAGE_HEADERS = { version: "X-Ergo-App-Version", code: "X-Ergo-App-Code", sha256: "X-Ergo-App-Sha256" } as const;

/** 安卓安装包的类型：旧 App 的下载按它存成 .apk（octet-stream 会被存成 .bin，点了装不上） */
export const ANDROID_PACKAGE_MIME = "application/vnd.android.package-archive";

/** 下载下来的文件名：带版本号，.apk 结尾 */
export function androidPackageFileName(version: string): string {
  return `ergo-android-${version.replace(/[^0-9A-Za-z._-]/g, "_")}.apk`;
}

/**
 * 这台设备的 App 有没有新版可装：只看安卓，报上来的版本低于二狗带的那一版就有（读不到版本的算最旧）。
 * 鸿蒙不算：两边共用版本号，鸿蒙包内容没变也会跟着升号，而且装不了（要用户自己签名），只在低于最低版本时提示
 */
export function appUpdateFor(device: { appVersion?: string | undefined; appPlatform?: AppPlatform | undefined }, view: AppUpdateView | undefined): AndroidAppPackage | undefined {
  const android = view?.android;
  if (!android || device.appPlatform !== "android" || device.appVersion === undefined) return undefined;
  return compareAppVersions(device.appVersion, android.version) < 0 ? android : undefined;
}

/** "App 太旧了"这条待办的 data */
export interface AppOutdatedNoticeData {
  deviceId: string;
  deviceName: string;
  /** App 报的版本；读不到是空串 */
  version: string;
  /** 这一条说的是哪个要求 */
  minVersion: string;
  platform?: AppPlatform;
}

/** "App 太旧了"这条待办的编号：一台设备、一个要求只有一条，用户删掉了也不再放 */
export function appOutdatedItemId(deviceId: string, minVersion: string): string {
  return `i-app-outdated-${deviceId}-${minVersion}`;
}
