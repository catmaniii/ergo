// 日志切分端到端：管理器真的拉起一个往 stdout 狂写的假服务（输出经 cmd 的 `>> logs/<id>.out.log` 直接写进文件），
// 它跑着时日志超了上限也切不了（文件被它的 cmd 占着），巡检只在管理器日志里记一笔；重启时在新的 cmd 打开之前切开，
// 只留 keep 份；看日志（tail、manage.logs、日志页的流）读得到最新的内容，刚切过时接得上 .1 的尾巴。
//
// 安全措施：注册表、账本、日志都在临时目录（LSM_DATA_DIR）；端口是临时挑的空闲端口，不碰 7420 / 8810 / 8811 等；
// autoResolveConflicts、哨兵关掉；收尾按命令行里的临时目录认这个文件起的进程，杀进程树（不按 PID、不按名字）。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-logrotate-'));
process.env.LSM_DATA_DIR = DATA;
process.env.LSM_QUIET = '1';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const [MGR, SPEW_PORT] = await Promise.all([1, 2].map(freePort));
assert.ok(![MGR, SPEW_PORT].some((p) => [7420, 8810, 8811, 8090, 8091, 47823, 47890, 47895, 8785].includes(p)));

const LIMIT_MB = 0.05;                 // ≈ 51 KB：假服务一启动就写 120 KB，每一轮都超
const REG = path.join(DATA, 'registry');
const APP = path.join(DATA, 'app');
fs.mkdirSync(path.join(REG, 'services'), { recursive: true });
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(REG, 'manager.yaml'), [
  'bind: 127.0.0.1', `port: ${MGR}`, 'probeIntervalMs: 5000', 'autoResolveConflicts: false',
  'sentinels:', '  port: false', '  scheduledTask: false',
  'logs:', `  maxMB: ${LIMIT_MB}`, '  keep: 2', '',
].join('\n'));

// 狂写的假服务：一起来先写 120 KB，之后每 50 毫秒一行；/mark?t=xxx 往 stdout 写一行「MARK xxx」，回它写到第几行了
fs.writeFileSync(path.join(APP, 'spew.mjs'), [
  "import http from 'node:http';",
  'let i = 0;',
  "const line = () => `spew ${process.pid} ${i++} ${'x'.repeat(200)}\\n`;",
  'let n = 0; while (n < 120 * 1024) { const s = line(); process.stdout.write(s); n += s.length; }',
  'setInterval(() => process.stdout.write(line()), 50);',
  'http.createServer((req, res) => {',
  "  const u = new URL(req.url, 'http://x');",
  "  if (u.pathname === '/mark') process.stdout.write(`MARK ${u.searchParams.get('t')}\\n`);",
  '  res.end(String(i));',
  "}).listen(Number(process.env.PORT), '127.0.0.1');",
  '',
].join('\n'));
fs.writeFileSync(path.join(REG, 'services', 'spew.yaml'), [
  'id: spew', `root: ${JSON.stringify(APP)}`, 'kind: managed',
  'probe:', '  tier: port', `  port: ${SPEW_PORT}`,
  // 脚本写绝对路径：收尾时按命令行里有没有这个临时目录认自己起的进程
  'hooks:', '  start:', '    argv:', `      - ${JSON.stringify(process.execPath)}`, `      - ${JSON.stringify(path.join(APP, 'spew.mjs'))}`, '    detaches: false', '    readyTimeoutMs: 20000',
  'env:', '  - name: PORT', '    from: literal', `    value: "${SPEW_PORT}"`, '',
].join('\n'));

const { Supervisor } = await import('../src/supervisor.mjs');
const { createManage } = await import('../src/manage.mjs');
const { tail, logEntries, streamLog } = await import('../src/logs.mjs');
const { rotatedFile } = await import('../src/rotate.mjs');
const { killTree, allProcesses } = await import('../src/winproc.mjs');
const { MANAGER_LOG } = await import('../src/paths.mjs');

const sup = new Supervisor();
assert.deepEqual(sup.registryErrors, []);
const OUT = sup.outLog('spew');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = async (t) => (await fetch(`http://127.0.0.1:${SPEW_PORT}/mark?t=${t}`, { signal: AbortSignal.timeout(10000) })).text();
const existing = () => [0, 1, 2, 3, 4].filter((n) => fs.existsSync(n ? rotatedFile(OUT, n) : OUT));
const managerLog = () => { try { return fs.readFileSync(MANAGER_LOG, 'utf-8'); } catch { return ''; } };
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(200); }
}
async function restart() {
  const s = await sup.stop('spew', { force: true });
  assert.equal(s.ok, true, s.why);
  const r = await sup.start('spew');
  assert.equal(r.ok, true, r.why);
}

test.after(async () => {
  const mine = [...(await allProcesses())].filter(([, p]) => (p.cmd || '').toLowerCase().includes(APP.toLowerCase())).map(([pid]) => pid);
  for (const pid of mine) await killTree(pid);
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

test('manager.yaml 的 logs 生效', () => {
  assert.deepEqual(sup.logRotation, { maxBytes: Math.round(LIMIT_MB * 1048576), keep: 2 });
});

test('跑着的服务：日志超了上限也切不了（被它的 cmd 占着），巡检只在管理器日志里记一笔，等它下次启动', async () => {
  const r = await sup.start('spew');
  assert.equal(r.ok, true, r.why);
  assert.ok(await until(() => fs.existsSync(OUT) && fs.statSync(OUT).size > 120 * 1024), '假服务写出了 120 KB');
  sup.rotateLogs();
  sup.rotateLogs();
  assert.deepEqual(existing(), [0], '没切');
  const noted = managerLog().split('\n').filter((l) => l.includes('spew 的命令行输出') && l.includes('下次启动时切'));
  assert.equal(noted.length, 1, '只记一笔');
  // 跑着的时候看日志：最新的内容在
  await mark('while-running');
  assert.ok(await until(() => tail(OUT, { lines: 30, rotated: true }).lines.includes('MARK while-running')));
});

test('重启：新的 cmd 打开之前切开——上一轮的输出整份在 .1，新的一份从启动标记开始；读日志接得上 .1 的尾巴', async () => {
  await mark('last-words');
  await sleep(200);
  await restart();
  assert.deepEqual(existing(), [0, 1]);
  const old = fs.readFileSync(rotatedFile(OUT, 1), 'utf-8');
  assert.match(old, /MARK while-running/);
  assert.match(old, /MARK last-words/, '上一轮最后写的也在 .1 里');
  assert.match(fs.readFileSync(OUT, 'utf-8'), /^\n===== lsm 启动 spew @/);
  assert.match(managerLog(), /spew 的命令行输出到了 \d+ KB，超过上限 51 KB，切开了：旧的现在是 spew\.out\.log\.1，留最近 2 份/);

  // 新的一份很短的时候（刚起来）：tail 接上 .1 的尾巴，中间标一行
  const t = tail(OUT, { lines: 100000, maxBytes: 4 * 1048576, rotated: true }).lines;
  // .1 自己也是从上一轮的启动标记开始的，所以新的一份的启动标记是最后一个
  const a = t.indexOf('MARK last-words'), b = t.indexOf('日志在这里切开过：以上在 spew.out.log.1'), c = t.lastIndexOf('===== lsm 启动 spew');
  assert.ok(a >= 0 && a < b && b < c, `顺序：上一轮的尾巴、切开标记、新的一份（${[a, b, c]}）`);
});

test('再重启：切下来的有了 2 份（下一条再切时最老的删掉）；manage.logs 读到最新的', async () => {
  await restart();
  assert.deepEqual(existing(), [0, 1, 2]);
  await mark('newest');
  const manage = createManage(sup);
  const r = await until(async () => {
    const x = await manage.request('spew', { type: 'manage.logs', id: 1, name: 'spew', lines: 20 });
    return x.ok && x.lines.includes('MARK newest') ? x : null;
  });
  assert.ok(r, '经接入层的看日志读到了最新那行');
  assert.equal(r.label, '命令行输出');
  assert.equal(logEntries(sup, sup.services.get('spew'))[0].rotated, true);
});

test('日志页的流开着时重启：发 rotated、不清屏，上一轮剩下的推完、标一行，接着推新的一份', async () => {
  const req = new EventEmitter();
  let raw = '';
  const res = { writeHead() {}, write(s) { raw += s; }, on() {} };
  streamLog(req, res, () => OUT, { rotated: true });
  const events = () => raw.split('\n\n').map((b) => {
    const ev = {};
    for (const l of b.split('\n')) {
      if (l.startsWith('event: ')) ev.event = l.slice(7);
      else if (l.startsWith('data: ')) ev.data = JSON.parse(l.slice(6));
    }
    return ev;
  }).filter((e) => e.event);
  try {
    await sleep(300);
    const meta = events()[0];
    assert.equal(meta.event, 'meta');
    assert.ok(meta.data.earliest < 0, '还留着切下来的旧日志，能往前翻');
    await mark('before-restart');
    await restart();
    await mark('after-restart');
    const got = await until(() => {
      const evs = events();
      const text = evs.filter((e) => e.event === 'chunk').map((e) => e.data.text).join('');
      return text.includes('MARK after-restart') ? { evs, text } : null;
    });
    assert.ok(got, '流里读到了重启后的新内容');
    assert.ok(got.evs.some((e) => e.event === 'rotated'), '发了 rotated');
    assert.ok(!got.evs.some((e) => e.event === 'reset' || e.event === 'missing'), '没清屏、没报不存在');
    const { text } = got;
    const a = text.indexOf('MARK before-restart'), b = text.lastIndexOf('日志在这里切开过：以上在 spew.out.log.1'), c = text.lastIndexOf('===== lsm 启动 spew'), d = text.indexOf('MARK after-restart');
    assert.ok(a >= 0 && a < b && b < c && c < d, `顺序不对：${[a, b, c, d]}`);
    assert.equal(text.split('MARK before-restart').length, 2, '不重复');
  } finally {
    req.emit('close');
  }
  assert.deepEqual(existing(), [0, 1, 2], '切了第三次，还是只留 keep（2）份');
});
