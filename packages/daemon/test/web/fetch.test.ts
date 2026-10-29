// 读网页的逻辑（70 号票，照搬用户 web-search skill 的 fetch.mjs）：假的直接请求和假的浏览器驱动，不联网。
// 先直接请求；403、429、5xx、别的不成功、网络出错、超时时改用浏览器；JSON、纯文本原样，网页抽正文；超过 max 截断并注明原长；
// 直接请求的正文只读到上限（评审后定）。
import { describe, expect, it } from "vitest";
import { DIRECT_MAX_BYTES, DIRECT_TIMEOUT_MS, decodeEntities, FetchFailed, type FetchFunction, type FetchResponse, htmlToText, readCapped, truncate, webFetch } from "../../src/web/index.ts";
import { FakeBrowser } from "../helpers/web.ts";

const PAGE = `<!doctype html><html><head><title>示例 &amp; 页面</title><style>.x{}</style><script>alert(1)</script></head>
<body><nav>导航</nav><h1>标题</h1><p>第一段&nbsp;文字&#x4E2D;&#20013;</p><div>第二段<br>换行</div><!-- 注释 --><footer>页脚</footer></body></html>`;

function response(status: number, body: string, contentType = "text/html; charset=utf-8"): FetchResponse {
  return { ok: status >= 200 && status < 300, status, headers: { get: (n) => (n.toLowerCase() === "content-type" ? contentType : null) }, text: async () => body };
}

/** 假的直接请求：记下请求，按给的回（抛错就是网络出错） */
function fakeFetch(reply: () => FetchResponse): { fetch: FetchFunction; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return reply();
    },
  };
}

const noBrowser = () => new FakeBrowser(() => undefined, { unavailable: "找不到浏览器（Chrome 或 Edge）" });

/** 假的直接请求：一直不回，直到被中止（超时或调用方中止），按中止的原因出错 */
const hanging: FetchFunction = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
  });

describe("正文抽取（照 skill）", () => {
  it("去掉脚本、样式、head、导航、页脚、注释，块级标签换行，实体换回", () => {
    const { title, text } = htmlToText(PAGE);
    expect(title).toBe("示例 & 页面");
    expect(text).toBe("标题\n第一段 文字中中\n第二段\n换行");
    expect(decodeEntities("&lt;a&gt; &quot;b&quot; &#39;c&#x27; &#99999999;")).toBe(`<a> "b" 'c' `);
  });

  it("超过 max 截断，注明原长", () => {
    expect(truncate("12345", 5)).toBe("12345");
    expect(truncate("123456", 5)).toBe("12345\n\n…[已截断，共 6 字，要看更多把 max 调大]");
  });
});

describe("读网页", () => {
  it("直接请求成功的网页：抽正文，带上网址和标题；照 skill 的浏览器标识；不起浏览器", async () => {
    const direct = fakeFetch(() => response(200, PAGE));
    const browser = noBrowser();
    const page = await webFetch({ fetch: direct.fetch, browser }, { url: "https://example.com/a", max: 8000 });
    expect(page).toEqual({ via: "direct", text: "URL: https://example.com/a\n标题: 示例 & 页面\n\n标题\n第一段 文字中中\n第二段\n换行" });
    expect(direct.calls[0]!.headers["User-Agent"]).toContain("Chrome/131");
  });

  it("JSON、纯文本原样交回，带内容类型", async () => {
    const direct = fakeFetch(() => response(200, '{"a":1}', "application/json"));
    const page = await webFetch({ fetch: direct.fetch, browser: noBrowser() }, { url: "https://api.example.com/x", max: 8000 });
    expect(page.text).toBe('URL: https://api.example.com/x\nContent-Type: application/json\n\n{"a":1}');
  });

  it("超过 max：截断", async () => {
    const direct = fakeFetch(() => response(200, "x".repeat(100), "text/plain"));
    const page = await webFetch({ fetch: direct.fetch, browser: noBrowser() }, { url: "https://example.com/t", max: 80 });
    expect(page.text).toMatch(/^URL: https:\/\/example\.com\/t\nContent-Type: text\/plain\n\nx+\n\n…\[已截断，共 \d+ 字，要看更多把 max 调大\]$/);
    expect(page.text.split("\n\n…")[0]!.length).toBe(80);
  });

  for (const [name, reply] of [
    ["被 403 拦了", () => response(403, "forbidden")],
    ["被 429 限流", () => response(429, "slow down")],
    ["服务器出错", () => response(503, "oops")],
    ["别的不成功（404）", () => response(404, "nope")],
    [
      "网络出错",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ] as const) {
    it(`${name}：改用浏览器，正文照样抽，带上 HTTP 状态`, async () => {
      const browser = new FakeBrowser((url) => (url === "https://example.com/b" ? { status: 200, title: "浏览器里的标题", html: PAGE } : undefined));
      const page = await webFetch({ fetch: fakeFetch(reply).fetch, browser }, { url: "https://example.com/b", max: 8000 });
      expect(page.via).toBe("browser");
      expect(page.text).toBe("URL: https://example.com/b\nHTTP: 200\n标题: 浏览器里的标题\n\n标题: 示例 & 页面\n\n标题\n第一段 文字中中\n第二段\n换行");
      expect(browser.visited).toEqual(["https://example.com/b"]);
    });
  }

  it("浏览器打开超时：照样取已经渲染出来的内容（HTTP 记 0）", async () => {
    const browser = new FakeBrowser(() => ({ error: "Timeout 30000ms exceeded", title: "半截", html: "<p>已经渲染的</p>" }));
    const page = await webFetch({ fetch: fakeFetch(() => response(403, "")).fetch, browser }, { url: "https://example.com/c", max: 8000 });
    expect(page.text).toBe("URL: https://example.com/c\nHTTP: 0\n标题: 半截\n\n标题: \n\n已经渲染的");
  });

  it("直接请求被拦、浏览器又用不了：说清楚两样", async () => {
    const err = await webFetch({ fetch: fakeFetch(() => response(403, "")).fetch, browser: noBrowser() }, { url: "https://example.com/d", max: 8000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchFailed);
    expect((err as Error).message).toBe("没读到 https://example.com/d：直接请求回了 HTTP 403；找不到浏览器（Chrome 或 Edge）");
  });

  it("直接请求超时（连上、读正文一起算）：按网络出错算，改用浏览器；默认 20 秒", async () => {
    expect(DIRECT_TIMEOUT_MS).toBe(20_000);
    const logs: string[] = [];
    const browser = new FakeBrowser(() => ({ status: 200, title: "t", html: "<p>浏览器读到的</p>" }));
    const page = await webFetch({ fetch: hanging, browser }, { url: "https://example.com/slow", max: 8000 }, { limits: { timeoutMs: 30, maxBytes: DIRECT_MAX_BYTES }, log: (l) => logs.push(l) });
    expect(page.via).toBe("browser");
    expect(logs).toEqual(["读网页 https://example.com/slow：直接请求超时（0 秒），改用浏览器"]);
    const err = await webFetch({ fetch: hanging, browser: noBrowser() }, { url: "https://example.com/slow", max: 8000 }, { limits: { timeoutMs: 30, maxBytes: 1 } }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^没读到 https:\/\/example\.com\/slow：直接请求超时/);
  });

  it("调用方中止（不是超时）：不改用浏览器，照样中止", async () => {
    const controller = new AbortController();
    const browser = new FakeBrowser(() => ({ status: 200, title: "t", html: "<p>x</p>" }));
    const pending = webFetch({ fetch: hanging, browser }, { url: "https://example.com/x", max: 8000 }, { signal: controller.signal });
    controller.abort(new Error("用户打断"));
    await expect(pending).rejects.toThrow(/用户打断/);
    expect(browser.visited).toEqual([]);
  });

  it("正文只读到上限（默认 5 MB）：读到就停、关掉流，注明只读了前面", async () => {
    expect(DIRECT_MAX_BYTES).toBe(5 * 1024 * 1024);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("abcdefgh"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res: FetchResponse = { ...response(200, "", "text/plain"), body };
    const page = await webFetch({ fetch: async () => res, browser: noBrowser() }, { url: "https://example.com/big", max: 8000 }, { limits: { timeoutMs: 1000, maxBytes: 20 } });
    expect(page.text).toBe("URL: https://example.com/big\nContent-Type: text/plain\n\nabcdefghabcdefghabcd\n\n…[网页超过 20 字节，只读了前面这些]");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
    // 没有流的（只有 text()）读了再截；不到上限的原样
    expect(await readCapped({ text: async () => "一二三四" }, 6)).toEqual({ body: "一二", capped: true });
    expect(await readCapped({ text: async () => "abc" }, 6)).toEqual({ body: "abc", capped: false });
  });
});
