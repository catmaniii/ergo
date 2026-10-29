// VPS 上跑的脚本（321 号票）：在"假 Debian"里用 Git Bash 真的跑——从零装、重跑（幂等）、断了接着做、
// nginx -t 不过撤回、原样撤；再加静态检查（bash -n、不该出现的写法）。不连任何真机器。
import './_isolate.mjs';   // 必须是第一个 import：先把数据目录换成临时目录
import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fakeDebian, gitBash, toMsys } from './_fake-debian.mjs';
import * as sc from '../src/vps/scripts.mjs';

const BASH = gitBash();
const skip = BASH ? false : '这台机器上没有 Git Bash';
const vps = { user: 'root', host: '203.0.113.10', port: 22 };
const TUNNEL_PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVyZ28tdHVubmVsLXRlc3Qta2V5LW5vdC1yZWFs ergo-supervisor-tunnel';
const ADMIN_PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVyZ28tYWRtaW4tdGVzdC1rZXktbm90LXJlYWw ergo-supervisor-admin';
const tunnel = {
  mode: 'tunnel', vps, publicIp: '203.0.113.10', domain: 'ergo.203.0.113.10.sslip.io', site: 'ergo-vps-tunnel',
  account: 'ergo-tunnel', remotePort: 18811, localPort: 8811, tunnelPubkey: TUNNEL_PUB, email: '',
};
const headscale = {
  mode: 'headscale', vps, publicIp: '203.0.113.10', domain: 'hs.203.0.113.10.sslip.io', site: 'ergo-vps-headscale',
  hsPort: 8080, hsVersion: '0.26.1', hsUser: 'ergo', derp: true, email: '',
};
const now = new Date('2026-10-27T00:00:00Z');
const T = () => sc.tunnelSetupScript(tunnel, { now });
const H = (wantAuthKey = false) => sc.headscaleSetupScript(headscale, { now, wantAuthKey });
const RM = (mode, rec, revokeAdmin) => sc.removeScript(mode, rec, { vps, adminPubkey: ADMIN_PUB, revokeAdmin, now });
// 每条用例各用各的假根目录，互不相干：并行跑（Windows 上起 bash 很慢）
const changing = (calls) => calls.filter((c) => /^(apt-get (install|purge)|certbot (certonly|delete)|ufw (allow|delete|--force)|useradd|userdel|systemctl (restart|reload-or-restart|stop|start)|curl .*\.deb)/.test(c));

describe('VPS 脚本在假 Debian 上真的跑', { concurrency: 4 }, () => {

test('脚本的静态检查：bash -n 都过；只有参数是生成的，参数都单引号；没有 Windows 换行；绝不出现 8810', { skip }, () => {
  const scripts = {
    tunnel: T(), headscale: H(true), checkup: sc.checkupScript(tunnel, { now }), status: sc.statusScript({ vps, modes: { tunnel, headscale } }, { now }),
    removeTunnel: RM('tunnel', tunnel, false), removeHeadscale: RM('headscale', headscale, true),
  };
  const dir = fs.mkdtempSync(`${process.env.LSM_DATA_DIR}/sh-`);
  for (const [name, s] of Object.entries(scripts)) {
    const f = `${dir}/${name}.sh`;
    fs.writeFileSync(f, s);
    const r = spawnSync(BASH, ['-n', toMsys(f)], { encoding: 'utf-8', windowsHide: true });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.ok(s.startsWith('#!/usr/bin/env bash\n'), name);
    assert.ok(s.includes('\nset -euo pipefail\n'), `${name} 要 set -euo pipefail`);
    assert.ok(!s.includes('\r'), `${name} 里有 Windows 换行`);
    assert.ok(!/8810/.test(s), `${name} 里出现了 8810`);
    // 参数段：每个都是 KEY='…'
    const params = s.split('# ---------------------------------------------------------------- 参数（生成时填好）\n')[1].split('\n\n')[0].split('\n');
    for (const p of params) assert.match(p, /^[A-Z][A-Z0-9_]*='[^']*'$/, `${name} 的参数行 ${p}`);
  }
  // 受限账号那一行和票里写的一字不差；nginx 站点把真实 IP 传过去、接的是 VPS 上的隧道端口
  assert.ok(scripts.tunnel.includes('line="restrict,port-forwarding,permitlisten=\\"127.0.0.1:$TUNNEL_PORT\\",command=\\"/bin/false\\" $TUNNEL_PUBKEY"'));
  assert.ok(scripts.tunnel.includes('proxy_set_header X-Real-IP $remote_addr;'));
  assert.ok(scripts.tunnel.includes('proxy_pass http://127.0.0.1:18811;'));
  assert.ok(scripts.tunnel.includes('add_header Strict-Transport-Security'));
  // 一次性钥匙只在要的时候发
  assert.ok(H(true).includes("WANT_AUTHKEY='1'"));
  assert.ok(H(false).includes("WANT_AUTHKEY='0'"));
  // 参数里带单引号也安全
  assert.equal(sc.shq("a'b"), "'a'\\''b'");
  assert.throws(() => sc.contentFunction('content_x', 'x\nERGO_CONTENT_EOF\ny'), /分隔行/);
});

test('隧道：从零装一遍，装上了该装的；再跑一遍什么都不改（幂等）', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  const r1 = await f.run(T());
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /^ERGO-DONE tunnel$/m);
  for (const p of ['nginx', 'certbot', 'ufw', 'unattended-upgrades']) assert.ok(f.installed(p), `${p} 没装`);
  assert.ok(f.ufwActive());
  assert.deepEqual(f.ufwRules(), ['22/tcp', '80/tcp', '443/tcp']);
  assert.ok(f.user('ergo-tunnel'));
  assert.equal(f.read('var/lib/ergo-tunnel/.ssh/authorized_keys'), `restrict,port-forwarding,permitlisten="127.0.0.1:18811",command="/bin/false" ${TUNNEL_PUB}\n`);
  const site = f.read('etc/nginx/sites-available/ergo-vps-tunnel.conf');
  assert.match(site, /listen 443 ssl;/);
  assert.match(site, /ssl_certificate \/etc\/letsencrypt\/live\/ergo\.203\.0\.113\.10\.sslip\.io\/fullchain\.pem;/);
  assert.ok(f.exists('etc/nginx/sites-enabled/ergo-vps-tunnel.conf'));
  assert.ok(f.exists('etc/letsencrypt/live/ergo.203.0.113.10.sslip.io/fullchain.pem'));
  assert.ok(f.exists('etc/letsencrypt/renewal-hooks/deploy/ergo-vps-reload-nginx'));
  assert.match(f.read('etc/apt/apt.conf.d/52ergo-auto-upgrades'), /Unattended-Upgrade "1"/);
  assert.match(f.read('etc/ergo-vps/base.env'), /PRE_PKG_NGINX=0/);
  assert.match(f.read('etc/ergo-vps/tunnel.env'), /DOMAIN=ergo\.203\.0\.113\.10\.sslip\.io/);
  // 签证书用 webroot，不停 nginx
  assert.ok(r1.calls.some((c) => c.startsWith('certbot certonly --webroot')));
  assert.ok(!r1.calls.some((c) => c.startsWith('systemctl stop')));

  const r2 = await f.run(T());
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(changing(r2.calls), [], `重跑不该再改东西：${changing(r2.calls).join(' | ')}`);
  const steps = [...r2.out.matchAll(/^ERGO-STEP (\S+) (ok|skip)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.ok(steps.every((s) => s.endsWith(' skip')), steps.join('、'));
  assert.deepEqual(f.ufwRules(), ['22/tcp', '80/tcp', '443/tcp']);
});

test('断了接着做：签证书那一步失败就停下，处理好重跑从那里接着做，不重装已经装好的', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.mark('certbot-fail');
  const r1 = await f.run(T());
  assert.notEqual(r1.code, 0);
  assert.ok(!/ERGO-DONE/.test(r1.out));
  assert.ok(f.installed('nginx') && f.user('ergo-tunnel'));
  // 证书没签下来时只有 80 端口那段站点，nginx -t 照样过（不会引用不存在的证书）
  assert.ok(!/listen 443/.test(f.read('etc/nginx/sites-available/ergo-vps-tunnel.conf')));
  f.unmark('certbot-fail');
  const r2 = await f.run(T());
  assert.equal(r2.code, 0, r2.err);
  assert.ok(!r2.calls.some((c) => c.startsWith('apt-get install')), '不该重装');
  assert.ok(!r2.calls.some((c) => c.startsWith('useradd')), '不该重建账号');
  assert.ok(r2.calls.some((c) => c.startsWith('certbot certonly')));
  assert.match(f.read('etc/nginx/sites-available/ergo-vps-tunnel.conf'), /listen 443 ssl;/);
});

test('nginx -t 不过：站点撤回原样（原来没有就删掉），脚本停下报错', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  assert.equal((await f.run(T())).code, 0);
  const before = f.read('etc/nginx/sites-available/ergo-vps-tunnel.conf');
  // 换一个隧道端口重跑（站点内容变了）而 nginx -t 不过 → 换回原来的
  f.mark('nginx-t-fail');
  const r = await f.run(sc.tunnelSetupScript({ ...tunnel, remotePort: 18812 }, { now }));
  assert.notEqual(r.code, 0);
  assert.match(r.err, /nginx -t 没通过，站点 ergo-vps-tunnel 已撤回原样/);
  assert.equal(f.read('etc/nginx/sites-available/ergo-vps-tunnel.conf'), before);
  assert.ok(!f.exists('etc/nginx/sites-available/ergo-vps-tunnel.conf.ergo-prev'));

  // 全新的机器上第一次写站点就不过：不留半截站点
  const g = fakeDebian();
  t.after(() => g.cleanup());
  g.mark('nginx-t-fail');
  assert.notEqual((await g.run(T())).code, 0);
  assert.ok(!g.exists('etc/nginx/sites-available/ergo-vps-tunnel.conf'));
  assert.ok(!g.exists('etc/nginx/sites-enabled/ergo-vps-tunnel.conf'));
});

test('域名没指到这台：签证书之前就停下，什么证书都不签', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.mark('dns-wrong');
  const r = await f.run(T());
  assert.notEqual(r.code, 0);
  assert.match(r.err, /没有指到这台 VPS/);
  assert.ok(!r.calls.some((c) => c.startsWith('certbot')));
});

test('撤隧道：原样撤掉——原来没有的包卸掉、ufw 关回去、管理用的钥匙拿掉；自动安全更新留着；别人的钥匙、原来就有的东西不碰；能重复撤', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  assert.equal((await f.run(T())).code, 0);
  f.write('root/.ssh/authorized_keys', `ssh-ed25519 AAAAothers someone@laptop\n${ADMIN_PUB}\n`);
  const r = await f.run(RM('tunnel', tunnel, true));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ERGO-DONE remove$/m);
  assert.ok(!f.user('ergo-tunnel'));
  assert.ok(!f.exists('var/lib/ergo-tunnel'));
  assert.ok(!f.exists('etc/nginx/sites-available/ergo-vps-tunnel.conf'));
  assert.ok(!f.exists('etc/letsencrypt'));
  for (const p of ['nginx', 'nginx-common', 'certbot', 'ufw']) assert.ok(!f.installed(p), `${p} 该卸`);
  assert.ok(!f.ufwActive());
  assert.deepEqual(f.ufwRules(), []);
  // 自动安全更新：撤的时候留着（包不卸、打开它的文件不删）
  assert.ok(f.installed('unattended-upgrades'), 'unattended-upgrades 留着');
  assert.match(f.read('etc/apt/apt.conf.d/52ergo-auto-upgrades'), /Unattended-Upgrade "1"/);
  assert.ok(!r.calls.some((c) => /^apt-get purge .*unattended-upgrades/.test(c)));
  assert.ok(!f.exists('etc/ergo-vps'));
  assert.equal(f.read('root/.ssh/authorized_keys'), 'ssh-ed25519 AAAAothers someone@laptop\n');
  const again = await f.run(RM('tunnel', tunnel, true));
  assert.equal(again.code, 0);
  assert.match(again.out, /没什么可撤的/);
});

test('原来就有 nginx、ufw 开着、已经放行 443：装的时候沿用，撤的时候不卸 nginx、不关 ufw、不删原来的规则', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.preinstall('nginx');
  f.preinstall('ufw');
  f.mark('ufw.active');
  f.mark('ufw.rules', 'OpenSSH\n22/tcp\n443/tcp\n');
  const r1 = await f.run(T());
  assert.equal(r1.code, 0, r1.err);
  assert.ok(!r1.calls.some((c) => /^apt-get install .*\bnginx\b/.test(c)));
  assert.deepEqual(f.ufwRules(), ['OpenSSH', '22/tcp', '443/tcp', '80/tcp']);
  assert.match(r1.out, /ERGO-STEP firewall ok 放行 80\/tcp 443\/tcp（ufw 原来就开着）/);
  const r2 = await f.run(RM('tunnel', tunnel, false));
  assert.equal(r2.code, 0, r2.err);
  assert.ok(f.installed('nginx') && f.installed('ufw'), 'nginx、ufw 原来就有，不卸');
  assert.ok(f.ufwActive(), 'ufw 原来就开着，不关');
  assert.deepEqual(f.ufwRules(), ['OpenSSH', '22/tcp', '443/tcp'], '只删我们加的 80/tcp');
  assert.ok(!f.installed('certbot'), 'certbot 原来没有，卸');
});

test('headscale：从零装（下载的安装包核对 sha256）、写配置、建用户、发一次性钥匙；重跑不重下、不重启', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  const r1 = await f.run(H(true));
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /^ERGO-DONE headscale$/m);
  assert.match(r1.out, /^ERGO-RESULT AUTHKEY=[0-9a-f]{48}$/m);
  assert.ok(f.installed('headscale') && f.active('headscale'));
  const conf = f.read('etc/headscale/config.yaml');
  assert.match(conf, /^server_url: https:\/\/hs\.203\.0\.113\.10\.sslip\.io$/m);
  assert.match(conf, /^listen_addr: 127\.0\.0\.1:8080$/m);
  assert.match(conf, /extra_records_path: \/var\/lib\/headscale\/extra-records\.json/);
  assert.equal(f.read('var/lib/headscale/extra-records.json').trim(), '[]');
  assert.deepEqual(f.ufwRules(), ['22/tcp', '80/tcp', '443/tcp', '3478/udp']);
  assert.match(f.read('etc/nginx/sites-available/ergo-vps-headscale.conf'), /proxy_pass http:\/\/127\.0\.0\.1:8080;/);
  assert.ok(r1.calls.some((c) => /^curl .*headscale_0\.26\.1_linux_amd64\.deb$/.test(c)));

  const r2 = await f.run(H(false));
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(changing(r2.calls), [], `重跑不该再改东西：${changing(r2.calls).join(' | ')}`);
  assert.ok(!/AUTHKEY/.test(r2.out), '没要就不发钥匙');
});

test('headscale：镜像只换安装包从哪下，校验和照样从 GitHub 发布页取；镜像给的包 sha256 对不上就不装', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  const mirrored = sc.headscaleSetupScript({ ...headscale, hsMirror: 'https://gh-proxy.example.com/' }, { now });
  assert.ok(mirrored.includes("HS_MIRROR='https://gh-proxy.example.com/'"));
  f.mark('checksum-wrong');
  const bad = await f.run(mirrored);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /sha256 和 GitHub 发布页的 checksums\.txt 对不上，没装（安装包是从镜像 https:\/\/gh-proxy\.example\.com\/ 下的）/);
  assert.ok(!f.installed('headscale'));
  f.unmark('checksum-wrong');
  const r = await f.run(mirrored);
  assert.equal(r.code, 0, r.err);
  const curls = r.calls.filter((c) => c.startsWith('curl ') && /\.deb|checksums/.test(c));
  assert.ok(curls.some((c) => c.endsWith(' https://gh-proxy.example.com/https://github.com/juanfont/headscale/releases/download/v0.26.1/headscale_0.26.1_linux_amd64.deb')), curls.join('\n'));
  assert.ok(curls.some((c) => c.endsWith(' https://github.com/juanfont/headscale/releases/download/v0.26.1/checksums.txt')), '校验和从 GitHub 取');
  assert.ok(!curls.some((c) => /gh-proxy.*checksums/.test(c)), '校验和不从镜像取');
  assert.match(r.out, /安装包从镜像下的，sha256 和官方的对上了/);
});

test('headscale：安装包的 sha256 对不上就不装；配置 configtest 不过就换回原来的', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.mark('checksum-wrong');
  const r1 = await f.run(H());
  assert.notEqual(r1.code, 0);
  assert.match(r1.err, /sha256 和 GitHub 发布页的 checksums\.txt 对不上，没装/);
  assert.ok(!f.installed('headscale'));
  f.unmark('checksum-wrong');
  assert.equal((await f.run(H())).code, 0);
  const good = f.read('etc/headscale/config.yaml');
  f.mark('hs-configtest-fail');
  const r2 = await f.run(sc.headscaleSetupScript({ ...headscale, derp: false }, { now }));
  assert.notEqual(r2.code, 0);
  assert.match(r2.err, /configtest 没通过，配置已换回原来的/);
  assert.equal(f.read('etc/headscale/config.yaml'), good);
});

test('原来就有 headscale（不是我们装的）：不覆盖，一步都不往下做', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.preinstall('headscale');
  const r = await f.run(H());
  assert.notEqual(r.code, 0);
  assert.match(r.err, /原来就有 headscale/);
  assert.ok(!r.calls.some((c) => c.startsWith('apt-get install')));
});

test('两种都装、先撤一种：另一种还要的端口和公共部分留着；再撤另一种才全撤掉', { skip }, async (t) => {
  const f = fakeDebian();
  t.after(() => f.cleanup());
  assert.equal((await f.run(H())).code, 0);
  assert.equal((await f.run(T())).code, 0);
  const r1 = await f.run(RM('headscale', headscale, false));
  assert.equal(r1.code, 0, r1.err);
  assert.ok(!f.installed('headscale') && !f.exists('var/lib/headscale'));
  assert.ok(f.installed('nginx') && f.ufwActive());
  assert.deepEqual(f.ufwRules(), ['22/tcp', '80/tcp', '443/tcp'], '3478/udp 只给 headscale 开的，关掉；80、443 隧道还要');
  assert.ok(f.exists('etc/nginx/sites-available/ergo-vps-tunnel.conf'));
  const r2 = await f.run(RM('tunnel', tunnel, true));
  assert.equal(r2.code, 0, r2.err);
  assert.ok(!f.installed('nginx') && !f.ufwActive() && !f.exists('etc/ergo-vps'));
  assert.ok(f.installed('unattended-upgrades'), '自动安全更新留着');
});

test('体检脚本在假 Debian 上跑得通，输出能解析；谁占着 80 能看出来', { skip }, async (t) => {
  const { parseCheckup, assessCheckup } = await import('../src/vps/checkup.mjs');
  const f = fakeDebian();
  t.after(() => f.cleanup());
  f.preinstall('apache2');
  f.mark('listen/t-80', 'apache2');
  f.mark('listen/t-8000', 'python3');
  const r = await f.run(sc.checkupScript(tunnel, { now }));
  assert.equal(r.code, 0, r.err);
  const kv = parseCheckup(r.out);
  assert.equal(kv.OS_ID, 'debian');
  assert.equal(kv.LISTEN_TCP_80, 'apache2');
  assert.equal(kv.OPENSSH_VERSION, '9.2');
  assert.equal(kv.DNS_OK, '1');
  const a = assessCheckup(kv, tunnel);
  assert.ok(a.blocking.some((b) => /80 端口被 apache2 占着/.test(b)), a.blocking.join('；'));
  assert.ok(a.warnings.some((w) => /8000/.test(w)), '打开防火墙前要提醒对外在听的别的端口');
  // 体检只读：没改任何东西
  assert.deepEqual(changing(r.calls), []);
  assert.ok(!f.exists('etc/ergo-vps'));
});

test('status 脚本列出证书到期时刻、服务和隧道账号', { skip }, async (t) => {
  const { parseCertLines } = await import('../src/vps/certs.mjs');
  const f = fakeDebian();
  t.after(() => f.cleanup());
  assert.equal((await f.run(T())).code, 0);
  const r = await f.run(sc.statusScript({ vps, modes: { tunnel } }, { now }));
  assert.equal(r.code, 0, r.err);
  const p = sc.parseOutput(r.out);
  assert.equal(p.kv.SVC_NGINX, 'active');
  assert.equal(p.kv.TUNNEL_ACCOUNT, '1');
  assert.deepEqual(parseCertLines(r.out), [{ domain: 'ergo.203.0.113.10.sslip.io', notAfter: Date.UTC(2030, 0, 1) }]);
  assert.deepEqual(changing(r.calls), []);
});

});
