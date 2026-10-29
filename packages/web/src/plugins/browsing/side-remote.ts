// 浏览侧边栏的侧边栏模式（147 号票，2026-10-18 用户纠正：浏览器是主体不缩，侧边栏盖在上面）：App 另开一个 Web 组件、加载二狗的网页
// 加上 ?ergo=side，摆在原生网页上面当侧边栏。这一份网页只画侧边栏（SideApp.tsx），状态在"浏览"页那一份（browse-side.ts 的 BrowseSide：
// 浏览器的编号、网页、选中的框、办秘书的网页工具）——
// - App 把"浏览"页报的样子（SideViewMessage）原样转过来：调这一页登记的 window.__ergoSide(json)；这一页起来时调 App 给的
//   window.ergoSide.ready()，App 再推一次最后的样子；
// - 侧边栏上的"收起"、× 经 window.ergoSide.close() / clearSelection() 交给 App，App 转给"浏览"页（NativeBrowserEvent 的 side）；
// - 发消息带的网页上下文按转过来的样子拼（浏览器的编号是"浏览"页那一份的：守护进程据此把秘书的网页工具转给那一页的连接）；
// - App 给这一页也挂了二狗的原生桥（window.ergoNative，主会话定：侧边栏挂二狗原生桥走原生录音），只有版本号、日志和录音那一组：
//   page-native.ts 照常认出在 App 里，"按住说话"走 App 的原生录音器；外观、返回键、通知、浏览器这些认不出，这一页什么都不变。
// - 275 号票（用户 2026-10-25：设置里改了界面风格，侧边栏要重启 App 才跟着变）：转过来的样子里带着"浏览"页那一份现在的外观
//   （appearance：外观、风格、主色），收到就交给 onAppearance（页面上那一份照着套：app/theme.ts 的 adopt，马上换、不写存储）。
//   设置在"浏览"页那一份里改，回到"浏览"时那一页重报一次样子，侧边栏跟着换；App 不用改（样子原样转）。
// 不碰浏览器的全局变量（App 给的对象、登记回调的地方都由参数给），测试在 Node 里跑；页面上那一份在 SideApp.tsx。
import type { BrowseSideView, SideViewMessage, SidebarControl } from "./browse-side.ts";
import { parsePageField } from "../../app/native-browser.ts";
import type { Appearance } from "../../app/theme.ts";
import { type BrowsingContext, THEME_CHOICES } from "../../state/index.ts";

/** 认不认得侧边栏模式是外壳的事（212 号票挪到 app/side-mode.ts），这里照旧转出 */
export { isSideMode, SIDE_MODE_PARAM, SIDE_MODE_VALUE } from "../../app/side-mode.ts";

/** App 给侧边栏的网页的对象（javaScriptProxy：window.ergoSide） */
export interface SideHostObject {
  close?: () => void;
  clearSelection?: () => void;
  ready?: () => void;
}

const BROWSER_ID = /^b-[0-9a-f]{16}$/;
/** 风格、主色的 id（风格清单里的写法：小写英文、数字、连字符） */
const STYLE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 转过来的外观（275 号票）：形状不对的当没有（风格、主色认不认识由页面上那一份的 adopt 按风格清单认） */
function parseAppearance(v: unknown): Appearance | undefined {
  if (!isObject(v) || typeof v.style !== "string" || !STYLE_ID.test(v.style)) return undefined;
  const theme = THEME_CHOICES.find((c) => c === v.theme);
  if (theme === undefined) return undefined;
  if (v.accent !== undefined && (typeof v.accent !== "string" || !STYLE_ID.test(v.accent))) return undefined;
  return { theme, style: v.style, ...(typeof v.accent === "string" ? { accent: v.accent } : {}) };
}

/** App 转过来的样子（JSON）：形状不对的当没有 */
export function parseSideView(json: unknown): SideViewMessage | undefined {
  let v: unknown;
  try {
    v = typeof json === "string" ? JSON.parse(json) : undefined;
  } catch {
    return undefined;
  }
  if (!isObject(v) || typeof v.open !== "boolean" || typeof v.browser !== "string" || !BROWSER_ID.test(v.browser)) return undefined;
  const page = isObject(v.page) && typeof v.page.title === "string" && typeof v.page.url === "string" ? { title: v.page.title.slice(0, 300), url: v.page.url.slice(0, 2048) } : undefined;
  // 选中的框（149 号票起带着框里现在的内容：侧边栏里发的消息带上它）
  const selected = parsePageField(v.selected);
  const appearance = parseAppearance(v.appearance);
  return {
    open: v.open,
    browser: v.browser,
    ...(page ? { page } : {}),
    ...(selected ? { selected } : {}),
    ...(typeof v.safeBottom === "string" && /^[\w\s().,-]{1,60}$/.test(v.safeBottom) ? { safeBottom: v.safeBottom } : {}),
    ...(appearance ? { appearance } : {}),
  };
}

/** 侧边栏模式这一页另要的（275 号票）：收到"浏览"页那一份的外观时交给谁（页面上是 pageTheme().adopt） */
export interface RemoteSideOptions {
  onAppearance?: (appearance: Appearance) => void;
}

/** 侧边栏模式这一页的侧边栏：样子跟着 App 转过来的，动作交给 App */
export class RemoteSide implements SidebarControl {
  private readonly host: () => SideHostObject | undefined;
  private readonly options: RemoteSideOptions;
  private message: SideViewMessage | undefined;
  private view: BrowseSideView = { open: true };
  private readonly listeners = new Set<() => void>();

  constructor(host: () => SideHostObject | undefined, options: RemoteSideOptions = {}) {
    this.host = host;
    this.options = options;
  }

  readonly snapshot = (): BrowseSideView => this.view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** App 转过来的（window.__ergoSide）；返回认没认 */
  receive(json: unknown): SideViewMessage | undefined {
    const message = parseSideView(json);
    if (!message) return undefined;
    this.message = message;
    // 外观先换（275 号票）：侧边栏重画时已经是新的风格
    if (message.appearance) this.options.onAppearance?.(message.appearance);
    this.view = { open: message.open, ...(message.page?.url ? { page: message.page } : {}), ...(message.selected ? { selected: message.selected } : {}) };
    for (const listener of this.listeners) listener();
    return message;
  }

  /** 起来了：让 App 再推一次最后的样子 */
  ready(): void {
    this.call("ready");
  }

  setOpen(open: boolean): void {
    if (!open) this.call("close");
  }

  clearSelection(): void {
    this.call("clearSelection");
  }

  context(): BrowsingContext {
    const m = this.message;
    // 还没收到"浏览"页的样子（App 还没推过来）：带一个认不出的浏览器，秘书的网页工具会说浏览器关了
    return { browser: m?.browser ?? "b-0000000000000000", page: m?.page ?? { title: "", url: "" }, ...(m?.selected ? { selected: m.selected } : {}) };
  }

  private call(method: "close" | "clearSelection" | "ready"): void {
    try {
      this.host()?.[method]?.();
    } catch {
      // App 拒绝了：什么都不做
    }
  }
}
