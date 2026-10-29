// @i18n-ignore-file model：参数不对的原因写进工具结果（给模型看）
// 在 Git Bash 里跑一段脚本（带类型的 bash 工具都经这里执行，规格第 3、9 节）：
// - 以给定的目录为当前目录。值（模型给的仓库路径、分支、提交说明、附加参数、包名……）一律不上命令行：Git Bash 是 MSYS 程序，
//   它的运行时会把命令行上的参数当通配符展开（`*.ts` 变成文件名）、当响应文件读进来（`@secret.txt` 变成文件内容）。
//   命令行上只有固定的脚本；值经 stdin 按 NUL 分隔送进去，脚本开头（VALUES_PRELUDE）读进 "$@"，脚本里只用 "$@"、"$1"…，
//   不拼进脚本，也不被 shell 再解释；
// - 环境由调用方显式给出（buildChildEnv：系统变量白名单，不带守护进程的密钥）；
// - 每次调用建一个 Job 对象（只在 Windows 上有：KILL_ON_JOB_CLOSE、不允许脱离），先经闸门进程（process/gated-spawn.ts，
//   和 MCP 服务进程共用）放进去再起 Git Bash，所以它起的进程、孙进程都在里面。结束时（跑完、超时、被中止）关掉这个 Job，
//   还活着的（比如测试起的后台进程）一起结束。不放进 agent 管家的那个 Job：那里按"从活着的 agent 子进程走不到"回收孤儿，
//   守护进程直接起的进程会被当成孤儿；这个 Job 的句柄只在守护进程手里，守护进程怎么死，里面的进程都跟着结束；
// - 超时、被中止（模型这一轮被中止、agent 退出）时结束整棵进程树，结果里写明。
import { StringDecoder } from "node:string_decoder";
import { type GatedChild, spawnGated } from "../process/gated-spawn.ts";
import type { JobObject } from "../process/job-object.ts";

/** 每段脚本的开头：把 stdin 上按 NUL 分隔的值读进 "$@"（mapfile -d '' 要 bash ≥ 4.4，Git Bash 是 5） */
const VALUES_PRELUDE = `mapfile -d '' -t __ergo_values; set -- "\${__ergo_values[@]}"; unset __ergo_values\n`;

/** stdout 最多留这么多字符（git 的输出要解析；再多的截掉、标出来） */
const STDOUT_MAX = 4 * 1024 * 1024;
/** 交织的输出只留最后这么多字符（跑测试、构建的输出摘要看结尾） */
const OUTPUT_TAIL_MAX = 256 * 1024;

export interface ShellRunOptions {
  /** Git Bash 的 bash.exe */
  bash: string;
  /** bash 脚本（固定的，只有它上命令行）；值用 "$@"、"$1"… 取 */
  script: string;
  /** 脚本的参数：经 stdin 送进去，不上命令行 */
  args?: readonly string[];
  cwd: string;
  /** 完整的环境变量（显式给出，不继承守护进程的环境） */
  env: Record<string, string>;
  timeoutMs: number;
  /** 中止：结束整棵进程树 */
  signal?: AbortSignal;
  /** 给这次调用建一个 Job 对象；返回 undefined（不是 Windows）时不放 */
  newJob?: () => JobObject | undefined;
}

export interface ShellRunResult {
  /** 退出码；没起来、被结束时为 null */
  exitCode: number | null;
  stdout: string;
  /** stdout 和 stderr 按到达先后交织（只留结尾） */
  output: string;
  /** stdout 超过上限被截掉了 */
  truncated: boolean;
  /** 超时或被中止而结束 */
  stopped?: "timeout" | "aborted";
  /** 起不来的原因 */
  error?: string;
}

export function runShell(options: ShellRunOptions): Promise<ShellRunResult> {
  const { signal } = options;
  const values = options.args ?? [];
  if (values.some((v) => v.includes("\0"))) return Promise.resolve({ exitCode: null, stdout: "", output: "", truncated: false, error: "参数里不能有 NUL 字符" });
  if (signal?.aborted) return Promise.resolve({ exitCode: null, stdout: "", output: "", truncated: false, stopped: "aborted" });
  let gated: GatedChild;
  try {
    gated = spawnGated({ cwd: options.cwd, env: options.env, ...(options.newJob ? { newJob: options.newJob } : {}) });
  } catch (err) {
    return Promise.resolve({ exitCode: null, stdout: "", output: "", truncated: false, error: messageOf(err) });
  }
  const { child, job } = gated;
  return new Promise<ShellRunResult>((resolve) => {
    let stdout = "";
    let output = "";
    let truncated = false;
    let stopped: ShellRunResult["stopped"];
    let error: string | undefined;
    const stop = (why: NonNullable<ShellRunResult["stopped"]>) => {
      stopped ??= why;
      // 关掉 Job：里面的进程（闸门、Git Bash 和它起的一切）全部结束；没有 Job 时只能结束闸门进程
      if (job) job.close();
      else child.kill();
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (stream: NodeJS.ReadableStream, isStdout: boolean) => {
      const decoder = new StringDecoder("utf8");
      const take = (text: string) => {
        if (isStdout) {
          if (stdout.length + text.length > STDOUT_MAX) {
            stdout += text.slice(0, Math.max(0, STDOUT_MAX - stdout.length));
            truncated = true;
          } else stdout += text;
        }
        output += text;
        if (output.length > OUTPUT_TAIL_MAX * 2) output = output.slice(-OUTPUT_TAIL_MAX);
      };
      stream.on("data", (chunk: Buffer) => take(decoder.write(chunk)));
      stream.on("end", () => take(decoder.end()));
    };
    collect(child.stdout, true);
    collect(child.stderr, false);
    child.on("error", (err) => {
      error ??= err.message;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // 跑完了也关掉 Job：它留下的后台进程不活过这次调用
      job?.close();
      resolve({
        exitCode: stopped ? null : code,
        stdout,
        output: output.length > OUTPUT_TAIL_MAX ? output.slice(-OUTPUT_TAIL_MAX) : output,
        truncated,
        ...(stopped ? { stopped } : {}),
        ...(error === undefined ? {} : { error }),
      });
    });
    // 放好 Job 之后才告诉闸门进程要跑什么：值从 stdin 送（不上命令行）
    gated.launch({ file: options.bash, args: ["-c", VALUES_PRELUDE + options.script, "bash"], stdin: { values } });
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
