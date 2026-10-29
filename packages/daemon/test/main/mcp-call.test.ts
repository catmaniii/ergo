// 主切面（240 号票）：秘书带参调 MCP。真的守护进程、真的端口、真的 mcp.json；MCP 服务进程是测试里的假 MCP 服务
// （test/fixtures/fake-mcp-server.mjs，stdio，不连任何真的 MCP），旅行相册那几个带参的工具是相册应用里让秘书做的典型的事
// （person.rename{id,name}、filter.set{personId}）。
// 用户 2026-10-21 定：不要给 MCP 调用加读写分级、不要审批卡——登记过就调，参数原样发过去；平台自己的守卫照旧。
// 覆盖的验收（原来的 8 条按用户的要求压成 5 条）：
// 1. 任何登记过的工具都能带参调到：假的写工具（person.rename）直接执行，没有额外的卡，参数到了服务进程，结果回到秘书手边；
// 2. 没登记（MCP / 工具）和参数错能说清：不崩，服务端报的错原样带回来；
// 3. 服务进程没起来 / 端口不对：说清、能操作，不留"做成了"的记录；
// 4. 停用 / 移除这个 MCP 之后再调：回"没登记"；
// 5. 秘书知道该用它，不再用页面点代替：工具清单里有 mcp_call，系统提示里写着要动登记过的 MCP 就用它。
import path from "node:path";
import { CHANNELS, type McpCalledPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { TestDaemon } from "../helpers/daemon.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { call, cardsOf, messagesOf, recordsOf, say, textOf, turnsOf } from "../helpers/task-flow.ts";
import { FAKE_MCP_SERVER, MCP_TOKEN, MCP_TOKEN_ENV, mcpLog, writeMcpRegistration } from "../helpers/toolkit.ts";

const SECRETARY = CHANNELS.secretary;
/** echo_context：回的是秘书看到的上下文（系统提示、工具清单、工具结果都在里面） */
const ECHO = { kind: "echo_context" } as const;

/** 旅行相册的登记：两个带参的（person.rename 写、filter.set 读）——240 号票要的就是这个都能带参调 */
const albumRegistration = (logFile: string) => ({
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
    "filter.set": {
      title: "按人筛选",
      readOnlyOrIdempotent: true,
      network: false,
      inputSchema: { type: "object", properties: { personId: { type: "string" } }, required: ["personId"] },
    },
  },
});

/** 往临时数据目录的配置区写旅行相册的登记（记录文件换成这次的；别的照旧用 helpers 里的 demo） */
function registerAlbum(td: TestDaemon, logFile: string): void {
  writeMcpRegistration(td.dataDir, logFile, { album: albumRegistration(logFile) });
}

/** 假服务收到的调用（起来时那行不算） */
const callsIn = (logFile: string) => mcpLog(logFile).filter((e) => e.call !== undefined);

/** 连上前端，订阅卡片、待我处理、秘书会话 */
async function connect(url: string): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries([CHANNELS.cards, CHANNELS.inbox, SECRETARY].map((channel) => [channel, 0])));
  return frontend;
}

/** 秘书那条回复（echo_context 回的是它看到的上下文） */
const secretaryReply = (frontend: TestFrontend) => {
  const replies = messagesOf(frontend, SECRETARY)
    .filter((m) => m.message.speaker === "agent" && m.message.parts.some((p) => p.type === "text"))
    .map(textOf);
  return replies.at(-1) ?? "";
};

/** mcp 频道上的 mcp_called（这个频道上还有 239 的 mcp_decided，只认有 outcome 的） */
const calledEvents = (td: TestDaemon) => td.daemon.store.read("mcp", 0).map((e) => e.payload as Partial<McpCalledPayload>).filter((p) => p.outcome !== undefined);

describe("秘书带参调 MCP（240）", () => {
  it("登记过的写工具直接调（没有额外的卡）：参数到了服务进程，结果回到秘书手边；时间线和审计都记着", { timeout: 120_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-call-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      env: { [MCP_TOKEN_ENV]: MCP_TOKEN },
      secretary: [call("mcp_call", { tool: "album/person.rename", args: { id: "p2", name: "爸爸" }, why: "用户说第二个人叫爸爸" }), ECHO],
    });
    registerAlbum(td, logFile);
    const frontend = await connect(td.url);

    await frontend.sendText("第二个人改名叫爸爸");
    await turnsOf(frontend, SECRETARY, 1);
    const seen = secretaryReply(frontend);
    // 假服务收到了原样的参数，结果回到秘书手边（工具结果在它看到的上下文里）
    expect(callsIn(logFile)).toEqual([{ call: "person.rename", args: { id: "p2", name: "爸爸" } }]);
    expect(seen).toContain("已把 p2 改名成 爸爸");
    // 没有额外的卡、没有待办事项：能调就直接调
    expect(cardsOf(frontend)).toEqual([]);
    expect(td.daemon.inbox.list()).toEqual([]);
    // 时间线一条、审计一条
    const records = recordsOf(frontend, SECRETARY)
      .map((r) => r.record)
      .filter((r) => r.kind === "mcp_call");
    expect(records).toHaveLength(1);
    expect(records[0]!.summary).toContain("调了 person.rename");
    expect(records[0]!.detail).toContain('"id":"p2"');
    expect(records[0]!.detail).toContain("用户说第二个人叫爸爸");
    expect(calledEvents(td)).toMatchObject([{ outcome: "done", server: "album", serverTitle: "旅行相册", tool: "person.rename", args: { id: "p2", name: "爸爸" }, why: "用户说第二个人叫爸爸", result: { ok: true, text: "已把 p2 改名成 爸爸" } }]);
    // 5. 秘书知道该用它：工具清单里有 mcp_call，系统提示里写着要动登记过的 MCP 就用它、别用浏览器点页面代替
    expect(seen).toContain("[tool] mcp_call");
    expect(seen).toContain("就用 mcp_call 带参调它的工具");
    expect(seen).toContain("不要用浏览器点页面代替它");
    await frontend.close();
  });

  it("只读的带参工具一样直接调，参数原样发过去", { timeout: 120_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-call-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      secretary: [call("mcp_call", { tool: "album/filter.set", args: { personId: "p2" } }), ECHO],
    });
    registerAlbum(td, logFile);
    const frontend = await connect(td.url);
    await frontend.sendText("只看老二");
    await turnsOf(frontend, SECRETARY, 1);
    expect(callsIn(logFile)).toEqual([{ call: "filter.set", args: { personId: "p2" } }]);
    expect(secretaryReply(frontend)).toContain("筛选到 p2");
    expect(cardsOf(frontend)).toEqual([]);
    await frontend.close();
  });

  it("没登记和参数错能说清：不崩，服务端报的错原样带回来", { timeout: 120_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-call-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      secretary: [
        call("mcp_call", { tool: "nope/x", args: {} }),
        call("mcp_call", { tool: "album/person.rename", args: { id: "p2" } }),
        ECHO,
      ],
    });
    registerAlbum(td, logFile);
    const frontend = await connect(td.url);
    await frontend.sendText("第二个人改名叫爸爸");
    await turnsOf(frontend, SECRETARY, 1);
    const seen = secretaryReply(frontend);
    // 没登记的 MCP：说清，并列出登记了哪些
    expect(seen).toContain("没有登记 MCP nope");
    expect(seen).toContain("album/person.rename");
    // 参数错：不替服务端拦，服务端的错原样带回来
    expect(seen).toContain("改名字要写 name");
    expect(callsIn(logFile)).toEqual([{ call: "person.rename", args: { id: "p2" } }]);
    // 没登记的没有记录，调了没调成的那次记成 failed；没有卡
    const records = recordsOf(frontend, SECRETARY)
      .map((r) => r.record)
      .filter((r) => r.kind === "mcp_call");
    expect(records).toHaveLength(1);
    expect(records[0]!.summary).toContain("没做成");
    expect(calledEvents(td)).toMatchObject([{ outcome: "failed", tool: "person.rename" }]);
    expect(cardsOf(frontend)).toEqual([]);
    await frontend.close();
  });

  it("服务进程没起来：说清 + 提示看看端口，不留\"做成了\"的记录", { timeout: 120_000 }, async () => {
    const td = await startTestDaemon({
      secretary: [call("mcp_call", { tool: "broken/status", args: {} }), ECHO],
    });
    writeMcpRegistration(td.dataDir, path.join(makeTempDir("ergo-mcp-broken-log-"), "mcp.jsonl"), {
      broken: { title: "坏了的 MCP", command: process.execPath, args: [path.join(makeTempDir("ergo-broken-"), "没有这个文件.mjs")], tools: { status: { title: "看状态", readOnlyOrIdempotent: true, network: false } } },
    });
    const frontend = await connect(td.url);
    await frontend.sendText("看看那个 MCP 的状态");
    await turnsOf(frontend, SECRETARY, 1);
    const seen = secretaryReply(frontend);
    expect(seen).toContain("没起来");
    expect(seen).toContain("端口");
    expect(seen).not.toContain("做成了");
    const records = recordsOf(frontend, SECRETARY)
      .map((r) => r.record)
      .filter((r) => r.kind === "mcp_call");
    expect(records).toHaveLength(1);
    expect(records[0]!.detail).toContain("没做成");
    expect(calledEvents(td)).toMatchObject([{ outcome: "failed", result: { ok: false } }]);
    expect(cardsOf(frontend)).toEqual([]);
    await frontend.close();
  });

  it("停用 / 移除这个 MCP 之后再调回\"没登记\"", { timeout: 120_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-call-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      secretary: [call("mcp_call", { tool: "album/filter.set", args: { personId: "p2" } }), say("筛选好了"), call("mcp_call", { tool: "album/filter.set", args: { personId: "p2" } }), ECHO],
    });
    registerAlbum(td, logFile);
    const frontend = await connect(td.url);
    await frontend.sendText("只看老二");
    await turnsOf(frontend, SECRETARY, 1);
    expect(callsIn(logFile)).toEqual([{ call: "filter.set", args: { personId: "p2" } }]);
    expect(secretaryReply(frontend)).toContain("筛选好了");
    // 停用 / 移除：登记里没有 album 了（配置区本来要用户手改，这里直接重写一份）
    writeMcpRegistration(td.dataDir, logFile);
    await frontend.sendText("还是一样，只看老二");
    await turnsOf(frontend, SECRETARY, 2);
    expect(secretaryReply(frontend)).toContain("没有登记 MCP album");
    expect(callsIn(logFile)).toEqual([{ call: "filter.set", args: { personId: "p2" } }]);
    await frontend.close();
  });
});
