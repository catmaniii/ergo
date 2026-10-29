// Debug 工具集（124 号票）在页面上要的几样（接浏览器、鸿蒙 App 的原生桥）：
// - 复制一段文字：先用 navigator.clipboard，ArkWeb 里不行（没有、被拒）就退回选中文字的老办法（execCommand("copy")）；
// - 录几秒：App 里用原生录音（63 号票的 NativeVoiceRecorder），浏览器里用页面录音（VoiceRecorder），和"按住说话"同一套后端；
// - 放一段音频（录的回放、合成的那一句）；
// - 版本与环境：原生桥有哪些方法、屏幕和视口、安全区、风格和深浅色、主色；
// - 本机存储里二狗记的键；重置首次提示（页面一侧"要麦克风被拒过"的记号、App 记的 notify_asked）。
// 纯逻辑（怎么列存储、怎么写原因）在状态层 state/debug-tools.ts。
import { type StorageArea, type StorageRow, storageRows, t } from "../state/index.ts";
import { BASE_STYLE, VISUAL_STYLES } from "../visual-styles/index.ts";
import { appObject } from "./app-names.ts";
import { pageNativeApp } from "./page-native.ts";
import { pageTheme } from "./page-theme.ts";
import { browserVoiceEnv, resetMicDenied, voiceSupport } from "./voice-browser.ts";
import { NativeVoiceRecorder } from "./voice-native-recorder.ts";
import { type Recording, type VoiceCaptureBackend, VoiceRecorder } from "./voice-recorder.ts";

/** 复制一段文字：成了回 true（clipboard 不行时退回老办法：临时文本框选中再 execCommand("copy")） */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // ArkWeb、http 页面上 clipboard 可能被拒：走老办法
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** 录几秒的结果：录音、走的哪条（App 原生、浏览器） */
export interface DebugTake {
  readonly recording: Recording;
  readonly backend: "native" | "web";
}

/** 录 seconds 秒（App 里原生录音，浏览器里页面录音）；不能录、录不下去抛错（message 是给人看的话） */
export async function recordSeconds(seconds: number): Promise<DebugTake> {
  const support = voiceSupport();
  if (!support.ok) throw new Error(support.text);
  const env = browserVoiceEnv();
  let trouble: Error | undefined;
  const backend: VoiceCaptureBackend = env.native
    ? new NativeVoiceRecorder(env.native, env.now, { log: env.micLog, onTrouble: (err) => (trouble = err) })
    : new VoiceRecorder(env.media, env.now, { log: env.micLog });
  try {
    await backend.open("press", { userAction: true });
    backend.begin({ pressedAt: env.now(), prewarmed: false });
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    if (trouble) throw trouble;
    const recording = await backend.stop();
    return { recording, backend: backend.backend };
  } finally {
    backend.close("leave");
  }
}

/** 放一段音频（录的回放、合成的那一句）；放完收回地址 */
export function playBlob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.addEventListener("ended", done);
    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error(t("app.debugPage.cantPlay")));
    });
    audio.play().catch((err: unknown) => {
      URL.revokeObjectURL(url);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** base64 的音频 → Blob */
export function blobOfBase64(base64: string, mime: string): Blob {
  return new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mime });
}

/** 原生桥上有哪些方法（不在 App 里是 undefined） */
export function nativeBridgeMethods(): string[] | undefined {
  const bridge = appObject(window, "ergoNative");
  if (!pageNativeApp() || typeof bridge !== "object" || bridge === null) return undefined;
  const names = new Set<string>();
  // javaScriptProxy 注入的对象：方法可能在对象自己身上，也可能在原型上
  for (let o: object | null = bridge; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
    for (const name of Object.getOwnPropertyNames(o)) if (name !== "constructor" && typeof (bridge as Record<string, unknown>)[name] === "function") names.add(name);
  }
  return [...names].toSorted();
}

/** 浏览器自己报的安全区（env(safe-area-inset-*)，CSS 像素）：放一个看不见的块量出来 */
function browserSafeArea(): string {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const s = getComputedStyle(probe);
  const text = t("app.debugPage.insets", { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft });
  probe.remove();
  return text;
}

/** 版本与环境里"这台设备"那几行：label 和值 */
export function environmentRows(): { label: string; value: string }[] {
  const theme = pageTheme();
  const style = VISUAL_STYLES.find((s) => s.id === theme.style()) ?? BASE_STYLE;
  const accentId = theme.accent();
  const accent = accentId === undefined ? undefined : style.accents?.find((a) => a.id === accentId);
  const app = pageNativeApp();
  const insets = app?.safeArea?.();
  const pageBottom = getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom").trim();
  return [
    { label: "user agent", value: navigator.userAgent },
    { label: t("app.debugPage.screen"), value: `${screen.width} × ${screen.height}` },
    { label: t("app.debugPage.viewport"), value: `${window.innerWidth} × ${window.innerHeight}` },
    { label: "devicePixelRatio", value: String(window.devicePixelRatio) },
    {
      label: t("app.debugPage.safeArea"),
      value: app?.safeArea
        ? t("app.debugPage.safeAreaApp", { inset: insets ? t("app.debugPage.physicalPx", { px: insets.bottom }) : t("app.debugPage.notMeasured"), page: pageBottom || "?" })
        : t("app.debugPage.safeAreaBrowser", { insets: browserSafeArea() }),
    },
    { label: t("app.debugPage.style"), value: t("app.debugPage.named", { name: style.name, id: style.id }) },
    {
      label: t("app.debugPage.theme"),
      value: t("app.debugPage.themeValue", {
        now: t(theme.theme() === "dark" ? "app.debugPage.dark" : "app.debugPage.light"),
        choice: t(theme.choice() === "system" ? "app.debugPage.system" : theme.choice() === "dark" ? "app.debugPage.dark" : "app.debugPage.light"),
      }),
    },
    { label: t("app.debugPage.accent"), value: accent ? t("app.debugPage.named", { name: accent.name, id: accent.id }) : t("app.debugPage.noAccent") },
  ];
}

/** 一块本机存储里二狗记的键；读不了（隐私模式、被禁用）是空的 */
function readStorage(area: StorageArea): StorageRow[] {
  try {
    const storage = area === "localStorage" ? window.localStorage : window.sessionStorage;
    const entries: [string, string][] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) entries.push([key, storage.getItem(key) ?? ""]);
    }
    return storageRows(area, entries);
  } catch {
    return [];
  }
}

/** 本机存储（localStorage、sessionStorage）里二狗记的键 */
export function storageSnapshot(): StorageRow[] {
  return [...readStorage("localStorage"), ...readStorage("sessionStorage")];
}

/** 重置首次提示的结果：页面一侧、App 一侧各一句 */
export interface ResetResult {
  readonly page: string;
  readonly app: string;
}

/**
 * 重置首次提示：页面一侧清掉"这个页面上要麦克风被拒过"的记号（之后进语音模式会再要一次麦克风）；浏览器的通知授权是浏览器自己记的，
 * 页面清不掉。App 一侧清掉 notify_asked（新版 App 才有这个方法）
 */
export function resetFirstPrompts(): ResetResult {
  resetMicDenied();
  const page = t("app.debugPage.resetPage");
  const notify = pageNativeApp()?.notify;
  if (!notify) return { page, app: t("app.debugPage.notInApp") };
  if (!notify.resetAsked) return { page, app: t("app.debugPage.appTooOld") };
  const state = notify.resetAsked();
  if (!state) return { page, app: t("app.debugPage.appNoReply") };
  return {
    page,
    app: t("app.debugPage.resetApp", {
      enabled: t(state.enabled ? "app.debugPage.notifyOn" : "app.debugPage.notifyOff"),
      asked: t(state.asked ? "app.debugPage.asked" : "app.debugPage.notAsked"),
    }),
  };
}
