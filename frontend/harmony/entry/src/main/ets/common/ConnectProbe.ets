import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from './AppSettings';
import { classifyConnectError, ConnectFailure, isErgoAccess } from './ConnectCheck';

/** 约 10 秒（票里定的，错误文案里也写着 10 秒） */
const TIMEOUT_MS = 10000;
/** 协议包 http.ts 的 HTTP_PATHS.access */
const ACCESS_PATH = '/api/access';

/** 测的结果：failure 是 undefined 就是连上了、对面是二狗；detail 是给人看的原话（只有 other 用得上） */
export class ConnectResult {
  failure: ConnectFailure | undefined;
  detail: string;

  constructor(failure: ConnectFailure | undefined, detail: string = '') {
    this.failure = failure;
    this.detail = detail;
  }
}

/**
 * 真的请求一次（364 号票，对应安卓 common/ConnectProbe.kt）：GET <来源>/api/access，约 10 秒没回就算超时，确认回话的是二狗。
 * 不带 cookie（@ohos.net.http 不碰 ArkWeb 的 cookie），不跟跳转（跳到别处的不算二狗）。取消后不再回。
 */
export class ConnectProbe {
  private request: http.HttpRequest | undefined = undefined;
  private timer: number = -1;
  private finished: boolean = false;
  private onDone: (result: ConnectResult) => void;

  constructor(onDone: (result: ConnectResult) => void) {
    this.onDone = onDone;
  }

  start(origin: string): void {
    const request = http.createHttp();
    this.request = request;
    // connectTimeout 和 readTimeout 分开算，一共可能到 20 秒；整个过程到点就断开
    this.timer = setTimeout(() => this.finish(new ConnectResult('timeout')), TIMEOUT_MS);
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.GET,
      header: { 'Accept': 'application/json' },
      expectDataType: http.HttpDataType.STRING,
      usingCache: false,
      connectTimeout: TIMEOUT_MS,
      readTimeout: TIMEOUT_MS,
      maxRedirects: 0,
    };
    request.request(`${origin}${ACCESS_PATH}`, options).then((response: http.HttpResponse) => {
      const body = typeof response.result === 'string' ? response.result : '';
      this.finish(new ConnectResult(isErgoAccess(response.responseCode, body) ? undefined : 'notErgo'));
    }).catch((err: BusinessError) => {
      // 只记错误码，不记地址
      hilog.info(DOMAIN, TAG, 'connect probe failed: %{public}d', err.code);
      this.finish(new ConnectResult(classifyConnectError(err.code), String(err.code)));
    });
  }

  cancel(): void {
    this.finished = true;
    this.release();
  }

  private finish(result: ConnectResult): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.release();
    this.onDone(result);
  }

  private release(): void {
    clearTimeout(this.timer);
    try {
      this.request?.destroy();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'connect probe release failed: %{public}s', JSON.stringify(e));
    }
    this.request = undefined;
  }
}
