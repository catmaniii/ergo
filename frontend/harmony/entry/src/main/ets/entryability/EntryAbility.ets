import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { AppSettings, colorModeOf, DOMAIN, TAG } from '../common/AppSettings';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      // 网页设置里的"外观"：开场先按上次记下的定深浅色，不等网页加载完（没选过就跟随系统）
      const mode = new AppSettings(this.context).colorMode();
      this.context.getApplicationContext().setColorMode(colorModeOf(mode));
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'set color mode failed: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, TAG, 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'load content failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'content loaded');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'Ability onForeground');
  }

  onBackground(): void {
    // 设备凭证在 cookie 里：切到后台时落盘，App 被系统杀掉也不用重新配对
    webview.WebCookieManager.saveCookieAsync().catch((err: Error) => {
      hilog.error(DOMAIN, TAG, 'save cookies failed: %{public}s', JSON.stringify(err));
    });
    hilog.info(DOMAIN, TAG, 'Ability onBackground');
  }
}
