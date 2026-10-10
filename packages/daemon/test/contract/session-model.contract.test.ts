// pi 契约测试：一个会话固定一个模型（73 号票，规格第 1 节"模型"），和设置页用的模型探查。
// - 新开的会话用装配参数里的模型和思考档位；接着已有的会话（目录里的模型）照会话开始时 pi 记下的模型和思考档位、子进程记下的
//   看图能力，设置里改了只对新会话生效。ready 报回实际用的（ready.model）；用量照实际用的模型报（账本据此记）。
// - faux（测试）一律照装配参数：剧本按每次拉起给。
// - 73 号票之前开的会话没有记看图能力：第一次接着时按配置和目录定下、记上，之后照记下的。
// - 模型探查（一次性子进程）：列出模型目录里 DeepSeek 的模型（能不能看图、支持哪几档思考，不连网）；连通测试发一条极短的请求
//   （不开思考），回首 token 延迟；出错原因里没有 key 的内容；超时结束子进程、写明超时多久（正式的是 60 秒）。
//   请求都发到本机的假 DeepSeek（helpers/fake-deepseek.ts），不联网。
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { type ModelSpec, PROBE_TIMEOUT_MS, runModelProbe } from "../../src/runtime/index.ts";
import { FAKE_DEEPSEEK_REPLY, startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import type { Daemon } from "../../src/daemon.ts";

const KEY = "sk-test-73-not-a-real-key-9F3k";
const deepseek = (modelId: string, thinkingLevel: "off" | "low" | "high", baseUrl: string): ModelSpec => ({ kind: "catalog", provider: "deepseek", modelId, thinkingLevel, baseUrl });

/** 拉起、说一句话、等这一轮结束；返回 ready 和这一轮的用量 */
async function talk(daemon: Daemon, agentId: string, model: ModelSpec, options: { continueSession?: boolean; vision?: Record<string, boolean> } = {}) {
  const { agent, log } = spawnTestAgent(daemon, {
    agentId,
    model,
    credentials: { deepseek: KEY },
    tools: [],
    continueSession: options.continueSession ?? true,
    ...(options.vision ? { vision: options.vision } : {}),
  });
  const ready = await log.next("ready");
  agent.send({ type: "user_input", inputId: `in-${Date.now()}`, text: "在吗" });
  expect((await log.next("turn_end")).outcome).toBe("completed");
  const usage = log.ofType("usage");
  agent.kill();
  await agent.exited;
  return { ready, usage };
}

describe("pi 契约：一个会话固定一个模型", () => {
  it("新开的会话用装配参数里的；接着已有的会话照它开始时的模型和思考档位（设置改了也不换），用量照实际用的报；另开的会话用新的", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();

    const first = await talk(daemon, "contract-model-pin", deepseek("deepseek-flash", "off", provider.baseUrl));
    expect(first.ready.model).toEqual({ provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off", pinned: false });
    expect(provider.requests.at(-1)!.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });

    // 设置改成 v4-pro、思考高：接着同一个会话照旧是 flash、不开思考（没给 handoff 就不换，报 differs：和装配参数不一样，83 号票）
    const second = await talk(daemon, "contract-model-pin", deepseek("deepseek-v4-pro", "high", provider.baseUrl));
    expect(second.ready.model).toEqual({ provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off", pinned: true, differs: true });
    expect(provider.requests.at(-1)!.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });
    expect(second.usage.map((u) => `${u.provider}/${u.modelId}`)).toEqual(["deepseek/deepseek-flash"]);
    // 请求地址照装配参数的（本机的假服务）
    expect(provider.requests).toHaveLength(2);

    // 另开一个会话：用新的
    const other = await talk(daemon, "contract-model-new", deepseek("deepseek-v4-pro", "high", provider.baseUrl));
    expect(other.ready.model).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high", pinned: false });
    expect(provider.requests.at(-1)!.body).toMatchObject({ model: "deepseek-v4-pro", thinking: { type: "enabled" } });
    expect(other.usage.map((u) => `${u.provider}/${u.modelId}`)).toEqual(["deepseek/deepseek-v4-pro"]);

    // 不接着会话（每次新开）的照装配参数
    const fresh = await talk(daemon, "contract-model-pin", deepseek("deepseek-v4-pro", "high", provider.baseUrl), { continueSession: false });
    expect(fresh.ready.model).toMatchObject({ modelId: "deepseek-v4-pro", pinned: false });
  });

  it("看图能力在会话开始时定下：接着会话时配置改了也照开始时的；73 号票之前开的会话（没记）第一次接着时按配置定下、记上", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    const flash = deepseek("deepseek-flash", "off", provider.baseUrl);

    const first = await talk(daemon, "contract-vision-pin", flash);
    expect(first.ready.vision).toBe(true);
    const second = await talk(daemon, "contract-vision-pin", flash, { vision: { "deepseek/deepseek-flash": false } });
    expect(second.ready.vision).toBe(true);

    // 模拟 73 号票之前开的会话：把记下的那条换成别的类型（条目链不断）
    const file = first.ready.sessionFile;
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll('"customType":"ergou-session-model"', '"customType":"ergou-test-legacy"'));
    const legacy = await talk(daemon, "contract-vision-pin", flash, { vision: { "deepseek/deepseek-flash": false } });
    expect(legacy.ready.vision).toBe(false);
    // 记上了：之后照它（配置不写了也还是关着）
    const after = await talk(daemon, "contract-vision-pin", flash);
    expect(after.ready.vision).toBe(false);
  });

  it("faux 一律照装配参数：接着会话也换成这次的剧本，不算固定", async () => {
    const { daemon } = await startTestDaemon();
    const spawn = (text: string) => {
      const spawned = spawnTestAgent(daemon, { agentId: "contract-model-faux", model: fauxModel([{ kind: "reply", text }]), tools: [], continueSession: true });
      return spawned;
    };
    const a = spawn("第一次");
    expect((await a.log.next("ready")).model).toEqual({ provider: "faux", modelId: "faux-1", thinkingLevel: "off", pinned: false });
    a.agent.send({ type: "user_input", inputId: "in-1", text: "在吗" });
    await a.log.next("turn_end");
    a.agent.kill();
    await a.agent.exited;
    const b = spawn("第二次");
    expect((await b.log.next("ready")).model).toMatchObject({ provider: "faux", pinned: false });
    b.agent.send({ type: "user_input", inputId: "in-2", text: "还在吗" });
    expect((await b.log.next("message_final")).message.parts).toEqual([{ type: "text", text: "第二次" }]);
  });
});

describe("pi 契约：模型探查（设置里的模型页）", () => {
  it("列出模型目录里 DeepSeek 的模型：名字、能不能看图（flash 能、v4-pro 不能）、支持哪几档思考；不连网、不要凭据", async () => {
    const { daemon } = await startTestDaemon();
    const result = await daemon.agents.probeModels({ type: "catalog", provider: "deepseek" });
    expect(result.type).toBe("catalog");
    if (result.type !== "catalog") return;
    const byId = Object.fromEntries(result.models.map((m) => [m.modelId, m]));
    expect(byId["deepseek-flash"]).toEqual({ modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash", vision: true, thinkingLevels: ["off", "low", "high"] });
    expect(byId["deepseek-v4-pro"]).toMatchObject({ vision: false, thinkingLevels: ["off", "high"] });
    // 别的服务商的不在里面
    expect(await daemon.agents.probeModels({ type: "catalog", provider: "no-such-provider" })).toEqual({ type: "catalog", models: [] });
  });

  it("连通测试：发一条极短的请求（不开思考、只要几个 token），回首 token 延迟；key 交给了 provider", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    const result = await daemon.agents.probeModels({ type: "ping", model: deepseek("deepseek-flash", "high", provider.baseUrl), credentials: { deepseek: KEY } });
    expect(result).toMatchObject({ type: "ping", ok: true });
    if (result.type !== "ping") return;
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(result.totalMs).toBeGreaterThanOrEqual(result.firstTokenMs!);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, max_tokens: 16 });
    expect(provider.requests[0]!.authorization === `Bearer ${KEY}`).toBe(true);
    expect(FAKE_DEEPSEEK_REPLY.length).toBeGreaterThan(0);
  });

  it("连通测试不通：结果里 ok 为假、写明原因，原因里没有 key 的内容（provider 的报错带着 key 的末尾几位也去掉）", async () => {
    const provider = await startFakeDeepSeek();
    provider.unauthorized();
    const { daemon } = await startTestDaemon();
    const result = await daemon.agents.probeModels({ type: "ping", model: deepseek("deepseek-flash", "off", provider.baseUrl), credentials: { deepseek: KEY } });
    expect(result).toMatchObject({ type: "ping", ok: false });
    if (result.type !== "ping") return;
    expect(result.error).toMatch(/401|Authentication/);
    expect(result.error).not.toContain(KEY);
    expect(result.error).not.toContain(KEY.slice(-4));
  });

  it("连通测试超时：结束子进程，出错原因写明\"连通测试超时（多少秒）\"（正式的等 60 秒，这里配成 3 秒；provider 一直不回）", async () => {
    const provider = await startFakeDeepSeek();
    provider.hold();
    expect(PROBE_TIMEOUT_MS).toBe(60_000);
    const request = { type: "ping", model: deepseek("deepseek-flash", "off", provider.baseUrl), credentials: { deepseek: KEY } } as const;
    await expect(runModelProbe(request, { env: buildChildEnv(process.env), timeoutMs: 3000 })).rejects.toThrow("连通测试超时（3 秒），结束了子进程");
  }, 30_000);

  it("连通测试用 faux：照剧本回话，量得到首 token", async () => {
    const { daemon } = await startTestDaemon();
    const result = await daemon.agents.probeModels({ type: "ping", model: fauxModel([{ kind: "reply", text: "在" }]), credentials: {} });
    expect(result).toMatchObject({ type: "ping", ok: true, firstTokenMs: expect.any(Number) });
  });
});
