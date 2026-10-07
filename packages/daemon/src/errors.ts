// 请求被拒：模块按前端协议的错误码拒绝一个请求（卡片已被处理、事项不存在、卡着任务的事项不能删……）。
// 网关把它原样回成错误响应，连接不断；message 是给人看的原因。
import type { ErrorCode } from "@ergou/protocol";

export class RequestRejected extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
