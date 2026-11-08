// 本机的假 DeepSeek 查余额接口（440）：一个只听 127.0.0.1 临时端口的服务，测试里 GET /user/balance 都发到这里
// （deepseekBalanceSource 的 baseUrl、守护进程的 deepseekBalanceBaseUrl），从不连真的 DeepSeek、不用真 Key。
// 每次请求记下方法、路径、Authorization；回什么由测试给的剧本定（第几次回什么），不给按"照常回"：官方文档的样例
// （能用，CNY 总余额 110.00，其中赠送 10.00、充值 100.00）。剧本里给 hang 的一直不回（测超时），给 drop 的直接断开（测连不上）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/** 官方文档 "Get User Balance" 的响应样例（https://api-docs.deepseek.com/zh-cn/api/get-user-balance） */
export const DOC_SAMPLE_BALANCE = {
  is_available: true,
  balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
};

/** 一次回什么：状态码和 JSON（或者原样的正文），或者一直不回、直接断开 */
export type FakeBalanceReply = { status: number; json?: unknown; text?: string } | { hang: true } | { drop: true };

export interface FakeBalanceRequest {
  method: string;
  path: string;
  /** 请求头里的 Authorization（测 Key 确实交过去了；测试里一律是假的 Key） */
  authorization: string | undefined;
}

export interface FakeDeepSeekBalance {
  baseUrl: string;
  requests: FakeBalanceRequest[];
  /** 之后的请求按这个回（覆盖构造时给的剧本） */
  reply(next: FakeBalanceReply | ((n: number) => FakeBalanceReply)): void;
}

/** DeepSeek 兼容 OpenAI 的出错响应体 */
export const balanceError = (message: string, code = "invalid_request_error") => ({ error: { message, type: code, param: null, code } });

export async function startFakeDeepSeekBalance(script?: FakeBalanceReply | ((n: number) => FakeBalanceReply)): Promise<FakeDeepSeekBalance> {
  const requests: FakeBalanceRequest[] = [];
  let current = script;
  const hanging: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
    const n = requests.length;
    const reply: FakeBalanceReply = typeof current === "function" ? current(n) : (current ?? { status: 200, json: DOC_SAMPLE_BALANCE });
    if ("hang" in reply) {
      hanging.push(res);
      return;
    }
    if ("drop" in reply) {
      req.socket.destroy();
      return;
    }
    if (req.method !== "GET" || req.url !== "/user/balance") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify(balanceError("Not Found")));
      return;
    }
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.text ?? JSON.stringify(reply.json ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  onTestFinished(async () => {
    for (const res of hanging) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    reply(next) {
      current = next;
    },
  };
}
