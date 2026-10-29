// VPS 上的 https 站点和证书（322 号票）：site add / remove 的脚本在假 Debian 上用 Git Bash 真的跑（直接听 443、
// 80 被别的程序占着要临时停、443 前面有 stream 前门三种布局；重跑不改东西；nginx -t 不过撤回；签失败也拉起来），
// 布局判断、nginx 配置解析的单测，和经假执行层的整条流程（certs、scan 认领）。不连任何真机器。
import './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fakeDebian, gitBash } from './_fake-debian.mjs';
import { fakeExec, FRESH_DEBIAN, scriptKind } from './_fake-vps-exec.mjs';
import * as sc from '../src/vps/scripts.mjs';
import * as paths from '../src/paths.mjs';
import { decideLayout, nginxFromOutput, FRESH_LAYOUT, describeScan } from '../src/vps/sites.mjs';
import { parseDump, frontdoor, frontdoorBackend, httpServers } from '../src/vps/nginxconf.mjs';
import { genericSite } from '../src/vps/nginx.mjs';
import { certAlerts, snapshotFromOutput, certsDue } from '../src/vps/certwatch.mjs';
import { runVps } from '../src/vps/cli.mjs';
import { loadState } from '../src/vps/state.mjs';

const BASH = gitBash();
const skip = BASH ? false : '这台机器上没有 Git Bash';
const vps = { user: 'root', host: '203.0.113.10', port: 22 };
const now = new Date('2026-10-27T00:00:00Z');
const DOMAIN = 'notes.203.0.113.10.sslip.io';
const plan = (layout = FRESH_LAYOUT, over = {}) => ({
  mode: 'site', name: 'notes', vps, publicIp: '203.0.113.10', domain: DOMAIN, site: 'ergo-site-notes', upstreamPort: 3000, email: '', public: false, layout, ...over,
});
const ADD = (p) => sc.siteAddScript(p, { now });
const RM = (p, certOurs = true, revokeAdmin = false) => sc.removeScript('site', { ...p, certOurs, frontdoor: p.layout.frontdoor }, { vps, adminPubkey: '', revokeAdmin, now });
const changing = (calls) => calls.filter((c) => /^(apt-get (install|purge)|certbot (certonly|delete)|ufw (allow|delete|--force)|systemctl (restart|reload-or-restart|stop|start))/.test(c));

const FRONT_NGINX_CONF = [
  'http {', '    include /etc/nginx/conf.d/*.conf;', '    include /etc/nginx/sites-enabled/*;', '}',
  'stream {',
  '    map $ssl_preread_server_name $backend {',
  '        hostnames;',
  '        vpn.example.com 127.0.0.1:10443;',
  '        default 127.0.0.1:8443;',
  '    }',
  '    server {', '        listen 443;', '        ssl_preread on;', '        proxy_pass $backend;', '    }',
  '}', '',
].join('\n');
const FRONT_SITE = 'server {\n    listen 127.0.0.1:8443 ssl;\n    server_name blog.example.com;\n    ssl_certificate /etc/letsencrypt/live/blog.example.com/fullchain.pem;\n    location / { proxy_pass http://127.0.0.1:4000; }\n}\n';

describe('站点脚本在假 Debian 上真的跑', { concurrency: 1 }, () => {  // 一条一条跑：和全量里别的测试一起抢进程，Windows 上起 bash 很吃力

test('直接听 443：从零加一遍（webroot 签、不停任何东西）、重跑什么都不改、撤掉原样（自动安全更新留着）；静态检查', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  const s = ADD(plan());
  assert.ok(!s.includes('\r') && !/8810/.test(s));
  const params = s.split('# ---------------------------------------------------------------- 参数（生成时填好）\n')[1].split('\n\n')[0].split('\n');
  for (const p of params) assert.match(p, /^[A-Z][A-Z0-9_]*='[^']*'$/, p);
  const r1 = await f.run(s);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /^ERGO-DONE site$/m);
  assert.match(r1.out, /^ERGO-RESULT CERT_OURS=1$/m);
  const site = f.read('etc/nginx/sites-available/ergo-site-notes.conf');
  for (const want of ['listen 443 ssl;', 'listen 80;', 'proxy_pass http://127.0.0.1:3000;', 'proxy_set_header Host $host;', 'proxy_request_buffering off;',
    'client_max_body_size 256m;', 'proxy_read_timeout 3600s;', 'Strict-Transport-Security', 'proxy_set_header Connection $ergo_site_notes_upgrade;', 'proxy_set_header X-Real-IP $remote_addr;']) {
    assert.ok(site.includes(want), want);
  }
  assert.ok(r1.calls.some((c) => c.startsWith('certbot certonly --webroot')));
  assert.ok(!r1.calls.some((c) => c.startsWith('systemctl stop')));
  assert.match(f.read('etc/ergo-vps/site-notes.env'), /CERT_OURS=1/);
  const r2 = await f.run(s);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(changing(r2.calls), [], `重跑不该再改东西：${changing(r2.calls).join(' | ')}`);
  const rm = await f.run(RM(plan(), true, true));
  assert.equal(rm.code, 0, rm.err);
  assert.ok(!f.exists('etc/nginx/sites-available/ergo-site-notes.conf'));
  assert.ok(!f.exists('etc/letsencrypt/live/' + DOMAIN));
  assert.ok(!f.installed('nginx') && !f.exists('etc/ergo-vps'));
  assert.ok(f.installed('unattended-upgrades'));
  assert.equal((await f.run(RM(plan(), true, true))).code, 0, '能重复撤');
});

test('80 被 apache2 占着：先停它签（standalone，续期钩子跟着记）、签完拉起来；签失败 trap 也拉起来；站点不写 80 那段；nginx 装的时候不起、拿掉 default', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.mark('listen/t-80', 'apache2');
  f.mark('listen-unit/t-80', 'apache2.service');
  f.mark('svc/apache2.service.active');
  const L = { ...FRESH_LAYOUT, http80: false, certHow: 'standalone', stopUnits: ['apache2.service'], noStartInstall: true };
  const s = ADD(plan(L));
  // 签失败：apache2 照样被拉起来，80 还给它
  f.mark('certbot-fail');
  const bad = await f.run(s);
  assert.notEqual(bad.code, 0);
  assert.ok(bad.calls.some((c) => c === 'systemctl stop apache2.service'));
  assert.ok(bad.calls.some((c) => c === 'systemctl start apache2.service'), '签失败也要拉起来');
  assert.equal(f.read('../fake/listen/t-80'), 'apache2', '80 还给 apache2');
  assert.ok(!f.exists('usr/sbin/policy-rc.d'), '装包时临时放的 policy-rc.d 拿掉了');
  assert.ok(!f.exists('etc/nginx/sites-enabled/default'), 'nginx 自带的 default 站点（听 80）拿掉了');
  f.unmark('certbot-fail');
  const r = await f.run(s);
  assert.equal(r.code, 0, r.err);
  const issue = r.calls.find((c) => c.startsWith('certbot certonly --standalone'));
  assert.ok(issue.includes('--pre-hook systemctl stop apache2.service') && issue.includes('--post-hook systemctl start apache2.service'), issue);
  assert.equal(f.read('../fake/listen/t-80'), 'apache2');
  assert.ok(f.active('nginx'), 'nginx 起来了（只听 443）');
  const site = f.read('etc/nginx/sites-available/ergo-site-notes.conf');
  assert.ok(!/listen 80/.test(site) && /listen 443 ssl;/.test(site));
});

test('443 前面有 stream 前门：站点只听 127.0.0.1:8443，前门 map 里加一行；nginx -t 不过换回原样；撤的时候拿掉那一行', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.preinstall('nginx');
  f.preinstall('certbot');
  f.write('etc/nginx/nginx.conf', FRONT_NGINX_CONF);
  f.mark('listen/t-443', 'nginx');
  f.mark('listen/t-80', 'nginx');
  const fd = { file: '/etc/nginx/nginx.conf', mapVar: 'backend', backend: '127.0.0.1:8443', proxyProtocol: false };
  const L = { ...FRESH_LAYOUT, kind: 'frontdoor', listen: '127.0.0.1:8443 ssl', frontdoor: fd };
  // 加前门那一行以后 nginx -t 不过：前门换回原样、脚本停下
  f.mark('nginx-t-fail-grep', 'ergo-vps-site=notes');
  const bad = await f.run(ADD(plan(L)));
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /前门加了 .* 那一行后 nginx -t 没通过，已换回原样/);
  assert.equal(f.read('etc/nginx/nginx.conf'), FRONT_NGINX_CONF);
  f.unmark('nginx-t-fail-grep');
  const r = await f.run(ADD(plan(L)));
  assert.equal(r.code, 0, r.err);
  assert.match(f.read('etc/nginx/nginx.conf'), /map \$ssl_preread_server_name \$backend \{\n {8}notes\.203\.0\.113\.10\.sslip\.io 127\.0\.0\.1:8443; {2}# ergo-vps-site=notes\n/);
  assert.match(f.read('etc/nginx/sites-available/ergo-site-notes.conf'), /listen 127\.0\.0\.1:8443 ssl;/);
  const again = await f.run(ADD(plan(L)));
  assert.equal(again.code, 0, again.err);
  assert.equal(f.read('etc/nginx/nginx.conf').match(/ergo-vps-site=notes/g).length, 1, '重跑不重复加');
  const rm = await f.run(RM(plan(L)));
  assert.equal(rm.code, 0, rm.err);
  assert.equal(f.read('etc/nginx/nginx.conf'), FRONT_NGINX_CONF, '前门原样');
  assert.ok(f.installed('nginx'), 'nginx 原来就有，不卸');
});

test('布局变了（生成时没有前门、现在 80 被别的占着）：开头核对就停，一样东西都不改', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.mark('listen/t-80', 'caddy');
  const r = await f.run(ADD(plan()));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /80 现在被 caddy 占着/);
  assert.deepEqual(changing(r.calls), []);
  assert.ok(!f.exists('etc/ergo-vps'));
});

});

test('nginx 配置解析：include 拼回去，认出 http 站点、stream 前门、前门后面的地址', () => {
  const dump = [
    '# configuration file /etc/nginx/nginx.conf:', FRONT_NGINX_CONF,
    '# configuration file /etc/nginx/sites-enabled/blog:', FRONT_SITE,
  ].join('\n');
  const n = parseDump(dump);
  const sites = httpServers(n.tree);
  assert.deepEqual(sites.map((s) => [s.serverNames, s.listen, s.proxyPass, s.file]), [[['blog.example.com'], ['127.0.0.1:8443 ssl'], ['http://127.0.0.1:4000'], '/etc/nginx/sites-enabled/blog']]);
  const fd = frontdoor(n.tree);
  assert.equal(fd.ok, true);
  assert.deepEqual([fd.mapVar, fd.mapFile, fd.proxyProtocol, fd.default], ['backend', '/etc/nginx/nginx.conf', false, '127.0.0.1:8443']);
  assert.deepEqual(fd.entries, [{ name: 'vpn.example.com', to: '127.0.0.1:10443' }]);
  assert.equal(frontdoorBackend(n.tree, fd), '127.0.0.1:8443');
  assert.equal(frontdoor(parseDump('# configuration file /etc/nginx/nginx.conf:\nhttp { server { listen 80; } }').tree), null);
});

test('布局判断：新 VPS、前门（开没开 proxy_protocol）、80 被占（认得出 / 认不出 / docker）、443 被占', () => {
  const kv = (over = {}) => ({ ...FRESH_DEBIAN, CERT_LEFT: '-1', LISTEN_TCP_80_UNIT: '', ...over });
  const empty = { tree: [], files: [] };
  const p = plan();
  const fresh = decideLayout(kv(), empty, p);
  assert.deepEqual([fresh.kind, fresh.listen, fresh.certHow, fresh.http80, fresh.blocking], ['direct', '443 ssl', 'webroot', true, []]);
  const dump = (conf) => nginxFromOutput(['# configuration file /etc/nginx/nginx.conf:', conf, '# configuration file /etc/nginx/sites-enabled/blog:', FRONT_SITE].map((l) => l.split('\n').map((x) => `ERGO-NGX|${x}`).join('\n')).join('\n'));
  const fd = decideLayout(kv({ NGINX_STREAM_443: '1', LISTEN_TCP_443: 'nginx', LISTEN_TCP_80: 'nginx' }), dump(FRONT_NGINX_CONF), p);
  assert.deepEqual([fd.kind, fd.listen, fd.clientAddress, fd.frontdoor.file, fd.blocking], ['frontdoor', '127.0.0.1:8443 ssl', '$remote_addr', '/etc/nginx/nginx.conf', []]);
  assert.match(fd.warnings.join('\n'), /没开 proxy_protocol/);
  const pp = decideLayout(kv({ NGINX_STREAM_443: '1' }), dump(FRONT_NGINX_CONF.replace('ssl_preread on;', 'ssl_preread on;\n        proxy_protocol on;')), p);
  assert.deepEqual([pp.listen, pp.clientAddress], ['127.0.0.1:8443 ssl proxy_protocol', '$proxy_protocol_addr']);
  const taken = decideLayout(kv({ NGINX_STREAM_443: '1' }), dump(FRONT_NGINX_CONF.replace('vpn.example.com', DOMAIN)), p);
  assert.match(taken.blocking.join('\n'), /已经指到 127\.0\.0\.1:10443/);
  const apache = decideLayout(kv({ LISTEN_TCP_80: 'apache2', LISTEN_TCP_80_UNIT: 'apache2.service' }), empty, p);
  assert.deepEqual([apache.certHow, apache.stopUnits, apache.http80, apache.noStartInstall, apache.blocking], ['standalone', ['apache2.service'], false, true, []]);
  assert.match(decideLayout(kv({ LISTEN_TCP_80: 'docker-proxy', LISTEN_TCP_80_UNIT: 'docker.service' }), empty, p).blocking.join(''), /连带停掉别的东西/);
  assert.match(decideLayout(kv({ LISTEN_TCP_80: 'python3' }), empty, p).blocking.join(''), /--stop-unit/);
  assert.equal(decideLayout(kv({ LISTEN_TCP_80: 'python3' }), empty, p, { stopUnit: 'notes-dev.service' }).certHow, 'standalone');
  assert.equal(decideLayout(kv({ LISTEN_TCP_80: 'apache2', CERT_LEFT: '50' }), empty, p).certHow, 'existing', '证书原来就有就不停它');
  assert.match(decideLayout(kv({ LISTEN_TCP_443: 'caddy' }), empty, p).blocking.join(''), /443 被 caddy 占着/);
  assert.throws(() => genericSite({ name: 'Bad_Name', domain: DOMAIN, upstreamPort: 3000 }));
  assert.throws(() => genericSite({ name: 'notes', domain: DOMAIN, upstreamPort: 3000, listen: '0.0.0.0:443 ssl' }));
});

test('证书提醒：少于 20 天提醒、7 天内红、过期；管理器 12 小时去看一次、没看成 1 小时后再试', () => {
  const t0 = Date.UTC(2026, 9, 27);
  const snap = snapshotFromOutput(`ERGO-CERT a.example.com ${(t0 + 30 * 86400000) / 1000}\nERGO-CERT b.example.com ${(t0 + 10 * 86400000) / 1000}\nERGO-CERTFILE /etc/nginx/ssl/c.pem ${(t0 + 3 * 86400000) / 1000}\n`, { now: t0 });
  const a = certAlerts(snap, t0);
  assert.deepEqual(a.map((x) => [x.name, x.level, x.days]), [['b.example.com', 'warn', 10], ['/etc/nginx/ssl/c.pem', 'bad', 3]]);
  assert.equal(certsDue(snap, t0 + 3600000), false);
  assert.equal(certsDue(snap, t0 + 13 * 3600000), true);
  assert.equal(certsDue({ ...snap, ok: false }, t0 + 2 * 3600000), true);
});

function fakeIo(answers = []) {
  const lines = [];
  const events = [];
  return {
    lines, events, text: () => lines.join('\n'),
    say(l) { lines.push(String(l)); },
    async ask() { return answers.length ? answers.shift() : null; },
    async confirm(q, { yes } = {}) { events.push(['confirm', q, lines.length]); if (yes) return true; return answers.shift() === 'y'; },
  };
}
const clean = () => { for (const p of [paths.VPS_STATE, paths.VPS_KEYS_DIR, paths.VPS_SCRIPTS_DIR, paths.REGISTRY_DIR, paths.VPS_CERTS]) fs.rmSync(p, { recursive: true, force: true }); };
const NOW = () => new Date('2026-10-27T08:00:00Z');
const run = (args, { io, exec }) => runVps(args, { io, exec, now: NOW, sleep: async () => {} });
const ssh = (exec, kind) => exec.calls.filter((c) => c.type === 'run' && path.basename(c.argv[0]) === 'ssh' && scriptKind(c.input) === kind);
const NOT_ERGO = { access: { status: 404, body: 'not found' }, health: { status: 404, body: '' } };
const ADD_ARGS = ['site', 'add', 'notes', '--host', 'root@203.0.113.10', '--port', '3000'];

test('site add 整条流程：体检要回 nginx 配置、显示了才问、同意了才跑；验收 401 过、记进状态；remove 原样撤、最后一样收回管理钥匙', async () => {
  clean();
  const exec = fakeExec({ site: NOT_ERGO, siteRoot: { status: 401, body: '' } });
  const io = fakeIo(['y']);
  assert.equal(await run(ADD_ARGS, { io, exec }), 0, io.text());
  assert.ok(ssh(exec, 'checkup')[0].input.includes("WANT_NGINX_DUMP='1'"));
  const [add] = ssh(exec, 'site-add');
  assert.ok(add.input.includes("UPSTREAM_PORT='3000'") && add.input.includes(`DOMAIN='${DOMAIN}'`));
  assert.match(io.text(), /不带凭证打开回 401：有认证把关/);
  const s = loadState().sites.notes;
  assert.deepEqual([s.phase, s.certOurs, s.layout.kind, s.upstreamPort], ['verified', true, 'direct', 3000]);
  const rm = fakeIo(['y']);
  assert.equal(await run(['site', 'remove', 'notes'], { io: rm, exec }), 0, rm.text());
  const [r] = ssh(exec, 'remove');
  assert.ok(r.input.includes("MODE='site'") && r.input.includes("SITE_NAME='notes'") && r.input.includes("REVOKE_ADMIN='1'"));
  assert.deepEqual(loadState().sites, {});
  assert.equal(loadState().vps, null);
});

test('site add：80 被别的程序占着要临时停——单独先说、先问，不同意一个字不跑；不带凭证就能打开且没说 --public 算没过', async () => {
  clean();
  const exec = fakeExec({ site: NOT_ERGO, siteRoot: { status: 200, body: 'hello' }, checkup: { LISTEN_TCP_80: 'apache2', LISTEN_TCP_80_UNIT: 'apache2.service' } });
  const no = fakeIo(['n']);
  assert.equal(await run(ADD_ARGS, { io: no, exec }), 1);
  assert.match(no.text(), /签证书要用 80 端口，可 80 现在被 apache2\.service 占着/);
  assert.equal(no.events[0][1], '同意签证书时临时停 apache2.service？');
  assert.equal(ssh(exec, 'site-add').length, 0);
  const io = fakeIo(['y', 'y']);
  assert.equal(await run(ADD_ARGS, { io, exec }), 1, '200 不带凭证就能打开：没过');
  assert.ok(ssh(exec, 'site-add')[0].input.includes("CERT_HOW='standalone'") && ssh(exec, 'site-add')[0].input.includes("STOP_UNITS='apache2.service'"));
  assert.match(io.text(), /不带凭证就能打开（回 200）/);
  assert.equal(loadState().sites.notes.phase, 'verify-failed');
  const ok = fakeIo(['y', 'y']);
  assert.equal(await run([...ADD_ARGS, '--public'], { io: ok, exec }), 0, ok.text());
});

test('site add：后面接的是二狗的本机端口 8810 → 报红、当场撤掉站点；域名撞了、名字不对一开始就拒', async () => {
  clean();
  const exec = fakeExec({ site: { access: { status: 200, body: '{"access":"local"}' }, health: { status: 200, body: '{}' } }, siteRoot: { status: 200, body: '' } });
  const io = fakeIo(['y']);
  assert.equal(await run(ADD_ARGS, { io, exec }), 1);
  assert.match(io.text(), /8810/);
  assert.equal(ssh(exec, 'remove').length, 1, '当场撤掉');
  assert.equal(loadState().sites.notes, undefined);
  const bad = fakeIo();
  assert.equal(await run(['site', 'add', 'Bad_Name', '--host', 'root@203.0.113.10', '--port', '3000'], { io: bad, exec }), 1);
  assert.match(bad.text(), /站点名只能是/);
  const p80 = fakeIo();
  assert.equal(await run(['site', 'add', 'x', '--host', 'root@203.0.113.10', '--port', '443'], { io: p80, exec }), 1);
  assert.match(p80.text(), /不能是 443/);
});

test('scan 只读认领已有站点和证书（不改 VPS）；certs 列到期日、少于 20 天提醒并存进 vps-certs.json；认领的站点 site remove 不撤', async () => {
  clean();
  const t = NOW().getTime();
  const exec = fakeExec({
    nginxDump: ['# configuration file /etc/nginx/nginx.conf:', FRONT_NGINX_CONF, '# configuration file /etc/nginx/sites-enabled/blog:', FRONT_SITE].join('\n'),
    certs: [{ domain: 'blog.example.com', notAfter: t + 12 * 86400000 }],
  });
  const io = fakeIo();
  assert.equal(await run(['scan', '--host', 'root@203.0.113.10'], { io, exec }), 0, io.text());
  assert.equal(ssh(exec, 'scan').length, 1);
  assert.ok(!exec.calls.some((c) => ['setup-tunnel', 'site-add', 'remove'].includes(scriptKind(c.input))), '只读');
  const st = loadState();
  assert.deepEqual(st.claimed.sites.map((s) => s.serverNames), [['blog.example.com']]);
  assert.equal(st.claimed.frontdoor.mapVar, 'backend');
  assert.match(io.text(), /blog\.example\.com （认领）/);
  const c = fakeIo();
  assert.equal(await run(['certs'], { io: c, exec }), 1, '有快到期的退出码 1');
  assert.match(c.text(), /blog\.example\.com .*还剩 12 天/);
  assert.match(c.text(), /certbot 的自动续期大概没跑成/);
  assert.equal(JSON.parse(fs.readFileSync(paths.VPS_CERTS, 'utf-8')).certs[0].owner, '认领的 blog.example.com');
  const r = fakeIo(['y']);
  assert.equal(await run(['site', 'remove', 'blog.example.com'], { io: r, exec }), 1);
  assert.match(r.text(), /lsm vps scan 认领的站点/);
  assert.match(describeScan(`ERGO-SCAN=1\n`).sites.length.toString(), /^0$/);
});
