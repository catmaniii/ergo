// 设置里的"模型"（73 号票）：设置文件和设置接口的 schema。名字、纯函数和响应的样子在 model-settings.ts（不引用 TypeBox）。
//
// 数据目录配置区的 model-settings.json 是真相，只由运行时写（设置接口）；没有这个文件时全按默认（deepseek-flash、思考档位高）。
// 设置接口是整份替换（幂等：同样的再存一次没有变化），所以不带幂等键。请求体里没有、也放不进 API key（多出来的字段一律拒绝）。
import { type Static, Type } from "typebox";
import { MODEL_THINKING_LEVELS, type ModelAgent } from "./model-settings.ts";

/** 模型 id：字母、数字和 . _ - :（DeepSeek 的 id 都是这样），最长 100 */
const ModelId = Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });

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
  },
  { additionalProperties: false },
);
export type ModelSettingsFile = Static<typeof ModelSettingsFile>;

/** 某个维护者单独配模型（PUT /api/agents/<agent id>/model，120 号票）：选定的模型和思考档位；改回跟随那一行是 DELETE */
export const AgentModelBody = ModelChoiceSchema;
export type AgentModelBody = Static<typeof AgentModelBody>;

/** 连通测试（POST /api/model-settings/test）：测哪个模型；不给是默认模型 */
export const ModelTestBody = Type.Object({ modelId: Type.Optional(ModelId) }, { additionalProperties: false });
export type ModelTestBody = Static<typeof ModelTestBody>;

/**
 * 在网页上填模型的 key（POST /api/model-settings/key，用户 2026-10-28 定）：只有 key，不带服务商——按设置里的那一个（目前只有 deepseek）。
 * 这里只挡空和太长；去掉首尾空白、BOM、换行以后够不够长由守护进程按 MODEL_KEY_MIN_LENGTH 判（400 说清楚）
 */
export const ModelKeyBody = Type.Object(
  { key: Type.String({ minLength: 1, maxLength: 1000 }) },
  { additionalProperties: false },
);
export type ModelKeyBody = Static<typeof ModelKeyBody>;
