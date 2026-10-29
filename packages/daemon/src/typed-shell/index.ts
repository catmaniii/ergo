// @i18n-ignore-file model：起不来的原因写进工具结果（给模型看）
// 带类型的特殊 bash 工具（28 号票）。上层只从这里取东西：
// - createTypedShell(...)：守护进程里建一份（环境、超时、GitHub 命令行在哪）；
// - toolsFor({ cwd, toolkit })：一个会话的工具，随工具包的 bash 开关出现——bash 关着时一个都没有；联网开关关着时没有要联网的
//   推送、建远端仓库、装依赖（27 号票评审后定：联网关着时会话里没有任何要联网的工具）。
//   拉起会话的模块把它们加进代为执行的工具（hostTools），pi 的工具里同时给 bash；秘书的固定工具里没有它们；
// - runScript(...)：用同一个启动器跑一段固定的脚本（13 号票的阶段验收）。
//
// 工具起的进程：环境是系统变量白名单（buildChildEnv，没有守护进程的密钥；推送、建远端仓库靠本机已登录的 git 和
// GitHub 命令行，二狗不另外注入凭据），联网开关关着时另加一组无效代理（OFFLINE_SHELL_ENV）；每次调用一个 Job 对象（runner.ts）。
import type { HostTool } from "../agent-manager/host-tools.ts";
import { buildChildEnv, OFFLINE_SHELL_ENV } from "../process/child-env.ts";
import { createJobObject, type JobObject } from "../process/job-object.ts";
import { findGitBash } from "./git-bash.ts";
import { runShell, type ShellRunResult } from "./runner.ts";
import { typedShellTools } from "./tools.ts";

export { typedShellTools, type TypedShellContext } from "./tools.ts";
export type { ShellRunResult } from "./runner.ts";

/** 工具包里和这些工具有关的两个开关 */
export interface ShellToolkit {
  bash: boolean;
  network: boolean;
}

export interface TypedShellOptions {
  /** 守护进程自己的环境：只从中挑系统变量给工具起的进程 */
  parentEnv: Readonly<Record<string, string | undefined>>;
  /** 展开 `~` 用的用户主目录（和守卫判定用的同一个） */
  homeDir: string;
  /**
   * 单次调用的超时：defaultMs 是 agent 管家的工具调用超时（配置 agents.toolCallMinutes）；
   * 跑测试、启动构建、装依赖声明更长的 longMs（配置 shellTools.longCallMinutes），管家按它计时
   */
  timeouts: { defaultMs: number; longMs: number };
  /** GitHub 命令行：程序和它前面的固定参数，默认 ["gh"]（PATH 上的）。测试里换成假的，不真的连 GitHub */
  ghCommand?: readonly string[];
  /** 每次调用建 Job 对象；默认 Windows 上建，别的系统不建 */
  newJob?: () => JobObject | undefined;
  log: (line: string) => void;
}

export interface TypedShell {
  /** 一个会话的工具：bash 关着时一个都没有，联网关着时没有要联网的 */
  toolsFor(session: { cwd: string; toolkit: ShellToolkit }): HostTool[];
  /**
   * 跑一段固定的脚本（13 号票的阶段验收：用户确认过的计划里写的，不经守卫）：和工具一样的启动器
   * （闸门进程先放进这次调用的 Job 对象再起 Git Bash）、环境和联网开关
   */
  runScript(input: { cwd: string; script: string; network: boolean; timeoutMs: number; signal?: AbortSignal }): Promise<ShellRunResult>;
}

/**
 * 工具起的进程固定加的：git 不弹提示、不开编辑器、不分页（没有终端）；Git Bash 起 Windows 程序时不改写参数
 * （MSYS 默认把像 POSIX 路径的参数换成 Windows 路径，`/x/y` 会变成 `X:/y`：附加参数要原样交给项目的脚本）
 */
const SHELL_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  MSYS_NO_PATHCONV: "1",
  MSYS2_ARG_CONV_EXCL: "*",
});

export function createTypedShell(options: TypedShellOptions): TypedShell {
  const newJob = options.newJob ?? (() => (process.platform === "win32" ? createJobObject() : undefined));
  let bash: string | undefined;
  /** 在 Git Bash 里跑一段脚本：环境照联网开关，每次一个 Job 对象 */
  const run = (input: { cwd: string; script: string; args?: readonly string[]; network: boolean; timeoutMs: number; signal?: AbortSignal | undefined }): Promise<ShellRunResult> => {
    bash ??= findGitBash(options.parentEnv);
    if (bash === undefined) return Promise.resolve({ exitCode: null, stdout: "", output: "", truncated: false, error: "找不到 Git Bash（要装 Git for Windows）" });
    // 238 号票：告诉脚本和它起的程序"你在哪个 Git Bash 里"。findGitBash 找到的 Git\bin\bash.exe 是 Git for Windows 的
    // 包装脚本，它 exec 的 Git\usr\bin\bash.exe 才是 bash 本身（bash 里的 $BASH 就是后者）；SHELL 统一指向实现的这一条
    // （MSYS 起 native 程序时会换成真正的 bash 那条，两个是同一个 Git Bash）。
    // 不沿用外面可能有、可能没有的那个（从 PowerShell、LSM 起来时没有，脚本里看到的就是 null）。
    // 只在 Windows 上设：别的系统上 findGitBash 给的是 PATH 上的 "bash"，不是路径。
    const env = buildChildEnv(options.parentEnv, {
      ...SHELL_ENV,
      ...(process.platform === "win32" ? { SHELL: bash } : {}),
      ...(input.network ? {} : OFFLINE_SHELL_ENV),
    });
    const { cwd, script, args, timeoutMs, signal } = input;
    return runShell({ bash, script, ...(args ? { args } : {}), cwd, env, timeoutMs, ...(signal ? { signal } : {}), newJob });
  };
  return {
    toolsFor({ cwd, toolkit }) {
      if (!toolkit.bash) return [];
      const tools = typedShellTools({
        cwd,
        network: toolkit.network,
        homeDir: options.homeDir,
        timeouts: options.timeouts,
        ghCommand: options.ghCommand ?? ["gh"],
        run: (dir, script, args, { timeoutMs, signal }) => run({ cwd: dir, script, args, network: toolkit.network, timeoutMs, signal }),
      });
      return toolkit.network ? tools : tools.filter((t) => t.descriptor.network !== true);
    },
    runScript: (input) => run(input),
  };
}
