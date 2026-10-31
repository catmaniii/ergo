// 自定义（OpenAI 兼容）服务商（provider id 固定是 custom，自定义服务商这一步）的守护进程这一侧：
// - 设置里存/取 custom（地址、模型 id、接口风格），模型一律按 custom.modelId；旧设置文件没有这一项时行为完全不变；
// - 拉起 agent 的装配里带上它（用 fixtures/echo-assembly-child.ts 把"启动"收到的装配参数交回来核对），密钥不在装配里；
// - 子进程里登记这个 provider 之后 getModel("custom", …) 认得、连通测试的请求真的打到本机的假 OpenAI 兼容服务
//   （helpers/fake-openai.ts，不联网），成功、失败各一条；
// - CUSTOM_MODEL_API_KEY 收在 credentials 的 custom 名下；列模型两种结果；出错原因里没有 key 的内容。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTOM_PROVIDER_ID } from "@ergo/protocol";
import { describe, expect, it, vi } from "vitest";
import { createAgentManager } from "../src/agent-manager/agent-manager.ts";
import { dataDirLayout } from "../src/config/data-dir.ts";
import { modelCredentials } from "../src/config/secrets.ts";
import { RequestRejected } from "../src/errors.ts";
import { createModelSettings, DEFAULT_MODEL_SETTINGS, type ModelProvider, type ModelSettingsOptions } from "../src/model-settings/index.ts";
import { buildChildEnv } from "../src/process/child-env.ts";
import { piRuntime, runModelProbe, type RunModelProbeOptions } from "../src/runtime/index.ts";
import { fakeSecret } from "./helpers/fake-secrets.ts";
import { startFakeOpenAI } from "./helpers/fake-openai.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const KEY = fakeSecret("sk-", "unit-custom-not-a-real-key-Q8z2");

/** 用户填的那一份（地址末尾不带斜杠；设置里存的就是收拾过的样子） */
const CUSTOM = { baseUrl: "https://api.example.com/v1", modelId: "my-model" } as const;

/** 把"启动"收到的装配参数写回文件的子进程（不跑模型） */
const ECHO_ENTRY = fileURLToPath(new URL("./fixtures/echo-assembly-child.ts", import.meta.url));

/** 一次性子进程（模型探查）的环境：只带系统变量，和守护进程拉起它时一样 */
const probeOptions = (): RunModelProbeOptions => ({ env: buildChildEnv(process.env, {}), onLog: () => {} });

interface Setup {
  dataDir?: string;
  /** daemon 环境的 credentials（默认只有自定义服务商的 key） */
  credentials?: Record<string, string>;
  /** 数据目录里已经有的设置文件内容（不给就按 provider: custom 写一份；"none" 是不写文件） */
  settingsFile?: unknown | "none";
  /** 模型探查换成假的（不给就真的起一次性子进程、打到本机假服务上） */
  probe?: ModelSettingsOptions["probe"];
  keyApplied?: (provider: ModelProvider, key: string) => void;
}

/** 起一个设置服务：默认设置是"选了自定义服务商、模型 my-model"，模型探查走真的子进程 */
function setup(options: Setup = {}) {
  const dataDir = options.dataDir ?? makeTempDir("ergo-data-");
  const layout = dataDirLayout(dataDir);
  if (options.dataDir === undefined && options.settingsFile !== "none") {
    const settingsFile =
      options.settingsFile === undefined
        ? { format: 1, provider: CUSTOM_PROVIDER_ID, default: { modelId: CUSTOM.modelId, thinkingLevel: "high" }, agents: {}, vision: {}, custom: CUSTOM }
        : options.settingsFile;
    fs.mkdirSync(path.dirname(layout.modelSettingsFile), { recursive: true });
    fs.writeFileSync(layout.modelSettingsFile, JSON.stringify(settingsFile), "utf8");
  }
  const logs: string[] = [];
  const service = createModelSettings({
    layout,
    config: { models: {}, tokenPrices: { currency: "CNY", models: {} } },
    credentials: options.credentials ?? { [CUSTOM_PROVIDER_ID]: KEY },
    probe: options.probe ?? ((request) => runModelProbe(request, probeOptions())),
    lsm: () => false,
    secretarySession: () => undefined,
    ...(options.keyApplied ? { keyApplied: options.keyApplied } : {}),
    log: (line) => logs.push(line),
  });
  return { service, layout, logs, dataDir };
}

/** 假模型探查回的目录：DeepSeek 的两个模型和自定义服务商那一个（设置这一类的用例不用真起子进程） */
const FAKE_CATALOG = [
  { modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash", vision: true, thinkingLevels: ["off", "high"] },
  { modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", vision: false, thinkingLevels: ["off", "high"] },
  { modelId: CUSTOM.modelId, name: CUSTOM.modelId, vision: false, thinkingLevels: ["off"] },
] as const;

/** 只是列目录、不用真子进程的用例用它 */
const fakeCatalogProbe: ModelSettingsOptions["probe"] = async () => ({ type: "catalog", models: FAKE_CATALOG.map((m) => ({ ...m, thinkingLevels: [...m.thinkingLevels] })) });

describe("自定义（OpenAI 兼容）服务商：设置", () => {
  it("设置里选了自定义：模型一律按 custom.modelId，地址和模型 id 交给装配用；写进设置文件，重启后照旧", async () => {
    const { service, layout, dataDir } = setup({
      settingsFile: { format: 1, provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents: {}, vision: {} },
      probe: fakeCatalogProbe,
    });
    // 还没选自定义：装配里没有这一块，模型照 DeepSeek
    expect(service.customProvider()).toBeUndefined();
    expect(service.modelFor("secretary")).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash" });

    await service.change({ provider: CUSTOM_PROVIDER_ID, default: { modelId: "leftover-model", thinkingLevel: "medium" }, agents: { reviewer: { modelId: "other-model", thinkingLevel: "off" } }, vision: {}, custom: CUSTOM });
    // 服务商只有一个模型：default、各 agent 覆盖里写的模型 id 不起作用（思考档位照样按那一行）
    expect(service.customProvider()).toEqual(CUSTOM);
    expect(service.modelFor("secretary")).toEqual({ kind: "catalog", provider: CUSTOM_PROVIDER_ID, modelId: CUSTOM.modelId, thinkingLevel: "medium" });
    expect(service.modelFor("reviewer")).toEqual({ kind: "catalog", provider: CUSTOM_PROVIDER_ID, modelId: CUSTOM.modelId, thinkingLevel: "off" });
    // 写进设置文件；地址末尾的斜杠存的时候去掉
    const saved = JSON.parse(fs.readFileSync(layout.modelSettingsFile, "utf8"));
    expect(saved).toMatchObject({ format: 1, provider: CUSTOM_PROVIDER_ID, custom: CUSTOM });
    expect((await service.view()).settings.custom).toEqual(CUSTOM);
    expect((await service.view()).effective.secretary).toEqual({ modelId: CUSTOM.modelId, thinkingLevel: "medium" });

    // 重启：照文件
    const again = setup({ dataDir, probe: fakeCatalogProbe });
    expect(again.service.customProvider()).toEqual(CUSTOM);
    expect(again.service.modelFor("sub_agent")).toMatchObject({ provider: CUSTOM_PROVIDER_ID, modelId: CUSTOM.modelId });
  });

  it("选了自定义却没填地址和模型 id、地址不是 http(s)、模型 id 是空白：都不收，文件不动", async () => {
    const { service, layout } = setup();
    const rejected = async (body: Parameters<typeof service.change>[0], message: RegExp) => {
      const err = await service.change(body).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RequestRejected);
      expect((err as Error).message).toMatch(message);
    };
    await rejected({ provider: CUSTOM_PROVIDER_ID, default: { modelId: "x", thinkingLevel: "high" }, agents: {}, vision: {} }, /却没填接口地址和模型 id/);
    await rejected({ provider: CUSTOM_PROVIDER_ID, default: { modelId: "x", thinkingLevel: "high" }, agents: {}, vision: {}, custom: { baseUrl: "api.example.com", modelId: "x" } }, /接口地址要以 http:\/\/ 或 https:\/\//);
    await rejected({ provider: CUSTOM_PROVIDER_ID, default: { modelId: "x", thinkingLevel: "high" }, agents: {}, vision: {}, custom: { baseUrl: "https://api.example.com/v1", modelId: "  " } }, /模型 id 不能是空的/);
    // 原来那份没被改
    expect(JSON.parse(fs.readFileSync(layout.modelSettingsFile, "utf8")).custom).toEqual(CUSTOM);
  });

  it("切回 DeepSeek 时原来的 custom 那一块留着（没带就不动），以后再选自定义不用重填", async () => {
    const { service } = setup({ probe: fakeCatalogProbe });
    await service.change({ provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents: {}, vision: {} });
    expect(service.current().provider).toBe("deepseek");
    expect(service.current().custom).toEqual(CUSTOM);
    expect(service.customProvider()).toBeUndefined();
    expect(service.modelFor("secretary")).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash" });
  });

  it("旧设置文件（没有 custom 这一项）照样合规，行为不变：默认 DeepSeek、没有自定义服务商", () => {
    const { service, logs } = setup({ settingsFile: { format: 1, provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents: {}, vision: {} } });
    expect(service.current()).toEqual(DEFAULT_MODEL_SETTINGS);
    expect(service.customProvider()).toBeUndefined();
    expect(logs.filter((l) => l.startsWith("模型设置的文件读不出来"))).toEqual([]);
    // 连设置文件都没有：一样是默认
    expect(setup({ settingsFile: "none" }).service.customProvider()).toBeUndefined();
  });

  it("文件里选了自定义却没有那一块：整份按读不出来处理（用默认、记日志、设置页上提示）", () => {
    const { service, logs } = setup({ settingsFile: { format: 1, provider: CUSTOM_PROVIDER_ID, default: { modelId: "my-model", thinkingLevel: "high" }, agents: {}, vision: {} } });
    expect(service.current()).toEqual(DEFAULT_MODEL_SETTINGS);
    expect(logs.join("\n")).toMatch(/模型设置的文件读不出来.*却没填接口地址和模型 id/);
  });

  it("CUSTOM_MODEL_API_KEY 收在 credentials 的 custom 名下（和 pi 的 provider id 对齐），没设的不带", () => {
    expect(modelCredentials({ CUSTOM_MODEL_API_KEY: KEY })).toEqual({ [CUSTOM_PROVIDER_ID]: KEY });
    expect(modelCredentials({ DEEPSEEK_API_KEY: fakeSecret("sk-", "deepseek-here"), CUSTOM_MODEL_API_KEY: ` ${KEY} ` })).toEqual({ deepseek: fakeSecret("sk-", "deepseek-here"), [CUSTOM_PROVIDER_ID]: KEY });
    expect(modelCredentials({})).toEqual({});
  });
});

describe("自定义（OpenAI 兼容）服务商：拉起子进程的装配", () => {
  it("装配里带上 baseUrl 和模型 id（密钥照旧只在 credentials 里，不进 custom 这一块）", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const file = path.join(dataDir, "assembly.json");
    const logs: string[] = [];
    const manager = createAgentManager({
      layout: dataDirLayout(dataDir),
      parentEnv: process.env,
      job: undefined,
      customProvider: () => CUSTOM,
      // 换成把装配交回来的子进程（不跑模型、不连网）
      runtimes: { resolve: () => ({ ...piRuntime, entry: ECHO_ENTRY }) },
      log: (line) => logs.push(line),
    });
    manager.spawn({
      agentId: "tm-1",
      model: { kind: "catalog", provider: CUSTOM_PROVIDER_ID, modelId: CUSTOM.modelId, thinkingLevel: "high" },
      tools: [],
      credentials: { [CUSTOM_PROVIDER_ID]: KEY },
      env: { ERGO_TEST_ASSEMBLY_FILE: file },
    });
    await vi.waitUntil(() => fs.existsSync(file), { timeout: 30_000 });
    const assembly = JSON.parse(fs.readFileSync(file, "utf8")) as { custom?: unknown; credentials?: unknown; model?: unknown };
    expect(assembly.custom).toEqual(CUSTOM);
    expect(assembly.model).toMatchObject({ provider: CUSTOM_PROVIDER_ID, modelId: CUSTOM.modelId, thinkingLevel: "high" });
    // 密钥照旧只走 credentials（经 stdin 送给子进程），不在 custom 那一块里
    expect(assembly.credentials).toEqual({ [CUSTOM_PROVIDER_ID]: KEY });
    expect(assembly.custom).not.toHaveProperty("apiKey");
    expect(assembly.custom).not.toHaveProperty("key");
    await manager.shutdown();
  });

  it("没选自定义服务商：装配里没有 custom 这一块（和以前一样）", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const file = path.join(dataDir, "assembly.json");
    const manager = createAgentManager({
      layout: dataDirLayout(dataDir),
      parentEnv: process.env,
      job: undefined,
      runtimes: { resolve: () => ({ ...piRuntime, entry: ECHO_ENTRY }) },
      log: () => {},
    });
    manager.spawn({
      agentId: "tm-2",
      model: { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" },
      tools: [],
      env: { ERGO_TEST_ASSEMBLY_FILE: file },
    });
    await vi.waitUntil(() => fs.existsSync(file), { timeout: 30_000 });
    const assembly = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect("custom" in assembly).toBe(false);
    await manager.shutdown();
  });
});

describe("自定义（OpenAI 兼容）服务商：子进程里登记", () => {
  it("登记之后模型目录认得它；连通测试的请求真的打到假服务上（带着 Bearer key）", async () => {
    const fake = await startFakeOpenAI({ models: [CUSTOM.modelId] });
    const custom = { baseUrl: fake.baseUrl, modelId: CUSTOM.modelId };
    // 列它有哪些模型：pi 的模型目录里没有这个 provider，全靠子进程登记过它
    const catalog = await runModelProbe({ type: "catalog", provider: CUSTOM_PROVIDER_ID, custom }, probeOptions());
    expect(catalog.type).toBe("catalog");
    if (catalog.type !== "catalog") return;
    expect(catalog.models.map((m) => m.modelId)).toEqual([CUSTOM.modelId]);
    expect(catalog.models[0]).toMatchObject({ name: CUSTOM.modelId, vision: false });
    expect(Array.isArray(catalog.models[0]!.thinkingLevels)).toBe(true);
    // 连通测试：一条极短的请求，真的发生在假服务上
    const ping = await runModelProbe(
      { type: "ping", model: { kind: "catalog", provider: CUSTOM_PROVIDER_ID, modelId: CUSTOM.modelId, thinkingLevel: "off" }, credentials: { [CUSTOM_PROVIDER_ID]: KEY }, custom },
      probeOptions(),
    );
    expect(ping).toMatchObject({ type: "ping", ok: true });
    const answered = fake.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(answered).toHaveLength(1);
    expect(answered[0]!.method).toBe("POST");
    expect(answered[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(answered[0]!.body.model).toBe(CUSTOM.modelId);
  }, 60_000);

  it("没登记就查不到这个 provider（和 73 号票一样：模型目录里没有就是没有）", async () => {
    const catalog = await runModelProbe({ type: "catalog", provider: CUSTOM_PROVIDER_ID }, probeOptions());
    expect(catalog).toEqual({ type: "catalog", models: [] });
  }, 60_000);
});

describe("自定义（OpenAI 兼容）服务商：连通测试", () => {
  it("打了就通：测的是 custom 里的模型 id，请求打到假服务上", async () => {
    const fake = await startFakeOpenAI({ models: [CUSTOM.modelId] });
    const { service } = setup({ settingsFile: { format: 1, provider: CUSTOM_PROVIDER_ID, default: { modelId: CUSTOM.modelId, thinkingLevel: "high" }, agents: {}, vision: {}, custom: { baseUrl: fake.baseUrl, modelId: CUSTOM.modelId } } });
    const result = await service.test();
    expect(result).toMatchObject({ ok: true, modelId: CUSTOM.modelId });
    expect(fake.countFor(CUSTOM.modelId)).toBe(1);
  }, 60_000);

  it("不通就说原因（401），原因里没有 key 的内容", async () => {
    const fake = await startFakeOpenAI({ models: [CUSTOM.modelId] });
    const { service } = setup({ settingsFile: { format: 1, provider: CUSTOM_PROVIDER_ID, default: { modelId: CUSTOM.modelId, thinkingLevel: "high" }, agents: {}, vision: {}, custom: { baseUrl: fake.baseUrl, modelId: CUSTOM.modelId } } });
    fake.unauthorized();
    const result = await service.test();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(KEY);
    expect(result.error).not.toContain(KEY.slice(-4));
  }, 60_000);

  it("请求体带了一份 custom 就测那一份（设置页还没存就想试一下），不带就按设置里存的", async () => {
    const fake = await startFakeOpenAI({ models: [CUSTOM.modelId] });
    const probes: unknown[] = [];
    const { service } = setup({
      settingsFile: { format: 1, provider: CUSTOM_PROVIDER_ID, default: { modelId: CUSTOM.modelId, thinkingLevel: "high" }, agents: {}, vision: {}, custom: CUSTOM },
      probe: async (request) => {
        probes.push(request);
        return { type: "ping", ok: true, firstTokenMs: 5, totalMs: 9 };
      },
    });
    // 不带：按设置里存的那一份（模型 id 也是它里面的）
    expect(await service.test("ignored-model")).toMatchObject({ ok: true, modelId: CUSTOM.modelId });
    expect(probes.at(-1)).toMatchObject({ type: "ping", custom: CUSTOM });
    // 带上这一份：就测它
    expect(await service.test("ignored-model", { baseUrl: fake.baseUrl, modelId: "typed-model" })).toMatchObject({ ok: true, modelId: "typed-model" });
    expect(probes.at(-1)).toMatchObject({ type: "ping", custom: { baseUrl: fake.baseUrl, modelId: "typed-model" } });
  });
});

describe("自定义（OpenAI 兼容）服务商：列它有哪些模型", () => {
  it("GET {baseUrl}/models，带 Bearer key；回的就是那一串 id", async () => {
    const fake = await startFakeOpenAI({ models: ["model-a", "model-b"] });
    const { service } = setup();
    const result = await service.customModels(fake.baseUrl);
    expect(result).toEqual({
      ok: true,
      models: [
        { id: "model-a", ownedBy: "fake" },
        { id: "model-b", ownedBy: "fake" },
      ],
    });
    const call = fake.requests.find((r) => r.path === "/v1/models");
    expect(call).toMatchObject({ method: "GET", authorization: `Bearer ${KEY}` });
  }, 60_000);

  it("列不成不算出错：401、服务出错、没填地址都写原因，原因里没有 key 的内容", async () => {
    const fake = await startFakeOpenAI({ models: [CUSTOM.modelId] });
    const { service } = setup();
    fake.failModels();
    expect(await service.customModels(fake.baseUrl)).toMatchObject({ ok: false, models: [] });
    fake.unauthorized();
    const unauthorized = await service.customModels(fake.baseUrl);
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.error).toMatch(/401/);
    expect(unauthorized.error).not.toContain(KEY);
    expect(unauthorized.error).not.toContain(KEY.slice(-4));
    // 还没填地址
    const noUrl = await setup({
      settingsFile: { format: 1, provider: CUSTOM_PROVIDER_ID, default: { modelId: CUSTOM.modelId, thinkingLevel: "high" }, agents: {}, vision: {} },
      credentials: {},
    }).service.customModels();
    expect(noUrl).toMatchObject({ ok: false, models: [] });
    expect(noUrl.error).toContain("还没填");
  }, 60_000);
});
