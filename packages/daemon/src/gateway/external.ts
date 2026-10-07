// 外网端口的门（规格第 6 节、第 21 节）：隧道的唯一目标，永远不享受本机信任。
// - 每个 HTTP 请求和 WebSocket 握手都要带有效的设备凭证（HttpOnly cookie）；不看来源 IP，也不看 Host 写的是什么；
// - 没有凭证只能拿到页面本身（前端据此显示配对等待页）、查"我有没有被信任"、发配对请求（这里的 handlePairingRoute）；
// - 带了 Origin 就必须和 Host 是同一个源：挡住别的网站借用户的浏览器发请求（凭证 cookie 本身也是 SameSite=Strict）；
// - 来源：经隧道来的请求 TCP 对端都是本机，以 nginx 覆盖写的 X-Real-IP 为准（只在外网端口上信任这个头），
//   只用于配对请求的限频和卡片上显示的来源。
import type http from "node:http";
import net from "node:net";
import {
  checkHttpBody,
  DEVICE_CREDENTIAL_TTL_MS,
  type ErrorCode,
  type HttpErrorCode,
  PAIRING_CLAIM_WINDOW_MS,
  PAIRING_REQUEST_TTL_MS,
  PairingCreateBody,
  PairingRenameBody,
} from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import { DEVICE_COOKIE, PAIRING_COOKIE, readCookie, setCookieHeader } from "../pairing/credentials.ts";
import type { PairingService } from "../pairing/pairing.ts";
import { sendError, sendJson } from "./http-api.ts";
import type { OriginCheck } from "./local-origin.ts";

/** 网关用到的配对模块的那部分 */
export type DevicePairing = Pick<PairingService, "authenticate" | "rejectionOf" | "refresh" | "createRequest" | "claim" | "rename" | "onRevoked">;

/** 配对接口的请求体上限 */
const MAX_BODY_BYTES = 4096;

/** 配对 cookie 活多久：待批的期限，加上批准后来领凭证的期限 */
const PAIRING_COOKIE_MAX_AGE_MS = PAIRING_REQUEST_TTL_MS + PAIRING_CLAIM_WINDOW_MS;

/** 带了 Origin 就必须和 Host 同源（不管写的是什么地址，都不因此得到信任） */
export function checkExternalOrigin(headers: http.IncomingHttpHeaders): OriginCheck {
  const origin = headers.origin;
  if (origin === undefined) return { ok: true };
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { ok: false, reason: `Origin 不对：${origin}` };
  }
  if (!originHost || originHost.toLowerCase() !== headers.host?.toLowerCase()) return { ok: false, reason: `Origin 和 Host 不是同一个源：${origin}` };
  return { ok: true };
}

/** 请求的来源：经隧道的以 X-Real-IP 为准（nginx 覆盖写，客户端伪造不了）；没有或不像 IP 就用 TCP 对端 */
export function requestSource(req: http.IncomingMessage): { source: string; viaTunnel: boolean } {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && net.isIP(realIp.trim()) !== 0) return { source: realIp.trim(), viaTunnel: true };
  return { source: req.socket.remoteAddress ?? "未知", viaTunnel: false };
}

/** 配对模块拒绝的原因（前端协议的错误码）→ HTTP 接口的错误码（状态码只看 http-api.ts 的 STATUS_OF） */
const HTTP_CODE_OF: Partial<Record<ErrorCode, HttpErrorCode>> = {
  bad_params: "bad_request",
  not_found: "not_found",
  not_allowed: "forbidden",
  rate_limited: "too_many_requests",
};

/**
 * 配对接口（只在外网端口上，不需要凭证）：
 * - POST 发起配对请求，响应里下发配对 cookie；
 * - GET 查自己这个请求（靠配对 cookie 认），已批准就在这次响应里下发设备凭证；
 * - PATCH 改设备名。
 */
export function handlePairingRoute(req: http.IncomingMessage, res: http.ServerResponse, pairing: DevicePairing, log: (line: string) => void): void {
  const secret = readCookie(req.headers.cookie, PAIRING_COOKIE);
  const run = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof RequestRejected) return sendError(res, HTTP_CODE_OF[err.code] ?? "internal", err.message);
      log(`处理配对请求出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      sendError(res, "internal", "守护进程内部出错");
    }
  };
  switch (req.method) {
    case "GET":
    case "HEAD":
      return run(() => {
        const found = pairing.claim(secret);
        if (!found) return sendError(res, "not_found", "这台设备还没有配对请求");
        // 领到了凭证：放进 HttpOnly cookie（页面脚本看不到），配对 cookie 用完删掉
        if (found.credential !== undefined) res.setHeader("Set-Cookie", [deviceCookie(found.credential), setCookieHeader(PAIRING_COOKIE, "", 0)]);
        sendJson(res, 200, { request: found.request });
      });
    case "POST":
      return readJson(req, res, (body) =>
        run(() => {
          const checked = checkHttpBody(PairingCreateBody, body);
          if (!checked.ok) throw new RequestRejected("bad_params", `请求体不对：${checked.message}`);
          const { deviceName } = checked.value;
          const { request, secret: newSecret } = pairing.createRequest({
            ...(deviceName === undefined ? {} : { deviceName }),
            userAgent: req.headers["user-agent"] ?? "",
            ...requestSource(req),
          });
          res.setHeader("Set-Cookie", setCookieHeader(PAIRING_COOKIE, newSecret, PAIRING_COOKIE_MAX_AGE_MS));
          sendJson(res, 201, { request });
        }),
      );
    case "PATCH":
      return readJson(req, res, (body) =>
        run(() => {
          const checked = checkHttpBody(PairingRenameBody, body);
          if (!checked.ok) throw new RequestRejected("bad_params", `请求体不对：${checked.message}`);
          sendJson(res, 200, { request: pairing.rename(secret, checked.value.deviceName) });
        }),
      );
    default:
      req.resume();
      res.setHeader("Allow", "GET, HEAD, POST, PATCH");
      sendError(res, "method_not_allowed", `这个地址不支持 ${req.method}`);
  }
}

/** 设备凭证的 Set-Cookie：DEVICE_CREDENTIAL_TTL_MS（每次使用都重新下发，跟着服务端续期） */
export function deviceCookie(credential: string): string {
  return setCookieHeader(DEVICE_COOKIE, credential, DEVICE_CREDENTIAL_TTL_MS);
}

/** 删掉浏览器里失效的设备凭证（吊销了、过期了） */
export function clearDeviceCookie(): string {
  return setCookieHeader(DEVICE_COOKIE, "", 0);
}

/** 读 JSON 请求体（空的算 {}）；太大或不是 JSON 直接回错误 */
function readJson(req: http.IncomingMessage, res: http.ServerResponse, then: (body: unknown) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendError(res, "too_large", "请求体太大");
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (aborted) return;
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text === "") return then({});
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return sendError(res, "bad_request", "请求体不是合法的 JSON");
    }
    then(body);
  });
}
