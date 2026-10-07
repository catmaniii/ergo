// 新设备这一侧的配对接口（外网端口上，不需要凭证；规格第 6 节）。
// 认出"这台设备的配对请求"的东西和批准后发下来的设备凭证都只在 HttpOnly cookie 里：浏览器自己带，页面脚本一个令牌也碰不到。
// - current：这台设备现在的配对请求（已批准的话，这一次的响应里就领到了凭证）；
// - create：发起配对请求（设备名由守护进程按 User-Agent 生成，之后可以改）；
// - rename：在新设备上改设备名（本机待我处理里那张配对请求卡跟着改）。
import { type AccessInfo, HTTP_PATHS, type HttpErrorBody, type PairingRequestView } from "../state/index.ts";

export interface PairingApi {
  /** 这台设备现在的配对请求；还没有是 undefined */
  current(): Promise<PairingRequestView | undefined>;
  /** 发起配对请求；设备名不给就由守护进程按 User-Agent 生成 */
  create(deviceName?: string): Promise<PairingRequestView>;
  rename(deviceName: string): Promise<PairingRequestView>;
  /** 只有原型的预览有：模拟"在别处批准了" */
  simulateApproval?: () => void;
}

/** 配对接口回的错误（太频繁、名字不对、请求已经不在等批准了……），message 给人看 */
export class PairingError extends Error {}

async function call(method: string, body?: unknown): Promise<PairingRequestView | undefined> {
  const res = await fetch(HTTP_PATHS.pairing, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (method === "GET" && res.status === 404) return undefined;
  if (!res.ok) {
    const error = (await res.json().catch(() => undefined)) as HttpErrorBody | undefined;
    throw new PairingError(error?.message ?? `配对接口出错（HTTP ${res.status}）`);
  }
  return ((await res.json()) as { request: PairingRequestView }).request;
}

export const httpPairingApi: PairingApi = {
  current: () => call("GET"),
  create: async (deviceName) => (await call("POST", deviceName === undefined ? {} : { deviceName }))!,
  rename: async (deviceName) => (await call("PATCH", { deviceName }))!,
};

/** 这个页面被信任吗：本机端口、带着有效凭证的已配对设备、都不是（要配对；带来的凭证刚失效时附上原因） */
export async function fetchAccess(): Promise<AccessInfo> {
  const res = await fetch(HTTP_PATHS.access, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AccessInfo;
}
