// 模型调用的接口（④ 号票的模型版用）：一问一答、要求 JSON 输出。真模型是 DeepSeek（deepseek.ts），测试用 FakeChatModel。
// 只在评测的"真模型"开关下用，只喂合成数据，跑之前先报预计费用（estimate.ts、main.ts）。
import { estimateTokens } from "./estimate.ts";

/** 201 号票加了 lift（往上抽）、strategies（编交互策略）；216 号票加了 answer（大模型回答器，llm/answerer.ts）；
 * 226 号票加了 prediction（判断结论当时写的预测后来应验没有，rg/predictions.ts）；227 号票加了 review（对抗复核）；
 * 271 号票加了 reply（每晚整理时判顺口问以后用户有没有在答，rg/reply-judge.ts）；283 号票加了 people（每晚整理时从用户的话里
 * 认出别人的固定信息、攒成个人档案的候选，kg/person-info.ts） */
export type ChatPurpose = "extract" | "propose" | "probes" | "judge" | "lift" | "strategies" | "answer" | "prediction" | "review" | "reply" | "people";

export interface ChatRequest {
  purpose: ChatPurpose;
  system: string;
  user: string;
  /** 输出最多多少 token */
  maxTokens: number;
}

export interface ChatResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  /** 输出到了 maxTokens 被截断（DeepSeek 的 finish_reason = length；192 号票） */
  truncated?: boolean;
}

/** 输出解析不了时丢掉的原因：被截断的写明是截断（192 号票：模型版第一次真跑时 propose 全被 2000 的上限截断） */
export function unparsedReason(response: ChatResponse, request: ChatRequest, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return response.truncated ? `模型输出到了上限（maxTokens ${request.maxTokens}）被截断，解析不了：${detail}` : `模型输出解析不了：${detail}`;
}

export interface ChatModel {
  /** 模型名，记在事实的 extractedBy、推断的 by 上（model:<名>） */
  readonly name: string;
  complete(request: ChatRequest): Promise<ChatResponse>;
}

/** 测试用的假模型：按请求给出回答（对象会转成 JSON），记下每次请求；token 按估算记 */
export class FakeChatModel implements ChatModel {
  readonly name: string;
  readonly calls: ChatRequest[] = [];
  private readonly respond: (request: ChatRequest) => unknown;

  constructor(respond: (request: ChatRequest) => unknown, name = "fake-llm") {
    this.respond = respond;
    this.name = name;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const out = this.respond(request);
    const content = typeof out === "string" ? out : JSON.stringify(out);
    return { content, usage: { inputTokens: estimateTokens(request.system + request.user), outputTokens: estimateTokens(content) } };
  }
}
