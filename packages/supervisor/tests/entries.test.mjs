// 指向自己的入口（docs/link-protocol.md §8）：纯函数 + 真的 Supervisor 和接入层走一遍协议。
//
// 安全措施：注册表、账本都在临时目录（LSM_DATA_DIR）；端口全是临时挑的空闲端口，不碰 7420 / 8810 / 8811；
// 不调 refresh（不起 PowerShell、不起服务），只在注册表里写，实测结果由测试直接放进 sup。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-entries-'));
process.env.LSM_DATA_DIR = DATA;
process.env.LSM_QUIET = '1';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const [MGR, LOCAL, EXTERNAL, GW] = await Promise.all([1, 2, 3, 4].map(freePort));
for (const p of [MGR, LOCAL, EXTERNAL, GW]) assert.ok(![7420, 8810, 8811].includes(p));

const REG = path.join(DATA, 'registry');
fs.mkdirSync(path.join(REG, 'services'), { recursive: true });
fs.writeFileSync(path.join(REG, 'manager.yaml'), [
  'bind: 127.0.0.1', `port: ${MGR}`, 'probeIntervalMs: 5000', 'autoResolveConflicts: false',
  'sentinels:', '  port: false', '  scheduledTask: false',
  'tailnet:', '  domain: tail.example.test', '  gateway: tail-gw', '',
].join('\n'));
const managed = (id, port, extra = []) => [
  `id: ${id}`, `root: ${JSON.stringify(DATA)}`, 'kind: managed',
  'probe:', `  tier: port`, `  port: ${port}`,
  'hooks:', '  start:', '    cmd: node -e 0', '    detaches: false', ...extra, '',
].join('\n');
fs.writeFileSync(path.join(REG, 'services', 'tail-gw.yaml'), managed('tail-gw', GW));
// 示例里那种写法：探活是本机端口，exposure 没写 localPort，隧道的 -R 才连外网端口
fs.writeFileSync(path.join(REG, 'services', 'ergo-tunnel.yaml'), [
  'id: ergo-tunnel', `root: ${JSON.stringify(DATA)}`, 'kind: managed', 'role: tunnel',
  'probe:', '  tier: process', `  matchCmd: 18811:127\\.0\\.0\\.1:${EXTERNAL}`,
  'hooks:', '  start:', '    argv:', '      - ssh', '      - -R', `      - 127.0.0.1:18811:127.0.0.1:${EXTERNAL}`, '      - user@vps.example.test', '    detaches: false', '',
].join('\n'));
const daemonYaml = (exposure) => managed('ergo-test', LOCAL, ['link:', '  enabled: true', ...exposure]);
const DAEMON_FILE = path.join(REG, 'services', 'ergo-test.yaml');
fs.writeFileSync(DAEMON_FILE, daemonYaml(['exposure:', '  via: ergo-tunnel', '  remotePort: 18811', '  publicUrl: https://ergo.example.test/', '  check: true']));
fs.writeFileSync(path.join(REG, 'services', 'plain.yaml'), managed('plain', await freePort(), ['link:', '  enabled: true']));
// tailnet 入口：网关照 exposedPort 转发，这份登记没写 localPort，所以它接的是本机端口
fs.writeFileSync(path.join(REG, 'tailnet.yaml'), 'entries:\n  - id: ergo-test\n    name: ergo\n');

const { entriesFor, tunnelTargetPort, FEATURE } = await import('../src/entries.mjs');
const { Supervisor } = await import('../src/supervisor.mjs');
const { attachLink } = await import('../src/link.mjs');

const NO_SITES = path.join(DATA, 'no-such-file.json');

test('隧道接的是哪个本机端口：看 -R，不看字面的 localPort', () => {
  assert.equal(tunnelTargetPort({ hooks: { start: { argv: ['ssh', '-R', '127.0.0.1:18811:127.0.0.1:8811', 'u@h'] } } }), 8811);
  assert.equal(tunnelTargetPort({ hooks: { start: { cmd: 'ssh -N -R 18811:localhost:8810 u@h' } } }), 8810);
  assert.equal(tunnelTargetPort({ hooks: { start: { argv: ['frpc', '-c', 'x.toml'] } } }), null);
  assert.equal(tunnelTargetPort(null), null);
});

/** 不起 Supervisor 的小替身：只有入口要用的字段 */
function fakeSup({ exposure, probePort = 8810, tunnelArgv, tailnet, publicCheck, tailnetCheck }) {
  const services = new Map([['d', { id: 'd', exposure, probe: { port: probePort } }]]);
  if (tunnelArgv) services.set('t', { id: 't', hooks: { start: { argv: tunnelArgv } } });
  return {
    services,
    exposureChecks: new Map(publicCheck ? [['d', publicCheck]] : []),
    tailnetEntries: new Map(tailnet ? [['d', { name: tailnet }]] : []),
    tailnetChecks: new Map(tailnetCheck ? [['d', tailnetCheck]] : []),
    manager: { tailnet: { domain: 'tail.example.test', gateway: 'gw' } },
  };
}

test('公网和 tailnet 都接到外网端口：都给，带最近一次打没打通；公网在前', () => {
  const sup = fakeSup({
    exposure: { via: 't', remotePort: 18811, localPort: 8811, publicUrl: 'https://a.example.test/', check: true },
    tailnet: 'ergo',
    publicCheck: { ok: false, status: null, why: '超时' },
    tailnetCheck: { ok: true },
  });
  const r = entriesFor(sup, 'd', 8811, NO_SITES);
  assert.deepEqual(r.wrongPort, []);
  assert.deepEqual(r.entries, [
    { kind: 'public', url: 'https://a.example.test/', port: 8811, reachable: false, why: '超时' },
    { kind: 'tailnet', url: 'https://ergo.tail.example.test/', port: 8811, reachable: true, why: null },
  ]);
});

test('指向本机端口的入口不算：只进 wrongPort（接入方拿去写日志和体检）', () => {
  const sup = fakeSup({ exposure: { localPort: undefined, via: 't', publicUrl: 'https://a.example.test/', check: true }, tunnelArgv: ['ssh', '-R', '127.0.0.1:18810:127.0.0.1:8810', 'u@h'], tailnet: 'ergo' });
  sup.services.get('d').exposure.via = 't';
  const r = entriesFor(sup, 'd', 8811, NO_SITES);
  assert.deepEqual(r.entries, []);
  assert.deepEqual(r.wrongPort.map((e) => [e.kind, e.port]), [['public', 8810], ['tailnet', 8810]]);
});

test('隧道的 -R 接外网端口，exposure 没写 localPort：不冤枉它（二狗手写的示例就是这样）', () => {
  const sup = fakeSup({ exposure: { via: 't', publicUrl: 'https://a.example.test/', check: true }, tunnelArgv: ['ssh', '-R', '127.0.0.1:18811:127.0.0.1:8811', 'u@h'] });
  assert.equal(entriesFor(sup, 'd', 8811, NO_SITES).entries.length, 1);
});

test('没测过（check: false、慢周期还没轮到）是 null，不假装通或不通；没填 publicUrl 的不算入口', () => {
  const unchecked = fakeSup({ exposure: { via: 't', localPort: 8811, publicUrl: 'https://a.example.test/', check: false }, publicCheck: { ok: true } });
  assert.equal(entriesFor(unchecked, 'd', 8811, NO_SITES).entries[0].reachable, null);
  const waiting = fakeSup({ exposure: { via: 't', localPort: 8811, publicUrl: 'https://a.example.test/', check: true } });
  assert.equal(entriesFor(waiting, 'd', 8811, NO_SITES).entries[0].reachable, null);
  const noUrl = fakeSup({ exposure: { via: 't', localPort: 8811, publicUrl: null, check: false } });
  assert.deepEqual(entriesFor(noUrl, 'd', 8811, NO_SITES), { entries: [], wrongPort: [] });
});

test('VPS 上的站点：上游正好是这条隧道的端口才算；同一个地址只算一条；文件坏了不影响别的入口', () => {
  const sites = path.join(DATA, 'sites.json');
  fs.writeFileSync(sites, JSON.stringify({ sites: { mine: { domain: 'site.example.test', upstreamPort: 18811 }, other: { domain: 'other.example.test', upstreamPort: 9000 }, same: { domain: 'a.example.test', upstreamPort: 18811 } } }));
  const sup = fakeSup({ exposure: { via: 't', remotePort: 18811, localPort: 8811, publicUrl: 'https://a.example.test/', check: true }, publicCheck: { ok: true } });
  assert.deepEqual(entriesFor(sup, 'd', 8811, sites).entries.map((e) => [e.url, e.reachable]), [['https://a.example.test/', true], ['https://site.example.test/', null]]);
  fs.writeFileSync(sites, '{坏了');
  assert.equal(entriesFor(sup, 'd', 8811, sites).entries.length, 1);
});

test('接入方没说 externalPort（别的项目）：不分对错，全给', () => {
  const sup = fakeSup({ exposure: { via: 't', localPort: 8810, publicUrl: 'https://a.example.test/', check: false } });
  const r = entriesFor(sup, 'd', null, NO_SITES);
  assert.equal(r.entries.length, 1);
  assert.equal(r.wrongPort.length, 0);
});

test('没有这个服务：空的，不抛', () => {
  assert.deepEqual(entriesFor(fakeSup({ exposure: null }), 'nobody', 8811, NO_SITES), { entries: [], wrongPort: [] });
});

// ---- 真的 Supervisor + 接入层：hello 里声明、welcome 里有、接入时推一次、变了才推

const sup = new Supervisor();
assert.deepEqual(sup.registryErrors, []);
const linkSrv = attachLink(sup);
sup.link = linkSrv;
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket, head) => linkSrv.handleUpgrade(req, socket, head));
await new Promise((r) => server.listen(MGR, '127.0.0.1', r));
sup.st('ergo-test').linkToken = 'tok-ergo';
sup.st('plain').linkToken = 'tok-plain';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = [];
/** 连上来发 hello，收集管理器发来的消息 */
async function connect(id, token, hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${MGR}/link`, { headers: { Authorization: `Bearer ${token}` } });
  open.push(ws);
  const got = [];
  ws.on('message', (raw) => got.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', serviceId: id, pid: process.pid, port: LOCAL, protocol: 1, capabilities: [], ...hello }));
  return { ws, got };
}
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(20); }
}

test.after(async () => {
  for (const ws of open) { try { ws.close(); } catch {} }
  linkSrv.close();
  await new Promise((r) => server.close(r));
  await sleep(100);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

test('welcome 里声明这项能力', () => {
  assert.ok(linkSrv.FEATURES.includes(FEATURE));
  assert.equal(FEATURE, 'entries');
});

test('走一遍协议：接入时推一次，指向本机端口的 tailnet 进 wrongPort；实测结果变了才再推；没变不推', async () => {
  const { ws, got } = await connect('ergo-test', 'tok-ergo', { features: ['services', 'entries'], externalPort: EXTERNAL });
  const welcome = await waitFor(() => got.find((m) => m.type === 'welcome'));
  assert.ok(welcome.features.includes('entries'));
  const first = await waitFor(() => got.find((m) => m.type === 'entries.status'));
  assert.deepEqual(first.entries, [{ kind: 'public', url: 'https://ergo.example.test/', port: EXTERNAL, reachable: null, why: null }]);
  assert.deepEqual(first.wrongPort, [{ kind: 'tailnet', url: 'https://ergo.tail.example.test/', port: LOCAL, reachable: null, why: null }]);

  // 探活又跑了一轮，什么都没变：不多推
  const count = () => got.filter((m) => m.type === 'entries.status').length;
  sup.emit('refresh', {});
  await sleep(100);
  assert.equal(count(), 1);

  // 慢周期打了一遍公网：结果变了，下一轮探活推出去
  sup.exposureChecks = new Map([['ergo-test', { ok: true, status: 200, checkedAt: Date.now() }]]);
  sup.emit('refresh', {});
  await waitFor(() => count() === 2);
  assert.equal(got.filter((m) => m.type === 'entries.status').at(-1).entries[0].reachable, true);

  // 再打一遍还是通（时间变了、结果没变）：不推
  sup.exposureChecks = new Map([['ergo-test', { ok: true, status: 200, checkedAt: Date.now() + 1000 }]]);
  sup.emit('refresh', {});
  await sleep(100);
  assert.equal(count(), 2);

  // 用户在注册表里撤了公网入口、把 tailnet 接到外网端口：推新的
  fs.writeFileSync(DAEMON_FILE, daemonYaml(['exposure:', `  localPort: ${EXTERNAL}`]));
  sup.reload();
  sup.emit('registry-changed');
  await waitFor(() => count() === 3);
  const last = got.filter((m) => m.type === 'entries.status').at(-1);
  assert.deepEqual(last.entries, [{ kind: 'tailnet', url: 'https://ergo.tail.example.test/', port: EXTERNAL, reachable: null, why: null }]);
  assert.deepEqual(last.wrongPort, []);
  ws.close();
  await waitFor(() => !linkSrv.status('ergo-test').connected);
});

test('没声明这项能力的老项目：什么都不多收到（除了 welcome 里多一个字段）', async () => {
  const { got } = await connect('plain', 'tok-plain', {});
  await waitFor(() => got.find((m) => m.type === 'welcome'));
  sup.emit('refresh', {});
  await sleep(150);
  assert.deepEqual(got.filter((m) => m.type !== 'welcome'), []);
});

test('声明了但没有任何入口：也推一次空的（接入方好知道这一边问过了）', async () => {
  fs.writeFileSync(path.join(REG, 'tailnet.yaml'), 'entries: []\n');
  fs.writeFileSync(DAEMON_FILE, daemonYaml([]));
  sup.reload();
  const { got } = await connect('ergo-test', 'tok-ergo', { features: ['entries'], externalPort: EXTERNAL });
  const first = await waitFor(() => got.find((m) => m.type === 'entries.status'));
  assert.deepEqual(first.entries, []);
  assert.deepEqual(first.wrongPort, []);
});
