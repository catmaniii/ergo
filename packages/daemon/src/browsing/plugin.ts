// 浏览插件（212 号票，ADR-0027；用户 2026-10-20："把内置浏览器和网页工具，日历和语音这三个拆成插件，其他都不拆"）：鸿蒙 App 的内置浏览器
// （"浏览"页签，134 号票）在守护进程这一侧的全部登记都在这里，组合根只在插件清单里列它。网页那一半是同名的网页插件（web 的 plugins/browsing/）。
// - 数据契约（停用也登记）：
//   - 网页候选卡（browse_pick，147 号票）：卡上"交"现取浏览插件的设备通路，没启用时回"内置浏览器插件没启用"；"都不要"、网页上已经交好的照常记；
//   - "浏览"的 ⋮ 菜单里存进素材的网页（web_page_saved，165 号票）：怎么变成素材（声明进内核的素材库，停用也照样：素材属于内核，
//     重建 materials.db 时照样采得出来）、彻底删除的改写函数；
//   - 移除时"连数据删"：网页候选卡的每个版本、候选缩略图的缓存；存进素材的网页不删（素材属于内核，设置里写明去成批删除删）。
// - 装配：
//   - 设备通路（browser-links.ts：设备报的浏览器、秘书的网页工具转给设备的事），停用时 close（正等着的回断开了）；
//   - 要交给网页的文件的取件码、候选的缩略图（start 开始定时清缓存，stop 停）、悬浮按钮上说的一段送识别（语音插件的识别，可选依赖
//     wants: [VOICE]，现取；语音插件不在时回"语音插件没启用"）、存进素材——经服务 BROWSING 交给网关（browsing/api.ts）；
//   - agent 那一侧：秘书的八个网页工具（读网页、填框、找文件、看图、交文件、开网址、看能点的、按编号点）经 agent 贡献缝只给秘书，
//     写着 at: "end"——排在内核的工具之后（原来的位置，模型看到的工具先后不变）；浏览侧边栏、悬浮按钮发的消息后面那段网页上下文
//     （147、182 号票）是输入附注，接在那条消息自己的文字末尾（原来的位置）；系统提示里的在定义里声明（prompt.ts：条件"浏览"、
//     六个网页工具名的占位符）。
// 停用（配置 plugins.disabled 里写 browsing 重启，或者设置 · 插件里点停用，马上生效）：秘书没有网页工具、提示里没有讲浏览的三段、
// 消息后面没有网页上下文；联网搜索不算 App 的内置浏览器（组合根按 BROWSING 现判）；App 发来的页面指令（browser_status、悬浮按钮的语音、
// 取文件、缩略图、存进素材）回"内置浏览器插件没启用"；以前的网页候选卡点"交"回同一句。网页上没有"浏览"页签、侧边栏、悬浮按钮。
// 不搬进来的（都是内核的）：授权的文件夹（folders/：秘书在聊天里也用它，138 号票）、App 的原生浏览器那一层的接口（网页的
// app/native-browser.ts、page-bridge/）、132 号票的内置浏览器叠层（/apps/ 转发的页面、渲染附件）。
import path from "node:path";
import { browseSearchEngineOf, t } from "@ergo/protocol";
import { clockIso } from "../scheduler/clock.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { VOICE } from "../voice/api.ts";
import { BROWSING } from "./api.ts";
import { createBrowserLinks } from "./browser-links.ts";
import { createPageFileTokens } from "./file-tokens.ts";
import { createPageThumbnails } from "./page-thumbnails.ts";
import { createPageVoice } from "./page-voice.ts";
import { browsePickCardType } from "./pick-card.ts";
import { browsingPrompts } from "./prompt.ts";
import { createSavedPages, webPageSavedPurge, webPageSavedSource } from "./saved-pages.ts";
import { browsingTools, browsingTurnOf } from "./secretary-tools.ts";
import { browsingInputNote } from "./texts.ts";

/** 候选缩略图的缓存在数据目录里的位置（和 config/data-dir.ts 的 pageThumbnails 一样；连数据删时按数据目录找） */
export const PAGE_THUMBNAILS_DIR = path.join("cache", "page-thumbnails");

export const browsingPlugin: PluginDefinition = {
  name: "browsing",
  get title() {
    return t("browsing.plugin.title");
  },
  get summary() {
    return t("browsing.plugin.summary");
  },
  // 工具的先后和个数照秘书拿到的（browsingTools）
  get brings() {
    return {
      tools: [
        t("browsing.tools.readPage"),
        t("browsing.tools.fill"),
        t("browsing.tool.findFiles"),
        t("browsing.tool.viewFiles"),
        t("browsing.tools.attach"),
        t("browsing.tools.open"),
        t("browsing.tools.snapshot"),
        t("browsing.tools.click"),
      ],
      cards: [t("browsing.plugin.card")],
    };
  },
  needs: [KERNEL.config, KERNEL.store, KERNEL.clock, KERNEL.cards, KERNEL.materials, KERNEL.media, KERNEL.layout, KERNEL.localFolders, KERNEL.thumbnails, KERNEL.webSearch],
  // 悬浮按钮上说话要语音插件的识别（214 号票）：可选，语音插件停用时说话回"没认出说了什么：语音插件没启用"，打字、别的照常
  wants: [VOICE],
  provides: [BROWSING],
  prompts: browsingPrompts,
  contracts(ctx) {
    // 网页候选卡：卡上"交"经设备通路交给发消息的那台设备，现取（没启用时回"内置浏览器插件没启用"）
    ctx.cardTypes.register(browsePickCardType({ links: { request: (...args) => ctx.active(BROWSING).links.request(...args) } }));
    // 存进素材的网页（165）：用户主动投喂的材料；彻底删除时标题、地址、正文换成删除标记
    ctx.materialSources.register(webPageSavedSource);
    ctx.purge.register(webPageSavedPurge);
    // 移除时连数据一起彻底删除（211 号票的口子）：浏览留下的网页候选卡和候选缩略图的缓存；存进素材的网页是素材，归内核，不删
    ctx.removal.declare({
      get deletes() {
        return [t("browsing.plugin.purge.cards"), t("browsing.plugin.purge.thumbnails")];
      },
      get keeps() {
        return [t("browsing.plugin.keep.pages"), t("browsing.plugin.keep.secretary"), t("browsing.plugin.keep.backup")];
      },
      cardTypes: ["browse_pick"],
      files: [PAGE_THUMBNAILS_DIR],
    });
  },
  setup(ctx) {
    const config = ctx.use(KERNEL.config);
    const store = ctx.use(KERNEL.store);
    const clock = ctx.use(KERNEL.clock);
    const cards = ctx.use(KERNEL.cards);
    const localFolders = ctx.use(KERNEL.localFolders);
    const thumbnails = ctx.use(KERNEL.thumbnails);
    const webSearch = ctx.use(KERNEL.webSearch);
    // 设备通路（147）：停用时正等着设备回的事回"断开了"
    const links = createBrowserLinks();
    // 要交给网页的文件的取件码（134）
    const pageFiles = createPageFileTokens();
    // 候选的缩略图（149）：秘书给候选时在后台先做好，挑图片窗口、候选卡凭取件码取小图；存在缓存区，定时清理
    const pageThumbnails = createPageThumbnails({ dir: ctx.use(KERNEL.layout).pageThumbnails, thumbnails, log: (line) => ctx.log(line) });
    ctx.lifecycle({ start: () => pageThumbnails.start(), stop: () => pageThumbnails.stop() });
    ctx.lifecycle({ stop: () => links.close() });
    ctx.provide(BROWSING, {
      links,
      appBrowserTurn(call) {
        const turn = browsingTurnOf({ store, links }, call);
        return "refused" in turn ? undefined : { engine: browseSearchEngineOf(turn.status.searchEngine) };
      },
      // 悬浮按钮上说的一段（149）：识别经语音插件的服务，每次现取（214 号票；不在时回"语音插件没启用"）
      pageVoice: createPageVoice(() => ctx.optional(VOICE)),
      pageFiles,
      pageThumbnails,
      savedPages: createSavedPages({ store, now: () => clockIso(clock) }),
    });
    // 秘书的网页工具（147；149 起悬浮按钮那一轮也是秘书）：只给秘书，排在内核的工具之后（原来的位置）
    const tools = browsingTools({
      store,
      links,
      cards,
      tokens: pageFiles,
      thumbs: pageThumbnails,
      files: {
        materials: ctx.use(KERNEL.materials),
        media: ctx.use(KERNEL.media),
        folders: () => localFolders.view(),
        timeZone: config.timeZone,
        cache: new Map(),
        thumbnails,
        log: (line) => ctx.log(`秘书的网页工具：${line}`), // @i18n-ignore log
      },
    });
    ctx.agent.tools.register({ to: { agents: ["secretary"] }, at: "end", tools: () => tools });
    // 浏览侧边栏、悬浮按钮发的消息后面那段网页上下文（147），秘书那段里另加一句联网搜索算上 App 的内置浏览器（182，按此刻的队列）
    ctx.agent.notes.register({
      to: { agents: ["secretary"] },
      text: (message) => (message.speaker === "user" && message.browsing ? browsingInputNote(message.browsing, webSearch.appBrowserNote()) : undefined),
    });
  },
};
