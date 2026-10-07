// 带类型的特殊 bash 工具（28 号票）。上层只从这里取东西：
// - createTypedShell(...)：守护进程里建一份（环境、超时、GitHub 命令行在哪）；
// - toolsFor({ cwd, toolkit })：一个会话的工具，随工具包的 bash 开关出现——bash 关着时一个都没有。
//   拉起会话的模块把它们加进代为执行的工具（hostTools），pi 的工具里同时给 bash；秘书的固定工具里没有它们。
//
// 工具起的进程：环境是系统变量白名单（buildChildEnv，没有守护进程的密钥；推送、建远端仓库靠本机已登录的 git 和
// GitHub 命令行，二狗不另外注入凭据），联网开关关着时另加一组无效代理（OFFLINE_SHELL_ENV）；每次调用一个 Job 对象（runner.ts）。
import type { HostTool } from "../agent-manager/host-tools.ts";
import { buildChildEnv, OFFLINE_SHELL_ENV } from "../process/child-env.ts";
import { createJobObject, type JobObject } from "../process/job-object.ts";
import { findGitBash } from "./git-bash.ts";
import { runShell } from "./runner.ts";
import { typedShellTools } from "./tools.ts";

export { typedShellTools, type TypedShellContext } from "./tools.ts";

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
  /** 一个会话的工具：bash 关着时一个都没有 */
  toolsFor(session: { cwd: string; toolkit: ShellToolkit }): HostTool[];
}

/** git 不弹提示、不开编辑器、不分页（工具起的进程没有终端） */
const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
});

export function createTypedShell(options: TypedShellOptions): TypedShell {
  const newJob = options.newJob ?? (() => (process.platform === "win32" ? createJobObject() : undefined));
  let bash: string | undefined;
  return {
    toolsFor({ cwd, toolkit }) {
      if (!toolkit.bash) return [];
      const env = buildChildEnv(options.parentEnv, { ...GIT_ENV, ...(toolkit.network ? {} : OFFLINE_SHELL_ENV) });
      return typedShellTools({
        cwd,
        network: toolkit.network,
        homeDir: options.homeDir,
        timeouts: options.timeouts,
        ghCommand: options.ghCommand ?? ["gh"],
        async run(dir, script, args, { timeoutMs, signal }) {
          bash ??= findGitBash(options.parentEnv);
          if (bash === undefined) return { exitCode: null, stdout: "", output: "", truncated: false, error: "找不到 Git Bash（要装 Git for Windows）" };
          return runShell({ bash, script, args, cwd: dir, env, timeoutMs, ...(signal ? { signal } : {}), newJob });
        },
      });
    },
  };
}
