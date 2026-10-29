// 请求被拒：模块按前端协议的错误码拒绝一个请求（卡片已被处理、事项不存在、卡着任务的事项不能删……）。
// 网关把它原样回成错误响应，连接不断；message 是给人看的原因。
import type { ErrorCode } from "@ergo/protocol";

export class RequestRejected extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 请求里说的项目不在项目列表里（64 号票：秘书建卡写错了项目时，据此补一句"说不清是哪个项目时先问用户"） */
export class UnknownProjects extends RequestRejected {
  constructor(message: string) {
    super("bad_params", message);
  }
}
