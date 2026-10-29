// DeepSeek 的对话接口（模型版用）：POST {base}/chat/completions，要求 JSON 输出、温度 0。
// 默认关掉思考（thinking: {type: "disabled"}，192 号票）：deepseek-flash 是 V4.1 Flash，会推理的模型（pi-ai 的模型表里 reasoning: true），
// 不关时先想再答，想的 token 也算进 max_tokens——第一、二次真跑时 propose 大都写满上限被截断。关法照 pi-ai 发 DeepSeek 请求的做法
// （pi-ai 包里 openai-completions 的实现：thinkingFormat = deepseek、不要推理时发 thinking disabled）。
// key 只从环境变量 DEEPSEEK_API_KEY 读（每次调用时现取），不打印、不写进文件；出错信息里出现 key 也换成 ***。
// 只在评测的"真模型"开关下用（llm/main.ts 要显式 --run），测试里用假的发送函数，不联网。
import type { ChatModel, ChatRequest, ChatResponse } from "./chat.ts";

export const DEEPSEEK_KEY_ENV = "DEEPSEEK_API_KEY";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** 二狗默认的模型（daemon 的 model-settings/providers.ts） */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface PostResult {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type PostFunction = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<PostResult>;

export interface DeepSeekChatOptions {
  model?: string;
  baseUrl?: string;
  /** 不给用 Node 的 fetch */
  post?: PostFunction;
  /** 取 key 的环境（测试注入）；不给是 process.env */
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  /** 思考开不开，默认关（要结构化 JSON，不用先想） */
  thinking?: "enabled" | "disabled";
}

export class DeepSeekChat implements ChatModel {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly post: PostFunction;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly timeoutMs: number;
  private readonly thinking: "enabled" | "disabled";

  constructor(options: DeepSeekChatOptions = {}) {
    this.name = options.model ?? DEEPSEEK_DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
    this.post = options.post ?? ((url, init) => fetch(url, init));
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.thinking = options.thinking ?? "disabled";
  }

  /** 配了 key 没有（不说 key 是什么） */
  hasKey(): boolean {
    return (this.env[DEEPSEEK_KEY_ENV]?.trim() ?? "").length > 0;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const key = this.env[DEEPSEEK_KEY_ENV]?.trim();
    if (!key) throw new Error(`没配 DeepSeek 的 key（环境变量 ${DEEPSEEK_KEY_ENV}）`);
    const redact = (s: string) => s.split(key).join("***");
    const body = JSON.stringify({
      model: this.name,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: request.maxTokens,
      thinking: { type: this.thinking },
      stream: false,
    });
    let res: PostResult;
    try {
      res = await this.post(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`DeepSeek 请求没发出去：${redact(err instanceof Error ? err.message : String(err))}`, { cause: err });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`DeepSeek 返回 HTTP ${res.status}：${redact(text.slice(0, 200))}`);
    let data: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new Error(`DeepSeek 的回应不是 JSON：${redact(text.slice(0, 200))}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("DeepSeek 的回应里没有内容");
    return {
      content,
      usage: { inputTokens: Number(data.usage?.prompt_tokens ?? 0), outputTokens: Number(data.usage?.completion_tokens ?? 0) },
      truncated: data.choices?.[0]?.finish_reason === "length",
    };
  }
}
