// agent 自己申请目录授权（464，folders/folder-grant-requests.ts）。真的卡片、待办、事件存储和目录授权表，假的只有"这个 agent 在哪"：
// - 发卡前先查，查不过直接回原因、不发卡：目录不对（相对路径、不在、不是目录、在数据目录里）、没有表的 agent；
// - 已经有了（这个目录或上级登记了、要的都有、没过期；所有 agent 都能读的文件夹里只要读）回"已经有了"，过期了的照样发卡；
//   同一个 agent 同一个目录已经有一张没处理的 → "已经在等"；
// - 发的卡：已有什么、读本来就行，进待办（来源、去处、项目内部的标记），出在它自己的会话里（交回卡片编号）；
// - 同意：登记（谁加的记 request），已有的那条不会被收窄（操作取并集、到期取更晚的）；收窄后只登记勾着的，不能加没要的；
//   登记不成（目录没了）卡留着、不算同意、不通知；不同意不登记；结果作为通知交回它的会话（带归属）；
// - 守卫里它不改东西、不登记路径参数；子 agent 没有这个工具。
import fs from "node:fs";
import path from "node:path";
import { type Card, CHANNELS, type FolderGrantRequestCardPayload, maintainerChannel, type MessageEventPayload, nowIso } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { createFolderGrantRequests, folderGrantExpiryAfter, folderGrantRequestCardType, type FolderGrantOwner, REQUEST_FOLDER_GRANT_TOOL } from "../../src/folders/folder-grant-requests.ts";
import { openFolderGrants } from "../../src/folders/folder-grants.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { MAINTAINER_ONLY_TOOLS, subAgentAssembly } from "../../src/sub-agents/assembly.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 12, 4, 0, 0);

const OWNERS: Record<string, FolderGrantOwner> = {
  secretary: { label: "〔助理〕", conversation: CHANNELS.secretary, scope: {}, source: "〔助理〕", origin: { conversation: CHANNELS.secretary } },
  "pm-1": { label: "项目「笔记」的负责人", conversation: maintainerChannel("pm-1"), scope: { projectId: "p-1" }, source: "项目「笔记」", origin: { projectId: "p-1" } },
  "tm-1": {
    label: "长程任务 t-1「整理」的负责人",
    conversation: maintainerChannel("tm-1"),
    scope: { taskId: "t-1", projectId: "p-1" },
    source: "项目「笔记」内部 · 任务「整理」",
    origin: { taskId: "t-1", projectId: "p-1" },
    internal: { projectId: "p-1", projectName: "笔记" },
  },
};

function setup() {
  const root = fs.realpathSync.native(makeTempDir("ergo-grant-requests-"));
  const notes = path.join(root, "notes");
  const inner = path.join(notes, "books");
  const photos = path.join(root, "photos");
  const dataDir = path.join(root, "ergo-data");
  for (const dir of [notes, inner, photos, path.join(dataDir, "config")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, "file.txt"), "x");
  const store = openEventStore({ file: path.join(dataDir, "ergo.db"), views: [cardsView, inboxView] });
  onTestFinished(() => store.close());
  let now = NOW;
  const registry = new CardTypeRegistry();
  const cards = createCardService({ store, registry, now: () => nowIso(new Date(now)) });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: () => nowIso(new Date(now)) });
  const grants = openFolderGrants({
    file: path.join(dataDir, "config", "folder-grants.json"),
    now: () => now,
    forbidden: () => [dataDir],
    canHold: (agentId) => agentId in OWNERS,
    log: () => {},
  });
  const registered: number[] = [];
  const authorized: string[] = [];
  const requests = createFolderGrantRequests({
    store,
    cards,
    inbox,
    grants,
    authorizedFolders: () => authorized,
    ownerOf: (agentId) => OWNERS[agentId],
    now: () => now,
    onRegistered: () => registered.push(now),
    log: () => {},
  });
  registry.register(folderGrantRequestCardType(requests));
  const ask = (agentId: string, args: Record<string, unknown>) => requests.tool(agentId).run(args as never, { toolCallId: "call-1" });
  const latest = (): Card[] => {
    const byId = new Map<string, Card>();
    for (const event of store.read(CHANNELS.cards, 0)) byId.set((event.payload as { card: Card }).card.id, (event.payload as { card: Card }).card);
    return [...byId.values()].filter((c) => c.type === "folder_grant_request");
  };
  const act = (cardId: string, action: "approve" | "deny", o: { note?: string; input?: unknown } = {}) => {
    const card = cards.get(cardId)!;
    return cards.act({ cardId, action, expectedVersion: card.version, idempotencyKey: `k-${action}-${cardId}-${card.version}`, ...o }) as ReturnType<typeof cards.act> & { ok?: boolean };
  };
  const notices = (channel: string) =>
    store
      .read(channel, 0)
      .filter((e) => e.type === "message")
      .map((e) => e.payload as MessageEventPayload)
      .filter((m) => m.agentInput && m.message.speaker === "system");
  return { root, notes, inner, photos, dataDir, store, cards, inbox, grants, requests, ask, latest, act, notices, noticeText, authorized, registered, setNow: (at: number) => (now = at) };
}

/** 一条通知的文字 */
const noticeText = (m: MessageEventPayload) => m.message.parts.map((p) => ("text" in p ? p.text : "")).join("");

/** 卡片动作的结果：成了，或者拒绝的原因 */
async function outcome(fn: () => unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

describe("发卡前先查", () => {
  it("目录不对、没有表：直接回原因，不发卡、不进待办", async () => {
    const s = setup();
    const cases: [string, string, Record<string, unknown>, RegExp][] = [
      ["相对路径", "secretary", { path: "notes", modes: ["read"], why: "整理" }, /完整的路径/],
      ["不在", "secretary", { path: path.join(s.root, "nope"), modes: ["read"], why: "整理" }, /没有这个文件夹/],
      ["不是目录", "secretary", { path: path.join(s.root, "file.txt"), modes: ["read"], why: "整理" }, /不是文件夹/],
      ["数据目录里", "secretary", { path: path.join(s.dataDir, "config"), modes: ["write"], why: "改配置" }, /不能登记/],
      ["没有表的 agent", "sa-1", { path: s.notes, modes: ["read"], why: "整理" }, /没有目录授权表/],
      ["没写为什么", "secretary", { path: s.notes, modes: ["read"] }, /参数不对/],
      ["天数不对", "secretary", { path: s.notes, modes: ["read"], days: 0, why: "整理" }, /参数不对/],
    ];
    for (const [why, agentId, args, message] of cases) {
      const result = await s.ask(agentId, args);
      expect({ why, isError: result.isError, text: result.text }).toMatchObject({ why, isError: true, text: expect.stringMatching(message) });
    }
    expect(s.latest()).toEqual([]);
    expect(s.inbox.list()).toEqual([]);
    expect(s.grants.list()).toEqual([]);
  });

  it("已经有了：这个目录或上级登记了、要的都有、没过期就不发卡；所有 agent 都能读的文件夹里只要读的也算", async () => {
    const s = setup();
    s.grants.add({ agentId: "pm-1", path: s.notes, modes: ["read", "write"], addedBy: "user" });
    const same = await s.ask("pm-1", { path: s.notes, modes: ["write"], why: "写笔记" });
    expect(same.isError).toBeFalsy();
    expect(same.text).toContain("已经有了");
    expect(same.cardIds).toBeUndefined();
    // 上级登记了：里面的目录也算有了
    expect((await s.ask("pm-1", { path: s.inner, modes: ["read", "write"], why: "整理一本书" })).text).toContain("已经有了");
    // 授权的文件夹里只要读
    s.authorized.push(s.photos);
    const readable = await s.ask("secretary", { path: s.photos, modes: ["read"], why: "看照片" });
    expect(readable.text).toContain("读本来就行");
    expect(s.latest()).toEqual([]);
  });

  it("期限不够就是要延长：照常发卡（已有的有期限、这次要得更久或要长期有效）；期限也够的才回已经有了", async () => {
    const s = setup();
    const tenDays = folderGrantExpiryAfter(10, NOW);
    s.grants.add({ agentId: "pm-1", path: s.notes, modes: ["read", "write"], expiresAt: tenDays, addedBy: "user" });
    // 要 7 天：已有的到第 10 天，够了
    const enough = await s.ask("pm-1", { path: s.notes, modes: ["write"], days: 7, why: "写一周" });
    expect(enough.text).toContain("已经有了");
    expect(enough.cardIds).toBeUndefined();
    // 正好 10 天也够
    expect((await s.ask("pm-1", { path: s.notes, modes: ["write"], days: 10, why: "写十天" })).text).toContain("已经有了");
    // 要 30 天：不够，发卡，卡上带着已有的到期时间
    const longer = await s.ask("pm-1", { path: s.notes, modes: ["write"], days: 30, why: "写一个月" });
    expect(longer.cardIds).toHaveLength(1);
    expect(s.latest()[0]!.payload).toMatchObject({ modes: ["write"], days: 30, existing: { path: s.notes, modes: ["read", "write"], expiresAt: tenDays, expired: false } });
    // 要长期有效：有期限的都不够
    s.grants.add({ agentId: "tm-1", path: s.notes, modes: ["read"], expiresAt: nowIso(new Date(NOW + 365 * DAY)), addedBy: "user" });
    expect((await s.ask("tm-1", { path: s.notes, modes: ["read"], why: "一直要读" })).cardIds).toHaveLength(1);
    // 同意之后延长了：到期取更晚的
    await s.act(longer.cardIds![0]!, "approve");
    expect(s.grants.list().find((g) => g.agentId === "pm-1")).toMatchObject({ modes: ["read", "write"], expiresAt: folderGrantExpiryAfter(30, NOW) });
    // 上级登记了长期有效的：里面的目录要多久都够
    s.grants.add({ agentId: "secretary", path: s.notes, modes: ["read"], addedBy: "user" });
    expect((await s.ask("secretary", { path: s.inner, modes: ["read"], days: 3650, why: "一直读" })).text).toContain("已经有了");
  });

  it("过期了的不算有了：照样发卡，卡上写明以前登记过、已过期", async () => {
    const s = setup();
    s.grants.add({ agentId: "secretary", path: s.notes, modes: ["read"], expiresAt: nowIso(new Date(NOW + DAY)), addedBy: "user" });
    s.setNow(NOW + 2 * DAY);
    const result = await s.ask("secretary", { path: s.notes, modes: ["read"], why: "再整理一次" });
    expect(result.cardIds).toHaveLength(1);
    expect(s.latest()[0]!.payload).toMatchObject({ existing: { path: s.notes, modes: ["read"], expired: true } });
  });

  it("同一个 agent 同一个目录已经有一张没处理的：回已经在等，不再发；别的 agent、处理过之后照常发", async () => {
    const s = setup();
    const first = await s.ask("secretary", { path: s.notes, modes: ["read"], why: "整理" });
    expect(first.cardIds).toHaveLength(1);
    const again = await s.ask("secretary", { path: `${s.notes}\\`, modes: ["write"], why: "再要写" });
    expect(again.isError).toBeFalsy();
    expect(again.text).toContain("在等用户确认");
    expect(again.cardIds).toBeUndefined();
    expect((await s.ask("pm-1", { path: s.notes, modes: ["read"], why: "项目也要" })).cardIds).toHaveLength(1);
    expect(s.latest()).toHaveLength(2);
    await s.act(first.cardIds![0]!, "deny");
    expect((await s.ask("secretary", { path: s.notes, modes: ["write"], why: "这次要写" })).cardIds).toHaveLength(1);
  });
});

describe("申请卡", () => {
  it("卡上写谁、目录（真实路径）、要的、多久、为什么、已有什么、读本来就行；进待办，带来源、去处和项目内部的标记", async () => {
    const s = setup();
    s.grants.add({ agentId: "tm-1", path: s.notes, modes: ["read"], addedBy: "user" });
    s.authorized.push(s.root);
    const result = await s.ask("tm-1", { path: s.notes.toUpperCase(), modes: ["delete", "write"], days: 3, why: " 按书归档 " });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("已发给用户，等确认");
    const [card] = s.latest();
    expect(result.cardIds).toEqual([card!.id]);
    expect(card).toMatchObject({ status: "pending", urgency: "non_blocking" });
    expect(card!.payload).toEqual({
      agentId: "tm-1",
      agentLabel: "长程任务 t-1「整理」的负责人",
      path: s.notes,
      modes: ["write", "delete"],
      days: 3,
      why: "按书归档",
      existing: { path: s.notes, modes: ["read"], expired: false },
      readable: true,
    } satisfies FolderGrantRequestCardPayload);
    expect(card!.text).toContain("长程任务 t-1「整理」的负责人申请写、删");
    expect(s.inbox.list()).toMatchObject([
      { kind: "card", cardId: card!.id, source: "项目「笔记」内部 · 任务「整理」", origin: { taskId: "t-1", projectId: "p-1" }, internal: { projectId: "p-1" }, urgency: "non_blocking" },
    ]);
    // 只是发卡：没登记
    expect(s.grants.list().map((g) => g.modes)).toEqual([["read"]]);
  });

  it("工具在守卫里：只读或幂等、只看，不登记路径参数（不因为目录在范围之外先弹审批），不落入任何类别", () => {
    const s = setup();
    const tool = s.requests.tool("secretary");
    expect(tool.spec.name).toBe(REQUEST_FOLDER_GRANT_TOOL);
    expect(tool.descriptor).toMatchObject({ source: "host", categories: [], args: {}, readOnlyOrIdempotent: true, nature: "look" });
  });
});

describe("同意、不同意", () => {
  it("同意：登记成它申请的（谁加的写 request），结果作为通知交回它的会话（带归属）", async () => {
    const s = setup();
    const { cardIds } = await s.ask("pm-1", { path: s.notes, modes: ["read", "write"], days: 7, why: "导出笔记" });
    await s.act(cardIds![0]!, "approve");
    const [grant] = s.grants.list();
    expect(grant).toMatchObject({ agentId: "pm-1", path: s.notes, modes: ["read", "write"], note: "导出笔记", addedBy: "request", expiresAt: folderGrantExpiryAfter(7, NOW) });
    expect(s.registered).toEqual([NOW]);
    const card = s.latest()[0]!;
    expect(card.status).toBe("handled");
    expect(card.outcome).toMatchObject({ action: "approve" });
    expect((card.payload as FolderGrantRequestCardPayload).decided).toMatchObject({ approved: true, granted: { modes: ["read", "write"] }, grant: { modes: ["read", "write"], expiresAt: grant!.expiresAt } });
    const [notice] = s.notices(maintainerChannel("pm-1"));
    expect(notice).toMatchObject({ agentInput: true, projectId: "p-1" });
    expect(s.noticeText(notice!)).toContain(`用户同意了你申请的目录授权：${s.notes}，读、写`);
    expect(s.notices(CHANNELS.secretary)).toEqual([]);
  });

  it("已有的那条不会被收窄：操作取并集，到期取更晚的（长期有效最晚）", async () => {
    const s = setup();
    // 已有：读，长期有效；申请写 3 天 → 读写、仍然长期有效
    s.grants.add({ agentId: "secretary", path: s.notes, modes: ["read"], note: "整理读书笔记", addedBy: "user" });
    const a = await s.ask("secretary", { path: s.notes, modes: ["write"], days: 3, why: "写回去" });
    await s.act(a.cardIds![0]!, "approve");
    expect(s.grants.list()).toMatchObject([{ path: s.notes, modes: ["read", "write"], note: "整理读书笔记", addedBy: "request" }]);
    expect(s.grants.list()[0]!.expiresAt).toBeUndefined();
    expect(s.noticeText(s.notices(CHANNELS.secretary)[0]!)).toContain("并进原来那条之后现在是：读、写（长期有效）");
    // 已有：读写删，到 30 天后；申请删 3 天 → 到期还是 30 天后
    s.grants.add({ agentId: "pm-1", path: s.notes, modes: ["read", "write"], expiresAt: nowIso(new Date(NOW + 30 * DAY)), addedBy: "user" });
    const b = await s.ask("pm-1", { path: s.notes, modes: ["delete"], days: 3, why: "删重复的" });
    await s.act(b.cardIds![0]!, "approve");
    const pm = s.grants.list().find((g) => g.agentId === "pm-1")!;
    expect(pm.modes).toEqual(["read", "write", "delete"]);
    expect(Date.parse(pm.expiresAt!)).toBe(NOW + 30 * DAY);
    // 已有到期的、这次要长期有效 → 长期有效
    s.grants.add({ agentId: "tm-1", path: s.notes, modes: ["read"], expiresAt: nowIso(new Date(NOW + DAY)), addedBy: "user" });
    const c = await s.ask("tm-1", { path: s.notes, modes: ["write"], why: "长期写" });
    await s.act(c.cardIds![0]!, "approve");
    expect(s.grants.list().find((g) => g.agentId === "tm-1")).toMatchObject({ modes: ["read", "write"] });
    expect(s.grants.list().find((g) => g.agentId === "tm-1")!.expiresAt).toBeUndefined();
  });

  it("收窄后只登记勾着的、按改过的多久；不能加没要的，一样不勾不行", async () => {
    const s = setup();
    const { cardIds } = await s.ask("secretary", { path: s.notes, modes: ["read", "write", "delete"], why: "整理" });
    const cardId = cardIds![0]!;
    // 加没要的（申请里没有……这里换成"读、写、删"之外的不可能，用一张只要读的卡试）
    const only = await s.ask("pm-1", { path: s.notes, modes: ["read"], why: "看看" });
    const extra = await outcome(() => s.act(only.cardIds![0]!, "approve", { input: { modes: ["read", "write"] } }));
    expect(extra).toMatchObject({ ok: false, message: expect.stringContaining("不能加它没要的") });
    expect(s.grants.list()).toEqual([]);
    expect(s.cards.get(only.cardIds![0]!)!.status).toBe("pending");
    expect((await outcome(() => s.act(cardId, "approve", { input: { modes: [] } }))).ok).toBe(false);
    // 去掉写和删、改成 1 天
    await s.act(cardId, "approve", { input: { modes: ["read"], days: 1 }, note: "先只看" });
    expect(s.grants.list()).toMatchObject([{ agentId: "secretary", modes: ["read"], expiresAt: folderGrantExpiryAfter(1, NOW) }]);
    const text = s.noticeText(s.notices(CHANNELS.secretary)[0]!);
    expect(text).toContain("你要的是读、写、删，用户只给了这些");
    expect(text).toContain("用户说：「先只看」");
    expect((s.cards.get(cardId)!.payload as FolderGrantRequestCardPayload).decided).toMatchObject({ approved: true, note: "先只看", granted: { modes: ["read"] } });
    // 申请的是几天，同意时改成长期有效（null）
    const d = await s.ask("pm-1", { path: s.inner, modes: ["write"], days: 5, why: "写" });
    await s.act(d.cardIds![0]!, "approve", { input: { days: null } });
    expect(s.grants.list().find((g) => g.agentId === "pm-1")!.expiresAt).toBeUndefined();
  });

  it("登记不成（目录没了）：卡留着、写出原因、不算同意，不通知", async () => {
    const s = setup();
    const gone = path.join(s.root, "gone");
    fs.mkdirSync(gone);
    const { cardIds } = await s.ask("secretary", { path: gone, modes: ["write"], why: "写" });
    fs.rmdirSync(gone);
    const result = await outcome(() => s.act(cardIds![0]!, "approve"));
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("没有这个文件夹") });
    expect(s.cards.get(cardIds![0]!)!.status).toBe("pending");
    expect(s.grants.list()).toEqual([]);
    expect(s.notices(CHANNELS.secretary)).toEqual([]);
  });

  it("不同意：不登记，附的那句话交回它（任务的负责人的通知带任务和项目）", async () => {
    const s = setup();
    const { cardIds } = await s.ask("tm-1", { path: s.notes, modes: ["delete"], why: "删旧笔记" });
    await s.act(cardIds![0]!, "deny", { note: "旧笔记别删" });
    expect(s.grants.list()).toEqual([]);
    const card = s.cards.get(cardIds![0]!)!;
    expect(card).toMatchObject({ status: "handled", outcome: { action: "deny", note: "旧笔记别删" } });
    expect((card.payload as FolderGrantRequestCardPayload).decided).toMatchObject({ approved: false, note: "旧笔记别删" });
    expect(card.text).toContain("没同意");
    const [notice] = s.notices(maintainerChannel("tm-1"));
    expect(notice).toMatchObject({ agentInput: true, taskId: "t-1", projectId: "p-1" });
    expect(s.noticeText(notice!)).toContain("用户没同意你申请的目录授权");
    expect(s.noticeText(notice!)).toContain("旧笔记别删");
  });
});

describe("谁有这个工具", () => {
  it("子 agent 没有：负责人专用的工具里有它，子 agent 的装配收窄时去掉", () => {
    expect(MAINTAINER_ONLY_TOOLS).toContain(REQUEST_FOLDER_GRANT_TOOL);
    const maintainer = { cwd: "C:\\w", toolkit: { bash: true, network: true }, skillPaths: [], piTools: ["read"], hostTools: [REQUEST_FOLDER_GRANT_TOOL, "web_search"], projectRecords: [], workingDirs: ["C:\\w"], development: false };
    expect(subAgentAssembly(maintainer, { agentId: "sa-1", cwd: "C:\\w", hostTools: [REQUEST_FOLDER_GRANT_TOOL, "web_search"] }).hostTools).toEqual(["web_search"]);
  });
});
