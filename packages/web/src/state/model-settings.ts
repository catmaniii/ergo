// 设置里的"模型"（73 号票）：设置页上的说法和"改一处、存整份"的纯函数。界面（pages/more/ModelsPage.tsx）只管画。
// - 设置存在守护进程（各设备一样），设置页每改一处就把整份存回去（POST /api/model-settings），守护进程查过合规才存；
// - 一个会话固定一个模型：改了以后下一个新会话生效，正在进行的会话照它开始时的（页面上写清楚）；长会话（秘书、项目维护者的对话段、
//   定时触发的任务）下一轮新开会话、附交接摘要，任务执行中途不换（83 号票）；
// - API key 只说配没配、从哪来，页面上没有 key 的内容；319 号票起能在页面上填一个换掉（那块在 ui/model-key.tsx，
//   请求体和"存好之后怎么说"在 state/model-key.ts）；
// - 看图能力：这里改的为准，其次配置文件写明的，都没写按模型目录。
// - 单独配了模型的维护者（120 号票）：项目、任务的维护者在自己的 ⚙ 里选定，盖过它那一行；这一页在那一行下面列出来（点了去它的 ⚙），
//   ⚙ 上的"模型"一块也在这里写成话（模型清单、看图能力的说法和这一页同一套）。
import {
  type AgentModelView,
  ASSISTANT_NAME_MARK,
  MODEL_AGENT_LABEL,
  MODEL_AGENTS,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  type ModelApiKeyStatus,
  type ModelChoice,
  type ModelCustomProvider,
  type ModelOptionView,
  type ModelAgent,
  type MaintainerModelView,
  type ModelSettings,
  type ModelSettingsBody,
  type ModelSettingsView,
  type ModelTestResult,
  type ModelThinkingLevel,
  type ModelVisionChoice,
  type ModelSwitchAt,
  type SessionModelView,
  effectiveModelChoice,
  t,
  tTable,
} from "./protocol.ts";

// 170 号票：页面上的几句说明原来是模块顶层的常量，改成函数（按当前语言现取）

/** 页面顶上的一句：什么时候生效（说到秘书写名字占位，页面上换成用户起的名字） */
export function modelSettingsEffectNote(): string {
  return t("state.modelSettings.effectNote", { name: ASSISTANT_NAME_MARK });
}

/** 服务商那一项的说明 */
export function modelProviderNote(): string {
  return t("state.modelSettings.providerNote");
}

/** "各个 agent"那一节的说明（秘书写名字占位，界面按用户起的名字显示） */
export function modelAgentsNote(): string {
  return t("state.modelSettings.agentsNote", { agents: MODEL_AGENTS.map((agent) => MODEL_AGENT_LABEL[agent]).join(t("state.modelSettings.listSep")) });
}

/** 设置文件读不出来时页面上的提示（原因另写） */
export function modelSettingsFileBrokenNote(): string {
  return t("state.modelSettings.fileBroken");
}

/** 存回去的整份：从设置复制一份（不改原来的）。存着的自定义（OpenAI 兼容）服务商那一块也带上，切回 DeepSeek 时不清空 */
export function settingsBody(settings: ModelSettings): ModelSettingsBody {
  return {
    provider: settings.provider,
    default: { ...settings.default },
    agents: Object.fromEntries(Object.entries(settings.agents).map(([agent, o]) => [agent, { ...o }])),
    vision: { ...settings.vision },
    ...(settings.custom === undefined ? {} : { custom: { ...settings.custom } }),
  };
}

/**
 * 换服务商（设置页上那两个单选、首次向导那一步）：custom 给了就连自定义那一块一起存（地址、模型 id、接口风格），
 * 没给时留着设置里原来那份（守护进程那边也是"没带就不动"）
 */
export function withProvider(settings: ModelSettings, provider: string, custom?: ModelCustomProvider): ModelSettingsBody {
  const body = settingsBody(settings);
  body.provider = provider;
  if (custom !== undefined) body.custom = { ...custom };
  return body;
}

/** 改默认模型或默认的思考档位 */
export function withDefault(settings: ModelSettings, patch: Partial<ModelChoice>): ModelSettingsBody {
  const body = settingsBody(settings);
  body.default = { ...body.default, ...patch };
  return body;
}

/** 改一个 agent：给 null 是这一项改回"跟随默认"；两项都跟随默认就去掉这个 agent */
export function withAgent(settings: ModelSettings, agent: ModelAgent, patch: { modelId?: string | null; thinkingLevel?: ModelThinkingLevel | null }): ModelSettingsBody {
  const body = settingsBody(settings);
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
  const body = settingsBody(settings);
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
  const lsm = status.lsm ? "" : t("state.modelSettings.apiKey.notViaLsm");
  const params = { envVar: status.envVar, secretFile: status.secretFile, lsm };
  if (status.configured) return { label: t("state.modelSettings.apiKey.configured"), ok: true, detail: t("state.modelSettings.apiKey.configuredDetail", params) };
  return { label: t("state.modelSettings.apiKey.missing"), ok: false, detail: t("state.modelSettings.apiKey.missingDetail", params) };
}

/** 一个模型在下拉里怎么写：名字和 id；模型目录里没有的注明 */
export function modelOptionLabel(option: ModelOptionView): string {
  const name = option.name && option.name !== option.modelId ? t("state.modelSettings.option.named", { name: option.name, id: option.modelId }) : option.modelId;
  return option.inCatalog ? name : t("state.modelSettings.option.notInCatalog", { name });
}

const VISION_SOURCE_LABEL = tTable({ settings: "state.modelSettings.visionSource.settings", config: "state.modelSettings.visionSource.config", catalog: "state.modelSettings.visionSource.catalog" });

/** "能看图" / "看不了图" */
const visionWord = (vision: boolean) => (vision ? t("state.modelSettings.vision.yes") : t("state.modelSettings.vision.no"));

/** 一个模型能不能看图、按什么定的 */
export function visionText(option: ModelOptionView): string {
  if (option.vision === undefined) return t("state.modelSettings.vision.unknown");
  return t("state.modelSettings.vision.withSource", { vision: visionWord(option.vision), source: VISION_SOURCE_LABEL[option.visionSource ?? "catalog"] });
}

/** 看图能力的下拉里"跟随"那一项：不在这里改时按什么（配置文件写明的，或模型目录的） */
const visionShort = (vision: boolean) => (vision ? t("state.modelSettings.vision.yes") : t("state.modelSettings.vision.noShort"));

export function visionFollowLabel(option: ModelOptionView): string {
  if (option.configVision !== undefined) return t("state.modelSettings.vision.followConfig", { vision: visionShort(option.configVision) });
  if (option.catalogVision !== undefined) return t("state.modelSettings.vision.followCatalogWith", { vision: visionShort(option.catalogVision) });
  return t("state.modelSettings.vision.followCatalog");
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
  return t("state.modelSettings.thinkingNote", { model: option.modelId, level: MODEL_THINKING_LABEL[level], actual: MODEL_THINKING_LABEL[actual] });
}

/** 一个选定怎么写：模型 · 思考档位 */
export function choiceText(choice: ModelChoice): string {
  return t("state.modelSettings.choice", { model: choice.modelId, level: MODEL_THINKING_LABEL[choice.thinkingLevel] });
}

/** agent 这一行实际会用的（下一个新会话起；范围审视不进会话，是下一次审视起）；跟随默认的注明 */
export function agentSummary(view: ModelSettingsView, agent: ModelAgent): string {
  const override = view.settings.agents[agent];
  const choice = view.effective[agent] ?? effectiveModelChoice(view.settings, agent);
  const follows = override?.modelId === undefined && override?.thinkingLevel === undefined;
  const params = { choice: choiceText(choice) };
  if (agent === "scope_review") return follows ? t("state.modelSettings.nextReviewDefault", params) : t("state.modelSettings.nextReview", params);
  return follows ? t("state.modelSettings.nextSessionDefault", params) : t("state.modelSettings.nextSession", params);
}

/** 秘书的主线会话现在用的 */
export function sessionModelText(session: SessionModelView): string {
  const level = (MODEL_THINKING_LEVELS as readonly string[]).includes(session.thinkingLevel) ? MODEL_THINKING_LABEL[session.thinkingLevel as ModelThinkingLevel] : session.thinkingLevel;
  return t("state.modelSettings.mainSession", { model: session.modelId, level, vision: visionWord(session.vision) });
}

/** 毫秒怎么说：不到 1 秒写毫秒，1 秒以上写到小数点后一位 */
export function latencyText(ms: number): string {
  return ms < 1000 ? t("state.modelSettings.ms", { n: Math.round(ms) }) : t("state.modelSettings.seconds", { n: (ms / 1000).toFixed(1) });
}

/** 连通测试的结果怎么说 */
export function modelTestText(result: ModelTestResult): { ok: boolean; text: string } {
  if (result.ok) {
    const total = latencyText(result.totalMs);
    if (result.firstTokenMs === undefined) return { ok: true, text: t("state.modelSettings.test.ok", { model: result.modelId, total }) };
    return { ok: true, text: t("state.modelSettings.test.okFirst", { model: result.modelId, first: latencyText(result.firstTokenMs), total }) };
  }
  return { ok: false, text: t("state.modelSettings.test.failed", { model: result.modelId, error: result.error ?? t("state.modelSettings.test.noReason") }) };
}

// ───────────────────────── 单独配了模型的维护者（120 号票） ─────────────────────────

/** 设置 · 模型页上，项目维护者、任务维护者那一行下面的一句：单独配了模型的有哪些（每个一项，点了去它的 ⚙） */
export interface MaintainerOverrideLine {
  /** "单独配了模型的项目：" / "单独配了模型的任务：" */
  lead: string;
  items: Array<{ agentId: string; owner: MaintainerModelView["owner"]; name: string; text: string; unavailable?: string }>;
}

/** 这一行下面的那一句；没有单独配了的不写 */
export function maintainerOverrideLine(view: Pick<ModelSettingsView, "maintainers">, agent: ModelAgent): MaintainerOverrideLine | undefined {
  const list = (view.maintainers ?? []).filter((m) => m.agent === agent);
  if (list.length === 0) return undefined;
  return {
    lead: agent === "project_maintainer" ? t("state.modelSettings.override.projects") : t("state.modelSettings.override.tasks"),
    items: list.map((m) => ({
      agentId: m.agentId,
      owner: m.owner,
      name: m.owner.kind === "project" ? m.owner.title : t("state.modelSettings.override.taskName", { id: m.owner.id, title: m.owner.title }),
      text: m.unavailable === undefined ? choiceText(m.choice) : t("state.modelSettings.override.unavailable", { choice: choiceText(m.choice) }),
      ...(m.unavailable === undefined ? {} : { unavailable: m.unavailable }),
    })),
  };
}

/** 改了以后什么时候换（⚙ 上"模型"那一块的说明，照 83 号票） */
export const MODEL_SWITCH_NOTE: Readonly<Record<ModelSwitchAt, string>> = tTable({
  next_segment: "state.modelSettings.switch.nextSegment",
  next_run: "state.modelSettings.switch.nextRun",
  new_session: "state.modelSettings.switch.newSession",
});

/** 下拉第一项：跟随它那一行（写上那一行现在用的） */
export function maintainerFollowLabel(model: Pick<AgentModelView, "agent" | "role">): string {
  return t("state.modelSettings.followRow", { agent: MODEL_AGENT_LABEL[model.agent], choice: choiceText(model.role) });
}

/** ⚙ 上"模型"那一块写成的话 */
export interface AgentModelLines {
  /** 下一个新会话用的、按什么定的 */
  readonly next: string;
  /** 最近一次在跑的会话实际用的（不知道时没有） */
  readonly session: string | undefined;
  /** 单独配的用不了了：原因（这时跟随那一行） */
  readonly unavailable: string | undefined;
  /** 什么时候换 */
  readonly switchNote: string;
}

export function agentModelLines(model: AgentModelView): AgentModelLines {
  const label = MODEL_AGENT_LABEL[model.agent];
  const follows = model.own === undefined || model.unavailable !== undefined;
  const session = model.session;
  const level = session && ((MODEL_THINKING_LEVELS as readonly string[]).includes(session.thinkingLevel) ? MODEL_THINKING_LABEL[session.thinkingLevel as ModelThinkingLevel] : session.thinkingLevel);
  return {
    next: follows ? t("state.modelSettings.lines.nextFollow", { choice: choiceText(model.next), agent: label }) : t("state.modelSettings.lines.nextOwn", { choice: choiceText(model.next) }),
    session: session && t("state.modelSettings.lines.session", { model: session.modelId, level, vision: visionWord(session.vision) }),
    unavailable: model.unavailable === undefined ? undefined : t("state.modelSettings.lines.unavailable", { reason: model.unavailable, agent: label }),
    switchNote: MODEL_SWITCH_NOTE[model.switchAt],
  };
}
