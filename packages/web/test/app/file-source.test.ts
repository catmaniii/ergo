// 160 号票：内置浏览器渲染文件时怎么取内容——网页的内置浏览器（/apps/… 同源）直接请求，只读开头 1 MB、截在字符边上；
// 按 Content-Type 的字符集解，没写先按 UTF-8、不行再按 GB18030，二进制的（含 NUL）不当文本；响应是网页的不读正文，交回去当网页开。
// 鸿蒙 App 的原生浏览器交来的（页面上的字、拦下的下载的字节 base64）也换成同一种结果。
import { describe, expect, test } from "vitest";
import { decodeFileBytes, fetchFileText, nativeFileText } from "../../src/app/file-source.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("解码", () => {
  test("UTF-8（带 BOM 的去掉 BOM）", () => {
    expect(decodeFileBytes(utf8("# 日报"), undefined, false)).toEqual({ ok: true, text: "# 日报" });
    expect(decodeFileBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hi")]), undefined, false)).toEqual({ ok: true, text: "hi" });
  });

  test("没写字符集、不是 UTF-8 的按 GB18030（国内常见的 GBK 文本）", () => {
    // "中文" 的 GBK 编码
    expect(decodeFileBytes(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), undefined, false)).toEqual({ ok: true, text: "中文" });
  });

  test("写了字符集照它解", () => {
    expect(decodeFileBytes(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), "gbk", false)).toEqual({ ok: true, text: "中文" });
    // 不认得的字符集按没写处理
    expect(decodeFileBytes(utf8("好"), "x-unknown-charset", false)).toEqual({ ok: true, text: "好" });
  });

  test("截断的：最后半个字不算错、丢掉", () => {
    const bytes = utf8("日报");
    expect(decodeFileBytes(bytes.subarray(0, 4), undefined, true)).toEqual({ ok: true, text: "日" });
  });

  test("含 NUL 的是二进制，不当文本", () => {
    expect(decodeFileBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), undefined, false)).toEqual({ ok: false });
  });
});

/** 假的 fetch：回给定的响应，记下请求 */
function fakeFetch(respond: () => Response) {
  const calls: string[] = [];
  const fn = (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return Promise.resolve(respond());
  };
  return { fn: fn as typeof fetch, calls };
}

describe("网页的内置浏览器直接请求（同源的 /apps/…）", () => {
  test("Markdown：取到字、类型、大小", async () => {
    const { fn, calls } = fakeFetch(() => new Response("# 标题\n", { headers: { "content-type": "text/markdown; charset=utf-8", "content-length": "11" } }));
    expect(await fetchFileText(fn, "/apps/notes/README.md")).toEqual({ status: "text", mime: "text/markdown", text: "# 标题\n", bytes: 11, truncated: false });
    expect(calls).toEqual(["/apps/notes/README.md"]);
  });

  test("超过上限只读开头、截在字符边上；一共多少字节按 Content-Length", async () => {
    const body = "日".repeat(10);
    const { fn } = fakeFetch(() => new Response(body, { headers: { "content-type": "text/plain", "content-length": "30" } }));
    expect(await fetchFileText(fn, "/apps/notes/a.txt", undefined, 8)).toEqual({ status: "text", mime: "text/plain", text: "日日", bytes: 30, truncated: true });
  });

  test("一段一段来的（没有 Content-Length）也只读到上限", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(utf8("abcd"));
        if (pulled > 100) controller.close();
      },
    });
    const { fn } = fakeFetch(() => new Response(stream, { headers: { "content-type": "text/plain" } }));
    expect(await fetchFileText(fn, "/apps/notes/a.log", undefined, 10)).toEqual({ status: "text", mime: "text/plain", text: "abcdabcdab", bytes: undefined, truncated: true });
    expect(pulled).toBeLessThan(10);
  });

  test("响应是网页（.md 地址回的 HTML）：不读正文，交回去当网页开", async () => {
    const { fn } = fakeFetch(() => new Response("<html></html>", { headers: { "content-type": "text/html" } }));
    expect(await fetchFileText(fn, "/apps/git/blob/README.md")).toEqual({ status: "page", mime: "text/html" });
  });

  test("一律当下载发的（octet-stream）按扩展名；二进制的说不是文本", async () => {
    const md = fakeFetch(() => new Response("hi", { headers: { "content-type": "application/octet-stream" } }));
    expect(await fetchFileText(md.fn, "/files/a.md")).toMatchObject({ status: "text", mime: "application/octet-stream", text: "hi" });
    const bin = fakeFetch(() => new Response(new Uint8Array([1, 0, 2]), { headers: { "content-type": "application/octet-stream" } }));
    expect(await fetchFileText(bin.fn, "/files/a.txt")).toMatchObject({ status: "error", title: "这不是文本文件" });
  });

  test("服务器回错、连不上：说清楚", async () => {
    const missing = fakeFetch(() => new Response("nope", { status: 404 }));
    expect(await fetchFileText(missing.fn, "/apps/notes/gone.md")).toMatchObject({ status: "error", title: "这个文件不在了" });
    const broken = fakeFetch(() => new Response("oops", { status: 502 }));
    expect(await fetchFileText(broken.fn, "/apps/notes/a.md")).toMatchObject({ status: "error", title: "取文件失败", detail: expect.stringContaining("502") });
    const offline = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    expect(await fetchFileText(offline, "/apps/notes/a.md")).toMatchObject({ status: "error", title: "取文件失败" });
  });
});

describe("鸿蒙 App 交来的", () => {
  test("页面上的字（浏览器已经解好了）：大小按 UTF-8 算，截断了的不知道一共多大", () => {
    expect(nativeFileText(JSON.stringify({ ok: true, kind: "text", mime: "text/plain", text: "日报", total: 2, truncated: false }), "text/plain")).toEqual({ status: "text", mime: "text/plain", text: "日报", bytes: 6, truncated: false });
    expect(nativeFileText(JSON.stringify({ ok: true, kind: "text", mime: "text/markdown", text: "ab", total: 9, truncated: true }), "text/markdown")).toEqual({ status: "text", mime: "text/markdown", text: "ab", bytes: undefined, truncated: true });
  });

  test("拦下的下载：字节（base64）按同样的规矩解", () => {
    const base64 = btoa(String.fromCharCode(...utf8("# 标题")));
    expect(nativeFileText(JSON.stringify({ ok: true, kind: "bytes", base64, total: 9, truncated: false }), "application/octet-stream")).toEqual({ status: "text", mime: "application/octet-stream", text: "# 标题", bytes: 9, truncated: false });
    const binary = btoa(String.fromCharCode(0x50, 0x4b, 0x00));
    expect(nativeFileText(JSON.stringify({ ok: true, kind: "bytes", base64: binary, total: 3, truncated: false }), "text/plain")).toMatchObject({ status: "error", title: "这不是文本文件" });
  });

  test("App 说取不到、回的不对：说清楚", () => {
    expect(nativeFileText(JSON.stringify({ ok: false, reason: "网页已经换了" }), "text/plain")).toMatchObject({ status: "error", detail: expect.stringContaining("网页已经换了") });
    expect(nativeFileText("", "text/plain")).toMatchObject({ status: "error", title: "取文件失败" });
  });
});
