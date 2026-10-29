// 名下的服务端到端：真的 Supervisor + 接入层 + 客户端（clients/lsm-link.mjs），真的起一个服务进程。
//
// 安全措施：注册表、账本、日志都在临时目录（LSM_DATA_DIR）；端口全是临时挑的空闲端口，
// 不碰 7420 / 8810 / 8811；autoResolveConflicts 关掉——万一哪个临时端口被别的程序占了，也绝不去杀它。
// 每一步都要起 PowerShell 查进程表（~3 秒），整个文件跑一分钟上下，按顺序一步一步来，不并发。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-owned-link-'));
process.env.LSM_DATA_DIR = DATA;
process.env.LSM_QUIET = '1';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const [MGR, OWNER_PORT, WEB_SERVER_PORT, OTHER_PORT, WEB_PORT, WEB_PORT2] = await Promise.all([1, 2, 3, 4, 5, 6].map(freePort));
const FORBIDDEN = [7420, 8810, 8811];
assert.ok(![MGR, OWNER_PORT, WEB_SERVER_PORT, OTHER_PORT, WEB_PORT, WEB_PORT2].some((p) => FORBIDDEN.includes(p)));

// ---- 临时注册表：一个登记方（ergo-test，已接入）、一个手写的服务、另一个登记方名下的服务
const REG = path.join(DATA, 'registry');
const APP = path.join(DATA, 'app');
fs.mkdirSync(path.join(REG, 'services', 'owned', 'other-owner'), { recursive: true });
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(REG, 'manager.yaml'), [
  'bind: 127.0.0.1', `port: ${MGR}`, 'probeIntervalMs: 5000', 'autoResolveConflicts: false',
  'sentinels:', '  port: false', '  scheduledTask: false', '',
].join('\n'));
const svcYaml = (id, port, extra = '') => [
  `id: ${id}`, `root: ${JSON.stringify(DATA)}`, 'kind: managed',
  'probe:', `  tier: ${extra.includes('link:') ? 'linked' : 'port'}`, `  port: ${port}`,
  'hooks:', '  start:', '    cmd: node -e 0', '    detaches: false', extra, '',
].join('\n');
fs.writeFileSync(path.join(REG, 'services', 'ergo-test.yaml'), svcYaml('ergo-test', OWNER_PORT, 'link:\n  enabled: true'));
fs.writeFileSync(path.join(REG, 'services', 'other-owner.yaml'), svcYaml('other-owner', OTHER_PORT, 'link:\n  enabled: true'));
fs.writeFileSync(path.join(REG, 'services', 'web-server.yaml'), svcYaml('web-server', WEB_SERVER_PORT));
const OTHERS_FILE = path.join(REG, 'services', 'owned', 'other-owner', 'x.yaml');
fs.writeFileSync(OTHERS_FILE, svcYaml('other-owner--x', await freePort()));
// 名下服务的程序：一个只有 /health 的小 HTTP 服务
fs.writeFileSync(path.join(APP, 'server.mjs'), [
  "import http from 'node:http';",
  'const port = Number(process.env.PORT);',
  "http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end(process.env.GREETING || 'ok'); }).listen(port, '127.0.0.1');",
  '',
].join('\n'));

const { Supervisor } = await import('../src/supervisor.mjs');
const { attachLink } = await import('../src/link.mjs');
const { killTree, allProcesses } = await import('../src/winproc.mjs');
const { execFileSync } = await import('node:child_process');
const { link } = await import('../clients/lsm-link.mjs');

const sup = new Supervisor();
assert.deepEqual(sup.registryErrors, []);
const linkSrv = attachLink(sup);
sup.link = linkSrv;
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket, head) => linkSrv.handleUpgrade(req, socket, head));
await new Promise((r) => server.listen(MGR, '127.0.0.1', r));

// 登记方的接入身份：平时由管理器 spawn 它时注入，这里直接发一个令牌
sup.st('ergo-test').linkToken = 'tok-ergo-test';
sup.st('other-owner').linkToken = 'tok-other-owner';
const URL_ = `ws://127.0.0.1:${MGR}/link`;
function linkAs(id, token) {
  Object.assign(process.env, { LSM_URL: URL_, LSM_SERVICE_ID: id, LSM_TOKEN: token, LSM_PROTOCOL: '1' });
  const l = link({ log: () => {} });
  const pushes = [];
  l.services.onStatus((m) => pushes.push(m));
  return { l, pushes };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100); }
}
const ID = 'ergo-test--web';
const FILE = path.join(REG, 'services', 'owned', 'ergo-test', 'web.yaml');
const DEF = {
  name: 'web', title: '测试页面', cwd: APP, argv: [process.execPath, 'server.mjs'], port: WEB_PORT,
  env: [{ name: 'PORT', from: 'literal', value: String(WEB_PORT) }], health: { path: '/health' }, autostart: true,
  readyTimeoutMs: 20000,
};
let { l: lsm, pushes } = linkAs('ergo-test', 'tok-ergo-test');

test.after(async () => {
  try { lsm.close(); } catch {}
  // 万一中途失败，别把测试起的服务进程留在机器上
  const pid = sup.st(ID)?.pid;
  if (pid) await killTree(pid);
  linkSrv.close();
  await new Promise((r) => server.close(r));
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

test('接入后知道管理器支持名下的服务，并且马上收到一次全量状态（现在是空的）', async () => {
  assert.equal(await lsm.services.ready(), true);
  const full = await until(() => pushes.find((m) => m.full));
  assert.ok(full, '接入时要推一次全量');
  assert.deepEqual(full.services, []);
});

test('定义不合规：被拒，原因逐条写清楚，注册表一个字都不写', async () => {
  const r = await lsm.services.put({ name: 'web', port: 99999, cwd: 'not-absolute', command: 'x', env: [{ name: 'GITHUB_TOKEN', from: 'literal', value: 'ghp_x' }], bogus: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid');
  for (const re of [/port 必须是/, /cwd 必须是绝对路径/, /看名字是密钥/, /不认识的字段 "bogus"/]) assert.ok(r.error.details.some((d) => re.test(d)), `少了：${re}`);
  assert.equal(fs.existsSync(FILE), false);
});

test('端口和已登记的服务撞了：被拒，说清是谁占着（管理器不分配端口）', async () => {
  const r = await lsm.services.put({ ...DEF, port: WEB_SERVER_PORT });
  assert.equal(r.error.code, 'port-conflict');
  assert.match(r.error.message, /web-server/);
  const r2 = await lsm.services.put({ ...DEF, port: MGR });
  assert.equal(r2.error.code, 'invalid', '管理器自己的端口也不行');
});

test('碰别人的服务：别的登记方名下的、手写在注册表里的，一概被拒', async () => {
  for (const name of ['other-owner--x', 'web-server--x']) {
    for (const call of [() => lsm.services.stop(name, { force: true }), () => lsm.services.remove(name), () => lsm.services.put({ ...DEF, name })]) {
      const r = await call();
      assert.equal(r.error.code, 'not-owner', `${name} 应该碰不到`);
    }
  }
  // 不带 -- 的名字只落进自己的命名空间：stop web-server = stop ergo-test--web-server，不存在
  const r = await lsm.services.stop('web-server', { force: true });
  assert.equal(r.error.code, 'not-found');
  assert.ok(fs.existsSync(OTHERS_FILE), '别人名下的服务原封不动');
  assert.equal(sup.services.get('web-server').owner, null);
});

test('登记：写进中心注册表 owned/<登记方>/，开机自启名单里有它，卡片上标「由 X 登记」', async () => {
  pushes.length = 0;
  const r = await lsm.services.put(DEF);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.created, true);
  assert.equal(r.service.id, ID);
  assert.equal(r.service.state, 'STOPPED');
  assert.equal(r.service.autostart, true);
  assert.ok(fs.existsSync(FILE));
  const text = fs.readFileSync(FILE, 'utf-8');
  assert.match(text, /由 ergo-test 经接入协议登记/);
  assert.match(text, /owner: ergo-test/);
  assert.doesNotMatch(text, /exposure/, '公网入口默认不开');
  assert.match(fs.readFileSync(path.join(REG, 'autostart.yaml'), 'utf-8'), new RegExp(ID));
  const card = sup.snapshotForUi().services.find((s) => s.id === ID);
  assert.equal(card.owner, 'ergo-test', 'WebUI / CLI 看得到是谁登记的');
  assert.ok(await until(() => pushes.some((m) => m.services.some((s) => s.id === ID))), '登记之后推一次状态');

  const again = await lsm.services.put(DEF);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, '同一份定义反复发：不重写注册表');
  const list = await lsm.services.list();
  assert.deepEqual(list.services.map((s) => s.name), ['web']);
});

let firstPid = null;
test('启动：管理器 spawn 它，端口有人听、健康检查通过，状态推给登记方', async () => {
  pushes.length = 0;
  const r = await lsm.services.start('web');
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.service.up, true);
  assert.equal(r.service.listening, true);
  assert.equal(r.service.health, 'ok');
  firstPid = r.service.pid;
  assert.ok(firstPid);
  assert.ok(await until(() => pushes.some((m) => m.services.some((s) => s.id === ID && s.state === 'STARTING'))), '起来的过程也推');
  assert.ok(await until(() => pushes.some((m) => m.services.some((s) => s.id === ID && s.up))));
  const res = await fetch(`http://127.0.0.1:${WEB_PORT}/health`);
  assert.equal(res.status, 200);
});

test('没有停机能力（没给 stop.command、也没接入）：不带 force 不停，不替它伪造优雅停机', async () => {
  const r = await lsm.services.stop('web');
  assert.equal(r.error.code, 'no-capability');
  assert.match(r.error.message, /force: true/);
  const r2 = await lsm.services.restart('web');
  assert.equal(r2.error.code, 'no-capability');
});

test('登记方掉线、重新接入：服务照跑；重新接入时推一次全量', async () => {
  lsm.close();
  await sleep(300);
  await sup.refresh();
  assert.equal(sup.st(ID).state, 'RUNNING', '登记方掉线不影响它运行');
  assert.equal((await fetch(`http://127.0.0.1:${WEB_PORT}/health`)).status, 200);

  ({ l: lsm, pushes } = linkAs('ergo-test', 'tok-ergo-test'));
  assert.equal(await lsm.services.ready(), true);
  const full = await until(() => pushes.find((m) => m.full));
  assert.ok(full);
  const s = full.services.find((x) => x.id === ID);
  assert.equal(s.state, 'RUNNING');
  assert.equal(s.up, true);
  assert.equal(s.pid, firstPid, '还是原来那个进程');
});

test('管理器重启也不影响它：包装层被收走后服务照跑，新起的管理器按端口把它认领回来', async () => {
  // 真管理器重启时，libuv 的 job 只带走它直接 spawn 的 cmd 包装层，服务是孙子进程、照常跑（2026-10-08 实测）。
  // 这里照样只杀包装层（不带 /T），再起一个新的 Supervisor 读同一份账本。
  const pid = sup.st(ID).pid;
  const procs = await allProcesses();
  const wrapper = procs.get(pid)?.ppid;
  assert.match(procs.get(wrapper)?.name || '', /^cmd\.exe$/i, '服务的父进程应该是管理器套的那层 cmd');
  execFileSync('taskkill', ['/F', '/PID', String(wrapper)], { windowsHide: true, stdio: 'ignore' });
  await sleep(500);
  assert.equal((await fetch(`http://127.0.0.1:${WEB_PORT}/health`)).status, 200, '包装层没了，服务照跑');
  sup.persist();
  const fresh = new Supervisor();
  await fresh.refresh();
  assert.equal(fresh.st(ID).state, 'RUNNING');
  assert.equal(fresh.st(ID).pid, pid, '认领回来的还是同一个进程');
  assert.equal(fresh.services.get(ID).owner, 'ergo-test');
  sup.state = fresh.state;   // 后面的步骤接着用新账本（和真重启一样）
});

test('在跑的时候改端口：被拒（新端口没人听、老进程没人认，两头都错）', async () => {
  const r = await lsm.services.put({ ...DEF, port: WEB_PORT2 });
  assert.equal(r.error.code, 'running');
});

test('更新定义：告诉登记方要重启才生效；带 force 重启后用上新定义', async () => {
  const def2 = { ...DEF, env: [...DEF.env, { name: 'GREETING', from: 'literal', value: 'v2' }] };
  const r = await lsm.services.put(def2);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.restartNeeded, true);
  assert.equal(r.created, false);
  const rr = await lsm.services.restart('web', { force: true });
  assert.equal(rr.ok, true, JSON.stringify(rr.error));
  assert.equal(rr.service.up, true);
  assert.notEqual(rr.service.pid, firstPid, '换了一个进程');
  assert.equal(await (await fetch(`http://127.0.0.1:${WEB_PORT}/`)).text(), 'v2');
});

test('开机自启开关：只改名单，不起停任何东西', async () => {
  const r = await lsm.services.autostart('web', false);
  assert.equal(r.ok, true);
  assert.equal(r.service.autostart, false);
  assert.equal(r.service.up, true);
  assert.doesNotMatch(fs.readFileSync(path.join(REG, 'autostart.yaml'), 'utf-8'), new RegExp(ID));
});

test('老的接入方：hello 不带 features 照样接入（welcome 只多一个它不认识的字段）；不先 hello 就发请求被拒', async () => {
  const ws = new WebSocket(URL_, { headers: { Authorization: 'Bearer tok-other-owner' } });
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  await new Promise((r) => { ws.onopen = r; });
  // 先不 hello 就发：不行
  ws.send(JSON.stringify({ type: 'services.list', id: 'early' }));
  await until(() => got.length >= 1);
  assert.equal(got[0].type, 'services.reply');
  assert.equal(got[0].error.code, 'not-linked');
  ws.send(JSON.stringify({ type: 'hello', serviceId: 'other-owner', protocol: 1, capabilities: [] }));
  await until(() => got.some((m) => m.type === 'welcome'));
  await sleep(500);
  const welcome = got.find((m) => m.type === 'welcome');
  assert.deepEqual(welcome.features, ['services']);
  assert.equal(got.filter((m) => m.type === 'services.status').length, 1,
    'other-owner 名下有手写的 x，所以推一次全量；没有名下服务的老项目连这一条都不会收到（见下一条断言）');
  ws.close();
  await sleep(300);
});

test('撤销：先停，端口空了，再从注册表、开机自启名单、账本里拿掉；推给登记方', async () => {
  pushes.length = 0;
  const r = await lsm.services.remove('web');
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.removed, { id: ID, name: 'web' });
  assert.equal(fs.existsSync(FILE), false);
  assert.equal(fs.existsSync(path.dirname(FILE)), false, '登记方名下空了，目录也收掉');
  assert.equal(sup.services.has(ID), false);
  assert.equal(sup.state.services[ID], undefined);
  await assert.rejects(fetch(`http://127.0.0.1:${WEB_PORT}/health`, { signal: AbortSignal.timeout(2000) }), '进程已经停了');
  assert.ok(await until(() => pushes.some((m) => (m.removed || []).includes('web'))), '撤掉的推给登记方');
  const r2 = await lsm.services.remove('web');
  assert.equal(r2.error.code, 'not-found');
});

test('你手动撤销（lsm owned remove）走同一条路；还被别的服务依赖时拒绝撤销；手写的服务不归它撤', async () => {
  const put = await lsm.services.put({ ...DEF, name: 'api', port: WEB_PORT2, autostart: false });
  assert.equal(put.ok, true, JSON.stringify(put.error));
  const idle = await lsm.services.stop('api');
  assert.equal(idle.ok, true, '本来就停着的：直接成功，不报「没有停机能力」');
  assert.equal(idle.already, true);
  const DEP = path.join(REG, 'services', 'dependent.yaml');
  fs.writeFileSync(DEP, svcYaml('dependent', await freePort(), 'dependsOn:\n  - ergo-test--api'));
  sup.reload();
  pushes.length = 0;
  const busy = await sup.owned.withdraw('ergo-test--api', { by: 'user' });
  assert.equal(busy.code, 'in-use');
  assert.match(busy.why, /dependent 依赖它/);
  fs.rmSync(DEP);
  sup.reload();
  const r = await sup.owned.withdraw('ergo-test--api', { by: 'user' });
  assert.equal(r.ok, true, r.why);
  assert.ok(await until(() => pushes.some((m) => (m.removed || []).includes('api'))), '你撤的也推给登记方');
  assert.equal((await sup.owned.withdraw('web-server', { by: 'user' })).code, 'not-owner');
});

test('没有名下服务、hello 不带 features 的老接入方：连状态推送都收不到', async () => {
  fs.rmSync(OTHERS_FILE);
  sup.reload();
  const ws = new WebSocket(URL_, { headers: { Authorization: 'Bearer tok-other-owner' } });
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ type: 'hello', serviceId: 'other-owner', protocol: 1, capabilities: [] }));
  await until(() => got.some((m) => m.type === 'welcome'));
  await sup.refresh();
  await sleep(300);
  assert.deepEqual(got.map((m) => m.type), ['welcome']);
  ws.close();
});
