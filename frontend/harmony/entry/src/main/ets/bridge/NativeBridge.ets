import { bundleManager, common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppSettings, colorModeOf, DOMAIN, TAG } from '../common/AppSettings';
import { originOf, ServerAddress } from '../common/ServerAddress';
import { NativeNotify, notifyTaps } from '../notify/NativeNotify';
import { NativeVoice } from '../voice/NativeVoice';

/** 网页里看到的名字：window.ergouNative（packages/web/src/app/native-app.ts 按这个名字检测） */
export const NATIVE_BRIDGE_NAME = 'ergouNative';

/**
 * 网页能调的同步方法（62 号票：版本号、日志、设置地址、外观，加上照搬 AgentSense 返回键的 setCanGoBack）。
 * 63 号票的原生录音（备好、开始、停止交出音频、丢弃、释放）也在这里：要等结果的（voicePrepare、voiceStart、voiceStop）
 * 是同步方法、回 Promise<string>，网页那边拿到的是 Promise（官方文档"应用侧 new Promise 作为返回值传给前端"）；
 * 不放进 asyncMethodList——那里的方法拿不到返回值。原生往网页推的实时音量、错误用 controller.runJavaScript 调网页登记的
 * window.__ergouVoice。每个新方法开头都要先过 allowed()。名字和网页一侧 packages/web/src/app/native-voice.ts 的 NATIVE_VOICE_METHODS 一致。
 * 105 号票的 safeArea：Web 组件延伸到了底部手势条底下，告诉网页那一截多高（网页一侧 packages/web/src/app/native-app.ts）
 * 110 号票的系统通知（开没开、要授权、发一条、取用户点开的那一条）：名字和网页一侧 packages/web/src/app/native-notify.ts 的
 * NATIVE_NOTIFY_METHODS 一致；notifyPrepare 要等系统的授权框，和录音一样回 Promise<string>
 */
export const NATIVE_BRIDGE_METHODS: string[] = ['appVersion', 'log', 'editServer', 'setColorMode', 'setCanGoBack',
  'voicePrepare', 'voiceStart', 'voiceStop', 'voiceDiscard', 'voiceRelease', 'safeArea',
  'notifyState', 'notifyPrepare', 'notifyShow', 'notifyTakeOpen'];

/** asyncMethodList（ArkWeb 异步调用、拿不到返回值）：现在没有 */
export const NATIVE_BRIDGE_ASYNC_METHODS: string[] = [];

/**
 * 底部避让区（105 号票）：Web 组件延伸到了手势条（三键导航条）底下的那一截有多高，物理像素。
 * safeArea() 回它的 JSON；变了（量到了、转屏）Index.ets 经 window.__ergouInsets(json) 推给网页
 */
export interface SafeAreaMessage {
  bottom: number;
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
 * 原生桥（62 号票）：javaScriptProxy 以 `ergouNative` 名注入 ArkWeb。
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
  /** 网页当前还能不能在内部返回上一级（照搬 AgentSense：网页经 setCanGoBack 报，原生按返回键时据此决定交给网页还是退出） */
  canGoBack: boolean = false;
  /** 网页调过原生桥没有：加载完一阵还没调过，就不是二狗的网页（Index.ets 提示"这不是二狗？换地址"） */
  contacted: boolean = false;
  /** 原生录音（63 号票），一个原生桥（一个 Web 组件、一个来源）一份 */
  private voice: NativeVoice;
  /** 系统通知（110 号票），整个页面一份（Index.ets 建，记着 App 在不在前台），换地址不重建 */
  private notify: NativeNotify;

  constructor(context: common.Context, settings: AppSettings, server: ServerAddress, voice: NativeVoice,
    notify: NativeNotify, currentUrl: () => string, callingFrameUrl: () => string, onEditServer: () => void,
    onContact: () => void, bottomInset: () => number) {
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
  }

  /** App 的版本号；网页据此在设置里显示"在鸿蒙 App 里运行" */
  appVersion(): string {
    if (!this.allowed('appVersion')) {
      return '';
    }
    return this.version;
  }

  /** 网页的日志写进 hilog（hdc hilog 里按 ErgouApp 过滤） */
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

  /** 外观：system 跟随系统，light / dark 固定；记下来，下次开场先按它定深浅色（照 AgentSense 的 setColorMode） */
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

  /** 返回键（照搬 AgentSense）：网页报现在还能不能在内部返回；能的话原生按返回键时调网页登记的 window.__ergouBack() */
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

  /** 系统通知（110 号票）：{"enabled", "asked"}，系统设置里这个应用的通知开没开、向用户要过授权没有 */
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

  /** 系统通知：发一条到通知栏（App 在前台时不发，页面顶上已经有了）；route 是点了之后网页要去的页面地址（#/…） */
  notifyShow(id: string, title: string, body: string, route: string): void {
    if (!this.allowed('notifyShow')) {
      return;
    }
    this.notify.show(id, title, body, route);
  }

  /** 系统通知：用户点开的那一条 {"id", "route"}，取一次就清掉；没有回空串 */
  notifyTakeOpen(): string {
    if (!this.allowed('notifyTakeOpen')) {
      return '';
    }
    return notifyTaps.take();
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
