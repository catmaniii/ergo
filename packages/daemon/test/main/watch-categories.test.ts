// 主切面：设置里的关注类别（规格第 9 节，26 号票）。测试扮演设置页：订阅关注类别频道，看到内置九类（对话、任务两套处置）、
// 两条底线和自定义类别；新建、改规则、改处置（往松往严都行）、删除自定义类别，调严内置类别——不重启守护进程，
// 秘书下一次工具调用就按新设置判定。调松内置类别、改底线被拒，设置文件不变。注册表在数据目录的配置区，
// agent 用文件工具、bash、脚本写它都判"永不"、不出审批卡。设置文件坏了：守卫判定出错，设置页看到问题并能修复。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type UpdateWatchCategoriesResult,
  type WatchCategorySettingsEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, watchCategories: WATCH } = CHANNELS;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const done: FauxStep = { kind: "reply", text: "好" };

async function setup(script: FauxStep[], options: { reuse?: { dataDir: string; homeDir: string } } = {}) {
  const test = await startTestDaemon({ secretary: script, ...options });
  const frontend = await TestFrontend.connect(test.url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [WATCH]: 0 });
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
      [{ op: "create_custom", category: { title: "写错的工具", match: { tools: ["wirte"] }, chat: "never", task: "never" } }, /没有这个工具：wirte/],
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
});

describe("注册表在受保护的配置区：agent 写它一律'永不'，不出审批卡", () => {
  it("文件工具、bash 重定向、内联脚本、跑写好的脚本", async () => {
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
    await tell(frontend, "把关注类别都放开");
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.disposition, p.outcome])).toEqual([
      ["write", "never", "blocked"],
      ["bash", "never", "blocked"],
      ["bash", "never", "blocked"],
      ["write", "do", "done"],
      ["bash", "never", "blocked"],
    ]);
    expect(fs.existsSync(target)).toBe(false);
    expect(frontend.events({ channel: CARDS })).toEqual([]);
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
    await tell(frontend, "写到 notes");
    expect(lastPart(frontend)).toMatchObject({ tool: "write", disposition: "never", outcome: "blocked", categoryTitles: ["动 notes"] });
  });

  it("用户手改好了文件，点'重新读取'：设置页跟着变", async () => {
    const { frontend, layout } = await setup([]);
    await nextSettings(frontend);
    fs.writeFileSync(layout.watchCategoriesFile, JSON.stringify({ builtin: { unknown_write: { chat: "never" } } }));
    expect((await frontend.updateWatchCategories({ op: "reload" })).ok).toBe(true);
    const reloaded = await nextSettings(frontend);
    expect(reloaded).toMatchObject({ by: "system", change: { op: "file" } });
    expect(reloaded.state.builtin.find((c) => c.id === "unknown_write")?.chat).toBe("never");
    // 再读一次，没变就不再记
    expect((await frontend.updateWatchCategories({ op: "reload" })).ok).toBe(true);
    expect(settingsEvents(frontend)).toHaveLength(2);
  });
});
