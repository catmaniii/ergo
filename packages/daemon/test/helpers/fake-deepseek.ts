// 本机的假 DeepSeek（73 号票）：一个只听 127.0.0.1 的 chat completions 服务，测试里目录模型的请求都发到这里
// （CatalogModelSpec.baseUrl；主切面经 startTestDaemon 的 catalogBaseUrl），从不连真的 DeepSeek。
// 每次请求记下请求体（解析好的 JSON：model、thinking、max_tokens……），默认回一段录好的流式响应（DeepSeek 的格式，带用量）；
// unauthorized() 之后一律回 401，报错里像 DeepSeek 那样带着 key 的末尾几位（测"出错原因里没有 key 的内容"）；
// hold() 之后的请求记下但先不回（测连通测试同一时间只跑一个、超时），release() 再照常回。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import { DEEPSEEK_STREAM } from "../fixtures/provider-usage-streams.ts";

export interface FakeDeepSeekRequest {
  path: string;
  /** 请求头里的 Authorization（测 key 确实交给了 provider；断言时别打印它） */
  authorization: string | undefined;
  body: { model?: string; thinking?: { type?: string }; max_tokens?: number; messages?: unknown[]; [key: string]: unknown };
}

export interface FakeDeepSeek {
  baseUrl: string;
  requests: FakeDeepSeekRequest[];
  /** 之后的请求一律回 401（报错里带着请求头里 key 的末尾 4 位，像 DeepSeek 那样） */
  unauthorized(): void;
  /** 某个模型的请求有多少次 */
  countFor(modelId: string): number;
  /** 之后的请求记下但先不回 */
  hold(): void;
  /** 照常回压着的请求，之后也不再压 */
  release(): void;
}

/** 照常回：录好的流式响应 */
function answer(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(DEEPSEEK_STREAM.body);
}

export async function startFakeDeepSeek(): Promise<FakeDeepSeek> {
  const requests: FakeDeepSeekRequest[] = [];
  let reject401 = false;
  let holding = false;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: FakeDeepSeekRequest["body"] = {};
      try {
        body = JSON.parse(text) as FakeDeepSeekRequest["body"];
      } catch {
        // 不是 JSON 的照样记一条
      }
      const authorization = req.headers.authorization;
      requests.push({ path: req.url ?? "", authorization, body });
      if (reject401) {
        const last4 = (authorization ?? "").slice(-4);
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Authentication Fails, Your api key: ****${last4} is invalid`, type: "authentication_error", param: null, code: "invalid_request_error" } }));
        return;
      }
      if (holding) held.push(res);
      else answer(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 压着没回的连接一并断开，不然 close 等不到
        server.closeAllConnections();
      }),
  );
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    unauthorized: () => {
      reject401 = true;
    },
    countFor: (modelId) => requests.filter((r) => r.body.model === modelId).length,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const res of held.splice(0)) answer(res);
    },
  };
}

/** 假 DeepSeek 回的那句话 */
export const FAKE_DEEPSEEK_REPLY = DEEPSEEK_STREAM.text;
