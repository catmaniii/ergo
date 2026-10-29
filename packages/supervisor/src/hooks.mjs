// 钩子执行器。落地 docs/service-schema.md 的 8 条硬契约——管理器对钩子只有黑盒判断（启停的业务语义归项目，管理器只管时机和观测结果），
// 所以这些约定必须在这里被强制执行，而不是靠项目自觉。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree, readUserEnv } from './winproc.mjs';

// 传给钩子的最小基础环境。不整份继承 process.env：管理器自己的 env 块是开机时的快照，
// 里面的业务变量必然陈旧（契约第 3 条），必须靠 env: 声明现读。
const BASE_ENV_KEYS = [
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'PUBLIC', 'Path', 'PSModulePath',
];

function baseEnv() {
  const out = {};
  for (const key of Object.keys(process.env)) {
    if (BASE_ENV_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) out[key] = process.env[key];
  }
  return out;
}

/** 解析 env: 声明。userEnv 每次执行都重新读，从不缓存（契约第 3 条）。 */
export async function resolveEnv(svc, extra = {}) {
  const env = { ...baseEnv() };
  const decls = svc.env || [];
  const userNames = decls.filter((d) => d.from === 'userEnv').map((d) => d.name);
  const userVals = await readUserEnv(userNames);
  const missing = [];

  for (const d of decls) {
    let value = null;
    if (d.from === 'userEnv') value = userVals.get(d.name) ?? null;
    else if (d.from === 'literal') value = String(d.value);
    else if (d.from === 'file') {
      const p = path.isAbsolute(d.path) ? d.path : path.join(svc.root, d.path);
      try { value = fs.readFileSync(p, 'utf-8').trim(); } catch { value = null; }
    }
    if (value == null || value === '') {
      if (!d.optional) missing.push(`${d.name} (from ${d.from})`);
      continue;
    }
    env[d.name] = value;
  }
  Object.assign(env, extra);
  return { env, missing };
}

const PS_FILE_RE = /^powershell(?:\.exe)?\s+(.*?)\s*-File\s+(?:"([^"]+)"|(\S+))\s*(.*)$/i;

/**
 * 把 `powershell -File X.ps1` 改写成 PS 内部重定向：`-Command "& 'X.ps1' *>&1 | Out-File utf8"`。
 *
 * 历史：曾经用 detached spawn，PowerShell 因此完全没有控制台，输出凭空消失，只能靠这个改写补救。
 * 现在改用 CREATE_NO_WINDOW（见 spawnDetached 的注释），句柄继承本来就能拿到输出，
 * 这个改写不再是启动路径的一部分。留着它是因为它仍是「PS 在无控制台环境下要自己写文件」
 * 这一事实的可执行记录，且被测试覆盖——将来若需要在真正无控制台的场景下起 PS，直接用它。
 */
export function psWrapForLog(cmd, logFile) {
  const m = PS_FILE_RE.exec(cmd.trim());
  if (!m) return { cmd, wrapped: false };
  const [, leadingArgs = '', quoted, bare, restArgs = ''] = m;
  const script = (quoted || bare || '').replace(/'/g, "''");
  const log = logFile.replace(/'/g, "''");
  const inner = `& '${script}'${restArgs ? ' ' + restArgs : ''} *>&1 | Out-File -FilePath '${log}' -Encoding utf8 -Append`;
  const flags = /-NoProfile/i.test(leadingArgs) ? '-NoProfile ' : '';
  return { cmd: `powershell ${flags}-NonInteractive -ExecutionPolicy Bypass -Command "${inner}"`, wrapped: true };
}

/**
 * argv → 一行给 cmd 的命令。argv 形式现在也要经 cmd 一层（让 cmd 自己做 >> 重定向，见 spawnDetached），
 * 所以每个参数都加上引号。引号里 cmd 仍会展开 %VAR%，而 " 会把引号打断——这两种字符直接拒绝，
 * 不悄悄改写成别的东西。末尾的反斜杠要成对，否则 `"C:\dir\"` 里的 \" 会被目标程序读成转义的引号。
 */
export function cmdLineOf(argv) {
  for (const a of argv) {
    if (/["%\r\n]/.test(String(a))) throw new Error(`argv 参数里不能有 " % 或换行（cmd 会改写它们）：${a}`);
  }
  return argv.map((a) => `"${String(a).replace(/(\\+)$/, '$1$1')}"`).join(' ');
}

/**
 * 由管理器自己 spawn 一个前台常驻服务（`hooks.start.detaches: false`）。
 *
 * 两条启动路径的分工：
 *  - 钩子自己 detach（比如项目自带的 restart 脚本）→ runHook，跑完就退，PID 靠端口反查（端口是服务的身份）
 *  - 钩子是前台常驻（隧道脚本的 while 循环）→ 走这里，管理器直接拿到 PID，还顺手接管了输出
 *
 * Windows 上 shell:true 实际起的是 `cmd.exe /d /s /c "<cmd>"`，cmd 会一直等着子进程，
 * 所以 cmd 的 PID 与服务同生共死，作为存活判据和 killTree 的把手都成立。
 *
 * ⚠ 零窗口的关键是 **stdio 全部 'ignore'**（2026-10-08 实测定位）：
 *   libuv 只在「没有任何一路 stdio 是继承的句柄」时才加 CREATE_NO_WINDOW。
 *   原来这里把日志文件的 fd 直接塞进 stdio，于是 CREATE_NO_WINDOW 从来没生效过——
 *   所有服务都挂在**管理器自己的控制台**上。那个控制台被 Windows Terminal 接管、
 *   `-WindowStyle Hidden` 在 WT 里只是最小化，任务栏上就一直挂着一个窗口，
 *   标题是最后一个执行 `title lsm:xxx` 的服务名——看上去像是那个服务开的窗口。
 *   而且共用一个控制台意味着关掉它 = 所有服务一起收到关闭事件（2026-08-28 实测：关掉一个看着像没用的窗口，两个服务一起死了）。
 *   现在：stdio 全 ignore → 每个服务一个**自己的、不可见的**控制台；
 *   输出由 cmd 的 `>> 日志 2>&1` 写进文件，不再需要继承句柄。
 */
export async function spawnDetached(svc, { extraEnv = {}, logFile } = {}) {
  const hook = svc.hooks?.start;
  if (!hook) return { ok: false, reason: 'no-capability', stderr: `服务 ${svc.id} 没有 start 钩子` };

  const { env, missing } = await resolveEnv(svc, extraEnv);
  if (missing.length) return { ok: false, reason: 'env-missing', stderr: `缺少环境变量：${missing.join('、')}` };

  // argv 形式：参数不经 shell 拆分，原样交给目标程序（隧道这类「一条命令就够」的服务）。
  let line;
  try {
    line = Array.isArray(hook.argv) && hook.argv.length ? cmdLineOf(hook.argv) : hook.cmd;
    if (/["%]/.test(logFile)) throw new Error(`日志路径里不能有 " 或 %：${logFile}`);
  } catch (e) {
    return { ok: false, reason: 'bad-argv', stderr: e.message };
  }

  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `\n===== lsm 启动 ${svc.id} @ ${new Date().toISOString()} =====\n`);
  } catch (e) {
    // cmd 的 >> 打开文件时不许别人再写（实测：同时写 → EBUSY，同时读没问题，日志页照常能看）。
    // 写不进去 = 已经有一份这个服务的 cmd 正往里写——也就是它已经在跑了，再起一份 cmd 的 >> 也会失败。
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      return { ok: false, reason: 'already-running', stderr: `日志文件正被另一份 ${svc.id} 占着写——它好像已经有一个实例在跑了，没有再起第二份（${path.basename(logFile)}）` };
    }
    return { ok: false, reason: 'log-open-failed', stderr: String(e) };
  }

  try {
    const child = spawn(`${line} >> "${logFile}" 2>&1`, {
      shell: true, cwd: svc.root, env, windowsHide: true, detached: false,
      // 必须全是 ignore——见函数头的注释。别为了「顺手拿输出」改回 fd 或 pipe：
      // fd 会让 CREATE_NO_WINDOW 失效；pipe 会让服务的输出系在管理器身上，管理器一死服务写日志就 EPIPE。
      stdio: 'ignore',
    });
    child.on('error', () => {});   // cmd.exe 起不来这种事几乎不会发生，但没人接的 error 事件会把管理器带走
    child.unref();                 // 不让子进程吊住管理器的事件循环
    return { ok: true, pid: child.pid, logFile };
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', stderr: String(e) };
  }
}

/**
 * 执行一个钩子。
 * stdio 的 stdin 恒为 ignore —— 这就是契约第 4 条「禁止交互」的强制手段：
 * 钩子里任何 Read-Host / 确认提示会立刻拿到 EOF 而失败，而不是把管理器挂死。
 */
export async function runHook(svc, name, { extraEnv = {}, onOutput, logFile } = {}) {
  // 钩子的输出也记进这个服务的命令行日志：日志页上看到的是「这个服务在命令行里说过的所有话」，
  // 停机钩子报的错不该只活在内存里那 4000 个字符中。
  // 例外：服务自己还在跑时，它的 cmd 正占着这个文件写（>> 不许别人同时写），停机钩子的输出就记不进去，
  // 只能留在返回值里（失败时会进 lastError）。这里静默跳过，不为了记日志去改变停机行为。
  const record = (s) => { if (logFile) try { fs.appendFileSync(logFile, s); } catch {} };
  const hook = svc.hooks?.[name];
  if (!hook) {
    return {
      ok: false, code: null, reason: 'no-capability', stdout: '',
      stderr: `服务 ${svc.id} 未提供 ${name} 能力`, ms: 0,
    };
  }
  if (logFile) {
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch {}
    record(`\n===== lsm 执行 ${name} 钩子 ${svc.id} @ ${new Date().toISOString()} =====\n`);
  }

  const { env, missing } = await resolveEnv(svc, extraEnv);
  if (missing.length) {
    return {
      ok: false, code: null, reason: 'env-missing', stdout: '',
      stderr: `缺少环境变量：${missing.join('、')}`, ms: 0,
    };
  }

  const started = Date.now();
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(hook.cmd, {
        shell: true, cwd: svc.root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({
        ok: false, code: null, reason: 'spawn-failed', stdout: '',
        stderr: String(e), ms: Date.now() - started,
      });
    }

    let out = '';
    let err = '';
    let done = false;
    const cap = (buf, isErr) => {
      record(buf);                 // 记原始字节：PowerShell 写的可能是 GBK，按 UTF-8 转一道就毁了
      const s = buf.toString();
      if (onOutput) onOutput(s, isErr);
      if (isErr) err = (err + s).slice(-4000);
      else out = (out + s).slice(-4000);
    };
    child.stdout?.on('data', (b) => cap(b, false));
    child.stderr?.on('data', (b) => cap(b, true));

    // 超时即失败，连钩子的进程树一起清掉（契约第 2 条）
    const timer = setTimeout(async () => {
      if (done) return;
      done = true;
      record(`----- ${name} 钩子超时（${hook.timeoutMs}ms），连进程树一起清掉 -----\n`);
      await killTree(child.pid);
      resolve({
        ok: false, code: null, reason: 'timeout', timedOut: true,
        stdout: out, stderr: err, ms: Date.now() - started,
      });
    }, hook.timeoutMs);

    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, reason: 'spawn-failed', stdout: out, stderr: String(e), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      record(`----- ${name} 钩子结束，退出码 ${code} -----\n`);
      resolve({
        ok: code === 0, code, reason: code === 0 ? null : 'exit-nonzero',
        stdout: out, stderr: err, ms: Date.now() - started,
      });
    });
  });
}
