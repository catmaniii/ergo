// 设备凭证和配对 cookie（规格第 6 节）：
// - 设备凭证：批准配对后发给新设备的 256 位随机值，只放在 HttpOnly、Secure、SameSite=Strict 的 cookie 里，
//   页面脚本看不到；服务端只存它的 sha256，原值只在发给设备的那一个响应里出现过；
// - 配对 cookie：新设备发起配对请求时拿到的另一个随机值（同样 HttpOnly），之后查状态、改设备名、领凭证都靠它认出
//   是哪个请求。服务端同样只存哈希；短指纹由它推出来。
// cookie 名带 __Host- 前缀：浏览器只接受 Secure、Path=/、不带 Domain 的，同一 sslip.io 下别的子域名没法覆盖它。
import { createHash, randomBytes, randomInt } from "node:crypto";
import { PAIRING_FINGERPRINT_HEX_DIGITS, PAIRING_SHORT_CODE_DIGITS } from "@ergou/protocol";

export const DEVICE_COOKIE = "__Host-ergou-device";
export const PAIRING_COOKIE = "__Host-ergou-pairing";

/** 256 位随机值，base64url（43 个字符） */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** 是不是 newSecret 生成的样子（别的一概不去查库） */
export function isSecretShaped(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** 服务端存的：sha256 十六进制 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** 短指纹：由配对 cookie 推出来的 8 位十六进制（和存的哈希不是同一个东西） */
export function fingerprintOf(secret: string): string {
  return createHash("sha256").update(`ergou-pairing-fingerprint\0${secret}`, "utf8").digest("hex").slice(0, PAIRING_FINGERPRINT_HEX_DIGITS);
}

/** 6 位数字短码（可以以 0 开头） */
export function newShortCode(): string {
  return String(randomInt(0, 10 ** PAIRING_SHORT_CODE_DIGITS)).padStart(PAIRING_SHORT_CODE_DIGITS, "0");
}

/** Set-Cookie 头：HttpOnly、Secure、SameSite=Strict、Path=/；maxAgeMs 为 0 表示删掉 */
export function setCookieHeader(name: string, value: string, maxAgeMs: number): string {
  return `${name}=${value}; Max-Age=${Math.floor(maxAgeMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** 从 Cookie 请求头里取某个 cookie 的值 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
