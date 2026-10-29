// 工具调用的性质（54 号票，state/tool-nature.ts）：只看、动手、删改，要点层、全局层的工具色块按它分深浅
// （最重的一档是删改，不只是删除）。守护进程记在工具调用 part 上（nature，用户 2026-10-09 定）；
// 54 号票之前的记录没有，按工具名和"删除或覆盖"类别估。
// 工具调用组取组里最重的。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { chatItemNature, chatItems, type EventFrame, type MessagePart, replay, type ToolNature, toolNatureOf, type UiInput } from "../../src/state/index.ts";
import { frame } from "./events.ts";

describe("守护进程记了的：照它的（回放 timeline-zoom，录制在 packages/daemon/test/main/timeline.test.ts）", () => {
  const inputs = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", "timeline-zoom.json"), "utf8")) as UiInput[];
  const items = chatItems(replay(inputs), "maintainer:tm-1");

  test("第一组（写新文件、ls、建目录、提交）是动手；读主目录那组是只看；第二阶段写报告、写围栏外那组是动手", () => {
    const groups = items.filter((it) => it.kind === "tool_group");
    expect(groups.map((g) => (g.kind === "tool_group" ? g.calls.map((c) => `${c.part.tool}:${c.part.nature}`) : []))).toEqual([
      ["write:act", "bash:look", "bash:act", "git_commit:act"],
      ["read:look"],
      ["write:act", "write:act"],
    ]);
    expect(groups.map(chatItemNature)).toEqual(["act", "look", "act"]);
  });

  test("没执行的调用（被拦下、你拒绝了）按只看画，记的是什么都一样（没发生的删改不显示成红圈）", () => {
    expect(toolNatureOf(tool("bash", { nature: "modify", outcome: "blocked", blockedBy: "hard_refusal" }))).toBe("look");
    expect(toolNatureOf(tool("delete_files", { outcome: "denied" }))).toBe("look");
    expect(toolNatureOf(tool("write", { nature: "modify", outcome: "error" }))).toBe("modify");
  });

  test("记了的不再按工具名估：名字像删除的、命中删除或覆盖的，守护进程说只看就是只看；通用 bash 守护进程拆开了，说删改就是删改", () => {
    expect(toolNatureOf(tool("delete_files", { categoryTitles: ["删除或覆盖"], nature: "look" }))).toBe("look");
    expect(toolNatureOf(tool("bash", { genericBash: true, argsSummary: "sed -i 's/a/b/' x.ini", nature: "modify" }))).toBe("modify");
    expect(toolNatureOf(tool("bash", { genericBash: true, argsSummary: "ls -la", nature: "look" }))).toBe("look");
  });
});

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

function tool(name: string, overrides: Partial<ToolCallPart> = {}): ToolCallPart {
  return { type: "tool_call", callId: `c-${name}`, tool: name, argsSummary: "", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done", ...overrides };
}

describe("旧记录（没有 nature）：按工具名和\"删除或覆盖\"类别估", () => {
  test.each<[string, ToolCallPart, ToolNature]>([
    ["读文件", tool("read"), "look"],
    ["列目录", tool("ls"), "look"],
    ["搜索内容", tool("grep"), "look"],
    ["查找文件", tool("find"), "look"],
    ["git 状态和差异", tool("git_status_diff"), "look"],
    ["读项目档案", tool("read_project_records"), "look"],
    ["查看板", tool("view_board"), "look"],
    ["写文件（没命中删除或覆盖：新文件）", tool("write"), "act"],
    ["写文件命中删除或覆盖（整个覆盖已有的文件）", tool("write", { categoryTitles: ["删除或覆盖"] }), "modify"],
    ["改文件（局部编辑）", tool("edit"), "modify"],
    ["通用 bash（哪怕只是 ls）", tool("bash", { genericBash: true, argsSummary: "ls -la" }), "act"],
    ["git 提交", tool("git_commit"), "act"],
    ["推送", tool("git_push", { argsSummary: "remote=origin branch=main force=false" }), "act"],
    ["强推", tool("git_push", { argsSummary: "remote=origin branch=main force=true" }), "modify"],
    ["改提醒", tool("update_reminder"), "modify"],
    ["取消提醒", tool("cancel_reminder"), "modify"],
    ["自行调整计划", tool("revise_plan"), "modify"],
    ["写回进展（整份换掉）", tool("write_progress"), "modify"],
    ["建提醒", tool("create_reminder"), "act"],
    ["工具名像删除", tool("delete_files"), "modify"],
    ["工具名像移除", tool("removeTag"), "modify"],
    ["命中删除或覆盖（带括号的全称）", tool("move_files", { categoryTitles: ["以我的名义对外发送或发布", "删除或覆盖（项目档案和工作目录内）"] }), "modify"],
    ["读文件命中了别的类别", tool("read", { categoryTitles: ["越出项目目录"] }), "look"],
    // 173 号票：带了类别 id 的按 id 认，不看名字（名字按记下时的语言写）
    ["带类别 id：命中删除或覆盖（英文的名字）", tool("write", { categories: ["delete_or_overwrite"], categoryTitles: ["Deleting or overwriting (in project records and working folders)"] }), "modify"],
    ["带类别 id：没命中删除或覆盖，名字里有那几个字也不算", tool("write", { categories: ["outside_project"], categoryTitles: ["删除或覆盖"] }), "act"],
  ])("%s", (_name, part, nature) => {
    expect(toolNatureOf(part)).toBe(nature);
  });
});

const at = (n: number) => `2026-10-09T10:00:0${n}.000+08:00`;

describe("一条：只有工具调用组有，取组里算进 N 的调用里最重的", () => {
  const C = "maintainer:tn-1";
  const msg = (seq: number, speaker: "user" | "agent", parts: MessagePart[]): EventFrame => frame(C, seq, "message", { message: { id: `m${seq}`, conversation: C, speaker, time: at(seq), parts } });

  test("只看的一组、有动手的一组、有删改的一组；用户消息和回复没有", () => {
    const state = replay([
      msg(1, "user", [{ type: "text", text: "看看" }]),
      msg(2, "agent", [tool("read"), tool("ls"), { type: "text", text: "看完了" }]),
      msg(3, "agent", [tool("read"), tool("write"), { type: "text", text: "写好了" }]),
      msg(4, "agent", [tool("write"), tool("delete_files"), tool("read"), { type: "text", text: "删了" }]),
    ]);
    const items = chatItems(state, C);
    expect(items.map((it) => [it.kind, chatItemNature(it)])).toEqual([
      ["user", undefined],
      ["tool_group", "look"],
      ["reply", undefined],
      ["tool_group", "act"],
      ["reply", undefined],
      ["tool_group", "modify"],
      ["reply", undefined],
    ]);
  });
});
