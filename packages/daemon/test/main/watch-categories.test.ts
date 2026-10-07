// 主切面：设置里的关注类别（规格第 9 节，26 号票）。测试扮演设置页：订阅关注类别频道，看到内置九类（对话、任务两套处置）、
// 两条底线和自定义类别；新建、改规则、改处置（往松往严都行）、删除自定义类别，调严内置类别——不重启守护进程，
// 秘书下一次工具调用就按新设置判定。调松内置类别、改底线被拒，设置文件不变；还没登记的工具也能写进规则（登记后生效）。
// 注册表在数据目录的配置区，agent 用文件工具、bash 写它判"永不"、不出审批卡；脚本里写着它的路径（读写分不清）先问用户。
// 设置文件坏了：守卫判定出错，设置页看到问题并能修复，待我处理里有一条事项，修好后自动归档。新的自定义类别 id 不重用。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type ResponseFrame,
  type UpdateWatchCategoriesResult,
  WATCH_CATEGORIES_REPAIR_ACTION,
  type WatchCategorySettingsEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX, watchCategories: WATCH } = CHANNELS;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const done: FauxStep = { kind: "reply", text: "好" };

async function setup(script: FauxStep[], options: { reuse?: { dataDir: string; homeDir: string } } = {}) {
  const test = await startTestDaemon({ secretary: script, ...options });
  const frontend = await TestFrontend.connect(test.url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [WATCH]: 0 });
  const layout = dataDirLayout(realPathOf(test.dataDir)!);
  return { ...test, frontend, layout };
}

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

const toolPartsOf = (frontend: TestFrontend): ToolCallPart[] =>
  frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message as MessageEnvelope)
    .flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));

const lastPart = (frontend: TestFrontend) => toolPartsOf(frontend).at(-1)!;

const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

/** 待我处理里各事项的最新样子 */
const inboxItems = (frontend: TestFrontend): InboxItem[] => [
  ...new Map(frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => [(f.payload as InboxItemEventPayload).item.id, (f.payload as InboxItemEventPayload).item])).values(),
];
/** 每张卡的最新样子 */
const latestCards = (frontend: TestFrontend): Card[] => [
  ...new Map(frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => [(f.payload as CardEventPayload).card.id, (f.payload as CardEventPayload).card])).values(),
];

/** 一个最简单的自定义类别（金额大于 1） */
const draft = (title: string) => ({ title, match: { amountOver: 1 }, chat: "ask_first" as const, task: "ask_first" as const });

const settingsEvents = (frontend: TestFrontend) => frontend.events({ channel: WATCH, type: EVENT_TYPES.watchCategorySettings });

/** 每个前端已经看过几条设置事件（关注类别频道和秘书会话各走各的，按频道里的先后往后取，不用 frontend.next 的全局游标） */
const seenSettings = new WeakMap<TestFrontend, number>();

/** 关注类别频道上的下一条设置事件 */
async function nextSettings(frontend: TestFrontend): Promise<WatchCategorySettingsEventPayload> {
  const seen = seenSettings.get(frontend) ?? 0;
  await waitUntil(() => settingsEvents(frontend).length > seen, { describe: () => `等第 ${seen + 1} 条设置事件；已收到 ${settingsEvents(frontend).length} 条` });
  seenSettings.set(frontend, seen + 1);
  return settingsEvents(frontend)[seen]!.payload as WatchCategorySettingsEventPayload;
}

describe("设置页看到的关注类别", () => {
  it("内置九类各有对话、任务两套处置（计划外工单的对话一栏不适用），两条底线只显示，自定义类别和能匹配的工具", async () => {
    const { frontend } = await setup([]);
    const first = await nextSettings(frontend);
    expect(first.by).toBe("system");
    expect(first.change.op).toBe("file");
    const { builtin, bottomLines, custom, tools, problems } = first.state;
    expect(builtin.map((c) => [c.id, c.chat, c.task])).toEqual([
      ["spend_money", "hand_to_me", "hand_to_me"],
      ["external_send", "ask_first", "planned_only"],
      ["delete_or_overwrite", "ask_first", "do_then_tell"],
      ["irreversible_commit", "ask_first", "planned_only"],
      ["account_security", "ask_first", "ask_first"],
      ["outside_project", "ask_first", "planned_only"],
      ["memory_out_of_scope", "ask_first", "ask_first"],
      ["unplanned_work_order", null, "ask_first"],
      ["unknown_write", "ask_first", "ask_first"],
    ]);
    expect(builtin.every((c) => c.chat === c.defaults.chat && c.task === c.defaults.task)).toBe(true);
    expect(bottomLines.map((b) => [b.id, b.disposition])).toEqual([
      ["payment_account_auth", "hand_to_me"],
      ["secret_in_outbound", "never"],
    ]);
    expect(custom).toEqual([]);
    expect(problems).toEqual([]);
    // 能匹配的工具：文件工具、bash 拆出的伪工具、秘书代为执行的工具、快速动作
    const names = tools.map((t) => t.name);
    for (const name of ["write", "delete", "git_push", "create_reminder", "quick_action:remember"]) expect(names).toContain(name);
  });
});

describe("改了设置，下一次判定就按新设置走（不重启守护进程）", () => {
  it("新建自定义类别、改处置（往松里改）、改规则、删除；调严内置类别", async () => {
    const homeFile = path.join(makeTempDir("ergou-outside-"), "x.txt");
    fs.writeFileSync(homeFile, "外面的文件");
    const { frontend, layout } = await setup([
      call("write", { path: "notes/a.md", content: "1" }),
      done,
      call("write", { path: "notes/b.md", content: "2" }),
      done,
      call("write", { path: "notes/c.md", content: "3" }),
      done,
      call("write", { path: "notes/d.md", content: "4" }),
      done,
      call("write", { path: "other/e.md", content: "5" }),
      done,
      call("read", { path: homeFile }),
      done,
    ]);
    await nextSettings(frontend);
    const notes = path.join(layout.scratch, "notes");

    // 还没有自定义类别：草稿区里的写不落入任何类别
    await tell(frontend, "记一笔");
    expect(lastPart(frontend)).toMatchObject({ tool: "write", disposition: "do", outcome: "done", categoryTitles: [] });

    // 新建：动草稿区的 notes，对话里"永不"
    const created = await frontend.updateWatchCategories({ op: "create_custom", category: { title: "动草稿区的 notes", match: { paths: [notes] }, chat: "never", task: "never" } });
    expect(created.ok).toBe(true);
    const categoryId = (created as { result: UpdateWatchCategoriesResult }).result.categoryId!;
    const afterCreate = await nextSettings(frontend);
    expect(afterCreate).toMatchObject({ by: "user", change: { op: "create_custom", categoryId } });
    expect(afterCreate.state.custom).toEqual([{ id: categoryId, title: "动草稿区的 notes", match: { paths: [notes] }, chat: "never", task: "never" }]);
    await tell(frontend, "再记一笔");
    expect(lastPart(frontend)).toMatchObject({ tool: "write", disposition: "never", outcome: "blocked", categoryTitles: ["动草稿区的 notes"] });
    expect(fs.existsSync(path.join(notes, "b.md"))).toBe(false);

    // 往松里改处置：对话里"直接做只记录"
    const relax = { title: "动草稿区的 notes", match: { paths: [notes] }, chat: "do" as const, task: "never" as const };
    expect((await frontend.updateWatchCategories({ op: "update_custom", categoryId, category: relax })).ok).toBe(true);
    await nextSettings(frontend);
    await tell(frontend, "再记一笔");
    expect(lastPart(frontend)).toMatchObject({ tool: "write", disposition: "do", outcome: "done", categoryTitles: ["动草稿区的 notes"] });

    // 改规则：换成别的目录，notes 不再命中
    const moved = { ...relax, chat: "never" as const, match: { paths: [path.join(layout.scratch, "other")] } };
    expect((await frontend.updateWatchCategories({ op: "update_custom", categoryId, category: moved })).ok).toBe(true);
    await nextSettings(frontend);
    await tell(frontend, "再记一笔");
    expect(lastPart(frontend)).toMatchObject({ tool: "write", disposition: "do", outcome: "done", categoryTitles: [] });

    // 删除：other 也不再命中
    expect((await frontend.updateWatchCategories({ op: "delete_custom", categoryId })).ok).toBe(true);
    expect((await nextSettings(frontend)).state.custom).toEqual([]);
    await tell(frontend, "记到 other");
    expect(lastPart(frontend)).toMatchObject({ tool: "write", disposition: "do", outcome: "done", categoryTitles: [] });

    // 调严内置类别：越出项目目录在对话里"永不"（默认先问我）：直接拦下，不出审批卡
    expect((await frontend.updateWatchCategories({ op: "set_builtin", categoryId: "outside_project", scene: "chat", disposition: "never" })).ok).toBe(true);
    const tightened = await nextSettings(frontend);
    expect(tightened.state.builtin.find((c) => c.id === "outside_project")).toMatchObject({ chat: "never", task: "planned_only", defaults: { chat: "ask_first" } });
    await tell(frontend, "看看那个文件");
    expect(lastPart(frontend)).toMatchObject({ tool: "read", disposition: "never", outcome: "blocked", categoryTitles: ["越出项目目录"] });
    expect(frontend.events({ channel: CARDS })).toEqual([]);

    // 注册表写在数据目录的配置区（守卫的写法）
    expect(JSON.parse(fs.readFileSync(layout.watchCategoriesFile, "utf8"))).toEqual({ builtin: { outside_project: { chat: "never" } } });
  });

  it("同一个幂等键重发只改一次", async () => {
    const { frontend } = await setup([]);
    await nextSettings(frontend);
    const params = { op: "create_custom", category: { title: "大额付款", match: { amountOver: 1000 }, chat: "hand_to_me", task: "hand_to_me" } } as const;
    const a = await frontend.updateWatchCategories(params, "k-create");
    const b = await frontend.updateWatchCategories(params, "k-create");
    expect(a.ok && b.ok).toBe(true);
    expect((a as { result: unknown }).result).toEqual((b as { result: unknown }).result);
    await nextSettings(frontend);
    expect(settingsEvents(frontend)).toHaveLength(2);
  });
});

describe("设置接口改不动的", () => {
  it("内置类别调松、底线、计划外工单的对话一栏、坏规则：被拒并说明原因，设置文件和设置都不变", async () => {
    const { frontend, layout } = await setup([]);
    await nextSettings(frontend);
    expect((await frontend.updateWatchCategories({ op: "set_builtin", categoryId: "delete_or_overwrite", scene: "task", disposition: "ask_first" })).ok).toBe(true);
    await nextSettings(frontend);
    const before = fs.readFileSync(layout.watchCategoriesFile, "utf8");

    const rejected: [Parameters<TestFrontend["updateWatchCategories"]>[0], RegExp][] = [
      [{ op: "set_builtin", categoryId: "delete_or_overwrite", scene: "task", disposition: "do" }, /只能往严里调/],
      [{ op: "set_builtin", categoryId: "spend_money", scene: "chat", disposition: "ask_first" }, /只能往严里调/],
      [{ op: "set_builtin", categoryId: "payment_account_auth", scene: "chat", disposition: "never" }, /底线.*不能改/],
      [{ op: "set_builtin", categoryId: "secret_in_outbound", scene: "task", disposition: "never" }, /底线.*不能改/],
      [{ op: "set_builtin", categoryId: "unplanned_work_order", scene: "chat", disposition: "never" }, /不适用/],
      [{ op: "create_custom", category: { title: "相对路径", match: { paths: ["db/migrations"] }, chat: "never", task: "never" } }, /完整的 Windows 路径/],
      [{ op: "create_custom", category: { title: "没有规则", match: {}, chat: "never", task: "never" } }, /至少要有一个条件/],
      [{ op: "update_custom", categoryId: "nope", category: { title: "x", match: { amountOver: 1 }, chat: "never", task: "never" } }, /没有这个自定义类别/],
      [{ op: "delete_custom", categoryId: "nope" }, /没有这个自定义类别/],
      [{ op: "repair", to: "defaults" }, /没坏/],
    ];
    for (const [params, why] of rejected) {
      const res = await frontend.updateWatchCategories(params);
      expect(res.ok).toBe(false);
      expect(res.ok ? "" : res.error.message).toMatch(why);
    }
    expect(fs.readFileSync(layout.watchCategoriesFile, "utf8")).toBe(before);
    // 没有多出设置事件：只有启动时那条和调严那条
    expect(settingsEvents(frontend)).toHaveLength(2);
  });

  it("还没登记的工具也能写进规则（登记后生效，设置页提示）；规则里的工具后来没了也能只改处置", async () => {
    const { frontend, layout } = await setup([]);
    await nextSettings(frontend);
    const video = { title: "上传视频", match: { tools: ["mcp_video_upload"] }, chat: "ask_first" as const, task: "ask_first" as const };
    const created = ok(await frontend.updateWatchCategories({ op: "create_custom", category: video })) as UpdateWatchCategoriesResult;
    const state = (await nextSettings(frontend)).state;
    expect(state.custom).toEqual([{ id: created.categoryId, ...video }]);
    expect(state.tools.map((t) => t.name)).not.toContain("mcp_video_upload");
    ok(await frontend.updateWatchCategories({ op: "update_custom", categoryId: created.categoryId!, category: { ...video, task: "never" } }));
    expect((await nextSettings(frontend)).state.custom[0]).toMatchObject({ task: "never" });
    expect(JSON.parse(fs.readFileSync(layout.watchCategoriesFile, "utf8")).custom[0]).toMatchObject({ match: { tools: ["mcp_video_upload"] }, task: "never" });
  });

  it("新的自定义类别 id 不重用：删掉的 id 不再分配，手改进文件的大号也躲开", async () => {
    const { frontend, layout } = await setup([]);
    await nextSettings(frontend);
    const create = async (title: string) => {
      const r = ok(await frontend.updateWatchCategories({ op: "create_custom", category: draft(title) })) as UpdateWatchCategoriesResult;
      await nextSettings(frontend);
      return r.categoryId;
    };
    expect(await create("一")).toBe("c-1");
    ok(await frontend.updateWatchCategories({ op: "delete_custom", categoryId: "c-1" }));
    await nextSettings(frontend);
    expect(await create("二")).toBe("c-2");
    // 用户手改文件加了一个 c-7
    const file = JSON.parse(fs.readFileSync(layout.watchCategoriesFile, "utf8"));
    fs.writeFileSync(layout.watchCategoriesFile, JSON.stringify({ custom: [...file.custom, { id: "c-7", ...draft("手写的"), chat: "ask_first", task: "ask_first" }] }));
    expect(await create("三")).toBe("c-8");
  });
});

describe("注册表在受保护的配置区", () => {
  it("文件工具、bash 重定向写它：永不，不出审批卡；脚本里写着它的路径（读写分不清）：按拆不开的操作先问用户，拒绝了就没写成", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const layout = dataDirLayout(realPathOf(dataDir)!);
    const target = layout.watchCategoriesFile;
    const fwd = target.replaceAll("\\", "/");
    const script = `require("fs").writeFileSync(${JSON.stringify(target)}, "{}");\n`;
    const { frontend } = await setup(
      [
        call("write", { path: target, content: "{}" }),
        call("bash", { command: `echo '{}' > "${fwd}"` }),
        call("bash", { command: `node -e "require('fs').writeFileSync('${fwd}', '{}')"` }),
        call("write", { path: "w.js", content: script }),
        call("bash", { command: "node w.js" }),
        done,
      ],
      { reuse: { dataDir, homeDir } },
    );
    await frontend.sendText("把关注类别都放开");
    // 两次脚本各出一张审批卡：用户拒绝
    const denied = new Set<string>();
    const pendingApproval = () => latestCards(frontend).find((c) => c.type === "approval" && c.status === "pending" && !denied.has(c.id));
    for (let n = 1; n <= 2; n++) {
      await waitUntil(() => pendingApproval() !== undefined, { timeoutMs: 20_000, describe: () => `等第 ${n} 张审批卡` });
      const card = pendingApproval()!;
      denied.add(card.id);
      ok(await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version }));
    }
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.disposition, p.outcome])).toEqual([
      ["write", "never", "blocked"],
      ["bash", "never", "blocked"],
      ["bash", "ask_first", "denied"],
      ["write", "do", "done"],
      ["bash", "ask_first", "denied"],
    ]);
    expect(toolPartsOf(frontend)[2]!.categoryTitles).toEqual(["未知的写操作"]);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("演示流程（录给前端回放）", () => {
  it("设置页：新建一个自定义类别、改它的处置、调严一个内置类别、想调松被拒、删掉自定义类别", async () => {
    const { url } = await startTestDaemon({});
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [WATCH]: 0 });
    await nextSettings(frontend);
    const category = { title: "动数据库迁移目录", match: { paths: ["D:\\code\\app\\db\\migrations"] }, chat: "ask_first" as const, task: "ask_first" as const };
    ok(await frontend.updateWatchCategories({ op: "create_custom", category }, "k-create"));
    await nextSettings(frontend);
    ok(await frontend.updateWatchCategories({ op: "update_custom", categoryId: "c-1", category: { ...category, task: "do" } }, "k-relax"));
    await nextSettings(frontend);
    ok(await frontend.updateWatchCategories({ op: "set_builtin", categoryId: "delete_or_overwrite", scene: "task", disposition: "ask_first" }, "k-tighten"));
    await nextSettings(frontend);
    expect((await frontend.updateWatchCategories({ op: "set_builtin", categoryId: "delete_or_overwrite", scene: "task", disposition: "do" }, "k-loosen")).ok).toBe(false);
    ok(await frontend.updateWatchCategories({ op: "delete_custom", categoryId: "c-1" }, "k-delete"));
    await nextSettings(frontend);
    saveOrCheckRecording("watch-categories", frontend.recording);
  });
});

describe("设置文件坏了", () => {
  it("守卫判定出错拦下；设置页看到问题；坏的时候改不了；恢复成上一次有效的设置后照常判定，坏文件另存一份", async () => {
    const { frontend, layout } = await setup([call("write", { path: "a.txt", content: "x" }), done, call("write", { path: "notes/b.md", content: "y" }), done]);
    await nextSettings(frontend);
    const notes = path.join(layout.scratch, "notes");
    expect((await frontend.updateWatchCategories({ op: "create_custom", category: { title: "动 notes", match: { paths: [notes] }, chat: "never", task: "never" } })).ok).toBe(true);
    const valid = (await nextSettings(frontend)).state;

    // 用户手改坏了文件：下一次判定出错（拦下），同时设置页收到一条带问题的事件，表格仍是上一次有效的设置
    fs.writeFileSync(layout.watchCategoriesFile, '{ "builtin": { "spend_money": { "chat": "do" } ');
    await tell(frontend, "写个文件");
    expect(lastPart(frontend)).toMatchObject({ tool: "write", blockedBy: "judge_error", outcome: "blocked" });
    const broken = await nextSettings(frontend);
    expect(broken).toMatchObject({ by: "system", change: { op: "file" } });
    expect(broken.state.problems.join("\n")).toMatch(/不是合法的 JSON/);
    expect(broken.state.custom).toEqual(valid.custom);
    // 待我处理里一条事项（卡着：所有 agent 的工具调用都会被拦下），动作是去设置页修复
    await waitUntil(() => inboxItems(frontend).some((i) => i.kind === "notice" && i.notice === "watch_categories_broken"));
    const notice = inboxItems(frontend).find((i) => i.kind === "notice" && i.notice === "watch_categories_broken")!;
    expect(notice).toMatchObject({ title: "关注类别设置文件有问题，所有 agent 的工具调用都会被拦下", urgency: "blocking", actions: [WATCH_CATEGORIES_REPAIR_ACTION], archived: false });

    // 坏的时候别的修改被拒
    const refused = await frontend.updateWatchCategories({ op: "set_builtin", categoryId: "unknown_write", scene: "chat", disposition: "never" });
    expect(refused.ok ? "" : refused.error.message).toMatch(/设置文件坏了.*先修复/);

    // 修复：恢复成上一次有效的设置
    expect((await frontend.updateWatchCategories({ op: "repair", to: "last_valid" })).ok).toBe(true);
    const repaired = await nextSettings(frontend);
    expect(repaired).toMatchObject({ by: "user", change: { op: "repair", to: "last_valid" } });
    expect(repaired.state.problems).toEqual([]);
    expect(repaired.state.custom).toEqual(valid.custom);
    expect(fs.readFileSync(path.join(layout.config, "watch-categories.broken.json"), "utf8")).toContain("spend_money");
    // 修好了：事项自动归档
    await waitUntil(() => inboxItems(frontend).find((i) => i.id === notice.id)?.archived === true);
    expect(inboxItems(frontend).find((i) => i.id === notice.id)?.title).toBe("关注类别设置文件有问题（已修复）");
    await tell(frontend, "写到 notes");
    expect(lastPart(frontend)).toMatchObject({ tool: "write", disposition: "never", outcome: "blocked", categoryTitles: ["动 notes"] });
  });

  it("用户手改好了文件，点'重新读取'：设置页跟着变，坏文件的事项自动归档", async () => {
    const { frontend, layout } = await setup([]);
    await nextSettings(frontend);
    fs.writeFileSync(layout.watchCategoriesFile, "{ 坏了");
    expect((await frontend.updateWatchCategories({ op: "reload" })).ok).toBe(true);
    expect((await nextSettings(frontend)).state.problems).not.toEqual([]);
    await waitUntil(() => inboxItems(frontend).some((i) => i.kind === "notice" && i.notice === "watch_categories_broken" && !i.archived));
    fs.writeFileSync(layout.watchCategoriesFile, JSON.stringify({ builtin: { unknown_write: { chat: "never" } } }));
    expect((await frontend.updateWatchCategories({ op: "reload" })).ok).toBe(true);
    const reloaded = await nextSettings(frontend);
    expect(reloaded).toMatchObject({ by: "system", change: { op: "file" } });
    expect(reloaded.state.builtin.find((c) => c.id === "unknown_write")?.chat).toBe("never");
    await waitUntil(() => inboxItems(frontend).every((i) => i.kind !== "notice" || i.notice !== "watch_categories_broken" || i.archived));
    // 再读一次，没变就不再记
    expect((await frontend.updateWatchCategories({ op: "reload" })).ok).toBe(true);
    expect(settingsEvents(frontend)).toHaveLength(3);
  });
});
