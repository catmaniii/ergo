// `lsm vps setup | status | remove | approve` 的步骤（321 号票）。CLI 和测试共用：
// 外部命令、端口、https 都经执行层（exec），问你的话经 io，服务管家的启停经 lsm——测试三样都换成假的。
//
// setup 的顺序：
//   1. 定 VPS 地址、域名（默认 <名字>.<IP>.sslip.io）；本机生成专用钥匙；
//   2. 钥匙登不进去就打印那一句让你自己把公钥放上去（密码只进 ssh 自己的提示），等你放好；
//   3. 体检（只读）+ 从电脑上连 VPS 的端口：有挡路的就停，端口不通就告诉你去安全组放行哪几个；
//   4. 生成要在 VPS 上跑的脚本，整份显示（另存一份），你同意了才经 ssh 送上去跑；
//   5. 电脑这一半：隧道 → 在服务管家里登记并起隧道服务；headscale → 电脑加入 tailnet、打印手机加入的步骤；
//   6. 验收：证书是真的、没配对的进不去、接的是 8811 不是 8810；
//   7. 每一步的结果记进状态文件（数据目录的 vps-setup.json）。断了重跑同一条命令，VPS 上做过的跳过、接着做。
import fs from 'node:fs';
import path from 'node:path';
import { VPS_SCRIPTS_DIR } from '../paths.mjs';
import { audit } from '../log.mjs';
import { DEFAULT_CLI, DEFAULT_RECORDS } from '../tailnet.mjs';
import * as st from './state.mjs';
import * as rm from './remote.mjs';
import * as sc from './scripts.mjs';
import { defaultDomain, validDomain, validEmail, parseCertLines, certSummary } from './certs.mjs';
import { parseCheckup, assessCheckup, probePorts, portWarnings, neededPorts, portsText } from './checkup.mjs';
import { verifyErgo, verifyHeadscale, localPortProblem, ERGO_EXTERNAL_PORT } from './verify.mjs';
import * as hs from './headscale.mjs';
import { writeTunnelService, deleteTunnelService, exposuresOf8810, fillErgoExposure, clearErgoExposure, ERGO_DAEMON_ID } from './local.mjs';

export const DEFAULTS = {
  tunnel: { name: 'ergo', site: 'ergo-vps-tunnel', account: 'ergo-tunnel', remotePort: 18811, localPort: ERGO_EXTERNAL_PORT, serviceId: 'ergo-vps-tunnel' },
  headscale: { name: 'hs', site: 'ergo-vps-headscale', hsPort: hs.HEADSCALE_PORT, hsVersion: hs.HEADSCALE_VERSION, hsUser: hs.HEADSCALE_USER, derp: true },
};
const MODE_NAME = { tunnel: '隧道入口', headscale: '自建 tailnet（headscale）' };

export const int = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${what}不对：${v}`);
  return n;
};

/** VPS 在哪：命令行的 --host > 状态文件里记的；sshPort 是命令行给的 ssh 端口。返回 { vps, publicIp } */
export async function resolveVps(opts, state, exec, sshPort) {
  const hostInput = opts.host ?? (state.vps ? `${state.vps.user}@${state.vps.host}` : null);
  if (!hostInput) throw new Error('要告诉我 VPS 的地址：--host root@203.0.113.10');
  const vps = rm.parseHost(hostInput, { port: sshPort ?? (opts.host ? undefined : state.vps?.port) });
  let publicIp = rm.isIPv4(vps.host) ? vps.host : null;
  if (!publicIp) {
    const ips = await exec.resolve4(vps.host);
    if (!ips.length) throw new Error(`${vps.host} 解析不到 IPv4 地址`);
    publicIp = ips[0];
  }
  return { vps, publicIp };
}

/** 这次要搭的东西：命令行给的 > 状态文件里上次记的 > 默认。 */
export async function buildPlan(mode, opts, state, exec) {
  if (!st.MODES.includes(mode)) throw new Error(`只有 headscale 和 tunnel 两种：${mode}`);
  const prev = state.modes[mode] || {};
  const { vps, publicIp } = await resolveVps(opts, state, exec, opts.port ?? opts.sshPort);
  const d = DEFAULTS[mode];
  if (opts.name != null && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(opts.name)) throw new Error(`--name 只能是小写字母、数字和连字符：${opts.name}`);
  const domain = String(opts.domain || prev.domain || defaultDomain(opts.name || d.name, publicIp)).toLowerCase();
  if (!validDomain(domain)) throw new Error(`域名不对：${domain}`);
  if (prev.domain && prev.domain !== domain) {
    throw new Error(`上次在 ${prev.domain} 上搭的${MODE_NAME[mode]}还在。换域名先 lsm vps remove ${mode}，再用新域名重搭`);
  }
  const email = opts.email ?? prev.email ?? '';
  if (email && !validEmail(email)) throw new Error(`邮箱不对：${email}`);
  const plan = { mode, vps, publicIp, domain, email, site: d.site };
  if (mode === 'tunnel') {
    plan.account = d.account;
    plan.remotePort = int(opts.remotePort ?? prev.remotePort ?? d.remotePort, 'VPS 上隧道的端口');
    plan.localPort = int(opts.localPort ?? prev.localPort ?? d.localPort, '电脑上隧道接的端口');
    const p = localPortProblem(plan.localPort);
    if (p) throw new Error(p);
    if (plan.remotePort < 1024) throw new Error('VPS 上隧道的端口要 ≥ 1024');
    plan.serviceId = opts.serviceId ?? prev.serviceId ?? d.serviceId;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(plan.serviceId)) throw new Error(`--service-id 不对：${plan.serviceId}`);
  } else {
    plan.hsPort = int(opts.hsPort ?? prev.hsPort ?? d.hsPort, 'headscale 的端口');
    plan.hsVersion = opts.hsVersion ?? prev.hsVersion ?? d.hsVersion;
    if (!/^\d+\.\d+\.\d+$/.test(plan.hsVersion)) throw new Error(`headscale 版本号不对：${plan.hsVersion}`);
    plan.hsUser = d.hsUser;
    plan.derp = opts.derp ?? prev.derp ?? d.derp;
    plan.hsMirror = hs.normalizeMirror(opts.hsMirror ?? prev.hsMirror ?? '');
  }
  return plan;
}

/** 状态文件里这一种方式记些什么（不记钥匙、不记密码） */
function modeRecord(plan) {
  const keep = ['domain', 'email', 'site', 'account', 'remotePort', 'localPort', 'serviceId', 'hsPort', 'hsVersion', 'hsUser', 'derp', 'hsMirror'];
  return Object.fromEntries(keep.filter((k) => plan[k] !== undefined).map((k) => [k, plan[k]]));
}

/** 按行显示脚本的输出（藏起一次性钥匙；一行没收全先攒着） */
export function lineSink(io) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) io.say(`  │ ${sc.maskSecrets(l)}`);
    },
    flush() { if (buf) io.say(`  │ ${sc.maskSecrets(buf)}`); buf = ''; },
  };
}

export function saveScript(name, text) {
  fs.mkdirSync(VPS_SCRIPTS_DIR, { recursive: true });
  const file = path.join(VPS_SCRIPTS_DIR, name);
  fs.writeFileSync(file, text, 'utf-8');
  return file;
}

/** 显示整份脚本、另存一份，问你同不同意。 */
export async function showAndConfirm(io, opts, { title, script, file, extra = [] }) {
  io.say('');
  io.say(`──────── 要在 VPS 上跑的脚本（${title}），全文如下 ────────`);
  for (const l of script.split('\n')) io.say(l);
  io.say('──────── 脚本到此为止 ────────');
  io.say(`（同一份另存在 ${file}，可以用编辑器细看；也可以自己登进 VPS 用 sudo bash 跑它）`);
  for (const l of extra) io.say(l);
  return io.confirm('照这份脚本在 VPS 上执行？', { yes: opts.yes });
}

export async function runOnVps(ctx, state, keys, script) {
  const sink = lineSink(ctx.io);
  const r = await rm.runScript(ctx.exec, state.vps, keys, script, { onData: (s) => sink.push(s) });
  sink.flush();
  return { ...r, parsed: sc.parseOutput(`${r.out}\n${r.err}`) };
}

/** 钥匙登不进去：打印那一句，等你放好（最多试三次）。 */
export async function ensureLogin(ctx, plan, keys, adminPub, opts) {
  const { exec, io } = ctx;
  let r = await rm.canLogin(exec, plan.vps, keys);
  for (let i = 0; !r.ok && i < 3; i++) {
    if (!/钥匙还没放上去/.test(r.why) || opts.yes) return r;
    io.say('');
    io.say(`管理用的钥匙还没放到 VPS 上。在你自己的终端里跑下面这一句（会问一次 VPS 的密码——密码只进 ssh 自己的提示，这个程序不经手、不保存）：`);
    io.say('');
    io.say(`  ${rm.installKeyCommand(plan.vps, adminPub)}`);
    io.say('');
    const a = await io.ask('放好了按回车（输入 q 不搭了）：');
    if (a == null || a.trim().toLowerCase() === 'q') return { ok: false, why: '没放钥匙，不搭了' };
    r = await rm.canLogin(exec, plan.vps, keys);
  }
  return r;
}

/**
 * 体检：VPS 上只读跑一遍 + 从电脑上连端口。返回能不能往下走。
 * site add 用：nginxDump 把 nginx 的配置也要回来，more(kv, 输出全文) 再加一层判断（布局），结果并进来（多出的字段原样带回）。
 */
export async function checkup(ctx, plan, state, keys, { nginxDump = false, more = null } = {}) {
  const { io, exec } = ctx;
  io.say('');
  io.say('体检（只读，什么都不改）……');
  const r = await rm.runScript(exec, plan.vps, keys, sc.checkupScript(plan, { now: ctx.now(), nginxDump }), { timeout: 120000 });
  const kv = parseCheckup(r.out);
  const a = assessCheckup(kv, plan);
  const extra = kv && more ? more(kv, r.out) : {};
  for (const k of ['blocking', 'warnings', 'info']) a[k] = [...a[k], ...(extra[k] || [])];
  const ports = await probePorts(exec, plan);
  const pw = portWarnings(ports);
  for (const l of a.info) io.say(`  · ${l}`);
  for (const l of [...a.warnings, ...pw]) io.say(`  ! ${l}`);
  for (const l of a.blocking) io.say(`  ✗ ${l}`);
  io.say(`  云厂商的安全组 / 防火墙要放行：${portsText(neededPorts(plan))}（程序不替你开，请在控制台里放行）`);
  const record = { at: ctx.now().toISOString(), blocking: a.blocking, warnings: [...a.warnings, ...pw] };
  if (st.MODES.includes(plan.mode)) st.patchMode(state, plan.mode, { lastCheckup: record });
  if (!kv && r.code !== 0) a.blocking.push(`体检脚本跑不起来：${(r.err || r.out).trim().split(/\r?\n/).slice(-2).join(' / ')}`);
  return { ...extra, ...a, ok: a.blocking.length === 0, ports, record };
}

function nextStepsTunnel(io, plan) {
  io.say('');
  io.say(`手机上打开 https://${plan.domain} → 出现配对页 → 在电脑上的二狗里批准这台设备，就能用了。`);
  io.say(`隧道服务是服务管家里的 ${plan.serviceId}（开机自启：lsm autostart ${plan.serviceId} on）。`);
}

function nextStepsHeadscale(io, plan, state, keys) {
  io.say('');
  for (const l of hs.phoneSteps(plan.domain)) io.say(l);
  io.say('');
  io.say('要给本机的服务开 tailnet 入口（只在 tailnet 里能打开的 https 地址），在数据目录的 registry\\manager.yaml 里加上这两段（已经有 vps: 的话只加 host / key 两行）：');
  io.say('');
  io.say('vps:');
  io.say(`  host: ${rm.target(state.vps)}`);
  io.say(`  key: ${JSON.stringify(keys.admin)}`);
  io.say('tailnet:');
  io.say(`  domain: tail.${plan.publicIp}.sslip.io`);
  io.say('  gateway: tailnet-gateway');
  io.say(`  records: ${DEFAULT_RECORDS}`);
  io.say('  certbotStopUnits: [nginx]          # 给 tailnet 入口签证书时临时停 nginx 约 10 秒');
  io.say('');
  io.say(`再登记网关服务（见 README 的「可选功能」），然后 lsm tailnet <服务 id> on。二狗的入口只能接外网端口 ${ERGO_EXTERNAL_PORT}。`);
}

/** 给二狗的登记填 exposure 的结果，说给你听（填不上不算失败：隧道照样能用，只是网页上二狗卡片下面看不到它） */
function sayExposure(io, ex) {
  if (ex.status === 'filled') io.say(`  ✓ 二狗（${ERGO_DAEMON_ID}）的登记填了 exposure：网页上二狗那张卡下面能看到这条隧道（${ex.file}）`);
  else if (ex.status === 'same') io.say(`  ✓ 二狗（${ERGO_DAEMON_ID}）的 exposure 已经指着这条隧道`);
  else if (ex.status === 'no-daemon') io.say(`  · 服务管家里没有 ${ERGO_DAEMON_ID} 的登记，exposure 没填（登记二狗之后重跑 lsm vps setup tunnel --local-only）`);
  else if (ex.status === 'conflict') {
    io.say(`  ! 二狗（${ERGO_DAEMON_ID}）的 exposure ${ex.why}——那是你自己写的，没动它。`);
    io.say(`    要让网页上二狗卡片下面显示这条新隧道，把 ${ex.file} 里的 exposure 段换成：`);
    for (const l of ex.lines) io.say(`      ${l}`);
  } else io.say(`  ! 给二狗（${ERGO_DAEMON_ID}）的登记填 exposure 没成功，已换回原样：${ex.why}`);
}

/** 电脑这一半。返回 { ok, why, join? } */
async function localHalf(ctx, plan, state, keys, results, opts) {
  const { io, exec } = ctx;
  if (plan.mode === 'tunnel') {
    const w = writeTunnelService(plan, keys, ctx.now());
    if (!w.ok) return w;
    io.say(`  ✓ 服务管家里登记了隧道服务 ${plan.serviceId}（${w.changed ? '新写' : '没变'}：${w.file}）`);
    sayExposure(io, fillErgoExposure(plan));
    const lsm = await ctx.lsm();
    const rl = await lsm.reload();
    if (rl && rl.ok === false) return { ok: false, why: `服务管家重新加载注册表失败：${(rl.errors || [rl.why]).join('；')}` };
    if (opts.noStart) { io.say(`  · 没起隧道（--no-start）：lsm start ${plan.serviceId}`); return { ok: true }; }
    const s = await lsm.start(plan.serviceId);
    if (!s?.ok) return { ok: false, why: `隧道服务没起来：${s?.why || '没有响应'}` };
    io.say(`  ✓ 隧道服务 ${plan.serviceId} 起来了`);
    return { ok: true };
  }
  // headscale：电脑加入
  const cli = opts.tailscaleCli || DEFAULT_CLI;
  const node = await hs.localNode(exec, cli);
  const jp = hs.joinPlan(node, plan.domain);
  if (jp.action === 'none') { io.say(`  ✓ 这台电脑${jp.why}`); return { ok: true, joined: true }; }
  if (jp.action === 'install' || jp.action === 'manual' || !results.AUTHKEY) {
    io.say(`  ! 这台电脑没自动加入：${jp.why || '没拿到一次性钥匙（--local-only 时不去 VPS 上要）'}`);
    if (jp.action !== 'install') {
      io.say(`    要加入就自己跑（浏览器登录后照手机第 2、3 步批准）：${hs.manualJoinCommand(cli, plan.domain)}`);
    }
    return { ok: true, joined: false };
  }
  const r = await exec.run(hs.joinArgv(cli, plan.domain, results.AUTHKEY), { timeout: 120000 });
  if (r.code !== 0) return { ok: false, why: `tailscale up 失败：${(r.err || r.out).replaceAll(results.AUTHKEY, '***').trim().split(/\r?\n/).pop()}` };
  io.say(`  ✓ 这台电脑加入了 https://${plan.domain} 的 tailnet`);
  return { ok: true, joined: true };
}

/** 验收。返回 { ok, why, ... }，同时记进状态。 */
async function acceptance(ctx, plan, opts) {
  const { exec, io } = ctx;
  const url = `https://${plan.domain}/`;
  const leaks = exposuresOf8810();
  let v;
  if (plan.mode === 'tunnel') {
    // 隧道刚起，ssh 连上要几秒：没接上就等一会儿再看（最多约 30 秒）
    for (let i = 0; i < (opts.verifyTries ?? 10); i++) {
      v = await verifyErgo(exec, url);
      if (v.verdict !== 'unreachable') break;
      await ctx.sleep(3000);
    }
  } else {
    v = await verifyHeadscale(exec, url);
  }
  const problems = [...(v.ok ? [] : [v.why]), ...leaks.map((l) => `会把二狗的本机端口 8810 接出去：${l}`)];
  const ok = problems.length === 0;
  io.say('');
  io.say('验收：');
  if (v.cert?.notAfter) io.say(`  ✓ 证书是真的（${v.cert.issuer || '公认的 CA'} 签的，到 ${new Date(v.cert.notAfter).toISOString().slice(0, 10)}）`);
  if (v.ok) io.say(`  ✓ ${v.why}`);
  for (const p of problems) io.say(`  ✗ ${p}`);
  return { ok, verdict: v.verdict || null, why: ok ? v.why : problems.join('；'), at: ctx.now().toISOString() };
}

export async function setup(mode, opts, ctx) {
  const { io, exec } = ctx;
  let state;
  let plan;
  try {
    state = st.loadState();
    plan = await buildPlan(mode, opts, state, exec);
    const other = st.sameVpsOrWhy(state, plan.vps);
    if (other) throw new Error(other);
  } catch (e) { io.say(`✗ ${e.message}`); return 1; }

  const keys = rm.keyPaths();
  let adminPub;
  try {
    adminPub = (await rm.ensureKey(exec, keys.admin, rm.ADMIN_COMMENT)).publicKey;
    if (mode === 'tunnel') plan.tunnelPubkey = (await rm.ensureKey(exec, keys.tunnel, rm.TUNNEL_COMMENT)).publicKey;
  } catch (e) { io.say(`✗ ${e.message}`); return 1; }

  const script = mode === 'tunnel'
    ? sc.tunnelSetupScript(plan, { now: ctx.now() })
    : sc.headscaleSetupScript(plan, { now: ctx.now(), wantAuthKey: !opts.localOnly });
  if (opts.printScript) { io.say(script); return 0; }

  io.say(`${MODE_NAME[mode]}：${rm.target(plan.vps)}（ssh ${plan.vps.port}）→ https://${plan.domain}`);
  state.vps = { user: plan.vps.user, host: plan.vps.host, port: plan.vps.port, publicIp: plan.publicIp };
  st.patchMode(state, mode, { ...modeRecord(plan), phase: state.modes[mode]?.phase || 'planned', startedAt: state.modes[mode]?.startedAt || ctx.now().toISOString() });
  st.saveState(state);

  let results = {};
  if (!opts.localOnly) {
    const login = await ensureLogin(ctx, plan, keys, adminPub, opts);
    if (!login.ok) { io.say(`✗ 登不进 VPS：${login.why}`); return 1; }
    io.say('✓ 管理用的钥匙能登进 VPS');

    const ck = await checkup(ctx, plan, state, keys);
    st.saveState(state);
    if (!ck.ok) { io.say(''); io.say('✗ 有挡路的，没往上装。处理完重跑同一条命令。'); return 1; }

    const file = saveScript(`${mode}-setup.sh`, script);
    const extra = mode === 'tunnel'
      ? [`电脑这一半（VPS 上跑完以后）：在服务管家里登记隧道服务 ${plan.serviceId} 并起起来；给二狗（${ERGO_DAEMON_ID}）的登记填 exposure（已经有别的 exposure 就不动，只告诉你）。`]
      : [];
    const yes = await showAndConfirm(io, opts, { title: `lsm vps setup ${mode}`, script, file, extra });
    if (!yes) { io.say('没执行。'); return 1; }
    audit('vps-setup-run', { mode, host: plan.vps.host, domain: plan.domain });
    io.say('');
    io.say('在 VPS 上执行……');
    const r = await runOnVps(ctx, state, keys, script);
    results = r.parsed.results;
    const done = r.code === 0 && r.parsed.done.includes(mode);
    st.patchMode(state, mode, {
      phase: done ? 'vps-done' : 'vps-failed',
      steps: Object.fromEntries(r.parsed.steps.map((s) => [s.step, s.status])),
      lastRun: { at: ctx.now().toISOString(), ok: done, failure: done ? null : (r.parsed.failure || (r.err || '').trim().split(/\r?\n/).pop() || `退出码 ${r.code}`) },
    });
    st.remember(state, { action: 'setup', mode, ok: done }, ctx.now());
    st.saveState(state);
    if (!done) {
      io.say('');
      io.say(`✗ VPS 上没做完：${state.modes[mode].lastRun.failure}`);
      io.say('  做过的步骤 VPS 上都记着；处理完重跑同一条命令，会从断的地方接着做。');
      return 1;
    }
    io.say('✓ VPS 那一半做完了');
  }

  io.say('');
  io.say('电脑这一半……');
  let local;
  try { local = await localHalf(ctx, plan, state, keys, results, opts); } catch (e) { local = { ok: false, why: e.message }; }
  if (!local.ok) {
    st.patchMode(state, mode, { phase: 'local-failed', lastLocal: { at: ctx.now().toISOString(), ok: false, why: local.why } });
    st.saveState(state);
    io.say(`✗ ${local.why}`);
    return 1;
  }
  st.patchMode(state, mode, { phase: 'local-done', ...(local.joined != null ? { joined: local.joined } : {}) });
  st.saveState(state);

  const acc = (plan.mode === 'tunnel' && opts.noStart) ? null : await acceptance(ctx, plan, opts);
  st.patchMode(state, mode, { phase: acc?.ok ? 'verified' : acc ? 'verify-failed' : 'local-done', lastVerify: acc, ...(acc?.ok ? { verifiedAt: acc.at } : {}) });
  st.remember(state, { action: 'verify', mode, ok: !!acc?.ok, verdict: acc?.verdict ?? null }, ctx.now());
  st.saveState(state);
  audit('vps-setup-verify', { mode, domain: plan.domain, ok: !!acc?.ok, verdict: acc?.verdict ?? null });

  if (acc && !acc.ok) {
    if (plan.mode === 'tunnel' && acc.verdict === 'local') {
      // 接到了 8810：隧道立刻停掉，不留一个整个公网免认证的入口
      try { await (await ctx.lsm()).stop(plan.serviceId, { force: true }); io.say(`  已停掉隧道服务 ${plan.serviceId}`); } catch { /* 停不掉也照样报红 */ }
    }
    io.say('');
    io.say('✗ 验收没过（见上面）。');
    return 1;
  }
  if (plan.mode === 'tunnel') nextStepsTunnel(io, plan);
  else nextStepsHeadscale(io, plan, state, keys);
  io.say('');
  io.say(`✓ ${MODE_NAME[mode]}搭好了：https://${plan.domain}`);
  return 0;
}

export async function status(opts, ctx) {
  const { io, exec } = ctx;
  let state;
  try { state = st.loadState(); } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  const modes = st.MODES.filter((m) => state.modes[m]);
  if (!state.vps || !modes.length) { io.say('还没用 lsm vps setup 搭过（状态文件里没有记录）。'); return 0; }
  const keys = rm.keyPaths();
  io.say(`VPS ${rm.target(state.vps)}（ssh ${state.vps.port}）`);
  const r = await rm.runScript(exec, state.vps, keys, sc.statusScript(state, { now: ctx.now() }), { timeout: 60000 });
  const p = sc.parseOutput(r.out);
  const reached = /^ERGO-STATUS=1$/m.test(r.out);
  if (!reached) io.say(`  ! 登不进 VPS 看：${(r.err || r.out).trim().split(/\r?\n/).pop() || `退出码 ${r.code}`}（下面只有从电脑上能看到的）`);
  const certs = parseCertLines(r.out);
  let bad = !reached;
  for (const mode of modes) {
    const rec = state.modes[mode];
    io.say('');
    io.say(`${MODE_NAME[mode]}  https://${rec.domain}  （${rec.phase}${rec.verifiedAt ? `，${rec.verifiedAt.slice(0, 10)} 验收过` : ''}）`);
    if (reached) {
      const kv = p.kv;
      const parts = [`nginx ${kv.SVC_NGINX || '?'}`];
      if (mode === 'tunnel') {
        parts.push(kv.TUNNEL_ACCOUNT === '1' ? '受限账号在' : '受限账号没了');
        parts.push(Number(kv.TUNNEL_LISTEN) > 0 ? `隧道接上了（VPS 的 127.0.0.1:${rec.remotePort} 有人在听）` : '隧道没接上');
        if (kv.TUNNEL_ACCOUNT !== '1' || !(Number(kv.TUNNEL_LISTEN) > 0)) bad = true;
      } else {
        parts.push(`headscale ${kv.SVC_HEADSCALE || '?'}`);
        parts.push(/pass/i.test(kv.HS_HEALTH || '') ? '健康' : '健康检查没过');
        parts.push(`${kv.HS_NODES || 0} 台设备`);
        if (kv.SVC_HEADSCALE !== 'active') bad = true;
      }
      if (kv.SVC_NGINX !== 'active') bad = true;
      io.say(`  VPS：${parts.join(' · ')}`);
      const cs = certSummary(certs.find((c) => c.domain === rec.domain), ctx.now().getTime());
      io.say(`  证书：${cs.text}${cs.warn ? '  ← 要看一眼（certbot 的自动续期没跑成？）' : ''}`);
      if (!cs.ok) bad = true;
    }
    if (mode === 'tunnel') {
      try {
        const s = await (await ctx.lsm()).state(rec.serviceId);
        io.say(`  电脑：隧道服务 ${rec.serviceId} ${s ?? '没登记'}`);
      } catch (e) { io.say(`  电脑：看不了隧道服务（${e.message}）`); }
      const v = await verifyErgo(exec, `https://${rec.domain}/`);
      io.say(`  从外面：${v.ok ? '✓' : '✗'} ${v.why}`);
      if (!v.ok) bad = true;
    } else {
      const v = await verifyHeadscale(exec, `https://${rec.domain}/`);
      io.say(`  从外面：${v.ok ? '✓' : '✗'} ${v.why}`);
      if (!v.ok) bad = true;
      const node = await hs.localNode(exec, opts.tailscaleCli || DEFAULT_CLI);
      const jp = node.installed ? hs.joinPlan(node, rec.domain) : null;
      io.say(`  电脑：${!node.installed ? '没装 Tailscale' : jp.action === 'none' ? `连着这个 tailnet（${node.backend}）` : `没连着这个 tailnet（${node.backend || '?'}${node.controlURL ? `，连的是 ${node.controlURL}` : ''}）`}`);
    }
  }
  for (const l of exposuresOf8810()) { io.say(`✗ 会把二狗的本机端口 8810 接出去：${l}`); bad = true; }
  state.lastStatus = { at: ctx.now().toISOString(), ok: !bad };
  st.saveState(state);
  return bad ? 1 : 0;
}

export async function remove(mode, opts, ctx) {
  const { io, exec } = ctx;
  let state;
  try { state = st.loadState(); } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  if (!st.MODES.includes(mode)) { io.say(`✗ 只有 headscale 和 tunnel 两种：${mode}`); return 1; }
  const rec = state.modes[mode];
  if (!rec || !state.vps) { io.say(`状态文件里没有${MODE_NAME[mode]}的记录，没什么可撤的。`); return 0; }
  // 最后一样了（别的方式、站点、认领的都没有）才收回管理钥匙：站点、认领的证书还要靠它去看
  const last = st.othersLeft(state, { mode }) === 0;
  const keys = rm.keyPaths();
  let adminPub = '';
  try { adminPub = rm.readPublicKey(keys.admin); } catch { /* 钥匙没了也照样能显示脚本 */ }
  const script = sc.removeScript(mode, rec, { vps: state.vps, adminPubkey: adminPub, revokeAdmin: last, now: ctx.now() });
  const localActions = mode === 'tunnel'
    ? [`电脑这一半：先拿掉 lsm vps setup 填进二狗（${ERGO_DAEMON_ID}）登记的 exposure，强制停掉隧道服务 ${rec.serviceId}、从服务管家的注册表里删掉它（只删 lsm vps setup 生成的那份），删掉隧道用的钥匙。`]
    : ['电脑这一半：这台电脑的 tailscale 连着这台 headscale 的话，先 tailscale logout（从这个 tailnet 退出）。'];
  if (last) localActions.push('这是最后一种：撤完后管理用的钥匙、主机指纹也一起删，状态文件里只留历史。');
  const file = saveScript(`${mode}-remove.sh`, script);
  const yes = await showAndConfirm(io, opts, { title: `lsm vps remove ${mode}`, script, file, extra: localActions });
  if (!yes) { io.say('没执行。'); return 1; }
  audit('vps-remove-run', { mode, host: state.vps.host, domain: rec.domain });

  if (mode === 'tunnel') {
    // 先拿掉二狗登记里我们填的 exposure：它的 via 指着隧道服务，隧道的登记先删了，二狗的登记就校验不过了
    const cx = clearErgoExposure();
    if (cx.why) { io.say(`✗ 拿掉二狗（${ERGO_DAEMON_ID}）登记里的 exposure 没成功（已换回原样）：${cx.why}。没往下撤`); return 1; }
    if (cx.removed) io.say(`  ✓ 拿掉了二狗（${ERGO_DAEMON_ID}）登记里 lsm vps setup 填的 exposure`);
    try {
      const lsm = await ctx.lsm();
      const s = await lsm.stop(rec.serviceId, { force: true });
      if (s && s.ok === false && !/不存在|没有|unknown/i.test(s.why || '')) io.say(`  ! 停隧道服务：${s.why}`);
    } catch (e) { io.say(`  ! 停隧道服务：${e.message}`); }
    const d = deleteTunnelService(rec.serviceId);
    if (!d.ok) { io.say(`✗ ${d.why}`); return 1; }
    if (d.existed) io.say(`  ✓ 删了隧道服务的登记 ${d.file}`);
    try { await (await ctx.lsm()).reload(); } catch { /* 管理器没开就算了 */ }
  } else {
    const cli = opts.tailscaleCli || DEFAULT_CLI;
    const node = await hs.localNode(exec, cli);
    if (node.installed && (node.controlURL || '').replace(/\/+$/, '') === `https://${rec.domain}`) {
      const r = await exec.run([cli, 'logout'], { timeout: 60000 });
      io.say(r.code === 0 ? '  ✓ 这台电脑退出了这个 tailnet' : `  ! tailscale logout 没成功：${(r.err || r.out).trim().split(/\r?\n/).pop()}`);
    }
  }

  io.say('');
  io.say('在 VPS 上执行……');
  const r = await runOnVps(ctx, state, keys, script);
  const done = r.code === 0 && r.parsed.done.includes('remove');
  if (!done) {
    st.patchMode(state, mode, { phase: 'remove-failed', lastRun: { at: ctx.now().toISOString(), ok: false, failure: r.parsed.failure || (r.err || '').trim().split(/\r?\n/).pop() || `退出码 ${r.code}` } });
    st.remember(state, { action: 'remove', mode, ok: false }, ctx.now());
    st.saveState(state);
    io.say(`✗ VPS 上没撤完：${state.modes[mode].lastRun.failure}。重跑同一条命令接着撤。`);
    return 1;
  }
  if (mode === 'tunnel') for (const f of [keys.tunnel, `${keys.tunnel}.pub`]) fs.rmSync(f, { force: true });
  delete state.modes[mode];
  if (last) {
    for (const f of [keys.admin, `${keys.admin}.pub`, keys.knownHosts]) fs.rmSync(f, { force: true });
    state.vps = null;
  }
  st.remember(state, { action: 'remove', mode, ok: true, domain: rec.domain }, ctx.now());
  st.saveState(state);
  io.say(`✓ ${MODE_NAME[mode]}撤掉了（${rec.domain}）`);
  return 0;
}

/** 手机登录页给的那一串 → 在 VPS 上把它登记进来。 */
export async function approve(key, opts, ctx) {
  const { io, exec } = ctx;
  let state;
  try { state = st.loadState(); } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  const rec = state.modes.headscale;
  if (!rec || !state.vps) { io.say('✗ 还没用 lsm vps setup headscale 搭过。'); return 1; }
  let script;
  try { script = hs.approveScript(rec.hsUser || hs.HEADSCALE_USER, key); } catch (e) { io.say(`✗ ${e.message}`); return 1; }
  io.say(`在 VPS 上跑：headscale nodes register --user ${rec.hsUser || hs.HEADSCALE_USER} --key ${key}`);
  const r = await rm.runScript(exec, state.vps, rm.keyPaths(), script, { timeout: 60000 });
  if (r.code !== 0 || !/ERGO-DONE approve/.test(r.out)) { io.say(`✗ 没登记上：${(r.err || r.out).trim().split(/\r?\n/).pop()}`); return 1; }
  audit('vps-approve', { host: state.vps.host });
  io.say('✓ 登记好了，回到手机上几秒内显示已连接');
  return 0;
}
