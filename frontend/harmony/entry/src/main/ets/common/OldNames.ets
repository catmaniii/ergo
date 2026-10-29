/**
 * 312 号票：二狗系统里的 ergou（拼音）换成了 ergo。App 这边刻意留着的旧名字都在这里（包名 com.example.ergou 不动，见 AppScope/app.json5）：
 * - 存设置的偏好文件名：改了名设置就丢了（服务器地址要重填），照旧用旧的；
 * - 原生桥、侧边栏的对象用旧名字再挂一份，往网页调的函数没有新名字时调旧名字的，侧边栏地址也带上旧的参数：网页还是旧版时照样能用；
 * - 通知里带的参数名：旧版 App 发出去的通知点开时照样认。
 * 网页那边新旧都认（packages/web/src/app/app-names.ts、side-mode.ts）。
 */

/** 旧的拼法 */
const OLD_SPELLING = 'ergou';

/** App 自己的设置存在这个偏好文件里（应用沙箱，不进仓库）：名字照旧，改了设置就丢 */
export const PREFS_NAME = `${OLD_SPELLING}_app`;

/** 新名字对应的旧名字：里面第一个 ergo 换成 ergou（ergoNative → ergouNative，__ergoBack → __ergouBack） */
export function oldNameOf(name: string): string {
  const at = name.indexOf('ergo');
  return at < 0 ? name : `${name.substring(0, at)}${OLD_SPELLING}${name.substring(at + 4)}`;
}

/** 往网页调网页挂的函数（args 是已经写好的参数表达式）：新名字的优先，网页还是旧版（只挂了旧名字）时调旧名字的，都没有就不调 */
export function webCallScript(name: string, args: string): string {
  return `(function(){var f=window.${name}||window.${oldNameOf(name)};return f?f(${args}):undefined})()`;
}
