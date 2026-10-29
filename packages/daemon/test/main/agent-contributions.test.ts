// 主切面：agent 贡献缝（128 号票，ADR-0027）。走真实的装配路径：测试用的插件接在插件清单后面（startTestDaemon 的 extraPlugins，
// 和清单里的插件同一条路：插件宿主装配 → agent 贡献模块 → 秘书、agent 宿主的装配 → 宿主协议的通用贡献清单 → 子进程里的桥接扩展）。
// - 插件给"任务的维护者、起草计划的会话"一个工具：起草计划的维护者看得到、调用得了（守卫照它带的登记判、记下调用），
//   执行的会话里没有（按会话种类筛）、秘书看不到（按 agent 筛）；
// - 插件给任务的维护者的每轮上下文跟在交给它的输入后面，被唤起时注入的上下文块在输入之前，系统提示后缀接在系统提示末尾；
// - 秘书也经同一个贡献模块：上下文块、钩子订阅的文字变了，下一条输入之前先送过去（同一个子进程里就是新的）；
// - 插件运行中停用（只有测试用）：贡献撤掉，秘书手头这一条处理完就按新的重新装配。
import { CHANNELS, maintainerChannel, type MessageEventPayload, Type } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { SpawnAgentRequest } from "../../src/agent-manager/agent-manager.ts";
import { defineHostTool } from "../../src/agent-manager/host-tools.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { call, cardWhere, inputsDone, messagesOf, say, textOf, toolCallsOf, twoStagePlan } from "../helpers/task-flow.ts";

const SECRETARY = CHANNELS.secretary;
const TM1 = maintainerChannel("tm-1");
const echo = { kind: "echo_context" } as const;

const probeTool = defineHostTool({
  name: "probe_lookup",
  title: "查探针",
  description: "测试用的插件工具：回一句固定的话",
  parameters: Type.Object({ what: Type.String() }, { additionalProperties: false }),
  readOnlyOrIdempotent: true,
  nature: "look",
  run: (args) => ({ text: `探针查到了：${args.what}` }),
});

/** 测试用的插件：给任务的维护者（工具只给起草计划的会话）、给秘书的各一份；version 是被唤起时注入的那块的版本 */
function probePlugin(state: { version: number }): PluginDefinition {
  return {
    name: "probe",
    title: "探针",
    setup(ctx) {
      ctx.agent.tools.register({ to: { agents: ["task"], sessions: ["planning"] }, tools: () => [probeTool] });
      ctx.agent.context.register({ to: { agents: ["task"] }, when: "input", text: () => "【探针：跟在输入后面】" });
      ctx.agent.context.register({ to: { agents: ["task", "secretary"] }, when: "wake", id: "brief", text: () => `【探针：简报 v${state.version}】` });
      ctx.agent.hooks.register({ to: { agents: ["task", "secretary"] }, id: "rules", kind: "system_prompt_suffix", text: () => `【探针的规矩 v${state.version}】` });
    },
  };
}

/** 一条 agent 消息里的文字（echo_context 回显的上下文） */
const echoes = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent" && textOf(m).includes("[system] "));
/** 回显里第一条用户消息之前列出的工具（会话里还没有别的回显时用） */
const toolsIn = (seen: string) => seen.split("\n").filter((l) => l.startsWith("[tool] ")).map((l) => l.slice("[tool] ".length));
/**
 * 回显里生效的那条系统提示：最后一条顶格的 [system] 到它后面第一条顶格的 [user]。之前的回显作为 agent 的回复留在会话里，
 * 那里的 [system] 跟在 [assistant] 后面，不算
 */
const latestPrompt = (seen: string) => {
  const tail = seen.slice([...seen.matchAll(/^\[system\] /gm)].at(-1)?.index ?? 0);
  return tail.slice(0, tail.search(/^\[user\] /m));
};

describe("agent 贡献缝", () => {
  it("插件给起草计划的任务维护者的工具、每轮上下文、上下文块、系统提示后缀：它看得到、用得了（守卫照登记判）；执行的会话没有这个工具，秘书都看不到", { timeout: 90_000 }, async () => {
    const state = { version: 1 };
    const td = await startTestDaemon({
      extraPlugins: [probePlugin(state)],
      secretary: [echo],
      maintainer: (_id, spawn) => (spawn === 1 ? [call("probe_lookup", { what: "资料" }), submitPlanStep(twoStagePlan()), echo, say("交了")] : [echo, echo]),
    });
    expect(td.daemon.plugins.report().running).toEqual(["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki", "probe"]);
    // 测试接缝：记下拉起维护者的请求（守护进程代为执行的工具、通用贡献清单里插件的那几项）
    const spawned: SpawnAgentRequest[] = [];
    const original = td.daemon.agents.spawn.bind(td.daemon.agents);
    td.daemon.agents.spawn = (request) => {
      spawned.push(request);
      return original(request);
    };
    const maintainerSpawns = () => spawned.filter((r) => r.agentId === "tm-1");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.cards]: 0, [CHANNELS.board]: 0, [TM1]: 0 });

    // 秘书：这三样都只给任务的维护者（上下文块、后缀也给秘书，见下一条）
    await frontend.sendText("你好");
    await inputsDone(frontend, SECRETARY);
    const secretarySeen = textOf(echoes(frontend, SECRETARY).at(-1)!);
    expect(toolsIn(secretarySeen)).not.toContain("probe_lookup");
    expect(secretarySeen).not.toContain("【探针：跟在输入后面】");

    // 起草计划的维护者
    const task = td.daemon.tasks.createByRequest({ title: "调研", summary: "调研" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });
    const card = await cardWhere(frontend, (c) => c.type === "plan", "计划卡");
    await inputsDone(frontend, TM1);
    const planning = textOf(echoes(frontend, TM1).at(-1)!);
    expect(toolsIn(planning)).toContain("probe_lookup");
    // 工具接在每个会话都配的工具后面
    expect(toolsIn(planning).slice(toolsIn(planning).indexOf("send_voice"), toolsIn(planning).indexOf("send_voice") + 2)).toEqual(["send_voice", "probe_lookup"]);
    expect(planning).toContain("[toolResult] probe_lookup: 探针查到了：资料");
    expect(latestPrompt(planning)).toContain("【探针的规矩 v1】");
    const lines = planning.split("\n");
    const brief = lines.indexOf("[user] 【探针：简报 v1】");
    const after = lines.indexOf("[user] 【探针：跟在输入后面】");
    expect(brief).toBeGreaterThan(0);
    // 被唤起时注入的那块在输入之前，每轮的那块紧跟在输入（任务书的通知，好几行）后面
    expect(after).toBeGreaterThan(brief + 1);
    expect(lines.slice(brief + 1, after).filter((l) => /^\[(user|assistant|toolResult)\] /.test(l))).toHaveLength(1);
    // 守卫照工具带的登记判、调用记进会话
    expect(toolCallsOf(frontend, TM1).find((c) => c.tool === "probe_lookup")).toMatchObject({ outcome: "done" });

    expect(maintainerSpawns()).toHaveLength(1);
    expect(maintainerSpawns()[0]!.hostTools?.map((t) => t.name)).toContain("probe_lookup");

    // 确认计划：执行的会话（重新装配）没有这个工具，上下文块、系统提示后缀照样有（文字是新的）
    state.version = 2;
    expect((await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} })).ok).toBe(true);
    const executing = textOf(await eventuallyEcho(frontend, TM1, 2));
    const execution = maintainerSpawns().at(-1)!;
    expect(maintainerSpawns()).toHaveLength(2);
    expect(execution.hostTools?.map((t) => t.name)).not.toContain("probe_lookup");
    expect(execution.contributions).toEqual({
      contextBlocks: [{ id: "probe:brief", text: "【探针：简报 v2】" }],
      hooks: [{ id: "probe:rules", kind: "system_prompt_suffix", text: "【探针的规矩 v2】" }],
    });
    expect(executing).toContain("[user] 【探针：简报 v2】");
    expect(latestPrompt(executing)).toContain("【探针的规矩 v2】");
  });

  it("秘书经同一个贡献模块：上下文块、系统提示后缀的文字变了，同一个子进程里下一条输入之前先送过去；插件运行中停用，秘书重新装配后就没有了", { timeout: 90_000 }, async () => {
    const state = { version: 1 };
    const td = await startTestDaemon({ extraPlugins: [probePlugin(state)], secretary: [echo, echo, echo] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const pid = td.daemon.secretary.pid;

    await frontend.sendText("第一句");
    await inputsDone(frontend, SECRETARY);
    const first = textOf(echoes(frontend, SECRETARY).at(-1)!);
    expect(first).toContain("[user] 【探针：简报 v1】");
    expect(latestPrompt(first)).toContain("【探针的规矩 v1】");

    state.version = 2;
    await frontend.sendText("第二句");
    await inputsDone(frontend, SECRETARY);
    const second = textOf(echoes(frontend, SECRETARY).at(-1)!);
    expect(td.daemon.secretary.pid).toBe(pid);
    // 用户消息是两行：时间标记、原话
    const lines = second.split("\n");
    expect(lines.indexOf("[user] 【探针：简报 v2】")).toBeGreaterThan(lines.indexOf("第一句"));
    expect(lines.indexOf("第二句")).toBeGreaterThan(lines.indexOf("[user] 【探针：简报 v2】"));
    expect(latestPrompt(second)).toContain("【探针的规矩 v2】");
    expect(latestPrompt(second)).not.toContain("【探针的规矩 v1】");

    // 运行中停用（只有测试用）：贡献撤掉，秘书按新的重新装配（新的子进程），没有探针的上下文块和后缀了
    expect(await td.daemon.plugins.disable("probe")).toEqual(["probe"]);
    await frontend.sendText("第三句");
    await inputsDone(frontend, SECRETARY);
    const third = textOf(echoes(frontend, SECRETARY).at(-1)!);
    expect(td.daemon.secretary.pid).not.toBe(pid);
    expect(latestPrompt(third)).not.toContain("【探针的规矩");
    // 第三句（两行：时间标记、原话）前面没有再注入探针的上下文块
    const thirdLines = third.split("\n");
    const at = thirdLines.lastIndexOf("第三句");
    expect(thirdLines[at - 1]!.startsWith("[user] [")).toBe(true);
    expect(thirdLines[at - 2]).not.toMatch(/^\[user\] 【探针/);
  });
});

/** 等维护者会话里第 n 条回显 */
async function eventuallyEcho(frontend: TestFrontend, channel: string, n: number): Promise<MessageEventPayload> {
  for (let i = 0; i < 300; i++) {
    const list = echoes(frontend, channel);
    if (list.length >= n) return list[n - 1]!;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${channel} 里没等到第 ${n} 条回显`);
}


