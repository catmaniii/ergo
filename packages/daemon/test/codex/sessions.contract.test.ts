// 接管已有 Codex 会话的那几样（child/sessions.ts、sessions.ts）：列、读状况、读前情、分叉，全部经 app-server 的接口，不读 ~/.codex 下的文件。
// 这里 app-server 是假的（说的话按 0.166 生成的 schema 校验），线程是编的；"占没占"写判不准的那条也在这里。
import { describe, expect, it, onTestFinished } from "vitest";
import { CODEX_CLIENT_NAME, CodexRpc } from "../../src/codex/child/app-server.ts";
import { handleSessionsRequest, historyOf } from "../../src/codex/child/sessions.ts";
import { CODEX_BUSY_RECENT_MS, type CodexSessionSource, listResumable, sessionBusy } from "../../src/codex/sessions.ts";
import { FakeCodexServer, FakeCodexStore } from "../helpers/fake-codex-app-server.ts";

async function connect(store: FakeCodexStore) {
  const server = new FakeCodexServer({ store });
  const proc = server.spawn(["app-server"], { env: {}, cwd: "D:\\", log: () => {} });
  const rpc = new CodexRpc(proc, { onNotification: () => {}, onRequest: () => Promise.reject(new Error("不接")), onExit: () => {} });
  await rpc.initialize();
  onTestFinished(async () => {
    await rpc.close();
    expect(server.violations).toEqual([]);
  });
  return { server, rpc };
}

const SECONDS = 1_800_000_000;

function storeWithThreads(): FakeCodexStore {
  const store = new FakeCodexStore();
  store.addThread({ id: "t-1", cwd: "D:\\work\\a", name: "修测试", preview: "帮我修", updatedAt: SECONDS, branch: "fix/flaky" });
  store.addThread({ id: "t-2", cwd: "D:\\work\\b", preview: "  只有\n预览的  ", updatedAt: SECONDS - 100 });
  store.addThread({ id: "t-3", cwd: "D:\\work\\c", updatedAt: SECONDS - 200, status: { type: "active", activeFlags: [] } });
  // 二狗自己开的不列
  store.addThread({ id: "t-own", cwd: "D:\\work\\d", originator: CODEX_CLIENT_NAME, preview: "二狗开的", updatedAt: SECONDS + 100 });
  return store;
}

describe("列本机的 Codex 会话", () => {
  it("thread/list 按最近活动排，翻页；二狗自己开的不列；标题优先 name，再 preview，再 id；毫秒、分支、开着没有都翻好", async () => {
    const { rpc, server } = await connect(storeWithThreads());
    const result = await handleSessionsRequest({ op: "list", limit: 2 }, rpc);
    expect(result).toEqual({
      op: "list",
      sessions: [
        { sessionId: "t-1", title: "修测试", cwd: "D:\\work\\a", branch: "fix/flaky", updatedAt: SECONDS * 1000, loaded: false },
        { sessionId: "t-2", title: "只有 预览的", cwd: "D:\\work\\b", updatedAt: (SECONDS - 100) * 1000, loaded: false },
      ],
    });
    expect(server.callsOf("thread/list")[0]).toMatchObject({ sortKey: "updated_at", sortDirection: "desc", limit: 2 });

    const all = await handleSessionsRequest({ op: "list", limit: 100 }, rpc);
    expect(all.op === "list" && all.sessions.map((s) => [s.sessionId, s.title, s.loaded])).toEqual([
      ["t-1", "修测试", false],
      ["t-2", "只有 预览的", false],
      ["t-3", "t-3", true],
    ]);
  });

  it("读状况：thread/read；没有这个会话的抛错（收回前核对写查不到）", async () => {
    const { rpc } = await connect(storeWithThreads());
    expect(await handleSessionsRequest({ op: "state", sessionId: "t-3" }, rpc)).toEqual({ op: "state", state: { updatedAt: (SECONDS - 200) * 1000, loaded: true } });
    await expect(handleSessionsRequest({ op: "state", sessionId: "t-none" }, rpc)).rejects.toThrow(/no rollout found/);
  });

  it("分叉带上原来的模型：实测 thread/fork 不带 model 回到配置里的，配置里的用不了时接管后第一轮就失败", async () => {
    const store = storeWithThreads();
    store.threads["t-1"]!.model = "gpt-other";
    const { rpc, server } = await connect(store);
    const result = await handleSessionsRequest({ op: "fork", sessionId: "t-1", cwd: "D:\\work\\a" }, rpc);
    expect(server.callsOf("thread/fork")).toMatchObject([{ threadId: "t-1", model: "gpt-other" }]);
    expect(result.op === "fork" && store.threads[result.sessionId]!.model).toBe("gpt-other");
  });

  it("分叉：thread/fork 带工作目录和最严的审批策略，原会话不动", async () => {
    const store = storeWithThreads();
    const { rpc, server } = await connect(store);
    const result = await handleSessionsRequest({ op: "fork", sessionId: "t-1", cwd: "D:\\work\\a" }, rpc);
    expect(result.op === "fork" && result.sessionId).toMatch(/^th-/);
    expect(server.callsOf("thread/fork")).toMatchObject([{ threadId: "t-1", cwd: "D:\\work\\a", approvalPolicy: "untrusted", approvalsReviewer: "user" }]);
    expect(store.threads["t-1"]!.forkedFromId).toBeNull();
  });
});

describe("读前情", () => {
  const turns = [
    {
      id: "u-1",
      items: [
        { type: "userMessage", id: "i1", content: [{ type: "text", text: "帮我修测试", text_elements: [] }, { type: "image", url: "data:image/png;base64,AA" }] },
        { type: "reasoning", id: "i2", summary: ["先跑一遍"], content: [] },
        { type: "commandExecution", id: "c1", command: "npm test", commandActions: [], cwd: "D:\\w", status: "completed", exitCode: 1, aggregatedOutput: "2 failed" },
        { type: "fileChange", id: "p1", status: "completed", changes: [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "" }] },
        { type: "mcpToolCall", id: "m1", server: "gh", tool: "list", status: "failed", arguments: { a: 1 }, error: { message: "连不上" }, result: null },
        { type: "webSearch", id: "w1", query: "怎么修" },
        { type: "agentMessage", id: "i3", text: "有两个不稳。" },
      ],
    },
    { id: "u-2", items: [{ type: "contextCompaction", id: "x" }, { type: "userMessage", id: "i4", content: [{ type: "text", text: "先修第一个", text_elements: [] }] }, { type: "agentMessage", id: "i5", text: "好了。" }] },
  ];

  it("thread/turns/list 从新往旧读，翻成二狗的样子（工具名照守卫的登记表）", async () => {
    const store = new FakeCodexStore();
    store.addThread({ id: "t-1", cwd: "D:\\w", turns: turns.map((t) => ({ ...t, status: "completed" })) as never });
    const { rpc, server } = await connect(store);
    const result = await handleSessionsRequest({ op: "history", sessionId: "t-1", turns: 40, messages: 60 }, rpc);
    expect(server.callsOf("thread/turns/list")[0]).toMatchObject({ threadId: "t-1", limit: 40, sortDirection: "desc", itemsView: "full" });
    expect(result.op === "history" && result.history).toEqual({
      truncated: false,
      items: [
        { kind: "user", text: "帮我修测试\n[图片]" },
        {
          kind: "agent",
          parts: [
            { type: "reasoning", text: "先跑一遍" },
            { type: "tool", id: "c1", tool: "bash", native: "Bash", args: { command: "npm test" }, result: "2 failed", failed: true },
            { type: "tool", id: "p1", tool: "apply_patch", native: "apply_patch", args: { adds: [], updates: ["src/a.ts"], deletes: [] }, result: "src/a.ts" },
            { type: "tool", id: "m1", tool: "mcp__gh__list", native: "mcp__gh__list", args: { a: 1 }, result: "连不上", failed: true },
            { type: "tool", id: "w1", tool: "web_search", native: "webSearch", args: { query: "怎么修" }, result: "怎么修" },
            { type: "text", text: "有两个不稳。" },
          ],
        },
        { kind: "compacted" },
        { kind: "user", text: "先修第一个" },
        { kind: "agent", parts: [{ type: "text", text: "好了。" }] },
      ],
    });
  });

  it("读得多、读不全的写 truncated，尽量从一句用户的话开始；太长的截短", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `u-${i}`, items: [{ type: "userMessage", id: `a${i}`, content: [{ type: "text", text: `问 ${i}` }] }, { type: "agentMessage", id: `b${i}`, text: `答 ${i}` }] }));
    const history = historyOf(many, false, 3);
    expect(history.truncated).toBe(true);
    expect(history.items.map((item) => item.kind)).toEqual(["user", "agent"]);
    expect(historyOf(many, true, 100).truncated).toBe(true);
    expect(historyOf(many, false, 100).truncated).toBe(false);
    const long = historyOf([{ id: "u", items: [{ type: "agentMessage", id: "x", text: "字".repeat(9000) }] }], false, 10);
    const part = long.items[0]!.kind === "agent" ? long.items[0]!.parts[0]! : undefined;
    expect(part && "text" in part ? part.text.length : 0).toBeLessThan(8100);
  });

  it("读不了（老会话）退到 thread/read 带 includeTurns", async () => {
    const store = new FakeCodexStore();
    store.addThread({ id: "t-1", cwd: "D:\\w", turns: turns.map((t) => ({ ...t, status: "completed" })) as never });
    const { rpc } = await connect(store);
    const calls: string[] = [];
    const flaky = {
      request: <T>(method: string, params?: unknown): Promise<T> => {
        calls.push(method);
        if (method === "thread/turns/list") return Promise.reject(new Error("not supported on legacy threads"));
        return rpc.request<T>(method, params);
      },
    };
    const result = await handleSessionsRequest({ op: "history", sessionId: "t-1", turns: 1, messages: 60 }, flaky);
    expect(calls).toEqual(["thread/turns/list", "thread/read"]);
    expect(result.op === "history" && result.history.truncated).toBe(true);
    expect(result.op === "history" && result.history.items.map((i) => i.kind)).toEqual(["user", "agent"]);
  });
});

describe("占没占（判不准，照实写）", () => {
  const NOW = Date.parse("2026-11-02T10:00:00+08:00");
  const source = (sessions: Array<{ sessionId: string; updatedAt: number; loaded: boolean }>): CodexSessionSource => ({
    list: () => Promise.resolve(sessions.map((s) => ({ ...s, title: s.sessionId, cwd: "D:\\w" }))),
    state: (id) => Promise.resolve(sessions.find((s) => s.sessionId === id)!),
    history: () => Promise.resolve({ items: [], truncated: false }),
    fork: () => Promise.resolve("forked"),
  });

  it("状态不是没加载、或者最近还有活动的写可能还开着（busy）；再早的也判不准（unsure），不说它空闲", async () => {
    const listed = await listResumable(
      source([
        { sessionId: "loaded", updatedAt: NOW - 3_600_000, loaded: true },
        { sessionId: "recent", updatedAt: NOW - 60_000, loaded: false },
        { sessionId: "old", updatedAt: NOW - CODEX_BUSY_RECENT_MS - 1, loaded: false },
      ]),
      () => NOW,
    );
    expect(listed[0]).toMatchObject({ id: "loaded", busy: "这个会话正开着（有别的 Codex 进程在写它）" });
    expect(listed[1]).toMatchObject({ id: "recent", busy: "1 分钟前还有活动，可能还开着" });
    expect(listed[2]!.busy).toBeUndefined();
    expect(listed[2]!.unsure).toContain("可能还开着，先在那边关掉，或者分叉一份接管");
    expect(listed[0]!.unsure).toBeUndefined();
  });

  it("工作目录不知道的不列", async () => {
    const empty: CodexSessionSource = { ...source([]), list: () => Promise.resolve([{ sessionId: "x", title: "x", cwd: "", updatedAt: NOW, loaded: false }]) };
    expect(await listResumable(empty, () => NOW)).toEqual([]);
  });

  it("收回前核对：只算交还之后的活动（交还之前是二狗自己写的）；交还之后又动过的写可能开着；开着的不管什么时候都算", async () => {
    const returnedAt = new Date(NOW - 60_000).toISOString();
    const sessions = source([
      { sessionId: "before", updatedAt: NOW - 120_000, loaded: false },
      { sessionId: "after", updatedAt: NOW - 30_000, loaded: false },
      { sessionId: "open", updatedAt: NOW - 120_000, loaded: true },
    ]);
    expect(await sessionBusy(sessions, "before", returnedAt, () => NOW)).toBeUndefined();
    expect(await sessionBusy(sessions, "after", returnedAt, () => NOW)).toContain("可能还开着");
    expect(await sessionBusy(sessions, "open", returnedAt, () => NOW)).toBe("这个会话正开着（有别的 Codex 进程在写它）");
    // 接管时（不带交还时刻）最近的也算
    expect(await sessionBusy(sessions, "before", undefined, () => NOW)).toContain("可能还开着");
  });

  it("状况靠写入锁判断：别的进程开着的 thread/resume 被拒就是开着（status 跨进程永远是 notLoaded）；没人开着的探一次不算开着；thread/read 查不到照样抛出", async () => {
    const store = storeWithThreads();
    const { rpc, server } = await connect(store);
    store.activeWriters.add("t-1");
    expect(await handleSessionsRequest({ op: "state", sessionId: "t-1" }, rpc)).toEqual({ op: "state", state: { updatedAt: SECONDS * 1000, loaded: true } });
    expect(await handleSessionsRequest({ op: "state", sessionId: "t-2" }, rpc)).toEqual({ op: "state", state: { updatedAt: (SECONDS - 100) * 1000, loaded: false } });
    expect(server.callsOf("thread/resume").map((p) => p.excludeTurns)).toEqual([true, true]);
    // 列的时候不探（一个一个探太慢，还会拉起用户的 MCP）
    const before = server.callsOf("thread/resume").length;
    const list = await handleSessionsRequest({ op: "list", limit: 10 }, rpc);
    expect(list.op === "list" && list.sessions.find((s) => s.sessionId === "t-1")?.loaded).toBe(false);
    expect(server.callsOf("thread/resume")).toHaveLength(before);
    await expect(handleSessionsRequest({ op: "state", sessionId: "没有这个" }, rpc)).rejects.toThrow("no rollout found");
  });

  it("开着也能分叉（写入锁只拦 resume）", async () => {
    const store = storeWithThreads();
    const { rpc } = await connect(store);
    store.activeWriters.add("t-1");
    const forked = await handleSessionsRequest({ op: "fork", sessionId: "t-1", cwd: "D:\\work\\a" }, rpc);
    expect(forked.op === "fork" && forked.sessionId).toBeTruthy();
  });
});
