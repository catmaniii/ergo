// 主切面：记忆插件（129 号票，ADR-0027 的第二个适配器）。走真实的装配路径：经组合根和插件清单起守护进程，停用只经数据目录配置的
// plugins.disabled（startTestDaemon 的 plugins 选项），不手挂插件。
// - 配置里停用记忆插件：守护进程照常起（日志、健康信息里写明，不算降级）；不采成素材（库里没有、检索不到、没有向量），
//   用户的话照样留原话副本（用户的数据承诺）；没有记忆命令（快速动作里没有、"提议快速动作"的说明里不提 search_materials），
//   秘书没有 search_materials、系统提示里不讲记忆命令（句子照样通顺）；别的功能（提醒、工作日历）照常；
// - 停用期间：以前的记忆删除卡回"记忆插件没启用"；设置里按会话彻底删除照常（库里已有的、只在原话副本里的都删，原文改写成标记）；
// - 再启用：素材库从停下的采集位置补采，停用期间没删的话成了素材、能检索，删过的不回来。
// 默认全开时秘书看到的工具（先后、说明）、系统提示和以前逐字节一样，由已有的主切面测试守着（plugins.test.ts、secretary-chat.test.ts……）。
// 232 号票起：开着时秘书多一个 ask_memory（在 read_material 后面、propose_quick_action 前面），每轮醒来还有一块记忆简报
// （推理库还空着时是空串，不产生块）；停用后这两个都没有。242 号票起再多一个 ask_curator（问记忆管理员，排在 ask_memory 后面）。
import fs from "node:fs";
import path from "node:path";
import { type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, isDeletedEventPayload, type MessageEventPayload, type ResponseFrame } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { proposeQuickActionTool } from "../../src/quick-actions/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi, workdayApi } from "../helpers/http.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX, board: BOARD } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [BOARD]: 0 };
const echo: FauxStep = { kind: "echo_context" };
const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

const lastSecretaryText = (frontend: TestFrontend) =>
  (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
/** 秘书回显的上下文里第一条用户消息之前的那一段：系统提示和工具清单 */
const assemblyOf = (echoed: string) => echoed.slice(0, echoed.indexOf("\n[user]"));
const refusalOf = (r: ResponseFrame): string => {
  if (r.ok) throw new Error("应该被拒，却成功了");
  return `${r.error.code}: ${r.error.message}`;
};
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).flatMap((f) => (isDeletedEventPayload(f.payload) ? [] : [(f.payload as CardEventPayload).card]));
/** 素材区里的原话副本（素材 id） */
function originals(dataDir: string): string[] {
  const root = path.join(dataDir, "materials", "originals");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json")).toSorted();
}

describe("记忆插件", () => {
  it("配置里停用记忆插件：照常起、不算降级；不采成素材但照样留原话副本；没有记忆命令、秘书没有素材检索、提示里不讲记忆命令；提醒、工作日历照常", async () => {
    const logs: string[] = [];
    const td = await startTestDaemon({
      plugins: ["reminders", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"],
      log: (line) => logs.push(line),
      secretary: [call("propose_quick_action", { type: "remember", params: { content: "下周三上午体检" } }), echo],
    });
    expect(td.daemon.plugins.report()).toEqual({ running: ["reminders", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["memory"], skipped: [] });
    expect(logs).toContain("插件 memory（记忆）在配置里停用了");
    const health = (await (await fetch(new URL("/healthz", td.url))).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: "ok", plugins: { running: ["reminders", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["memory"], skipped: [] } });

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, "记住下周三上午体检");
    const seen = lastSecretaryText(frontend);
    // 没有记忆命令：秘书提了"记住"，运行时回没有这种动作，不出卡
    expect(seen).toContain("[toolResult] propose_quick_action: 没有登记这种快速动作：remember");
    expect(cardsOf(frontend)).toEqual([]);
    // 秘书没有 search_materials、read_material、ask_memory、ask_curator、mark_woven_question（提醒的四个工具后面是内核的；297 号票 Google 日历、298 号票 Gmail、296 号票 Looki 的按需查排在中间，306 号票起没连上的不给），系统提示里不讲记忆命令，快速动作那一段照样通顺
    const assembly = assemblyOf(seen);
    expect(assembly).not.toMatch(/search_materials|read_material|ask_memory|ask_curator|mark_woven_question|remember|forget|no_infer/);
    expect(assembly).toContain("[tool] cancel_reminder\n[tool] archive_reminder\n[tool] mcp_call\n[tool] propose_quick_action");
    expect(assembly).toContain("否则出卡请用户确认）。哪天不上班、要上班用 workday_calendar");
    expect(td.daemon.quickActions.registry.list().map((e) => e.type)).toEqual(expect.not.arrayContaining(["remember", "forget", "purge", "no_infer"]));
    const description = proposeQuickActionTool(td.daemon.quickActions, SECRETARY).spec.description;
    // 185 号票起提醒插件登记了删除简单提醒（排在内核的前面）
    expect(description).toContain("否则出一张卡请用户确认后才执行。\n能用的动作：\n- delete_reminder（删除简单提醒）：");
    expect(description).toContain("\n- workday_calendar（改工作日历）：");
    expect(description).not.toContain("search_materials");

    // 不采成素材：库里没有、检索不到、没有向量；原话副本照样留着（读的时候算上它：设置里的删除找得到）
    expect(td.daemon.materials.searchKeyword("下周三上午体检")).toEqual([]);
    expect(td.daemon.materials.vectorStatus()).toMatchObject({ state: "off" });
    const kept = td.daemon.materials.list();
    expect(kept.map((m) => [m.kind, m.segments[0]?.text])).toEqual([["user_utterance", "记住下周三上午体检"]]);
    expect(originals(td.dataDir)).toEqual([kept[0]!.id]);
    // 记忆 · 素材（167）：范围的统计写明只保管（页面顶上提示），已有的照样列、照样搜得到（逐条比对）
    expect((await materialsApi.scope(td.url)).body).toMatchObject({ count: 1, keepingOnly: true });
    expect((await materialsApi.list(td.url, { filter: { query: "体检" } })).body).toMatchObject({ total: 1, items: [{ id: kept[0]!.id, excerpt: "记住下周三上午体检" }] });

    // 别的功能照常：看板上有简单提醒那一类、工作日历照常改
    expect(td.daemon.boardKinds.list().map((k) => k.label)).toEqual(["任务", "简单提醒", "定时触发的任务"]);
    expect((await workdayApi.change(td.url, { kind: "mark", date: "2026-10-12", mark: "rest" })).status).toBe(200);
  });

  it("停用期间以前的记忆删除卡回\"记忆插件没启用\"、设置里彻底删除照常（库里的、只在原话副本里的都删）；再启用时补采停用期间的，删过的不回来", { timeout: 60_000 }, async () => {
    // 开着时：用户说一句，秘书检索出来提议忘掉 → 一张记忆删除卡
    const first = await startTestDaemon({
      secretary: [
        say("好"),
        call("search_materials", { query: "搬家", why: "用户问搬家的事" }),
        { kind: "call_with_matches", toolCall: { name: "propose_quick_action", arguments: { type: "forget", params: {} } }, argument: "params.materialIds", pattern: "mat-[0-9a-f]{24}" },
        say("请核对"),
      ],
    });
    const f1 = await TestFrontend.connect(first.url);
    await f1.subscribe(ALL);
    await tell(f1, "我打算下个月搬家");
    const [moving] = first.daemon.materials.searchKeyword("搬家");
    expect(moving).toBeDefined();
    await tell(f1, "忘掉搬家的事");
    const card = cardsOf(f1).find((c) => c.type === "memory_delete")!;
    expect(card).toBeDefined();
    await f1.close();
    await first.daemon.stop();

    // 停用着起来
    const reuse = { dataDir: first.dataDir, homeDir: first.homeDir };
    const second = await startTestDaemon({ plugins: ["reminders", "voice", "browsing", "claude-code", "phone", "google", "looki"], reuse, secretary: [say("好"), say("好")] });
    const f2 = await TestFrontend.connect(second.url);
    await f2.subscribe(ALL);
    expect(refusalOf(await f2.cardAction({ cardId: card.id, action: "delete", expectedVersion: 1, input: { mode: "forget", materialIds: [moving!.id] } }))).toBe(
      "not_allowed: 记忆插件没启用",
    );
    await tell(f2, "停用时说的：周三体检");
    expect(second.daemon.materials.searchKeyword("周三体检")).toEqual([]);
    const summary = await materialsApi.scope(second.url, { kind: "conversation", conversation: SECRETARY });
    // 库里的两条（搬家那句、"忘掉搬家的事"）加只在原话副本里的一条
    expect(summary.body).toMatchObject({ count: 3 });
    const purged = await materialsApi.delete(second.url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-while-off" });
    expect(purged.status).toBe(200);
    expect(purged.body).toMatchObject({ count: 3 });
    const said = JSON.stringify(second.daemon.store.read(SECRETARY, 0, EVENT_TYPES.message));
    for (const words of ["我打算下个月搬家", "忘掉搬家的事", "停用时说的：周三体检"]) expect(said).not.toContain(words);
    // 原话副本只剩这次删除命令自己（"彻底删除：会话 secretary 里的 3 条素材"）
    expect(second.daemon.materials.list().map((m) => m.kind)).toEqual(["memory_command"]);
    expect(originals(second.dataDir)).toEqual(second.daemon.materials.list().map((m) => m.id));
    await tell(f2, "停用后又说的：周五复查");
    await f2.close();
    await second.daemon.stop();

    // 再启用：停用期间没删的那句补采成素材（能检索），删过的不回来
    const third = await startTestDaemon({ plugins: ["reminders", "memory", "voice", "browsing", "claude-code", "phone", "google", "looki"], reuse });
    expect(third.daemon.materials.searchKeyword("周五复查").map((m) => m.kind)).toEqual(["user_utterance"]);
    expect(third.daemon.materials.searchKeyword("周三体检")).toEqual([]);
    expect(third.daemon.materials.searchKeyword("搬家")).toEqual([]);
    expect(third.daemon.materials.vectorStatus().state).not.toBe("off");
  });

  it("开着时秘书多一个 ask_memory、一个 ask_curator、一个 mark_woven_question、一个 remember_memory（在 read_material 后面、propose_quick_action 前面）；推理库还空着时没有简报上下文块", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ secretary: [echo] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, "在吗");
    const seen = lastSecretaryText(frontend);
    // 232、242、271、337 号票的工具排在哪：记忆插件的六个工具按登记先后，之后是数据源的按需查（297 号票：查 Google 日历；298 号票：搜、读 Gmail 邮件；296 号票：查 Looki——306 号票起没连上的不给，这里都没连），再后面才是内核的 mcp_call（240）、propose_quick_action
    expect(assemblyOf(seen)).toContain(
      "[tool] read_material\n[tool] ask_memory\n[tool] ask_curator\n[tool] mark_woven_question\n[tool] remember_memory\n[tool] mcp_call\n[tool] propose_quick_action",
    );
    expect(assemblyOf(seen)).not.toMatch(/query_google_calendar|search_gmail|read_gmail|query_looki/);
    // 推理库刚建好、还没整理出结论：简报是空串，不注入（模型看到的消息里没有那一块）；266 号票的每条消息的记忆简报也没有
    expect(seen).not.toMatch(/【(醒来|记忆)简报】/);
    expect(fs.existsSync(td.daemon.layout.rgDb)).toBe(true);
  });

  // 235 号票：memory.enabled = false 只是"这台机器上不跑整理"，和插件停用是两回事
  it("memory.enabled = false：照常起、不排每晚整理、不建 rg.db；素材照常采、秘书照常有检索和问记忆", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ config: { memory: { enabled: false } }, secretary: [echo] });
    // 不排作业、不建库（打开一次确认库的那一步也跳过）
    expect(td.daemon.internalJobs.state("memory-nightly")).toBeUndefined();
    expect(fs.existsSync(td.daemon.layout.rgDb)).toBe(false);
    // 插件本身照常：素材照常采成素材，秘书照常有记忆的三个工具和手动整理的快速动作
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, "这周六的聚会我就不去了。");
    expect(td.daemon.materials.searchKeyword("聚会").length).toBeGreaterThan(0);
    expect(assemblyOf(lastSecretaryText(frontend))).toContain("[tool] search_materials\n[tool] read_material\n[tool] ask_memory\n[tool] ask_curator");
    expect(td.daemon.quickActions.registry.list().map((e) => e.type)).toEqual(expect.arrayContaining(["memory_nightly"]));
    // 推理库从来没建过：简报是空串（没有那块），ask_memory 回"记忆还没准备好"
    expect(lastSecretaryText(frontend)).not.toMatch(/【(醒来|记忆)简报】/);
  });
});
