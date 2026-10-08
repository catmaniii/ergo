// 经闸门进程起一个放进 Job 对象的程序（带类型的 bash 工具的每次调用、每个 MCP 服务进程共用，28、27 号票）：
// 先起闸门（gate-main.ts），放进调用方给的 Job（KILL_ON_JOB_CLOSE、不允许脱离；不是 Windows 时没有）之后，才告诉它要跑什么
// （launch），要跑的程序和它起的一切因此都在 Job 里：关掉 Job 整棵进程树一起结束，守护进程怎么死都跟着结束。
// 不放进 agent 管家的那个 Job：那里按"从活着的 agent 子进程走不到"回收孤儿，守护进程直接起的进程会被当成孤儿。
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JobObject } from "./job-object.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
const GATE_ENTRY = fileURLToPath(new URL(`./gate-main${ownExt}`, import.meta.url));

/** 告诉闸门要跑什么（stdin 的第一行）：程序、固定的参数、工作目录，要跑的程序的 stdin 从哪来（见 gate-main.ts） */
export interface GateSpec {
  file: string;
  args: readonly string[];
  cwd?: string;
  stdin: "forward" | { values: readonly string[] };
}

export interface GatedChild {
  /** 闸门进程：它的 stdout / stderr 就是要跑的程序的（继承句柄）；stdin 在 launch 之后按 GateSpec.stdin 用 */
  child: ChildProcessWithoutNullStreams;
  /** 这次的 Job 对象（只在 Windows 上有）：调用方结束时关掉它 */
  job: JobObject | undefined;
  /** 放好 Job 之后告诉闸门要跑什么 */
  launch(spec: GateSpec): void;
}

/**
 * 起闸门进程、放进 Job。环境由调用方显式给出（不继承守护进程的环境）。
 * 建不了 Job、起不来、放不进 Job 都抛错（起了的已经结束、建了的 Job 已经关掉）
 */
export function spawnGated(options: { cwd: string; env: Record<string, string>; newJob?: () => JobObject | undefined }): GatedChild {
  let job: JobObject | undefined;
  try {
    job = options.newJob?.();
  } catch (err) {
    throw new Error(`建不了 Job 对象：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const child = spawn(process.execPath, [GATE_ENTRY], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.on("error", () => {});
  if (child.pid === undefined) {
    job?.close();
    // 起不来的原因在随后的 error 事件里；这里先吞掉，免得没人听时抛成未捕获的错误
    child.on("error", () => {});
    throw new Error("闸门进程起不来");
  }
  try {
    job?.assign(child.pid);
  } catch (err) {
    child.kill();
    job?.close();
    throw new Error(`放不进 Job 对象：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return {
    child,
    job,
    launch(spec) {
      const line = `${JSON.stringify(spec)}\n`;
      if (spec.stdin === "forward") child.stdin.write(line);
      else child.stdin.end(line);
    },
  };
}
