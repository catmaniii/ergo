// VPS 搭建的执行层（321 号票）：本机要跑的外部命令（ssh、ssh-keygen、tailscale）、从本机看端口、打 https，全经这一层。
//
// 为什么单独一层：`lsm vps …` 要碰的是别人的机器。测试绝不能真的 ssh 出去、真的连谁的端口，所以测试换一个假的执行层——
// 它记下"要跑什么"、按预设的输出回话。CLI 端到端的测试用环境变量 LSM_VPS_EXEC 指向一个模块，模块导出 createExec()，
// 返回和下面 realExec() 一样形状的对象（只给测试用；平时不设）。
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

/**
 * 跑一条本机命令。argv[0] 是程序，不经 shell（不拼引号、不弹窗口）。
 * input：送进 stdin 的内容；onData(chunk, stream)：边跑边看输出（长脚本要给用户看进度）；
 * inherit：stdin/stdout/stderr 直接接终端（只给"让用户自己在 ssh 的提示里输密码"那一步用）。
 */
function run(argv, { input = null, timeout = 0, onData = null, inherit = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: -1, out: '', err: e.message }); return; }
    let out = '', err = '';
    let timer = null;
    if (timeout) timer = setTimeout(() => { err += `\n（${Math.round(timeout / 1000)} 秒没跑完，已中止）`; child.kill(); }, timeout);
    if (!inherit) {
      child.stdout.on('data', (d) => { const s = d.toString('utf-8'); out += s; onData?.(s, 'out'); });
      child.stderr.on('data', (d) => { const s = d.toString('utf-8'); err += s; onData?.(s, 'err'); });
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    }
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: e.code === 'ENOENT' ? `找不到 ${argv[0]}` : e.message }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
  });
}

/** 从本机连一下 host:port（TCP）：open 通了；refused 到了机器但没人听（安全组是放行的）；timeout 多半被安全组拦了。 */
function tcp(host, port, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeout, () => done('timeout'));
    sock.on('connect', () => done('open'));
    sock.on('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ETIMEDOUT' ? 'timeout' : `error:${e.code || e.message}`));
  });
}

/**
 * 打一个 https 地址（也认 http，测试拿本机的假服务验证判断逻辑）。证书按系统信任的根校验、名字要对得上——
 * 证书不对就是 tlsError，不会"凑合着看看"。headers.host 可以改 Host（只在 http 上有意义）。
 */
function request(url, { method = 'GET', headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, { method, headers, timeout, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (d) => { if (body.length < 65536) body += d; });
      res.on('end', () => {
        const cert = u.protocol === 'https:' ? res.socket?.getPeerCertificate?.() : null;
        resolve({
          status: res.statusCode, headers: res.headers, body,
          cert: cert && cert.valid_to ? { notAfter: Date.parse(cert.valid_to), subject: cert.subject?.CN || null, issuer: cert.issuer?.O || cert.issuer?.CN || null } : null,
        });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('超时'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => {
      const tls = /CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|HOSTNAME|ALTNAME|DEPTH_ZERO/i.test(e.code || '') || /certificate/i.test(e.message);
      resolve(tls ? { tlsError: `${e.code || ''} ${e.message}`.trim() } : { error: e.code || e.message });
    });
    req.end();
  });
}

/** 一个名字在公网 DNS 里解析到哪些 IPv4（走系统的解析）。解析不了就是空的。 */
async function resolve4(name) {
  try { return (await dns.lookup(name, { all: true, family: 4 })).map((r) => r.address); } catch { return []; }
}

/** 真的执行层：真跑命令、真连端口、真打 https、真查 DNS。 */
export function realExec() {
  return { kind: 'real', run, tcp, request, resolve4 };
}

/** 平时是真的；设了 LSM_VPS_EXEC（测试）就换成那个模块给的。 */
export async function loadExec(env = process.env) {
  if (!env.LSM_VPS_EXEC) return realExec();
  const mod = await import(pathToFileURL(env.LSM_VPS_EXEC).href);
  return mod.createExec();
}
