// 秘书带参调 MCP（240 号票）的单元测试：
// - 登记过的工具（写、读都一样）直接调，参数原样发过去，结果交回秘书；时间线和 mcp_called 各记一笔；
// - 不替服务端校验参数：缺必填也照样发，服务进程报的错原样带回来（记成 failed）；
// - 没登记的 MCP / 工具：说清，并列出登记了哪些（能操作）；
// - 登记文件写坏了：说清，不崩；
// - 服务进程没起来 / 端口对不上：回错误 + 能操作的提示，不留执行成功的记录；
// - 密钥类参数：时间线、事件日志里只有"来自环境变量 X"和星号，原值一个字都没有，但服务进程收到的是原参数。
// 用户 2026-10-21 定：不搞读写分级、不出审批卡——这里没有卡片依赖，只有工具和时间线/事件。
// 端到端（真守护进程、真端口、真的 mcp.json）在主切面 test/main/mcp-call.test.ts。
import fs from "node:fs";
import path from "node:path";
import { type McpCalledPayload, nowIso } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, maskSecretArgValues, registerTools } from "../../src/guard/index.ts";
import { summarizeArgs } from "../../src/guard-runtime/describe.ts";
import { createMcpCallService, MCP_CALL_TOOL } from "../../src/mcp/call.ts";
import { createMcpService } from "../../src/mcp/mcp.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { FAKE_MCP_SERVER, MCP_TOKEN, MCP_TOKEN_ENV, mcpLog } from "../helpers/toolkit.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

/** 旅行相册那条登记：写（person.rename，带必填）、读（filter.set）、假服务不认识的一个（谁也没实现过）、命中底线的（pay） */
const albumEntry = (logFile: string) => ({
  title: "旅行相册",
  command: process.execPath,
  args: [FAKE_MCP_SERVER],
  env: { FAKE_MCP_LOG: logFile, FAKE_MCP_TOKEN: { fromEnv: MCP_TOKEN_ENV } },
  tools: {
    "person.rename": {
      title: "改名字",
      network: false,
      inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
    },
    "filter.set": { title: "按人筛选", readOnlyOrIdempotent: true, network: false },
    "person.dance": { title: "没实现的工具", network: false },
    pay: { title: "付款", bottomLines: ["payment_account_auth"], network: false },
  },
});

/** 单元测试的底座：真的 MCP 服务和事件存储；MCP 服务是测试里的假服务（记录写进 logFile） */
function setup(servers: (logFile: string) => Record<string, unknown> = (logFile) => ({ album: albumEntry(logFile) })) {
  const logFile = path.join(makeTempDir("ergo-mcp-call-log-"), "mcp.jsonl");
  const root = makeTempDir("ergo-mcp-call-");
  const layout = dataDirLayout(root);
  fs.mkdirSync(layout.config, { recursive: true });
  fs.writeFileSync(layout.mcpFile, JSON.stringify({ servers: servers(logFile) }, null, 2));
  const store = openEventStore({ file: path.join(root, "ergo.db"), views: [] });
  onTestFinished(() => store.close());
  const logs: string[] = [];
  const mcp = createMcpService({ file: layout.mcpFile, parentEnv: { [MCP_TOKEN_ENV]: MCP_TOKEN }, cwd: makeTempDir("ergo-mcp-call-cwd-"), newJob: () => undefined, callTimeoutMs: 10_000, log: (l) => logs.push(l) });
  onTestFinished(() => mcp.stop());
  const service = createMcpCallService({ store, mcp, now: nowIso, log: (l) => logs.push(l) });
  const run = (args: Record<string, unknown>) => service.tool().run(args as never, { toolCallId: "call-1" });
  /** mcp 频道上的 mcp_called（这个频道上也可能有别的票的事件，只认有 outcome 的） */
  const called = () => store.read("mcp", 0).map((e) => e.payload as Partial<McpCalledPayload>).filter((p) => p.outcome !== undefined) as McpCalledPayload[];
  /** 秘书会话上的时间线 */
  const timeline = () => store.read("secretary", 0).filter((e) => e.type === "timeline_record").map((e) => (e.payload as { record: { kind: string; summary: string; detail?: string } }).record);
  return { store, mcp, service, run, called, timeline, logFile };
}

describe("mcp_call：登记过就调", () => {
  it("写工具也一样直调（不出卡）：参数原样到服务进程、结果交回秘书；时间线和 mcp_called 各记一笔", async () => {
    const s = setup();
    const result = await s.run({ tool: "album/person.rename", args: { id: "p2", name: "爸爸" }, why: "用户说第二个人叫爸爸" });
    expect(result.isError).toBeFalsy();
    expect(result.text).toBe("已把 p2 改名成 爸爸");
    // 假服务收到了原样的参数
    expect(mcpLog(s.logFile).filter((e) => e.call !== undefined)).toEqual([{ call: "person.rename", args: { id: "p2", name: "爸爸" } }]);
    // 事件日志：调到了、参数、结果
    expect(s.called()).toMatchObject([
      { outcome: "done", server: "album", serverTitle: "旅行相册", tool: "person.rename", toolTitle: "改名字", args: { id: "p2", name: "爸爸" }, why: "用户说第二个人叫爸爸", result: { ok: true, text: "已把 p2 改名成 爸爸" } },
    ]);
    // 时间线：一句话 + 明细（参数、为什么、结果）
    expect(s.timeline()).toMatchObject([{ kind: "mcp_call", summary: expect.stringContaining("调了 person.rename") }]);
    expect(s.timeline()[0]!.detail).toContain('"id":"p2"');
    expect(s.timeline()[0]!.detail).toContain("用户说第二个人叫爸爸");
    expect(s.timeline()[0]!.detail).toContain("已把 p2 改名成 爸爸");
  });

  it("只读工具一样直调，不因为没写参数说明就拦", async () => {
    const s = setup();
    const result = await s.run({ tool: "album/filter.set", args: { personId: "p2" } });
    expect(result.isError).toBeFalsy();
    expect(result.text).toBe("筛选到 p2");
    expect(mcpLog(s.logFile).filter((e) => e.call !== undefined)).toEqual([{ call: "filter.set", args: { personId: "p2" } }]);
    expect(s.called()).toMatchObject([{ outcome: "done", tool: "filter.set" }]);
  });

  it("不替服务端校验参数：缺必填照样发过去，服务进程报的错原样带回来（记录成 failed）", async () => {
    const s = setup();
    const result = await s.run({ tool: "album/person.rename", args: { id: "p2" } });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("改名字要写 name");
    // 服务进程真的收到了这次调用（缺的那个参数也在）
    expect(mcpLog(s.logFile).filter((e) => e.call !== undefined)).toEqual([{ call: "person.rename", args: { id: "p2" } }]);
    expect(s.called()).toMatchObject([{ outcome: "failed", result: { ok: false, text: "改名字要写 name" } }]);
    expect(s.timeline()[0]!.summary).toContain("没做成");
  });

  it("服务进程不认识这个工具（登记里有、服务进程回错）：错误原样带回来", async () => {
    const s = setup();
    const result = await s.run({ tool: "album/person.dance", args: {} });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("没有这个工具：person.dance");
    expect(s.called()).toMatchObject([{ outcome: "failed", tool: "person.dance" }]);
  });
});

describe("mcp_call：根本调不到时说清楚", () => {
  it("没登记的 MCP / 工具：说清，并列出登记了哪些", async () => {
    const s = setup();
    const wrongServer = await s.run({ tool: "nope/x", args: {} });
    expect(wrongServer.isError).toBe(true);
    expect(wrongServer.text).toContain("没有登记 MCP nope");
    expect(wrongServer.text).toContain("album/person.rename");
    const wrongTool = await s.run({ tool: "album/person.dance2", args: {} });
    expect(wrongTool.isError).toBe(true);
    expect(wrongTool.text).toContain("没有登记这个工具");
    expect(wrongTool.text).toContain("album/filter.set");
    // 只写 MCP 名：列出它有的工具
    const onlyServer = await s.run({ tool: "album", args: {} });
    expect(onlyServer.isError).toBe(true);
    expect(onlyServer.text).toContain("album/pay");
    expect(s.called()).toEqual([]);
  });

  it("登记文件写坏了：说清、不崩", async () => {
    const root = makeTempDir("ergo-mcp-bad-");
    const layout = dataDirLayout(root);
    fs.mkdirSync(layout.config, { recursive: true });
    fs.writeFileSync(layout.mcpFile, "{ 不是 JSON");
    const store = openEventStore({ file: path.join(root, "ergo.db"), views: [] });
    onTestFinished(() => store.close());
    const logs: string[] = [];
    const mcp = createMcpService({ file: layout.mcpFile, parentEnv: {}, cwd: makeTempDir("ergo-cwd-"), newJob: () => undefined, callTimeoutMs: 5_000, log: (l) => logs.push(l) });
    onTestFinished(() => mcp.stop());
    const service = createMcpCallService({ store, mcp, now: nowIso, log: (l) => logs.push(l) });
    const result = await service.tool().run({ tool: "album/x" } as never, { toolCallId: "call-1" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("读不了");
  });

  it("服务进程没起来：回错误 + 端口可能不一致的提示，不留执行成功的记录", async () => {
    const s = setup(() => ({
      broken: { title: "坏了的 MCP", command: process.execPath, args: [path.join(makeTempDir("ergo-broken-"), "没有这个文件.mjs")], tools: { status: { title: "看状态", readOnlyOrIdempotent: true, network: false } } },
    }));
    const result = await s.run({ tool: "broken/status" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("没起来");
    expect(result.text).toContain("端口");
    expect(result.text).not.toContain("做成了");
    expect(s.called()).toMatchObject([{ outcome: "failed", result: { ok: false } }]);
    expect(s.timeline()[0]!.detail).toContain("没做成");
  });
});

describe("mcp_call：密钥类参数", () => {
  it("时间线、事件日志里只有\"来自环境变量 X\"和星号；服务进程收到的是原参数", async () => {
    const s = setup();
    const result = await s.run({ tool: "album/person.rename", args: { id: "p2", name: MCP_TOKEN, auth: "hunter2" }, why: "改个名" });
    expect(result.isError).toBeFalsy();
    // 服务进程收到的是原参数（脱敏只影响记录和显示）
    expect(mcpLog(s.logFile).filter((e) => e.call !== undefined)).toEqual([{ call: "person.rename", args: { id: "p2", name: MCP_TOKEN, auth: "hunter2" } }]);
    // 事件日志、时间线里没有原值
    expect(s.called()).toMatchObject([{ args: { id: "p2", name: `来自环境变量 ${MCP_TOKEN_ENV}`, auth: "（密钥）" } }]);
    const dumped = JSON.stringify({ called: s.called(), timeline: s.timeline() });
    expect(dumped).not.toContain(MCP_TOKEN);
    expect(dumped).not.toContain("hunter2");
  });

  it("聊天里的工具调用摘要：工具自己声明参数要打码（280 号票，登记里的 maskArgs），守卫运行时按登记擦，结果和原来按名字认时一样", () => {
    const s = setup();
    const tool = s.service.tool();
    expect(tool.descriptor.maskArgs).toBe(true);
    const tools = registerTools(BUILTIN_TOOL_REGISTRY, tool.descriptor);
    const args = { tool: "album/person.rename", args: { id: "p2", name: "爸爸", auth_token: "hunter2", note: `key ${fakeSecret("sk-", "abcdefghijklmnopqrstuv")}` }, why: "改个名" };
    const summary = summarizeArgs(tools, MCP_CALL_TOOL, args);
    expect(summary).not.toContain("hunter2");
    expect(summary).not.toContain(fakeSecret("sk-", "abcdefghijklmnopqrstuv"));
    expect(summary).toBe(summarizeArgs(BUILTIN_TOOL_REGISTRY, MCP_CALL_TOOL, maskSecretArgValues(args)));
  });
});
