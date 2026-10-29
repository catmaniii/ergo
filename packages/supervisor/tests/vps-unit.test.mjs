// `lsm vps setup` 的零件（321 号票）：VPS 地址、钥匙那一句、域名、体检结果的判断、状态文件、
// 隧道服务的登记（Windows 路径进 YAML）、"接到了 8810"的判断（拿本机起的假二狗网关真打）、nginx 站点、headscale 配置。全部离线。
import './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as paths from '../src/paths.mjs';
import * as rm from '../src/vps/remote.mjs';
import * as st from '../src/vps/state.mjs';
import { defaultDomain, validDomain, certSummary, parseCertLines, checkDns } from '../src/vps/certs.mjs';
import { assessCheckup, parseCheckup, neededPorts, portWarnings } from '../src/vps/checkup.mjs';
import { classifyErgo, verifyErgo, verifyHeadscale, localPortProblem } from '../src/vps/verify.mjs';
import { realExec } from '../src/vps/exec.mjs';
import {
  tunnelArgv, tunnelServiceYaml, writeTunnelService, deleteTunnelService, exposuresOf8810, MARKER,
  fillErgoExposure, clearErgoExposure, ERGO_DAEMON_ID, EXPOSURE_BEGIN, EXPOSURE_END,
} from '../src/vps/local.mjs';
import { loadServices } from '../src/registry.mjs';
import { ergoTunnelSite, headscaleSite, httpOnlySite } from '../src/vps/nginx.mjs';
import * as hs from '../src/vps/headscale.mjs';
import { parseOutput, maskSecrets } from '../src/vps/scripts.mjs';
import { parseArgs } from '../src/vps/cli.mjs';
import { buildPlan } from '../src/vps/setup.mjs';
import { FRESH_DEBIAN, fakeExec } from './_fake-vps-exec.mjs';

const vps = { user: 'root', host: '203.0.113.10', port: 22 };

test('VPS 地址：[用户@]主机[:端口]，默认 root、22；怪字符一律拒（这串会进 ssh 命令行和注册表）', () => {
  assert.deepEqual(rm.parseHost('203.0.113.10'), { user: 'root', host: '203.0.113.10', port: 22 });
  assert.deepEqual(rm.parseHost('debian@VPS.Example.com:2222'), { user: 'debian', host: 'vps.example.com', port: 2222 });
  assert.deepEqual(rm.parseHost('root@203.0.113.10', { port: '2200' }), { user: 'root', host: '203.0.113.10', port: 2200 });
  for (const bad of ['', 'root@', '203.0.113.10; rm -rf /', '-oProxyCommand=x', 'root@203.0.113.999', 'Root!@x.com', 'a@b@c', '[::1]', '203.0.113.10:70000']) {
    assert.throws(() => rm.parseHost(bad), Error, bad);
  }
});

test('ssh 的命令行：只用专用钥匙、不问密码、主机指纹记在专用 known_hosts（带空格的路径加引号）', () => {
  const a = rm.sshArgv({ ...vps, port: 2222 }, 'C:\\k\\admin', 'C:\\Users\\a b\\kh', 'bash -s');
  assert.deepEqual(a.slice(0, 3), ['ssh', '-i', 'C:\\k\\admin']);
  for (const o of ['BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=accept-new', 'UserKnownHostsFile="C:\\Users\\a b\\kh"']) assert.ok(a.includes(o), o);
  assert.deepEqual(a.slice(-4), ['-p', '2222', 'root@203.0.113.10', 'bash -s']);
  assert.equal(rm.remoteShell({ user: 'root' }), 'bash -s');
  assert.equal(rm.remoteShell({ user: 'debian' }), 'sudo -n bash -s');
});

test('放公钥的那一句：PowerShell / cmd 里原样能贴，重复跑不重复加；公钥里有怪字符就拒', () => {
  const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc ergo-supervisor-admin';
  assert.equal(rm.installKeyCommand(vps, pub),
    `ssh root@203.0.113.10 "umask 077; mkdir -p ~/.ssh; grep -qxF '${pub}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ~/.ssh/authorized_keys"`);
  assert.match(rm.installKeyCommand({ ...vps, port: 2222 }, pub), /^ssh -p 2222 root@/);
  assert.throws(() => rm.installKeyCommand(vps, "ssh-ed25519 AAAA'x"));
  assert.throws(() => rm.installKeyCommand(vps, 'ssh-ed25519 AAAA$(x)'));
});

test('钥匙：没有就生成（ssh-keygen 不设口令），有了原样用；生成出来的不像公钥就报错', async () => {
  const exec = fakeExec();
  const keys = rm.keyPaths(fs.mkdtempSync(path.join(paths.DATA_DIR, 'k-')));
  const a = await rm.ensureKey(exec, keys.admin, rm.ADMIN_COMMENT);
  assert.equal(a.created, true);
  assert.match(a.publicKey, /^ssh-ed25519 \S+ ergo-supervisor-admin$/);
  const argv = exec.calls[0].argv;
  assert.deepEqual([argv[0], argv[argv.indexOf('-N') + 1], argv[argv.indexOf('-t') + 1]], ['ssh-keygen', '', 'ed25519']);
  const b = await rm.ensureKey(exec, keys.admin, rm.ADMIN_COMMENT);
  assert.deepEqual([b.created, b.publicKey], [false, a.publicKey]);
  assert.equal(exec.calls.length, 1);
  fs.writeFileSync(`${keys.admin}.pub`, 'not a key');
  assert.throws(() => rm.readPublicKey(keys.admin), /不像一把 ed25519 公钥/);
});

test('域名：默认 <名字>.<IP>.sslip.io；名字、IP、域名的格式都要对；本机核对 DNS', async () => {
  assert.equal(defaultDomain('ergo', '203.0.113.10'), 'ergo.203.0.113.10.sslip.io');
  assert.throws(() => defaultDomain('Ergo_1', '203.0.113.10'));
  assert.throws(() => defaultDomain('ergo', 'vps.example.com'));
  assert.ok(validDomain('chat.example.com'));
  assert.ok(!validDomain('chat.example.com;x'));
  const exec = fakeExec({ dns: { 'ergo.example.com': ['198.51.100.7'] } });
  assert.deepEqual(await checkDns(exec, 'ergo.203.0.113.10.sslip.io', '203.0.113.10'), { ok: true, ips: ['203.0.113.10'] });
  assert.match((await checkDns(exec, 'ergo.example.com', '203.0.113.10')).why, /不是这台 VPS/);
});

test('证书：ERGO-CERT 行解析；还剩几天、少于 20 天提醒、过期、没有', () => {
  const now = Date.UTC(2026, 9, 27);
  assert.deepEqual(parseCertLines('x\nERGO-CERT a.example.com 1893456000\nERGO-CERT b.example.com none\n'),
    [{ domain: 'a.example.com', notAfter: 1893456000000 }, { domain: 'b.example.com', notAfter: null }]);
  assert.deepEqual(certSummary({ notAfter: now + 30 * 86400000 }, now), { ok: true, days: 30, warn: false, text: '还剩 30 天（到 2026-11-26）' });
  assert.equal(certSummary({ notAfter: now + 5 * 86400000 }, now).warn, true);
  assert.match(certSummary({ notAfter: now - 3 * 86400000 }, now).text, /已经过期 3 天/);
  assert.deepEqual(certSummary(undefined, now), { ok: false, days: null, warn: true, text: '没有证书' });
});

const tunnelPlan = { mode: 'tunnel', vps, publicIp: '203.0.113.10', domain: 'ergo.203.0.113.10.sslip.io', account: 'ergo-tunnel', remotePort: 18811, localPort: 8811, serviceId: 'ergo-vps-tunnel' };
const hsPlan = { mode: 'headscale', vps, publicIp: '203.0.113.10', domain: 'hs.203.0.113.10.sslip.io', hsPort: 8080, derp: true };

test('体检的判断：一台新 Debian 什么都不挡；各种挡路的说清楚', () => {
  assert.deepEqual(assessCheckup({ ...FRESH_DEBIAN }, tunnelPlan).blocking, []);
  assert.deepEqual(assessCheckup({ ...FRESH_DEBIAN }, hsPlan).blocking, []);
  const block = (over, plan = tunnelPlan) => assessCheckup({ ...FRESH_DEBIAN, ...over }, plan).blocking.join('\n');
  assert.match(block({ OS_ID: 'centos', OS_PRETTY: 'CentOS Stream 9' }), /只支持 Debian \/ Ubuntu/);
  assert.equal(block({ OS_ID: 'ubuntu', OS_LIKE: 'debian' }), '');
  assert.match(block({ IS_ROOT: '0' }), /免密 sudo/);
  assert.match(block({ NGINX_STREAM_443: '1' }), /stream 前门.*proxy_protocol/);
  assert.match(block({ LISTEN_TCP_80: 'apache2' }), /80 端口被 apache2 占着/);
  assert.equal(block({ LISTEN_TCP_80: 'nginx', PKG_NGINX: '1' }), '', 'nginx 自己占着 80 没关系');
  assert.match(block({ OPENSSH_VERSION: '7.4' }), /得 7\.8 以上/);
  assert.match(block({ SSHD_TCP_FORWARDING: 'no' }), /AllowTcpForwarding 是 no/);
  assert.match(block({ SSHD_ALLOW_USERS: 'root admin' }), /AllowUsers 只放行 root admin/);
  assert.equal(block({ SSHD_ALLOW_USERS: 'root ergo-tunnel' }), '');
  assert.match(block({ LISTEN_TCP_TUNNEL: 'sshd' }), /127\.0\.0\.1:18811 已经被 sshd 占着.*--remote-port/);
  assert.equal(block({ LISTEN_TCP_TUNNEL: 'sshd', MANIFEST_TUNNEL: '1' }), '', '我们自己的隧道已经接上了');
  assert.match(block({ PKG_HEADSCALE: '1', HEADSCALE_VERSION: '0.25.0' }, hsPlan), /原来就有 headscale（0\.25\.0）/);
  assert.equal(block({ PKG_HEADSCALE: '1', MANIFEST_HEADSCALE: '1' }, hsPlan), '');
  assert.match(block({ LISTEN_UDP_3478: 'coturn' }, hsPlan), /3478\/udp 被 coturn 占着.*--no-derp/);
  assert.equal(block({ LISTEN_UDP_3478: 'coturn' }, { ...hsPlan, derp: false }), '');
  assert.match(block({ DNS_OK: '0' }), /解析不到它自己的 IP/);
  assert.match(block({ DISK_FREE_MB: '120' }), /只剩 120 MB/);
  const w = assessCheckup({ ...FRESH_DEBIAN, FIREWALLD_ACTIVE: '1' }, tunnelPlan).warnings.join('\n');
  assert.match(w, /firewalld/);
  const pub = assessCheckup({ ...FRESH_DEBIAN, PUBLIC_TCP: '22 80 3000 8080 ' }, tunnelPlan).warnings.join('\n');
  assert.match(pub, /3000 8080/);
  assert.deepEqual(assessCheckup(null, tunnelPlan).blocking, ['体检脚本没跑完（输出里没有开头那一行）']);
  assert.equal(parseCheckup('OS_ID=debian\n'), null, '没有开头那一行不算');
  assert.deepEqual(neededPorts(hsPlan).map((p) => `${p.proto}/${p.port}`), ['tcp/22', 'tcp/80', 'tcp/443', 'udp/3478']);
  assert.deepEqual(portWarnings([{ proto: 'tcp', port: 443, why: 'https', result: 'open' }]), []);
});

test('状态文件：没有是空的；坏了报出来（不悄悄覆盖）；整份写；一份只管一台 VPS', () => {
  const file = path.join(fs.mkdtempSync(path.join(paths.DATA_DIR, 's-')), 'vps-setup.json');
  assert.deepEqual(st.loadState(file), st.emptyState());
  const s = st.emptyState();
  s.vps = { ...vps, publicIp: '203.0.113.10' };
  st.patchMode(s, 'tunnel', { domain: 'ergo.203.0.113.10.sslip.io', phase: 'verified' });
  st.remember(s, { action: 'setup', mode: 'tunnel', ok: true }, new Date('2026-10-27T00:00:00Z'));
  st.saveState(s, file);
  assert.deepEqual(st.loadState(file), s);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.equal(st.sameVpsOrWhy(s, vps), null);
  assert.match(st.sameVpsOrWhy(s, { ...vps, host: '198.51.100.20' }), /另一台 VPS/);
  assert.throws(() => st.patchMode(s, 'wireguard', {}), /不认识的方式/);
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => st.loadState(file), /不是合法的 JSON.*别直接删/);
  fs.writeFileSync(file, JSON.stringify({ version: 99 }));
  assert.throws(() => st.loadState(file), /版本是 99/);
});

test('这次要搭的东西：默认值、上次记的、命令行给的；8810、坏端口、换域名都拒', async () => {
  const exec = fakeExec({ dns: { 'vps.example.com': ['198.51.100.20'] } });
  const p = await buildPlan('tunnel', { host: 'root@203.0.113.10' }, st.emptyState(), exec);
  assert.deepEqual([p.domain, p.remotePort, p.localPort, p.serviceId, p.account], ['ergo.203.0.113.10.sslip.io', 18811, 8811, 'ergo-vps-tunnel', 'ergo-tunnel']);
  const h = await buildPlan('headscale', { host: 'vps.example.com', name: 'tail' }, st.emptyState(), exec);
  assert.deepEqual([h.publicIp, h.domain, h.hsPort, h.hsVersion, h.derp], ['198.51.100.20', 'tail.198.51.100.20.sslip.io', 8080, hs.HEADSCALE_VERSION, true]);
  assert.equal((await buildPlan('headscale', { host: 'vps.example.com', derp: false }, st.emptyState(), exec)).derp, false);
  await assert.rejects(buildPlan('tunnel', { host: 'root@203.0.113.10', localPort: '8810' }, st.emptyState(), exec), /绝不能接 8810/);
  await assert.rejects(buildPlan('tunnel', { host: 'root@203.0.113.10', remotePort: '80' }, st.emptyState(), exec), /≥ 1024/);
  await assert.rejects(buildPlan('tunnel', {}, st.emptyState(), exec), /VPS 的地址/);
  await assert.rejects(buildPlan('tunnel', { host: 'root@203.0.113.10', email: 'x' }, st.emptyState(), exec), /邮箱不对/);
  await assert.rejects(buildPlan('wireguard', { host: 'root@203.0.113.10' }, st.emptyState(), exec), /只有 headscale 和 tunnel/);
  const s = st.emptyState();
  s.vps = { ...vps, publicIp: '203.0.113.10' };
  s.modes.tunnel = { domain: 'ergo.203.0.113.10.sslip.io', remotePort: 18899 };
  assert.equal((await buildPlan('tunnel', {}, s, exec)).remotePort, 18899, '上次记的端口接着用');
  await assert.rejects(buildPlan('tunnel', { domain: 'chat.example.com' }, s, exec), /换域名先 lsm vps remove tunnel/);
});

test('隧道服务的登记：Windows 钥匙路径（带 \\v \\a、空格）写进 YAML 读回来一字不差；绝不接 8810；手写的同名文件不碰', () => {
  // \v、\a 在 YAML 双引号里是转义符：写坏了钥匙路径就悄悄变了（踩过一次）
  const keys = { tunnel: 'C:\\vps\\a b\\tunnel_ed25519', knownHosts: 'C:\\vps\\a b\\known_hosts' };
  const argv = tunnelArgv(tunnelPlan, keys);
  assert.equal(argv[argv.indexOf('-i') + 1], keys.tunnel);
  assert.equal(argv.at(-1), 'ergo-tunnel@203.0.113.10');
  assert.equal(argv[argv.indexOf('-R') + 1], '127.0.0.1:18811:127.0.0.1:8811');
  for (const o of ['-N', '-n', '-T', 'ExitOnForwardFailure=yes', 'BatchMode=yes']) assert.ok(argv.includes(o), o);
  assert.throws(() => tunnelArgv({ ...tunnelPlan, localPort: 8810 }, keys), /8810/);
  assert.match(tunnelServiceYaml(tunnelPlan, keys), new RegExp(`^${MARKER}$`, 'm'));

  const w = writeTunnelService(tunnelPlan, keys);
  assert.equal(w.ok, true, w.why);
  assert.equal(writeTunnelService(tunnelPlan, keys).changed, false, '重写一样的不算变');
  // 手写的同名文件：不碰
  const own = path.join(paths.SERVICES_DIR, 'ergo-tunnel.yaml');
  fs.writeFileSync(own, 'id: ergo-tunnel\n# 用户自己手写的\n');
  const r = writeTunnelService({ ...tunnelPlan, serviceId: 'ergo-tunnel' }, keys);
  assert.equal(r.ok, false);
  assert.match(r.why, /不是 lsm vps setup 生成的/);
  assert.equal(fs.readFileSync(own, 'utf-8'), 'id: ergo-tunnel\n# 用户自己手写的\n');
  assert.equal(deleteTunnelService('ergo-tunnel').ok, false);
  assert.ok(fs.existsSync(own));
  fs.rmSync(own);
  assert.deepEqual(deleteTunnelService('ergo-vps-tunnel').existed, true);
  assert.deepEqual(deleteTunnelService('ergo-vps-tunnel'), { ok: true, existed: false });
});

test('二狗的 exposure：隧道搭好后填上（追加带标记的一段），撤的时候原样拿掉；已经有 exposure 的不碰；没登记二狗就不填', () => {
  const daemon = path.join(paths.SERVICES_DIR, `${ERGO_DAEMON_ID}.yaml`);
  const keys = { tunnel: 'C:\\vps\\a b\\tunnel_ed25519', knownHosts: 'C:\\vps\\a b\\known_hosts' };
  fs.mkdirSync(paths.SERVICES_DIR, { recursive: true });
  assert.equal(fillErgoExposure(tunnelPlan).status, 'no-daemon');
  const original = [
    '# 二狗守护进程（用户自己写的注释要原样留着）', `id: ${ERGO_DAEMON_ID}`, `root: ${JSON.stringify(paths.DATA_DIR)}`, 'kind: managed',
    'probe:', '  tier: port', '  port: 8810', 'hooks:', '  start: node daemon.js', '',
  ].join('\r\n');
  fs.writeFileSync(daemon, original);
  // via 指着的隧道服务要先登记
  assert.equal(writeTunnelService(tunnelPlan, keys).ok, true);
  const r = fillErgoExposure(tunnelPlan);
  assert.equal(r.status, 'filled', r.why);
  const text = fs.readFileSync(daemon, 'utf-8');
  assert.ok(text.startsWith(original.trimEnd()), '原来的内容（连注释、换行）一字不动');
  assert.ok(text.includes(`${EXPOSURE_BEGIN}\r\nexposure:\r\n  via: ergo-vps-tunnel\r\n  remotePort: 18811\r\n  localPort: 8811\r\n  publicUrl: "https://ergo.203.0.113.10.sslip.io/"\r\n  check: true\r\n${EXPOSURE_END}`));
  const { services, errors } = loadServices();
  assert.deepEqual(errors, []);
  assert.deepEqual(services.get(ERGO_DAEMON_ID).exposure, { via: 'ergo-vps-tunnel', remotePort: 18811, localPort: 8811, publicUrl: 'https://ergo.203.0.113.10.sslip.io/', check: true });
  assert.equal(fillErgoExposure(tunnelPlan).status, 'same', '重跑不重复填');
  assert.equal(fillErgoExposure({ ...tunnelPlan, remotePort: 18899 }).status, 'filled', '我们填的那段跟着这次的参数换');
  assert.equal(loadServices().services.get(ERGO_DAEMON_ID).exposure.remotePort, 18899);
  assert.deepEqual(clearErgoExposure(), { removed: true, file: daemon });
  assert.equal(fs.readFileSync(daemon, 'utf-8'), original, '撤完和原来一字不差');
  assert.deepEqual(clearErgoExposure(), { removed: false });

  // 用户自己写的 exposure（接着他手写的 ergo-tunnel）：不碰，告诉他怎么改
  fs.writeFileSync(path.join(paths.SERVICES_DIR, 'ergo-tunnel.yaml'), [
    'id: ergo-tunnel', `root: ${JSON.stringify(paths.DATA_DIR)}`, 'kind: managed', 'role: tunnel',
    'probe:', '  tier: process', '  matchCmd: "18811"', 'hooks:', '  start:', '    argv: [ssh, -N]', '    detaches: false', '',
  ].join('\n'));
  const own = `${original}exposure:\r\n  via: ergo-tunnel\r\n  remotePort: 18811\r\n`;
  fs.writeFileSync(daemon, own);
  const c = fillErgoExposure(tunnelPlan);
  assert.equal(c.status, 'conflict');
  assert.match(c.why, /已经接着 ergo-tunnel（你手写的那条隧道）/);
  assert.ok(c.lines.includes('  via: ergo-vps-tunnel'));
  assert.equal(fs.readFileSync(daemon, 'utf-8'), own, '一个字都没动');
  assert.deepEqual(clearErgoExposure(), { removed: false }, '不是我们填的，撤的时候也不碰');
  // 只写了 localPort 的、标了永不上公网的：一样不碰
  fs.writeFileSync(daemon, `${original}exposure:\r\n  localPort: 8811\r\n`);
  assert.match(fillErgoExposure(tunnelPlan).why, /exposure 段已经有了/);
  fs.writeFileSync(daemon, `${original}exposure:\r\n  never: 只给本机用\r\n`);
  assert.match(fillErgoExposure(tunnelPlan).why, /永不上公网（只给本机用）/);
  for (const f of [daemon, path.join(paths.SERVICES_DIR, 'ergo-tunnel.yaml')]) fs.rmSync(f);
  assert.equal(deleteTunnelService('ergo-vps-tunnel').existed, true);
});

test('headscale 安装包的镜像：前缀式，规整成以 / 结尾；怪写法拒；状态文件记着下次接着用', async () => {
  assert.equal(hs.normalizeMirror(''), '');
  assert.equal(hs.normalizeMirror(undefined), '');
  assert.equal(hs.normalizeMirror('https://gh-proxy.example.com'), 'https://gh-proxy.example.com/');
  assert.equal(hs.normalizeMirror('https://mirror.example.com/gh/'), 'https://mirror.example.com/gh/');
  for (const bad of ['gh-proxy.example.com', "https://x.example.com/'; reboot", 'https://x.example.com/$(id)', 'ftp://x.example.com/', 'https://x.example.com/a b']) {
    assert.throws(() => hs.normalizeMirror(bad), /--headscale-mirror/, bad);
  }
  const exec = fakeExec();
  const p = await buildPlan('headscale', { host: 'root@203.0.113.10', hsMirror: 'https://gh-proxy.example.com' }, st.emptyState(), exec);
  assert.equal(p.hsMirror, 'https://gh-proxy.example.com/');
  const s = st.emptyState();
  s.vps = { ...vps, publicIp: '203.0.113.10' };
  s.modes.headscale = { domain: 'hs.203.0.113.10.sslip.io', hsMirror: 'https://gh-proxy.example.com/' };
  assert.equal((await buildPlan('headscale', {}, s, exec)).hsMirror, 'https://gh-proxy.example.com/', '上次记的镜像接着用');
  assert.equal(parseArgs(['setup', 'headscale', '--headscale-mirror', 'https://gh-proxy.example.com/']).opts.hsMirror, 'https://gh-proxy.example.com/');
});

test('注册表里有把 8810 接出去的（手写的隧道、tailnet 入口）：查得出来', () => {
  fs.mkdirSync(paths.SERVICES_DIR, { recursive: true });
  const f = path.join(paths.SERVICES_DIR, 'bad-tunnel.yaml');
  fs.writeFileSync(f, [
    'id: bad-tunnel', `root: ${JSON.stringify(paths.DATA_DIR)}`, 'kind: managed', 'role: tunnel',
    'probe:', '  tier: process', '  matchCmd: "18811"',
    'hooks:', '  start:', '    argv: [ssh, -N, -R, "127.0.0.1:18811:127.0.0.1:8810", "u@203.0.113.10"]', '    detaches: false', '',
  ].join('\n'));
  assert.deepEqual(exposuresOf8810(), ['bad-tunnel 的隧道接的是 127.0.0.1:18811:127.0.0.1:8810']);
  fs.rmSync(f);
  fs.writeFileSync(path.join(paths.SERVICES_DIR, 'ergo-daemon.yaml'), [
    'id: ergo-daemon', `root: ${JSON.stringify(paths.DATA_DIR)}`, 'kind: managed', 'probe:', '  tier: port', '  port: 8810',
    'hooks:', '  start: node daemon.js', '',
  ].join('\n'));
  fs.writeFileSync(paths.TAILNET_FILE, 'entries:\n  - id: ergo-daemon\n    name: ergo\n');
  assert.match(exposuresOf8810().join('\n'), /tailnet 入口 ergo-daemon 接的是 8810/);
  fs.appendFileSync(path.join(paths.SERVICES_DIR, 'ergo-daemon.yaml'), 'exposure:\n  localPort: 8811\n');
  assert.deepEqual(exposuresOf8810(), [], '入口接外网端口 8811 就对了');
  fs.rmSync(paths.TAILNET_FILE);
  fs.rmSync(path.join(paths.SERVICES_DIR, 'ergo-daemon.yaml'));
});

test('"接到了 8810"的判断：照二狗网关两个端口的真实行为分', () => {
  const j = (status, body) => ({ status, body: JSON.stringify(body) });
  assert.equal(classifyErgo({ access: j(200, { access: 'none' }), health: j(401, { code: 'unauthorized' }) }).verdict, 'external');
  assert.equal(classifyErgo({ access: j(200, { access: 'local' }), health: j(200, {}) }).verdict, 'local');
  assert.equal(classifyErgo({ access: j(403, { code: 'forbidden', message: 'Host 不对' }) }).verdict, 'local');
  assert.equal(classifyErgo({ access: j(200, { access: 'none' }), health: j(200, {}) }).verdict, 'unknown');
  assert.equal(classifyErgo({ access: { status: 502, body: '<html>bad gateway</html>' } }).verdict, 'unreachable');
  assert.equal(classifyErgo({ access: { status: 200, body: '<html>Welcome to nginx!</html>' } }).verdict, 'unknown');
  assert.equal(classifyErgo({ access: { tlsError: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }).verdict, 'cert');
  assert.equal(classifyErgo({ access: { error: 'ECONNREFUSED' } }).verdict, 'unreachable');
  assert.match(localPortProblem(8810), /绝不能接 8810/);
  assert.equal(localPortProblem(8811), null);
});

/** 本机起一个假的二狗网关：local 照 8810（只认 127.0.0.1 的 Host、本机来的一律信任），external 照 8811（不看 Host，只看凭证） */
function fakeGateway(kind) {
  const srv = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = new URL(req.url, 'http://x').pathname;
    if (kind === 'local') {
      const port = srv.address().port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(403, { code: 'forbidden', message: `拒绝：Host ${req.headers.host}` });
      if (p === '/api/access') return send(200, { access: 'local' });
      if (p === '/healthz') return send(200, { status: 'ok' });
      return send(404, {});
    }
    if (p === '/api/access') return send(200, { access: 'none' });
    return send(401, { code: 'unauthorized', message: '这个设备还没配对' });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('拿本机起的假二狗网关真打：nginx 原样转 Host → 8810 拒了；改写 Host → 8810 当成本机；8811 → 认出是外网端口', async (t) => {
  const local = await fakeGateway('local');
  const external = await fakeGateway('external');
  t.after(() => { local.close(); external.close(); });
  const exec = realExec();
  const at = (srv) => `http://127.0.0.1:${srv.address().port}/`;
  const host = { host: 'ergo.203.0.113.10.sslip.io' };   // nginx 的 proxy_set_header Host $host
  assert.equal((await verifyErgo(exec, at(external), { headers: host })).verdict, 'external');
  assert.equal((await verifyErgo(exec, at(local), { headers: host })).verdict, 'local');
  assert.equal((await verifyErgo(exec, at(local), { headers: { host: `127.0.0.1:${local.address().port}` } })).verdict, 'local');
  const h = await verifyHeadscale(exec, at(external));
  assert.equal(h.ok, false, '假网关的 /health 回 401，不算 headscale');
  const closed = await verifyErgo(exec, 'http://127.0.0.1:1/');
  assert.equal(closed.verdict, 'unreachable');
});

test('nginx 站点：照二狗自己的模板（/ws、/apps/ 升级、不缓冲、真实 IP 每个 location 都写、HSTS、大上传）；80 端口给签证书', () => {
  const s = ergoTunnelSite({ domain: 'ergo.203.0.113.10.sslip.io', upstreamPort: 18811 });
  for (const want of ['location /ws {', 'location /apps/ {', 'location / {', 'client_max_body_size 256m;', 'proxy_read_timeout 3600s;',
    'add_header Strict-Transport-Security "max-age=31536000" always;', 'proxy_request_buffering off;', 'proxy_buffering off;',
    'map $http_upgrade $ergo_tunnel_upgrade {', 'location ^~ /.well-known/acme-challenge/ {', 'root /var/www/ergo-acme;', 'return 301 https://$host$request_uri;']) {
    assert.ok(s.includes(want), want);
  }
  assert.equal(s.match(/proxy_set_header X-Real-IP \$remote_addr;/g).length, 3, '每个 location 都写');
  assert.equal(s.match(/proxy_pass http:\/\/127\.0\.0\.1:18811;/g).length, 3);
  assert.ok(!/8810/.test(s));
  assert.ok(!/listen 443/.test(httpOnlySite('ergo.203.0.113.10.sslip.io', 'x')));
  const h = headscaleSite({ domain: 'hs.203.0.113.10.sslip.io', upstreamPort: 8080 });
  for (const want of ['proxy_pass http://127.0.0.1:8080;', 'proxy_set_header Host $server_name;', 'proxy_redirect http:// https://;', 'proxy_buffering off;']) assert.ok(h.includes(want), want);
  assert.throws(() => ergoTunnelSite({ domain: 'x;y', upstreamPort: 18811 }));
  assert.throws(() => ergoTunnelSite({ domain: 'ergo.example.com', upstreamPort: 0 }));
});

test('headscale：配置（只听本机、DNS 记录走 extra_records_path、可关内置中转）；电脑加入怎么做；手机那串 key 只认安全的字符', () => {
  const c = hs.headscaleConfig({ domain: 'hs.203.0.113.10.sslip.io', publicIp: '203.0.113.10', port: 8080, derp: false });
  assert.match(c, /^server_url: https:\/\/hs\.203\.0\.113\.10\.sslip\.io$/m);
  assert.match(c, /^listen_addr: 127\.0\.0\.1:8080$/m);
  assert.match(c, /^ {4}enabled: false$/m);
  assert.match(c, /^ {2}extra_records_path: \/var\/lib\/headscale\/extra-records\.json$/m);
  assert.match(c, /^ {2}base_domain: ergo-tailnet\.internal$/m, 'base_domain 不能是 headscale 自己域名的上级');
  const d = 'hs.203.0.113.10.sslip.io';
  assert.equal(hs.joinPlan({ installed: false }, d).action, 'install');
  assert.equal(hs.joinPlan({ installed: true, backend: 'Running', controlURL: `https://${d}/` }, d).action, 'none');
  assert.equal(hs.joinPlan({ installed: true, backend: 'Running', controlURL: 'https://controlplane.tailscale.com' }, d).action, 'manual');
  assert.equal(hs.joinPlan({ installed: true, backend: 'NeedsLogin', controlURL: 'https://controlplane.tailscale.com' }, d).action, 'join');
  assert.ok(hs.joinArgv('tailscale', d, 'k'.repeat(48)).includes('--accept-dns=true'));
  assert.ok(hs.validRegistrationKey('mkey:0123abcd0123abcd'));
  assert.ok(!hs.validRegistrationKey('abc def'));
  assert.ok(!hs.validRegistrationKey("x'; reboot"));
  assert.throws(() => hs.approveScript('ergo', '$(reboot)'));
});

test('脚本输出的标记行解析；一次性钥匙显示时藏起来', () => {
  const p = parseOutput('ERGO-STEP packages ok 装了 nginx\nERGO-STEP firewall skip\nERGO-WARN 小心\nERGO-RESULT AUTHKEY=abc123\nERGO-FAIL 出错了\nOS_ID=debian\nERGO-DONE tunnel\n');
  assert.deepEqual(p.steps, [{ step: 'packages', status: 'ok', note: '装了 nginx' }, { step: 'firewall', status: 'skip', note: '' }]);
  assert.deepEqual([p.results, p.warnings, p.failure, p.done, p.kv.OS_ID], [{ AUTHKEY: 'abc123' }, ['小心'], '出错了', ['tunnel'], 'debian']);
  assert.equal(maskSecrets('ERGO-RESULT AUTHKEY=abc123'), 'ERGO-RESULT AUTHKEY=（一次性加入钥匙，已收下，不显示）');
});

test('命令行参数：认识的选项、--no-derp、打错字报错', () => {
  const r = parseArgs(['setup', 'headscale', '--host', 'root@203.0.113.10', '--no-derp', '--yes', '--domain=hs.example.com']);
  assert.deepEqual(r.positional, ['setup', 'headscale']);
  assert.equal(r.opts.derp, false);
  assert.equal(r.opts.yes, true);
  assert.equal(r.opts.domain, 'hs.example.com');
  assert.equal(parseArgs(['setup', 'tunnel']).opts.derp, undefined);
  assert.throws(() => parseArgs(['setup', 'tunnel', '--hots', 'x']), /不认识的选项：--hots/);
  assert.throws(() => parseArgs(['setup', 'tunnel', '--host']), /后面要跟一个值/);
});
