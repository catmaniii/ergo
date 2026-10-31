// 本机的假 OpenAI 兼容服务（自定义服务商这一步）：只听 127.0.0.1，两路——
// - GET /models：回 { data: [{ id, object, owned_by }] }（设置页"列出这个服务商有哪些模型"用它，守护进程直接发这条）；
// - POST /chat/completions：回一段和 OpenAI 一样的流式响应（pi 的 openai-completions 收到它就算连通了）。
// 每次请求记下路径、方法、Authorization 和请求体（断言"请求真的打到这儿、带着 Bearer key"用；断言时别打印 key）。
// unauthorized() 之后一律 401，报错里像真的服务商那样带着 key 的末尾 4 位（测"出错原因里没有 key 的内容"）；
// failModels() 让接下来的 /models 回 500。从不连外网。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

export interface FakeOpenAIRequest {
  method: string;
  path: string;
  /** 请求头里的 Authorization（测 key 确实交给了服务商；断言时别打印它） */
  authorization: string | undefined;
  body: { model?: string; messages?: unknown[]; [key: string]: unknown };
}

export interface FakeOpenAI {
  baseUrl: string;
  requests: FakeOpenAIRequest[];
  /** 之后的请求一律 401（报错里带着请求头里 key 的末尾 4 位） */
  unauthorized(): void;
  /** 接下来的 /models 回 500（报错写 message） */
  failModels(message?: string): void;
  /** 某个模型的补全请求有多少次 */
  countFor(modelId: string): number;
}

/** 流式响应的一片（OpenAI 的 chat.completion.chunk 写法） */
const chunk = (model: string, body: Record<string, unknown>) => `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1_760_000_000, model, ...body })}\n\n`;

/** 一段完整的流式响应：先说一句、带一下用量、最后 [DONE] */
function streamFor(model: string, text: string): string {
  return [
    chunk(model, { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
    chunk(model, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    chunk(model, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
    "data: [DONE]\n\n",
  ].join("");
}

/** 假服务商回的那句话 */
export const FAKE_OPENAI_REPLY = "在的。"; // @i18n-ignore fixed：假服务商回给模型看的话

/** 起一个假 OpenAI 兼容服务：models 是 /models 回的那几个模型 id */
export async function startFakeOpenAI(options: { models?: readonly string[] } = {}): Promise<FakeOpenAI> {
  const models = [...(options.models ?? ["custom-model-1"])];
  const requests: FakeOpenAIRequest[] = [];
  let reject401 = false;
  let modelsFailure: string | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: FakeOpenAIRequest["body"] = {};
      try {
        body = JSON.parse(text) as FakeOpenAIRequest["body"];
      } catch {
        // 不是 JSON 的照样记一条
      }
      const authorization = req.headers.authorization;
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path, authorization, body });
      if (reject401) {
        const last4 = (authorization ?? "").slice(-4);
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ****${last4}`, type: "invalid_request_error", code: "invalid_api_key" } }));
        return;
      }
      // 接口地址一般带着 /v1（baseUrl 是 http://127.0.0.1:<port>/v1），所以按结尾认
      if (path.endsWith("/models")) {
        if (modelsFailure !== undefined) {
          const message = modelsFailure;
          modelsFailure = undefined;
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message, type: "server_error" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "fake" })) }));
        return;
      }
      if (path.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(streamFor(body.model ?? models[0] ?? "custom-model-1", FAKE_OPENAI_REPLY));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `没有这一路：${path}` } }));
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
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    unauthorized: () => {
      reject401 = true;
    },
    failModels: (message = "模拟的出错：这次不回模型列表") => {
      modelsFailure = message;
    },
    countFor: (modelId) => requests.filter((r) => r.body.model === modelId).length,
  };
}
