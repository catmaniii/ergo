// 斜杠命令原样转交给运行时（289 号票）：维护者用的运行时能转交的（Claude Code，能力清单 slash_passthrough）——
// - 交给它的：用户自己在这里打的、只有文字、开头是 / 的原文（不加时间标记、不带消息 id 那一行）；二狗自己的命令（项目会话里的 /流程）、
//   秘书转达的、带着附件的、不转交的运行时（pi）都照旧；
// - 输入框的候选：二狗自己的命令在前，再是运行时报的命令（kind 是 runtime，集合名写运行时的名字），二狗的 skill 不列；和二狗的命令同名的不列；
// - 运行时的登记表记下子进程报回的模型、命令：模型按运行时（view 用它），命令按维护者（它还没跑过时用这个运行时最近报的）。
import { describe, expect, it } from "vitest";
import { slashPassthroughText } from "../../src/conversation/agent-input.ts";
import { createRuntimeRegistry, piRuntime } from "../../src/runtime/index.ts";
import { ergoCommandsIn } from "../../src/slash-commands/commands.ts";
import { conversationSlashCommands } from "../../src/slash-commands/list.ts";
import { fakeRuntime } from "../helpers/fake-runtime.ts";

const passthrough = { slashPassthrough: true, ergoCommands: ergoCommandsIn("task") };
const user = (text: string) => ({ speaker: "user" as const, parts: [{ type: "text" as const, text }] });
/** 库里的 skill 的斜杠命令（309 号票那一条用）：pstack 集合里的 tdd 写成"集合名:目录名"，unloaded 这次没装配 */
const skillCommands = () => [
  { command: "weekly-report", name: "weekly-report", description: "写周报", dir: "/skills/weekly-report" },
  { command: "review", name: "review", description: "评审", dir: "/skills/review" },
  { command: "pstack:tdd", name: "tdd", description: "测试驱动", collection: "pstack", dir: "/skills/pstack/tdd" },
  { command: "unloaded", name: "unloaded", description: "没装配", dir: "/skills/unloaded" },
];

describe("斜杠命令原样转交给运行时", () => {
  it("用户打的 /命令 原样交出；二狗自己的命令、秘书转达的、带附件的、不转交的运行时照旧", () => {
    expect(slashPassthroughText(passthrough, user("/compact"))).toBe("/compact");
    expect(slashPassthroughText(passthrough, user("  /review 42  "))).toBe("/review 42");
    expect(slashPassthroughText(passthrough, user("看看 /compact 怎么用"))).toBeUndefined();
    expect(slashPassthroughText({ slashPassthrough: false, ergoCommands: [] }, user("/compact"))).toBeUndefined();
    expect(slashPassthroughText({ slashPassthrough: true, ergoCommands: ergoCommandsIn("project") }, user("/流程 整理下载目录"))).toBeUndefined();
    expect(slashPassthroughText(passthrough, { ...user("/compact"), relayedBy: "secretary" as const })).toBeUndefined();
    expect(slashPassthroughText(passthrough, { speaker: "system" as const, parts: [{ type: "text" as const, text: "/compact" }] })).toBeUndefined();
    expect(
      slashPassthroughText(passthrough, { speaker: "user" as const, parts: [{ type: "text" as const, text: "/review" }, { type: "file" as const, mediaId: "m1", name: "a.txt", mime: "text/plain", size: 1 }] }),
    ).toBeUndefined();
  });

  it("309 号票：转交时 /<目录名>、/skill:<目录名> 是这次装配的 skill 的换成运行时里的写法（后面的话照留）；和运行时自己的命令同名的、没装配的、二狗自己的命令照旧", () => {
    const ctx = {
      ...passthrough,
      skillDirs: ["/skills/weekly-report", "/skills/review", "/skills/pstack/tdd"],
      skillCommands,
      // 运行时里的写法和 skillDirs 一一对应（Claude Code 是插件里的目录名）
      runtimeSlash: { skillCommands: (dirs: readonly string[]) => dirs.map((d) => `ergo:${d.split("/").at(-1)!}`), commands: () => ["compact", "review"] },
    };
    expect(slashPassthroughText(ctx, user("/weekly-report 写本周的"))).toBe("/ergo:weekly-report 写本周的");
    expect(slashPassthroughText(ctx, user("/pstack:tdd"))).toBe("/ergo:tdd");
    expect(slashPassthroughText(ctx, user("/skill:weekly-report"))).toBe("/ergo:weekly-report");
    // 和运行时的命令同名：运行时的优先；明说 /skill: 的才换
    expect(slashPassthroughText(ctx, user("/review 42"))).toBe("/review 42");
    expect(slashPassthroughText(ctx, user("/skill:review 42"))).toBe("/ergo:review 42");
    // 没装配的、不认得的、已经是插件写法的、运行时自己的命令照旧
    expect(slashPassthroughText(ctx, user("/unloaded"))).toBe("/unloaded");
    expect(slashPassthroughText(ctx, user("/ergo:weekly-report"))).toBe("/ergo:weekly-report");
    expect(slashPassthroughText(ctx, user("/compact"))).toBe("/compact");
    // 二狗自己的命令（项目会话里的 /workflow，中文的老写法 /流程 也算）不转交；运行时没有自己的写法的（假运行时）原样
    expect(slashPassthroughText({ ...ctx, ergoCommands: ergoCommandsIn("project") }, user("/workflow 整理下载目录"))).toBeUndefined();
    expect(slashPassthroughText({ ...ctx, ergoCommands: ergoCommandsIn("project") }, user("/流程 整理下载目录"))).toBeUndefined();
    expect(slashPassthroughText({ ...passthrough, skillDirs: ctx.skillDirs, skillCommands }, user("/weekly-report"))).toBe("/weekly-report");
  });

  it("候选：转交的运行时是二狗的命令、再是它报的命令（不列 skill、和二狗的命令同名的不列）；pi 照旧列 skill", () => {
    const table = [{ command: "tdd", name: "tdd", description: "测试驱动", dir: "/skills/tdd" }];
    const runtime = { title: "Claude Code", commands: [{ name: "compact", description: "Compact" }, { name: "task", description: "同名" }, { name: "review", description: "Review a PR", argumentHint: "<pr>" }] };
    const sources = {
      table: () => table,
      secretarySkills: () => [],
      projectSkills: (id: string) => (id === "pm-1" ? ["tdd"] : undefined),
      taskSkills: (id: string) => (id === "tm-1" || id === "tm-2" ? ["tdd"] : undefined),
      runtimeCommands: (id: string) => (id === "pm-1" || id === "tm-1" ? runtime : undefined),
    };
    expect(conversationSlashCommands(sources, "maintainer:pm-1")?.commands.map((c) => `${c.kind}:${c.text}`)).toEqual(["command:/workflow", "command:/task", "runtime:/compact", "runtime:/review"]);
    expect(conversationSlashCommands(sources, "maintainer:tm-1")?.commands).toEqual([
      { kind: "runtime", text: "/compact", name: "compact", description: "Compact", collection: "Claude Code" },
      { kind: "runtime", text: "/task", name: "task", description: "同名", collection: "Claude Code" },
      // 310 号票：参数提示照带
      { kind: "runtime", text: "/review", name: "review", description: "Review a PR", collection: "Claude Code", argumentHint: "<pr>" },
    ]);
    expect(conversationSlashCommands(sources, "maintainer:tm-2")?.commands.map((c) => c.text)).toEqual(["/tdd"]);
  });

  it("登记表记下子进程报回的：模型按运行时（view 的列表换成报回的），命令按维护者、它还没跑过时用这个运行时最近报的", () => {
    const runtimes = createRuntimeRegistry({ log: () => {} });
    runtimes.register(piRuntime);
    runtimes.register(fakeRuntime);
    expect(runtimes.view().runtimes.find((r) => r.id === fakeRuntime.id)?.models).toEqual([{ id: "fake-1", title: "假模型一号" }]);
    expect(runtimes.commandsOf(fakeRuntime.id, "tm-1")).toBeUndefined();

    runtimes.noteCatalog(fakeRuntime.id, "tm-1", { models: [{ id: "fake-2", title: "假模型二号" }], commands: [{ name: "compact", description: "压缩" }] });
    expect(runtimes.view().runtimes.find((r) => r.id === fakeRuntime.id)?.models).toEqual([{ id: "fake-2", title: "假模型二号" }]);
    expect(runtimes.commandsOf(fakeRuntime.id, "tm-1")).toEqual([{ name: "compact", description: "压缩" }]);
    // 别的维护者还没跑过：用这个运行时最近报的
    expect(runtimes.commandsOf(fakeRuntime.id, "tm-2")).toEqual([{ name: "compact", description: "压缩" }]);
    runtimes.noteCatalog(fakeRuntime.id, "tm-2", { commands: [{ name: "review", description: "评审" }] });
    expect(runtimes.commandsOf(fakeRuntime.id, "tm-1")).toEqual([{ name: "compact", description: "压缩" }]);
    expect(runtimes.commandsOf(fakeRuntime.id, "tm-3")).toEqual([{ name: "review", description: "评审" }]);
    // 只报命令的不动模型
    expect(runtimes.view().runtimes.find((r) => r.id === fakeRuntime.id)?.models).toEqual([{ id: "fake-2", title: "假模型二号" }]);
  });
});
