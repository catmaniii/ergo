// VPS 订阅：包年包月的订阅什么时候到期、怎么续，快到期时提醒续费 / 充值。只读，经阿里云费用中心 OpenAPI 查（凭证只放数据目录的 .secrets/）。
//
// 要盯的是「订阅」：VPS 这类包年包月的实例若是手动续费，到期不续就停机——核心是到期日。
// 余额顺带显示（扣款走绑定的卡时余额常年是 0）。
// 只用费用中心（BSS）的两个只读接口，一个 AliyunBSSReadOnlyAccess 策略就够：
//  - QueryAvailableInstances(SubscriptionType=Subscription)：账号下所有包年包月订阅，带到期日和续费方式；
//  - QueryAccountBalance：余额。
// 不查轻量的实例和流量包（SWAS 接口）：要多授一个策略，到期提醒也用不上。
//
// 凭证是一个只读 RAM 用户的 AccessKey，只放在数据目录 .secrets/ 下的文件里（manager.yaml 只写路径）。
// 它不进注册表、日志、审计、快照，也不会出现在任何报错里。
// 签名是 V3（ACS3-HMAC-SHA256），手写、零依赖；算法按官方文档的固定参数示例做了单测。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.mjs';

export const BILLING_DEFAULTS = {
  site: 'cn',                       // cn = 阿里云中国站（aliyun.com）；intl = 国际站（alibabacloud.com）
  region: null,                     // VPS 所在地域（比如 cn-hangzhou）：这个地域的轻量订阅标成「这台 VPS」；不写就不标
  credentials: '.secrets/alicloud_vps',     // 目录或文件，见 loadCredentials
  remindDays: 7,                    // 到期前几天开始提醒（3 天内升成红色）
  minBalance: 0,                    // 余额低于这个数提醒（账户币种）；0 = 只在欠费（为负）时提醒
  notify: true,                     // Windows 系统通知；同一条提醒一天最多弹一次
  intervalMs: 3 * 3600_000,         // 多久查一次（到期日一天才变一格；WebUI 上可以随时手动刷新）
};

const BSS_HOST = { cn: 'business.aliyuncs.com', intl: 'business.ap-southeast-1.aliyuncs.com' };
// 费用中心首页：续费（续费管理 → 手动续费）和充值都在这里。续费页的直达地址没在官方文档里核实到，不瞎拼
const LINKS = {
  cn: { billing: 'https://usercenter2.aliyun.com/', console: 'https://swas.console.aliyun.com/' },
  intl: { billing: 'https://usercenter2-intl.aliyun.com/', console: 'https://swas.console.alibabacloud.com/' },
};
const PRODUCT = { swas: '轻量应用服务器', ecs: '云服务器 ECS', domain: '域名', rds: '云数据库 RDS', slb: '负载均衡', eip: '弹性公网 IP', cdn: 'CDN', oss: '对象存储 OSS', vpn: 'VPN 网关', cbwp: '共享带宽' };
const REGION = { 'cn-hongkong': '香港', 'ap-southeast-1': '新加坡', 'cn-shanghai': '上海', 'cn-hangzhou': '杭州', 'cn-beijing': '北京', 'cn-shenzhen': '深圳', 'us-west-1': '美西', 'ap-northeast-1': '东京' };
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DAY = 86400_000;

/** manager.yaml 里没写 vps.billing 就是没开这个功能。 */
export function billingConfig(manager) {
  const b = manager?.vps?.billing;
  if (!b) return null;
  return { ...BILLING_DEFAULTS, ...b };
}

export const linksFor = (site) => LINKS[site] || LINKS.cn;

// ---------- 凭证 ----------

/**
 * 读只读 AccessKey。两种格式都认：
 *  - 控制台创建 AccessKey 时「下载 CSV 文件」得到的那份，原样存过来就行（表头 AccessKey ID,AccessKey Secret）；
 *  - JSON：{"accessKeyId": "...", "accessKeySecret": "..."}。
 * 报错里只说文件哪里不对，绝不回显文件内容。
 */
export function loadCredentials(file) {
  const p = dataPath(file);
  // 也可以指向一个目录：里面恰好一个文件能读出 AccessKey 就用它。
  // 这样 manager.yaml 不用写文件名——控制台给的文件名里带着账号 ID。
  let isDir = false;
  try { isDir = fs.statSync(p).isDirectory(); } catch {}
  if (isDir) {
    let names = [];
    try { names = fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); } catch {}
    const found = names.map((n) => loadCredentials(path.join(p, n))).filter((c) => c.ok);
    if (found.length === 1) return found[0];
    if (!found.length) return { ok: false, missing: !names.length, file: p, why: names.length ? `${p} 里的文件都读不出 AccessKey ID 和 Secret` : `还没配只读 AccessKey（${p} 是空的）` };
    return { ok: false, file: p, why: `${p} 里有 ${found.length} 个文件都像 AccessKey，不知道用哪个：${found.map((c) => path.basename(c.file)).join('、')}` };
  }
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8').replace(/^﻿/, ''); } catch {
    return { ok: false, missing: true, file: p, why: `还没配只读 AccessKey（${p} 不存在）` };
  }
  let id, secret;
  const text = raw.trim();
  if (text.startsWith('{')) {
    try { const j = JSON.parse(text); id = j.accessKeyId ?? j.AccessKeyId; secret = j.accessKeySecret ?? j.AccessKeySecret; } catch {
      return { ok: false, file: p, why: `${p} 看着像 JSON，但解析不了` };
    }
  } else if (/^AccessKey\s*Secret(?:\s*[:：]\s*|\s+)[^\s,]+\s*$/im.test(text)) {
    // 「创建成功」页存下来的文本：一行一个「标签 值」（AccessKey ID xxx / AccessKey Secret xxx），
    // 同一份里还有登录名、登录密码、安全邮箱之类——只认这两行，别的一概不碰。
    // 值不许带逗号：免得把 CSV 表头「AccessKeyId,AccessKeySecret」误读成「标签 + 值」
    const pick = (re) => text.split(/\r?\n/).map((l) => re.exec(l.trim())?.[1]).find(Boolean);
    id = pick(/^AccessKey\s*ID(?:\s*[:：]\s*|\s+)([^\s,]+)$/i);
    secret = pick(/^AccessKey\s*Secret(?:\s*[:：]\s*|\s+)([^\s,]+)$/i);
  } else {
    // RAM 用户的 CSV 可能多几列（用户名之类），按表头找列；没表头就认前两列
    const rows = text.split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))).filter((r) => r.some(Boolean));
    const head = rows.findIndex((r) => r.some((c) => /access\s*key/i.test(c)));
    const idCol = head >= 0 ? rows[head].findIndex((c) => /access\s*key\s*id/i.test(c)) : 0;
    const secCol = head >= 0 ? rows[head].findIndex((c) => /secret/i.test(c)) : 1;
    const data = rows[head + 1];
    if (data && idCol >= 0 && secCol >= 0) [id, secret] = [data[idCol], data[secCol]];
  }
  if (!id || !secret) return { ok: false, file: p, why: `${p} 里没找到 AccessKey ID 和 Secret（认三种：控制台下载的 CSV、「AccessKey ID xxx / AccessKey Secret xxx」逐行的文本、{"accessKeyId","accessKeySecret"} 的 JSON）` };
  return { ok: true, file: p, accessKeyId: String(id).trim(), accessKeySecret: String(secret).trim() };
}

// ---------- 签名 V3 ----------

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** RFC 3986：只有 A-Z a-z 0-9 - _ . ~ 不编码（encodeURIComponent 还放过了 ! ' ( ) *）。 */
export function percentEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * ACS3-HMAC-SHA256。RPC 风格：参数全放查询串，请求体为空。
 * 规范请求 = 方法 \n / \n 规范查询串 \n 规范头（每行以 \n 结尾）\n 签名头列表 \n 请求体哈希。
 */
export function signRequest({ method = 'POST', host, action, version, query = {}, accessKeyId, accessKeySecret, date, nonce, body = '' }) {
  const hashedPayload = body ? sha256hex(body) : EMPTY_SHA256;
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-content-sha256': hashedPayload,
    'x-acs-date': date,
    'x-acs-signature-nonce': nonce,
    'x-acs-version': version,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(query[k])}`).join('&');
  const canonicalRequest = [method, '/', canonicalQuery, canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const hashedCanonicalRequest = sha256hex(canonicalRequest);
  const stringToSign = `ACS3-HMAC-SHA256\n${hashedCanonicalRequest}`;
  const signature = crypto.createHmac('sha256', accessKeySecret).update(stringToSign, 'utf8').digest('hex');
  return {
    headers: { ...headers, authorization: `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}` },
    canonicalQuery, hashedCanonicalRequest, signature,
  };
}

/** 阿里云的错误码翻成「该怎么办」。 */
export function explainError(code, message, site, host = '') {
  const c = String(code || '');
  if (c.startsWith('InvalidAccessKeyId')) return 'AccessKey ID 不存在——填错了，或者已被删除';
  // 实测：国际站账号打中国站的费用中心就是这个错（反过来同理）
  if (c.startsWith('AuthSiteFail')) {
    return `账号和站点对不上——把 manager.yaml 的 vps.billing.site 改成 ${site === 'intl' ? 'cn（阿里云中国站）' : 'intl（国际站 alibabacloud.com）'}`;
  }
  if (/SignatureDoesNotMatch|IncompleteSignature|InvalidSignature/i.test(c)) return 'AccessKey Secret 不对（签名对不上）——重新从控制台下载的 CSV 拷过来';
  if (/Forbidden|NoPermission|NotAuthorized|Unauthorized/i.test(c)) {
    // 只点名缺的那一个：费用中心通了、轻量没授权时，说「两个都加」会让人以为前一个也没生效
    const policy = host.startsWith('swas.') ? 'AliyunSWASReadOnlyAccess（轻量应用服务器只读）'
      : host.startsWith('business.') ? 'AliyunBSSReadOnlyAccess（费用中心只读）'
      : 'AliyunBSSReadOnlyAccess 和 AliyunSWASReadOnlyAccess';
    return `这个 RAM 用户没有权限——在 RAM 控制台给它加上 ${policy}`;
  }
  if (/InvalidTimeStamp|RequestTimeTooSkewed/i.test(c)) return '本机时间和阿里云差太多（超过 15 分钟），对一下系统时间';
  return `${c || '出错'}：${String(message || '').slice(0, 200)}`;
}

/** 发一个 RPC 请求。永远不抛：{ ok, data } 或 { ok:false, code, why }。 */
export async function callApi({ host, action, version, query = {}, cred, site = 'cn', timeoutMs = 15000 }) {
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomBytes(16).toString('hex');
  const { headers, canonicalQuery } = signRequest({
    host, action, version, query, date, nonce, accessKeyId: cred.accessKeyId, accessKeySecret: cred.accessKeySecret,
  });
  delete headers.host;   // 和 URL 里的主机名一致，交给 fetch 自己带
  let res, text;
  try {
    res = await fetch(`https://${host}/${canonicalQuery ? `?${canonicalQuery}` : ''}`, {
      method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, code: 'Network', why: `连不上 ${host}：${e?.cause?.code || e?.name || e?.message}` };
  }
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, code: `HTTP${res.status}`, why: `${host} 回的不是 JSON（HTTP ${res.status}）` }; }
  // BSS 出错时也可能回 200 + Success:false
  if (!res.ok || data.Success === false) {
    return { ok: false, code: data.Code, why: explainError(data.Code, data.Message, site, host) };
  }
  return { ok: true, data };
}

// ---------- 查询 ----------

const amount = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** 费用中心的一条「可用实例」→ 一条订阅。 */
export function toSubscription(x, cfg) {
  const time = (v) => (v ? Date.parse(v) : null);
  return {
    id: String(x.InstanceID),
    product: x.ProductCode || null,
    productName: PRODUCT[x.ProductCode] || x.ProductCode || '未知产品',
    region: x.Region || null,
    regionName: REGION[x.Region] || x.Region || null,
    endTime: time(x.EndTime), createTime: time(x.CreateTime),
    renewStatus: x.RenewStatus || null,               // AutoRenewal / ManualRenewal / NotRenewal
    renewalDuration: x.RenewalDuration ?? null, renewalUnit: x.RenewalDurationUnit || null,
    status: x.Status || null,                         // Creating / WaitForExpire / Normal / Expired
    isVps: x.ProductCode === 'swas' && x.Region === cfg.region,
  };
}

/** 两个查询拼成一份结果；一个失败不影响另一个，失败原因逐项记下。 */
export async function fetchBilling(cfg, { call = callApi } = {}) {
  const cred = loadCredentials(cfg.credentials);
  const base = { checkedAt: Date.now(), site: cfg.site, region: cfg.region };
  if (!cred.ok) return { ...base, ok: false, configured: false, why: cred.why, credentialsFile: cred.file };
  const host = BSS_HOST[cfg.site] || BSS_HOST.cn;
  const q = (action, query) => call({ host, action, version: '2017-12-14', query, cred, site: cfg.site });
  const errors = [];

  const [subs, bal] = await Promise.all([
    q('QueryAvailableInstances', { SubscriptionType: 'Subscription', PageSize: 300 }),
    q('QueryAccountBalance', {}),
  ]);

  let subscriptions = null;
  if (subs.ok) {
    subscriptions = (subs.data.Data?.InstanceList || [])
      .filter((x) => x.SubscriptionType !== 'PayAsYouGo')
      .map((x) => toSubscription(x, cfg))
      .sort((a, b) => (a.endTime ?? Infinity) - (b.endTime ?? Infinity));   // 最先到期的排前面
  } else errors.push({ part: '订阅', why: subs.why });

  let balance = null;
  if (bal.ok) {
    const d = bal.data.Data || {};
    balance = { available: amount(d.AvailableAmount), cash: amount(d.AvailableCashAmount), credit: amount(d.CreditAmount), currency: d.Currency || 'CNY' };
  } else errors.push({ part: '余额', why: bal.why });

  return { ...base, ok: !errors.length, configured: true, subscriptions, balance, errors };
}

// ---------- 提醒 ----------

const money = (n, cur) => `${cur === 'CNY' || !cur ? '¥' : `${cur} `}${n.toFixed(2)}`;
const ymd = (ms) => { const d = new Date(ms + 8 * 3600_000); return d.toISOString().slice(0, 10); };   // 按北京时间说日期

/** 到期还剩几天（不足一天算一天，过了是负数）。 */
export const daysLeft = (expiresAt, now = Date.now()) => Math.ceil((expiresAt - now) / DAY);

/** 「轻量应用服务器 · 杭州（这台 VPS）」 */
export const subLabel = (s) => `${s.productName}${s.regionName ? ` · ${s.regionName}` : ''}${s.isVps ? '（这台 VPS）' : ''}`;

/**
 * 该提醒什么。每条 { key, level: 'warn'|'bad', text }；key 用来做「一天最多弹一次」。
 * 查询本身出错不在这里：那是「查不到」，不是「该续费」，界面上单独显示。
 *
 *  - 订阅已到期（服务已停）、或费用中心标了「即将停止服务」：红。
 *  - 到期前 remindDays（默认 7）天内：手动续费 / 到期不续 → 黄，3 天内红——「去续费 / 充值」；
 *    自动续费的：余额低于 minBalance 才提醒（会续，但可能扣不动），否则不打扰。
 *  - 余额为负（欠费）：红；低于 minBalance：黄（默认 0，即只管欠费）。
 */
export function billingAlerts(b, cfg, now = Date.now()) {
  if (!b?.configured) return [];
  const out = [];
  const bal = b.balance;
  const cur = bal?.currency;
  const low = bal?.available != null && bal.available < cfg.minBalance;
  let balanceSaid = false;

  for (const s of b.subscriptions || []) {
    const key = `expiry:${s.id}`;
    const what = subLabel(s);
    if (s.status === 'Expired') {
      out.push({ key, level: 'bad', text: `${what}已到期、服务已停——尽快去费用中心续费，过了保留期会被释放` });
      continue;
    }
    if (!s.endTime) continue;
    const d = daysLeft(s.endTime, now);
    const ending = s.status === 'WaitForExpire';
    if (d > cfg.remindDays && !ending) continue;
    const level = d <= 3 || ending ? 'bad' : 'warn';
    const when = `${d <= 0 ? '今天' : `${d} 天后`}（${ymd(s.endTime)}）到期`;
    if (s.renewStatus === 'AutoRenewal') {
      if (low) {
        out.push({ key, level, text: `${what}${when}，会自动续费，但余额只有 ${money(bal.available, cur)}——先充值，或确认绑的卡能扣款` });
        balanceSaid = true;
      }
    } else {
      const how = s.renewStatus === 'NotRenewal' ? '设成了到期不续费' : '是手动续费';
      out.push({ key, level, text: `${what}${when}，${how}——去费用中心续费 / 充值` });
    }
  }

  if (bal?.available != null && !balanceSaid) {
    if (bal.available < 0) out.push({ key: 'balance', level: 'bad', text: `余额是负的（${money(bal.available, cur)}）——已欠费，先充值，不然会停机` });
    else if (low) out.push({ key: 'balance', level: 'warn', text: `余额 ${money(bal.available, cur)}，低于提醒线 ${money(cfg.minBalance, cur)}` });
  }
  return out;
}

/**
 * 这一轮要弹哪几条：同一个 key 同一天（北京时间）只弹一次；级别升了（warn → bad）当天可以再弹。
 * notified 是落盘的 { key: { day, level } }，返回新的 notified。
 */
export function dueNotifications(alerts, notified = {}, now = Date.now()) {
  const day = ymd(now);
  const due = alerts.filter((a) => {
    const n = notified[a.key];
    return !n || n.day !== day || (n.level === 'warn' && a.level === 'bad');
  });
  const next = { ...notified };
  for (const a of due) next[a.key] = { day, level: a.level };
  return { due, notified: next };
}

export { ymd as billingDay };
