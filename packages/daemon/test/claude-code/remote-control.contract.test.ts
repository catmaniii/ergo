// 契约：Claude Code 会话交给官方 App（Remote Control）、收回、只读跟随，运行时自己的那一半（292 号票；调研 35 第 3、4 节）。
// 命令行换成扮演本机 claude 的假的（helpers/fake-claude-cli.ts），SDK 读出的会话记录是编的——不起真的 claude、不读用户真实的 ~/.claude：
// - 交出去：先确认这个会话没有带进程号的条目（二狗的进程退干净了），第一次带名字开、停着的后台会话不带参数唤醒（带了会开出副本），
//   确认后台会话在跑、拿链接（logs 里的地址，去掉控制序列）；已经有后台会话在跑的直接认它；还开着的、开出副本的、没开起来的不算交出去；
// - 收回：stop 之后等到没有带进程号的条目；它已经不在了也算停了；终端里开着的停不掉；
// - 只读跟随（followOf）：从某一条之后读，翻法同前情（元信息的用户消息不算），带着每条的 id 和时间；还没说完的最后一条回复先不交、final 时交；
//   那边压缩过的从压缩标记读起、对不上的不补记；一次最多 max 条；tail 只要最后一条的 id；
// - 维护者现在接着的会话（currentClaudeSession）：会话目录里最近用的那份记录（和适配子进程写的同一个格式），没开始的不算；
// - 守护进程这一侧的命令行：找不到本机的 claude 时直接说清楚（不起进程）。
import fs from "node:fs";
import path from "node:path";
import type { GetSessionMessagesOptions, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { followOf, handleSessionsRequest } from "../../src/claude-code/child/sessions.ts";
import { RECORD_EXT, writeRecord } from "../../src/claude-code/child/records.ts";
import { detachedClaudeCli } from "../../src/claude-code/cli.ts";
import { backgroundedAs, claudeRemoteControl, copiedAs, remoteLinkIn } from "../../src/claude-code/remote-control.ts";
import { currentClaudeSession, SESSION_RECORD_EXT } from "../../src/claude-code/session-records.ts";
import type { ClaudeSessionSource } from "../../src/claude-code/sessions.ts";
import { FakeClaudeCli } from "../helpers/fake-claude-cli.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const FAST = { pollMs: 5, exitWaitMs: 60, startWaitMs: 60, linkWaitMs: 30, stopWaitMs: 60 };
const SID = "c153a547-6723-43cb-9302-3cada99e7193";

const noSource = (): ClaudeSessionSource => {
  throw new Error("用不着会话来源");
};
const control = (cli: FakeClaudeCli, logs: string[] = []) => claudeRemoteControl({ cli: () => cli, source: noSource, log: (line) => logs.push(line), timing: FAST });

// —— 编的会话记录 ——
const m = (type: SessionMessage["type"], uuid: string, message: unknown, extra: Record<string, unknown> = {}): SessionMessage =>
  ({ type, uuid, session_id: SID, message, parent_tool_use_id: null, parent_agent_id: null, ...extra }) as SessionMessage;
const said = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => m("user", uuid, { role: "user", content }, extra);
const reply = (uuid: string, id: string, stop: string | undefined, ...content: unknown[]) => m("assistant", uuid, { role: "assistant", id, content, ...(stop ? { stop_reason: stop } : {}) });
const text = (t: string) => ({ type: "text", text: t });
const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
const toolResult = (uuid: string, id: string, content: string, isError = false) => said(uuid, [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);

describe("交给官方 App：开 / 唤醒后台会话、拿链接（292 号票）", () => {
  it("第一次带名字开，确认后台会话在跑、拿到链接；停着的后台会话不带参数唤醒，同一个链接", async () => {
    const cli = new FakeClaudeCli();
    const remote = control(cli);
    const opened = await remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI" });
    expect(opened).toEqual({ job: "c153a547", url: "https://claude.ai/code/session_01Rcc153a547" });
    expect(cli.calls).toEqual([
      { args: ["agents", "--json"] },
      { args: ["agents", "--json", "--all"] },
      { args: ["--bg", "--resume", SID, "--remote-control", "修 CI"], cwd: "D:/work" },
      { args: ["agents", "--json"] },
      { args: ["logs", "c153a547"] },
    ]);
    await remote.stop({ sessionId: SID, job: "c153a547" });
    expect(cli.jobs.get("c153a547")?.pid).toBeUndefined();

    // 二狗没记着 job 也能从 agents --all 认出停着的后台会话：照样不带参数唤醒
    cli.calls.splice(0);
    const woke = await remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI" });
    expect(woke).toEqual(opened);
    expect(cli.commands()).toEqual([`--bg --resume ${SID}`, "logs c153a547"]);
    // 记着 job 的不再看 --all
    await remote.stop({ sessionId: SID, job: "c153a547" });
    cli.calls.splice(0);
    await remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI", job: "c153a547" });
    expect(cli.calls.map((c) => c.args.join(" "))).toEqual(["agents --json", `--bg --resume ${SID}`, "agents --json", "logs c153a547"]);
    expect(cli.jobs.size).toBe(1);
  });

  it("已经有后台会话在跑的直接认它；二狗的进程一会儿才退的等它；还开着的、开出副本的、没开起来的不算交出去", async () => {
    const cli = new FakeClaudeCli();
    const remote = control(cli);
    await remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI" });
    cli.calls.splice(0);
    expect(await remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI" })).toEqual({ job: "c153a547", url: "https://claude.ai/code/session_01Rcc153a547" });
    expect(cli.commands()).toEqual(["logs c153a547"]);
    await remote.stop({ sessionId: SID, job: "c153a547" });

    // 二狗的进程过一会儿才退：等它退了再开
    let polls = 0;
    cli.ergoOpen = () => (++polls <= 2 ? [{ sessionId: SID, pid: 999 }] : []);
    cli.calls.splice(0);
    await remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI", job: "c153a547" });
    expect(cli.calls.slice(0, 3).map((c) => c.args.join(" "))).toEqual(["agents --json", "agents --json", "agents --json"]);
    await remote.stop({ sessionId: SID, job: "c153a547" });

    // 终端里开着：到点还开着，不交（不跑 --bg）
    cli.ergoOpen = () => [];
    cli.interactive = [{ sessionId: SID, pid: 4321 }];
    cli.calls.splice(0);
    await expect(remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI", job: "c153a547" })).rejects.toThrow("在终端里开着（进程 4321）：等了 0 秒还开着，先不交给官方 App（这时交出去会开出一份副本）");
    expect(cli.commands()).toEqual([]);

    // agents 没列出来、其实开着：claude 另开了一份副本——停掉副本，不算交出去
    cli.interactive = [];
    cli.hidden = [SID];
    await expect(remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI", job: "c153a547" })).rejects.toThrow("Claude Code 没接着原来的会话，另开了一份副本（copy1000），副本已经停掉；先不交给官方 App");
    expect(cli.commands()).toEqual([`--bg --resume ${SID}`, "stop copy1000"]);
    cli.hidden = [];

    // --bg 出错、agents 跑不了
    cli.bgError = "Error: not logged in";
    await expect(remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI", job: "c153a547" })).rejects.toThrow(`后台会话没开起来：claude --bg --resume ${SID}：退出码 1，Error: not logged in`);
    cli.bgError = undefined;
    cli.agentsError = new Error("没找到本机的 claude.exe");
    await expect(remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI" })).rejects.toThrow("查不到这个会话现在有没有开着（没找到本机的 claude.exe），先不动它");
  });

  it("收回：stop 之后等到退干净；已经不在了也算停了；终端里开着的停不掉", async () => {
    const cli = new FakeClaudeCli();
    const logs: string[] = [];
    const remote = control(cli, logs);
    await remote.open({ sessionId: SID, cwd: "D:/work", name: "修 CI" });
    await remote.stop({ sessionId: SID, job: "c153a547" });
    // 再停一次（已经不在了）：照样算停了，日志里记一笔
    await remote.stop({ sessionId: SID, job: "c153a547" });
    expect(logs.some((line) => line.includes("claude stop c153a547：退出码 1"))).toBe(true);
    cli.interactive = [{ sessionId: SID, pid: 4321 }];
    await expect(remote.stop({ sessionId: SID, job: "c153a547" })).rejects.toThrow("在终端里开着（进程 4321）：停了 0 秒还没退，先不收回");
  });

  it("命令行输出：副本、后台会话短 id、logs 里的链接（去掉控制序列，取最后一个）", () => {
    expect(copiedAs("note: background session c153a547 keeps its own saved options, so the flags you passed started a copy as a87273db. Without flags, …")).toBe("a87273db");
    expect(copiedAs("note: woke session c153a547 with its saved options (--remote-control).")).toBeUndefined();
    expect(backgroundedAs("Starting background service…\nbackgrounded · c153a547 (idle — send a prompt to start)")).toBe("c153a547");
    expect(remoteLinkIn("\u001b[2J\u001b[32m/remote-control is active\u001b[0m · Continue here, on your phone, or at https://claude.ai/code/session_01Old\nlater https://claude.ai/code/session_01SsoJugV5aWBwjF4o61PeVd\u001b[0m")).toBe(
      "https://claude.ai/code/session_01SsoJugV5aWBwjF4o61PeVd",
    );
    expect(remoteLinkIn("auto mode on")).toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")("守护进程这一侧的命令行：找不到本机的 claude 时说清楚，不起进程", async () => {
    const empty = makeTempDir("ergo-no-claude-");
    const cli = detachedClaudeCli(() => ({ PATH: empty, USERPROFILE: empty }));
    await expect(cli.run(["agents", "--json"])).rejects.toThrow("没找到本机的 claude.exe");
  });
});

describe("只读跟随：读那边新增的（292 号票）", () => {
  const before = [said("u1", "CI 老是挂"), reply("a1", "m1", "end_turn", text("有两个用例不稳。"))];

  it("从某一条之后读：用户说的、它的回复（工具结果填回去），带着 id 和时间；元信息的用户消息不算；还没说完的最后一条先不交，final 时交", () => {
    const messages = [
      ...before,
      said("r1", "在手机上：再跑一遍", { timestamp: "2026-10-25T02:10:00.000Z" }),
      said("meta", "<system-reminder>x</system-reminder>提醒", { is_meta: true }),
      reply("r2", "m2", "tool_use", text("跑一下。"), bash("toolu_1", "npm test")),
      toolResult("r3", "toolu_1", "2 failed", true),
      reply("r4", "m3", "end_turn", text("还有两个挂着。")),
      said("r5", "再看看 lint"),
      reply("r6", "m4", "tool_use", bash("toolu_2", "npm run lint")),
    ];
    const got = followOf(messages, "a1", false, 100);
    expect(got.items).toEqual([
      { kind: "user", text: "在手机上：再跑一遍", key: "r1", at: "2026-10-25T02:10:00.000Z" },
      { kind: "agent", key: "r2", parts: [{ type: "text", text: "跑一下。" }, { type: "tool", id: "toolu_1", tool: "bash", native: "Bash", args: { command: "npm test" }, result: "2 failed", failed: true }] },
      { kind: "agent", key: "r4", parts: [{ type: "text", text: "还有两个挂着。" }] },
      { kind: "user", text: "再看看 lint", key: "r5" },
    ]);
    // 下次从先不交的那条回复之前接着读
    expect(got.cursor).toBe("r5");
    expect(got.reset).toBeUndefined();
    expect(followOf(messages, got.cursor, false, 100).items).toEqual([]);
    // 后台会话停了（final）：没说完的那条也交
    const last = followOf(messages, got.cursor, true, 100);
    expect(last.items).toEqual([{ kind: "agent", key: "r6", parts: [{ type: "tool", id: "toolu_2", tool: "bash", native: "Bash", args: { command: "npm run lint" } }] }]);
    expect(last.cursor).toBe("r6");
    // 说完了（end_turn）的最后一条照常交；没写 stop_reason 的当没说完
    expect(followOf([...before, said("x1", "嗨"), reply("x2", "m9", "end_turn", text("在。"))], "a1", false, 100).items.map((i) => i.key)).toEqual(["x1", "x2"]);
    expect(followOf([...before, said("x1", "嗨"), reply("x2", "m9", undefined, text("在。"))], "a1", false, 100).items.map((i) => i.key)).toEqual(["x1"]);
  });

  it("找不到从哪接着：那边压缩过的从压缩标记读起，对不上的不补记、挪到最后；一次最多 max 条；不给从哪是从头读", () => {
    const compacted = [m("system", "b1", undefined, { subtype: "compact_boundary" }), said("c1", "压缩之后说的"), reply("c2", "m5", "end_turn", text("好。"))];
    const reset = followOf(compacted, "gone", false, 100);
    expect(reset.reset).toBe("compacted");
    expect(reset.items.map((i) => i.kind)).toEqual(["compacted", "user", "agent"]);
    expect(reset.items[0]!.key).toBe("b1");
    const lost = followOf(before, "gone", false, 100);
    expect(lost).toEqual({ items: [], cursor: "a1", reset: "lost" });
    const capped = followOf([...before, said("d1", "一"), said("d2", "二"), said("d3", "三")], "a1", false, 2);
    expect(capped.items.map((i) => i.key)).toEqual(["d1", "d2"]);
    expect(capped.cursor).toBe("d2");
    expect(followOf(before, undefined, false, 100).items.map((i) => i.key)).toEqual(["u1", "a1"]);
  });

  it("一次性子进程：follow 读会话（含 system 消息），tail 只要最后一条的 id", async () => {
    const seen: Array<[string, GetSessionMessagesOptions | undefined]> = [];
    const sdk = {
      listSessions: () => Promise.resolve([]),
      getSessionMessages: (id: string, options?: GetSessionMessagesOptions) => {
        seen.push([id, options]);
        return Promise.resolve([...before, said("r1", "新的一句")]);
      },
      forkSession: () => Promise.reject(new Error("用不着")),
    };
    const deps = { sdk, runAgents: () => Promise.resolve("[]") };
    expect(await handleSessionsRequest({ op: "follow", sessionId: SID, final: true, max: 10, tail: true }, deps)).toEqual({ op: "follow", follow: { items: [], cursor: "r1" } });
    const got = await handleSessionsRequest({ op: "follow", sessionId: SID, after: "a1", final: false, max: 10 }, deps);
    expect(got).toEqual({ op: "follow", follow: { items: [{ kind: "user", text: "新的一句", key: "r1" }], cursor: "r1" } });
    expect(seen).toEqual([
      [SID, { includeSystemMessages: true }],
      [SID, { includeSystemMessages: true }],
    ]);
  });
});

describe("维护者现在接着的 Claude Code 会话（292 号票）", () => {
  it("会话目录里最近用的那份记录（和适配子进程写的同一个格式）；最近那份还没开始的、没有记录的是 undefined", async () => {
    expect(SESSION_RECORD_EXT).toBe(RECORD_EXT);
    const dir = makeTempDir("ergo-records-");
    expect(currentClaudeSession(dir)).toBeUndefined();
    expect(currentClaudeSession(path.join(dir, "missing"))).toBeUndefined();
    writeRecord(path.join(dir, `seg-1${RECORD_EXT}`), { claudeSessionId: "s-old", cwd: "D:/a", createdAt: "2026-10-25T00:00:00Z", started: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeRecord(path.join(dir, `seg-2${RECORD_EXT}`), { claudeSessionId: "s-new", cwd: "D:/b", createdAt: "2026-10-25T01:00:00Z", started: true });
    expect(currentClaudeSession(dir)).toEqual({ sessionId: "s-new", cwd: "D:/b" });
    // 清空当前对话之后新开的一段，还没说过话：没有可交的会话
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeRecord(path.join(dir, `seg-3${RECORD_EXT}`), { claudeSessionId: "s-fresh", cwd: "D:/b", createdAt: "2026-10-25T02:00:00Z", started: false });
    expect(currentClaudeSession(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, `broken${RECORD_EXT}`), "{");
    expect(() => currentClaudeSession(dir)).not.toThrow();
  });
});
