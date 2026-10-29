// 守护进程这一侧的 agent 子进程句柄：拉起子进程、放进 Job 对象、送"启动"、收发宿主协议消息。
// 本文件不引用 pi；pi 只在子进程里（agent-child/）。
// 286 号票：拉起哪个子进程入口由调用方按维护者的运行时给（entry，runtimes.ts 的登记表解析）；不给是 pi 的（PI_CHILD_ENTRY）。
// 宿主协议不分运行时：哪个入口都收同一条"启动"、说同一套消息。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_DOMAIN_TERM, ASSISTANT_NAME_MARK } from "@ergo/protocol";
import { HOST_PROTOCOL_VERSION, type AgentReport, type HostCommand, type SessionAssembly } from "./host-protocol.ts";
import { encodeLine, readJsonLines, readLines } from "./line-channel.ts";

// 子进程入口与本文件同扩展名（开发时直接跑 .ts，将来构建成 .js 也对得上）
const ownExt = path.extname(fileURLToPath(import.meta.url));
/** 内核自带的运行时 pi 的子进程入口（agent-child/main）：runtimes.ts 里 pi 照运行时的接口登记时用它 */
export const PI_CHILD_ENTRY = fileURLToPath(new URL(`./agent-child/main${ownExt}`, import.meta.url));

export interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AgentProcess {
  readonly agentId: string;
  readonly pid: number;
  /** 送一条命令（"启动"在拉起时已经自动送过） */
  send(command: Exclude<HostCommand, { type: "start" }>): void;
  /** 订阅子进程发来的消息，返回取消订阅的函数 */
  onReport(listener: (report: AgentReport) => void): () => void;
  /** 子进程退出、且它的输出都读完之后 resolve */
  readonly exited: Promise<AgentExit>;
  /** 强行结束子进程 */
  kill(): void;
}

export interface SpawnAgentProcessOptions {
  session: SessionAssembly;
  /** 子进程入口（实现宿主协议的脚本的绝对路径，用 process.execPath 跑它，286 号票：按维护者的运行时）；不给是 pi 的 */
  entry?: string;
  /** 子进程的完整环境变量（显式给出，不继承守护进程的环境） */
  env: Record<string, string>;
  /** 拉起后立刻放进这个 Job 对象；放进去之后才送"启动"，子进程在收到"启动"之前不会起任何孙进程 */
  job?: { assign(pid: number): void };
  /** 子进程 stderr 的每一行（日志），以及无法解析的输出 */
  onLog?: (line: string) => void;
}

/**
 * 名字占位不进 agent（43 号票）：守护进程生成的话里提到秘书的写名字占位，给人看时前端换成用户起的名字；
 * 这些话也会转给 agent（待我处理的列表、引用的卡片、素材……），往子进程送的每一行都经这里，占位一律换成领域术语"秘书"。
 * 占位里没有 JSON 要转义的字符，在编码好的一行里直接换
 */
const forAgent = (line: string) => line.replaceAll(ASSISTANT_NAME_MARK, ASSISTANT_DOMAIN_TERM);

export function spawnAgentProcess(options: SpawnAgentProcessOptions): AgentProcess {
  const { session } = options;
  const child = spawn(process.execPath, [options.entry ?? PI_CHILD_ENTRY], {
    cwd: session.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = options.onLog ?? (() => {});
  // 拉起失败、或之后杀进程失败时 ChildProcess 会发 error 事件；没人接会让守护进程崩掉
  child.on("error", (err) => log(`子进程出错：${err.message}`));
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`拉起 agent 子进程失败（${session.agentId}）`); // @i18n-ignore log：拉起失败的原因记日志
  }
  try {
    options.job?.assign(pid);
  } catch (err) {
    child.kill();
    throw err;
  }

  const listeners = new Set<(report: AgentReport) => void>();

  readJsonLines<AgentReport>(
    child.stdout,
    (report) => {
      for (const listener of listeners) listener(report);
    },
    { onInvalid: (line) => log(`无法解析的子进程输出：${line}`) },
  );
  readLines(child.stderr, log);

  // 子进程已退出时写 stdin 会 EPIPE，这里吞掉，退出由 exited 体现
  child.stdin.on("error", () => {});

  const exited = new Promise<AgentExit>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const write = (command: HostCommand) => {
    if (!child.stdin.writable) throw new Error(`agent 子进程已退出（${session.agentId}），无法送 ${command.type}`); // @i18n-ignore log：编程错误
    child.stdin.write(forAgent(encodeLine(command)));
  };

  write({ type: "start", protocolVersion: HOST_PROTOCOL_VERSION, session });

  return {
    agentId: session.agentId,
    pid,
    send: write,
    onReport(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited,
    kill: () => {
      child.kill();
    },
  };
}
