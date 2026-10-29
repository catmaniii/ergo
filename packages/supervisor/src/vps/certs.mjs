// VPS 上的证书（321 号票写，322 的 `lsm vps site add / certs / scan` 接着用）：本机这一半。
// VPS 上那一半是 sh/certs.sh（签、删、续期钩子、列到期日），脚本拼装时带上它。
//
// 域名默认 `<名字>.<IP>.sslip.io`：sslip.io 把编在名字里的 IP 原样解析回来，不用买域名、不用配 DNS，
// Let's Encrypt 照样能用 HTTP-01 签（它要的只是"这个名字解析到这台机器、80 端口回得上话"）。
import fs from 'node:fs';
import { isIPv4 } from './remote.mjs';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const EMAIL = /^[^\s@'"`$\\]+@[^\s@'"`$\\]+\.[a-z]{2,}$/i;

/** 少于这么多天就提醒（322 的 certs 也用这个数） */
export const CERT_WARN_DAYS = 20;

export const validLabel = (s) => LABEL.test(String(s));
export const validDomain = (s) => DOMAIN.test(String(s));
export const validEmail = (s) => EMAIL.test(String(s));

/** 默认域名：<名字>.<IP>.sslip.io（IP 必须是 IPv4）。 */
export function defaultDomain(name, ip) {
  if (!validLabel(name)) throw new Error(`名字只能是小写字母、数字和连字符：${JSON.stringify(name)}`);
  if (!isIPv4(ip)) throw new Error(`默认域名要用 VPS 的 IPv4 地址，得到 ${JSON.stringify(ip)}`);
  return `${name}.${ip}.sslip.io`;
}

/** 从本机核对：这个名字在公网 DNS 里是不是解析到这台 VPS。 */
export async function checkDns(exec, domain, ip) {
  const ips = await exec.resolve4(domain);
  if (ips.includes(ip)) return { ok: true, ips };
  return { ok: false, ips, why: ips.length ? `${domain} 解析到 ${ips.join('、')}，不是这台 VPS（${ip}）` : `${domain} 在公网 DNS 里解析不到` };
}

/** 解析 VPS 上 cert_report 的输出：ERGO-CERT <域名> <Unix 秒|none> */
export function parseCertLines(text) {
  return [...String(text).matchAll(/^ERGO-CERT (\S+) (\d+|none)\s*$/gm)].map((m) => ({
    domain: m[1], notAfter: m[2] === 'none' ? null : Number(m[2]) * 1000,
  }));
}

/** 证书的一句话：还剩几天、要不要提醒。 */
export function certSummary(cert, now = Date.now()) {
  if (!cert || cert.notAfter == null) return { ok: false, days: null, warn: true, text: '没有证书' };
  const days = Math.floor((cert.notAfter - now) / 86400000);
  if (days < 0) return { ok: false, days, warn: true, text: `已经过期 ${-days} 天` };
  return { ok: true, days, warn: days < CERT_WARN_DAYS, text: `还剩 ${days} 天（到 ${new Date(cert.notAfter).toISOString().slice(0, 10)}）` };
}

/** VPS 上那一半（bash 函数）：拼进脚本里。 */
export function certsShell() {
  return fs.readFileSync(new URL('./sh/certs.sh', import.meta.url), 'utf-8').replace(/\r\n/g, '\n');
}
