// 交给手机上的地图导航（434，卡片上"用手机地图导航"）在网页这一侧的原生那一半：新版鸿蒙 App 的原生桥 ergoNative 上多一个
// openNavigation(lat, lon, name, mode)，拉起系统的"选导航应用"面板（startAbilityByType('navigation')，App 那边在
// frontend/harmony/entry/src/main/ets/navigation/NavigationPanel.ets），手机上装了的地图 App 列在里面，用户点一个就开始导航。
// - 坐标由网页转好交过去（大陆里 GCJ-02：系统面板要的就是它；大陆外原样）；name 是终点的名字（没有给空串）；mode 是
//   driving / transit / walking（App 照它选"导航"还是"路线规划"）；
// - 回 Promise<string>："ok" 是面板拉起来了；别的（"bad" 参数不对、"failed:<错误码>"、App 拒绝了这个页面回的空串）是没拉起来，
//   网页退回那一家的导航网址（plugins/map/navigate.ts）；
// - 旧版鸿蒙 App、安卓 App 没有这个方法：NativeApp.navigation 是 undefined（安卓走 geo: 交给系统，旧版鸿蒙走导航网址）。
// 这里不碰浏览器的全局变量，测试在 Node 里用假的原生桥跑。

/** 原生桥上的方法名（鸿蒙 NativeBridge.ets 的 NATIVE_BRIDGE_METHODS 里也叫它） */
export const NATIVE_NAVIGATION_METHOD = "openNavigation";

/** 交给 App 的目的地：坐标已经按系统面板要的转好（大陆里 GCJ-02） */
export interface NativeNavigationTarget {
  readonly lat: number;
  readonly lon: number;
  readonly name?: string | undefined;
  readonly mode?: string | undefined;
}

/** 拉起系统的"选导航应用"面板：拉起来了是 true，没拉起来（App 出错、拒绝了）是 false */
export type NativeNavigation = (target: NativeNavigationTarget) => Promise<boolean>;

/** 原生桥上有 openNavigation（新版鸿蒙 App）就包一层；没有是 undefined */
export function wrapNativeNavigation(bridge: Record<string, unknown>): NativeNavigation | undefined {
  const fn = bridge[NATIVE_NAVIGATION_METHOD];
  if (typeof fn !== "function") return undefined;
  return async (target) => {
    try {
      const result: unknown = await fn.call(bridge, target.lat, target.lon, target.name ?? "", target.mode ?? "driving");
      return result === "ok";
    } catch {
      return false;
    }
  };
}
