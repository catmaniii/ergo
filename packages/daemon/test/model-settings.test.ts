// 设置里的"模型"（73 号票）的模块层测试：设置文件、按 agent 取模型、看图能力的层次、设置页的样子、连通测试的分支。
// 模型探查换成假的（不起子进程）；主切面在 test/main/model-settings.test.ts，pi 那一侧的契约在 test/contract/session-model.contract.test.ts。
import fs from "node:fs";
import { MODEL_AGENTS, type ModelSettingsBody } from "@ergou/protocol";
import { describe, expect, it, vi } from "vitest";
import { dataDirLayout } from "../src/config/data-dir.ts";
import { RequestRejected } from "../src/errors.ts";
import { createModelSettings, DEFAULT_MODEL_SETTINGS, type ModelSettingsOptions } from "../src/model-settings/index.ts";
import { type CatalogModel, type ModelProbeRequest, type ModelProbeResult, redactApiKeys } from "../src/runtime/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const KEY = "sk-unit-73-not-a-real-key-Q8z2";

const CATALOG: CatalogModel[] = [
  { modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash", vision: true, thinkingLevels: ["off", "low", "high"] },
  { modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", vision: false, thinkingLevels: ["off", "high"] },
];

interface Setup {
  config?: Partial<ModelSettingsOptions["config"]>;
  credentials?: Record<string, string>;
  /** 模型探查：catalog 回什么（抛错表示查不到）；ping 回什么 */
  catalog?: CatalogModel[] | Error;
  ping?: (request: Extract<ModelProbeRequest, { type: "ping" }>) => ModelProbeResult | Promise<ModelProbeResult>;
  dataDir?: string;
}

function setup(options: Setup = {}) {
  const dataDir = options.dataDir ?? makeTempDir("ergou-data-");
  const layout = dataDirLayout(dataDir);
  const logs: string[] = [];
  const probes: ModelProbeRequest[] = [];
  const service = createModelSettings({
    layout,
    config: { models: options.config?.models ?? {}, tokenPrices: options.config?.tokenPrices ?? { currency: "CNY", models: {} } },
    credentials: options.credentials ?? { deepseek: KEY },
    probe: async (request) => {
      probes.push(request);
      if (request.type === "catalog") {
        if (options.catalog instanceof Error) throw options.catalog;
        return { type: "catalog", models: options.catalog ?? CATALOG };
      }
      return options.ping ? options.ping(request) : { type: "ping", ok: true, firstTokenMs: 120, totalMs: 300 };
    },
    lsm: () => true,
    secretarySession: () => ({ modelId: "deepseek-flash", thinkingLevel: "high", vision: true }),
    log: (line) => logs.push(line),
  });
  return { service, layout, logs, probes, dataDir };
}

const settings = (overrides: Partial<ModelSettingsBody> = {}): ModelSettingsBody => ({
  provider: "deepseek",
  default: { modelId: "deepseek-flash", thinkingLevel: "high" },
  agents: {},
  vision: {},
  ...overrides,
});

describe("设置里的模型：设置文件和按 agent 取模型", () => {
  it("没有设置文件：全按默认，和 73 号票之前写死的一样（每个 agent 都是 deepseek-flash、思考档位高）", () => {
    const { service } = setup();
    expect(service.current()).toEqual(DEFAULT_MODEL_SETTINGS);
    for (const agent of MODEL_AGENTS) expect(service.modelFor(agent)).toEqual({ kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" });
  });

  it("改默认模型、按 agent 覆盖（只覆盖模型或只覆盖思考档位，另一项跟随默认）：写进配置区的文件，之后按 agent 取到新的；重启后照文件", async () => {
    const { service, layout, dataDir } = setup();
    await service.change(
      settings({
        default: { modelId: "deepseek-v4-pro", thinkingLevel: "medium" },
        agents: { secretary: { modelId: "deepseek-flash" }, reviewer: { thinkingLevel: "off" }, sub_agent: {} },
      }),
    );
    expect(service.modelFor("secretary")).toMatchObject({ modelId: "deepseek-flash", thinkingLevel: "medium" });
    expect(service.modelFor("reviewer")).toMatchObject({ modelId: "deepseek-v4-pro", thinkingLevel: "off" });
    expect(service.modelFor("task_maintainer")).toMatchObject({ modelId: "deepseek-v4-pro", thinkingLevel: "medium" });
    // 两项都跟随默认的不记
    expect(service.current().agents).toEqual({ secretary: { modelId: "deepseek-flash" }, reviewer: { thinkingLevel: "off" } });
    expect(JSON.parse(fs.readFileSync(layout.modelSettingsFile, "utf8"))).toEqual({ format: 1, ...service.current() });
    // 重启（同一个数据目录）：照文件
    const again = setup({ dataDir });
    expect(again.service.modelFor("reviewer")).toMatchObject({ modelId: "deepseek-v4-pro", thinkingLevel: "off" });
  });

  it("不合规的不存：模型目录里没有的模型、不支持的服务商、看图能力的键写错；文件不动", async () => {
    const { service, layout } = setup();
    const rejected = async (body: ModelSettingsBody, message: RegExp) => {
      const err = await service.change(body).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RequestRejected);
      expect((err as Error).message).toMatch(message);
    };
    await rejected(settings({ default: { modelId: "deepseek-nope", thinkingLevel: "high" } }), /默认模型：DeepSeek 的模型目录里没有 deepseek-nope/);
    await rejected(settings({ agents: { scope_review: { modelId: "gpt-x" } } }), /scope_review 的模型/);
    await rejected(settings({ provider: "openai" }), /不支持服务商 openai/);
    await rejected(settings({ vision: { "openai/gpt-x": true } }), /看图能力的键/);
    await rejected(settings({ vision: { "deepseek/deepseek-nope": true } }), /看图能力：.*没有 deepseek-nope/);
    expect(fs.existsSync(layout.modelSettingsFile)).toBe(false);
  });

  it("设置文件读不出来（不合规、不是 JSON）：按默认用、记一条日志，设置页上提示；先不覆盖它，设置页存一次（哪怕和默认一样）就覆盖、提示消失", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const { modelSettingsFile, config } = dataDirLayout(dataDir);
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(modelSettingsFile, '{"format":1,"provider":"deepseek","default":{"modelId":"deepseek-flash","thinkingLevel":"超高"},"agents":{},"vision":{}}');
    const { service, logs } = setup({ dataDir });
    expect(service.current()).toEqual(DEFAULT_MODEL_SETTINGS);
    expect(logs.filter((l) => l.startsWith("模型设置的文件读不出来"))).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/模型设置的文件读不出来：.*格式不对.*正在用默认，设置页保存会覆盖它/);
    expect(fs.readFileSync(modelSettingsFile, "utf8")).toContain("超高");
    expect((await service.view()).settingsFileError).toMatch(/格式不对/);

    // 存一份和正在用的默认一样的：照样写文件、覆盖坏的，提示消失
    const saved = await service.change(settings());
    expect(saved.settingsFileError).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(modelSettingsFile, "utf8"))).toEqual({ format: 1, ...DEFAULT_MODEL_SETTINGS });
    expect(logs.join("\n")).toMatch(/设置页存了一份新的，覆盖了它/);

    // 不是 JSON 的也一样；没有文件不算读不出来
    fs.writeFileSync(modelSettingsFile, "{不是 json");
    expect((await setup({ dataDir }).service.view()).settingsFileError).toBeTruthy();
    expect((await setup().service.view()).settingsFileError).toBeUndefined();
  });

  it("模型目录查不到时：只能选配置里登记过的和已经选了的", async () => {
    const { service } = setup({ catalog: new Error("子进程起不来"), config: { tokenPrices: { currency: "CNY", models: { "deepseek/deepseek-registered": { cacheHit: 0, cacheMiss: 1, output: 2 } } } } });
    await service.change(settings({ default: { modelId: "deepseek-registered", thinkingLevel: "high" } }));
    expect(service.modelFor("secretary")).toMatchObject({ modelId: "deepseek-registered" });
    await expect(service.change(settings({ default: { modelId: "deepseek-v4-pro", thinkingLevel: "high" } }))).rejects.toThrow(/模型目录现在查不到/);
  });
});

describe("设置里的模型：看图能力", () => {
  it("设置页改的为准，其次配置文件写明的，都没写按模型目录；交给子进程的是写明的那张表（设置页的盖过配置文件的）", async () => {
    const { service } = setup({ config: { models: { "deepseek/deepseek-v4-pro": { vision: true }, "deepseek/deepseek-flash": {}, faux: { vision: false } } } });
    let view = await service.view();
    const option = (id: string) => view.models.find((m) => m.modelId === id);
    expect(option("deepseek-flash")).toMatchObject({ vision: true, visionSource: "catalog", catalogVision: true });
    expect(option("deepseek-v4-pro")).toMatchObject({ vision: true, visionSource: "config", catalogVision: false, configVision: true });
    expect(service.configuredVision()).toEqual({ "deepseek/deepseek-v4-pro": true, faux: false });

    view = await service.change(settings({ vision: { "deepseek/deepseek-v4-pro": false, "deepseek/deepseek-flash": false } }));
    expect(option("deepseek-flash")).toMatchObject({ vision: false, visionSource: "settings", catalogVision: true });
    expect(option("deepseek-v4-pro")).toMatchObject({ vision: false, visionSource: "settings", configVision: true });
    expect(service.configuredVision()).toEqual({ "deepseek/deepseek-v4-pro": false, "deepseek/deepseek-flash": false, faux: false });
  });
});

describe("设置里的模型：设置页的样子", () => {
  it("服务商登记表只有 DeepSeek；可选的模型来自模型目录和配置里登记的（目录里没有的标出来）；各个 agent 实际会用的；秘书主线会话现在用的", async () => {
    const { service } = setup({ config: { models: { "deepseek/deepseek-old": {} } } });
    await service.change(settings({ agents: { project_maintainer: { modelId: "deepseek-v4-pro", thinkingLevel: "off" } } }));
    const view = await service.view();
    expect(view.providers).toEqual([{ id: "deepseek", label: "DeepSeek" }]);
    expect(view.models.map((m) => [m.modelId, m.inCatalog])).toEqual([
      ["deepseek-flash", true],
      ["deepseek-v4-pro", true],
      ["deepseek-old", false],
    ]);
    expect(view.models[0]).toMatchObject({ name: "DeepSeek V4.1 Flash", thinkingLevels: ["off", "low", "high"] });
    expect(view.effective.project_maintainer).toEqual({ modelId: "deepseek-v4-pro", thinkingLevel: "off" });
    expect(view.effective.secretary).toEqual({ modelId: "deepseek-flash", thinkingLevel: "high" });
    expect(view.secretarySession).toEqual({ modelId: "deepseek-flash", thinkingLevel: "high", vision: true });
    expect(view.catalogError).toBeUndefined();
  });

  it("API key 只有状态：配没配、从哪个环境变量来、LSM 从哪个文件注入；设置页的整份里没有 key 的内容", async () => {
    const configured = await setup().service.view();
    expect(configured.apiKey).toEqual({ configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true });
    const text = JSON.stringify(configured);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(KEY.slice(-4));
    expect((await setup({ credentials: {} }).service.view()).apiKey.configured).toBe(false);
  });

  it("模型目录查不到：写明原因，下次再查", async () => {
    const { service, probes } = setup({ catalog: new Error("模型探查的子进程退出了（code 1），没有结果\n后面的堆栈") });
    const view = await service.view();
    expect(view.catalogError).toBe("模型探查的子进程退出了（code 1），没有结果");
    expect(view.models.map((m) => m.modelId)).toEqual(["deepseek-flash"]);
    await service.view();
    expect(probes.filter((p) => p.type === "catalog")).toHaveLength(2);
  });

  it("模型目录查到一次就记住", async () => {
    const { service, probes } = setup();
    await service.view();
    await service.view();
    expect(probes.filter((p) => p.type === "catalog")).toHaveLength(1);
  });
});

describe("设置里的模型：连通测试", () => {
  it("没配 key：不发请求，直接说没配、去哪配", async () => {
    const { service, probes } = setup({ credentials: {} });
    const result = await service.test();
    expect(result).toMatchObject({ ok: false, modelId: "deepseek-flash" });
    expect(result.error).toMatch(/没配置 DeepSeek 的 API key.*DEEPSEEK_API_KEY.*secrets\/deepseek-api-key\.txt/);
    expect(probes).toEqual([]);
  });

  it("配了 key：交给模型探查（不开思考），默认测默认模型，也能指定模型；出错原因里 key 的内容再去掉一遍", async () => {
    const { service, probes } = setup({ ping: () => ({ type: "ping", ok: false, totalMs: 50, error: `401 Your api key: ${KEY} / ****${KEY.slice(-6)} is invalid` }) });
    const result = await service.test("deepseek-v4-pro");
    expect(probes.at(-1)).toEqual({ type: "ping", model: { kind: "catalog", provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "off" }, credentials: { deepseek: KEY } });
    expect(result).toMatchObject({ ok: false, modelId: "deepseek-v4-pro", totalMs: 50 });
    expect(result.error).not.toContain(KEY.slice(-4));
    const ok = await setup().service.test();
    expect(ok).toEqual({ ok: true, modelId: "deepseek-flash", firstTokenMs: 120, totalMs: 300 });
  });

  it("去掉 key 的内容（runtime/redact.ts，子进程和这里用的同一份）：整个 key、末尾 4 位起的片段、\"api key: ****abcd\"后面那一截", () => {
    const text = `key=${KEY}；Your api key: ****${KEY.slice(-4)} is invalid；尾巴 ${KEY.slice(-7)}；API key sk-****`;
    const out = redactApiKeys(text, [KEY, ""]);
    expect(out).not.toContain(KEY.slice(-4));
    expect(out).not.toContain("****");
    expect(out).toContain("<已隐去>");
    expect(redactApiKeys("没有 key 的话", [KEY])).toBe("没有 key 的话");
  });

  it("测的模型目录里没有：拒绝", async () => {
    await expect(setup().service.test("deepseek-nope")).rejects.toThrow(/连通测试：DeepSeek 的模型目录里没有 deepseek-nope/);
  });

  it("同一时间只跑一个：上一个还没测完时再要，回\"上一个还没测完\"（不再发请求）；测完了能再测", async () => {
    let finish!: (result: ModelProbeResult) => void;
    let pending = true;
    const { service, probes } = setup({
      ping: () => (pending ? new Promise<ModelProbeResult>((resolve) => (finish = resolve)) : { type: "ping", ok: true, firstTokenMs: 5, totalMs: 9 }),
    });
    const first = service.test();
    await expect(service.test("deepseek-v4-pro")).rejects.toThrow(new RequestRejected("conflict", "上一个还没测完"));
    await expect(service.test()).rejects.toThrow("上一个还没测完");
    await vi.waitUntil(() => probes.some((p) => p.type === "ping"));
    expect(probes.filter((p) => p.type === "ping")).toHaveLength(1);
    pending = false;
    finish({ type: "ping", ok: true, firstTokenMs: 10, totalMs: 20 });
    expect(await first).toMatchObject({ ok: true, totalMs: 20 });
    expect(await service.test()).toMatchObject({ ok: true, totalMs: 9 });
    // 出错的那次也放开
    const failing = setup({ catalog: CATALOG, ping: () => Promise.reject(new Error("连通测试超时（60 秒），结束了子进程")) });
    expect(await failing.service.test()).toMatchObject({ ok: false, error: "连通测试超时（60 秒），结束了子进程" });
    expect(await failing.service.test()).toMatchObject({ ok: false });
  });
});
