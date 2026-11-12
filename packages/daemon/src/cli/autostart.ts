// 服务管家的开机自启：计划任务 LocalServiceManager。注册、删除由 lsm 的 install-autostart / uninstall-autostart 做
// （packages/supervisor/src/autostart.mjs），这里管四件事：读它现在指着哪、在不在跑，认它是不是这个安装的，
// 换版本时停一下、再起一下它（让它起的服务管家换成新版本，见 service.ts 的 restartManagerViaTask），把"真的动任务"挡在测试外面。
//
// 这个任务的名字是固定的，一台电脑只有一个，开发机上就有一个正在用的，所以动它的路都过同一道关：
//   - ergo 起 lsm 只有 service.ts 的 runLsm 一个入口，它先问 interceptTaskCommand；守护进程里向导的开关走 runTaskCommand，同样先问它；
//   - 停、起任务（Stop-ScheduledTask、Start-ScheduledTask）只有 runTaskOp 一个入口，也先问它；
//   - 设了 ERGO_AUTOSTART_TASK_FILE：动的是那个 JSON 文件（和 ERGO_USER_ENV_FILE 假 PATH 一个路子），不起 lsm、不碰计划任务；
//   - 在 vitest 里又没设：直接拒绝，也不起 lsm。忘了设假任务的测试会红，不会碰到真的。
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const AUTOSTART_TASK_NAME = "LocalServiceManager";

/** 被挡下来时的退出码（只在测试进程里会见到） */
export const TASK_COMMAND_REFUSED = 97;

const TASK_COMMANDS = new Set(["install-autostart", "uninstall-autostart"]);

/**
 * 假任务：一个 JSON 文件。action 是任务现在跑的命令（没有任务就没这一项）；calls 记着动过几次（install-autostart、stop-task、start-task……）；
 * fail* 让那条命令失败。state 是任务的状态（Get-ScheduledTask 的 State，没写是 Ready）：Running 就是有一个实例在跑。
 * run 时起任务真的照 action 起一个实例（和计划任务一样：conhost --headless 拉起服务管家，端到端用），pid 记着它；停任务只结束它（和 Stop-ScheduledTask 一样）
 */
export interface FakeAutostartTask {
  action?: string;
  /** 任务的工作目录（lsm 设成那个版本的 packages\supervisor） */
  workingDirectory?: string;
  state?: string;
  run?: boolean;
  pid?: number;
  calls?: string[];
  failInstall?: boolean;
  failUninstall?: boolean;
  failStop?: boolean;
  failStart?: boolean;
}

export function readFakeTask(file: string): FakeAutostartTask {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as FakeAutostartTask;
  } catch {
    return {};
  }
}

function writeFakeTask(file: string, task: FakeAutostartTask): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(task, null, 2));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 假任务现在的状态：起过的实例已经没了（比如撞端口退了）就和计划任务一样回到 Ready */
function fakeState(task: FakeAutostartTask): string {
  if (task.pid !== undefined && !alive(task.pid)) return "Ready";
  return task.state ?? "Ready";
}

/** 任务：现在跑的命令（执行文件、参数、工作目录连成一行），和它的状态（Running 是有一个实例在跑） */
export interface AutostartTaskInfo {
  action: string;
  state: string;
}

/** 没有这个任务时退出码是 0、什么都不写（原来那样写会因为 Get-ScheduledTask 报了"找不到"而退出码 1，被当成"查不了"）；别的错才是 1 */
export function readTaskScript(name: string): string {
  return (
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue -ErrorVariable e; ` +
    `if ($t) { [Console]::Out.Write([string]$t.State + [char]9 + (($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' | ')) } ` +
    `elseif ($e.Count -gt 0 -and [string]$e[0].CategoryInfo.Category -ne 'ObjectNotFound') { exit 1 }; exit 0`
  );
}

const READ_TASK_SCRIPT = readTaskScript(AUTOSTART_TASK_NAME);

/** 读任务那段 PowerShell 的输出：状态、一个制表符、命令；空的是没有任务 */
export function parseTaskRead(stdout: string): AutostartTaskInfo | null {
  const text = stdout.trim();
  if (text === "") return null;
  const tab = text.indexOf("\t");
  return tab < 0 ? { state: "", action: text } : { state: text.slice(0, tab).trim(), action: text.slice(tab + 1).trim() };
}

function fakeTaskInfo(file: string): AutostartTaskInfo | null {
  const task = readFakeTask(file);
  return task.action ? { action: task.action, state: fakeState(task) } : null;
}

/**
 * 任务现在跑的命令和状态。没有任务回 null，查不了回 undefined（都当"不动它"）。
 * 只读，不碰任务。输出按 UTF-8 读：用户名是中文时路径才对得上。
 */
export function readAutostartTaskInfo(env: NodeJS.ProcessEnv): AutostartTaskInfo | null | undefined {
  const file = env.ERGO_AUTOSTART_TASK_FILE?.trim();
  if (file) return fakeTaskInfo(file);
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", READ_TASK_SCRIPT], { encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.status !== 0) return undefined;
  return parseTaskRead(r.stdout);
}

/** 只要命令：没有任务回空串，查不了回 undefined */
export function readAutostartTask(env: NodeJS.ProcessEnv): string | undefined {
  const info = readAutostartTaskInfo(env);
  return info === undefined ? undefined : (info?.action ?? "");
}

/** 同上，不卡住调用的进程（守护进程里用：PowerShell 起来要一两秒，不能挡着别的请求） */
export function readAutostartTaskAsync(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const file = env.ERGO_AUTOSTART_TASK_FILE?.trim();
  if (file) return Promise.resolve(fakeTaskInfo(file)?.action ?? "");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", READ_TASK_SCRIPT], { encoding: "utf8", windowsHide: true, timeout: 30_000 }, (err, stdout) =>
      resolve(err ? undefined : (parseTaskRead(stdout)?.action ?? "")),
    );
  });
}

const normal = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** 一个路径的两种写法：照原样、解开联接和 8.3 短名之后（lsm 写进任务的是它自己解开后的位置） */
function forms(p: string): string[] {
  try {
    return [normal(p), normal(fs.realpathSync.native(p))];
  } catch {
    return [normal(p)];
  }
}

/** 任务指着这个安装目录里的东西（不是用的人自己别处装的服务管家）。root 后面带分隔符：ergo2 不算 ergo 里面 */
export function taskInsideRoot(action: string, root: string): boolean {
  const text = normal(action);
  return forms(root).some((form) => text.includes(`${form}\\`));
}

/** 任务跑的就是这个 lsm.mjs */
export function taskRunsScript(action: string, script: string): boolean {
  const text = normal(action);
  return forms(script).some((form) => text.includes(form));
}

/** 任务里写的服务管家数据目录（lsm 注册时数据目录不是默认位置才写 --data-dir "…"）；没写回 undefined */
export function taskDataDir(action: string): string | undefined {
  return /--data-dir\s+"([^"]+)"/.exec(action)?.[1] ?? /--data-dir[=\s]+([^\s"|]+)/.exec(action)?.[1];
}

/** 两个目录是不是同一个（大小写、斜杠、联接和 8.3 短名都不计较） */
export function sameDir(a: string, b: string): boolean {
  const other = forms(b);
  return forms(a).some((form) => other.includes(form));
}

export interface LsmResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 这条 lsm 命令要动计划任务时，真的起 lsm 之前过这一关：回结果就是到此为止，回 undefined 才往下真的起。
 * 命令可能带 --data-dir 这类开关（lsm 会先摘掉它们），所以按整条参数找，不只看第一个。
 */
export function interceptTaskCommand(env: NodeJS.ProcessEnv, args: readonly string[], target: { node: string; script: string; dataDir: string }): LsmResult | undefined {
  const command = args.find((a) => TASK_COMMANDS.has(a));
  if (!command) return undefined;
  const file = env.ERGO_AUTOSTART_TASK_FILE?.trim();
  if (!file) {
    // 看的是这个进程自己的环境，不是 ctx.env：测试给的 ctx.env 可能是另拼的一份
    if (!process.env.VITEST) return undefined;
    return { code: TASK_COMMAND_REFUSED, stdout: "", stderr: `refused: ${command} under vitest without ERGO_AUTOSTART_TASK_FILE would change the real scheduled task` };
  }
  const task = readFakeTask(file);
  const calls = [...(task.calls ?? []), command];
  if (command === "install-autostart" ? task.failInstall : task.failUninstall) {
    writeFakeTask(file, { ...task, calls });
    return { code: 1, stdout: "", stderr: "fake task refused" };
  }
  if (command === "uninstall-autostart") {
    // 任务删了，它起的实例（conhost）也跟着没了
    if (task.pid !== undefined) killQuietly(task.pid);
    writeFakeTask(file, { calls });
    return { code: 0, stdout: "fake task removed", stderr: "" };
  }
  // 重新注册不动正在跑的实例：它照旧跑着注册前的命令（真的计划任务会不会结束它没核实过，restartManagerViaTask 两种都接得住）
  writeFakeTask(file, {
    ...task,
    calls,
    action: `C:\\Windows\\System32\\conhost.exe --headless "${target.node}" "${target.script}" serve --lifeline --quiet --data-dir "${target.dataDir}"`,
    workingDirectory: path.dirname(path.dirname(target.script)),
  });
  return { code: 0, stdout: "fake task registered", stderr: "" };
}

/**
 * 守护进程里动任务（向导的开关）：和 ergo svc install-autostart / uninstall-autostart 同一条命令，先过上面那一关；不卡住守护进程
 */
export function runTaskCommand(env: NodeJS.ProcessEnv, command: "install-autostart" | "uninstall-autostart", target: { node: string; script: string; dataDir: string }): Promise<LsmResult> {
  const intercepted = interceptTaskCommand(env, [command], target);
  if (intercepted) return Promise.resolve(intercepted);
  return new Promise((resolve) => {
    execFile(target.node, [target.script, command], { env: { ...env, LSM_DATA_DIR: target.dataDir }, encoding: "utf8", windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || (err && typeof err.code !== "number" ? err.message : "") });
    });
  });
}

/** 停任务、起任务：Stop-ScheduledTask 只结束任务的主进程（conhost），服务管家靠 --lifeline 跟着退；Start-ScheduledTask 照任务现在的命令起一个实例（在跑就不再起：IgnoreNew） */
export type TaskOp = "stop" | "start";

const TASK_OP_SCRIPT: Record<TaskOp, string> = {
  stop: `Stop-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -ErrorAction Stop`,
  start: `Start-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -ErrorAction Stop`,
};

/** 停、起开机自启的任务。和 interceptTaskCommand 同一道关：设了假任务动 JSON 文件，测试进程里没设就拒绝 */
export function runTaskOp(env: NodeJS.ProcessEnv, op: TaskOp): LsmResult {
  const file = env.ERGO_AUTOSTART_TASK_FILE?.trim();
  if (file) return fakeTaskOp(file, op, env);
  if (process.env.VITEST) return { code: TASK_COMMAND_REFUSED, stdout: "", stderr: `refused: ${op} the scheduled task under vitest without ERGO_AUTOSTART_TASK_FILE would touch the real one` };
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${TASK_OP_SCRIPT[op]}`], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.error ? 1 : (r.status ?? 1), stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() || (r.error?.message ?? "") };
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // 已经没了
  }
}

function fakeTaskOp(file: string, op: TaskOp, env: NodeJS.ProcessEnv): LsmResult {
  const task = readFakeTask(file);
  const calls = [...(task.calls ?? []), `${op}-task`];
  if (!task.action) {
    writeFakeTask(file, { ...task, calls });
    return { code: 1, stdout: "", stderr: "fake task: there is no such task" };
  }
  if (op === "stop" ? task.failStop : task.failStart) {
    writeFakeTask(file, { ...task, calls });
    return { code: 1, stdout: "", stderr: `fake task refused to ${op}` };
  }
  if (op === "stop") {
    if (task.pid !== undefined) killQuietly(task.pid);
    const { pid: _pid, ...rest } = task;
    writeFakeTask(file, { ...rest, calls, state: "Ready" });
    return { code: 0, stdout: "fake task stopped", stderr: "" };
  }
  if (fakeState(task) === "Running") {
    writeFakeTask(file, { ...task, calls });
    return { code: 0, stdout: "fake task already running", stderr: "" };
  }
  const { pid: _old, ...rest } = task;
  let pid: number | undefined;
  if (task.run) {
    try {
      pid = launchAction(task.action, task.workingDirectory, env);
    } catch (err) {
      writeFakeTask(file, { ...rest, calls, state: "Ready" });
      return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  }
  writeFakeTask(file, { ...rest, calls, state: "Running", ...(pid !== undefined ? { pid } : {}) });
  return { code: 0, stdout: "fake task started", stderr: "" };
}

/** PowerShell 单引号字符串 */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * 照任务的命令起一个实例（假任务的 run）：执行文件是第一段（可以带引号），其余原样当参数；隐藏、和调用的进程断开，回它的 pid。
 * 环境里去掉 LSM_DATA_DIR：计划任务起的进程看不到终端里的环境变量，数据目录只能靠命令里的 --data-dir
 */
function launchAction(action: string, cwd: string | undefined, env: NodeJS.ProcessEnv): number {
  const m = /^\s*(?:"([^"]+)"|(\S+))\s*(.*)$/.exec(action);
  if (!m) throw new Error(`fake task: cannot read the command ${action}`);
  const file = m[1] ?? m[2]!;
  const args = m[3]!.trim();
  const script = `$p = Start-Process -FilePath ${lit(file)}${args ? ` -ArgumentList ${lit(args)}` : ""}${cwd ? ` -WorkingDirectory ${lit(cwd)}` : ""} -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)`;
  const { LSM_DATA_DIR: _dir, ...rest } = env;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: rest, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const pid = Number(r.stdout?.trim());
  if (r.status !== 0 || !Number.isInteger(pid) || pid <= 0) throw new Error(`fake task: Start-Process ${file}: ${r.stderr?.trim() || r.status}`);
  return pid;
}
