// 本机的假模型服务（只在测试里）：只听 127.0.0.1 的临时端口，说 Codex 要的 Responses API（POST /v1/responses，流式 SSE），按剧本吐文字和工具调用。
// 让真的 codex 程序连它（real-codex-env.ts 的 -c model_providers.*），不花钱、不需要登录。协议以本机 codex 0.166 实际发的请求为准（test/codex/real-codex.test.ts 记着）。
// 每个请求原样记下：测试据此核对"模型收到了什么"（工具清单、工具结果、上下文里有没有被切掉的内容）。
import http from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

/** 一次模型回复里的一条输出 */
export type ModelOutput =
  /** 一段文字 */
  | { kind: "text"; text: string }
  /** 一段思考摘要 */
  | { kind: "reasoning"; text: string }
  /** 函数调用：exec_command、mcp__ergo__x……（arguments 是 JSON 对象） */
  | { kind: "call"; name: string; args: Json; callId?: string }
  /** 自由格式调用（apply_patch 的 custom 工具：input 是补丁正文） */
  | { kind: "custom"; name: string; input: string; callId?: string }
  /** 模型服务那边做的联网搜索 */
  | { kind: "web_search"; query: string; id?: string }
  /** 任意一条 Responses 的输出（剧本要吐协议里别的东西时） */
  | { kind: "raw"; item: Json };

export interface ModelUsage {
  input?: number;
  cached?: number;
  output?: number;
}

/** 一次回复；fail：这一次回 HTTP 出错（测模型服务出错） */
export interface ModelReply {
  outputs?: ModelOutput[];
  usage?: ModelUsage;
  fail?: { status: number; message: string; type?: string };
  /** 流走到一半不结束，等 release()（测打断） */
  hold?: boolean;
}

/** 回复可以按请求算（看到什么回什么） */
export type ModelTurn = ModelReply | ((request: ModelRequest) => ModelReply);

export interface ModelRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Json;
}

const sse = (event: string, data: Json) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

/** 一条 Responses 输入里的文字（message 的 content、工具结果的 output） */
export function textOfInputItem(item: unknown): string {
  if (typeof item !== "object" || item === null) return "";
  const entry = item as { content?: unknown; output?: unknown; arguments?: unknown; input?: unknown };
  const pieces: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") pieces.push(value);
    else if (Array.isArray(value)) for (const v of value) collect(v);
    else if (typeof value === "object" && value !== null) {
      const v = value as { text?: unknown; content?: unknown };
      if (typeof v.text === "string") pieces.push(v.text);
      else collect(v.content);
    }
  };
  collect(entry.content);
  collect(entry.output);
  collect(entry.arguments);
  collect(entry.input);
  return pieces.join("\n");
}

export class FakeResponsesModel {
  /** 收到的每个请求（/responses 的、别的都记） */
  readonly requests: ModelRequest[] = [];
  /** 优先按它回（子代理的请求和主线的混着来，按请求分；回 undefined 的再按剧本走） */
  route: ((request: ModelRequest) => ModelReply | undefined) | undefined;
  /** 没用完的剧本 */
  private script: ModelTurn[] = [];
  private seq = 0;
  private readonly held = new Set<() => void>();
  private readonly server: http.Server;
  private port = 0;

  constructor() {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** 接下来按这些回（追加在没用完的后面）；用完了回一句"剧本用完了" */
  queue(...turns: ModelTurn[]): void {
    this.script.push(...turns);
  }

  /** 发给模型的（POST /responses） */
  get turns(): ModelRequest[] {
    return this.requests.filter((r) => r.method === "POST" && r.path.endsWith("/responses"));
  }

  /** 最近一次发给模型的 */
  get last(): ModelRequest {
    const last = this.turns.at(-1);
    if (!last) throw new Error("假模型还没收到过请求");
    return last;
  }

  /** 放开 hold 着的回复 */
  release(): void {
    for (const go of this.held) go();
  }

  async close(): Promise<void> {
    this.release();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Json = {};
      try {
        body = raw ? (JSON.parse(raw) as Json) : {};
      } catch {
        body = { unparsed: raw };
      }
      const request: ModelRequest = { method: req.method ?? "", path: (req.url ?? "").split("?")[0] ?? "", headers: req.headers, body };
      this.requests.push(request);
      if (request.method === "POST" && request.path.endsWith("/responses")) return void this.respond(request, res);
      if (request.path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ models: [], data: [], object: "list" }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `假模型没有 ${request.path}` } }));
    });
  }

  private async respond(request: ModelRequest, res: http.ServerResponse): Promise<void> {
    const routed = this.route?.(request);
    const next = routed ?? this.script.shift() ?? { outputs: [{ kind: "text", text: "（假模型的剧本用完了）" }] };
    const reply = typeof next === "function" ? next(request) : next;
    if (reply.fail) {
      res.writeHead(reply.fail.status, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: { message: reply.fail.message, type: reply.fail.type ?? "fake_error", code: reply.fail.type ?? null } }));
    }
    const id = `resp_${++this.seq}`;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sse("response.created", { response: { id, status: "in_progress", output: [] } }));
    for (const [index, output] of (reply.outputs ?? []).entries()) res.write(this.eventsOf(output, index));
    if (reply.hold) {
      await new Promise<void>((resolve) => {
        const go = () => {
          this.held.delete(go);
          resolve();
        };
        this.held.add(go);
        res.once("close", go);
      });
      if (res.destroyed) return;
    }
    const usage = reply.usage ?? {};
    const input = usage.input ?? 100;
    const output = usage.output ?? 20;
    res.write(
      sse("response.completed", {
        response: {
          id,
          status: "completed",
          output: [],
          usage: { input_tokens: input, input_tokens_details: { cached_tokens: usage.cached ?? 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output },
        },
      }),
    );
    res.end();
  }

  private eventsOf(output: ModelOutput, index: number): string {
    const itemId = `item_${++this.seq}`;
    const done = (item: Json) => sse("response.output_item.added", { output_index: index, item: { ...item, id: itemId } }) + sse("response.output_item.done", { output_index: index, item: { ...item, id: itemId } });
    switch (output.kind) {
      case "text": {
        const added = sse("response.output_item.added", { output_index: index, item: { type: "message", role: "assistant", id: itemId, content: [] } });
        const delta = sse("response.output_text.delta", { output_index: index, item_id: itemId, content_index: 0, delta: output.text });
        const item = { type: "message", role: "assistant", id: itemId, content: [{ type: "output_text", text: output.text, annotations: [] }] };
        return added + delta + sse("response.output_item.done", { output_index: index, item });
      }
      case "reasoning": {
        const item = { type: "reasoning", id: itemId, summary: [{ type: "summary_text", text: output.text }], content: null, encrypted_content: null };
        return sse("response.output_item.added", { output_index: index, item: { ...item, summary: [] } }) + sse("response.reasoning_summary_text.delta", { output_index: index, item_id: itemId, summary_index: 0, delta: output.text }) + sse("response.output_item.done", { output_index: index, item });
      }
      case "call":
        return done({ type: "function_call", name: output.name, arguments: JSON.stringify(output.args), call_id: output.callId ?? `call_${++this.seq}`, status: "completed" });
      case "custom":
        return done({ type: "custom_tool_call", name: output.name, input: output.input, call_id: output.callId ?? `call_${++this.seq}`, status: "completed" });
      case "web_search":
        return done({ type: "web_search_call", status: "completed", action: { type: "search", query: output.query, queries: [output.query] } });
      case "raw":
        return done(output.item);
    }
  }
}
