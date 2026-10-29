// 主切面：插件（126 号票，ADR-0027）。走真实的装配路径：经组合根（startDaemon）和插件清单起守护进程，停用插件只经数据目录配置的
// plugins.disabled（startTestDaemon 的 plugins 选项写的就是它），不手挂插件（dsh 的复盘 0001：手挂插件的单元测试全过、上线即崩）。
// - 默认全装：提醒插件、记忆插件（129 号票）在运行；停用记忆插件的在 memory-plugin.test.ts；
// - 配置里停用提醒插件：守护进程照常起，日志和健康信息里写明；秘书照常聊天，它没有提醒工具、系统提示里没有提醒（128 号票：
//   agent 那一侧也是提醒插件贡献的），不产生提醒和卡片；发起对话框里的"只提醒我"回"提醒插件没启用"；看板、日历照常，
//   只是没有提醒那一类；别的功能（素材、工作日历）照常；
// - 停用期间：以前的提醒卡上的按钮回"提醒插件没启用"，彻底删除照常（提醒卡是数据契约，停用也登记）；
// - 再启用：提醒的视图整表补一遍，以前建的提醒照常到点；秘书又有提醒工具、系统提示里又有提醒。
import { CHANNELS, EVENT_TYPES, type InboxItemEventPayload, type MessageEventPayload, nowIso, type ResponseFrame } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { boardToolText } from "../../src/board/kinds.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { reminderService, startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi, workdayApi } from "../helpers/http.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0 };

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 7, 21, 0);

const createCall = (args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name: "create_reminder", arguments: args as never }] });

/** 用户说一句话，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

/** 秘书最后一条消息里的文字（echo_context 把模型看到的工具结果写进来） */
const lastSecretaryText = (frontend: TestFrontend) =>
  (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/** 秘书回显的上下文里第一条用户消息之前的那一段：系统提示和工具清单 */
const assemblyOf = (echo: string) => echo.slice(0, echo.indexOf("\n[user]"));

/** 被拒的请求：错误码和原因 */
const refusalOf = (r: ResponseFrame): string => {
  if (r.ok) throw new Error("应该被拒，却成功了");
  return `${r.error.code}: ${r.error.message}`;
};

describe("插件清单和配置", () => {
  it("默认全装：提醒插件、记忆插件在运行，提醒的服务经插件宿主取得到", async () => {
    const { daemon } = await startTestDaemon();
    expect(daemon.plugins.report()).toEqual({ running: ["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: [], skipped: [] });
    expect(reminderService(daemon).pending()).toEqual([]);
    expect(daemon.boardKinds.list().map((k) => k.label)).toEqual(["任务", "简单提醒", "定时触发的任务"]);
  });

  it("配置里停用提醒插件：守护进程照常起（日志、健康信息里写明）；秘书没有提醒工具、系统提示里没有提醒，不建卡；\"只提醒我\"回\"提醒插件没启用\"；看板、日历、素材、工作日历照常", async () => {
    const logs: string[] = [];
    const clock = new ManualClock(START);
    const td = await startTestDaemon({ plugins: ["memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], clock, log: (line) => logs.push(line), secretary: [{ kind: "echo_context" }] });
    expect(td.daemon.plugins.report()).toEqual({ running: ["memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["reminders"], skipped: [] });
    expect(td.daemon.plugins.service({ id: "reminders" })).toBeUndefined();
    expect(logs).toContain("插件 reminders（提醒）在配置里停用了");
    const health = (await (await fetch(new URL("/healthz", td.url))).json()) as Record<string, unknown>;
    expect(health.plugins).toEqual({ running: ["memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["reminders"], skipped: [] });

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, "明早 9 点提醒我交报告");
    // 128 号票：秘书没有提醒的三个工具，系统提示里没有提醒（别的工具、别的段落照旧）；不产生提醒和卡片
    const seen = assemblyOf(lastSecretaryText(frontend));
    expect(seen).not.toMatch(/reminder|提醒/);
    expect(seen).toContain("[tool] send_attachment\n[tool] search_materials\n[tool] read_material");
    expect(seen).toContain("你有一块自己的草稿区");
    expect(seen).toContain("建定时触发的普通任务或流程。将来");
    expect(frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder })).toEqual([]);
    expect(frontend.events({ channel: CARDS, type: EVENT_TYPES.card })).toEqual([]);
    // 发起对话框里的"只提醒我"
    expect(refusalOf(await frontend.createReminder("交报告", { kind: "once", at: nowIso(at(10, 8, 9)) }))).toBe("not_allowed: 提醒插件没启用");

    // 看板没有提醒那一类；日历照常（工作日判定在，提醒是空的）
    expect(td.daemon.boardKinds.list().map((k) => k.label)).toEqual(["任务", "定时触发的任务"]);
    expect(boardToolText(td.daemon.store, td.daemon.boardKinds)).toBe("看板是空的：没有任务、定时触发的任务。");
    const month = await frontend.calendarMonth("2026-10");
    expect(month.days).toHaveLength(31);
    expect(month.days.every((d) => d.reminders.length === 0)).toBe(true);
    // 素材照常采（用户说的话）；工作日历照常改
    expect(td.daemon.materials.list().map((m) => m.segments[0]?.text)).toContain("明早 9 点提醒我交报告");
    expect((await workdayApi.change(td.url, { kind: "mark", date: "2026-10-12", mark: "rest" })).status).toBe(200);
  });

  it("停用期间以前的提醒卡回\"提醒插件没启用\"、彻底删除照常；再启用时提醒的视图整表补一遍，以前建的提醒照常到点，秘书又有提醒", async () => {
    const first = await startTestDaemon({ clock: new ManualClock(START), secretary: [createCall({ text: "交报告", inDays: 1, time: "09:00" }), { kind: "reply", text: "好。" }] });
    const f1 = await TestFrontend.connect(first.url);
    await f1.subscribe(ALL);
    await tell(f1, "明早 9 点提醒我交报告");
    expect(reminderService(first.daemon).get("r-1")).toMatchObject({ status: "pending", nextAt: nowIso(at(10, 8, 9)) });
    const cardId = reminderService(first.daemon).get("r-1")!.cardId;
    await f1.close();
    await first.daemon.stop();

    // 停用着起来
    const reuse = { dataDir: first.dataDir, homeDir: first.homeDir };
    const second = await startTestDaemon({ plugins: ["memory", "voice", "browsing", "claude-code", "phone", "google", "looki"], clock: new ManualClock(at(10, 7, 22)), reuse });
    const f2 = await TestFrontend.connect(second.url);
    await f2.subscribe(ALL);
    expect(refusalOf(await f2.cardAction({ cardId, action: "cancel_reminder", expectedVersion: 1 }))).toBe("not_allowed: 提醒插件没启用");
    // 彻底删除秘书会话里的素材（用户那句话）：照常
    const purged = await materialsApi.delete(second.url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-secretary" });
    expect(purged.status).toBe(200);
    expect(purged.body).toMatchObject({ count: 1 });
    expect(JSON.stringify(second.daemon.store.read(SECRETARY, 0, EVENT_TYPES.message))).not.toContain("明早 9 点提醒我交报告");
    // 提醒卡还在、没被改（卡片新版本、彻底删除靠它的数据契约照常）
    expect(second.daemon.cards.get(cardId)).toMatchObject({ type: "reminder", status: "pending" });
    await f2.close();
    await second.daemon.stop();

    // 再启用：视图补齐，到点照常响
    const logs: string[] = [];
    const clock = new ManualClock(at(10, 7, 23));
    // 下面拨过 03:00：只关掉记忆整理（memory.enabled，265 号票），不要后台唤醒记忆管理员；插件照样在运行
    const third = await startTestDaemon({
      plugins: ["reminders", "memory", "voice", "browsing", "claude-code", "phone", "google", "looki"],
      clock,
      reuse,
      log: (line) => logs.push(line),
      secretary: [{ kind: "echo_context" }],
      config: { memory: { enabled: false } },
    });
    expect(third.daemon.plugins.report().running).toEqual(["reminders", "memory", "voice", "browsing", "claude-code", "phone", "google", "looki"]);
    expect(logs.some((l) => l.startsWith("视图 reminders 从事件 #") && l.endsWith("整表按事件日志补一遍"))).toBe(true);
    expect(reminderService(third.daemon).get("r-1")).toMatchObject({ status: "pending", nextAt: nowIso(at(10, 8, 9)) });
    const f3 = await TestFrontend.connect(third.url);
    await f3.subscribe(ALL);
    clock.advanceTo(at(10, 8, 9));
    const item = ((await f3.next(INBOX, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
    expect(item).toMatchObject({ notice: "reminder_due", title: "提醒：交报告" });
    // 秘书又有提醒的三个工具（排在两个附件工具之后），系统提示里又有提醒那一段和两处顺带的半句
    await tell(f3, "在吗");
    const seen = assemblyOf(lastSecretaryText(f3));
    expect(seen).toContain("[tool] send_attachment\n[tool] create_reminder\n[tool] update_reminder\n[tool] cancel_reminder\n[tool] archive_reminder\n[tool] search_materials\n[tool] read_material");
    expect(seen).toContain("用户要你到点提醒他做什么时，直接用 create_reminder 建简单提醒");
    expect(seen).toContain("建定时触发的普通任务或流程；只要到点提醒一声的建简单提醒。将来");
  });
});
