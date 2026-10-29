import { common, Want, wantAgent, WantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { notificationManager } from '@kit.NotificationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppSettings, DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { oldNameOf } from '../common/OldNames';

/** 点开通知栏里的一条拉起 App 时 want 里带的：通知的 id、点了之后网页要去的页面地址 */
const WANT_NOTICE_ID = 'ergoNoticeId';
const WANT_NOTICE_ROUTE = 'ergoNoticeRoute';
/** 标题、正文最多多少字：网页那边已经截过（packages/web/src/app/system-notify.ts），这里兜底；系统另有字节上限，超出的系统截掉 */
const TITLE_MAX = 60;
const BODY_MAX = 200;
/** 通知的 id、页面地址最长多少 */
const ID_MAX = 200;
const ROUTE_MAX = 512;
/** 系统要求标题、正文都不能为空：网页没给时用这两句（175 号票起按 App 现在的语言取） */
const EMPTY_TITLE = (): string => t('harmony.notify.emptyTitle');
const EMPTY_BODY = (): string => t('harmony.notify.emptyBody');

/** notifyState() 回的：系统设置里这个应用的通知开没开，问没问过用户；124 号票起还有 App 现在算不算在前台 */
interface NotifyStateMessage {
  enabled: boolean;
  asked: boolean;
  foreground: boolean;
}

/**
 * notifyShow() 回的这一条的结果（124 号票，Debug 工具集的通知记录用）：published 发出去了（number 是通知编号）、
 * foreground App 在前台没发、disabled 通知没打开（用户关了通知或这个渠道）、failed 出错（message 是原因）
 */
interface NotifyShownMessage {
  result: string;
  number?: number;
  message?: string;
}

/** 用户关了这个应用的通知、关了这个渠道（publish 报的错误码） */
const DISABLED_CODES: number[] = [1600004, 1600005];

/** notifyShow() 回网页的 JSON */
function shown(result: string, code?: number, message?: string): string {
  const reply: NotifyShownMessage = { result: result };
  if (code !== undefined) {
    reply.number = code;
  }
  if (message !== undefined) {
    reply.message = message;
  }
  return JSON.stringify(reply);
}

/** notifyTakeOpen() 回的：用户点开的那一条 */
interface NotifyOpenedMessage {
  id: string;
  route: string;
}

function errorText(err: BusinessError): string {
  return typeof err.code === 'number' ? t('harmony.common.errorWithCode', { 'message': `${err.message}`, 'code': String(err.code) }) : `${err.message}`;
}

/** 网页的页面地址（#/ 开头）：只认这种，别的应用拉起 App 时带来的别的东西不认 */
function isRoute(route: string): boolean {
  return route.startsWith('#/') && route.length <= ROUTE_MAX;
}

function isId(id: string): boolean {
  return id.length > 0 && id.length <= ID_MAX;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.substring(0, max - 1)}…`;
}

/** want 里的一个字符串参数；没有、不是字符串当空串 */
function stringParam(want: Want, key: string): string {
  const params = want.parameters;
  if (params === undefined) {
    return '';
  }
  // 312 号票：旧版 App 发出去的通知里参数是旧名字
  const value = params[key] ?? params[oldNameOf(key)];
  return typeof value === 'string' ? value as string : '';
}

/**
 * 通知的编号（publish 的 id、wantAgent 的 requestCode）：由网页给的 id 算出来，同一件事同一个编号——再发一次换掉通知栏里那一条，
 * 不出第二条；不同的事 wantAgent 各是各的（requestCode 一样的 wantAgent 会被当成同一个，点旧通知会去新通知的地址）
 */
function numberOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return hash & 0x7fffffff;
}

/**
 * 用户点开的那一条（110 号票）：EntryAbility 在 onCreate（App 没在跑、被点开的通知拉起来）、onNewWant（App 在跑）里
 * 从 want 取出来记下，等网页经原生桥 notifyTakeOpen() 来取（取一次就清掉）；记下时告诉 Index.ets，它调网页登记的
 * window.__ergoNotifyOpen() 让网页来取。只记最新的一条（连着点了两条，去后点的那一条）
 */
export class NotifyTaps {
  private pending: string = '';
  private listener: (() => void) | undefined = undefined;

  /** 从拉起 App 的 want 里取；不是点通知拉起来的（桌面图标）什么都不做 */
  fromWant(want: Want): void {
    const id = stringParam(want, WANT_NOTICE_ID);
    const route = stringParam(want, WANT_NOTICE_ROUTE);
    if (!isId(id) || !isRoute(route)) {
      return;
    }
    const message: NotifyOpenedMessage = { id: id, route: route };
    this.pending = JSON.stringify(message);
    hilog.info(DOMAIN, TAG, 'notification opened: %{public}s', id);
    const listener = this.listener;
    if (listener !== undefined) {
      listener();
    }
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** 网页来取：{"id", "route"}，取了就清掉；没有回空串 */
  take(): string {
    const json = this.pending;
    this.pending = '';
    return json;
  }

  /** 记下一条时叫谁（Index.ets 推给网页）；undefined 是不叫了 */
  listen(listener: (() => void) | undefined): void {
    this.listener = listener;
  }
}

/** 整个 App 一份：EntryAbility 往里记，原生桥从里面取 */
export const notifyTaps: NotifyTaps = new NotifyTaps();

/**
 * 系统通知（110 号票，用户 2026-10-13 定：先做不用实名认证的这一步）：Notification Kit 的本地通知，App 自己往通知栏发，
 * 不经华为服务器，不用在 AppGallery Connect 开通什么、不用改签名，也不用在 module.json5 里声明权限（publish 没有要求权限）。
 * App 的进程要活着（开着，或者刚切到后台、还没被系统冻结）才发得出；App 关着、被冻结后发不出，那要靠以后的推送服务（Push Kit）。
 * - 授权：第一次向用户要（notificationManager.requestEnableNotification，系统的授权框，要 App 在前台；网页开场在前台时要），
 *   记下问过了（AppSettings），用户拒了不再问（系统自己也只弹这一次）；设置里点"去打开"而拒过的，拉起系统的通知设置
 *   （openNotificationSettings，半模态）。
 * - 发：网页每条提醒都交过来（同一件事网页只交一次），App 在前台时不发（页面顶上已经有了），在后台时 publish 一条普通文本通知，
 *   渠道是"服务提醒"（SlotType.SERVICE_INFORMATION：横幅、响铃、锁屏可见）；编号由 id 算出来、appMessageId 用 id，
 *   同一件事只出一条、换掉时不再响（isAlertOnce）。
 * - 点：通知带一个 wantAgent（START_ABILITY 拉起 EntryAbility，want 里带着 id 和页面地址），点了 App 到前台
 *   （singleton 的 Ability 在跑时走 onNewWant），地址交回网页（NotifyTaps），通知随即从通知栏收掉（tapDismissed）。
 * - 124 号票（网页设置里的 Debug 工具集）：show 回这一条的结果（Promise<string>，网页记进通知记录）；第 5 个参数 force 为真时
 *   App 在前台也发（绕过上面的"前台不发"，只有 Debug 工具集用；旧版网页只给 4 个参数，照旧）；state 多带 App 现在算不算前台；
 *   resetAsked 清掉"问过了"（系统自己的授权框还是只弹一次，重置后多半只能拉起系统设置）。
 */
export class NativeNotify {
  private context: common.UIAbilityContext;
  private settings: AppSettings;
  /** App 在不在前台（Index.ets 的 onPageShow / onPageHide） */
  private foreground: boolean = true;

  constructor(context: common.UIAbilityContext, settings: AppSettings) {
    this.context = context;
    this.settings = settings;
  }

  setForeground(flag: boolean): void {
    this.foreground = flag;
  }

  /** {"enabled", "asked", "foreground"} */
  state(): string {
    const message: NotifyStateMessage = { enabled: this.enabled(), asked: this.settings.notifyAsked(), foreground: this.foreground };
    return JSON.stringify(message);
  }

  /** 清掉"问过用户了"（124 号票：Debug 工具集的重置首次提示），回之后的 state() */
  resetAsked(): string {
    this.settings.clearNotifyAsked();
    hilog.info(DOMAIN, TAG, 'notification asked mark cleared');
    return this.state();
  }

  /**
   * 开着就什么都不做；没问过就向用户要（只此一次）；问过了、用户拒了：userAction 为真（设置里点"去打开"）时拉起系统的通知设置。
   * 都回做完之后的 state()
   */
  prepare(userAction: boolean): Promise<string> {
    if (this.enabled()) {
      return Promise.resolve(this.state());
    }
    try {
      if (!this.settings.notifyAsked()) {
        // 先记下问过了：用户拒了不再问
        this.settings.setNotifyAsked();
        return notificationManager.requestEnableNotification(this.context)
          .then(() => {
            hilog.info(DOMAIN, TAG, 'notification enabled by user');
          })
          .catch((err: BusinessError) => {
            // 用户拒了是 1600004
            hilog.warn(DOMAIN, TAG, 'notification not enabled: %{public}s', errorText(err));
          })
          .then(() => this.state());
      }
      if (!userAction) {
        return Promise.resolve(this.state());
      }
      return notificationManager.openNotificationSettings(this.context)
        .catch((err: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'open notification settings failed: %{public}s', errorText(err));
        })
        .then(() => this.state());
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'prepare notification failed: %{public}s', JSON.stringify(e));
      return Promise.resolve(this.state());
    }
  }

  /**
   * 发一条：标题、正文，点了之后网页要去的页面地址；App 在前台时不发，force 为真（Debug 工具集）时照发。
   * 回这一条的结果（NotifyShownMessage 的 JSON）
   */
  show(id: string, title: string, body: string, route: string, force?: boolean): Promise<string> {
    if (typeof id !== 'string' || typeof title !== 'string' || typeof body !== 'string' || typeof route !== 'string' ||
      !isId(id) || !isRoute(route)) {
      hilog.warn(DOMAIN, TAG, 'notification refused: bad arguments');
      return Promise.resolve(shown('failed', undefined, 'bad arguments'));
    }
    const forced = force === true;
    if (this.foreground && !forced) {
      hilog.info(DOMAIN, TAG, 'notification %{public}s not published: app in foreground', id);
      return Promise.resolve(shown('foreground'));
    }
    if (forced) {
      hilog.info(DOMAIN, TAG, 'notification %{public}s forced (foreground %{public}s)', id, String(this.foreground));
    }
    const code = numberOf(id);
    const params: Record<string, Object> = {};
    params[WANT_NOTICE_ID] = id;
    params[WANT_NOTICE_ROUTE] = route;
    const want: Want = {
      bundleName: this.context.abilityInfo.bundleName,
      abilityName: this.context.abilityInfo.name,
      parameters: params
    };
    const info: wantAgent.WantAgentInfo = {
      wants: [want],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: code,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    };
    const shortTitle = clip(title, TITLE_MAX);
    const shortBody = clip(body, BODY_MAX);
    try {
      return wantAgent.getWantAgent(info)
        .then((agent: WantAgent) => {
          const request: notificationManager.NotificationRequest = {
            id: code,
            appMessageId: id,
            notificationSlotType: notificationManager.SlotType.SERVICE_INFORMATION,
            content: {
              notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
              normal: {
                title: shortTitle.length > 0 ? shortTitle : EMPTY_TITLE(),
                text: shortBody.length > 0 ? shortBody : EMPTY_BODY()
              }
            },
            wantAgent: agent,
            tapDismissed: true,
            isAlertOnce: true
          };
          return notificationManager.publish(request);
        })
        .then(() => {
          hilog.info(DOMAIN, TAG, 'notification %{public}s published as %{public}d', id, code);
          return shown('published', code);
        })
        .catch((err: BusinessError) => {
          // 用户关了通知是 1600004，关了这个渠道是 1600005
          hilog.error(DOMAIN, TAG, 'publish notification %{public}s failed: %{public}s', id, errorText(err));
          return shown(DISABLED_CODES.includes(err.code) ? 'disabled' : 'failed', undefined, errorText(err));
        });
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'publish notification %{public}s failed: %{public}s', id, JSON.stringify(e));
      return Promise.resolve(shown('failed', undefined, JSON.stringify(e)));
    }
  }

  /** 系统设置里这个应用的通知开没开；查不了当没开 */
  private enabled(): boolean {
    try {
      return notificationManager.isNotificationEnabledSync();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'read notification enabled failed: %{public}s', JSON.stringify(e));
      return false;
    }
  }
}
