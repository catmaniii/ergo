// 非 2xx 的响应体里挑一句给人看的话（233 号票的记忆页会碰到：守护进程重启的几十秒里、隧道断了一下、
// 前面的 nginx 回了 502——body 是 HTML 错误页）。直接 `res.json()` 会抛出
// "Unexpected token '<', "<html> <h"… is not valid JSON"，用户看不懂，所以先看状态码再解析。
//
// 单独一个纯函数（不碰 DOM 的类型）：前端状态层和 Node 里的测试都能用。
import { type HttpErrorBody, t } from "../state/index.ts";

/** 状态不对时的一句话：能读出 `{ message }` 就用它（守护进程自己的错误），读不出来（HTML、空）给一句人话 */
export function httpErrorMessage(status: number, body: string): string {
  const text = body.trim();
  if (text.length > 0 && !text.startsWith("<")) {
    try {
      const json = JSON.parse(text) as Partial<HttpErrorBody>;
      if (typeof json.message === "string" && json.message.length > 0) return json.message;
    } catch {
      // 不是 JSON：下面给通用的那句
    }
  }
  return t("app.daemonHttp.httpFailed", { status });
}

/** 状态是 2xx、body 却不是 JSON（一般也是网关塞回来的错误页）：说清楚让人再试 */
export function notJsonMessage(): string {
  return t("app.daemonHttp.notJson");
}
