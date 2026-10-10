// 设置里的"模型"（73 号票）：设置页上的说法和"改一处、存整份"的纯函数。界面（pages/more/ModelsPage.tsx）只管画。
// - 设置存在守护进程（各设备一样），设置页每改一处就把整份存回去（POST /api/model-settings），守护进程查过合规才存；
// - 一个会话固定一个模型：改了以后下一个新会话生效，正在进行的会话照它开始时的（页面上写清楚）；长会话（秘书、项目维护者的对话段、
//   定时作业的维护者）下一轮新开会话、附交接摘要，任务执行中途不换（83 号票）；
// - API key 只说配没配、从哪来，页面上没有 key 的内容，也不能在这里输入；
// - 看图能力：这里改的为准，其次配置文件写明的，都没写按模型目录。
import {
  ASSISTANT_NAME_MARK,
  MODEL_AGENT_LABEL,
  MODEL_AGENTS,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  type ModelApiKeyStatus,
  type ModelChoice,
  type ModelOptionView,
  type ModelAgent,
  type ModelSettings,
  type ModelSettingsBody,
  type ModelSettingsView,
  type ModelTestResult,
  type ModelThinkingLevel,
  type ModelVisionChoice,
  type SessionModelView,
  effectiveModelChoice,
} from "./protocol.ts";

/** 页面顶上的一句：什么时候生效（说到秘书写名字占位，页面上换成用户起的名字） */
export const MODEL_SETTINGS_EFFECT_NOTE = `一个会话固定一个模型：改了以后下一个新会话生效。长会话（${ASSISTANT_NAME_MARK}、项目维护者的对话、定时作业的维护者）下一轮就新开会话、附一份交接摘要，接着之前的对话；任务执行中途不换。`;

/** 服务商那一项的说明 */
export const MODEL_PROVIDER_NOTE = "模型都在服务端（二狗守护进程这台电脑）调用。目前只支持 DeepSeek，以后会支持更多服务商。";

/** "各个 agent"那一节的说明（秘书写名字占位，界面按用户起的名字显示） */
export const MODEL_AGENTS_NOTE = `${MODEL_AGENTS.map((agent) => MODEL_AGENT_LABEL[agent]).join("、")}各自用什么模型：跟随默认，或者选定模型和思考档位。`;

/** 设置文件读不出来时页面上的提示（原因另写） */
export const MODEL_SETTINGS_FILE_BROKEN_NOTE = "设置文件读不出来，正在用默认；保存会覆盖它";

/** 存回去的整份：从设置复制一份（不改原来的） */
function bodyOf(settings: ModelSettings): ModelSettingsBody {
  return {
    provider: settings.provider,
    default: { ...settings.default },
    agents: Object.fromEntries(Object.entries(settings.agents).map(([agent, o]) => [agent, { ...o }])),
    vision: { ...settings.vision },
  };
}

/** 改默认模型或默认的思考档位 */
export function withDefault(settings: ModelSettings, patch: Partial<ModelChoice>): ModelSettingsBody {
  const body = bodyOf(settings);
  body.default = { ...body.default, ...patch };
  return body;
}

/** 改一个 agent：给 null 是这一项改回"跟随默认"；两项都跟随默认就去掉这个 agent */
export function withAgent(settings: ModelSettings, agent: ModelAgent, patch: { modelId?: string | null; thinkingLevel?: ModelThinkingLevel | null }): ModelSettingsBody {
  const body = bodyOf(settings);
  const next = { ...body.agents[agent] };
  if (patch.modelId === null) delete next.modelId;
  else if (patch.modelId !== undefined) next.modelId = patch.modelId;
  if (patch.thinkingLevel === null) delete next.thinkingLevel;
  else if (patch.thinkingLevel !== undefined) next.thinkingLevel = patch.thinkingLevel;
  if (next.modelId === undefined && next.thinkingLevel === undefined) delete body.agents[agent];
  else body.agents[agent] = next;
  return body;
}

/** 改一个模型的看图能力：follow 是去掉这里改的（按配置文件写明的、再按模型目录） */
export function withVision(settings: ModelSettings, key: string, choice: ModelVisionChoice): ModelSettingsBody {
  const body = bodyOf(settings);
  if (choice === "follow") delete body.vision[key];
  else body.vision[key] = choice === "on";
  return body;
}

/** 这里给这个模型改的看图能力（没改是 follow） */
export function visionChoiceOf(settings: ModelSettings, key: string): ModelVisionChoice {
  const v = settings.vision[key];
  return v === undefined ? "follow" : v ? "on" : "off";
}

/** API key 的状态怎么说：只有配没配、从哪来、没配时去哪配 */
export function apiKeyText(status: ModelApiKeyStatus): { label: string; ok: boolean; detail: string } {
  const lsm = status.lsm ? "" : "（守护进程现在不是经 LSM 启动的）";
  if (status.configured) {
    return {
      label: "已配置",
      ok: true,
      detail: `来自环境变量 ${status.envVar}：LSM 从数据目录密钥区的 ${status.secretFile} 读出，启动守护进程时注入${lsm}。这里不显示 key，也不能在这里输入。`,
    };
  }
  return {
    label: "没配置",
    ok: false,
    detail: `在 LSM 的 ergou-daemon 条目里给环境变量 ${status.envVar} 配上（env.from: file，指向数据目录密钥区的 ${status.secretFile}），再在 LSM 里重启 ergou-daemon${lsm}。这里不能输入 key。`,
  };
}

/** 一个模型在下拉里怎么写：名字和 id；模型目录里没有的注明 */
export function modelOptionLabel(option: ModelOptionView): string {
  const name = option.name && option.name !== option.modelId ? `${option.name}（${option.modelId}）` : option.modelId;
  return option.inCatalog ? name : `${name}（模型目录里没有）`;
}

const VISION_SOURCE_LABEL = { settings: "这里改的", config: "配置文件写明", catalog: "按模型目录" } as const;

/** 一个模型能不能看图、按什么定的 */
export function visionText(option: ModelOptionView): string {
  if (option.vision === undefined) return "不知道能不能看图（模型目录里没有）";
  return `${option.vision ? "能看图" : "看不了图"}（${VISION_SOURCE_LABEL[option.visionSource ?? "catalog"]}）`;
}

/** 看图能力的下拉里"跟随"那一项：不在这里改时按什么（配置文件写明的，或模型目录的） */
export function visionFollowLabel(option: ModelOptionView): string {
  if (option.configVision !== undefined) return `跟随配置文件（${option.configVision ? "能看图" : "看不了"}）`;
  if (option.catalogVision !== undefined) return `跟随模型目录（${option.catalogVision ? "能看图" : "看不了"}）`;
  return "跟随模型目录";
}

/** 思考档位实际会落到哪一档：模型不分这么细时 pi 就近取它支持的（先往高找，再往低找）；不知道支持哪几档时原样 */
export function effectiveThinking(level: ModelThinkingLevel, supported: readonly ModelThinkingLevel[] | undefined): ModelThinkingLevel {
  if (!supported || supported.length === 0 || supported.includes(level)) return level;
  const at = MODEL_THINKING_LEVELS.indexOf(level);
  const up = MODEL_THINKING_LEVELS.slice(at + 1).find((l) => supported.includes(l));
  if (up) return up;
  for (let i = at - 1; i >= 0; i--) if (supported.includes(MODEL_THINKING_LEVELS[i]!)) return MODEL_THINKING_LEVELS[i]!;
  return level;
}

/** 选的档这个模型不分时的一句说明；分的不说 */
export function thinkingNote(option: ModelOptionView | undefined, level: ModelThinkingLevel): string | undefined {
  if (!option?.thinkingLevels) return undefined;
  const actual = effectiveThinking(level, option.thinkingLevels);
  if (actual === level) return undefined;
  return `${option.modelId} 不分「${MODEL_THINKING_LABEL[level]}」，实际按「${MODEL_THINKING_LABEL[actual]}」`;
}

/** 一个选定怎么写：模型 · 思考档位 */
export function choiceText(choice: ModelChoice): string {
  return `${choice.modelId} · 思考${MODEL_THINKING_LABEL[choice.thinkingLevel]}`;
}

/** agent 这一行实际会用的（下一个新会话起；范围审视不进会话，是下一次审视起）；跟随默认的注明 */
export function agentSummary(view: ModelSettingsView, agent: ModelAgent): string {
  const override = view.settings.agents[agent];
  const choice = view.effective[agent] ?? effectiveModelChoice(view.settings, agent);
  const follows = override?.modelId === undefined && override?.thinkingLevel === undefined;
  return `${agent === "scope_review" ? "下一次审视用" : "下一个新会话用"} ${choiceText(choice)}${follows ? "（跟随默认）" : ""}`;
}

/** 秘书的主线会话现在用的 */
export function sessionModelText(session: SessionModelView): string {
  const level = (MODEL_THINKING_LEVELS as readonly string[]).includes(session.thinkingLevel) ? MODEL_THINKING_LABEL[session.thinkingLevel as ModelThinkingLevel] : session.thinkingLevel;
  return `主线会话现在用 ${session.modelId} · 思考${level} · ${session.vision ? "能看图" : "看不了图"}`;
}

/** 毫秒怎么说：不到 1 秒写毫秒，1 秒以上写到小数点后一位 */
export function latencyText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

/** 连通测试的结果怎么说 */
export function modelTestText(result: ModelTestResult): { ok: boolean; text: string } {
  if (result.ok) {
    const first = result.firstTokenMs === undefined ? "" : `首 token ${latencyText(result.firstTokenMs)}，`;
    return { ok: true, text: `通了：${result.modelId} ${first}整次 ${latencyText(result.totalMs)}` };
  }
  return { ok: false, text: `不通：${result.modelId}：${result.error ?? "没有说原因"}` };
}
