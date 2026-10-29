// 浏览插件（内置浏览器和网页工具，212 号票，ADR-0027）对外的接口：内核和别的插件只从这里拿浏览插件的东西，
// 不 import 浏览插件的别的文件（test/browsing/boundary.test.ts 检查，例外写在那里）。
// - 服务名 BROWSING（经插件宿主按名字取，插件没启用时取到 undefined，不要存起来）和它的类型：网关把连接报的浏览器、回的结果交给它
//   （browser_status、browser_reply，147 号票），悬浮按钮上说的一段送识别（149）、要交给网页的文件和候选缩略图（134、149）、
//   "浏览"的 ⋮ 菜单里存进素材（165），联网搜索按它判这一轮能不能用鸿蒙 App 的内置浏览器（182）；
// - 数据契约里读得出的（只看事件日志，不管插件开没开都能用，和素材来源、改写函数一样）：存进素材的网页的正文（savedPageOf：素材在内核的
//   素材库里，设置里看素材、秘书检索和读素材都用它）、网页文字的外部数据标记；
// - 网页工具的名字（联网搜索的说明里提到它们，只在浏览插件运行时提）；
// - 插件没启用时给人看的那一句（browsingOff：网关回 App 发来的页面指令用）。
import { t } from "@ergo/protocol";
import type { HostToolCall } from "../agent-manager/host-tools.ts";
import { serviceKey } from "../plugins/host.ts";
import type { AppBrowserTurn } from "../web/index.ts";
import type { BrowserLinks } from "./browser-links.ts";
import type { PageFileTokens } from "./file-tokens.ts";
import type { PageThumbnails } from "./page-thumbnails.ts";
import type { PageVoice } from "./page-voice.ts";
import type { SavedPages } from "./saved-pages.ts";

export type { BrowserLinks, BrowserPeer } from "./browser-links.ts";
export type { PageFileTokens } from "./file-tokens.ts";
export type { PageThumbnails } from "./page-thumbnails.ts";
export type { PageVoice } from "./page-voice.ts";
export { type SavedPage, savedPageOf, type SavedPages } from "./saved-pages.ts";
export { BROWSE_ATTACH_FILES_TOOL, BROWSE_CLICK_TOOL, BROWSE_FILL_TOOL, BROWSE_OPEN_TOOL, BROWSE_READ_PAGE_TOOL, BROWSE_SNAPSHOT_TOOL, PAGE_TEXT_BEGIN, PAGE_TEXT_END } from "./texts.ts";

/** 浏览插件提供的服务（插件在运行时才有） */
export interface BrowsingService {
  /** 设备通路（147 号票）：哪台设备上开着哪个浏览器，秘书的网页工具转给设备的事；网关把连接报的、回的交给它，连接断了 drop */
  readonly links: BrowserLinks;
  /**
   * 这一次调用所在的那一轮能不能用鸿蒙 App 的内置浏览器联网搜索（182 号票，和秘书的网页工具同一个准入：侧边栏、悬浮按钮那一轮，
   * 发消息那台设备还连着）：能用回那台设备"浏览"里的搜索引擎，不能用是 undefined
   */
  appBrowserTurn(call: Pick<HostToolCall, "inputMessageId" | "moreInputMessageIds">): AppBrowserTurn | undefined;
  /** 悬浮按钮上按住说的一段送识别（149 号票，POST /api/page-command/voice） */
  readonly pageVoice: PageVoice;
  /** 要交给网页的文件的取件码（134 号票，GET /api/page-files/<取件码>） */
  readonly pageFiles: PageFileTokens;
  /** 候选的缩略图（149 号票，GET /api/page-files/<取件码>/thumb） */
  readonly pageThumbnails: Pick<PageThumbnails, "get">;
  /** "浏览"的 ⋮ 菜单里存进素材（165 号票，POST /api/materials/web-page） */
  readonly savedPages: SavedPages;
}

/** 浏览插件提供的服务 */
export const BROWSING = serviceKey<BrowsingService>("browsing");

/** 浏览插件没启用时给人看的那一句（"内置浏览器插件没启用"，按当前语言） */
export const browsingOff = (): string => t("plugins.notEnabled", { title: t("browsing.plugin.title") });
