// 网页是哪一版（116 号票）：构建时写进 index.html 的 <meta name="ergo-web-version">，守护进程从它提供的文件里取、页面读自己的，
// 写法和认法只在协议包里一处。
import { describe, expect, it } from "vitest";
import { EVENT_TYPES, isEphemeralEventType, WEB_VERSION_META, webVersionInHtml, webVersionMeta } from "../src/index.ts";

const page = (head: string) => `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    ${head}\n    <title>二狗</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n`;

describe("网页的版本号", () => {
  it("写进去的认得出来", () => {
    expect(webVersionMeta("3f9a0c12d4e5b678")).toBe(`<meta name="${WEB_VERSION_META}" content="3f9a0c12d4e5b678" />`);
    expect(webVersionInHtml(page(webVersionMeta("3f9a0c12d4e5b678")))).toBe("3f9a0c12d4e5b678");
  });

  it("没有版本号的页面（这张票之前构建的、测试页）是不知道", () => {
    expect(webVersionInHtml(page('<meta charset="UTF-8" />'))).toBeUndefined();
    expect(webVersionInHtml("")).toBeUndefined();
  });

  it("只认 head 里第一个、内容是字母数字和 . _ - 的；别处的同名字样不算", () => {
    expect(webVersionInHtml(page(`${webVersionMeta("v1")}\n    ${webVersionMeta("v2")}`))).toBe("v1");
    expect(webVersionInHtml(page(`<meta name="${WEB_VERSION_META}" content="a b<script>" />`))).toBeUndefined();
    expect(webVersionInHtml(page(`<meta name="${WEB_VERSION_META}" content="" />`))).toBeUndefined();
    // 正文里（比如页面脚本里的字符串）出现同样的字样不算
    expect(webVersionInHtml(`<html><head><title>x</title></head><body><script>const s = '${webVersionMeta("fake")}';</script></body></html>`)).toBeUndefined();
  });

  it("换了一版时推的 web_version 是临时事件（只推送、不落盘、不补发）", () => {
    expect(EVENT_TYPES.webVersion).toBe("web_version");
    expect(isEphemeralEventType(EVENT_TYPES.webVersion)).toBe(true);
  });
});
