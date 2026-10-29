// 浏览侧边栏（147 号票，用户 2026-10-18："浏览"右边有个按钮，点了展开一个二狗面板，再点能缩回去；里面是秘书本人，陪着浏览器，
// 看得到浏览器里的内容，也能和用户选中的网页元素交互）在网页这一侧的状态和办事，不碰 DOM 和浏览器的全局变量（存储、App 的原生桥、
// 连接都由参数给），测试在 Node 里跑；页面上那一份在 page-browse.ts，界面在 pages/BrowseSidebar.tsx。
// - 展开、收起：记在这台设备上（localStorage），下次进"浏览"照上次的样子；存储用不了时默认收起，改了只在这次打开里生效；
// - 怎么摆（browseFrames）：开合的按钮在"浏览"页顶上那一栏（地址栏那一行）的最右边（2026-10-18 用户定：不在网页右边缘放把手，
//   免得挡网页内容）。展开时侧边栏从右边滑出来：窄屏（手机竖屏）整屏盖住，收起回到网页（147 号票，不变）；宽屏**挤压**网页（148 号票，
//   2026-10-18 用户在平板横屏上提：侧边栏不能只是盖住网页，网页跟着变窄、侧边栏外面的网页完整可用）——侧边栏在内容区右边，
//   浏览器让出右边（侧边栏的宽度加中间一条分隔条），两者不重叠；分隔条能拖、调侧边栏的宽度（照"详情"阶段栏，宽度这台设备记住，
//   stage-side-width.ts 的 BROWSE_SIDE_WIDTH）。原生网页盖在二狗的网页上面，所以侧边栏由 App 画在原生网页上面（App 另开一个 Web 组件
//   承载侧边栏，加载二狗的网页的侧边栏模式 ?ergo=side，见 side-remote.ts），这里只算位置，浏览器经原生桥 browserLayout、侧边栏经
//   browserSide 报给 App，分隔条二狗的网页自己画在两个原生 Web 中间那条缝里（触摸到得了二狗的网页）；侧边栏上的"收起"、× 由 App
//   转回来（sideAction）；
// - "现在在看"：网页的标题和地址（App 推的浏览器样子），选中的框（页面桥报的 selected：点进框、点了上传处就选中，换框、框没了、
//   换了网页、× 取消才变）；变了就报给守护进程（browser_status），重连后连接自己再报；
// - 侧边栏里发的消息带的网页上下文（context）：哪个浏览器（这一页二狗网页随机的编号）、网页、选中的框；
// - 守护进程推来的秘书的网页工具要办的事（handle）：读整页文字、给选中的框填字（核对还是这一页、还是选中的那个框）、
//   给上传框交文件（核对还是这一页；凭取件码取字节、分段交给 App、交进页面桥认出的框，照网页上下指令的做法）、开网址（窄屏上收起侧边栏，
//   让用户看到网页）；办完回结果，办不成回明确的原因（页面桥不在、换了网页、框没了……）。
// 149 号票：悬浮按钮那一轮秘书的网页工具也转到这里办（作用于按钮所在的框；交给网页弹出、App 拦下的选文件对话框的 fieldId 是 "chooser"）；
// 交文件先用候选一出来就预备好的文件（page-stage.ts：没预备的现取），记一条耗时的日志；读网页时连同选中的框里现在的内容一起交回去；
// 报给守护进程的浏览器样子里，选中的框不带框里的内容（发消息、读网页时才带）。
// 164 号票：秘书看网页上能点的东西（snapshot）、按编号点（click）也转到这里办——都交给页面桥（核对还是那一页、元素还在、字没变都在
// 页面桥里做），这里只转请求；点完等最多 3 秒看 App 推来的地址变没变（只改了查询串、# 也算），变了再等最多 5 秒加载完，带上新的网页。
// 旧版 App 不认这两样，回"App 太旧，装新版才能点"。
// 182 号票：报给守护进程的浏览器样子带上这台设备"浏览"里在用的搜索引擎（联网搜索轮到"鸿蒙 App 的内置浏览器"时，守护进程照它拼
// 结果页的地址交给秘书）；设置里换了搜索引擎再报一次。
// 184 号票：填字、交文件也能按编号（snapshot 列的 textbox、upload 的 ref，不用先选中）——填字先经页面桥按编号找到文本框（核对还是那一页、
// 编号认得、元素还在、种类没变）再照它的框编号填；交文件先找一次上传框（找不到就不取字节），交的时候按编号交（页面桥再核对一次）。
// 旧版 App 不认按编号找框，回"App 太旧，装新版才能按编号填和交"。
import type { PageBridgeEvent } from "../../page-bridge/protocol.ts";
import {
  type BrowserOutcome,
  type BrowserRequest,
  type BrowserStatusParams,
  type BrowsingContext,
  type BrowsingPage,
  PAGE_CHOOSER_TARGET,
  PAGE_ELEMENTS_DEFAULT,
  PAGE_ELEMENTS_MAX,
  type PageField,
  pageUrlForModel,
} from "../../state/index.ts";
import type { DeviceStorage } from "../../app/device-storage.ts";
import type { Appearance } from "../../app/theme.ts";
import { BLANK_BROWSER, type BrowserState, type DeliverTarget, type NativePageControl, type SideAction } from "../../app/native-browser.ts";
import type { SideWidthSpec } from "../../app/stage-side-width.ts";
import type { PageStage } from "./page-stage.ts";

/** 记在 localStorage 里的键：展开着时是 "open"，收起不留记号 */
const BROWSE_SIDE_KEY = "ergo-browse-side";

/** 侧边栏的样子 */
export interface BrowseSideView {
  /** 展开着 */
  readonly open: boolean;
  /** 开着的网页（还没打开过网页就没有） */
  readonly page?: BrowsingPage;
  /** 选中的框 */
  readonly selected?: PageField;
}

/** 页面上的一块（CSS 像素，相对页面的视口） */
export interface FrameRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// ───────────────────────── 宽屏挤压、拖动调宽（148 号票） ─────────────────────────

/** 宽屏上侧边栏的宽度初值（147 号票定的 400，380–420 之间）；拖过的照这台设备记住的 */
export const SIDE_WIDTH = 400;

/** 侧边栏最窄（侧边栏里是一整个会话，再窄输入框那一行的按钮挤不下；147 号票内容区窄时的下限也是它） */
export const SIDE_WIDTH_MIN = 320;

/** 侧边栏最宽占内容区的几成（照"详情"阶段栏的最宽外框宽的 60%，浏览器至少留 40%） */
const SIDE_WIDTH_SHARE = 0.6;

/**
 * 浏览器和侧边栏中间那条分隔条多宽：照"详情"阶段栏分隔条的命中区（.splitter 的 14）。那边的分隔条左右各压进栏里 5，这里两边是原生 Web
 * （盖在二狗的网页上面，压进去的那截摸不到），所以整条命中区都留成缝
 */
export const SPLIT_WIDTH = 14;

/**
 * 侧边栏能拖到的范围（照"详情"阶段栏 dragStageSideWidth 的口径）：最窄 320，最宽内容区宽的 60%；内容区窄得 60% 不到 320 时就是 320。
 * 宽屏（窗口 ≥ 600）的内容区减去左边的导航还有 500 多，侧边栏 320 时浏览器也还有 180 以上
 */
export function browseSideWidthRange(hostWidth: number): { min: number; max: number } {
  return { min: SIDE_WIDTH_MIN, max: Math.max(SIDE_WIDTH_MIN, Math.round(hostWidth * SIDE_WIDTH_SHARE)) };
}

/** 夹回范围里（记住的宽度、拖到的宽度都经它；转屏、窗口变化时照新的内容区夹） */
function clampSideWidth(width: number, hostWidth: number): number {
  const { min, max } = browseSideWidthRange(hostWidth);
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** 拖分隔条：dx 是这一下往右挪了多少（侧边栏在右边：往左拖变宽、往右拖变窄），夹在范围里 */
export function dragBrowseSideWidth(width: number, dx: number, hostWidth: number): number {
  return clampSideWidth(width - dx, hostWidth);
}

/**
 * 这台设备记住的宽度怎么认：认不出、比最窄还窄的按初值。照阶段栏（stageSideWidthOf）不按现在的内容区裁——转屏、窗口变窄时摆的时候夹回，
 * 转回来还是原来拖的宽度
 */
export function browseSideWidthOf(raw: string | null): number {
  const w = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(w) && w >= SIDE_WIDTH_MIN ? w : SIDE_WIDTH;
}

/** 这台设备记住的宽屏浏览侧边栏宽度记在哪个键、初值多少（148 号票；212 号票从 app/stage-side-width.ts 挪过来，写法照它） */
export const BROWSE_SIDE_WIDTH: SideWidthSpec = { key: "ergo-browse-side-width", initial: SIDE_WIDTH, parse: browseSideWidthOf };

/** 浏览器、侧边栏、分隔条摆在哪（浏览器经 browserLayout、侧边栏经 browserSide 报给 App，分隔条二狗的网页自己画） */
export interface BrowseFrames {
  /** 原生浏览器：宽屏展开、侧边栏滑到位后让出右边（侧边栏的宽度加分隔条）；别的时候是整个内容区 */
  readonly browser: FrameRect;
  /** 侧边栏（visible 展开着；收着时照样给展开时的位置，App 从那里滑进滑出） */
  readonly side: FrameRect & { readonly visible: boolean };
  /** 中间的分隔条：只在挤压着的时候有（两个原生 Web 中间那条缝） */
  readonly splitter?: FrameRect;
  /** 窄屏：侧边栏整屏盖住 */
  readonly cover: boolean;
}

/**
 * host 是"浏览"的内容区（原生网页摆的那一块），viewport 是页面的视口；shown 是"浏览"页显示着；width 是侧边栏要多宽（记住的或拖着的，
 * 这里夹回范围）；settled 是展开后侧边栏已经滑到位——刚展开时 App 让侧边栏从右边滑进来，这时浏览器先不让（侧边栏盖在它右边），滑到位
 * 再让出右边，中间就不会露出一块空的；收起时浏览器马上恢复原宽，侧边栏盖着它滑出去。
 * 宽屏挤压（侧边栏在右边、中间分隔条、浏览器在左边，三者不重叠；顶上那一栏露着，开合按钮在那里），窄屏整屏盖住、浏览器不变
 */
export function browseFrames(
  host: FrameRect,
  viewport: { width: number; height: number },
  at: { wide: boolean; open: boolean; shown: boolean; settled: boolean; width: number },
): BrowseFrames {
  const box: FrameRect = { x: Math.round(host.x), y: Math.round(host.y), width: Math.round(host.width), height: Math.round(host.height) };
  if (!at.wide) {
    const rect: FrameRect = { x: 0, y: 0, width: Math.round(viewport.width), height: Math.round(viewport.height) };
    return { browser: box, side: { ...rect, visible: at.open && at.shown && rect.width > 0 && rect.height > 0 }, cover: true };
  }
  const width = clampSideWidth(at.width, box.width);
  const side: FrameRect = { x: box.x + box.width - width, y: box.y, width, height: box.height };
  const visible = at.open && at.shown && side.width > 0 && side.height > 0;
  if (!visible || !at.settled) return { browser: box, side: { ...side, visible }, cover: false };
  const splitter: FrameRect = { x: side.x - SPLIT_WIDTH, y: box.y, width: SPLIT_WIDTH, height: box.height };
  return { browser: { ...box, width: Math.max(0, splitter.x - box.x) }, splitter, side: { ...side, visible }, cover: false };
}

/** 侧边栏上点了什么（App 转回来的）：原生桥的接口，定义在 app/native-browser.ts（212 号票） */
export type { SideAction } from "../../app/native-browser.ts";

/** 侧边栏要的（BrowseSidebar.tsx）：收起、取消选中、发消息带的网页上下文 */
export interface SidebarControl {
  setOpen(open: boolean): void;
  clearSelection(): void;
  context(): BrowsingContext;
}

/**
 * 交给侧边栏模式的网页（App 转过去）的：展开没展开、哪个浏览器、网页、选中的框，底部要让开多少（窄屏整屏盖住时），
 * 这一份现在的外观（275 号票：设置里换了风格、深浅色、主色，侧边栏照着马上换）
 */
export interface SideViewMessage {
  readonly open: boolean;
  readonly browser: string;
  readonly page?: BrowsingPage;
  readonly selected?: PageField;
  readonly safeBottom?: string;
  readonly appearance?: Appearance;
}

/** 浏览器的编号：b- 加 16 个十六进制字（random 给 0–1 的随机数） */
export function newBrowserId(random: () => number): string {
  let hex = "";
  for (let i = 0; i < 16; i++) hex += Math.floor(random() * 16).toString(16);
  return `b-${hex}`;
}

/** "现在在看"那一条的网页：标题加域名（没标题写地址） */
export function watchingText(page: BrowsingPage | undefined): { title: string; host: string } | undefined {
  if (!page?.url) return undefined;
  let host = "";
  try {
    host = new URL(page.url).host;
  } catch {
    host = page.url;
  }
  return { title: page.title.trim() || host, host };
}

export interface BrowseSideDeps {
  /** 这一页二狗网页的浏览器编号 */
  browserId: string;
  /** 页面桥这一组（App 的原生桥） */
  page: NativePageControl;
  /** 在内置浏览器里打开一个网址 */
  load(url: string): void;
  /** 报给守护进程（连接的 browser_status） */
  report(status: BrowserStatusParams): void;
  /** 这台设备"浏览"里在用的搜索引擎（182 号票，报给守护进程）；不给就不报 */
  searchEngine?(): string;
  /** 回守护进程推来的事（连接的 browser_reply） */
  reply(id: string, outcome: BrowserOutcome): void;
  /** 要交的文件交给 App 暂存（149 号票：先用预备好的，没预备的现取）、记耗时 */
  stage: Pick<PageStage, "take" | "logDelivery">;
  /** 这台设备的存储（取不到时抛错） */
  storage(): DeviceStorage;
  /** 现在是窄屏：开网址后收起侧边栏 */
  narrow(): boolean;
  /** 现在的毫秒数（文件的编号用） */
  now(): number;
  /** 过 ms 毫秒调 fn，回取消的函数（164 号票：点完等地址变；不给用 setTimeout） */
  timer?(ms: number, fn: () => void): () => void;
}

/** 原因最多多少字（协议里的上限） */
const REASON_MAX = 500;

/** 点完等多久看地址变没变、变了再等多久加载完（毫秒，164 号票） */
const CLICK_NAVIGATION_WAIT_MS = 3000;
const CLICK_LOAD_WAIT_MS = 5000;

/** 页面桥不在 */
const BRIDGE_GONE = "网页上的二狗页面桥不在（网页还没加载完，或者这一页没法装）"; // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
/** 旧版 App 不认看、点（164 号票） */
const APP_TOO_OLD = "这台设备上的二狗 App 太旧，装新版才能点（看网页上能点的东西、点击都要新版 App）"; // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
/** 旧版 App 不认按编号找框（184 号票） */
const APP_TOO_OLD_REF = "这台设备上的二狗 App 太旧，装新版才能按编号填字、交文件"; // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）

const defaultTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

const samePage = (a: string, b: string) => pageUrlForModel(a) === pageUrlForModel(b);

export class BrowseSide implements SidebarControl {
  private readonly deps: BrowseSideDeps;
  private view: BrowseSideView;
  private readonly listeners = new Set<() => void>();
  private lastReport = "";
  /** App 推来的浏览器的样子原样（164 号票：点完看地址变没变、加载完没有） */
  private raw: BrowserState = BLANK_BROWSER;
  /** 等浏览器样子变的（164 号票） */
  private readonly rawWaiters = new Set<() => void>();

  constructor(deps: BrowseSideDeps) {
    this.deps = deps;
    let open = false;
    try {
      open = deps.storage().getItem(BROWSE_SIDE_KEY) === "open";
    } catch {
      open = false;
    }
    this.view = { open };
  }

  readonly snapshot = (): BrowseSideView => this.view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private set(next: BrowseSideView): void {
    this.view = next;
    for (const listener of this.listeners) listener();
    this.announce();
  }

  /** 报给守护进程（没变不再报；开场调一次，守护进程才知道这台设备开着浏览器） */
  announce(): void {
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastReport) return;
    this.lastReport = key;
    this.deps.report(status);
  }

  /** 没变也再报一次（212 号票：浏览插件在设置 · 插件里停用后又启用，守护进程那边记浏览器的是新的一份） */
  reannounce(): void {
    this.lastReport = "";
    this.announce();
  }

  /** 现在的样子（报给守护进程的；选中的框不带框里的内容，149 号票：发消息、读网页时才带；182 号票带上在用的搜索引擎） */
  status(): BrowserStatusParams {
    const { page, selected } = this.view;
    const { value: _value, ...field } = selected ?? { value: undefined };
    const engine = this.deps.searchEngine?.();
    return { browser: this.deps.browserId, ...(page ? { page } : {}), ...(selected ? { selected: field as PageField } : {}), ...(engine ? { searchEngine: engine } : {}) };
  }

  /** 展开、收起（记在这台设备上） */
  setOpen(open: boolean): void {
    if (open === this.view.open) return;
    try {
      if (open) this.deps.storage().setItem(BROWSE_SIDE_KEY, "open");
      else this.deps.storage().removeItem(BROWSE_SIDE_KEY);
    } catch {
      // 存不了：这次打开里照样生效，下次打开回到默认（收起）
    }
    this.set({ ...this.view, open });
  }

  toggle(): void {
    this.setOpen(!this.view.open);
  }

  /** 浏览器的样子变了（App 推的）：换了网页，选中的框就没了 */
  browserChanged(state: BrowserState): void {
    this.raw = state;
    // 叫醒的会把自己从集合里删掉：Set 边遍历边删没问题
    for (const wake of this.rawWaiters) wake();
    const page: BrowsingPage | undefined = state.url ? { title: state.title.slice(0, 300), url: pageUrlForModel(state.url).slice(0, 2048) } : undefined;
    const old = this.view.page;
    if (old?.url === page?.url && old?.title === page?.title) return;
    const moved = !page || !old || !samePage(old.url, page.url);
    const { open, selected } = this.view;
    this.set({ open, ...(page ? { page } : {}), ...(selected && !moved ? { selected } : {}) });
  }

  /** 页面桥报的话：选中的框变了；气泡的回话上点了"去侧边栏看"（146 号票的气泡）就展开 */
  pageEvent(event: PageBridgeEvent): void {
    if (event.type === "bubble" && event.action === "sidebar") return this.setOpen(true);
    if (event.type !== "selected") return;
    const { selected: _old, ...rest } = this.view;
    // 选中的框跟着它在的那一页走（App 推的地址可能还没到）
    const page = this.view.page && samePage(this.view.page.url, event.page.url) ? this.view.page : { title: event.page.title, url: pageUrlForModel(event.page.url) };
    this.set({ ...rest, page, ...(event.field ? { selected: event.field } : {}) });
  }

  /** 侧边栏、把手上点的（App 转回来的） */
  sideAction(action: SideAction): void {
    if (action === "toggle") this.toggle();
    else if (action === "close") this.setOpen(false);
    else if (action === "clearSelection") this.clearSelection();
    else if (this.deps.narrow()) this.setOpen(false);
  }

  /** 交给侧边栏模式的网页的（appearance：这一份现在的外观，275 号票） */
  sideView(safeBottom?: string, appearance?: Appearance): SideViewMessage {
    const { open, page, selected } = this.view;
    return { open, browser: this.deps.browserId, ...(page ? { page } : {}), ...(selected ? { selected } : {}), ...(safeBottom ? { safeBottom } : {}), ...(appearance ? { appearance } : {}) };
  }

  /** "现在在看"那一条的 ×：取消选中 */
  clearSelection(): void {
    if (!this.view.selected) return;
    const { selected: _old, ...rest } = this.view;
    this.set(rest);
    void this.deps.page.clearSelection();
  }

  /** 侧边栏里发的消息带的网页上下文 */
  context(): BrowsingContext {
    const { page, selected } = this.view;
    return { browser: this.deps.browserId, page: page ?? { title: "", url: "" }, ...(selected ? { selected } : {}) };
  }

  /** 守护进程推来的事：办完回结果 */
  async handle(request: BrowserRequest): Promise<void> {
    let outcome: BrowserOutcome;
    try {
      outcome = await this.run(request);
    } catch (err) {
      outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!outcome.ok) outcome = { ok: false, reason: outcome.reason.slice(0, REASON_MAX) };
    this.deps.reply(request.id, outcome);
  }

  /** 等到 ok() 成立（浏览器样子变了再看），最多 ms 毫秒；到时没成立回 false */
  private until(ok: () => boolean, ms: number): Promise<boolean> {
    if (ok()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let cancel: (() => void) | undefined;
      const finish = (value: boolean) => {
        this.rawWaiters.delete(check);
        cancel?.();
        resolve(value);
      };
      const check = () => {
        if (ok()) finish(true);
      };
      this.rawWaiters.add(check);
      cancel = (this.deps.timer ?? defaultTimer)(ms, () => finish(false));
    });
  }

  private async run(request: BrowserRequest): Promise<BrowserOutcome> {
    const { page } = this.deps;
    switch (request.op) {
      case "snapshot": {
        // 164 号票：列能点的东西，编号由页面桥给、记在页面桥里
        const snap = await page.snapshot(request.max ?? PAGE_ELEMENTS_DEFAULT);
        if (snap === "old") return { ok: false, reason: APP_TOO_OLD };
        if (!snap) return { ok: false, reason: BRIDGE_GONE };
        if (!snap.ok) return snap;
        const elements = snap.elements.slice(0, PAGE_ELEMENTS_MAX);
        return { ok: true, page: { title: snap.page.title.slice(0, 300), url: pageUrlForModel(snap.page.url).slice(0, 2048) }, elements, total: snap.total, truncated: snap.total > elements.length };
      }
      case "click": {
        // 164 号票：页面桥核对还是那一页、元素还在、字没变才点；点完看地址变没变
        const before = this.raw.url;
        const clicked = await page.click(request.ref, request.url);
        if (clicked === "old") return { ok: false, reason: APP_TOO_OLD };
        if (!clicked) return { ok: false, reason: BRIDGE_GONE };
        if (!clicked.ok) return clicked;
        const navigated = await this.until(() => this.raw.url !== before, CLICK_NAVIGATION_WAIT_MS);
        if (navigated) await this.until(() => !this.raw.loading, CLICK_LOAD_WAIT_MS);
        const now = this.view.page ?? { title: clicked.page.title.slice(0, 300), url: pageUrlForModel(clicked.page.url).slice(0, 2048) };
        return { ok: true, clicked: `${clicked.role}:${clicked.text}`.slice(0, 300), navigated, page: now };
      }
      case "read": {
        const text = await page.text();
        if (!text) return { ok: false, reason: BRIDGE_GONE };
        // 选中的框里现在的内容（149 号票：正文文字里没有框里的值）
        const now = await page.selected();
        const selected = now?.field && samePage(now.page.url, text.page.url) ? now.field : undefined;
        return { ok: true, page: { title: text.page.title, url: pageUrlForModel(text.page.url) }, text: text.text, truncated: text.truncated, total: text.total, ...(selected ? { selected } : {}) };
      }
      case "fill": {
        if ("ref" in request) {
          // 184 号票：按编号填——页面桥找到文本框再照它的框编号填，不看选中的框
          const found = await page.refField(request.ref, request.url, "textbox");
          if (found === "old") return { ok: false, reason: APP_TOO_OLD_REF };
          if (!found) return { ok: false, reason: BRIDGE_GONE };
          if (!found.ok) return found;
          const filled = await page.fill(found.field.id, request.text);
          return filled.ok ? { ok: true } : { ok: false, reason: filled.reason ?? "没填上" }; // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
        }
        const now = await page.selected();
        if (!now) return { ok: false, reason: BRIDGE_GONE };
        // @i18n-ignore-start model：交回去的原因进秘书的网页工具结果（给模型看）
        if (!samePage(now.page.url, request.url)) return { ok: false, reason: "浏览器已经换了网页，原来选中的框不在了" };
        if (now.field?.id !== request.fieldId) return { ok: false, reason: now.field ? "选中的框变了（用户点了别的框）" : "现在网页上没有选中的框（框没了，或者用户取消了选中）" };
        // @i18n-ignore-end
        const filled = await page.fill(request.fieldId, request.text);
        return filled.ok ? { ok: true } : { ok: false, reason: filled.reason ?? "没填上" }; // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
      }
      case "attach": {
        let target: DeliverTarget;
        if ("ref" in request) {
          // 184 号票：按编号交——先找一次上传框（找不到就不取字节），交的时候按编号交、页面桥再核对一次
          const found = await page.refField(request.ref, request.url, "upload");
          if (found === "old") return { ok: false, reason: APP_TOO_OLD_REF };
          if (!found) return { ok: false, reason: BRIDGE_GONE };
          if (!found.ok) return found;
          target = { ref: request.ref, url: request.url };
        } else {
          // 交给网页弹出、App 拦下的选文件对话框（149 号票，悬浮按钮上"让二狗选"的那一轮）：对话框还等着才交得进（App 核对）
          const toChooser = request.fieldId === PAGE_CHOOSER_TARGET;
          const now = await page.selected();
          if (!now && !toChooser) return { ok: false, reason: BRIDGE_GONE };
          if (now && !samePage(now.page.url, request.url)) return { ok: false, reason: toChooser ? "浏览器已经换了网页，原来的选文件对话框不在了" : "浏览器已经换了网页，原来的上传框不在了" }; // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
          target = toChooser ? "chooser" : { fieldId: request.fieldId };
        }
        const began = this.deps.now();
        let taken: Awaited<ReturnType<PageStage["take"]>>;
        try {
          taken = await this.deps.stage.take(request.files);
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        const staged = this.deps.now();
        const delivered = await page.deliver(target, taken.files);
        this.deps.stage.logDelivery("守护进程转来的", taken, this.deps.now() - staged, this.deps.now() - began); // @i18n-ignore log：日志里写的来路
        return delivered.ok ? { ok: true, count: delivered.count ?? taken.files.length } : { ok: false, reason: delivered.reason ?? "没交进去" }; // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
      }
      case "open": {
        if (!/^https?:\/\//i.test(request.url)) return { ok: false, reason: "只能开 http、https 的网址" }; // @i18n-ignore model：交回去的原因进秘书的网页工具结果（给模型看）
        this.deps.load(request.url);
        // 窄屏：收起侧边栏，让用户看到网页
        if (this.deps.narrow()) this.setOpen(false);
        return { ok: true };
      }
    }
  }
}
