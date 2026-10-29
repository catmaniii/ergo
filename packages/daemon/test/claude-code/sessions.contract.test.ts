// 契约：接管已有会话时读本机 Claude Code 会话的那一层（290 号票）。SDK 的 listSessions / getSessionMessages / forkSession 和
// `claude agents --json` 都换成假的（编的会话、编的消息，照 sdk.d.ts 的 SDKSessionInfo、SessionMessage 的形状），不读用户真实的 ~/.claude：
// - 列：只列终端 /resume 看得到的（includeProgrammatic: false），标题按自己起的 → 摘要 → 第一句，最近活动的在前；
// - agents --json：数组或包了一层的都认，没有 sessionId 的不要；占着的说明按交互式 / 后台在跑 / 停着的后台记录；查不到一律占着；
// - 前情：同一个 message.id 的几条 assistant 并成一条，工具结果填回那次调用（出错的标出），工具名照守卫登记表映射；命令写回 /命令，
//   本地命令输出、提醒不要；压缩边界成一条标记；只看最后 entries 条、最多 messages 条、尽量从一句用户的话开始；
// - 分叉：不传 dir（会话 id 全局唯一）；
// - 适配子进程的会话记录：装配参数给了接管的会话 id 时不新开 Claude 会话、按 id 恢复，项目换段接着同一条线（/clear 换了 id 的接着新的）。
import fs from "node:fs";
import path from "node:path";
import type { ForkSessionOptions, GetSessionMessagesOptions, ListSessionsOptions, SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { handleSessionsRequest, historyOf, parseAgents, userText } from "../../src/claude-code/child/sessions.ts";
import { openSessionRecord, writeRecord } from "../../src/claude-code/child/records.ts";
import { busyOf, listResumable, oneShotSessionSource } from "../../src/claude-code/sessions.ts";
import type { ClaudeSessionSource } from "../../src/claude-code/sessions.ts";
import type { SessionAssembly } from "../../src/runtime/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

let uuid = 0;
const msg = (type: SessionMessage["type"], message: unknown): SessionMessage => ({ type, uuid: `u-${++uuid}`, session_id: "s-1", message, parent_tool_use_id: null, parent_agent_id: null });
const user = (content: unknown) => msg("user", { role: "user", content });
const assistant = (id: string, ...content: unknown[]) => msg("assistant", { role: "assistant", id, content });

function fakeSdk(messages: SessionMessage[] = [], sessions: SDKSessionInfo[] = []) {
  const seen: { list?: ListSessionsOptions; messages?: [string, GetSessionMessagesOptions | undefined]; fork?: [string, ForkSessionOptions | undefined] } = {};
  return {
    seen,
    sdk: {
      listSessions: (options?: ListSessionsOptions) => {
        seen.list = options;
        return Promise.resolve(sessions);
      },
      getSessionMessages: (id: string, options?: GetSessionMessagesOptions) => {
        seen.messages = [id, options];
        return Promise.resolve(messages);
      },
      forkSession: (id: string, options?: ForkSessionOptions) => {
        seen.fork = [id, options];
        return Promise.resolve({ sessionId: `${id}-forked` });
      },
    },
  };
}

/** 列表里三个会话（终端里开着的、空闲的、不知道工作目录的），占用情况由 open 给 */
const threeSessions = (open: () => Promise<ReturnType<typeof parseAgents>>): ClaudeSessionSource => ({
  list: () =>
    Promise.resolve([
      { sessionId: "s-term", title: "终端里的", cwd: "D:/t", lastModified: Date.parse("2026-10-25T10:00:00+08:00") },
      { sessionId: "s-free", title: "空闲的", cwd: "D:/f", lastModified: Date.parse("2026-10-25T09:00:00+08:00"), bytes: 5 },
      { sessionId: "s-nocwd", title: "不知道在哪", lastModified: 0 },
    ]),
  running: open,
  history: () => Promise.reject(new Error("不该叫")),
  fork: () => Promise.reject(new Error("不该叫")),
  follow: () => Promise.reject(new Error("用不着")),
});

const assemblyOf = (sessionDir: string, patch: Partial<SessionAssembly>): SessionAssembly => ({ sessionDir, cwd: "D:/repo", continueSession: false, ...patch }) as SessionAssembly;

describe("读本机 Claude Code 会话（290 号票）", () => {
  it("列：只列终端看得到的，标题按自己起的、摘要、第一句，最近活动的在前", async () => {
    const { sdk, seen } = fakeSdk([], [
      { sessionId: "a", summary: "自动摘要", firstPrompt: "第一句", lastModified: 1000, fileSize: 10, cwd: "D:/a", gitBranch: "main" },
      { sessionId: "b", summary: "", customTitle: "我起的名字", lastModified: 3000, cwd: "D:/b" },
      { sessionId: "c", summary: "", lastModified: 2000 },
    ]);
    const result = await handleSessionsRequest({ op: "list", limit: 50 }, { sdk, runAgents: () => Promise.reject(new Error("不该叫")) });
    expect(seen.list).toEqual({ limit: 50, includeProgrammatic: false });
    expect(result).toEqual({
      op: "list",
      sessions: [
        { sessionId: "b", title: "我起的名字", cwd: "D:/b", lastModified: 3000 },
        { sessionId: "c", title: "c", lastModified: 2000 },
        { sessionId: "a", title: "自动摘要", cwd: "D:/a", branch: "main", lastModified: 1000, bytes: 10 },
      ],
    });
  });

  it("agents --json：数组或包了一层的都认；占着的说明；查不到的一律占着；工作目录不知道的不列", async () => {
    const text = JSON.stringify([
      { pid: 18324, id: "c153a547", kind: "background", sessionId: "s-bg", status: "idle", state: "blocked" },
      { pid: 4321, kind: "interactive", sessionId: "s-term", name: "work-1", status: "busy" },
      { id: "old", kind: "background", sessionId: "s-old", state: "blocked" },
      { kind: "interactive" },
    ]);
    const running = parseAgents(text);
    expect(running).toEqual([
      { sessionId: "s-bg", kind: "background", pid: 18324, id: "c153a547" },
      { sessionId: "s-term", kind: "interactive", pid: 4321, name: "work-1" },
      { sessionId: "s-old", kind: "background", id: "old" },
    ]);
    expect(parseAgents(JSON.stringify({ sessions: [{ sessionId: "x", kind: "interactive", pid: 1 }] }))).toEqual([{ sessionId: "x", kind: "interactive", pid: 1 }]);
    expect(parseAgents("  ")).toEqual([]);
    expect(busyOf(running.filter((r) => r.sessionId === "s-term"))).toBe("在终端里开着（进程 4321）");
    expect(busyOf(running.filter((r) => r.sessionId === "s-bg"))).toBe("后台会话在跑（c153a547）");
    expect(busyOf(running.filter((r) => r.sessionId === "s-old"))).toBe("有一个停着的后台会话记着它（old），当作占着");
    expect(busyOf([])).toBeUndefined();

    const logs: string[] = [];
    const listed = await listResumable(threeSessions(() => Promise.resolve(running)), (line) => logs.push(line));
    expect(listed.map((s) => [s.id, s.busy])).toEqual([
      ["s-term", "在终端里开着（进程 4321）"],
      ["s-free", undefined],
    ]);
    expect(listed[1]).toMatchObject({ title: "空闲的", cwd: "D:/f", bytes: 5, updatedAt: expect.stringMatching(/^2026-10-25T09:00:00/) });
    const unknown = await listResumable(threeSessions(() => Promise.reject(new Error("没找到 claude.exe"))), (line) => logs.push(line));
    expect(unknown.every((s) => s.busy === "查不到它现在有没有在别处开着")).toBe(true);
    expect(logs.some((l) => l.includes("没找到 claude.exe"))).toBe(true);
  });

  it("前情：并成一条回复、工具结果填回、命令写回、元信息不要、压缩边界成标记；只看最后一段，从一句用户的话开始", () => {
    const messages = [
      user("很早以前的一句"),
      assistant("m0", { type: "text", text: "很早以前的回复" }),
      msg("system", { subtype: "compact_boundary" }),
      user("<command-name>/review</command-name>\n<command-args>PR 12</command-args>"),
      user("<local-command-stdout>本地命令的输出</local-command-stdout>"),
      user([{ type: "text", text: "CI 老是挂<system-reminder>提醒</system-reminder>" }, { type: "image", source: {} }]),
      assistant("m1", { type: "thinking", thinking: "先跑测试" }),
      assistant("m1", { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }),
      user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "2 failed" }] }]),
      assistant("m2", { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }, { type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [] } }),
      user([
        { type: "tool_result", tool_use_id: "t2", content: "old_string not found", is_error: true },
        { type: "tool_result", tool_use_id: "t3", content: "ok" },
      ]),
      assistant("m3", { type: "text", text: "改好了" }),
    ];
    const all = historyOf(messages, 100, 100);
    expect(all.truncated).toBe(false);
    expect(all.items).toEqual([
      { kind: "user", text: "很早以前的一句" },
      { kind: "agent", parts: [{ type: "text", text: "很早以前的回复" }] },
      { kind: "compacted" },
      { kind: "user", text: "/review PR 12" },
      { kind: "user", text: "CI 老是挂\n[图片]" },
      {
        kind: "agent",
        parts: [
          { type: "reasoning", text: "先跑测试" },
          { type: "tool", id: "t1", tool: "bash", native: "Bash", args: { command: "npm test" }, result: "2 failed" },
        ],
      },
      {
        kind: "agent",
        parts: [
          { type: "tool", id: "t2", tool: "edit", native: "Edit", args: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }, result: "old_string not found", failed: true },
          { type: "tool", id: "t3", tool: "TodoWrite", native: "TodoWrite", args: { todos: [] }, result: "ok" },
        ],
      },
      { kind: "agent", parts: [{ type: "text", text: "改好了" }] },
    ]);
    // 只看最后 7 条：从"CI 老是挂"开始，更早的算截掉了
    const tail = historyOf(messages, 7, 100);
    expect(tail.truncated).toBe(true);
    expect(tail.items[0]).toEqual({ kind: "user", text: "CI 老是挂\n[图片]" });
    // 最多 2 条：取最后两条（没有用户的话就照原样）
    const few = historyOf(messages, 100, 2);
    expect(few.truncated).toBe(true);
    expect(few.items).toHaveLength(2);
    // 很长的文字截短
    const long = historyOf([user("长".repeat(9000))], 10, 10);
    expect((long.items[0] as { text: string }).text).toHaveLength(8001);
  });

  it("命令、元信息：写回 /命令；本地命令的输出、Caveat、只有提醒的不要", () => {
    expect(userText("<command-name>compact</command-name>")).toBe("/compact");
    expect(userText("<local-command-stdout>x</local-command-stdout>")).toBe("");
    expect(userText("Caveat: The messages below were generated by the user while running local commands. DO NOT respond.")).toBe("");
    expect(userText("<system-reminder>只是提醒</system-reminder>")).toBe("");
    expect(userText("  正常的一句  ")).toBe("正常的一句");
  });

  it("读前情、分叉：不传 dir（会话 id 全局唯一）；读的时候带上系统消息（压缩边界）", async () => {
    const { sdk, seen } = fakeSdk([user("你好")]);
    const history = await handleSessionsRequest({ op: "history", sessionId: "s-1", cwd: "D:/x", entries: 10, messages: 10 }, { sdk, runAgents: () => Promise.resolve("[]") });
    expect(seen.messages).toEqual(["s-1", { includeSystemMessages: true }]);
    expect(history).toEqual({ op: "history", history: { items: [{ kind: "user", text: "你好" }], truncated: false } });
    expect(await handleSessionsRequest({ op: "fork", sessionId: "s-1", cwd: "D:/x" }, { sdk, runAgents: () => Promise.resolve("[]") })).toEqual({ op: "fork", sessionId: "s-1-forked" });
    expect(seen.fork).toEqual(["s-1", undefined]);
    expect(await handleSessionsRequest({ op: "running" }, { sdk, runAgents: () => Promise.resolve('[{"sessionId":"s-1","kind":"interactive","pid":3}]') })).toEqual({
      op: "running",
      running: [{ sessionId: "s-1", kind: "interactive", pid: 3 }],
    });
  });

  it("守护进程这一侧：每样拉一个一次性子进程，请求照约定的写", async () => {
    const asked: Array<{ entry: string; request: unknown; timeoutMs: number }> = [];
    const replies: Record<string, unknown> = {
      list: { op: "list", sessions: [] },
      running: { op: "running", running: [] },
      history: { op: "history", history: { items: [], truncated: false } },
      fork: { op: "fork", sessionId: "new" },
    };
    const run = <T,>(entry: string, request: unknown, _label: string, timeoutMs: number): Promise<T> => {
      asked.push({ entry, request, timeoutMs });
      return Promise.resolve(replies[(request as { op: string }).op] as T);
    };
    const source = oneShotSessionSource(run);
    await source.list();
    await source.running();
    await source.history("s-1", "D:/x");
    expect(await source.fork("s-1", "D:/x")).toBe("new");
    expect(asked.map((a) => a.request)).toEqual([
      { op: "list", limit: 100 },
      { op: "running" },
      { op: "history", sessionId: "s-1", cwd: "D:/x", entries: 400, messages: 60 },
      { op: "fork", sessionId: "s-1", cwd: "D:/x" },
    ]);
    expect(path.basename(asked[0]!.entry)).toMatch(/^sessions-main\.(ts|js)$/);
    expect(fs.existsSync(asked[0]!.entry)).toBe(true);
  });
});

describe("适配子进程的会话记录：接管的会话（290 号票）", () => {
  it("给了接管的会话 id：不新开 Claude 会话，按 id 恢复；接着已有的照旧；换段接着同一条线（/clear 换了 id 的接着新的）；freshSession 照旧新开", () => {
    const dir = makeTempDir("ergo-cc-records-");
    // 任务的维护者：接着最近的、还没有记录 → 接管的那个，按 id 恢复
    const first = openSessionRecord(assemblyOf(dir, { continueSession: true, resumeRuntimeSession: "s-idle" }));
    expect(first.record).toMatchObject({ claudeSessionId: "s-idle", started: true, takenOver: "s-idle" });
    expect(first.existing).toBe(false);
    // 再拉起：接着那份记录
    const again = openSessionRecord(assemblyOf(dir, { continueSession: true, resumeRuntimeSession: "s-idle" }));
    expect(again.existing).toBe(true);
    expect(again.record.claudeSessionId).toBe("s-idle");
    // 中途 /clear 换了 id（记录跟着改）；项目换段（新段名）：接着同一条线上最新的 id
    writeRecord(first.file, { ...first.record, claudeSessionId: "s-after-clear" });
    const segment = openSessionRecord(assemblyOf(dir, { session: "seg-2", resumeRuntimeSession: "s-idle" }));
    expect(segment.record).toMatchObject({ claudeSessionId: "s-after-clear", started: true, takenOver: "s-idle" });
    expect(segment.name).toBe("seg-2");
    // 清空当前对话之后新开的段（freshSession）：照旧新开，不接管
    const fresh = openSessionRecord(assemblyOf(dir, { freshSession: "cleared-1", resumeRuntimeSession: "s-idle" }));
    expect(fresh.record.started).toBe(false);
    expect(fresh.record.takenOver).toBeUndefined();
    expect(fresh.record.claudeSessionId).not.toBe("s-idle");
    // 没给的照旧新开
    const plain = openSessionRecord(assemblyOf(makeTempDir("ergo-cc-records-"), { continueSession: true }));
    expect(plain.record).toMatchObject({ started: false });
    expect(plain.record.takenOver).toBeUndefined();
  });
});
