// 本机的假 DeepSeek 联网搜索、读网页接口（154 号票）：一个只听 127.0.0.1 临时端口的服务，测试里 Search（/v1/tools/search）、
// Fetch（/v1/tools/fetch）的请求都发到这里（createDeepSeekTools 的 baseUrl），从不连真的 DeepSeek、不用真 key。
// 每次请求记下路径、Authorization、解析好的请求体和收到的时间；回什么由测试给的剧本定（按路径、第几次），不给按"照常回"：
// 搜索回两条结果，读网页回一段 Markdown。剧本里给 hang 的请求一直不回（测超时），给 drop 的直接断开连接（测网络出错）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

export interface FakeToolsRequest {
  kind: "search" | "fetch" | "other";
  /** 请求头里的 Authorization（测 key 确实交过去了；断言时别打印真 key——测试里一律是假的） */
  authorization: string | undefined;
  body: Record<string, unknown>;
  /** 收到的时间（Date.now()），测限速用 */
  at: number;
}

/** 一次回什么：状态码和 JSON（error 是 DeepSeek 兼容 OpenAI 的 error 对象），或者一直不回、直接断开 */
export type FakeToolsReply = { status: number; json?: unknown; headers?: Record<string, string> } | { hang: true } | { drop: true };

export interface FakeDeepSeekTools {
  baseUrl: string;
  requests: FakeToolsRequest[];
  /** 按种类数请求 */
  count(kind: "search" | "fetch"): number;
}

/** 照常回的搜索结果（两条，字段照 DeepSeek 文档） */
export const FAKE_SEARCH_RESULTS = [
  {
    rerank_score: 2.4,
    title: "DeepSeek V4 发布",
    url: "https://news.example/deepseek-v4",
    snippet: "短摘要一",
    summary: "长摘要一：DeepSeek 发布了 V4 模型。",
    content: "",
    site_name: "新闻站",
    site_icon: "https://news.example/favicon.ico",
    date: "2026-06-01T00:00:00+00:00",
    authority: 3,
  },
  {
    rerank_score: 0.9,
    title: "某论坛的讨论",
    url: "https://forum.example/t/1",
    snippet: "短摘要二",
    summary: "",
    content: "",
    site_name: null,
    site_icon: null,
    date: null,
    authority: -1,
  },
];

/** 照常回的读网页结果 */
export const FAKE_FETCH_RESULT = { title: "示例文章", content: "# 示例文章\n\n第一段正文。\n\n第二段正文。" };

/** DeepSeek 的出错响应体 */
export const deepseekError = (message: string, code = "invalid_request_error") => ({ error: { message, type: code, param: null, code } });

export async function startFakeDeepSeekTools(script: (request: FakeToolsRequest, nth: number) => FakeToolsReply | undefined = () => undefined): Promise<FakeDeepSeekTools> {
  const requests: FakeToolsRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        // 不是 JSON 的照样记一条
      }
      const path = req.url ?? "";
      const kind = path === "/v1/tools/search" && req.method === "POST" ? "search" : path === "/v1/tools/fetch" && req.method === "POST" ? "fetch" : "other";
      const request: FakeToolsRequest = { kind, authorization: req.headers.authorization, body, at: Date.now() };
      requests.push(request);
      const nth = requests.filter((r) => r.kind === kind).length;
      const reply = script(request, nth) ?? (kind === "search" ? { status: 200, json: { results: FAKE_SEARCH_RESULTS } } : kind === "fetch" ? { status: 200, json: FAKE_FETCH_RESULT } : { status: 404, json: deepseekError("没有这个接口") });
      if ("hang" in reply) return;
      if ("drop" in reply) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(reply.json === undefined ? "" : JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    count: (kind) => requests.filter((r) => r.kind === kind).length,
  };
}
