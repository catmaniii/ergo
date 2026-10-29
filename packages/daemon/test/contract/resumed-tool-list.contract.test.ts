// pi 契约测试：接着会话时工具清单以这次交的为准（273 号票）。
// 开始时和这次拉起时工具清单不一样（插件中途启用、停用：秘书的工具多了几个、少了几个，propose_quick_action 的说明多了几句），
// 接着这个会话时：
// - pi 把工具的变化记成会话里接着的一条系统消息（加了哪些、去掉了哪些；说明改了的算去掉再加上）。原样发给模型时，faux 看到开头一份旧清单、
//   中间一份增减（改了说明的工具出现两次），DeepSeek 的请求里工具按"没变的照旧在前、新加和改了的排到最后"——和新开的会话顺序不同；
// - 二狗在子进程里给每次请求排一遍（agent-child/tool-order.ts）：开头那条系统消息带这次交的全部工具、按这次交的先后，中间不再有工具增减。
//   模型看到的工具清单和同样装配的新会话一样：不重复、先后一致；同一次拉起里前后几次请求的工具清单一字不差（前缀缓存稳）。
// faux 认会话中途的系统消息，照原样列出来（helpers 的 faux 剧本 reply_with_context）；DeepSeek（本机的假 DeepSeek，helpers/fake-deepseek.ts）记下请求体里的 tools。
import { describe, expect, it } from "vitest";
import type { HostToolSpec, ModelSpec } from "../../src/runtime/index.ts";
import { type FakeDeepSeekRequest, startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import type { Daemon } from "../../src/daemon.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const tool = (name: string, description = `${name}（测试用）`): HostToolSpec => ({
  name,
  description,
  parameters: { type: "object", properties: {}, additionalProperties: false },
});

/** 开始时的清单：插件停着 */
const BEFORE = [tool("alpha"), tool("propose_quick_action", "提一个快速动作"), tool("beta")];
/** 插件启用后：中间插进两个，propose_quick_action 的说明多了几句 */
const AFTER = [tool("alpha"), tool("mem_a"), tool("propose_quick_action", "提一个快速动作；记忆命令也走这里"), tool("mem_b"), tool("beta")];

const textOf = (final: { message: { parts: Array<{ type: string; text?: string }> } }) =>
  final.message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
const lines = (seen: string, prefix: string) => seen.split("\n").filter((l) => l.startsWith(prefix));
/** 回显的上下文里第一条用户消息之前的那一段：开头的系统提示和工具清单 */
const headOf = (seen: string) => seen.slice(0, seen.indexOf("\n[user]"));
/** 发给 DeepSeek 的请求里的工具：名字和说明，按先后 */
const toolsOf = (request: FakeDeepSeekRequest) => (request.body.tools as Array<{ function: { name: string; description: string } }>).map((t) => `${t.function.name}：${t.function.description}`);

/**
 * 拉起（faux）、按顺序说几句、每句等这一轮结束；返回每一轮模型看到的上下文。回复是转义成一行的上下文（reply_with_context），
 * 下一次请求里这条回复只占一行，不会被当成工具清单
 */
async function talkFaux(daemon: Daemon, agentId: string, hostTools: HostToolSpec[], inputs: string[], continueSession = true): Promise<string[]> {
  const { agent, log } = spawnTestAgent(daemon, {
    agentId,
    model: fauxModel(inputs.map(() => ({ kind: "reply_with_context" as const, text: "{{context}}" }))),
    tools: ["read"],
    hostTools,
    systemPrompt: "你是测试用的秘书。",
    continueSession,
  });
  await log.next("ready");
  const seen: string[] = [];
  for (const [i, text] of inputs.entries()) {
    agent.send({ type: "user_input", inputId: `${agentId}-${Date.now()}-${i}`, text });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    seen.push(JSON.parse(`"${textOf(log.ofType("message_final").at(-1)!)}"`) as string);
  }
  agent.send({ type: "exit" });
  await agent.exited;
  return seen;
}

describe("pi 契约：接着会话时工具清单以这次交的为准", () => {
  it("faux：插件中途启用后接着会话，开头一份清单就是这次交的（新加的在原位、改了说明的不重复），和新会话一样；再停用照样；同一次拉起里前后两次一样", async () => {
    const { daemon } = await startTestDaemon();
    await talkFaux(daemon, "contract-resume-tools", BEFORE, ["第一句"]);

    // 插件启用：接着同一个会话
    const [first, second] = await talkFaux(daemon, "contract-resume-tools", AFTER, ["第二句", "第三句"]);
    const fresh = (await talkFaux(daemon, "contract-fresh-tools", AFTER, ["新会话"], false))[0]!;
    const expected = ["[tool] read", "[tool] alpha", "[tool] mem_a", "[tool] propose_quick_action", "[tool] mem_b", "[tool] beta"];
    expect(lines(headOf(fresh), "[tool]")).toEqual(expected);
    for (const seen of [first!, second!]) {
      // 原来的对话还在
      expect(seen).toContain("[user] 第一句");
      // 工具只在开头一份、按这次交的先后；会话中途没有工具增减
      expect(lines(headOf(seen), "[tool]")).toEqual(expected);
      expect(lines(seen, "[tool]")).toEqual(expected);
      expect(lines(seen, "[tool-removed]")).toEqual([]);
    }
    // 同一次拉起里前后两次请求，开头那段（系统提示和工具清单）一字不差
    expect(headOf(second!)).toBe(headOf(first!));

    // 插件又停用：接着会话，开头一份就是停用后的清单
    const [third] = await talkFaux(daemon, "contract-resume-tools", BEFORE, ["第四句"]);
    expect(lines(third!, "[tool]")).toEqual(["[tool] read", "[tool] alpha", "[tool] propose_quick_action", "[tool] beta"]);
    expect(lines(third!, "[tool-removed]")).toEqual([]);
    expect(third).toContain("[user] 第三句");
  });

  it("DeepSeek：接着会话时请求里的 tools 和新会话的一样（名字、先后、说明），不重复；同一次拉起里前后两次请求的 tools 一字不差", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    // flash 不认会话中途的系统消息（pi 折叠成开头一条），v4-pro 认（中途的留在原位）：两种都一样
    const models: ModelSpec[] = [
      { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off", baseUrl: provider.baseUrl },
      { kind: "catalog", provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high", baseUrl: provider.baseUrl },
    ];
    const talk = async (agentId: string, model: ModelSpec, hostTools: HostToolSpec[], inputs: number, continueSession = true) => {
      const { agent, log } = spawnTestAgent(daemon, { agentId, model, credentials: { deepseek: fakeSecret("sk-", "test-273-not-a-real-key") }, tools: ["read"], hostTools, systemPrompt: "你是测试用的秘书。", continueSession });
      await log.next("ready");
      const from = provider.requests.length;
      for (let i = 0; i < inputs; i++) {
        agent.send({ type: "user_input", inputId: `${agentId}-${Date.now()}-${i}`, text: "在吗" });
        expect((await log.next("turn_end")).outcome).toBe("completed");
      }
      agent.send({ type: "exit" });
      await agent.exited;
      return provider.requests.slice(from);
    };

    for (const model of models) {
      const id = model.kind === "catalog" ? model.modelId : "faux";
      await talk(`contract-resume-ds-${id}`, model, BEFORE, 1);
      const resumed = await talk(`contract-resume-ds-${id}`, model, AFTER, 2);
      const [fresh] = await talk(`contract-fresh-ds-${id}`, model, AFTER, 1, false);
      const expected = toolsOf(fresh!);
      expect(expected.map((t) => t.split("：")[0])).toEqual(["read", "alpha", "mem_a", "propose_quick_action", "mem_b", "beta"]);
      expect(expected).toContain("propose_quick_action：提一个快速动作；记忆命令也走这里");
      expect(resumed).toHaveLength(2);
      for (const request of resumed) expect(toolsOf(request)).toEqual(expected);
      // 前后两次请求的 tools 一字不差（DeepSeek 的前缀缓存按请求前缀整段匹配）
      expect(JSON.stringify(resumed[1]!.body.tools)).toBe(JSON.stringify(resumed[0]!.body.tools));
    }
  });
});
