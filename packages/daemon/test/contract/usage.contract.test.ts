// pi 契约测试：每次模型调用的用量（规格第 16 节、Testing Decisions 切面 3，24 号票）。
// token 账本靠子进程上报的 usage：每次模型调用一条，输入分成命中缓存的（cacheRead）和没命中的（input、cacheWrite），外加输出。
// - 剧本给定的用量原样到达：faux 的回复带 usage 时，子进程照它上报（主切面靠它让账本的数和剧本对得上）；
// - pi 自己算的用量：同一个会话里第二次调用，前缀命中缓存的部分记在 cacheRead（真模型的缓存命中走的也是这一项）；
// - 压缩会话生成摘要的那次模型调用也报一条（purpose: compaction）；
// - 真实 provider 的换算：pi 的 openai-completions 解析录好的流式响应（本机回放，不联网），子进程报的三块输入换成账本的
//   命中 / 未命中后，和 provider 自己报的缓存命中、输入总数对得上。pi 升级改了这几个字段的含义时这里会红。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { ledgerTokens } from "../../src/ledger/index.ts";
import { DEEPSEEK_STREAM, OPENROUTER_STREAM, type ProviderUsageSample } from "../fixtures/provider-usage-streams.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";

/** 一段约 2.5 万 token 的材料 */
const long = (n: number) => `材料${n}：${"一段很长的材料。".repeat(12_500)}`;

/** 本机起一个只回放这份样本的 chat completions 服务（测试结束关掉），返回它的地址 */
async function replayProvider(sample: ProviderUsageSample): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(sample.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe("pi 契约：用量", () => {
  it("每次模型调用一条用量：剧本给定的缓存命中、未命中和输出原样到达，一回合里调了几次就有几条，各自对得上那次的定稿消息", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-usage",
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "ls", arguments: { path: "." } }], usage: { cacheHit: 1200, cacheMiss: 300, output: 40 } },
        { kind: "reply", text: "看过了", usage: { cacheHit: 1500, cacheMiss: 80, output: 25 } },
      ]),
      tools: ["ls"],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看一眼目录" });
    const first = await log.next("message_final");
    const second = await log.next("message_final");
    expect((await log.next("turn_end")).outcome).toBe("completed");

    expect(log.ofType("usage")).toEqual([
      { type: "usage", messageId: first.messageId, provider: "faux", modelId: "faux-1", input: 300, cacheRead: 1200, cacheWrite: 0, output: 40, totalTokens: 1540 },
      { type: "usage", messageId: second.messageId, provider: "faux", modelId: "faux-1", input: 80, cacheRead: 1500, cacheWrite: 0, output: 25, totalTokens: 1605 },
    ]);
  });

  it("pi 自己算的用量：同一个会话里第二次调用，和上一次相同的前缀算作命中缓存（cacheRead），其余是没命中的输入", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-usage-cache",
      model: fauxModel([
        { kind: "reply", text: "第一句回复" },
        { kind: "reply", text: "第二句回复" },
      ]),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "第一个问题，写得长一点，好让前缀有点分量。".repeat(4) });
    await log.next("turn_end");
    agent.send({ type: "user_input", inputId: "in-2", text: "第二个问题" });
    await log.next("turn_end");

    const [first, second] = log.ofType("usage");
    // 第一次没有可命中的前缀
    expect(first).toMatchObject({ cacheRead: 0 });
    expect(first!.input + first!.cacheWrite).toBeGreaterThan(0);
    expect(first!.output).toBeGreaterThan(0);
    // 第二次：上一轮的整段上下文是前缀，命中缓存；新加的那句是没命中的
    expect(second!.cacheRead).toBeGreaterThan(0);
    expect(second!.input + second!.cacheWrite).toBeGreaterThan(0);
    expect(second!.totalTokens).toBe(second!.input + second!.cacheRead + second!.cacheWrite + second!.output);
  });

  it("压缩会话生成摘要的那次模型调用也报一条用量（purpose: compaction），数是那次调用的", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-usage-compaction",
      model: fauxModel([
        // 前三次的用量由 faux 按上下文估算（pi 据此判断会话够不够大、从哪里切）
        { kind: "reply", text: "收到了第一段" },
        { kind: "reply", text: "收到了第二段" },
        { kind: "reply", text: "好" },
        // 压缩时写摘要的那次模型调用
        { kind: "reply", text: "摘要：用户发过两大段材料", usage: { cacheHit: 0, cacheMiss: 25_100, output: 300 } },
      ]),
      tools: [],
    });
    await log.next("ready");
    // 前两轮都很长：pi 留最近约 2 万 token（第二轮起），第一轮写进摘要；第三轮很短
    agent.send({ type: "user_input", inputId: "in-1", text: long(1) });
    await log.next("turn_end");
    agent.send({ type: "user_input", inputId: "in-2", text: long(2) });
    await log.next("turn_end");
    agent.send({ type: "user_input", inputId: "in-3", text: "第三句" });
    await log.next("turn_end");
    agent.send({ type: "compact" });

    await expect.poll(() => log.ofType("usage").length, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
    const usages = log.ofType("usage");
    expect(usages[3]).toMatchObject({ purpose: "compaction", messageId: "compaction-1", provider: "faux", modelId: "faux-1", input: 25_100, cacheRead: 0, cacheWrite: 0, output: 300 });
    expect(usages.slice(0, 3).every((u) => u.purpose === undefined)).toBe(true);
  });

  it.each([DEEPSEEK_STREAM, OPENROUTER_STREAM])("真实 provider 的换算（$name）：pi 解析录好的流式响应，账本的命中 = cacheRead、未命中 = input + cacheWrite，和 provider 报的对得上", async (sample) => {
    const provider = await replayProvider(sample);
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-usage-provider",
      model: { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off", baseUrl: provider.baseUrl },
      credentials: { deepseek: "sk-test-not-a-real-key" },
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看一眼" });
    const final = await log.next("message_final");
    expect(await log.next("turn_end")).toMatchObject({ outcome: "completed" });
    // 请求确实到了本机回放的服务（没有联网）
    expect(provider.requests).toEqual(["POST /chat/completions"]);
    expect(final.message.parts).toEqual([{ type: "text", text: sample.text }]);

    const [usage] = log.ofType("usage");
    expect(usage).toMatchObject({ messageId: final.messageId, provider: "deepseek", modelId: "deepseek-flash" });
    expect({ cacheHit: usage!.cacheRead, cacheMiss: usage!.input + usage!.cacheWrite, output: usage!.output }).toEqual(sample.ledger);
    // 账本照同一个换算记（ledger/ledger.ts 的 ledgerTokens）
    expect(ledgerTokens(usage!)).toEqual(sample.ledger);
  });
});

