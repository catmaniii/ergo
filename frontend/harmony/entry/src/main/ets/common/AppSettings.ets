import { preferences } from '@kit.ArkData';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PREFS_NAME } from './OldNames';

export const DOMAIN = 0x0E60;
export const TAG = 'ErgoApp';

/** 用户配好的二狗地址 */
const KEY_SERVER = 'server_url';
/** 网页设置里选的外观：system / light / dark；开场先按它定深浅色，不等网页 */
const KEY_COLOR_MODE = 'color_mode';
/** 向用户要过通知授权没有（110 号票）：要过就是 '1'，用户拒了不再问 */
const KEY_NOTIFY_ASKED = 'notify_asked';
/** 上次二狗的网页交来的 App 原生的字（用户 2026-10-19 定：记住上次的语言）：{ language, texts } 的 JSON */
const KEY_APP_TEXTS = 'app_texts';
/** 向用户要过读手机日历的授权没有（299 号票）：要过就是 '1' */
const KEY_CALENDAR_ASKED = 'calendar_asked';
/** 向用户要过读相册、定位的授权没有（300 号票）：要过就是 '1' */
const KEY_PHOTOS_ASKED = 'photos_asked';
const KEY_LOCATION_ASKED = 'location_asked';
/** 在不在记位置、后台也记没有（300 号票）：是就是 '1'；App 重新打开时照它接着记 */
const KEY_LOCATION_RECORDING = 'location_recording';
const KEY_LOCATION_BACKGROUND = 'location_background';

/** 外观（system / light / dark）对应的应用深浅色：状态栏、窗口底色跟着网页一起变 */
export function colorModeOf(mode: string): ConfigurationConstant.ColorMode {
  if (mode === 'dark') {
    return ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
  if (mode === 'light') {
    return ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  }
  return ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
}

export class AppSettings {
  private prefs: preferences.Preferences;

  constructor(context: common.Context) {
    const options: preferences.Options = { name: PREFS_NAME };
    // 读不到偏好文件属不可恢复错误，交给上层崩溃日志
    this.prefs = preferences.getPreferencesSync(context, options);
  }

  serverUrl(): string {
    return this.get(KEY_SERVER);
  }

  setServerUrl(href: string): void {
    this.put(KEY_SERVER, href);
  }

  colorMode(): string {
    return this.get(KEY_COLOR_MODE);
  }

  setColorMode(mode: string): void {
    this.put(KEY_COLOR_MODE, mode);
  }

  notifyAsked(): boolean {
    return this.get(KEY_NOTIFY_ASKED) === '1';
  }

  setNotifyAsked(): void {
    this.put(KEY_NOTIFY_ASKED, '1');
  }

  appTexts(): string {
    return this.get(KEY_APP_TEXTS);
  }

  setAppTexts(json: string): void {
    this.put(KEY_APP_TEXTS, json);
  }

  calendarAsked(): boolean {
    return this.get(KEY_CALENDAR_ASKED) === '1';
  }

  setCalendarAsked(): void {
    this.put(KEY_CALENDAR_ASKED, '1');
  }

  photosAsked(): boolean {
    return this.get(KEY_PHOTOS_ASKED) === '1';
  }

  setPhotosAsked(): void {
    this.put(KEY_PHOTOS_ASKED, '1');
  }

  locationAsked(): boolean {
    return this.get(KEY_LOCATION_ASKED) === '1';
  }

  setLocationAsked(): void {
    this.put(KEY_LOCATION_ASKED, '1');
  }

  locationRecording(): boolean {
    return this.get(KEY_LOCATION_RECORDING) === '1';
  }

  locationBackground(): boolean {
    return this.get(KEY_LOCATION_BACKGROUND) === '1';
  }

  /** 记不记位置、后台也记不记（停下时后台也一起关） */
  setLocationRecording(on: boolean, background: boolean): void {
    this.put(KEY_LOCATION_RECORDING, on ? '1' : '');
    this.put(KEY_LOCATION_BACKGROUND, on && background ? '1' : '');
  }

  /** Debug 工具集的"重置首次提示"（124 号票）：当作没问过用户（系统自己的授权框还是只弹一次） */
  clearNotifyAsked(): void {
    this.put(KEY_NOTIFY_ASKED, '');
  }

  private get(key: string): string {
    try {
      return this.prefs.getSync(key, '') as string;
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'read setting %{public}s failed: %{public}s', key, JSON.stringify(e));
      return '';
    }
  }

  private put(key: string, value: string): void {
    try {
      this.prefs.putSync(key, value);
      this.prefs.flush();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'write setting %{public}s failed: %{public}s', key, JSON.stringify(e));
    }
  }
}
