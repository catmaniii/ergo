// `lsm vps setup | status | remove | approve` 的整条流程（321 号票）：执行层换成假的（记下要跑什么、按场景回话），
// 服务管家换成假的（记下登记、启停）。验：先体检、脚本整份显示了才问、同意了才跑；装了什么记进状态文件；
// 验收能认出"接到了 8810"并拒绝、当场停掉隧道；一次性钥匙不显示、不落盘；撤的时候原样撤。最后一条从命令行端到端跑一遍。
import { TEST_DATA_DIR } from './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeExec, ERGO_LOCAL_TRUSTED, ERGO_LOCAL_REFUSED, scriptKind } from './_fake-vps-exec.mjs';
import { runVps } from '../src/vps/cli.mjs';
import { loadState } from '../src/vps/state.mjs';
import * as paths from '../src/paths.mjs';

function fakeIo(answers = []) {
  const lines = [];
  const events = [];
  return {
    lines, events,
    text: () => lines.join('\n'),
    say(l) { lines.push(String(l)); },
    async ask(p) { events.push(['ask', p, lines.length]); return answers.length ? answers.shift() : null; },
    async confirm(q, { yes } = {}) { events.push(['confirm', q, lines.length]); if (yes) return true; const a = answers.shift(); return a === 'y'; },
  };
}

const clean = () => {
  for (const p of [paths.VPS_STATE, paths.VPS_KEYS_DIR, paths.VPS_SCRIPTS_DIR, paths.REGISTRY_DIR]) fs.rmSync(p, { recursive: true, force: true });
};
const NOW = () => new Date('2026-10-27T08:00:00Z');
const vps = (args, { io, exec }) => runVps(args, { io, exec, now: NOW, sleep: async () => {} });
const ssh = (exec, kind) => exec.calls.filter((c) => c.type === 'run' && path.basename(c.argv[0]) === 'ssh' && scriptKind(c.input) === kind);
const TUNNEL = ['setup', 'tunnel', '--host', 'root@203.0.113.10'];
const HS = ['setup', 'headscale', '--host', 'root@203.0.113.10'];

test('隧道：先体检、脚本整份显示了才问、同意了才在 VPS 上跑；登记隧道服务、起起来、验收接的是 8811；都记进状态文件', async () => {
  clean();
  const exec = fakeExec();
  const io = fakeIo(['y']);
  assert.equal(await vps(TUNNEL, { io, exec }), 0, io.text());
  // 顺序：体检 → 显示脚本 → 问 → 跑
  const kinds = exec.calls.filter((c) => c.type === 'run' && path.basename(c.argv[0]) === 'ssh').map((c) => scriptKind(c.input) === 'unknown' ? 'login' : scriptKind(c.input));
  assert.deepEqual(kinds, ['login', 'checkup', 'setup-tunnel']);
  const [setup] = ssh(exec, 'setup-tunnel');
  const confirm = io.events.find((e) => e[0] === 'confirm');
  const shown = io.lines.slice(0, confirm[2]).join('\n');
  assert.ok(shown.includes(setup.input.trimEnd()), '送上 VPS 的脚本要在问之前整份显示出来');
  assert.equal(fs.readFileSync(path.join(paths.VPS_SCRIPTS_DIR, 'tunnel-setup.sh'), 'utf-8'), setup.input, '另存的就是送上去的那份');
  // 只用专用钥匙、专用的 known_hosts，不问密码
  assert.ok(setup.argv.includes('BatchMode=yes') && setup.argv.includes('IdentitiesOnly=yes'));
  assert.equal(setup.argv[setup.argv.indexOf('-i') + 1], path.join(paths.VPS_KEYS_DIR, 'admin_ed25519'));
  assert.ok(setup.argv.some((a) => a.startsWith('UserKnownHostsFile=') && a.includes('vps-setup')));
  // 脚本里带着隧道钥匙的公钥（受限账号用），默认域名是 sslip.io 的
  const tunnelPub = fs.readFileSync(path.join(paths.VPS_KEYS_DIR, 'tunnel_ed25519.pub'), 'utf-8').trim();
  assert.ok(setup.input.includes(`TUNNEL_PUBKEY='${tunnelPub}'`));
  assert.ok(setup.input.includes("DOMAIN='ergo.203.0.113.10.sslip.io'"));
  // 电脑这一半：服务管家里登记了隧道服务，起起来了
  const reg = fs.readFileSync(path.join(paths.SERVICES_DIR, 'ergo-vps-tunnel.yaml'), 'utf-8');
  assert.ok(reg.includes('# ergo-vps-setup: tunnel'));
  assert.ok(reg.includes('"127.0.0.1:18811:127.0.0.1:8811"'));
  assert.ok(reg.includes('"ergo-tunnel@203.0.113.10"'));
  assert.deepEqual(exec.lsmCalls.filter((c) => c[0] !== 'state'), [['reload'], ['start', 'ergo-vps-tunnel']]);
  // 验收：不带凭证打了 /api/access 和 /healthz
  assert.ok(exec.calls.some((c) => c.type === 'request' && c.url === 'https://ergo.203.0.113.10.sslip.io/api/access'));
  assert.match(io.text(), /接的是二狗的外网端口 8811/);
  assert.match(io.text(), /证书是真的/);
  // 状态文件
  const st = loadState();
  assert.deepEqual(st.vps, { user: 'root', host: '203.0.113.10', port: 22, publicIp: '203.0.113.10' });
  const t = st.modes.tunnel;
  assert.equal(t.phase, 'verified');
  assert.equal(t.domain, 'ergo.203.0.113.10.sslip.io');
  assert.equal(t.lastVerify.verdict, 'external');
  assert.deepEqual([t.remotePort, t.localPort, t.serviceId, t.account], [18811, 8811, 'ergo-vps-tunnel', 'ergo-tunnel']);
  assert.equal(t.steps['base-record'], 'ok');
  assert.ok(st.history.some((h) => h.action === 'setup' && h.ok));
  // 从电脑上连了 VPS 的 22、80、443（看安全组），并告诉了要放行哪几个
  assert.deepEqual(exec.calls.filter((c) => c.type === 'tcp').map((c) => c.port), [22, 80, 443]);
  assert.match(io.text(), /安全组 \/ 防火墙要放行：TCP 22、TCP 80、TCP 443/);
});

test('你不同意：一个字都不往 VPS 上跑；体检（只读）照样跑过', async () => {
  clean();
  const exec = fakeExec();
  const io = fakeIo(['n']);
  assert.equal(await vps(TUNNEL, { io, exec }), 1);
  assert.equal(ssh(exec, 'checkup').length, 1);
  assert.equal(ssh(exec, 'setup-tunnel').length, 0);
  assert.ok(!fs.existsSync(path.join(paths.SERVICES_DIR, 'ergo-vps-tunnel.yaml')));
  assert.equal(loadState().modes.tunnel.phase, 'planned');
});

for (const [name, site] of [['nginx 改了 Host、本机端口当成本机信任', ERGO_LOCAL_TRUSTED], ['Host 原样转、本机端口拒了', ERGO_LOCAL_REFUSED]]) {
  test(`验收认出"接到了 8810"（${name}）：报红、退出码 1、当场强制停掉隧道服务、状态记 verify-failed`, async () => {
    clean();
    const exec = fakeExec({ site });
    const io = fakeIo(['y']);
    assert.equal(await vps(TUNNEL, { io, exec }), 1);
    assert.match(io.text(), /8810/);
    assert.deepEqual(exec.lsmCalls.at(-1), ['stop', 'ergo-vps-tunnel', { force: true }]);
    const t = loadState().modes.tunnel;
    assert.equal(t.phase, 'verify-failed');
    assert.equal(t.lastVerify.verdict, 'local');
    assert.ok(!t.verifiedAt);
  });
}

test('电脑这头要接 8810：一开始就拒绝，什么都不做', async () => {
  clean();
  const exec = fakeExec();
  const io = fakeIo(['y']);
  assert.equal(await vps([...TUNNEL, '--local-port', '8810'], { io, exec }), 1);
  assert.match(io.text(), /绝不能接 8810/);
  assert.equal(exec.calls.length, 0);
});

test('体检有挡路的（443 前面有 stream 前门）：停下，不往上装；告诉你为什么', async () => {
  clean();
  const exec = fakeExec({ checkup: { NGINX_STREAM_443: '1', PKG_NGINX: '1', LISTEN_TCP_443: 'nginx' } });
  const io = fakeIo(['y']);
  assert.equal(await vps(TUNNEL, { io, exec }), 1);
  assert.equal(ssh(exec, 'setup-tunnel').length, 0);
  assert.match(io.text(), /stream 前门/);
  assert.ok(loadState().modes.tunnel.lastCheckup.blocking.length > 0);
});

test('安全组没放行 80：体检里说清楚去放行哪几个（不替你开）', async () => {
  clean();
  const exec = fakeExec({ tcp: { 80: 'timeout' } });
  const io = fakeIo(['n']);
  await vps(TUNNEL, { io, exec });
  assert.match(io.text(), /TCP 80（签证书、跳 https）超时：多半是云厂商的安全组没放行/);
});

test('钥匙还没放上去：打印让你自己跑的那一句（带管理用的公钥），等你回车再试；密码不经程序', async () => {
  clean();
  const exec = fakeExec({ login: ['denied', 'ok'] });
  const io = fakeIo(['', 'y']);
  assert.equal(await vps(TUNNEL, { io, exec }), 0, io.text());
  const adminPub = fs.readFileSync(path.join(paths.VPS_KEYS_DIR, 'admin_ed25519.pub'), 'utf-8').trim();
  assert.ok(io.text().includes(`ssh root@203.0.113.10 "umask 077; mkdir -p ~/.ssh; grep -qxF '${adminPub}' ~/.ssh/authorized_keys 2>/dev/null || echo '${adminPub}' >> ~/.ssh/authorized_keys"`));
  assert.equal(io.events[0][0], 'ask');
});

test('VPS 上断了：记 vps-failed 和原因；重跑同一条命令接着做，钥匙不换', async () => {
  clean();
  const exec = fakeExec({ setup: [{ code: 1, out: 'ERGO-STEP base-record ok\n', err: 'ERGO-FAIL nginx -t 没通过，站点 ergo-vps-tunnel 已撤回原样\n' }] });
  assert.equal(await vps(TUNNEL, { io: fakeIo(['y']), exec }), 1);
  let t = loadState().modes.tunnel;
  assert.equal(t.phase, 'vps-failed');
  assert.match(t.lastRun.failure, /nginx -t 没通过/);
  const pub = fs.readFileSync(path.join(paths.VPS_KEYS_DIR, 'tunnel_ed25519.pub'), 'utf-8');
  const io = fakeIo(['y']);
  assert.equal(await vps(['setup', 'tunnel'], { io, exec }), 0, io.text());   // 第二次不用再给 --host：状态文件里记着
  t = loadState().modes.tunnel;
  assert.equal(t.phase, 'verified');
  assert.equal(fs.readFileSync(path.join(paths.VPS_KEYS_DIR, 'tunnel_ed25519.pub'), 'utf-8'), pub);
  assert.equal(exec.calls.filter((c) => c.type === 'run' && path.basename(c.argv[0]) === 'ssh-keygen').length, 2, '两把钥匙各生成一次');
});

test('换一台 VPS、换域名：拒绝（先 remove）', async () => {
  clean();
  const exec = fakeExec();
  assert.equal(await vps(TUNNEL, { io: fakeIo(['y']), exec }), 0);
  let io = fakeIo(['y']);
  assert.equal(await vps(['setup', 'tunnel', '--host', 'root@198.51.100.20'], { io, exec }), 1);
  assert.match(io.text(), /另一台 VPS/);
  io = fakeIo(['y']);
  assert.equal(await vps([...TUNNEL, '--domain', 'chat.example.com'], { io, exec }), 1);
  assert.match(io.text(), /换域名先 lsm vps remove tunnel/);
});

test('--print-script 只打印脚本（自己登进 VPS 跑），不碰 VPS', async () => {
  clean();
  const exec = fakeExec();
  const io = fakeIo();
  assert.equal(await vps([...TUNNEL, '--print-script'], { io, exec }), 0);
  assert.ok(io.text().startsWith('#!/usr/bin/env bash'));
  assert.ok(exec.calls.every((c) => c.type === 'run' && path.basename(c.argv[0]) === 'ssh-keygen'));
});

test('headscale：一次性钥匙交给电脑上的 tailscale 加入，终端里不显示、状态文件里不落；打印手机加入的步骤', async () => {
  clean();
  const key = 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed';
  const exec = fakeExec({ authKey: key });
  const io = fakeIo(['y']);
  assert.equal(await vps(HS, { io, exec }), 0, io.text());
  const [setup] = ssh(exec, 'setup-headscale');
  assert.ok(setup.input.includes("WANT_AUTHKEY='1'"));
  const up = exec.calls.find((c) => c.type === 'run' && c.argv[1] === 'up');
  assert.ok(up.argv.includes('--login-server=https://hs.203.0.113.10.sslip.io'));
  assert.ok(up.argv.includes(`--auth-key=${key}`));
  assert.ok(!io.text().includes(key), '终端里不能出现一次性钥匙');
  assert.match(io.text(), /一次性加入钥匙，已收下，不显示/);
  assert.ok(!fs.readFileSync(paths.VPS_STATE, 'utf-8').includes(key), '状态文件里不能有一次性钥匙');
  assert.match(io.text(), /lsm vps approve/);
  assert.match(io.text(), /tail\.203\.0\.113\.10\.sslip\.io/);
  const h = loadState().modes.headscale;
  assert.equal(h.phase, 'verified');
  assert.equal(h.joined, true);
  assert.deepEqual(exec.calls.filter((c) => c.type === 'tcp').map((c) => c.port), [22, 80, 443], 'UDP 3478 测不了，只提醒');
  assert.match(io.text(), /UDP 3478 从这里测不出来/);
});

test('headscale：这台电脑正连着别的 tailnet——不动它，只告诉你怎么换', async () => {
  clean();
  const exec = fakeExec({ tailscale: { backend: 'Running', controlURL: 'https://controlplane.tailscale.com' } });
  const io = fakeIo(['y']);
  assert.equal(await vps(HS, { io, exec }), 0, io.text());
  assert.ok(!exec.calls.some((c) => c.type === 'run' && c.argv[1] === 'up'));
  assert.match(io.text(), /正连着别的 tailnet/);
  assert.equal(loadState().modes.headscale.joined, false);
});

test('status：证书还剩几天、隧道接没接上、电脑上的隧道服务、从外面打一遍；快到期要提醒', async () => {
  clean();
  const exec = fakeExec({ certs: [{ domain: 'ergo.203.0.113.10.sslip.io', notAfter: NOW().getTime() + 10 * 86400000 }] });
  assert.equal(await vps(TUNNEL, { io: fakeIo(['y']), exec }), 0);
  const io = fakeIo();
  const code = await vps(['status'], { io, exec });
  assert.equal(code, 0, io.text());
  assert.match(io.text(), /隧道接上了/);
  assert.match(io.text(), /还剩 10 天.*要看一眼/);
  assert.match(io.text(), /隧道服务 ergo-vps-tunnel RUNNING/);
  assert.match(io.text(), /从外面：✓/);
  assert.ok(loadState().lastStatus.ok);
  // 证书没了 → 退出码 1
  const bad = fakeExec({ certs: [{ domain: 'ergo.203.0.113.10.sslip.io', notAfter: null }] });
  assert.equal(await vps(['status'], { io: fakeIo(), exec: bad }), 1);
});

test('remove：显示撤的脚本和电脑这头要做的、同意了才撤；先停隧道服务、删登记，再撤 VPS；最后一种撤完连管理钥匙一起收回', async () => {
  clean();
  const exec = fakeExec();
  assert.equal(await vps(TUNNEL, { io: fakeIo(['y']), exec }), 0);
  const no = fakeIo(['n']);
  assert.equal(await vps(['remove', 'tunnel'], { io: no, exec }), 1);
  assert.equal(ssh(exec, 'remove').length, 0);
  assert.ok(fs.existsSync(path.join(paths.SERVICES_DIR, 'ergo-vps-tunnel.yaml')));

  const io = fakeIo(['y']);
  assert.equal(await vps(['remove', 'tunnel'], { io, exec }), 0, io.text());
  const [rm] = ssh(exec, 'remove');
  assert.ok(rm.input.includes("REVOKE_ADMIN='1'"), '最后一种：收回管理钥匙');
  assert.ok(rm.input.includes("MODE='tunnel'"));
  assert.match(io.text(), /强制停掉隧道服务 ergo-vps-tunnel/);
  assert.deepEqual(exec.lsmCalls.filter((c) => c[0] === 'stop').at(-1), ['stop', 'ergo-vps-tunnel', { force: true }]);
  assert.ok(!fs.existsSync(path.join(paths.SERVICES_DIR, 'ergo-vps-tunnel.yaml')));
  for (const f of ['admin_ed25519', 'tunnel_ed25519', 'known_hosts']) assert.ok(!fs.existsSync(path.join(paths.VPS_KEYS_DIR, f)), `${f} 该删`);
  const st = loadState();
  assert.equal(st.vps, null);
  assert.deepEqual(st.modes, {});
  assert.ok(st.history.some((h) => h.action === 'remove' && h.ok));
});

test('隧道搭好顺手给二狗的登记填 exposure（问之前就说了），撤的时候先拿掉它再删隧道登记；用户手写的 exposure 不碰', async () => {
  clean();
  fs.mkdirSync(paths.SERVICES_DIR, { recursive: true });
  const daemon = path.join(paths.SERVICES_DIR, 'ergo-daemon.yaml');
  const original = ['id: ergo-daemon', `root: ${JSON.stringify(paths.DATA_DIR)}`, 'kind: managed', 'probe:', '  tier: port', '  port: 8810', 'hooks:', '  start: node daemon.js', ''].join('\n');
  fs.writeFileSync(daemon, original);
  const exec = fakeExec();
  const io = fakeIo(['y']);
  assert.equal(await vps(TUNNEL, { io, exec }), 0, io.text());
  const confirm = io.events.find((e) => e[0] === 'confirm');
  assert.match(io.lines.slice(0, confirm[2]).join('\n'), /给二狗（ergo-daemon）的登记填 exposure/, '问之前先说要改二狗的登记');
  assert.match(io.text(), /二狗（ergo-daemon）的登记填了 exposure/);
  assert.match(fs.readFileSync(daemon, 'utf-8'), /via: ergo-vps-tunnel/);

  const rmIo = fakeIo(['y']);
  assert.equal(await vps(['remove', 'tunnel'], { io: rmIo, exec }), 0, rmIo.text());
  assert.equal(fs.readFileSync(daemon, 'utf-8'), original, '撤完二狗的登记和原来一字不差');
  assert.match(rmIo.text(), /拿掉了二狗（ergo-daemon）登记里 lsm vps setup 填的 exposure/);

  // 用户手写的 exposure（接着自己的 ergo-tunnel）：提示、不动
  clean();
  fs.mkdirSync(paths.SERVICES_DIR, { recursive: true });
  fs.writeFileSync(path.join(paths.SERVICES_DIR, 'ergo-tunnel.yaml'), ['id: ergo-tunnel', `root: ${JSON.stringify(paths.DATA_DIR)}`, 'kind: managed', 'role: tunnel',
    'probe:', '  tier: process', '  matchCmd: "18811"', 'hooks:', '  start:', '    argv: [ssh, -N]', '    detaches: false', ''].join('\n'));
  const own = `${original}exposure:\n  via: ergo-tunnel\n  remotePort: 18811\n  publicUrl: https://chat.example.com/\n`;
  fs.writeFileSync(daemon, own);
  const io2 = fakeIo(['y']);
  assert.equal(await vps(TUNNEL, { io: io2, exec: fakeExec() }), 0, io2.text());
  assert.match(io2.text(), /exposure 已经接着 ergo-tunnel（你手写的那条隧道）——那是你自己写的，没动它/);
  assert.equal(fs.readFileSync(daemon, 'utf-8'), own);
});

test('remove 一种、另一种还在：不收回管理钥匙', async () => {
  clean();
  const exec = fakeExec();
  assert.equal(await vps(TUNNEL, { io: fakeIo(['y']), exec }), 0);
  assert.equal(await vps(HS, { io: fakeIo(['y']), exec }), 0);
  assert.equal(await vps(['remove', 'headscale'], { io: fakeIo(['y']), exec }), 0);
  const [rm] = ssh(exec, 'remove');
  assert.ok(rm.input.includes("REVOKE_ADMIN='0'"));
  assert.ok(fs.existsSync(path.join(paths.VPS_KEYS_DIR, 'admin_ed25519')));
  assert.ok(loadState().modes.tunnel);
});

test('approve：只认登录页给的那种串；认了就在 VPS 上把手机登记进来', async () => {
  clean();
  const exec = fakeExec();
  assert.equal(await vps(HS, { io: fakeIo(['y']), exec }), 0);
  let io = fakeIo();
  assert.equal(await vps(['approve', 'abc; rm -rf /'], { io, exec }), 1);
  assert.match(io.text(), /不像 headscale 登录页给的 key/);
  io = fakeIo();
  assert.equal(await vps(['approve', 'Xk3Jd9aLmQ2vB7nR4tYp8wZc'], { io, exec }), 0, io.text());
  const [ap] = ssh(exec, 'approve');
  assert.match(ap.input, /headscale nodes register --user ergo --key Xk3Jd9aLmQ2vB7nR4tYp8wZc/);
});

/** 挑一个本机空闲端口（给假的管理器端口用：绝不碰 7420） */
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

test('命令行端到端：lsm vps setup tunnel --yes（假的执行层经 LSM_VPS_EXEC 接进去），status、remove；不碰真机器、不碰真管理器', async () => {
  clean();
  const dir = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'cli-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(path.join(data, 'registry', 'services'), { recursive: true });
  // 管理器端口指到一个空闲端口：CLI 万一要接管理器，也绝不会接到本机正在跑的那个（7420）
  fs.writeFileSync(path.join(data, 'registry', 'manager.yaml'), `bind: 127.0.0.1\nport: ${await freePort()}\n`);
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ certs: [{ domain: 'ergo.203.0.113.10.sslip.io', notAfter: Date.now() + 80 * 86400000 }] }));
  const log = path.join(dir, 'calls.jsonl');
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(paths.ROOT, 'bin', 'lsm.mjs'), '--data-dir', data, 'vps', ...args], {
      env: { ...process.env, LSM_DATA_DIR: '', LSM_VPS_EXEC: fileURLToPath(new URL('./_fake-vps-exec.mjs', import.meta.url)), FAKE_VPS_SCENARIO: scenario, FAKE_VPS_LOG: log },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, out }));
  });
  const r1 = await run(['setup', 'tunnel', '--host', 'root@203.0.113.10', '--yes']);
  assert.equal(r1.code, 0, r1.out);
  assert.match(r1.out, /照这份脚本在 VPS 上执行？ \[y\/N\] y（--yes）/);
  assert.match(r1.out, /隧道入口搭好了：https:\/\/ergo\.203\.0\.113\.10\.sslip\.io/);
  const calls = fs.readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((c) => c.type === 'run' && scriptKind(c.input) === 'setup-tunnel'));
  // 数据都落在 --data-dir 里
  assert.ok(fs.existsSync(path.join(data, 'vps-setup.json')));
  assert.ok(fs.existsSync(path.join(data, '.secrets', 'vps-setup', 'admin_ed25519.pub')));
  assert.ok(fs.existsSync(path.join(data, 'registry', 'services', 'ergo-vps-tunnel.yaml')));
  const r2 = await run(['status']);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /证书：还剩/);
  const r3 = await run(['remove', 'tunnel', '--yes']);
  assert.equal(r3.code, 0, r3.out);
  assert.ok(!fs.existsSync(path.join(data, 'registry', 'services', 'ergo-vps-tunnel.yaml')));
  const r4 = await run(['setup', 'tunnel', '--host', 'root@203.0.113.10', '--bogus']);
  assert.equal(r4.code, 1);
  assert.match(r4.out, /不认识的选项：--bogus/);
});
