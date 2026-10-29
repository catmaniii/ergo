// 探活。四档精度，一盏绿灯在不同档位下保证的东西完全不同——档位必须一路传到 WebUI。
import fs from 'node:fs';
import path from 'node:path';
import { allProcesses, listeningPorts } from './winproc.mjs';

async function httpOk(url, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // 同 exposure.mjs 里那条：不消费 body，undici 会在收尾时抛一个包不住的断言。
    // 这一处更危险 —— health 档是 5 秒一轮，而公网探测是慢周期。
    await r.body?.cancel().catch(() => {});
    return { ok: r.status < 400, detail: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: `不通：${e.name === 'TimeoutError' ? '超时' : e.message}` };
  }
}

function readPidFile(svc) {
  if (!svc.probe.pidFile) return null;
  const p = path.isAbsolute(svc.probe.pidFile) ? svc.probe.pidFile : path.join(svc.root, svc.probe.pidFile);
  try {
    const n = Number(fs.readFileSync(p, 'utf-8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 按命令行认领 process 档服务：没有端口、没有 PID 文件、还是别人（或你自己手动）起的进程，
 * 只剩命令行这一条身份线索。隧道就是这种——两条隧道都是手动起的，账本里没有任何记录。
 */
function cmdRegex(svc) {
  if (!svc.probe.matchCmd) return null;
  try { return new RegExp(svc.probe.matchCmd, 'i'); } catch { return null; }
}

function findByCmd(svc, allProcs) {
  const re = cmdRegex(svc);
  if (!re || !allProcs) return null;
  for (const info of allProcs.values()) if (info.cmd && re.test(info.cmd)) return info;
  return null;
}

/**
 * PID 文件 / 账本给的 PID 只是**线索**，不是身份。Windows 回收 PID 很快，重启之后更是必然。
 *
 * 2026-10-05 实测：一条隧道的账本里记着 2344，重启后 2344 被 svchost.exe 复用了。
 * 原来这里只问「这个 PID 上有没有进程」，于是 svchost 被当成了隧道——
 * 隧道永远显示「在跑」，autoRestart 永远不触发，公网一直 502，界面上看着一切正常。
 * 更糟的是：误认那一轮的探活结果会把 svchost 的启动时间写回账本（supervisor.refresh 的认领分支），
 * 从此账本被「毒化」，光比启动时间也再识别不出来了。
 *
 * 所以两道校验，缺一不可：
 *   1. 启动时间：账本记的跟现实不符 → 被复用了。只能抓住**第一轮**（之后账本就被毒化了）。
 *   2. 命令行：有 matchCmd 就必须对得上。这一道不怕毒化——svchost 的命令行永远不会像一条 ssh -R。
 * 隧道全都有 matchCmd，所以隧道这一类是彻底堵住的；没有 matchCmd 的 process 档服务只能靠第 1 道。
 */
function verifyIdentity(svc, st, info) {
  if (!info) return { ok: false };
  if (info.pid === st.pid && st.pidStart && info.start && st.pidStart !== info.start) {
    return { ok: false, why: `PID ${info.pid} 被复用了（启动时间不符，现在是 ${info.name || '别的进程'}）` };
  }
  const re = cmdRegex(svc);
  if (re && !re.test(info.cmd || '')) {
    return { ok: false, why: `PID ${info.pid} 现在是 ${info.name || '别的进程'}，命令行对不上，不是它` };
  }
  return { ok: true };
}

/**
 * 一轮探活的现实快照，供本轮所有服务共用。**整轮只起一个 PowerShell**——这是硬要求，不是优化。
 *
 * 2026-08-29 实测（管理器把自己拖死之后量的）：
 *   listeningPorts（netstat）  ~0.1s
 *   processInfo（按 PID 过滤）  ~3.0s
 *   allProcesses（全量枚举）    ~2.6s
 * 也就是说，开销几乎全在「起一次 PowerShell + 连一次 CIM」的固定成本上，跟枚举多少行没关系。
 * 原来那句「全量枚举比按 PID 查贵得多」是错的，据此做的分支省不下任何东西，
 * 反而让一轮要起两次 PowerShell（~5.5s），超过了 5s 的探活间隔 → 轮次叠加 →
 * PowerShell 进程堆积 → 机器变慢 → 健康检查超时 → 服务被误判 FAILED → autoRestart 空转
 * → 更慢。管理器就是这么把自己的事件循环饿死的（7420 能连上但永远不回包）。
 *
 * 所以现在：一次全量枚举，两个用途（按 PID 查 + matchCmd 匹配）都从它身上取。
 */
// 调用方照旧传要看的服务（[svc] 或整份清单）；一次全量枚举已经全覆盖，用不着它
export async function snapshot() {
  const { pids: ports, binds } = await listeningPorts();
  // 全量枚举顺带覆盖了端口反查到的 PID 和 pidFile 里的 PID，不用再单独收集一遍
  const procs = await allProcesses();
  return { ports, binds, procs, allProcs: procs };
}

/**
 * 三元校验：PID 活着 && 进程启动时间对得上 && 该端口的监听者就是它。
 * 只认 PID 会认错进程——Windows 的 PID 回收很快。
 */
export function triCheck(st, snap, port) {
  if (!st.pid) return { match: false, why: '账本里没有 PID' };
  const info = snap.procs.get(st.pid);
  if (!info) return { match: false, why: `PID ${st.pid} 已不存在` };
  if (st.pidStart && info.start && st.pidStart !== info.start) {
    return { match: false, why: `PID ${st.pid} 被复用了（启动时间不符）` };
  }
  if (port) {
    const owners = snap.ports.get(port) || [];
    if (!owners.includes(st.pid)) return { match: false, why: `端口 ${port} 的监听者不是 PID ${st.pid}` };
  }
  return { match: true, info };
}

export async function probeService(svc, st, snap, linkStatus) {
  const port = svc.probe.port;
  const link = linkStatus?.(svc.id);
  // 端口有没有人听、健康检查过没过，单独报出来（不只是揉进 ok / detail）：
  // 名下的服务的状态推送要分开给这几样。没有端口、或这轮快照里没有端口表时为 null。
  const listening = port && snap?.ports ? (snap.ports.get(port) || []).length > 0 : null;

  // linked：连接在 = 服务真的活着（身份来自这条出站连接本身）。失联不判死，只降级观测精度。
  if (svc.link?.enabled && link?.connected) {
    const busyPart = link.busy ? ` · 忙碌：${link.busyReason || '未说明'}` : '';
    return {
      tier: 'linked',
      ok: link.health !== 'failing',
      pid: link.pid ?? st.pid,
      pidStart: st.pidStart,
      busy: !!link.busy,
      busyReason: link.busyReason || null,
      listening,
      health: link.health || 'ok',     // 服务自报的：ok | degraded | failing
      detail: `接入中 · 自报 ${link.health || 'ok'}${busyPart}`,
    };
  }

  const degradedObservation = !!(svc.link?.enabled && !link?.connected && svc.probe.tier === 'linked');
  const tier = svc.probe.tier === 'linked'
    ? (svc.probe.health?.url ? 'health' : 'port')
    : svc.probe.tier;

  if (tier === 'process') {
    // 身份三条线索，按可靠性排序：PID 文件 > 账本里的 PID > 命令行匹配。
    // 前两条给的 PID 必须先过 verifyIdentity，过不了就当没给，退到命令行匹配。
    const fromFile = readPidFile(svc);
    const hint = fromFile ?? st.pid;
    let pid = null, info = null, via = null, rejected = null;
    if (hint) {
      const cand = snap.procs.get(hint);
      const v = verifyIdentity(svc, st, cand);
      if (v.ok) { pid = hint; info = cand; via = fromFile ? 'PID 文件' : '账本'; }
      else if (v.why) rejected = v.why;
    }
    if (!info) {
      const byCmd = findByCmd(svc, snap.allProcs);
      if (byCmd) { pid = byCmd.pid; info = byCmd; via = '命令行匹配'; }
    }
    // 管理器 spawn 的服务外面套着一层 cmd（它负责把输出 >> 进日志，见 hooks.spawnDetached），
    // cmd 的命令行里也带着整条 ssh 命令，所以 matchCmd 会先认到它。往下认到真正干活的那个进程，
    // 界面上才会写「ssh.exe 在跑」而不是「cmd.exe 在跑」。cmd 只活到 ssh 退出为止，两者同生共死。
    const re = cmdRegex(svc);
    for (let hop = 0; info && re && hop < 3 && /^cmd\.exe$/i.test(info.name || ''); hop++) {
      const child = [...(snap.allProcs?.values() || [])].find((p) => p.ppid === info.pid && re.test(p.cmd || ''));
      if (!child) break;
      pid = child.pid; info = child;
    }
    return {
      tier,
      ok: !!info,
      pid: pid ?? null,
      pidStart: info?.start ?? null,
      degradedObservation,
      detail: info
        ? `${info.name} (${pid}) 在跑（认自 ${via}）——本档只保证进程还在，不保证它还能干活`
        : (rejected ? `找不到这个进程（${rejected}）` : '找不到这个进程'),
    };
  }

  const owners = port ? (snap.ports.get(port) || []) : [];
  const pid = owners[0] ?? null;
  const info = pid ? snap.procs.get(pid) : null;

  if (!owners.length) {
    return { tier, ok: false, pid: null, pidStart: null, degradedObservation, listening: false, health: null, detail: `端口 ${port} 没人在听` };
  }

  const tri = triCheck(st, snap, port);
  const orphan = st.pid != null && !tri.match;

  if (tier === 'health') {
    const h = await httpOk(svc.probe.health.url, svc.probe.health.timeoutMs ?? 3000);
    return {
      tier, ok: h.ok, pid, pidStart: info?.start ?? null,
      orphan, orphanWhy: orphan ? tri.why : null, degradedObservation,
      listening: true, health: h.ok ? 'ok' : 'failing',
      bindAddrs: snap.binds?.get(port) || [], detail: h.detail,
    };
  }

  return {
    tier, ok: true, pid, pidStart: info?.start ?? null,
    orphan, orphanWhy: orphan ? tri.why : null, degradedObservation,
    listening: true, health: null,
    bindAddrs: snap.binds?.get(port) || [],
    detail: `端口 ${port} 由 ${info?.name || '未知进程'} (${pid}) 监听`,
  };
}
