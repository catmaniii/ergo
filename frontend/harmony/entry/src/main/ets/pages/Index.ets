import { webview } from '@kit.ArkWeb';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { call } from '@kit.TelephonyKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import BuildProfile from 'BuildProfile';
import { AppSettings, DOMAIN, TAG } from '../common/AppSettings';
import { appTexts, t } from '../common/AppTexts';
import { oldNameOf, webCallScript } from '../common/OldNames';
import { checkServerAddress, originOf, ServerAddress } from '../common/ServerAddress';
import {
  BrowserHost,
  bridgePermission,
  idleBrowserHost,
  NATIVE_BRIDGE_ASYNC_METHODS,
  NATIVE_BRIDGE_METHODS,
  NATIVE_BRIDGE_NAME,
  NATIVE_SIDE_BRIDGE_METHODS,
  NativeBridge,
  pageFromServer,
  SafeAreaMessage
} from '../bridge/NativeBridge';
import { NativeNotify, notifyTaps } from '../notify/NativeNotify';
import { PhoneData } from '../phone/PhoneData';
import { NativeVoice } from '../voice/NativeVoice';
import { WebDownloads } from '../download/WebDownloads';
import { BrowserFrame, InAppBrowser, isWebUrl, parseLayout } from '../browser/InAppBrowser';
import { FileDocs } from '../browser/FileDocs';
import { BrowserTools } from '../browser/BrowserTools';
import { PAGE_HOST_NAME, PageControl, PageHost } from '../browser/PageControl';
import { parseSideLayout, SIDE_HOST_METHODS, SIDE_HOST_NAME, SideForward, SideFrame, SideHost, sideUrlOf } from '../browser/SidePanel';

const MICROPHONE: Permissions = 'ohos.permission.MICROPHONE';
const AUDIO_CAPTURE: string = ProtectedResourceType.AUDIO_CAPTURE;
/**
 * 导航被取消、被拦下（onLoadIntercept 把外链交给系统浏览器）、不认识的链接（mailto: 之类已经交给系统）：不算打不开
 * （@ohos.web.netErrorList 的 ERR_ABORTED、ERR_BLOCKED_BY_CLIENT、ERR_UNKNOWN_URL_SCHEME）
 */
const IGNORED_NET_ERRORS: number[] = [-3, -20, -302];
/** 留在 WebView 里自己处理的非 http(s) 链接；别的（mailto:、tel:、sms:、geo:、别的 App 的链接）交给系统 */
const IN_PAGE_SCHEMES: string[] = ['about', 'blob', 'data', 'javascript'];
/** 页面加载完这么久网页还没调过原生桥，就不是二狗的网页（地址填成了别的网站）：提示"这不是二狗？换地址" */
const NOT_ERGO_AFTER_MS = 8000;

/**
 * 二狗的鸿蒙 App（62 号票）：原生壳。
 * 第一次打开先填二狗的地址（存在应用本地）；之后 ArkWeb 加载这个地址，网页照常由守护进程提供，
 * App 和手机浏览器一样是一台要配对的设备。网页不打包进 HAP：二狗的网页要带设备凭证（__Host- cookie），
 * Origin 要和 Host 一致，打包进来的网页属于另一个来源，见 docs/adr/0022。
 */
@Entry
@Component
struct Index {
  private context: common.UIAbilityContext = this.getUIContext().getHostContext() as common.UIAbilityContext;
  private settings: AppSettings = new AppSettings(this.context);
  /** 当前加载的地址；没配过是 undefined */
  private server: ServerAddress | undefined = undefined;
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: NativeBridge | undefined = undefined;
  /** 网页里的下载（96 号票）：下到缓存，下完弹"保存到"；换地址重建 Web 组件时重新挂到新的 controller 上 */
  private downloads: WebDownloads = new WebDownloads(this.context, (text: string) => {
    this.getUIContext().getPromptAction().showToast({ message: text, duration: 2500 });
  });
  /** 系统通知（110 号票）：整个页面一份，换地址不重建；记着 App 在不在前台（在前台不发，页面顶上已经有了） */
  private nativeNotify: NativeNotify = new NativeNotify(this.context, this.settings);
  /** 读本机（299 号票）：通讯录选人、手机日历；300 号票加了照片的时间地点、位置，整个页面一份 */
  private phoneData: PhoneData = new PhoneData(this.context, this.settings);
  /**
   * 原生的内置浏览器（134 号票，网页的"浏览"页签）：另一个 Web 组件，叠在二狗的网页上面盖住"浏览"页签的内容区；整个页面一份，
   * 换地址、主页面重新加载都不重建（切走再回来页面原样还在）。不挂二狗的原生桥
   */
  private browser: InAppBrowser = new InAppBrowser((json: string) => this.pushBrowser(json), () => {
    this.browserCreated = true;
  });
  /**
   * 页面桥（134 号票第二部分）：注入浏览器里每个网页的脚本（认框、悬浮按钮、填字、塞文件）、它报的话转给二狗的网页、
   * 二狗的网页交来的文件交进网页、拦下网页弹出的选文件对话框
   */
  private pageControl: PageControl = new PageControl(this.context, this.browser.controller, (json: string) => this.pushBrowser(json),
    () => this.browser.attached);
  /** 页面桥用的对象（javaScriptProxy，只有 post）：每句话要带页面桥的口令 */
  private pageHost: PageHost = new PageHost(this.pageControl);
  /**
   * 浏览器里能渲染的文件（160 号票）：加载完的一页报类型给网页、可能是能渲染的文本的下载拦下来，交给二狗的网页用二狗的渲染画；
   * 网页说它能渲染（browserDoc enable）才做
   */
  private fileDocs: FileDocs = new FileDocs(this.context, this.browser.controller, (json: string) => this.pushBrowser(json),
    (path: string, name: string, keep: boolean) => this.browserDownloads.saveFile(path, name, keep));
  /**
   * "浏览"的 ⋮ 菜单用到的原生能力（165 号票，browser/BrowserTools.ets）：页内查找、按网站的文字大小和桌面版、分享、清数据、
   * 下载记录；文字大小落到 browserTextZoom（浏览器 Web 组件的 textZoomRatio）
   */
  private browserTools: BrowserTools = new BrowserTools(this.context, this.browser.controller, (json: string) => this.pushBrowser(json),
    () => this.server, () => this.browser.currentUrl(), (zoom: number) => {
      this.browserTextZoom = zoom;
    });
  /**
   * 浏览器里的下载：和二狗的网页一样下到缓存、下完弹"保存到"；可能是能渲染的文本的先问 fileDocs 拦不拦（160 号票）；
   * 存好了的记进下载记录（165 号票）
   */
  private browserDownloads: WebDownloads = new WebDownloads(this.context, (text: string) => {
    this.getUIContext().getPromptAction().showToast({ message: text, duration: 2500 });
  }, this.fileDocs, (name: string, uri: string, size: number, mime: string) => this.browserTools.record(name, uri, size, mime));
  /** 浏览器里的文字大小（百分比，165 号票：按网站记住，每一页开始时由 browserTools 按主机名设） */
  @State browserTextZoom: number = 100;
  /** 浏览器的 Web 组件建了没有（网页第一次 attach 或要开地址时才建） */
  @State browserCreated: boolean = false;
  /**
   * 浏览侧边栏（147 号票，browser/SidePanel.ets）：另一个 Web 组件，加载二狗网页的侧边栏模式，盖在原生网页上面；第一次展开时才建，
   * 之后留着（收起只是藏起来），换地址时拆掉
   */
  private sideController: webview.WebviewController = new webview.WebviewController();
  /** 侧边栏的网页能调的对象（window.ergoSide）：收起、取消选中转给二狗的网页 */
  private sideHost: SideHost = new SideHost((action: string) => this.sideAction(action));
  /**
   * 侧边栏那个 Web 上的二狗原生桥（主会话定：侧边栏挂二狗原生桥走原生录音）：自己一份原生录音器，只开 NATIVE_SIDE_BRIDGE_METHODS；
   * 跟着侧边栏的 controller 换地址时重建
   */
  private sideBridge: NativeBridge | undefined = undefined;
  /** "浏览"页报的交给侧边栏网页的样子（JSON），侧边栏的网页起来了、变了就推过去 */
  private sideView: string = '';
  /** 侧边栏的 Web 已经去过二狗的侧边栏地址了（about:blank 加载完才去，见 sidePageEnd） */
  private sideNavigated: boolean = false;
  @State sideCreated: boolean = false;
  /** 侧边栏摆在哪（网页报的换成 vp）、显不显示（滑出去的过程中还显示着） */
  @State sideFrame: SideFrame = new SideFrame();
  @State sideVisible: boolean = false;
  /** 滑进滑出：往右挪多少（vp） */
  @State sideOffset: number = 0;
  /** 浏览器摆在哪、显不显示（网页报的内容区换成 vp） */
  @State browserFrame: BrowserFrame = new BrowserFrame();
  /** 每换一次地址加一：Web 组件连同 controller、原生桥整个重建（原生桥的白名单是注册时定的） */
  @State session: number = 0;
  @State hasServer: boolean = false;
  /** 显示地址页：第一次打开，或者网页设置里点了"换地址"、出错页上点了"改地址" */
  @State editing: boolean = false;
  @State draft: string = '';
  @State draftError: string = '';
  /** 网页打不开的原因；空串是没出错 */
  @State loadError: string = '';
  /** 加载完一阵网页还没调过原生桥：底部提示"这不是二狗？换地址" */
  @State notErgo: boolean = false;
  /**
   * App 原生的字换过几次（175 号票）：二狗的网页经原生桥 setTexts 交来了不一样的语言时加一，地址页、出错页、"这不是二狗？"跟着重画
   * （它们的字经 tx() 取，tx() 读了它）
   */
  @State textsRevision: number = 0;
  private notErgoTimer: number = -1;
  /**
   * 底部避让区（105 号票）：页面延伸到了手势条（三键导航条）底下，这一截多高（物理像素，取导航条和系统避让区底边里大的那个）；
   * 还没量到是 -1。网页经原生桥 safeArea() 取，变了（转屏）推给网页的 window.__ergoInsets
   */
  private bottomInsetPx: number = -1;
  private mainWindow: window.Window | undefined = undefined;
  private onAvoidAreaChange = (options: window.AvoidAreaOptions): void => {
    if (options.type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR || options.type === window.AvoidAreaType.TYPE_SYSTEM) {
      this.updateBottomInset();
    }
  };

  aboutToAppear(): void {
    this.watchBottomInset();
    // App 原生的字（175 号票）：网页交来别的语言时让这几页重画
    appTexts.listen(() => {
      this.textsRevision += 1;
    });
    // 用户点开了通知栏里的一条（110 号票，EntryAbility 的 onNewWant 记下的）：让网页来取
    notifyTaps.listen(() => this.pushNotifyOpen());
    // WebView 调试（PC 上的 Chrome DevTools 经 hdc 端口转发）默认关：开着的话，接上 USB 的人能用 hdc 取到设备凭证 cookie。
    // 只有构建时显式要了（npm run build:harmony -- --webview-debug）才开，见 entry/hvigorfile.ts 和 docs/developer-guide.md 的"鸿蒙 App"
    if (BuildProfile.WEBVIEW_DEBUG) {
      webview.WebviewController.setWebDebuggingAccess(true);
    }
    const saved = checkServerAddress(this.settings.serverUrl());
    if (saved.address !== undefined) {
      this.openServer(saved.address);
    } else {
      this.startEditing();
    }
  }

  // 系统返回手势：在地址页上先回到网页；网页报过还能在内部返回（setCanGoBack）就交给网页
  // （window.__ergoBack：先关弹窗、详情，再回上一级），否则交给系统退出 App
  onBackPress(): boolean {
    if (this.editing) {
      if (this.hasServer) {
        this.editing = false;
        return true;
      }
      return false;
    }
    // 浏览侧边栏开着（147 号票）：它盖在最上面，先收起它（由二狗的网页收，它再报藏起来）
    if (this.sideShown()) {
      this.pushBrowser(JSON.stringify(new SideForward('close')));
      return true;
    }
    // "浏览"页签开着（134 号票）：悬浮按钮旁边的气泡、挑图片窗口开着先收起它（146、149 号票），再是浏览器里的网页还有历史先退一页，
    // 退到头才照二狗别的页签的规矩
    if (this.browserShown() && this.pageControl.closeBubble()) {
      return true;
    }
    // 查找栏开着（165 号票）：先让网页收起它，再退网页历史
    if (this.browserShown() && this.browserTools.closeFind()) {
      return true;
    }
    if (this.browserShown() && this.browser.backGesture()) {
      return true;
    }
    if (this.hasServer && this.loadError.length === 0 && this.bridge !== undefined && this.bridge.canGoBack) {
      this.controller.runJavaScript(webCallScript('__ergoBack', '')).catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'web back failed: %{public}s', JSON.stringify(err));
      });
      return true;
    }
    return false;
  }

  aboutToDisappear(): void {
    clearTimeout(this.notErgoTimer);
    this.bridge?.releaseVoice('closed');
    this.sideBridge?.releaseVoice('closed');
    notifyTaps.listen(undefined);
    appTexts.listen(undefined);
    try {
      this.mainWindow?.off('avoidAreaChange', this.onAvoidAreaChange);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'stop watching avoid area failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 原生页面上的一句（175 号票）：读一下 textsRevision，网页交来别的语言时这句跟着重画 */
  private tx(key: string): string {
    return this.textsRevision >= 0 ? t(key) : key;
  }

  /** 量底部避让区，之后变了（转屏、导航方式改了）再量（105 号票） */
  private watchBottomInset(): void {
    window.getLastWindow(this.context).then((win: window.Window) => {
      this.mainWindow = win;
      this.updateBottomInset();
      win.on('avoidAreaChange', this.onAvoidAreaChange);
    }).catch((err: BusinessError) => {
      hilog.warn(DOMAIN, TAG, 'get window failed: %{public}s', JSON.stringify(err));
    });
  }

  /** 重新量底部避让区；变了就推给网页 */
  private updateBottomInset(): void {
    const win = this.mainWindow;
    if (win === undefined) {
      return;
    }
    try {
      const indicator = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR).bottomRect.height;
      const system = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).bottomRect.height;
      const bottom = Math.max(indicator, system, 0);
      if (bottom === this.bottomInsetPx) {
        return;
      }
      hilog.info(DOMAIN, TAG, 'bottom avoid area: %{public}d px (indicator %{public}d, system %{public}d)', bottom, indicator, system);
      this.bottomInsetPx = bottom;
      this.pushInsets();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'read avoid area failed: %{public}s', JSON.stringify(e));
    }
  }

  /**
   * 底部避让区推给网页（调网页登记的 window.__ergoInsets(json)）：量到了、变了、页面重新加载完都推一次；
   * 推之前和原生录音一样核对主框架还是配好的来源
   */
  private pushInsets(): void {
    const server = this.server;
    if (server === undefined || this.bottomInsetPx < 0) {
      return;
    }
    const controller = this.controller;
    if (!pageFromServer(server, () => controller.getUrl())) {
      return;
    }
    const message: SafeAreaMessage = { bottom: this.bottomInsetPx };
    try {
      controller.runJavaScript(webCallScript('__ergoInsets', JSON.stringify(JSON.stringify(message))))
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'push insets failed: %{public}s', JSON.stringify(err));
        });
    } catch (e) {
      // Web 组件还没接上 controller、已经拆掉了：网页开场会自己经 safeArea() 来取
      hilog.warn(DOMAIN, TAG, 'push insets failed: %{public}s', JSON.stringify(e));
    }
  }

  // App 回到前台：系统通知不再往通知栏发（110 号票）；点通知回来的那一条之前没推到网页（网页在后台被暂停）的，再推一次
  onPageShow(): void {
    this.nativeNotify.setForeground(true);
    // 位置（300 号票）：在记的按前台的间隔订上（App 重新打开时也是这一下接着记）
    this.phoneData.setForeground(true);
    if (notifyTaps.hasPending()) {
      this.pushNotifyOpen();
    }
  }

  // App 切到后台：放掉原生录音器（63 号票，后台不录；网页的 visibilitychange 不一定先到）。回到前台由网页重新要。
  // 之后来的提醒发到系统通知栏（110 号票）
  onPageHide(): void {
    this.bridge?.releaseVoice('background');
    this.sideBridge?.releaseVoice('background');
    this.nativeNotify.setForeground(false);
    // 位置（300 号票）：没打开后台也记的停订（鸿蒙在后台几秒后挂起 App，订着也收不到）
    this.phoneData.setForeground(false);
  }

  /**
   * 用户点开了通知栏里的一条（110 号票）：调网页登记的 window.__ergoNotifyOpen()，网页再经原生桥 notifyTakeOpen() 来取
   * （取一次就清掉，推了几次也只去一次）。推之前和原生录音一样核对主框架还是配好的来源；网页还没加载好的，开场自己来取
   */
  private pushNotifyOpen(): void {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    const controller = this.controller;
    if (!pageFromServer(server, () => controller.getUrl())) {
      return;
    }
    try {
      controller.runJavaScript(webCallScript('__ergoNotifyOpen', ''))
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'push notification open failed: %{public}s', JSON.stringify(err));
        });
    } catch (e) {
      // Web 组件还没接上 controller、已经拆掉了：网页开场会自己来取
      hilog.warn(DOMAIN, TAG, 'push notification open failed: %{public}s', JSON.stringify(e));
    }
  }

  /**
   * 原生的内置浏览器往网页推（134 号票：浏览器的样子变了、在浏览器里打开了主页面上的外链）：调网页登记的 window.__ergoBrowser(json)。
   * 推之前和原生录音一样核对主框架还是配好的来源；网页还没 attach（旧版网页、还没加载好）就不推
   */
  private pushBrowser(json: string): void {
    const server = this.server;
    if (server === undefined || !this.browser.attached) {
      return;
    }
    const controller = this.controller;
    if (!pageFromServer(server, () => controller.getUrl())) {
      return;
    }
    try {
      controller.runJavaScript(webCallScript('__ergoBrowser', JSON.stringify(json)))
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'push browser event failed: %{public}s', JSON.stringify(err));
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'push browser event failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 浏览侧边栏现在显示着（147 号票） */
  private sideShown(): boolean {
    return this.sideCreated && this.sideVisible && !this.editing && this.loadError.length === 0;
  }

  /**
   * 网页报的侧边栏（147 号票，CSS 像素）换成 vp 摆侧边栏的 Web，交给侧边栏网页的样子转过去；第一次要显示时才建。
   * 显示、藏起来时从右边滑进滑出（藏起来等滑完再藏）
   */
  private layoutSide(json: string): void {
    const layout = parseSideLayout(json);
    if (layout === undefined) {
      hilog.warn(DOMAIN, TAG, 'side layout ignored: %{public}s', json);
      return;
    }
    const ui = this.getUIContext();
    const frame = new SideFrame();
    frame.visible = layout.side.visible && layout.side.width > 0 && layout.side.height > 0;
    frame.x = ui.px2vp(layout.side.x * layout.dpr);
    frame.y = ui.px2vp(layout.side.y * layout.dpr);
    frame.width = ui.px2vp(layout.side.width * layout.dpr);
    frame.height = ui.px2vp(layout.side.height * layout.dpr);
    this.sideView = layout.view;
    if (frame.visible && !this.sideCreated) {
      this.sideCreated = true;
    }
    const opening = frame.visible && !this.sideVisible;
    const closing = !frame.visible && this.sideVisible;
    if (closing) {
      // 滑出去时照原来的位置大小（藏起来时报的可能是空的）
      frame.x = this.sideFrame.x;
      frame.y = this.sideFrame.y;
      frame.width = this.sideFrame.width;
      frame.height = this.sideFrame.height;
    }
    this.sideFrame = frame;
    if (opening) {
      this.sideOffset = frame.width;
      this.sideVisible = true;
      ui.animateTo({ duration: 220, curve: Curve.EaseOut }, () => {
        this.sideOffset = 0;
      });
    } else if (closing) {
      // 收起了：侧边栏里正在录的、备好的录音器放掉（展开后网页再要）
      this.sideBridge?.releaseVoice('hidden');
      ui.animateTo({
        duration: 200, curve: Curve.EaseIn, onFinish: () => {
          if (!this.sideFrame.visible) {
            this.sideVisible = false;
          }
        }
      }, () => {
        this.sideOffset = frame.width;
      });
    }
    this.pushSide();
  }

  /** 交给侧边栏网页的样子推过去（window.__ergoSide）：侧边栏的网页还没建、主框架不是配好的来源就不推 */
  private pushSide(): void {
    const server = this.server;
    if (server === undefined || !this.sideCreated || this.sideView.length === 0) {
      return;
    }
    const controller = this.sideController;
    if (!pageFromServer(server, () => controller.getUrl())) {
      return;
    }
    try {
      controller.runJavaScript(webCallScript('__ergoSide', JSON.stringify(this.sideView)))
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'push side view failed: %{public}s', JSON.stringify(err));
        });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'push side view failed: %{public}s', JSON.stringify(e));
    }
  }

  /**
   * 侧边栏的 Web 接上控制器时登记 window.ergoSide（只认配好的来源，和原生桥同一个白名单；登记的对象下一次加载才出现在网页里）。
   * 这里不开侧边栏的网页：真机上接上控制器之后 Web 组件才按 src 加载 about:blank，这时调的 loadUrl 会被它盖掉（侧边栏一片空白，
   * 2026-10-18 真机），所以等 about:blank 加载完再去（sidePageEnd）
   */
  private registerSideHost(): void {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    try {
      this.sideController.registerJavaScriptProxy(this.sideHost, SIDE_HOST_NAME, SIDE_HOST_METHODS, [], bridgePermission(server));
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'register side host failed: %{public}s', JSON.stringify(e));
    }
    // 312 号票：侧边栏的对象、侧边栏上的原生桥都用旧名字再挂一份（网页还是旧版时照样能用）
    this.registerOldName(this.sideController, this.sideHost, SIDE_HOST_NAME, SIDE_HOST_METHODS, []);
    this.registerOldName(this.sideController, this.sideBridge as NativeBridge, NATIVE_BRIDGE_NAME, NATIVE_SIDE_BRIDGE_METHODS, NATIVE_BRIDGE_ASYNC_METHODS);
  }

  /** 312 号票：同一个对象用旧名字再登记一份（只认配好的来源，和新名字的一样；登记不上只记日志，新名字的照常） */
  private registerOldName(controller: webview.WebviewController, object: Object, name: string, methods: string[], asyncMethods: string[]): void {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    try {
      controller.registerJavaScriptProxy(object, oldNameOf(name), methods, asyncMethods, bridgePermission(server));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'register old name %{public}s failed: %{public}s', oldNameOf(name), JSON.stringify(e));
    }
  }

  /** 侧边栏的网页加载完：开场的 about:blank 加载完时去二狗的侧边栏地址（只去一次）；二狗的侧边栏页面加载完推一次样子 */
  private sidePageEnd(): void {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    if (!this.sideNavigated) {
      this.sideNavigated = true;
      try {
        this.sideController.loadUrl(sideUrlOf(server.href));
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'load side page failed: %{public}s', JSON.stringify(e));
      }
      return;
    }
    this.pushSide();
  }

  /** 侧边栏的网页调的（window.ergoSide）：起来了就推一次样子；收起、取消选中转给二狗的网页 */
  private sideAction(action: string): void {
    if (action === 'ready') {
      this.pushSide();
      return;
    }
    if (action === 'close' || action === 'clearSelection') {
      this.pushBrowser(JSON.stringify(new SideForward(action)));
    }
  }

  /**
   * 侧边栏的网页要去的地方（147 号票）：二狗自己的留在侧边栏里；about:、blob:、data:、javascript: 留着；外部网页改到内置浏览器里打开
   * （告诉二狗的网页，窄屏上收起侧边栏让用户看到网页）；别的（tel:、mailto:）交给系统（只认用户点出来的）
   */
  private sideIntercept(request: WebResourceRequest): boolean {
    const target = request.getRequestUrl();
    const server = this.server;
    if (server !== undefined && originOf(target) === server.origin) {
      return false;
    }
    const colon = target.indexOf(':');
    const scheme = colon > 0 ? target.substring(0, colon).toLowerCase() : '';
    if (scheme.length === 0 || IN_PAGE_SCHEMES.includes(scheme)) {
      return false;
    }
    if (isWebUrl(target)) {
      if (request.isMainFrame()) {
        this.browser.load(target);
        this.pushBrowser(JSON.stringify(new SideForward('link')));
      }
      return true;
    }
    if (request.isMainFrame() && request.isRequestGesture()) {
      this.openOutside(target);
    }
    return true;
  }

  /** 浏览器现在显示着（"浏览"页签开着、没被地址页和出错页盖住） */
  private browserShown(): boolean {
    return this.browserCreated && this.browserFrame.visible && !this.editing && this.loadError.length === 0;
  }

  /** 网页报的内容区（CSS 像素）换成 vp 摆浏览器：先乘网页的 devicePixelRatio 成物理像素，再按屏幕密度换成 vp */
  private layoutBrowser(json: string): void {
    const layout = parseLayout(json);
    if (layout === undefined) {
      hilog.warn(DOMAIN, TAG, 'browser layout ignored: %{public}s', json);
      return;
    }
    const ui = this.getUIContext();
    const frame = new BrowserFrame();
    frame.visible = layout.visible && layout.width > 0 && layout.height > 0;
    frame.x = ui.px2vp(layout.x * layout.dpr);
    frame.y = ui.px2vp(layout.y * layout.dpr);
    frame.width = ui.px2vp(layout.width * layout.dpr);
    frame.height = ui.px2vp(layout.height * layout.dpr);
    this.browserFrame = frame;
  }

  /** 网页顶栏的动作；outside 是用系统浏览器打开现在这一页 */
  private browserNav(action: string): void {
    if (action !== 'outside') {
      this.browser.nav(action);
      return;
    }
    const url = this.browser.currentUrl();
    if (url.length === 0) {
      return;
    }
    this.context.openLink(url).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'open in system browser failed: %{public}s', JSON.stringify(err));
    });
  }

  /**
   * 原生录音往网页推（实时音量、出错、App 放掉了录音器）：调网页登记的 window.__ergoVoice(json)。
   * 推之前核对主框架还是配好的来源（和原生桥的 allowed() 同一个口径）：页面跳到了别的地址就不推
   */
  private pushVoice(controller: webview.WebviewController, server: ServerAddress, json: string): void {
    if (!pageFromServer(server, () => controller.getUrl())) {
      hilog.warn(DOMAIN, TAG, 'voice event not pushed: page is not %{public}s', server.origin);
      return;
    }
    try {
      controller.runJavaScript(webCallScript('__ergoVoice', JSON.stringify(json)))
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'push voice event failed: %{public}s', JSON.stringify(err));
        });
    } catch (e) {
      // Web 组件已经拆掉了（换地址）：不推了
      hilog.warn(DOMAIN, TAG, 'push voice event failed: %{public}s', JSON.stringify(e));
    }
  }

  private openServer(address: ServerAddress): void {
    // 换地址：旧网页（连同侧边栏）的原生录音器先放掉
    this.bridge?.releaseVoice('server-changed');
    this.sideBridge?.releaseVoice('server-changed');
    this.server = address;
    this.controller = new webview.WebviewController();
    const controller = this.controller;
    const voice = new NativeVoice(this.context, (json: string) => this.pushVoice(controller, address, json));
    this.bridge = new NativeBridge(this.context, this.settings, address, voice, this.nativeNotify,
      () => controller.getUrl(),
      () => controller.getLastJavascriptProxyCallingFrameUrl(),
      // 网页调过来的时候不在这次调用里拆掉 Web 组件，等调用返回
      () => {
        setTimeout(() => this.startEditing(), 0);
      },
      // 网页调过原生桥了：是二狗的网页
      () => {
        this.notErgo = false;
      },
      // 底部避让区（105 号票）
      () => this.bottomInsetPx,
      // 原生的内置浏览器（134 号票）
      new BrowserHost(() => this.browser.attach(), (json: string) => this.layoutBrowser(json),
        (url: string) => {
          this.browser.load(url);
        },
        (action: string) => this.browserNav(action),
        (op: string, args: string) => this.pageControl.run(op, args),
        (id: string, base64: string) => this.pageControl.writeChunk(id, base64),
        (json: string) => this.pageControl.deliver(json),
        (choice: string) => this.pageControl.choose(choice),
        // 浏览侧边栏（147 号票）
        (json: string) => this.layoutSide(json),
        // 放掉预备好了没用上的文件（149 号票）
        (json: string) => this.pageControl.discard(json),
        // 能渲染的文件（160 号票）
        (op: string, id: string) => this.fileDocs.run(op, id),
        // ⋮ 菜单用到的原生工具（165 号票）
        (op: string, json: string) => this.browserTools.run(op, json)),
      // 读本机（299 号票）
      this.phoneData);
    // 浏览侧边栏跟着二狗的地址：换地址时拆掉，下次展开再按新地址建
    this.sideCreated = false;
    this.sideVisible = false;
    this.sideFrame = new SideFrame();
    this.sideView = '';
    this.sideNavigated = false;
    this.sideController = new webview.WebviewController();
    const sideController = this.sideController;
    const sideVoice = new NativeVoice(this.context, (json: string) => this.pushVoice(sideController, address, json));
    this.sideBridge = new NativeBridge(this.context, this.settings, address, sideVoice, this.nativeNotify,
      () => sideController.getUrl(),
      () => sideController.getLastJavascriptProxyCallingFrameUrl(),
      // 地址页、浏览器这些不开给侧边栏（NATIVE_SIDE_BRIDGE_METHODS 里没有）
      () => {},
      () => {},
      () => this.bottomInsetPx,
      idleBrowserHost());
    // 新页面要重新说它有没有"浏览"页签
    this.browser.attached = false;
    clearTimeout(this.notErgoTimer);
    this.notErgo = false;
    this.loadError = '';
    this.hasServer = true;
    this.session += 1;
  }

  /** 页面加载完：过一阵网页还没调过原生桥（二狗的网页一打开就会问 App 的版本号），就提示"这不是二狗？" */
  private checkIsErgo(): void {
    clearTimeout(this.notErgoTimer);
    const bridge = this.bridge;
    this.notErgoTimer = setTimeout(() => {
      if (bridge !== undefined && bridge === this.bridge && !bridge.contacted && this.loadError.length === 0) {
        hilog.warn(DOMAIN, TAG, 'page never called the bridge: not an ergo page?');
        this.notErgo = true;
      }
    }, NOT_ERGO_AFTER_MS);
  }

  private startEditing(): void {
    this.notErgo = false;
    this.draft = this.server === undefined ? '' : this.server.href;
    this.draftError = '';
    this.editing = true;
  }

  private saveDraft(): void {
    const checked = checkServerAddress(this.draft);
    if (checked.address === undefined) {
      this.draftError = checked.error;
      return;
    }
    this.settings.setServerUrl(checked.address.href);
    this.editing = false;
    if (this.server !== undefined && this.server.href === checked.address.href && this.loadError.length === 0) {
      return;
    }
    this.openServer(checked.address);
  }

  private retry(): void {
    if (this.server === undefined) {
      return;
    }
    this.loadError = '';
    try {
      this.controller.loadUrl(this.server.href);
    } catch (e) {
      this.openServer(this.server);
    }
  }

  /**
   * 网页要麦克风（getUserMedia）：只对配好的来源、只给麦克风；App 还没有麦克风权限时先向用户申请。
   * 63 号票起网页在 App 里用原生录音（voice/NativeVoice.ets），不再走 getUserMedia；这里留给没有原生录音的网页（旧版网页）
   */
  private onPermissionRequest(request: PermissionRequest): void {
    const resources = request.getAccessibleResource();
    const fromServer = this.server !== undefined && originOf(request.getOrigin()) === this.server.origin;
    const onlyMicrophone = resources.length > 0 && resources.every((r: string) => r === AUDIO_CAPTURE);
    if (!fromServer || !onlyMicrophone) {
      hilog.warn(DOMAIN, TAG, 'deny web permission %{public}s for %{public}s', resources.join(','), request.getOrigin());
      request.deny();
      return;
    }
    abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.context, [MICROPHONE])
      .then((result) => {
        if (result.authResults.length > 0 && result.authResults[0] === 0) {
          request.grant([AUDIO_CAPTURE]);
        } else {
          request.deny();
        }
      })
      .catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'request microphone failed: %{public}s', JSON.stringify(err));
        request.deny();
      });
  }

  /** 交给系统：tel: 拉起拨号界面，别的（mailto:、sms:、别的 App 的链接）按链接找能打开它的应用 */
  private openOutside(target: string): void {
    const openLink = () => {
      this.context.openLink(target).catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'open %{public}s failed: %{public}s', target, JSON.stringify(err));
      });
    };
    if (!target.toLowerCase().startsWith('tel:')) {
      openLink();
      return;
    }
    let phoneNumber = target.substring(4);
    const query = phoneNumber.indexOf('?');
    if (query >= 0) {
      phoneNumber = phoneNumber.substring(0, query);
    }
    try {
      call.makeCall(this.context, decodeURIComponent(phoneNumber)).catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'makeCall failed: %{public}s', JSON.stringify(err));
        openLink();
      });
    } catch (e) {
      // 没有电话能力的设备（平板）：按链接找应用
      openLink();
    }
  }

  /**
   * 主页面要去的地方：配好的来源留在 App 里；mailto:、tel: 这类交给系统，不落到出错页；
   * 别的网站：网页有"浏览"页签（134 号票）就在原生浏览器里打开、让网页切过去，旧版网页照旧交给系统浏览器；
   * 地址本身跳到别的来源时提示去改地址。App 里只显示配好的那个来源
   */
  private interceptLoad(request: WebResourceRequest): boolean {
    if (this.server === undefined || !request.isMainFrame()) {
      return false;
    }
    const target = request.getRequestUrl();
    const colon = target.indexOf(':');
    const scheme = colon > 0 ? target.substring(0, colon).toLowerCase() : '';
    if (scheme.length === 0 || IN_PAGE_SCHEMES.includes(scheme)) {
      return false;
    }
    if (scheme !== 'http' && scheme !== 'https') {
      this.openOutside(target);
      return true;
    }
    const origin = originOf(target);
    if (origin === this.server.origin) {
      return false;
    }
    if (request.isRedirect()) {
      this.loadError = t('harmony.index.redirected', { 'url': target });
      return true;
    }
    if (this.browser.attached && this.browser.load(target)) {
      this.browser.pushOpened(target);
      return true;
    }
    this.context.openLink(target).catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'open link failed: %{public}s', JSON.stringify(err));
    });
    return true;
  }

  @Builder
  WebPage() {
    Web({ src: this.server === undefined ? '' : this.server.href, controller: this.controller })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(false)
      // 网页的 prefers-color-scheme 跟着系统（外观选"跟随系统"时用）；不强制把网页反色，深色由网页自己画
      .darkMode(WebDarkMode.Auto)
      .forceDarkAccess(false)
      .javaScriptProxy({
        object: this.bridge as NativeBridge,
        name: NATIVE_BRIDGE_NAME,
        methodList: NATIVE_BRIDGE_METHODS,
        asyncMethodList: NATIVE_BRIDGE_ASYNC_METHODS,
        controller: this.controller,
        permission: bridgePermission(this.server as ServerAddress)
      })
      .onPermissionRequest((event: OnPermissionRequestEvent) => {
        this.onPermissionRequest(event.request);
      })
      .onControllerAttached(() => {
        this.downloads.attach(this.controller);
        // 312 号票：原生桥用旧名字再挂一份（网页还是旧版时照样能用）
        this.registerOldName(this.controller, this.bridge as NativeBridge, NATIVE_BRIDGE_NAME, NATIVE_BRIDGE_METHODS, NATIVE_BRIDGE_ASYNC_METHODS);
      })
      .onLoadIntercept((event: OnLoadInterceptEvent) => this.interceptLoad(event.data))
      // 页面重新加载、跳走：上一个页面备好的原生录音器放掉（新页面进语音模式时再要）；新页面要重新说它有没有"浏览"页签、
      // 浏览器先藏起来（新页面开到"浏览"会再报内容区）
      .onPageBegin(() => {
        this.bridge?.releaseVoice('reload');
        this.browser.attached = false;
        // 新页面要重新说它能不能渲染文件（160 号票）
        this.fileDocs.enabled = false;
        this.browserFrame = new BrowserFrame();
        // 浏览器里网页上的气泡没人管了，收起（146 号票）
        this.pageControl.hostPageBegin();
        // 新页面的查找栏是关着的（165 号票）
        this.browserTools.findOpen = false;
        // 浏览侧边栏也先藏起来（新页面开到"浏览"会再报）
        this.sideVisible = false;
        this.sideFrame = new SideFrame();
      })
      .onPageEnd(() => {
        this.checkIsErgo();
        // 网页开场经 safeArea() 取；那时还没量到的，这里再推一次
        this.pushInsets();
      })
      .onErrorReceive((event: OnErrorReceiveEvent) => {
        if (event.request.isMainFrame() && !IGNORED_NET_ERRORS.includes(event.error.getErrorCode())) {
          this.loadError = t('harmony.index.cantConnect', { 'error': event.error.getErrorInfo() });
        }
      })
      .onHttpErrorReceive((event: OnHttpErrorReceiveEvent) => {
        if (event.request.isMainFrame() && event.response.getResponseCode() >= 400) {
          this.loadError = t('harmony.index.httpError', { 'code': String(event.response.getResponseCode()) });
        }
      })
      // 网页还没画出来之前的底色跟着系统深浅色（不先白一下）；画出来之后是网页自己的底色
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .width('100%')
      .height('100%')
      // 105 号票：延伸到底部手势条（三键导航条）底下，竖屏横屏都拉满，不再留一条白边；顶部状态栏照旧让开。
      // 页面底部导航、输入框让开多少由网页按 safeArea() 定（只让开一小截）
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }

  /**
   * 浏览器里的网页要去的地方（134 号票）：http、https 留在浏览器里；about:、blob:、data:、javascript: 留在页面里；
   * 别的（tel:、mailto:、App 跳转）交给系统（只认主框架的、用户点出来的，网页自己偷偷跳的不拉起别的应用）
   */
  private browserIntercept(request: WebResourceRequest): boolean {
    const target = request.getRequestUrl();
    const colon = target.indexOf(':');
    const scheme = colon > 0 ? target.substring(0, colon).toLowerCase() : '';
    if (scheme.length === 0 || scheme === 'http' || scheme === 'https' || IN_PAGE_SCHEMES.includes(scheme)) {
      return false;
    }
    if (request.isMainFrame() && request.isRequestGesture()) {
      this.openOutside(target);
    } else {
      hilog.info(DOMAIN, TAG, 'browser blocked a %{public}s link without a user gesture', scheme);
    }
    return true;
  }

  /**
   * 原生的内置浏览器（134 号票，网页"浏览"页签的内容区）：位置大小照网页报的摆，藏起来时 Web 留着（Visibility.Hidden 不收触摸）。
   * 不挂二狗的原生桥，外部网页拿不到二狗的任何原生能力；只注入页面桥（134 号票第二部分：javaScriptOnDocumentStart，在网页的脚本之前）
   * 和它报话用的 ergoPageHost（只有 post 一个方法，没有口令的话不认）；网页弹出的选文件对话框由页面桥那边接管（问"让二狗选 / 自己选"）；
   * 不给定位、摄像头、麦克风；调试和二狗的网页一样默认关（setWebDebuggingAccess 是全局的，见 aboutToAppear）
   */
  @Builder
  BrowserPage() {
    Web({ src: 'about:blank', controller: this.browser.controller })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(false)
      .geolocationAccess(false)
      .darkMode(WebDarkMode.Auto)
      .forceDarkAccess(false)
      .javaScriptOnDocumentStart(this.pageControl.scripts)
      .javaScriptProxy({
        object: this.pageHost,
        name: PAGE_HOST_NAME,
        methodList: ['post'],
        controller: this.browser.controller
      })
      .onShowFileSelector((event: OnShowFileSelectorEvent) => this.pageControl.intercept(event))
      .onControllerAttached(() => {
        this.browserDownloads.attach(this.browser.controller);
        this.browser.controllerAttached();
      })
      .onLoadIntercept((event: OnLoadInterceptEvent) => this.browserIntercept(event.data))
      .onPageBegin((event: OnPageBeginEvent) => {
        this.pageControl.browserPageBegin();
        this.browser.pageBegin(event.url);
        this.fileDocs.pageBegin();
        // 按网站记住的文字大小（165 号票）
        this.browserTools.pageBegin(event.url);
      })
      .onPageEnd((event: OnPageEndEvent) => {
        this.browser.pageEnd(event.url);
        // 能渲染的文件（160 号票）：问这一页的类型报给网页
        this.fileDocs.pageEnd(event.url);
      })
      .onProgressChange((event: OnProgressChangeEvent) => this.browser.progressChanged(event.newProgress))
      .onTitleReceive((event: OnTitleReceiveEvent) => this.browser.titleReceived(event.title))
      .onRefreshAccessedHistory((event: OnRefreshAccessedHistoryEvent) => this.browser.historyChanged(event.url))
      // 页内查找的结果（165 号票）：推给网页的查找栏（第几个、一共几个）
      .onSearchResultReceive((event: OnSearchResultReceiveEvent) => this.browserTools.searchResult(event.activeMatchOrdinal,
        event.numberOfMatches, event.isDoneCounting))
      // 文字大小（165 号票）：按网站记住
      .textZoomRatio(this.browserTextZoom)
      .onPermissionRequest((event: OnPermissionRequestEvent) => {
        hilog.info(DOMAIN, TAG, 'browser denied web permission for %{public}s', event.request.getOrigin());
        event.request.deny();
      })
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .position({ x: this.browserFrame.x, y: this.browserFrame.y })
      .width(this.browserFrame.width)
      .height(this.browserFrame.height)
      .visibility(this.browserShown() ? Visibility.Visible : Visibility.Hidden)
  }

  /**
   * 浏览侧边栏（147 号票，browser/SidePanel.ets）：二狗网页的侧边栏模式，盖在原生网页上面（宽屏右边一块、窄屏整屏）。
   * 二狗自己的网页：挂二狗原生桥（只开版本号、日志、录音那一组，"按住说话"走原生录音器）和 window.ergoSide（收起、取消选中、
   * 起来了，控制器接上时登记——一个 Web 组件的 javaScriptProxy 属性只挂得了一个对象），都只认配好的来源；
   * 键盘照主界面的 Web（RESIZE_CONTENT）；里面点的外部网页链接改到内置浏览器里打开
   */
  @Builder
  SidePage() {
    // 先空着，控制器接上时登记好 window.ergoSide，about:blank 加载完再开侧边栏的网页（登记的对象下一次加载才出现在网页里）
    Web({ src: 'about:blank', controller: this.sideController })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(false)
      .geolocationAccess(false)
      .darkMode(WebDarkMode.Auto)
      .forceDarkAccess(false)
      .javaScriptProxy({
        object: this.sideBridge as NativeBridge,
        name: NATIVE_BRIDGE_NAME,
        methodList: NATIVE_SIDE_BRIDGE_METHODS,
        asyncMethodList: NATIVE_BRIDGE_ASYNC_METHODS,
        controller: this.sideController,
        permission: bridgePermission(this.server as ServerAddress)
      })
      .onControllerAttached(() => this.registerSideHost())
      .keyboardAvoidMode(WebKeyboardAvoidMode.RESIZE_CONTENT)
      .onPermissionRequest((event: OnPermissionRequestEvent) => {
        this.onPermissionRequest(event.request);
      })
      // 侧边栏的网页重新加载：备好的原生录音器放掉（新页面要时再备）
      .onPageBegin(() => this.sideBridge?.releaseVoice('reload'))
      .onLoadIntercept((event: OnLoadInterceptEvent) => this.sideIntercept(event.data))
      .onPageEnd(() => this.sidePageEnd())
      .backgroundColor($r('sys.color.ohos_id_color_background'))
      .position({ x: this.sideFrame.x, y: this.sideFrame.y })
      .width(this.sideFrame.width)
      .height(this.sideFrame.height)
      .translate({ x: this.sideOffset })
      .shadow({ radius: 16, color: '#33000000', offsetX: -2 })
      .visibility(this.sideShown() ? Visibility.Visible : Visibility.Hidden)
  }

  /** 地址填成了能打开、但不是二狗的网站时，原生层唯一的出口 */
  @Builder
  NotErgoBar() {
    Row({ space: 12 }) {
      Text(this.tx('harmony.index.notErgo'))
        .fontSize(15)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .layoutWeight(1)
      Button(this.tx('harmony.index.changeAddress'))
        .onClick(() => this.startEditing())
      Button(this.tx('harmony.index.close'), { buttonStyle: ButtonStyleMode.NORMAL })
        .onClick(() => {
          this.notErgo = false;
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .shadow({ radius: 12, color: '#33000000' })
    // 底色铺到手势条底下（按钮还在避让区之上）
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }

  @Builder
  ErrorPage() {
    Column({ space: 16 }) {
      Text(this.tx('harmony.index.cantOpen'))
        .fontSize(22)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      Text(this.loadError)
        .fontSize(15)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .textAlign(TextAlign.Center)
      Text(this.server === undefined ? '' : this.server.href)
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      Row({ space: 12 }) {
        Button(this.tx('harmony.index.retry'))
          .onClick(() => this.retry())
        Button(this.tx('harmony.index.editAddress'), { buttonStyle: ButtonStyleMode.NORMAL })
          .onClick(() => this.startEditing())
      }
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .justifyContent(FlexAlign.Center)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }

  @Builder
  AddressPage() {
    Column({ space: 14 }) {
      Text(this.tx('harmony.address.title'))
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      Text(this.tx('harmony.address.heading'))
        .fontSize(17)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      Text(this.tx('harmony.address.hint'))
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      TextInput({ text: this.draft, placeholder: 'https://' })
        .type(InputType.URL)
        .enterKeyType(EnterKeyType.Go)
        .onChange((value: string) => {
          this.draft = value;
          this.draftError = '';
        })
        .onSubmit(() => this.saveDraft())
      if (this.draftError.length > 0) {
        Text(this.draftError)
          .fontSize(14)
          .fontColor($r('sys.color.ohos_id_color_warning'))
      }
      Row({ space: 12 }) {
        if (this.hasServer) {
          Button(this.tx('harmony.address.cancel'), { buttonStyle: ButtonStyleMode.NORMAL })
            .onClick(() => {
              this.editing = false;
            })
        }
        Button(this.tx('harmony.address.connect'))
          .onClick(() => this.saveDraft())
      }
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .alignItems(HorizontalAlign.Start)
    .justifyContent(FlexAlign.Center)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.BOTTOM])
  }

  build() {
    // 底部对齐：只有"这不是二狗？"那一条不是整页大小
    Stack({ alignContent: Alignment.Bottom }) {
      if (this.hasServer) {
        // 只有一项，键跟着 session 变：换地址时旧的 Web 组件拆掉、新建一个
        ForEach([this.session], (key: number) => {
          this.WebPage()
        }, (key: number) => `web-${key}`)
      }
      // 原生的内置浏览器（134 号票）：建了就一直留着，换地址也不拆
      if (this.hasServer && this.browserCreated) {
        this.BrowserPage()
      }
      // 浏览侧边栏（147 号票）：盖在原生网页上面；第一次展开才建，之后留着
      if (this.hasServer && this.sideCreated) {
        this.SidePage()
      }
      if (this.hasServer && this.loadError.length > 0 && !this.editing) {
        this.ErrorPage()
      }
      if (this.hasServer && this.notErgo && this.loadError.length === 0 && !this.editing) {
        this.NotErgoBar()
      }
      if (this.editing) {
        this.AddressPage()
      }
    }
    .width('100%')
    .height('100%')
  }
}
