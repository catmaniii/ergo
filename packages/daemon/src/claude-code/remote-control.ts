// Claude Code 会话交给官方 App（Remote Control）、再收回来，运行时自己的那一半（292 号票；实测见 docs/research/35-remote-control-takeover-switch-probe.md
// 第 3、4 节）。二狗这一侧的顺序（打断、关掉自己的进程、记下在哪边、只读跟随、收回后接着同一个会话）在接管服务（takeover/）。
//
// 交出去（open）：
// 1. 核对二狗自己的进程退干净了：`claude agents --json` 里这个会话没有带进程号的条目（二狗经 SDK 起的进程也显示成 interactive）。
//    还看得到就隔一会儿再看，到点还在就不交——这时 `claude --bg` 不会抢，会默默另开一份副本（调研 35 E1）。已经有后台会话在跑的直接认它；
// 2. 有没有停着的后台会话记着它（二狗记着的 job，或者 `claude agents --json --all` 里有这个会话的后台条目）：
//    - 没有（第一次）：`claude --bg --resume <id> --remote-control "<名字>"`；
//    - 有：`claude --bg --resume <id>`，一个参数都不带——带了就按新参数另开一份副本（调研 35 第 6a 步），不带它按存下的参数（--remote-control）醒来；
//    命令在会话原来的工作目录里跑；
// 3. 输出里说"started a copy as …"的：没接着原会话，停掉副本、不算交出去；
// 4. 再看 agents：这个会话有带进程号的后台条目才算开起来了（短 id 用它的 id）；
// 5. 链接：`claude logs <短id>` 里的 claude.ai 地址（实测约 3 秒出来，每次同一个）；一时拿不到不算失败，跟随时再拿。
// 收回（stop）：`claude stop <短id>`，再看 agents 直到这个会话没有带进程号的条目（实测 1–1.5 秒）；它已经不在了也算停了；
// 用户在终端里开着它的（interactive）停不掉，写明在哪开着。
// 只读跟随（follow）：经一次性子进程用 SDK 读会话（sessions.ts 的会话来源），不碰后台会话。
// 命令行可注入（cli.ts 的 ClaudeCli）：正式的由守护进程直接拉起、不进二狗的 Job（见 cli.ts），测试换成扮演本机 claude 的假的。
import { t } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import type { RuntimeRemoteControl } from "../runtime/index.ts";
import { parseAgents } from "./agents-json.ts";
import type { ClaudeCli } from "./cli.ts";
import type { ClaudeRunningSession } from "./sessions-protocol.ts";
import { busyOf, type ClaudeSessionSource } from "./sessions.ts";

/** 各步等多久（毫秒）：轮询的间隔、等二狗的进程退干净、等后台会话出现、等链接、等停掉 */
export interface RemoteTiming {
  pollMs: number;
  exitWaitMs: number;
  startWaitMs: number;
  linkWaitMs: number;
  stopWaitMs: number;
}

const DEFAULT_TIMING: RemoteTiming = { pollMs: 1000, exitWaitMs: 10_000, startWaitMs: 8_000, linkWaitMs: 10_000, stopWaitMs: 10_000 };

export interface ClaudeRemoteDeps {
  /** 跑命令行（插件在运行时才有，现取） */
  cli(): ClaudeCli;
  /** 会话来源（只读跟随经它读会话） */
  source(): ClaudeSessionSource;
  log(line: string): void;
  /** 测试调短 */
  timing?: Partial<RemoteTiming>;
}

/** `claude --bg` 的输出里说开了一份副本（"started a copy as a87273db"） */
export function copiedAs(output: string): string | undefined {
  return /started a copy as ([0-9a-z][0-9a-z-]*)/i.exec(output)?.[1];
}

/** `claude --bg` 的输出里的后台会话短 id（"backgrounded · c153a547"） */
export function backgroundedAs(output: string): string | undefined {
  return /backgrounded\s*·\s*([0-9a-z][0-9a-z-]*)/i.exec(output)?.[1];
}

/** 终端控制序列（`claude logs` 交回的是后台界面的样子） */
// oxlint-disable-next-line no-control-regex -- 要认的就是控制序列
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** `claude logs` 里官方 App 接着它的链接（"/remote-control is active · … at https://claude.ai/code/session_…"）：最后出现的那个 */
export function remoteLinkIn(output: string): string | undefined {
  const plain = output.replace(ANSI, "");
  const found = [...plain.matchAll(/https:\/\/claude\.ai\/code\/[A-Za-z0-9_\-/]+/g)].map((m) => m[0]);
  return found.at(-1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询 agents 的结果：等到了（result），或者到点了、最后一次看到的在跑的条目（live） */
type Polled<T> = { result: T } | { live: ClaudeRunningSession[] };

/** 带进程号的条目（在跑的） */
const liveOf = (entries: readonly ClaudeRunningSession[]) => entries.filter((e) => e.pid !== undefined);
/** 在跑的后台会话 */
const backgroundOf = (entries: readonly ClaudeRunningSession[]) => entries.find((e) => e.kind === "background" && e.pid !== undefined);

/** 一条命令的出错说明（退出码、标准错误或输出的头几行） */
function failure(args: readonly string[], result: { code: number | null; stdout: string; stderr: string }): string {
  const said = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(0, 3).join(" ");
  return `claude ${args.join(" ")}：退出码 ${result.code ?? "?"}${said ? `，${said}` : ""}`; // @i18n-ignore log：命令行的出错说明（交给人看的那句另外包一层）
}

/** Claude Code 的 Remote Control 那一半（见文件开头） */
export function claudeRemoteControl(deps: ClaudeRemoteDeps): RuntimeRemoteControl {
  const timing: RemoteTiming = { ...DEFAULT_TIMING, ...deps.timing };

  /** `claude agents --json [--all]` 里这个会话的条目；跑不了抛错 */
  const entriesOf = async (sessionId: string, all = false): Promise<ClaudeRunningSession[]> => {
    const args = ["agents", "--json", ...(all ? ["--all"] : [])];
    const result = await deps.cli().run(args);
    if (result.code !== 0) throw new Error(failure(args, result));
    return parseAgents(result.stdout).filter((e) => e.sessionId === sessionId);
  };

  /** 隔一会儿看一次 agents，直到 done 给出结果或者到点（到点交回最后一次看到的条目） */
  const poll = async <T>(sessionId: string, waitMs: number, done: (live: ClaudeRunningSession[]) => T | undefined): Promise<Polled<T>> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const live = liveOf(await entriesOf(sessionId));
      const result = done(live);
      if (result !== undefined) return { result };
      if (Date.now() >= deadline) return { live };
      await sleep(timing.pollMs);
    }
  };

  const link = async (job: string): Promise<string | undefined> => {
    try {
      const result = await deps.cli().run(["logs", job]);
      return result.code === 0 ? remoteLinkIn(result.stdout) : undefined;
    } catch (err) {
      deps.log(`claude logs ${job} 出错：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  /** 等链接出来（到点拿不到是 undefined） */
  const waitLink = async (job: string): Promise<string | undefined> => {
    const deadline = Date.now() + timing.linkWaitMs;
    for (;;) {
      const url = await link(job);
      if (url !== undefined || Date.now() >= deadline) return url;
      await sleep(timing.pollMs);
    }
  };

  return {
    async open({ sessionId, cwd, name, job: knownJob }) {
      // 1. 二狗自己的进程退干净了（已经有后台会话在跑的直接认它）
      let gone: Polled<{ running?: ClaudeRunningSession }>;
      try {
        gone = await poll(sessionId, timing.exitWaitMs, (live) => {
          const running = backgroundOf(live);
          if (running) return { running };
          return live.length === 0 ? {} : undefined;
        });
      } catch (err) {
        throw new RequestRejected("conflict", t("claudeCode.remote.checkFailed", { error: err instanceof Error ? err.message : String(err) }));
      }
      if (!("result" in gone)) throw new RequestRejected("conflict", t("claudeCode.remote.stillOpen", { busy: busyOf(gone.live) ?? "", seconds: Math.round(timing.exitWaitMs / 1000) }));
      if (gone.result.running) {
        const job = gone.result.running.id ?? knownJob;
        if (job === undefined) throw new RequestRejected("conflict", t("claudeCode.remote.stillOpen", { busy: busyOf([gone.result.running]) ?? "", seconds: Math.round(timing.exitWaitMs / 1000) }));
        deps.log(`Claude Code 会话 ${sessionId} 已经有后台会话在跑（${job}），直接认它`);
        const url = await waitLink(job);
        return { job, ...(url === undefined ? {} : { url }) };
      }
      // 2. 第一次带名字连上官方 App；停着的后台会话记着它的不带参数唤醒（带了会开出副本）
      let job = knownJob;
      if (job === undefined) {
        try {
          job = (await entriesOf(sessionId, true)).find((e) => e.kind === "background")?.id;
        } catch (err) {
          throw new RequestRejected("conflict", t("claudeCode.remote.checkFailed", { error: err instanceof Error ? err.message : String(err) }));
        }
      }
      const args = job === undefined ? ["--bg", "--resume", sessionId, "--remote-control", name] : ["--bg", "--resume", sessionId];
      let output: string;
      try {
        const result = await deps.cli().run(args, { cwd });
        if (result.code !== 0) throw new Error(failure(args, result));
        output = `${result.stdout}\n${result.stderr}`;
      } catch (err) {
        throw new RequestRejected("conflict", t("claudeCode.remote.startFailed", { error: err instanceof Error ? err.message : String(err) }));
      }
      // 3. 开出了副本：停掉副本，不算交出去
      const copy = copiedAs(output);
      if (copy !== undefined) {
        deps.log(`claude ${args.join(" ")} 开出了副本 ${copy}，停掉它`);
        await deps
          .cli()
          .run(["stop", copy])
          .catch((err: unknown) => deps.log(`停副本 ${copy} 出错：${err instanceof Error ? err.message : String(err)}`));
        throw new RequestRejected("conflict", t("claudeCode.remote.copied", { copy }));
      }
      // 4. 后台会话在跑了才算
      let started: Polled<ClaudeRunningSession>;
      try {
        started = await poll(sessionId, timing.startWaitMs, backgroundOf);
      } catch (err) {
        throw new RequestRejected("conflict", t("claudeCode.remote.checkFailed", { error: err instanceof Error ? err.message : String(err) }));
      }
      if (!("result" in started)) throw new RequestRejected("conflict", t("claudeCode.remote.notStarted"));
      const running = started.result.id ?? backgroundedAs(output) ?? job;
      if (running === undefined) throw new RequestRejected("conflict", t("claudeCode.remote.notStarted"));
      deps.log(`Claude Code 会话 ${sessionId} 交给官方 App：${job === undefined ? "第一次开" : "唤醒"}后台会话 ${running}`);
      // 5. 链接
      const url = await waitLink(running);
      return { job: running, ...(url === undefined ? {} : { url }) };
    },

    link: async ({ job }) => link(job),

    async stop({ sessionId, job }) {
      try {
        const result = await deps.cli().run(["stop", job]);
        // 已经不在了（停过、后台服务重启过）照样往下看 agents
        if (result.code !== 0) deps.log(failure(["stop", job], result));
      } catch (err) {
        deps.log(`claude stop ${job} 出错：${err instanceof Error ? err.message : String(err)}`);
      }
      let stopped: Polled<true>;
      try {
        stopped = await poll(sessionId, timing.stopWaitMs, (live) => (live.length === 0 ? true : undefined));
      } catch (err) {
        throw new RequestRejected("conflict", t("claudeCode.remote.checkFailed", { error: err instanceof Error ? err.message : String(err) }));
      }
      if (!("result" in stopped)) throw new RequestRejected("conflict", t("claudeCode.remote.stopFailed", { busy: busyOf(stopped.live) ?? "", seconds: Math.round(timing.stopWaitMs / 1000) }));
    },

    follow: ({ sessionId, after, final, tail }) => deps.source().follow(sessionId, { ...(after === undefined ? {} : { after }), final, ...(tail ? { tail } : {}) }),
  };
}
