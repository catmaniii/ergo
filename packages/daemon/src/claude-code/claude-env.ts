// 交给 claude 的环境变量和可执行文件（287 号票，调研 31 第 5.1 节、调研 35 第 1 节）。适配子进程、一次性子进程交给 SDK / `claude agents` 的，
// 292 号票起守护进程这一侧直接跑的命令行（cli.ts：`claude --bg`、`claude stop`、`claude logs`）也用它——所以从 child/ 挪到插件目录
// （child/env.ts 照旧转出它们，子进程里的代码不用改）。
// - 环境：SDK 的 env 选项是"整份换掉"，这里从适配子进程自己的环境（守护进程按白名单给的，process/child-env.ts）拷一份，去掉：
//   · ANTHROPIC_API_KEY：claude 在非交互模式下只要看到它就改用 API key 按量计费，不走本机登录的订阅额度（Remote Control 也只认订阅登录）；
//   · 从别的 Claude Code 会话里继承来的会话变量（调研 35：不剥掉的话 claude 可能把父会话的 RC 会话号、会话 id 当成自己的，
//     CLAUDE_CODE_CHILD_SESSION 还会让它不写记录）。守护进程的白名单本来就不带这些，这里再兜一层。
//   另加 CLAUDE_AGENT_SDK_CLIENT_APP（SDK 文档建议：请求的 User-Agent 里写明是哪个程序）。
// - 可执行文件：Windows 上自己找本机装的 claude.exe（Node 在 Windows 上起进程不搜 PATHEXT；官方安装器装在 %USERPROFILE%\.local\bin），
//   和用户终端里是同一个版本（接管、Remote Control 互转用的也是它）；找不到用 SDK 自带的（版本跟 SDK 锁死）。别的系统用 SDK 自带的。
import fs from "node:fs";
import path from "node:path";

/** 交给 claude 之前去掉的环境变量（Windows 上名字不分大小写，按大写比） */
export const STRIPPED_CLAUDE_ENV = [
  "ANTHROPIC_API_KEY",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
] as const;

const stripped = new Set<string>(STRIPPED_CLAUDE_ENV);

/** claude 进程的环境：适配子进程自己的环境去掉上面那些，加上客户端标识 */
export function claudeProcessEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && !stripped.has(name.toUpperCase())) env[name] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "ergo";
  return env;
}

/**
 * 本机装的 claude.exe（只在 Windows 上找）：先按 PATH 里的目录找，再找官方安装器的位置（%USERPROFILE%\.local\bin）；
 * 都没有是 undefined（用 SDK 自带的）。只认 .exe：SDK 直接起进程，不经 shell，.cmd 这类包装脚本起不来
 */
export function findClaudeExecutable(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync,
): string | undefined {
  if (platform !== "win32") return undefined;
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  const dirs = (pathKey === undefined ? "" : (env[pathKey] ?? "")).split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"));
  const home = Object.entries(env).find(([name]) => name.toUpperCase() === "USERPROFILE")?.[1];
  if (home) dirs.push(path.win32.join(home, ".local", "bin"));
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.win32.join(dir, "claude.exe");
    if (exists(file)) return file;
  }
  return undefined;
}
