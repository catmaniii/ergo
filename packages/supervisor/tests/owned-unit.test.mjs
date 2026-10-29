// 名下的服务：命名空间、定义校验、YAML 生成、端口冲突、注册表加载 owned/ 目录。全部离线，不起进程。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 注册表、账本、日志挪进临时目录：绝不碰本机正在用的 registry/ 和 state.json
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-owned-unit-'));
process.env.LSM_DATA_DIR = DATA;
process.env.LSM_QUIET = '1';
const { resolveName, definitionErrors, buildRaw, sameDefinition, portHolder, wireReply } = await import('../src/owned.mjs');
const { loadServices } = await import('../src/registry.mjs');
const { probeService } = await import('../src/probe.mjs');

test.after(() => { fs.rmSync(DATA, { recursive: true, force: true }); });

const CWD = DATA;   // 存在的绝对路径
const GOOD = { name: 'web', cwd: CWD, command: 'node server.mjs', port: 18899 };

test('命名空间：短名和全名都认；带 -- 却不是自己的前缀 = 想碰别人的服务，拒', () => {
  assert.deepEqual(resolveName('ergo-daemon', 'p-1-web'), { ok: true, name: 'p-1-web', id: 'ergo-daemon--p-1-web' });
  assert.equal(resolveName('ergo-daemon', 'ergo-daemon--p-1-web').id, 'ergo-daemon--p-1-web');
  assert.equal(resolveName('ergo-daemon', 'other--x').code, 'not-owner');
  assert.equal(resolveName('ergo-daemon', 'other-app--x').code, 'not-owner');
  // 不带 -- 的名字只会落进自己的命名空间：web-server 解析成 ergo-daemon--web-server，碰不到手写的 web-server
  assert.equal(resolveName('ergo-daemon', 'web-server').id, 'ergo-daemon--web-server');
  for (const bad of ['Web', '-x', 'x-', 'a b', 'x'.repeat(49), '中文']) assert.equal(resolveName('o', bad).code, 'invalid', bad);
  assert.equal(resolveName('o', '').code, 'bad-request');
  assert.equal(resolveName('o', 42).code, 'bad-request');
});

test('定义校验：合规的定义一条错都没有', () => {
  assert.deepEqual(definitionErrors(GOOD), []);
  assert.deepEqual(definitionErrors({ ...GOOD, command: undefined, argv: ['node', 'server.mjs'], health: { path: '/health', timeoutMs: 2000 },
    env: [{ name: 'PORT', from: 'literal', value: 18899 }, { name: 'API_KEY', from: 'file', path: '.secrets/k.txt' }, { name: 'HOME_X', from: 'userEnv', optional: true }],
    autostart: true, autoRestart: false, link: false, readyTimeoutMs: 30000, stop: { command: 'node stop.mjs' }, title: '示例站点', project: 'p-1',
    logs: [{ path: 'tmp/a.log', label: 'a' }] }), []);
});

test('定义校验：缺字段、写错类型、不认识的字段都逐条报出来', () => {
  const errs = definitionErrors({ name: 'web', port: 70000, healthcheck: '/h' });
  assert.ok(errs.some((e) => /不认识的字段 "healthcheck"/.test(e)), '拼错的字段不能被悄悄忽略');
  assert.ok(errs.some((e) => /command（字符串）和 argv/.test(e)));
  assert.ok(errs.some((e) => /缺少 cwd/.test(e)));
  assert.ok(errs.some((e) => /port 必须是 1–65535/.test(e)));
  assert.ok(definitionErrors({ ...GOOD, argv: ['x'] }).some((e) => /只给一个/.test(e)), 'command 和 argv 不能同时给');
  assert.ok(definitionErrors({ ...GOOD, cwd: 'relative\\dir' }).some((e) => /绝对路径/.test(e)));
  assert.ok(definitionErrors({ ...GOOD, cwd: path.join(DATA, 'nope') }).some((e) => /不存在/.test(e)));
  assert.ok(definitionErrors({ ...GOOD, command: undefined, argv: ['echo', '%PATH%'] }).some((e) => /不能有 " %/.test(e)));
  assert.ok(definitionErrors({ ...GOOD, health: { path: 'health' } }).some((e) => /以 \/ 开头/.test(e)));
  assert.ok(definitionErrors({ ...GOOD, health: { url: 'http://evil/' } }).some((e) => /health 里不认识的字段 "url"/.test(e)),
    '健康检查只给路径，管理器只打 127.0.0.1:<port>，不替人去敲别的地址');
  assert.ok(definitionErrors({ ...GOOD, autostart: 'yes' }).some((e) => /autostart 必须是 true/.test(e)));
  assert.ok(definitionErrors({ ...GOOD, port: 7420 }, { managerPort: 7420 }).some((e) => /管理器自己的端口/.test(e)));
  assert.deepEqual(definitionErrors(null), ['service 必须是一个对象']);
});

test('定义校验：密钥不许用 literal 写进注册表；LSM_ 变量是管理器注入的，不许自己写', () => {
  const env = (e) => definitionErrors({ ...GOOD, env: [e] });
  assert.ok(env({ name: 'OPENAI_API_KEY', from: 'literal', value: 'sk-xxx' }).some((e) => /看名字是密钥/.test(e)));
  assert.ok(env({ name: 'NODE_AUTH_TOKEN', from: 'literal', value: 'x' }).some((e) => /看名字是密钥/.test(e)));
  assert.ok(env({ name: 'DB_PASSWORD', from: 'literal', value: 'x' }).some((e) => /看名字是密钥/.test(e)));
  assert.deepEqual(env({ name: 'TOKENIZERS_PARALLELISM', from: 'literal', value: 'false' }), [], '按下划线分段认，别误伤');
  assert.deepEqual(env({ name: 'OPENAI_API_KEY', from: 'file', path: '.secrets/openai.txt' }), [], '密钥从文件来就行');
  assert.ok(env({ name: 'LSM_TOKEN', from: 'literal', value: 'x' }).some((e) => /管理器注入/.test(e)));
  assert.ok(definitionErrors({ ...GOOD, env: [{ name: 'A', from: 'literal', value: '1' }, { name: 'a', from: 'literal', value: '2' }] }).some((e) => /重复/.test(e)),
    'Windows 的环境变量不分大小写');
  assert.ok(env({ name: 'X', from: 'file' }).some((e) => /必须给 path/.test(e)));
  assert.ok(env({ name: 'X', from: 'env' }).some((e) => /from 必须是/.test(e)));
});

test('生成的注册表声明：档位跟着定义走，管理器自己 spawn，公网入口默认不开', () => {
  const raw = buildRaw('ergo-daemon', 'web', { ...GOOD, health: { path: '/health' }, title: '示例站点' }, { ownerProject: 'ergo', now: 'T1' });
  assert.equal(raw.id, 'ergo-daemon--web');
  assert.equal(raw.owner, 'ergo-daemon');
  assert.equal(raw.name, '示例站点');
  assert.equal(raw.project, 'ergo');
  assert.equal(raw.root, CWD);
  assert.deepEqual(raw.probe, { tier: 'health', port: 18899, health: { url: 'http://127.0.0.1:18899/health', timeoutMs: 3000 } });
  assert.equal(raw.hooks.start.detaches, false, '管理器自己 spawn：零窗口、管理器重启时照跑');
  assert.equal(raw.hooks.stop, undefined, '没给停机命令就没有 stop 能力（不替它伪造）');
  assert.equal(raw.exposure, undefined, '公网入口默认不开');
  assert.deepEqual(raw.autoRestart, { enabled: false }, '默认不自动重启');
  assert.equal(buildRaw('o', 'w', GOOD).probe.tier, 'port');
  assert.equal(buildRaw('o', 'w', { ...GOOD, link: true, health: { path: '/h' } }).probe.tier, 'linked');
  assert.deepEqual(buildRaw('o', 'w', { ...GOOD, command: undefined, argv: ['node', 'a.mjs'] }).hooks.start.argv, ['node', 'a.mjs']);
  assert.deepEqual(buildRaw('o', 'w', { ...GOOD, env: [{ name: 'PORT', from: 'literal', value: 18899 }] }).env, [{ name: 'PORT', from: 'literal', value: '18899' }]);
});

test('更新：登记时间不变；你在 WebUI 上开的公网入口照留；只有时间不同算「没变」', () => {
  const prev = { ...buildRaw('o', 'w', GOOD, { now: 'T1' }), exposure: { via: 'o--w-tunnel', remotePort: 28899 } };
  const next = buildRaw('o', 'w', GOOD, { prevRaw: prev, now: 'T2' });
  assert.equal(next.registeredAt, 'T1');
  assert.equal(next.updatedAt, 'T2');
  assert.deepEqual(next.exposure, prev.exposure);
  assert.equal(sameDefinition(prev, next), true, '同一份定义反复发，不重写注册表');
  assert.equal(sameDefinition(prev, buildRaw('o', 'w', { ...GOOD, port: 18900 }, { prevRaw: prev })), false);
});

test('端口冲突：探活端口、附属端口、对外端口都算已登记；自己更新自己不算', () => {
  const services = new Map([
    ['web-server', { id: 'web-server', probe: { port: 8799, extraPorts: [8800] } }],
    ['chat-daemon', { id: 'chat-daemon', probe: { port: 8810 }, exposure: { localPort: 8811 } }],
    ['o--w', { id: 'o--w', probe: { port: 18899 } }],
  ]);
  assert.equal(portHolder(services, 8799).id, 'web-server');
  assert.match(portHolder(services, 8800).as, /extraPorts/);
  assert.match(portHolder(services, 8811).as, /localPort/);
  assert.equal(portHolder(services, 18899, 'o--w'), null);
  assert.equal(portHolder(services, 18899, 'o--other').id, 'o--w');
  assert.equal(portHolder(services, 9999), null);
});

test('回复的线上格式：失败统一成 error: { code, message, details }', () => {
  assert.deepEqual(wireReply({ ok: false, code: 'port-conflict', why: '端口被占', details: ['a'] }),
    { ok: false, error: { code: 'port-conflict', message: '端口被占', details: ['a'] } });
  assert.deepEqual(wireReply({ ok: true, service: { id: 'x' } }), { ok: true, service: { id: 'x' } });
  assert.deepEqual(wireReply({ ok: false, code: 'failed', why: 'x', service: { id: 's' } }), { ok: false, service: { id: 's' }, error: { code: 'failed', message: 'x' } });
});

test('探活把「端口有没有人听」「健康检查」单独报出来（状态推送要用）', async () => {
  const svc = { id: 's', probe: { tier: 'port', port: 18899 } };
  const snap = (ports) => ({ procs: new Map([[100, { pid: 100, name: 'node.exe', start: 's' }]]), ports: new Map(Object.entries(ports).map(([k, v]) => [Number(k), v])) });
  const down = await probeService(svc, {}, snap({}));
  assert.equal(down.listening, false);
  const up = await probeService(svc, {}, snap({ 18899: [100] }));
  assert.equal(up.listening, true);
  assert.equal(up.health, null, 'port 档没有健康检查');
  const linked = await probeService({ ...svc, link: { enabled: true } }, {}, snap({ 18899: [100] }), () => ({ connected: true, health: 'degraded' }));
  assert.equal(linked.health, 'degraded');
  assert.equal(linked.listening, true);
});

// ---- 注册表：services/owned/<登记方>/ 的加载（真读文件，在临时目录里）
const write = (rel, text) => { const f = path.join(DATA, 'registry', 'services', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const base = (id, port, extra = '') => `id: ${id}\nroot: ${JSON.stringify(CWD)}\nkind: managed\nprobe:\n  tier: port\n  port: ${port}\nhooks:\n  start:\n    cmd: node x.mjs\n    detaches: false\n${extra}`;

test('注册表：owned/<登记方>/<名字>.yaml 加载成 <登记方>--<名字>，归属只看目录', () => {
  write('ergo-daemon.yaml', base('ergo-daemon', 18810));
  write('owned/ergo-daemon/web.yaml', base('ergo-daemon--web', 18899, 'owner: ergo-daemon\n'));
  const { services, errors } = loadServices();
  assert.deepEqual(errors, []);
  assert.equal(services.get('ergo-daemon--web').owner, 'ergo-daemon');
  assert.equal(services.get('ergo-daemon').owner, null);
});

test('注册表：id 和位置对不上、顶层文件冒充名下、owner 写的和目录不一致，都报错', () => {
  write('owned/ergo-daemon/bad.yaml', base('ergo-daemon--wrong', 18901));
  write('owned/ergo-daemon/liar.yaml', base('ergo-daemon--liar', 18902, 'owner: someone-else\n'));
  write('sneaky.yaml', base('sneaky', 18903, 'owner: ergo-daemon\n'));
  const { services, errors } = loadServices();
  assert.ok(errors.some((e) => /owned\/ergo-daemon\/bad\.yaml: id "ergo-daemon--wrong" 与文件名不一致，应为 "ergo-daemon--bad"/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /liar\.yaml: owner "someone-else" 与所在目录/.test(e)));
  assert.ok(errors.some((e) => /sneaky\.yaml: owner 只能出现在/.test(e)));
  assert.equal(services.get('sneaky').owner, null, '顶层文件写了 owner 也不算名下的服务——否则谁都能把自己的服务送进别人手里');
  for (const f of ['owned/ergo-daemon/bad.yaml', 'owned/ergo-daemon/liar.yaml', 'sneaky.yaml']) fs.rmSync(path.join(DATA, 'registry', 'services', f));
});
