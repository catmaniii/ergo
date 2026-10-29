// DeepSeek 的联网搜索（Search）、读网页（Fetch）接口（154 号票）：本机临时端口上的假 DeepSeek（base URL 可配），不连真网络、不用真 key。
// - 请求：POST /v1/tools/search（query、count）、/v1/tools/fetch（url），Bearer 用 DeepSeek 的 key（和模型共用，每次现取）；
// - 选项映射：n → count（最多 50）、time → 查询后面加 after:日期、region → lang:（对不上的不加）、查询超过 128 字不发请求；
// - 结果：标题、地址、短摘要、长摘要、日期、站点、相关度、权威度，原样的字段留给 json；
// - 出错：没 key 不发请求；402 余额不足不重试（记下时间，之后成功一次就清掉）；408、429、5xx 等一下重试，最多两次；
//   别的 4xx 不重试；Fetch 的 403、404 写明原因；没结果、没正文算没成（DeepSeek 也不计费）；超时、连不上；调用方中止照样中止；
// - 限速：Search、Fetch 各一个账号级的限速器（每秒 5 次），所有调用共用，两种互不占。
import { nowIso } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createDeepSeekTools, createRateLimiter, DEEPSEEK_COUNT_MAX, DEEPSEEK_QUERY_MAX, DeepSeekFailed, deepseekLang, deepseekQuery } from "../../src/web/index.ts";
import { deepseekError, FAKE_FETCH_RESULT, FAKE_SEARCH_RESULTS, type FakeToolsReply, startFakeDeepSeekTools } from "../helpers/fake-deepseek-tools.ts";

const NOW = new Date(2026, 9, 18, 10, 30);
const KEY = "sk-fake-for-tests";

/** 指向假服务的客户端：重试不等、时钟固定 */
function client(baseUrl: string, options: { key?: string | undefined; timeoutMs?: number; log?: string[] } = {}) {
  return createDeepSeekTools({
    key: () => ("key" in options ? options.key : KEY),
    baseUrl,
    retryDelaysMs: [0, 0],
    now: () => NOW,
    ...(options.timeoutMs === undefined ? {} : { timeouts: { searchMs: options.timeoutMs, fetchMs: options.timeoutMs } }),
    log: (line) => options.log?.push(line),
  });
}

/** 按次回：第 n 次（从 1 起）回 replies[n-1]，超出的照常回 */
const sequence =
  (...replies: FakeToolsReply[]) =>
  (_request: unknown, nth: number) =>
    replies[nth - 1];

const failure = (err: unknown) => err as DeepSeekFailed;

describe("选项映射", () => {
  it("time → 查询后面加 after:日期（一天、一周、一个月、一年前的本地日期）", () => {
    expect(deepseekQuery({ query: "二狗", n: 8 }, NOW)).toBe("二狗");
    expect(deepseekQuery({ query: "二狗", n: 8, time: "d" }, NOW)).toBe("二狗 after:2026-10-17");
    expect(deepseekQuery({ query: "二狗", n: 8, time: "w" }, NOW)).toBe("二狗 after:2026-10-11");
    expect(deepseekQuery({ query: "二狗", n: 8, time: "m" }, NOW)).toBe("二狗 after:2026-09-18");
    expect(deepseekQuery({ query: "二狗", n: 8, time: "y" }, NOW)).toBe("二狗 after:2025-10-18");
  });

  it("region → lang:（cn-zh、zh-CN 是 zh，us-en、en-us 是 en；对不上的不加）；查询里自己写了 after:、lang: 的不再加", () => {
    expect(deepseekLang("cn-zh")).toBe("zh");
    expect(deepseekLang("zh-CN")).toBe("zh");
    expect(deepseekLang("us-en")).toBe("en");
    expect(deepseekLang("en-us")).toBe("en");
    expect(deepseekLang("jp-ja")).toBe("ja");
    expect(deepseekLang("fr")).toBe("fr");
    expect(deepseekLang("wt-wt")).toBeUndefined();
    expect(deepseekLang("xx-yy")).toBeUndefined();
    expect(deepseekQuery({ query: "二狗", n: 8, time: "w", region: "cn-zh" }, NOW)).toBe("二狗 after:2026-10-11 lang:zh");
    expect(deepseekQuery({ query: "二狗", n: 8, region: "wt-wt" }, NOW)).toBe("二狗");
    expect(deepseekQuery({ query: "二狗 after:2020 lang:en", n: 8, time: "w", region: "cn-zh" }, NOW)).toBe("二狗 after:2020 lang:en");
  });

  it(`查询（加上 after:、lang: 以后）超过 ${DEEPSEEK_QUERY_MAX} 字：不发请求，说明原因`, async () => {
    const server = await startFakeDeepSeekTools();
    const long = "字".repeat(DEEPSEEK_QUERY_MAX);
    expect(deepseekQuery({ query: long, n: 8 }, NOW)).toBe(long);
    const err = await client(server.baseUrl)
      .search({ query: long, n: 8, time: "w" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeepSeekFailed);
    expect(failure(err).problem).toBe("too_long");
    expect(failure(err).message).toBe(`查询加上时间、语言的条件后超过 ${DEEPSEEK_QUERY_MAX} 字`);
    expect(server.requests).toEqual([]);
  });
});

describe("联网搜索", () => {
  it("POST /v1/tools/search，Bearer 是 DeepSeek 的 key；n 是 count（最多 50）；结果的字段都取到，原样的留着", async () => {
    const server = await startFakeDeepSeekTools();
    const found = await client(server.baseUrl).search({ query: "DeepSeek V4", n: 8, time: "w", region: "cn-zh" });
    expect(server.requests).toEqual([{ kind: "search", authorization: `Bearer ${KEY}`, body: { query: "DeepSeek V4 after:2026-10-11 lang:zh", count: 8 }, at: expect.any(Number) }]);
    expect(found).toEqual({
      engine: "deepseek",
      query: "DeepSeek V4 after:2026-10-11 lang:zh",
      results: [
        { title: "DeepSeek V4 发布", url: "https://news.example/deepseek-v4", snippet: "短摘要一", summary: "长摘要一：DeepSeek 发布了 V4 模型。", date: "2026-06-01", site: "新闻站", score: 2.4, authority: 3 },
        { title: "某论坛的讨论", url: "https://forum.example/t/1", snippet: "短摘要二", score: 0.9 },
      ],
      raw: FAKE_SEARCH_RESULTS,
    });
    await client(server.baseUrl).search({ query: "x", n: 80 });
    expect(server.requests[1]!.body).toEqual({ query: "x", count: DEEPSEEK_COUNT_MAX });
    const one = await client(server.baseUrl).search({ query: "x", n: 1 });
    expect(server.requests[2]!.body).toEqual({ query: "x", count: 1 });
    expect(one.results).toHaveLength(1);
  });

  it("没结果：算没搜成（DeepSeek 也不计费）", async () => {
    const server = await startFakeDeepSeekTools(() => ({ status: 200, json: { results: [] } }));
    const err = await client(server.baseUrl)
      .search({ query: "x", n: 8 })
      .catch((e: unknown) => e);
    expect(failure(err).problem).toBe("empty");
    expect(failure(err).message).toBe("DeepSeek 没搜到结果");
  });

  it("没配 key：不发请求，说清楚 key 从哪来（和模型共用）", async () => {
    const server = await startFakeDeepSeekTools();
    const tools = client(server.baseUrl, { key: undefined });
    expect(tools.available()).toBe(false);
    const err = await tools.search({ query: "x", n: 8 }).catch((e: unknown) => e);
    expect(failure(err).problem).toBe("no_key");
    expect(failure(err).message).toMatch(/^没配 DeepSeek 的 key（环境变量 DEEPSEEK_API_KEY，和模型共用/);
    expect(server.requests).toEqual([]);
  });
});

describe("读网页", () => {
  it("POST /v1/tools/fetch { url }：回标题和 Markdown 正文", async () => {
    const server = await startFakeDeepSeekTools();
    const page = await client(server.baseUrl).fetch("https://a.example/article");
    expect(page).toEqual(FAKE_FETCH_RESULT);
    expect(server.requests).toEqual([{ kind: "fetch", authorization: `Bearer ${KEY}`, body: { url: "https://a.example/article" }, at: expect.any(Number) }]);
  });

  it("403 被安全策略拒绝、404 没取到正文、回了空正文：写明原因，不重试", async () => {
    const cases: [FakeToolsReply, string, string][] = [
      [{ status: 403, json: deepseekError("blocked by policy") }, "rejected", "被 DeepSeek 的安全策略拒绝（HTTP 403：blocked by policy）"],
      [{ status: 404, json: deepseekError("no content") }, "no_content", "DeepSeek 没取到可用的正文（HTTP 404：no content）"],
      [{ status: 200, json: { title: "空的", content: "  " } }, "no_content", "DeepSeek 没取到正文"],
    ];
    for (const [reply, problem, message] of cases) {
      const server = await startFakeDeepSeekTools(() => reply);
      const err = await client(server.baseUrl)
        .fetch("https://a.example/")
        .catch((e: unknown) => e);
      expect(failure(err).problem).toBe(problem);
      expect(failure(err).message).toBe(message);
      expect(server.count("fetch")).toBe(1);
    }
  });
});

describe("出错和重试", () => {
  it("402 余额不足：不重试，记下时间（设置页上看得到）；之后成功一次就清掉", async () => {
    let broke = true;
    const server = await startFakeDeepSeekTools(() => (broke ? { status: 402, json: deepseekError("Insufficient Balance") } : undefined));
    const log: string[] = [];
    const tools = client(server.baseUrl, { log });
    const err = await tools.search({ query: "x", n: 8 }).catch((e: unknown) => e);
    expect(failure(err).problem).toBe("balance");
    expect(failure(err).message).toBe("DeepSeek 余额不足（HTTP 402：Insufficient Balance）");
    expect(server.count("search")).toBe(1);
    expect(tools.balanceLowAt()).toBe(nowIso(NOW));
    expect(log).toContain("DeepSeek 联网搜索：DeepSeek 余额不足（HTTP 402：Insufficient Balance）");
    broke = false;
    await tools.fetch("https://a.example/");
    expect(tools.balanceLowAt()).toBeUndefined();
  });

  it("429、408、5xx：等一下重试，最多两次；第三次成了就算成", async () => {
    for (const status of [429, 408, 500, 503]) {
      const server = await startFakeDeepSeekTools(sequence({ status, json: deepseekError("busy") }, { status, json: deepseekError("busy") }));
      const found = await client(server.baseUrl).search({ query: "x", n: 8 });
      expect(found.engine).toBe("deepseek");
      expect(server.count("search")).toBe(3);
    }
  });

  it("重试两次还是 429、5xx：说明重试过；别的 4xx（400、401）不重试", async () => {
    const cases: [number, string, string, number][] = [
      [429, "rate_limited", "DeepSeek 限速（HTTP 429：busy），重试 2 次还是不行", 3],
      [504, "server", "DeepSeek 服务出错（HTTP 504：busy），重试 2 次还是不行", 3],
      [400, "bad_request", "DeepSeek 不收这个请求（HTTP 400：busy）", 1],
      [401, "key_invalid", "DeepSeek 的 key 不对（HTTP 401：busy）", 1],
    ];
    for (const [status, problem, message, requests] of cases) {
      const server = await startFakeDeepSeekTools(() => ({ status, json: deepseekError("busy") }));
      const err = await client(server.baseUrl)
        .search({ query: "x", n: 8 })
        .catch((e: unknown) => e);
      expect(failure(err).problem).toBe(problem);
      expect(failure(err).message).toBe(message);
      expect(failure(err).status).toBe(status);
      expect(server.count("search")).toBe(requests);
    }
  });

  it("超时、连不上：说清楚，不重试；调用方中止：照样中止，不当成 DeepSeek 没成", async () => {
    const hang = await startFakeDeepSeekTools(() => ({ hang: true }));
    const slow = await client(hang.baseUrl, { timeoutMs: 100 })
      .search({ query: "x", n: 8 })
      .catch((e: unknown) => e);
    expect(failure(slow).problem).toBe("timeout");
    expect(failure(slow).message).toBe("DeepSeek 没在 1 秒内回（超时）");
    expect(hang.count("search")).toBe(1);

    const drop = await startFakeDeepSeekTools(() => ({ drop: true }));
    const down = await client(drop.baseUrl)
      .fetch("https://a.example/")
      .catch((e: unknown) => e);
    expect(failure(down).problem).toBe("network");
    expect(failure(down).message).toMatch(/^连不上 DeepSeek（/);

    const controller = new AbortController();
    const pending = client(hang.baseUrl).search({ query: "x", n: 8 }, controller.signal);
    controller.abort(new Error("用户停了"));
    const aborted = await pending.catch((e: unknown) => e);
    expect(aborted).not.toBeInstanceOf(DeepSeekFailed);
    expect((aborted as Error).message).toBe("用户停了");
  });
});

describe("限速（账号级，每秒 5 次）", () => {
  it("一秒里第 6 次等到第 1 次满一秒；排着的按先后", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const limiter = createRateLimiter({
      perSecond: 5,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    const order: number[] = [];
    await Promise.all(Array.from({ length: 7 }, (_, i) => limiter.take().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(sleeps).toEqual([1000]);
    // 第 6、7 次在 1000 毫秒时放行；1400 毫秒时再放三次就满了，第四次等到 2000 毫秒
    t += 400;
    await Promise.all([limiter.take(), limiter.take(), limiter.take()]);
    expect(sleeps).toEqual([1000]);
    await limiter.take();
    expect(sleeps).toEqual([1000, 600]);
  });

  it("客户端里搜索、读网页各一个限速器，所有调用共用：6 次搜索里最后一次要等，读网页不受搜索影响", async () => {
    const server = await startFakeDeepSeekTools();
    let t = 0;
    const sleeps: number[] = [];
    const tools = createDeepSeekTools({
      key: () => KEY,
      baseUrl: server.baseUrl,
      retryDelaysMs: [0, 0],
      now: () => NOW,
      clock: {
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
      },
      log: () => undefined,
    });
    await Promise.all(Array.from({ length: 5 }, () => tools.search({ query: "x", n: 2 })));
    await Promise.all(Array.from({ length: 5 }, () => tools.fetch("https://a.example/")));
    expect(sleeps).toEqual([]);
    await tools.search({ query: "x", n: 2 });
    expect(sleeps).toEqual([1000]);
    expect(server.count("search")).toBe(6);
    expect(server.count("fetch")).toBe(5);
  });
});
