// 主切面：设置里的"模型"（73 号票，规格第 1 节"模型"）。
// - 设置页取、存（GET / POST /api/model-settings）：服务商只有 DeepSeek，默认模型、按 agent 覆盖和思考档位；
// - 一个会话固定一个模型：改了以后下一个新会话生效，正在进行的会话（接着的会话）照它开始时的；记账照实际用的模型；
// - API key 只有状态：接口、日志里都没有 key 的内容，请求体也放不进 key；
// - 319 号票：网页上能填 key（POST /api/model-settings/key）——写进密钥区的文件、GET 马上说配了、现在起的模型调用就用新的，
//   太短、空的、带服务商的回 400；再填一次换掉旧的；响应和日志里都没有 key 的内容；
// - 连通测试在一次性子进程里发一条极短的请求，回首 token 延迟；同一时间只跑一个（再要回 409"上一个还没测完"）；
// - 看图能力：设置页改的为准，其次配置文件写明的，都没写按模型目录；
// - 范围审视用的模型每次审视时现取（和子 agent、评审一样）：维护者拉起之后改了设置，下一次审视就用新的。
// 目录模型（DeepSeek）的请求一律发到本机的假 DeepSeek（helpers/fake-deepseek.ts），从不连真的；key 是假的。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type ModelSettingsBody } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { say } from "../helpers/task-flow.ts";
import { startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { modelSettingsApi, webSettingsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

/** 假的 key（测试里的 key 来源：守护进程环境里的 DEEPSEEK_API_KEY） */
const KEY = fakeSecret("sk-", "main-73-fake-key-Zx81Lq");

const settings = (overrides: Partial<ModelSettingsBody> = {}): ModelSettingsBody => ({
  provider: "deepseek",
  default: { modelId: "deepseek-flash", thinkingLevel: "high" },
  agents: {},
  vision: {},
  ...overrides,
});

const BRIEF = { acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" };

/** 设置页上的一个模型 */
const option = async (url: string, id: string) => (await modelSettingsApi.view(url)).body.models.find((m) => m.modelId === id);

describe("设置里的模型", () => {
  it("设置页取到的：服务商只有 DeepSeek（在服务端调用），可选的模型来自模型目录（各自能不能看图、支持哪几档思考），各个 agent 实际会用的", async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: KEY } });
    const { status, body } = await modelSettingsApi.view(td.url);
    expect(status).toBe(200);
    expect(body.providers).toEqual([{ id: "deepseek", label: "DeepSeek" }]);
    expect(body.settings).toEqual({ provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents: {}, vision: {} });
    const flash = body.models.find((m) => m.modelId === "deepseek-flash");
    const pro = body.models.find((m) => m.modelId === "deepseek-v4-pro");
    expect(flash).toMatchObject({ name: "DeepSeek V4.1 Flash", inCatalog: true, vision: true, visionSource: "catalog", thinkingLevels: ["off", "low", "high"] });
    expect(pro).toMatchObject({ inCatalog: true, vision: false, visionSource: "catalog", thinkingLevels: ["off", "high"] });
    expect(body.effective.scope_review).toEqual({ modelId: "deepseek-flash", thinkingLevel: "high" });
    expect(body.catalogError).toBeUndefined();
  }, 30_000);

  it("API key 只有状态：配了、从环境变量 DEEPSEEK_API_KEY 来（LSM 从密钥区的文件注入）；接口和日志里都没有 key 的内容，请求体也放不进 key", async () => {
    const logs: string[] = [];
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: KEY }, catalogBaseUrl: fake.baseUrl, log: (line) => logs.push(line) });
    const { body } = await modelSettingsApi.view(td.url);
    expect(body.apiKey).toEqual({ configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: false });
    // 存设置、连通测试（不通的那次 provider 的报错带着 key 的末尾几位）之后，接口回的、日志里的都没有 key 的内容
    const texts = [await modelSettingsApi.viewText(td.url)];
    texts.push(JSON.stringify((await modelSettingsApi.change(td.url, settings({ agents: { reviewer: { thinkingLevel: "low" } } }))).body));
    texts.push(JSON.stringify((await modelSettingsApi.test(td.url)).body));
    fake.unauthorized();
    const failed = await modelSettingsApi.test(td.url);
    expect(failed.body).toMatchObject({ ok: false });
    texts.push(JSON.stringify(failed.body));
    for (const text of [...texts, logs.join("\n")]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(KEY.slice(-4));
    }
    // 请求体里多出来的字段（比如想顺手存个 key）一律拒绝
    const withKey = await modelSettingsApi.change(td.url, { ...settings(), apiKey: KEY });
    expect(withKey.status).toBe(400);
    // 设置文件里也没有
    expect(fs.readFileSync(td.daemon.layout.modelSettingsFile, "utf8")).not.toContain(KEY);

    // 没配 key：说没配
    const none = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined } });
    expect((await modelSettingsApi.view(none.url)).body.apiKey.configured).toBe(false);
  }, 60_000);

  it("在网页上填模型的 key（319 号票）：没配时 GET 说没配；填一个就写进密钥区的文件、GET 说配了、现在起的模型调用就用新的；太短、空的回 400；再填一次换掉旧的", async () => {
    const logs: string[] = [];
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined }, catalogBaseUrl: fake.baseUrl, log: (line) => logs.push(line) });
    const FILLED = fakeSecret("sk-", "main-319-filled-in-web-K4v7");
    const AGAIN = fakeSecret("sk-", "main-319-replaced-B8n2");
    const file = path.join(td.daemon.layout.secrets, "deepseek-api-key.txt");

    expect((await modelSettingsApi.key(td.url)).body.apiKey.configured).toBe(false);
    expect(fs.existsSync(file)).toBe(false);

    // 填一个：写进密钥区的文件（就 key 一行），回的只有状态
    const saved = await modelSettingsApi.keySet(td.url, FILLED);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      configured: true,
      effective: "now",
      apiKey: { configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: false },
    });
    expect(JSON.stringify(saved.body)).not.toContain(FILLED);
    expect(fs.readFileSync(file, "utf8")).toBe(`${FILLED}\n`);
    expect(fs.readdirSync(td.daemon.layout.secrets)).toEqual(["deepseek-api-key.txt"]);
    expect((await modelSettingsApi.key(td.url)).body.apiKey.configured).toBe(true);
    // 联网设置里 DeepSeek 的 key 也跟着成"配了"（319 号票：联网工具也从现在用的那一份取）
    expect((await webSettingsApi.view(td.url)).body.deepseekKey.configured).toBe(true);
    // 现在起的模型调用（连通测试发到本机的假 DeepSeek）带的是新 key
    expect((await modelSettingsApi.test(td.url)).body).toMatchObject({ ok: true });
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${FILLED}`);

    // 再填一次：换掉旧的
    expect((await modelSettingsApi.keySet(td.url, `  ${AGAIN}\r\n`)).status).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe(`${AGAIN}\n`);

    // 空的、只有空白、太短的、带了服务商或别的字段的：400，文件不动
    for (const bad of [{ key: "" }, { key: " \r\n " }, { key: "sk-短" }, { key: AGAIN, provider: "deepseek" }, {}]) {
      expect((await modelSettingsApi.keySet(td.url, bad)).status).toBe(400);
    }
    expect((await modelSettingsApi.keySet(td.url, { key: "sk-短" })).body.message).toMatch(/太短/);
    expect(fs.readFileSync(file, "utf8")).toBe(`${AGAIN}\n`);
    // 日志里没有 key 的内容
    for (const key of [FILLED, AGAIN]) {
      expect(logs.join("\n")).not.toContain(key);
      expect(logs.join("\n")).not.toContain(key.slice(-4));
    }
  }, 60_000);

  it("填好 key 不用重启：秘书下一条消息之前按新的重新拉起，发给模型的请求带的就是新 key（319 号票）", { timeout: 90_000 }, async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ modelsFromSettings: ["secretary"], catalogBaseUrl: fake.baseUrl, env: { DEEPSEEK_API_KEY: undefined } });
    const FILLED = fakeSecret("sk-", "main-319-now-secretary-T6q3");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("在吗");
    // 这一轮没有 key：回"还没配模型"，一次模型请求都没发出去（先把这一轮等完）
    const note = async () =>
      (await frontend.history(CHANNELS.secretary)).messages
        .flatMap((m) => ("message" in m && m.message.speaker === "system" ? m.message.parts : []))
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
    let first = "";
    for (const deadline = Date.now() + 30_000; first === "" && Date.now() < deadline; ) {
      first = await note();
      if (first === "") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(first).toContain("还没配模型");
    expect(fake.requests).toHaveLength(0);

    // 网页上填一个：下一条消息之前秘书的主线会话按新的重新拉起，模型请求带的是新 key
    expect((await modelSettingsApi.keySet(td.url, FILLED)).status).toBe(200);
    await frontend.sendText("现在呢");
    await waitUntil(() => fake.requests.length >= 1, { timeoutMs: 30_000, describe: () => "等填好 key 之后秘书发的模型请求" });
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${FILLED}`);
  });

  it("改默认模型、按 agent 覆盖和思考档位：下一个新会话生效，正在进行的会话（闲置退出后接着的）照它开始时的；记账照实际用的模型", async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({
      modelsFromSettings: ["maintainer"],
      catalogBaseUrl: fake.baseUrl,
      env: { DEEPSEEK_API_KEY: KEY },
      config: { agents: { idleMinutes: 0.02 } },
    });
    const frontend = await TestFrontend.connect(td.url);
    const wake = (title: string) => {
      const task = td.daemon.tasks.createByRequest({ title, summary: title });
      td.daemon.tasks.writeBrief(task.id, { goal: title, ...BRIEF });
      return task;
    };

    // 第一个任务的维护者：默认的 deepseek-flash、思考高
    wake("A 的调研");
    await waitUntil(() => fake.requests.length === 1, { timeoutMs: 20_000, describe: () => JSON.stringify(fake.requests.map((r) => r.body.model)) });
    expect(fake.requests[0]!.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "enabled" } });

    // 任务维护者改成 v4-pro、不开思考
    const changed = await modelSettingsApi.change(td.url, settings({ agents: { task_maintainer: { modelId: "deepseek-v4-pro", thinkingLevel: "off" } } }));
    expect(changed.status).toBe(200);
    expect(changed.body.effective.task_maintainer).toEqual({ modelId: "deepseek-v4-pro", thinkingLevel: "off" });
    expect(changed.body.effective.project_maintainer).toEqual({ modelId: "deepseek-flash", thinkingLevel: "high" });

    // 第一个维护者闲置退出后再对它说话：接着原来的会话，照它开始时的 flash、思考高
    await waitUntil(() => !td.daemon.agents.live().some((a) => a.agentId === "tm-1"), { timeoutMs: 20_000 });
    await frontend.sendText("再查一下来源", { conversation: maintainerChannel("tm-1") });
    await waitUntil(() => fake.requests.length === 2, { timeoutMs: 20_000 });
    expect(fake.requests[1]!.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "enabled" } });

    // 新任务的维护者是新会话：用新的
    wake("B 的调研");
    await waitUntil(() => fake.requests.length === 3, { timeoutMs: 20_000 });
    expect(fake.requests[2]!.body).toMatchObject({ model: "deepseek-v4-pro", thinking: { type: "disabled" } });

    // 账本照实际用的模型记
    await waitUntil(() => td.daemon.ledger.entries().filter((e) => e.agentId.startsWith("tm-")).length === 3);
    expect(td.daemon.ledger.entries().filter((e) => e.agentId.startsWith("tm-")).map((e) => [e.agentId, e.model])).toEqual([
      ["tm-1", "deepseek/deepseek-flash"],
      ["tm-1", "deepseek/deepseek-flash"],
      ["tm-2", "deepseek/deepseek-v4-pro"],
    ]);
  }, 90_000);

  it("秘书只有一条长期主线会话：重启后接着它、照它开始时的模型（设置页上看得到主线会话现在用的）；停机时改了秘书的模型，用户的下一条消息时才换（83 号票）", async () => {
    const fake = await startFakeDeepSeek();
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const options = { reuse: { dataDir, homeDir }, modelsFromSettings: ["secretary"] as const, catalogBaseUrl: fake.baseUrl, env: { DEEPSEEK_API_KEY: KEY } };
    const first = await startTestDaemon(options);
    const frontend = await TestFrontend.connect(first.url);
    await frontend.sendText("在吗");
    await waitUntil(() => fake.requests.length === 1, { timeoutMs: 20_000 });
    expect(fake.requests[0]!.body.model).toBe("deepseek-flash");
    expect((await modelSettingsApi.change(first.url, settings({ agents: { secretary: { modelId: "deepseek-v4-pro" } } }))).status).toBe(200);
    await first.daemon.stop();

    // 重启：接着主线会话，照它开始时的 flash（还没有消息，不换）
    const second = await startTestDaemon(options);
    await waitUntil(() => second.daemon.secretary.sessionModel !== undefined, { timeoutMs: 20_000 });
    const view = (await modelSettingsApi.view(second.url)).body;
    expect(view.effective.secretary).toEqual({ modelId: "deepseek-v4-pro", thinkingLevel: "high" });
    expect(view.secretarySession).toEqual({ modelId: "deepseek-flash", thinkingLevel: "high", vision: true });
    expect(fake.requests).toHaveLength(1);
    // 用户的下一条消息：先用 flash 写交接摘要，再用 v4-pro 回复（换模型的细节见 model-switch.test.ts）
    const again = await TestFrontend.connect(second.url);
    await again.sendText("还在吗");
    await waitUntil(() => fake.requests.length === 3, { timeoutMs: 30_000 });
    expect(fake.requests.map((r) => r.body.model)).toEqual(["deepseek-flash", "deepseek-flash", "deepseek-v4-pro"]);
    expect((await modelSettingsApi.view(second.url)).body.secretarySession).toEqual({ modelId: "deepseek-v4-pro", thinkingLevel: "high", vision: false });
  }, 90_000);

  it("连通测试：发一条极短的请求（不开思考），回首 token 延迟；能指定模型；没配 key 时不发请求、说没配", async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: KEY }, catalogBaseUrl: fake.baseUrl });
    const ok = await modelSettingsApi.test(td.url);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, modelId: "deepseek-flash", firstTokenMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(fake.requests.at(-1)!.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, max_tokens: 16 });
    expect((await modelSettingsApi.test(td.url, "deepseek-v4-pro")).body).toMatchObject({ ok: true, modelId: "deepseek-v4-pro" });
    expect(fake.requests.at(-1)!.body.model).toBe("deepseek-v4-pro");
    expect((await modelSettingsApi.test(td.url, "deepseek-nope")).status).toBe(400);

    // 同一时间只跑一个：上一个还没测完（provider 还没回）时再要，回 409"上一个还没测完"，不再发请求；测完了能再测
    fake.hold();
    const sent = fake.requests.length;
    const slow = modelSettingsApi.test(td.url);
    await waitUntil(() => fake.requests.length === sent + 1, { timeoutMs: 20_000 });
    const busy = await modelSettingsApi.test(td.url, "deepseek-v4-pro");
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: "busy", message: "上一个还没测完" });
    expect(fake.requests).toHaveLength(sent + 1);
    fake.release();
    expect((await slow).body).toMatchObject({ ok: true, modelId: "deepseek-flash" });
    expect((await modelSettingsApi.test(td.url)).body).toMatchObject({ ok: true });

    const noKey = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined }, catalogBaseUrl: fake.baseUrl });
    const before = fake.requests.length;
    const result = await modelSettingsApi.test(noKey.url);
    expect(result.body).toMatchObject({ ok: false, error: expect.stringMatching(/没配置 DeepSeek 的 API key/) });
    expect(fake.requests).toHaveLength(before);
  }, 60_000);

  it("范围审视用的模型每次审视时现取：维护者拉起之后把它改成 v4-pro、不开思考，下一次审视（压缩会话时）就用新的；记账照实际用的", async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({
      modelsFromSettings: ["scope_review"],
      catalogBaseUrl: fake.baseUrl,
      env: { DEEPSEEK_API_KEY: KEY },
      maintainer: (id) => (id === "tm-1" ? [say("收到任务书"), say("收到了一大段"), { kind: "context_overflow" }, say("摘要：任务书和一大段材料"), say("好")] : []),
    });
    const TM1 = maintainerChannel("tm-1");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [TM1]: 0 });
    const turns = (n: number) => waitUntil(() => frontend.events({ channel: TM1, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 60_000, describe: () => `等 tm-1 处理完 ${n} 条输入` });
    const task = td.daemon.tasks.createByRequest({ title: "X 的调研", summary: "X 的调研" });
    td.daemon.tasks.writeBrief(task.id, { goal: "调研 X 的现状", ...BRIEF });
    await turns(1);
    // 维护者已经拉起（装配里审视用的是默认的 deepseek-flash）：这时改设置
    expect((await modelSettingsApi.change(td.url, settings({ agents: { scope_review: { modelId: "deepseek-v4-pro", thinkingLevel: "off" } } }))).status).toBe(200);
    await frontend.sendText(`材料：${"一段很长的材料。".repeat(12_500)}`, { conversation: TM1 });
    await turns(2);
    await frontend.sendText("第三句", { conversation: TM1 });

    // 压缩会话时的审视：发到假 DeepSeek 的是新设的模型、不开思考
    await waitUntil(() => fake.requests.length >= 1, { timeoutMs: 60_000, describe: () => "等范围审视的请求" });
    expect(fake.requests.map((r) => r.body.model)).toEqual(["deepseek-v4-pro"]);
    expect(fake.requests[0]!.body.thinking).toEqual({ type: "disabled" });
    // 账本：审视那次记在实际用的模型名下
    await waitUntil(() => td.daemon.ledger.entries().some((e) => e.purpose === "scope_review"), { timeoutMs: 20_000 });
    expect(td.daemon.ledger.entries().filter((e) => e.purpose === "scope_review").map((e) => [e.agentId, e.model])).toEqual([["tm-1", "deepseek/deepseek-v4-pro"]]);
  }, 120_000);

  it("看图能力：没写按模型目录，配置文件写明的其次，设置页改的为准；改了存进设置文件，重启后还在", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const options = { reuse: { dataDir, homeDir }, config: { models: { "deepseek/deepseek-v4-pro": { vision: true } } } };
    const td = await startTestDaemon(options);
    expect(await option(td.url, "deepseek-flash")).toMatchObject({ vision: true, visionSource: "catalog" });
    expect(await option(td.url, "deepseek-v4-pro")).toMatchObject({ vision: true, visionSource: "config", catalogVision: false, configVision: true });
    const changed = await modelSettingsApi.change(td.url, settings({ vision: { "deepseek/deepseek-flash": false } }));
    expect(changed.body.models.find((m) => m.modelId === "deepseek-flash")).toMatchObject({ vision: false, visionSource: "settings", catalogVision: true });
    await td.daemon.stop();
    const again = await startTestDaemon(options);
    expect(await option(again.url, "deepseek-flash")).toMatchObject({ vision: false, visionSource: "settings" });
  }, 60_000);

  it("不合规的设置不存：模型目录里没有的模型、思考档位写错、服务商不支持，都回 400 说清楚", async () => {
    const td = await startTestDaemon();
    const bad = async (body: Record<string, unknown>, message: RegExp) => {
      const res = await modelSettingsApi.change(td.url, body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
    };
    await bad(settings({ default: { modelId: "deepseek-nope", thinkingLevel: "high" } }), /模型目录里没有 deepseek-nope/);
    await bad({ ...settings(), default: { modelId: "deepseek-flash", thinkingLevel: "max" } }, /模型设置的参数不对/);
    await bad(settings({ provider: "openai" }), /不支持服务商 openai/);
    await bad({ ...settings(), agents: { boss: { modelId: "deepseek-flash" } } }, /模型设置的参数不对/);
    expect(fs.existsSync(td.daemon.layout.modelSettingsFile)).toBe(false);
  }, 30_000);
});
