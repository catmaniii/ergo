import { bundleManager, common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppSettings, colorModeOf, DOMAIN, TAG } from '../common/AppSettings';
import { originOf, ServerAddress } from '../common/ServerAddress';
import { appTexts } from '../common/AppTexts';
import { NativeNotify, notifyTaps } from '../notify/NativeNotify';
import { PhoneData } from '../phone/PhoneData';
import { NativeVoice } from '../voice/NativeVoice';

/** 网页里看到的名字：window.ergoNative（packages/web/src/app/native-app.ts 按这个名字检测） */
export const NATIVE_BRIDGE_NAME = 'ergoNative';

/**
 * 网页能调的同步方法（62 号票：版本号、日志、设置地址、外观，加上返回键的 setCanGoBack）。
 * 63 号票的原生录音（备好、开始、停止交出音频、丢弃、释放）也在这里：要等结果的（voicePrepare、voiceStart、voiceStop）
 * 是同步方法、回 Promise<string>，网页那边拿到的是 Promise（官方文档"应用侧 new Promise 作为返回值传给前端"）；
 * 不放进 asyncMethodList——那里的方法拿不到返回值。原生往网页推的实时音量、错误用 controller.runJavaScript 调网页登记的
 * window.__ergoVoice。每个新方法开头都要先过 allowed()。名字和网页一侧 packages/web/src/app/native-voice.ts 的 NATIVE_VOICE_METHODS 一致。
 * 105 号票的 safeArea：Web 组件延伸到了底部手势条底下，告诉网页那一截多高（网页一侧 packages/web/src/app/native-app.ts）
 * 110 号票的系统通知（开没开、要授权、发一条、取用户点开的那一条）：名字和网页一侧 packages/web/src/app/native-notify.ts 的
 * NATIVE_NOTIFY_METHODS 一致；notifyPrepare 要等系统的授权框，和录音一样回 Promise<string>
 * 124 号票（网页设置里的 Debug 工具集）：notifyShow 多一个可选参数 force（前台也发）、回这一条的结果（Promise<string>），
 * notifyState 多带 foreground，新加 notifyResetAsked（清掉"问过了"）。网页认 notifyResetAsked 在不在来分新旧 App
 * 134 号票的原生内置浏览器（"浏览"页签）：browserAttach（网页有这个页签了，回浏览器的样子）、browserLayout（内容区的位置大小）、
 * browserLoad（开一个网址）、browserNav（后退、前进、刷新、停止、系统浏览器打开）。名字和网页一侧
 * packages/web/src/app/native-browser.ts 的 NATIVE_BROWSER_METHODS 一致；浏览器那个 Web 组件本身不挂这个原生桥。
 * 134 号票第二部分（网页的框上的悬浮按钮）：browserPage（调页面桥：列框、填字、按钮的样子）、browserFileChunk（把要交的文件一段一段写进
 * App 的缓存）、browserFiles（交进选文件的框，或交给拦下的选文件对话框）、browserChooser（拦下的对话框上用户选了"自己选"或取消），
 * 都回 Promise<string>；名字和网页一侧的 NATIVE_PAGE_METHODS 一致。
 * 147 号票（浏览侧边栏）：browserSide（侧边栏摆在哪、交给侧边栏网页的样子），名字和网页一侧的 NATIVE_SIDE_METHOD 一致。
 * 149 号票：browserDiscard（放掉预备好了没用上的文件），名字和网页一侧的 NATIVE_DISCARD_METHOD 一致（网页认它在不在来分新旧 App）。
 * 160 号票：browserDoc（能渲染的文件：enable / source / save / outside / drop），名字和网页一侧的 NATIVE_DOC_METHOD 一致（网页认它在不在来分新旧 App）。
 * 165 号票："浏览"的 ⋮ 菜单用到的原生工具 browserTool（页内查找、按网站的文字大小和桌面版、分享、清数据、下载记录），名字和网页一侧的
 * NATIVE_TOOL_METHOD 一致（网页认它在不在来分新旧 App，旧版 App 上菜单里这几项灰掉）。
 * 175 号票：setTexts（二狗的网页交来当前语言的 App 原生的字，common/AppTexts.ets），名字和网页一侧 native-app.ts 认的一致（网页认它在不在来分新旧 App）。
 * 299 号票：读本机（phone/PhoneData.ets）——phoneContactsPick（系统的选人界面）、phoneCalendarState、phoneCalendarPrepare（要读日历的授权）、
 * phoneCalendarRead（只读一段时间里的日程），名字和网页一侧 packages/web/src/app/native-phone.ts 的 NATIVE_PHONE_METHODS 一致
 * （网页认四个都在才算新版 App）。只开给主界面那个 Web，侧边栏没有。
 * 300 号票：照片的时间地点（phone/PhonePhotos.ets）——phonePhotosState、phonePhotosPrepare、phonePhotosRead；位置（phone/PhoneLocation.ets）——
 * phoneLocationState、phoneLocationPrepare、phoneLocationRecord（开始 / 停下记）、phoneLocationRead（记下、没交出去的点）、phoneLocationAck
 * （交好了删掉），名字和网页一侧的 NATIVE_PHONE_PHOTOS_METHODS、NATIVE_PHONE_LOCATION_METHODS 一致。同样只开给主界面。
 * 308 号票："常去的地方"手动加一处用的 phonePlaceHere（现在在哪：定一次位、转地名）、phonePlaceFind（按地名找），名字和网页一侧的
 * NATIVE_PHONE_PLACE_METHODS 一致；照片、位置点读出来时带系统地名（phone/PhoneGeocode.ets）。同样只开给主界面。
 * 侧边栏是 App 另开的一个 Web 组件（browser/SidePanel.ets），加载的也是二狗自己的网页：它另挂一个原生桥，只开 NATIVE_SIDE_BRIDGE_METHODS
 */
export const NATIVE_BRIDGE_METHODS: string[] = ['appVersion', 'log', 'editServer', 'setColorMode', 'setCanGoBack',
  'voicePrepare', 'voiceStart', 'voiceStop', 'voiceDiscard', 'voiceRelease', 'safeArea',
  'notifyState', 'notifyPrepare', 'notifyShow', 'notifyTakeOpen', 'notifyResetAsked',
  'browserAttach', 'browserLayout', 'browserLoad', 'browserNav',
  'browserPage', 'browserFileChunk', 'browserFiles', 'browserChooser', 'browserSide', 'browserDiscard', 'browserDoc', 'browserTool',
  'setTexts',
  'phoneContactsPick', 'phoneCalendarState', 'phoneCalendarPrepare', 'phoneCalendarRead',
  'phonePhotosState', 'phonePhotosPrepare', 'phonePhotosRead',
  'phoneLocationState', 'phoneLocationPrepare', 'phoneLocationRecord', 'phoneLocationRead', 'phoneLocationAck',
  'phonePlaceHere', 'phonePlaceFind'];

/**
 * 浏览侧边栏那个 Web 组件上的原生桥（147 号票，主会话定：侧边栏挂二狗原生桥走原生录音）：同一个 NativeBridge 类、自己一份原生录音器，
 * 只开版本号（网页据此认出在 App 里）、日志和录音那一组——"按住说话"照 63 号票走原生录音器，不用 getUserMedia。
 * 地址页、外观、返回键、底部避让、系统通知、内置浏览器这些只归主界面那个 Web（侧边栏那一页认不出它们，什么都不变：外观两页共用一份设置，
 * 返回手势由 App 先收侧边栏，底部让开多少由"浏览"页随侧边栏的样子交过去，通知、浏览器由主界面那一页管）
 */
export const NATIVE_SIDE_BRIDGE_METHODS: string[] = ['appVersion', 'log',
  'voicePrepare', 'voiceStart', 'voiceStop', 'voiceDiscard', 'voiceRelease'];

/** asyncMethodList（ArkWeb 异步调用、拿不到返回值）：现在没有 */
export const NATIVE_BRIDGE_ASYNC_METHODS: string[] = [];

/**
 * 底部避让区（105 号票）：Web 组件延伸到了手势条（三键导航条）底下的那一截有多高，物理像素。
 * safeArea() 回它的 JSON；变了（量到了、转屏）Index.ets 经 window.__ergoInsets(json) 推给网页
 */
export interface SafeAreaMessage {
  bottom: number;
}

/**
 * 原生的内置浏览器（134 号票）由 Index.ets 管（Web 组件、摆放），原生桥只把网页的调用转过去
 */
export class BrowserHost {
  /** 网页有"浏览"页签了：回浏览器现在的样子（JSON） */
  attach: () => string;
  /** 内容区的位置大小（JSON：CSS 像素、devicePixelRatio、要不要显示） */
  layout: (json: string) => void;
  /** 开一个网址（只认 http、https） */
  load: (url: string) => void;
  /** back / forward / reload / stop / outside */
  nav: (action: string) => void;
  /** 调页面桥（fields / fill / mark），args 是参数的 JSON 数组 */
  page: (op: string, args: string) => Promise<string>;
  /** 要交的文件的一段（base64）写进 App 的缓存 */
  fileChunk: (id: string, base64: string) => Promise<string>;
  /** 交文件（JSON：target、fieldId、files） */
  files: (json: string) => Promise<string>;
  /** 拦下的选文件对话框：system / cancel */
  chooser: (choice: string) => Promise<string>;
  /** 浏览侧边栏（147 号票）：侧边栏摆在哪（JSON：CSS 像素、devicePixelRatio、要不要显示）、交给侧边栏网页的样子 */
  side: (json: string) => void;
  /** 放掉预备好了没用上的文件（149 号票，JSON：文件编号的数组） */
  discard: (json: string) => Promise<string>;
  /** 能渲染的文件（160 号票）：enable / source / save / outside / drop，id 是报给网页的文件编号 */
  doc: (op: string, id: string) => Promise<string>;
  /** ⋮ 菜单用到的原生工具（165 号票，browser/BrowserTools.ets）：op 加参数的 JSON */
  tool: (op: string, json: string) => Promise<string>;

  constructor(attach: () => string, layout: (json: string) => void, load: (url: string) => void, nav: (action: string) => void,
    page: (op: string, args: string) => Promise<string>, fileChunk: (id: string, base64: string) => Promise<string>,
    files: (json: string) => Promise<string>, chooser: (choice: string) => Promise<string>, side: (json: string) => void,
    discard: (json: string) => Promise<string>, doc: (op: string, id: string) => Promise<string>,
    tool: (op: string, json: string) => Promise<string>) {
    this.attach = attach;
    this.layout = layout;
    this.load = load;
    this.nav = nav;
    this.page = page;
    this.fileChunk = fileChunk;
    this.files = files;
    this.chooser = chooser;
    this.side = side;
    this.discard = discard;
    this.doc = doc;
    this.tool = tool;
  }
}

/** 侧边栏那份原生桥用的内置浏览器（147 号票）：浏览器那几个方法不开给侧边栏（NATIVE_SIDE_BRIDGE_METHODS 里没有），这里都不做事 */
export function idleBrowserHost(): BrowserHost {
  const none = (): Promise<string> => Promise.resolve('');
  return new BrowserHost(() => '', () => {}, () => {}, () => {}, none, none, none, none, () => {}, none, none, none);
}

/** 原生桥拒绝了这次调用（来源不对）时要等结果的方法回空串，网页当失败 */
function refused(): Promise<string> {
  return Promise.resolve('');
}

interface UrlPermission {
  scheme: string;
  host: string;
  /** 精确匹配，空串不查 */
  port: string;
  /** 前缀匹配，空串不查 */
  path: string;
}

interface MethodPermission {
  methodName: string;
  urlPermissionList: UrlPermission[];
}

interface ObjectPermission {
  urlPermissionList: UrlPermission[];
  methodList: MethodPermission[];
}

interface ProxyPermission {
  javascriptProxyPermission: ObjectPermission;
}

/**
 * ArkWeb 自带的白名单（javaScriptProxy 的 permission）：只有配好的那个来源的页面能调这个对象。
 * 端口留空时 ArkWeb 不查端口，所以每次调用还要在 allowed() 里按完整的来源再核对一遍。
 */
export function bridgePermission(server: ServerAddress): string {
  const own: UrlPermission = { scheme: server.scheme, host: server.host, port: server.port, path: '' };
  const permission: ProxyPermission = {
    javascriptProxyPermission: { urlPermissionList: [own], methodList: [] }
  };
  return JSON.stringify(permission);
}

/** App 的版本号（AppScope/app.json5 的 versionName） */
function appVersionName(): string {
  try {
    return bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).versionName;
  } catch (e) {
    hilog.error(DOMAIN, TAG, 'read version failed: %{public}s', JSON.stringify(e));
    return '';
  }
}

/** 取网址；取不到（controller 还没接上等）当空串 */
function safeUrl(read: () => string): string {
  try {
    return read();
  } catch (e) {
    return '';
  }
}

/**
 * 主框架现在是不是配好的那个来源：allowed() 核对网页调过来的、Index.ets 往网页推原生录音的消息之前核对，同一个口径。
 * 取不到网址（controller 还没接上、已经拆了）当不是
 */
export function pageFromServer(server: ServerAddress, currentUrl: () => string): boolean {
  return originOf(safeUrl(currentUrl)) === server.origin;
}

/** 去掉 # 后面的部分：单页应用换 # 地址不算换了文档 */
function withoutHash(href: string): string {
  const at = href.indexOf('#');
  return at < 0 ? href : href.substring(0, at);
}

/**
 * 原生桥（62 号票）：javaScriptProxy 以 `ergoNative` 名注入 ArkWeb。
 * 只对用户配好的来源的主框架开放：ArkWeb 把这个对象注入所有框架（含 iframe），白名单按调用的那个框架的网址查，
 * 别的来源的 iframe 调不进来；每次调用再核对一遍——主框架是配好的来源，调用的框架也是这个来源、而且就是主框架那个文档
 * （controller.getLastJavascriptProxyCallingFrameUrl() 和 getUrl() 去掉 # 之后相同），不对就拒绝（不做事、返回空）。
 * 残留：同一来源、网址和主框架一模一样的 iframe 分不出来（二狗的网页不用 iframe，这样的 iframe 只能来自二狗自己）。
 * 每换一次地址整个重建（连同 Web 组件和 controller），所以一个实例只认一个来源。
 */
export class NativeBridge {
  private server: ServerAddress;
  private settings: AppSettings;
  private app: common.ApplicationContext;
  private version: string;
  /** 主框架的网址（controller.getUrl()） */
  private currentUrl: () => string;
  /** 这次调用来自哪个框架的网址（controller.getLastJavascriptProxyCallingFrameUrl()） */
  private callingFrameUrl: () => string;
  /** 回到原生的地址页 */
  private onEditServer: () => void;
  /** 网页第一次调过来（说明加载的确实是二狗的网页） */
  private onContact: () => void;
  /** 底部避让区多高（物理像素）；还没量到是负数 */
  private bottomInset: () => number;
  /** 网页当前还能不能在内部返回上一级（网页经 setCanGoBack 报，原生按返回键时据此决定交给网页还是退出） */
  canGoBack: boolean = false;
  /** 网页调过原生桥没有：加载完一阵还没调过，就不是二狗的网页（Index.ets 提示"这不是二狗？换地址"） */
  contacted: boolean = false;
  /** 原生录音（63 号票），一个原生桥（一个 Web 组件、一个来源）一份 */
  private voice: NativeVoice;
  /** 系统通知（110 号票），整个页面一份（Index.ets 建，记着 App 在不在前台），换地址不重建 */
  private notify: NativeNotify;
  /** 原生的内置浏览器（134 号票），整个页面一份，换地址不重建 */
  private browser: BrowserHost;
  /** 读本机（299 号票），整个页面一份；侧边栏那份原生桥没有（不开那几个方法） */
  private phone: PhoneData | undefined;

  constructor(context: common.Context, settings: AppSettings, server: ServerAddress, voice: NativeVoice,
    notify: NativeNotify, currentUrl: () => string, callingFrameUrl: () => string, onEditServer: () => void,
    onContact: () => void, bottomInset: () => number, browser: BrowserHost, phone?: PhoneData) {
    this.app = context.getApplicationContext();
    this.settings = settings;
    this.server = server;
    this.voice = voice;
    this.notify = notify;
    this.version = appVersionName();
    this.currentUrl = currentUrl;
    this.callingFrameUrl = callingFrameUrl;
    this.onEditServer = onEditServer;
    this.onContact = onContact;
    this.bottomInset = bottomInset;
    this.browser = browser;
    this.phone = phone;
  }

  /** App 的版本号；网页据此在设置里显示"在鸿蒙 App 里运行" */
  appVersion(): string {
    if (!this.allowed('appVersion')) {
      return '';
    }
    return this.version;
  }

  /** 网页的日志写进 hilog（hdc hilog 里按 ErgoApp 过滤） */
  log(message: string): void {
    if (!this.allowed('log')) {
      return;
    }
    hilog.info(DOMAIN, TAG, '[web] %{public}s', message);
  }

  /** 设置地址：回到原生的地址页（网页设置里"换地址"） */
  editServer(): void {
    if (!this.allowed('editServer')) {
      return;
    }
    this.onEditServer();
  }

  /** 外观：system 跟随系统，light / dark 固定；记下来，下次开场先按它定深浅色（setColorMode） */
  setColorMode(mode: string): void {
    if (!this.allowed('setColorMode')) {
      return;
    }
    if (mode !== 'system' && mode !== 'light' && mode !== 'dark') {
      hilog.warn(DOMAIN, TAG, 'unknown color mode: %{public}s', mode);
      return;
    }
    this.settings.setColorMode(mode);
    try {
      this.app.setColorMode(colorModeOf(mode));
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'setColorMode failed: %{public}s', JSON.stringify(e));
    }
  }

  /** 返回键：网页报现在还能不能在内部返回；能的话原生按返回键时调网页登记的 window.__ergoBack() */
  setCanGoBack(flag: boolean): void {
    if (!this.allowed('setCanGoBack')) {
      return;
    }
    this.canGoBack = flag === true;
  }

  /** 原生录音：备好录音器（PREPARED，不采集、不占麦克风）；userAction 为真是按下引起的（用户拒过权限时弹"去设置里打开"） */
  voicePrepare(userAction: boolean): Promise<string> {
    if (!this.allowed('voicePrepare')) {
      return refused();
    }
    return this.voice.prepare(userAction === true);
  }

  /** 原生录音：开始采集（按下） */
  voiceStart(): Promise<string> {
    if (!this.allowed('voiceStart')) {
      return refused();
    }
    return this.voice.start();
  }

  /** 原生录音：停下（松手），交出这一段 PCM（base64） */
  voiceStop(): Promise<string> {
    if (!this.allowed('voiceStop')) {
      return refused();
    }
    return this.voice.stop();
  }

  /** 原生录音：丢掉这一段（上划取消、太短） */
  voiceDiscard(): void {
    if (!this.allowed('voiceDiscard')) {
      return;
    }
    this.voice.discard();
  }

  /** 原生录音：放掉录音器（离开语音模式、页面切到后台） */
  voiceRelease(): void {
    if (!this.allowed('voiceRelease')) {
      return;
    }
    this.voice.release();
  }

  /**
   * 底部避让区（105 号票）：{"bottom": 物理像素}，网页据此让页面底部只让开一小截；还没量到回空串（之后 Index.ets 推过去）
   */
  safeArea(): string {
    if (!this.allowed('safeArea')) {
      return '';
    }
    const bottom = this.bottomInset();
    if (bottom < 0) {
      return '';
    }
    const message: SafeAreaMessage = { bottom: bottom };
    return JSON.stringify(message);
  }

  /**
   * 系统通知（110 号票）：{"enabled", "asked", "foreground"}，系统设置里这个应用的通知开没开、向用户要过授权没有；
   * foreground（124 号票）是 App 现在算不算在前台（Index.ets 的 onPageShow / onPageHide）
   */
  notifyState(): string {
    if (!this.allowed('notifyState')) {
      return '';
    }
    return this.notify.state();
  }

  /**
   * 系统通知：没问过就向用户要授权（系统的授权框，只问这一次）；userAction 为真（网页设置里点"去打开"）而用户拒过时
   * 拉起系统的通知设置。回做完之后的 notifyState
   */
  notifyPrepare(userAction: boolean): Promise<string> {
    if (!this.allowed('notifyPrepare')) {
      return refused();
    }
    return this.notify.prepare(userAction === true);
  }

  /**
   * 系统通知：发一条到通知栏（App 在前台时不发，页面顶上已经有了）；route 是点了之后网页要去的页面地址（#/…）。
   * 124 号票：force 为真时在前台也发（网页设置里的 Debug 工具集；平常网页只给 4 个参数），回这一条的结果
   * {"result": "published" | "foreground" | "disabled" | "failed", "number"?, "message"?}（旧版网页不看返回值）
   */
  notifyShow(id: string, title: string, body: string, route: string, force?: boolean): Promise<string> {
    if (!this.allowed('notifyShow')) {
      return refused();
    }
    return this.notify.show(id, title, body, route, force === true);
  }

  /** 系统通知（124 号票）：清掉"问过用户了"，回之后的 notifyState（网页设置里 Debug 工具集的"重置首次提示"） */
  notifyResetAsked(): string {
    if (!this.allowed('notifyResetAsked')) {
      return '';
    }
    return this.notify.resetAsked();
  }

  /** 系统通知：用户点开的那一条 {"id", "route"}，取一次就清掉；没有回空串 */
  notifyTakeOpen(): string {
    if (!this.allowed('notifyTakeOpen')) {
      return '';
    }
    return notifyTaps.take();
  }

  /** 原生的内置浏览器（134 号票）：网页有"浏览"页签了，回浏览器现在的样子 {"url", "title", "progress", "loading", "canGoBack", "canGoForward"} */
  browserAttach(): string {
    if (!this.allowed('browserAttach')) {
      return '';
    }
    return this.browser.attach();
  }

  /** 原生的内置浏览器：内容区在网页上的位置大小 {"visible", "x", "y", "width", "height", "dpr"}（CSS 像素），App 照着摆浏览器 */
  browserLayout(json: string): void {
    if (!this.allowed('browserLayout')) {
      return;
    }
    this.browser.layout(typeof json === 'string' ? json : '');
  }

  /** 原生的内置浏览器：开一个网址（只认 http、https） */
  browserLoad(url: string): void {
    if (!this.allowed('browserLoad')) {
      return;
    }
    this.browser.load(typeof url === 'string' ? url : '');
  }

  /** 原生的内置浏览器：back / forward / reload / stop / outside（用系统浏览器打开现在这一页） */
  browserNav(action: string): void {
    if (!this.allowed('browserNav')) {
      return;
    }
    this.browser.nav(typeof action === 'string' ? action : '');
  }

  /** 页面桥（134 号票第二部分）：调浏览器里网页上的页面桥（fields / fill / mark），args 是参数的 JSON 数组，回页面桥回的 JSON */
  browserPage(op: string, args: string): Promise<string> {
    if (!this.allowed('browserPage')) {
      return refused();
    }
    return this.browser.page(typeof op === 'string' ? op : '', typeof args === 'string' ? args : '[]');
  }

  /** 要交进网页的文件的一段（base64）写进 App 的缓存；回 {"ok", "count"（已写的字节）, "reason"} */
  browserFileChunk(id: string, base64: string): Promise<string> {
    if (!this.allowed('browserFileChunk')) {
      return refused();
    }
    return this.browser.fileChunk(typeof id === 'string' ? id : '', typeof base64 === 'string' ? base64 : '');
  }

  /** 交文件 {"target": "field" | "chooser", "fieldId"?, "files": [{"id", "name", "mime"}]}；回 {"ok", "count", "reason"} */
  browserFiles(json: string): Promise<string> {
    if (!this.allowed('browserFiles')) {
      return refused();
    }
    return this.browser.files(typeof json === 'string' ? json : '');
  }

  /** 拦下的选文件对话框上用户的选择：system（系统的选择器）/ cancel */
  browserChooser(choice: string): Promise<string> {
    if (!this.allowed('browserChooser')) {
      return refused();
    }
    return this.browser.chooser(typeof choice === 'string' ? choice : '');
  }

  /** 放掉预备好了没用上的文件（149 号票）：["编号", ...]；回 {"ok", "count"} */
  browserDiscard(json: string): Promise<string> {
    if (!this.allowed('browserDiscard')) {
      return refused();
    }
    return this.browser.discard(typeof json === 'string' ? json : '[]');
  }

  /**
   * 能渲染的文件（160 号票）：enable（网页能渲染文件了）、source（取内容）、save（下载）、outside（系统浏览器打开）、drop（放掉拦下的下载），
   * id 是报给网页的文件编号；回 JSON（source 回内容，别的回 {"ok"}）
   */
  browserDoc(op: string, id: string): Promise<string> {
    if (!this.allowed('browserDoc')) {
      return refused();
    }
    return this.browser.doc(typeof op === 'string' ? op : '', typeof id === 'string' ? id : '');
  }

  /**
   * ⋮ 菜单用到的原生工具（165 号票）：find / findNext / findClear / findBar / sites / share / clear / downloads / openDownload /
   * removeDownloads，json 是参数；回 JSON
   */
  browserTool(op: string, json: string): Promise<string> {
    if (!this.allowed('browserTool')) {
      return refused();
    }
    return this.browser.tool(typeof op === 'string' ? op : '', typeof json === 'string' ? json : '{}');
  }

  /** 浏览侧边栏（147 号票）：{"dpr", "side": {"visible", "x", "y", "width", "height"}, "view"}（CSS 像素），App 照着摆侧边栏 */
  browserSide(json: string): void {
    if (!this.allowed('browserSide')) {
      return;
    }
    this.browser.side(typeof json === 'string' ? json : '');
  }

  /**
   * App 原生的字（175 号票）：二狗的网页交来当前语言的这几句 {"language", "texts": {"harmony.…": "…"}}（开场、换了语言时），
   * App 换上（common/AppTexts.ets）。认得出来回 'ok'，不然空串
   */
  setTexts(json: string): string {
    if (!this.allowed('setTexts')) {
      return '';
    }
    return appTexts.setFromWeb(typeof json === 'string' ? json : '') ? 'ok' : '';
  }

  /**
   * 读本机（299 号票）：拉起系统的选人界面（不用通讯录权限），回用户挑的人
   * {"ok": true, "device", "contacts": [{"name", "phones", "birthday"?, "addresses"}]}；取消了 {"ok": false, "reason": "cancelled"}
   */
  phoneContactsPick(): Promise<string> {
    if (!this.allowed('phoneContactsPick') || !this.phone) {
      return refused();
    }
    return this.phone.pickContacts();
  }

  /** 读本机：读手机日历的授权 {"granted", "asked", "device"} */
  phoneCalendarState(): string {
    if (!this.allowed('phoneCalendarState') || !this.phone) {
      return '';
    }
    return this.phone.calendarState();
  }

  /** 读本机：要读日历的授权（系统的授权框）；userAction 为真而拒过时拉起二次授权；回之后的状态 */
  phoneCalendarPrepare(userAction: boolean): Promise<string> {
    if (!this.allowed('phoneCalendarPrepare') || !this.phone) {
      return refused();
    }
    return this.phone.prepareCalendar(userAction === true);
  }

  /** 读本机：只读 [from, to)（毫秒）里的日程，回 {"ok", "events" | "state", "message"} */
  phoneCalendarRead(from: string, to: string): Promise<string> {
    if (!this.allowed('phoneCalendarRead') || !this.phone) {
      return refused();
    }
    return this.phone.readCalendar(typeof from === 'string' ? from : '', typeof to === 'string' ? to : '');
  }

  /** 读本机（300 号票）：读相册、读照片位置的授权 {"granted", "location", "asked", "device"} */
  phonePhotosState(): string {
    if (!this.allowed('phonePhotosState') || !this.phone) {
      return '';
    }
    return this.phone.photos.state();
  }

  /** 读本机：要读相册、读照片位置的授权（系统的授权框）；userAction 为真而拒过时拉起二次授权；回之后的状态 */
  phonePhotosPrepare(userAction: boolean): Promise<string> {
    if (!this.allowed('phonePhotosPrepare') || !this.phone) {
      return refused();
    }
    return this.phone.photos.prepare(userAction === true);
  }

  /** 读本机：只读 [from, to)（毫秒）里拍的照片的时间地点，回 {"ok", "location", "photos" | "state", "message"} */
  phonePhotosRead(from: string, to: string): Promise<string> {
    if (!this.allowed('phonePhotosRead') || !this.phone) {
      return refused();
    }
    return this.phone.photos.read(typeof from === 'string' ? from : '', typeof to === 'string' ? to : '');
  }

  /** 读本机：定位的授权、在不在记 {"granted", "precise", "asked", "recording", "background", "device"} */
  phoneLocationState(): string {
    if (!this.allowed('phoneLocationState') || !this.phone) {
      return '';
    }
    return this.phone.location.state();
  }

  /** 读本机：要定位的授权（系统的授权框）；userAction 为真而拒过时拉起二次授权；回之后的状态 */
  phoneLocationPrepare(userAction: boolean): Promise<string> {
    if (!this.allowed('phoneLocationPrepare') || !this.phone) {
      return refused();
    }
    return this.phone.location.prepare(userAction === true);
  }

  /** 读本机：开始 / 停下记位置（background 为真时后台也记，开位置类的长时任务）；回之后的状态 */
  phoneLocationRecord(on: boolean, background: boolean): Promise<string> {
    if (!this.allowed('phoneLocationRecord') || !this.phone) {
      return refused();
    }
    return this.phone.location.record(on === true, background === true);
  }

  /** 读本机：手机上记下、还没交出去的点，回 {"ok", "points" | "state", "message"} */
  phoneLocationRead(): Promise<string> {
    if (!this.allowed('phoneLocationRead') || !this.phone) {
      return refused();
    }
    return this.phone.location.read();
  }

  /** 读本机：交给守护进程了，删掉 until（毫秒）以前（含）的点；回 "ok" */
  phoneLocationAck(until: string): string {
    if (!this.allowed('phoneLocationAck') || !this.phone) {
      return '';
    }
    return this.phone.location.ack(typeof until === 'string' ? until : '');
  }

  /** 读本机（308 号票）：现在在哪（定一次位、转地名），回 {"ok", "lat", "lon", "address"? | "state", "message"} */
  phonePlaceHere(): Promise<string> {
    if (!this.allowed('phonePlaceHere') || !this.phone) {
      return refused();
    }
    return this.phone.location.here();
  }

  /** 读本机（308 号票）：按地名找（系统的地址转坐标），回 {"ok", "lat", "lon", "address"? | "state", "message"} */
  phonePlaceFind(text: string): Promise<string> {
    if (!this.allowed('phonePlaceFind') || !this.phone) {
      return refused();
    }
    return this.phone.geocoder.find(typeof text === 'string' ? text : '');
  }

  /** App 自己放掉录音器（切到后台、页面重新加载、换地址），并告诉网页；不经网页调用，不过 allowed() */
  releaseVoice(reason: string): void {
    this.voice.releaseByApp(reason);
  }

  /** 这次调用是不是来自配好的来源的主框架；是的话记下网页调过来了 */
  private allowed(method: string): boolean {
    const page = safeUrl(this.currentUrl);
    const caller = safeUrl(this.callingFrameUrl);
    if (pageFromServer(this.server, this.currentUrl) && originOf(caller) === this.server.origin &&
      withoutHash(caller) === withoutHash(page)) {
      if (!this.contacted) {
        this.contacted = true;
        this.onContact();
      }
      return true;
    }
    hilog.warn(DOMAIN, TAG, 'bridge %{public}s refused: page %{public}s, calling frame %{public}s, expected origin %{public}s',
      method, originOf(page), originOf(caller), this.server.origin);
    return false;
  }
}
