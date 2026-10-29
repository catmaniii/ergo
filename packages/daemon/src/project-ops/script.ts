// 实现方式 script（268 号票，草稿："script 工作目录里的脚本 JSON 进出"）：项目工作目录里的一个脚本，二狗在本机跑它——
// - 哪个脚本：impl.file，相对项目工作目录的路径（要在工作目录里面、要已经存在；链接出去的不算），impl.args 是固定的附加参数；
//   按扩展名选解释器：.mjs .js .cjs .ts .mts 用二狗自己的 node，.py 用 python，.ps1 用 PowerShell，.cmd .bat 经 cmd，.exe 直接跑；
// - JSON 进：标准输入是和 http 一样的请求体 { "name", "arguments", "_meta"? }（验收的测试调用带 "_meta": { "ergo/test": true }），
//   环境变量另有 ERGO_OPS_PROJECT、ERGO_OPS_OP，测试调用还有 ERGO_OPS_TEST=1（312 号票：每个都另带一份旧名字的，早先写的脚本照样读得到）；
// - JSON 出：标准输出照 reply.ts 取能念的那句和附件（{ "say", "detail" } 或 MCP 的 CallToolResult，纯文本整个当附件）；
//   退出码不是 0 的算没做成（标准错误的结尾带回去）；
// - 以工作目录为当前目录，环境照 agent 的子进程那样显式构造（系统变量白名单，不带守护进程的密钥）；每次一个 Job 对象（Windows），
//   跑完、超时（timeoutMs）、被中止时整棵进程树一起结束（同带类型的 bash 工具，process/gated-spawn.ts）。
// @i18n-ignore-file model：跑不起来的说法交给秘书（工具结果）
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { withOldEnvNames } from "../config/old-names.ts";
import { buildChildEnv } from "../process/child-env.ts";
import { type GatedChild, spawnGated } from "../process/gated-spawn.ts";
import type { JobObject } from "../process/job-object.ts";
import { callBody, type OpReach } from "./call.ts";
import { type ParsedReply, parseReply } from "./reply.ts";

/** 标准输出最多留多少字（再多的截掉） */
const STDOUT_MAX = 1024 * 1024;
/** 标准错误只留结尾这么多字 */
const STDERR_TAIL = 4000;

export interface ScriptRunResult {
  reach: OpReach;
  reply: ParsedReply;
  ok: boolean;
  exitCode?: number | null;
}

/** 脚本在工作目录里的绝对路径：在里面、存在、是文件；不是的说清（给秘书 / 维护者看） */
export function scriptPath(workdir: string, file: string): { ok: true; path: string } | { ok: false; reason: string } {
  const full = path.resolve(workdir, file);
  let real: string;
  let root: string;
  try {
    real = fs.realpathSync.native(full);
    root = fs.realpathSync.native(workdir);
  } catch {
    return { ok: false, reason: `工作目录里没有脚本 ${file}` };
  }
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, reason: `脚本 ${file} 不在项目的工作目录里` };
  if (!fs.statSync(real).isFile()) return { ok: false, reason: `${file} 不是一个文件` };
  return { ok: true, path: real };
}

/** 没做成的结果 */
const failed = (reach: OpReach, detail: string): ScriptRunResult => ({ reach, reply: { detail, isError: true }, ok: false });

/** 按扩展名选解释器：程序和参数 */
function commandOf(script: string, args: readonly string[]): { file: string; args: string[] } {
  const ext = path.extname(script).toLowerCase();
  if ([".mjs", ".js", ".cjs", ".ts", ".mts"].includes(ext)) return { file: process.execPath, args: [script, ...args] };
  if (ext === ".py") return { file: process.platform === "win32" ? "python" : "python3", args: [script, ...args] };
  if (ext === ".ps1") return { file: process.platform === "win32" ? "powershell.exe" : "pwsh", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args] };
  if (ext === ".cmd" || ext === ".bat") return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", script, ...args] };
  return { file: script, args: [...args] };
}

/** 跑一次（见文件开头） */
export function runScriptOp(input: {
  workdir: string;
  file: string;
  args: readonly string[];
  projectId: string;
  name: string;
  arguments: Record<string, unknown>;
  test: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  newJob?: () => JobObject | undefined;
}): Promise<ScriptRunResult> {
  const located = scriptPath(input.workdir, input.file);
  if (!located.ok) return Promise.resolve(failed("refused", located.reason));
  if (input.signal?.aborted) return Promise.resolve(failed("aborted", "这次调用被中止了"));
  const env = buildChildEnv(
    process.env,
    withOldEnvNames({
      ERGO_OPS_PROJECT: input.projectId,
      ERGO_OPS_OP: input.name,
      ...(input.test ? { ERGO_OPS_TEST: "1" } : {}),
    }),
  );
  let gated: GatedChild;
  try {
    gated = spawnGated({ cwd: input.workdir, env, ...(input.newJob ? { newJob: input.newJob } : {}) });
  } catch (err) {
    return Promise.resolve(failed("refused", `脚本跑不起来：${err instanceof Error ? err.message : String(err)}`));
  }
  const { child, job } = gated;
  return new Promise<ScriptRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stopped: "timeout" | "aborted" | undefined;
    const stop = (why: "timeout" | "aborted") => {
      stopped ??= why;
      if (job) job.close();
      else child.kill();
    };
    const timer = setTimeout(() => stop("timeout"), input.timeoutMs);
    const onAbort = () => stop("aborted");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < STDOUT_MAX) stdout += out.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + err.write(chunk)).slice(-STDERR_TAIL * 2);
    });
    child.on("error", (e) => {
      stderr += `\n${e.message}`;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      job?.close();
      stdout += out.end();
      stderr = (stderr + err.end()).trim().slice(-STDERR_TAIL);
      if (stopped === "timeout") return resolve(failed("timeout", `等了 ${input.timeoutMs / 1000} 秒脚本还没跑完，结束了它`));
      if (stopped === "aborted") return resolve(failed("aborted", "这次调用被中止了"));
      // 闸门进程起不来要跑的程序时退出码是 127（起不来的原因在标准错误里）
      if (code === 127 && stdout.trim() === "" && stderr.startsWith("起不来")) return resolve({ ...failed("refused", `脚本跑不起来：${stderr}`), exitCode: code }); // @i18n-ignore data：认闸门进程的说法
      const reply = parseReply(stdout.slice(0, STDOUT_MAX), null);
      if (code !== 0) {
        const detail = [reply.detail.trim(), stderr ? `标准错误：${stderr}` : ""].filter(Boolean).join("\n") || `脚本退出码 ${String(code)}`;
        return resolve({ reach: "answered", reply: { ...reply, detail, isError: true }, ok: false, exitCode: code });
      }
      resolve({ reach: "answered", reply, ok: !reply.isError, exitCode: code });
    });
    const command = commandOf(located.path, input.args);
    gated.launch({ file: command.file, args: command.args, stdin: "forward" });
    child.stdin.write(callBody(input.name, input.arguments, input.test));
    child.stdin.end();
  });
}
