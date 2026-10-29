// 网页是哪一版（116 号票）：服务端的页面更新了（npm run build:web 换了 index.html），开着的页面（鸿蒙 App、浏览器）要知道，
// 提示"二狗有新版本 · 刷新"。
// - 构建时算出构建产物内容的哈希，写进 index.html 的 <head> 开头：<meta name="ergo-web-version" content="<版本号>" />
//   （packages/web/build/web-version-plugin.ts）。内容不变（同样的代码再构建一遍）版本号就不变；
// - 守护进程从它提供的 index.html 里取（gateway/web-version.ts），订阅的响应里带上（SubscribeResult.webVersion）、换了一版时在活动状态频道
//   上推一条临时的 web_version、经 GET /api/web-version 回（WebVersionView）；
// - 页面读自己 <head> 里的那一个（packages/web/src/app/web-version.ts），对不上就提示。
// 写法和认法只在这里一处。不引用 TypeBox。

import { oldNameOf } from "./old-names.ts";

/** 版本号写在哪个 meta 里 */
export const WEB_VERSION_META = "ergo-web-version";

/** 版本号里能有的字（构建时是十六进制的哈希；认的时候放宽到字母数字和 . _ -，最长 64） */
const VERSION_PATTERN = "[0-9A-Za-z._-]{1,64}";

/** 认的时候 312 号票之前构建的页面（meta 名是旧名字）也认：守护进程换了新版、网页还没重新构建时照样知道是哪一版 */
const META_RE = new RegExp(`<meta\\s+name="(?:${WEB_VERSION_META}|${oldNameOf(WEB_VERSION_META)})"\\s+content="(${VERSION_PATTERN})"\\s*/?>`);

/** 写进 <head> 的那一行 */
export function webVersionMeta(version: string): string {
  return `<meta name="${WEB_VERSION_META}" content="${version}" />`;
}

/**
 * 从页面里取出版本号：只看 </head> 之前的第一个（构建时写在 <head> 开头，在内联的页面脚本前面）；没有、写得不对是 undefined
 * （这张票之前构建的页面、测试页）。读到一半的文件（正在重新构建）还没有 </head> 时整段都看
 */
export function webVersionInHtml(html: string): string | undefined {
  const end = html.indexOf("</head>");
  return META_RE.exec(end < 0 ? html : html.slice(0, end))?.[1];
}

/** 活动状态频道上的临时事件 web_version 的负载：守护进程提供的网页换成了这一版 */
export interface WebVersionEventPayload {
  version: string;
}
