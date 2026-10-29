// 哨兵：让「在跑但没纳管」和「会自启但没纳管」这两件事可见。
// 它只负责让你看见并邀请你纳管，从不阻止你手动启动任何东西——管理器不是保安。
import { listeningPorts, processInfo, scheduledTasks } from './winproc.mjs';

// 管理器自己的任务和端口不能被当成「冲突」——它就是那个唯一合法的自启入口（一个服务只能有一个管理者）。
const SELF_TASKS = new Set(['LocalServiceManager', 'LocalServiceManager-OpenWebUI']);

function inProjectRoots(cmd, roots) {
  const c = (cmd || '').toLowerCase();
  return roots.some((r) => c.includes(r));
}

/**
 * 命令行落在哪个项目里：代码根目录下的第一级目录名（<代码根>\<这个>\...）。
 * WebUI 按它把一堆端口归成一组——一个项目的测试 worker 一次能占十几个端口，逐条列出来就是一整屏。
 */
export function projectOf(cmd, roots) {
  const c = String(cmd || '').replace(/\//g, '\\');
  const lower = c.toLowerCase();
  for (const r of roots) {
    const root = r.replace(/\//g, '\\').replace(/\\+$/, '');
    const i = lower.indexOf(root + '\\');
    if (i < 0) continue;
    const m = /^[^\\"\s]+/.exec(c.slice(i + root.length + 1));
    if (m) return m[0];
  }
  return null;
}

export async function scan(sup) {
  const manager = sup.manager;
  const roots = (manager.projectRoots || []).map((r) => r.toLowerCase());
  const known = new Set();
  const knownTasks = new Set();
  known.add(manager.port);            // 管理器自己的端口不是「未纳管的服务」
  for (const svc of sup.services.values()) {
    if (svc.probe.port) known.add(svc.probe.port);
    for (const p of svc.probe.extraPorts || []) known.add(p);
    for (const t of [...(svc.onboarding?.removedScheduledTasks || []), ...(svc.onboarding?.pendingScheduledTasks || [])]) {
      knownTasks.add(t);
    }
  }

  const findings = { ports: [], tasks: [], duplicateTasks: [] };

  if (manager.sentinels.port) {
    const { pids: ports } = await listeningPorts();
    const candidates = [...ports.entries()].filter(([port]) => !known.has(port)
      && !(manager.ignorePorts || []).includes(port));
    const pids = candidates.flatMap(([, ps]) => ps);
    const procs = await processInfo(pids);
    const ignoreNames = new Set((manager.ignoreProcessNames || []).map((n) => n.toLowerCase()));
    for (const [port, ps] of candidates) {
      for (const pid of ps) {
        const info = procs.get(pid);
        if (!info) continue;
        if (ignoreNames.has((info.name || '').toLowerCase())) continue;
        // 只报「像是你的项目」的：命令行落在你的代码根目录下。
        // 微信、ToDesk 这类也监听一堆端口，但它们不是你要管的东西，不该每轮都来烦你。
        if (!inProjectRoots(info.cmd, roots)) continue;
        findings.ports.push({ port, pid, name: info.name, cmd: info.cmd, project: projectOf(info.cmd, roots) });
      }
    }
  }

  if (manager.sentinels.scheduledTask) {
    const tasks = await scheduledTasks();
    const taskKeywords = (manager.sentinels.taskKeywords || []).map((k) => String(k).toLowerCase());
    for (const t of tasks) {
      const action = t.action || '';
      if (SELF_TASKS.has(t.name)) continue;                 // 管理器自己，跳过
      // 只报「像是你的项目」的：动作落在代码根目录下，或含 manager.yaml 里 sentinels.taskKeywords 的词
      if (!inProjectRoots(action, roots) && !taskKeywords.some((k) => action.toLowerCase().includes(k))) continue;
      if (knownTasks.has(t.name)) {
        // 已纳管但旧任务还在 —— 最危险的状态：两个东西同时管一个服务
        findings.duplicateTasks.push({ name: t.name, state: t.state, action });
      } else {
        findings.tasks.push({ name: t.name, state: t.state, action });
      }
    }
  }
  return findings;
}

export function formatScan(f) {
  const lines = [];
  if (f.duplicateTasks.length) {
    lines.push('⚠ 已纳管、但项目自己的自启任务还在（两个东西抢同一个服务，最危险的状态）：');
    for (const t of f.duplicateTasks) lines.push(`   [${t.state}] ${t.name}\n      ${t.action}`);
    lines.push('   摘除：lsm detach-task "<任务名>"');
    lines.push('');
  }
  if (f.ports.length) {
    lines.push('发现在跑但未纳管的服务：');
    for (const p of f.ports) lines.push(`   :${p.port}  ${p.name} (${p.pid})\n      ${(p.cmd || '').slice(0, 150)}`);
    lines.push('');
  }
  if (f.tasks.length) {
    lines.push('发现未纳管的自启任务：');
    for (const t of f.tasks) lines.push(`   [${t.state}] ${t.name}\n      ${t.action}`);
    lines.push('');
  }
  if (!lines.length) return '✓ 哨兵没发现异常：没有未纳管的服务，也没有多余的自启任务。';
  return lines.join('\n');
}
