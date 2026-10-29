// 停机要真的停下（2026-10-18 修）：健康检查不过的服务，stop 原来当场报「已停止」——
// 停没停是拿「探活过不过」判的，进程其实还活着、端口还在听，账本却记成 STOPPED、PID 清掉，从此没人管它。
// 现在「还在不在跑」只看进程和端口（supervisor.runningEvidence），停完亲眼确认端口空了才报已停。
//
// 真的起进程：一个「起得来、但 /health 永远回 500」的小服务。注册表、账本、日志都在临时目录（LSM_DATA_DIR），
// 端口是临时挑的空闲端口，autoResolveConflicts 关掉，不碰本机真实的管理器。每步要起 PowerShell 查进程表，按顺序来。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-stop-'));
process.env.LSM_DATA_DIR = DATA;
process.env.LSM_QUIET = '1';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const [MGR, P_NOHOOK, P_LAZY, P_QUIT, P_OWNED, P_OWNER] = await Promise.all([1, 2, 3, 4, 5, 6].map(freePort));
assert.ok(![MGR, P_NOHOOK, P_LAZY, P_QUIT, P_OWNED, P_OWNER].some((p) => [7420, 8810, 8811].includes(p)));

const REG = path.join(DATA, 'registry');
const APP = path.join(DATA, 'app');
fs.mkdirSync(path.join(REG, 'services'), { recursive: true });
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(REG, 'manager.yaml'),
  `bind: 127.0.0.1\nport: ${MGR}\nautoResolveConflicts: false\nsentinels:\n  port: false\n  scheduledTask: false\n`);
// 起得来、端口在听，但健康检查永远不过；GET /quit 自己退出（给「真会停」的停机钩子用）
fs.writeFileSync(path.join(APP, 'sick.mjs'), [
  "import http from 'node:http';",
  "http.createServer((req, res) => {",
  "  if (req.url === '/quit') { res.end('bye'); setTimeout(() => process.exit(0), 50); return; }",
  "  res.writeHead(req.url === '/health' ? 500 : 200); res.end('sick');",
  "}).listen(Number(process.env.PORT), '127.0.0.1');",
  '',
].join('\n'));
fs.writeFileSync(path.join(APP, 'quit.mjs'), "await fetch(`http://127.0.0.1:${process.env.PORT}/quit`).catch(() => {});\n");

const q = (s) => JSON.stringify(s);
// 手写在注册表顶层的服务（现有用户的情况），health 档，就绪等 3 秒
const sick = (id, port, stopHook = '') => [
  `id: ${id}`, `root: ${q(APP)}`, 'kind: managed',
  'probe:', '  tier: health', `  port: ${port}`, '  health:', `    url: http://127.0.0.1:${port}/health`, '    timeoutMs: 1500',
  'env:', '  - name: PORT', '    from: literal', `    value: "${port}"`,
  'hooks:', '  start:', '    argv:', `      - ${q(process.execPath)}`, '      - sick.mjs', '    detaches: false', '    readyTimeoutMs: 3000',
  stopHook, '',
].join('\n');
fs.writeFileSync(path.join(REG, 'services', 'sick-nohook.yaml'), sick('sick-nohook', P_NOHOOK));
// 停机钩子成功返回、却什么都没做：原来会当场报已停
fs.writeFileSync(path.join(REG, 'services', 'sick-lazyhook.yaml'), sick('sick-lazyhook', P_LAZY, '  stop:\n    cmd: node -e 0\n    timeoutMs: 3000'));
// 停机钩子真的让它退出：走自己的停机，不该被强杀
fs.writeFileSync(path.join(REG, 'services', 'sick-quithook.yaml'), sick('sick-quithook', P_QUIT, '  stop:\n    cmd: node quit.mjs\n    timeoutMs: 15000'));
fs.writeFileSync(path.join(REG, 'services', 'owner-x.yaml'),
  `id: owner-x\nroot: ${q(DATA)}\nkind: managed\nprobe:\n  tier: port\n  port: ${P_OWNER}\nhooks:\n  start:\n    cmd: node -e 0\n    detaches: false\n`);

const { Supervisor } = await import('../src/supervisor.mjs');
const { killTree } = await import('../src/winproc.mjs');
const sup = new Supervisor();
assert.deepEqual(sup.registryErrors, []);

const listening = async (port) => (await sup.liveness({ id: 'x', probe: { port } }, {})).running;
const reachable = (port) => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const auditLines = () => fs.readFileSync(path.join(DATA, 'logs', 'audit.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

/** 起一个「起得来但不健康」的服务：start 报失败（就绪超时）、账本 FAILED，可进程活着、端口在听——这就是现场。 */
async function bringUpSick(id, port) {
  const r = await sup.start(id);
  assert.equal(r.ok, false, 'health 档就绪要健康检查通过，它永远不过');
  assert.equal(sup.st(id).state, 'FAILED');
  assert.equal(await reachable(port), true, '可进程活着、端口在听');
}

test.after(async () => {
  // 万一中途失败，别把测试起的进程留在机器上
  for (const port of [P_NOHOOK, P_LAZY, P_QUIT, P_OWNED]) {
    const ev = await sup.liveness({ id: 'x', probe: { port } }, {}).catch(() => ({ pids: [] }));
    for (const pid of ev.pids) await killTree(pid);
  }
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

test('没有停机钩子、健康检查不过：不带 force 不停（它还在跑，没有停机能力）；带 force 真杀掉、端口空了才报已停', async () => {
  await bringUpSick('sick-nohook', P_NOHOOK);
  const r = await sup.stop('sick-nohook');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-capability');
  assert.match(r.why, /还在跑：端口 \d+ 还有人在听/);
  assert.equal(await reachable(P_NOHOOK), true);

  // 原来：强制停止当场报「已停止」（探活不过 = 已停），一个进程都没杀——账本里的 PID 早被探活清掉了
  const f = await sup.stop('sick-nohook', { force: true });
  assert.equal(f.ok, true, f.why);
  assert.equal(sup.st('sick-nohook').state, 'STOPPED');
  assert.equal(await listening(P_NOHOOK), false, '报已停的时候端口必须真的空了');
  assert.equal(await reachable(P_NOHOOK), false);
  assert.ok(auditLines().some((a) => a.action === 'force-kill' && a.id === 'sick-nohook' && a.reason === 'force'));
});

test('本来就没在跑：停它不需要任何停机能力，直接成功', async () => {
  const r = await sup.stop('sick-nohook');
  assert.equal(r.ok, true);
  assert.equal(r.already, true);
});

test('停机钩子成功返回却没让它退：等到钩子超时，杀进程树兜底，确认端口空了才报已停（原来当场报已停）', async () => {
  await bringUpSick('sick-lazyhook', P_LAZY);
  const r = await sup.stop('sick-lazyhook');
  assert.equal(r.ok, true, r.why);
  assert.equal(await listening(P_LAZY), false);
  assert.equal(sup.st('sick-lazyhook').state, 'STOPPED');
  assert.ok(auditLines().some((a) => a.action === 'force-kill' && a.id === 'sick-lazyhook' && a.reason === 'stop-timeout'),
    '兜底强杀要留痕');
});

test('停机钩子真的让它退出：走它自己的停机，不强杀；进程和端口都没了才报已停', async () => {
  await bringUpSick('sick-quithook', P_QUIT);
  const r = await sup.stop('sick-quithook');
  assert.equal(r.ok, true, r.why);
  assert.equal(await listening(P_QUIT), false);
  assert.ok(!auditLines().some((a) => a.action === 'force-kill' && a.id === 'sick-quithook'), '它自己停下了，不该被杀');
});

test('探活循环也不再把「停机中、健康检查不过」的服务提前记成已停', async () => {
  await bringUpSick('sick-nohook', P_NOHOOK);
  const st = sup.st('sick-nohook');
  st.state = 'STOPPING';   // 停机正在进行（比如停机钩子还在跑）时来了一轮探活
  await sup.refresh();
  assert.equal(st.state, 'STOPPING', '原来这一轮就会翻成 STOPPED、PID 清掉');
  await sup.stop('sick-nohook', { force: true });
  assert.equal(await listening(P_NOHOOK), false);
});

test('名下的服务同一条规矩：健康检查不过时 services.stop 不带 force 回 no-capability，带 force 真停、端口空了', async () => {
  const put = await sup.owned.request('owner-x', { type: 'services.put', service: {
    name: 'web', cwd: APP, argv: [process.execPath, 'sick.mjs'], port: P_OWNED,
    env: [{ name: 'PORT', from: 'literal', value: String(P_OWNED) }], health: { path: '/health', timeoutMs: 1500 }, readyTimeoutMs: 3000,
  } });
  assert.equal(put.ok, true, put.why);
  const s = await sup.owned.request('owner-x', { type: 'services.start', name: 'web' });
  assert.equal(s.ok, false);
  assert.equal(s.service.listening, true, '推给登记方的状态如实写：端口在听');
  assert.equal(s.service.health, 'failing', '……但健康检查不过');
  assert.equal(await reachable(P_OWNED), true);
  const r = await sup.owned.request('owner-x', { type: 'services.stop', name: 'web' });
  assert.equal(r.code, 'no-capability');
  const f = await sup.owned.request('owner-x', { type: 'services.stop', name: 'web', force: true });
  assert.equal(f.ok, true, f.why);
  assert.equal(f.service.state, 'STOPPED');
  assert.equal(await listening(P_OWNED), false);
  const rm = await sup.owned.request('owner-x', { type: 'services.remove', name: 'web' });
  assert.equal(rm.ok, true, rm.why);
});
