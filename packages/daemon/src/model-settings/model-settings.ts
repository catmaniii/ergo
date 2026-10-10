// 设置里的"模型"（73 号票，规格第 1 节"模型"）：模型在服务端（守护进程这台电脑）调用，目前只支持 DeepSeek；
// 默认模型和思考档位，按 agent（秘书、任务维护者、项目维护者、子 agent、评审、范围审视）覆盖；连通测试；看图能力。
//
// - 存：数据目录配置区的 model-settings.json 是真相，只由运行时写（设置接口），各设备看到的一样；配置区是受保护区域，agent 写不进。
//   没有这个文件时全按默认（providers.ts 的 DEFAULT_MODEL_SETTINGS，和 73 号票之前写死的一样）；文件读不了、不合规时先不覆盖它，
//   记日志、按默认用，设置页上提示"设置文件读不出来，正在用默认；保存会覆盖它"（settingsFileError），在设置页存一次就覆盖、
//   提示消失。启动时读一次，之后只经设置接口改（手改文件要重启守护进程）。
// - 用：拉起 agent 的模块按 agent 现取（modelFor），只用于新开的会话——一个会话固定一个模型：接着已有的会话时子进程照会话开始时
//   记下的模型、思考档位和看图能力（agent-child/session.ts），所以改了以后下一个新会话生效，正在进行的会话不换。
//   记账照实际用的模型（子进程每次调用报的 provider、模型 id）。
// - 看图能力（79 号票的判法加一层）：设置页改的为准，其次配置文件 models["provider/模型 id"].vision 写明的，都没写按模型目录。
// - 模型目录只有子进程查得到（pi 边界）：设置页要的模型列表（名字、能不能看图、支持哪几档思考）经一次性子进程查一次、记住
//   （pi 不升级就不变）；连通测试同样在一次性子进程里发一条极短的请求（守护进程自己不跑模型），同一时间只跑一个：
//   上一个还没测完时再要回 409"上一个还没测完"；子进程超时（60 秒）结束它，结果里写明"超时（60 秒）"。
// - API key 只说配没配、从哪来：守护进程只看环境变量有没有值（LSM 从密钥区的文件注入），不读密钥区；接口、页面、日志里都没有
//   key 的内容。连通测试的出错原因里 provider 可能带着 key 的一截，子进程去掉一遍，这里再去掉一遍（都用 runtime/redact.ts）。
import fs from "node:fs";
import {
  effectiveModelChoice,
  MODEL_AGENTS,
  MODEL_THINKING_LEVELS,
  type ModelChoice,
  modelKeyOf,
  type ModelOptionView,
  type ModelAgent,
  type ModelSettings,
  type ModelSettingsBody,
  ModelSettingsFile,
  type ModelSettingsView,
  type ModelTestResult,
  type ModelThinkingLevel,
  type ModelVisionSource,
  schemaChecker,
  type SessionModelView,
  splitModelKey,
} from "@ergou/protocol";
import type { ErgouConfig } from "../config/config.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import { type CatalogModel, type CatalogModelSpec, type ModelProbeRequest, type ModelProbeResult, redactApiKeys } from "../runtime/index.ts";
import { writeJsonAtomic } from "../util/json-file.ts";
import { DEFAULT_MODEL_SETTINGS, MODEL_PROVIDERS, type ModelProvider, providerOf } from "./providers.ts";

const settingsFile = schemaChecker(ModelSettingsFile);

export interface ModelSettingsService {
  /** 现在的设置 */
  current(): ModelSettings;
  /** 这个 agent 下一个新会话用的模型和思考档位（目录里的模型） */
  modelFor(agent: ModelAgent): CatalogModelSpec;
  /** 配置写明的看图能力（设置页改的优先于配置文件），键是「provider/模型 id」；拉起 agent 时交给子进程 */
  configuredVision(): Record<string, boolean>;
  /** 设置页要的全部（要查模型目录，所以是异步的） */
  view(): Promise<ModelSettingsView>;
  /** 整份存：查过合规（不合规抛 RequestRejected，HTTP 回 400）再写文件；回存好之后的设置页 */
  change(body: ModelSettingsBody): Promise<ModelSettingsView>;
  /**
   * 连通测试：用这个模型（不给是默认模型）发一条极短的请求；没配 key 时不发，直接说没配。
   * 同一时间只跑一个：上一个还没测完时抛 RequestRejected（conflict，设置接口回 409）"上一个还没测完"
   */
  test(modelId?: string): Promise<ModelTestResult>;
}

export interface ModelSettingsOptions {
  layout: DataDirLayout;
  /** 配置文件里的模型能力（models）和单价（tokenPrices）：看图能力写明的、登记过的模型 */
  config: Pick<ErgouConfig, "models" | "tokenPrices">;
  /** provider id → API key（守护进程从环境变量取的，config/secrets.ts）：只用来判断配没配、交给连通测试的子进程 */
  credentials: Readonly<Record<string, string>>;
  /** 一次性子进程的模型探查（agent 管家的 probeModels） */
  probe: (request: ModelProbeRequest) => Promise<ModelProbeResult>;
  /** 守护进程接没接入 LSM（经 LSM 拉起才有 key 的注入）；现取 */
  lsm: () => boolean;
  /** 秘书的主线会话现在用的（秘书在运行时才有）；现取 */
  secretarySession: () => SessionModelView | undefined;
  /** 测试用：目录里的模型的请求都发到这个地址（本机的假 DeepSeek），连通测试也是；正式的不给 */
  catalogBaseUrl?: string;
  log: (line: string) => void;
}

export function createModelSettings(options: ModelSettingsOptions): ModelSettingsService {
  const { layout, config, credentials, log } = options;
  const file = layout.modelSettingsFile;
  const loaded = readSettings(file, log);
  let settings: ModelSettings = loaded.settings;
  /** 设置文件读不出来的原因（这时在用默认；设置页存一次覆盖它之后清掉） */
  let fileError: string | undefined = loaded.error;
  /** 有一个连通测试在跑 */
  let testing = false;
  /** 模型目录里各服务商的模型（查一次记住；查不到的不记，下次再查） */
  const catalogs = new Map<string, Promise<CatalogModel[]>>();

  const catalogOf = (provider: string): Promise<CatalogModel[]> => {
    let pending = catalogs.get(provider);
    if (!pending) {
      pending = options.probe({ type: "catalog", provider }).then((result) => {
        if (result.type !== "catalog") throw new Error("模型探查回的不是模型列表");
        return result.models;
      });
      catalogs.set(provider, pending);
      pending.catch((err: unknown) => {
        catalogs.delete(provider);
        log(`查不到模型目录（${provider}）：${firstLine(err)}`);
      });
    }
    return pending;
  };

  /** 模型目录里的（查不到时 error 是原因） */
  const catalog = async (provider: string): Promise<{ models?: CatalogModel[]; error?: string }> => {
    try {
      return { models: await catalogOf(provider) };
    } catch (err) {
      return { error: firstLine(err) };
    }
  };

  /** 配置文件里登记过的这个服务商的模型（models、tokenPrices 的键） */
  const registered = (provider: string): string[] => modelIdsOf(provider, [...Object.keys(config.models), ...Object.keys(config.tokenPrices.models)]);

  /** 配置写明的看图能力：配置文件的，设置页改的盖过它 */
  const configuredVision = (): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    for (const [key, caps] of Object.entries(config.models)) if (caps.vision !== undefined) out[key] = caps.vision;
    return { ...out, ...settings.vision };
  };

  const view = async (): Promise<ModelSettingsView> => {
    const provider = providerOf(settings.provider) ?? MODEL_PROVIDERS[0]!;
    const { models: catalogModels, error } = await catalog(provider.id);
    const ids = unique([...(catalogModels ?? []).map((m) => m.modelId), ...registered(provider.id), ...mentioned(settings)]);
    const models = ids.map((modelId) => optionView(provider, modelId, catalogModels));
    const secretarySession = options.secretarySession();
    return {
      providers: MODEL_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
      apiKey: { configured: Boolean(credentials[provider.id]), envVar: provider.keyEnv, secretFile: provider.secretFile, lsm: options.lsm() },
      models,
      ...(error === undefined ? {} : { catalogError: error }),
      ...(fileError === undefined ? {} : { settingsFileError: fileError }),
      settings: structuredClone(settings),
      effective: Object.fromEntries(MODEL_AGENTS.map((agent) => [agent, effectiveModelChoice(settings, agent)])) as Record<ModelAgent, ModelChoice>,
      ...(secretarySession ? { secretarySession } : {}),
    };
  };

  const optionView = (provider: ModelProvider, modelId: string, catalogModels: readonly CatalogModel[] | undefined): ModelOptionView => {
    const key = modelKeyOf(provider.id, modelId);
    const inCatalog = catalogModels?.find((m) => m.modelId === modelId);
    const configVision = config.models[key]?.vision;
    const settingsVision = settings.vision[key];
    const [vision, visionSource]: [boolean | undefined, ModelVisionSource | undefined] =
      settingsVision !== undefined ? [settingsVision, "settings"] : configVision !== undefined ? [configVision, "config"] : inCatalog ? [inCatalog.vision, "catalog"] : [undefined, undefined];
    const thinkingLevels = inCatalog?.thinkingLevels.filter((l): l is ModelThinkingLevel => (MODEL_THINKING_LEVELS as readonly string[]).includes(l));
    return {
      modelId,
      ...(inCatalog ? { name: inCatalog.name } : {}),
      // 目录查不到时不知道它在不在：按"在"列着（选了拉不起会话时会话里有说明）
      inCatalog: catalogModels === undefined || inCatalog !== undefined,
      ...(vision === undefined ? {} : { vision }),
      ...(visionSource === undefined ? {} : { visionSource }),
      ...(inCatalog ? { catalogVision: inCatalog.vision } : {}),
      ...(configVision === undefined ? {} : { configVision }),
      ...(thinkingLevels ? { thinkingLevels } : {}),
    };
  };

  /** 能选的模型：模型目录里有的；目录查不到时退回配置里登记的和设置里已经选了的（没法核对） */
  const selectable = async (provider: string): Promise<{ ids: Set<string>; fromCatalog: boolean }> => {
    const { models } = await catalog(provider);
    if (models) return { ids: new Set(models.map((m) => m.modelId)), fromCatalog: true };
    return { ids: new Set([...registered(provider), ...mentioned(settings)]), fromCatalog: false };
  };

  /** 连通测试本身（test 管同一时间只跑一个） */
  const ping = async (modelId: string | undefined): Promise<ModelTestResult> => {
    const provider = providerOf(settings.provider) ?? MODEL_PROVIDERS[0]!;
    const target = modelId ?? settings.default.modelId;
    const started = performance.now();
    const key = credentials[provider.id];
    if (!key) return { ok: false, modelId: target, totalMs: 0, error: `没配置 ${provider.label} 的 API key：在 LSM 的 ergou-daemon 条目里给环境变量 ${provider.keyEnv} 配上（从数据目录的 ${provider.secretFile} 注入），重启后生效` };
    checkModel(target, await selectable(provider.id), provider, "连通测试");
    const spec: CatalogModelSpec = { kind: "catalog", provider: provider.id, modelId: target, thinkingLevel: "off", ...(options.catalogBaseUrl === undefined ? {} : { baseUrl: options.catalogBaseUrl }) };
    try {
      const result = await options.probe({ type: "ping", model: spec, credentials: { [provider.id]: key } });
      if (result.type !== "ping") throw new Error("模型探查回的不是连通测试的结果");
      return {
        ok: result.ok,
        modelId: target,
        ...(result.firstTokenMs === undefined ? {} : { firstTokenMs: result.firstTokenMs }),
        totalMs: result.totalMs,
        ...(result.error === undefined ? {} : { error: redactApiKeys(result.error, [key]) }),
      };
    } catch (err) {
      // 子进程出错、超时（"连通测试超时（60 秒），结束了子进程"）
      return { ok: false, modelId: target, totalMs: Math.round(performance.now() - started), error: redactApiKeys(firstLine(err), [key]) };
    }
  };

  return {
    current: () => structuredClone(settings),
    modelFor(agent) {
      const choice = effectiveModelChoice(settings, agent);
      return { kind: "catalog", provider: settings.provider, modelId: choice.modelId, thinkingLevel: choice.thinkingLevel, ...(options.catalogBaseUrl === undefined ? {} : { baseUrl: options.catalogBaseUrl }) };
    },
    configuredVision,
    view,
    async change(body) {
      const provider = providerOf(body.provider);
      if (!provider) throw new RequestRejected("bad_params", `不支持服务商 ${body.provider}：目前只支持 ${MODEL_PROVIDERS.map((p) => p.label).join("、")}`);
      const allowed = await selectable(provider.id);
      checkModel(body.default.modelId, allowed, provider, "默认模型");
      const agents: ModelSettings["agents"] = {};
      for (const agent of MODEL_AGENTS) {
        const override = body.agents[agent];
        if (override?.modelId !== undefined) checkModel(override.modelId, allowed, provider, `agent ${agent} 的模型`);
        // 两项都跟随默认的不记
        if (override?.modelId !== undefined || override?.thinkingLevel !== undefined) {
          agents[agent] = { ...(override.modelId === undefined ? {} : { modelId: override.modelId }), ...(override.thinkingLevel === undefined ? {} : { thinkingLevel: override.thinkingLevel }) };
        }
      }
      const vision: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(body.vision)) {
        const parts = splitModelKey(key);
        if (parts?.provider !== provider.id) throw new RequestRejected("bad_params", `看图能力的键要写成「${modelKeyOf(provider.id, "模型 id")}」，实际是 ${key}`);
        checkModel(parts.modelId, allowed, provider, "看图能力");
        vision[key] = value;
      }
      const next: ModelSettings = { provider: provider.id, default: { modelId: body.default.modelId, thinkingLevel: body.default.thinkingLevel }, agents, vision };
      // 设置文件读不出来时，存一次就覆盖它（哪怕和正在用的默认一样）
      if (fileError !== undefined || JSON.stringify(next) !== JSON.stringify(settings)) {
        writeJsonAtomic(file, { format: 1, ...next } satisfies ModelSettingsFile);
        settings = next;
        if (fileError !== undefined) log(`模型设置的文件读不出来，设置页存了一份新的，覆盖了它：${file}`);
        fileError = undefined;
        log(`模型设置改了（下一个新会话起生效）：默认 ${next.default.modelId}（思考 ${next.default.thinkingLevel}）${describeAgents(next)}`);
      }
      return view();
    },
    async test(modelId) {
      if (testing) throw new RequestRejected("conflict", "上一个还没测完");
      testing = true;
      try {
        return await ping(modelId);
      } finally {
        testing = false;
      }
    },
  };
}

/** keys（「provider/模型 id」）里这个服务商的模型 id */
function modelIdsOf(provider: string, keys: readonly string[]): string[] {
  return unique(keys.flatMap((key) => {
    const parts = splitModelKey(key);
    return parts?.provider === provider ? [parts.modelId] : [];
  }));
}

/** 设置里提到的模型（默认、各个 agent 的、改过看图能力的） */
function mentioned(s: ModelSettings): string[] {
  return unique([
    s.default.modelId,
    ...MODEL_AGENTS.flatMap((agent) => (s.agents[agent]?.modelId === undefined ? [] : [s.agents[agent].modelId])),
    ...modelIdsOf(s.provider, Object.keys(s.vision)),
  ]);
}

/** 这个模型能不能选：不能时抛 RequestRejected（HTTP 回 400），说清是哪一项、为什么 */
function checkModel(modelId: string, allowed: { ids: Set<string>; fromCatalog: boolean }, provider: ModelProvider, where: string): void {
  if (allowed.ids.has(modelId)) return;
  throw new RequestRejected(
    "bad_params",
    allowed.fromCatalog ? `${where}：${provider.label} 的模型目录里没有 ${modelId}` : `${where}：模型目录现在查不到，只能选配置里登记过的和已经选了的模型，没有 ${modelId}`,
  );
}

/**
 * 读设置文件：没有是默认；读不了、不合规时 error 是原因，按默认用、记一条日志（先不覆盖文件：设置页上提示，存一次才覆盖）
 */
function readSettings(file: string, log: (line: string) => void): { settings: ModelSettings; error?: string } {
  const broken = (error: string) => {
    log(`模型设置的文件读不出来：${file}：${error}；正在用默认，设置页保存会覆盖它`);
    return { settings: structuredClone(DEFAULT_MODEL_SETTINGS) as ModelSettings, error };
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: structuredClone(DEFAULT_MODEL_SETTINGS) as ModelSettings };
    return broken(err instanceof Error ? err.message : String(err));
  }
  if (!settingsFile.check(parsed)) return broken(`格式不对：${settingsFile.firstError(parsed) ?? "不合规"}`);
  if (!providerOf(parsed.provider)) return broken(`服务商 ${parsed.provider} 不支持（目前只支持 ${MODEL_PROVIDERS.map((p) => p.id).join("、")}）`);
  const { format: _format, ...settings } = parsed;
  return { settings: settings as ModelSettings };
}

function describeAgents(settings: ModelSettings): string {
  const parts = MODEL_AGENTS.flatMap((agent) => {
    const o = settings.agents[agent];
    if (!o) return [];
    return [`${agent} ${o.modelId ?? "跟随默认"}（思考 ${o.thinkingLevel ?? "跟随默认"}）`];
  });
  return parts.length === 0 ? "，各个 agent 都跟随默认" : `；${parts.join("，")}`;
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split(/\r?\n/, 1)[0] ?? text;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
