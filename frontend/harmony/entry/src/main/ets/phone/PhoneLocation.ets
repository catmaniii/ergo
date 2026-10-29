import { common, Permissions, wantAgent, WantAgent } from '@kit.AbilityKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { geoLocationManager } from '@kit.LocationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppSettings, DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { closeQuietly, deviceName, errorText, permissionGranted, requestPermissions } from './PhoneCommon';
import { GeoSpot, PhoneAddress, PhoneGeocoder, PlaceFixResult } from './PhoneGeocode';

/**
 * 读本机：位置（300 号票）。App 自己定时记位置，二狗的网页经原生桥（NativeBridge.ets 的 phoneLocation* 五个方法）取走记下的点、
 * 交给用户自己的守护进程（POST /api/data-sources/phone-location/push），交好了再让 App 删掉交过的。网页一侧的包装在 packages/web/src/app/native-phone.ts。
 * - 授权：APPROXIMATELY_LOCATION（大概位置）和 LOCATION（精确位置）一起要（鸿蒙要求精确位置和大概位置同时申请；用户可以只给大概的）；
 * - 怎么记（频率和省电的取舍，照鸿蒙官方的说法）：
 *   - App 在前台：持续定位 locationChange，场景是低功耗（PowerConsumptionScenario.LOW_POWER_CONSUMPTION：靠 Wi-Fi、基站，不开 GPS），
 *     每 5 分钟一个点；开始记的那一下另外定一次位（getCurrentLocation，等最多 10 秒），马上有一个点；
 *   - App 在后台：鸿蒙在应用退到后台、没有规范内的后台任务时几秒内把进程挂起，定位回调不再来，所以默认只在 App 开着时记、退到后台就停订；
 *     用户打开"后台也记"时申请位置类的长时任务（backgroundTaskManager.startBackgroundRunning，BackgroundMode.LOCATION：
 *     module.json5 声明 backgroundModes location 和 KEEP_BACKGROUND_RUNNING，通知栏一直显示），在后台每 10 分钟一个点；
 *     另一条路是用户在系统设置里给"始终允许"（LOCATION_IN_BACKGROUND），没用它；
 *   - 定位精度差于 5 公里的点不记；位置只能从开始记的那一刻起有，没有以前的；
 *   - 系统的位置开关关着时订不上（3301100），状态里报 switchOff（网页写明、交给守护进程一句原因）；开关打开时（locationEnabledChange）重新订；
 *   - 长时任务的通知是系统给的（"正在运行定位任务，删除通知后任务将停止"）：用户划掉通知、系统停了长时任务时（continuousTaskCancel）
 *     当作关掉了"后台也记"，回到只在 App 开着时记（网页那一行、守护进程那边的"后台也记"跟着变）；
 * - 记下的点存在 App 自己的文件里（filesDir/phone-locations.csv，一行一个点：毫秒,纬度,经度,精度），只留最近 7 天、最多交 3000 个；
 *   停下时一起删掉。在不在记、后台也记没有存在 AppSettings 里，App 重新打开时接着记。
 * - 308 号票：交给网页之前把点转成地名（PhoneGeocode.ets：200 米内转过的不再转，一次最多转 20 处，转不了的只交坐标、25 分钟里不再试），
 *   状态里报系统能不能转地名（geocoder）；"常去的地方"手动加一处用的"现在在哪"（here：定一次位、转地名）。
 */

const APPROX: Permissions = 'ohos.permission.APPROXIMATELY_LOCATION';
const PRECISE: Permissions = 'ohos.permission.LOCATION';
const BUFFER_FILE = 'phone-locations.csv';
/** 一次最多交几个点（和守护进程那边 PHONE_LOCATION_POINTS_MAX 一样） */
const POINTS_MAX = 3000;
/** 手机上没交出去的点最多留几天（和 PHONE_LOCATION_BUFFER_DAYS 一样） */
const BUFFER_DAYS = 7;
/** 前台、后台多久一个点（秒，和 PHONE_LOCATION_INTERVAL_S、PHONE_LOCATION_BACKGROUND_INTERVAL_S 一样） */
const FOREGROUND_INTERVAL_S = 300;
const BACKGROUND_INTERVAL_S = 600;
/** 精度差于这个（米）的点不记 */
const ACCURACY_MAX = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

class LocationStateResult {
  granted: boolean = false;
  precise: boolean = false;
  asked: boolean = false;
  recording: boolean = false;
  background: boolean = false;
  /** 系统的位置开关关着（记不到） */
  switchOff: boolean = false;
  /** 现在转得了地名没有（308 号票：系统说能转、又不在没转成以后的 25 分钟暂停里） */
  geocoder: boolean = false;
  device?: string;
}

/** 系统的位置开关开着没有（查不了当开着） */
function locationEnabled(): boolean {
  try {
    return geoLocationManager.isLocationEnabled();
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'check location switch failed: %{public}s', JSON.stringify(e));
    return true;
  }
}

class LocationPoint {
  at: number = 0;
  lat: number = 0;
  lon: number = 0;
  accuracy?: number;
  /** 系统地名（308 号票，交给网页时转，转得了才有；文件里不存） */
  address?: PhoneAddress;
}

class LocationReadResult {
  ok: boolean = false;
  state?: string;
  message?: string;
  points?: LocationPoint[];
}

export class PhoneLocation {
  private context: common.UIAbilityContext;
  private settings: AppSettings;
  private geocoder: PhoneGeocoder;
  /** App 在不在前台（Index.ets 的 onPageShow / onPageHide） */
  private foreground: boolean = true;
  /** 现在订着的间隔（秒）；0 是没订 */
  private interval: number = 0;
  /** 长时任务开着没有 */
  private backgroundRunning: boolean = false;
  /** 上一个记下的点的时间（同一个点不记两次） */
  private lastAt: number = 0;
  private onLocation: (location: geoLocationManager.Location) => void;

  constructor(context: common.UIAbilityContext, settings: AppSettings, geocoder: PhoneGeocoder) {
    this.context = context;
    this.settings = settings;
    this.geocoder = geocoder;
    this.onLocation = (location: geoLocationManager.Location) => this.append(location);
    // 位置开关打开了：之前订不上的重新订（关着时订的会失败，interval 留 0）
    try {
      geoLocationManager.on('locationEnabledChange', (enabled: boolean) => {
        hilog.info(DOMAIN, TAG, 'location switch %{public}s', enabled ? 'on' : 'off');
        if (enabled) {
          this.apply();
        }
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'watch location switch failed: %{public}s', JSON.stringify(e));
    }
    // 后台记的长时任务被停了（划掉了通知、系统停了）：回到只在 App 开着时记
    try {
      backgroundTaskManager.on('continuousTaskCancel', (info: backgroundTaskManager.ContinuousTaskCancelInfo) => {
        hilog.info(DOMAIN, TAG, 'location continuous task cancelled (reason %{public}d)', info.reason);
        this.backgroundRunning = false;
        if (this.settings.locationRecording()) {
          this.settings.setLocationRecording(true, false);
        }
        this.apply();
      });
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'watch continuous task cancel failed: %{public}s', JSON.stringify(e));
    }
  }

  /** App 到前台、退到后台：按在不在记、后台也记没有重新订（到前台时也是 App 重新打开后接着记的那一下） */
  setForeground(flag: boolean): void {
    this.foreground = flag;
    this.apply();
  }

  /** {"granted", "precise", "asked", "recording", "background", "device"} */
  state(): string {
    return JSON.stringify(this.current());
  }

  /** 要定位的授权（系统的授权框）；userAction 为真而拒过时拉起二次授权；回之后的状态 */
  async prepare(userAction: boolean): Promise<string> {
    if (!permissionGranted(APPROX)) {
      await requestPermissions(this.context, [APPROX, PRECISE], userAction);
      this.settings.setLocationAsked();
    }
    hilog.info(DOMAIN, TAG, 'location permission: %{public}s (precise %{public}s)', String(permissionGranted(APPROX)), String(permissionGranted(PRECISE)));
    return JSON.stringify(this.current());
  }

  /** 开始 / 停下记（停下时手机上没交出去的点一起删）；开始时马上定一次位；回之后的状态 */
  async record(on: boolean, background: boolean): Promise<string> {
    if (!on) {
      this.settings.setLocationRecording(false, false);
      this.apply();
      this.writePoints([]);
      hilog.info(DOMAIN, TAG, 'location recording stopped');
      return JSON.stringify(this.current());
    }
    if (!permissionGranted(APPROX)) {
      return JSON.stringify(this.current());
    }
    this.settings.setLocationRecording(true, background);
    this.apply();
    await this.locateOnce();
    hilog.info(DOMAIN, TAG, 'location recording on (background %{public}s)', String(background));
    return JSON.stringify(this.current());
  }

  /**
   * 手机上记下、还没交出去的点（按时间先后，最多 3000 个，308 号票起带系统地名）：{"ok": true, "points": [...]}；
   * 没授权 {"ok": false, "state": "denied"}
   */
  async read(): Promise<string> {
    const result = new LocationReadResult();
    if (!permissionGranted(APPROX)) {
      result.state = 'denied';
      return JSON.stringify(result);
    }
    let points: LocationPoint[] = [];
    try {
      points = this.readPoints().slice(0, POINTS_MAX);
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(DOMAIN, TAG, 'read location buffer failed: %{public}s', JSON.stringify(e));
      result.state = 'unavailable';
      result.message = t('harmony.phone.locationFailed', { 'error': errorText(err) });
      return JSON.stringify(result);
    }
    // 转成地名（308 号票）：转不了的只交坐标
    const spots = points.map((p: LocationPoint) => {
      const spot = new GeoSpot();
      spot.lat = p.lat;
      spot.lon = p.lon;
      return spot;
    });
    const names = await this.geocoder.addressesOf(spots);
    for (let i = 0; i < points.length; i++) {
      const name = names[i];
      if (name !== undefined) {
        points[i].address = name;
      }
    }
    result.points = points;
    result.ok = true;
    return JSON.stringify(result);
  }

  /**
   * 现在在哪（308 号票，"常去的地方"手动加一处）：定一次位（等最多 10 秒）、转成地名：{"ok": true, "lat", "lon", "address"?}；
   * 没定位授权 {"ok": false, "state": "denied"}；定不了 {"ok": false, "state": "unavailable", "message"}
   */
  async here(): Promise<string> {
    const result = new PlaceFixResult();
    if (!permissionGranted(APPROX)) {
      result.state = 'denied';
      return JSON.stringify(result);
    }
    try {
      const request: geoLocationManager.SingleLocationRequest = {
        locatingPriority: geoLocationManager.LocatingPriority.PRIORITY_LOCATING_SPEED,
        locatingTimeoutMs: 10000
      };
      const location = await geoLocationManager.getCurrentLocation(request);
      result.ok = true;
      result.lat = location.latitude;
      result.lon = location.longitude;
      const address = await this.geocoder.addressAt(location.latitude, location.longitude);
      if (address !== undefined) {
        result.address = address;
      }
      hilog.info(DOMAIN, TAG, 'place here: located (named %{public}s)', String(address !== undefined));
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'place here failed: %{public}s', JSON.stringify(e));
      result.state = 'unavailable';
      result.message = t('harmony.phone.hereFailed', { 'error': errorText(err) });
    }
    return JSON.stringify(result);
  }

  /** 交给守护进程了：删掉 until（毫秒）以前（含）的点 */
  ack(untilMs: string): string {
    const until = Number(untilMs);
    if (!Number.isFinite(until)) {
      return '';
    }
    return this.writePoints(this.readPoints().filter((p: LocationPoint) => p.at > until)) ? 'ok' : '';
  }

  /** 按现在该怎么记订好：在记、有授权时前台每 5 分钟、后台（打开了后台也记）每 10 分钟，否则停订；长时任务跟着后台也记开关 */
  private apply(): void {
    const recording = this.settings.locationRecording() && permissionGranted(APPROX);
    const background = recording && this.settings.locationBackground();
    const want = !recording ? 0 : this.foreground ? FOREGROUND_INTERVAL_S : background ? BACKGROUND_INTERVAL_S : 0;
    if (want !== this.interval) {
      this.unsubscribe();
      if (want > 0) {
        this.subscribe(want);
      }
    }
    if (background && !this.backgroundRunning) {
      this.startBackground();
    } else if (!background && this.backgroundRunning) {
      this.stopBackground();
    }
  }

  private subscribe(intervalS: number): void {
    try {
      const request: geoLocationManager.ContinuousLocationRequest = {
        interval: intervalS,
        locationScenario: geoLocationManager.PowerConsumptionScenario.LOW_POWER_CONSUMPTION
      };
      geoLocationManager.on('locationChange', request, this.onLocation);
      this.interval = intervalS;
      hilog.info(DOMAIN, TAG, 'location subscribed every %{public}d s', intervalS);
    } catch (e) {
      // 3301100：系统的位置开关关着；201：没授权
      hilog.error(DOMAIN, TAG, 'subscribe location failed: %{public}s', JSON.stringify(e));
      this.interval = 0;
    }
  }

  private unsubscribe(): void {
    if (this.interval === 0) {
      return;
    }
    try {
      geoLocationManager.off('locationChange', this.onLocation);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'unsubscribe location failed: %{public}s', JSON.stringify(e));
    }
    this.interval = 0;
  }

  /** 位置类的长时任务（通知栏一直显示，点了回到 App） */
  private startBackground(): void {
    this.backgroundRunning = true;
    const info: wantAgent.WantAgentInfo = {
      wants: [{ bundleName: this.context.abilityInfo.bundleName, abilityName: this.context.abilityInfo.name }],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 300,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    };
    wantAgent.getWantAgent(info)
      .then((agent: WantAgent) => backgroundTaskManager.startBackgroundRunning(this.context, backgroundTaskManager.BackgroundMode.LOCATION, agent))
      .then(() => {
        hilog.info(DOMAIN, TAG, 'location continuous task started');
      })
      .catch((err: BusinessError) => {
        this.backgroundRunning = false;
        hilog.error(DOMAIN, TAG, 'start location continuous task failed: %{public}s', JSON.stringify(err));
      });
  }

  private stopBackground(): void {
    this.backgroundRunning = false;
    backgroundTaskManager.stopBackgroundRunning(this.context)
      .then(() => {
        hilog.info(DOMAIN, TAG, 'location continuous task stopped');
      })
      .catch((err: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'stop location continuous task failed: %{public}s', JSON.stringify(err));
      });
  }

  /** 马上定一次位（开始记的那一下），记下来；定不到不要紧 */
  private async locateOnce(): Promise<void> {
    try {
      const request: geoLocationManager.SingleLocationRequest = {
        locatingPriority: geoLocationManager.LocatingPriority.PRIORITY_LOCATING_SPEED,
        locatingTimeoutMs: 10000
      };
      const location = await geoLocationManager.getCurrentLocation(request);
      this.append(location);
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'locate once failed: %{public}s', JSON.stringify(e));
    }
  }

  private path(): string {
    return `${this.context.filesDir}/${BUFFER_FILE}`;
  }

  /** 记下一个点（精度太差的、和上一个同一时刻的不记） */
  private append(location: geoLocationManager.Location): void {
    if (!(location.accuracy <= ACCURACY_MAX)) {
      return;
    }
    const at = location.timeStamp > 0 ? Math.round(location.timeStamp) : Date.now();
    if (at === this.lastAt) {
      return;
    }
    this.lastAt = at;
    const line = `${at},${location.latitude.toFixed(6)},${location.longitude.toFixed(6)},${Math.round(location.accuracy)}\n`;
    let file: fs.File | undefined = undefined;
    try {
      file = fs.openSync(this.path(), fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.APPEND);
      fs.writeSync(file.fd, line);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'append location failed: %{public}s', JSON.stringify(e));
    } finally {
      closeQuietly(file);
    }
  }

  /** 文件里的点（最近 7 天的，按时间先后）；读不了当没有 */
  private readPoints(): LocationPoint[] {
    let text = '';
    try {
      const path = this.path();
      text = fs.accessSync(path) ? fs.readTextSync(path) : '';
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'read location buffer failed: %{public}s', JSON.stringify(e));
    }
    const cutoff = Date.now() - BUFFER_DAYS * DAY_MS;
    const points: LocationPoint[] = [];
    for (const line of text.split('\n')) {
      const fields = line.split(',');
      if (fields.length < 3) {
        continue;
      }
      const point = new LocationPoint();
      point.at = Number(fields[0]);
      point.lat = Number(fields[1]);
      point.lon = Number(fields[2]);
      if (!Number.isFinite(point.at) || point.at < cutoff || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
        continue;
      }
      const accuracy = fields.length > 3 && fields[3] !== '' ? Number(fields[3]) : NaN;
      if (Number.isFinite(accuracy)) {
        point.accuracy = accuracy;
      }
      points.push(point);
    }
    points.sort((a: LocationPoint, b: LocationPoint) => a.at - b.at);
    return points;
  }

  /** 整个文件换成这些点（没有点就删掉文件）；写不了记日志、回 false */
  private writePoints(points: LocationPoint[]): boolean {
    const path = this.path();
    let file: fs.File | undefined = undefined;
    try {
      if (points.length === 0) {
        if (fs.accessSync(path)) {
          fs.unlinkSync(path);
        }
        return true;
      }
      const text = points.map((p: LocationPoint) => `${p.at},${p.lat},${p.lon},${p.accuracy ?? ''}`).join('\n') + '\n';
      file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text);
      return true;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'write location buffer failed: %{public}s', JSON.stringify(e));
      return false;
    } finally {
      closeQuietly(file);
    }
  }

  private current(): LocationStateResult {
    const state = new LocationStateResult();
    state.granted = permissionGranted(APPROX);
    state.precise = permissionGranted(PRECISE);
    state.asked = this.settings.locationAsked();
    state.recording = this.settings.locationRecording() && state.granted;
    state.background = this.settings.locationBackground();
    state.switchOff = !locationEnabled();
    state.geocoder = this.geocoder.usable();
    const device = deviceName();
    if (device !== '') {
      state.device = device;
    }
    return state;
  }
}
