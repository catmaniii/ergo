import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { originOf } from '../common/ServerAddress';

/**
 * 浏览器的样子（134 号票）：网页的"浏览"页签据此画顶栏（地址、标题、进度、后退前进亮不亮）。
 * browserAttach() 回它，变了 Index.ets 经 window.__ergoBrowser(json) 推 {type: "state", state}（网页一侧 packages/web/src/app/native-browser.ts）
 */
export interface BrowserStateMessage {
  url: string;
  title: string;
  progress: number;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 推给网页的：state 浏览器的样子变了；open 在浏览器里打开了主页面上点的外链，网页切到"浏览" */
export interface BrowserEventMessage {
  type: string;
  state?: BrowserStateMessage;
  url?: string;
}

/** 网页报的内容区：CSS 像素（相对网页的视口）和网页的 devicePixelRatio、要不要显示 */
export interface BrowserLayoutMessage {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
}

/** 网页报的内容区换成 vp 之后：Index.ets 照它摆浏览器的 Web */
export class BrowserFrame {
  visible: boolean = false;
  x: number = 0;
  y: number = 0;
  width: number = 0;
  height: number = 0;
}

function isFiniteNumber(v: number | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 网页报的内容区（JSON）；不对是 undefined */
export function parseLayout(json: string): BrowserLayoutMessage | undefined {
  let value: BrowserLayoutMessage;
  try {
    value = JSON.parse(json) as BrowserLayoutMessage;
  } catch (e) {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.width) || !isFiniteNumber(value.height) || !isFiniteNumber(value.dpr) || value.dpr <= 0) {
    return undefined;
  }
  return value;
}

/** 只开 http、https（别的协议交给系统，见 Index.ets 的 browserIntercept） */
export function isWebUrl(url: string): boolean {
  return originOf(url).length > 0;
}

/**
 * 原生的内置浏览器（134 号票，"浏览"页签）：另一个 ArkWeb 的 Web 组件，叠在二狗的网页上面、盖住"浏览"页签的内容区
 * （位置大小由网页经原生桥 browserLayout 报来，Index.ets 摆）。这里是它的状态和动作，Web 组件本身在 Index.ets 的 BrowserPage。
 * - 不挂二狗的原生桥（NativeBridge）：外部网页拿不到二狗的任何原生能力；
 * - 只开 http、https；别的协议（tel:、mailto:、App 跳转）交给系统；
 * - 和二狗的网页在同一个 App 里，ArkWeb 的 cookie 整个 App 共用一份（WebCookieManager），开二狗转发的服务页面（/apps/…）带着
 *   App 的设备凭证；外部网站的 cookie 照常保存，切到后台时和二狗的一起落盘（EntryAbility.onBackground），退出 App 再进登录还在；
 * - 切到别的页签只是藏起来（Web 留着），切回来页面原样还在；换二狗的地址也不重建。
 * Web 组件还没接上 controller 时要开的地址先记着，接上后再开。
 */
export class InAppBrowser {
  readonly controller: webview.WebviewController = new webview.WebviewController();
  /** 二狗的网页有"浏览"页签（调过 browserAttach）：主页面上点的外链改到这里打开；主页面重新加载、换地址时清掉，等新页面再说 */
  attached: boolean = false;
  /** Web 组件已经建了（第一次 attach 或要开地址时才建，之后一直留着） */
  created: boolean = false;
  private controllerReady: boolean = false;
  /** Web 组件接上 controller 之前要开的地址 */
  private pendingUrl: string = '';
  private url: string = '';
  private title: string = '';
  private progress: number = 0;
  private loading: boolean = false;
  /** 往二狗的网页推（Index.ets 调 window.__ergoBrowser） */
  private emit: (json: string) => void;
  /** 要建 Web 组件了（Index.ets 把 created 换成 @State 刷新界面） */
  private onCreate: () => void;

  constructor(emit: (json: string) => void, onCreate: () => void) {
    this.emit = emit;
    this.onCreate = onCreate;
  }

  /** 现在的样子 */
  state(): BrowserStateMessage {
    let canGoBack = false;
    let canGoForward = false;
    if (this.controllerReady) {
      try {
        canGoBack = this.controller.accessBackward();
        canGoForward = this.controller.accessForward();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'browser history state failed: %{public}s', JSON.stringify(e));
      }
    }
    const state: BrowserStateMessage = {
      url: this.url,
      title: this.title,
      progress: this.progress,
      loading: this.loading,
      canGoBack: canGoBack,
      canGoForward: canGoForward
    };
    return state;
  }

  /** 网页有"浏览"页签了（browserAttach）：建 Web 组件（之后一直留着），回现在的样子 */
  attach(): string {
    this.attached = true;
    this.ensureCreated();
    return JSON.stringify(this.state());
  }

  /** 打开一个网址：只认 http、https；Web 组件还没接上的先记着 */
  load(url: string): boolean {
    if (!isWebUrl(url)) {
      hilog.warn(DOMAIN, TAG, 'browser refused to load a non-web url');
      return false;
    }
    this.ensureCreated();
    // 点了打开马上算在加载（网页的进度条先出来），页面真开始了 onPageBegin 再更新地址
    this.url = url;
    this.loading = true;
    this.progress = 0;
    if (!this.controllerReady) {
      this.pendingUrl = url;
      this.pushState();
      return true;
    }
    try {
      this.controller.loadUrl(url);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'browser loadUrl failed: %{public}s', JSON.stringify(e));
      this.loading = false;
    }
    this.pushState();
    return true;
  }

  /** 顶栏的几个动作（outside 由 Index.ets 交给系统浏览器，这里不管） */
  nav(action: string): void {
    if (!this.controllerReady) {
      return;
    }
    try {
      if (action === 'back' && this.controller.accessBackward()) {
        this.controller.backward();
      } else if (action === 'forward' && this.controller.accessForward()) {
        this.controller.forward();
      } else if (action === 'reload') {
        this.controller.refresh();
      } else if (action === 'stop') {
        this.controller.stop();
        this.loading = false;
        this.pushState();
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'browser %{public}s failed: %{public}s', action, JSON.stringify(e));
    }
  }

  /** 返回手势：网页还有历史就退一页，返回 true；没有了返回 false（照二狗别的页签的规矩） */
  backGesture(): boolean {
    if (!this.controllerReady) {
      return false;
    }
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return true;
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'browser back failed: %{public}s', JSON.stringify(e));
    }
    return false;
  }

  /** 现在这一页的地址（"用系统浏览器打开"用）；还没开过是空串 */
  currentUrl(): string {
    if (this.controllerReady) {
      try {
        const now = this.controller.getUrl();
        if (isWebUrl(now)) {
          return now;
        }
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'browser getUrl failed: %{public}s', JSON.stringify(e));
      }
    }
    return this.url;
  }

  /** Web 组件接上了 controller：记着的地址这时开 */
  controllerAttached(): void {
    this.controllerReady = true;
    const pending = this.pendingUrl;
    this.pendingUrl = '';
    if (pending.length > 0) {
      try {
        this.controller.loadUrl(pending);
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'browser loadUrl (pending) failed: %{public}s', JSON.stringify((e as BusinessError).message));
      }
    }
  }

  pageBegin(url: string): void {
    if (isWebUrl(url)) {
      this.url = url;
    }
    this.loading = true;
    this.pushState();
  }

  pageEnd(url: string): void {
    if (isWebUrl(url)) {
      this.url = url;
    }
    this.loading = false;
    this.progress = 100;
    try {
      const title = this.controller.getTitle();
      if (title.length > 0 && !isWebUrl(title)) {
        this.title = title;
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'browser getTitle failed: %{public}s', JSON.stringify(e));
    }
    this.pushState();
  }

  progressChanged(progress: number): void {
    this.progress = progress;
    this.pushState();
  }

  titleReceived(title: string): void {
    // 没有 <title> 时 ArkWeb 报的是地址：不当标题
    this.title = isWebUrl(title) ? '' : title;
    this.pushState();
  }

  /** 网页历史变了（后退前进亮不亮跟着变） */
  historyChanged(url: string): void {
    if (isWebUrl(url)) {
      this.url = url;
    }
    this.pushState();
  }

  /** 推一条 {type: "open", url}：网页切到"浏览" */
  pushOpened(url: string): void {
    const message: BrowserEventMessage = { type: 'open', url: url };
    this.emit(JSON.stringify(message));
  }

  private pushState(): void {
    const message: BrowserEventMessage = { type: 'state', state: this.state() };
    this.emit(JSON.stringify(message));
  }

  private ensureCreated(): void {
    if (this.created) {
      return;
    }
    this.created = true;
    this.onCreate();
  }
}
