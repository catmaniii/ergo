// 假的执行层（321 号票的测试用）：`lsm vps …` 要跑的外部命令（ssh、ssh-keygen、tailscale）、连端口、打 https、查 DNS，
// 都落到这里——记下"要跑什么"（送上 VPS 的脚本全文也记），按预设的场景回话。绝不真的 ssh、真的连谁。
//
// 两种用法：测试里直接 fakeExec(场景)；CLI 端到端测试设 LSM_VPS_EXEC 指向本文件，createExec() 从
// FAKE_VPS_SCENARIO（JSON 文件）读场景、每次调用追加一行到 FAKE_VPS_LOG。
import fs from 'node:fs';
import path from 'node:path';

/** 一台刚开出来的 Debian 12 的体检结果 */
export const FRESH_DEBIAN = {
  OS_ID: 'debian', OS_LIKE: '', OS_VERSION: '12', OS_PRETTY: 'Debian GNU/Linux 12 (bookworm)', ARCH: 'amd64',
  IS_ROOT: '1', SYSTEMD: '1', APT: '1',
  PKG_NGINX: '0', PKG_CERTBOT: '0', PKG_UFW: '0', PKG_UNATTENDED_UPGRADES: '1', PKG_HEADSCALE: '0', PKG_CURL: '1',
  HEADSCALE_BIN: '0', HEADSCALE_VERSION: '', NGINX_SITES: '0', NGINX_STREAM_443: '0',
  UFW_ACTIVE: '0', FIREWALLD_ACTIVE: '0', AUTO_UPGRADES: '1',
  SSHD_TCP_FORWARDING: 'yes', SSHD_ALLOW_USERS: '', SSHD_ALLOW_GROUPS: '', OPENSSH_VERSION: '9.2',
  LISTEN_TCP_80: '', LISTEN_TCP_443: '', LISTEN_UDP_3478: '', LISTEN_TCP_HS: '', LISTEN_TCP_TUNNEL: '',
  PUBLIC_TCP: '22 ', MANIFEST_BASE: '0', MANIFEST_TUNNEL: '0', MANIFEST_HEADSCALE: '0', DISK_FREE_MB: '20000', DNS_OK: '1',
};

/** 二狗的外网端口 8811 不带凭证时的样子 */
export const ERGO_EXTERNAL = {
  access: { status: 200, body: '{"access":"none"}' },
  health: { status: 401, body: '{"code":"unauthorized","message":"这个设备还没配对"}' },
};
/** nginx 把 Host 改成 127.0.0.1 再转给本机端口 8810 时的样子：整个公网免认证 */
export const ERGO_LOCAL_TRUSTED = {
  access: { status: 200, body: '{"access":"local"}' },
  health: { status: 200, body: '{"status":"ok"}' },
};
/** Host 原样转给 8810：本机端口只认 127.0.0.1 的 Host，拒了 */
export const ERGO_LOCAL_REFUSED = {
  access: { status: 403, body: '{"code":"forbidden","message":"拒绝：Host 不对"}' },
  health: { status: 403, body: '{"code":"forbidden","message":"拒绝：Host 不对"}' },
};

const CERT = { notAfter: Date.UTC(2027, 0, 25), subject: 'ergo.203.0.113.10.sslip.io', issuer: "Let's Encrypt" };

/** 认一下送上去的是哪份脚本（看第二行的标题） */
export function scriptKind(input) {
  const title = String(input || '').split('\n')[1] || '';
  if (title.includes('体检')) return 'checkup';
  if (title.includes('搭隧道入口')) return 'setup-tunnel';
  if (title.includes('搭自建 tailnet')) return 'setup-headscale';
  if (title.includes('撤掉')) return 'remove';
  if (title.includes('加 https 站点')) return 'site-add';
  if (title.includes('列证书')) return 'certs';
  if (title.includes('扫一遍')) return 'scan';
  if (title.includes('现在怎样')) return 'status';
  if (String(input).includes('headscale nodes register')) return 'approve';
  return 'unknown';
}

export function fakeExec(sc = {}, { log = null } = {}) {
  const calls = [];
  const lsmCalls = [];
  const queues = { login: [...(sc.login || [])], setup: [...(sc.setup || [])] };
  const record = (c) => { calls.push(c); if (log) fs.appendFileSync(log, `${JSON.stringify(c)}\n`); };
  const reply = (r, onData) => { if (onData && r.out) onData(r.out, 'out'); return { code: r.code ?? 0, out: r.out || '', err: r.err || '' }; };

  async function run(argv, { input = null, onData = null } = {}) {
    record({ type: 'run', argv, input });
    const prog = path.basename(argv[0]).replace(/\.exe$/i, '').toLowerCase();
    if (prog === 'ssh-keygen') {
      const f = argv[argv.indexOf('-f') + 1];
      const comment = argv[argv.indexOf('-C') + 1];
      const body = Buffer.from(`fake-key-${path.basename(f)}`).toString('base64').replace(/=+$/, '');
      fs.writeFileSync(f, 'FAKE PRIVATE KEY (测试用，不是真钥匙)\n');
      fs.writeFileSync(`${f}.pub`, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${body} ${comment}\n`);
      return { code: 0, out: '', err: '' };
    }
    if (prog === 'ssh') {
      const remote = argv[argv.length - 1];
      if (remote === 'echo ERGO-LOGIN-OK') {
        const o = queues.login.length ? queues.login.shift() : 'ok';
        return o === 'ok' ? { code: 0, out: 'ERGO-LOGIN-OK\n', err: '' } : { code: 255, out: '', err: 'root@203.0.113.10: Permission denied (publickey).\n' };
      }
      const kind = scriptKind(input);
      if (kind === 'checkup') {
        const kv = { ...FRESH_DEBIAN, CERT_LEFT: '-1', LISTEN_TCP_80_UNIT: '', ...sc.checkup };
        const dump = /WANT_NGINX_DUMP='1'/.test(input) && sc.nginxDump ? `${sc.nginxDump.split('\n').map((l) => `ERGO-NGX|${l}`).join('\n')}\n` : '';
        return { code: 0, out: `ERGO-CHECKUP=1\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n')}\n${dump}ERGO-DONE checkup\n`, err: '' };
      }
      if (kind === 'site-add') return reply(sc.siteAdd || { code: 0, out: 'ERGO-STEP layout ok\nERGO-RESULT CERT_OURS=1\nERGO-STEP cert-x ok\nERGO-DONE site\n' }, onData);
      if (kind === 'certs' || kind === 'scan') {
        const certs = (sc.certs || []).map((c) => `ERGO-CERT ${c.domain} ${c.notAfter == null ? 'none' : Math.floor(c.notAfter / 1000)}`).join('\n');
        const dump = kind === 'scan' && sc.nginxDump ? `${sc.nginxDump.split('\n').map((l) => `ERGO-NGX|${l}`).join('\n')}\n` : '';
        return { code: 0, out: `ERGO-${kind === 'certs' ? 'CERTS' : 'SCAN'}=1\n${certs}\n${dump}ERGO-DONE ${kind}\n`, err: '' };
      }
      if (kind === 'setup-tunnel' || kind === 'setup-headscale') {
        const mode = kind.slice(6);
        const r = queues.setup.length ? queues.setup.shift() : {};
        const out = r.out ?? `ERGO-STEP base-record ok\nERGO-STEP packages ok 装了 nginx certbot ufw\n${mode === 'headscale' && /WANT_AUTHKEY='1'/.test(input) ? `ERGO-RESULT AUTHKEY=${sc.authKey || 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed'}\n` : ''}ERGO-DONE ${mode}\n`;
        return reply({ code: r.code ?? 0, out, err: r.err }, onData);
      }
      if (kind === 'remove') return reply(sc.remove || { code: 0, out: 'ERGO-STEP site-x ok\nERGO-DONE remove\n' }, onData);
      if (kind === 'status') {
        const kv = { MANIFEST_TUNNEL: '1', MANIFEST_HEADSCALE: '1', SVC_NGINX: 'active', SVC_HEADSCALE: 'active', UFW_ACTIVE: '1', TUNNEL_ACCOUNT: '1', TUNNEL_LISTEN: '1', HS_HEALTH: '{"status":"pass"}', HS_NODES: '2', ...sc.status };
        const certs = (sc.certs || []).map((c) => `ERGO-CERT ${c.domain} ${c.notAfter == null ? 'none' : Math.floor(c.notAfter / 1000)}`).join('\n');
        return { code: 0, out: `ERGO-STATUS=1\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n')}\n${certs}\nERGO-DONE status\n`, err: '' };
      }
      if (kind === 'approve') return { code: 0, out: 'ERGO-DONE approve\n', err: '' };
      return { code: 1, out: '', err: `假的执行层不认识这份脚本：${String(input).split('\n')[1]}` };
    }
    if (prog === 'tailscale') {
      const ts = { backend: 'NeedsLogin', controlURL: '', upCode: 0, ...sc.tailscale };
      if (argv[1] === 'status') return { code: 0, out: JSON.stringify({ BackendState: ts.backend, Self: { HostName: 'pc' } }), err: '' };
      if (argv[1] === 'debug') return { code: 0, out: JSON.stringify({ ControlURL: ts.controlURL }), err: '' };
      if (argv[1] === 'up') return { code: ts.upCode, out: '', err: ts.upCode ? 'backend error: invalid key' : '' };
      if (argv[1] === 'logout') return { code: 0, out: '', err: '' };
    }
    return { code: -1, out: '', err: `找不到 ${argv[0]}` };
  }

  return {
    kind: 'fake', calls, lsmCalls, run,
    async tcp(host, port) { record({ type: 'tcp', host, port }); return sc.tcp?.[port] ?? 'refused'; },
    async request(url, opts = {}) {
      record({ type: 'request', url, headers: opts.headers || {} });
      const p = new URL(url).pathname;
      const site = sc.site || ERGO_EXTERNAL;
      if (sc.tlsError) return { tlsError: sc.tlsError };
      if (p === '/health') return { status: sc.hsHealth ?? 200, headers: {}, body: '{"status":"pass"}', cert: CERT };
      const r = p === '/api/access' ? site.access : p === '/healthz' ? site.health : p === '/' && sc.siteRoot ? sc.siteRoot : { status: 404, body: '' };
      return { ...r, headers: { 'strict-transport-security': 'max-age=31536000' }, cert: CERT };
    },
    async resolve4(name) { record({ type: 'resolve4', name }); return sc.dns?.[name] ?? ['203.0.113.10']; },
    lsm: {
      async reload() { lsmCalls.push(['reload']); return { ok: true }; },
      async start(id) { lsmCalls.push(['start', id]); return sc.lsmStart || { ok: true }; },
      async stop(id, o) { lsmCalls.push(['stop', id, o]); return { ok: true }; },
      async state(id) { lsmCalls.push(['state', id]); return sc.lsmState ?? 'RUNNING'; },
    },
  };
}

/** LSM_VPS_EXEC 指向本文件时 CLI 调这个 */
export function createExec() {
  const sc = process.env.FAKE_VPS_SCENARIO ? JSON.parse(fs.readFileSync(process.env.FAKE_VPS_SCENARIO, 'utf-8')) : {};
  return fakeExec(sc, { log: process.env.FAKE_VPS_LOG || null });
}
