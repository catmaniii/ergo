// 设置里的"模型"（73 号票，规格第 1 节"模型"）：名字、纯函数和接口的样子，守护进程和 Web 共用。不引用 TypeBox
// （设置文件和请求体的 schema 在 model-settings-schema.ts）。
//
// - 模型在服务端（二狗守护进程这台电脑）调用，服务商做成一张登记表，目前只有 DeepSeek 一项（以后加服务商只加一项，这次不实现别家）；
// - 默认模型和思考档位，加上按 agent 的覆盖（秘书、任务维护者、项目维护者、子 agent、评审、范围审视），各自"跟随默认"或者选定；
// - 一个会话固定一个模型：改了以后下一个新会话生效，正在进行的会话（接着的会话）照旧用它开始时的模型、思考档位和看图能力；
//   长会话（秘书的长期主线、项目维护者的对话段、定时触发的任务（76 号票）的 agent）换模型就新开会话、附一份交接摘要（83 号票），任务执行中途不换；
// - API key 只说配没配、从哪来（LSM 从数据目录的密钥区注入守护进程的环境），接口和页面里都没有 key 的内容，也不在页面里输入 key；
// - 看图能力：设置页改的为准，其次是配置文件 models["provider/模型 id"].vision 写明的，都没写按模型目录（79 号票）。
import { ASSISTANT_NAME_MARK } from "./assistant-name.ts";

/** 各自选模型的 agent。普通任务的 agent、迁移来的定时作业自己的维护者都算任务维护者 */
export const MODEL_AGENTS = ["secretary", "task_maintainer", "project_maintainer", "sub_agent", "reviewer", "scope_review"] as const;
export type ModelAgent = (typeof MODEL_AGENTS)[number];

/** agent 的叫法：秘书写名字占位，界面按用户起的名字显示（43 号票） */
export const MODEL_AGENT_LABEL: Readonly<Record<ModelAgent, string>> = {
  secretary: ASSISTANT_NAME_MARK,
  task_maintainer: "任务维护者",
  project_maintainer: "项目维护者",
  sub_agent: "子 agent",
  reviewer: "评审",
  scope_review: "范围审视",
};

/** agent 的一句说明：它的会话什么时候算"新会话"（改了设置从那时起生效）；范围审视不进会话，每次审视时现取 */
export const MODEL_AGENT_NOTE: Readonly<Record<ModelAgent, string>> = {
  secretary: "只有一条长期主线会话：改了以后，你的下一条消息时新开会话、附一份交接摘要，接着之前的对话",
  task_maintainer: "每个任务的维护者一个会话，执行中途不换，新任务用新设置；定时触发的任务下一次运行开头新开会话、附交接摘要",
  project_maintainer: "每张工单、每段对话一个新会话；对话段里改了，下一条消息时新开会话、附交接摘要；工单做到一半不换",
  sub_agent: "每个并行派出的子 agent 一个新会话",
  reviewer: "每次阶段验收的评审一个新会话",
  scope_review: "压缩时、工单结束时另开一次调用、不进会话，每次审视时按设置现取",
};

/** 设置里能选的思考档位：关、低、中、高（模型不分这么细时由 pi 就近取它支持的，比如 deepseek-v4-pro 只有关和高） */
export const MODEL_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

export const MODEL_THINKING_LABEL: Readonly<Record<ModelThinkingLevel, string>> = { off: "关", low: "低", medium: "中", high: "高" };

/** 一个选定：哪个模型、什么思考档位（服务商是设置里的那一个） */
export interface ModelChoice {
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
}

/** 一个 agent 的覆盖：不写的那一项跟随默认 */
export interface ModelAgentOverride {
  modelId?: string;
  thinkingLevel?: ModelThinkingLevel;
}

/** 设置的内容（设置文件里存的、设置页改的整份） */
export interface ModelSettings {
  /** 服务商（登记表里的 id；目前只有 deepseek） */
  provider: string;
  /** 默认模型和思考档位 */
  default: ModelChoice;
  /** 按 agent 的覆盖；没有这个 agent 就是全部跟随默认 */
  agents: Partial<Record<ModelAgent, ModelAgentOverride>>;
  /** 设置页改的看图能力，键是「provider/模型 id」；没有的按配置文件写明的、再按模型目录 */
  vision: Record<string, boolean>;
}

/** 某个 agent 实际会用的：跟随默认的那一项换成默认 */
export function effectiveModelChoice(settings: Pick<ModelSettings, "default" | "agents">, agent: ModelAgent): ModelChoice {
  const override = settings.agents[agent];
  return { modelId: override?.modelId ?? settings.default.modelId, thinkingLevel: override?.thinkingLevel ?? settings.default.thinkingLevel };
}

/**
 * 模型在配置里的键（和配置文件的 models、tokenPrices 的键一样，设置里看图能力的键也是它）：「provider/模型 id」。
 * 拼和拆都走这里（modelKeyOf / splitModelKey），别处不手写斜杠
 */
export function modelKeyOf(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** 拆开「provider/模型 id」（在第一个斜杠处拆，模型 id 里可以再有斜杠）；不是这个写法的（如测试里的 faux）是 undefined */
export function splitModelKey(key: string): { provider: string; modelId: string } | undefined {
  const at = key.indexOf("/");
  if (at <= 0 || at === key.length - 1) return undefined;
  return { provider: key.slice(0, at), modelId: key.slice(at + 1) };
}

/** 看图能力从哪来：设置页改的、配置文件写明的、模型目录 */
export const MODEL_VISION_SOURCES = ["settings", "config", "catalog"] as const;
export type ModelVisionSource = (typeof MODEL_VISION_SOURCES)[number];

/** 设置页上的一个服务商（登记表里的一项） */
export interface ModelProviderView {
  id: string;
  /** 名字，如 DeepSeek */
  label: string;
}

/**
 * API key 的状态：只说配没配、从哪来，没有 key 的任何内容（连开头结尾几个字也没有）。
 * key 由 LSM 从数据目录密钥区的 secretFile 读出、注入守护进程的环境变量 envVar；守护进程只看这个变量有没有值
 */
export interface ModelApiKeyStatus {
  configured: boolean;
  /** 守护进程从哪个环境变量取 */
  envVar: string;
  /** LSM 从数据目录里的哪个文件注入（相对数据目录） */
  secretFile: string;
  /** 守护进程是不是接入了 LSM（经 LSM 拉起时才有注入） */
  lsm: boolean;
}

/** 设置页上可选的一个模型 */
export interface ModelOptionView {
  modelId: string;
  /** 模型目录里的名字（如 DeepSeek V4.1 Flash）；目录里没有时不给 */
  name?: string;
  /** 模型目录里有没有它（没有的选了也拉不起会话） */
  inCatalog: boolean;
  /** 实际能不能看图；目录里没有、配置也没写时不知道（undefined） */
  vision?: boolean;
  /** 看图能力从哪来 */
  visionSource?: ModelVisionSource;
  /** 模型目录里的看图能力（目录里没有时不给），设置页"按模型目录"那一项显示它 */
  catalogVision?: boolean;
  /** 配置文件里写明的看图能力（没写不给） */
  configVision?: boolean;
  /** 模型支持的思考档位（模型目录里的，设置里能选的那几档）；不知道时不给 */
  thinkingLevels?: ModelThinkingLevel[];
}

/** 一个会话正在用的模型（秘书的主线会话：设置页上告诉用户它现在用的是哪个） */
export interface SessionModelView {
  modelId: string;
  /** 思考档位（pi 的叫法，可能是设置里没有的档） */
  thinkingLevel: string;
  vision: boolean;
}

/** 设置页取到的全部（GET /api/model-settings） */
export interface ModelSettingsView {
  /** 服务商登记表（目前只有 DeepSeek） */
  providers: ModelProviderView[];
  apiKey: ModelApiKeyStatus;
  /** 可选的模型：模型目录里这个服务商的、配置文件里登记的（models、tokenPrices 的键），加上设置里已经选了的 */
  models: ModelOptionView[];
  /** 模型目录查不到时的原因（这时可选的只有配置里登记的和已经选了的） */
  catalogError?: string;
  /** 设置文件读不出来（读不了、不合规）时的原因：这时正在用默认，设置页存一次会覆盖它；存好之后不再给 */
  settingsFileError?: string;
  settings: ModelSettings;
  /** 每个 agent 实际会用的（下一个新会话起） */
  effective: Record<ModelAgent, ModelChoice>;
  /** 秘书的主线会话现在用的（秘书在运行时才有） */
  secretarySession?: SessionModelView;
}

/** 连通测试的结果：通不通、首 token 延迟（毫秒）、整次多久；不通时 error 是原因（不含 key 的内容） */
export interface ModelTestResult {
  ok: boolean;
  modelId: string;
  firstTokenMs?: number;
  totalMs: number;
  error?: string;
}

/** 设置页上改的看图能力怎么写：follow 是去掉设置页的这一项（按配置文件写明的、再按模型目录） */
export type ModelVisionChoice = "follow" | "on" | "off";
