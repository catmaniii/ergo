#!/usr/bin/env node
// 本地服务管理器 CLI。
// 管理器常驻时，所有命令走 HTTP 交给它执行——两个 Supervisor 实例会互相覆盖账本。
// 管理器不在时自动退回本地直连模式：这是降级手册的第一层，它挂了你照样能管服务。
import { Supervisor } from '../src/supervisor.mjs';
import { connect } from '../src/client.mjs';
import * as paths from '../src/paths.mjs';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const STATE_COLOR = {
  RUNNING: C.green, DEGRADED: C.yellow, STARTING: C.cyan, STOPPING: C.cyan,
  STOPPED: C.gray, FAILED: C.red, ORPHAN: C.red, EXTERNAL: C.dim,
};

const TIER_NOTE = {
  linked: '接入中，精度最高',
  health: '健康检查通过',
  port: '只知道端口有人听',
  process: '只知道进程还在',
};

function dur(ms) {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function printStatus(snap, mode) {
  if (snap.manager?.registryErrors?.length) {
    console.log(`${C.red}注册表有 ${snap.manager.registryErrors.length} 处问题：${C.reset}`);
    snap.manager.registryErrors.forEach((e) => console.log(`  ${C.red}✗${C.reset} ${e}`));
    console.log('');
  }
  if (!snap.services?.length) {
    console.log(`${C.dim}注册表是空的。用 lsm scan 看看这台机器上有什么在跑。${C.reset}`);
    return;
  }
  // 纯隧道不单独占一行——它作为被暴露服务那行的「公网」一栏显示（和 WebUI 一致）；tailnet 网关同理，在最后的 Tailnet 一栏
  const rows = snap.services.filter((s) => !s.tunnelFor && s.role !== 'gateway');
  const w = Math.max(...rows.map((s) => s.id.length), 4);
  console.log(`${C.bold}${'服务'.padEnd(w)}  状态        档位     端口   运行  说明${C.reset}`);
  for (const s of rows) {
    const col = STATE_COLOR[s.state] || '';
    const state = `${col}${s.state.padEnd(9)}${C.reset}`;
    const tier = `${s.tier || '-'}`.padEnd(7);
    const port = String(s.port || '-').padEnd(5);
    const busy = s.busy ? `${C.yellow} ⚠ 忙碌：${s.busyReason || '未说明'}${C.reset}` : '';
    const degraded = s.degradedObservation ? `${C.yellow} [接入层已断，观测精度下降]${C.reset}` : '';
    console.log(`${s.id.padEnd(w)}  ${state}  ${tier}  ${port}  ${dur(s.runningSince).padEnd(5)} ${C.dim}${s.detail || ''}${C.reset}${busy}${degraded}`);
    if (s.owner) console.log(`${' '.repeat(w + 2)}${C.cyan}└ 由 ${s.owner} 登记${C.reset}${C.dim}（经接入协议；你照样能启停，撤销：lsm owned remove ${s.id}）${C.reset}`);
    if (s.lastError) console.log(`${' '.repeat(w + 2)}${C.red}└ ${s.lastError}${C.reset}`);
    if (s.orphanWhy) console.log(`${' '.repeat(w + 2)}${C.red}└ 孤儿：${s.orphanWhy} —— lsm orphan ${s.id} adopt|kill${C.reset}`);
    const e = s.exposure || {};
    if (e.scope === 'public') {
      const up = ['RUNNING', 'DEGRADED'].includes(e.viaState);
      const chk = e.publicCheck;
      const verdict = !up ? `${C.red}公网已断${C.reset}`
        : chk?.ok ? `${C.green}公网可达 ${chk.status}${C.reset}`
        : chk ? `${C.red}隧道在跑但公网打不通（${chk.why || chk.status}）${C.reset}`
        : `${C.yellow}公网未实测${C.reset}`;
      console.log(`${' '.repeat(w + 2)}└ ${verdict} ${C.dim}${e.publicUrl || ''} 经 ${e.via}(${e.viaState || '未知'}) → VPS:${e.remotePort ?? '?'}${C.reset}`);
    } else {
      console.log(`${' '.repeat(w + 2)}${C.gray}└ 仅本地${s.port ? ` 127.0.0.1:${s.port}` : ''}${C.reset}`);
    }
    if (s.tailnet) {
      const k = s.tailnet.check;
      const verdict = !k ? `${C.yellow}tailnet 未实测${C.reset}`
        : k.ok ? `${C.green}tailnet 就绪${C.reset}`
        : `${C.red}tailnet 不通（${[!k.gateway?.ok && `网关 ${k.gateway?.status ?? k.gateway?.why ?? '?'}`, !k.dns?.ok && 'DNS 没指到本机', !k.serve?.ok && 'serve 没配'].filter(Boolean).join('，')}）${C.reset}`;
      console.log(`${' '.repeat(w + 2)}└ ${verdict} ${C.dim}${s.tailnet.url}${C.reset}`);
    }
    if (s.autostart) console.log(`${' '.repeat(w + 2)}${C.cyan}└ 开机自启${C.reset}`);
    const missing = ['start', 'stop', 'restart'].filter((c) => !s.capabilities.includes(c));
    if (missing.length && s.kind !== 'external') {
      console.log(`${' '.repeat(w + 2)}${C.gray}└ 无 ${missing.join('/')} 能力（WebUI 上灰显）${C.reset}`);
    }
  }
  if (snap.tailnet) printTailnet(snap);
  if (snap.vps) printVps(snap.vps);
  console.log(`\n${C.dim}档位含义：${Object.entries(TIER_NOTE).map(([k, v]) => `${k}=${v}`).join(' · ')}${C.reset}`);
  console.log(`${C.dim}${mode}${C.reset}`);
}

function printTailnet(snap) {
  const t = snap.tailnet;
  const n = t.node;
  const gw = snap.services.find((s) => s.id === t.gateway?.id);
  console.log('');
  if (!n?.ok) {
    console.log(`${C.bold}Tailnet${C.reset}  ${n ? `${C.red}本机 tailscale 不在线${C.reset} ${C.dim}${n.why || n.backend || ''}${C.reset}` : `${C.dim}还没巡检${C.reset}`}`);
    return;
  }
  const peers = n.peers || [];
  console.log(`${C.bold}Tailnet${C.reset}  ${C.green}●${C.reset} ${n.self.host} ${n.self.ipv4} ${C.dim}@ ${n.tailnet} · 设备 ${peers.filter((p) => p.online).length}/${peers.length} 在线${C.reset}`);
  console.log(`         serve :443 → ${n.serve443 || '（未配）'} · 网关 ${t.gateway?.id || '-'} ${gw ? `${STATE_COLOR[gw.state] || ''}${gw.state}${C.reset}` : ''} · 入口 ${t.entries} 个`);
}

/** VPS 订阅：每个包年包月订阅一行（到期日 · 剩几天 · 续费方式），余额顺带；提醒和查不到的项逐条列。 */
function printVps(v) {
  const b = v.billing;
  const H = `${C.bold}VPS 订阅${C.reset}`;
  console.log('');
  if (!b) { console.log(`${H}  ${C.dim}还没查过${C.reset}`); return; }
  if (!b.configured) {
    console.log(`${H}  ${C.yellow}${b.why}${C.reset}`);
    console.log(`${C.dim}          怎么配见 WebUI 上 VPS 订阅栏的「怎么配」，或 examples/registry/manager.yaml 里 vps.billing 的注释；放好文件一分钟内自动生效${C.reset}`);
    return;
  }
  const ago = Math.round((Date.now() - b.checkedAt) / 60000);
  const cur = b.balance?.currency === 'CNY' || !b.balance?.currency ? '¥' : `${b.balance.currency} `;
  const bal = b.balance ? `余额 ${cur}${b.balance.available?.toFixed(2)} · ` : '';
  console.log(`${H}  ${C.dim}${bal}${ago < 1 ? '刚刚' : `${ago} 分钟前`}查的${C.reset}`);
  const RENEW = { AutoRenewal: '自动续费', ManualRenewal: '手动续费', NotRenewal: '到期不续' };
  for (const s of b.subscriptions || []) {
    const d = s.endTime ? Math.ceil((s.endTime - Date.now()) / 86400000) : null;
    const color = s.status === 'Expired' || (d != null && d <= 3) ? C.red : d != null && d <= v.remindDays ? C.yellow : C.green;
    const end = s.endTime ? `${new Date(s.endTime + 8 * 3600000).toISOString().slice(0, 10)} 到期（剩 ${d} 天）` : '到期日未知';
    console.log(`          ${color}●${C.reset} ${s.productName}${s.regionName ? ` · ${s.regionName}` : ''}${s.isVps ? '（这台 VPS）' : ''}  ${end} · ${RENEW[s.renewStatus] || '续费方式未知'}`);
  }
  if (b.subscriptions && !b.subscriptions.length) console.log(`          ${C.dim}账号下没有包年包月订阅${C.reset}`);
  for (const a of v.alerts || []) console.log(`          ${a.level === 'bad' ? C.red : C.yellow}⚠ ${a.text}${C.reset}`);
  for (const e of b.errors || []) console.log(`          ${C.gray}${e.part}查不到：${e.why}${C.reset}`);
  if ((v.alerts || []).length) console.log(`${C.dim}          续费 / 充值：${v.links.billing}（续费管理 → 手动续费）${C.reset}`);
}

function report(r, id) {
  if (!r) { console.log(`${C.red}✗${C.reset} 没有响应`); return 1; }
  if (r.pending) console.log(`${C.yellow}⏸${C.reset} ${id}：${r.why}`);
  else if (r.ok) console.log(`${C.green}✓${C.reset} ${id}${r.already ? ' 本来就在跑' : ' 完成'}`);
  else console.log(`${C.red}✗${C.reset} ${id}：${r.why || '失败'}`);
  return r.ok ? 0 : 1;
}

const stateOf = (snap, id) => (snap?.services || []).find((s) => s.id === id)?.state ?? null;

/** `lsm vps setup` 要登记、起停隧道服务时用：管理器在跑就经它（不能另开一个 Supervisor 抢账本），不在就本地直连。 */
async function lsmAdapter() {
  const probe = new Supervisor();
  const api = await connect(probe.manager);
  if (api) {
    return {
      reload: () => api.reload(),
      start: (id) => api.start(id),
      stop: (id, o) => api.stop(id, o),
      state: async (id) => stateOf(await api.snapshot(), id),
    };
  }
  return {
    reload: async () => { const errors = probe.reload(); return { ok: !errors.length, errors }; },
    start: (id) => probe.start(id),
    stop: (id, o) => probe.stop(id, o),
    state: async (id) => { await probe.refresh(); return stateOf(probe.snapshotForUi(), id); },
  };
}

async function main() {
  // --data-dir <目录> 可以写在任何位置，paths.mjs 已经认过了，这里去掉再分命令
  const [cmd, ...args] = paths.withoutDataDirArg(process.argv.slice(2));

  if (cmd === 'paths') {
    const from = { flag: `命令行 ${paths.DATA_DIR_FLAG}`, env: '环境变量 LSM_DATA_DIR', default: '默认位置' }[paths.DATA_DIR_FROM];
    console.log(`代码目录  ${paths.ROOT}`);
    console.log(`数据目录  ${paths.DATA_DIR}  ${C.dim}（${from}）${C.reset}`);
    console.log(`  注册表    ${paths.REGISTRY_DIR}`);
    console.log(`  账本      ${paths.STATE_FILE}`);
    console.log(`  日志      ${paths.LOGS_DIR}`);
    console.log(`  密钥      ${paths.SECRETS_DIR}`);
    console.log(`  网关路由  ${paths.TAILNET_ROUTES}`);
    console.log(`  VPS 搭建  ${paths.VPS_STATE}（钥匙在 ${paths.VPS_KEYS_DIR}）`);
    return 0;
  }

  // 这几个命令不碰运行状态，永远本地执行
  if (cmd === 'set-password') {
    const { setPassword } = await import('../src/auth.mjs');
    try {
      const f = setPassword(args.join(' '));
      console.log(`${C.green}✓${C.reset} 口令已写入 ${f}`);
      console.log(`${C.dim}  把 registry/manager.yaml 的 auth.enabled 改成 true 再重启管理器即可生效。`);
      console.log(`${C.dim}  口令只存在这个文件里：不进注册表、不进日志、不进审计。`);
      console.log(`${C.yellow}  注意：口令刚进了你的 shell 历史，介意就直接手改那个文件。${C.reset}`);
      return 0;
    } catch (e) { console.log(`${C.red}✗${C.reset} ${e.message}`); return 1; }
  }
  if (cmd === 'install-autostart' || cmd === 'uninstall-autostart') {
    const a = await import('../src/autostart.mjs');
    if (cmd === 'uninstall-autostart') { await a.uninstall(); console.log(`${C.green}✓${C.reset} 已删除自启任务`); return 0; }
    const r = await a.install();
    console.log(`${C.green}✓${C.reset} 已注册登录时自启：${a.TASK_NAME}（无窗口控制台，跑在你的用户会话里）`);
    console.log(`${C.dim}  ${r.action}`);
    console.log(`${C.dim}  这是本机唯一该存在的自启入口——其余服务由管理器拉起。`);
    console.log(`${C.dim}  立刻跑一次：Start-ScheduledTask -TaskName ${a.TASK_NAME}`);
    return 0;
  }
  if (cmd === 'install-shortcut' || cmd === 'auto-open' || cmd === 'no-auto-open') {
    const sc = await import('../src/shortcut.mjs');
    if (cmd === 'no-auto-open') { await sc.uninstallAutoOpen(); console.log(`${C.green}✓${C.reset} 已取消开机自动打开前端`); return 0; }
    if (cmd === 'auto-open') {
      await sc.installAutoOpen();
      console.log(`${C.green}✓${C.reset} 登录后 25 秒会自动打开前端（任务：${sc.OPEN_TASK}）`);
      console.log(`${C.dim}  不想要了：lsm no-auto-open`);
      return 0;
    }
    const r = await sc.installShortcut();
    console.log(`${C.green}✓${C.reset} 桌面已放好「本地服务管理器」快捷方式`);
    console.log(`${C.dim}  ${r.file}`);
    console.log(`${C.dim}  是个 .url 互联网快捷方式：无脚本、零闪窗、不会被杀软拦（.vbs 那条路被 360 锁死过）。`);
    console.log(`${C.dim}  管理器是登录自启的，正常情况下点开就能用。`);
    console.log(`${C.dim}  想开机自动打开前端：lsm auto-open`);
    return 0;
  }
  if (cmd === 'serve') {
    // 计划任务用 conhost --headless 拉起时带 --quiet：控制台没人看，日志照常写 manager.log
    if (args.includes('--quiet')) process.env.LSM_QUIET = '1';
    // 那个控制台没人看，Node 默认把未捕获异常的堆栈打到 stderr 就等于丢了——记进 manager.log 再退出
    const { error } = await import('../src/log.mjs');
    process.on('uncaughtException', (e) => {
      error('管理器崩溃：未捕获异常', { stack: String(e?.stack || e) });
      process.exit(1);
    });
    const sup = new Supervisor();
    const { serve } = await import('../src/server.mjs');
    await serve(sup, { lifeline: args.includes('--lifeline') });
    return null;
  }
  if (cmd === 'validate') {
    const sup = new Supervisor();
    const errors = sup.reload();
    if (!errors.length) { console.log(`${C.green}✓${C.reset} 注册表 ${sup.services.size} 个服务，全部通过校验`); return 0; }
    errors.forEach((e) => console.log(`${C.red}✗${C.reset} ${e}`));
    return 1;
  }

  // VPS 一条命令搭建（321 号票）：setup / status / remove / approve。`lsm vps`、`lsm vps refresh` 还是订阅到期提醒，走下面。
  // 要动服务管家（登记、起停隧道服务）时才接上它，见 lsmAdapter
  if (cmd === 'vps' && ['setup', 'status', 'remove', 'approve', 'site', 'certs', 'scan', 'help'].includes(args[0])) {
    const { runVps } = await import('../src/vps/cli.mjs');
    return runVps(args[0] === 'help' ? [] : args, { lsmFactory: lsmAdapter });
  }

  // 其余命令：管理器在就交给它，不在就本地干
  const probe = new Supervisor();
  let api = null;
  try { api = await connect(probe.manager); } catch (e) { console.log(`${C.red}✗${C.reset} ${e.message}`); return 1; }
  const mode = api ? '（经由常驻管理器执行）' : '（管理器没在跑，本地直连模式）';
  const sup = api || {
    remote: false,
    snapshot: async () => { await probe.refresh(); return probe.snapshotForUi(); },
    start: (id) => probe.start(id),
    stop: (id, o) => probe.stop(id, o),
    restart: (id, o) => probe.restart(id, o),
    startProfile: (n) => probe.startProfile(n),
    stopProfile: (n, o) => probe.stopProfile(n, o),
    resolveOrphan: (id, d) => probe.resolveOrphan(id, d),
    cancelPendingStop: (id) => probe.cancelPendingStop(id),
    detachTask: (t) => probe.detachTask(t),
    reload: async () => { const errors = probe.reload(); return { ok: !errors.length, errors }; },
    setAutostart: async (id, on) => probe.setAutostart(id, on),
    openTailnet: (id, name) => probe.openTailnet(id, { name }),
    closeTailnet: (id) => probe.closeTailnet(id),
    refreshVps: () => probe.refreshVpsBilling({ force: true }),
    removeOwned: (id) => probe.owned.withdraw(id, { by: 'user' }),
    scan: async () => (await import('../src/sentinel.mjs')).scan(probe),
  };

  switch (cmd) {
    case undefined:
    case 'status':
    case 'adopt': {
      // --json：整份快照原样给程序读（ergo status / start 用它，318 号票）
      if (args.includes('--json')) { console.log(JSON.stringify(await sup.snapshot())); return 0; }
      printStatus(await sup.snapshot(), mode);
      return 0;
    }
    case 'start': return report(await sup.start(args[0]), args[0]);
    case 'stop': return report(await sup.stop(args[0], {
      force: args.includes('--force'),
      mode: args.includes('--when-idle') ? 'when-idle' : 'now',
    }), args[0]);
    case 'restart': return report(await sup.restart(args[0], {
      mode: args.includes('--when-idle') ? 'when-idle' : 'now',
    }), args[0]);
    case 'profile': {
      const r = await sup.startProfile(args[0]);
      if (r.results) r.results.forEach((x) => report(x, x.id));
      else console.log(`${C.red}✗${C.reset} ${r.why}`);
      return r.ok ? 0 : 1;
    }
    case 'profile-stop': {
      const r = await sup.stopProfile(args[0], { force: args.includes('--force') });
      if (r.results) r.results.forEach((x) => report(x, x.id));
      else console.log(`${C.red}✗${C.reset} ${r.why}`);
      return r.ok ? 0 : 1;
    }
    case 'cancel-stop': return report(await sup.cancelPendingStop(args[0]), args[0]);
    case 'orphan': return report(await sup.resolveOrphan(args[0], args[1]), args[0]);
    case 'reload': {
      const r = sup.reload ? await sup.reload() : { ok: false, why: '本地模式下无需 reload' };
      if (r.ok) console.log(`${C.green}✓${C.reset} 注册表已重新加载`);
      else (r.errors || [r.why]).forEach((e) => console.log(`${C.red}✗${C.reset} ${e}`));
      return r.ok ? 0 : 1;
    }
    case 'detach-task': return report(await sup.detachTask(args.join(' ')), args.join(' '));
    case 'autostart': {
      if (!args.length) {
        const snap = await sup.snapshot();
        const list = snap.bootList || [];
        if (!list.length) console.log(`${C.dim}开机自启列表是空的——开机后只有管理器自己起来。${C.reset}`);
        else {
          console.log('开机自启（新的登录会话里，管理器起来后自动拉起）：');
          list.forEach((id) => console.log(`  ${C.cyan}●${C.reset} ${id}`));
        }
        console.log(`${C.dim}改：lsm autostart <id> on|off，或 WebUI 卡片上的「开机自启」开关${C.reset}`);
        return 0;
      }
      const [id, v] = args;
      if (!['on', 'off'].includes(v)) { console.log(`${C.red}✗${C.reset} 用法：lsm autostart <id> on|off`); return 1; }
      return report(await sup.setAutostart(id, v === 'on'), id);
    }
    case 'vps': {
      if (args[0] && args[0] !== 'refresh') { console.log(`${C.red}✗${C.reset} 用法：lsm vps [refresh]（订阅提醒）；lsm vps setup | status | remove | approve（搭 VPS，lsm vps help）`); return 1; }
      let r = null;
      if (args[0] === 'refresh') r = await sup.refreshVps();
      const snap = await sup.snapshot();
      if (!snap.vps) { console.log(`${C.dim}manager.yaml 里没配 vps.billing。${C.reset}`); return 0; }
      printVps(snap.vps);
      return r && !r.ok ? 1 : 0;
    }
    case 'tailnet': {
      if (!args.length) {
        const snap = await sup.snapshot();
        if (!snap.tailnet) { console.log(`${C.dim}manager.yaml 里没配 tailnet。${C.reset}`); return 0; }
        printTailnet(snap);
        for (const s of snap.services.filter((x) => x.tailnet)) {
          const k = s.tailnet.check;
          console.log(`  ${k?.ok ? C.green + '●' : C.red + '●'}${C.reset} ${s.id.padEnd(16)} ${s.tailnet.url}  ${C.dim}${k ? `网关 ${k.gateway?.status ?? k.gateway?.why} · DNS ${k.dns?.ok ? '→ 本机' : '✗'} · 证书到 ${k.cert?.notAfter ? new Date(k.cert.notAfter).toISOString().slice(0, 10) : '?'}` : '未实测'}${C.reset}`);
        }
        console.log(`${C.dim}改：lsm tailnet <id> on [名字] | off，或 WebUI 卡片上的「开通 tailnet 入口」${C.reset}`);
        return 0;
      }
      const [id, v, name] = args;
      if (!['on', 'off'].includes(v)) { console.log(`${C.red}✗${C.reset} 用法：lsm tailnet <id> on [名字] | off`); return 1; }
      const r = v === 'on' ? await sup.openTailnet(id, name) : await sup.closeTailnet(id);
      if (r?.note) console.log(r.note);
      return report(r, id);
    }
    case 'owned': {
      // 名下的服务：接入的项目经协议登记的服务，按登记方分组列出；remove 是你手动撤销
      if (args[0] === 'remove') {
        if (!args[1]) { console.log(`${C.red}✗${C.reset} 用法：lsm owned remove <id>`); return 1; }
        return report(await sup.removeOwned(args[1]), args[1]);
      }
      const snap = await sup.snapshot();
      const owned = (snap.services || []).filter((s) => s.owner && (!args[0] || s.owner === args[0]));
      if (!owned.length) {
        console.log(`${C.dim}${args[0] ? `${args[0]} 名下` : '注册表里'}没有经接入协议登记的服务。${C.reset}`);
        return 0;
      }
      const byOwner = new Map();
      for (const s of owned) byOwner.set(s.owner, [...(byOwner.get(s.owner) || []), s]);
      for (const [owner, list] of byOwner) {
        console.log(`${C.bold}${owner}${C.reset} ${C.dim}名下 ${list.length} 个（registry/services/owned/${owner}/）${C.reset}`);
        for (const s of list) {
          const col = STATE_COLOR[s.state] || '';
          console.log(`  ${col}●${C.reset} ${s.id.padEnd(28)} ${col}${s.state.padEnd(9)}${C.reset} :${String(s.port || '-').padEnd(5)} ${s.autostart ? `${C.cyan}开机自启${C.reset} ` : ''}${C.dim}${s.name !== s.id ? s.name : ''}${C.reset}`);
        }
      }
      console.log(`${C.dim}启停照常用 lsm start / stop / restart <id>；撤销（先停再拿掉登记）：lsm owned remove <id>${C.reset}`);
      return 0;
    }
    case 'scan': {
      const { formatScan } = await import('../src/sentinel.mjs');
      console.log(formatScan(await sup.scan()));
      console.log(`${C.dim}${mode}${C.reset}`);
      return 0;
    }
    default:
      console.log(`用法：lsm <命令>

  status [--json]           看所有服务的真实状态（默认）；--json 给程序读的整份快照
  validate                  只校验注册表，不碰任何进程
  adopt                     重认领：把已经在跑的服务认回账本
  start <id>                启动（含依赖编排）
  stop <id> [--when-idle] [--force]
  restart <id> [--when-idle]
  profile <名字>            按场景启动一组服务
  profile-stop <名字> [--force]
  cancel-stop <id>          取消一个挂起的「等空闲再停」
  orphan <id> adopt|kill    裁决孤儿
  reload                    让常驻管理器重新加载注册表
  scan                      哨兵巡检：谁在跑但没纳管、哪些自启任务该摘
  detach-task <任务名>      摘掉项目自带的自启计划任务（纳管的最后一步）
  autostart [<id> on|off]   开机自启：不带参数列出，带参数加入/移出（WebUI 卡片上也能切）
  tailnet [<id> on [名字]|off]  tailnet 入口：不带参数看本机节点和各入口，带参数开 / 撤（会去 VPS 签证书、写 DNS 记录）
  vps [refresh]             VPS 订阅：到期日、余额和提醒；refresh 立刻去阿里云查一次（只读）
  vps setup headscale|tunnel --host root@<IP>   一条命令在 VPS 上搭自建 tailnet / 隧道入口（先体检、显示脚本、同意才跑）
  vps status | remove headscale|tunnel | approve <key>   搭好的通不通、原样撤掉、把手机登记进 tailnet（lsm vps help）
  vps site add <名字> --port <端口> | site remove <名字>   VPS 上加 / 撤一个 https 站点（证书、nginx、前门都照布局办）
  vps certs | scan          VPS 上的证书和到期日；只读扫一遍已有的站点和证书、认领进状态文件
  owned [<登记方>]          列出接入的项目经协议登记的「名下的服务」
  owned remove <id>         撤销一个名下的服务：先强制停，再从注册表和开机自启名单里拿掉
  serve                     启动管理器常驻进程 + WebUI
  set-password <口令>       设置 WebUI 口令（至少 12 位，写进数据目录的 .secrets/）
  install-autostart         把管理器注册成登录时自启（隐藏窗口，本机唯一自启入口）
  install-shortcut          在桌面放一个打开 WebUI 的快捷方式
  auto-open / no-auto-open  开机后自动打开 WebUI（默认不开）
  uninstall-autostart       删掉自启任务
  paths                     看代码目录、数据目录（注册表、账本、日志、密钥）各在哪

任何命令都可以加 --data-dir <目录>：用别处的数据目录（也可以设环境变量 LSM_DATA_DIR）；
不加时是默认位置 ${paths.defaultDataDir()}。`);
      return cmd ? 1 : 0;
  }
}

main().then((code) => { if (code !== null) process.exit(code); }).catch((e) => {
  console.error(`${C.red}✗${C.reset} ${e.message}`);
  process.exit(1);
});
