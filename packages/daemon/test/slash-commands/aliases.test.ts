// 斜杠命令的写法（175 号票加英文别名；310 号票用户 2026-10-26 定"所有命令用英文"）：
// - 命令一律写英文：/workflow、/task（记忆管理员的会话里 /interview、/consolidate），哪种界面语言候选里都写英文的、说明按界面语言；
// - 中文的老写法（/流程、/任务、/访谈、/整理）和 175 号票的 /ergo_workflow、/ergo_task 照样认，候选里不列；
// - 和 skill 同名时这几种写法都算二狗自己的命令（秘书、项目的会话里叫 task 的 skill 要写 /skill:task；任务的会话里没有这两个命令，直接 /task）；
// - 英文写法后面紧跟 - _ : . / 的是 skill 的名字（/task-runner），不算命令；
// - 给模型看的说法写英文的，也认的写法跟一句。
import { activeLocaleFrom, DEFAULT_LANGUAGE, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { commandAt, ergoCommandAt, ergoCommandsIn, launchCommandText } from "../../src/slash-commands/commands.ts";
import { slashCommandList } from "../../src/slash-commands/list.ts";

const use = (language: string) => setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, language));
afterEach(() => use(DEFAULT_LANGUAGE));

const skill = (command: string) => ({ command, name: command, description: `${command} 的说明`, dir: `/skills/${command}` });

describe("斜杠命令的写法", () => {
  it("英文的写法、中文的老写法、175 号票的别名都认成同一个命令；后面不是空白、标点的不算", () => {
    const ergo = ergoCommandsIn("secretary");
    expect(ergoCommandAt("/workflow 整理下载目录", ergo)?.text).toBe("/workflow");
    expect(ergoCommandAt("/task", ergo)?.text).toBe("/task");
    expect(ergoCommandAt("/流程 整理", ergo)?.text).toBe("/workflow");
    expect(ergoCommandAt("/任务，调研 NAS", ergo)?.text).toBe("/task");
    expect(ergoCommandAt("/ergo_workflow 整理下载目录", ergo)?.text).toBe("/workflow");
    expect(ergoCommandAt("/ergo_task", ergo)?.text).toBe("/task");
    expect(ergoCommandAt("/tasks", ergo)).toBeUndefined();
    expect(ergoCommandAt("/ergo_tasks", ergo)).toBeUndefined();
    // 任务的会话里没有这两个命令
    expect(ergoCommandAt("/task", ergoCommandsIn("task"))).toBeUndefined();
    // 记忆管理员的会话
    const curator = ergoCommandsIn("curator");
    expect(ergoCommandAt("/interview 家里的人", curator)?.text).toBe("/interview");
    expect(ergoCommandAt("/访谈", curator)?.text).toBe("/interview");
    expect(ergoCommandAt("/整理", curator)?.text).toBe("/consolidate");
    expect(ergoCommandAt("/workflow", curator)).toBeUndefined();
  });

  it("英文写法后面紧跟 - _ : . / 的是 skill 的名字，不算命令；空白、别的标点、中文标点算", () => {
    expect(commandAt("/task-runner 跑一下", "/task")).toBe(false);
    expect(commandAt("/task:x", "/task")).toBe(false);
    expect(commandAt("/workflow_v2", "/workflow")).toBe(false);
    expect(commandAt("/task 调研 NAS", "/task")).toBe(true);
    expect(commandAt("/task，调研 NAS", "/task")).toBe(true);
    expect(commandAt("/task!", "/task")).toBe(true);
    // 中文的老写法照旧：后面跟标点（含 -）就算（82 号票的 /流程-助手）
    expect(commandAt("/流程-助手 看看", "/流程")).toBe(true);
    expect(commandAt("/流程图怎么画", "/流程")).toBe(false);
  });

  it("候选：中文、英文界面都写 /workflow、/task（说明按界面语言）；秘书的会话里叫 task 的 skill 写 /skill:task，任务的会话里直接 /task", () => {
    const skills = [skill("task"), skill("tdd")];
    const zh = slashCommandList("secretary", skills).commands;
    expect(zh.map((c) => c.text)).toEqual(["/workflow", "/task", "/skill:task", "/tdd"]);
    expect(zh[0]).toEqual({ kind: "command", text: "/workflow", name: "workflow", description: expect.stringMatching(/^发起一个流程/), argumentHint: "<要做的事>" });
    use("en");
    const en = slashCommandList("secretary", skills).commands;
    expect(en.slice(0, 2)).toEqual([
      { kind: "command", text: "/workflow", name: "workflow", description: expect.stringMatching(/^Start a workflow/), argumentHint: "<what to do>" },
      { kind: "command", text: "/task", name: "task", description: expect.stringMatching(/^Start a long-running task/), argumentHint: "<what to do>" },
    ]);
    expect(en.slice(2).map((c) => c.text)).toEqual(["/skill:task", "/tdd"]);
    expect(slashCommandList("task", skills).commands.map((c) => c.text)).toEqual(["/task", "/tdd"]);
  });

  it("给模型看的说法写英文的，也认的写法跟一句", () => {
    expect(launchCommandText("workflow")).toBe("/workflow（也认 /流程、/ergo_workflow）");
    expect(launchCommandText("long_running")).toBe("/task（也认 /任务、/ergo_task）");
  });
});
