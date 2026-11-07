// 重启接入了的服务的各条岔路（438）：真的 Supervisor + 临时注册表，接入层换成替身（连没连、PID、忙不忙由测试拨），
// 会真起进程、真杀进程、真起 PowerShell 的方法（startOnce / liveness / killServiceTree / refresh）换成只记账的替身。
// 真进程、真命令行的那一遍在 restart-linked.test.mjs。
//
// 安全措施：数据目录是 _isolate.mjs 建的临时目录；不起任何进程、不连任何端口（注册表里的端口只是个数）。
import { TEST_DATA_DIR } from './_isolate.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

process.env.LSM_QUIET = '1';
const REG = path.join(TEST_DATA_DIR, 'registry');
fs.mkdirSync(path.join(REG, 'services'), { recursive: true });
fs.writeFileSync(path.join(REG, 'manager.yaml'), [
  'bind: 127.0.0.1', 'port: 27954', 'autoResolveConflicts: false',
  'sentinels:', '  port: false', '  scheduledTask: false', '',
].join('\n'));
// 等空闲的上限、立刻停的期限都调短（stopPlan 从 hooks.stop 取），测试才跑得完
const yaml = (id, port) => [
  `id: ${id}`, `root: ${JSON.stringify(TEST_DATA_DIR)}`, 'kind: managed',
  'probe:', '  tier: linked', `  port: ${port}`,
  'hooks:', '  start:', '    cmd: node -e 0', '  stop:', '    cmd: node -e 0', '    timeoutMs: 1500', '    idleTimeoutMs: 3000',
  'link:', '  enabled: true', '',
].join('\n');
fs.writeFileSync(path.join(REG, 'services', 'svc.yaml'), yaml('svc', 27955));

const { Supervisor } = await import('../src/supervisor.mjs');
const { AUDIT_LOG } = await import('../src/paths.mjs');
const audits = () => { try { return fs.readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); }
}

const sup = new Supervisor();
assert.deepEqual(sup.registryErrors, []);

/** 一套新的替身：接入层、进程在不在、start、杀进程。返回拨它们的把手和调用记录。 */
function rig({ capabilities = ['busy', 'stop', 'restart'], busy = false, ack = { ok: true } } = {}) {
  const w = {
    link: { connected: true, pid: 1001, busy, busyReason: busy ? '在跑长任务' : null, capabilities, health: 'ok' },
    alive: true,            // 进程和端口还在不在（liveness 的替身）
    calls: [],              // 发给服务的指令
    starts: [],             // startOnce 被调时账本的样子
    kills: [],
  };
  /** 服务照指令退出：连接断、进程没了 */
  w.exit = () => { w.link.connected = false; w.alive = false; };
  sup.link = {
    status: (id) => (id === 'svc' ? { ...w.link } : { connected: false }),
    restart: async (id, o) => { w.calls.push(['restart', id, o]); return ack; },
    stop: async (id, o) => { w.calls.push(['stop', id, o]); return ack; },
    cancel: async (id) => { w.calls.push(['cancel', id]); return { ok: true }; },
  };
  sup.liveness = async () => ({ running: w.alive, pids: w.alive ? [4242] : [], why: w.alive ? '替身：还在' : '' });
  sup.refresh = async () => [];
  sup.killServiceTree = async (svc, pid) => { w.kills.push(pid); w.exit(); return { killed: [pid] }; };
  sup.startOnce = async (id) => {
    const st = sup.st(id);
    w.starts.push({ state: st.state, desired: st.desired, failStreak: st.failStreak });
    Object.assign(w.link, { connected: true, pid: 2002, busy: false });
    w.alive = true;
    Object.assign(st, { state: 'RUNNING', pid: 2002 });
    return { ok: true, pid: 2002 };
  };
  // 账本：在跑、上一轮探活正常（就是 02:35 那次的样子）
  Object.assign(sup.st('svc'), { state: 'RUNNING', desired: 'running', pid: 1001, failStreak: 0, pendingStop: false });
  return w;
}
const lastDone = () => audits().filter((a) => a.action === 'restart-done' && a.id === 'svc').at(-1);
const view = () => sup.snapshotForUi().services.find((s) => s.id === 'svc');

test('立刻重启：旧进程退干净后先把账本记成已停（desired 仍 running）再 start——不给「上一轮还在跑」留宽限；回已重启和新 PID', async () => {
  const w = rig();
  setTimeout(w.exit, 300);
  const r = await sup.restart('svc', { mode: 'now' });
  assert.deepEqual(r, { ok: true, restarted: true, pid: 2002 });
  assert.deepEqual(w.calls.map((c) => c.slice(0, 2)), [['restart', 'svc']]);
  assert.equal(w.calls[0][2].mode, 'now');
  assert.deepEqual(w.starts, [{ state: 'STOPPED', desired: 'running', failStreak: 0 }]);
  assert.equal(lastDone().ok, true);
  assert.equal(lastDone().pid, 2002);
});

test('服务不接重启指令：照实回失败、原因带上，不起不杀', async () => {
  const w = rig({ ack: { ok: false, why: '正在写入分镜' } });
  const r = await sup.restart('svc', { mode: 'now' });
  assert.equal(r.ok, false);
  assert.match(r.why, /没接下重启指令（正在写入分镜）/);
  assert.equal(w.starts.length, 0);
  assert.equal(w.kills.length, 0);
});

test('等空闲再重启、服务正忙：马上回「等它空闲后重启」，卡片上显示待重启；再要一次不重复发；空闲后退出，后台拉起来', async () => {
  const w = rig({ busy: true });
  const t0 = Date.now();
  const r = await sup.restart('svc', { mode: 'when-idle' });
  assert.ok(Date.now() - t0 < 1500, '不等它空闲');
  assert.equal(r.ok, true);
  assert.equal(r.pending, true);
  assert.equal(r.already, undefined);
  assert.match(r.why, /svc 正忙（在跑长任务），重启已排队：等它空闲后重启/);
  assert.equal(view().pendingRestart, true);
  const again = await sup.restart('svc', { mode: 'when-idle' });
  assert.equal(again.pending, true);
  assert.match(again.why, /已经排着一次重启了/);
  assert.equal(w.calls.filter((c) => c[0] === 'restart').length, 1, '只发了一条');
  assert.equal(w.starts.length, 0, '忙着不起');
  // 空闲了：它自己退出，管理器拉起来
  w.link.busy = false;
  w.exit();
  assert.ok(await until(() => lastDone()?.background && lastDone().ok), '后台做完记了审计');
  assert.deepEqual(w.starts, [{ state: 'STOPPED', desired: 'running', failStreak: 0 }]);
  assert.equal(view().pendingRestart, false);
});

test('等空闲再重启、等到上限还在忙：两边都撤（发 cancel），不起不杀，它照常跑', async () => {
  const w = rig({ busy: true });
  const r = await sup.restart('svc', { mode: 'when-idle' });
  assert.equal(r.pending, true);
  const done = await until(() => (lastDone()?.background && lastDone().ok === false ? lastDone() : null), 10000);
  assert.ok(done, '等到上限（测试里调成 3 秒）后放弃');
  assert.match(done.why, /这次重启撤销了（它那边挂着的也撤了），它照常跑/);
  assert.deepEqual(w.calls.map((c) => c[0]), ['restart', 'cancel']);
  assert.equal(w.calls[0][2].deadlineMs, 3000, '告诉服务的期限就是管理器等的上限');
  assert.equal(w.starts.length, 0);
  assert.equal(w.kills.length, 0, '等空闲的永远不强杀');
  assert.equal(view().pendingRestart, false);
  assert.equal(sup.st('svc').desired, 'running');
});

test('旧进程退了、新进程被别人（autoRestart）抢先拉起来接入：算重启了，不再起第二份', async () => {
  const w = rig();
  setTimeout(() => { w.link.pid = 3003; }, 300);   // 连接一直「在」，只是换了 PID
  const r = await sup.restart('svc', { mode: 'now' });
  assert.equal(r.ok, true);
  assert.equal(r.restarted, true);
  assert.equal(r.pid, 3003);
  assert.match(r.note, /1001 → 3003/);
  assert.equal(w.starts.length, 0);
});

test('等它退出的工夫里有人让它停下：退了也不再拉起，照实说', async () => {
  const w = rig();
  setTimeout(() => { sup.st('svc').desired = 'stopped'; w.exit(); }, 300);
  const r = await sup.restart('svc', { mode: 'now' });
  assert.equal(r.ok, false);
  assert.match(r.why, /有人让它停下/);
  assert.equal(w.starts.length, 0);
});

test('立刻重启过了期限还没退出：和立刻停止一样杀进程树兜底，再拉起来', async () => {
  const w = rig();   // 接下了指令却一直不退
  const r = await sup.restart('svc', { mode: 'now' });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.restarted, true);
  assert.deepEqual(w.kills, [4242]);
  assert.deepEqual(w.starts, [{ state: 'STOPPED', desired: 'running', failStreak: 0 }]);
  assert.ok(audits().some((a) => a.action === 'force-kill' && a.id === 'svc' && a.reason === 'restart-timeout'));
});

test('拉不起来：旧的已经退了，照实说没起来，不报成功', async () => {
  const w = rig();
  sup.startOnce = async () => ({ ok: false, why: 'start 失败（exit 1）：端口被占' });
  setTimeout(w.exit, 300);
  const r = await sup.restart('svc', { mode: 'now' });
  assert.equal(r.ok, false);
  assert.match(r.why, /已经退出，但没拉起来：start 失败（exit 1）：端口被占/);
});

test('只报了停机能力的接入服务（注册表有停机和启动钩子）：经接入层让它退出再拉起——不会排队停下之后回「本来就在跑」', async () => {
  const w = rig({ capabilities: ['busy', 'stop'] });
  setTimeout(w.exit, 300);
  const r = await sup.restart('svc', { mode: 'when-idle' });
  assert.deepEqual(r, { ok: true, restarted: true, pid: 2002 });
  assert.deepEqual(w.calls.map((c) => c.slice(0, 2)), [['stop', 'svc']]);
  assert.equal(w.calls[0][2].mode, 'when-idle');
  assert.equal(sup.st('svc').pendingStop, false);
  assert.deepEqual(w.starts, [{ state: 'STOPPED', desired: 'running', failStreak: 0 }]);
});
