// 测试里的 git 仓库：建在临时目录里，测试进程自己跑 git 时不读用户的 git 配置和凭据
// （HOME 换成临时目录、不读系统级和全局配置），作者写在仓库自己的配置里。远端用临时目录里的本地裸仓库，不碰网络。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTempDir } from "./temp-dir.ts";

/** 不存在的主目录：git 在这里找不到任何全局配置 */
const NO_HOME = path.join(os.tmpdir(), "ergo-test-no-home");

/** 测试进程自己跑 git 用的环境：不读用户主目录下的配置、不读系统配置、不弹任何提示 */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: NO_HOME,
    USERPROFILE: NO_HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(NO_HOME, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** 在 dir 里跑一条 git，返回 stdout（失败抛错） */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env: isolatedGitEnv(), encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** 写文件（自动建上级目录） */
export function put(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 把 dir 变成一个 git 仓库（主分支 main，作者写在仓库配置里），写进这些文件并提交一次；返回提交号 */
export function initRepo(dir: string, files: Record<string, string> = { "README.md": "# 测试仓库\n" }): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "二狗测试");
  git(dir, "config", "user.email", "ergo-test@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  for (const [rel, content] of Object.entries(files)) put(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "初始提交");
  return head(dir);
}

/** 临时目录里的一个本地裸仓库（当远端用），返回它的路径 */
export function bareRemote(): string {
  const dir = path.join(makeTempDir("ergo-remote-"), "remote.git");
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}

export function head(dir: string, ref = "HEAD"): string {
  return git(dir, "rev-parse", ref).trim();
}

/** 未提交的改动（porcelain 的每一行） */
export function status(dir: string): string[] {
  return git(dir, "status", "--porcelain=v1").split("\n").filter((l) => l !== "");
}
