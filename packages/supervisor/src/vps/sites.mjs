// VPS 上的 https 站点和证书（322 号票）：`lsm vps site add | remove`、`lsm vps certs`、`lsm vps scan`。
// 和 321 的 setup 同一套底子：执行层（exec）、问答（io）、专用钥匙、只读体检、脚本整份显示了才跑、状态文件（vps-setup.json）。
//
// site add 的顺序：
//   1. 定域名（默认 <名字>.<IP>.sslip.io）、本机专用钥匙、登进 VPS；
//   2. 体检（只读）+ 把 nginx 的配置（nginx -T）要回来，看布局：
//      - 443：nginx 自己占着或没人占 → 直接听 443；前面有 stream 前门 → 只听前门后面的本机地址（比如 127.0.0.1:8443），
//        往前门的 map 里加一行"这个域名 → 那个地址"；前门开了 proxy_protocol 就按它拿真实 IP；
//      - 80：nginx 占着或没人占 → webroot 签证书（不停任何东西）；别的程序占着 → standalone，签的时候临时停它、签完拉起来
//        （先单独告诉你、问你；trap 保证签失败也拉起来；以后续期也这样停一下）；
//   3. 生成脚本、整份显示、你同意了才跑；脚本开头再核对一遍布局，变了就停；
//   4. 从外面验收：证书是真的、不带凭证进不去（401）；后面接的是二狗的话照 321 分 8810 / 8811，接到 8810 当场撤掉。
// remove 原样撤；certs 列证书和到期日（少于 20 天提醒）；scan 只读扫一遍，把原来就有的站点和证书"认领"进状态文件、不改它们。
import { audit } from '../log.mjs';
import fs from 'node:fs';
import * as st from './state.mjs';
import * as rm from './remote.mjs';
import * as sc from './scripts.mjs';
import { defaultDomain, validDomain, validEmail, CERT_WARN_DAYS } from './certs.mjs';
import { parseCheckup } from './checkup.mjs';
import { SITE_NAME, siteFile } from './nginx.mjs';
import { parseDump, httpServers, frontdoor, frontdoorBackend, mapLineOk } from './nginxconf.mjs';
import { verifySite } from './verify.mjs';
import { exposuresOf8810 } from './local.mjs';
import { resolveVps, ensureLogin, checkup, showAndConfirm, saveScript, runOnVps, int } from './setup.mjs';
import { fetchCerts, saveCertSnapshot, loadCertSnapshot, certAlerts, daysLeft, snapshotFromOutput } from './certwatch.mjs';

const UNIT = /^[A-Za-z0-9@._-]+\.service$/;
/** 停了会连带停掉别的东西的单元：不替你停 */
const NEVER_STOP = /^(docker|containerd|ssh|sshd|systemd-[a-z-]+|dbus|networking|NetworkManager)\.service$/;
const BACKEND = /^127\.0\.0\.1:\d{1,5}$/;
const NGINX_PATH = /^\/etc\/nginx\/[A-Za-z0-9._/-]+$/;

/** 新 VPS 的布局（--print-script 登不进去体检时按它生成；脚本开头会核对，不一样就停） */
export const FRESH_LAYOUT = { kind: 'direct', listen: '443 ssl', clientAddress: '$remote_addr', http80: true, certHow: 'webroot', stopUnits: [], noStartInstall: false, frontdoor: null };

/** 体检输出里 nginx -T 那一段（每行带 ERGO-NGX| 前缀）→ 解析好的配置 */
export function nginxFromOutput(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.startsWith('ERGO-NGX|')).map((l) => l.slice('ERGO-NGX|'.length));
  return parseDump(lines.join('\n'));
}

/**
 * 看布局，定怎么加这个站点。kv 是体检的键值，nginx 是 nginxFromOutput 的结果。
 * opts.stopUnit：80 被别的程序占着时要临时停的单元（不给就用体检认出来的）；opts.frontdoorBackend：前门后面的站点地址（认不出来时手给）。
 * 返回布局字段 + blocking / warnings / info（并进体检结果一起显示）。
 */
export function decideLayout(kv, nginx, plan, opts = {}) {
  const blocking = [], warnings = [], info = [];
  const L = { ...FRESH_LAYOUT, stopUnits: [] };
  const who80 = kv.LISTEN_TCP_80 || '';
  const who443 = kv.LISTEN_TCP_443 || '';
  const haveCert = Number(kv.CERT_LEFT) >= 0;
  const fd = frontdoor(nginx.tree);

  // ---- 443
  if (fd || kv.NGINX_STREAM_443 === '1') {
    if (!fd || !fd.ok) {
      blocking.push(`443 前面有 stream 前门，可看不懂它（${fd?.why || '没找到 ssl_preread on 的 server'}）：这一版只会往「map $ssl_preread_server_name $变量 { 域名 去向; }」这种前门里加一行。`
        + '要么自己在前门里把这个域名指到前门后面的 nginx，要么见 docs/vps-https.md 的「443 前面已经有前门」');
    } else {
      const backend = opts.frontdoorBackend || frontdoorBackend(nginx.tree, fd);
      const hit = fd.entries.find((e) => e.name === plan.domain);
      if (!backend) blocking.push('认不出前门后面的 nginx 站点听哪个地址（http 里没有 listen 127.0.0.1:<端口> … ssl 的站点）：用 --frontdoor-backend 127.0.0.1:8443 指定');
      else if (!BACKEND.test(backend)) blocking.push(`前门后面的地址只认 127.0.0.1:<端口>：${backend}`);
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fd.mapVar) || !NGINX_PATH.test(fd.mapFile)) blocking.push(`前门的 map（${fd.mapFile} 里的 $${fd.mapVar}）名字或路径太怪，没动它`);
      else if (!hit && !mapLineOk(nginx.files, fd)) blocking.push(`前门 ${fd.mapFile} 的「map $ssl_preread_server_name $${fd.mapVar} {」没写在一行里，脚本找不到地方加：请自己在 map 里加一行「${plan.domain} ${backend};」再重跑`);
      else if (hit && hit.to !== backend) blocking.push(`前门里 ${plan.domain} 已经指到 ${hit.to}（不是前门后面的 nginx ${backend}），没动它`);
      else {
        L.kind = 'frontdoor';
        L.listen = `${backend} ssl${fd.proxyProtocol ? ' proxy_protocol' : ''}`;
        L.clientAddress = fd.proxyProtocol ? '$proxy_protocol_addr' : '$remote_addr';
        L.frontdoor = { file: fd.mapFile, mapVar: fd.mapVar, backend, proxyProtocol: fd.proxyProtocol, routed: !!hit };
        info.push(`443 前面有 stream 前门（${fd.mapFile}）：新站点只听 ${backend}，不抢 443；前门的 map 里${hit ? '已经有' : '加一行'}「${plan.domain} → ${backend}」`);
        if (fd.proxyProtocol) info.push('前门开了 proxy_protocol：新站点的 listen 带上 proxy_protocol，访客的真实 IP 用 $proxy_protocol_addr');
        else {
          warnings.push('前门没开 proxy_protocol：这个站点看到的访客 IP 都是 127.0.0.1（真实 IP 传不过来，按 IP 限频的服务所有人挤一个桶）。'
            + '要真实 IP 得在前门开 proxy_protocol、同时给前门后面每个站点的 listen 加 proxy_protocol——会动到你别的站点，这里不替你改，见 docs/vps-https.md');
        }
      }
    }
  } else if (who443 && who443 !== 'nginx') {
    blocking.push(`443 被 ${who443} 占着：nginx 听不了 443。这一版只会在 nginx 自己占着 443（或者没人占）、或者 443 前面是 nginx 的 stream 前门时加站点`);
  }

  // ---- 80
  if (who80 && who80 !== 'nginx') {
    L.http80 = false;
    L.noStartInstall = kv.PKG_NGINX !== '1';
    if (haveCert) {
      L.certHow = 'existing';
      info.push(`80 被 ${who80} 占着，${plan.domain} 的证书原来就有（还剩 ${kv.CERT_LEFT} 天）：不签、不停它；站点不写 80 端口那段`);
    } else {
      const unit = opts.stopUnit || kv.LISTEN_TCP_80_UNIT || '';
      if (!unit) {
        blocking.push(`80 被 ${who80} 占着，认不出它是哪个 systemd 服务（docker 容器之类）：没法替你临时停它签证书。自己停掉它再跑，或者用 --stop-unit <单元名> 指定`);
      } else if (!UNIT.test(unit)) {
        blocking.push(`--stop-unit 要写 systemd 单元的全名（比如 apache2.service）：${unit}`);
      } else if (NEVER_STOP.test(unit)) {
        blocking.push(`80 被 ${who80}（${unit}）占着：停它会连带停掉别的东西，没替你停。把占 80 的那个挪开，或者用自己的域名走 DNS 验证另签证书`);
      } else {
        L.certHow = 'standalone';
        L.stopUnits = [unit];
        info.push(`80 被 ${who80}（${unit}）占着：证书用 standalone 签，签的时候临时停它、签完拉起来；站点不写 80 端口那段`);
        if (L.noStartInstall) info.push('装 nginx 时不让它马上起（它自带的 default 站点听 80，会起不来），装完拿掉 default 站点');
      }
    }
  } else if (haveCert) {
    L.certHow = 'existing';
    info.push(`${plan.domain} 的证书原来就有（还剩 ${kv.CERT_LEFT} 天）：不签；撤的时候也不删它`);
  }
  return { ...L, blocking, warnings, info };
}

/** 站点在状态文件里记些什么（不记钥匙、不记密码） */
function siteRecord(plan) {
  const L = plan.layout || null;
  return {
    name: plan.name, domain: plan.domain, upstreamPort: plan.upstreamPort, email: plan.email, site: plan.site, public: plan.public,
    ...(L ? {
      layout: { kind: L.kind, listen: L.listen, clientAddress: L.clientAddress, http80: L.http80, certHow: L.certHow, stopUnits: L.stopUnits },
      frontdoor: L.frontdoor ? { file: L.frontdoor.file, mapVar: L.frontdoor.mapVar, backend: L.frontdoor.backend, proxyProtocol: L.frontdoor.proxyProtocol } : null,
    } : {}),
  };
}

/** 这个域名是不是已经被别的占了：setup 的方式、别的站点、认领的站点 */
export function domainTaken(state, domain, name) {
  for (const [mode, rec] of Object.entries(state.modes || {})) if (rec?.domain === domain) return `${domain} 已经是 lsm vps setup ${mode} 用的域名`;
  for (const [n, rec] of Object.entries(state.sites || {})) if (n !== name && rec?.domain === domain) return `${domain} 已经是站点 ${n} 的域名`;
  const c = (state.claimed?.sites || []).find((s) => (s.serverNames || []).includes(domain));
  if (c) return `${domain} 在 VPS 上已经有站点了（${c.file}，lsm vps scan 认领的）——那是你原来配的，没动它`;
  return null;
}

/** 这次要加的站点：命令行给的 > 状态文件里上次记的 > 默认。--port 是站点后面那个服务的端口（ssh 端口用 --ssh-port）。 */
export async function buildSitePlan(name, opts, state, exec) {
  if (!SITE_NAME.test(String(name || ''))) throw new Error(`站点名只能是小写字母、数字和连字符（最长 40）：${JSON.stringify(name)}`);
  const prev = state.sites?.[name] || {};
  const { vps, publicIp } = await resolveVps(opts, state, exec, opts.sshPort);
  if (opts.port == null && prev.upstreamPort == null) throw new Error(`要告诉我站点后面那个服务在 VPS 上听哪个端口：lsm vps site add ${name} --port <端口>`);
  const upstreamPort = int(opts.port ?? prev.upstreamPort, '站点后面那个服务的端口');
  if ([80, 443].includes(upstreamPort)) throw new Error(`站点后面那个服务的端口不能是 ${upstreamPort}（那是 nginx 自己要听的）`);
  const domain = String(opts.domain || prev.domain || defaultDomain(name, publicIp)).toLowerCase();
  if (!validDomain(domain)) throw new Error(`域名不对：${domain}`);
  if (prev.domain && prev.domain !== domain) throw new Error(`站点 ${name} 上次用的是 ${prev.domain}。换域名先 lsm vps site remove ${name}，再用新域名重加`);
  const taken = domainTaken(state, domain, name);
  if (taken) throw new Error(taken);
  const email = opts.email ?? prev.email ?? '';
  if (email && !validEmail(email)) throw new Error(`邮箱不对：${email}`);
  return { mode: 'site', name, vps, publicIp, domain, site: siteFile(name), upstreamPort, email, public: !!(opts.public ?? prev.public) };
}

const pickLayout = (ck) => ({
  kind: ck.kind, listen: ck.listen, clientAddress: ck.clientAddress, http80: ck.http80, certHow: ck.certHow,
  stopUnits: ck.stopUnits, noStartInstall: ck.noStartInstall, frontdoor: ck.frontdoor,
});

async function readCheckupQuietly(ctx, plan, keys, opts) {
  const r = await rm.runScript(ctx.exec, plan.vps, keys, sc.checkupScript(plan, { now: ctx.now(), nginxDump: true }), { timeout: 120000 });
  const kv = parseCheckup(r.out);
  return kv ? decideLayout(kv, nginxFromOutput(r.out), plan, opts) : null;
}

/** 从外面验收；接到了二狗的 8810 就当场把站点撤掉（不留一个整个公网免认证的入口） */
async function siteAcceptance(ctx, plan, state, keys, adminPub) {
  const { exec, io } = ctx;
  const url = `https://${plan.domain}/`;
  const v = await verifySite(exec, url, { isPublic: plan.public });
  const leaks = exposuresOf8810();
  const problems = [...(v.ok ? [] : [v.why]), ...leaks.map((l) => `会把二狗的本机端口 8810 接出去：${l}`)];
  io.say('');
  io.say('验收（从外面打一遍，不带任何凭证）：');
  if (v.cert?.notAfter) io.say(`  ✓ 证书是真的（${v.cert.issuer || '公认的 CA'} 签的，到 ${new Date(v.cert.notAfter).toISOString().slice(0, 10)}）`);
  if (v.ok) io.say(`  ✓ ${v.why}`);
  for (const p of problems) io.say(`  ✗ ${p}`);
  if (v.verdict === 'local') {
    io.say(`  站点后面接到了二狗的本机端口 8810：当场撤掉这个站点（lsm vps site remove ${plan.name} 那份脚本）……`);
    const script = sc.removeScript('site', { ...siteRecord(plan), certOurs: state.sites[plan.name]?.certOurs }, { vps: plan.vps, adminPubkey: adminPub, revokeAdmin: false, now: ctx.now() });
    const r = await runOnVps(ctx, state, keys, script);
    const done = r.code === 0 && r.parsed.done.includes('remove');
    io.say(done ? '  已撤掉。' : `  ✗ 没撤掉：${r.parsed.failure || r.err.trim().split(/\r?\n/).pop()}——赶紧自己撤：lsm vps site remove ${plan.name}`);
    if (done) { delete state.sites[plan.name]; st.remember(state, { action: 'site-remove', site: plan.name, ok: true, why: '验收认出接到了 8810，当场撤掉' }, ctx.now()); }
  }
  return { ok: problems.length === 0, verdict: v.verdict || null, why: problems.length ? problems.join('；') : v.why, at: ctx.now().toISOString() };
}

export async function siteAdd(name, opts, ctx) {
  const { io, exec } = ctx;
  let state, plan;
  try {
    state = st.loadState();
    plan = await buildSitePlan(name, opts, state, exec);
    const other = st.sameVpsOrWhy(state, plan.vps);
    if (other) throw new Error(other);
  } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  const keys = rm.keyPaths();
  let adminPub;
  try { adminPub = (await rm.ensureKey(exec, keys.admin, rm.ADMIN_COMMENT)).publicKey; } catch (e) { io.say(`✗ ${e.message}`); return 1; }

  if (opts.printScript) {
    // 能登进去就先只读体检定布局；登不进去按新 VPS 的布局生成（脚本开头会核对，布局不一样就停下）
    let layout = null;
    if ((await rm.canLogin(exec, plan.vps, keys)).ok) layout = await readCheckupQuietly(ctx, plan, keys, opts);
    if (layout?.blocking.length) { for (const b of layout.blocking) io.say(`✗ ${b}`); return 1; }
    io.say(sc.siteAddScript({ ...plan, layout: layout ? pickLayout(layout) : FRESH_LAYOUT, layoutAssumed: !layout }, { now: ctx.now() }));
    return 0;
  }

  io.say(`站点 ${name}：https://${plan.domain} → VPS 本机的 127.0.0.1:${plan.upstreamPort}（${rm.target(plan.vps)}，ssh ${plan.vps.port}）`);
  const login = await ensureLogin(ctx, plan, keys, adminPub, opts);
  if (!login.ok) { io.say(`✗ 登不进 VPS：${login.why}`); return 1; }
  io.say('✓ 管理用的钥匙能登进 VPS');

  const ck = await checkup(ctx, plan, state, keys, { nginxDump: true, more: (kv, out) => decideLayout(kv, nginxFromOutput(out), plan, opts) });
  state.vps = { user: plan.vps.user, host: plan.vps.host, port: plan.vps.port, publicIp: plan.publicIp };
  const prev = state.sites[name] || {};
  state.sites[name] = { ...prev, ...siteRecord(plan), phase: prev.phase || 'planned', startedAt: prev.startedAt || ctx.now().toISOString(), lastCheckup: ck.record };
  st.saveState(state);
  if (!ck.ok) { io.say(''); io.say('✗ 有挡路的，没往上装。处理完重跑同一条命令。'); return 1; }
  plan.layout = pickLayout(ck);
  Object.assign(state.sites[name], siteRecord(plan));

  if (plan.layout.certHow === 'standalone') {
    const unit = plan.layout.stopUnits[0];
    io.say('');
    io.say(`! 签证书要用 80 端口，可 80 现在被 ${unit} 占着。动手前先说清楚：`);
    io.say(`  签的时候先停它（systemctl stop ${unit}），签完马上拉起来——一般十几秒到一分钟，这段时间它提供的服务会断一下；`);
    io.say('  签失败也会拉起来（脚本里用 trap 兜着）。以后 certbot 每次自动续期（大约每 60 天一次）也会这样停一下、续完拉起来。');
    const ok = await io.confirm(`同意签证书时临时停 ${unit}？`, { yes: opts.yes });
    if (!ok) { io.say('没执行。不想停它的话：把它挪离 80 端口再来，或者用自己的域名走 DNS 验证另签证书。'); st.saveState(state); return 1; }
  }

  const script = sc.siteAddScript(plan, { now: ctx.now() });
  const file = saveScript(`site-${name}-add.sh`, script);
  const yes = await showAndConfirm(io, opts, { title: `lsm vps site add ${name}`, script, file });
  if (!yes) { io.say('没执行。'); st.saveState(state); return 1; }
  audit('vps-site-add-run', { site: name, host: plan.vps.host, domain: plan.domain, layout: plan.layout.kind, certHow: plan.layout.certHow });
  io.say('');
  io.say('在 VPS 上执行……');
  const r = await runOnVps(ctx, state, keys, script);
  const done = r.code === 0 && r.parsed.done.includes('site');
  Object.assign(state.sites[name], {
    phase: done ? 'vps-done' : 'vps-failed',
    steps: Object.fromEntries(r.parsed.steps.map((s) => [s.step, s.status])),
    lastRun: { at: ctx.now().toISOString(), ok: done, failure: done ? null : (r.parsed.failure || (r.err || '').trim().split(/\r?\n/).pop() || `退出码 ${r.code}`) },
    ...(r.parsed.results.CERT_OURS != null ? { certOurs: r.parsed.results.CERT_OURS === '1' } : {}),
  });
  st.remember(state, { action: 'site-add', site: name, ok: done }, ctx.now());
  st.saveState(state);
  if (!done) {
    io.say('');
    io.say(`✗ VPS 上没做完：${state.sites[name].lastRun.failure}`);
    io.say('  做过的步骤 VPS 上都记着（nginx -t 不过的已经换回原样、临时停的服务已经拉起来）；处理完重跑同一条命令，会从断的地方接着做。');
    return 1;
  }
  io.say('✓ VPS 那一半做完了');

  const acc = await siteAcceptance(ctx, plan, state, keys, adminPub);
  if (state.sites[name]) {
    Object.assign(state.sites[name], { phase: acc.ok ? 'verified' : 'verify-failed', lastVerify: acc, ...(acc.ok ? { verifiedAt: acc.at } : {}) });
  }
  st.remember(state, { action: 'site-verify', site: name, ok: acc.ok, verdict: acc.verdict }, ctx.now());
  st.saveState(state);
  audit('vps-site-verify', { site: name, domain: plan.domain, ok: acc.ok, verdict: acc.verdict });
  if (!acc.ok) { io.say(''); io.say('✗ 验收没过（见上面）。'); return 1; }
  io.say('');
  io.say(`✓ 站点 ${name} 加好了：https://${plan.domain}`);
  io.say(`  撤掉：lsm vps site remove ${name}；证书哪天到期：lsm vps certs（少于 ${CERT_WARN_DAYS} 天会标出来）`);
  return 0;
}

export async function siteRemove(name, opts, ctx) {
  const { io } = ctx;
  let state;
  try { state = st.loadState(); } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  const rec = state.sites?.[name];
  if (!rec || !state.vps) {
    const c = (state.claimed?.sites || []).find((s) => s.serverNames?.includes(name) || s.file?.endsWith(`/${name}`) || s.file?.endsWith(`/${name}.conf`));
    if (c) { io.say(`✗ ${name} 是 lsm vps scan 认领的站点（${c.file}）——你原来配的，不归这里撤。`); return 1; }
    io.say(`状态文件里没有站点 ${name} 的记录，没什么可撤的。`);
    return 0;
  }
  const last = st.othersLeft(state, { site: name }) === 0;
  const keys = rm.keyPaths();
  let adminPub = '';
  try { adminPub = rm.readPublicKey(keys.admin); } catch { /* 钥匙没了也照样能显示脚本 */ }
  const script = sc.removeScript('site', { ...rec, name }, { vps: state.vps, adminPubkey: adminPub, revokeAdmin: last, now: ctx.now() });
  const file = saveScript(`site-${name}-remove.sh`, script);
  const extra = last ? ['这是这台 VPS 上归服务管家管的最后一样：撤完后管理用的钥匙、主机指纹也一起删，状态文件里只留历史。'] : [];
  const yes = await showAndConfirm(io, opts, { title: `lsm vps site remove ${name}`, script, file, extra });
  if (!yes) { io.say('没执行。'); return 1; }
  audit('vps-site-remove-run', { site: name, host: state.vps.host, domain: rec.domain });
  io.say('');
  io.say('在 VPS 上执行……');
  const r = await runOnVps(ctx, state, keys, script);
  const done = r.code === 0 && r.parsed.done.includes('remove');
  if (!done) {
    Object.assign(rec, { phase: 'remove-failed', lastRun: { at: ctx.now().toISOString(), ok: false, failure: r.parsed.failure || (r.err || '').trim().split(/\r?\n/).pop() || `退出码 ${r.code}` } });
    st.remember(state, { action: 'site-remove', site: name, ok: false }, ctx.now());
    st.saveState(state);
    io.say(`✗ VPS 上没撤完：${rec.lastRun.failure}。重跑同一条命令接着撤。`);
    return 1;
  }
  delete state.sites[name];
  if (last) {
    for (const f of [keys.admin, `${keys.admin}.pub`, keys.knownHosts]) fs.rmSync(f, { force: true });
    state.vps = null;
  }
  st.remember(state, { action: 'site-remove', site: name, ok: true, domain: rec.domain }, ctx.now());
  st.saveState(state);
  io.say(`✓ 站点 ${name} 撤掉了（${rec.domain}）`);
  return 0;
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** lsm vps certs：列证书和到期日（只读）；少于 20 天提醒。结果也存进 vps-certs.json，管理器的网页和通知用它。 */
export async function certs(opts, ctx) {
  const { io, exec } = ctx;
  let state;
  try { state = st.loadState(); } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  if (!state.vps) {
    io.say('还没有 VPS 的记录：先 lsm vps scan --host root@<IP>（认领 VPS 上原来就有的站点和证书），或者用 lsm vps setup / site add 搭过。');
    return 1;
  }
  io.say(`VPS ${rm.target(state.vps)}（ssh ${state.vps.port}）上的证书（只读）：`);
  const snap = await fetchCerts(exec, state, { now: ctx.now(), previous: loadCertSnapshot() });
  saveCertSnapshot(snap);
  if (!snap.ok) { io.say(`✗ 登不进 VPS 看：${snap.why}`); return 1; }
  const now = ctx.now().getTime();
  if (!snap.certs.length) io.say('  （一张证书都没有）');
  const sorted = snap.certs.toSorted((a, b) => (a.notAfter ?? 0) - (b.notAfter ?? 0));
  for (const c of sorted) {
    const d = daysLeft(c.notAfter, now);
    const mark = d == null ? '?' : d < 0 ? '✗' : d < CERT_WARN_DAYS ? '!' : '✓';
    const left = d == null ? '读不出到期日' : d < 0 ? `已经过期 ${-d} 天` : `还剩 ${d} 天`;
    io.say(`  ${mark} ${c.name}  ${c.notAfter ? `${ymd(c.notAfter)} 到期，` : ''}${left}${c.owner ? `  · ${c.owner}` : c.kind === 'file' ? '  · 不是 Let\'s Encrypt 的，自己续' : ''}`);
  }
  const alerts = certAlerts(snap, now);
  if (alerts.length) {
    io.say('');
    for (const a of alerts) io.say(`  ! ${a.text}`);
  }
  io.say('');
  io.say(`少于 ${CERT_WARN_DAYS} 天的标了 !（结果存在数据目录的 vps-certs.json）。`);
  return alerts.length ? 1 : 0;
}

/** scan 的输出 → 站点、前门、证书（哪些是 lsm 装的、哪些是你原来配的） */
export function describeScan(text, state = null) {
  const nginx = nginxFromOutput(text);
  const fd = frontdoor(nginx.tree);
  const sites = httpServers(nginx.tree).map((s) => {
    const base = String(s.file).split('/').pop();
    const ours = /^ergo-(vps|site)-/.test(base);
    const isDefault = !s.serverNames.length || s.serverNames.every((n) => n === '_' || n === '""' || n === '');
    return { ...s, ours, isDefault };
  });
  const snap = snapshotFromOutput(text, { state });
  return { sites, frontdoor: fd, certs: snap.certs };
}

/** lsm vps scan：只读扫一遍 VPS 上已有的站点和证书，认领进状态文件（不改它们）。 */
export async function scan(opts, ctx) {
  const { io, exec } = ctx;
  let state, vps, publicIp;
  try {
    state = st.loadState();
    ({ vps, publicIp } = await resolveVps(opts, state, exec, opts.sshPort ?? opts.port));
    const other = st.sameVpsOrWhy(state, vps);
    if (other) throw new Error(other);
  } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  const keys = rm.keyPaths();
  let adminPub;
  try { adminPub = (await rm.ensureKey(exec, keys.admin, rm.ADMIN_COMMENT)).publicKey; } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  const script = sc.scanScript(vps, { now: ctx.now() });
  if (opts.printScript) { io.say(script); return 0; }
  const login = await ensureLogin(ctx, { vps }, keys, adminPub, opts);
  if (!login.ok) { io.say(`✗ 登不进 VPS：${login.why}`); return 1; }
  io.say(`只读扫一遍 ${rm.target(vps)}（不装、不改、不 reload；要先看脚本：lsm vps scan --print-script）……`);
  const r = await rm.runScript(exec, vps, keys, script, { timeout: 120000 });
  if (!/^ERGO-SCAN=1$/m.test(r.out)) { io.say(`✗ 扫描脚本没跑起来：${(r.err || r.out).trim().split(/\r?\n/).pop() || `退出码 ${r.code}`}`); return 1; }
  const found = describeScan(r.out, state);
  const now = ctx.now().getTime();
  const certOf = (s) => found.certs.find((c) => (c.path && c.path === s.certificate) || (s.certificate || '').includes(`/live/${c.name}/`));
  const claim = found.sites.filter((s) => !s.ours && !s.isDefault);
  io.say('');
  io.say(`站点（nginx，${found.sites.length} 个 server）：`);
  if (!found.sites.length) io.say('  （没有：nginx 没装，或者一个站点都没配）');
  for (const s of found.sites) {
    const c = certOf(s);
    const d = c ? daysLeft(c.notAfter, now) : null;
    const tag = s.ours ? '（lsm 装的）' : s.isDefault ? '（默认站点）' : '（认领）';
    io.say(`  · ${s.serverNames.join(' ') || '（没写 server_name）'} ${tag}  listen ${s.listen.join(' / ') || '?'}${s.proxyPass.length ? `  → ${s.proxyPass.join('、')}` : s.returns ? `  return ${s.returns}` : ''}`
      + `${s.certificate ? `  证书${d == null ? '（读不出到期日）' : d < 0 ? `已过期 ${-d} 天` : `还剩 ${d} 天`}` : ''}  [${s.file}]`);
  }
  if (found.frontdoor) {
    const fd = found.frontdoor;
    io.say('');
    io.say(fd.ok
      ? `443 前面有 stream 前门（${fd.mapFile}，map $${fd.mapVar}，${fd.proxyProtocol ? '开了' : '没开'} proxy_protocol）：${fd.entries.map((e) => `${e.name} → ${e.to}`).join('、') || '（没有按域名的条目）'}${fd.default ? `；默认 → ${fd.default}` : ''}`
      : `443 前面有 stream 前门，但看不懂：${fd.why}`);
  }
  io.say('');
  io.say(`证书（${found.certs.length} 张）：`);
  for (const c of found.certs) {
    const d = daysLeft(c.notAfter, now);
    io.say(`  · ${c.name}  ${c.notAfter ? `${ymd(c.notAfter)} 到期（${d < 0 ? `已过期 ${-d} 天` : `还剩 ${d} 天`}）` : '读不出到期日'}`);
  }
  state.vps = state.vps || { user: vps.user, host: vps.host, port: vps.port, publicIp };
  state.claimed = {
    at: ctx.now().toISOString(),
    sites: claim.map((s) => ({ file: s.file, serverNames: s.serverNames, listen: s.listen, proxyPass: s.proxyPass, certificate: s.certificate })),
    certs: found.certs.filter((c) => !c.owner || c.owner.startsWith('认领')).map((c) => ({ kind: c.kind, name: c.name, path: c.path || null })),
    frontdoor: found.frontdoor?.ok ? { file: found.frontdoor.mapFile, mapVar: found.frontdoor.mapVar, proxyProtocol: found.frontdoor.proxyProtocol, entries: found.frontdoor.entries } : null,
  };
  st.remember(state, { action: 'scan', ok: true, sites: claim.length, certs: found.certs.length }, ctx.now());
  st.saveState(state);
  saveCertSnapshot(snapshotFromOutput(r.out, { state, host: vps.host, now }));
  audit('vps-scan', { host: vps.host, sites: claim.length, certs: found.certs.length });
  io.say('');
  io.say(`✓ 认领了 ${claim.length} 个站点、${state.claimed.certs.length} 张证书进状态文件（只记下来盯到期日，VPS 上一样没改；lsm vps site remove 不会撤它们）。`);
  io.say('  证书到期：lsm vps certs（少于 20 天标出来）。');
  return 0;
}
