// 实现方式 http：二狗在本机代调项目服务的调用口（260 号票，issue 19 第 7 条"项目服务开本机调用口，二狗在本机代调，不走公网"）：
// POST http://127.0.0.1:<服务的端口><path>，请求体是 MCP tools/call 的 params：{ "name": <操作名>, "arguments": <参数> }；
// 验收时的测试调用另带 "_meta": { "ergo/test": true }（268 号票：有副作用的操作收到它不要真的改东西，照常校验参数、回 say）。
// 回的东西怎么取能念的那句和附件见 reply.ts；HTTP 4xx / 5xx 算没做成（回的内容照样取出来带回去）；
// 连不上（端口没人听）、等不到（timeoutMs）、被中止：没做成，说清是哪一种（reach）。
// 只连 127.0.0.1（服务都在这台电脑上，LSM 管着）；不带任何凭据、不跟跳转。
// @i18n-ignore-file model：连不上的说法交给秘书（工具结果）
import { oldNameOf } from "@ergo/protocol";
import { type ParsedReply, parseReply } from "./reply.ts";

const LOCAL_HOST = "127.0.0.1";

/** 测试调用的标记（http 请求体的 _meta、脚本标准输入的 _meta 里都是它） */
export const OPS_TEST_META = "ergo/test";

/** 调到没有：调到了 answered；连不上、等不到、被中止的没调到 */
export type OpReach = "answered" | "refused" | "timeout" | "aborted";

/** 一次 http 调用的结果 */
export interface ProjectOpCallResult {
  reach: OpReach;
  /** 调到了的：取出来的能念的那句和附件 */
  reply: ParsedReply;
  /** 服务回的 HTTP 状态（调到了才有） */
  status?: number;
  /** 做成了：调到了、2xx、没说出错 */
  ok: boolean;
}

/** 调用口的地址（路径已经校验过：/ 开头、不是 // 开头） */
export function opsUrl(port: number, path: string): string {
  return `http://${LOCAL_HOST}:${port}${path}`;
}

/** 请求体（http 和脚本一样）：MCP tools/call 的 params，测试调用带上标记（312 号票：另带一份旧名字的，早先做的服务照样认得出是测试） */
export function callBody(name: string, args: Record<string, unknown>, test: boolean): string {
  return JSON.stringify({ name, arguments: args, ...(test ? { _meta: { [OPS_TEST_META]: true, [oldNameOf(OPS_TEST_META)]: true } } : {}) });
}

/** 连不上：fetch 的错里一层层找 ECONNREFUSED 这类 */
function refusedCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** 调一次：到 timeoutMs 还没回的算等不到；signal（这次工具调用被中止）中止的算被中止 */
export async function callProjectOp(input: { url: string; name: string; args: Record<string, unknown>; test?: boolean; timeoutMs: number; signal?: AbortSignal }): Promise<ProjectOpCallResult> {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  try {
    const res = await fetch(input.url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json, text/plain;q=0.9, */*;q=0.5" },
      body: callBody(input.name, input.args, input.test === true),
      signal,
      redirect: "manual",
    });
    const body = await res.text();
    const reply = parseReply(body, res.headers.get("content-type"));
    const ok = res.status >= 200 && res.status < 300 && !reply.isError;
    return { reach: "answered", reply, status: res.status, ok };
  } catch (err) {
    if (timeout.aborted) return { reach: "timeout", reply: { detail: `等了 ${input.timeoutMs / 1000} 秒没回`, isError: true }, ok: false };
    if (input.signal?.aborted) return { reach: "aborted", reply: { detail: "这次调用被中止了", isError: true }, ok: false };
    const code = refusedCode(err);
    return { reach: "refused", reply: { detail: code ? `连不上（${code}）` : `连不上（${err instanceof Error ? err.message : String(err)}）`, isError: true }, ok: false };
  }
}
