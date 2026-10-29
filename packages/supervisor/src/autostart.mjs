// 管理器自己的开机自启：**唯一**一个自启入口（一个服务只能有一个管理者，自启入口也只能有这一个），且必须跑在用户会话里。
// 一旦它变成 Session 0 的 Windows 服务，它起的所有子进程都会继承那个隔离，
// 要开窗口、要碰桌面的服务就再也看不见桌面了（所以管理器不做成 Windows 服务）。
import path from 'node:path';
import { ROOT, DATA_DIR, DATA_DIR_FLAG, DATA_DIR_FROM } from './paths.mjs';
import { ps, psJson } from './winproc.mjs';

export const TASK_NAME = 'LocalServiceManager';

function q(s) { return String(s).replace(/'/g, "''"); }

/**
 * 计划任务里跑的那条命令的参数。数据目录不是默认位置时（--data-dir 或 LSM_DATA_DIR 指了别处，比如切换时先沿用旧的 LSM 目录），
 * 把它写成 --data-dir 带进去：计划任务拉起的进程不一定看得到你当时终端里的环境变量。
 */
export function taskArgs({ node = process.execPath, root = ROOT, dataDir = DATA_DIR, dataDirFrom = DATA_DIR_FROM } = {}) {
  const entry = path.join(root, 'bin', 'lsm.mjs');
  const dataArg = dataDirFrom === 'default' ? '' : ` ${DATA_DIR_FLAG} "${dataDir}"`;
  return `--headless "${node}" "${entry}" serve --lifeline --quiet${dataArg}`;
}

export async function install() {
  // 用 Windows 自带的 conhost.exe --headless 拉起 node：给它一个**没有窗口**的控制台，
  // Windows Terminal 无从接管，整条链上一个窗口都不会出现（2026-10-08 实测）。
  //
  // 走过的两条死路，别再走：
  //  - `powershell -WindowStyle Hidden -Command "& node ..."`：控制台被 WT 接管，Hidden 在 WT 里只是最小化，
  //    任务栏上永远挂着一个窗口；所有服务还共用它，关掉它 = 所有服务一起死。
  //  - 自己编译一个 GUI 子系统的小启动器（lsm-launch.exe）：第一次跑通了，之后 360 每次在任务启动时
  //    拦下它扫描约 30 秒、报拒绝访问、把文件删掉。不签名的自制 exe 在这台机器上活不长，别再试。
  //
  // --lifeline：conhost 一没（Stop-ScheduledTask、任务被删）管理器就跟着退出，见 server.mjs。
  // --quiet：日志已经写进 manager.log，不必再往（没人看的）控制台抄一遍。
  const args = taskArgs();
  const conhost = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');

  // 每条必须单行：PowerShell 的续行是反引号，换行符会把参数切成独立命令。
  await ps([
    `$action = New-ScheduledTaskAction -Execute '${q(conhost)}' -Argument '${q(args)}' -WorkingDirectory '${q(ROOT)}'`,
    // 两个触发器：登录时起一次，再加一个每 5 分钟的重复触发当看门狗。
    // 为什么需要看门狗（2026-08-28 实测）：管理器被控制台关闭事件干掉过
    // （LastTaskResult=3221225786 / 0xC000013A / STATUS_CONTROL_C_EXIT），
    // 而 -RestartCount 那套只在「任务启动失败」时兜底，进程中途死掉它不管。
    // MultipleInstances=IgnoreNew 保证管理器活着时这些重复触发全被丢弃，
    // 一旦它死了，最多 5 分钟自己回来。看门狗只有这一个，别再往别处加——两个看门狗会各拉起一份管理器。
    `$trigger = @(New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)`,
    // 不给 -RepetitionDuration：任务 XML 里 Duration 缺省就是「无限重复」。
    // 别想着用 [TimeSpan]::MaxValue 表达「永远」——注册会被拒：
    // "The task XML contains a value which is incorrectly formatted or out of range"（实测）。
    `$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)`,
    `$trigger += $repeat`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew`,
    // LogonType Interactive：必须在用户会话里跑，不能是 Session 0
    `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '本地服务管理器：本机唯一的服务自启入口' -Force | Out-Null`,
  ].join('; '), { timeout: 60000 });
  return { ok: true, task: TASK_NAME, action: `${conhost} ${args}` };
}

export async function uninstall() {
  await ps(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false`);
  return { ok: true };
}

export async function status() {
  const rows = await psJson(
    `Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { @{ name=$_.TaskName; state=[string]$_.State; ` +
    `action=(($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ') } }`,
  );
  return rows[0] || null;
}
