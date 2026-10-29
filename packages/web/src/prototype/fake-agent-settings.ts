// 原型里每个 agent 的会话里的 ⚙（114 号票）：面板的数据是编的。通用模板取原型的系统提示（fake-system-prompts.ts，设置里改了这里跟着变），
// 单独的提示词、清空、压缩只记在内存里；"现在压缩"假装压一会儿（1.5 秒）就压好，用量等下一次调用。
// 占位符的检查和守护进程用同一个函数（状态层的 checkAgentPromptDraft），写错了照样拒收。
// 120 号票：项目、任务的维护者的"模型"一块。编的：记账本的维护者单独配了 deepseek-v4-pro（思考高），最近一段会话已经换成它；
// 那一行（项目维护者 / 任务维护者）取原型的模型设置（fake-http.ts，设置 · 模型里改了这里跟着变）。
// 289 号票：项目、任务的维护者的"运行时"一块。编的：个人博客的维护者用 Claude Code（选了 Opus、自动接受改文件、思考高）；
// 换运行时假装写一会儿交接摘要（1.5 秒）再换，只改选的值的马上记下。
import {
  type AgentCompactResult,
  type AgentIdentityView,
  type AgentModelBody,
  type AgentModelView,
  type AgentPromptBody,
  type AgentPromptMode,
  type AgentRoleAssignmentBody,
  type AgentRoleBody,
  type AgentRoleOption,
  type AgentRolesView,
  type AgentRoleUpdateBody,
  type AgentRuntimeBody,
  type AgentRuntimeStateView,
  type AgentSettingsKind,
  type AgentSettingsView,
  ASSISTANT_NAME_MARK,
  checkAgentPromptDraft,
  checkAssistantName,
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
  PI_RUNTIME_ID,
  type PromptNode,
  type ReferenceVoiceList,
  renderPromptTemplate,
  type RuntimeChoice,
  type SystemPromptDetail,
  systemPromptSpec,
  type TakeoverAction,
  TASK_KIND_LABEL,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";
import { at, FAKE_REMOTE_TASK, FAKE_TAKEOVER_TASK } from "./fake-conversations.ts";
import { FAKE_BOARD, FAKE_PROJECTS, FAKE_TASK_DETAILS } from "./fake-data.ts";
import { FAKE_CLAUDE_CODE, fakeRuntimes } from "./fake-runtimes.ts";
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

/** 编的：用别的运行时的维护者（个人博客的维护者用 Claude Code），没写的是 pi */
const SEEDED_RUNTIMES: ReadonlyArray<[string, { id: string; options?: RuntimeChoice }]> = [
  ["project-blog", { id: FAKE_CLAUDE_CODE, options: { model: "opus", settings: { permission_mode: "acceptEdits", effort: "high" } } }],
  // 290 号票：从 Claude Code 会话接管来的普通任务
  [FAKE_TAKEOVER_TASK.maintainerId, { id: FAKE_CLAUDE_CODE }],
  // 292 号票：交给了官方 App 的普通任务
  [FAKE_REMOTE_TASK.maintainerId, { id: FAKE_CLAUDE_CODE }],
];

/** 原型的模型目录里有的（和 fake-http.ts 的模型设置一样） */
const FAKE_MODEL_IDS = ["deepseek-flash", "deepseek-v4-pro"];

/** 项目维护者这一段的固定上下文（原型里编的一小段，真的由守护进程从项目档案拼） */
const projectContext = (name: string, goal: string) => `【项目档案】（原型里的示例）\n立项书：${name}——${goal}\n进展：最近一次运行 10-06 21:00，甲银行接口 403，等用户重新授权。`;

/** 原型里维护者的工作文件夹（305 号票）：项目在外面的工作目录、接管来的任务的；别的不写 */
function fakeWorkdirOf(agentId: string): string | undefined {
  const project = FAKE_PROJECTS.find((p) => p.maintainerId === agentId);
  if (project) return project.workdir.external ? project.workdir.path : undefined;
  return agentId === FAKE_TAKEOVER_TASK.maintainerId ? FAKE_TAKEOVER_TASK.workdir : undefined;
}

export class FakeAgentSettings {
  private readonly agents = new Map<string, FakeAgent>();
  private readonly prompts: FakeSystemPrompts;
  /** 原型的模型设置（fake-http.ts 的，设置 · 模型里改了跟着变） */
  private readonly modelSettings: () => ModelSettings;
  /** 原型设置的参考音色（fake-http.ts 的，设置 · 语音里导入了跟着变） */
  private readonly voices: () => ReferenceVoiceList;
  /** 单独配了模型的维护者（120 号票），只在内存里 */
  private readonly ownModels = new Map<string, ModelChoice>(SEEDED_MODELS);
  /** 维护者用的运行时和选的值（289 号票），只在内存里；没有的是 pi */
  private readonly runtimes = new Map<string, { id: string; options?: RuntimeChoice }>(SEEDED_RUNTIMES);
  /** 正在换运行时的（289 号票）：换成哪个 */
  private readonly switching = new Map<string, string>();
  /** 接管来的（290 号票）：接管自哪个会话、工作目录、交还了没有；292 号票：在哪边、二狗自己开的、官方 App 里的链接。只在内存里 */
  private readonly takeovers = new Map<string, NonNullable<AgentRuntimeStateView["takeover"]>>([
    [FAKE_TAKEOVER_TASK.maintainerId, { sessionId: FAKE_TAKEOVER_TASK.takeover!.sessionId, title: FAKE_TAKEOVER_TASK.takeover!.title, cwd: FAKE_TAKEOVER_TASK.workdir!, returned: false, place: "ergo" }],
    [
      FAKE_REMOTE_TASK.maintainerId,
      { sessionId: FAKE_REMOTE_TASK.takeover!.sessionId, title: FAKE_REMOTE_TASK.takeover!.title, cwd: "D:\\code\\photo-tools", returned: true, place: "remote", own: true, url: FAKE_REMOTE_TASK.takeover!.remote!.url! },
    ],
  ]);
  /** 角色（248 号票），只在内存里：名字 + 音色绑成一个，每个 agent 选一个；默认角色的名字是全局名字（原型里就是默认的"二狗"） */
  private roles: { id: string; name: string; voiceId?: string }[] = [
    { id: "role-default", name: DEFAULT_ASSISTANT_NAME },
    { id: "role-xiaoming", name: "小明" },
  ];
  private defaultRoleId = "role-default";
  private readonly assignments = new Map<string, string>();
  private nextRoleSeq = 1;

  constructor(prompts: FakeSystemPrompts, modelSettings: () => ModelSettings, voices: () => ReferenceVoiceList) {
    this.prompts = prompts;
    this.modelSettings = modelSettings;
    this.voices = voices;
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

  /** 用哪个运行时、选的值（289 号票）：换运行时的假装写 1.5 秒交接摘要再换；只改选的值的马上记下（值照运行时清单核对） */
  setRuntime(agentId: string, body: AgentRuntimeBody): AgentSettingsView {
    const view = this.view(agentId);
    if (view.readOnly) throw new Error(view.readOnly);
    if (!view.runtime) throw new Error("个人助理一直用 pi");
    const target = fakeRuntimes().find((r) => r.id === body.runtime);
    if (!target?.available) throw new Error(`没有运行时「${body.runtime}」`);
    if (body.model !== undefined && !target.models?.some((m) => m.id === body.model)) throw new Error(`${target.title}没有模型「${body.model}」`);
    const options: RuntimeChoice = { ...(body.model === undefined ? {} : { model: body.model }), ...(body.settings && Object.keys(body.settings).length > 0 ? { settings: { ...body.settings } } : {}) };
    if (body.runtime === view.runtime.id) {
      this.runtimes.set(agentId, { id: body.runtime, options });
      return this.view(agentId);
    }
    this.switching.set(agentId, body.runtime);
    setTimeout(() => {
      if (this.switching.get(agentId) !== body.runtime) return;
      this.switching.delete(agentId);
      this.runtimes.set(agentId, { id: body.runtime, options });
    }, 1500);
    return this.view(agentId);
  }

  /** 交还 / 收回（290 号票）、交给官方 App（292 号票）：不是接管来的 Claude Code 维护者交给官方 App 时才记下（二狗自己开的会话） */
  takeover(agentId: string, action: TakeoverAction): AgentSettingsView {
    const found = this.takeovers.get(agentId);
    if (action === "remote") {
      const runtime = this.runtimes.get(agentId);
      if (!found && runtime?.id !== FAKE_CLAUDE_CODE) throw new Error("它用的运行时不能交给官方 App");
      const base = found ?? { sessionId: "9a1c7e2b-0d3f-4b6a-8c5e-2f7d1b3a9e40", title: FAKE_PROJECTS.find((p) => p.maintainerId === agentId)?.name ?? this.who(agentId).title ?? agentId, cwd: fakeWorkdirOf(agentId) ?? "D:\\code", returned: false, place: "ergo" as const, own: true as const };
      this.takeovers.set(agentId, { ...base, returned: true, place: "remote", url: "https://claude.ai/code/session_01DemoHandedJustNow" });
      return this.view(agentId);
    }
    if (!found) throw new Error("它不是从已有的会话接管来的");
    const { url: _url, ...rest } = found;
    this.takeovers.set(agentId, action === "return" ? { ...rest, returned: true, place: "returned" } : { ...rest, returned: false, place: "ergo" });
    return this.view(agentId);
  }

  /** "运行时"一块（289 号票）：秘书没有 */
  private runtimeView(agentId: string, kind: AgentSettingsKind): AgentRuntimeStateView | undefined {
    if (kind === "secretary") return undefined;
    const list = fakeRuntimes();
    const title = (id: string) => list.find((r) => r.id === id)?.title ?? id;
    const current = this.runtimes.get(agentId) ?? { id: PI_RUNTIME_ID };
    const to = this.switching.get(agentId);
    return {
      id: current.id,
      title: title(current.id),
      ...(current.options?.model === undefined ? {} : { model: current.options.model }),
      settings: { ...current.options?.settings },
      ...(to === undefined ? {} : { switching: { to, title: title(to), state: "handoff" as const } }),
      ...(this.takeovers.has(agentId) ? { takeover: { ...this.takeovers.get(agentId)! } } : {}),
      // 292 号票：Claude Code 能交给官方 App
      ...(current.id === FAKE_CLAUDE_CODE ? { remoteControl: true as const } : {}),
      // 305 号票：能选工作文件夹的运行时写出工作文件夹（原型里：项目在外面的工作目录、接管来的任务的）
      ...(current.id === FAKE_CLAUDE_CODE && fakeWorkdirOf(agentId) !== undefined ? { workdir: fakeWorkdirOf(agentId)! } : {}),
    };
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

  /** 默认角色：名字是全局名字（原型里就是默认的"二狗"），音色是现在选中的参考音色 */
  private defaultRole(): { id: string; name: string; voiceId?: string } {
    return this.roles.find((role) => role.id === this.defaultRoleId) ?? { id: this.defaultRoleId, name: DEFAULT_ASSISTANT_NAME };
  }

  /** 这个 agent 现在用哪个角色、名字和音色（248 号票），和守护进程同一套算法：指定的角色优先，没指定跟默认角色 */
  private identityOf(agentId: string): AgentIdentityView {
    const assigned = this.assignments.get(agentId);
    const own = assigned === undefined ? undefined : this.roles.find((role) => role.id === assigned);
    const role = own ?? this.defaultRole();
    const isDefault = role.id === this.defaultRoleId;
    const list = this.voices();
    const pinned = isDefault || role.voiceId === undefined ? undefined : list.voices.find((v) => v.id === role.voiceId);
    const fallback = list.voices.find((v) => v.id === list.currentId);
    const voice = pinned ?? fallback;
    return {
      roleId: role.id,
      name: isDefault ? DEFAULT_ASSISTANT_NAME : role.name,
      defaultName: DEFAULT_ASSISTANT_NAME,
      nameSource: own === undefined || isDefault ? "default" : "own",
      ...(own === undefined || isDefault ? {} : { ownRoleId: role.id }),
      ...(voice ? { voiceId: voice.id, voiceName: voice.name } : {}),
      voiceSource: pinned !== undefined ? "own" : fallback !== undefined ? "default" : "none",
    };
  }

  /** 能配的 agent：秘书、原型里的每个项目的维护者、每个任务的维护者 */
  private configurableAgentIds(): string[] {
    return [
      ...new Set([
        "secretary",
        ...FAKE_PROJECTS.map((project) => project.maintainerId),
        ...Object.values(FAKE_TASK_DETAILS).flatMap((detail) => (detail.maintainer === undefined ? [] : [detail.maintainer.slice(MAINTAINER_CHANNEL_PREFIX.length)])),
      ]),
    ];
  }

  /** 无副作用（每次现取） */
  roleOptions(): AgentRoleOption[] {
    return this.roles.map((role) => ({ id: role.id, name: role.id === this.defaultRoleId ? DEFAULT_ASSISTANT_NAME : role.name, isDefault: role.id === this.defaultRoleId }));
  }

  /** 设置 · 角色与声音那一页（248 号票）：编的，和守护进程的 GET /api/agent-roles 一个样子 */
  rolesView(): AgentRolesView {
    const agents = this.configurableAgentIds().map((agentId) => {
      const who = this.who(agentId);
      return { agentId, kind: who.kind, label: who.label, ...(who.readOnly ? { readOnly: who.readOnly } : {}), identity: this.identityOf(agentId) };
    });
    const list = this.voices();
    const fallback = list.voices.find((v) => v.id === list.currentId);
    const usedBy = new Map<string, string[]>();
    for (const entry of agents) usedBy.set(entry.identity.roleId, [...(usedBy.get(entry.identity.roleId) ?? []), entry.agentId]);
    const roles = this.roles.map((role) => {
      const isDefault = role.id === this.defaultRoleId;
      const pinned = isDefault || role.voiceId === undefined ? undefined : list.voices.find((v) => v.id === role.voiceId);
      const voice = pinned ?? fallback;
      return {
        id: role.id,
        name: isDefault ? DEFAULT_ASSISTANT_NAME : role.name,
        isDefault,
        ...(voice ? { voiceId: voice.id, voiceName: voice.name } : {}),
        usedBy: usedBy.get(role.id) ?? [],
      };
    });
    return { defaultRoleId: this.defaultRoleId, roles, agents, voices: list.voices, ...(fallback ? { defaultVoiceId: fallback.id } : {}) };
  }

  /** 新建一个角色（248 号票）：名字照起名的规矩查，音色要现在有的 */
  createRole(body: AgentRoleBody): AgentRolesView {
    const checked = checkAssistantName(body.name);
    if (!checked.ok) throw new Error(checked.error);
    const voiceId = body.voiceId === undefined || body.voiceId === null ? undefined : body.voiceId;
    if (voiceId !== undefined && !this.voices().voices.some((v) => v.id === voiceId)) throw new Error(`没有这个参考音色：${voiceId}`);
    this.roles.push({ id: `role-fake-${this.nextRoleSeq++}`, name: checked.name, ...(voiceId === undefined ? {} : { voiceId }) });
    return this.rolesView();
  }

  /** 改名 / 换音色（默认角色会同时改全局名字 / 全局选中的音色） */
  updateRole(roleId: string, body: AgentRoleUpdateBody): AgentRolesView {
    const role = this.roles.find((item) => item.id === roleId);
    if (role === undefined) throw new Error(`没有这个角色：${roleId}`);
    if (body.name !== undefined) {
      const checked = checkAssistantName(body.name);
      if (!checked.ok) throw new Error(checked.error);
      role.name = checked.name;
    }
    if (body.voiceId !== undefined) {
      if (body.voiceId === null) delete role.voiceId;
      else if (!this.voices().voices.some((v) => v.id === body.voiceId)) throw new Error(`没有这个参考音色：${body.voiceId}`);
      else role.voiceId = body.voiceId;
    }
    return this.rolesView();
  }

  /** 删一个角色：默认角色、还有 agent 在用的不能删 */
  removeRole(roleId: string): AgentRolesView {
    const view = this.rolesView();
    const role = view.roles.find((item) => item.id === roleId);
    if (role === undefined) throw new Error(`没有这个角色：${roleId}`);
    if (role.isDefault) throw new Error("默认角色不能删：先把别的角色设成默认角色");
    if (role.usedBy.length > 0) throw new Error(`这个角色还有 agent 在用：${role.usedBy.join("、")}`);
    this.roles = this.roles.filter((item) => item.id !== roleId);
    return this.rolesView();
  }

  /** 设默认角色 */
  setDefaultRole(roleId: string): AgentRolesView {
    if (!this.roles.some((role) => role.id === roleId)) throw new Error(`没有这个角色：${roleId}`);
    this.defaultRoleId = roleId;
    return this.rolesView();
  }

  /** 给一个 agent 选角色：null = 跟默认 */
  assignRole(agentId: string, body: AgentRoleAssignmentBody): AgentRolesView {
    const who = this.who(agentId);
    if (who.readOnly) throw new Error(who.readOnly);
    if (body.roleId === null || body.roleId === this.defaultRoleId) this.assignments.delete(agentId);
    else if (!this.roles.some((role) => role.id === body.roleId)) throw new Error(`没有这个角色：${body.roleId}`);
    else this.assignments.set(agentId, body.roleId);
    return this.rolesView();
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
    const runtime = this.runtimeView(agentId, who.kind);
    const list = this.voices();
    const fallback = list.voices.find((v) => v.id === list.currentId);
    return {
      agentId,
      kind: who.kind,
      label: who.label,
      ...(who.readOnly ? { readOnly: who.readOnly } : {}),
      identity: this.identityOf(agentId),
      roles: this.roleOptions(),
      voices: list.voices,
      ...(fallback ? { defaultVoiceId: fallback.id } : {}),
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
      ...(runtime ? { runtime } : {}),
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
    // 290 号票：接管来的普通任务（做完了也能接着说，不是只读）；292 号票：交给了官方 App 的普通任务
    for (const task of [FAKE_TAKEOVER_TASK, FAKE_REMOTE_TASK]) {
      if (agentId !== task.maintainerId) continue;
      const { id, title } = task;
      return { kind: "task", taskId: id, title, label: `${TASK_KIND_LABEL.plain} ${id}「${title}」的维护者`, template: "task-maintainer", values: {} };
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
