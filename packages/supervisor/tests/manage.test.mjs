// 管理指令（docs/link-protocol.md §9）：命脉怎么算、哪些操作对命脉一律 protected、对普通服务照常转给 supervisor、
// 不开放的、名下的服务不能用、restartSelf 立刻回「已排队」、审计日志；最后经真的接入层走一遍消息分流。
//
// 安全措施：注册表、账本、日志都在临时目录（LSM_DATA_DIR）；端口全是临时挑的空闲端口，不碰 7420 / 8810 / 8811；
// autoResolveConflicts 关掉。会真的起停、杀进程的 supervisor 方法（start / stop / restart / resolveOrphan / tailnet / 撤销）
// 在测试里换成只记账的替身——这里测的是「该不该转过去、转了什么」，真起停在 manage-link.test.mjs 里测。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-manage-'));
process.env.LSM_DATA_DIR = DATA;
process.env.LSM_QUIET = '1';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORTS = await Promise.all(Array.from({ length: 14 }, freePort));
const FORBIDDEN = [7420, 8810, 8811, 8090, 8091, 47823, 47890, 47895, 8785];
assert.ok(!PORTS.some((p) => FORBIDDEN.includes(p)));
const [MGR, P_ERGO, P_GW, P_DB, P_DISK, P_NET, P_TTS, P_GUARD, P_PLAIN, P_REPORT, P_OTHER, P_WEB, P_BOT] = PORTS;

// ---- 临时注册表
// ergo-test：调用方。公网经 ergo-tunnel（隧道硬依赖 net-up），开着 tailnet 入口，硬依赖 db（db 再硬依赖 db-disk），软依赖 tts
// guard-svc：标了 lifeline: true；plain：普通服务（有自己的隧道和 tailnet 入口）；reporting：硬依赖 db 的普通服务（标了 ergo: true，只是显示、不算命脉）
// other：另一个接入的项目；ergo-test--web / ergo-test--bot：ergo-test 名下的服务（bot 自己也接入）
const REG = path.join(DATA, 'registry');
fs.mkdirSync(path.join(REG, 'services', 'owned', 'ergo-test'), { recursive: true });
fs.writeFileSync(path.join(REG, 'manager.yaml'), [
  'bind: 127.0.0.1', `port: ${MGR}`, 'probeIntervalMs: 5000', 'autoResolveConflicts: false',
  'sentinels:', '  port: false', '  scheduledTask: false',
  'tailnet:', '  domain: tail.example.test', '  gateway: tail-gw',
  'profiles:', '  ergo: [ergo-test]', '  gpu: [tts, plain]', '  data: [reporting]', '',
].join('\n'));
const svc = (id, port, extra = []) => [
  `id: ${id}`, `root: ${JSON.stringify(DATA)}`, 'kind: managed',
  'probe:', `  tier: port`, `  port: ${port}`,
  'hooks:', '  start:', '    cmd: node -e 0', '    detaches: false', ...extra, '',
].join('\n');
const tunnel = (id, extra = []) => [
  `id: ${id}`, `root: ${JSON.stringify(DATA)}`, 'kind: managed', 'role: tunnel',
  'probe:', '  tier: process', `  matchCmd: ${id}-no-such-process`,
  'hooks:', '  start:', '    cmd: node -e 0', '    detaches: false', ...extra, '',
].join('\n');
const write = (rel, text) => fs.writeFileSync(path.join(REG, 'services', rel), text);
write('ergo-test.yaml', svc('ergo-test', P_ERGO, [
  'link:', '  enabled: true',
  'exposure:', '  via: ergo-tunnel', '  remotePort: 18811', '  check: false',
  'dependsOn:', '  - id: db', '    type: hard', '  - id: tts', '    type: soft',
]));
write('ergo-tunnel.yaml', tunnel('ergo-tunnel', ['dependsOn:', '  - id: net-up', '    type: hard']));
write('tail-gw.yaml', svc('tail-gw', P_GW));
write('db.yaml', svc('db', P_DB, ['dependsOn:', '  - id: db-disk', '    type: hard']));
write('db-disk.yaml', svc('db-disk', P_DISK));
write('net-up.yaml', svc('net-up', P_NET));
write('tts.yaml', svc('tts', P_TTS));
write('guard-svc.yaml', svc('guard-svc', P_GUARD, ['lifeline: true']));
write('plain.yaml', svc('plain', P_PLAIN, ['exposure:', '  via: plain-tunnel', '  remotePort: 18899', '  check: false', 'logs:', '  - path: plain-app.log', '    label: app']));
write('plain-tunnel.yaml', tunnel('plain-tunnel'));
write('reporting.yaml', svc('reporting', P_REPORT, ['dependsOn:', '  - id: db', '    type: hard', 'ergo: true']));
write('other.yaml', svc('other', P_OTHER, ['link:', '  enabled: true']));
write(path.join('owned', 'ergo-test', 'web.yaml'), svc('ergo-test--web', P_WEB, ['owner: ergo-test']));
write(path.join('owned', 'ergo-test', 'bot.yaml'), svc('ergo-test--bot', P_BOT, ['owner: ergo-test', 'link:', '  enabled: true']));
fs.writeFileSync(path.join(REG, 'tailnet.yaml'), 'entries:\n  - id: ergo-test\n    name: ergo\n  - id: plain\n    name: plain\n');

const { Supervisor } = await import('../src/supervisor.mjs');
const { attachLink } = await import('../src/link.mjs');
const { createManage, lifelineOf, FEATURE, LOG_LINES_MAX } = await import('../src/manage.mjs');
const { parseService, validate } = await import('../src/registry.mjs');
const { AUDIT_LOG } = await import('../src/paths.mjs');

const sup = new Supervisor();
assert.deepEqual(sup.registryErrors, []);
const manage = createManage(sup);
const ask = (caller, msg) => manage.request(caller, { id: 'q', ...msg });
const audits = () => fs.readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(20); }
}

/** 把会真起停、真杀进程的 supervisor 方法换成只记账的替身；restore() 换回来。 */
function stubSup({ running = true } = {}) {
  const calls = [];
  const rec = (name, ret = { ok: true }) => async (...args) => { calls.push([name, ...args]); return typeof ret === 'function' ? ret(...args) : ret; };
  const names = {
    start: rec('start'), stop: rec('stop'), restart: rec('restart'), cancelPendingStop: rec('cancelPendingStop'),
    startProfile: rec('startProfile', { ok: true, results: [] }), stopProfile: rec('stopProfile', { ok: true, results: [] }),
    resolveOrphan: rec('resolveOrphan', { ok: true, killed: [] }), openTailnet: rec('openTailnet', { ok: true, url: 'https://x.tail.example.test/' }),
    closeTailnet: rec('closeTailnet'), liveness: async () => ({ running, pids: [], why: '替身' }),
  };
  Object.assign(sup, names);
  const withdraw = sup.owned.withdraw;
  sup.owned.withdraw = rec('withdraw', (id) => ({ ok: true, removed: { id, name: id } }));
  return {
    calls,
    restore() { for (const n of Object.keys(names)) delete sup[n]; sup.owned.withdraw = withdraw; },
  };
}

// ---------------------------------------------------------------- 命脉怎么算

test('命脉：自己、公网隧道（连同隧道的硬依赖）、tailnet 网关、硬依赖的闭包、标了 lifeline 的；软依赖和别的服务不算', () => {
  const l = lifelineOf(sup, 'ergo-test');
  assert.deepEqual([...l.keys()].toSorted(), ['db', 'db-disk', 'ergo-test', 'ergo-tunnel', 'guard-svc', 'net-up', 'tail-gw']);
  assert.deepEqual(l.get('ergo-test'), ['调用方自己']);
  assert.match(l.get('ergo-tunnel')[0], /公网隧道/);
  assert.match(l.get('tail-gw')[0], /tailnet 网关/);
  assert.deepEqual(l.get('db'), ['ergo-test 硬依赖它']);
  assert.deepEqual(l.get('db-disk'), ['db 硬依赖它'], '闭包：硬依赖的硬依赖');
  assert.deepEqual(l.get('net-up'), ['ergo-tunnel 硬依赖它'], '隧道活不了，公网入口也就没了');
  assert.deepEqual(l.get('guard-svc'), ['注册表里标了 lifeline: true']);
  for (const id of ['tts', 'plain', 'plain-tunnel', 'reporting', 'other', 'ergo-test--web']) assert.equal(l.has(id), false, `${id} 不是命脉`);
});

test('别的接入方只保护它自己：没开 tailnet 入口就不带网关；二狗对它不是命脉', () => {
  const l = lifelineOf(sup, 'other');
  assert.deepEqual([...l.keys()].toSorted(), ['guard-svc', 'other']);
  assert.equal(l.has('ergo-test'), false);
  assert.equal(l.has('tail-gw'), false);
});

test('不是写死的名单：注册表一变（撤了公网入口、tailnet 入口），命脉跟着变', () => {
  const me = sup.services.get('ergo-test');
  const exposure = me.exposure;
  const entries = sup.tailnetEntries;
  try {
    me.exposure = null;
    sup.tailnetEntries = new Map([['plain', { name: 'plain' }]]);
    const l = lifelineOf(sup, 'ergo-test');
    assert.equal(l.has('ergo-tunnel'), false);
    assert.equal(l.has('net-up'), false);
    assert.equal(l.has('tail-gw'), false);
    assert.ok(l.has('db'));
  } finally { me.exposure = exposure; sup.tailnetEntries = entries; }
});

test('探活端口就是管理器自己端口的：对谁都是命脉（管理器本身不在任何「停」的范围里）', () => {
  const s = sup.services.get('tts');
  const port = s.probe.port;
  try {
    s.probe.port = MGR;
    assert.match(lifelineOf(sup, 'other').get('tts')[0], /服务管家自己/);
  } finally { s.probe.port = port; }
});

test('注册表的 ergo（和二狗有关）只能是 true / false：写错报错；它不算命脉', () => {
  const file = path.join(REG, 'services', 'x.yaml');
  for (const [v, bad] of [[true, false], [false, false], [undefined, false], ['yes', true], [1, true]]) {
    const errs = [];
    const s = parseService({ id: 'x', root: DATA, kind: 'managed', probe: { tier: 'port', port: 1 }, hooks: { start: 'node -e 0' }, ...(v === undefined ? {} : { ergo: v }) }, file);
    validate(s, file, errs);
    assert.equal(errs.some((e) => /ergo/.test(e)), bad, JSON.stringify(v));
    assert.equal(s.ergo, v === true);
  }
  assert.equal(sup.services.get('reporting').ergo, true);
  assert.equal(lifelineOf(sup, 'ergo-test').has('reporting'), false);
});

test('注册表的 lifeline 只能是 true / false：写成字符串报错，不悄悄当成没标', () => {
  const file = path.join(REG, 'services', 'x.yaml');
  for (const [v, bad] of [[true, false], [false, false], ['yes', true], [1, true]]) {
    const errs = [];
    const s = parseService({ id: 'x', root: DATA, kind: 'managed', probe: { tier: 'port', port: 1 }, hooks: { start: 'node -e 0' }, lifeline: v }, file);
    validate(s, file, errs);
    assert.equal(errs.some((e) => /lifeline/.test(e)), bad, JSON.stringify(v));
    assert.equal(s.lifeline, v === true);
  }
});

// ---------------------------------------------------------------- 对命脉一律 protected

const LIFELINE = ['ergo-test', 'ergo-tunnel', 'tail-gw', 'db', 'db-disk', 'net-up', 'guard-svc'];
const FORBIDDEN_OPS = [
  ['停止', (name) => ({ type: 'manage.stop', name })],
  ['强制停止', (name) => ({ type: 'manage.stop', name, force: true })],
  ['等空闲再停', (name) => ({ type: 'manage.stop', name, mode: 'when-idle' })],
  ['立刻重启', (name) => ({ type: 'manage.restart', name })],
  ['强制重启', (name) => ({ type: 'manage.restart', name, force: true })],
  ['开机自启关', (name) => ({ type: 'manage.autostart', name, on: false })],
  ['裁决孤儿 kill', (name) => ({ type: 'manage.orphan', name, decision: 'kill' })],
  ['撤销', (name) => ({ type: 'manage.remove', name })],
];

test('每个被禁的操作对每个命脉都回 protected，原因写清，supervisor 一个都没被调', async () => {
  const s = stubSup();
  try {
    for (const id of LIFELINE) {
      for (const [what, make] of FORBIDDEN_OPS) {
        const r = await ask('ergo-test', make(id));
        assert.equal(r.ok, false, `${what} ${id} 应该被拒`);
        assert.equal(r.code, 'protected', `${what} ${id}：${r.code} ${r.why}`);
        assert.equal(r.details[0].id, id);
        assert.ok(r.details[0].why.length > 0);
        assert.match(r.why, /命脉/);
      }
    }
    assert.deepEqual(s.calls, []);
  } finally { s.restore(); }
});

test('公网入口关、tailnet 关、含命脉的场景停止：也 protected', async () => {
  const s = stubSup();
  try {
    const off = await ask('ergo-test', { type: 'manage.exposeOff', name: 'ergo-test' });
    assert.equal(off.code, 'protected');
    assert.deepEqual(off.details.map((d) => d.id).toSorted(), ['ergo-test', 'ergo-tunnel'], '关公网入口 = 强制停那条隧道');
    assert.equal((await ask('ergo-test', { type: 'manage.tailnetClose', name: 'ergo-test' })).code, 'protected');
    const scene = await ask('ergo-test', { type: 'manage.profileStop', profile: 'ergo' });
    assert.equal(scene.code, 'protected');
    // 场景 data 只列了 reporting，可场景停止会连它的硬依赖 db 一起停
    const data = await ask('ergo-test', { type: 'manage.profileStop', profile: 'data', force: true });
    assert.equal(data.code, 'protected');
    assert.deepEqual(data.details.map((d) => d.id).toSorted(), ['db', 'db-disk']);
    assert.deepEqual(s.calls, []);
  } finally { s.restore(); }
});

test('撤最后一个 tailnet 入口会顺手停网关：网关是命脉时也拒', async () => {
  const s = stubSup();
  const gw = sup.services.get('tail-gw');
  const entries = sup.tailnetEntries;
  try {
    sup.tailnetEntries = new Map([['plain', { name: 'plain' }]]);
    gw.lifeline = true;
    const r = await ask('other', { type: 'manage.tailnetClose', name: 'plain' });
    assert.equal(r.code, 'protected');
    assert.deepEqual(r.details.map((d) => d.id), ['tail-gw']);
    gw.lifeline = false;
    assert.equal((await ask('other', { type: 'manage.tailnetClose', name: 'plain' })).ok, true, '网关不是命脉就照常撤');
  } finally { gw.lifeline = false; sup.tailnetEntries = entries; s.restore(); }
});

test('对命脉不停的操作照常：启动、取消等空闲再停、开机自启开、公网入口开、tailnet 开、认领孤儿', async () => {
  const s = stubSup();
  try {
    for (const msg of [
      { type: 'manage.start', name: 'ergo-test' },
      { type: 'manage.cancelStop', name: 'ergo-test' },
      { type: 'manage.exposeOn', name: 'ergo-test' },
      { type: 'manage.tailnetOpen', name: 'db', tailnetName: 'db' },
      { type: 'manage.orphan', name: 'db', decision: 'adopt' },
      { type: 'manage.profileStart', profile: 'ergo' },
    ]) {
      const r = await ask('ergo-test', msg);
      assert.equal(r.ok, true, `${msg.type}：${r.why}`);
    }
    assert.deepEqual(s.calls.map((c) => [c[0], c[1]]), [
      ['start', 'ergo-test'], ['cancelPendingStop', 'ergo-test'], ['start', 'ergo-tunnel'],
      ['openTailnet', 'db'], ['resolveOrphan', 'db'], ['startProfile', 'ergo'],
    ]);
    assert.deepEqual(s.calls[3][2], { name: 'db' });
    assert.equal(s.calls[4][2], 'adopt');
    const on = await ask('ergo-test', { type: 'manage.autostart', name: 'ergo-tunnel', on: true });
    assert.equal(on.ok, true, on.why);
    assert.equal(on.service.autostart, true);
  } finally { s.restore(); }
});

// ---------------------------------------------------------------- 普通服务照常

test('普通服务：停、强制停、重启、开机自启关、场景停、公网入口关、tailnet 关、孤儿 kill、撤销名下的，都转给 supervisor', async () => {
  const s = stubSup();
  try {
    const ok = async (msg) => {
      const r = await ask('ergo-test', msg);
      assert.equal(r.ok, true, `${msg.type} ${msg.name ?? msg.profile}：${r.code} ${r.why}`);
      return r;
    };
    await ok({ type: 'manage.stop', name: 'tts', mode: 'when-idle' });
    await ok({ type: 'manage.stop', name: 'plain', force: true });
    // tts 只有 start 钩子、没接入：没有重启能力，不带 force 不替它伪造
    const nocap = await ask('ergo-test', { type: 'manage.restart', name: 'tts' });
    assert.equal(nocap.code, 'no-capability');
    await ok({ type: 'manage.restart', name: 'tts', force: true });
    await ok({ type: 'manage.autostart', name: 'tts', on: false });
    await ok({ type: 'manage.profileStop', profile: 'gpu', force: true });
    await ok({ type: 'manage.exposeOff', name: 'plain' });
    await ok({ type: 'manage.tailnetClose', name: 'plain' });
    await ok({ type: 'manage.orphan', name: 'reporting', decision: 'kill' });
    const rm = await ok({ type: 'manage.remove', name: 'ergo-test--web' });
    assert.deepEqual(rm.removed, { id: 'ergo-test--web', name: 'ergo-test--web' });
    // 名下的服务照样能停（services.* 也照旧，见 owned-link.test.mjs）
    await ok({ type: 'manage.stop', name: 'ergo-test--web', force: true });
    assert.deepEqual(s.calls.map((c) => c.slice(0, 2)), [
      ['stop', 'tts'], ['stop', 'plain'], ['stop', 'tts'], ['start', 'tts'],
      ['stopProfile', 'gpu'], ['stop', 'plain-tunnel'], ['closeTailnet', 'plain'], ['resolveOrphan', 'reporting'],
      ['withdraw', 'ergo-test--web'], ['stop', 'ergo-test--web'],
    ]);
    assert.equal(s.calls[0][2].mode, 'when-idle');
    assert.equal(s.calls[1][2].force, true);
    assert.equal(s.calls[2][2].force, true, '强制重启 = 先强制停再起');
    assert.deepEqual(s.calls[4][2], { force: true });
    assert.equal(s.calls[5][2].force, true, '关公网入口 = 强制停隧道');
    assert.deepEqual(s.calls[8][2], { by: 'ergo-test' }, '撤销记着是谁撤的');
    assert.match(s.calls[0][2].reason, /ergo-test 经接入层/);
  } finally { s.restore(); }
});

test('别的接入方能停二狗（对它来说二狗不是命脉），但停不了它自己', async () => {
  const s = stubSup();
  try {
    assert.equal((await ask('other', { type: 'manage.stop', name: 'ergo-test', force: true })).ok, true);
    assert.equal((await ask('other', { type: 'manage.stop', name: 'other' })).code, 'protected');
    assert.equal((await ask('other', { type: 'manage.stop', name: 'guard-svc' })).code, 'protected', '标了 lifeline 的对谁都是');
  } finally { s.restore(); }
});

test('有重启能力的普通服务按 now 重启；没在跑的「重启」就是启动', async () => {
  const s = stubSup();
  const db = sup.services.get('reporting');
  try {
    db.hooks.restart = { cmd: 'node -e 0' };
    assert.equal((await ask('ergo-test', { type: 'manage.restart', name: 'reporting' })).ok, true);
    assert.deepEqual(s.calls.at(-1).slice(0, 2), ['restart', 'reporting']);
    assert.equal(s.calls.at(-1)[2].mode, 'now');
    assert.equal((await ask('ergo-test', { type: 'manage.restart', name: 'reporting', mode: 'when-idle' })).code, 'bad-request', '等空闲再重启只有 restartSelf');
  } finally { delete db.hooks.restart; s.restore(); }
  const idle = stubSup({ running: false });
  try {
    assert.equal((await ask('ergo-test', { type: 'manage.restart', name: 'tts' })).ok, true);
    assert.deepEqual(idle.calls.map((c) => c[0]), ['start']);
  } finally { idle.restore(); }
});

// ---------------------------------------------------------------- 不开放的、不认识的、缺字段的、名下的服务

test('reload、摘计划任务、VPS、改口令、开通公网：这条连接上不开放', async () => {
  for (const type of ['manage.reload', 'manage.detachTask', 'manage.vpsRefresh', 'manage.vpsSetup', 'manage.setPassword', 'manage.exposeCreate']) {
    const r = await ask('ergo-test', { type, name: 'plain' });
    assert.equal(r.code, 'not-allowed', type);
  }
  assert.equal((await ask('ergo-test', { type: 'manage.shutdown' })).code, 'bad-request', '不认识的');
  assert.equal((await ask('ergo-test', { type: 'manage.stop' })).code, 'bad-request', '缺 name');
  assert.equal((await ask('ergo-test', { type: 'manage.stop', name: 'nope' })).code, 'not-found');
  assert.equal((await ask('ergo-test', { type: 'manage.autostart', name: 'tts' })).code, 'bad-request', '缺 on');
  assert.equal((await ask('ergo-test', { type: 'manage.orphan', name: 'tts', decision: 'boom' })).code, 'bad-request');
  assert.equal((await ask('ergo-test', { type: 'manage.profileStop', profile: 'nope' })).code, 'not-found');
  assert.equal((await ask('ergo-test', { type: 'manage.exposeOff', name: 'tts' })).code, 'not-found', '没有公网入口');
  assert.equal((await ask('ergo-test', { type: 'manage.tailnetClose', name: 'tts' })).code, 'not-found', '没有 tailnet 入口');
  assert.equal((await ask('ergo-test', { type: 'manage.stop', name: 'tts', mode: 'later' })).code, 'bad-request');
});

test('名下的服务不能用管理指令（名下只有一层）', async () => {
  const r = await ask('ergo-test--bot', { type: 'manage.list' });
  assert.equal(r.code, 'not-allowed');
  assert.equal((await ask('ergo-test--bot', { type: 'manage.stop', name: 'tts' })).code, 'not-allowed');
});

// ---------------------------------------------------------------- 列表、日志

test('列表：每个服务带状态、端口、开机自启、最后一次出错、是不是命脉和原因；还有场景和命脉清单', async () => {
  sup.st('tts').lastError = '起不来：测试里编的';
  const r = await ask('ergo-test', { type: 'manage.list' });
  assert.equal(r.ok, true);
  assert.equal(r.self, 'ergo-test');
  const by = new Map(r.services.map((s) => [s.id, s]));
  assert.equal(by.size, sup.services.size);
  const me = by.get('ergo-test');
  assert.equal(me.protected, true);
  assert.deepEqual(me.protectedWhy, ['调用方自己']);
  assert.equal(me.port, P_ERGO);
  assert.deepEqual(me.exposure, { via: 'ergo-tunnel', publicUrl: null });
  assert.equal(me.tailnet.url, 'https://ergo.tail.example.test/');
  for (const k of ['state', 'desired', 'up', 'autostart', 'lastError', 'capabilities', 'linked', 'busy', 'pendingStop', 'dependsOn', 'profiles']) assert.ok(k in me, k);
  assert.equal(by.get('tts').protected, false);
  assert.deepEqual(by.get('tts').protectedWhy, []);
  assert.equal(by.get('tts').lastError, '起不来：测试里编的');
  assert.equal(by.get('ergo-test--web').owner, 'ergo-test');
  assert.deepEqual(r.profiles.data, ['reporting']);
  assert.deepEqual(r.lifeline.map((x) => x.id).toSorted(), ['db', 'db-disk', 'ergo-test', 'ergo-tunnel', 'guard-svc', 'net-up', 'tail-gw']);
  // tailnet 网关是哪个（调用方认「它离不开的」用）；标了 ergo: true 的带着标记，别的是 false
  assert.equal(r.tailnetGateway, 'tail-gw');
  assert.equal(by.get('reporting').ergo, true);
  assert.equal(by.get('tts').ergo, false);
  assert.equal(sup.snapshotForUi().services.find((s) => s.id === 'reporting').ergo, true);
  // 换个调用方，同一个服务的保护就不一样
  const other = await ask('other', { type: 'manage.list' });
  assert.equal(other.services.find((s) => s.id === 'ergo-test').protected, false);
});

test('日志：最后 N 行，有上限，过脱敏；还列出有哪几份', async () => {
  const out = sup.outLog('plain');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, [...Array.from({ length: 700 }, (_, i) => `line ${i}`), 'api_key=supersecretvalue', ''].join('\n'));
  const r = await ask('ergo-test', { type: 'manage.logs', name: 'plain', lines: 5000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.capped, true);
  const lines = r.lines.split('\n').filter(Boolean);
  assert.ok(lines.length <= LOG_LINES_MAX);
  assert.equal(lines.at(-1), 'api_key=***', '密钥不出管理器');
  assert.equal(lines.at(-2), 'line 699');
  assert.deepEqual(r.sources.map((x) => x.label), ['命令行输出', 'app']);
  const few = await ask('ergo-test', { type: 'manage.logs', name: 'plain', lines: 3 });
  assert.deepEqual(few.lines.split('\n').filter(Boolean), ['line 698', 'line 699', 'api_key=***']);
  assert.equal((await ask('ergo-test', { type: 'manage.logs', name: 'plain', source: 1 })).code, 'not-found', 'app 日志文件还不存在');
  assert.equal((await ask('ergo-test', { type: 'manage.logs', name: 'plain', source: 7 })).code, 'not-found');
  assert.equal((await ask('ergo-test', { type: 'manage.logs', name: 'plain', lines: 0 })).code, 'bad-request');
});

// ---------------------------------------------------------------- restartSelf

/** 假的接入层：只有 restartSelf 要用的 status / restart / cancel。 */
function fakeLink({ capabilities = ['busy', 'stop', 'restart'] } = {}) {
  const calls = [];
  const self = {
    connected: true, calls,
    status: (id) => (id === 'ergo-test' && self.connected ? { connected: true, capabilities } : { connected: false }),
    restart: async (id, opts) => { calls.push(['restart', id, opts]); return { ok: true }; },
    cancel: async (id) => { calls.push(['cancel', id]); return { ok: true }; },
  };
  return self;
}

test('restartSelf：只接受 when-idle；没接入、没报 restart 能力的不行', async () => {
  const saved = sup.link;
  try {
    sup.link = fakeLink();
    const m = createManage(sup);
    const now = await m.request('ergo-test', { type: 'manage.restartSelf', mode: 'now' });
    assert.equal(now.code, 'protected');
    sup.link = fakeLink({ capabilities: ['busy'] });
    assert.equal((await m.request('ergo-test', { type: 'manage.restartSelf' })).code, 'no-capability');
    sup.link = { status: () => ({ connected: false }) };
    assert.equal((await m.request('ergo-test', { type: 'manage.restartSelf', mode: 'when-idle' })).code, 'not-linked');
  } finally { sup.link = saved; }
});

test('restartSelf：立刻回「已排队」（不等它空闲），回复之后才发重启指令；排着的时候再要一次回 already', async () => {
  const saved = sup.link;
  const s = stubSup({ running: false });
  try {
    const link = fakeLink();
    sup.link = link;
    const m = createManage(sup, { restartSelfWaitMs: 60000 });
    const t0 = Date.now();
    const r = await m.request('ergo-test', { type: 'manage.restartSelf', mode: 'when-idle' });
    assert.ok(Date.now() - t0 < 1000, '不阻塞');
    assert.equal(r.ok, true);
    assert.equal(r.queued, true);
    assert.equal(typeof r.after, 'function');
    assert.deepEqual(link.calls, [], '回复发出去之前不发重启指令');
    const again = await m.request('ergo-test', { type: 'manage.restartSelf' });
    assert.equal(again.already, true);
    r.after();
    await sleep(50);
    assert.deepEqual(link.calls.map((c) => c.slice(0, 2)), [['restart', 'ergo-test']]);
    assert.equal(link.calls[0][2].mode, 'when-idle');
    assert.deepEqual(s.calls, [], '它还连着（还在忙）：不起');
    // 它空闲了、退出了：连接断开、进程和端口都没了 → 管理器把它拉起来
    link.connected = false;
    for (let i = 0; i < 50 && !s.calls.length; i++) await sleep(100);
    assert.deepEqual(s.calls.map((c) => c.slice(0, 2)), [['start', 'ergo-test']]);
    await sleep(50);
    const again2 = await m.request('ergo-test', { type: 'manage.restartSelf' });
    assert.equal(again2.already, undefined, '这一次做完了，可以再排');
  } finally { sup.link = saved; s.restore(); }
});

test('restartSelf：等不到空闲就两边都撤（服务那边的挂起也撤），不重启，服务照常跑', async () => {
  const saved = sup.link;
  const s = stubSup();
  try {
    const link = fakeLink();
    sup.link = link;
    const m = createManage(sup, { restartSelfWaitMs: 1200 });
    const r = await m.request('ergo-test', { type: 'manage.restartSelf' });
    r.after();
    for (let i = 0; i < 50 && link.calls.length < 2; i++) await sleep(100);
    assert.deepEqual(link.calls.map((c) => c[0]), ['restart', 'cancel']);
    assert.deepEqual(s.calls, []);
  } finally { sup.link = saved; s.restore(); }
});

// ---------------------------------------------------------------- 审计

test('每条管理指令都进审计日志：谁、什么、结果、拒绝原因', async () => {
  await ask('ergo-test', { type: 'manage.stop', name: 'ergo-tunnel', force: true });
  const rows = audits().filter((a) => a.action === 'link-manage');
  const last = rows.at(-1);
  assert.equal(last.caller, 'ergo-test');
  assert.equal(last.type, 'manage.stop');
  assert.equal(last.target, 'ergo-tunnel');
  assert.equal(last.force, true);
  assert.equal(last.ok, false);
  assert.equal(last.code, 'protected');
  assert.match(last.why, /命脉/);
  assert.ok(rows.some((a) => a.type === 'manage.list' && a.ok === true), '只读的也记');
  assert.ok(rows.some((a) => a.type === 'manage.restartSelf' && a.queued === true));
  assert.ok(audits().some((a) => a.action === 'link-manage-restart-self' && a.phase === 'started' && a.ok === true));
  assert.ok(audits().some((a) => a.action === 'link-manage-restart-self' && a.phase === 'gave-up'));
});

// ---------------------------------------------------------------- 经真的接入层

test('经接入层：welcome 里声明 manage；没 hello 先发、缺 id 被拒；回复是 manage.reply，error 带 code', async () => {
  const linkSrv = attachLink(sup);
  const savedLink = sup.link;
  sup.link = linkSrv;
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => linkSrv.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(MGR, '127.0.0.1', r));
  sup.st('ergo-test').linkToken = 'tok-ergo';
  sup.st('other').linkToken = 'tok-other';
  const open = [];
  const connect = async (token) => {
    const ws = new WebSocket(`ws://127.0.0.1:${MGR}/link`, { headers: { Authorization: `Bearer ${token}` } });
    open.push(ws);
    const got = [];
    ws.on('message', (raw) => got.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ws, got };
  };
  try {
    assert.ok(linkSrv.FEATURES.includes(FEATURE));
    const a = await connect('tok-ergo');
    a.ws.send(JSON.stringify({ type: 'manage.list', id: 'early' }));
    const early = await until(() => a.got.find((m) => m.id === 'early'));
    assert.equal(early.type, 'manage.reply');
    assert.equal(early.error.code, 'not-linked');
    // hello 里不报 pid：这里扮演服务的是测试进程自己，绝不能让任何一步把它当成要杀的进程
    a.ws.send(JSON.stringify({ type: 'hello', serviceId: 'ergo-test', protocol: 1, capabilities: ['busy', 'stop', 'restart'] }));
    const welcome = await until(() => a.got.find((m) => m.type === 'welcome'));
    assert.ok(welcome.features.includes('manage'));
    a.ws.send(JSON.stringify({ type: 'manage.list' }));
    const noId = await until(() => a.got.find((m) => m.type === 'manage.reply' && m.id === null));
    assert.equal(noId.error.code, 'bad-request');
    a.ws.send(JSON.stringify({ type: 'manage.stop', id: 7, name: 'ergo-test', force: true }));
    const self = await until(() => a.got.find((m) => m.id === 7));
    assert.equal(self.ok, false);
    assert.equal(self.error.code, 'protected');
    assert.deepEqual(self.error.details, [{ id: 'ergo-test', why: ['调用方自己'] }]);
    a.ws.send(JSON.stringify({ type: 'manage.list', id: 'l' }));
    const list = await until(() => a.got.find((m) => m.id === 'l'));
    assert.equal(list.ok, true);
    assert.equal(list.services.find((x) => x.id === 'ergo-test').protected, true);

    // 另一个接入方：二狗对它不是命脉——这里真的走到 supervisor.stop。先把扮演二狗的连接关掉：
    // 连着就算「还在跑」，stop 会去发停机指令、等不到再杀进程树；关掉之后它的端口没人听，看一眼就回「本来就停着」
    a.ws.close();
    assert.ok(await until(() => !linkSrv.status('ergo-test').connected));
    const b = await connect('tok-other');
    b.ws.send(JSON.stringify({ type: 'hello', serviceId: 'other', protocol: 1, capabilities: [] }));
    await until(() => b.got.find((m) => m.type === 'welcome'));
    b.ws.send(JSON.stringify({ type: 'manage.stop', id: 's', name: 'ergo-test' }));
    const stopped = await until(() => b.got.find((m) => m.id === 's'), 30000);
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
    assert.equal(stopped.already, true);
    b.ws.send(JSON.stringify({ type: 'manage.stop', id: 's2', name: 'other' }));
    assert.equal((await until(() => b.got.find((m) => m.id === 's2'))).error.code, 'protected');
  } finally {
    for (const ws of open) { try { ws.close(); } catch {} }
    linkSrv.close();
    sup.link = savedLink;
    await new Promise((r) => server.close(r));
  }
});

test.after(async () => {
  await sleep(100);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});
