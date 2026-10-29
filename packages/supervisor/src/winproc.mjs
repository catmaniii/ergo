// Windows 进程/端口原语。所有「现实」都从这里读——账本不可信，现实可信。
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

export async function ps(script, { timeout = 20000 } = {}) {
  // 必须先把输出编码钉成 UTF-8：PS 5.1 默认按系统代码页（中文机器上是 GBK）写 stdout，
  // Node 按 UTF-8 解，中文任务名、中文路径全变乱码——而有的项目启动脚本就是中文名。
  const wrapped = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
  const { stdout } = await pexec('powershell.exe', [...PS_ARGS, wrapped], {
    maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout,
  });
  return stdout;
}

export async function psJson(script, opts) {
  const out = (await ps(`${script} | ConvertTo-Json -Depth 5 -Compress`, opts)).trim();
  if (!out) return [];
  const v = JSON.parse(out);
  return Array.isArray(v) ? v : [v];
}

/**
 * netstat -ano 解析全机监听端口。用 netstat 而不是 PowerShell：它是原生 exe，
 * 30ms 量级，可以按探活周期反复调；Get-NetTCPConnection 每次要付 PowerShell 启动成本。
 * @returns {Promise<{pids: Map<number, number[]>, binds: Map<number, string[]>}>}
 *   pids: port -> 监听进程；binds: port -> 绑定地址（0.0.0.0 = 局域网可达，127.0.0.1 = 仅本机）
 */
export async function listeningPorts() {
  const map = new Map();
  const binds = new Map();
  let stdout;
  try {
    ({ stdout } = await pexec('netstat', ['-ano', '-p', 'TCP'], {
      maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 15000,
    }));
  } catch { return { pids: map, binds }; }
  for (const line of stdout.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;   // netstat 的状态列在中文 Windows 上也是英文
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[parts.length - 1]);
    const m = /:(\d+)$/.exec(parts[1] || '');
    if (!m || !Number.isInteger(pid) || pid === 0) continue;
    const port = Number(m[1]);
    const addr = parts[1].slice(0, parts[1].lastIndexOf(':'));
    if (!map.has(port)) map.set(port, []);
    if (!map.get(port).includes(pid)) map.get(port).push(pid);
    if (!binds.has(port)) binds.set(port, []);
    if (!binds.get(port).includes(addr)) binds.get(port).push(addr);
  }
  return { pids: map, binds };
}

/** 本机的局域网 IPv4。没有就返回 null（比如只有回环）。 */
export function lanIp() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.')) return n.address;
    }
  }
  return null;
}

/** 进程详情。start 是 ISO 字符串——PID 会被 Windows 快速复用，只认 PID 会认错进程。 */
export async function processInfo(pids) {
  const list = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (!list.length) return new Map();
  const filter = list.map((p) => `ProcessId=${p}`).join(' or ');
  let rows = [];
  try {
    rows = await psJson(
      `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; ` +
      `start=$(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }); cmd=$_.CommandLine } }`,
    );
  } catch { return new Map(); }
  const out = new Map();
  for (const r of rows) {
    if (r && r.pid) out.set(Number(r.pid), { pid: Number(r.pid), ppid: Number(r.ppid) || null, name: r.name || '', start: r.start || '', cmd: r.cmd || '' });
  }
  return out;
}

/** 全量进程枚举（含命令行）。只在存在 matchCmd 服务时才调——它比按 PID 查贵得多。 */
export async function allProcesses() {
  const out = new Map();
  let rows = [];
  try {
    rows = await psJson(
      `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; ` +
      `start=$(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }); cmd=$_.CommandLine } }`,
      { timeout: 30000 },
    );
  } catch { return out; }
  for (const r of rows) {
    if (r && r.pid) out.set(Number(r.pid), { pid: Number(r.pid), ppid: Number(r.ppid) || null, name: r.name || '', start: r.start || '', cmd: r.cmd || '' });
  }
  return out;
}

export async function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return (await processInfo([pid])).has(pid);
}

/**
 * 找出「服务树的真正树顶」。
 *
 * 实测踩到的坑（2026-08-23，接管一个项目时）：它的 hub.ps1 自己是个 always-on 的重启循环，
 * 监听 8787 的 node 是它的子进程。`taskkill /T` 只向下杀子孙，杀不到当父进程的 ps1，
 * 于是 ps1 立刻又把 node 拉起来——看起来像「服务自己复活了」。
 *
 * 所以从监听进程往上走，只要父进程的命令行还落在这个服务的地盘里（root 目录或启动脚本），
 * 就继续往上认；一旦父进程与本服务无关（explorer / services.exe / 计划任务宿主）就停。
 * 这个「相关性」判据是安全阀：绝不会一路杀到系统进程。
 */
// 走到这些进程就停：它们是「别人的地盘」，越过去就会误伤系统。
const TREE_BOUNDARY = new Set([
  'svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'explorer.exe',
  'csrss.exe', 'lsass.exe', 'smss.exe', 'system', 'taskhostw.exe', 'userinit.exe',
]);

/**
 * stopAt：走到这些 PID 就停，它们和它们的祖先都不算这棵树——传管理器自己的 PID 和它的父进程。
 * 管理器直接 spawn 的服务，父链上就是管理器本身（cmd 包装层 ← lsm.mjs ← conhost）。
 * 「相关性」只看命令行里有没有 root / 启动脚本名：服务的 root 若恰好是管理器路径的前缀
 * （比如 root: C:\dev，管理器在 C:\dev\...\local_service_manager），管理器和 conhost 都会被认成「相关」，
 * 树顶一路认到 conhost，taskkill /T 就把管理器连同它起的每一个服务一起杀了。
 * 名下的服务的 root 由接入的项目给，什么都可能有，所以这道边界必须有。
 */
export function findServiceTreeTop(pid, procs, marks, { stopAt = [] } = {}) {
  const norm = marks.filter(Boolean).map((m) => String(m).toLowerCase());
  const boundary = new Set(stopAt.filter(Boolean));
  const related = (info) => {
    const c = (info?.cmd || '').toLowerCase();
    return !!c && norm.some((m) => c.includes(m));
  };

  // 链条中间会夹着「看起来无关」的环节：实测一个 hub 服务的链是
  //   node(监听) ← node(tsx) ← cmd /c "tsx src/bin/hub.ts" ← node(npm shim) ← powershell(ps1 循环)
  // 中间两环的命令行里根本没有项目路径。所以不能一遇到无关就停，
  // 而要一直走到系统宿主为止，记住**最高的那个相关祖先**。
  let top = pid;
  let cur = procs.get(pid);
  const seen = new Set([pid]);
  for (let i = 0; i < 10 && cur; i++) {
    const parent = cur.ppid ? procs.get(cur.ppid) : null;
    if (!parent || seen.has(parent.pid)) break;
    if (boundary.has(parent.pid)) break;
    if (TREE_BOUNDARY.has((parent.name || '').toLowerCase())) break;
    // PID 复用防线：父进程不可能比子进程更晚启动。晚于子进程 = 这个 PID 已经是别人了。
    if (parent.start && cur.start && new Date(parent.start) > new Date(cur.start)) break;
    seen.add(parent.pid);
    if (related(parent)) top = parent.pid;
    cur = parent;
  }
  return top;
}

/** 必须带 /T：有的服务是 uv → python → 游戏客户端三层，杀最上层会留下继续吃显存的孤儿。 */
export async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    await pexec('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 20000 });
    return true;
  } catch { return false; }
}

/** 用户级环境变量批量现读。管理器自己的 env 块是陈旧的（开机就起、跑好几天），从不缓存。 */
export async function readUserEnv(names) {
  const list = [...new Set(names)].filter(Boolean);
  const out = new Map();
  if (!list.length) return out;
  const arr = list.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  let rows = [];
  try {
    rows = await psJson(`$h=@{}; foreach ($n in @(${arr})) { $h[$n] = [Environment]::GetEnvironmentVariable($n,'User') }; $h`);
  } catch { return out; }
  for (const row of rows) for (const [k, v] of Object.entries(row || {})) if (v != null && v !== '') out.set(k, String(v));
  return out;
}

/** 计划任务哨兵的数据源：找「会自启但没纳管」的入口。 */
export async function scheduledTasks() {
  try {
    return await psJson(
      `Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { ` +
      `@{ name=$_.TaskName; path=$_.TaskPath; state=[string]$_.State; ` +
      `action=(($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ') } }`,
      { timeout: 60000 },
    );
  } catch { return []; }
}

export async function unregisterScheduledTask(name) {
  await ps(`Unregister-ScheduledTask -TaskName '${name.replace(/'/g, "''")}' -Confirm:$false`);
}

/**
 * 本次登录会话是什么时候建立的：本会话里最早那个进程（csrss.exe）的启动时间，ISO 字符串。
 * 开机、注销再登录都会变；管理器自己重启不会变——开机自启靠它分辨这两件事。
 * 读不到返回 null。
 */
export async function sessionEpoch() {
  try {
    const out = (await ps(
      `$s=(Get-Process -Id $PID).SessionId; ` +
      `$p=Get-CimInstance Win32_Process -Filter "SessionId=$s" | Where-Object CreationDate | Sort-Object CreationDate | Select-Object -First 1; ` +
      `if ($p) { $p.CreationDate.ToString('o') }`,
      { timeout: 30000 },
    )).trim();
    return out || null;
  } catch { return null; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn() 为真；返回是否在超时前成真。 */
export async function waitFor(fn, { timeoutMs, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
