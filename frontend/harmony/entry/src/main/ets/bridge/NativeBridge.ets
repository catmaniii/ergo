import { bundleManager, common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppSettings, colorModeOf, DOMAIN, TAG } from '../common/AppSettings';
import { originOf, ServerAddress } from '../common/ServerAddress';

/** 网页里看到的名字：window.ergouNative（packages/web/src/app/native-app.ts 按这个名字检测） */
export const NATIVE_BRIDGE_NAME = 'ergouNative';

/**
 * 网页能调的同步方法（62 号票：版本号、日志、设置地址、外观，加上照搬 AgentSense 返回键的 setCanGoBack）。
 * 63 号票的原生录音（备好、开始、停止交出音频、丢弃、释放）也挂在这个对象上：
 * 立即返回的加进这里，要等结果的加进 NATIVE_BRIDGE_ASYNC_METHODS；原生往网页推的实时音量、错误
 * 用 controller.runJavaScript 调网页登记的回调。每个新方法开头都要先过 allowed()。
 */
export const NATIVE_BRIDGE_METHODS: string[] = ['appVersion', 'log', 'editServer', 'setColorMode', 'setCanGoBack'];

/** 异步方法（网页那边拿到的是 Promise）；62 号票还没有 */
export const NATIVE_BRIDGE_ASYNC_METHODS: string[] = [];

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
  /** 网页当前还能不能在内部返回上一级（照搬 AgentSense：网页经 setCanGoBack 报，原生按返回键时据此决定交给网页还是退出） */
  canGoBack: boolean = false;
  /** 网页调过原生桥没有：加载完一阵还没调过，就不是二狗的网页（Index.ets 提示"这不是二狗？换地址"） */
  contacted: boolean = false;

  constructor(context: common.Context, settings: AppSettings, server: ServerAddress,
    currentUrl: () => string, callingFrameUrl: () => string, onEditServer: () => void, onContact: () => void) {
    this.app = context.getApplicationContext();
    this.settings = settings;
    this.server = server;
    this.version = appVersionName();
    this.currentUrl = currentUrl;
    this.callingFrameUrl = callingFrameUrl;
    this.onEditServer = onEditServer;
    this.onContact = onContact;
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

  /** 这次调用是不是来自配好的来源的主框架；是的话记下网页调过来了 */
  private allowed(method: string): boolean {
    const page = safeUrl(this.currentUrl);
    const caller = safeUrl(this.callingFrameUrl);
    if (originOf(page) === this.server.origin && originOf(caller) === this.server.origin &&
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
