// MCP 登记变更（239 号票）的单元测试：
// - 工具 request_mcp_change：只校验、出卡，文件一个字节都不变；名字格式、command 空、tools 不合法、密钥写明文时不出卡；
//   add / update / remove 先对上现在的登记（add 不能覆盖已有的、update 和 remove 要有这条）；
// - 批准：按 name 合并写进 mcp.json，然后真把服务进程拉起来一次（tools/list）把结果写进卡和时间线；拉不起来时登记留着、
//   卡上写原因，不回滚；拒绝不写文件。两种决定都记一条 mcp_decided（审批决定素材）和维护者会话上的时间线。
// 写入文件本身（合并、原子写、备份）在 writer.test.ts，端到端的在主切面 test/main/mcp-registration.test.ts。
import fs from "node:fs";
import path from "node:path";
import { type McpChangeSubmitter as McpSubmitter, nowIso } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { createMcpChangeService, mcpChangeCardType, type McpChangeService, type McpChangeTarget } from "../../src/mcp/change.ts";
import { createMcpService, type McpService } from "../../src/mcp/mcp.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { FAKE_MCP_SERVER, MCP_TOKEN, MCP_TOKEN_ENV, mcpLog } from "../helpers/toolkit.ts";

/** 临时配置区里的登记文件和历史区 */
function configDir(initial?: unknown) {
  const root = makeTempDir("ergo-mcp-config-");
  const layout = dataDirLayout(root);
  fs.mkdirSync(layout.config, { recursive: true });
  if (initial !== undefined) fs.writeFileSync(layout.mcpFile, typeof initial === "string" ? initial : JSON.stringify(initial, null, 2));
  return { file: layout.mcpFile, historyDir: path.join(layout.config, ".history"), root };
}

const notes = { command: "node", args: ["notes.js"], tools: { search: { title: "搜笔记" } } };

/** 一条登记的内容：假 MCP 服务的（和主切面一样，只是这里不用起守护进程） */
const albumEntry = (logFile: string) => ({
  title: "旅行相册",
  command: process.execPath,
  args: [FAKE_MCP_SERVER],
  env: { FAKE_MCP_LOG: logFile, FAKE_MCP_TOKEN: { fromEnv: MCP_TOKEN_ENV } },
  tools: {
    list_actions: { title: "列出动作", readOnlyOrIdempotent: true, network: false },
    call: { title: "调用动作", readOnlyOrIdempotent: false, network: false },
  },
});

/** 单元测试的底座：真的卡片、待我处理、事件存储，假的只有项目和任务的查询 */
function setup(initial?: unknown) {
  const { file, historyDir, root } = configDir(initial);
  const logFile = path.join(makeTempDir("ergo-mcp-log-"), "mcp.jsonl");
  const store = openEventStore({ file: path.join(root, "ergo.db"), views: [cardsView, inboxView] });
  onTestFinished(() => store.close());
  const registry = new CardTypeRegistry();
  const cards = createCardService({ store, registry, now: nowIso });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: nowIso });
  const logs: string[] = [];
  const mcp: McpService = createMcpService({ file, parentEnv: { [MCP_TOKEN_ENV]: MCP_TOKEN }, cwd: makeTempDir("ergo-cwd-"), newJob: () => undefined, callTimeoutMs: 5_000, log: (l) => logs.push(l) });
  onTestFinished(() => mcp.stop());
  const changed: McpSubmitter[] = [];
  const submissions: Record<string, { kind: "project"; name: string } | { kind: "task"; title: string; maintainerId: string; projectId?: string }> = {
    "p-1": { kind: "project", name: "旅行相册" },
    "t-1": { kind: "task", title: "整理照片", maintainerId: "tm-1", projectId: "p-1" },
  };
  const service: McpChangeService = createMcpChangeService({
    store,
    cards,
    inbox,
    mcp,
    write: { file, historyDir },
    projectOf: (id) => (submissions[id]?.kind === "project" ? { id, name: submissions[id]!.name as string } : undefined),
    taskOf: (id) => {
      const row = submissions[id];
      return row?.kind === "task" ? { id, title: row.title, maintainerId: row.maintainerId, ...(row.projectId === undefined ? {} : { projectId: row.projectId }) } : undefined;
    },
    mcpChanged: (who) => changed.push(who),
    selfCheckTimeoutMs: 10_000,
    now: nowIso,
    log: (l) => logs.push(l),
  });
  registry.register(mcpChangeCardType(service));
  const tool = (target: McpChangeTarget) => service.requestTool(target);
  const run = async (target: McpChangeTarget, args: Record<string, unknown>) => tool(target).run(args as never, { toolCallId: "call-1" });
  /** 每种卡的最后一版（卡片每修改一次追加一版） */
  const latestCards = () => {
    const byId = new Map<string, { id: string; type: string; payload: Record<string, unknown>; status: string }>();
    for (const event of store.read("cards", 0)) byId.set((event.payload as { card: { id: string } }).card.id, (event.payload as { card: never }).card);
    return [...byId.values()];
  };
  const cardsOfType = (type: string) => latestCards().filter((c) => c.type === type);
  /** 用户在卡上做了动作（和前端走同一条路：卡片改写、处理结果、事件一起落盘） */
  const act = (cardId: string, action: "approve" | "deny", note?: string) => {
    const card = cards.get(cardId)!;
    return cards.act({ cardId, action, expectedVersion: card.version, idempotencyKey: `k-${action}-${cardId}`, ...(note === undefined ? {} : { note }) });
  };
  const decided = () => store.read("mcp", 0).map((e) => e.payload as Record<string, unknown>);
  const timeline = (channel: string) => store.read(channel, 0).filter((e) => e.type === "timeline_record").map((e) => (e.payload as { record: { kind: string; summary: string; detail?: string } }).record);
  return { service, store, cards, inbox, mcp, file, logFile, changed, run, act, cardsOfType, decided, timeline, logs };
}

const projectTarget: McpChangeTarget = { kind: "project", projectId: "p-1", maintainerId: "pm-1" };

describe("request_mcp_change：只校验、出卡", () => {
  it("不合规的当场回原因、不出卡、文件不动", async () => {
    const s = setup();
    const hash = () => (fs.existsSync(s.file) ? fs.readFileSync(s.file, "utf8") : "<没有>");
    const before = hash();
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["名字不合法", { action: "add", name: "家庭 相册", command: "node", tools: { a: { title: "甲" } } }, /名字/],
      ["command 空", { action: "add", name: "album", command: "", tools: { a: { title: "甲" } } }, /command/],
      ["tools 不合法", { action: "add", name: "album", command: "node", tools: { a: {} } }, /tools|title/],
      ["没有工具", { action: "add", name: "album", command: "node", tools: {} }, /工具/],
      ["密钥写明文", { action: "add", name: "album", command: "node", env: { ALBUM_TOKEN: "sk-明文" }, tools: { a: { title: "甲" } } }, /fromEnv/],
      ["删一条没登记的", { action: "remove", name: "album" }, /没有.*album|add/],
    ];
    for (const [why, args, message] of cases) {
      const result = await s.run(projectTarget, args);
      expect({ why, isError: result.isError, text: result.text }).toMatchObject({ why, isError: true, text: expect.stringMatching(message) });
      expect({ why, cards: s.cardsOfType("mcp_change").length }).toEqual({ why, cards: 0 });
    }
    expect(hash()).toBe(before);
  });

  it("合规的出一张卡：动作、名字、校验过的登记、是谁提的；add 不能顶掉已有的", async () => {
    const s = setup({ servers: { notes } });
    const entry = albumEntry(s.logFile);
    const result = await s.run(projectTarget, { action: "add", name: "album", why: "p-4 的相册桥", ...entry });
    expect(result.isError).toBeFalsy();
    expect(result.cardIds).toHaveLength(1);
    const [card] = s.cardsOfType("mcp_change");
    expect(card!.payload).toMatchObject({
      action: "add",
      name: "album",
      submitter: { kind: "project", projectId: "p-1", projectName: "旅行相册", maintainerId: "pm-1" },
      registration: { command: process.execPath, tools: { list_actions: { title: "列出动作" } } },
    });
    expect(card!.status).toBe("pending");
    // 待我处理里有一条
    const items = s.inbox.list().filter((i) => i.kind === "card" && i.cardId === card!.id);
    expect(items).toHaveLength(1);
    // 文件一个字节都没变
    expect(fs.readFileSync(s.file, "utf8")).toBe(JSON.stringify({ servers: { notes } }, null, 2));
    // 再 add 一次同一个名字：不出卡，提示用 update
    const again = await s.run(projectTarget, { action: "add", name: "notes", command: "node", tools: { a: { title: "甲" } } });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/update/);
    expect(s.cardsOfType("mcp_change")).toHaveLength(1);
  });
});

describe("批准、拒绝", () => {
  it("批准：按 name 合并写进去，真把服务拉起来一次，结果写进卡和时间线；审批决定是素材", async () => {
    const s = setup({ servers: { notes } });
    const before = JSON.parse(fs.readFileSync(s.file, "utf8")) as { servers: Record<string, unknown> };
    await s.run(projectTarget, { action: "add", name: "album", why: "接相册桥", ...albumEntry(s.logFile) });
    const [card] = s.cardsOfType("mcp_change");
    await s.act(card!.id, "approve", "可以");
    // 原有的一条不动，新的一条在里面
    const after = JSON.parse(fs.readFileSync(s.file, "utf8")) as { servers: Record<string, unknown> };
    expect(after.servers.notes).toEqual(before.servers.notes);
    expect(after.servers.album).toMatchObject({ title: "旅行相册" });
    // 真拉起来了：假服务记下了 started，卡上写着它报的工具
    expect(mcpLog(s.logFile).some((e) => e.started)).toBe(true);
    const updated = s.cards.get(card!.id)!;
    expect(updated.status).toBe("handled");
    expect(updated.payload).toMatchObject({ applied: true, check: { ok: true, tools: ["echo", "env_token", "send_note", "wait", "status", "person.rename", "filter.set", "slideshow.start"] } });
    expect(updated.outcome?.note).toMatch(/登记好了|已登记/);
    // 时间线：维护者会话上一条，写着谁提的、动作、名字、自检结果
    expect(s.timeline("maintainer:pm-1")).toMatchObject([{ kind: "mcp", summary: expect.stringContaining("旅行相册") }]);
    expect(s.timeline("maintainer:pm-1")[0]!.detail).toContain("list_actions");
    // 审批决定
    expect(s.decided()).toMatchObject([
      { decision: "approved", action: "add", name: "album", cardId: card!.id, note: "可以", applied: true, submitter: { kind: "project", projectId: "p-1" }, check: { ok: true } },
    ]);
    // 登记变了：让提交的人的会话按新的装配重新拉起（卡片落盘之后叫）
    expect(s.changed).toMatchObject([{ kind: "project", projectId: "p-1", maintainerId: "pm-1" }]);
  });

  it("拉不起来：登记留着（不回滚），卡上写原因，时间线也记一笔；拒绝则一个字节不动", async () => {
    const s = setup();
    const broken = { command: process.execPath, args: [path.join(makeTempDir("ergo-broken-"), "没有这个文件.mjs")], tools: { status: { title: "状态", readOnlyOrIdempotent: true } } };
    await s.run(projectTarget, { action: "add", name: "broken", why: "试试", ...broken });
    const [card] = s.cardsOfType("mcp_change");
    await s.act(card!.id, "approve");
    const updated = s.cards.get(card!.id)!;
    expect(updated.outcome?.note).toMatch(/没拉起来/);
    expect(updated.payload).toMatchObject({ applied: true, check: { ok: false, problem: expect.stringMatching(/\S/) } });
    // 登记留着
    const after = JSON.parse(fs.readFileSync(s.file, "utf8")) as { servers: Record<string, unknown> };
    expect(Object.keys(after.servers)).toEqual(["broken"]);
    expect(s.timeline("maintainer:pm-1")[0]!.summary).toContain("没拉起来");

    // 拒绝：不写文件
    const denied = setup({ servers: { notes } });
    const before = fs.readFileSync(denied.file, "utf8");
    await denied.run(projectTarget, { action: "remove", name: "notes" });
    const [second] = denied.cardsOfType("mcp_change");
    await denied.act(second!.id, "deny", "先不删");
    expect(fs.readFileSync(denied.file, "utf8")).toBe(before);
    expect(denied.decided()).toMatchObject([{ decision: "denied", action: "remove", name: "notes", cardId: second!.id, note: "先不删", applied: false }]);
    expect(denied.changed).toEqual([]);
  });
});
