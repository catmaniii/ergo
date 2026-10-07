// 设备配对和外网端口（规格第 6 节、第 21 节）：守护进程和 Web 共用的常量、默认设备名。
// 只有常量和纯函数，不引用 TypeBox。HTTP 接口的路径在 http.ts（HTTP_PATHS.access、HTTP_PATHS.pairing），
// 请求体和响应体在 http-schema.ts。
//
// 外网端口是隧道的唯一目标，永远不享受本机信任：每个 HTTP 请求和 WebSocket 握手都要带有效的设备凭证
// （HttpOnly cookie，页面脚本里看不到）；没有凭证只能拿到页面本身（显示配对等待页）、查"我有没有被信任"、发配对请求。

const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** 待批的配对请求多久过期 */
export const PAIRING_REQUEST_TTL_MS = 5 * MINUTE;

/** 批准之后，新设备在多久之内来领凭证（新设备每隔几秒问一次；超时没领就作废，要重新请求） */
export const PAIRING_CLAIM_WINDOW_MS = 5 * MINUTE;

/** 同一来源（经隧道来的以 nginx 覆盖写的 X-Real-IP 为准）在这么长的时间里…… */
export const PAIRING_RATE_WINDOW_MS = 10 * MINUTE;
/** ……最多发这么多个配对请求，再多的被拒 */
export const PAIRING_RATE_LIMIT = 5;

/** 设备凭证的有效期：从最近一次使用算起（每次使用都续期） */
export const DEVICE_CREDENTIAL_TTL_MS = 365 * DAY;

/**
 * 新设备领到凭证之后，多久之内要第一次带着它来（领取的响应丢了，凭证就到不了设备手里）：
 * 这之前设备记录是"等待首次使用"，到时还没用过就自动作废
 */
export const DEVICE_FIRST_USE_WINDOW_MS = DAY;

/** 给人看的时长："5 分钟"、"24 小时"、"365 天"（界面和报错的文字由常量拼出，不另写数字） */
export function durationText(ms: number): string {
  if (ms >= 2 * DAY && ms % DAY === 0) return `${ms / DAY} 天`;
  if (ms >= HOUR && ms % HOUR === 0) return `${ms / HOUR} 小时`;
  return `${Math.round(ms / MINUTE)} 分钟`;
}

/** 待我处理里配对请求那一项的标题 */
export function pairingRequestTitle(deviceName: string): string {
  return `新设备请求配对：${deviceName}`;
}

/** 短码的位数（十进制数字）和短指纹的位数（十六进制） */
export const PAIRING_SHORT_CODE_DIGITS = 6;
export const PAIRING_FINGERPRINT_HEX_DIGITS = 8;

/** 设备名最长多少个字符 */
export const DEVICE_NAME_MAX_LENGTH = 64;

/** 被吊销（或凭证失效）的设备，服务端关掉它的 WebSocket 时用的关闭码 */
export const WS_CLOSE_UNPAIRED = 4401;

/** 设备名默认值：浏览器 · 系统（由 User-Agent 推出来；新设备上可以改） */
export function defaultDeviceName(userAgent: string): string {
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /HarmonyOS|ArkWeb/.test(ua)
      ? "鸿蒙浏览器"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "浏览器";
  const os = /HarmonyOS|OpenHarmony/.test(ua)
    ? "HarmonyOS"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua)
        ? "iPad"
        : /Android/.test(ua)
          ? "Android"
          : /Windows/.test(ua)
            ? "Windows"
            : /Mac OS X/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "未知系统";
  return `${browser} · ${os}`;
}

/** 规整用户给的设备名：去掉首尾空白、换行换成空格；空的或太长的不收（返回 undefined） */
export function normalizeDeviceName(name: string): string | undefined {
  const s = name.replace(/\s+/g, " ").trim();
  return s.length === 0 || s.length > DEVICE_NAME_MAX_LENGTH ? undefined : s;
}
