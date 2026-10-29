// 这一页是不是侧边栏模式（147 号票）：鸿蒙 App 另开一个 Web 组件加载二狗网页加上 ?ergo=side，摆在原生网页上面当浏览侧边栏。
// 认出来是外壳的事（App.tsx 据此整页只画侧边栏、不接页面上的别的），画什么由浏览插件给（plugins/slots.ts 的 TabSlot.Side）。
// 212 号票从浏览插件的 side-remote.ts、page-side.ts 挪到这里（核心不 import 插件）；那两个文件照旧转出这几个名字。
// isSideMode 不碰浏览器的全局变量，能在 Node 里测；SIDE_MODE 经 globalThis 取地址，Node 里是 false。
// 312 号票：参数名以前是 ergou（旧 App 加载的是 ?ergou=side），新旧都认。
import { oldNameOf } from "@ergo/protocol";

/** 地址里带着它就是侧边栏模式 */
export const SIDE_MODE_PARAM = "ergo";
export const SIDE_MODE_VALUE = "side";

/** 这一页是不是侧边栏模式（location.search） */
export function isSideMode(search: string): boolean {
  const params = new URLSearchParams(search);
  return [SIDE_MODE_PARAM, oldNameOf(SIDE_MODE_PARAM)].some((name) => params.get(name) === SIDE_MODE_VALUE);
}

/** 页面的地址（Node 里跑的测试没有）：经 globalThis 取，这个文件在 Node 里也能引 */
const here = (globalThis as { location?: { search?: string } }).location;

/** 这一页是侧边栏模式（App 另开的 Web 组件加载的 ?ergo=side） */
export const SIDE_MODE = here?.search !== undefined && isSideMode(here.search);
