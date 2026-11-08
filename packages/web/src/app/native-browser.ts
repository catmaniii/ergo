// 鸿蒙 App 的原生内置浏览器在网页这一侧的接口。App 里的实现在 frontend/harmony/entry/src/main/ets/browser/
// （另一个 ArkWeb 的 Web 组件，叠在二狗的网页上面、盖住"浏览"页签的内容区），经原生桥 ergoNative 的这一组方法调：
// - browserAttach()：网页有"浏览"页签了（App 据此把主页面上点的外链改到这里打开，不再交给系统浏览器），回浏览器现在的样子（JSON）；
// - browserLayout(json)：内容区在页面上的位置大小（CSS 像素和 devicePixelRatio）、要不要显示——App 照着把浏览器的 Web 摆到那里，
//   转屏、宽窄屏切换时网页重新报；切到别的页签报 visible: false（Web 留着、只是藏起来，切回来页面原样还在）；
// - browserLoad(url)：打开一个网址（只认 http、https）；browserNav(action)：后退、前进、刷新、停止、用系统浏览器打开现在这一页。
// App 往网页推的（地址、标题、加载进度、能不能后退前进变了；主页面上点了外链、App 已经在浏览器里打开了，网页切到"浏览"）
// 调网页登记的 window.__ergoBrowser(json)。
// 这组方法都在才算有（新版 App）；没有（旧版 App、不在 App 里）时没有"浏览"页签，openInAppBrowser 照旧用嵌入框叠层，
// 外链照旧交给系统浏览器。App 回的东西形状不一定对：一律核对，不对就当没有，不抛错。
// （网页的框上的悬浮按钮）还有一组（NATIVE_PAGE_METHODS，都在才有 NativeBrowser.page）：
// - browserPage(op, argsJson)：调浏览器里网页上的页面桥（fields 列框、fill 填字、mark 按钮的样子、bubble 按钮旁边的气泡画成什么样），
//   回页面桥回的 JSON；
// - browserFileChunk(id, base64)：要交的文件一段一段写进 App 的缓存；browserFiles(json)：交进页面桥认出的框（塞进 input.files），
//   或交给 App 拦下的选文件对话框（handleFileList）；browserChooser(choice)：拦下的对话框上用户选了"自己选"（system）或取消。
// App 推过来的多三种：page（页面桥报的话：悬浮按钮挂在哪个框上、点了、长按说话、气泡上点了什么）、chooser（网页弹出选文件对话框、
// App 拦下了）、bubble-close（气泡开着时按了返回，App 先收起气泡）。
// 页面桥报的话出自外部网页里的脚本（App 核对过口令），这里照样按形状核对，只信形状对的。
// 浏览侧边栏：页面桥多报 selected（选中的框变了），气泡上多一个动作 sidebar（回话太长，去侧边栏看）；browserPage 多三个操作：selected 现问选中的框、
// text 取整页文字、clearSelection 取消选中（App 的 PageControl.ets 的 PAGE_OPS 里也要有）。
// 侧边栏由 App 画在原生网页上面（宽屏挤压：浏览器经 browserLayout 报的是让出右边之后的那一块，两者不相叠）：browserSide(json) 报侧边栏摆在哪
// （CSS 像素和 devicePixelRatio）和交给侧边栏网页的样子（view，JSON 字符串，App 原样转给侧边栏的网页）；App 推过来的多一种
// side（侧边栏上点了收起 close、× clearSelection、侧边栏里点了外部链接 link；toggle 留着备用）。有 browserSide 才有侧边栏（NativeBrowser.side）。
// browserPage 多一个操作 pick（挑图片窗口画成什么样，App 的 PAGE_OPS 里也要有），页面桥多报 pick（窗口上点了什么），
// App 推过来的多一种 pick-close（窗口开着时按了返回）；页面桥报的框带着框里的内容（value）；原生桥多一个可选的
// browserDiscard（放掉预备好了没用上的文件，新版 App 才有，NativePageControl.discard）。
// 能渲染的文件用二狗的渲染打开：原生桥多一个可选的 browserDoc(op, id)（新版 App 才有，NativeBrowser.docs）——
// enable 告诉 App 网页能渲染文件了（App 这才推 document、拦能渲染的下载）、source 取文件内容（页面上显示的字，或拦下的下载的字节 base64）、
// save 下载（页面上的经浏览器重新下载一次、拦下的直接弹"保存到"）、outside 用系统浏览器打开、drop 放掉拦下的下载在 App 缓存里的那份；
// App 推过来的多一种 document：浏览器里加载完一页（via page，带响应类型）、拦下了一个可能能渲染的下载（via download，带服务端给的文件名、大小）。
// 秘书看网页上能点的东西、按编号点：browserPage 多两个操作 snapshot、click（App 的 PAGE_OPS 里也要有）。旧版 App 不认
// （PAGE_OPS 里没有，回空串）：再问一次 selected，页面桥在就是 App 太旧（NativePageControl.snapshot / click 回 "old"），不在就是页面桥不在。
// 按编号填字、交文件：browserPage 多一个操作 refField（按编号找要填的文本框、要交的上传框，App 的 PAGE_OPS 里也要有；
// 旧版 App 同样回 "old"）；看的结果里多文本框、上传框、下拉框的字段；交文件的目标多一种按编号的（先 refField 找到框、再交进它的框编号）。
// "浏览"右上角 ⋮ 菜单：原生桥多一个可选的 browserTool(op, json)（新版 App 才有，NativeBrowser.tools），都回 Promise<string>（JSON）——
// find 在页面里查找（ArkWeb 的 searchAllAsync）、findNext 上一个 / 下一个、findClear 清掉高亮、sites 按网站记住的文字大小和桌面版
// （App 照着在每一页开始时设文字缩放、给这些网站换桌面版的浏览器标识）、share 系统分享面板、clear 清缓存 / Cookie 和网站数据、
// downloads 列下载记录、openDownload 打开一个、removeDownloads 删记录（不删文件）、findBar 查找栏开没开（返回手势先收起它）；
// App 推过来的多两种 find（查找结果：第几个、一共几个、数完了没有）、find-close（查找栏开着时按了返回，网页收起它）。
// 浏览侧边栏关着时悬浮按钮常驻右下角：页面桥多报 corner-open、corner-voice（不带框，只带这一页），开不开随 texts 交过去（fab），App 不用改。
// 长按网页元素的圆钮：页面桥多报 element、element-open、element-voice，气泡的发送可能带着元素；browserPage 多五个操作 elementInfo、elementPrepare、
// elementChunk、elementRect、elementShotDone（App 的 PAGE_OPS 里也要有）；browserTool 多几个操作（App 的 browser/ElementFiles）：elementFetch 带登录状态和来源页把一个
// 地址取进 App 的缓存、elementShot 截一块网页、elementRead 分段读出来、elementWrite 分段写进去、elementSave 弹"保存到"并记进下载记录、elementDownload 下载一个地址、
// elementDrop 放掉缓存里的那份。
import type { FindResult, NativeClearRequest, SiteTuning } from "../state/index.ts";
import type { PageBridgeEvent, PageBridgeMark, PageBubbleAction, PageBubbleView, PageInfo, PagePickAction, PagePickView } from "../page-bridge/protocol.ts";
import { FIELD_VALUE_MAX, PAGE_TEXT_MAX } from "../page-bridge/rules.ts";
import { exposeToApp } from "./app-names.ts";
import type { PageBridgeTexts } from "../page-bridge/texts.ts";
import { PAGE_ELEMENT_OPTION_MAX, PAGE_ELEMENT_OPTIONS_MAX, PAGE_ELEMENT_ROLES, PAGE_ELEMENT_VALUE_MAX, PICKED_ELEMENT_KINDS, PICKED_ELEMENT_LABEL_MAX, PICKED_ELEMENT_SOURCES, PICKED_ELEMENT_URL_MAX, type PageElement, type PageElementRole, type PageField, type PickedElement, type PickedElementKind, type PickedElementSource, t } from "../state/index.ts";

/**
 * 侧边栏上点了什么（App 转回来的）：开合（备用）、"收起"、×、侧边栏里点了外部链接（窄屏收起让用户看网页）。
 * App 推过来的话的一种，属于原生桥的接口（从浏览插件的 browse-side.ts 挪到这里：核心不 import 插件）
 */
export type SideAction = "toggle" | "close" | "clearSelection" | "link";

/** 原生桥上浏览器这一组方法的名字（NativeBridge.ets 的 NATIVE_BRIDGE_METHODS 里也是这几个） */
export const NATIVE_BROWSER_METHODS = ["browserAttach", "browserLayout", "browserLoad", "browserNav"] as const;

/** 原生桥上页面桥这一组方法的名字 */
export const NATIVE_PAGE_METHODS = ["browserPage", "browserFileChunk", "browserFiles", "browserChooser"] as const;

/** 原生桥上浏览侧边栏的方法：App 照着摆侧边栏和把手 */
export const NATIVE_SIDE_METHOD = "browserSide";

/** 原生桥上放掉预备好的文件的方法（新版 App 才有） */
export const NATIVE_DISCARD_METHOD = "browserDiscard";

/** 原生桥上能渲染的文件那一个方法（新版 App 才有）：browserDoc(op, id) */
export const NATIVE_DOC_METHOD = "browserDoc";

/** 原生桥上 ⋮ 菜单用到的原生工具（新版 App 才有）：browserTool(op, json) */
export const NATIVE_TOOL_METHOD = "browserTool";

/** 一条下载记录（App 记的：在浏览器里下载、存好了的文件）：名字、大小（字节）、存好的时间（毫秒）、存在哪（系统"保存到"给的地址）、类型 */
export interface DownloadRecord {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly time: number;
  readonly uri: string;
  readonly mime: string;
}

/** 清数据的结果：成了没有、要告诉用户的几句（缓存只能整个清、有几个 Cookie 没清掉……）、不成的原因 */
export interface ClearOutcome {
  readonly ok: boolean;
  readonly notes: readonly string[];
  readonly reason?: string;
}

/** ⋮ 菜单用到的原生工具（经 browserTool） */
export interface NativeToolControl {
  /** 在页面里查找（结果由 App 推 find）；空串等于清掉 */
  find(text: string): void;
  /** 下一个（forward）、上一个 */
  findNext(forward: boolean): void;
  /** 清掉高亮 */
  findClear(): void;
  /** 查找栏开着没有（App 据此让返回手势先收起查找栏，再退网页历史；收起时推 find-close） */
  findBar(open: boolean): void;
  /** 按网站记住的文字大小、桌面版（整份交过去，变了再交） */
  sites(tuning: SiteTuning): void;
  /** 系统分享面板：分享标题加网址 */
  share(page: { title: string; url: string }): Promise<PageOutcome>;
  /** 清缓存、Cookie 和网站数据 */
  clear(request: NativeClearRequest): Promise<ClearOutcome>;
  /** 下载记录（新的在前）；App 回的不对是空的 */
  downloads(): Promise<DownloadRecord[]>;
  /** 打开一个下载的文件 */
  openDownload(id: string): Promise<PageOutcome>;
  /** 删下载记录（文件留着） */
  removeDownloads(ids: readonly string[]): Promise<PageOutcome>;
  /** 长按元素的圆钮：取元素的内容、下载，放在 App 的缓存里 */
  readonly element: NativeElementFiles;
}

/** App 缓存里的一个元素文件：编号、名字、类型、大小 */
export interface AppElementFile {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

/**
 * App 没取成的原因：code 是 too-large 太大、http 服务端回了错误（status）、network 连不上、bad-url 地址不对、shot 截图不成、no-web 浏览器不在；
 * 不认识的操作（旧版 App）是 old。字由二狗的网页写
 */
export type AppElementFailure = { readonly ok: false; readonly code: string; readonly status?: number };

/** 取元素内容、下载这一组（经 browserTool） */
export interface NativeElementFiles {
  /** 带登录状态和来源页把一个地址取进缓存，超过 maxBytes 不要 */
  fetch(url: string, maxBytes: number): Promise<({ ok: true } & AppElementFile) | AppElementFailure>;
  /** 截网页的一块进缓存（物理像素，相对网页这一块的左上角） */
  shot(rect: { x: number; y: number; width: number; height: number }): Promise<({ ok: true } & AppElementFile) | AppElementFailure>;
  /** 从 offset 起读一段（base64 之后约 512 KB） */
  read(id: string, offset: number): Promise<{ ok: true; base64: string; done: boolean } | AppElementFailure>;
  /** 往缓存里写一段（id 空串是新建）：回编号 */
  write(id: string, base64: string): Promise<{ ok: true; id: string } | AppElementFailure>;
  /** 缓存里的这一份弹"保存到"，存好了记进下载记录（存好、取消都不留） */
  save(id: string, name: string, mime: string): Promise<{ ok: true } | AppElementFailure>;
  /** 下载一个地址（带登录状态和来源页）：下完弹"保存到"、记进下载记录。开头几秒就失败的回原因，还在下的回 ok */
  download(url: string): Promise<{ ok: true } | AppElementFailure>;
  /** 放掉缓存里的这一份 */
  drop(id: string): void;
}

/**
 * App 报来的一个文件：浏览器里加载完的一页（via page，mime 是 document.contentType），或拦下的一个下载（via download，
 * mime 是响应的类型，name 是服务端给的文件名，bytes 是大小）。编号 p…、d… 由 App 发，取内容、下载都凭它
 */
export interface BrowserDoc {
  readonly id: string;
  readonly url: string;
  readonly mime: string;
  readonly name: string;
  readonly via: "page" | "download";
  readonly bytes?: number;
}

/** 能渲染的文件这一组（经 browserDoc） */
export interface NativeDocControl {
  /** 网页能渲染文件了：App 这才推 document、拦能渲染的下载（旧版网页不调，App 照旧） */
  enable(): void;
  /** 文件内容：App 回的 JSON 原样（app/file-source.ts 的 nativeFileText 换成结果）；App 没回、出错是空串 */
  source(id: string): Promise<string>;
  /** 下载：页面上显示的经浏览器重新下载一次（不再拦），拦下的直接弹"保存到" */
  save(id: string): void;
  /** 用系统浏览器打开这个文件的地址 */
  outside(id: string): void;
  /** 不看了：拦下的下载在 App 缓存里的那份删掉 */
  drop(id: string): void;
}

/** 报给 App 的侧边栏（browse-side.ts 的 browseFrames 算的，CSS 像素）和交给侧边栏网页的样子（JSON 字符串） */
export interface SideReport {
  readonly dpr: number;
  readonly side: { readonly visible: boolean; readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly view: string;
}

/** 浏览器现在的样子：地址、标题、加载进度（0–100）、在不在加载、能不能后退、前进 */
export interface BrowserState {
  readonly url: string;
  readonly title: string;
  readonly progress: number;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** 还什么都没打开 */
export const BLANK_BROWSER: BrowserState = { url: "", title: "", progress: 0, loading: false, canGoBack: false, canGoForward: false };

/** 内容区在页面上的位置大小（CSS 像素，相对页面的视口）、要不要显示，和页面的 devicePixelRatio（App 按它换成自己的单位） */
export interface BrowserLayout {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** 顶栏的几个动作：后退、前进、刷新、停止加载、用系统浏览器打开现在这一页 */
export type BrowserNavAction = "back" | "forward" | "reload" | "stop" | "outside";

/** 网页弹出的选文件对话框（App 拦下了）：要什么类型、能不能选好几个、是不是要拍照、页面桥认出的是哪个框（认不出是空的） */
export interface ChooserRequest {
  readonly accept: readonly string[];
  readonly multiple: boolean;
  readonly capture: boolean;
  readonly fieldId: string;
}

/**
 * App 推过来的：state 浏览器的样子变了；open App 在浏览器里打开了一个链接（主页面上点的外链），网页切到"浏览"；
 * page 页面桥报的话；chooser 网页弹出选文件对话框、App 拦下了；bubble-close 气泡开着时按了返回；
 * pick-close 挑图片窗口开着时按了返回
 */
export type NativeBrowserEvent =
  | { type: "state"; state: BrowserState }
  | { type: "open"; url: string }
  | { type: "page"; event: PageBridgeEvent }
  | { type: "chooser"; chooser: ChooserRequest }
  | { type: "bubble-close" }
  | { type: "pick-close" }
  | { type: "side"; action: SideAction }
  | { type: "document"; doc: BrowserDoc }
  | { type: "find"; result: FindResult }
  | { type: "find-close" };

/** 交文件、调页面桥的结果 */
export interface PageOutcome {
  readonly ok: boolean;
  readonly count?: number;
  readonly reason?: string;
}

/** 要交的一个文件（字节已经写进 App 的缓存） */
export interface StagedFile {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
}

/** 整页文字：网页、文字、截没截、一共多少字 */
export interface PageText {
  readonly page: PageInfo;
  readonly text: string;
  readonly truncated: boolean;
  readonly total: number;
}

/** 网页上能点的东西：网页、能点的（编号由页面桥给）、一共几个；页面桥说不成的是原因 */
export type PageSnapshot = { ok: true; page: PageInfo; elements: PageElement[]; total: number } | { ok: false; reason: string };

/** 按编号点了：点了什么（种类、文字）、点完那一刻的网页；页面桥说不成的是原因（换了网页、元素不在了、字变了……） */
export type PageClick = { ok: true; role: PageElementRole; text: string; page: PageInfo } | { ok: false; reason: string };

/** 按编号找到的框：框的说法（id 是页面桥的框编号）、那一刻的网页；页面桥说不成的是原因（换了网页、种类不对……） */
export type PageRefField = { ok: true; page: PageInfo; field: PageField } | { ok: false; reason: string };

/** 交文件交到哪（多一种按编号的：url 是看的时候那一页的地址） */
export type DeliverTarget = { fieldId: string } | { ref: string; url: string } | "chooser";

/** 旧版 App 不认 snapshot、click（页面桥照样在） */
export type AppTooOld = "old";

/** 按编号找长按认出来的元素：元素的说法、那一刻的网页；换了网页、元素不在了是原因 */
export type PageElementInfo = { ok: true; page: PageInfo; element: PickedElement } | { ok: false; reason: string };

/** 页面里读好的一段：还在读 ready 为假；读到了是 base64、类型、一共多少字节、读完没有 */
export type PageElementChunk = { ok: true; ready: false } | { ok: true; ready: true; base64: string; mime: string; total: number; done: boolean } | { ok: false; reason: string };

/** 要截图的元素在网页这一块上的位置（物理像素）；partial 是只有一部分在屏幕上 */
export type PageElementRect = { ok: true; x: number; y: number; width: number; height: number; partial: boolean } | { ok: false; reason: string };

/** 页面桥这一组 */
export interface NativePageControl {
  /** 页面上能填的框（页面桥现列）；页面桥不在是 undefined */
  fields(): Promise<{ page: PageInfo; fields: PageField[] } | undefined>;
  fill(fieldId: string, text: string): Promise<PageOutcome>;
  mark(fieldId: string, mark: PageBridgeMark): void;
  /** 悬浮按钮旁边的气泡画成这个样子；页面桥不在、没画上是 false */
  bubble(view: PageBubbleView): Promise<boolean>;
  /** 挑图片窗口画成这个样子；页面桥不在、旧版 App 不认、没画上是 false */
  pick(view: PagePickView): Promise<boolean>;
  /** 页面桥自己的字换成当前语言的这几句；旧版 App 不认、页面桥不在就算了（页面桥照旧中文） */
  texts?(texts: PageBridgeTexts): void;
  /** 把一个文件的字节交给 App（分段，每段 base64 后约 512 KB）；交不了是 false */
  putFile(id: string, bytes: Uint8Array): Promise<boolean>;
  /** 交文件：交进页面桥认出的框，或交给拦下的选文件对话框；也能按编号交（先找到上传框，找不到回原因） */
  deliver(target: DeliverTarget, files: readonly StagedFile[]): Promise<PageOutcome>;
  /** 拦下的选文件对话框：自己选（系统的选择器）或取消 */
  chooser(choice: "system" | "cancel"): Promise<PageOutcome>;
  /** 现在选中的框；页面桥不在是 undefined */
  selected(): Promise<{ page: PageInfo; field: PageField | null } | undefined>;
  /** 整页文字；页面桥不在是 undefined */
  text(): Promise<PageText | undefined>;
  /** 取消选中 */
  clearSelection(): Promise<PageOutcome>;
  /** 放掉交给 App 暂存、没用上的文件（预备好的候选）；旧版 App 没有 */
  discard?(ids: readonly string[]): void;
  /** 网页上能点的东西，最多 max 个；旧版 App 是 "old"，页面桥不在是 undefined */
  snapshot(max: number): Promise<PageSnapshot | AppTooOld | undefined>;
  /** 按编号点，url 是看的时候那一页的地址；旧版 App 是 "old"，页面桥不在是 undefined */
  click(ref: string, url: string): Promise<PageClick | AppTooOld | undefined>;
  /** 按编号找要填的文本框、要交的上传框，url 同上；旧版 App 是 "old"，页面桥不在是 undefined */
  refField(ref: string, url: string, want: "textbox" | "upload"): Promise<PageRefField | AppTooOld | undefined>;
  /** 按编号找长按认出来的元素，url 是那一页的地址；旧版 App 是 "old"，页面桥不在是 undefined */
  elementInfo(id: string, url: string): Promise<PageElementInfo | AppTooOld | undefined>;
  /** blob:、data:、canvas 只有页面读得到：开始读；读不了是原因 */
  elementPrepare(id: string, url: string): Promise<PageOutcome>;
  /** 读好的一段 */
  elementChunk(id: string, offset: number): Promise<PageElementChunk>;
  /** 要截这个元素的图了：滚到看得见、藏起页面桥这一层，回它的位置 */
  elementRect(id: string, url: string): Promise<PageElementRect>;
  /** 截完了，把页面桥这一层放回来 */
  elementShotDone(): void;
}

export interface NativeBrowser {
  /** 告诉 App 网页有"浏览"页签了，取浏览器现在的样子（App 回的不对是 undefined） */
  attach(): BrowserState | undefined;
  layout(layout: BrowserLayout): void;
  load(url: string): void;
  nav(action: BrowserNavAction): void;
  /** 收 App 推过来的；返回退订 */
  subscribe(listener: (event: NativeBrowserEvent) => void): () => void;
  /** 页面桥这一组（新版 App 才有） */
  readonly page?: NativePageControl;
  /** 浏览侧边栏（新版 App 才有）：报侧边栏、把手摆在哪 */
  readonly side?: (report: SideReport) => void;
  /** 能渲染的文件（新版 App 才有） */
  readonly docs?: NativeDocControl;
  /** ⋮ 菜单用到的原生工具（新版 App 才有） */
  readonly tools?: NativeToolControl;
}

/** 页面上登记推送回调的地方（window） */
export interface NativeBrowserScope {
  __ergoBrowser?: (json: string) => void;
}

type BridgeObject = Record<string, unknown>;
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(text: unknown): Json | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** App 回的、推过来的浏览器的样子；地址不是 http(s)（还没打开、about:blank）的当空 */
export function parseBrowserState(value: unknown): BrowserState | undefined {
  const s = typeof value === "string" ? parse(value) : isObject(value) ? value : undefined;
  if (!s) return undefined;
  const url = typeof s.url === "string" && /^https?:\/\//i.test(s.url) ? s.url : "";
  const progress = typeof s.progress === "number" && Number.isFinite(s.progress) ? Math.min(100, Math.max(0, Math.round(s.progress))) : 0;
  return {
    url,
    title: typeof s.title === "string" ? s.title : "",
    progress,
    loading: s.loading === true,
    canGoBack: s.canGoBack === true,
    canGoForward: s.canGoForward === true,
  };
}

const PAGE_FIELD_KINDS: readonly string[] = ["text", "textarea", "editable", "file"];
const FIELD_ID = /^f\d{1,6}$/;
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

/** 页面桥报的框（侧边栏模式那一页收 App 转过来的也用它）：形状不对的当没有；框里的内容截到 FIELD_VALUE_MAX 字 */
export function parsePageField(value: unknown): PageField | undefined {
  if (!isObject(value) || typeof value.id !== "string" || !FIELD_ID.test(value.id) || typeof value.kind !== "string" || !PAGE_FIELD_KINDS.includes(value.kind)) return undefined;
  const placeholder = text(value.placeholder, 80);
  const inputType = text(value.inputType, 20);
  const accept = text(value.accept, 200);
  const v = value.value;
  const content = isObject(v) && typeof v.text === "string" ? { text: v.text.slice(0, FIELD_VALUE_MAX), total: typeof v.total === "number" && Number.isFinite(v.total) ? Math.max(Math.round(v.total), Math.min(v.text.length, FIELD_VALUE_MAX)) : v.text.length } : undefined;
  return {
    id: value.id,
    kind: value.kind as PageField["kind"],
    label: text(value.label, 80) ?? "",
    ...(placeholder ? { placeholder } : {}),
    ...(inputType ? { inputType } : {}),
    ...(accept ? { accept } : {}),
    ...(value.multiple === true ? { multiple: true } : {}),
    ...(content && value.kind !== "file" ? { value: content } : {}),
  };
}

const fieldOf = parsePageField;

function pageInfoOf(value: unknown): PageInfo | undefined {
  if (!isObject(value) || typeof value.title !== "string" || typeof value.url !== "string" || !/^https?:\/\//i.test(value.url)) return undefined;
  return { title: value.title.slice(0, 300), url: value.url.slice(0, 2048) };
}

function fieldsOf(value: unknown): PageField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 60).flatMap((f) => fieldOf(f) ?? []);
}

const ELEMENT_REF = /^e\d{1,6}$/;

/** 页面桥交来的一个能点的东西：编号、种类不对的丢掉；文字截到 200，地址只认 http(s)、截到 2000 */
function elementOf(value: unknown): PageElement | undefined {
  if (!isObject(value) || typeof value.ref !== "string" || !ELEMENT_REF.test(value.ref) || typeof value.text !== "string") return undefined;
  if (typeof value.role !== "string" || !(PAGE_ELEMENT_ROLES as readonly string[]).includes(value.role)) return undefined;
  const href = typeof value.href === "string" && /^https?:\/\//i.test(value.href) ? value.href.slice(0, 2000) : undefined;
  // 文本框、上传框、下拉框的字段（形状不对的不要）
  const value40 = typeof value.valuePreview === "string" && value.valuePreview ? value.valuePreview.slice(0, PAGE_ELEMENT_VALUE_MAX) : undefined;
  const accept = typeof value.accept === "string" && value.accept ? value.accept.slice(0, 200) : undefined;
  const options = Array.isArray(value.options)
    ? value.options
        .filter((o): o is string => typeof o === "string")
        .slice(0, PAGE_ELEMENT_OPTIONS_MAX)
        .map((o) => o.slice(0, PAGE_ELEMENT_OPTION_MAX))
    : undefined;
  return {
    ref: value.ref,
    role: value.role as PageElementRole,
    text: value.text.slice(0, 200),
    ...(href ? { href } : {}),
    ...(value.disabled === true ? { disabled: true } : {}),
    ...(value40 ? { valuePreview: value40 } : {}),
    ...(value.multiline === true ? { multiline: true } : {}),
    ...(accept ? { accept } : {}),
    ...(value.multiple === true ? { multiple: true } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(value.hidden === true ? { hidden: true } : {}),
  };
}

const webUrl = (v: unknown): string | undefined => (typeof v === "string" && /^https?:\/\//i.test(v) && v.length <= PICKED_ELEMENT_URL_MAX ? v : undefined);

/** 页面桥报的长按认出来的元素：编号、种类不对的丢掉；地址只认 http(s)，字截到上限 */
export function pickedElementOf(value: unknown): PickedElement | undefined {
  if (!isObject(value) || typeof value.id !== "string" || !/^x[0-9]{1,6}$/.test(value.id)) return undefined;
  if (typeof value.kind !== "string" || !(PICKED_ELEMENT_KINDS as readonly string[]).includes(value.kind)) return undefined;
  const source = typeof value.source === "string" && (PICKED_ELEMENT_SOURCES as readonly string[]).includes(value.source) ? (value.source as PickedElementSource) : undefined;
  const src = webUrl(value.src);
  const href = webUrl(value.href);
  const label = text(value.label, PICKED_ELEMENT_LABEL_MAX);
  const contentOf = (v: unknown) =>
    isObject(v) && typeof v.text === "string" ? { text: v.text.slice(0, FIELD_VALUE_MAX), total: typeof v.total === "number" && Number.isFinite(v.total) ? Math.max(Math.round(v.total), 0) : v.text.length } : undefined;
  const content = contentOf(value.text);
  const around = contentOf(value.around);
  return {
    id: value.id,
    kind: value.kind as PickedElementKind,
    ...(source ? { source } : {}),
    ...(src ? { src } : {}),
    ...(href ? { href } : {}),
    ...(label ? { label } : {}),
    ...(content ? { text: content } : {}),
    ...(value.selected === true ? { selected: true as const } : {}),
    ...(around ? { around } : {}),
  };
}

/** 页面桥说不成的原因（看、点） */
const refusal = (reply: Json | undefined) => ({ ok: false as const, reason: typeof reply?.reason === "string" && reply.reason ? reply.reason.slice(0, 500) : "页面桥没回结果" }); // @i18n-ignore model：看、点网页的原因进秘书的网页工具结果（给模型看）

/** 打的字最多多少（和协议的 PAGE_COMMAND_TEXT_MAX 一样；这里只按长度截，守护进程再核对） */
const BUBBLE_TEXT_MAX = 2000;

/** 气泡上点的：动作认得、带的字形状对才认；发送带着的框形状不对就不带 */
function bubbleActionOf(e: Json): PageBubbleAction | undefined {
  switch (e.action) {
    case "send": {
      if (typeof e.text !== "string" || e.text.trim() === "") return undefined;
      const field = fieldOf(e.field);
      const element = pickedElementOf(e.element);
      return { action: "send", text: e.text.slice(0, BUBBLE_TEXT_MAX), ...(field ? { field } : {}), ...(element ? { element } : {}) };
    }
    case "close":
    case "ergo":
    case "system":
    case "sidebar":
      return { action: e.action };
    default:
      return undefined;
  }
}

/** 挑图片窗口上点的：哪张卡、动作认得、带的取件码形状对才认 */
function pickActionOf(e: Json): PagePickAction | undefined {
  if (typeof e.id !== "string" || e.id === "" || e.id.length > 100) return undefined;
  const id = e.id;
  switch (e.action) {
    case "choose":
      return typeof e.token === "string" && e.token !== "" && e.token.length <= 64 ? { id, action: "choose", token: e.token } : undefined;
    case "deliver":
    case "dismiss":
    case "hide":
      return { id, action: e.action };
    default:
      return undefined;
  }
}

/** 页面桥报的话（App 原样转过来的 JSON）；形状不对的当没有 */
export function parsePageEvent(json: unknown): PageBridgeEvent | undefined {
  const e = parse(json);
  if (!e) return undefined;
  if (e.type === "bubble") {
    const action = bubbleActionOf(e);
    return action ? { type: "bubble", ...action } : undefined;
  }
  if (e.type === "pick") {
    const action = pickActionOf(e);
    return action ? { type: "pick", ...action } : undefined;
  }
  if (e.type === "field") {
    if (e.field === null) return { type: "field", field: null };
    const field = fieldOf(e.field);
    return field ? { type: "field", field } : undefined;
  }
  if (e.type === "chooser-field") {
    const field = fieldOf(e.field);
    return field ? { type: "chooser-field", field } : undefined;
  }
  if (e.type === "selected") {
    const page = pageInfoOf(e.page);
    if (!page) return undefined;
    if (e.field === null) return { type: "selected", field: null, page };
    const field = fieldOf(e.field);
    return field ? { type: "selected", field, page } : undefined;
  }
  if (e.type === "element") {
    if (e.element === null) return { type: "element", element: null };
    const element = pickedElementOf(e.element);
    return element ? { type: "element", element } : undefined;
  }
  if (e.type === "element-open" || e.type === "element-voice") {
    const element = pickedElementOf(e.element);
    const at = pageInfoOf(e.page);
    if (!element || !at) return undefined;
    if (e.type === "element-open") return { type: "element-open", element, page: at };
    return e.phase === "press" || e.phase === "start" || e.phase === "stop" || e.phase === "cancel" ? { type: "element-voice", phase: e.phase, element, page: at } : undefined;
  }
  if (e.type === "corner-open" || e.type === "corner-voice") {
    const at = pageInfoOf(e.page);
    if (!at) return undefined;
    if (e.type === "corner-open") return { type: "corner-open", page: at };
    return e.phase === "press" || e.phase === "start" || e.phase === "stop" || e.phase === "cancel" ? { type: "corner-voice", phase: e.phase, page: at } : undefined;
  }
  const field = fieldOf(e.field);
  const page = pageInfoOf(e.page);
  const fields = fieldsOf(e.fields);
  if (!field || !page || !fields) return undefined;
  if (e.type === "open") return { type: "open", field, page, fields };
  if (e.type === "voice" && (e.phase === "press" || e.phase === "start" || e.phase === "stop" || e.phase === "cancel")) return { type: "voice", phase: e.phase, field, page, fields };
  return undefined;
}

const DOC_ID = /^[pd]\d{1,9}$/;

/** App 报来的文件：形状不对的当没有 */
function docOf(value: unknown): BrowserDoc | undefined {
  if (!isObject(value) || typeof value.id !== "string" || !DOC_ID.test(value.id) || typeof value.url !== "string" || !/^https?:\/\//i.test(value.url)) return undefined;
  if (value.via !== "page" && value.via !== "download") return undefined;
  const bytes = typeof value.bytes === "number" && Number.isFinite(value.bytes) && value.bytes >= 0 ? Math.round(value.bytes) : undefined;
  return {
    id: value.id,
    url: value.url.slice(0, 4096),
    mime: typeof value.mime === "string" ? value.mime.slice(0, 200) : "",
    name: typeof value.name === "string" ? value.name.slice(0, 255) : "",
    via: value.via,
    ...(bytes !== undefined ? { bytes } : {}),
  };
}

/** 非负整数（查找结果的第几个、一共几个）；不是数是 undefined */
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined);

function eventOf(json: unknown): NativeBrowserEvent | undefined {
  const e = parse(json);
  if (!e) return undefined;
  if (e.type === "document") {
    const doc = docOf(e.doc);
    return doc ? { type: "document", doc } : undefined;
  }
  if (e.type === "find") {
    const active = count(e.active);
    const total = count(e.total);
    return active === undefined || total === undefined ? undefined : { type: "find", result: { active, total, done: e.done === true } };
  }
  if (e.type === "state") {
    const state = parseBrowserState(e.state);
    return state ? { type: "state", state } : undefined;
  }
  if (e.type === "open" && typeof e.url === "string" && /^https?:\/\//i.test(e.url)) return { type: "open", url: e.url };
  if (e.type === "bubble-close") return { type: "bubble-close" };
  if (e.type === "pick-close") return { type: "pick-close" };
  if (e.type === "find-close") return { type: "find-close" };
  if (e.type === "page") {
    const event = parsePageEvent(e.json);
    return event ? { type: "page", event } : undefined;
  }
  if (e.type === "side" && (e.action === "toggle" || e.action === "close" || e.action === "clearSelection" || e.action === "link")) return { type: "side", action: e.action };
  if (e.type === "chooser") {
    const accept = Array.isArray(e.accept) ? e.accept.filter((a): a is string => typeof a === "string").slice(0, 20) : [];
    const fieldId = typeof e.fieldId === "string" && FIELD_ID.test(e.fieldId) ? e.fieldId : "";
    return { type: "chooser", chooser: { accept, multiple: e.multiple === true, capture: e.capture === true, fieldId } };
  }
  return undefined;
}

/** 原生桥上有浏览器这一组方法就包装起来、在 scope 上登记推送回调；没有（旧版 App）返回 undefined */
export function wrapNativeBrowser(bridge: BridgeObject, scope: NativeBrowserScope): NativeBrowser | undefined {
  if (!NATIVE_BROWSER_METHODS.every((m) => typeof bridge[m] === "function")) return undefined;
  const listeners = new Set<(event: NativeBrowserEvent) => void>();
  exposeToApp(scope, "__ergoBrowser", (json: string) => {
    const event = eventOf(json);
    if (event) for (const listener of listeners) listener(event);
  });
  const call = (method: string, ...args: string[]): unknown => {
    try {
      return (bridge[method] as (...a: string[]) => unknown).apply(bridge, args);
    } catch {
      // App 拒绝了或出错：网页照常
      return undefined;
    }
  };
  const page = NATIVE_PAGE_METHODS.every((m) => typeof bridge[m] === "function") ? wrapPageControl(bridge, typeof bridge[NATIVE_DISCARD_METHOD] === "function") : undefined;
  const side = typeof bridge[NATIVE_SIDE_METHOD] === "function" ? (report: SideReport) => void call(NATIVE_SIDE_METHOD, JSON.stringify(report)) : undefined;
  const docs = typeof bridge[NATIVE_DOC_METHOD] === "function" ? wrapDocControl(bridge) : undefined;
  const tools = typeof bridge[NATIVE_TOOL_METHOD] === "function" ? wrapToolControl(bridge) : undefined;
  return {
    ...(page ? { page } : {}),
    ...(side ? { side } : {}),
    ...(docs ? { docs } : {}),
    ...(tools ? { tools } : {}),
    attach: () => parseBrowserState(call("browserAttach")),
    layout: (layout) => void call("browserLayout", JSON.stringify(layout)),
    load: (url) => void call("browserLoad", url),
    nav: (action) => void call("browserNav", action),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** 能渲染的文件这一组的包装：都经 browserDoc(op, id)，App 回 Promise<string>；出错、回的不是字符串当空串 */
function wrapDocControl(bridge: BridgeObject): NativeDocControl {
  const ask = async (op: string, id: string): Promise<string> => {
    try {
      const value: unknown = await (bridge[NATIVE_DOC_METHOD] as (op: string, id: string) => unknown).call(bridge, op, id);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  return {
    enable: () => void ask("enable", ""),
    source: (id) => ask("source", id),
    save: (id) => void ask("save", id),
    outside: (id) => void ask("outside", id),
    drop: (id) => void ask("drop", id),
  };
}

/** 一条下载记录（App 回的）：形状不对的当没有 */
function downloadOf(value: unknown): DownloadRecord | undefined {
  if (!isObject(value)) return undefined;
  const { id, name, size, time, uri, mime } = value;
  if (typeof id !== "string" || id === "" || id.length > 64 || typeof name !== "string" || typeof uri !== "string" || uri === "") return undefined;
  if (typeof size !== "number" || !Number.isFinite(size) || typeof time !== "number" || !Number.isFinite(time)) return undefined;
  return { id, name: name.slice(0, 255), size: Math.max(0, Math.round(size)), time, uri: uri.slice(0, 4096), mime: typeof mime === "string" ? mime.slice(0, 200) : "" };
}

/** ⋮ 菜单用到的原生工具的包装：都经 browserTool(op, json)，App 回 Promise<string>；出错、回的不对当失败 */
function wrapToolControl(bridge: BridgeObject): NativeToolControl {
  const ask = async (op: string, args: unknown): Promise<string> => {
    try {
      const value: unknown = await (bridge[NATIVE_TOOL_METHOD] as (op: string, json: string) => unknown).call(bridge, op, JSON.stringify(args));
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  return {
    find: (query) => void ask("find", { text: query }),
    findNext: (forward) => void ask("findNext", { forward }),
    findClear: () => void ask("findClear", {}),
    findBar: (open) => void ask("findBar", { open }),
    sites: (tuning) => void ask("sites", tuning),
    share: async (page) => outcomeOf(await ask("share", { title: page.title, url: page.url })),
    async clear(request) {
      const reply = parse(await ask("clear", request));
      if (!reply || typeof reply.ok !== "boolean") return { ok: false, notes: [], reason: t("app.nativeBrowser.noReply") };
      const notes = Array.isArray(reply.notes) ? reply.notes.filter((n): n is string => typeof n === "string").slice(0, 10) : [];
      return { ok: reply.ok, notes, ...(typeof reply.reason === "string" && reply.reason ? { reason: reply.reason } : {}) };
    },
    async downloads() {
      const reply = parse(await ask("downloads", {}));
      const list = Array.isArray(reply?.downloads) ? reply.downloads.slice(0, 500).flatMap((d) => downloadOf(d) ?? []) : [];
      return list.toSorted((a, b) => b.time - a.time);
    },
    openDownload: async (id) => outcomeOf(await ask("openDownload", { id })),
    removeDownloads: async (ids) => outcomeOf(await ask("removeDownloads", { ids })),
    element: wrapElementFiles(ask),
  };
}

/** App 没回、回的不对、不认这个操作（旧版 App 回 ok: false 和原因，没有 code）：都是 old */
function elementFailureOf(reply: Json | undefined): AppElementFailure {
  const code = typeof reply?.code === "string" && reply.code ? reply.code.slice(0, 40) : "old";
  const status = typeof reply?.status === "number" && Number.isFinite(reply.status) ? reply.status : undefined;
  return { ok: false, code, ...(status !== undefined ? { status } : {}) };
}

function appElementFileOf(reply: Json | undefined): ({ ok: true } & AppElementFile) | AppElementFailure {
  if (reply?.ok !== true || typeof reply.id !== "string" || typeof reply.size !== "number") return elementFailureOf(reply);
  return {
    ok: true,
    id: reply.id,
    name: typeof reply.name === "string" ? reply.name.slice(0, 255) : "",
    mime: typeof reply.mime === "string" ? reply.mime.slice(0, 200) : "",
    size: reply.size,
  };
}

const elementOkOf = (reply: Json | undefined): { ok: true } | AppElementFailure => (reply?.ok === true ? { ok: true } : elementFailureOf(reply));

function wrapElementFiles(ask: (op: string, args: unknown) => Promise<string>): NativeElementFiles {
  return {
    fetch: async (url, maxBytes) => appElementFileOf(parse(await ask("elementFetch", { url, maxBytes }))),
    shot: async (rect) => appElementFileOf(parse(await ask("elementShot", rect))),
    async read(id, offset) {
      const reply = parse(await ask("elementRead", { id, offset }));
      return reply?.ok === true && typeof reply.base64 === "string" ? { ok: true, base64: reply.base64, done: reply.done === true } : elementFailureOf(reply);
    },
    async write(id, base64) {
      const reply = parse(await ask("elementWrite", { id, base64 }));
      return reply?.ok === true && typeof reply.id === "string" ? { ok: true, id: reply.id } : elementFailureOf(reply);
    },
    save: async (id, name, mime) => elementOkOf(parse(await ask("elementSave", { id, name, mime }))),
    download: async (url) => elementOkOf(parse(await ask("elementDownload", { url }))),
    drop: (id) => void ask("elementDrop", { id }),
  };
}

/** 交给 App 时一段多少字节（base64 之后约 512 KB） */
const FILE_CHUNK_BYTES = 384 * 1024;

/** 一段字节的 base64（分段转，大文件也不爆调用栈） */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function outcomeOf(json: unknown): PageOutcome {
  const o = parse(json);
  if (!o || typeof o.ok !== "boolean") return { ok: false, reason: t("app.nativeBrowser.noReply") };
  return { ok: o.ok, ...(typeof o.count === "number" ? { count: o.count } : {}), ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}) };
}

/** 页面桥这一组的包装：App 都回 Promise<string>，回的不对一律当失败；canDiscard：App 有放掉预备文件的方法 */
function wrapPageControl(bridge: BridgeObject, canDiscard: boolean): NativePageControl {
  const ask = async (method: string, ...args: string[]): Promise<string> => {
    try {
      const value: unknown = await (bridge[method] as (...a: string[]) => unknown).apply(bridge, args);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  /** 现在选中的框；回的不对是 undefined */
  const selected = async (): Promise<{ page: PageInfo; field: PageField | null } | undefined> => {
    const reply = parse(await ask("browserPage", "selected", "[]"));
    const page = pageInfoOf(reply?.page);
    if (!page || !reply || !("field" in reply)) return undefined;
    if (reply.field === null) return { page, field: null };
    const field = fieldOf(reply.field);
    return field ? { page, field } : undefined;
  };
  /** 页面桥的新操作回空串：页面桥照样在（selected 回得出来）是旧版 App 不认这个操作，不在就是页面桥不在 */
  const tooOld = async (): Promise<AppTooOld | undefined> => ((await selected()) ? "old" : undefined);
  /** 按编号找框 */
  const refField = async (ref: string, url: string, want: "textbox" | "upload"): Promise<PageRefField | AppTooOld | undefined> => {
    const raw = await ask("browserPage", "refField", JSON.stringify([ref, url, want]));
    if (raw === "") return tooOld();
    const reply = parse(raw);
    const page = pageInfoOf(reply?.page);
    const field = reply?.ok === true ? fieldOf(reply.field) : undefined;
    if (!page || !field) return refusal(reply);
    return { ok: true, page, field };
  };
  /** 交进页面桥认出的框、或交给拦下的选文件对话框 */
  const deliverTo = async (target: { fieldId: string } | "chooser", files: readonly StagedFile[]) =>
    outcomeOf(await ask("browserFiles", JSON.stringify(target === "chooser" ? { target: "chooser", files } : { target: "field", fieldId: target.fieldId, files })));
  return {
    refField,
    async snapshot(max) {
      const raw = await ask("browserPage", "snapshot", JSON.stringify([String(max)]));
      if (raw === "") return tooOld();
      const reply = parse(raw);
      const page = pageInfoOf(reply?.page);
      if (reply?.ok !== true || !page || !Array.isArray(reply.elements)) return refusal(reply);
      const elements = reply.elements.slice(0, 100).flatMap((e) => elementOf(e) ?? []);
      const total = typeof reply.total === "number" && Number.isFinite(reply.total) ? Math.max(elements.length, Math.round(reply.total)) : elements.length;
      return { ok: true, page, elements, total };
    },
    async click(ref, url) {
      const raw = await ask("browserPage", "click", JSON.stringify([ref, url]));
      if (raw === "") return tooOld();
      const reply = parse(raw);
      const page = pageInfoOf(reply?.page);
      const role = typeof reply?.role === "string" && (PAGE_ELEMENT_ROLES as readonly string[]).includes(reply.role) ? (reply.role as PageElementRole) : undefined;
      if (reply?.ok !== true || !page || !role || typeof reply.text !== "string") return refusal(reply);
      return { ok: true, role, text: reply.text.slice(0, 200), page };
    },
    async fields() {
      const reply = parse(await ask("browserPage", "fields", "[]"));
      const page = pageInfoOf(reply?.page);
      const fields = fieldsOf(reply?.fields);
      return page && fields ? { page, fields } : undefined;
    },
    fill: async (fieldId, value) => outcomeOf(await ask("browserPage", "fill", JSON.stringify([fieldId, value]))),
    mark: (fieldId, mark) => void ask("browserPage", "mark", JSON.stringify([fieldId, mark])),
    bubble: async (view) => outcomeOf(await ask("browserPage", "bubble", JSON.stringify([JSON.stringify(view)]))).ok,
    pick: async (view) => outcomeOf(await ask("browserPage", "pick", JSON.stringify([JSON.stringify(view)]))).ok,
    texts: (texts) => void ask("browserPage", "texts", JSON.stringify([JSON.stringify(texts)])),
    ...(canDiscard ? { discard: (ids: readonly string[]) => void ask(NATIVE_DISCARD_METHOD, JSON.stringify(ids)) } : {}),
    async putFile(id, bytes) {
      let at = 0;
      do {
        const done = outcomeOf(await ask("browserFileChunk", id, base64Of(bytes.subarray(at, at + FILE_CHUNK_BYTES))));
        if (!done.ok) return false;
        at += FILE_CHUNK_BYTES;
      } while (at < bytes.length);
      return true;
    },
    async deliver(target, files) {
      if (target === "chooser" || !("ref" in target)) return deliverTo(target, files);
      // 按编号交：交之前再找一次框（还是那一页、编号认得、还是上传框），交进它的框编号
      const found = await refField(target.ref, target.url, "upload");
      if (found === "old") return { ok: false, reason: t("app.nativeBrowser.refTooOld") };
      if (!found) return { ok: false, reason: t("app.nativeBrowser.bridgeGone") };
      if (!found.ok) return found;
      return deliverTo({ fieldId: found.field.id }, files);
    },
    chooser: async (choice) => outcomeOf(await ask("browserChooser", choice)),
    selected,
    async text() {
      const reply = parse(await ask("browserPage", "text", "[]"));
      const page = pageInfoOf(reply?.page);
      if (!page || reply?.ok !== true || typeof reply.text !== "string") return undefined;
      const total = typeof reply.total === "number" && Number.isFinite(reply.total) ? Math.max(0, Math.round(reply.total)) : reply.text.length;
      return { page, text: reply.text.slice(0, PAGE_TEXT_MAX), truncated: reply.truncated === true || reply.text.length > PAGE_TEXT_MAX, total };
    },
    clearSelection: async () => outcomeOf(await ask("browserPage", "clearSelection", "[]")),
    async elementInfo(id, url) {
      const reply = parse(await ask("browserPage", "elementInfo", JSON.stringify([id, url])));
      if (!reply) return (await selected()) ? "old" : undefined;
      if (reply.ok !== true) return refusal(reply);
      const page = pageInfoOf(reply.page);
      const element = pickedElementOf(reply.element);
      return page && element ? { ok: true, page, element } : refusal(undefined);
    },
    elementPrepare: async (id, url) => outcomeOf(await ask("browserPage", "elementPrepare", JSON.stringify([id, url]))),
    async elementChunk(id, offset) {
      const reply = parse(await ask("browserPage", "elementChunk", JSON.stringify([id, String(offset)])));
      if (reply?.ok !== true) return refusal(reply);
      if (reply.ready !== true) return { ok: true, ready: false };
      if (typeof reply.base64 !== "string" || typeof reply.total !== "number") return refusal(undefined);
      return { ok: true, ready: true, base64: reply.base64, mime: typeof reply.mime === "string" ? reply.mime.slice(0, 200) : "application/octet-stream", total: reply.total, done: reply.done === true };
    },
    async elementRect(id, url) {
      const reply = parse(await ask("browserPage", "elementRect", JSON.stringify([id, url])));
      if (reply?.ok !== true || typeof reply.x !== "number" || typeof reply.y !== "number" || typeof reply.width !== "number" || typeof reply.height !== "number") return refusal(reply);
      return { ok: true, x: reply.x, y: reply.y, width: reply.width, height: reply.height, partial: reply.partial === true };
    },
    elementShotDone: () => void ask("browserPage", "elementShotDone", "[]"),
  };
}

/** 一个地址是不是外部网站的网页（http、https，和二狗不同源）：在 App 里这种链接改到"浏览"里打开 */
export function isExternalWebUrl(href: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href, `${origin}/`);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin !== origin;
}
