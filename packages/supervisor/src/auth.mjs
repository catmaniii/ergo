// 鉴权：SCRAM-SHA-256（口令不上网）：
// SCRAM-SHA-256 —— 口令本身不落盘、不上网；握手换会话令牌走 header/cookie 而非 query；
// 按来源 IP 失败计数 + 锁定；口令只能来自数据目录 .secrets/ 下的文件，绝不进任何配置文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SECRETS_DIR, dataPath } from './paths.mjs';
import { warn, info } from './log.mjs';

const ITERATIONS = 210000;
const SESSION_TTL_MS = 12 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const COOKIE = 'lsm_session';
const PUBLIC = new Set(['/api/auth/challenge', '/api/auth/verify', '/api/auth/status']);

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

/** WebUI 口令文件：manager.yaml 的 auth.passwordFile，相对路径相对数据目录（CLI 换会话时读同一个文件） */
export function passwordFileOf(cfg) {
  return dataPath(cfg?.auth?.passwordFile || '.secrets/webui-password.txt');
}

export function createAuth(cfg) {
  const enabled = !!cfg.auth?.enabled;
  const pwFile = passwordFileOf(cfg);
  const saltFile = path.join(SECRETS_DIR, 'webui-salt.txt');

  let password = null;
  if (enabled) {
    try { password = fs.readFileSync(pwFile, 'utf-8').trim(); } catch {}
    if (!password || password.length < 12) {
      throw new Error(`鉴权已开启，但 ${pwFile} 里没有至少 12 位的口令。\n` +
        '口令只能来自这个文件（硬规则：secret 不进配置文件）。\n' +
        '设置：lsm set-password "<你的强口令>"');
    }
  } else {
    warn('鉴权未开启：仅在绑定 127.0.0.1 且没有隧道出网时才可接受。开隧道前必须先 lsm set-password。');
  }

  let salt;
  if (enabled) {
    try { salt = Buffer.from(fs.readFileSync(saltFile, 'utf-8').trim(), 'hex'); } catch {}
    if (!salt || salt.length !== 16) {
      salt = crypto.randomBytes(16);
      fs.mkdirSync(path.dirname(saltFile), { recursive: true });
      fs.writeFileSync(saltFile, salt.toString('hex'), 'utf-8');
      info('已生成 WebUI 鉴权盐值');
    }
  }

  // StoredKey 由口令推导：服务器不需要保存明文口令的任何等价物在内存之外
  const storedKey = enabled
    ? sha256(hmac(crypto.pbkdf2Sync(Buffer.from(password, 'utf-8'), salt, ITERATIONS, 32, 'sha256'), 'Client Key'))
    : null;

  const sessions = new Map();
  const challenges = new Map();
  const fails = new Map();
  const lockouts = new Map();

  const ipOf = (req) => req.socket?.remoteAddress || 'unknown';
  const locked = (ip) => (lockouts.get(ip) || 0) > Date.now();

  function recordFail(ip) {
    const n = (fails.get(ip) || 0) + 1;
    fails.set(ip, n);
    if (n >= MAX_FAILS) {
      lockouts.set(ip, Date.now() + LOCKOUT_MS);
      fails.set(ip, 0);
      warn(`鉴权失败次数达上限，锁定 ${LOCKOUT_MS / 1000}s`, { ip });
    }
  }

  function valid(req) {
    if (!enabled) return true;
    const tok = readCookie(req, COOKIE) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const s = sessions.get(tok);
    if (!s) return false;
    if (s.exp < Date.now()) { sessions.delete(tok); return false; }
    return true;
  }

  return {
    enabled,
    check(req, p) {
      if (!enabled) return { reject: false };
      if (PUBLIC.has(p)) return { reject: false };
      if (!p.startsWith('/api/')) return { reject: false };   // 静态资源放行，登录界面自己在前端
      if (valid(req)) return { reject: false };
      return { reject: true, code: 401, body: { ok: false, needAuth: true } };
    },
    checkWs(req) { return valid(req); },
    status(req) { return { enabled, authed: valid(req) }; },

    challenge() {
      if (!enabled) return { enabled: false };
      const nonce = crypto.randomBytes(18).toString('base64url');
      challenges.set(nonce, Date.now() + 60000);
      for (const [k, exp] of challenges) if (exp < Date.now()) challenges.delete(k);
      return { enabled: true, nonce, salt: salt.toString('hex'), iterations: ITERATIONS };
    },

    /** 客户端算 ClientProof = ClientKey XOR HMAC(StoredKey, authMessage)，服务器只用 StoredKey 验。 */
    verify(body, req) {
      const ip = ipOf(req);
      if (!enabled) return { ok: true };
      if (locked(ip)) return { ok: false, why: '失败次数过多，已临时锁定' };
      const { nonce, proof } = body || {};
      if (!nonce || !challenges.has(nonce) || challenges.get(nonce) < Date.now()) return { ok: false, why: '挑战已过期，请重试' };
      challenges.delete(nonce);

      let clientProof;
      try { clientProof = Buffer.from(String(proof), 'base64'); } catch { return { ok: false, why: '证明格式不对' }; }
      if (clientProof.length !== 32) { recordFail(ip); return { ok: false, why: '证明格式不对' }; }

      const sig = hmac(storedKey, nonce);
      const clientKey = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) clientKey[i] = clientProof[i] ^ sig[i];
      if (!crypto.timingSafeEqual(sha256(clientKey), storedKey)) {
        recordFail(ip);
        return { ok: false, why: '口令不对' };
      }
      fails.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { exp: Date.now() + SESSION_TTL_MS, ip });
      return { ok: true, token, cookie: `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}` };
    },
  };
}

/** 写口令文件。口令永远不进注册表、不进日志、不进审计。 */
export function setPassword(pw) {
  if (!pw || pw.length < 12) throw new Error('口令至少 12 位');
  const dir = SECRETS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'webui-password.txt'), pw, 'utf-8');
  try { fs.unlinkSync(path.join(dir, 'webui-salt.txt')); } catch {}   // 换口令即换盐，旧会话材料作废
  return path.join(dir, 'webui-password.txt');
}
