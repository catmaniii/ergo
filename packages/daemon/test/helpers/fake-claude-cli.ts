// 测试用的本机 claude 命令行（292 号票，只在测试里）：Claude Code 插件交给官方 App、收回时跑的 `claude agents --json [--all]`、
// `claude --bg --resume <id> [--remote-control <名字>]`、`claude stop <短id>`、`claude logs <短id>` 换成它——不起真的 claude、不花额度、
// 不碰用户真实的 ~/.claude。它照调研 35 实测的样子扮演本机：
// - 后台会话（jobs）：第一次带 --remote-control 开，短 id 是会话 id 的前 8 位，连上 claude.ai（链接每次同一个）；`stop` 后停着（加 --all 才列出来）；
//   停着的不带参数唤醒（照存下的参数醒来、同一个链接），带了参数另开一份副本（新的短 id、新的链接）；
// - 这个会话在别的进程里开着（终端里 interactive，或者 ergoOpen 说二狗自己的进程还在）时 `--bg` 不抢、另开一份副本；
// - `logs` 只在后台会话在跑时有输出（后台界面的样子，带控制序列和链接）。
// 给了 290 号票的假会话来源（FakeClaudeSessions）时，它的"正开着的"（open）照这里的状态算（原来写进去的条目照样留着）。
import type { ClaudeCli, ClaudeCliResult } from "../../src/claude-code/cli.ts";
import type { ClaudeRunningSession } from "../../src/claude-code/sessions-protocol.ts";
import type { FakeClaudeSessions } from "./fake-claude-sessions.ts";

interface FakeJob {
  sessionId: string;
  /** 在跑的有进程号 */
  pid?: number;
  /** 开它时存下的参数 */
  flags: string[];
  /** 连着 claude.ai 的链接（带 --remote-control 开的才有） */
  url?: string;
}

const ok = (stdout: string): ClaudeCliResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ClaudeCliResult => ({ code: 1, stdout: "", stderr });

export class FakeClaudeCli implements ClaudeCli {
  /** 跑过的命令（参数原样）和在哪个目录跑的 */
  readonly calls: Array<{ args: string[]; cwd?: string }> = [];
  /** 本机的后台会话：短 id → 状态 */
  readonly jobs = new Map<string, FakeJob>();
  /** 终端里开着的会话（interactive，带进程号） */
  interactive: Array<{ sessionId: string; pid: number }> = [];
  /** 二狗自己的进程（经 SDK 起的，agents 里也显示成 interactive）：测试按维护者的子进程在不在给 */
  ergoOpen: () => Array<{ sessionId: string; pid: number }> = () => [];
  /** 原来写进假会话来源 open 里的条目（照样列出来） */
  private extra: ClaudeRunningSession[] = [];
  /** `agents` 跑不了（给了就抛这个错） */
  agentsError: Error | undefined;
  /** `--bg` 跑不了（退出码 1，这句写在标准错误里） */
  bgError: string | undefined;
  /** 在别的进程里开着、agents 却还没列出来的会话（刚起的进程）：`--bg` 照样另开一份副本 */
  hidden: string[] = [];
  private nextPid = 40_000;
  private copies = 0;

  constructor(sessions?: FakeClaudeSessions) {
    if (sessions) {
      this.extra = sessions.open instanceof Error ? [] : [...sessions.open];
      Object.defineProperty(sessions, "open", {
        configurable: true,
        get: () => this.entries(false),
        set: (value: ClaudeRunningSession[] | Error) => {
          this.extra = value instanceof Error ? [] : [...value];
        },
      });
    }
  }

  /** `claude agents --json [--all]` 列的（解析过的样子） */
  entries(all: boolean): ClaudeRunningSession[] {
    const out: ClaudeRunningSession[] = [...this.extra];
    for (const e of [...this.interactive, ...this.ergoOpen()]) out.push({ sessionId: e.sessionId, kind: "interactive", pid: e.pid, name: `work-${e.pid}` });
    for (const [id, job] of this.jobs) {
      if (job.pid !== undefined) out.push({ sessionId: job.sessionId, kind: "background", pid: job.pid, id, name: id });
      else if (all) out.push({ sessionId: job.sessionId, kind: "background", id, name: id });
    }
    return out;
  }

  /** 这个会话的后台会话（短 id 和状态） */
  jobOf(sessionId: string): [string, FakeJob] | undefined {
    return [...this.jobs].find(([, job]) => job.sessionId === sessionId);
  }

  /** 只看命令本身（不看 agents）：按先后，参数用空格连起来 */
  commands(): string[] {
    return this.calls.filter((c) => c.args[0] !== "agents").map((c) => c.args.join(" "));
  }

  run(args: readonly string[], options: { cwd?: string } = {}): Promise<ClaudeCliResult> {
    this.calls.push({ args: [...args], ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
    return Promise.resolve(this.answer([...args]));
  }

  private answer(args: string[]): ClaudeCliResult {
    if (args[0] === "agents") {
      if (this.agentsError) throw this.agentsError;
      const all = args.includes("--all");
      return ok(
        JSON.stringify(
          this.entries(all).map((e) => (e.kind === "background" ? { ...e, state: e.pid === undefined ? "stopped" : "working", ...(e.pid === undefined ? {} : { status: "idle" }) } : { ...e, status: "idle" })),
        ),
      );
    }
    if (args[0] === "--bg") return this.background(args);
    if (args[0] === "stop") {
      const job = this.jobs.get(args[1]!);
      if (!job || job.pid === undefined) return fail(`no running background session ${args[1]}`);
      delete job.pid;
      return ok(`stopped ${args[1]}\n`);
    }
    if (args[0] === "logs") {
      const job = this.jobs.get(args[1]!);
      if (!job || job.pid === undefined) return fail("connect ENOENT \\\\.\\pipe\\claude-daemon");
      return ok(
        `\u001b[2J\u001b[H\u001b[1m Claude Code \u001b[0m\n${job.url ? `\u001b[32m/remote-control is active\u001b[0m · Continue here, on your phone, or at ${job.url}\n` : ""}\u001b[2m auto mode on\u001b[0m\n`,
      );
    }
    return fail(`unknown command: ${args.join(" ")}`);
  }

  private background(args: string[]): ClaudeCliResult {
    if (this.bgError) return fail(this.bgError);
    const sessionId = args[args.indexOf("--resume") + 1]!;
    const flags = args.slice(args.indexOf("--resume") + 2);
    const short = sessionId.slice(0, 8);
    const start = (id: string, job: FakeJob) => {
      job.pid = this.nextPid++;
      this.jobs.set(id, job);
    };
    // 别的进程开着：不抢，另开一份副本（调研 35 E1）
    const open = [...this.interactive, ...this.ergoOpen(), ...this.hidden.map((id) => ({ sessionId: id }))].find((e) => e.sessionId === sessionId);
    if (open) {
      const copy = `copy${++this.copies}`.padEnd(8, "0");
      start(copy, { sessionId: `${copy}-0000-4000-8000-000000000000`, flags });
      return ok(`note: session ${short} is open in another Claude Code process, so this started a copy as ${copy}. The original conversation is unchanged.\nbackgrounded · ${copy} (idle — send a prompt to start)\n`);
    }
    const existing = this.jobs.get(short);
    if (existing) {
      if (existing.pid !== undefined) return ok(`backgrounded · ${short} (already running)\n`);
      // 停着的带参数：另开一份副本（调研 35 第 6a 步）
      if (flags.length > 0) {
        const copy = `copy${++this.copies}`.padEnd(8, "0");
        start(copy, { sessionId: `${copy}-0000-4000-8000-000000000000`, flags, url: `https://claude.ai/code/session_01Copy${this.copies}` });
        return ok(
          `note: background session ${short} keeps its own saved options, so the flags you passed started a copy as ${copy}. Without flags, the same command continues ${short} itself.\nbackgrounded · ${copy} (idle — send a prompt to start)\n`,
        );
      }
      start(short, existing);
      return ok(`note: woke session ${short} with its saved options (${existing.flags.filter((f) => f.startsWith("--")).join(" ")}).\nbackgrounded · ${short} (idle — send a prompt to start)\n`);
    }
    start(short, { sessionId, flags, ...(flags.includes("--remote-control") ? { url: `https://claude.ai/code/session_01Rc${short}` } : {}) });
    return ok(`Starting background service…\nbackgrounded · ${short} (idle — send a prompt to start)\n`);
  }
}
