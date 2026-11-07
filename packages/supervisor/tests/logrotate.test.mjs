// 日志切分（rotate.mjs）和读切开的日志（logs.mjs）：超过上限就切、只留几份、被服务的 cmd 占着时一个都不动；
// manager.log / audit.log 追加前切；看日志（tail、往前翻、日志页的流）跨过切开的地方接起来、标一行，切开时不丢、不重。
//
// 安全措施：数据目录是 _isolate.mjs 建的临时目录；文件都在临时目录里；占着文件的 cmd 是这里自己起的、命令行里带着临时目录，
// 收尾按它认、用完等它退出。不碰任何端口。
import { TEST_DATA_DIR } from './_isolate.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

process.env.LSM_QUIET = '1';
const { rotationPolicy, rotateIfLarge, rotatedFile, DEFAULT_ROTATION, DEFAULT_MAX_MB, DEFAULT_KEEP } = await import('../src/rotate.mjs');
const { logSegments, readSpan, tail, streamLog } = await import('../src/logs.mjs');
const { audit, info, setLogRotation } = await import('../src/log.mjs');
const { AUDIT_LOG, MANAGER_LOG } = await import('../src/paths.mjs');
const { allProcesses, killTree } = await import('../src/winproc.mjs');

const WORK = fs.mkdtempSync(path.join(TEST_DATA_DIR, 'rot-'));
let seq = 0;
const freshDir = () => { const d = path.join(WORK, `case-${++seq}`); fs.mkdirSync(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (prefix, n, width = 20) => Array.from({ length: n }, (_, i) => `${prefix}-${i} ${'.'.repeat(width)}\n`).join('');
const existing = (file) => [0, 1, 2, 3, 4, 5].filter((n) => fs.existsSync(n ? rotatedFile(file, n) : file));

test.after(async () => {
  // 万一哪条断言中途失败、占着文件的 cmd 没等到放行：命令行里带着这个临时目录的就是这里起的，按进程树杀
  const mine = [...(await allProcesses())].filter(([, p]) => (p.cmd || '').toLowerCase().includes(WORK.toLowerCase())).map(([pid]) => pid);
  for (const pid of mine) await killTree(pid);
});

test('manager.yaml 的 logs：默认 20 MB、留 3 份；写错的那一项报错并用默认，0 = 不切', () => {
  assert.equal(DEFAULT_MAX_MB, 20);
  assert.equal(DEFAULT_KEEP, 3);
  assert.deepEqual(rotationPolicy(undefined), { policy: { maxBytes: 20 * 1048576, keep: 3 }, errors: [] });
  assert.deepEqual(rotationPolicy({ maxMB: 5, keep: 2 }).policy, { maxBytes: 5 * 1048576, keep: 2 });
  assert.deepEqual(rotationPolicy({ maxMB: 0.5 }).policy, { maxBytes: 524288, keep: 3 });
  assert.equal(rotationPolicy({ maxMB: 0 }).policy.maxBytes, 0);
  for (const bad of [{ maxMB: -1 }, { maxMB: '20' }, { keep: 0 }, { keep: 1.5 }, { keep: 'three' }, { keep: 51 }]) {
    const r = rotationPolicy(bad);
    assert.equal(r.errors.length, 1, JSON.stringify(bad));
    assert.match(r.errors[0], /manager\.yaml: logs\./);
    assert.deepEqual(r.policy, { ...DEFAULT_ROTATION });
  }
  assert.match(rotationPolicy('big').errors[0], /maxMB \/ keep/);
});

test('没超上限不切；超了：现在这份改名成 .1，旧的往后挪，只留 keep 份，多出来的（份数调小过）清掉', () => {
  const d = freshDir();
  const f = path.join(d, 'svc.out.log');
  const pol = { maxBytes: 100, keep: 2 };
  fs.writeFileSync(f, 'x'.repeat(100));
  assert.deepEqual(rotateIfLarge(f, pol), { rotated: false, size: 100 });
  assert.deepEqual(rotateIfLarge(path.join(d, 'nope.log'), pol), { rotated: false });

  const gen = (n) => { fs.writeFileSync(f, `gen${n}\n` + 'x'.repeat(200)); return rotateIfLarge(f, pol); };
  assert.deepEqual(gen(1), { rotated: true, size: 205 });
  assert.deepEqual(existing(f), [1]);
  assert.match(fs.readFileSync(rotatedFile(f, 1), 'utf-8'), /^gen1/);
  gen(2); gen(3); gen(4);
  assert.deepEqual(existing(f), [1, 2], '只留 2 份，现在这份切走后还没重新建');
  assert.match(fs.readFileSync(rotatedFile(f, 1), 'utf-8'), /^gen4/);
  assert.match(fs.readFileSync(rotatedFile(f, 2), 'utf-8'), /^gen3/);

  // 以前留 4 份，现在调成 2：.3 .4 一起清掉
  fs.writeFileSync(rotatedFile(f, 3), 'old3'); fs.writeFileSync(rotatedFile(f, 4), 'old4');
  gen(5);
  assert.deepEqual(existing(f), [1, 2]);
  assert.match(fs.readFileSync(rotatedFile(f, 2), 'utf-8'), /^gen4/);

  // maxBytes 0 = 不切
  fs.writeFileSync(f, 'x'.repeat(1000));
  assert.deepEqual(rotateIfLarge(f, { maxBytes: 0, keep: 2 }), { rotated: false });
  assert.equal(fs.statSync(f).size, 1000);
});

test('服务的 cmd 正 >> 占着这份日志：改名、截断、追加都不行（所以没法「复制后截断」），切的时候一个文件都不动；它退了就能切', async () => {
  const d = freshDir();
  const f = path.join(d, 'held.out.log');
  const release = path.join(d, 'release');
  const holder = path.join(d, 'hold.cjs');
  // 和 hooks.spawnDetached 一样：外面一层 cmd 做 `>> 日志 2>&1`，服务进程直接写这个句柄
  fs.writeFileSync(holder, [
    "const fs = require('fs');",
    "process.stdout.write('held ' + 'y'.repeat(300) + '\\n');",
    `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(t); process.exit(0); } }, 100);`,
    'setTimeout(() => process.exit(0), 30000);',
    '',
  ].join('\n'));
  fs.writeFileSync(rotatedFile(f, 1), 'previous\n');
  fs.writeFileSync(f, 'header\n');
  const child = spawn(`"${process.execPath}" "${holder}" >> "${f}" 2>&1`, { shell: true, windowsHide: true, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 100 && fs.statSync(f).size < 300; i++) await sleep(100);
    assert.ok(fs.statSync(f).size > 300, '占着的进程写出了东西');
    // Windows 上 cmd 的 >> 只许别人读：这就是不能「复制后截断」、也不能边跑边改名的原因
    assert.throws(() => fs.truncateSync(f, 0), { code: 'EBUSY' });
    assert.throws(() => fs.renameSync(f, `${f}.x`), { code: 'EBUSY' });
    assert.ok(fs.readFileSync(f).length > 300, '读照样能读（日志页照常能看）');

    const r = rotateIfLarge(f, { maxBytes: 100, keep: 3 });
    assert.equal(r.rotated, false);
    assert.equal(r.busy, true);
    assert.ok(r.size > 300);
    assert.deepEqual(existing(f), [0, 1], '.1 没被往后挤，也没留下临时文件');
    assert.equal(fs.readFileSync(rotatedFile(f, 1), 'utf-8'), 'previous\n');
    assert.ok(!fs.existsSync(`${f}.rotating`));
  } finally {
    fs.writeFileSync(release, '');
    await exited;
  }
  // 它退了（下一次启动之前就是这样）：切得动
  assert.equal(rotateIfLarge(f, { maxBytes: 100, keep: 3 }).rotated, true);
  assert.deepEqual(existing(f), [1, 2]);
  assert.match(fs.readFileSync(rotatedFile(f, 1), 'utf-8'), /held y+/);
  assert.equal(fs.readFileSync(rotatedFile(f, 2), 'utf-8'), 'previous\n');
});

test('manager.log、audit.log 追加之前看一眼，超了就切，同样只留 keep 份', () => {
  setLogRotation({ maxBytes: 2048, keep: 2 });
  try {
    for (let i = 0; i < 120; i++) audit('test-rotate', { i, pad: 'p'.repeat(40) });
    for (let i = 0; i < 120; i++) info(`管理器日志 ${i} ${'q'.repeat(40)}`);
  } finally {
    setLogRotation(null);
  }
  for (const f of [AUDIT_LOG, MANAGER_LOG]) {
    assert.deepEqual(existing(f), [0, 1, 2], path.basename(f));
    assert.ok(fs.statSync(f).size <= 2048 + 200, `${path.basename(f)} 不超上限太多：${fs.statSync(f).size}`);
    assert.ok(fs.statSync(rotatedFile(f, 1)).size > 2048);
  }
  const last = fs.readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(last.i, 119, '最新的一条在现在这份里');
  // 每一行都完整：切只发生在两次追加之间
  for (const f of [AUDIT_LOG, rotatedFile(AUDIT_LOG, 1), rotatedFile(AUDIT_LOG, 2)]) {
    for (const l of fs.readFileSync(f, 'utf-8').trim().split('\n')) assert.equal(JSON.parse(l).action, 'test-rotate');
  }
});

// .2、.1、现在这份各写几行：位置上 .2 在最前（负数），现在这份从 0 开始
function layout() {
  const d = freshDir();
  const f = path.join(d, 'svc.out.log');
  fs.writeFileSync(rotatedFile(f, 2), lines('old2', 5));
  fs.writeFileSync(rotatedFile(f, 1), lines('old1', 5));
  fs.writeFileSync(f, lines('cur', 3));
  return { f, s2: fs.statSync(rotatedFile(f, 2)).size, s1: fs.statSync(rotatedFile(f, 1)).size, s0: fs.statSync(f).size };
}
const BOUNDARY = (name) => `----- 日志在这里切开过：以上在 ${name}，以下是接着的一份 -----\n`;

test('切开的日志按位置排：.1 在 [-size(.1), 0)，.2 在它前面；项目自己的日志只有现在这一份', () => {
  const { f, s2, s1, s0 } = layout();
  const segs = logSegments(f, { rotated: true });
  assert.deepEqual(segs.map((s) => [s.n, s.start, s.size]), [[2, -(s1 + s2), s2], [1, -s1, s1], [0, 0, s0]]);
  assert.deepEqual(logSegments(f).map((s) => s.n), [0]);
  fs.rmSync(f);
  const gone = logSegments(f, { rotated: true }).at(-1);
  assert.deepEqual([gone.exists, gone.size], [false, 0], '现在这份刚切走：记成空的');
});

test('readSpan：跨过切开的地方把几段接起来、中间标一行；起点在行中间时丢掉那半行；不切的日志照旧', () => {
  const { f, s2, s1, s0 } = layout();
  const all = readSpan(f, -(s1 + s2), s0, { rotated: true });
  assert.equal(all.ok, true);
  assert.equal(all.start, -(s1 + s2));
  assert.equal(all.text, lines('old2', 5) + BOUNDARY('svc.out.log.2') + lines('old1', 5) + BOUNDARY('svc.out.log.1') + lines('cur', 3));

  const mid = readSpan(f, -s1 + 3, 5, { rotated: true });          // 从 old1-0 那一行中间开始，读到现在这份的前 5 个字节
  const firstLen = Buffer.byteLength(lines('old1', 1));
  assert.equal(mid.start, -s1 + firstLen);
  assert.equal(mid.text, lines('old1', 5).slice(firstLen) + BOUNDARY('svc.out.log.1') + 'cur-0');

  const onlyOld = readSpan(f, -s1, 0, { rotated: true });          // 正好是 .1 一整份：读到它的头也标一行
  assert.equal(onlyOld.text, lines('old1', 5) + BOUNDARY('svc.out.log.1'));

  assert.equal(readSpan(f, -100, s0).text, lines('cur', 3), '项目自己的日志：负的起点当 0，不碰 .1');
});

test('tail：现在这份不够时接上 .1 的尾巴（标一行），够了就只读现在这份；项目的日志不接', () => {
  const { f, s0 } = layout();
  const r = tail(f, { lines: 6, rotated: true });
  assert.equal(r.ok, true);
  assert.equal(r.size, s0);
  assert.deepEqual(r.lines.split('\n'), ['old1-3 ' + '.'.repeat(20), 'old1-4 ' + '.'.repeat(20), BOUNDARY('svc.out.log.1').trim(), 'cur-0 ' + '.'.repeat(20), 'cur-1 ' + '.'.repeat(20), 'cur-2 ' + '.'.repeat(20), ''].slice(-6));
  assert.doesNotMatch(tail(f, { lines: 50, maxBytes: s0, rotated: true }).lines, /old1/, '现在这份就够 maxBytes：不往前接');
  assert.doesNotMatch(tail(f, { lines: 50 }).lines, /old1/, '项目自己的日志不接 .1');
  fs.rmSync(f);
  assert.match(tail(f, { lines: 3, rotated: true }).lines, /old1-4/, '现在这份刚切走、还没重新建：照样能读到 .1');
  assert.equal(tail(path.join(path.dirname(f), 'never.out.log'), { rotated: true }).ok, false);
});

// 日志页的流：假的 req / res，收下 SSE 事件
function openStream(file, opts) {
  const req = new EventEmitter();
  let raw = '';
  const res = { writeHead() {}, write(s) { raw += s; }, on() {} };
  streamLog(req, res, () => file, opts);
  return {
    events: () => raw.split('\n\n').map((block) => {
      const ev = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) ev.id = Number(line.slice(4));
        else if (line.startsWith('event: ')) ev.event = line.slice(7);
        else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
      }
      return ev;
    }).filter((e) => e.event),
    close: () => req.emit('close'),
  };
}
const textOf = (evs) => evs.filter((e) => e.event === 'chunk').map((e) => e.data.text).join('');

test('日志页的流：首屏接上切下来的旧日志；切开时发 rotated、位置换算好，没推完的从 .1 推完、标一行再接新的，不丢不重', async () => {
  const { f, s2, s1, s0 } = layout();
  const st = openStream(f, { rotated: true });
  try {
    await sleep(100);
    let evs = st.events();
    assert.equal(evs[0].event, 'meta');
    assert.equal(evs[0].data.earliest, -(s1 + s2));
    assert.equal(evs[0].data.start, -(s1 + s2), '现在这份很短：首屏从还留着的最早那份开头开始');
    assert.equal(evs[0].data.size, s0);
    assert.equal(textOf(evs), lines('old2', 5) + BOUNDARY('svc.out.log.2') + lines('old1', 5) + BOUNDARY('svc.out.log.1') + lines('cur', 3));
    assert.equal(evs.filter((e) => e.event === 'chunk').at(-1).id, s0);

    fs.appendFileSync(f, 'cur-3\n');
    await sleep(900);
    assert.equal(textOf(st.events().slice(evs.length)), 'cur-3\n');
    evs = st.events();

    // 写了一行还没推出去，紧接着就切（keep 2：.2 被删，.1 → .2，现在这份 → .1），新的一份马上开始写
    fs.appendFileSync(f, 'cur-4 not yet streamed\n');
    const before = fs.statSync(f).size;
    assert.equal(rotateIfLarge(f, { maxBytes: 1, keep: 2 }).rotated, true);
    fs.writeFileSync(f, 'new-0\n');
    await sleep(900);
    const after = st.events().slice(evs.length);
    assert.equal(after[0].event, 'rotated', JSON.stringify(after));
    assert.equal(after[0].data.shift, before);
    assert.equal(after[0].data.earliest, -(before + s1), '最早的现在是原来的 .1（变成了 .2）');
    assert.equal(after[0].id, s0 + 'cur-3\n'.length - before, '换算后的位置：在新的 .1 里，离它的结尾还差没推完的那一行');
    assert.equal(textOf(after), 'cur-4 not yet streamed\n' + BOUNDARY('svc.out.log.1') + 'new-0\n');
    assert.equal(after.filter((e) => e.event === 'chunk').at(-1).id, 'new-0\n'.length);
    assert.ok(!after.some((e) => e.event === 'reset'), '不清屏');

    // 常见的情形：那份早就推完了（服务停了一会儿才重启）才切——「切开过」那一行照样有
    evs = st.events();
    assert.equal(rotateIfLarge(f, { maxBytes: 1, keep: 2 }).rotated, true);
    fs.writeFileSync(f, 'next-0\n');
    await sleep(900);
    const again = st.events().slice(evs.length);
    assert.equal(again[0].event, 'rotated');
    assert.equal(again[0].id, 0);
    assert.equal(textOf(again), BOUNDARY('svc.out.log.1') + 'next-0\n');
  } finally { st.close(); }
});

test('日志页的流：断线重连带着负的位置（在 .1 里）照样续上；现在这份还没重新建出来时不报「不存在」', async () => {
  const { f, s1 } = layout();
  const st = openStream(f, { rotated: true, from: -s1 });
  try {
    await sleep(100);
    const evs = st.events();
    assert.equal(evs[0].event, 'meta');
    assert.equal(evs[0].data.start, -s1);
    assert.ok(textOf(evs).startsWith(lines('old1', 5) + BOUNDARY('svc.out.log.1') + 'cur-0'));
  } finally { st.close(); }

  fs.rmSync(f);
  const st2 = openStream(f, { rotated: true });
  try {
    await sleep(100);
    assert.ok(!st2.events().some((e) => e.event === 'missing'));
    assert.match(textOf(st2.events()), /old1-4/);
    fs.writeFileSync(f, 'born-0\n');
    await sleep(900);
    assert.match(textOf(st2.events()), /svc\.out\.log\.1，以下是接着的一份 -----\nborn-0\n$/);
  } finally { st2.close(); }

  // 项目自己的日志：不认 .1，现在这份没有就是「还不存在」
  const st3 = openStream(f + '.project', {});
  try { await sleep(100); assert.equal(st3.events()[0].event, 'missing'); } finally { st3.close(); }
});
