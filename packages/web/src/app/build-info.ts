// 这个页面是哪一版（124 号票：设置里的关于二狗）：二狗的版本、更新日志（构建时写进页面，build/build-info-plugin.ts），
// 页面构建（116 号票：构建产物内容的哈希，写在 index.html 的 <meta name="ergo-web-version">；开发服务器的页面没有）。
// 只有这里 import 虚拟模块：测试不碰这个文件（状态层的 changelog.ts 拿真的 CHANGELOG.md 测）。
import { APP_VERSION, CHANGELOG_BASE64 } from "virtual:ergo-build-info";
import { WEB_VERSION_META } from "../state/index.ts";

export { APP_VERSION };

/** 仓库根目录 CHANGELOG.md 的原文（构建时按 UTF-8 的 base64 写进来，这里解回去） */
export const CHANGELOG: string = new TextDecoder().decode(Uint8Array.from(atob(CHANGELOG_BASE64), (c) => c.charCodeAt(0)));

/** 页面构建（116 号票的 ergo-web-version）；开发服务器的页面、读不到是 undefined */
export const PAGE_WEB_VERSION: string | undefined =
  typeof document === "undefined" ? undefined : (document.querySelector(`meta[name="${WEB_VERSION_META}"]`)?.getAttribute("content") ?? undefined);
