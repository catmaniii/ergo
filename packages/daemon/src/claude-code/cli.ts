// 守护进程这一侧跑 Claude Code 的命令行（292 号票：交给官方 App、再收回来，调研 35 第 3 节）——`claude --bg --resume …`、`claude stop`、
// `claude logs`、`claude agents --json`。可注入（ClaudeCli）：主切面、契约测试换成扮演本机 claude 的假的（不起真的 claude、不花额度、
// 不碰用户真实的 ~/.claude）。
//
// 为什么不经一次性子进程（KERNEL.oneShot）、也不放进二狗的 Job 对象：`claude --bg` 会按需拉起 Claude Code 自己的后台服务（守护进程），
// 后台会话（连着官方 App 的那个）就跑在它里面。二狗的 Job 不允许脱离（process/job-object.ts），放进去的话那个服务成了 Job 里的孤儿，
// 孤儿回收（agent-manager/orphans.ts）一分钟内就把它连同官方 App 那边的会话一起结束，二狗重启时也会跟着没了；用户自己之后开的后台会话
// 挂在同一个服务上，也会被连累。所以这几条命令由守护进程直接拉起、detached（Node 不把它放进自己私有的 Job），不交给二狗的 Job。
// 环境照子进程的白名单（process/child-env.ts）再去掉 ANTHROPIC_API_KEY 和继承来的会话变量（claude-env.ts），claude.exe 照本机装的找。
// 等的是进程退出（exit），不等输出关闭：`claude --bg` 拉起的后台服务可能继承了输出的句柄，等关闭会一直等到它退出。
// @i18n-ignore-file log：出错说明进日志、交回接管服务（给人看的话在那边按语言写）
import { spawn } from "node:child_process";
import { buildChildEnv } from "../process/child-env.ts";
import { claudeProcessEnv, findClaudeExecutable } from "./claude-env.ts";

/** 一条命令跑完：退出码（被结束的是 null）、标准输出、标准错误 */
export interface ClaudeCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 跑 Claude Code 的命令行（正式的见 detachedClaudeCli；测试换成假的） */
export interface ClaudeCli {
  /** 跑一次 `claude <args>`（cwd 不给是守护进程自己的目录），等它退出；起不来（没找到 claude、超时）抛错，退出码不是 0 照样交回 */
  run(args: readonly string[], options?: { cwd?: string; timeoutMs?: number }): Promise<ClaudeCliResult>;
}

/** 一条命令默认最多等多久（`claude --bg` 实测 1.4–3 秒，`stop` 不到 1 秒） */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 输出最多收多少字（`claude logs` 是整屏，够用） */
const OUTPUT_MAX = 512 * 1024;
/** 进程退出后再等多久收尾还在路上的输出 */
const DRAIN_MS = 100;

/** 正式运行的：守护进程直接拉起本机的 claude（detached、不进二狗的 Job，见文件开头）；env 现取守护进程自己的环境 */
export function detachedClaudeCli(env: () => Readonly<Record<string, string | undefined>>): ClaudeCli {
  return {
    run(args, options = {}) {
      const parent = env();
      const executable = findClaudeExecutable(parent) ?? (process.platform === "win32" ? undefined : "claude");
      if (executable === undefined) return Promise.reject(new Error("没找到本机的 claude.exe（PATH 里、%USERPROFILE%\\.local\\bin 里都没有）"));
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const child = spawn(executable, [...args], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: claudeProcessEnv(buildChildEnv(parent)),
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        child.stdout.on("data", (chunk: Buffer) => {
          if (stdout.length < OUTPUT_MAX) stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < OUTPUT_MAX) stderr += chunk.toString("utf8");
        });
        const finish = (result: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 不再收：后台服务继承了句柄的话这两条流不会自己关
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          result();
        };
        const timer = setTimeout(() => {
          child.kill();
          finish(() => reject(new Error(`claude ${args.join(" ")} 超时（${timeoutMs / 1000} 秒），结束了它`)));
        }, timeoutMs);
        child.once("error", (err) => finish(() => reject(new Error(`claude ${args.join(" ")} 起不来：${err.message}`))));
        child.once("exit", (code) => {
          setTimeout(() => finish(() => resolve({ code, stdout, stderr })), DRAIN_MS);
        });
      });
    },
  };
}
