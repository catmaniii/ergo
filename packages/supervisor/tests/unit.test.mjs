import './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { psWrapForLog, cmdLineOf } from '../src/hooks.mjs';
import { bootPlan, loadBootList, saveBootList, autostartBlocked } from '../src/bootlist.mjs';
import { decodeBytes, lastLineEnd, readRange } from '../src/logs.mjs';
import { projectOf } from '../src/sentinel.mjs';
import { findCycles, topoLayers } from '../src/registry.mjs';
import { triCheck, probeService } from '../src/probe.mjs';
import { exposureCreatable, exposureErrors, exposedPort } from '../src/exposure.mjs';
import { confirmsDown, DOWN_CONFIRM_PROBES, stopPlan, FORCE_GRACE_MS } from '../src/supervisor.mjs';
import { stripTransient } from '../src/state.mjs';

const LOG = String.raw`C:\lsm\logs\web-tunnel.out.log`;

test('psWrapForLog：把 -File 形式改写成 PS 内部重定向（否则 detached 下输出全丢）', () => {
  const r = psWrapForLog(String.raw`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vps-tunnel.ps1`, LOG);
  assert.equal(r.wrapped, true);
  assert.match(r.cmd, /-Command "& 'scripts\\vps-tunnel\.ps1' \*>&1 \| Out-File -FilePath '/);
  assert.match(r.cmd, /-Encoding utf8 -Append"$/);   // 不给 utf8 的话 PS 5.1 写 UTF-16LE
  assert.match(r.cmd, /-NonInteractive/);            // 契约第 4 条：钩子不得等 stdin
});

test('psWrapForLog：带引号路径与额外参数都要原样保留', () => {
  const r = psWrapForLog(
    String.raw`powershell -NoProfile -ExecutionPolicy Bypass -File "E:\work\web_ui\启动服务.ps1" -Port 9000`,
    LOG,
  );
  assert.equal(r.wrapped, true);
  assert.match(r.cmd, /& 'E:\\work\\web_ui\\启动服务\.ps1' -Port 9000 \*>&1/);
});

test('psWrapForLog：非 PowerShell 命令原样放行（node 自己写句柄，detached 下也正常）', () => {
  const r = psWrapForLog('node scripts/restart-server.mjs', LOG);
  assert.equal(r.wrapped, false);
  assert.equal(r.cmd, 'node scripts/restart-server.mjs');
});

test('psWrapForLog：脚本路径里的单引号要转义，不能让它跳出 PS 字符串', () => {
  const r = psWrapForLog(String.raw`powershell -NoProfile -File C:\it's\a.ps1`, LOG);
  assert.match(r.cmd, /& 'C:\\it''s\\a\.ps1'/);
});

const mkServices = (spec) => new Map(Object.entries(spec).map(([id, deps]) => [id, {
  id, dependsOn: (deps || []).map((d) => (typeof d === 'string' ? { id: d, type: 'hard' } : d)),
}]));

test('循环依赖在加载期就被抓出来，不留到启动时死锁', () => {
  assert.equal(findCycles(mkServices({ a: ['b'], b: ['c'], c: [] })).length, 0);
  const cycles = findCycles(mkServices({ a: ['b'], b: ['a'] }));
  assert.equal(cycles.length >= 1, true);
});

test('拓扑分层：依赖在前，同层可并发', () => {
  const svcs = mkServices({ 'web-server': ['tts-engine'], 'tts-engine': [], 'web-tunnel': [] });
  const layers = topoLayers(svcs, ['web-server', 'web-tunnel']);
  assert.equal(layers[0].includes('tts-engine'), true);
  assert.equal(layers.at(-1).includes('web-server'), true);
  assert.equal(layers.flat().length, 3);   // 依赖会被自动拉进来
});

test('拓扑分层：只要了一个服务，它的依赖也必须被带上', () => {
  const svcs = mkServices({ a: ['b'], b: ['c'], c: [] });
  assert.deepEqual(topoLayers(svcs, ['a']).flat().sort(), ['a', 'b', 'c']);
});

const snap = (procs, ports) => ({
  procs: new Map(procs.map((p) => [p.pid, p])),
  ports: new Map(Object.entries(ports || {}).map(([k, v]) => [Number(k), v])),
});

test('三元校验：PID 被复用时必须判定为不匹配（只认 PID 会杀错进程）', () => {
  const st = { pid: 22452, pidStart: '2026-08-23T08:31:44.2659110+08:00' };
  const same = triCheck(st, snap([{ pid: 22452, start: st.pidStart, name: 'node.exe' }], { 8799: [22452] }), 8799);
  assert.equal(same.match, true);

  const reused = triCheck(st, snap([{ pid: 22452, start: '2026-08-23T09:00:00.0000000+08:00', name: 'python.exe' }], { 8799: [22452] }), 8799);
  assert.equal(reused.match, false);
  assert.match(reused.why, /复用/);
});

test('三元校验：端口的监听者换人了也算不匹配（孤儿）', () => {
  const st = { pid: 100, pidStart: 's' };
  const r = triCheck(st, snap([{ pid: 100, start: 's', name: 'node.exe' }], { 8799: [999] }), 8799);
  assert.equal(r.match, false);
  assert.match(r.why, /监听者不是/);
});

test('三元校验：进程没了就是没了', () => {
  const r = triCheck({ pid: 100, pidStart: 's' }, snap([], {}), 8799);
  assert.equal(r.match, false);
  assert.match(r.why, /已不存在/);
});

test('强制停止：忙着也不排队等空闲，最多给 10 秒收尾就杀；没有停机手段直接杀', () => {
  const hook = { timeoutMs: 30000, idleTimeoutMs: 3600000 };
  // 接入了、正忙的服务：卡片原来只给「等空闲再停」，长任务一跑几小时
  assert.deepEqual(stopPlan({ mode: 'when-idle', force: true, linked: true, hookStop: hook }), { mode: 'now', deadlineMs: FORCE_GRACE_MS });
  assert.deepEqual(stopPlan({ force: true, linked: false, hookStop: hook }), { mode: 'now', deadlineMs: FORCE_GRACE_MS });
  assert.deepEqual(stopPlan({ force: true, linked: true, hookStop: { timeoutMs: 3000 } }), { mode: 'now', deadlineMs: 3000 });
  assert.deepEqual(stopPlan({ force: true, linked: true }), { mode: 'now', deadlineMs: FORCE_GRACE_MS });
  assert.deepEqual(stopPlan({ force: true, linked: false }), { mode: 'now', deadlineMs: 0 });
});

test('不强制的停机：when-idle 忙多久等多久，now 按钩子的超时', () => {
  const hook = { timeoutMs: 30000, idleTimeoutMs: 7200000 };
  assert.deepEqual(stopPlan({ mode: 'when-idle', linked: true, hookStop: hook }), { mode: 'when-idle', deadlineMs: 7200000 });
  assert.deepEqual(stopPlan({ mode: 'when-idle', linked: true }), { mode: 'when-idle', deadlineMs: 3600000 });
  assert.deepEqual(stopPlan({ mode: 'now', linked: true, hookStop: hook }), { mode: 'now', deadlineMs: 30000 });
  assert.deepEqual(stopPlan({ linked: true }), { mode: 'now', deadlineMs: 60000 });
});

test('掉线判定：在跑的服务失败一次不算挂，连续两次才算', () => {
  const up = { before: 'RUNNING', desired: 'running' };
  assert.equal(confirmsDown({ ...up, failStreak: 1 }), false);   // 一次超时可能只是机器忙
  assert.equal(confirmsDown({ ...up, failStreak: 2 }), true);
  assert.equal(confirmsDown({ before: 'DEGRADED', desired: 'running', failStreak: 1 }), false);
});

test('掉线判定：本来就不在跑的不给宽限，多等一轮只会推迟真相', () => {
  for (const before of ['STOPPED', 'FAILED', 'STARTING']) {
    assert.equal(confirmsDown({ before, desired: 'running', failStreak: 1 }), true, before);
  }
});

test('掉线判定：目标就是停机时不给宽限——它本来就该消失', () => {
  assert.equal(confirmsDown({ before: 'RUNNING', desired: 'stopped', failStreak: 1 }), true);
});

test('掉线判定：failStreak 封顶后仍然判定为已挂（封顶不能把判定卡住）', () => {
  // 封顶值就是阈值本身，所以「>= 阈值」必须仍然成立——
  // 万一以后把封顶改小于阈值，服务就永远判不了挂，这条测试会先炸。
  assert.equal(confirmsDown({ before: 'RUNNING', desired: 'running', failStreak: DOWN_CONFIRM_PROBES }), true);
});

test('易失标志被剥掉：落盘的 autoRestarting 不得跨重启带过来', () => {
  // 这条守的是一次真实事故：闸落了盘，管理器在退避中途死掉，
  // 重启后读回 true，六条隧道的 autoRestart 永久失效（2026-09-03 实测）。
  const services = {
    'web-tunnel': { state: 'FAILED', desired: 'running', autoRestarting: true, retries: 1 },
    'dash-tunnel': { state: 'RUNNING', desired: 'running', autoRestarting: true },
  };
  stripTransient(services);
  for (const [id, st] of Object.entries(services)) {
    assert.equal('autoRestarting' in st, false, `${id} 的 autoRestarting 必须被剥掉`);
  }
  assert.equal(services['web-tunnel'].state, 'FAILED', '其余字段要原样保留');
  assert.equal(services['web-tunnel'].retries, 1);
});

// ---- process 档的身份校验（2026-10-05：blog 隧道被 svchost 冒名顶替） ----
const TUNNEL = { id: 'blog-tunnel', probe: { tier: 'process', matchCmd: String.raw`18797:127\.0\.0\.1:8797` } };
const procMap = (...list) => new Map(list.map((p) => [p.pid, p]));
const SVCHOST = { pid: 2344, name: 'svchost.exe', start: '2026-10-05T09:00:00.0000000+08:00', cmd: '' };
const SSH = { pid: 9000, name: 'ssh.exe', start: '2026-10-05T09:01:00.0000000+08:00',
  cmd: 'ssh -i k.pem -N -n -T -R 127.0.0.1:18797:127.0.0.1:8797 root@203.0.113.10' };

test('process 档：账本 PID 被别的进程复用时不能认——哪怕账本里的启动时间已经被毒化成一致', async () => {
  // 实测现场：重启后 2344 被 svchost 复用，第一轮误认时把 svchost 的启动时间写回了账本，
  // 所以只比启动时间永远抓不到；命令行对不上才是铁证。认错的后果是隧道永远「在跑」、autoRestart 永不触发。
  const st = { pid: 2344, pidStart: SVCHOST.start };
  const p = await probeService(TUNNEL, st, { procs: procMap(SVCHOST), allProcs: procMap(SVCHOST) });
  assert.equal(p.ok, false, '冒名的进程不能被当成隧道');
  assert.match(p.detail, /2344/, 'detail 要说清是哪个 PID 认错了');
});

test('process 档：账本 PID 认错时改按命令行找，找到真正的隧道', async () => {
  const st = { pid: 2344, pidStart: SVCHOST.start };
  const all = procMap(SVCHOST, SSH);
  const p = await probeService(TUNNEL, st, { procs: all, allProcs: all });
  assert.equal(p.ok, true);
  assert.equal(p.pid, 9000);
  assert.equal(p.pidStart, SSH.start, '写回账本的必须是真隧道的启动时间');
  assert.match(p.detail, /命令行匹配/);
});

test('process 档：没有 matchCmd 时靠启动时间识破 PID 复用', async () => {
  const svc = { id: 'guard', probe: { tier: 'process' } };
  const other = { pid: 500, name: 'chrome.exe', start: '2026-10-05T10:00:00Z', cmd: 'chrome.exe' };
  const p = await probeService(svc, { pid: 500, pidStart: '2026-10-01T08:00:00Z' }, { procs: procMap(other), allProcs: procMap(other) });
  assert.equal(p.ok, false);
});

test('process 档：账本 PID 命令行、启动时间都对得上就照常认（别把正常情况误伤了）', async () => {
  const p = await probeService(TUNNEL, { pid: 9000, pidStart: SSH.start }, { procs: procMap(SSH), allProcs: procMap(SSH) });
  assert.equal(p.ok, true);
  assert.equal(p.pid, 9000);
  assert.match(p.detail, /认自 账本/);
});

test('process 档：账本里还没有启动时间（刚 spawn 完）时只靠命令行判断', async () => {
  const p = await probeService(TUNNEL, { pid: 9000, pidStart: null }, { procs: procMap(SSH), allProcs: procMap(SSH) });
  assert.equal(p.ok, true);
});

// ---- 永不上公网（2026-10-05：tts-engine 卡片上不该有「开通公网」按钮） ----
const VPS = { host: 'root@203.0.113.10', key: 'k.pem' };

test('永不上公网：标了 exposure.never 的服务开通不了公网，理由原样给出', () => {
  const r = exposureCreatable({ id: 'tts-engine', probe: { port: 8090 }, exposure: { never: '本地 TTS 引擎，不是给人看的页面' } }, VPS);
  assert.equal(r.ok, false);
  assert.match(r.why, /本地 TTS 引擎/);
});

test('永不上公网：never 必须写明原因，且不能和 via 同时出现', () => {
  assert.equal(exposureErrors({ never: '' }).length, 1, '空原因不行');
  assert.equal(exposureErrors({ never: true }).length, 1, '布尔值不行——不写原因的禁令迟早被人删掉');
  assert.equal(exposureErrors({ never: '理由', via: 'x-tunnel' }).length, 1, '一边说永不上公网一边接了隧道，自相矛盾');
  assert.equal(exposureErrors({ never: '理由' }).length, 0);
  assert.equal(exposureErrors({ via: 'x-tunnel' }).length, 0);
  assert.equal(exposureErrors(null).length, 0);
});

test('对外端口：exposure.localPort 优先于探活端口（本机端口 8810 自动信任本机，对外只许 8811）', () => {
  assert.equal(exposedPort({ probe: { port: 8810 }, exposure: { via: 'chat-tunnel', localPort: 8811 } }), 8811);
  assert.equal(exposedPort({ probe: { port: 8797 } }), 8797);
  assert.equal(exposureErrors({ via: 'x', localPort: '8811' }).length, 1, '字符串不行');
  assert.equal(exposureErrors({ via: 'x', localPort: 8811 }).length, 0);
  assert.match(exposureCreatable({ id: 's', probe: { port: 8810 }, exposure: { localPort: 8811 } }, VPS).why, /exposure 段已经存在/,
    '只写了 localPort 还没接隧道：自动追加会写出第二个 exposure 键，必须拒绝');
});

test('开通公网的原有条件不变：有端口、还没暴露、配了 VPS', () => {
  const base = { id: 's', probe: { port: 8000 } };
  assert.equal(exposureCreatable(base, VPS).ok, true);
  assert.match(exposureCreatable({ ...base, probe: {} }, VPS).why, /没有端口/);
  assert.match(exposureCreatable({ ...base, exposure: { via: 's-tunnel' } }, VPS).why, /已经有公网入口/);
  assert.match(exposureCreatable(base, {}).why, /vps\.host/);
});

// ---- 零窗口：服务一律经 cmd 的 >> 写日志，stdio 全 ignore（2026-10-08 实测） ----
test('argv 拼成 cmd 命令行：每个参数加引号，路径末尾的反斜杠成对', () => {
  assert.equal(cmdLineOf(['ssh', '-R', '127.0.0.1:18081:127.0.0.1:8787', 'root@h']),
    '"ssh" "-R" "127.0.0.1:18081:127.0.0.1:8787" "root@h"');
  // 不成对的话 "C:\dir\" 里的 \" 会被目标程序当成转义的引号，后面的参数全粘在一起
  assert.equal(cmdLineOf(['x', String.raw`C:\dir\ `.trim()]), String.raw`"x" "C:\dir\\"`);
  // 引号里 cmd 仍然认 & | > 之外的 % ——这些字符原样保留是安全的
  assert.equal(cmdLineOf(['node', '-e', "setTimeout(()=>{}, 1) & echo x"]), `"node" "-e" "setTimeout(()=>{}, 1) & echo x"`);
});

test('argv 里有 " 或 % 直接拒绝，不悄悄改写（cmd 会展开 %VAR%、" 会打断引号）', () => {
  assert.throws(() => cmdLineOf(['node', '-e', 'console.log("x")']), /不能有/);
  assert.throws(() => cmdLineOf(['echo', '%PATH%']), /不能有/);
});

// ---- 开机自启 ----
const SVCS = new Map([
  ['ide-hub', { id: 'ide-hub', kind: 'managed', capabilities: ['start'] }],
  ['ext-webui', { id: 'ext-webui', kind: 'external', capabilities: [] }],
  ['guard', { id: 'guard', kind: 'managed', capabilities: [] }],
]);

test('开机判定：登录会话变了才算开机；管理器自己重启（会话没变）不算', () => {
  const list = new Set(['ide-hub']);
  assert.equal(bootPlan({ prevEpoch: 'A', epoch: 'A', bootList: list, services: SVCS }).fresh, false);
  const p = bootPlan({ prevEpoch: 'A', epoch: 'B', bootList: list, services: SVCS });
  assert.equal(p.fresh, true);
  assert.deepEqual(p.start, ['ide-hub']);
});

test('开机判定：读不到会话时间、或第一次记录时，一律不当开机（宁可不自启，不能把手动起的服务清掉）', () => {
  const list = new Set(['ide-hub']);
  assert.equal(bootPlan({ prevEpoch: null, epoch: 'B', bootList: list, services: SVCS }).fresh, false);
  assert.equal(bootPlan({ prevEpoch: 'A', epoch: null, bootList: list, services: SVCS }).fresh, false);
});

test('开机自启：外部服务、没有 start 能力的、注册表里已经没有的，不会被拉', () => {
  const p = bootPlan({ prevEpoch: 'A', epoch: 'B', bootList: new Set(['ide-hub', 'ext-webui', 'guard', 'gone']), services: SVCS });
  assert.deepEqual(p.start, ['ide-hub']);
  assert.match(autostartBlocked(SVCS.get('ext-webui')), /外部服务/);
  assert.match(autostartBlocked(SVCS.get('guard')), /start/);
  assert.equal(autostartBlocked(SVCS.get('ide-hub')), null);
});

test('开机自启列表：写了能原样读回；文件坏了要报错，不能当成空列表（否则下次保存会覆盖你手改的内容）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-boot-'));
  const f = path.join(dir, 'autostart.yaml');
  assert.deepEqual([...loadBootList(f).ids], [], '文件不存在 = 空列表');
  saveBootList(new Set(['ide-tunnel', 'ide-hub']), f);
  assert.deepEqual([...loadBootList(f).ids], ['ide-hub', 'ide-tunnel']);
  saveBootList(new Set(), f);
  assert.deepEqual([...loadBootList(f).ids], []);
  fs.writeFileSync(f, 'services: [unclosed');
  const bad = loadBootList(f);
  assert.ok(bad.error, '解析失败必须报出来');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- 日志页 ----
test('日志解码：同一个文件里 UTF-8 行和 GBK 行混着来（node 写 UTF-8，PowerShell 重定向写 GBK）', () => {
  const utf8 = Buffer.from('node 说：中文\n', 'utf-8');
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);   // 「中文\n」的 GBK
  assert.equal(decodeBytes(Buffer.concat([utf8, gbk]), 'auto'), 'node 说：中文\n中文\n');
});

test('日志只按整行推进：最后一个换行之后的半行留着，UTF-16 的换行要在偶数位上认', () => {
  assert.equal(lastLineEnd(Buffer.from('a\nbc\nd'), 'auto'), 5);
  assert.equal(lastLineEnd(Buffer.from('no newline'), 'auto'), 0);
  const u16 = Buffer.from('a\nb', 'utf16le');
  assert.equal(lastLineEnd(u16, 'utf16le'), 4);
});

test('往前翻日志：从文件中间取一段时丢掉开头那半行，拼回去不会出现残行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-log-'));
  const f = path.join(dir, 'x.log');
  fs.writeFileSync(f, 'line-1\nline-2\nline-3\n');
  const r = readRange(f, 3, 21);            // 从 "e-1\n" 中间开始
  assert.equal(r.text, 'line-2\nline-3\n');
  assert.equal(r.start, 7);
  assert.equal(readRange(f, 0, 7).text, 'line-1\n', '从文件头开始就不丢');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('日志脱敏照旧：往前翻读出来的内容也过一遍', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-log-'));
  const f = path.join(dir, 'x.log');
  fs.writeFileSync(f, 'apiKey=abcd1234secret\n');
  assert.doesNotMatch(readRange(f, 0, 100).text, /abcd1234secret/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('process 档：认到的是管理器套的那层 cmd 时，往下认到真正的 ssh', async () => {
  const CMD = { pid: 8000, ppid: 1, name: 'cmd.exe', start: '2026-10-08T14:00:00Z',
    cmd: 'cmd.exe /d /s /c ""ssh" "-R" "127.0.0.1:18797:127.0.0.1:8797" "root@h" >> "x.log" 2>&1"' };
  const SSH2 = { ...SSH, ppid: 8000 };
  const all = procMap(CMD, SSH2);
  const p = await probeService(TUNNEL, { pid: 8000, pidStart: CMD.start }, { procs: all, allProcs: all });
  assert.equal(p.ok, true);
  assert.equal(p.pid, 9000);
  assert.match(p.detail, /ssh\.exe \(9000\)/);
});

// ---- 哨兵：未纳管的端口按项目归组（一个项目的测试 worker 能占十几个端口） ----
test('哨兵归组：从命令行里认出是代码根目录下的哪个项目，正反斜杠都认', () => {
  const roots = [String.raw`c:\dev\projects`, String.raw`e:\work`];
  assert.equal(projectOf(String.raw`C:\x\node.exe --require C:/dev/projects/chat_app/.claude/w.cjs`, roots), 'chat_app');
  assert.equal(projectOf(String.raw`python E:\work\tools\web_ui\a.py`, roots), 'tools');
  assert.equal(projectOf(String.raw`node C:\other\x.js`, roots), null);
});

// ---- Tailnet 入口 ----
import * as tn from '../src/tailnet.mjs';

const TCFG = { domain: 'tail.example.com', gateway: 'tailnet-gateway' };

test('tailnet 清单：写了再读回来一样；不存在 = 空；坏文件报错而不是当成空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-tn-'));
  const f = path.join(dir, 'tailnet.yaml');
  assert.equal(tn.loadTailnetList(f).entries.size, 0);
  tn.saveTailnetList(new Map([['chat-daemon', { name: 'chat' }], ['blog-web', { name: 'blog' }]]), f);
  const back = tn.loadTailnetList(f);
  assert.equal(back.error, null);
  assert.deepEqual([...back.entries], [['blog-web', { name: 'blog' }], ['chat-daemon', { name: 'chat' }]]);
  tn.saveTailnetList(new Map(), f);
  assert.equal(tn.loadTailnetList(f).entries.size, 0);
  fs.writeFileSync(f, 'entries: [1, 2');
  assert.match(tn.loadTailnetList(f).error, /解析失败/);
  fs.writeFileSync(f, 'entries:\n  - id: x\n');
  assert.match(tn.loadTailnetList(f).error, /id 和 name/);
});

test('tailnet 入口连的是对外端口：连 8811，不是自动信任本机的 8810', () => {
  const services = new Map([['chat-daemon', { id: 'chat-daemon', probe: { port: 8810 }, exposure: { via: 'chat-tunnel', localPort: 8811 } }]]);
  const [r] = tn.routesFor(new Map([['chat-daemon', { name: 'chat' }]]), services, TCFG);
  assert.equal(r.host, 'chat.tail.example.com');
  assert.equal(r.port, 8811);
  assert.match(r.cert, /chat\.tail\.example\.com[\\/]fullchain\.pem$/);
});

test('tailnet 清单自检：不存在的服务、重名、非法名字、标了 never 的都报出来', () => {
  const services = new Map([
    ['a', { id: 'a', probe: { port: 1 } }], ['b', { id: 'b', probe: { port: 2 } }],
    ['tts', { id: 'tts', probe: { port: 3 }, exposure: { never: '本地 TTS' } }],
    ['tailnet-gateway', { id: 'tailnet-gateway', probe: { port: 8445 } }],
  ]);
  const errs = tn.tailnetListErrors(new Map([['a', { name: 'x' }], ['b', { name: 'x' }], ['ghost', { name: 'g' }], ['tts', { name: 'Bad_Name' }]]), services, TCFG);
  assert.ok(errs.some((e) => /ghost.*不存在/.test(e)));
  assert.ok(errs.some((e) => /同一个 name "x"/.test(e)));
  assert.ok(errs.some((e) => /Bad_Name.*不是合法/.test(e)));
  assert.ok(errs.some((e) => /never/.test(e)));
  assert.deepEqual(tn.tailnetListErrors(new Map([['a', { name: 'x' }]]), services, TCFG), []);
});

test('tailnet 能不能开：never、外部服务、没端口、没配 tailnet / VPS 都挡住', () => {
  const vps = { host: 'root@h', key: 'k' };
  assert.equal(tn.tailnetCreatable({ id: 's', probe: { port: 1 } }, TCFG, vps).ok, true);
  assert.match(tn.tailnetCreatable({ id: 's', probe: { port: 1 }, exposure: { never: '本地 TTS' } }, TCFG, vps).why, /永不对外：本地 TTS/);
  assert.match(tn.tailnetCreatable({ id: 's', kind: 'external', probe: { port: 1 } }, TCFG, vps).why, /外部服务/);
  assert.match(tn.tailnetCreatable({ id: 's', probe: {} }, TCFG, vps).why, /没有端口/);
  assert.match(tn.tailnetCreatable({ id: 's', probe: { port: 1 } }, null, vps).why, /tailnet\.domain/);
  assert.match(tn.tailnetCreatable({ id: 's', probe: { port: 1 } }, TCFG, {}).why, /vps/);
});

test('headscale DNS 记录：只动 <domain> 底下的，别人的原样保留；拿不到本机 IP 时沿用旧值', () => {
  const D = TCFG.domain;
  const existing = [
    { name: 'nas.home.arpa', type: 'A', value: '100.64.0.9' },
    { name: `old.${D}`, type: 'A', value: '100.64.0.1' },
    { name: `chat.${D}`, type: 'A', value: '100.64.0.7' },
  ];
  assert.deepEqual(tn.mergeRecords(existing, [`chat.${D}`], '100.64.0.1', D), [
    { name: 'nas.home.arpa', type: 'A', value: '100.64.0.9' },
    { name: `chat.${D}`, type: 'A', value: '100.64.0.1' },
  ]);
  assert.deepEqual(tn.mergeRecords(existing, [`chat.${D}`], null, D).at(-1), { name: `chat.${D}`, type: 'A', value: '100.64.0.7' });
  assert.deepEqual(tn.mergeRecords(existing, [], '100.64.0.1', D), [{ name: 'nas.home.arpa', type: 'A', value: '100.64.0.9' }]);
});

test('tailnet 杂项：serve 配置解析、默认名字沿用公网地址的第一段', () => {
  assert.equal(tn.serveTarget({ TCP: { 443: { TCPForward: '127.0.0.1:8445' } } }), '127.0.0.1:8445');
  assert.equal(tn.serveTarget({}), null);
  assert.equal(tn.serveTarget(null), null);
  assert.equal(tn.defaultName({ id: 'chat-daemon', exposure: { publicUrl: 'https://chat.example.com/' } }), 'chat');
  assert.equal(tn.defaultName({ id: 'Blog-Web' }), 'blog-web');
});

// ---- 还在不在跑：只看进程和端口，不看健康检查（2026-10-18：健康检查不过的服务 stop 秒报「已停」，进程其实还在听端口）
import { runningEvidence } from '../src/supervisor.mjs';

const HSVC = { id: 'web', probe: { tier: 'health', port: 8799, health: { url: 'http://127.0.0.1:8799/health' } } };
const NODE = { pid: 4242, ppid: 1, name: 'node.exe', start: '2026-10-18T08:00:00Z', cmd: 'node server.mjs' };

test('还在不在跑：健康检查不过、端口还在听 = 还在跑（原来这里被当成已停）', () => {
  // 探活结果是 ok:false（/health 回 500），但那只说明它不健康，不说明它停了
  const ev = runningEvidence(HSVC, { pid: null }, snap([NODE], { 8799: [4242] }), { probe: { ok: false, detail: 'HTTP 500' } });
  assert.equal(ev.running, true);
  assert.deepEqual(ev.pids, [4242], '兜底强杀要收拾的就是端口上的监听者——账本里的 PID 早被探活清掉了');
  assert.match(ev.why, /端口 8799 还有人在听/);
});

test('还在不在跑：端口空了、账本里的进程（启动时间对得上）还在 = 还在跑；PID 被复用了不算', () => {
  const st = { pid: 4242, pidStart: NODE.start };
  assert.equal(runningEvidence(HSVC, st, snap([NODE], {})).running, true, '比如刚起来还没监听，或者正在收尾、端口已经放了');
  const reused = { ...NODE, name: 'chrome.exe', start: '2026-10-18T09:00:00Z' };
  assert.equal(runningEvidence(HSVC, st, snap([reused], {})).running, false, 'PID 被别的进程复用了：那不是它，兜底强杀绝不能碰');
  assert.equal(runningEvidence(HSVC, st, snap([], {})).running, false);
});

test('还在不在跑：账本里还没有启动时间时，命令行里得有它自己的日志路径才认（刚 spawn 完的 cmd 包装层）', () => {
  const LOGF = String.raw`D:\lsm\logs\web.out.log`;
  const wrapper = { pid: 5000, ppid: 1, name: 'cmd.exe', start: 's', cmd: String.raw`cmd.exe /d /s /c ""node" "server.mjs" >> "D:\lsm\logs\web.out.log" 2>&1"` };
  assert.equal(runningEvidence(HSVC, { pid: 5000, pidStart: null }, snap([wrapper], {}), { outLog: LOGF }).running, true);
  const stranger = { ...wrapper, name: 'notepad.exe', cmd: 'notepad.exe' };
  assert.equal(runningEvidence(HSVC, { pid: 5000, pidStart: null }, snap([stranger], {}), { outLog: LOGF }).running, false,
    '只凭「这个 PID 上有进程」就认，PID 复用后会杀错人');
});

test('还在不在跑：接入层连接还在就是还在；没端口的 process 档看 probe 认没认到进程', () => {
  assert.equal(runningEvidence(HSVC, {}, snap([], {}), { link: { connected: true, pid: 77 } }).running, true);
  assert.deepEqual(runningEvidence(HSVC, {}, snap([], {}), { link: { connected: true, pid: 77 } }).pids, [77]);
  const tunnel = { id: 't', probe: { tier: 'process', matchCmd: 'ssh' } };
  assert.equal(runningEvidence(tunnel, {}, snap([], {}), { probe: { ok: true, pid: 9000, detail: 'ssh.exe (9000) 在跑' } }).running, true);
  assert.equal(runningEvidence(tunnel, {}, snap([], {}), { probe: { ok: false } }).running, false);
  assert.equal(runningEvidence(HSVC, { pid: null }, snap([], {})).running, false, '什么证据都没有才算停了');
});
