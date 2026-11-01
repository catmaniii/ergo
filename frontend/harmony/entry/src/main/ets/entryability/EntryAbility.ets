import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { detectBarcode, scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';
import BuildProfile from 'BuildProfile';
import { AppSettings, colorModeOf, DOMAIN, TAG } from '../common/AppSettings';
import { appTexts } from '../common/AppTexts';
import { notifyTaps } from '../notify/NativeNotify';

/** 联调的测试入口交给 Index.ets 的那段文字（AppStorage 的键） */
export const TEST_SCAN_KEY: string = 'ergoTestScan';

/**
 * 联调的测试入口：模拟器没有能对准屏幕的相机，App 开着时 aa start 带 --ps ergoTestScanText <文字> 或 --ps ergoTestScanImage <file:// 路径>
 * （图片走系统的解码器 detectBarcode）。只有 --webview-debug 的包才有：正式的包里别的应用不能这样塞一个地址进来
 */
function takeTestScan(want: Want): void {
  if (!BuildProfile.WEBVIEW_DEBUG) {
    return;
  }
  const text = want.parameters?.['ergoTestScanText'];
  if (typeof text === 'string') {
    AppStorage.setOrCreate(TEST_SCAN_KEY, `${Date.now()}|${text}`);
    return;
  }
  const image = want.parameters?.['ergoTestScanImage'];
  if (typeof image !== 'string') {
    return;
  }
  const options: scanBarcode.ScanOptions = { scanTypes: [scanCore.ScanType.QR_CODE], enableMultiMode: false, enableAlbum: false };
  detectBarcode.decode({ uri: image }, options).then((results: scanBarcode.ScanResult[]) => {
    hilog.info(DOMAIN, TAG, 'test scan image: %{public}d results', results.length);
    AppStorage.setOrCreate(TEST_SCAN_KEY, `${Date.now()}|${results.length > 0 ? results[0].originalValue : ''}`);
  }).catch((err: BusinessError) => {
    hilog.error(DOMAIN, TAG, 'test scan image failed: %{public}d', err.code);
    AppStorage.setOrCreate(TEST_SCAN_KEY, `${Date.now()}|`);
  });
}

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      // 网页设置里的"外观"：开场先按上次记下的定深浅色，不等网页加载完（没选过就跟随系统）
      const mode = new AppSettings(this.context).colorMode();
      this.context.getApplicationContext().setColorMode(colorModeOf(mode));
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'set color mode failed: %{public}s', JSON.stringify(err));
    }
    // App 原生的字：读打包进来的自带语言；记得上次二狗的语言就用它，从没连上过用英文
    appTexts.load(this.context);
    // App 没在跑、点开通知栏里的一条拉起来的：记下那一条，网页开场来取
    notifyTaps.fromWant(want);
    hilog.info(DOMAIN, TAG, 'Ability onCreate');
  }

  // App 在跑（前台、后台）时点开通知栏里的一条：Ability 是 singleton，系统把它拉到前台、走这里；
  // 记下那一条，Index.ets 让网页来取
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    notifyTaps.fromWant(want);
    takeTestScan(want);
    hilog.info(DOMAIN, TAG, 'Ability onNewWant');
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
