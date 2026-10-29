// Tailnet 入口：tailnet 里的设备（手机）经 https://<名字>.<domain>/ 访问本机服务，不经公网。
//
// 难点在证书：headscale 不给节点签证书（`tailscale status` 的 CertDomains 为空），也没有 Funnel，
// `tailscale serve --https` 拿不到浏览器认的证书——而浏览器只在 HTTPS 下才给麦克风（手机上的语音输入要用）。绕法：
//   1. 名字用 <名字>.<domain>（比如 <名字>.tail.example.com）：公网 DNS 指向 VPS，VPS 上的 certbot 能签到真证书；
//      没有自己的域名，也可以用把 VPS 的 IP 编进域名的通配 DNS 服务；
//   2. headscale 的 extra_records 把同一个名字在 tailnet 里指向本机：手机在 tailnet 里解析到的是本机的 100.64.x；
//   3. 证书拉回本机，本机的网关（tailnet-gateway，管理器托管）做 TLS 终结，解密后的字节原样转给服务的对外端口；
//   4. `tailscale serve --tcp 443` 把 tailnet 上的 443 交给网关。
// VPS 只签证书、发 DNS 记录，流量走 tailnet（直连或 DERP），公网上打不进来。
//
// 管理器改 VPS 的范围就这两样（certbot 签 *.<domain> 的证书、写 headscale 的 DNS 记录文件），
// 而且只在你点「开通 / 撤销」时做；平时只从 VPS 上**读**证书（续期后拉新的）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { TAILNET_FILE, TAILNET_ROUTES, TAILNET_CERTS } from './paths.mjs';
import { exposedPort } from './exposure.mjs';

const pexec = promisify(execFile);

export const DEFAULT_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';
export const DEFAULT_RECORDS = '/var/lib/headscale/extra-records.json';
const MAGIC_DNS = '100.100.100.100';
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// ---------------------------------------------------------------- 入口清单 registry/tailnet.yaml

const HEADER = [
  '# Tailnet 入口：tailnet 里的设备（手机）经 https://<name>.<manager.yaml 的 tailnet.domain>/ 访问这些服务，不经公网。',
  '# 连的是服务的对外端口（exposure.localPort，没写就是探活端口）；标了 exposure.never 的服务开不了。',
  '#',
  '# 平时用 WebUI 卡片上的「开通 tailnet 入口」或 `lsm tailnet <id> on|off` 改——它们还会去 VPS 上签证书、写 DNS 记录。',
  '# 手改这个文件只改本机这一半（网关路由），VPS 那一半不会跟着变。',
  '# 这个文件由管理器整份重写，写在这里的注释会被覆盖。',
];

/** 读清单。文件不存在 = 空；解析失败报出来，而不是当成空的悄悄覆盖掉你手改的内容。 */
export function loadTailnetList(file = TAILNET_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) {
    if (e.code === 'ENOENT') return { entries: new Map(), error: null };
    return { entries: new Map(), error: `tailnet.yaml 读不了：${e.message}` };
  }
  try {
    const doc = YAML.parse(raw) || {};
    if (doc.entries != null && !Array.isArray(doc.entries)) return { entries: new Map(), error: 'tailnet.yaml: entries 必须是列表' };
    const entries = new Map();
    for (const e of doc.entries || []) {
      if (!e || typeof e.id !== 'string' || typeof e.name !== 'string') return { entries: new Map(), error: 'tailnet.yaml: 每一项都要有 id 和 name' };
      entries.set(e.id, { name: e.name });
    }
    return { entries, error: null };
  } catch (e) {
    return { entries: new Map(), error: `tailnet.yaml 解析失败：${e.message}` };
  }
}

export function saveTailnetList(entries, file = TAILNET_FILE) {
  const list = [...entries].sort(([a], [b]) => a.localeCompare(b));
  const body = [
    ...HEADER,
    list.length ? 'entries:' : 'entries: []',
    ...list.flatMap(([id, e]) => [`  - id: ${id}`, `    name: ${e.name}`]),
    '',
  ].join('\n');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

export const hostOf = (name, cfg) => `${name}.${cfg.domain}`;

/** 默认名字：已经有公网地址就沿用它的第一段（chat.example.com → chat），否则用服务 id。 */
export function defaultName(svc) {
  const first = (() => { try { return new URL(svc.exposure?.publicUrl).hostname.split('.')[0]; } catch { return null; } })();
  return first && LABEL.test(first) ? first : svc.id.toLowerCase();
}

/** 能不能给这个服务开 tailnet 入口；不能的话为什么。界面上的按钮和 API 都从这里取。 */
export function tailnetCreatable(svc, cfg, vps) {
  if (svc.exposure?.never) return { ok: false, why: `${svc.id} 永不对外：${svc.exposure.never}` };
  if (svc.kind === 'external') return { ok: false, why: `${svc.id} 是外部服务` };
  if (!exposedPort(svc)) return { ok: false, why: `${svc.id} 没有端口` };
  if (!cfg?.domain || !cfg?.gateway) return { ok: false, why: 'registry/manager.yaml 里还没配 tailnet.domain / tailnet.gateway' };
  if (!vps?.host || !vps?.key) return { ok: false, why: 'registry/manager.yaml 里还没配 vps（签证书、写 DNS 记录要用）' };
  return { ok: true, why: null };
}

/** 清单的自检：reload 时跑，错误进 registryErrors。 */
export function tailnetListErrors(entries, services, cfg) {
  const errors = [];
  const seen = new Map();
  for (const [id, e] of entries) {
    const svc = services.get(id);
    if (!svc) { errors.push(`tailnet.yaml: "${id}" 不存在`); continue; }
    if (!LABEL.test(e.name)) errors.push(`tailnet.yaml: ${id} 的 name "${e.name}" 不是合法的域名标签（小写字母、数字、连字符）`);
    if (seen.has(e.name)) errors.push(`tailnet.yaml: ${id} 和 ${seen.get(e.name)} 用了同一个 name "${e.name}"`);
    seen.set(e.name, id);
    if (svc.exposure?.never) errors.push(`tailnet.yaml: ${id} 标了 exposure.never（${svc.exposure.never}），却开着 tailnet 入口`);
  }
  if (entries.size && (!cfg?.domain || !cfg?.gateway)) errors.push('tailnet.yaml 里有入口，但 manager.yaml 没配 tailnet.domain / tailnet.gateway');
  if (cfg?.gateway && !services.has(cfg.gateway)) errors.push(`manager.yaml: tailnet.gateway 指向的服务 "${cfg.gateway}" 不存在`);
  return errors;
}

// ---------------------------------------------------------------- 网关路由表 / 本机证书

export function certDir(host) { return path.join(TAILNET_CERTS, host); }

/** 网关读的路由表：名字 → 本机端口 + 证书文件。 */
export function routesFor(entries, services, cfg) {
  return [...entries].flatMap(([id, e]) => {
    const svc = services.get(id);
    const port = svc && exposedPort(svc);
    if (!port || !cfg?.domain) return [];
    const host = hostOf(e.name, cfg);
    return [{ host, id, port, cert: path.join(certDir(host), 'fullchain.pem'), key: path.join(certDir(host), 'privkey.pem') }];
  });
}

export function writeRoutes(routes, file = TAILNET_ROUTES) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ note: '由管理器生成（registry/tailnet.yaml），tailnet-gateway 读它；别手改', routes }, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * headscale 的 DNS 记录：只管 <domain> 底下的名字，文件里别人写的记录原样保留。
 * ip 拿不到时（本机 tailscale 不在线）沿用记录里原来的值。
 */
export function mergeRecords(existing, hosts, ip, domain) {
  const ours = (r) => r?.name === domain || String(r?.name || '').endsWith('.' + domain);
  const old = new Map((existing || []).filter(ours).map((r) => [r.name, r.value]));
  const keep = (existing || []).filter((r) => !ours(r));
  const add = [...hosts].sort().map((h) => ({ name: h, type: 'A', value: ip || old.get(h) })).filter((r) => r.value);
  return [...keep, ...add];
}

/** 证书和私钥是不是一对、证书是不是给这个名字的、什么时候到期。 */
export function inspectCert(fullchain, privkey, host) {
  const cert = new crypto.X509Certificate(fullchain);
  const key = crypto.createPrivateKey(privkey);
  if (!cert.checkPrivateKey(key)) throw new Error('证书和私钥不是一对');
  if (!cert.checkHost(host)) throw new Error(`证书不是给 ${host} 的（${cert.subjectAltName}）`);
  return { notAfter: new Date(cert.validTo).getTime(), fingerprint: cert.fingerprint256 };
}

// ---------------------------------------------------------------- tailscale（本机 CLI）

async function tsRun(cfg, args, timeout = 15000) {
  const { stdout } = await pexec(cfg?.cli || DEFAULT_CLI, args, { timeout, windowsHide: true, maxBuffer: 8 << 20 });
  return stdout;
}

/** serve 配置里某个 TCP 端口转给了谁（'127.0.0.1:8445'），没配就是 null。 */
export function serveTarget(serveConfig, port = 443) {
  return serveConfig?.TCP?.[String(port)]?.TCPForward || null;
}

/** 本机节点：在不在线、哪个 tailnet、tailnet 里还有谁、serve 配了什么。读不到就把原因带回去，不抛。 */
export async function nodeStatus(cfg) {
  try {
    const [st, serve] = await Promise.all([
      tsRun(cfg, ['status', '--json']).then(JSON.parse),
      tsRun(cfg, ['serve', 'status', '--json']).then((s) => JSON.parse(s || '{}')).catch(() => null),
    ]);
    const self = st.Self || {};
    const ipv4 = (self.TailscaleIPs || []).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)) || null;
    return {
      ok: st.BackendState === 'Running', backend: st.BackendState,
      tailnet: st.CurrentTailnet?.Name || null,
      self: { host: self.HostName || null, dnsName: (self.DNSName || '').replace(/\.$/, '') || null, ipv4, online: !!self.Online },
      peers: Object.values(st.Peer || {}).map((p) => ({
        host: p.HostName, os: p.OS, online: !!p.Online,
        ipv4: (p.TailscaleIPs || []).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)) || null,
        lastSeen: p.LastSeen && !p.LastSeen.startsWith('0001') ? Date.parse(p.LastSeen) : null,
      })),
      certDomains: st.CertDomains || [],
      serve, serve443: serveTarget(serve),
      checkedAt: Date.now(),
    };
  } catch (e) {
    return { ok: false, backend: null, why: e.code === 'ENOENT' ? `找不到 tailscale：${cfg?.cli || DEFAULT_CLI}` : (e.stderr?.trim() || e.message), checkedAt: Date.now() };
  }
}

/** 让 tailnet 上的 443 转给网关（on），或者撤掉（off）。已经是想要的样子就什么都不做。 */
export async function ensureServe(cfg, gwPort, on) {
  const cur = serveTarget(await tsRun(cfg, ['serve', 'status', '--json']).then((s) => JSON.parse(s || '{}')));
  const want = on ? `127.0.0.1:${gwPort}` : null;
  if (cur === want) return { ok: true, changed: false, target: cur };
  if (on) await tsRun(cfg, ['serve', '--bg', '--tcp', '443', `tcp://127.0.0.1:${gwPort}`]);
  else await tsRun(cfg, ['serve', '--tcp', '443', 'off']);
  const after = serveTarget(await tsRun(cfg, ['serve', 'status', '--json']).then((s) => JSON.parse(s || '{}')));
  return after === want ? { ok: true, changed: true, target: after } : { ok: false, why: `tailscale serve 没改成功：现在 443 → ${after || '（无）'}` };
}

// ---------------------------------------------------------------- VPS（ssh）

function sshRun(vps, script, timeout = 120000) {
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-i', vps.key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', vps.host, 'bash -s'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(script);
  });
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 读 VPS 上 headscale 的 DNS 记录文件（只读）。 */
export async function readRecords(vps, cfg) {
  const file = cfg.records || DEFAULT_RECORDS;
  const r = await sshRun(vps, `cat ${shq(file)}\n`, 30000);
  if (r.code !== 0) return { ok: false, why: `读不了 VPS 上的 ${file}：${(r.err || r.out).trim().split('\n').pop()}` };
  try { return { ok: true, records: JSON.parse(r.out || '[]') }; } catch (e) { return { ok: false, why: `${file} 不是合法 JSON：${e.message}` }; }
}

/**
 * 改 VPS：给 certHosts 里还没有证书的名字签证书，然后整份写入 DNS 记录文件。
 * 签证书要用 80 端口：tailnet.certbotStopUnits 里列的（占着 80 的）systemd 服务先停、签完再起（约 10 秒），签失败也一定拉起来（trap）。
 * headscale 监视记录文件，写完即时下发，不用重启。
 */
/** 签证书时要临时停掉的 systemd 服务（占着 80 端口的）：manager.yaml 的 tailnet.certbotStopUnits，只认正经的单元名。 */
export const stopUnits = (cfg) => (cfg?.certbotStopUnits || []).map(String).filter((u) => /^[A-Za-z0-9@._-]+$/.test(u));

export async function vpsApply(vps, cfg, { certHosts = [], records }) {
  const units = stopUnits(cfg).join(' ');
  const file = cfg.records || DEFAULT_RECORDS;
  for (const h of certHosts) if (!h.endsWith('.' + cfg.domain) || !/^[a-z0-9.-]+$/.test(h)) return { ok: false, why: `不签 ${h}：不在 ${cfg.domain} 底下` };
  const json = Buffer.from(JSON.stringify(records, null, 2) + '\n').toString('base64');
  const script = [
    'set -euo pipefail',
    `HOSTS=(${certHosts.map(shq).join(' ')})`,
    'NEED=()',
    'for h in "${HOSTS[@]}"; do [ -d "/etc/letsencrypt/live/$h" ] || NEED+=("$h"); done',
    'if [ ${#NEED[@]} -gt 0 ]; then',
    ...(units ? [`  systemctl stop ${units}`, `  trap ${shq(`systemctl start ${units}`)} EXIT`] : []),
    '  for h in "${NEED[@]}"; do certbot certonly --standalone --non-interactive --agree-tos -d "$h" >/dev/null && echo "CERT-ISSUED $h"; done',
    ...(units ? [`  systemctl start ${units}`, '  trap - EXIT'] : []),
    'fi',
    `F=${shq(file)}`,
    `echo ${shq(json)} | base64 -d > "$F.tmp"`,
    'chown --reference="$F" "$F.tmp" 2>/dev/null || chown headscale:headscale "$F.tmp"',
    'chmod 0640 "$F.tmp"',
    'mv "$F.tmp" "$F"',
    'echo RECORDS-WRITTEN',
  ].join('\n') + '\n';
  const r = await sshRun(vps, script, 180000);
  const issued = [...r.out.matchAll(/^CERT-ISSUED (\S+)$/gm)].map((m) => m[1]);
  if (r.code !== 0 || !/RECORDS-WRITTEN/.test(r.out)) {
    return { ok: false, issued, why: `VPS 上没做完（退出码 ${r.code}）：${(r.err || r.out).trim().split('\n').slice(-3).join(' / ')}` };
  }
  return { ok: true, issued };
}

/**
 * 从 VPS 把证书拉回本机（只读 VPS）。内容没变就不写——网关按文件修改时间重载，白写会让它白重载一次。
 * 续期是 VPS 上 certbot 的事（占 80 端口的服务要在 certbot 的续期钩子里自己停 / 起），这里只负责把新的那份拉回来。
 */
export async function pullCert(vps, host) {
  const marker = '-----LSM-SPLIT-----';
  const live = `/etc/letsencrypt/live/${host}`;
  const r = await sshRun(vps, `cat ${shq(live + '/fullchain.pem')}; echo ${shq(marker)}; cat ${shq(live + '/privkey.pem')}\n`, 30000);
  if (r.code !== 0) return { ok: false, why: `从 VPS 读不了 ${host} 的证书：${(r.err || r.out).trim().split('\n').pop()}` };
  const [fullchain, privkey] = r.out.split(marker + '\n');
  let info;
  try { info = inspectCert(fullchain, privkey, host); } catch (e) { return { ok: false, why: `${host} 的证书不对：${e.message}` }; }
  const dir = certDir(host);
  fs.mkdirSync(dir, { recursive: true });
  const fc = path.join(dir, 'fullchain.pem');
  let same = false;
  try { same = fs.readFileSync(fc, 'utf-8') === fullchain; } catch {}
  if (!same) {
    // 私钥先落地、证书后落地：网关看到新证书时，配对的私钥一定已经在了
    for (const [name, body] of [['privkey.pem', privkey], ['fullchain.pem', fullchain]]) {
      fs.writeFileSync(path.join(dir, name + '.tmp'), body, 'utf-8');
      fs.renameSync(path.join(dir, name + '.tmp'), path.join(dir, name));
    }
  }
  return { ok: true, changed: !same, ...info };
}

// ---------------------------------------------------------------- 实测

/** 经本机网关真打一遍（校验证书链和名字），拿到状态码就算通——401/403 说明请求到了服务，只是没带凭证。 */
function viaGateway(host, gwPort) {
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: gwPort, servername: host, path: '/', method: 'GET',
      headers: { host }, timeout: 8000, agent: false,
    }, (res) => { resolve({ ok: res.statusCode < 500, status: res.statusCode }); res.destroy(); });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', (e) => resolve({ ok: false, status: null, why: e.code || e.message }));
    req.end();
  });
}

/**
 * 一个入口通不通，分三段看（手机那一段从这里测不到——那要你在手机上打开）：
 *   网关：经本机网关打一遍，证书对、服务回了话；
 *   DNS：tailnet 的 DNS（100.100.100.100）把这个名字解析到本机；
 *   serve：tailnet 上的 443 转给了网关。
 */
export async function checkEntry(host, gwPort, node) {
  const gateway = await viaGateway(host, gwPort);
  let dns;
  try {
    const r = new Resolver({ timeout: 3000, tries: 1 });
    r.setServers([MAGIC_DNS]);
    const ips = await r.resolve4(host);
    dns = { ok: !!node?.self?.ipv4 && ips.includes(node.self.ipv4), ips };
  } catch (e) { dns = { ok: false, ips: [], why: e.code || e.message }; }
  const serve = { ok: node?.serve443 === `127.0.0.1:${gwPort}`, target: node?.serve443 || null };
  return { ok: gateway.ok && dns.ok && serve.ok, gateway, dns, serve, checkedAt: Date.now() };
}
