// 主切面（239 号票）：维护者用 request_mcp_change 提一条 MCP 登记的加、改、删，用户在"MCP 登记变更"卡上确认之后，
// 运行时才按 name 合并写进数据目录配置区的 config/mcp.json，顺手把这个 MCP 真拉起来一次做自检。真的守护进程、真的端口、
// 真的 mcp.json；MCP 服务进程是测试里的假 MCP 服务（test/fixtures/fake-mcp-server.mjs，stdio，不连任何真的 MCP）。
// 覆盖的验收：
// - 批准后 mcp.json 里多出那条登记（原有条目不动），维护者的会话按新装配重新拉起、里面能看到这个 MCP 的工具；
// - 未确认时文件一个字节都不变（对比前后全文）；
// - 删一条同样要卡，确认后工具从会话里消失（别的登记不动）；
// - 校验不通过（command 空）时不出卡，文件不动；
// - bash / 写文件直接改 mcp.json 被拒（处置"永不"、结局被拦下），文件不变；
// - 时间线、审计（mcp_decided）、审批决定素材里查得到：哪个项目提的、用户什么时候确认的、自检结果。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type McpChangeCardPayload, type McpDecidedPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { TestDaemon } from "../helpers/daemon.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { toolsNow } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { settled } from "../helpers/settled.ts";
import { call, cardWhere, eventually, fwd, inboxOf, messagesOf, ok, recordsOf, say, textOf, toolCallsOf } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { FAKE_MCP_SERVER, MCP_TOKEN, MCP_TOKEN_ENV, mcpLog, seedToolkitProject, toolkit, writeMcpRegistration } from "../helpers/toolkit.ts";

const PM1 = maintainerChannel("pm-1");
/** echo_context：回的是维护者看到的上下文（系统提示、工具、工具结果） */
const echo = { kind: "echo_context" } as const;

/** 给维护者的假 MCP 服务（相册桥）：命令、args、凭据只写引用、两个只读工具（假服务报的是 echo、status） */
const albumRegistration = (logFile: string) => ({
  title: "旅行相册",
  command: process.execPath,
  args: [FAKE_MCP_SERVER],
  env: { FAKE_MCP_LOG: logFile, FAKE_MCP_TOKEN: { fromEnv: MCP_TOKEN_ENV } },
  tools: {
    echo: { title: "原样回话", readOnlyOrIdempotent: true, network: false },
    status: { title: "看状态", readOnlyOrIdempotent: true, network: false },
  },
});

/** 维护者此刻能用的工具那几行：开头那一份（按新装配接着会话也是开头一份、按这次交的先后，273 号票）；以前回显的旧上下文不算 */
const toolLines = (seen: string) => toolsNow(seen).map((name) => `[tool] ${name}`);

/** 维护者会话里 agent 的回复（echo_context 回的是它看到的上下文） */
const repliesOf = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .filter((m) => m.message.speaker === "agent" && m.message.parts.some((p) => p.type === "text"))
    .map(textOf);

/** 维护者会话里第 n 条回复（从 1 起） */
async function nthReply(frontend: TestFrontend, channel: string, n: number): Promise<string> {
  await waitUntil(() => repliesOf(frontend, channel).length >= n, { timeoutMs: 60_000, describe: () => `等 ${channel} 的第 ${n} 条回复；现在是：\n${repliesOf(frontend, channel).map((t) => t.slice(0, 200)).join("\n")}` });
  return repliesOf(frontend, channel)[n - 1]!;
}

/** 连上前端，订阅卡片、待我处理、项目和项目维护者的会话 */
async function connect(td: TestDaemon): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe(Object.fromEntries([CHANNELS.cards, CHANNELS.inbox, CHANNELS.projects, PM1].map((channel) => [channel, 0])));
  return frontend;
}

/** 配置区的登记文件的全文（没有这个文件时写"没有"） */
const fileText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "<没有>");
/** 卡片频道上这张卡的最后样子 */
const cardOf = (frontend: TestFrontend, cardId: string) =>
  frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).map((f) => (f.payload as { card: McpChangeCardShape }).card).filter((c) => c.id === cardId).at(-1)!;
type McpChangeCardShape = { id: string; type: string; status: string; payload: Partial<McpChangeCardPayload>; outcome?: { note?: string } };

describe("MCP 登记变更（239）", () => {
  it("维护者提一条登记，用户在卡上确认后才写进 mcp.json：原有条目不动，自检真把服务拉起来，会话里看得到它的工具；时间线、审计、素材都记着", { timeout: 120_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const albumLog = path.join(makeTempDir("ergo-mcp-album-"), "mcp.jsonl");
    const td = await startTestDaemon({
      env: { [MCP_TOKEN_ENV]: MCP_TOKEN },
      // 第 1 次：用户让接相册桥 → 提登记（接着回它看到的上下文，里面是工具的结果）；批准之后按新装配重新拉起
      maintainer: (_id, spawn) => (spawn === 1 ? [call("request_mcp_change", { action: "add", name: "album", why: "p-4 的相册桥已经能跑了", ...albumRegistration(albumLog) }), echo] : [echo, say("看到了")]),
    });
    // 配置区里本来登记着 demo；项目的工具包里已经列着 album（比如之前登记过、后来删了）
    writeMcpRegistration(td.dataDir, logFile);
    const { mcpFile } = dataDirLayout(td.dataDir);
    const before = fileText(mcpFile);
    const project = seedToolkitProject(td.daemon, "旅行相册", toolkit({ mcp: ["album"] }));
    const frontend = await connect(td);

    await frontend.sendText("把相册桥接上", { conversation: PM1 });
    const card = await cardWhere(frontend, (c) => c.type === "mcp_change", "MCP 登记变更卡");
    expect(card.payload).toMatchObject({
      action: "add",
      name: "album",
      submitter: { kind: "project", projectId: project.id, projectName: "旅行相册", maintainerId: "pm-1" },
      registration: expect.objectContaining({ title: "旅行相册", command: process.execPath }),
    });
    // 卡上：启动命令、args、env（密钥只写"来自环境变量 X"）、工具和只读标注；密钥原值一个字都没有
    expect(card.text).toContain(FAKE_MCP_SERVER);
    expect(card.text).toContain(`来自环境变量 ${MCP_TOKEN_ENV}`);
    expect(card.text).toContain("原样回话");
    expect(card.text).toContain("只读或幂等");
    expect(card.text).not.toContain(MCP_TOKEN);
    // 待我处理里有一条；工具结果告诉维护者卡进待我处理了、用户确认之前文件不变
    expect(inboxOf(frontend).some((item) => item.kind === "card" && item.cardId === card.id)).toBe(true);
    expect(await nthReply(frontend, PM1, 1)).toContain("已提交“MCP 登记变更”卡");
    // 未确认：文件一个字节都不变，服务也还没被拉起过
    expect(fileText(mcpFile)).toBe(before);
    expect(mcpLog(albumLog)).toEqual([]);

    // 用户在卡上确认
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version, note: "接吧" }));
    // 写进去了：原有的 demo 一字不差，新的一条在里面
    const written = JSON.parse(fs.readFileSync(mcpFile, "utf8")) as { servers: Record<string, unknown> };
    const original = (JSON.parse(before) as { servers: Record<string, unknown> }).servers;
    expect(Object.keys(written.servers).toSorted()).toEqual(["album", "demo"]);
    expect(written.servers.demo).toEqual(original.demo);
    expect(written.servers.album).toMatchObject({ title: "旅行相册", command: process.execPath });
    // 自检：真把这个 MCP 拉起来了（假服务记下了 started），卡上写着它报的工具
    expect(mcpLog(albumLog).some((e) => e.started)).toBe(true);
    const approved = cardOf(frontend, card.id);
    expect(approved.status).toBe("handled");
    expect(approved.payload.check).toMatchObject({ ok: true, tools: ["echo", "env_token", "send_note", "wait", "status", "person.rename", "filter.set", "slideshow.start"] });
    expect(approved.outcome?.note).toMatch(/登记好了/);
    // 会话按新装配重新拉起：这个 MCP 的工具在了
    const seen = await nthReply(frontend, PM1, 2);
    expect(toolLines(seen)).toEqual(expect.arrayContaining(["[tool] mcp__album__echo", "[tool] mcp__album__status"]));
    // 时间线：谁提的、批准了、自检结果
    const record = recordsOf(frontend, PM1).map((r) => r.record).filter((r) => r.kind === "mcp").at(-1)!;
    expect(record.summary).toContain("项目「旅行相册」的维护者");
    expect(record.summary).toContain("拉起来了");
    expect(record.detail).toContain("原样回话");
    // 审计：mcp_decided 记着项目、时间、自检结果
    const decided = td.daemon.store.read("mcp", 0).map((e) => e.payload as McpDecidedPayload);
    expect(decided).toMatchObject([
      { decision: "approved", action: "add", name: "album", cardId: card.id, applied: true, check: { ok: true }, submitter: { kind: "project", projectId: project.id }, note: "接吧" },
    ]);
    expect(Number.isNaN(Date.parse(decided[0]!.time))).toBe(false);
    // 审批决定（素材）：批准的是维护者先提的申请，写着用户那句"接吧"
    const decisions = () => td.daemon.materials.list({ kind: "approval_decision" }).filter((m) => m.context.includes("card:mcp_change"));
    const decision = await eventually(decisions, (m) => m.context.includes("decision:approved"), "MCP 登记变更的审批决定素材");
    expect(decision.segments.map((s) => s.text).join("\n")).toContain("接吧");
    // 维护者收到了批准的通知
    expect(messagesOf(frontend, PM1).some((m) => m.agentInput === true && textOf(m).includes("批准了你的 MCP 登记变更"))).toBe(true);
    await frontend.close();
  });

  it("删一条登记也要卡：确认后才从 mcp.json 里去掉（别的条目不动），工具从会话里消失", { timeout: 120_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const td = await startTestDaemon({
      env: { [MCP_TOKEN_ENV]: MCP_TOKEN },
      maintainer: (_id, spawn) => (spawn === 1 ? [echo, call("request_mcp_change", { action: "remove", name: "demo", why: "桥不要了" }), echo] : [echo, say("没了")]),
    });
    // 登记着 demo，另有一条 notes（删 demo 时它不能动）
    writeMcpRegistration(td.dataDir, logFile, { notes: { command: process.execPath, args: [FAKE_MCP_SERVER], tools: { status: { title: "看状态", network: false } } } });
    const { mcpFile } = dataDirLayout(td.dataDir);
    const before = fileText(mcpFile);
    seedToolkitProject(td.daemon, "旅行相册", toolkit({ mcp: ["demo"] }));
    const frontend = await connect(td);

    // 一开始会话里就有 demo 的工具
    await frontend.sendText("看看有什么", { conversation: PM1 });
    const first = await nthReply(frontend, PM1, 1);
    expect(toolLines(first)).toEqual(expect.arrayContaining(["[tool] mcp__demo__echo"]));
    // 让维护者删掉：出一张卡，批准之前文件不变
    await frontend.sendText("把 demo 桥去掉", { conversation: PM1 });
    const card = await cardWhere(frontend, (c) => c.type === "mcp_change", "删登记的卡");
    expect(card.payload).toMatchObject({ action: "remove", name: "demo" });
    expect(card.payload).not.toHaveProperty("registration");
    expect(await nthReply(frontend, PM1, 2)).toContain("已提交“MCP 登记变更”卡：删 MCP demo");
    expect(fileText(mcpFile)).toBe(before);
    // 确认：demo 没有了，notes 还在
    await settled(td, "pm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    const written = JSON.parse(fs.readFileSync(mcpFile, "utf8")) as { servers: Record<string, unknown> };
    expect(Object.keys(written.servers)).toEqual(["notes"]);
    // 会话按新装配重新拉起：demo 的工具不在了
    const third = await nthReply(frontend, PM1, 3);
    expect(toolLines(third)).not.toContain("[tool] mcp__demo__echo");
    expect(recordsOf(frontend, PM1).map((r) => r.record.kind)).toContain("mcp");
    await frontend.close();
  });

  it("校验不通过不出卡、文件不动；用 write / bash 直接改配置区的 mcp.json 被拒（永不），文件照样不动", { timeout: 120_000 }, async () => {
    const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
    const target = () => path.join(td.dataDir, "config", "mcp.json");
    const td = await startTestDaemon({
      env: { [MCP_TOKEN_ENV]: MCP_TOKEN },
      maintainer: () => [
        // command 空：当场回原因，不出卡
        call("request_mcp_change", { action: "add", name: "album", command: "", tools: { echo: { title: "回话" } } }),
        // 绕过：自己写配置区的 mcp.json
        call("write", { path: target(), content: '{"servers":{}}' }),
        call("bash", { command: `echo '{}' > "${fwd(target())}"` }),
        echo,
      ],
    });
    writeMcpRegistration(td.dataDir, logFile);
    const before = fileText(target());
    seedToolkitProject(td.daemon, "旅行相册", toolkit({ bash: true }));
    const frontend = await connect(td);

    await frontend.sendText("试试改配置", { conversation: PM1 });
    const seen = await nthReply(frontend, PM1, 1);
    // 校验不过：工具结果里直接写着原因，没有出卡
    expect(seen).toContain("[toolResult] request_mcp_change");
    expect(seen).toContain("command 要写要拉起的命令");
    expect(frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).filter((f) => (f.payload as { card: { type: string } }).card.type === "mcp_change")).toEqual([]);
    // 两条绕过的路子都被拦下、记在这次调用的记录里（处置"永不"，结局"被拦下"）
    const calls = toolCallsOf(frontend, PM1);
    expect(calls.filter((c) => c.tool === "write").map((c) => [c.disposition, c.outcome])).toEqual([["never", "blocked"]]);
    expect(calls.filter((c) => c.tool === "bash").map((c) => [c.disposition, c.outcome])).toEqual([["never", "blocked"]]);
    // 文件一个字节都不变
    expect(fileText(target())).toBe(before);
    await frontend.close();
  });
});
