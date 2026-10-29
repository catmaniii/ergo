// 守卫切面：工具注册表和关注类别注册表的内容；关注类别注册表从数据目录的配置区读。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import {
  BUILTIN_TOOL_REGISTRY,
  BUILTIN_WATCH_CATEGORIES,
  judgeToolCall,
  loadWatchCategorySettings,
  registerTools,
} from "../../src/guard/index.ts";
import { call, inChat, inTask, maintainer, v1Satisfied } from "./helpers/guard-input.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("工具注册表", () => {
  it("带类型的特殊 bash 工具：类别、做完告诉我、联网照 28 号票的登记表；只读或幂等只有状态和差异（从严）", () => {
    // [工具, 关注类别, 做完告诉我, 只读或幂等, 要联网]
    const TABLE: [string, string[], boolean, boolean, boolean][] = [
      ["git_status_diff", [], false, true, false],
      ["git_commit", [], true, false, false],
      ["git_merge", [], true, false, false],
      ["git_push", ["external_send"], false, false, true],
      ["create_remote_repo", ["external_send"], false, false, true],
      ["run_tests", [], false, false, false],
      ["install_deps", [], true, false, true],
      ["start_build", [], false, false, false],
    ];
    for (const [name, categories, notify, idempotent, network] of TABLE) {
      const t = BUILTIN_TOOL_REGISTRY[name]!;
      expect({
        name,
        source: t.source,
        categories: [...t.categories],
        notify: t.notifyWhenDone ?? false,
        idempotent: t.readOnlyOrIdempotent ?? false,
        network: t.network ?? false,
      }).toEqual({ name, source: "typed_shell", categories, notify, idempotent, network });
    }
  });

  it("参数规则：哪个参数是路径（读还是写）、哪个是对外内容", () => {
    expect(BUILTIN_TOOL_REGISTRY.write!.args.path).toMatchObject({ kind: "path", access: "write", replaces: true });
    expect(BUILTIN_TOOL_REGISTRY.read!.args.path).toMatchObject({ kind: "path", access: "read" });
    expect(BUILTIN_TOOL_REGISTRY.git_commit!.args.repoPath).toMatchObject({ kind: "path" });
    expect(BUILTIN_TOOL_REGISTRY.git_commit!.args.message).toMatchObject({ kind: "content" });
  });

  it("带类型的工具的判定：状态和差异、跑测试、构建直接做；提交、合并、装依赖做完告诉我；推送、建远端仓库落入对外发送", () => {
    const TABLE: [string, Record<string, unknown>, string, string][] = [
      ["git_status_diff", {}, "log_only", "log_only"],
      ["run_tests", {}, "log_only", "log_only"],
      ["start_build", {}, "log_only", "log_only"],
      ["git_commit", { message: "wip" }, "notify_after", "notify_after"],
      ["git_merge", { branch: "feature" }, "notify_after", "notify_after"],
      ["install_deps", {}, "notify_after", "notify_after"],
      ["git_push", { remote: "origin", branch: "main" }, "ask_first", "ask_first"],
      ["create_remote_repo", { name: "notes", visibility: "private" }, "ask_first", "ask_first"],
    ];
    // 这里看的是登记的类别：v1 模板的前提（跑过测试、已提交）先满足
    for (const [tool, args, chat, task] of TABLE) {
      const chatJ = judgeToolCall(inChat(maintainer(), call(tool, args), v1Satisfied()));
      const taskJ = judgeToolCall(inTask(maintainer(), call(tool, args), v1Satisfied()));
      expect({ tool, chat: chatJ.disposition, task: taskJ.disposition }).toEqual({ tool, chat, task });
      expect(taskJ.genericShell).toBe(false);
    }
  });

  it("带类型工具的仓库路径过围栏：工作目录外落入'越出项目目录'，受保护区域永不", () => {
    expect(judgeToolCall(inTask(maintainer(), call("git_commit", { repoPath: "E:\\elsewhere", message: "x" }))).categories).toEqual(["outside_project"]);
    expect(judgeToolCall(inTask(maintainer(), call("git_commit", { repoPath: "D:\\ergo-app", message: "x" }))).disposition).toBe("never");
    expect(judgeToolCall(inTask(maintainer(), call("git_status_diff", { repoPath: "E:\\work\\notes\\wt-1" }))).disposition).toBe("log_only");
  });

  it("MCP 工具可以登记类别标签、参数规则、标记和联网；重名报错；注册表不被改动", () => {
    const registry = registerTools(BUILTIN_TOOL_REGISTRY, {
      name: "mcp__mail__send",
      title: "发邮件",
      source: "mcp",
      categories: ["external_send"],
      args: { to: { kind: "recipient" }, body: { kind: "content" } },
      network: true,
      outbound: true,
      readOnlyOrIdempotent: false,
    });
    expect(registry.mcp__mail__send!.categories).toEqual(["external_send"]);
    expect(BUILTIN_TOOL_REGISTRY.mcp__mail__send).toBeUndefined();
    expect(() => registerTools(registry, { ...registry.mcp__mail__send! })).toThrow(/已经有/);
    const j = judgeToolCall({ ...inChat(maintainer(), call("mcp__mail__send", { to: "a@b.c", body: "hi" })), tools: registry });
    expect(j.disposition).toBe("ask_first");
  });

  it("伪工具只能由守卫拆 bash 得到：模型直接调用同名工具按没登记处理", () => {
    const j = judgeToolCall(inTask(maintainer(), call("delete", { path: "x" })));
    expect(j.categories).toEqual(["unknown_write"]);
  });
});

describe("关注类别注册表", () => {
  it("内置九类，带对话和任务两套默认处置", () => {
    expect(BUILTIN_WATCH_CATEGORIES.map((c) => c.id)).toEqual([
      "spend_money",
      "external_send",
      "delete_or_overwrite",
      "irreversible_commit",
      "account_security",
      "outside_project",
      "memory_out_of_scope",
      "unplanned_work_order",
      "unknown_write",
    ]);
    expect(BUILTIN_WATCH_CATEGORIES.find((c) => c.id === "outside_project")!.defaults).toEqual({ chat: "ask_first", task: "plan_listed" });
    expect(BUILTIN_WATCH_CATEGORIES.find((c) => c.id === "unplanned_work_order")!.defaults.chat).toBeNull();
  });

  it("从数据目录的配置区读；没有文件时是空设置（全按默认）", () => {
    const layout = dataDirLayout(makeTempDir());
    expect(loadWatchCategorySettings(layout)).toEqual({});
  });

  it("读到的设置交给判定函数，判定按它走", () => {
    const layout = dataDirLayout(makeTempDir());
    fs.mkdirSync(layout.config, { recursive: true });
    fs.writeFileSync(
      layout.watchCategoriesFile,
      JSON.stringify({
        builtin: { delete_or_overwrite: { task: "ask_first" } },
        custom: [{ id: "migrations", title: "动迁移目录", match: { paths: ["E:\\work\\notes\\db\\migrations"] }, chat: "ask_first", task: "ask_first" }],
      }),
    );
    const settings = loadWatchCategorySettings(layout);
    const j = judgeToolCall(inTask(maintainer(), call("write", { path: "db/migrations/001.sql", content: "x" }), { settings, facts: { files: { "E:\\work\\notes\\db\\migrations\\001.sql": { exists: false } } } }));
    expect(j.categories).toEqual(["migrations"]);
    expect(j.disposition).toBe("ask_first");
  });

  it("文件不对时报错，并指出是哪个文件、哪一项", () => {
    const layout = dataDirLayout(makeTempDir());
    fs.mkdirSync(layout.config, { recursive: true });
    const cases: [unknown, RegExp][] = [
      [{ builtin: { spend_money: { chat: "log_only" } } }, /spend_money\.chat.*只能往严里调/],
      [{ builtin: { no_such: { chat: "never" } } }, /no_such/],
      [{ custom: [{ id: "external_send", title: "x", match: { tools: ["a"] }, chat: "never", task: "never" }] }, /和内置类别重名/],
      [{ custom: [{ id: "x", title: "x", match: {}, chat: "never", task: "never" }] }, /至少要有一个条件/],
      [{ custom: [{ id: "x", title: "x", match: { tools: ["a"] }, chat: "sometimes", task: "never" }] }, /custom\[0\]\.chat/],
      [[], /必须是一个对象/],
    ];
    for (const [content, pattern] of cases) {
      fs.writeFileSync(layout.watchCategoriesFile, JSON.stringify(content));
      expect(() => loadWatchCategorySettings(layout)).toThrow(pattern);
      expect(() => loadWatchCategorySettings(layout)).toThrow(/watch-categories\.json/);
    }
  });

  it("仓库里的示例文件可以原样放进数据目录使用", () => {
    const layout = dataDirLayout(makeTempDir());
    fs.mkdirSync(layout.config, { recursive: true });
    const example = path.resolve(import.meta.dirname, "../../../../config/watch-categories.example.json");
    fs.copyFileSync(example, layout.watchCategoriesFile);
    expect(() => loadWatchCategorySettings(layout)).not.toThrow();
  });
});
