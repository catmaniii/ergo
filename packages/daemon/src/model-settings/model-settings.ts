// 设置里的"模型"（73 号票，规格第 1 节"模型"）：模型在服务端（守护进程这台电脑）调用；DeepSeek 是默认，另有一个
// 自定义的 OpenAI 兼容服务商（provider id 固定是 custom，用户填接口地址、模型 id、key）；
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
// - 自定义（OpenAI 兼容）服务商（provider id 固定是 custom，选了它时设置里多一块 custom：baseUrl、modelId、api）：
//   只有**一个**模型，模型 id 就是 custom.modelId——default、各 agent 覆盖里写的模型 id 是切回 DeepSeek 时接着用的，自定义时不起作用
//   （思考档位照旧按那一行）。pi 的模型目录里没有它，子进程要先 registerProvider，所以拉起 agent 的装配（SessionAssembly.custom）
//   和模型探查的请求里都带上它（customProvider()）；密钥照旧只走 credentials（键名 custom）。
//   连通测试测它里面的 modelId；列它的模型是守护进程直接发的一次 GET {baseUrl}/models（不经过模型，也不花 token）。
// - 单独配了模型的维护者（120 号票）：某个项目、某个任务的维护者在自己的 ⚙ 里选定模型和思考档位，盖过它那一行（项目维护者 /
//   任务维护者）；存在同一个文件的 maintainers 里（按 agent id），设置页整份存时原样留着。拉起它时按 agent id 现取（modelFor 的第二个参数），
//   所以和那一行一样只用于新开的会话、长会话照 83 号票换。它派出的子 agent、评审，范围审视照各自那一行。配的模型在模型目录里没有了：
//   退回跟随那一行（记一次日志），⚙ 和设置页上写明原因；项目归档、任务归档时由守护进程清掉（followRole）。
// - 模型目录只有子进程查得到（pi 边界）：设置页要的模型列表（名字、能不能看图、支持哪几档思考）经一次性子进程查一次、记住
//   （pi 不升级就不变）；连通测试同样在一次性子进程里发一条极短的请求（守护进程自己不跑模型），同一时间只跑一个：
//   上一个还没测完时再要回 409"上一个还没测完"；子进程超时（60 秒）结束它，结果里写明"超时（60 秒）"。
// - API key 只说配没配、从哪来：守护进程只看环境变量有没有值（LSM 从密钥区的文件注入），不读密钥区。
//   319 号票（用户 2026-10-28 定"A：网页里能填 key"）起网页上能填一个：写进密钥区的同一个文件（先写临时文件再改名，文件 0o600、
//   目录 0o700），同时换进内存里的 key（credentials + keyApplied 交给组合根别处取 key 的地方），下一次模型调用就用新的；
//   接口回的、页面上的、日志里的都没有 key 的内容。连通测试的出错原因里 provider 可能带着 key 的一截，子进程去掉一遍，这里再去掉一遍
//   （都用 runtime/redact.ts）。
import fs from "node:fs";
import path from "node:path";
import {
  CUSTOM_MODELS_MAX,
  CUSTOM_PROVIDER_ID,
  checkModelCustom,
  effectiveModelChoice,
  MODEL_AGENTS,
  MODEL_KEY_MAX_LENGTH,
  MODEL_KEY_MIN_LENGTH,
  MODEL_THINKING_LEVELS,
  type ModelApiKeyStatus,
  type ModelChoice,
  type ModelCustomModel,
  type ModelCustomModelsResult,
  type ModelCustomProvider,
  type ModelKeyView,
  type ModelKeyWriteResult,
  modelKeyOf,
  type ModelOptionView,
  type ModelAgent,
  type MaintainerModelAgent,
  type MaintainerModelView,
  type ModelSettings,
  type ModelSettingsBody,
  ModelSettingsFile,
  type ModelSettingsView,
  type ModelTestResult,
  type ModelThinkingLevel,
  type ModelVisionSource,
  normalizeModelKey,
  schemaChecker,
  type SessionModelView,
  splitModelKey,
  t,
} from "@ergo/protocol";
import type { ErgoConfig } from "../config/config.ts";
import type { DataDirLayout } from "../config/data-dir.ts";
import { RequestRejected } from "../errors.ts";
import { type CatalogModel, type CatalogModelSpec, type ModelProbeRequest, type ModelProbeResult, type ModelSpec, redactApiKeys } from "../runtime/index.ts";
import { renameRetrying, tempPathFor } from "../util/atomic-file.ts";
import { writeJsonAtomic } from "../util/json-file.ts";
import { DEFAULT_MODEL_SETTINGS, MODEL_PROVIDERS, type ModelProvider, providerOf } from "./providers.ts";

const settingsFile = schemaChecker(ModelSettingsFile);

/** 一个维护者用什么模型（120 号票，⚙ 上显示的） */
export interface MaintainerModel {
  /** 它那一行现在实际会用的 */
  role: ModelChoice;
  /** 单独配的；跟随那一行时没有 */
  own?: ModelChoice;
  /** 单独配的模型用不了了：原因（这时跟随那一行） */
  unavailable?: string;
  /** 下一个新会话用的 */
  next: ModelChoice;
}

/** 单独配了模型的维护者是谁（设置页上列出来、点了去它的 ⚙）：不认得（项目删了、任务没了）的不列 */
export type MaintainerOwnerOf = (agentId: string) => Pick<MaintainerModelView, "agent" | "owner"> | undefined;

export interface ModelSettingsService {
  /** 现在的设置 */
  current(): ModelSettings;
  /**
   * 设置里选的自定义（OpenAI 兼容）服务商：选了 custom 才有（带上接口地址、模型 id、接口风格）。拉起 agent 的装配
   * 拿它去子进程里登记这个 provider（模型目录里没有它），key 照旧只走 credentials；
   * 没选自定义、设置文件里也没有这一块时是 undefined
   */
  customProvider(): ModelCustomProvider | undefined;
  /**
   * 这个 agent 下一个新会话用的模型和思考档位（目录里的模型）。给了 maintainerId（项目、任务的维护者）时，
   * 它单独配了、配的模型还能用就是单独配的（120 号票），不然按 agent 那一行
   */
  modelFor(agent: ModelAgent, maintainerId?: string): CatalogModelSpec;
  /** 一个维护者用什么模型（⚙ 上显示的，120 号票） */
  maintainerModel(agentId: string, agent: MaintainerModelAgent): MaintainerModel;
  /** 单独配模型：查过能选（不能选抛 RequestRejected，HTTP 回 400）再写文件；下一个新会话起生效 */
  setMaintainerModel(agentId: string, choice: ModelChoice): Promise<void>;
  /** 不再单独配、改回跟随那一行（⚙ 里改回、项目归档、任务归档）；why 记进日志。原来就没有回 false */
  followRole(agentId: string, why: string): boolean;
  /** 配置写明的看图能力（设置页改的优先于配置文件），键是「provider/模型 id」；拉起 agent 时交给子进程 */
  configuredVision(): Record<string, boolean>;
  /**
   * 这个模型能不能看图（145 号票：页面助手拉起之前要定给不给它看图的工具；149 号票起页面助手不再有，留给要先定看图能力的地方）：和子进程定会话的看图能力同一个判法——
   * 配置写明的（设置页改的、配置文件的）为准，没写的按模型目录（测试的 faux 能看）；目录查不到、目录里没有按看不了
   */
  visionOf(model: ModelSpec): Promise<boolean>;
  /** 设置页要的全部（要查模型目录，所以是异步的） */
  view(): Promise<ModelSettingsView>;
  /** 设置里选的服务商和它的 key 配没配（315 号票）：不查模型目录，会话页上"还没配模型"的提示用 */
  keyView(): ModelKeyView;
  /**
   * 在网页上填模型的 key（319 号票）：写进密钥区的文件、换进内存里的 key，回配好了、什么时候生效
   * （现在起的模型调用就用新的）。key 不合规（去掉首尾空白后太短、太长）抛 RequestRejected（HTTP 回 400），
   * 写文件出错抛别的（HTTP 回 500）。key 的内容不进日志、不回显
   */
  saveKey(raw: string): ModelKeyWriteResult;
  /** 整份存：查过合规（不合规抛 RequestRejected，HTTP 回 400）再写文件；回存好之后的设置页 */
  change(body: ModelSettingsBody): Promise<ModelSettingsView>;
  /**
   * 连通测试：用这个模型（不给是默认模型）发一条极短的请求；没配 key 时不发，直接说没配。
   * 自定义服务商（provider 是 custom）时测它里面的 modelId：custom 给了就测这一份（设置页还没存就想试一下），
   * 不给按设置里存的。
   * 同一时间只跑一个：上一个还没测完时抛 RequestRejected（conflict，设置接口回 409）"上一个还没测完"
   */
  test(modelId?: string, custom?: ModelCustomProvider): Promise<ModelTestResult>;
  /**
   * 列出自定义（OpenAI 兼容）服务商有哪些模型（POST /api/model-settings/custom-models）：GET {baseUrl}/models，
   * 带 Authorization: Bearer <key>。baseUrl 不给按设置里存的那份。列不成不算出错（ok 为 false，error 写原因），
   * key 的内容不进原因
   */
  customModels(baseUrl?: string): Promise<ModelCustomModelsResult>;
}

export interface ModelSettingsOptions {
  layout: DataDirLayout;
  /** 配置文件里的模型能力（models）和单价（tokenPrices）：看图能力写明的、登记过的模型 */
  config: Pick<ErgoConfig, "models" | "tokenPrices">;
  /** provider id → API key（守护进程从环境变量取的，config/secrets.ts）：判断配没配、交给连通测试和 agent 的子进程；网页上填了就地换成新的 */
  credentials: Record<string, string>;
  /**
   * 网页上填的 key 写进文件、换进 credentials 之后叫一次（319 号票）：组合根把别处取 key 的地方也换成新的
   * （记忆整理从守护进程的环境里读 DEEPSEEK_API_KEY）。不给就不管
   */
  keyApplied?: (provider: ModelProvider, key: string) => void;
  /** 一次性子进程的模型探查（agent 管家的 probeModels） */
  probe: (request: ModelProbeRequest) => Promise<ModelProbeResult>;
  /** 守护进程接没接入 LSM（经 LSM 拉起才有 key 的注入）；现取 */
  lsm: () => boolean;
  /** 秘书的主线会话现在用的（秘书在运行时才有）；现取 */
  secretarySession: () => SessionModelView | undefined;
  /** 单独配了模型的维护者是谁（120 号票，设置页上列出来）；不给时不列 */
  maintainerOwner?: MaintainerOwnerOf;
  /** 测试用：目录里的模型的请求都发到这个地址（本机的假 DeepSeek），连通测试也是；正式的不给 */
  catalogBaseUrl?: string;
  log: (line: string) => void;
}

/**
 * 把 key 写进密钥区的文件（319 号票）：目录不在就建（0o700），先写同目录的临时文件（0o600）再改名（atomic-file 的重试），
 * 文件里只有 key 这一行。写不进去抛原来的错误，临时文件删掉、原来的文件不动
 */
function writeModelKeyFile(target: string, key: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = tempPathFor(target);
  try {
    fs.writeFileSync(temp, `${key}\n`, { mode: 0o600 });
    renameRetrying(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

export function createModelSettings(options: ModelSettingsOptions): ModelSettingsService {
  const { layout, config, credentials, log } = options;
  const file = layout.modelSettingsFile;
  const loaded = readSettings(file, log);
  let settings: ModelSettings = loaded.settings;
  /** 单独配了模型的维护者（120 号票）：agent id → 选定的 */
  let maintainers: Record<string, ModelChoice> = loaded.maintainers;
  /** 单独配的模型用不了、退回跟随那一行时记过日志的（agent id → 那个模型；不刷屏） */
  const fallbackLogged = new Map<string, string>();
  /** 设置文件读不出来的原因（这时在用默认；设置页存一次覆盖它之后清掉） */
  let fileError: string | undefined = loaded.error;
  /** 有一个连通测试在跑 */
  let testing = false;
  /** 模型目录里各服务商的模型（查一次记住；查不到的不记，下次再查） */
  const catalogs = new Map<string, Promise<CatalogModel[]>>();
  /** 已经查到的模型目录（拉起 agent 时同步地判断单独配的模型还在不在，120 号票）；没查到过的服务商没有 */
  const known = new Map<string, readonly CatalogModel[]>();

  /**
   * 设置里选的自定义（OpenAI 兼容）服务商：选了 custom 才有。子进程按它登记 provider（模型目录里没有它），
   * 模型 id 也从它来（服务商只有一个模型）
   */
  const customOf = (): ModelCustomProvider | undefined => (settings.provider === CUSTOM_PROVIDER_ID ? settings.custom : undefined);

  /** 这次问模型目录时带给子进程的自定义服务商（自定义 provider 要先在子进程里登记，getModels 才认得） */
  const catalogOf = (provider: string, custom?: ModelCustomProvider | undefined): Promise<CatalogModel[]> => {
    let pending = catalogs.get(provider);
    if (!pending) {
      pending = options.probe({ type: "catalog", provider, ...(custom === undefined ? {} : { custom }) }).then((result) => {
        if (result.type !== "catalog") throw new Error("模型探查回的不是模型列表"); // @i18n-ignore log：编程错误
        known.set(provider, result.models);
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
  const catalog = async (provider: string, custom?: ModelCustomProvider | undefined): Promise<{ models?: CatalogModel[]; error?: string }> => {
    try {
      return { models: await catalogOf(provider, custom) };
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

  /**
   * 单独配的模型用不了的原因（120 号票）：模型目录查到了、里面没有它（pi 升级后去掉了、改了名）。目录还没查到时不知道，按能用
   * （拉不起会话时会话里有说明，和设置页选的一样）
   */
  const unavailableReason = (modelId: string): string | undefined => {
    const models = known.get(settings.provider);
    if (!models || models.some((m) => m.modelId === modelId)) return undefined;
    const provider = providerOf(settings.provider) ?? MODEL_PROVIDERS[0]!;
    return t("modelSettings.ownUnavailable", { modelId, provider: provider.label });
  };

  /** 这个维护者单独配的、还能用的（用不了的记一次日志，退回跟随那一行） */
  const usableOwn = (agentId: string): ModelChoice | undefined => {
    const own = maintainers[agentId];
    if (!own) return undefined;
    const reason = unavailableReason(own.modelId);
    if (reason === undefined) {
      fallbackLogged.delete(agentId);
      return own;
    }
    if (fallbackLogged.get(agentId) !== own.modelId) {
      fallbackLogged.set(agentId, own.modelId);
      log(`${agentId} ${reason}：退回跟随它那一行的设置（在它的 ⚙ 里重新选一个，或者改回跟随）`);
    }
    return undefined;
  };

  /** 写设置文件：设置加上单独配了模型的维护者（没有就不写这一项） */
  const save = (next: ModelSettings, nextMaintainers: Record<string, ModelChoice>, where: string) => {
    writeJsonAtomic(file, { format: 1, ...next, ...(Object.keys(nextMaintainers).length === 0 ? {} : { maintainers: nextMaintainers }) } satisfies ModelSettingsFile);
    settings = next;
    maintainers = nextMaintainers;
    if (fileError !== undefined) log(`模型设置的文件读不出来，${where}存了一份新的，覆盖了它：${file}`);
    fileError = undefined;
  };

  /** 设置页上列出的单独配了模型的维护者 */
  const maintainerViews = (): MaintainerModelView[] =>
    Object.entries(maintainers).flatMap(([agentId, choice]) => {
      const who = options.maintainerOwner?.(agentId);
      if (!who) return [];
      const reason = unavailableReason(choice.modelId);
      return [{ agentId, ...who, choice: { ...choice }, ...(reason === undefined ? {} : { unavailable: reason }) }];
    });

  /** 设置里选的服务商的 key 的状态：只说配没配、从哪来 */
  const apiKeyOf = (provider: ModelProvider): ModelApiKeyStatus => ({ configured: Boolean(credentials[provider.id]), envVar: provider.keyEnv, secretFile: provider.secretFile, lsm: options.lsm() });

  /** 密钥区里这个服务商的 key 文件（登记表的 secretFile 是相对数据目录的） */
  const keyFileOf = (provider: ModelProvider): string => path.join(layout.root, provider.secretFile);

  const view = async (): Promise<ModelSettingsView> => {
    const provider = providerOf(settings.provider) ?? MODEL_PROVIDERS[0]!;
    const custom = customOf();
    const { models: catalogModels, error } = await catalog(provider.id, custom);
    // 自定义服务商只有一个模型（用户填的那个）：别处提到的 DeepSeek 模型 id 这时不算可选的
    const ids =
      custom === undefined
        ? unique([...(catalogModels ?? []).map((m) => m.modelId), ...registered(provider.id), ...mentioned(settings, maintainers)])
        : unique([custom.modelId, ...registered(provider.id)]);
    const models = ids.map((modelId) => optionView(provider, modelId, catalogModels));
    const secretarySession = options.secretarySession();
    return {
      providers: MODEL_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
      apiKey: apiKeyOf(provider),
      models,
      ...(error === undefined ? {} : { catalogError: error }),
      ...(fileError === undefined ? {} : { settingsFileError: fileError }),
      settings: structuredClone(settings),
      effective: Object.fromEntries(MODEL_AGENTS.map((agent) => [agent, effectiveChoiceOf(agent)])) as Record<ModelAgent, ModelChoice>,
      ...(secretarySession ? { secretarySession } : {}),
      maintainers: maintainerViews(),
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
    const { models } = await catalog(provider, customOf());
    if (models) return { ids: new Set(models.map((m) => m.modelId)), fromCatalog: true };
    return { ids: new Set([...registered(provider), ...mentioned(settings, maintainers)]), fromCatalog: false };
  };

  /**
   * 这个 agent 实际会用的（设置页上的"实际会用的"、拉起 agent 时的 model）：自定义（OpenAI 兼容）服务商只有一个模型，
   * 模型 id 一律按设置里的 custom.modelId——default、各个 agent 覆盖里写的模型 id 是切回 DeepSeek 时接着用的，自定义时不起作用；
   * 思考档位照旧按那一行（给了 own 就是维护者单独配的那一份）
   */
  const effectiveChoiceOf = (agent: ModelAgent, own?: ModelChoice): ModelChoice => {
    const choice = own ?? effectiveModelChoice(settings, agent);
    const custom = customOf();
    return custom === undefined ? { ...choice } : { modelId: custom.modelId, thinkingLevel: choice.thinkingLevel };
  };

  /** 连通测试本身（test 管同一时间只跑一个） */
  const ping = async (modelId: string | undefined, input?: ModelCustomProvider): Promise<ModelTestResult> => {
    const provider = providerOf(settings.provider) ?? MODEL_PROVIDERS[0]!;
    // 自定义服务商：测请求体带来的那份（设置页还没存就想试一下），没带就按设置里存的；测的模型就是它里面的 modelId
    const custom = provider.id === CUSTOM_PROVIDER_ID ? (input ?? settings.custom) : undefined;
    const target = custom?.modelId ?? modelId ?? settings.default.modelId;
    const started = performance.now();
    const key = credentials[provider.id];
    if (!key) return { ok: false, modelId: target, totalMs: 0, error: t("modelSettings.noKey", { provider: provider.label, env: provider.keyEnv, file: provider.secretFile }) };
    // 自定义服务商只有一个模型，没有目录可查（它能不能用由这次请求说了算）
    if (custom === undefined) checkModel(target, await selectable(provider.id), provider, t("modelSettings.where.test"));
    const spec: CatalogModelSpec = { kind: "catalog", provider: provider.id, modelId: target, thinkingLevel: "off", ...(custom !== undefined || options.catalogBaseUrl === undefined ? {} : { baseUrl: options.catalogBaseUrl }) };
    try {
      const result = await options.probe({ type: "ping", model: spec, credentials: { [provider.id]: key }, ...(custom === undefined ? {} : { custom }) });
      if (result.type !== "ping") throw new Error("模型探查回的不是连通测试的结果"); // @i18n-ignore log：编程错误
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

  // 有单独配了模型的维护者：起来时就查一次模型目录（在一次性子进程里，不连网），好知道配的模型还在不在
  if (Object.keys(maintainers).length > 0) void catalog(settings.provider, customOf());

  return {
    current: () => structuredClone(settings),
    customProvider() {
      const custom = customOf();
      return custom === undefined ? undefined : { ...custom };
    },
    modelFor(agent, maintainerId) {
      const choice = effectiveChoiceOf(agent, maintainerId === undefined ? undefined : usableOwn(maintainerId));
      return { kind: "catalog", provider: settings.provider, modelId: choice.modelId, thinkingLevel: choice.thinkingLevel, ...(options.catalogBaseUrl === undefined ? {} : { baseUrl: options.catalogBaseUrl }) };
    },
    maintainerModel(agentId, agent) {
      // "它那一行"实际会用的（自定义服务商时模型 id 按 custom.modelId，见 effectiveChoiceOf）
      const role = effectiveChoiceOf(agent);
      const own = maintainers[agentId];
      const reason = own && unavailableReason(own.modelId);
      return { role, ...(own ? { own: { ...own } } : {}), ...(reason === undefined ? {} : { unavailable: reason }), next: own && reason === undefined ? { ...own } : role };
    },
    async setMaintainerModel(agentId, choice) {
      const provider = providerOf(settings.provider) ?? MODEL_PROVIDERS[0]!;
      // 自定义服务商只有一个模型、没有目录可查：照收（和设置页整份存一个道理）
      if (customOf() === undefined) checkModel(choice.modelId, await selectable(provider.id), provider, t("modelSettings.where.own"));
      const before = maintainers[agentId];
      if (fileError === undefined && before?.modelId === choice.modelId && before.thinkingLevel === choice.thinkingLevel) return;
      save(settings, { ...maintainers, [agentId]: { modelId: choice.modelId, thinkingLevel: choice.thinkingLevel } }, `${agentId} 的 ⚙ 里`); // @i18n-ignore log：只进日志
      fallbackLogged.delete(agentId);
      log(`${agentId} 单独配了模型：${choice.modelId}（思考 ${choice.thinkingLevel}），下一个新会话起生效`);
    },
    followRole(agentId, why) {
      const dropped = maintainers[agentId];
      if (!dropped) return false;
      const rest = { ...maintainers };
      delete rest[agentId];
      save(settings, rest, "改回跟随时"); // @i18n-ignore log：只进日志
      fallbackLogged.delete(agentId);
      log(`${agentId} 不再单独配模型（原来是 ${dropped.modelId}，思考 ${dropped.thinkingLevel}）：${why}；改回跟随它那一行的设置`);
      return true;
    },
    configuredVision,
    async visionOf(model) {
      const configured = configuredVision()[model.kind === "faux" ? "faux" : modelKeyOf(model.provider, model.modelId)];
      if (configured !== undefined) return configured;
      // pi 的 faux 模型输入里有图片（和子进程里一样按它）
      if (model.kind === "faux") return true;
      const { models } = await catalog(model.provider, customOf());
      return models?.find((m) => m.modelId === model.modelId)?.vision ?? false;
    },
    view,
    keyView() {
      const provider = providerOf(settings.provider) ?? MODEL_PROVIDERS[0]!;
      return { provider: { id: provider.id, label: provider.label }, apiKey: apiKeyOf(provider) };
    },
    saveKey(raw) {
      // 服务商不跟着请求走：按设置里选的那一个（deepseek 或者自定义服务商 custom，写进它自己的那个密钥文件）
      const provider = providerOf(settings.provider) ?? MODEL_PROVIDERS[0]!;
      const key = normalizeModelKey(raw);
      if (key.length < MODEL_KEY_MIN_LENGTH) throw new RequestRejected("bad_params", t("modelSettings.keyTooShort", { min: MODEL_KEY_MIN_LENGTH }));
      if (key.length > MODEL_KEY_MAX_LENGTH) throw new RequestRejected("bad_params", t("modelSettings.keyTooLong", { max: MODEL_KEY_MAX_LENGTH }));
      writeModelKeyFile(keyFileOf(provider), key);
      // 换成现在用的：下一个新会话（秘书的话是下一条消息之前重新拉起）起就用新的，不用重启守护进程
      credentials[provider.id] = key;
      options.keyApplied?.(provider, key);
      log(`${provider.label} 的 API key 在网页上填好了：写进密钥区的 ${provider.secretFile}，现在起的模型调用就用新的`); // @i18n-ignore log：只进日志
      return { configured: true, effective: "now", apiKey: apiKeyOf(provider) };
    },
    async change(body) {
      const provider = providerOf(body.provider);
      if (!provider) throw new RequestRejected("bad_params", t("modelSettings.badProvider", { provider: body.provider, providers: MODEL_PROVIDERS.map((p) => p.label).join(t("modelSettings.listSep")) }));
      // 自定义服务商的那一块：选了 custom 时必须有、地址和模型 id 要合规；这次没带就留着原来那份（切到 DeepSeek 时别把手填的弄丢）
      const checked = checkModelCustom(body);
      if (!checked.ok) throw new RequestRejected("bad_params", checked.error);
      const custom = checked.custom ?? settings.custom;
      // 自定义服务商只有一个模型（custom.modelId），没有模型目录可查：整份存时不再拿目录核对模型 id
      const allowed = provider.id === CUSTOM_PROVIDER_ID ? undefined : await selectable(provider.id);
      const check = (modelId: string, where: string): void => {
        if (allowed !== undefined) checkModel(modelId, allowed, provider, where);
      };
      check(body.default.modelId, t("modelSettings.where.default"));
      const agents: ModelSettings["agents"] = {};
      for (const agent of MODEL_AGENTS) {
        const override = body.agents[agent];
        if (override?.modelId !== undefined) check(override.modelId, t("modelSettings.where.agent", { agent }));
        // 两项都跟随默认的不记
        if (override?.modelId !== undefined || override?.thinkingLevel !== undefined) {
          agents[agent] = { ...(override.modelId === undefined ? {} : { modelId: override.modelId }), ...(override.thinkingLevel === undefined ? {} : { thinkingLevel: override.thinkingLevel }) };
        }
      }
      const vision: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(body.vision)) {
        const parts = splitModelKey(key);
        if (parts?.provider !== provider.id) throw new RequestRejected("bad_params", t("modelSettings.badVisionKey", { expected: modelKeyOf(provider.id, t("modelSettings.modelIdWord")), key }));
        check(parts.modelId, t("modelSettings.where.vision"));
        vision[key] = value;
      }
      const next: ModelSettings = { provider: provider.id, default: { modelId: body.default.modelId, thinkingLevel: body.default.thinkingLevel }, agents, vision, ...(custom === undefined ? {} : { custom }) };
      // 设置文件读不出来时，存一次就覆盖它（哪怕和正在用的默认一样）；单独配了模型的维护者原样留着（120 号票，只经 ⚙ 改）
      if (fileError !== undefined || JSON.stringify(next) !== JSON.stringify(settings)) {
        save(next, maintainers, "设置页"); // @i18n-ignore log：只进日志
        // 自定义服务商的地址、模型 id 变了：模型目录那份记的不作数了，下次要用时重查（在一次性子进程里登记后查）
        catalogs.delete(CUSTOM_PROVIDER_ID);
        known.delete(CUSTOM_PROVIDER_ID);
        log(`模型设置改了（下一个新会话起生效）：默认 ${next.default.modelId}（思考 ${next.default.thinkingLevel}）${describeAgents(next)}`);
      }
      return view();
    },
    async test(modelId, custom) {
      if (testing) throw new RequestRejected("conflict", t("modelSettings.testing"));
      testing = true;
      try {
        return await ping(modelId, custom);
      } finally {
        testing = false;
      }
    },
    async customModels(baseUrl) {
      // 列模型永远是"自定义服务商"的事，key 只能用 custom 那一份：以前按"当前选中的服务商"取，
      // 于是 provider 还是 deepseek 时调这个接口，会把 DeepSeek 的 key 当 Bearer 发给请求里那个任意 baseUrl。
      const provider = providerOf(CUSTOM_PROVIDER_ID) ?? MODEL_PROVIDERS[0]!;
      return listCustomModels(baseUrl ?? settings.custom?.baseUrl, credentials[CUSTOM_PROVIDER_ID], provider);
    },
  };
}

/** 列模型最多等这么久（毫秒）：就一次 GET，服务慢时也不至于把设置页卡住 */
const CUSTOM_MODELS_TIMEOUT_MS = 15_000;

/**
 * 列出自定义（OpenAI 兼容）服务商的模型：GET {baseUrl}/models，带 Authorization: Bearer <key>。
 * 只认 OpenAI 兼容的写法（{ data: [{ id, name?, owned_by? }] }，也认直接一个数组），最多收 CUSTOM_MODELS_MAX 个。
 * 列不成不算出错：ok 为 false、error 写原因；原因里去掉 key 的内容（服务商的报错可能带着它）
 */
async function listCustomModels(baseUrl: string | undefined, key: string | undefined, provider: ModelProvider): Promise<ModelCustomModelsResult> {
  const url = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (url === "") return { ok: false, models: [], error: t("modelSettings.custom.noBaseUrl") };
  if (key === undefined) return { ok: false, models: [], error: t("modelSettings.noKey", { provider: provider.label, env: provider.keyEnv, file: provider.secretFile }) };
  try {
    const response = await fetch(`${url}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(CUSTOM_MODELS_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      // 服务商的报错原样带一句（截短），key 的内容去掉
      return { ok: false, models: [], error: redactApiKeys(t("modelSettings.custom.listFailed", { error: `${response.status} ${oneLine(text).slice(0, 300)}` }), [key]) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, models: [], error: t("modelSettings.custom.listNotJson", { status: String(response.status) }) };
    }
    const list = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : undefined;
    if (list === undefined) return { ok: false, models: [], error: t("modelSettings.custom.listBadResponse", { status: String(response.status) }) };
    const models: ModelCustomModel[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as { id?: unknown; name?: unknown; owned_by?: unknown };
      if (typeof entry.id !== "string" || entry.id.trim() === "") continue;
      models.push({
        id: entry.id.trim(),
        ...(typeof entry.name === "string" && entry.name !== "" ? { name: entry.name } : {}),
        ...(typeof entry.owned_by === "string" && entry.owned_by !== "" ? { ownedBy: entry.owned_by } : {}),
      });
      if (models.length >= CUSTOM_MODELS_MAX) break;
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: redactApiKeys(t("modelSettings.custom.listFailed", { error: firstLine(err) }), [key]) };
  }
}

/** 一行：换行、回车都换成空格（服务商回的报错可能是一整页） */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** keys（「provider/模型 id」）里这个服务商的模型 id */
function modelIdsOf(provider: string, keys: readonly string[]): string[] {
  return unique(keys.flatMap((key) => {
    const parts = splitModelKey(key);
    return parts?.provider === provider ? [parts.modelId] : [];
  }));
}

/** 设置里提到的模型（默认、各个 agent 的、改过看图能力的、单独配了模型的维护者的） */
function mentioned(s: ModelSettings, maintainers: Readonly<Record<string, ModelChoice>>): string[] {
  return unique([
    s.default.modelId,
    ...MODEL_AGENTS.flatMap((agent) => (s.agents[agent]?.modelId === undefined ? [] : [s.agents[agent].modelId])),
    ...modelIdsOf(s.provider, Object.keys(s.vision)),
    ...Object.values(maintainers).map((c) => c.modelId),
  ]);
}

/** 这个模型能不能选：不能时抛 RequestRejected（HTTP 回 400），说清是哪一项、为什么 */
function checkModel(modelId: string, allowed: { ids: Set<string>; fromCatalog: boolean }, provider: ModelProvider, where: string): void {
  if (allowed.ids.has(modelId)) return;
  throw new RequestRejected(
    "bad_params",
    allowed.fromCatalog ? t("modelSettings.notInCatalog", { where, provider: provider.label, modelId }) : t("modelSettings.catalogUnavailable", { where, modelId }),
  );
}

/**
 * 读设置文件：没有是默认；读不了、不合规时 error 是原因，按默认用、记一条日志（先不覆盖文件：设置页上提示，存一次才覆盖）
 */
function readSettings(file: string, log: (line: string) => void): { settings: ModelSettings; maintainers: Record<string, ModelChoice>; error?: string } {
  const broken = (error: string) => {
    log(`模型设置的文件读不出来：${file}：${error}；正在用默认，设置页保存会覆盖它`);
    return { settings: structuredClone(DEFAULT_MODEL_SETTINGS) as ModelSettings, maintainers: {}, error };
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: structuredClone(DEFAULT_MODEL_SETTINGS) as ModelSettings, maintainers: {} };
    return broken(err instanceof Error ? err.message : String(err));
  }
  if (!settingsFile.check(parsed)) return broken(t("modelSettings.file.invalid", { error: settingsFile.firstError(parsed) ?? t("modelSettings.file.invalidUnknown") }));
  if (!providerOf(parsed.provider)) return broken(t("modelSettings.file.badProvider", { provider: parsed.provider, providers: MODEL_PROVIDERS.map((p) => p.id).join(t("modelSettings.listSep")) }));
  // 跨字段的那几条：provider 是 custom 时要有 custom，地址要是 http(s)、模型 id 不能空（旧文件没有这一项，照旧合规）
  const checked = checkModelCustom(parsed);
  if (!checked.ok) return broken(t("modelSettings.file.invalid", { error: checked.error }));
  const { format: _format, maintainers, ...settings } = parsed;
  return { settings: { ...settings, ...(checked.custom === undefined ? {} : { custom: checked.custom }) } as ModelSettings, maintainers: (maintainers ?? {}) as Record<string, ModelChoice> };
}

// @i18n-ignore-next log：只进日志
function describeAgents(settings: ModelSettings): string {
  const parts = MODEL_AGENTS.flatMap((agent) => {
    const o = settings.agents[agent];
    if (!o) return [];
    return [`${agent} ${o.modelId ?? "跟随默认"}（思考 ${o.thinkingLevel ?? "跟随默认"}）`]; // @i18n-ignore log：只进日志
  });
  return parts.length === 0 ? "，各个 agent 都跟随默认" : `；${parts.join("，")}`; // @i18n-ignore log：只进日志
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split(/\r?\n/, 1)[0] ?? text;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
