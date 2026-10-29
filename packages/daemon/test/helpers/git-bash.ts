// 238 号票：这台机器上有没有 Git Bash（靠 bash 跑的测试在真找不到时明确跳过，不要表现成 30 秒超时）。
// 找法和守护进程一样（src/typed-shell/git-bash.ts 的 findGitBash）：Windows 上先找 Program Files 下的
// Git\bin\bash.exe，再找 PATH 上不是 WSL 的那个；别的系统上就是 PATH 上的 bash。
// 本文件不引用 vitest，测试夹具进程也能用。
import { findGitBash } from "../../src/typed-shell/git-bash.ts";

/**
 * 找到的 Git Bash：Windows 上是 `C:\Program Files\Git\bin\bash.exe` 这类**包装脚本**，它 exec 的
 * `Git\usr\bin\bash.exe` 才是 bash 本身（bash 里的 `$BASH` 就是后者）；这台机器上没有时是 undefined。
 */
export const gitBash = findGitBash(process.env);

/** 有没有 Git Bash：依赖它的 describe / it 用 `skipIf(!hasGitBash)` 跳过 */
export const hasGitBash = gitBash !== undefined;

/** 真找不到 Git Bash 时的一句话：跳过、超时错误里带上，省得让人以为功能坏了 */
export const NO_GIT_BASH =
  "这台机器上没找到 Git Bash（C:\\Program Files\\Git\\bin\\bash.exe，或者 PATH 上不带 WSL 的那个）；先把 Git for Windows 的 bin 放进 PATH（docs/developer-guide.md 的“前提”），靠 bash 跑的测试才跑得起来";

/**
 * 工具起的进程里 `SHELL` 的期望值（238 号票统一到这一条）。实现（`typed-shell/index.ts`）把 `findGitBash` 找到的路径
 * 设成 SHELL：Windows 上是 `Git\bin\bash.exe`——Git for Windows 的**包装脚本**；它 exec 的 `Git\usr\bin\bash.exe`
 * 才是 bash 本身（bash 里的 `$BASH` 也是后者）。这是同一个 Git Bash 的两条路径：直接是 bash 的子进程看到包装这一条；
 * 经 npm 的 shim（sh 再起 native 程序）转身的，MSYS 会换成真正的 bash 路径，看到 `usr\bin` 那一条。两种都对，
 * 所以断言统一认这两种，不再一边写 `usr\bin`、一边只认 `bin`。
 * 别的系统上 findGitBash 给的是 PATH 上的 bash，SHELL 由跑测试的环境给。
 */
export const GIT_BASH_SHELL = process.platform === "win32" ? /Git[\\/](?:usr[\\/])?bin[\\/]bash\.exe$/i : /bash/i;
