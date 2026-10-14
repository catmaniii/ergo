/**
 * 界面上共用的线条图标（122 号票）：导航、选项、按钮上原来拿表情符号或 Unicode 符号（🎤 ⌨ 🖼 📄 📥 ⚙ 🔔 ▤ 💬 ＋……）当的图标，
 * 换成一套自己画的 SVG（不加依赖）。画法照几套风格现有的线条图标：24×24 的视框、线宽 1.75、圆头圆角、颜色是 currentColor
 * （跟着所在元素的字色，浅色深色都清楚）。大小是 1em：跟着所在元素的字号走。
 *
 * 用法：<Icon name="mic" />。外面一层 <span class="icon" data-icon="mic" aria-hidden="true">，图标都不给读屏读，
 * 按钮照旧靠文字或 aria-label 说清是什么。
 *
 * 风格要换掉某处的图标，照导航的做法（39 号票）在自己的 style.css 里覆盖：把那一处的字号设成 0（1em 的图标跟着缩没了，
 * 原来藏表情符号也是这么做的），再用 ::before 挂一张 mask 画自己的图标。只换某一个图标、不分在哪，可以按 .icon[data-icon="…"] 认。
 * 导航那几项不在这里换：主导航和"更多"页里同一项的图标走 .tab-icon + data-nav（ui/main-nav.tsx 的 NavIcon），每套风格都画了自己的。
 */
import type { ReactNode } from "react";

/** 齿轮：八个齿，中间一个孔（齿的外圈半径 9、齿根 6.6） */
const GEAR =
  "M10.52 5.57L10.75 3.09A9 9 0 0 1 13.25 3.09L13.48 5.57A6.6 6.6 0 0 1 15.5 6.4L17.42 4.81A9 9 0 0 1 19.19 6.58L17.6 8.5A6.6 6.6 0 0 1 18.43 10.52L20.91 10.75A9 9 0 0 1 20.91 13.25L18.43 13.48A6.6 6.6 0 0 1 17.6 15.5L19.19 17.42A9 9 0 0 1 17.42 19.19L15.5 17.6A6.6 6.6 0 0 1 13.48 18.43L13.25 20.91A9 9 0 0 1 10.75 20.91L10.52 18.43A6.6 6.6 0 0 1 8.5 17.6L6.58 19.19A9 9 0 0 1 4.81 17.42L6.4 15.5A6.6 6.6 0 0 1 5.57 13.48L3.09 13.25A9 9 0 0 1 3.09 10.75L5.57 10.52A6.6 6.6 0 0 1 6.4 8.5L4.81 6.58A9 9 0 0 1 6.58 4.81L8.5 6.4A6.6 6.6 0 0 1 10.52 5.57z";

/** 每个图标画什么（都在 24×24 里，线宽、线头、拐角、颜色由外面的 <svg> 统一给） */
const ICONS = {
  /** 对话气泡：导航的秘书；会话标题栏"回到对话"（原来的 💬） */
  chat: <path d="M20.5 12a8 8 0 0 1-8 8H8l-4 3v-5.2A8 8 0 0 1 11.5 4h1a8 8 0 0 1 8 8z" />,
  /** 方框里一个勾：导航的任务 */
  tasks: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="m8.5 12.2 2.5 2.5 4.8-5.2" />
    </>
  ),
  /** 文件夹：导航的项目 */
  folder: <path d="M3 7.5a2.5 2.5 0 0 1 2.5-2.5h3.6c.5 0 1 .2 1.4.6L12 7h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />,
  /** 铃铛：导航的待办；页面顶上的通知（原来的 🔔） */
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  /** 日历：导航的日历 */
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  /** 三根柱子：导航的消耗 */
  chart: <path d="M5 20v-7M12 20V5M19 20v-10M3 20h18" />,
  /** 叠起来的几层：导航的记忆 */
  layers: (
    <>
      <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16 8.5 4.5 8.5-4.5" />
    </>
  ),
  /** 齿轮：导航的设置；会话标题栏"这个 agent 的设置"（原来的 ⚙） */
  gear: (
    <>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
  /** 三个点：导航的"更多"（点是实心的） */
  dots: (
    <g fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </g>
  ),
  /** 加号：输入栏的附件按钮（原来的全角 ＋） */
  plus: <path d="M12 5v14M5 12h14" />,
  /** 话筒：输入栏"切换到语音输入"、输入框上方的一段语音（原来的 🎤） */
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  /** 键盘：输入栏"切换到文字输入"（原来的 ⌨） */
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M6.5 14h.01M17.5 14h.01M9.5 14h5" />
    </>
  ),
  /** 图片：附件菜单的"图片"、输入框上方的图片（原来的 🖼） */
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.75" />
      <path d="m3.5 17 5-5 4.5 4.5 2.5-2.5 5 5" />
    </>
  ),
  /** 一页纸：附件菜单的"文件"、输入框上方的文件（原来的 📄） */
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  /** 往托盘里放：附件菜单的"作为材料投喂"（原来的 📥） */
  tray: (
    <>
      <path d="M12 3v10M8 9l4 4 4-4" />
      <path d="M3.5 14v4a2.5 2.5 0 0 0 2.5 2.5h12a2.5 2.5 0 0 0 2.5-2.5v-4h-4.5l-1.5 2h-5l-1.5-2z" />
    </>
  ),
  /** 方框里几行：会话标题栏"缩到全局"（原来的 ▤） */
  overview: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M7.5 9h9M7.5 12h9M7.5 15h9" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

/** 全部图标的名字（测试用：每个都按同一套画法） */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** 一个线条图标：1em 大、当前字色，不给读屏读 */
export function Icon({ name }: { name: IconName }) {
  return (
    <span className="icon" data-icon={name} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        {ICONS[name]}
      </svg>
    </span>
  );
}
