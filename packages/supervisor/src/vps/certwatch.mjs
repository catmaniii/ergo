// 盯 VPS 上证书的到期日（322 号票）：`lsm vps certs` 和管理器共用。
//
// 只读：经 ssh 在 VPS 上跑一份只列证书的脚本（sh/certs-list.sh），结果存进数据目录的 vps-certs.json。
// （还没接上管理器：每 12 小时自己去看、少于 20 天在 WebUI 上提醒、弹 Windows 通知——下一步，见 322 号票 Comments；
//  CERT_REFRESH_MS、certsDue、certAlerts 是给那一步预备的。）Let's Encrypt 的证书 certbot 会在剩 30 天时自动续，所以剩不到 20 天多半是续期坏了。
import fs from 'node:fs';
import path from 'node:path';
import { VPS_CERTS } from '../paths.mjs';
import { CERT_WARN_DAYS, parseCertLines } from './certs.mjs';
import { certsScript } from './scripts.mjs';
import * as rm from './remote.mjs';
import { renameRetry } from './state.mjs';

/** 管理器多久去 VPS 上看一次；上一次没看成（连不上）就隔 1 小时再试 */
export const CERT_REFRESH_MS = 12 * 3600_000;
export const CERT_RETRY_MS = 3600_000;

/** 管理器这一轮该不该去 VPS 上看（看过的时刻、看成没有） */
export function certsDue(snap, now = Date.now()) {
  if (!snap?.checkedAt) return true;
  return now - snap.checkedAt >= (snap.ok ? CERT_REFRESH_MS : CERT_RETRY_MS);
}
/** 少于这么多天升成红色 */
export const CERT_BAD_DAYS = 7;
const DAY = 86400_000;

export function loadCertSnapshot(file = VPS_CERTS) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

export function saveCertSnapshot(snap, file = VPS_CERTS) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap, null, 2) + '\n', 'utf-8');
  renameRetry(`${file}.tmp`, file);
}

/** ERGO-CERTFILE <路径> <Unix 秒|none>：nginx 里引用的、不归 Let's Encrypt 管的证书文件 */
export function parseCertFileLines(text) {
  return [...String(text).matchAll(/^ERGO-CERTFILE (\S+) (\d+|none)\s*$/gm)].map((m) => ({
    path: m[1], notAfter: m[2] === 'none' ? null : Number(m[2]) * 1000,
  }));
}

/** 这张证书是谁的：lsm vps setup 的方式、site add 的站点、scan 认领的，都不是就是 null */
export function ownerOf(state, cert) {
  const domain = cert.name || null;
  for (const [mode, rec] of Object.entries(state?.modes || {})) if (rec?.domain === domain) return mode === 'tunnel' ? '隧道入口' : 'headscale';
  for (const [name, rec] of Object.entries(state?.sites || {})) if (rec?.domain === domain) return `站点 ${name}`;
  const claimed = (state?.claimed?.sites || []).find((s) => (cert.path && s.certificate === cert.path) || (domain && (s.certificate || '').includes(`/live/${domain}/`)));
  if (claimed) return `认领的 ${claimed.serverNames?.[0] || claimed.file}`;
  return null;
}

/** VPS 上证书脚本的输出 → 快照 */
export function snapshotFromOutput(text, { state = null, host = null, now = Date.now() } = {}) {
  const le = parseCertLines(text).map((c) => ({ kind: 'le', name: c.domain, notAfter: c.notAfter }));
  const files = parseCertFileLines(text).map((c) => ({ kind: 'file', name: c.path, path: c.path, notAfter: c.notAfter }));
  const certs = [...le, ...files].map((c) => ({ ...c, owner: ownerOf(state, c) }));
  return { at: now, checkedAt: now, host, ok: true, certs };
}

/** 还剩几天（向下取整；没有到期日是 null） */
export const daysLeft = (notAfter, now = Date.now()) => (notAfter == null ? null : Math.floor((notAfter - now) / DAY));

/** 要提醒的：少于 20 天（7 天内红）、已经过期。key 给通知去重用。 */
export function certAlerts(snap, now = Date.now()) {
  const out = [];
  for (const c of snap?.certs || []) {
    const d = daysLeft(c.notAfter, now);
    if (d == null || d >= CERT_WARN_DAYS) continue;
    const when = new Date(c.notAfter).toISOString().slice(0, 10);
    const who = c.owner ? `（${c.owner}）` : '';
    const text = d < 0
      ? `VPS 上的证书 ${c.name}${who}已经过期 ${-d} 天（${when}）——网站打不开了，先 lsm vps certs 看一眼`
      : `VPS 上的证书 ${c.name}${who}还剩 ${d} 天（${when} 到期）——certbot 的自动续期大概没跑成，lsm vps certs 看一眼`;
    out.push({ key: `cert:${c.kind}:${c.path || c.name}`, level: d < CERT_BAD_DAYS ? 'bad' : 'warn', text, name: c.name, days: d });
  }
  return out;
}

/** 去 VPS 上看一遍（只读），返回快照（没连上是 ok:false + why，证书沿用上一次的） */
export async function fetchCerts(exec, state, { keys = rm.keyPaths(), now = new Date(), previous = null } = {}) {
  const r = await rm.runScript(exec, state.vps, keys, certsScript(state.vps, { now }), { timeout: 60000 });
  if (!/^ERGO-CERTS=1$/m.test(r.out)) {
    const why = (r.err || r.out).trim().split(/\r?\n/).pop() || `退出码 ${r.code}`;
    // 没看成：证书沿用上一次看到的（at 还是上一次看成的时刻），记下这次没看成的原因
    return { certs: [], ...previous, checkedAt: now.getTime(), host: state.vps.host, ok: false, why };
  }
  return snapshotFromOutput(r.out, { state, host: state.vps.host, now: now.getTime() });
}
