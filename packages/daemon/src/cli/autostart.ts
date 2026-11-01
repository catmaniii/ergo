// 服务管家的开机自启：计划任务 LocalServiceManager。注册、删除由 lsm 的 install-autostart / uninstall-autostart 做
// （packages/supervisor/src/autostart.mjs），这里只管三件事：读它现在指着哪、认它是不是这个安装的、把"真的动任务"挡在测试外面。
//
// 这个任务的名字是固定的，一台电脑只有一个，开发机上就有一个正在用的，所以动它只有一条路，路上有一道关：
//   - ergo 起 lsm 只有 service.ts 的 runLsm 一个入口，它先问 interceptTaskCommand；守护进程里向导的开关走 runTaskCommand，同样先问它；
//   - 设了 ERGO_AUTOSTART_TASK_FILE：动的是那个 JSON 文件（和 ERGO_USER_ENV_FILE 假 PATH 一个路子），不起 lsm；
//   - 在 vitest 里又没设：直接拒绝，也不起 lsm。忘了设假任务的测试会红，不会碰到真的。
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const AUTOSTART_TASK_NAME = "LocalServiceManager";

/** 被挡下来时的退出码（只在测试进程里会见到） */
export const TASK_COMMAND_REFUSED = 97;

const TASK_COMMANDS = new Set(["install-autostart", "uninstall-autostart"]);

/** 假任务：一个 JSON 文件。action 是任务现在跑的命令（没有任务就没这一项）；calls 记着动过几次；failInstall、failUninstall 让那条命令失败 */
export interface FakeAutostartTask {
  action?: string;
  calls?: string[];
  failInstall?: boolean;
  failUninstall?: boolean;
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

const READ_TASK_SCRIPT =
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $t = Get-ScheduledTask -TaskName '${AUTOSTART_TASK_NAME}' -ErrorAction SilentlyContinue; ` +
  `if ($t) { [Console]::Out.Write((($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' | ')) }`;

/**
 * 任务现在跑的命令（执行文件、参数、工作目录连成一行）。没有任务回空串，查不了回 undefined（都当"不动它"）。
 * 只读，不碰任务。输出按 UTF-8 读：用户名是中文时路径才对得上。
 */
export function readAutostartTask(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.ERGO_AUTOSTART_TASK_FILE?.trim();
  if (file) return readFakeTask(file).action ?? "";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", READ_TASK_SCRIPT], { encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.status !== 0) return undefined;
  return r.stdout.trim();
}

/** 同上，不卡住调用的进程（守护进程里用：PowerShell 起来要一两秒，不能挡着别的请求） */
export function readAutostartTaskAsync(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const file = env.ERGO_AUTOSTART_TASK_FILE?.trim();
  if (file) return Promise.resolve(readFakeTask(file).action ?? "");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", READ_TASK_SCRIPT], { encoding: "utf8", windowsHide: true, timeout: 30_000 }, (err, stdout) => resolve(err ? undefined : stdout.trim()));
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
    writeFakeTask(file, { calls });
    return { code: 0, stdout: "fake task removed", stderr: "" };
  }
  writeFakeTask(file, { ...task, calls, action: `C:\\Windows\\System32\\conhost.exe --headless "${target.node}" "${target.script}" serve --lifeline --quiet --data-dir "${target.dataDir}"` });
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
