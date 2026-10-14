// 原型里每个 agent 的会话里的 ⚙（114 号票）：面板的数据是编的。通用模板取原型的系统提示（fake-system-prompts.ts，设置里改了这里跟着变），
// 单独的提示词、清空、压缩只记在内存里；"现在压缩"假装压一会儿（1.5 秒）就压好，用量等下一次调用。
// 占位符的检查和守护进程用同一个函数（状态层的 checkAgentPromptDraft），写错了照样拒收。
// 120 号票：项目、任务的维护者的"模型"一块。编的：记账本的维护者单独配了 deepseek-v4-pro（思考高），最近一段会话已经换成它；
// 那一行（项目维护者 / 任务维护者）取原型的模型设置（fake-http.ts，设置 · 模型里改了这里跟着变）。
import {
  type AgentCompactResult,
  type AgentModelBody,
  type AgentModelView,
  type AgentPromptBody,
  type AgentPromptMode,
  type AgentSettingsKind,
  type AgentSettingsView,
  ASSISTANT_NAME_MARK,
  checkAgentPromptDraft,
  DEFAULT_ASSISTANT_NAME,
  effectiveModelChoice,
  MAINTAINER_CHANNEL_PREFIX,
  type MaintainerModelView,
  maintainerChannel,
  type ModelChoice,
  type ModelSettings,
  normalizePromptSource,
  parsePromptTemplate,
  PI_COMPACTION_DEFAULTS,
  type PromptNode,
  renderPromptTemplate,
  type SystemPromptDetail,
  systemPromptSpec,
  TASK_KIND_LABEL,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import { at } from "./fake-conversations.ts";
import { FAKE_BOARD, FAKE_PROJECTS, FAKE_TASK_DETAILS } from "./fake-data.ts";
import type { FakeSystemPrompts } from "./fake-system-prompts.ts";

/** 原型里模型的上下文窗口（编的：12.8 万） */
const WINDOW = 128_000;

interface FakeAgent {
  own?: { mode: AgentPromptMode; content: string };
  clearedAt?: string;
  usedTokens?: number;
  measuredAt?: string;
  lastCompactedAt?: string;
  compacting: boolean;
  lastCompact?: AgentCompactResult;
}

/** 编的几个：秘书清空过一次（会话里那条分隔线）；记账本的维护者有一段追加的提示、自动压缩过一次（会话里那条记录） */
const SEEDS: Record<string, Omit<FakeAgent, "compacting">> = {
  secretary: { clearedAt: at("10-07", "08:30"), usedTokens: 82_000, measuredAt: at("10-07", "10:03") },
  "project-ledger": {
    own: { mode: "append", content: "金额一律保留两位小数；说到「{{项目名}}」的报表时先说本月合计，再和上个月比。" },
    usedTokens: 46_500,
    measuredAt: at("10-06", "21:36"),
    lastCompactedAt: at("10-06", "21:34"),
  },
};

/** 编的：单独配了模型的维护者（记账本的维护者配了 v4-pro、思考高） */
const SEEDED_MODELS: ReadonlyArray<[string, ModelChoice]> = [["project-ledger", { modelId: "deepseek-v4-pro", thinkingLevel: "high" }]];

/** 原型的模型目录里有的（和 fake-http.ts 的模型设置一样） */
const FAKE_MODEL_IDS = ["deepseek-flash", "deepseek-v4-pro"];

/** 项目维护者这一段的固定上下文（原型里编的一小段，真的由守护进程从项目档案拼） */
const projectContext = (name: string, goal: string) => `【项目档案】（原型里的示例）\n立项书：${name}——${goal}\n进展：最近一次运行 10-06 21:00，甲银行接口 403，等用户重新授权。`;

export class FakeAgentSettings {
  private readonly agents = new Map<string, FakeAgent>();
  private readonly prompts: FakeSystemPrompts;
  /** 原型的模型设置（fake-http.ts 的，设置 · 模型里改了跟着变） */
  private readonly modelSettings: () => ModelSettings;
  /** 单独配了模型的维护者（120 号票），只在内存里 */
  private readonly ownModels = new Map<string, ModelChoice>(SEEDED_MODELS);

  constructor(prompts: FakeSystemPrompts, modelSettings: () => ModelSettings) {
    this.prompts = prompts;
    this.modelSettings = modelSettings;
  }

  /** 设置 · 模型页上列出的单独配了模型的维护者 */
  maintainerModels(): MaintainerModelView[] {
    return [...this.ownModels].flatMap(([agentId, choice]) => {
      const who = this.who(agentId);
      if (who.kind === "secretary") return [];
      const project = FAKE_PROJECTS.find((p) => p.maintainerId === agentId);
      const owner = project ? { kind: "project" as const, id: project.id, title: project.name } : { kind: "task" as const, id: who.taskId ?? agentId, title: who.title ?? agentId };
      return [{ agentId, agent: who.kind === "project" ? ("project_maintainer" as const) : ("task_maintainer" as const), owner, choice: { ...choice } }];
    });
  }

  setModel(agentId: string, body: AgentModelBody): AgentSettingsView {
    const view = this.view(agentId);
    if (view.readOnly) throw new Error(view.readOnly);
    if (!view.model) throw new Error("个人助理的模型在设置 · 模型里改");
    if (!FAKE_MODEL_IDS.includes(body.modelId)) throw new Error(`单独配的模型：DeepSeek 的模型目录里没有 ${body.modelId}`);
    this.ownModels.set(agentId, { modelId: body.modelId, thinkingLevel: body.thinkingLevel });
    return this.view(agentId);
  }

  followModel(agentId: string): AgentSettingsView {
    const view = this.view(agentId);
    if (view.readOnly) throw new Error(view.readOnly);
    this.ownModels.delete(agentId);
    return this.view(agentId);
  }

  /** "模型"一块：跟随那一行或者单独配的；记账本的维护者最近一段会话已经换成单独配的 */
  private modelView(agentId: string, kind: AgentSettingsKind): AgentModelView | undefined {
    if (kind === "secretary") return undefined;
    const agent = kind === "project" ? "project_maintainer" : "task_maintainer";
    const role = effectiveModelChoice(this.modelSettings(), agent);
    const own = this.ownModels.get(agentId);
    const next = own ?? role;
    const session = agentId === "project-ledger" ? { modelId: "deepseek-v4-pro", thinkingLevel: "high", vision: false } : undefined;
    return { agent, role, ...(own ? { own: { ...own } } : {}), next: { ...next }, ...(session ? { session } : {}), switchAt: kind === "project" ? "next_segment" : "new_session" };
  }

  view(agentId: string): AgentSettingsView {
    const who = this.who(agentId);
    const state = this.state(agentId);
    const template = this.prompts.detail(who.template);
    const own = state.own;
    const base = renderFake(template, template.content, who.values, this.prompts);
    const effective = !own ? base : own.mode === "replace" ? renderFake(template, own.content, who.values, this.prompts) : `${base}\n\n${renderFake(template, own.content, who.values, this.prompts)}`;
    const autoCompactAt = WINDOW - PI_COMPACTION_DEFAULTS.reserveTokens;
    const model = this.modelView(agentId, who.kind);
    return {
      agentId,
      kind: who.kind,
      label: who.label,
      ...(who.readOnly ? { readOnly: who.readOnly } : {}),
      prompt: {
        state: own?.mode ?? "template",
        content: own?.content ?? "",
        template: { id: template.id, title: template.title, content: template.content, placeholders: template.placeholders, allowEmpty: template.allowEmpty },
        effective: who.context ? `${effective}\n\n${who.context}` : effective,
      },
      clear: { how: who.kind === "project" ? "reset_maintainer" : "new_session", pending: false, ...(state.clearedAt ? { lastAt: state.clearedAt } : {}) },
      context: {
        running: agentId === "secretary",
        busy: false,
        ...(state.usedTokens !== undefined ? { usedTokens: state.usedTokens } : {}),
        ...(state.measuredAt ? { measuredAt: state.measuredAt } : {}),
        window: WINDOW,
        autoCompactAt,
        keepRecentTokens: PI_COMPACTION_DEFAULTS.keepRecentTokens,
        ...(state.lastCompactedAt ? { lastCompactedAt: state.lastCompactedAt } : {}),
        compaction: state.compacting ? "running" : "idle",
        ...(state.lastCompact ? { lastCompact: state.lastCompact } : {}),
      },
      ...(model ? { model } : {}),
    };
  }

  savePrompt(agentId: string, body: AgentPromptBody): AgentSettingsView {
    const view = this.view(agentId);
    if (view.readOnly) throw new Error(view.readOnly);
    const check = checkAgentPromptDraft(view, body.mode, body.content);
    if (!check.ok) throw new Error(`没存：\n${check.problem}`);
    const content = normalizePromptSource(body.content);
    const state = this.state(agentId);
    if (body.mode === "append" && content.trim() === "") delete state.own;
    else state.own = { mode: body.mode, content };
    return this.view(agentId);
  }

  resetPrompt(agentId: string): AgentSettingsView {
    delete this.state(agentId).own;
    return this.view(agentId);
  }

  /** 清空：原型里只记个时间，用量清掉（会话里不加分隔线） */
  clear(agentId: string): AgentSettingsView {
    const view = this.view(agentId);
    if (view.readOnly) throw new Error(view.readOnly);
    const state = this.state(agentId);
    state.clearedAt = nowIso();
    delete state.usedTokens;
    delete state.measuredAt;
    delete state.lastCompactedAt;
    return this.view(agentId);
  }

  compact(agentId: string): AgentSettingsView {
    const view = this.view(agentId);
    if (view.readOnly) throw new Error(view.readOnly);
    const state = this.state(agentId);
    state.compacting = true;
    setTimeout(() => {
      state.compacting = false;
      const now = nowIso();
      if ((state.usedTokens ?? 0) <= PI_COMPACTION_DEFAULTS.keepRecentTokens) {
        state.lastCompact = { outcome: "nothing", at: now };
        return;
      }
      state.lastCompact = { outcome: "done", at: now };
      state.lastCompactedAt = now;
      delete state.usedTokens;
      delete state.measuredAt;
    }, 1500);
    return this.view(agentId);
  }

  private state(agentId: string): FakeAgent {
    let state = this.agents.get(agentId);
    if (!state) {
      state = { compacting: false, ...structuredClone(SEEDS[agentId] ?? {}) };
      this.agents.set(agentId, state);
    }
    return state;
  }

  /** 这个 agent 是谁：秘书、某个项目的维护者、某个任务的维护者（原型里的任务都用"长程任务的维护者"那份模板） */
  private who(agentId: string): { kind: AgentSettingsKind; label: string; template: string; values: Record<string, string>; readOnly?: string; context?: string; taskId?: string; title?: string } {
    if (agentId === "secretary") return { kind: "secretary", label: ASSISTANT_NAME_MARK, template: "secretary", values: {} };
    const project = FAKE_PROJECTS.find((p) => p.maintainerId === agentId);
    if (project) {
      return {
        kind: "project",
        label: `项目「${project.name}」的维护者`,
        template: "project-maintainer",
        values: { 项目名: project.name },
        ...(project.state === "archived" ? { readOnly: "项目已归档，这里只能看：取消归档后才能改提示词、重置或压缩" } : {}),
        context: projectContext(project.name, project.goal),
      };
    }
    const channel = maintainerChannel(agentId);
    const taskId = Object.entries(FAKE_TASK_DETAILS).find(([, d]) => d.maintainer === channel)?.[0];
    const task = FAKE_BOARD.find((e) => e.kind === "task" && e.id === taskId);
    const title = task?.kind === "task" ? task.title : channel.slice(MAINTAINER_CHANNEL_PREFIX.length);
    const ended = task?.kind === "task" && (task.status === "done" || task.status === "cancelled" || task.status === "failed");
    return {
      kind: "task",
      ...(taskId ? { taskId } : {}),
      title,
      label: `${TASK_KIND_LABEL[task?.kind === "task" ? (task.taskKind ?? "long_running") : "long_running"]} ${taskId ?? agentId}「${title}」的维护者`,
      template: "task-maintainer",
      values: {},
      ...(ended ? { readOnly: "任务已经结束，这里只能看：不能改提示词、清空或压缩" } : {}),
    };
  }
}

/** 原型里填值：名字用默认的名字，项目名照项目，条件都不成立，工具名、标记写它自己的名字；写错的原样显示 */
function renderFake(template: SystemPromptDetail, source: string, values: Record<string, string>, prompts: FakeSystemPrompts): string {
  const spec = systemPromptSpec(template);
  const parsed = parsePromptTemplate(normalizePromptSource(source), spec);
  if (!parsed.ok) return source;
  const filled: Record<string, string | boolean> = { 名字: DEFAULT_ASSISTANT_NAME, ...values };
  for (const p of template.placeholders) if (!(p.name in filled) && p.kind !== "partial") filled[p.name] = p.kind === "flag" ? false : p.name;
  const partial = (id: string): readonly PromptNode[] => {
    const detail = prompts.detail(id);
    const nodes = parsePromptTemplate(detail.content, systemPromptSpec(detail));
    return nodes.ok ? nodes.nodes : [];
  };
  try {
    return renderPromptTemplate(parsed.nodes, filled, partial, template.id);
  } catch {
    return source;
  }
}
