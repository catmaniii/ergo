import { webview } from '@kit.ArkWeb';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { call } from '@kit.TelephonyKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import BuildProfile from 'BuildProfile';
import { AppSettings, DOMAIN, TAG } from '../common/AppSettings';
import { checkServerAddress, originOf, ServerAddress } from '../common/ServerAddress';
import {
  bridgePermission,
  NATIVE_BRIDGE_ASYNC_METHODS,
  NATIVE_BRIDGE_METHODS,
  NATIVE_BRIDGE_NAME,
  NativeBridge
} from '../bridge/NativeBridge';

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
const NOT_ERGOU_AFTER_MS = 8000;

/**
 * 二狗的鸿蒙 App（62 号票）：原生壳。
 * 第一次打开先填二狗的地址（存在应用本地）；之后 ArkWeb 加载这个地址，网页照常由守护进程提供，
 * App 和手机浏览器一样是一台要配对的设备。不像 AgentSense 把网页打包进 HAP：二狗的网页要带设备凭证（__Host- cookie），
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
  @State notErgou: boolean = false;
  private notErgouTimer: number = -1;

  aboutToAppear(): void {
    // WebView 调试（PC 上的 Chrome DevTools 经 hdc 端口转发）默认关：开着的话，接上 USB 的人能用 hdc 取到设备凭证 cookie。
    // 只有构建时显式要了（npm run build:harmony -- --webview-debug）才开，见 entry/hvigorfile.ts 和 docs/dev.md
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

  // 系统返回手势（照搬 AgentSense）：在地址页上先回到网页；网页报过还能在内部返回（setCanGoBack）就交给网页
  // （window.__ergouBack：先关弹窗、详情，再回上一级），否则交给系统退出 App
  onBackPress(): boolean {
    if (this.editing) {
      if (this.hasServer) {
        this.editing = false;
        return true;
      }
      return false;
    }
    if (this.hasServer && this.loadError.length === 0 && this.bridge !== undefined && this.bridge.canGoBack) {
      this.controller.runJavaScript('window.__ergouBack && window.__ergouBack()').catch((err: Error) => {
        hilog.error(DOMAIN, TAG, 'web back failed: %{public}s', JSON.stringify(err));
      });
      return true;
    }
    return false;
  }

  aboutToDisappear(): void {
    clearTimeout(this.notErgouTimer);
  }

  private openServer(address: ServerAddress): void {
    this.server = address;
    this.controller = new webview.WebviewController();
    const controller = this.controller;
    this.bridge = new NativeBridge(this.context, this.settings, address,
      () => controller.getUrl(),
      () => controller.getLastJavascriptProxyCallingFrameUrl(),
      // 网页调过来的时候不在这次调用里拆掉 Web 组件，等调用返回
      () => {
        setTimeout(() => this.startEditing(), 0);
      },
      // 网页调过原生桥了：是二狗的网页
      () => {
        this.notErgou = false;
      });
    clearTimeout(this.notErgouTimer);
    this.notErgou = false;
    this.loadError = '';
    this.hasServer = true;
    this.session += 1;
  }

  /** 页面加载完：过一阵网页还没调过原生桥（二狗的网页一打开就会问 App 的版本号），就提示"这不是二狗？" */
  private checkIsErgou(): void {
    clearTimeout(this.notErgouTimer);
    const bridge = this.bridge;
    this.notErgouTimer = setTimeout(() => {
      if (bridge !== undefined && bridge === this.bridge && !bridge.contacted && this.loadError.length === 0) {
        hilog.warn(DOMAIN, TAG, 'page never called the bridge: not an ergou page?');
        this.notErgou = true;
      }
    }, NOT_ERGOU_AFTER_MS);
  }

  private startEditing(): void {
    this.notErgou = false;
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

  /** 网页要麦克风（getUserMedia）：只对配好的来源、只给麦克风；App 还没有麦克风权限时先向用户申请 */
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
   * 别的网站交给系统浏览器；地址本身跳到别的来源时提示去改地址。App 里只显示配好的那个来源
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
      this.loadError = `二狗的地址跳到了别的地址（${target}）。请把地址改成跳过去的那个。`;
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
      // 网页的 prefers-color-scheme 跟着系统（外观选"跟随系统"时用）；不强制把网页反色，深色由网页自己画（照 AgentSense）
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
      .onLoadIntercept((event: OnLoadInterceptEvent) => this.interceptLoad(event.data))
      .onPageEnd(() => this.checkIsErgou())
      .onErrorReceive((event: OnErrorReceiveEvent) => {
        if (event.request.isMainFrame() && !IGNORED_NET_ERRORS.includes(event.error.getErrorCode())) {
          this.loadError = `连不上（${event.error.getErrorInfo()}）`;
        }
      })
      .onHttpErrorReceive((event: OnHttpErrorReceiveEvent) => {
        if (event.request.isMainFrame() && event.response.getResponseCode() >= 400) {
          this.loadError = `服务器回了 ${event.response.getResponseCode()}`;
        }
      })
      .width('100%')
      .height('100%')
  }

  /** 地址填成了能打开、但不是二狗的网站时，原生层唯一的出口 */
  @Builder
  NotErgouBar() {
    Row({ space: 12 }) {
      Text('这不是二狗？')
        .fontSize(15)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
        .layoutWeight(1)
      Button('换地址')
        .onClick(() => this.startEditing())
      Button('关闭', { buttonStyle: ButtonStyleMode.NORMAL })
        .onClick(() => {
          this.notErgou = false;
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .shadow({ radius: 12, color: '#33000000' })
  }

  @Builder
  ErrorPage() {
    Column({ space: 16 }) {
      Text('打不开二狗')
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
        Button('重试')
          .onClick(() => this.retry())
        Button('改地址', { buttonStyle: ButtonStyleMode.NORMAL })
          .onClick(() => this.startEditing())
      }
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .justifyContent(FlexAlign.Center)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }

  @Builder
  AddressPage() {
    Column({ space: 14 }) {
      Text('二狗')
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      Text('填二狗的地址')
        .fontSize(17)
        .fontColor($r('sys.color.ohos_id_color_text_primary'))
      Text('比如公网地址或 tailnet 地址。必须是 https；本机调试可以用 http://127.0.0.1 或 http://localhost。地址只存在这台手机上。')
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
          Button('取消', { buttonStyle: ButtonStyleMode.NORMAL })
            .onClick(() => {
              this.editing = false;
            })
        }
        Button('连接')
          .onClick(() => this.saveDraft())
      }
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .alignItems(HorizontalAlign.Start)
    .justifyContent(FlexAlign.Center)
    .backgroundColor($r('sys.color.ohos_id_color_background'))
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
      if (this.hasServer && this.loadError.length > 0 && !this.editing) {
        this.ErrorPage()
      }
      if (this.hasServer && this.notErgou && this.loadError.length === 0 && !this.editing) {
        this.NotErgouBar()
      }
      if (this.editing) {
        this.AddressPage()
      }
    }
    .width('100%')
    .height('100%')
  }
}
