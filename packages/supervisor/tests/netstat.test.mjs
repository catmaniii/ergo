import './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
// 端口监听的判定：netstat 的状态列靠不住时（2026-10-29 实测），不能把好好在听的服务判成「没人在听」。
import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import { parseNetstat, canConnect, listenersFromCim } from '../src/winproc.mjs';
import { probeService, sharedPortNote, validRows, mergeOwners } from '../src/probe.mjs';
import { runningEvidence } from '../src/supervisor.mjs';

// 和那天的真输出同构：监听 socket 被报成 CLOSED / FIN_WAIT_1，外部地址仍是通配
const SAMPLE = [
  '',
  '活动连接',
  '',
  '  协议  本地地址          外部地址        状态           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200',
  '  TCP    127.0.0.1:7420         0.0.0.0:0              CLOSED          6304',
  '  TCP    127.0.0.1:47890        0.0.0.0:0              FIN_WAIT_1      18924',
  '  TCP    [::]:3389              [::]:0                 CLOSED          7256',
  '  TCP    127.0.0.1:47890        127.0.0.1:50648        ESTABLISHED     18924',
  '  TCP    127.0.0.1:50648        127.0.0.1:47890        ESTABLISHED     6304',
  '  TCP    127.0.0.1:50582        127.0.0.1:47823        TIME_WAIT       0',
].join('\r\n');

test('netstat：LISTENING 照常算；外部地址是通配、状态报错的归进 suspect；真连接不算监听', () => {
  const { pids, binds, suspect } = parseNetstat(SAMPLE);
  assert.deepEqual([...pids], [[135, [1200]]]);
  assert.deepEqual([...binds], [[135, ['0.0.0.0']]]);
  assert.deepEqual([...suspect.keys()].sort((a, b) => a - b), [3389, 7420, 47890]);
  assert.deepEqual(suspect.get(7420), [{ pid: 6304, addr: '127.0.0.1' }]);
  assert.deepEqual(suspect.get(3389), [{ pid: 7256, addr: '[::]' }]);
  assert.equal(suspect.has(50648), false);   // 已建立的连接有具体对端，不是监听
  assert.equal(suspect.has(47823), false);   // TIME_WAIT 的客户端那头也不是
});

test('真连一下：在听的端口连得上，没人听的连不上（netstat 说什么都不作数）', async () => {
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  assert.equal(await canConnect(port, '127.0.0.1'), true);
  assert.equal(await canConnect(port, '0.0.0.0'), true);        // 绑通配地址的，连回环
  await new Promise((r) => srv.close(r));
  assert.equal(await canConnect(port, '127.0.0.1', 500), false);
});

test('连得上、连接表里却没有它的行：按健康检查说好坏，不猜 PID、不判孤儿（猜错了冲突清理会杀自己人）', async () => {
  let code = 200;
  const srv = http.createServer((q, r) => { r.statusCode = code; r.end('x'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const svc = { id: 'site', probe: { tier: 'health', port, health: { url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 } } };
  const snap = { ports: new Map(), binds: new Map(), procs: new Map(), allProcs: new Map(), reachable: new Set([port]) };
  let p = await probeService(svc, { pid: 4242, pidStart: 's' }, snap, null);
  assert.deepEqual([p.ok, p.listening, p.orphan, p.pid, p.identityUnverified], [true, true, false, 4242, true]);
  assert.match(p.detail, /HTTP 200.*看不到是谁在听/);
  code = 500;
  p = await probeService(svc, { pid: null }, snap, null);
  assert.deepEqual([p.ok, p.health, p.pid, p.orphan], [false, 'failing', null, false]);
  await new Promise((r) => srv.close(r));
  // 连不上就是真没人听：和原来一样
  p = await probeService(svc, { pid: null }, { ...snap, reachable: new Set() }, null);
  assert.deepEqual([p.ok, p.listening], [false, false]);
});

test('还在不在跑：连得上就算在跑；要强杀的进程从「命令行里写着它日志路径的 cmd 包装层」认，别的不认', () => {
  const outLog = String.raw`D:\lsm\logs\site.out.log`;
  const snap = {
    ports: new Map(), reachable: new Set([5000]),
    procs: new Map([
      [77, { name: 'cmd.exe', cmd: String.raw`cmd /d /s /c "node serve.js >> "D:\lsm\logs\site.out.log""` }],
      [88, { name: 'node.exe', cmd: 'node unrelated.js' }],
    ]),
  };
  const e = runningEvidence({ probe: { port: 5000 } }, { pid: null }, snap, { outLog });
  assert.equal(e.running, true);
  assert.deepEqual(e.pids, [77]);
  assert.equal(runningEvidence({ probe: { port: 5000 } }, { pid: null }, { ...snap, reachable: new Set() }, { outLog }).running, false);
});

test('netstat 的 LISTENING 行留着「进程 + 地址」配对；Get-NetTCPConnection 的行归成同样的形状，IPv6 加方括号', () => {
  const { listeners } = parseNetstat(['  TCP    0.0.0.0:8799    0.0.0.0:0    LISTENING    100', '  TCP    127.0.0.1:8799  0.0.0.0:0    LISTENING    200'].join('\r\n'));
  assert.deepEqual(listeners.get(8799), [{ pid: 100, addr: '0.0.0.0' }, { pid: 200, addr: '127.0.0.1' }]);
  const m = listenersFromCim([
    { LocalAddress: '0.0.0.0', LocalPort: 8799, OwningProcess: 100 },
    { LocalAddress: '127.0.0.1', LocalPort: 8799, OwningProcess: 200 },
    { LocalAddress: '::', LocalPort: 3389, OwningProcess: 300 },
    { LocalAddress: '::', LocalPort: 3389, OwningProcess: 300 },        // 重复行只算一次
    { LocalAddress: '0.0.0.0', LocalPort: 135, OwningProcess: 0 },      // PID 0 不是进程
  ]);
  assert.deepEqual(m.get(8799), [{ pid: 100, addr: '0.0.0.0' }, { pid: 200, addr: '127.0.0.1' }]);
  assert.deepEqual(m.get(3389), [{ pid: 300, addr: '[::]' }]);
  assert.equal(m.has(135), false);
});

test('端口被共享（2026-11-02：测试服务绑着 127.0.0.1:8799，drama 绑 0.0.0.0）：状态里点名，PID 认账本里那个，不把入侵者记成自己', async () => {
  const srv = http.createServer((q, r) => { r.statusCode = 404; r.end('x'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const svc = { id: 'web', probe: { tier: 'health', port, health: { url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 } } };
  const rows = [{ pid: 222, addr: '127.0.0.1' }, { pid: 111, addr: '0.0.0.0' }];     // 入侵者排在前面
  const snap = {
    ports: new Map([[port, [222, 111]]]), binds: new Map([[port, ['127.0.0.1', '0.0.0.0']]]), listeners: new Map([[port, rows]]),
    procs: new Map([[111, { name: 'node.exe' }], [222, { name: 'python3.11.exe' }]]), allProcs: new Map(),
  };
  const p = await probeService(svc, { pid: 111 }, snap, null);
  assert.equal(p.pid, 111);
  assert.equal(p.ok, false);                 // 健康检查确实打到了别人那儿
  assert.match(p.detail, /HTTP 404 · ⚠ 端口 \d+ 有 2 个进程在听：127\.0\.0\.1 → python3\.11\.exe \(222\)，0\.0\.0\.0 → node\.exe \(111\)/);
  assert.equal(p.portShared, sharedPortNote(port, snap));
  await new Promise((r) => srv.close(r));
  // 同一个进程绑 IPv4 + IPv6 不算共享
  assert.equal(sharedPortNote(port, { listeners: new Map([[port, [{ pid: 1, addr: '0.0.0.0' }, { pid: 1, addr: '[::]' }]]]) }), '');
});

test('后台查到的行：进程死了、PID 被复用了都不算数', () => {
  const procs = new Map([[1, { start: 'a' }], [2, { start: 'b' }]]);
  const rows = [{ pid: 1, addr: '0.0.0.0' }, { pid: 2, addr: '127.0.0.1' }, { pid: 3, addr: '127.0.0.1' }];
  assert.deepEqual(validRows(rows, procs).map((r) => r.pid), [1, 2]);          // 3 已经没了
  procs.set(2, { start: 'reused' });
  assert.deepEqual(validRows(rows, procs).map((r) => r.pid), [1]);             // 2 换人了
  assert.deepEqual(validRows(null, procs), []);
});

test('缓存的权限比 netstat 小：netstat 这一轮有行就只认它（缓存只用来点名，进不了强杀名单）；没行才用缓存，并标出来不判孤儿', () => {
  const drama = { pid: 100, addr: '0.0.0.0' };
  const stray = { pid: 200, addr: '127.0.0.1' };
  let m = mergeOwners([drama], [drama, stray]);
  assert.deepEqual(m.owners, [100]);
  assert.deepEqual(m.rows, [drama, stray]);
  assert.equal(m.cacheOnly, false);
  m = mergeOwners([], [drama, stray]);
  assert.deepEqual(m.owners, [100, 200]);
  assert.equal(m.cacheOnly, true);
  m = mergeOwners([], []);
  assert.deepEqual([m.owners, m.rows, m.cacheOnly], [[], [], false]);
});

test('监听者只有缓存这一个来源、又对不上账本：不判孤儿（判了冲突清理就会动手），只把 PID 认过来', async () => {
  const srv = http.createServer((q, r) => r.end('x'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const svc = { id: 'web', probe: { tier: 'health', port, health: { url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 } } };
  const base = {
    ports: new Map([[port, [222]]]), binds: new Map(), listeners: new Map([[port, [{ pid: 222, addr: '127.0.0.1' }]]]),
    procs: new Map([[111, { name: 'cmd.exe' }], [222, { name: 'node.exe' }]]), allProcs: new Map(),
  };
  let p = await probeService(svc, { pid: 111 }, { ...base, cacheOwned: new Set([port]) }, null);
  assert.deepEqual([p.orphan, p.pid, p.ok], [false, 222, true]);
  p = await probeService(svc, { pid: 111 }, { ...base, cacheOwned: new Set() }, null);      // netstat 亲眼看到的：照旧判
  assert.equal(p.orphan, true);
  await new Promise((r) => srv.close(r));
});
