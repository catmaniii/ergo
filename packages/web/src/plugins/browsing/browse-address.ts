// "浏览"页签（134 号票）的地址栏：打的字变成要打开的网址——网址直接开，关键词拿设置里选的搜索引擎搜（搜索引擎的清单在 state/browse.ts）。
// 只开 http、https；javascript:、file: 这些一律当关键词。
import { type SearchEngineId, searchUrl } from "../../state/index.ts";

/** 像主机名的：localhost、IPv4、[IPv6]，或者带点、最后一段有字母的域名（example.com、a.b.cn），后面可以跟端口和路径 */
const HOST_LIKE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,})(?::\d{1,5})?(?:[/?#]\S*)?$/iu;

/** 本机、局域网的写法（不补 https，补 http） */
const PLAIN_HTTP_HOST = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])(?::\d{1,5})?(?:[/?#]|$)/i;

/**
 * 地址栏里打的字要打开哪个网址：http(s):// 开头的直接开；像网址的（没有空格、像个主机名）补上 https://（本机、IP 补 http://）；
 * 别的都当关键词拿搜索引擎搜（javascript:、file: 这些也当关键词，浏览器只开 http、https）。空的是 undefined
 */
export function addressToUrl(input: string, engine: SearchEngineId): string | undefined {
  const text = input.trim();
  if (text === "") return undefined;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.hostname !== "") return url.href;
    } catch {
      // 写得不对：当关键词
    }
    return searchUrl(text, engine);
  }
  if (!/\s/.test(text) && HOST_LIKE.test(text)) {
    try {
      return new URL(`${PLAIN_HTTP_HOST.test(text) ? "http" : "https"}://${text}`).href;
    } catch {
      // 拼出来不是网址：当关键词
    }
  }
  return searchUrl(text, engine);
}

