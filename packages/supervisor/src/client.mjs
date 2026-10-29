// CLI 在管理器常驻时必须走它，不能自己再开一个 Supervisor——
// 两个实例会互相覆盖 state.json，还可能各自 spawn 一份服务（一个服务只能有一个管理者，这正是要防的事）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { passwordFileOf } from './auth.mjs';

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

export async function connect(cfg, { timeoutMs = 1500 } = {}) {
  const base = `http://${cfg.bind}:${cfg.port}`;
  let cookie = '';

  const call = async (p, opts = {}) => {
    const r = await fetch(base + p, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // 探活：管理器不在就返回 null，CLI 退回本地直连模式（降级手册的第一层）
  try {
    const r = await fetch(`${base}/api/auth/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const st = await r.json();
    if (st.enabled && !st.authed) {
      // 本机 CLI 有资格读口令文件，用同一套 SCRAM 换会话——不给 CLI 开后门旁路
      const pwFile = passwordFileOf(cfg);
      const pw = fs.readFileSync(pwFile, 'utf-8').trim();
      const c = (await call('/api/auth/challenge', { method: 'POST', body: '{}' })).body;
      const salted = crypto.pbkdf2Sync(Buffer.from(pw, 'utf-8'), Buffer.from(c.salt, 'hex'), c.iterations, 32, 'sha256');
      const clientKey = hmac(salted, 'Client Key');
      const sig = hmac(sha256(clientKey), c.nonce);
      const proof = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) proof[i] = clientKey[i] ^ sig[i];
      const v = (await call('/api/auth/verify', { method: 'POST', body: JSON.stringify({ nonce: c.nonce, proof: proof.toString('base64') }) })).body;
      if (!v.ok) throw new Error(`管理器鉴权失败：${v.why}`);
      cookie = `lsm_session=${v.token}`;
    }
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.cause?.code === 'ECONNREFUSED') return null;
    if (String(e.message).includes('鉴权失败')) throw e;
    return null;
  }

  const action = async (body) => (await call('/api/action', { method: 'POST', body: JSON.stringify(body) })).body;

  return {
    remote: true,
    async snapshot() { return (await call('/api/state')).body; },
    start: (id) => action({ action: 'start', id }),
    stop: (id, o = {}) => action({ action: 'stop', id, ...o }),
    restart: (id, o = {}) => action({ action: 'restart', id, ...o }),
    startProfile: (name) => action({ action: 'profile-start', id: name }),
    stopProfile: (name, o = {}) => action({ action: 'profile-stop', id: name, ...o }),
    resolveOrphan: (id, decision) => action({ action: 'orphan', id, decision }),
    cancelPendingStop: (id) => action({ action: 'cancel-stop', id }),
    detachTask: (task) => action({ action: 'detach-task', task }),
    reload: () => action({ action: 'reload' }),
    setAutostart: (id, on) => action({ action: 'autostart-set', id, on }),
    openTailnet: (id, name) => action({ action: 'tailnet-open', id, name }),
    closeTailnet: (id) => action({ action: 'tailnet-close', id }),
    refreshVps: () => action({ action: 'vps-refresh' }),
    removeOwned: (id) => action({ action: 'owned-remove', id }),
    async scan() { return (await call('/api/scan')).body; },
  };
}
