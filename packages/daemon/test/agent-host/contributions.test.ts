// agent 贡献模块（128 号票）：按给谁（哪种 agent、哪种会话、此刻的工具包）筛插件的工具、上下文块、钩子订阅；登记都能撤销、撤了通知。
// 经插件宿主登记、停用时撤掉在 test/plugins/host.test.ts，走真实装配路径的在 test/main/agent-contributions.test.ts。
// 212 号票：工具排在哪（at: "end"，内核的工具之后）、输入附注（接在那条输入自己的文字末尾），走真实装配路径的在 test/main/browsing-plugin.test.ts。
import { type PlanToolkit, Type } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createAgentContributions, type ContributionTarget } from "../../src/agent-host/contributions.ts";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";

const tool = (name: string) => defineHostTool({ name, title: name, description: name, parameters: Type.Object({}), readOnlyOrIdempotent: true, run: () => ({ text: name }) });
const secretary: ContributionTarget = { agent: "secretary", agentId: "secretary", session: "secretary" };
const maintainer = (toolkit: Partial<PlanToolkit>, session: ContributionTarget["session"] = "execution"): ContributionTarget => ({
  agent: "task",
  agentId: "tm-1",
  session,
  toolkit: { skills: [], mcp: [], bash: false, network: false, ...toolkit },
});

describe("agent 贡献模块", () => {
  it("按哪种 agent、哪种会话、工具包筛：工具包的条件不给没有工具包的秘书", () => {
    const contributions = createAgentContributions({ log: () => {} });
    contributions.tools.register({ tools: () => [tool("everyone")] });
    contributions.tools.register({ to: { agents: ["task", "project"], sessions: ["execution", "plain"] }, tools: () => [tool("working")] });
    contributions.tools.register({ to: { toolkit: (t) => t.network }, tools: () => [tool("online")] });
    expect(contributions.toolsFor(secretary).map((t) => t.spec.name)).toEqual(["everyone"]);
    expect(contributions.toolsFor(maintainer({ network: true })).map((t) => t.spec.name)).toEqual(["everyone", "working", "online"]);
    expect(contributions.toolsFor(maintainer({ network: false }, "planning")).map((t) => t.spec.name)).toEqual(["everyone"]);
  });

  it("工具重名的只留第一个、记一行日志；上下文块、钩子订阅的 id 不能重复；这一回没有内容的文字是空的（id 照样在）", () => {
    const logs: string[] = [];
    const contributions = createAgentContributions({ log: (line) => logs.push(line) });
    contributions.tools.register({ tools: () => [tool("dup")] });
    contributions.tools.register({ tools: () => [tool("dup"), tool("other")] });
    expect(contributions.toolsFor(secretary).map((t) => t.spec.name)).toEqual(["dup", "other"]);
    expect(logs).toEqual(["插件贡献的工具 dup 重名了，给 secretary 的只留第一个"]);

    contributions.context.register({ when: "wake", id: "p:brief", text: () => undefined });
    contributions.hooks.register({ id: "p:rules", kind: "compaction_instructions", text: () => "写短一点" });
    expect(() => contributions.hooks.register({ id: "p:brief", kind: "system_prompt_suffix", text: () => "" })).toThrow(/已经有了/);
    expect(() => contributions.context.register({ when: "wake", id: "p:rules", text: () => "" })).toThrow(/已经有了/);
    expect(contributions.manifestFor(secretary)).toEqual({ contextBlocks: [{ id: "p:brief", text: "" }], hooks: [{ id: "p:rules", kind: "compaction_instructions", text: "写短一点" }] });
  });

  it("跟在输入后面的几块空一行拼在一起（没有内容的不算）；登记、撤销都通知，撤了就没有了", () => {
    const contributions = createAgentContributions({ log: () => {} });
    const changes: number[] = [];
    contributions.onChange(() => changes.push(changes.length + 1));
    const offA = contributions.context.register({ when: "input", text: (message) => `【A】${message.id}` });
    contributions.context.register({ when: "input", text: () => undefined });
    contributions.context.register({ to: { agents: ["task"] }, when: "input", text: () => "【只给维护者】" });
    const message = { id: "m-1" } as never;
    expect(contributions.inputContextFor(secretary, message)).toBe("【A】m-1");
    expect(contributions.inputContextFor(maintainer({}), message)).toBe("【A】m-1\n\n【只给维护者】");
    offA();
    offA();
    expect(contributions.inputContextFor(secretary, message)).toBeUndefined();
    expect(changes).toEqual([1, 2, 3, 4]);
  });

  it("266 号票：跟在输入后面的块可以是异步算的（记忆简报要检索）——有一块是异步的就整个等齐了再拼，先后照登记的；回话要带的 part 按给谁收齐", async () => {
    const contributions = createAgentContributions({ log: () => {} });
    contributions.context.register({ when: "input", text: async (message) => `【简报】${message.id}`, replyParts: () => [{ type: "text", text: "简报的部分" }] });
    contributions.context.register({ when: "input", text: () => "【顺口问】" });
    contributions.context.register({ when: "input", text: async () => undefined, replyParts: () => undefined });
    contributions.context.register({ to: { agents: ["task"] }, when: "input", text: () => "【只给维护者】", replyParts: () => [{ type: "text", text: "维护者的" }] });
    const message = { id: "m-1" } as never;
    const pending = contributions.inputContextFor(secretary, message);
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe("【简报】m-1\n\n【顺口问】");
    expect(contributions.replyPartsFor(secretary, message)).toEqual([{ type: "text", text: "简报的部分" }]);
    expect(contributions.replyPartsFor(maintainer({}), message)).toEqual([
      { type: "text", text: "简报的部分" },
      { type: "text", text: "维护者的" },
    ]);
    // 异步的那块出错：当它没有，别的照拼
    const failing = createAgentContributions({ log: () => {} });
    failing.context.register({ when: "input", text: () => Promise.reject(new Error("坏了")) });
    failing.context.register({ when: "input", text: () => "【留着】" });
    expect(await failing.inputContextFor(secretary, message)).toBe("【留着】");
  });

  it("212 号票：写着 at: \"end\" 的工具只在 end 那一处给（排在内核的工具之后），重名按两处合起来认", () => {
    const logs: string[] = [];
    const contributions = createAgentContributions({ log: (line) => logs.push(line) });
    contributions.tools.register({ tools: () => [tool("early"), tool("both")] });
    const off = contributions.tools.register({ to: { agents: ["secretary"] }, at: "end", tools: () => [tool("late"), tool("both")] });
    expect(contributions.toolsFor(secretary).map((t) => t.spec.name)).toEqual(["early", "both"]);
    expect(contributions.toolsFor(secretary, "end").map((t) => t.spec.name)).toEqual(["late"]);
    expect(contributions.toolsFor(maintainer({}), "end")).toEqual([]);
    expect(logs).toEqual(["插件贡献的工具 both 重名了，给 secretary 的只留第一个"]);
    off();
    expect(contributions.toolsFor(secretary, "end")).toEqual([]);
  });

  it("212 号票：输入附注按给谁筛、几条换行拼在一起（没有内容的不算）；登记、撤销都通知，撤了就没有了", () => {
    const contributions = createAgentContributions({ log: () => {} });
    const changes: number[] = [];
    contributions.onChange(() => changes.push(changes.length + 1));
    const off = contributions.notes.register({ to: { agents: ["secretary"] }, text: (message) => `（网页上下文 ${message.id}）` });
    contributions.notes.register({ text: () => "" });
    contributions.notes.register({ to: { agents: ["task"] }, text: () => "（只给维护者）" });
    const message = { id: "m-1" } as never;
    expect(contributions.inputNoteFor(secretary, message)).toBe("（网页上下文 m-1）");
    expect(contributions.inputNoteFor(maintainer({}), message)).toBe("（只给维护者）");
    off();
    expect(contributions.inputNoteFor(secretary, message)).toBeUndefined();
    expect(changes).toEqual([1, 2, 3, 4]);
  });
});
