// 设备凭证和配对 cookie（规格第 6 节）：
// - 设备凭证：批准配对后发给新设备的 256 位随机值，只放在 HttpOnly、Secure、SameSite=Strict 的 cookie 里，
//   页面脚本看不到；服务端只存它的 sha256，原值只在发给设备的那一个响应里出现过；
// - 配对 cookie：新设备发起配对请求时拿到的另一个随机值（同样 HttpOnly），之后查状态、改设备名、领凭证都靠它认出
//   是哪个请求。服务端同样只存哈希；短指纹由它推出来。
// cookie 名带 __Host- 前缀：浏览器只接受 Secure、Path=/、不带 Domain 的，同一 sslip.io 下别的子域名没法覆盖它。
// 312 号票：cookie 名从旧的 __Host-ergou-* 换成 __Host-ergo-*。读时新旧都认（readCookieOrOld，已配对的设备不用重新配对），
// 回应时写新的、把旧的清掉（oldCookieClears）。
import { createHash, randomBytes, randomInt } from "node:crypto";
import { oldNameOf, PAIRING_FINGERPRINT_HEX_DIGITS, PAIRING_SHORT_CODE_DIGITS } from "@ergo/protocol";

export const DEVICE_COOKIE = "__Host-ergo-device";
export const PAIRING_COOKIE = "__Host-ergo-pairing";

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
  return createHash("sha256").update(`ergo-pairing-fingerprint\0${secret}`, "utf8").digest("hex").slice(0, PAIRING_FINGERPRINT_HEX_DIGITS);
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

/** 某个 cookie 的值：先认新名字的，没有再认旧名字的（312 号票） */
export function readCookieOrOld(header: string | undefined, name: string): string | undefined {
  return readCookie(header, name) ?? readCookie(header, oldNameOf(name));
}

/** 请求里带着旧名字的这几个 cookie 的，回应里把旧的清掉（新的由调用方照常写） */
export function oldCookieClears(header: string | undefined, names: readonly string[]): string[] {
  return names.filter((name) => readCookie(header, oldNameOf(name)) !== undefined).map((name) => setCookieHeader(oldNameOf(name), "", 0));
}
