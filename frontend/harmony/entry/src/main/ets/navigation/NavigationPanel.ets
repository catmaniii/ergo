import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';

/**
 * 交给手机上的地图导航（票 434）：网页地图卡片上点"用手机地图导航"，原生桥的 openNavigation 调到这里，拉起系统的
 * "选导航应用"面板（UIAbilityContext.startAbilityByType('navigation')，官方文档"拉起导航类应用"）——手机上装了的、
 * 接了这个面板的地图 App（花瓣地图、高德、百度……）列在里面，用户点一个就开始导航；一个都没有时面板里系统自己说。
 * - 坐标网页转好了（大陆里 GCJ-02：面板要的就是它；大陆外原样），这里只核对是不是数、在不在范围里；
 * - 开车（和不认得的走法）用"导航"（sceneType 2：直接开始导航，这一种不带走法）；步行、公交用"路线规划"
 *   （sceneType 1，vehicleType 步行 1、公交 3），用户在地图 App 里再点开始；
 * - 回 "ok"（面板拉起来了）、"bad"（参数不对）、"failed:<错误码>"（系统没拉起来）；网页不是 ok 就退回导航网址。
 * 网页一侧是 packages/web/src/app/native-navigation.ts。只开给主界面（侧边栏那份原生桥没有这个方法）。
 */

/** 终点的名字最长多少个字（地图 App 里显示的；网页那边卡片上最长 40） */
const NAME_MAX = 60;

/** 系统面板的参数：坐标不对是 undefined（拆出来是为了在 Node 里测：frontend/test/harmony.test.ts） */
function navigationWant(lat: number, lon: number, name: string, mode: string): Record<string, Object> | undefined {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) ||
    Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return undefined;
  }
  const want: Record<string, Object> = {};
  const vehicle = mode === 'walking' ? 1 : mode === 'transit' ? 3 : -1;
  if (vehicle < 0) {
    want['sceneType'] = 2;
  } else {
    want['sceneType'] = 1;
    want['vehicleType'] = vehicle;
  }
  want['destinationLatitude'] = lat;
  want['destinationLongitude'] = lon;
  const shown = typeof name === 'string' ? name.trim().substring(0, NAME_MAX) : '';
  if (shown.length > 0) {
    want['destinationName'] = shown;
  }
  return want;
}

export class NavigationPanel {
  private readonly context: common.UIAbilityContext;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  /** 拉起系统的"选导航应用"面板；回 "ok" / "bad" / "failed:<错误码>" */
  open(lat: number, lon: number, name: string, mode: string): Promise<string> {
    const want = navigationWant(lat, lon, name, mode);
    if (want === undefined) {
      hilog.warn(DOMAIN, TAG, 'navigation panel: bad target');
      return Promise.resolve('bad');
    }
    return new Promise<string>((resolve) => {
      const callback: common.AbilityStartCallback = {
        onError: (code: number, errName: string, message: string) => {
          hilog.error(DOMAIN, TAG, 'navigation panel error: %{public}d %{public}s %{public}s', code, errName, message);
          resolve(`failed:${code}`);
        },
        onResult: () => {
          hilog.info(DOMAIN, TAG, 'navigation panel result');
        }
      };
      try {
        this.context.startAbilityByType('navigation', want, callback)
          .then(() => {
            hilog.info(DOMAIN, TAG, 'navigation panel opened: scene %{public}s', String(want['sceneType']));
            resolve('ok');
          })
          .catch((err: BusinessError) => {
            hilog.error(DOMAIN, TAG, 'navigation panel failed: %{public}s', JSON.stringify(err));
            resolve(`failed:${err.code}`);
          });
      } catch (e) {
        const err = e as BusinessError;
        hilog.error(DOMAIN, TAG, 'navigation panel threw: %{public}s', JSON.stringify(err));
        resolve(`failed:${err.code}`);
      }
    });
  }
}
