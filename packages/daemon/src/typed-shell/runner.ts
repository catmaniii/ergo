// 在 Git Bash 里跑一段脚本（带类型的 bash 工具都经这里执行，规格第 3、9 节）：
// - 以给定的目录为当前目录，脚本的参数经 "$@" 传进去，不拼进脚本（模型给的附加参数、提交说明原样到达，不被 shell 再解释）；
// - 环境由调用方显式给出（buildChildEnv：系统变量白名单，不带守护进程的密钥）；
// - 每次调用建一个 Job 对象（只在 Windows 上有：KILL_ON_JOB_CLOSE、不允许脱离），先经闸门进程（runner-main.ts）
//   放进去再起 Git Bash，所以它起的进程、孙进程都在里面。结束时（跑完、超时、被中止）关掉这个 Job，
//   还活着的（比如测试起的后台进程）一起结束。不放进 agent 管家的那个 Job：那里按"从活着的 agent 子进程走不到"回收孤儿，
//   守护进程直接起的进程会被当成孤儿；这个 Job 的句柄只在守护进程手里，守护进程怎么死，里面的进程都跟着结束；
// - 超时、被中止（模型这一轮被中止、agent 退出）时结束整棵进程树，结果里写明。
import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { JobObject } from "../process/job-object.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
const RUNNER_ENTRY = fileURLToPath(new URL(`./runner-main${ownExt}`, import.meta.url));

/** stdout 最多留这么多字符（git 的输出要解析；再多的截掉、标出来） */
const STDOUT_MAX = 4 * 1024 * 1024;
/** 交织的输出只留最后这么多字符（跑测试、构建的输出摘要看结尾） */
const OUTPUT_TAIL_MAX = 256 * 1024;

export interface ShellRunOptions {
  /** Git Bash 的 bash.exe */
  bash: string;
  /** bash 脚本；参数用 "$@"、"$1"… 取 */
  script: string;
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
  if (signal?.aborted) return Promise.resolve({ exitCode: null, stdout: "", output: "", truncated: false, stopped: "aborted" });
  let job: JobObject | undefined;
  try {
    job = options.newJob?.();
  } catch (err) {
    return Promise.resolve({ exitCode: null, stdout: "", output: "", truncated: false, error: `建不了 Job 对象：${messageOf(err)}` });
  }
  const child = spawn(process.execPath, [RUNNER_ENTRY], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    if (child.pid === undefined) return;
    try {
      job?.assign(child.pid);
    } catch (err) {
      error = `放不进 Job 对象：${messageOf(err)}`;
      child.kill();
      return;
    }
    // 放好 Job 之后才告诉闸门进程要跑什么
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ file: options.bash, args: ["-c", options.script, "bash", ...(options.args ?? [])] }));
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
