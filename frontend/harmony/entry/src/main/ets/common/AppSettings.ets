import { preferences } from '@kit.ArkData';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

export const DOMAIN = 0x0E60;
export const TAG = 'ErgouApp';

/** App 自己的设置存在这个偏好文件里（应用沙箱，不进仓库） */
const PREFS_NAME = 'ergou_app';
/** 用户配好的二狗地址 */
const KEY_SERVER = 'server_url';
/** 网页设置里选的外观：system / light / dark；开场先按它定深浅色，不等网页 */
const KEY_COLOR_MODE = 'color_mode';

/** 外观（system / light / dark）对应的应用深浅色：状态栏、窗口底色跟着网页一起变（照 AgentSense） */
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
