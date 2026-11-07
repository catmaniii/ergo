// 管理指令端到端（docs/link-protocol.md §9）：真的 Supervisor + 接入层 + 客户端（clients/lsm-link.mjs），
// 由管理器真的拉起一个接入了的服务，它经自己那条连接：停自己被拒、停别的服务照常、「等我空闲了重启我」立刻回已排队，
// 忙的时候不动，空闲后自己退出、被管理器拉起来（换了一个进程）。
//
// 安全措施：注册表、账本、日志都在临时目录（LSM_DATA_DIR）；端口全是临时挑的空闲端口，不碰 7420 / 8810 / 8811 等；
// autoResolveConflicts 关掉；测试起的进程收尾时按管理器记下的 PID 杀进程树。整个文件一分钟上下，一步一步来，不并发。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-manage-link-'));
process.env.LSM_DATA_DIR = DATA;
process.env.LSM_QUIET = '1';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const [MGR, SELF_PORT, VICTIM_PORT] = await Promise.all([1, 2, 3].map(freePort));
assert.ok(![MGR, SELF_PORT, VICTIM_PORT].some((p) => [7420, 8810, 8811, 8090, 8091, 47823, 47890, 47895, 8785].includes(p)));

const REG = path.join(DATA, 'registry');
const APP = path.join(DATA, 'app');
fs.mkdirSync(path.join(REG, 'services'), { recursive: true });
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(REG, 'manager.yaml'), [
  'bind: 127.0.0.1', `port: ${MGR}`, 'probeIntervalMs: 5000', 'autoResolveConflicts: false',
  'sentinels:', '  port: false', '  scheduledTask: false', '',
].join('\n'));

// 接入了的服务：用参考客户端接入；忙不忙由测试经 HTTP 拨；/manage 把一条管理指令经它自己的连接发出去，原样回结果
const CLIENT = pathToFileURL(path.resolve(import.meta.dirname, '../clients/lsm-link.mjs')).href;
fs.writeFileSync(path.join(APP, 'self.mjs'), [
  "import http from 'node:http';",
  `import { link } from ${JSON.stringify(CLIENT)};`,
  'const port = Number(process.env.PORT);',
  'let busy = false;',
  "const lsm = link({ port, log: () => {}, busy: () => ({ busy, reason: busy ? '测试里说忙' : null }), onShutdown: async () => { server.close(); } });",
  'const server = http.createServer(async (req, res) => {',
  "  const u = new URL(req.url, 'http://x');",
  "  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };",
  "  if (u.pathname === '/pid') return send({ pid: process.pid });",
  "  if (u.pathname === '/busy') { busy = u.searchParams.get('on') === '1'; lsm.notifyBusy(); return send({ busy }); }",
  "  if (u.pathname === '/manage') {",
  '    await lsm.manage.ready();',
  "    const args = JSON.parse(u.searchParams.get('a') || '[]');",
  "    return send(await lsm.manage[u.searchParams.get('m')](...args));",
  '  }',
  '  res.writeHead(404); res.end();',
  "}).listen(port, '127.0.0.1');",
  '',
].join('\n'));
fs.writeFileSync(path.join(APP, 'victim.mjs'), [
  "import http from 'node:http';",
  "http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1');",
  '',
].join('\n'));
const svcYaml = (id, port, script, extra = []) => [
  `id: ${id}`, `root: ${JSON.stringify(APP)}`, 'kind: managed',
  'probe:', `  tier: ${extra.includes('link:') ? 'linked' : 'port'}`, `  port: ${port}`,
  // 脚本写绝对路径：收尾时按命令行里有没有这个临时目录认自己起的进程（不按 PID 杀——PID 会被回收给别人）
  'hooks:', '  start:', '    argv:', `      - ${JSON.stringify(process.execPath)}`, `      - ${JSON.stringify(path.join(APP, script))}`, '    detaches: false', '    readyTimeoutMs: 20000',
  'env:', '  - name: PORT', '    from: literal', `    value: "${port}"`,
  ...extra, '',
].join('\n');
fs.writeFileSync(path.join(REG, 'services', 'self-svc.yaml'), svcYaml('self-svc', SELF_PORT, 'self.mjs', ['link:', '  enabled: true']));
fs.writeFileSync(path.join(REG, 'services', 'victim.yaml'), svcYaml('victim', VICTIM_PORT, 'victim.mjs'));

const { Supervisor } = await import('../src/supervisor.mjs');
const { attachLink } = await import('../src/link.mjs');
const { killTree, allProcesses } = await import('../src/winproc.mjs');
const { AUDIT_LOG, MANAGER_LOG } = await import('../src/paths.mjs');
const managerLogTail = () => { try { return fs.readFileSync(MANAGER_LOG, 'utf-8').trim().split('\n').slice(-15).join('\n'); } catch { return '（没有管理器日志）'; } };

const sup = new Supervisor();
assert.deepEqual(sup.registryErrors, []);
const linkSrv = attachLink(sup);
sup.link = linkSrv;
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket, head) => linkSrv.handleUpgrade(req, socket, head));
await new Promise((r) => server.listen(MGR, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(200); }
}
const get = async (p) => (await fetch(`http://127.0.0.1:${SELF_PORT}${p}`, { signal: AbortSignal.timeout(60000) })).json();
const manage = (m, ...a) => get(`/manage?m=${m}&a=${encodeURIComponent(JSON.stringify(a))}`);
const pidOf = async () => { try { return (await get('/pid')).pid; } catch { return null; } };

test.after(async () => {
  // 别把测试起的进程留在机器上：命令行里带着这个临时目录的，就是这个文件起的（cmd 包装层和 node 本身），按进程树杀
  const mine = [...(await allProcesses())].filter(([, p]) => (p.cmd || '').toLowerCase().includes(APP.toLowerCase())).map(([pid]) => pid);
  for (const pid of mine) await killTree(pid);
  linkSrv.close();
  await new Promise((r) => server.close(r));
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

let firstPid = null;
test('管理器拉起接入了的服务：它连上来，welcome 里有 manage', async () => {
  const r = await sup.start('self-svc');
  assert.equal(r.ok, true, r.why);
  assert.ok(await until(() => linkSrv.status('self-svc').connected));
  firstPid = await pidOf();
  assert.ok(firstPid);
  assert.equal(linkSrv.status('self-svc').pid, firstPid);
  assert.equal((await manage('list')).ok, true);
});

test('经自己的连接停自己、强制停自己、立刻重启自己：一律 protected，进程还是原来那个', async () => {
  for (const [m, args] of [['stop', ['self-svc']], ['stop', ['self-svc', { force: true }]], ['restart', ['self-svc']], ['autostart', ['self-svc', false]]]) {
    const r = await manage(m, ...args);
    assert.equal(r.ok, false, `${m} ${JSON.stringify(args)}`);
    assert.equal(r.error.code, 'protected');
    assert.deepEqual(r.error.details, [{ id: 'self-svc', why: ['调用方自己'] }]);
  }
  const list = await manage('list');
  const me = list.services.find((s) => s.id === 'self-svc');
  assert.equal(me.protected, true);
  assert.equal(me.linked, true);
  assert.equal(list.services.find((s) => s.id === 'victim').protected, false);
  assert.equal(await pidOf(), firstPid);
});

test('别的服务照常：没有停机能力不带 force 不停；带 force 停下、端口空了', async () => {
  assert.equal((await sup.start('victim')).ok, true);
  assert.equal((await fetch(`http://127.0.0.1:${VICTIM_PORT}/`)).status, 200);
  const no = await manage('stop', 'victim');
  assert.equal(no.error.code, 'no-capability');
  assert.match(no.error.message, /force/);
  const r = await manage('stop', 'victim', { force: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.service.state, 'STOPPED');
  await assert.rejects(fetch(`http://127.0.0.1:${VICTIM_PORT}/`, { signal: AbortSignal.timeout(2000) }));
  const logs = await manage('logs', 'self-svc', { lines: 20 });
  assert.equal(logs.ok, true, JSON.stringify(logs.error));
  assert.equal(logs.label, '命令行输出');
});

test('「等我空闲了重启我」：忙着时立刻回已排队、进程不动；空闲后自己退出，被管理器拉起来（换了一个进程）', async () => {
  await get('/busy?on=1');
  const t0 = Date.now();
  const first = await manage('restartSelf');
  assert.ok(Date.now() - t0 < 5000, '不等重启完');
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.queued, true);
  assert.equal(first.already, undefined);
  // 已经排上了；再要一次：回 already，不重复排
  const again = await manage('restartSelf');
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  // 忙着：过了一个多心跳周期（5 秒）还是原来那个进程
  await sleep(6500);
  assert.equal(await pidOf(), firstPid, '忙着不退');
  assert.equal(linkSrv.status('self-svc').connected, true);
  // 不忙了：它自己退出，管理器确认退干净后按 start 钩子拉起来
  await get('/busy?on=0').catch(() => {});
  const fresh = await until(async () => {
    const pid = await pidOf();
    return pid && pid !== firstPid && linkSrv.status('self-svc').connected ? pid : null;
  }, 60000);
  assert.ok(fresh, `换了一个新进程，并且重新接入。管理器日志最后几行：\n${managerLogTail()}`);
  // 新进程连上来的时候 start 可能还在等就绪；等它走完
  assert.ok(await until(() => sup.st('self-svc').state === 'RUNNING', 30000), `账本是 ${sup.st('self-svc').state}`);
  const rows = fs.readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((a) => a.action === 'link-manage' && a.caller === 'self-svc' && a.type === 'manage.restartSelf' && a.queued));
  assert.ok(rows.some((a) => a.action === 'link-manage' && a.caller === 'self-svc' && a.code === 'protected'));
  assert.ok(await until(() => {
    const now = fs.readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    return now.some((a) => a.action === 'link-manage-restart-self' && a.caller === 'self-svc' && a.phase === 'started' && a.ok);
  }, 10000));
});

test('收尾：重启之后照样能用管理指令，停自己照样被拒', async () => {
  const r = await manage('stop', 'self-svc', { force: true });
  assert.equal(r.error.code, 'protected');
});
