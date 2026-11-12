// 鸿蒙 App在网页这一侧：App 是个原生壳，用 ArkWeb 加载二狗的地址，并用 javaScriptProxy 往页面里注入
// window.ergoNative（frontend/harmony/entry/src/main/ets/bridge/NativeBridge.ets）。
// 检测到它时：设置里显示"在鸿蒙 App 里运行"和 App 版本、能回到 App 的地址页；外观告诉 App，状态栏和窗口底色跟着变；
// 系统返回键：网页经 setCanGoBack 报"还能不能在网页里返回"，App 按返回键时调网页登记的 window.__ergoBack()。
// 没有时什么都不变。原生桥只对 App 里配好的那个来源开放，来源不对时 App 不做事、版本号回空串。
// 这里不碰浏览器的全局变量（页面上的 window 在 page-native.ts 接进来），测试在 Node 里用假的原生桥跑。
// 原生录音也在 ergoNative 上：有录音这一组方法（新版 App）时 NativeApp.voice 是它的包装（native-voice.ts），
// 没有（旧版 App、不在 App 里）时录音照旧用浏览器的 getUserMedia。
// App 把网页延伸到了底部手势条底下，经 safeArea() 和推送的 window.__ergoInsets(json) 告诉页面那一截多高，
// 页面底部只让开一小截（appBottomReserve），不再留整条白边；旧版 App 没有 safeArea，什么都不变。
// 有通知这一组方法（新版 App）时 NativeApp.notify 是它的包装（native-notify.ts），提醒发到系统通知栏；
// 没有时照旧弹浏览器通知（走哪条路在 system-notify.ts）。
// 有浏览器这一组方法（新版 App）时 NativeApp.browser 是它的包装（native-browser.ts），导航多"浏览"页签、
// openInAppBrowser 和外链都在 App 的原生浏览器里打开；没有时照旧（嵌入框叠层、外链交给系统浏览器）。
// App 原生的字（地址页、出错页、下载的提示、交回网页的原因……，key 是 harmony.*）跟着二狗的全局语言：有 setTexts 的新版 App，
// 网页开场、换了语言时把当前语言的这几句交过去（appTexts、followLocaleInApp）；旧版 App 没有，照旧中文。
// 有手机这一组方法（新版 App）时 NativeApp.phone 是它的包装（native-phone.ts）：从通讯录挑人、读手机日历；没有时这两样做不了。
// 有 installAppUpdate（新版安卓 App）时 NativeApp.appUpdate 是它的包装（native-app-update.ts）：在 App 里更新 App；没有时退回成从二狗下载 APK。
// 有 openSystemBrowser（新版安卓 App，票 386）时 NativeApp.openSystemBrowser 是它的包装：用手机的系统浏览器打开一个 https 地址，
// 下载、安装交给系统（"下载新版"走它，ui/app-upgrade.tsx）；没有时照旧（主页面的外链进"浏览"，或者 App 交给系统）。
// 有 videoFullscreen（新版 App，票 407）时 NativeApp.videoFullscreen 是 true：App 接住了网页的全屏（标准 Fullscreen API，
// 安卓 onShowCustomView、鸿蒙 onFullScreenEnter），视频播放器的全屏按钮点了是真全屏；旧版 App 没有，播放器藏掉全屏按钮（videoFullscreenAllowed）。
// App 的版本（nativeAppReport）：连上守护进程后报上去，够不够新由守护进程判断（ADR-0047）；页面上的提示条看本机版本和协议包的最低版本。
import { activeLocale, APP_VERSION_MAX_LENGTH, appPlatformOf, type AppPlatform, onLocaleChange, type ReportAppVersionParams, t, type ThemeChoice } from "../state/index.ts";
import { appObject, exposeToApp } from "./app-names.ts";
import { type AppUpdateScope, type NativeAppUpdate, wrapNativeAppUpdate } from "./native-app-update.ts";
import type { BackRegistry } from "./back-registry.ts";
import { type NativeBrowser, type NativeBrowserScope, wrapNativeBrowser } from "./native-browser.ts";
import { type NativeNotify, wrapNativeNotify } from "./native-notify.ts";
import { type NativePhone, wrapNativePhone } from "./native-phone.ts";
import { type NativeVoice, type NativeVoiceScope, wrapNativeVoice } from "./native-voice.ts";
import type { ThemeController } from "./theme.ts";

/** 网页在 App 里时能做的事 */
export interface NativeApp {
  /** 哪种 App（按浏览器标识认）；认不出是 undefined */
  readonly platform: AppPlatform | undefined;
  /** App 的版本号（versionName） */
  readonly version: string;
  /** 日志交给 App，写进 hilog */
  log(message: string): void;
  /** 回到 App 的地址页，改二狗的地址 */
  editServer(): void;
  /** 外观告诉 App：状态栏、窗口底色跟着变，下次开场先按它画 */
  setColorMode(choice: ThemeChoice): void;
  /** 告诉 App 现在还能不能在网页里返回：能就由网页退一级，不能 App 按返回键就退出 */
  setCanGoBack(flag: boolean): void;
  /** App 的原生录音；旧版 App 没有 */
  readonly voice?: NativeVoice;
  /** 底部避让区多高：App 还没量到、回的不对是 undefined；旧版 App 没有这个方法 */
  readonly safeArea?: () => NativeInsets | undefined;
  /** App 的系统通知；旧版 App 没有 */
  readonly notify?: NativeNotify;
  /** App 的原生内置浏览器（"浏览"页签）；旧版 App 没有 */
  readonly browser?: NativeBrowser;
  /** 把 App 原生的字换成这些；旧版 App 没有 */
  readonly setTexts?: (texts: NativeAppTexts) => void;
  /** 读本机：从通讯录挑人、读手机日历；旧版 App 没有 */
  readonly phone?: NativePhone;
  /** 在 App 里更新 App（安卓，票 399）：下载二狗带的安装包、调起系统安装；旧版 App 和鸿蒙没有 */
  readonly appUpdate?: NativeAppUpdate;
  /** App 接住了网页的全屏（视频播放器自带的全屏按钮点了是真全屏，票 407）；旧版 App 没有这一项 */
  readonly videoFullscreen?: true;
  /**
   * 用手机的系统浏览器打开（安卓，票 386）：只收 https 地址，下载、安装交给系统。回打开了没有：
   * 不是 https、手机上没有浏览器、App 出错都回 false，调用方照旧打开。旧版 App 和鸿蒙没有
   */
  readonly openSystemBrowser?: (url: string) => Promise<boolean>;
}

/** 交给 App 的原生的字：二狗现在用的语言、harmony.* 的 key → 当前语言的句子（缺的已经用中文补上） */
export interface NativeAppTexts {
  readonly language: string;
  readonly texts: Readonly<Record<string, string>>;
}

/** App 报的避让区：bottom 是底部手势条（三键导航条）那一截的高度，物理像素 */
export interface NativeInsets {
  readonly bottom: number;
}

/** App 回的、推过来的避让区（JSON 字符串 {"bottom": 物理像素}）；不对就是 undefined */
export function parseNativeInsets(json: unknown): NativeInsets | undefined {
  if (typeof json !== "string" || json === "") return undefined;
  try {
    const value = JSON.parse(json) as { bottom?: unknown };
    return typeof value.bottom === "number" && Number.isFinite(value.bottom) && value.bottom >= 0 ? { bottom: value.bottom } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 手势条那一截里页面底部还让开多少：四分之一。各风格的底部横栏、输入框自己还留着下边距，
 * 原来让开一半时在平板上看下面还空，要输入框和底部导航再往下；左下角、右下角被挡一点用户说不要紧。
 * 真机上看着压字了就调大它
 */
export const APP_BOTTOM_KEEP_RATIO = 0.25;

/** 页面底部让开多少 CSS 像素：App 报的是物理像素，按 devicePixelRatio 换算，再取 APP_BOTTOM_KEEP_RATIO */
export function appBottomReserve(bottomPx: number, devicePixelRatio: number): number {
  if (!(bottomPx > 0) || !(devicePixelRatio > 0)) return 0;
  return Math.round((bottomPx / devicePixelRatio) * APP_BOTTOM_KEEP_RATIO);
}

/** 注入的对象是 App 给的，形状不一定对：方法一个个取，不是函数就当没有 */
type BridgeObject = Record<string, unknown>;

/** 调 App 的一个方法；没有这个方法、App 拒绝或出错都当没调（网页照常） */
function callBridge(bridge: BridgeObject, method: string, ...args: (string | boolean)[]): unknown {
  const fn = bridge[method];
  if (typeof fn !== "function") return undefined;
  try {
    return fn.apply(bridge, args);
  } catch {
    return undefined;
  }
}

/** 页面全局对象里的浏览器标识（App 挂的原生桥认不出是哪种 App，看它） */
interface UserAgentScope {
  navigator?: { userAgent?: string };
}

/**
 * 开在 App 里时要报给守护进程的：版本号、哪种 App。有原生桥就算在 App 里；版本读不到（没有这个方法、出错、App 回空串）报空串，算最旧。
 * 手机浏览器、电脑没有原生桥，是 undefined，什么都不报
 */
export function nativeAppReport(scope: { ergoNative?: unknown } & UserAgentScope): ReportAppVersionParams | undefined {
  const bridge = appObject(scope, "ergoNative");
  if (typeof bridge !== "object" || bridge === null) return undefined;
  const version = callBridge(bridge as BridgeObject, "appVersion");
  const platform = appPlatformOf(scope.navigator?.userAgent ?? "");
  return { version: typeof version === "string" ? version.slice(0, APP_VERSION_MAX_LENGTH) : "", ...(platform === undefined ? {} : { platform }) };
}

/** 原生桥上说明"App 能真全屏"的方法名（无参数、回 true；两个 App 的原生桥上也叫它，票 407） */
export const NATIVE_VIDEO_FULLSCREEN_METHOD = "videoFullscreen";

/** 原生桥上"用系统浏览器打开"的方法名（frontend/android 的 NativeBridge.kt 里也是它；鸿蒙没有，票 386） */
export const NATIVE_SYSTEM_BROWSER_METHOD = "openSystemBrowser";

/** 能交给系统浏览器的地址：只有 https（App 那边也只收 https），带用户名密码的、写法不对的不算 */
export function systemBrowserUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname !== "" && parsed.username === "" && parsed.password === "" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** 原生桥上有 openSystemBrowser（新版安卓 App）时的包装：App 回 "ok" 才算打开了；没有这个方法是 undefined */
function wrapSystemBrowser(bridge: BridgeObject): ((url: string) => Promise<boolean>) | undefined {
  const fn = bridge[NATIVE_SYSTEM_BROWSER_METHOD];
  if (typeof fn !== "function") return undefined;
  return async (url) => {
    const href = systemBrowserUrl(url);
    if (href === undefined) return false;
    try {
      return (await (fn as (url: string) => unknown).call(bridge, href)) === "ok";
    } catch {
      return false;
    }
  };
}

/**
 * 页面的全局对象里有没有 App 注入的原生桥；没有、形状不对、App 拒绝了这个页面都返回 undefined。
 * 有原生录音时在 scope 上登记 App 推送用的 __ergoVoice，有原生浏览器时登记 __ergoBrowser。
 */
export function detectNativeApp(scope: { ergoNative?: unknown } & UserAgentScope & NativeVoiceScope & NativeBrowserScope & AppUpdateScope): NativeApp | undefined {
  const bridge = appObject(scope, "ergoNative");
  if (typeof bridge !== "object" || bridge === null) return undefined;
  const raw = bridge as BridgeObject;
  if (typeof raw.appVersion !== "function") return undefined;
  const version = callBridge(raw, "appVersion");
  if (typeof version !== "string" || version === "") return undefined;
  const voice = wrapNativeVoice(raw, scope);
  const safeArea = typeof raw.safeArea === "function" ? () => parseNativeInsets(callBridge(raw, "safeArea")) : undefined;
  const notify = wrapNativeNotify(raw);
  const browser = wrapNativeBrowser(raw, scope);
  const setTexts = typeof raw.setTexts === "function" ? (texts: NativeAppTexts) => void callBridge(raw, "setTexts", JSON.stringify(texts)) : undefined;
  const phone = wrapNativePhone(raw);
  const appUpdate = wrapNativeAppUpdate(raw, scope);
  // 有这个方法就说明 App 能真全屏（方法本身无参数、回 true，网页不用调它）
  const videoFullscreen = typeof raw[NATIVE_VIDEO_FULLSCREEN_METHOD] === "function";
  const openSystemBrowser = wrapSystemBrowser(raw);
  return {
    platform: appPlatformOf(scope.navigator?.userAgent ?? ""),
    version,
    log: (message) => void callBridge(raw, "log", message),
    editServer: () => void callBridge(raw, "editServer"),
    setColorMode: (choice) => void callBridge(raw, "setColorMode", choice),
    setCanGoBack: (flag) => void callBridge(raw, "setCanGoBack", flag),
    ...(voice ? { voice } : {}),
    ...(safeArea ? { safeArea } : {}),
    ...(notify ? { notify } : {}),
    ...(browser ? { browser } : {}),
    ...(setTexts ? { setTexts } : {}),
    ...(phone ? { phone } : {}),
    ...(appUpdate ? { appUpdate } : {}),
    ...(videoFullscreen ? { videoFullscreen: true as const } : {}),
    ...(openSystemBrowser ? { openSystemBrowser } : {}),
  };
}

/**
 * 视频播放器给不给全屏按钮：不在 App 里（浏览器，电脑、手机）照给，本来就是真全屏；在 App 里要有 videoFullscreen（新版 App 接住了全屏）
 * 才给——旧版 App 没接，全屏按钮点了没反应，藏掉（controlsList="nofullscreen"），只用铺满页面的大播放器。
 * inApp 看有没有原生桥（App 拒绝了这个页面、读不到版本时也算在 App 里），app 是认出来的 App 能做的事
 */
export function videoFullscreenAllowed(inApp: boolean, app: Pick<NativeApp, "videoFullscreen"> | undefined): boolean {
  return !inApp || app?.videoFullscreen === true;
}

/** App 原生的字的 key 都以它开头（共享协议包 locales/<语言>/harmony.json） */
const APP_TEXT_PREFIX = "harmony.";

/** 当前语言的 App 原生的字：词典里（连同回退的中文）每个 harmony.* 的 key 按当前语言取好；{name} 原样留给 App 换 */
export function appTexts(): NativeAppTexts {
  const locale = activeLocale();
  const keys = new Set([...Object.keys(locale.fallback), ...Object.keys(locale.messages)].filter((k) => k.startsWith(APP_TEXT_PREFIX)));
  return { language: locale.meta.id, texts: Object.fromEntries([...keys].toSorted().map((k) => [k, t(k)])) };
}

/** App 原生的字跟着语言：马上交一次，之后换了语言（字不一样了）再交；返回停下。旧版 App 没有 setTexts：什么都不做 */
export function followLocaleInApp(app: NativeApp, texts: () => NativeAppTexts = appTexts, subscribe: (fn: () => void) => () => void = onLocaleChange): () => void {
  const setTexts = app.setTexts;
  if (!setTexts) return () => {};
  let told = "";
  const tell = () => {
    const now = texts();
    const json = JSON.stringify(now);
    if (json === told) return;
    told = json;
    setTexts(now);
  };
  tell();
  return subscribe(tell);
}

/** 外观的选择告诉 App：马上告诉一次，之后选择变了再告诉（跟随系统时系统切深浅色不算，App 自己跟着系统）；返回停下 */
export function followThemeInApp(app: NativeApp, theme: Pick<ThemeController, "choice" | "subscribe">): () => void {
  let told = theme.choice();
  app.setColorMode(told);
  return theme.subscribe(() => {
    const choice = theme.choice();
    if (choice === told) return;
    told = choice;
    app.setColorMode(choice);
  });
}

/** App 按返回键时调的函数挂在页面的全局对象上 */
export interface BackScope {
  __ergoBack?: () => boolean;
}

/**
 * 返回键接到 App 上：登记 window.__ergoBack（按返回栈退一级，到顶层返回 false），
 * 马上告诉 App 现在能不能返回，之后变了再告诉；返回停下（拿掉返回函数、不再告诉）
 */
export function followBackInApp(app: NativeApp, back: Pick<BackRegistry, "back" | "canGoBack" | "subscribe">, scope: BackScope): () => void {
  const goBack = () => back.back();
  const unexpose = exposeToApp(scope, "__ergoBack", goBack);
  let told = back.canGoBack();
  app.setCanGoBack(told);
  const off = back.subscribe(() => {
    const flag = back.canGoBack();
    if (flag === told) return;
    told = flag;
    app.setCanGoBack(flag);
  });
  return () => {
    off();
    unexpose();
  };
}

/** App 推避让区时调的函数挂在页面的全局对象上 */
export interface InsetsScope {
  __ergoInsets?: (json: string) => void;
}

/**
 * 底部避让接到 App 上：马上问一次（App 可能还没量到），登记 window.__ergoInsets 等 App 推（量到了、转屏了），
 * 每次拿到对的就交给 apply；返回停下。旧版 App 没有 safeArea：什么都不做
 */
export function followInsetsInApp(app: NativeApp, scope: InsetsScope, apply: (insets: NativeInsets) => void): () => void {
  if (!app.safeArea) return () => {};
  const now = app.safeArea();
  if (now) apply(now);
  const pushed = (json: string) => {
    const insets = parseNativeInsets(json);
    if (insets) apply(insets);
  };
  return exposeToApp(scope, "__ergoInsets", pushed);
}
