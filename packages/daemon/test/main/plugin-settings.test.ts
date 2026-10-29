// 主切面：设置 · 插件（211 号票，用户 2026-10-20："设置界面里面要能查看当前加载了哪些插件，还有可以把它暂时禁用或者是移除。相当于是可以热插拔"）。
// 走真实的装配路径：经组合根和插件清单起守护进程（提醒、记忆两个真插件），经 HTTP 接口（GET /api/plugins、POST /api/plugins/<插件名>）操作，
// 不手挂插件。
// - 列插件：清单里的两个，一句话、它带来了什么（给秘书的工具个数和秘书实际拿到的一样）、连数据删写明的；
// - 停用（热）：马上生效、插件频道推新状况、写进配置 plugins.disabled；秘书下一轮没有它的工具；正在跑的一轮里再调它的工具回"X插件没启用"；
// - 启用（热）：马上回来、从配置里拿掉；以前建的提醒照常到点；
// - 移除（不删数据）：记成移除了、写进 plugins.removed，重启后保持；装回就是启用，以前的数据都在；
// - 移除并连数据删：提醒——全部提醒事件、提醒卡、待我处理里的提醒通知；记忆（选 A）——"记住"的内容、长期没处理的卡的记录、
//   记忆删除卡，素材库不动、删除类的记忆命令不碰；都留一条删除记录（只写插件名和条数），同一个键重发不再删。
import fs from "node:fs";
import {
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  type MemoryCommandEventPayload,
  type MemoryDeleteCardPayload,
  type MessageEventPayload,
  nowIso,
  type PluginDataPurgedEventPayload,
  type PluginStatusEventPayload,
  PURGED_TEXT,
  type ResponseFrame,
  Type,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { listInboxItems } from "../../src/inbox/views.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { reminderService, startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { pluginsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, plugins: PLUGINS } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0, [PLUGINS]: 0 };

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 7, 21, 0);

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

let keys = 0;
/** 对一个插件做一件事（每次一个新的幂等键，给了 key 就用它） */
const act = (url: string, name: string, action: "disable" | "enable" | "remove", extra: { purgeData?: boolean; key?: string } = {}) =>
  pluginsApi.act(url, name, { action, ...(extra.purgeData === undefined ? {} : { purgeData: extra.purgeData }), idempotencyKey: extra.key ?? `plugin-test-${++keys}` });

/** 数据目录配置文件里的 plugins */
const pluginsConfig = (dataDir: string): unknown => (JSON.parse(fs.readFileSync(dataDirLayout(dataDir).configFile, "utf8")) as { plugins?: unknown }).plugins;

/** 插件频道上收到的状况（最后一条），按插件名 → 状况 */
const lastStatus = (frontend: TestFrontend) =>
  Object.fromEntries((frontend.events({ channel: PLUGINS, type: EVENT_TYPES.pluginStatus }).at(-1)!.payload as PluginStatusEventPayload).plugins.map((p) => [p.name, p.state]));

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

const lastSecretaryText = (frontend: TestFrontend) =>
  (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
/** 秘书回显的上下文里第一条用户消息之前的那一段：系统提示和工具清单 */
const assemblyOf = (echo: string) => echo.slice(0, echo.indexOf("\n[user]"));
const toolsIn = (echo: string) => assemblyOf(echo).split("\n").flatMap((line) => (line.startsWith("[tool] ") ? [line.slice(7)] : []));

const refusalOf = (r: ResponseFrame): string => {
  if (r.ok) throw new Error("应该被拒，却成功了");
  return `${r.error.code}: ${r.error.message}`;
};

describe("设置 · 插件", () => {
  it("列插件：提醒、记忆按清单的先后，一句话、带来的工具和卡片（工具个数和秘书实际拿到的一样）、连数据删删哪些删不掉哪些", async () => {
    const td = await startTestDaemon({ secretary: [{ kind: "echo_context" }] });
    const { status, body } = await pluginsApi.view(td.url);
    expect(status).toBe(200);
    expect(body.plugins.map((p) => [p.name, p.title, p.state])).toEqual([
      ["reminders", "提醒", "running"],
      ["memory", "记忆", "running"],
      ["calendar", "日历", "running"],
      ["voice", "语音", "running"],
      ["browsing", "内置浏览器", "running"],
      ["claude-code", "Claude Code", "running"],
      ["phone", "手机", "running"],
      ["google", "Google", "running"],
      ["looki", "Looki", "running"],
    ]);
    const [reminders, memory] = body.plugins;
    const voice = body.plugins.find((p) => p.name === "voice");
    expect(reminders).toMatchObject({
      summary: "到点或者某件事发生时提醒你一声：简单提醒，不用 agent 干活",
      brings: { tools: ["建简单提醒", "改简单提醒", "取消简单提醒", "归档简单提醒"], cards: ["提醒卡"], jobs: [] },
      needs: [],
      neededBy: [],
      stopsWith: [],
      startsWith: [],
    });
    expect(reminders!.removal!.deletes).toHaveLength(3);
    expect(reminders!.removal!.keeps).toEqual([
      "聊天里提到过的提醒内容（你让它建提醒时说的话、它的回话）",
      "备份快照里的一份（随快照轮换消失：本机约 7 天，同步目录最长约 5 周）",
    ]);
    expect(memory).toMatchObject({ brings: { tools: ["检索素材", "读素材", "问记忆", "问记忆管理员", "记下顺口问了", "记一句"], cards: ["记忆删除卡", "约访卡（了解你访谈）", "访谈的档案核对卡（了解你访谈收尾时，逐条确认）"], jobs: [] } });
    expect(memory!.removal!.keeps[0]).toContain("素材属于内核，要删请去 记忆 · 素材 的成批删除");
    // 语音插件（214 号票）：带来口语总结、发语音；连数据删删录音、合成的音频、语音事件里的文字，会话里交给过二狗的不删
    expect(voice).toMatchObject({ summary: expect.stringContaining("按住说话"), brings: { tools: ["口语总结", "发语音"], cards: [], jobs: [] }, needs: [], neededBy: [] });
    expect(voice!.removal!.deletes.join("\n")).toContain("录音");
    expect(voice!.removal!.keeps[0]).toContain("会话里转写成文字交给过二狗的那部分");
    // Google 插件（297 号票）：带来查 Google 日历、298 号票的搜 / 读 Gmail 邮件（数据源的按需查，内核替它给秘书）；连数据删删同步来的日历事件、
    // 私密地址、导入的你发出的邮件、Gmail 地址和密码；日历是可选依赖。301 号票：还删从 Google 联系人导入的记录，已经写进档案的、
    // 还没处理的候选不删
    const google = body.plugins.find((p) => p.name === "google");
    expect(google).toMatchObject({ title: "Google", brings: { tools: ["查 Google 日历", "搜 Gmail 邮件", "读 Gmail 邮件"], cards: [], jobs: [] }, needs: [], neededBy: [] });
    expect(google!.removal!.deletes).toEqual([
      "同步来的 Google 日历事件和日历的名字",
      "填过的私密 iCal 地址（这台电脑的密钥区里）",
      "导入的你发出的邮件（开了「导入」才有）",
      "填过的 Gmail 地址和应用专用密码（这台电脑的密钥区里）",
      "从 Google 联系人导入的记录",
    ]);
    expect(google!.removal!.keeps[2]).toContain("已经写进个人档案的、档案候选里还没处理的");

    // 带来的工具个数和秘书实际拿到的对得上
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, "在吗");
    const tools = toolsIn(lastSecretaryText(frontend));
    expect(tools.filter((name) => name.endsWith("_reminder"))).toHaveLength(reminders!.brings.tools.length);
    expect(tools.filter((name) => ["search_materials", "read_material", "ask_memory", "ask_curator", "mark_woven_question", "remember_memory"].includes(name))).toHaveLength(memory!.brings.tools.length);
    expect(tools.filter((name) => name === "spoken_summary" || name === "send_voice")).toHaveLength(voice!.brings.tools.length);
    // Google 带来的三个是数据源的按需查：306 号票起没连上的不给秘书（这里都没填地址、密码）
    expect(google!.brings.tools).toHaveLength(3);
    expect(tools.filter((name) => ["query_google_calendar", "search_gmail", "read_gmail"].includes(name))).toEqual([]);
    // 不认得的插件、请求体不对
    expect((await act(td.url, "nope", "disable")).status).toBe(404);
    expect((await pluginsApi.act(td.url, "reminders", { action: "explode", idempotencyKey: "k" })).status).toBe(400);
  });

  it("停用（热）：马上生效——插件频道推新状况、写进 plugins.disabled；正在跑的一轮里再调提醒工具回\"提醒插件没启用\"，下一轮秘书没有提醒工具；再启用：马上回来、从配置里拿掉，以前建的提醒照常到点", { timeout: 60_000 }, async () => {
    const clock = new ManualClock(START);
    let url = "";
    // 秘书调一下就在设置里停用提醒插件（模拟用户在这一轮当中点了停用）
    const disableNow = defineHostTool({
      name: "test_disable_reminders",
      title: "停用提醒插件",
      description: "测试用",
      parameters: Type.Object({}),
      readOnlyOrIdempotent: true,
      run: async () => {
        const r = await act(url, "reminders", "disable");
        return { text: `停了：${r.body.changed.join("、")}` };
      },
    });
    const td = await startTestDaemon({
      clock,
      // 265 号票：给了 clock 时底座默认停掉记忆插件；这里看的是全部插件照常装时的状况和配置，打开
      memoryPlugin: true,
      secretaryTools: [disableNow],
      secretary: [
        call("create_reminder", { text: "交报告", inDays: 1, time: "09:00" }),
        say("好。"),
        call("test_disable_reminders", {}),
        call("create_reminder", { text: "周五复查", inDays: 2, time: "10:00" }),
        { kind: "echo_context" },
        { kind: "echo_context" },
      ],
    });
    url = td.url;
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, "明早 9 点提醒我交报告");
    expect(reminderService(td.daemon).get("r-1")).toMatchObject({ status: "pending", nextAt: nowIso(at(10, 8, 9)) });

    // 这一轮当中停用：后面那次建提醒回"没启用"，不建
    await tell(frontend, "再提醒我周五复查");
    const midTurn = lastSecretaryText(frontend);
    expect(midTurn).toContain("[toolResult] test_disable_reminders: 停了：reminders");
    expect(midTurn).toContain("[toolResult] create_reminder: 提醒插件没启用：现在用不了 create_reminder（用户停用了这个插件）。如实告诉用户，不要说已经做好了。");
    expect(frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => (f.payload as { reminder: { id: string } }).reminder.id)).toEqual(["r-1"]);
    // 状况马上推给网页、配置写下了
    await waitUntil(() => lastStatus(frontend).reminders === "disabled");
    expect(lastStatus(frontend)).toEqual({ reminders: "disabled", memory: "running", calendar: "running", voice: "running", browsing: "running", "claude-code": "running", phone: "running", google: "running", looki: "running" });
    expect(pluginsConfig(td.dataDir)).toEqual({ disabled: ["reminders"] });
    expect(td.daemon.plugins.report()).toEqual({ running: ["memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["reminders"], skipped: [] });
    // 下一轮：秘书按新的贡献重新装配，没有提醒工具；"只提醒我"回没启用；看板上没有提醒那一类
    await tell(frontend, "在吗");
    expect(toolsIn(lastSecretaryText(frontend)).filter((name) => name.endsWith("_reminder"))).toEqual([]);
    expect(refusalOf(await frontend.createReminder("交报告", { kind: "once", at: nowIso(at(10, 8, 9)) }))).toBe("not_allowed: 提醒插件没启用");
    expect(td.daemon.boardKinds.list().map((k) => k.label)).toEqual(["任务", "定时触发的任务"]);
    // 停着的时候不会到点
    clock.advanceTo(at(10, 7, 23));

    // 再启用：马上回来，配置里拿掉，以前建的提醒照常到点
    const enabled = await act(td.url, "reminders", "enable");
    expect(enabled.status).toBe(200);
    expect(enabled.body.changed).toEqual(["reminders"]);
    expect(enabled.body.plugins.map((p) => p.state)).toEqual(["running", "running", "running", "running", "running", "running", "running", "running", "running"]);
    await waitUntil(() => lastStatus(frontend).reminders === "running");
    expect(pluginsConfig(td.dataDir)).toBeUndefined();
    expect(td.daemon.boardKinds.list().map((k) => k.label)).toEqual(["任务", "简单提醒", "定时触发的任务"]);
    expect(reminderService(td.daemon).get("r-1")).toMatchObject({ status: "pending" });
    clock.advanceTo(at(10, 8, 9));
    const item = ((await frontend.next(INBOX, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
    expect(item).toMatchObject({ notice: "reminder_due", title: "提醒：交报告" });
    // 已经开着的再启用、已经停着的再停用：没有变化
    expect((await act(td.url, "reminders", "enable")).body.changed).toEqual([]);
  });

  it("移除（不删数据）：记成移除了、写进 plugins.removed，重启后保持；装回就是启用，以前的提醒都在；停用的状况重启后也保持", { timeout: 60_000 }, async () => {
    // 265 号票：给了 clock 时底座默认停掉记忆插件；这里看的是全部插件照常装时的状况和配置，打开（重启沿用数据目录，照上次的）
    const first = await startTestDaemon({ clock: new ManualClock(START), memoryPlugin: true });
    const f1 = await TestFrontend.connect(first.url);
    await f1.subscribe(ALL);
    expect((await f1.createReminder("交报告", { kind: "once", at: nowIso(at(10, 8, 9)) })).ok).toBe(true);
    const removed = await act(first.url, "reminders", "remove");
    expect(removed.body).toMatchObject({ changed: ["reminders"] });
    expect(removed.body.purged).toBeUndefined();
    await waitUntil(() => lastStatus(f1).reminders === "removed");
    expect(await act(first.url, "memory", "disable").then((r) => r.body.changed)).toEqual(["memory"]);
    expect(pluginsConfig(first.dataDir)).toEqual({ disabled: ["memory"], removed: ["reminders"] });
    await f1.close();
    await first.daemon.stop();

    // 重启：照旧移除了、停用着
    const second = await startTestDaemon({ clock: new ManualClock(at(10, 7, 22)), reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    expect(second.daemon.plugins.report()).toEqual({ running: ["calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["memory"], skipped: [], removed: ["reminders"] });
    const f2 = await TestFrontend.connect(second.url);
    await f2.subscribe(ALL);
    await waitUntil(() => f2.events({ channel: PLUGINS, type: EVENT_TYPES.pluginStatus }).length > 0);
    expect(lastStatus(f2)).toEqual({ reminders: "removed", memory: "disabled", calendar: "running", voice: "running", browsing: "running", "claude-code": "running", phone: "running", google: "running", looki: "running" });
    expect((await pluginsApi.view(second.url)).body.plugins.map((p) => p.state)).toEqual(["removed", "disabled", "running", "running", "running", "running", "running", "running", "running"]);
    // 装回：以前的提醒都在
    expect((await act(second.url, "reminders", "enable")).body.changed).toEqual(["reminders"]);
    expect(reminderService(second.daemon).get("r-1")).toMatchObject({ status: "pending", text: "交报告" });
    expect(pluginsConfig(second.dataDir)).toEqual({ disabled: ["memory"] });
    expect((await act(second.url, "memory", "enable")).body.changed).toEqual(["memory"]);
    expect(pluginsConfig(second.dataDir)).toBeUndefined();
  });

  it("移除提醒并连数据一起彻底删除：全部提醒事件、提醒卡的每个版本、待我处理里的提醒通知；留一条删除记录（只写插件名和条数），重发不再删；装回后看板上没有以前的提醒", { timeout: 60_000 }, async () => {
    const clock = new ManualClock(START);
    // 265 号票：给了 clock 时底座默认停掉记忆插件；这里看的是全部插件照常装时的配置，打开
    const td = await startTestDaemon({ clock, memoryPlugin: true });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    expect((await frontend.createReminder("交报告", { kind: "once", at: nowIso(at(10, 7, 21, 30)) })).ok).toBe(true);
    expect((await frontend.createReminder("周五复查", { kind: "once", at: nowIso(at(10, 9, 10)) })).ok).toBe(true);
    clock.advanceTo(at(10, 7, 21, 30));
    await frontend.next(INBOX, EVENT_TYPES.inboxItem);
    const before = listInboxItems(td.daemon.store.reader);
    expect(before.some((item) => item.kind === "notice" && item.notice === "reminder_due")).toBe(true);
    const cardIds = reminderService(td.daemon)
      .list()
      .map((r) => r.cardId);
    expect(cardIds).toHaveLength(2);

    const key = "purge-reminders";
    const removed = await act(td.url, "reminders", "remove", { purgeData: true, key });
    expect(removed.status).toBe(200);
    expect(removed.body.changed).toEqual(["reminders"]);
    expect(removed.body.purged).toMatchObject({ cards: 2, files: 0 });
    expect(removed.body.purged!.events).toBeGreaterThanOrEqual(3);
    expect(removed.body.purged!.inboxItems).toBeGreaterThanOrEqual(1);
    // 提醒事件、提醒卡整条换成"已删除"标记；待我处理里没有提醒的事项了
    const store = td.daemon.store;
    expect(store.read(BOARD, 0, EVENT_TYPES.reminder).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    const cardEvents = store.read(CARDS).filter((e) => isDeletedEventPayload(e.payload) || cardIds.includes((e.payload as CardEventPayload).card?.id));
    expect(cardEvents.length).toBeGreaterThanOrEqual(2);
    expect(cardEvents.every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    for (const cardId of cardIds) expect(td.daemon.cards.get(cardId)).toBeUndefined();
    expect(listInboxItems(store.reader).filter((item) => item.kind === "notice" && item.notice?.includes("reminder"))).toEqual([]);
    // 原话一个字不留（看板、卡片、待我处理三个频道）
    for (const channel of [BOARD, CARDS, INBOX]) expect(JSON.stringify(store.read(channel))).not.toMatch(/交报告|周五复查/);
    // 停着的提醒视图也跟着重放（215 号票）：reminders 表里也不留（以前要到装回时才清掉）
    expect(JSON.stringify(store.reader.all("SELECT * FROM reminders"))).not.toMatch(/交报告|周五复查/);
    // 删除记录：插件频道上一条，只有插件名、时间、条数和类型
    const records = store.read(PLUGINS, 0, EVENT_TYPES.pluginDataPurged);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toEqual({ plugin: "reminders", at: expect.any(String), eventTypes: ["reminder"], cardTypes: ["reminder"], counts: removed.body.purged! } satisfies PluginDataPurgedEventPayload);
    // 同一个键重发：回第一次的条数，不再删、不再记
    const again = await act(td.url, "reminders", "remove", { purgeData: true, key });
    expect(again.body.purged).toEqual(removed.body.purged);
    expect(store.read(PLUGINS, 0, EVENT_TYPES.pluginDataPurged)).toHaveLength(1);
    expect(pluginsConfig(td.dataDir)).toEqual({ removed: ["reminders"] });

    // 装回：提醒视图按改写后的日志补齐，是空的；以后建的照常
    expect((await act(td.url, "reminders", "enable")).body.changed).toEqual(["reminders"]);
    expect(reminderService(td.daemon).list()).toEqual([]);
    expect((await frontend.createReminder("新的提醒", { kind: "once", at: nowIso(at(10, 10, 9)) })).ok).toBe(true);
    expect(reminderService(td.daemon).list().map((r) => r.text)).toEqual(["新的提醒"]);
  });

  it("移除记忆并连数据一起彻底删除（选 A）：\"记住\"的内容换成删除标记、长期没处理的卡的记录和记忆删除卡整条删掉；素材库不动，删除类的记忆命令不碰", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({
      secretary: [
        say("好"),
        call("propose_quick_action", { type: "remember", params: { content: "周三体检" } }),
        say("记住了"),
        call("search_materials", { query: "搬家", why: "用户要忘掉搬家的事" }),
        { kind: "call_with_matches", toolCall: { name: "propose_quick_action", arguments: { type: "forget", params: {} } }, argument: "params.materialIds", pattern: "mat-[0-9a-f]{24}" },
        say("请核对"),
      ],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, "我打算下个月搬家");
    await tell(frontend, "记住周三体检");
    await tell(frontend, "忘掉搬家的事");
    const store = td.daemon.store;
    const remember = store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand).find((e) => (e.payload as MemoryCommandEventPayload).command === "remember");
    expect(remember).toBeDefined();
    const card = frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card).find((c) => c.type === "memory_delete")!;
    const listed = (card.payload as MemoryDeleteCardPayload).matches.map((m) => m.materialId);
    expect(listed.length).toBeGreaterThan(0);
    expect((await frontend.cardAction({ cardId: card.id, action: "delete", expectedVersion: card.version, input: { mode: "forget", materialIds: listed } })).ok).toBe(true);
    const forget = store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand).find((e) => (e.payload as MemoryCommandEventPayload).command === "forget")!;
    expect(forget).toBeDefined();
    // 一张建议卡长期没处理的记录（回避信号计时追加的那种）
    const stale = store.append({
      channel: CARDS,
      type: EVENT_TYPES.cardStale,
      payload: { cardId: "c-stale", cardType: "suggest_task", pendingSince: nowIso(), time: nowIso(), cardText: "建议：体检前一天别熬夜" },
    }).event;
    const materialsBefore = td.daemon.materials.list().map((m) => m.id);

    const removed = await act(td.url, "memory", "remove", { purgeData: true });
    expect(removed.status).toBe(200);
    expect(removed.body.changed).toEqual(["memory"]);
    expect(removed.body.purged).toMatchObject({ events: 2, cards: 1, files: 0 });
    // "记住"的命令只换内容；删除类的命令原样
    expect((store.eventAt(MATERIALS_CHANNEL, remember!.seq)!.payload as MemoryCommandEventPayload & { content: string }).content).toBe(PURGED_TEXT);
    expect(store.eventAt(MATERIALS_CHANNEL, forget.seq)!.payload).toEqual(forget.payload);
    // 长期没处理的卡的记录、记忆删除卡的每个版本整条换成标记
    expect(isDeletedEventPayload(store.eventAt(CARDS, stale.seq)!.payload)).toBe(true);
    expect(td.daemon.cards.get(card.id)).toBeUndefined();
    expect(JSON.stringify(store.read(CARDS))).not.toMatch(/体检前一天|搬家/);
    // 素材库不动（记忆插件移除了，素材库只保管；以前的素材一条不少）
    expect(td.daemon.materials.list().map((m) => m.id)).toEqual(materialsBefore);
    expect(store.read(PLUGINS, 0, EVENT_TYPES.pluginDataPurged).map((e) => (e.payload as PluginDataPurgedEventPayload).plugin)).toEqual(["memory"]);
  });

  it("没写明连数据删的插件：勾了回\"没有可以一起删的数据\"，什么都不动；不勾照常移除", async () => {
    const td = await startTestDaemon({ extraPlugins: [{ name: "plain", title: "朴素", setup: () => {} }] });
    const refused = await act(td.url, "plain", "remove", { purgeData: true });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("朴素插件没有可以一起删的数据");
    expect(td.daemon.plugins.running("plain")).toBe(true);
    expect((await act(td.url, "plain", "remove")).body.changed).toEqual(["plain"]);
  });
});
