// 主切面：HTML、SVG 附件在隔离的沙箱里预览（117 号票）。真的守护进程（临时数据目录）：附件经 HTTP 上传入库，再像维护者发附件那样
// 作为一条消息追加进会话（名字、类型以消息里最近一次引用它的文件 part 为准）；测试扮演浏览器取内容：
// - GET /api/media/<媒体 id>/html：HTML 原样发出（末尾加一小段让链接在新窗口打开的脚本），带沙箱的 CSP 等响应头（逐项核对）；
// - GET /api/media/<媒体 id>/svg：SVG 以 image/svg+xml 发出，带 default-src 'none'; style-src 'unsafe-inline'; sandbox；
// - 内容接口 /text 对它们只回名字、大小和 frame；超过 1 MB 的不预览（413）；
// - 只按媒体 id 取；外网端口没配对的被拒；Origin: null（沙箱里的页面发出的请求就是这个来源）的接口请求和 WebSocket 握手
//   在两个端口上都被拒，带着有效凭证也一样；
// - 媒体接口 /api/media/<id> 原来的规矩不变（HTML、SVG 照旧作为附件下载）。
// 沙箱在真浏览器里的效果（脚本拿不到 cookie、本地存储，连二狗被拒，能从外网取数据……）在无头 Chrome 里核对，见 117 号票的 Comments。
import fs from "node:fs";
import path from "node:path";
import { attachmentPartFrom, HTTP_PATHS, type HttpErrorBody, MEDIA_FRAME_MAX_BYTES, type MediaTextView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { appendMessage } from "../../src/conversation/messages.ts";
import { LINKS_IN_NEW_WINDOW } from "../../src/gateway/http-api.ts";
import { DEVICE_COOKIE } from "../../src/pairing/credentials.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { media } from "../helpers/http.ts";
import { png } from "../helpers/images.ts";

const TM1 = "maintainer:tm-1";

/** agent 生成的日报页：内联脚本（按钮改字）、从 CDN 拉的图表库、页内锚点和外链 */
const REPORT_HTML = [
  "<!doctype html>",
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>AI 日报</title>',
  '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script></head>',
  '<body><h1 id="top">10 月 13 日 AI 日报</h1><a href="#top">回到顶上</a> <a href="https://example.com/news">原文</a>',
  '<button id="b" onclick="this.textContent=\'点过了\'">点我</button></body></html>',
].join("\n");

/** 走势图 */
const CHART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><style>.l{stroke:#36c}</style><polyline class="l" fill="none" points="0,50 40,30 80,35 120,10"/><script>alert(1)</script></svg>';

/**
 * HTML 预览的 CSP（逐项写出来核对）：用户 2026-10-13 定页面功能不加限制——sandbox 只不给 allow-same-origin、allow-top-navigation
 * 那几种；脚本能 eval，能从 https:、wss: 取数据，表单能提交到 https:；不许 http:（连不上二狗自己）
 */
const HTML_CSP =
  "sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-orientation-lock allow-presentation; " +
  "default-src https: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:; style-src 'unsafe-inline' https: data: blob:; " +
  "connect-src https: wss: data: blob:; form-action https:; frame-ancestors 'self'";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** 文件名在 Content-Disposition 里的写法（ASCII 退路名加 UTF-8 的真名） */
const disposition = (name: string) => `inline; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** 上传一个文件，作为维护者的一条消息发进它的会话（和 send_attachment 一样）；part 上的类型直接写明。返回媒体 id */
async function sendFile(test: TestDaemon, content: string | Buffer, name: string, mime: string): Promise<string> {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const stored = await media.upload(test.url, bytes, { name, mime }, 1024 * 1024);
  appendMessage(test.daemon.store, { conversation: TM1, speaker: "agent", parts: [attachmentPartFrom({ ...stored, mime })] }, { taskId: "t-1" });
  return stored.mediaId;
}

/** 预览接口的响应头（逐项核对的那几样） */
const FRAME_HEADER_NAMES = ["content-type", "content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "cache-control", "content-disposition", "content-length"] as const;
const frameHeaders = (headers: Record<string, string | string[] | undefined>) => Object.fromEntries(FRAME_HEADER_NAMES.map((n) => [n, headers[n]]));

describe("HTML 附件在沙箱里预览", () => {
  it("原样发出（末尾加一小段让链接在新窗口打开的脚本），响应头逐项：沙箱的 CSP、nosniff、只许二狗自己的页面嵌、不缓存、不带 Referer；HEAD 一样的头", async () => {
    const test = await startTestDaemon();
    const id = await sendFile(test, REPORT_HTML, "AI 日报.html", "text/html");
    const res = await httpRequest(test.url, HTTP_PATHS.mediaHtml(id));
    expect(res.status).toBe(200);
    const body = REPORT_HTML + LINKS_IN_NEW_WINDOW;
    expect(res.body).toBe(body);
    expect(frameHeaders(res.headers)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": HTML_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "content-disposition": disposition("AI 日报.html"),
      "content-length": String(Buffer.byteLength(body)),
    });
    // 沙箱：页面的功能都给（脚本、表单、弹框、下载、新窗口）；只有不是同源（拿不到 cookie、本地存储）、不能把整页导航走
    const sandbox = HTML_CSP.split("; ")[0]!;
    for (const missing of ["allow-same-origin", "allow-top-navigation"]) expect(sandbox).not.toContain(missing);
    for (const given of ["allow-scripts", "allow-forms", "allow-modals", "allow-downloads", "allow-popups"]) expect(sandbox.split(" ")).toContain(given);
    // 取东西、连接只许 https:、wss:、data:、blob:，不许 http:（二狗自己在本机 http 上）
    expect(HTML_CSP).not.toMatch(/\bhttp:/);
    // 加的那段只补 target，不碰页面别的东西，也只有 ASCII（不改原文的编码）
    expect(LINKS_IN_NEW_WINDOW).toMatch(/^\n<script>[\x20-\x7e]+<\/script>\n$/);
    expect(LINKS_IN_NEW_WINDOW).toContain('setAttribute("target","_blank")');

    const head = await httpRequest(test.url, HTTP_PATHS.mediaHtml(id), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(frameHeaders(head.headers)).toEqual(frameHeaders(res.headers));
  });

  it("不是 UTF-8 的 HTML（GBK 存的）：照样发出，类型不写 charset（按页面自己的 meta 认）", async () => {
    const test = await startTestDaemon();
    // "日报" 的 GBK 编码
    const gbk = Buffer.concat([Buffer.from('<!doctype html><meta charset="gbk"><h1>'), Buffer.from([0xc8, 0xd5, 0xb1, 0xa8]), Buffer.from("</h1>")]);
    const id = await sendFile(test, gbk, "旧日报.html", "text/html");
    const res = await httpRequest(test.url, HTTP_PATHS.mediaHtml(id));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.headers["content-security-policy"]).toBe(HTML_CSP);
  });

  it("内容接口对 HTML、SVG 只回名字、大小和 frame（不给内容）；part 上类型写成别的，按扩展名认", async () => {
    const test = await startTestDaemon();
    const html = await sendFile(test, REPORT_HTML, "AI 日报.html", "text/html");
    const svg = await sendFile(test, CHART_SVG, "走势图.svg", "text/plain");
    expect((await media.text(test.url, html)).body).toEqual({
      mediaId: html,
      name: "AI 日报.html",
      mime: "text/html",
      text: "",
      bytes: Buffer.byteLength(REPORT_HTML),
      truncated: false,
      sentAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      frame: "html",
    } satisfies MediaTextView);
    expect((await media.text(test.url, svg)).body).toMatchObject({ name: "走势图.svg", text: "", frame: "svg" });
  });

  it("超过 1 MB 的不预览（只能下载）：内容接口和 HTML 接口都回 413，说明大小；刚好 1 MB 的照常预览", async () => {
    const test = await startTestDaemon();
    const big = `<!doctype html><p>${"表".repeat(MEDIA_FRAME_MAX_BYTES / 3)}</p>`;
    const id = await sendFile(test, big, "全年报表.html", "text/html");
    for (const pathname of [HTTP_PATHS.mediaText(id), HTTP_PATHS.mediaHtml(id)]) {
      const res = await httpRequest(test.url, pathname);
      expect({ pathname, status: res.status }).toEqual({ pathname, status: 413 });
      expect(res.json<HttpErrorBody>()).toEqual({ code: "too_large", message: expect.stringContaining("全年报表.html") });
      expect(res.json<HttpErrorBody>().message).toContain("只能下载");
    }
    const exact = `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(MEDIA_FRAME_MAX_BYTES - 46)}</svg>`;
    expect(Buffer.byteLength(exact)).toBe(MEDIA_FRAME_MAX_BYTES);
    const exactId = await sendFile(test, exact, "刚好.svg", "image/svg+xml");
    expect((await httpRequest(test.url, HTTP_PATHS.mediaSvg(exactId))).status).toBe(200);
  });
});

describe("SVG 附件用 <img> 预览", () => {
  it("以 image/svg+xml 原样发出，响应头逐项：default-src 'none'; style-src 'unsafe-inline'; sandbox，nosniff、不许嵌框、不缓存", async () => {
    const test = await startTestDaemon();
    const id = await sendFile(test, CHART_SVG, "走势图.svg", "image/svg+xml");
    const res = await httpRequest(test.url, HTTP_PATHS.mediaSvg(id));
    expect(res.status).toBe(200);
    expect(res.body).toBe(CHART_SVG);
    expect(frameHeaders(res.headers)).toEqual({
      "content-type": "image/svg+xml",
      "content-security-policy": SVG_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "content-disposition": disposition("走势图.svg"),
      "content-length": String(Buffer.byteLength(CHART_SVG)),
    });
  });
});

describe("只按媒体 id 取", () => {
  it("找不到回 404：不是媒体 id、路径样子的、没有这份媒体、库里有但没有消息引用它、消息还在但文件不在了", async () => {
    const test = await startTestDaemon();
    const unsent = await media.upload(test.url, Buffer.from(REPORT_HTML), { name: "草稿.html", mime: "text/html" });
    const gone = await sendFile(test, CHART_SVG.replace("120", "121"), "旧图.svg", "image/svg+xml");
    fs.rmSync(path.join(test.dataDir, "materials", "media", gone));
    const cases: Array<[string, string]> = [
      ["不是媒体 id", HTTP_PATHS.mediaHtml("not-a-media-id")],
      ["路径样子的", "/api/media/..%2F..%2Fconfig%2Fergo.json/html"],
      ["路径样子的（反斜杠）", "/api/media/..%5C..%5Csecrets/svg"],
      ["没有这份媒体", HTTP_PATHS.mediaHtml("0".repeat(64))],
      ["库里有但没有消息引用它", HTTP_PATHS.mediaHtml(unsent.mediaId)],
      ["文件不在了", HTTP_PATHS.mediaSvg(gone)],
    ];
    for (const [what, pathname] of cases) {
      const res = await httpRequest(test.url, pathname);
      expect({ what, status: res.status, code: res.json<HttpErrorBody>().code }).toEqual({ what, status: 404, code: "not_found" });
      // 错误照旧是 JSON，带安全响应头（不会被当成页面打开）
      expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
  });

  it("part 上不是这一种的回 415：Markdown、图片走 HTML 接口，HTML 走 SVG 接口，SVG 走 HTML 接口", async () => {
    const test = await startTestDaemon();
    const md = await sendFile(test, "# 日报\n", "日报.md", "text/markdown");
    const html = await sendFile(test, REPORT_HTML, "AI 日报.html", "text/html");
    const svg = await sendFile(test, CHART_SVG, "走势图.svg", "image/svg+xml");
    const image = await media.upload(test.url, png({ width: 4, height: 4 }), { name: "截图.png", mime: "image/png" });
    appendMessage(test.daemon.store, { conversation: TM1, speaker: "agent", parts: [attachmentPartFrom(image)] });
    for (const [what, pathname] of [
      ["Markdown 走 HTML 接口", HTTP_PATHS.mediaHtml(md)],
      ["图片走 HTML 接口", HTTP_PATHS.mediaHtml(image.mediaId)],
      ["HTML 走 SVG 接口", HTTP_PATHS.mediaSvg(html)],
      ["SVG 走 HTML 接口", HTTP_PATHS.mediaHtml(svg)],
    ] as const) {
      const res = await httpRequest(test.url, pathname);
      expect({ what, status: res.status, code: res.json<HttpErrorBody>().code }).toEqual({ what, status: 415, code: "unsupported_type" });
    }
  });
});

describe("鉴权和来源", () => {
  it("外网端口：没配对的设备取不到（401）；配对过的设备取得到（报告页的框、图都是同源请求，带着设备凭证）", async () => {
    const test = await startTestDaemon();
    const html = await sendFile(test, REPORT_HTML, "AI 日报.html", "text/html");
    const svg = await sendFile(test, CHART_SVG, "走势图.svg", "image/svg+xml");
    for (const pathname of [HTTP_PATHS.mediaHtml(html), HTTP_PATHS.mediaSvg(svg)]) {
      const stranger = await httpRequest(test.externalUrl, pathname);
      expect({ pathname, status: stranger.status, code: stranger.json<HttpErrorBody>().code }).toEqual({ pathname, status: 401, code: "unauthorized" });
    }
    const pc = await TestFrontend.connect(test.url);
    await pc.subscribe({ cards: 0, inbox: 0 });
    const phone = await pairDevice(test.externalUrl, pc, { name: "我的手机" });
    const page = await phone.request(HTTP_PATHS.mediaHtml(html));
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toBe(HTML_CSP);
    expect((await phone.request(HTTP_PATHS.mediaSvg(svg))).headers["content-type"]).toBe("image/svg+xml");
  });

  it("Origin: null（沙箱里的页面发出的请求）：接口请求和 WebSocket 握手在两个端口上都被拒，带着有效的设备凭证也一样", async () => {
    const test = await startTestDaemon();
    const html = await sendFile(test, REPORT_HTML, "AI 日报.html", "text/html");
    const pathnames = [HTTP_PATHS.mediaHtml(html), HTTP_PATHS.mediaText(html), HTTP_PATHS.history("secretary"), HTTP_PATHS.access];
    // 本机端口
    for (const pathname of pathnames) {
      const res = await httpRequest(test.url, pathname, { headers: { origin: "null" } });
      expect({ pathname, status: res.status, code: res.json<HttpErrorBody>().code }).toEqual({ pathname, status: 403, code: "forbidden" });
    }
    await expect(TestFrontend.connect(test.url, { origin: "null" })).rejects.toThrow("HTTP 403");

    // 外网端口：配对过的设备带着有效凭证，Origin 写成 null 也被拒；不带 Origin 照常（对照）
    const pc = await TestFrontend.connect(test.url);
    await pc.subscribe({ cards: 0, inbox: 0 });
    const phone = await pairDevice(test.externalUrl, pc, { name: "我的手机" });
    for (const pathname of pathnames) {
      const res = await phone.request(pathname, { headers: { origin: "null" } });
      expect({ pathname, status: res.status, code: res.json<HttpErrorBody>().code }).toEqual({ pathname, status: 403, code: "forbidden" });
    }
    const cookie = `${DEVICE_COOKIE}=${phone.credential}`;
    await expect(TestFrontend.connect(test.externalUrl, { cookie, origin: "null" })).rejects.toThrow("HTTP 403");
    expect((await phone.request(HTTP_PATHS.mediaHtml(html))).status).toBe(200);
    const fine = await TestFrontend.connect(test.externalUrl, { cookie });
    expect(await fine.subscribe({ secretary: 0 })).toMatchObject({ ok: true });
  });
});

describe("媒体接口原来的规矩不变", () => {
  it("HTML、SVG 照旧作为附件下载（octet-stream、CSP sandbox），不按 part 上的类型发；图片照旧在页面里显示", async () => {
    const test = await startTestDaemon();
    const html = await sendFile(test, REPORT_HTML, "AI 日报.html", "text/html");
    const svg = await sendFile(test, CHART_SVG, "走势图.svg", "image/svg+xml");
    for (const id of [html, svg]) {
      const down = await media.download(test.url, id, { name: "附件" });
      expect(down.headers["content-type"]).toBe("application/octet-stream");
      expect(down.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(down.headers["content-security-policy"]).toContain("sandbox");
      expect(down.headers["x-frame-options"]).toBe("DENY");
    }
    const image = await media.upload(test.url, png({ width: 4, height: 4 }), { name: "截图.png", mime: "image/png" });
    const shown = await media.download(test.url, image.mediaId, { name: "截图.png" });
    expect(shown.headers["content-type"]).toBe("image/png");
    expect(shown.headers["content-disposition"]).toMatch(/^inline;/);
  });
});
