// 设置里的"模型"（73 号票）：设置文件和设置接口的 schema。名字、纯函数和响应的样子在 model-settings.ts（不引用 TypeBox）。
//
// 数据目录配置区的 model-settings.json 是真相，只由运行时写（设置接口）；没有这个文件时全按默认（deepseek-flash、思考档位高）。
// 设置接口是整份替换（幂等：同样的再存一次没有变化），所以不带幂等键。请求体里没有、也放不进 API key（多出来的字段一律拒绝）。
import { type Static, Type } from "typebox";
import { CUSTOM_PROVIDER_APIS, MODEL_THINKING_LEVELS, type ModelAgent } from "./model-settings.ts";

/** 模型 id：字母、数字和 . _ - :（DeepSeek 的 id 都是这样），最长 100 */
const ModelId = Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });

/** 自定义服务商那边的模型 id：原样交给那家服务商，所以只挡空白（别的写法的 id 不少，比如带斜杠的） */
const CustomModelId = Type.String({ minLength: 1, maxLength: 200, pattern: "^[^\\s]+$" });

/** 自定义服务商的接口地址：http:// 或 https:// 开头，不能有空白（末尾的斜杠由守护进程去掉） */
const CustomBaseUrl = Type.String({ minLength: 8, maxLength: 500, pattern: "^https?://[^\\s]+$" });

/**
 * 自定义（OpenAI 兼容）服务商（设置页填的那一栏）：接口地址、模型 id、可选的接口风格。
 * provider 是 custom 时必须有这一项、不选时可以没有（这条跨字段的规矩 schema 管不了，见 checkModelCustom）
 */
export const CustomProviderSchema = Type.Object(
  {
    baseUrl: CustomBaseUrl,
    modelId: CustomModelId,
    api: Type.Optional(Type.Enum(CUSTOM_PROVIDER_APIS)),
  },
  { additionalProperties: false },
);
export type CustomProviderSchema = Static<typeof CustomProviderSchema>;

const ThinkingLevel = Type.Enum(MODEL_THINKING_LEVELS);

export const ModelChoiceSchema = Type.Object({ modelId: ModelId, thinkingLevel: ThinkingLevel }, { additionalProperties: false });

export const ModelAgentOverrideSchema = Type.Object(
  { modelId: Type.Optional(ModelId), thinkingLevel: Type.Optional(ThinkingLevel) },
  { additionalProperties: false },
);

/** 按 agent 的覆盖：键只能是这几个 agent（MODEL_AGENTS） */
const AgentOverrides = Type.Object(
  {
    secretary: Type.Optional(ModelAgentOverrideSchema),
    task_maintainer: Type.Optional(ModelAgentOverrideSchema),
    project_maintainer: Type.Optional(ModelAgentOverrideSchema),
    sub_agent: Type.Optional(ModelAgentOverrideSchema),
    reviewer: Type.Optional(ModelAgentOverrideSchema),
    scope_review: Type.Optional(ModelAgentOverrideSchema),
  } satisfies Record<ModelAgent, unknown>,
  { additionalProperties: false },
);

/** 设置页改的看图能力：键是「provider/模型 id」（别的写法的键不收） */
const VisionOverrides = Type.Record(Type.String({ pattern: "^[a-z0-9-]+/[A-Za-z0-9][A-Za-z0-9._:-]*$" }), Type.Boolean(), { additionalProperties: false });

/** 设置的内容（设置页存的整份，POST /api/model-settings 的请求体） */
export const ModelSettingsBody = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 40 }),
    default: ModelChoiceSchema,
    agents: AgentOverrides,
    vision: VisionOverrides,
    /** 自定义（OpenAI 兼容）服务商：选了 provider: custom 时必须有（checkModelCustom 查） */
    custom: Type.Optional(CustomProviderSchema),
  },
  { additionalProperties: false },
);
export type ModelSettingsBody = Static<typeof ModelSettingsBody>;

/**
 * 单独配了模型的维护者（120 号票）：键是维护者的 agent id（tm-<n>、pm-<n>），值是选定的模型和思考档位（都要写，没有"跟随"的一半）。
 * 只经这个维护者的 ⚙ 改（PUT / DELETE /api/agents/<agent id>/model），设置页整份存时原样留着
 */
const MaintainerModels = Type.Record(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }), ModelChoiceSchema, { additionalProperties: false });

/** 设置在数据目录配置区里的文件（config/model-settings.json）：多一个格式版本；120 号票起多一项单独配了模型的维护者（没有就不写） */
export const ModelSettingsFile = Type.Object(
  {
    format: Type.Literal(1),
    provider: Type.String({ minLength: 1, maxLength: 40 }),
    default: ModelChoiceSchema,
    agents: AgentOverrides,
    vision: VisionOverrides,
    maintainers: Type.Optional(MaintainerModels),
    /** 自定义（OpenAI 兼容）服务商（自定义服务商这一步）：旧设置文件没有这一项，照样合规 */
    custom: Type.Optional(CustomProviderSchema),
  },
  { additionalProperties: false },
);
export type ModelSettingsFile = Static<typeof ModelSettingsFile>;

/** 某个维护者单独配模型（PUT /api/agents/<agent id>/model，120 号票）：选定的模型和思考档位；改回跟随那一行是 DELETE */
export const AgentModelBody = ModelChoiceSchema;
export type AgentModelBody = Static<typeof AgentModelBody>;

/**
 * 连通测试（POST /api/model-settings/test）：测哪个模型；不给是默认模型。
 * 自定义服务商（provider 是 custom）时：custom 不给就按设置里存的那份（地址、模型 id、接口风格），给了就测这一份
 * （设置页上还没存就想试一下）；custom 里的 modelId 优先于上面的 modelId
 */
export const ModelTestBody = Type.Object(
  { modelId: Type.Optional(ModelId), custom: Type.Optional(CustomProviderSchema) },
  { additionalProperties: false },
);
export type ModelTestBody = Static<typeof ModelTestBody>;

/**
 * 列出某个自定义（OpenAI 兼容）服务商有哪些模型（POST /api/model-settings/custom-models，响应 ModelCustomModelsResult）：
 * 只带接口地址——key 照旧从密钥区来（按设置里选的服务商），请求体里放不进 key；不给 baseUrl 就按设置里存的那份
 */
export const ModelCustomModelsBody = Type.Object(
  { baseUrl: Type.Optional(CustomBaseUrl) },
  { additionalProperties: false },
);
export type ModelCustomModelsBody = Static<typeof ModelCustomModelsBody>;

/**
 * 在网页上填模型的 key（POST /api/model-settings/key，用户 2026-10-28 定；2026-10-30 起可以点名服务商）：
 * - 不带 provider：按设置里选的那一个（deepseek 或者自定义服务商 custom），和以前一样；
 * - 带 provider：写那个服务商自己的 secretFile——设置 · 模型里 key 是**按服务商逐条列出**的，给"另一个服务商"填 key
 *   不用先把它切成当前服务商（这是用户说"找不到别的模型的 key 在哪填"的那一处）。不是登记表里的 id 时守护进程回 400。
 * 这里只挡空和太长；去掉首尾空白、BOM、换行以后够不够长由守护进程按 MODEL_KEY_MIN_LENGTH 判（400 说清楚）
 */
export const ModelKeyBody = Type.Object(
  { key: Type.String({ minLength: 1, maxLength: 1000 }), provider: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) },
  { additionalProperties: false },
);
export type ModelKeyBody = Static<typeof ModelKeyBody>;
