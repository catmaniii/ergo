// 浏览插件的网页这一半（212 号票，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/browsing/plugin.ts）。插件名和守护进程的一样
// （browsing）：守护进程报它在运行就装，配置 plugins.disabled 里停用了、设置 · 插件里停用了就停。登记的：
// - 主导航里的页签"浏览"（核心留着位置、地址 #/browse，只在鸿蒙 App 里有原生浏览器时出现；BrowsePage.tsx），侧边栏模式（?ergo=side）
//   那一页（BrowseSidebar.tsx），主框架里挂一次的（悬浮按钮、挑图片窗口接到 store，侧边栏开着时秘书会话算在看）；
// - 卡片类型 browse_pick 的画法（BrowsePickCard.tsx：网页候选卡，147 号票）；
// - 开场接上 App 推过来的（第一次装上时：原生浏览器、悬浮按钮、浏览侧边栏，page-browse.ts 的 connectBrowsing；组合根建宿主时交来页面的
//   连接和 HTTP），装上、停用时跟着变（turnBrowsingOn：页面里的外链改不改到"浏览"里打开，132 号票的内置浏览器在 App 里开不开原生浏览器，
//   重新装上时再报一次浏览器的样子）。
// 语音插件停用时（214 号票）：悬浮按钮长按不录、写一句"语音插件没启用：点一下按钮打字"，侧边栏里的输入框跟着核心没有话筒。
// 停用时：导航里没有"浏览"，地址 #/browse 写"内置浏览器插件没启用"（离开那一页时原生浏览器、侧边栏藏起来，悬浮按钮、挑图片窗口跟着不见）；
// 以前的网页候选卡显示"（内置浏览器插件没启用，这条内容暂时看不到）"；外链照旧（电脑、手机浏览器里新开标签页，App 里交给系统浏览器）。
// 留在核心的：App 原生浏览器那一层的接口（app/native-browser.ts、page-bridge/：App 注入网页的页面桥由鸿蒙 App 构建时从那里打包）、
// 设置 · 浏览与填框（搜索引擎、联网搜索、授权的文件夹，pages/more/BrowsingPage.tsx）、会话里"在网页「X」上说"的标注（状态层）。
import { useEffect } from "react";
import { t } from "../../state/index.ts";
import { type TabMountProps, usePlugins, type WebPluginDefinition } from "../api.ts";
import { BrowsePage } from "./BrowsePage.tsx";
import { BrowsePickCard } from "./BrowsePickCard.tsx";
import { BrowseSidebar } from "./BrowseSidebar.tsx";
import { connectBrowsing, setPageVoiceAvailable, turnBrowsingOn, useBrowseSide, usePageButtonSync } from "./page-browse.ts";
import { pageRemoteSide, useRemoteSide } from "./page-side.ts";

/** 侧边栏模式（147 号票）整页：秘书的主会话，状态由 App 从"浏览"页转过来 */
function SideModePage() {
  const view = useRemoteSide();
  return <BrowseSidebar control={pageRemoteSide()} view={view} />;
}

/**
 * 主框架里挂一次：悬浮按钮、挑图片窗口接到 store（149 号票）；"浏览"右边的侧边栏开着时秘书会话算在看（147 号票）；
 * 能不能说话跟着输入框的语音插槽（214 号票：语音插件登记的，有它才有话筒）——不在时悬浮按钮只能打字
 */
function BrowsingMount({ watching }: TabMountProps) {
  usePageButtonSync();
  const voice = usePlugins().list("composerVoice").length > 0;
  useEffect(() => setPageVoiceAvailable(voice), [voice]);
  const side = useBrowseSide();
  useEffect(() => watching(side.open), [side.open, watching]);
  useEffect(() => () => watching(false), [watching]);
  return null;
}

export const browsingWebPlugin: WebPluginDefinition = {
  name: "browsing",
  get title() {
    return t("ui.plugins.browsing.title");
  },
  owns: { tabs: ["browse"], cards: ["browse_pick"] },
  // 设置 · 插件里列的网页上的页面、栏目（211 号票）
  get brings() {
    return [t("ui.plugins.browsing.brings.tab"), t("ui.plugins.browsing.brings.sidebar"), t("ui.plugins.browsing.brings.button")];
  },
  setup(ctx) {
    if (ctx.page) connectBrowsing(ctx.page);
    ctx.register("tabs", { id: "browse", Page: BrowsePage, Side: SideModePage, Mount: BrowsingMount });
    ctx.register("cards", { type: "browse_pick", Card: BrowsePickCard });
    ctx.effect(turnBrowsingOn);
  },
};
