// Gmail 多账号（344 号票）在假内核里，IMAP 连本机的假服务（两个账号的 UIDVALIDITY、UID 故意撞号：谁没分账号，这里马上看得出），不连 Gmail：
// - 新装直接加两个：各自同步、互不串；页面上每个账号一项（完整邮箱、状态、问题），account 列出全部；
// - 老配置迁移成一条、再加一条，再启动不重复迁移；密钥文件写不了时（真的只读文件）照老样子接着用、老键还在、不留临时文件，日志里没密码；下次再转；
// - 断开一个：另一个照常，只删它的密钥；连已导入的一起删只删它的记录（老配置导入的、没写账号的也归它）；整个断开全删；
// - 一个账号登录不再通过：另一个照常，秘书照样有工具，结果里写明；都不行才算出错，每小时再试只试不行的；
// - 工具能按账号查，结果写明来自哪个账号（打了码的邮箱和编号）；邮件编号带账号，撞号也读得对；
// - 素材写明账号，证据里看得出、不同账号不合成一条；
// - 账号的开关；现查按账号一组；错误、日志、事件里没有密码，日志里邮箱打码。
import fs from "node:fs";
import path from "node:path";
import { isDeletedEventPayload } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_SOURCES_CHANNEL, DATA_SOURCE_DISCONNECTED } from "../../src/data-sources/events.ts";
import { GOOGLE_CHANNEL, GOOGLE_GMAIL_CURSOR, GOOGLE_GMAIL_SENT, type GoogleGmailSentPayload } from "../../src/google/events.ts";
import { maskId } from "../../src/google/feed-fetch.ts";
import { accountIdOf } from "../../src/google/gmail-accounts.ts";
import { GMAIL_READ_TOOL, GMAIL_SEARCH_TOOL, MAIL_TEXT_BEGIN } from "../../src/google/gmail-tools.ts";
import { createGooglePlugin } from "../../src/google/plugin.ts";
import { digestGroupKey, sceneParts } from "../../src/memory/data-source-evidence.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { SECRETARY_TARGET } from "../../src/secretary/secretary.ts";
import { type FakeImapServer, startFakeImapServer } from "../helpers/fake-imap.ts";
import { mail, ME, sentReplyMail } from "../helpers/fake-mail.ts";
import { fakePersonalFiles } from "../helpers/fake-personal-files.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { waitUntil } from "../helpers/process.ts";

const SOURCE = "google-gmail";
const OTHER = "work.mail@example.org";
const PASSWORD_ME = "abcdefghijklmnop";
const PASSWORD_OTHER = "qrstuvwxyzabcdef";
const ID_ME = accountIdOf(ME);
const ID_OTHER = accountIdOf(OTHER);

let keySeq = 0;
const key = () => `gm-multi-${++keySeq}`;
let server: FakeImapServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function startServer() {
  server = await startFakeImapServer({ user: ME, password: PASSWORD_ME, others: [{ user: OTHER, password: PASSWORD_OTHER }] });
  return server;
}
const startKernel = (imap: FakeImapServer, more: Partial<Parameters<typeof startPluginKernel>[0]> = {}) =>
  startPluginKernel({
    plugins: [createGooglePlugin({ imap: imap.endpoint, imapTimeoutMs: 5_000 })],
    at: new Date("2026-10-25T09:00:00+08:00"),
    services: [extraService(KERNEL.personalFiles, () => fakePersonalFiles().service)],
    ...more,
  });
/** 两个账号都连上（导入开着时马上同步） */
async function startTwo(options: { importOn?: boolean } = {}) {
  const imap = await startServer();
  const k = await startKernel(imap);
  if (options.importOn) await k.dataSources.act(SOURCE, { action: "usage", usage: "import", on: true, idempotencyKey: key() });
  await add(k, ME, PASSWORD_ME);
  await add(k, OTHER, PASSWORD_OTHER);
  return { k, imap, other: imap.mailbox(OTHER) };
}
const add = (k: PluginKernel, address: string, password: string) => k.dataSources.act(SOURCE, { action: "configure", values: { address, password }, idempotencyKey: key() });
const sourceOf = (k: PluginKernel) => k.dataSources.view().sources.find((s) => s.id === SOURCE)!;
const secretFile = (k: PluginKernel) => path.join(k.layout.dataSourceSecrets, `${SOURCE}.json`);
const secretValues = (k: PluginKernel) => (JSON.parse(fs.readFileSync(secretFile(k), "utf8")) as { values: Record<string, string> }).values;
const sentRecords = (k: PluginKernel) => k.store.read(GOOGLE_CHANNEL, 0, GOOGLE_GMAIL_SENT).filter((e) => !isDeletedEventPayload(e.payload)).map((e) => e.payload as GoogleGmailSentPayload);
const gmailMaterials = (k: PluginKernel) => k.materials.list().filter((m) => m.origin?.dataSource === SOURCE);
const gmailTools = (k: PluginKernel) => k.agent.toolsFor(SECRETARY_TARGET).map((t) => t.spec.name).filter((n) => /gmail/i.test(n));
async function call(k: PluginKernel, name: string, args: Record<string, unknown>) {
  const tool = k.agent.toolsFor(SECRETARY_TARGET).find((t) => t.spec.name === name)!;
  return await tool.run(args as never, { toolCallId: key() });
}
/** 事件、日志、页面里有没有这几个密码；日志里有没有完整邮箱 */
function leaked(k: PluginKernel, secrets: readonly string[] = [PASSWORD_ME, PASSWORD_OTHER]): string[] {
  const where: string[] = [];
  for (const secret of secrets) {
    if (k.store.readGlobal(0, 1_000_000).some((e) => JSON.stringify(e.payload).includes(secret))) where.push(`事件有 ${secret}`);
    if (k.logs.some((l) => l.includes(secret))) where.push(`日志有 ${secret}`);
    if (JSON.stringify(k.dataSources.view()).includes(secret)) where.push(`页面有 ${secret}`);
  }
  for (const address of [ME, OTHER]) if (k.logs.some((l) => l.includes(address))) where.push(`日志有完整邮箱 ${address}`);
  return where;
}
/** 老配置（298 号票的样子）放进密钥区 */
const oldConfig = (address: string, password: string) => (layout: { dataSourceSecrets: string }) => {
  fs.mkdirSync(layout.dataSourceSecrets, { recursive: true });
  fs.writeFileSync(path.join(layout.dataSourceSecrets, `${SOURCE}.json`), JSON.stringify({ format: 1, values: { address, password } }));
};

describe("新装直接加两个账号", () => {
  it("页面上每个账号一项（完整邮箱、状态、已导入几封）、account 列出全部；密钥各占一格；密码、完整邮箱不出现在事件和日志里", async () => {
    const { k } = await startTwo();
    const source = sourceOf(k);
    expect(source).toMatchObject({ connection: "connected", account: `${ME}、${OTHER}`, disconnectNote: "这里断开的是全部 2 个账号。只想断开一个，点那个账号旁边的「断开」。" });
    expect(source.items).toEqual([
      { id: ID_ME, title: ME, detail: "连着 · 已导入 0 封", count: 0, removable: true },
      { id: ID_OTHER, title: OTHER, detail: "连着 · 已导入 0 封", count: 0, removable: true },
    ]);
    expect(secretValues(k)).toEqual({
      accounts: `${ID_ME},${ID_OTHER}`,
      [`account.${ID_ME}.address`]: ME,
      [`account.${ID_ME}.password`]: PASSWORD_ME,
      [`account.${ID_ME}.enabled`]: "on",
      [`account.${ID_OTHER}.address`]: OTHER,
      [`account.${ID_OTHER}.password`]: PASSWORD_OTHER,
      [`account.${ID_OTHER}.enabled`]: "on",
    });
    expect(leaked(k)).toEqual([]);
    expect(k.logs.some((l) => l.includes(`连上了 Gmail（${maskId(OTHER)}）`))).toBe(true);
  });

  it("第二个的密码不对：什么都不存、第一个照常，原因写明（没有密码）；页面上仍然连着", async () => {
    const imap = await startServer();
    const k = await startKernel(imap);
    await add(k, ME, PASSWORD_ME);
    const before = secretValues(k);
    const result = await add(k, OTHER, "wrongpasswordxyz");
    const source = result.view.sources.find((s) => s.id === SOURCE)!;
    expect(source.connection).toBe("connected");
    expect(source.problem).toContain("登录 Gmail 没通过");
    expect(source.items!.map((i) => i.title)).toEqual([ME]);
    expect(secretValues(k)).toEqual(before);
    expect(JSON.stringify(result.view)).not.toContain("wrongpasswordxyz");
    expect(k.logs.join("\n")).not.toContain("wrongpasswordxyz");
    expect(k.logs.some((l) => l.includes(`Gmail 登录没通过（${maskId(OTHER)}）`))).toBe(true);
    // 没存的账号不算问题：第一个账号下面没写，再加对了就好了
    expect(source.items![0]!.problem).toBeUndefined();
    const fixed = await add(k, OTHER, PASSWORD_OTHER);
    expect(fixed.view.sources.find((s) => s.id === SOURCE)!.problem).toBeUndefined();
  });

  it("各自同步、互不串：撞号的 UID 各导各的，进度各记各的；再同步只拿新的；一个账号的素材写明账号", async () => {
    const { k, imap, other } = await startTwo({ importOn: true });
    // 两个账号的已发邮件 UID 一样（都从 40 起）；Message-ID 也一样也不串
    imap.add(sentReplyMail({ messageId: "<same@mail.example.com>", text: "我这边的第一封。", subject: "私人" }), ["sent", "all"]);
    other.add(sentReplyMail({ messageId: "<same@mail.example.com>", text: "工作账号的第一封。", subject: "工作" }), ["sent", "all"]);
    const first = await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    expect(first).toMatchObject({ added: 2 });
    expect(sentRecords(k).map((r) => [r.subject, r.account, r.accountLabel, r.uid])).toEqual([
      ["私人", ID_ME, maskId(ME), 40],
      ["工作", ID_OTHER, maskId(OTHER), 40],
    ]);
    expect(new Set(sentRecords(k).map((r) => r.id)).size).toBe(2);
    expect(sourceOf(k).items!.map((i) => i.count)).toEqual([1, 1]);
    expect(sourceOf(k).count).toBe(2);

    // 只有第二个账号有新的：只拿那一封，第一个的进度不动
    expect(await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() })).toMatchObject({ added: 0 });
    other.add(sentReplyMail({ messageId: "<work-2@mail.example.com>", date: "Sun, 25 Oct 2026 08:30:00 +0800", text: "工作账号的第二封。", subject: "工作二" }), ["sent", "all"]);
    expect(await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() })).toMatchObject({ added: 1 });
    expect(sentRecords(k).map((r) => [r.subject, r.account])).toEqual([
      ["私人", ID_ME],
      ["工作", ID_OTHER],
      ["工作二", ID_OTHER],
    ]);

    // 素材：origin 写明账号（id 和打了码的邮箱，没有完整邮箱）；证据那一行看得出，不同账号不合成一条
    await waitUntil(() => gmailMaterials(k).length === 3, { timeoutMs: 10_000, describe: () => `素材 ${gmailMaterials(k).length}` });
    const materials = gmailMaterials(k);
    expect(materials.map((m) => m.origin?.account).toSorted((a, b) => (a!.id + a!.label).localeCompare(b!.id + b!.label))).toEqual(
      [{ id: ID_ME, label: maskId(ME) }, { id: ID_OTHER, label: maskId(OTHER) }, { id: ID_OTHER, label: maskId(OTHER) }].toSorted((a, b) => (a.id + a.label).localeCompare(b.id + b.label)),
    );
    expect(JSON.stringify(materials.map((m) => m.origin))).not.toContain(ME);
    const mine = materials.find((m) => m.origin?.account?.id === ID_ME)!;
    const work = materials.find((m) => m.origin?.account?.id === ID_OTHER)!;
    expect(sceneParts(mine, false)).toContain(`账号 ${maskId(ME)}`);
    expect(digestGroupKey(mine)).not.toBe(digestGroupKey({ ...mine, origin: work.origin! }));
    expect(imap.writes).toEqual([]);
    expect(leaked(k)).toEqual([]);
  });

  it("一个账号同步出错不挡另一个：导到的照样写，这次算出错，原因写是谁的（打码的）；已有的素材不动", async () => {
    const { k, imap, other } = await startTwo({ importOn: true });
    other.add(sentReplyMail({ messageId: "<w@mail.example.com>", text: "工作账号的。", subject: "工作" }), ["sent", "all"]);
    imap.setPassword(ME, "revokedpassword1");
    const synced = await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    expect(synced.error).toContain(`${maskId(ME)}：登录 Gmail 没通过`);
    expect(sentRecords(k).map((r) => r.subject)).toEqual(["工作"]);
    expect(JSON.stringify(synced)).not.toContain(PASSWORD_ME);
    expect(leaked(k)).toEqual([]);
  });
});

describe("老配置", () => {
  it("启动时转成一条：页面、工具都能用，老键没了、备份在密钥区；再加一条，再启动不重复迁移；老记录归转过来的那条", async () => {
    const imap = await startServer();
    const k = await startKernel(imap, { seed: oldConfig(ME, PASSWORD_ME) });
    expect(secretValues(k)).toMatchObject({ accounts: ID_ME, "legacy.account": ID_ME, "backup.pre-344.password": PASSWORD_ME });
    expect(secretValues(k).address).toBeUndefined();
    expect(secretValues(k).password).toBeUndefined();
    expect(sourceOf(k)).toMatchObject({ connection: "connected", account: ME });
    expect(k.logs.some((l) => l.includes("老的 Gmail 配置转成了一条账号（备份留在密钥区）"))).toBe(true);
    // 备份不在备份区
    expect(fs.existsSync(path.join(k.dir, "backup"))).toBe(false);
    // 转之前导入的（老样子的事件，没写账号）
    k.store.append({ channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_SENT, payload: { id: "600003-41", uidValidity: imap.uidValidity("sent"), uid: 41, messageId: "<old@mail.example.com>", at: "2026-10-20T10:00:00.000+08:00", subject: "老的", to: [], text: "老的\n\n转之前导入的。", sensitive: [] } satisfies GoogleGmailSentPayload });
    expect(sourceOf(k).items).toEqual([expect.objectContaining({ title: ME, count: 1 })]);
    await add(k, OTHER, PASSWORD_OTHER);
    expect(sourceOf(k).items!.map((i) => [i.title, i.count])).toEqual([
      [ME, 1],
      [OTHER, 0],
    ]);
    // 老记录的进度接着：UID 41 之后的才导，第二个账号从头
    const dir = k.dir;
    const before = secretValues(k);
    await k.close();
    const again = await startKernel(imap, { dataDir: dir });
    expect(secretValues(again)).toEqual(before);
    expect(again.logs.some((l) => l.includes("转成了一条账号"))).toBe(false);
    await again.dataSources.act(SOURCE, { action: "usage", usage: "import", on: true, idempotencyKey: key() });
    imap.add(sentReplyMail({ messageId: "<before@mail.example.com>", text: "UID 40，老进度之前的。", subject: "早的" }), ["sent", "all"]);
    imap.add(sentReplyMail({ messageId: "<old@mail.example.com>", text: "UID 41，导过了。", subject: "老的" }), ["sent", "all"]);
    imap.add(sentReplyMail({ messageId: "<new@mail.example.com>", text: "UID 42，新的。", subject: "新的" }), ["sent", "all"]);
    imap.mailbox(OTHER).add(sentReplyMail({ messageId: "<w@mail.example.com>", text: "第二个账号的，UID 40。", subject: "工作" }), ["sent", "all"]);
    expect(await again.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() })).toMatchObject({ added: 2 });
    expect(sentRecords(again).map((r) => [r.subject, r.account])).toEqual([
      ["老的", undefined],
      ["新的", ID_ME],
      ["工作", ID_OTHER],
    ]);
    expect(leaked(again)).toEqual([]);
  });

  it("中途失败（密钥文件写不了）：老键还在、不留临时文件、日志里没密码，照老样子接着用；写得了以后下次启动转好", { timeout: 60_000 }, async () => {
    const imap = await startServer();
    let file = "";
    const k = await startKernel(imap, {
      seed: (layout) => {
        oldConfig(ME, PASSWORD_ME)(layout);
        file = path.join(layout.dataSourceSecrets, `${SOURCE}.json`);
        fs.chmodSync(file, 0o444);
      },
    });
    // 转不成：老键原样
    expect(secretValues(k)).toEqual({ address: ME, password: PASSWORD_ME });
    expect(fs.readdirSync(k.layout.dataSourceSecrets)).toEqual([`${SOURCE}.json`]);
    expect(k.logs.some((l) => l.includes("数据源 google-gmail 的密钥区没转成（照老样子接着用，下次启动再试）"))).toBe(true);
    expect(leaked(k)).toEqual([]);
    // 照样连着，秘书照样查得到
    expect(sourceOf(k)).toMatchObject({ connection: "connected", account: ME });
    imap.add(sentReplyMail({ text: "一封。", subject: "查得到" }), ["sent", "all"]);
    expect((await call(k, GMAIL_SEARCH_TOOL, { keyword: "查得到" })).text).toContain("一共 1 封");
    const dir = k.dir;
    await k.close();
    fs.chmodSync(file, 0o644);
    const again = await startKernel(imap, { dataDir: dir });
    expect(secretValues(again)).toMatchObject({ accounts: ID_ME, "backup.pre-344.password": PASSWORD_ME });
    expect(secretValues(again).password).toBeUndefined();
  });

  it("老版本导入过、后来断开过（留着已导入的）：谁也不归；重新连上不重复导（按 Message-ID 认）", async () => {
    const imap = await startServer();
    const k = await startKernel(imap);
    // 老样子的记录，密钥区里什么都没有（老版本断开时留着已导入的）
    k.store.append({ channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_SENT, payload: { id: "600003-40", uidValidity: imap.uidValidity("sent"), uid: 40, messageId: "<kept@mail.example.com>", at: "2026-10-20T10:00:00.000+08:00", subject: "留着的", to: [], text: "留着的\n\n以前导入的。", sensitive: [] } satisfies GoogleGmailSentPayload });
    imap.add(sentReplyMail({ messageId: "<kept@mail.example.com>", text: "以前导入的。", subject: "留着的" }), ["sent", "all"]);
    imap.add(sentReplyMail({ messageId: "<fresh@mail.example.com>", text: "新发的。", subject: "新的" }), ["sent", "all"]);
    await k.dataSources.act(SOURCE, { action: "usage", usage: "import", on: true, idempotencyKey: key() });
    const connected = await add(k, ME, PASSWORD_ME);
    expect(connected).toMatchObject({ added: 1 });
    expect(sentRecords(k).map((r) => r.subject)).toEqual(["留着的", "新的"]);
    // 谁也不归：账号下面只数它自己的，"共几条"两条都算
    const source = sourceOf(k);
    expect(source.items![0]!.count).toBe(1);
    expect(source.count).toBe(2);
  });

  it("插件停用时照样转（只动密钥区）：页面上还是写插件没启用", async () => {
    const imap = await startServer();
    const k = await startKernel(imap, { seed: oldConfig(ME, PASSWORD_ME), disabled: ["google"] });
    expect(secretValues(k)).toMatchObject({ accounts: ID_ME });
    expect(sourceOf(k)).toMatchObject({ available: false, connection: "connected" });
  });
});

describe("断开一个", () => {
  it("另一个照常：只删它的密钥；秘书还有工具、查得到；上次同步还在；留着已导入的", async () => {
    const { k, imap, other } = await startTwo({ importOn: true });
    imap.add(sentReplyMail({ text: "我这边的。", subject: "私人" }), ["sent", "all"]);
    other.add(sentReplyMail({ text: "工作账号的。", subject: "工作" }), ["sent", "all"]);
    await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    const lastSync = sourceOf(k).lastSync;
    expect(lastSync).toBeDefined();
    const result = await k.dataSources.act(SOURCE, { action: "disconnect", purge: false, item: ID_OTHER, idempotencyKey: key() });
    expect(result.purged).toBeUndefined();
    const source = result.view.sources.find((s) => s.id === SOURCE)!;
    expect(source).toMatchObject({ connection: "connected", account: ME, lastSync });
    expect(source.items!.map((i) => i.title)).toEqual([ME]);
    expect(secretValues(k)).toEqual({ accounts: ID_ME, [`account.${ID_ME}.address`]: ME, [`account.${ID_ME}.password`]: PASSWORD_ME, [`account.${ID_ME}.enabled`]: "on" });
    expect(gmailTools(k)).toEqual([GMAIL_SEARCH_TOOL, GMAIL_READ_TOOL]);
    expect((await call(k, GMAIL_SEARCH_TOOL, { in: "sent" })).text).toContain("一共 1 封");
    // 留着已导入的：记录还在，再连上接着（同一个地址是同一条）
    expect(sentRecords(k)).toHaveLength(2);
    await add(k, OTHER, PASSWORD_OTHER);
    expect(sourceOf(k).items!.map((i) => [i.title, i.count])).toEqual([
      [ME, 1],
      [OTHER, 1],
    ]);
    expect(await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() })).toMatchObject({ added: 0 });
    expect(k.logs.some((l) => l.includes(`断开了 Gmail 账号（${maskId(OTHER)}）`))).toBe(true);
    expect(leaked(k)).toEqual([]);
  });

  it("连已导入的一起删：只删它的记录和进度，另一个的不动；同一个幂等键重发只算一次；再断开最后一个，文件没了、整页是没连", async () => {
    const { k, imap, other } = await startTwo({ importOn: true });
    imap.add(sentReplyMail({ text: "我这边的。", subject: "私人" }), ["sent", "all"]);
    other.add(sentReplyMail({ text: "工作账号的。", subject: "工作" }), ["sent", "all"]);
    await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    // 让它有一条进度记号：最后一封没正文（只有引用的转发）
    other.add(mail([["From", OTHER], ["To", "x@example.com"], ["Subject", "Fwd: x"], ["Date", "Sun, 25 Oct 2026 08:00:00 +0800"], ["Message-ID", "<fwd@mail.example.com>"]], "---------- Forwarded message ---------\nFrom: x\n原文"), ["sent", "all"]);
    await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    expect(k.store.read(GOOGLE_CHANNEL, 0, GOOGLE_GMAIL_CURSOR).filter((e) => !isDeletedEventPayload(e.payload))).toHaveLength(1);

    const idempotencyKey = key();
    const purged = await k.dataSources.act(SOURCE, { action: "disconnect", purge: true, item: ID_OTHER, idempotencyKey });
    // 一封 + 一条进度记号；同步记录不分账号，不动
    expect(purged.purged).toMatchObject({ events: 2, files: 0 });
    expect(sentRecords(k).map((r) => r.subject)).toEqual(["私人"]);
    expect(k.store.read(GOOGLE_CHANNEL, 0, GOOGLE_GMAIL_CURSOR).filter((e) => !isDeletedEventPayload(e.payload))).toEqual([]);
    expect(k.store.readGlobal(0, 1_000_000).some((e) => JSON.stringify(e.payload).includes("工作账号的"))).toBe(false);
    expect(k.store.readGlobal(0, 1_000_000).some((e) => JSON.stringify(e.payload).includes("我这边的"))).toBe(true);
    expect(sourceOf(k).lastSync).toBeDefined();
    const recorded = () => k.store.read(DATA_SOURCES_CHANNEL, 0, DATA_SOURCE_DISCONNECTED).length;
    expect(recorded()).toBe(1);
    expect((await k.dataSources.act(SOURCE, { action: "disconnect", purge: true, item: ID_OTHER, idempotencyKey })).purged).toMatchObject({ events: 2 });
    expect(recorded()).toBe(1);
    // 另一个照常接着导
    imap.add(sentReplyMail({ messageId: "<m2@mail.example.com>", text: "第二封。", subject: "私人二" }), ["sent", "all"]);
    expect(await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() })).toMatchObject({ added: 1 });

    const last = await k.dataSources.act(SOURCE, { action: "disconnect", purge: true, item: ID_ME, idempotencyKey: key() });
    expect(last.view.sources.find((s) => s.id === SOURCE)).toMatchObject({ connection: "not_connected", count: 0 });
    expect(fs.existsSync(secretFile(k))).toBe(false);
    expect(sentRecords(k)).toEqual([]);
    expect(gmailTools(k)).toEqual([]);
  });

  it("断开转过来的那条：备份、老记录的归属一起没了，密码哪儿都不剩；连已导入的一起删时老样子的记录也删", async () => {
    const imap = await startServer();
    const k = await startKernel(imap, { seed: oldConfig(ME, PASSWORD_ME) });
    await add(k, OTHER, PASSWORD_OTHER);
    k.store.append({ channel: GOOGLE_CHANNEL, type: GOOGLE_GMAIL_SENT, payload: { id: "600003-41", uidValidity: 600003, uid: 41, at: "2026-10-20T10:00:00.000+08:00", subject: "老的", to: [], text: "老的\n\n转之前导入的。", sensitive: [] } satisfies GoogleGmailSentPayload });
    const purged = await k.dataSources.act(SOURCE, { action: "disconnect", purge: true, item: ID_ME, idempotencyKey: key() });
    expect(purged.purged).toMatchObject({ events: 1 });
    expect(sentRecords(k)).toEqual([]);
    expect(fs.readFileSync(secretFile(k), "utf8")).not.toContain(PASSWORD_ME);
    expect(fs.readFileSync(secretFile(k), "utf8")).not.toContain("backup");
    expect(secretValues(k)).toMatchObject({ accounts: ID_OTHER });
  });

  it("没有这个账号：回 not_found，什么都不动；不认单独断开的数据源回不允许；整个断开全删（连备份）", async () => {
    const imap = await startServer();
    const k = await startKernel(imap, { seed: oldConfig(ME, PASSWORD_ME) });
    await add(k, OTHER, PASSWORD_OTHER);
    await expect(k.dataSources.act(SOURCE, { action: "disconnect", purge: false, item: "a0000000000", idempotencyKey: key() })).rejects.toThrow("这个账号已经断开了");
    await expect(k.dataSources.act("google-calendar", { action: "disconnect", purge: false, item: "x", idempotencyKey: key() })).rejects.toThrow("不能单独断开");
    expect(sourceOf(k).items).toHaveLength(2);
    const all = await k.dataSources.act(SOURCE, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(all.view.sources.find((s) => s.id === SOURCE)).toMatchObject({ connection: "not_connected" });
    expect(fs.existsSync(secretFile(k))).toBe(false);
  });
});

describe("一个账号登录不再通过", () => {
  it("另一个照常：还算连着、要重新填（卡片要授权）、秘书有工具，结果里写明哪个没查成；重新填好恢复", async () => {
    const { k, imap, other } = await startTwo();
    imap.add(sentReplyMail({ text: "私人的。", subject: "共同的词" }), ["sent", "all"]);
    other.add(sentReplyMail({ text: "工作的。", subject: "共同的词" }), ["sent", "all"]);
    imap.setPassword(ME, "revokedpassword1");
    const result = await call(k, GMAIL_SEARCH_TOOL, { subject: "共同的词" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain(`账号 ${maskId(ME)}（账号编号 ${ID_ME}）：这次没查成（登录 Gmail 没通过`);
    expect(result.text).toContain("请用户去设置 · 数据源重新填应用专用密码");
    expect(result.text).toContain(`账号 ${maskId(OTHER)}（账号编号 ${ID_OTHER}）（全部邮件）：一共 1 封`);
    const source = sourceOf(k);
    expect(source).toMatchObject({ connection: "connected", needsAuth: true });
    expect(source.problem).toBeUndefined();
    expect(source.items![0]).toMatchObject({ title: ME, detail: "要重新填密码 · 已导入 0 封", problem: expect.stringContaining("登录 Gmail 没通过") });
    expect(source.items![1]!.problem).toBeUndefined();
    expect(gmailTools(k)).toEqual([GMAIL_SEARCH_TOOL, GMAIL_READ_TOOL]);
    // 重新填
    imap.setPassword(ME, "newpasswordabcde");
    await add(k, ME, "newpasswordabcde");
    expect(sourceOf(k).needsAuth).toBeUndefined();
    expect(sourceOf(k).items![0]!.problem).toBeUndefined();
    expect(secretValues(k)[`account.${ID_ME}.password`]).toBe("newpasswordabcde");
    expect(sourceOf(k).items).toHaveLength(2);
    expect(leaked(k, [PASSWORD_ME, PASSWORD_OTHER, "newpasswordabcde", "revokedpassword1"])).toEqual([]);
  });

  it("都不行才算出错：工具不给、每小时再试只试不行的；好了一个就回到连着", async () => {
    const { k, imap } = await startTwo();
    imap.setPassword(ME, "revoked1revoked1");
    imap.setPassword(OTHER, "revoked2revoked2");
    const both = await call(k, GMAIL_SEARCH_TOOL, { keyword: "x" });
    expect(both.isError).toBe(true);
    expect(both.text).toContain(`${maskId(ME)}：登录 Gmail 没通过`);
    expect(both.text).toContain(`${maskId(OTHER)}：登录 Gmail 没通过`);
    expect(both.text).not.toContain(ME);
    expect(sourceOf(k)).toMatchObject({ connection: "error", problem: "2 个账号都登录不上：每个账号下面写着原因，重新填应用专用密码", needsAuth: true, autoRetry: true });
    expect(gmailTools(k)).toEqual([]);
    const logins = imap.logins.length;
    // 第二个好了：一小时到点再试，两个都试（都不行），第二个回来，算连着
    imap.setPassword(OTHER, PASSWORD_OTHER);
    k.clock.advanceTo(k.clock.now() + 60 * 60_000);
    await k.dataSources.whenIdle();
    expect(imap.logins.slice(logins).toSorted()).toEqual([OTHER, ME].toSorted());
    expect(sourceOf(k)).toMatchObject({ connection: "connected", needsAuth: true, autoRetry: true });
    expect(gmailTools(k)).toEqual([GMAIL_SEARCH_TOOL, GMAIL_READ_TOOL]);
    // 又一小时：只试还不行的那个；它也好了，都回来，不再试
    imap.setPassword(ME, PASSWORD_ME);
    const later = imap.logins.length;
    k.clock.advanceTo(k.clock.now() + 60 * 60_000);
    await k.dataSources.whenIdle();
    expect(imap.logins.slice(later)).toEqual([ME]);
    expect(sourceOf(k).needsAuth).toBeUndefined();
    expect(sourceOf(k).autoRetry).toBeUndefined();
    expect(sourceOf(k).items!.every((i) => i.problem === undefined)).toBe(true);
    const settled = imap.logins.length;
    k.clock.advanceTo(k.clock.now() + 60 * 60_000);
    await k.dataSources.whenIdle();
    expect(imap.logins.length).toBe(settled);
  });
});

describe("工具按账号查", () => {
  it("不指定查全部，一个账号一段（打码的邮箱和编号，没有完整邮箱）；指定了只查那一个（地址、部分地址、编号、打码的都认）；认不出、对不上写明有哪几个", async () => {
    const { k, imap, other } = await startTwo();
    const a = imap.add(sentReplyMail({ text: "私人的。", subject: "共同的词 私人", to: "friend@example.net" }), ["INBOX", "all"]);
    const b = other.add(sentReplyMail({ text: "工作的。", subject: "共同的词 工作", to: "boss@example.net" }), ["INBOX", "all"]);
    // 两封的 UID 撞号
    expect(a.all).toBe(b.all);
    const idA = `${ID_ME}.all-${imap.uidValidity("all")}-${a.all}`;
    const idB = `${ID_OTHER}.all-${other.uidValidity("all")}-${b.all}`;

    const all = await call(k, GMAIL_SEARCH_TOOL, { subject: "共同的词" });
    expect(all.text).toContain("在 Gmail 的 2 个账号里按 主题含「共同的词」搜到的邮件，一个账号一段");
    expect(all.text).toContain(`账号 ${maskId(ME)}（账号编号 ${ID_ME}）（全部邮件）：一共 1 封（新的在前）\n${MAIL_TEXT_BEGIN}\n- ${idA} ·`);
    expect(all.text).toContain(`账号 ${maskId(OTHER)}（账号编号 ${ID_OTHER}）（全部邮件）：一共 1 封（新的在前）\n${MAIL_TEXT_BEGIN}\n- ${idB} ·`);
    expect(all.text).not.toContain(OTHER);

    for (const selector of [OTHER, OTHER.toUpperCase(), "example.org", ID_OTHER, maskId(OTHER)]) {
      const only = await call(k, GMAIL_SEARCH_TOOL, { subject: "共同的词", account: selector });
      expect(only.text).toContain(`一共 1 封（新的在前），来自账号 ${maskId(OTHER)}（账号编号 ${ID_OTHER}）`);
      expect(only.text).toContain(idB);
      expect(only.text).not.toContain(idA);
    }
    const none = await call(k, GMAIL_SEARCH_TOOL, { account: "nobody@example.com" });
    expect(none).toMatchObject({ isError: true });
    expect(none.text).toContain(`没有这个账号，连着的账号有：${maskId(ME)}（${ID_ME}）、${maskId(OTHER)}（${ID_OTHER}）`);
    expect((await call(k, GMAIL_SEARCH_TOOL, { account: "example" })).text).toContain("对得上好几个账号");

    // 读：编号带账号，撞号也读得对；结果写明来自哪个账号
    const readB = await call(k, GMAIL_READ_TOOL, { id: idB });
    expect(readB.text).toContain(`来自账号 ${maskId(OTHER)}（账号编号 ${ID_OTHER}）`);
    expect(readB.text).toContain("工作的。");
    expect(readB.text).not.toContain("私人的。");
    expect((await call(k, GMAIL_READ_TOOL, { id: idA })).text).toContain("私人的。");
    // 老样子的编号：几个账号时认不出是谁的，写明；说了账号就读得到
    const stale = `all-${imap.uidValidity("all")}-${a.all}`;
    expect((await call(k, GMAIL_READ_TOOL, { id: stale })).text).toContain("这个邮件编号没写是哪个账号的");
    expect((await call(k, GMAIL_READ_TOOL, { id: stale, account: OTHER })).text).toContain("工作的。");
    // 断开了的账号的编号：写明
    await k.dataSources.act(SOURCE, { action: "disconnect", purge: false, item: ID_OTHER, idempotencyKey: key() });
    expect((await call(k, GMAIL_READ_TOOL, { id: idB })).text).toContain("这个账号已经断开了");
    expect(imap.writes).toEqual([]);
  });

  it("都没搜到：写明查了几个账号、各自没搜到", async () => {
    const { k } = await startTwo();
    const result = await call(k, GMAIL_SEARCH_TOOL, { keyword: "没有这封" });
    expect(result.text).toContain("在 Gmail 的 2 个账号里按 关键词「没有这封」没搜到邮件");
    expect(result.text).toContain(`账号 ${maskId(OTHER)}（账号编号 ${ID_OTHER}）（全部邮件）：没搜到。`);
  });

  it("用户的另一个账号发来的也算用户自己发的", async () => {
    const { k, imap } = await startTwo();
    const fromWork = imap.add(mail([["From", OTHER], ["To", ME], ["Subject", "from work"], ["Date", "Sat, 24 Oct 2026 10:00:00 +0800"], ["Message-ID", "<x@mail.example.com>"]], "内容"), ["INBOX", "all"]);
    expect((await call(k, GMAIL_READ_TOOL, { id: `${ID_ME}.all-${imap.uidValidity("all")}-${fromWork.all}` })).text).toContain("这封是用户自己发出的");
  });
});

describe("账号的开关", () => {
  it("关了不查、不导入、页面写关着，另一个照常；指定它写明关着；开回来接着；都关了算没连，秘书没工具", async () => {
    const { k, imap, other } = await startTwo({ importOn: true });
    imap.add(sentReplyMail({ text: "私人的。", subject: "共同的词" }), ["sent", "all"]);
    other.add(sentReplyMail({ text: "工作的。", subject: "共同的词" }), ["sent", "all"]);
    const off = await k.dataSources.act(SOURCE, { action: "configure", values: { account: ID_ME, enabled: "off" }, idempotencyKey: key() });
    expect(off.view.sources.find((s) => s.id === SOURCE)!.items![0]).toMatchObject({ title: ME, off: true, detail: "关着 · 已导入 0 封" });
    expect(secretValues(k)[`account.${ID_ME}.enabled`]).toBe("off");
    // 只导了开着的那个
    expect(sentRecords(k).map((r) => r.account)).toEqual([ID_OTHER]);
    expect((await call(k, GMAIL_SEARCH_TOOL, { subject: "共同的词" })).text).toContain(`来自账号 ${maskId(OTHER)}`);
    expect((await call(k, GMAIL_SEARCH_TOOL, { account: ME })).text).toContain(`账号 ${maskId(ME)} 关着`);

    await k.dataSources.act(SOURCE, { action: "configure", values: { account: ID_OTHER, enabled: "off" }, idempotencyKey: key() });
    expect(sourceOf(k)).toMatchObject({ connection: "not_connected", account: `${ME}、${OTHER}`, note: "账号都关着：现在不查、不导入，打开一个就接着用" });
    expect(gmailTools(k)).toEqual([]);
    expect(await k.dataSources.act(SOURCE, { action: "configure", values: { account: ID_ME, enabled: "on" }, idempotencyKey: key() })).toMatchObject({ added: 1 });
    expect(sentRecords(k).map((r) => r.account)).toEqual([ID_OTHER, ID_ME]);
    expect(gmailTools(k)).toEqual([GMAIL_SEARCH_TOOL, GMAIL_READ_TOOL]);
  });
});

describe("现在能查到的按账号", () => {
  it("一个账号一组（名字是完整邮箱），条目对上组；一个账号查不到写在它那一组（没有密码），别的照常；点开认得出是谁的；什么都不写", async () => {
    const { k, imap, other } = await startTwo();
    imap.add(sentReplyMail({ text: "私人的。", subject: "私人" }), ["INBOX", "all"]);
    const b = other.add(sentReplyMail({ text: "工作的。", subject: "工作" }), ["INBOX", "all"]);
    const events = k.store.lastGlobalSeq();
    const list = await k.dataSources.live(SOURCE, {});
    expect(list).toMatchObject({ state: "ok", scope: "每个账号全部邮件里最新的 30 封" });
    expect(list.groups).toEqual([
      { id: ID_ME, title: ME, total: 1 },
      { id: ID_OTHER, title: OTHER, total: 1 },
    ]);
    expect(list.items.map((i) => [i.title, i.group])).toEqual([
      ["私人", ID_ME],
      ["工作", ID_OTHER],
    ]);
    const opened = await k.dataSources.live(SOURCE, { open: `${ID_OTHER}.all-${other.uidValidity("all")}-${b.all}` });
    expect(opened.items[0]!.body).toContain("工作的。");

    imap.setPassword(ME, "revokedpassword1");
    const partly = await k.dataSources.live(SOURCE, {});
    expect(partly.state).toBe("ok");
    expect(partly.groups![0]).toEqual({ id: ID_ME, title: ME, problem: expect.stringContaining("登录 Gmail 没通过") });
    expect(partly.groups![1]).toEqual({ id: ID_OTHER, title: OTHER, total: 1 });
    expect(partly.items.map((i) => i.title)).toEqual(["工作"]);
    expect(JSON.stringify(partly)).not.toContain(PASSWORD_ME);
    expect(k.store.lastGlobalSeq()).toBe(events);
    expect(imap.writes).toEqual([]);
  });

  it("已获取的写明是哪个账号的（还连着的写完整邮箱，只给页面）", async () => {
    const { k, imap } = await startTwo({ importOn: true });
    imap.add(sentReplyMail({ text: "私人的。", subject: "私人" }), ["sent", "all"]);
    await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    await waitUntil(() => gmailMaterials(k).length === 1, { timeoutMs: 10_000, describe: () => `素材 ${gmailMaterials(k).length}` });
    expect(k.dataSources.stored(SOURCE, {}).items[0]!.subtitle).toContain(ME);
    await k.dataSources.act(SOURCE, { action: "disconnect", purge: false, item: ID_ME, idempotencyKey: key() });
    expect(k.dataSources.stored(SOURCE, {}).items[0]!.subtitle).toContain(maskId(ME));
  });
});
