// 重启接入了的服务（438）：真的 Supervisor + 接入层 + 参考客户端（clients/lsm-link.mjs），由管理器真的拉起一个接入了的服务。
//
// 2026-11-08 02:35 部署时 `lsm restart ergo-daemon --when-idle` 回「✓ 本来就在跑」：服务其实退了，restart 紧接着的 start
// 先跑一轮探活，「上一轮还在跑」的服务头一回探活不过有一轮宽限（DOWN_CONFIRM_PROBES），账本还是 RUNNING，start 当它已经在跑、
// 什么都没起——靠 autoRestart 过了十几秒才拉回来，没开 autoRestart 的就是「重启 = 停止」。这里没有探活循环、也不开 autoRestart，
// 正好是那条路最容易出事的样子：重启后必须是一个新进程、账本 RUNNING，回的是「已重启」而不是「本来就在跑」。
// 命令行那一段经真的 bin/lsm.mjs 走：测试里起一个只有 /api/auth/status、/api/action 的小 HTTP 服务转给这个 Supervisor。
//
// 安全措施：注册表、账本、日志都在临时目录（LSM_DATA_DIR）；端口全是临时挑的空闲端口，不碰 7420 / 8810 / 8811 等；
// autoResolveConflicts 关掉；命令行子进程的 LSM_DATA_DIR 指着这个临时目录（端口读它的 manager.yaml）；
// 收尾按命令行里的临时目录认自己起的进程杀掉（不按 PID）。每步要起 PowerShell 查进程表，按顺序来，不并发。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-restart-linked-'));
process.env.LSM_DATA_DIR = DATA;
process.env.LSM_QUIET = '1';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const [MGR, SVC_PORT] = await Promise.all([1, 2].map(freePort));
assert.ok(![MGR, SVC_PORT].some((p) => [7420, 8810, 8811, 8090, 8091, 47823, 47890, 47895, 8785].includes(p)));

const REG = path.join(DATA, 'registry');
const APP = path.join(DATA, 'app');
fs.mkdirSync(path.join(REG, 'services'), { recursive: true });
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(REG, 'manager.yaml'), [
  'bind: 127.0.0.1', `port: ${MGR}`, 'probeIntervalMs: 5000', 'autoResolveConflicts: false',
  'sentinels:', '  port: false', '  scheduledTask: false', '',
].join('\n'));

// 接入了的服务：参考客户端接入，有停机回调（于是报 stop、restart 能力）；忙不忙由测试经 HTTP 拨
const CLIENT = pathToFileURL(path.resolve(import.meta.dirname, '../clients/lsm-link.mjs')).href;
fs.writeFileSync(path.join(APP, 'svc.mjs'), [
  "import http from 'node:http';",
  `import { link } from ${JSON.stringify(CLIENT)};`,
  'const port = Number(process.env.PORT);',
  'let busy = false;',
  "const lsm = link({ port, log: () => {}, busy: () => ({ busy, reason: busy ? '测试里说忙' : null }), onShutdown: async () => { server.close(); } });",
  'const server = http.createServer((req, res) => {',
  "  const u = new URL(req.url, 'http://x');",
  "  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };",
  "  if (u.pathname === '/pid') return send({ pid: process.pid });",
  "  if (u.pathname === '/busy') { busy = u.searchParams.get('on') === '1'; lsm.notifyBusy(); return send({ busy }); }",
  '  res.writeHead(404); res.end();',
  "}).listen(port, '127.0.0.1');",
  '',
].join('\n'));
fs.writeFileSync(path.join(REG, 'services', 'linked-svc.yaml'), [
  'id: linked-svc', `root: ${JSON.stringify(APP)}`, 'kind: managed',
  'probe:', '  tier: linked', `  port: ${SVC_PORT}`,
  // 脚本写绝对路径：收尾时按命令行里有没有这个临时目录认自己起的进程
  'hooks:', '  start:', '    argv:', `      - ${JSON.stringify(process.execPath)}`, `      - ${JSON.stringify(path.join(APP, 'svc.mjs'))}`, '    detaches: false', '    readyTimeoutMs: 20000',
  'env:', '  - name: PORT', '    from: literal', `    value: "${SVC_PORT}"`,
  'link:', '  enabled: true',
  // 故意不开 autoRestart：重启自己就得把它拉起来，不能指望别人兜
  '',
].join('\n'));

const { Supervisor } = await import('../src/supervisor.mjs');
const { attachLink } = await import('../src/link.mjs');
const { killTree, allProcesses } = await import('../src/winproc.mjs');
const { AUDIT_LOG, MANAGER_LOG } = await import('../src/paths.mjs');
const managerLogTail = () => { try { return fs.readFileSync(MANAGER_LOG, 'utf-8').trim().split('\n').slice(-15).join('\n'); } catch { return '（没有管理器日志）'; } };
const audits = () => fs.readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

const sup = new Supervisor();
assert.deepEqual(sup.registryErrors, []);
assert.equal(sup.get('linked-svc').autoRestart.enabled, false);
const linkSrv = attachLink(sup);
sup.link = linkSrv;

// 管理器的 HTTP 只留命令行要用的两个口子，动作转给上面这个 Supervisor（和 server.mjs 的 runAction 一样）
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
const server = http.createServer(async (req, res) => {
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/api/auth/status') return json({ enabled: false, authed: true });
  if (req.url === '/api/action' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.action === 'restart') return json(await sup.restart(body.id, { mode: body.mode || 'now' }));
    return json({ ok: false, why: `测试里没接这个动作：${body.action}` });
  }
  res.writeHead(404); res.end();
});
server.on('upgrade', (req, socket, head) => linkSrv.handleUpgrade(req, socket, head));
await new Promise((r) => server.listen(MGR, '127.0.0.1', r));

const LSM = path.resolve(import.meta.dirname, '../bin/lsm.mjs');
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');   // 命令行输出里的颜色码
/** 跑真的命令行；数据目录指着临时目录（端口读它的 manager.yaml），去掉接入用的环境变量。 */
function lsm(...args) {
  const env = { ...process.env, LSM_DATA_DIR: DATA, LSM_QUIET: '1' };
  for (const k of ['LSM_URL', 'LSM_SERVICE_ID', 'LSM_TOKEN', 'LSM_PROTOCOL']) delete env[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [LSM, ...args], { env, timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout).replace(ANSI, ''), err: String(stderr) });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(200); }
}
const get = async (p) => (await fetch(`http://127.0.0.1:${SVC_PORT}${p}`, { signal: AbortSignal.timeout(10000) })).json();
const pidOf = async () => { try { return (await get('/pid')).pid; } catch { return null; } };
const view = () => sup.snapshotForUi().services.find((s) => s.id === 'linked-svc');

test.after(async () => {
  // 别把测试起的进程留在机器上：命令行里带着这个临时目录的，就是这个文件起的（cmd 包装层和 node 本身），按进程树杀
  const mine = [...(await allProcesses())].filter(([, p]) => (p.cmd || '').toLowerCase().includes(APP.toLowerCase())).map(([pid]) => pid);
  for (const pid of mine) await killTree(pid);
  linkSrv.close();
  await new Promise((r) => server.close(r));
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

/** 重启完的样子：换了一个进程、它回话、重新接入、账本 RUNNING。 */
async function assertFresh(oldPid, r) {
  assert.ok(r.pid, `回了新进程的 PID：${JSON.stringify(r)}`);
  assert.notEqual(r.pid, oldPid);
  const now = await pidOf();
  assert.ok(now, `重启后服务得在跑、回话。管理器日志最后几行：\n${managerLogTail()}`);
  assert.notEqual(now, oldPid, '换了一个进程');
  assert.equal(now, r.pid, '回的 PID 就是现在在跑的那个');
  assert.ok(await until(() => linkSrv.status('linked-svc').connected && linkSrv.status('linked-svc').pid === now, 15000), '新进程重新接入了');
  assert.equal(sup.st('linked-svc').state, 'RUNNING');
  assert.equal(sup.st('linked-svc').desired, 'running');
  return now;
}

let pid = null;
test('管理器拉起接入了的服务，它连上来', async () => {
  const r = await sup.start('linked-svc');
  assert.equal(r.ok, true, r.why);
  assert.ok(await until(() => linkSrv.status('linked-svc').connected));
  pid = await pidOf();
  assert.ok(pid);
  assert.equal(linkSrv.status('linked-svc').pid, pid);
  assert.equal(sup.st('linked-svc').state, 'RUNNING');
});

test('立刻重启：旧进程退干净后真的拉起一个新进程，回「已重启」和新 PID，不回 already（02:35 那次回的是「本来就在跑」、服务停着）', async () => {
  const r = await sup.restart('linked-svc', { mode: 'now' });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.already, undefined, '重启不是启动，绝不说「本来就在跑」');
  assert.equal(r.pending, undefined);
  assert.equal(r.restarted, true);
  pid = await assertFresh(pid, r);
  const done = audits().filter((a) => a.action === 'restart-done' && a.id === 'linked-svc');
  assert.equal(done.at(-1)?.ok, true);
  assert.equal(done.at(-1)?.pid, pid);
  // 管理器自己 start 的（reason: restart），不是别人兜回来的
  assert.ok(audits().some((a) => a.action === 'start' && a.id === 'linked-svc' && a.reason === 'restart'));
});

test('命令行 lsm restart：打印「✓ 已重启（新进程 PID …）」，退出码 0，服务真的换了进程', async () => {
  const r = await lsm('restart', 'linked-svc');
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.doesNotMatch(r.out, /本来就在跑/);
  const m = /✓ linked-svc 已重启（新进程 PID (\d+)）/.exec(r.out);
  assert.ok(m, `命令行输出：${r.out}${r.err}`);
  pid = await assertFresh(pid, { pid: Number(m[1]) });
});

test('命令行 lsm restart --when-idle、服务不忙：当场重启完，同样打印「已重启」', async () => {
  const r = await lsm('restart', 'linked-svc', '--when-idle');
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  const m = /✓ linked-svc 已重启（新进程 PID (\d+)）/.exec(r.out);
  assert.ok(m, `命令行输出：${r.out}${r.err}`);
  pid = await assertFresh(pid, { pid: Number(m[1]) });
});

test('lsm restart --when-idle、服务正忙：立刻回「等它空闲后重启」、进程不动；空闲后它自己退出，被管理器拉起来（新进程）', async () => {
  await get('/busy?on=1');
  assert.ok(await until(() => linkSrv.status('linked-svc').busy, 5000), '忙的心跳到了管理器');
  const t0 = Date.now();
  const r = await lsm('restart', 'linked-svc', '--when-idle');
  assert.ok(Date.now() - t0 < 30000, '不等它空闲');
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.match(r.out, /⏸ linked-svc：linked-svc 正忙（测试里说忙），重启已排队：等它空闲后重启/);
  assert.doesNotMatch(r.out, /本来就在跑|已重启/);
  assert.equal(view().pendingRestart, true, '卡片上看得到「待重启」');
  // 再要一次：已经排着了，不重复发
  const again = await sup.restart('linked-svc', { mode: 'when-idle' });
  assert.equal(again.ok, true);
  assert.equal(again.pending, true);
  assert.match(again.why, /已经排着一次重启了/);
  assert.equal(audits().filter((a) => a.action === 'link-restart' && a.id === 'linked-svc' && a.mode === 'when-idle').length, 2, '只发了一条等空闲再重启（前一条是不忙那次）');
  // 忙着：过了一个多心跳周期（5 秒）还是原来那个进程
  await sleep(6500);
  assert.equal(await pidOf(), pid, '忙着不退');
  assert.equal(sup.st('linked-svc').state, 'RUNNING');
  // 不忙了：它自己退出，管理器确认退干净后按 start 钩子拉起来
  await get('/busy?on=0').catch(() => {});
  const fresh = await until(async () => {
    const p = await pidOf();
    return p && p !== pid && linkSrv.status('linked-svc').connected ? p : null;
  }, 60000);
  assert.ok(fresh, `换了一个新进程，并且重新接入。管理器日志最后几行：\n${managerLogTail()}`);
  const done = await until(() => audits().find((a) => a.action === 'restart-done' && a.id === 'linked-svc' && a.background), 30000);
  assert.ok(done, '后台做完记了审计');
  assert.equal(done.ok, true, done.why);
  assert.equal(done.pid, fresh);
  assert.equal(sup.st('linked-svc').state, 'RUNNING');
  assert.equal(view().pendingRestart, false);
  pid = fresh;
});
