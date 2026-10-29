// 每个 agent 的会话里一个 ⚙（114 号票，规格第 19 节"Web UI"、系统提示一节）：秘书会话、任务整页（负责它的维护者）、项目整页（项目维护者）。
// 面板上三件事：
// - 这个 agent 单独的提示词（用户 2026-10-13 定：默认追加，也能整份自己写）：存在数据目录配置区的 agent-prompts/（prompts/library.ts），
//   改完从这个 agent 的下一轮起生效（各模块收到 onAgentChange 后照改名的做法：手头这一条处理完按新的重新拉起，接着同一个会话）；
//   面板上看得到现在实际用的系统提示全文（前缀、模板 + 追加或整份；项目维护者后面还有这一段的固定上下文）；
// - 清空当前对话：秘书、任务的维护者新开一段会话（conversation/agent-session.ts 的 clear：旧消息不删，界面上收在分隔线上面；
//   计划、阶段、进展照常作为上下文给到新的一段，秘书照常有看板变化），项目维护者就是重置维护者（16 号票）；
// - 上下文用量和"现在压缩"：数都从子进程每次模型调用报的 usage 来（token 账本），不另数一套——这段会话里最近一次干活的调用的上下文
//   （缓存命中 + 未命中 + 输出，和 pi 自己算的一样），压缩之后还没调用过的不写；窗口和 pi 的压缩设置是子进程就绪时报的
//   （agent 没在跑时用这个模型上一次报的）。"现在压缩"经宿主协议的 compact（秘书照旧用它专用的压缩指令，维护者照旧在压缩时做范围审视、
//   压缩后重注入固定上下文），压缩那次的用量照常记账（用途"压缩"）。
// - 模型（120 号票，只有项目、任务的维护者有）：跟随它那一行（设置 · 模型里的项目维护者 / 任务维护者），或者单独选定模型和思考档位；
//   存在模型设置里（model-settings/ 的 maintainers），拉起时按 agent id 现取，照 83 号票下一个新会话生效、长会话换时写交接摘要。
//   面板上写它那一行现在用的、单独配的、下一个新会话用的、最近一次在跑的会话实际用的，配的模型用不了时的原因。
// - 角色（248 号票；241 号票的"名字 + 音色各管各的"被它替掉）：这个 agent 用哪个角色（没指定就跟默认角色），
//   名字影响界面上的称呼、它自己的系统提示、语音播报的开头，音色影响它说出来的所有话。角色表在配置区的 agent-roles.json
//   （agent-roles/），设置 · 角色与声音那一页和会话里的 ⚙ 都是它；旧的 GET /api/agent-profiles 只保留只读兼容（从角色算出来）。
//   面板上的"跟默认"= 用默认角色（名字是全局的名字、音色是全局选中的参考音色）；"恢复跟默认"就是删掉自己指定的角色。
// - 运行时（289 号票，只有项目、任务的维护者有）：用哪个运行时（pi / 现在能用的运行时插件登记的）、给它选的模型和设置项（按它的能力清单：
//   Claude Code 多"权限模式""思考档位"，模型列表是它自己的）；换运行时 = 手头这一条做完、原来的写交接摘要、新的新开会话（和换模型一样），
//   换完才记进任务、项目；只改选的值从下一轮起（手头这一条处理完按新的重新拉起）。选的值按运行时登记表核对（不认得的、不在列表里的拒绝）。
// 谁是哪个 agent、怎么清、怎么压、这一段从哪算起，由秘书、任务的维护者、项目维护者各自的模块给（AgentHandle），这里只拼面板、查只读。
import type {
  AgentIdentityView,
  AgentProfilesView,
  AgentRoleAssignmentBody,
  AgentRoleAssignmentView,
  AgentRoleBody,
  AgentRoleOption,
  AgentRoleUpdateBody,
  AgentRolesView,
} from "@ergo/protocol";
import type { AgentRoles, RoleDocument } from "../agent-roles/index.ts";
import type { RollbackSession } from "../conversation/rollback.ts";
import {
  type AgentModelBody,
  type AgentModelView,
  type AgentRuntimeBody,
  type AgentRuntimeStateView,
  type RuntimeChoice,
  type RuntimeTakeover,
  type TakeoverAction,
  type AgentPromptBody,
  type AgentClearKind,
  type AgentSettingsKind,
  type AgentSettingsView,
  type MaintainerModelAgent,
  type ModelSwitchAt,
  t,
  takeoverPlaceOf,
  tokenTotal,
} from "@ergo/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import type { AgentSessionPanel } from "../conversation/agent-session.ts";
import { RequestRejected } from "../errors.ts";
import type { TokenLedger } from "../ledger/index.ts";
import type { ModelSettingsService } from "../model-settings/index.ts";
import type { PromptId, PromptLibrary } from "../prompts/index.ts";
import type { RuntimeRegistry } from "../runtime/index.ts";
import type { TakeoverService } from "../takeover/index.ts";

/** 一个有 ⚙ 的 agent：各模块给出它是谁、通用模板是哪份、怎么清空、怎么压缩 */
export interface AgentHandle {
  agentId: string;
  kind: AgentSettingsKind;
  /** 给人看的：秘书（名字占位）、长程任务 t-3「…」的维护者、项目「…」的维护者 */
  label: string;
  /** 它的通用模板（设置 · 系统提示里这个角色的那份）：单独的提示词按它查、从它复制 */
  template: PromptId;
  /** 只能看不能改的原因（任务结束了、项目归档了）；能改是 undefined */
  readOnly: string | undefined;
  /** 现在实际用的系统提示（不含前缀；项目维护者带着这一段的固定上下文） */
  systemPrompt(): string;
  /** 清空当前对话怎么做 */
  clearKind: AgentClearKind;
  /** 清空当前对话（手头这一条处理完再清；同一个幂等键只清一次） */
  clear(idempotencyKey: string): void;
  /** 现在压缩（手头这一条处理完再压，没在跑的先拉起） */
  compact(): void;
  /** 现在压不了的原因（项目维护者没有在进行的一段会话）；压得了是 undefined */
  cannotCompact(): string | undefined;
  /** 这一段会话从哪算起（清空的分隔线、重置维护者新开的一段的全局序号）和上一次清空（重置）的时间；没有是 0 */
  since(): { seq: number; clearedAt?: string };
  /** 会话此刻的样子（会话还没建起来是 undefined：没在跑、没在等） */
  panel(): AgentSessionPanel | undefined;
  /**
   * 用户点了输入框旁的"停止"（144 号票）：停下这个 agent 正在回复的这一轮（AgentSession.stopReply）。停没停：没在回复、会话还没建起来时
   * 什么都不做，是 false
   */
  stopReply(): boolean;
  /**
   * 会话回退（150 号票）：在这个 agent 的会话树上挪、判定副作用的工具注册表（conversation/rollback.ts 的 RollbackSession）。
   * 秘书有；任务、项目维护者在 152 号票接上。没有的不能回退
   */
  rollback?: RollbackSession;
  /** 能单独配模型的（120 号票：项目、任务的维护者）：盖过哪一行、改了什么时候换；秘书没有（它在设置 · 模型里单独一行） */
  model?: { agent: MaintainerModelAgent; switchAt: ModelSwitchAt };
  /** 能选运行时的（289 号票：项目、任务的维护者）；秘书没有（它一直是 pi） */
  runtime?: AgentRuntimeHandle;
}

/** 维护者的运行时（289 号票）：现在用的和选的值、换运行时、只改选的值 */
export interface AgentRuntimeHandle {
  /** 现在用的运行时（没写的是 pi）、给它选的值 */
  current(): { id: string; options: RuntimeChoice | undefined };
  /** 换运行时：手头这一条做完、原来的写交接摘要、新的新开会话，换完才记进任务、项目（会话的 switchRuntime） */
  switchTo(to: string, options: RuntimeChoice | undefined): void;
  /** 运行时不变、只改选的值：记进任务、项目，手头这一条处理完按新的重新拉起 */
  setOptions(options: RuntimeChoice | undefined): void;
  /** 接管自运行时已有的会话（290 号票，任务、项目上记着的）和维护者的工作目录；不是接管来的（或已换了别的运行时）是 undefined */
  takeover?(): { takeover: RuntimeTakeover; cwd: string } | undefined;
  /** 维护者的工作目录（305 号票：⚙ 里给能选工作文件夹的运行时写出来） */
  workdir?(): string;
}

export interface AgentSettingsOptions {
  prompts: Pick<PromptLibrary, "agentPrompt" | "saveAgentPrompt" | "resetAgentPrompt" | "detail" | "withPrefix">;
  ledger: Pick<TokenLedger, "lastOf">;
  agents: Pick<AgentManager, "contextOf">;
  /** 维护者单独配的模型（120 号票）；不给时面板上没有模型一块 */
  models?: Pick<ModelSettingsService, "maintainerModel" | "setMaintainerModel" | "followRole">;
  /** 角色（248 号票）：名字和音色从 agent 用的角色来；没指定角色就跟默认角色 */
  roles: Pick<AgentRoles, "document" | "defaultRoleId" | "defaultRole" | "roleOf" | "voiceIdOf" | "voices" | "create" | "update" | "remove" | "setDefault" | "assign">;
  /** 全局的名字（43 号票）：默认角色的名字，也是旧的 GET /api/agent-profiles 里秘书跟默认时的名字 */
  assistantName: () => string;
  /** 能配角色和音色的 agent 的 id（秘书、每个在的项目维护者、每个在的任务维护者……）；不认得的（已经删了）跳过 */
  candidates: () => readonly string[];
  /** 语音插件没启用时给人看的一句（音色改不了、名字和角色照常）；在运行时 undefined */
  voiceUnavailable?: () => string | undefined;
  /** 认这个 agent：秘书、任务自己的维护者、项目维护者；不认得是 undefined */
  resolve(agentId: string): AgentHandle | undefined;
  /** 运行时的登记表（289 号票）：⚙ 里运行时一块的名字、选的值按它核对；不给时面板上没有运行时一块 */
  runtimes?: Pick<RuntimeRegistry, "view">;
  /** 接管来的会话交还、收回（290 号票，takeover/）；不给时 ⚙ 里不能交还 */
  takeover?: Pick<TakeoverService, "act">;
}

export interface AgentSettings {
  view(agentId: string): AgentSettingsView;
  savePrompt(agentId: string, body: AgentPromptBody): AgentSettingsView;
  resetPrompt(agentId: string): AgentSettingsView;
  clear(agentId: string, idempotencyKey: string): AgentSettingsView;
  compact(agentId: string): AgentSettingsView;
  /** 单独配模型（120 号票）：模型目录里没有的、不能单独配的 agent、只读的都拒绝 */
  setModel(agentId: string, body: AgentModelBody): Promise<AgentSettingsView>;
  /** 改回跟随它那一行 */
  followRoleModel(agentId: string): AgentSettingsView;
  /**
   * 用哪个运行时、给它选的值（289 号票，PUT /api/agents/<id>/runtime）：换运行时的等手头这一条做完、原来的写好交接摘要才换；
   * 不认得的运行时、没启用的、不在列表里的模型、不认得的设置项和值、只读的、不能选运行时的都拒绝
   */
  setRuntime(agentId: string, body: AgentRuntimeBody): AgentSettingsView;
  /**
   * 接管来的会话交还给运行时 / 收回到二狗（290 号票，POST /api/agents/<id>/takeover）：在做一轮的不交还、交还等子进程退干净；
   * 收回先核对没在别处开着。不是接管来的、只读的拒绝。292 号票：交给官方 App（不是接管来的也能交），在官方 App 里的收回先停掉那边
   */
  takeoverAction(agentId: string, action: TakeoverAction): Promise<AgentSettingsView>;
  /** 每个能配的 agent 现在的名字和音色（241 号票，旧的 GET /api/agent-profiles 的只读兼容）：从角色算出来的结果 */
  profiles(): AgentProfilesView;
  /** 设置 · 角色与声音那一页（248 号票）：默认角色、角色表（连同谁在用）、每个 agent 用哪个角色（GET /api/agent-roles） */
  rolesView(): AgentRolesView;
  /** 新建一个角色：名字不合规、音色不存在、插件没启用时写音色都拒绝 */
  createRole(body: AgentRoleBody): AgentRolesView;
  /** 改名 / 换音色（默认角色会同时改全局名字 / 全局选中的音色） */
  updateRole(roleId: string, body: AgentRoleUpdateBody): AgentRolesView;
  /** 删一个角色：默认角色、还有 agent 指定的都拒绝（写明是谁在用） */
  deleteRole(roleId: string): AgentRolesView;
  /** 把某个角色设成默认 */
  setDefaultRole(roleId: string): AgentRolesView;
  /** 给一个 agent 选角色（null = 跟默认）；只读的（任务结束了、项目归档了）拒绝 */
  assignRole(agentId: string, body: AgentRoleAssignmentBody): AgentRolesView;
}

/** 接管自哪个会话（290 号票）：会话、工作目录、交还了没有；292 号票：现在在哪边、是不是二狗自己开的、官方 App 里的链接 */
function takeoverView(runtime: AgentRuntimeHandle): Pick<AgentRuntimeStateView, "takeover"> {
  const now = runtime.takeover?.();
  if (!now) return {};
  const { takeover, cwd } = now;
  const place = takeoverPlaceOf(takeover);
  return {
    takeover: {
      sessionId: takeover.remote?.sessionId ?? takeover.sessionId,
      title: takeover.title,
      cwd,
      ...(takeover.forkedFrom ? { forkedFrom: takeover.forkedFrom } : {}),
      returned: takeover.returnedAt !== undefined,
      place,
      ...(takeover.own === true ? { own: true as const } : {}),
      ...(place === "remote" && takeover.remote?.url !== undefined ? { url: takeover.remote.url } : {}),
    },
  };
}

export function createAgentSettings(options: AgentSettingsOptions): AgentSettings {
  const { prompts, ledger } = options;

  const handleOf = (agentId: string): AgentHandle => {
    const handle = options.resolve(agentId);
    if (!handle) throw new RequestRejected("not_found", t("agentSettings.noAgent", { agentId }));
    return handle;
  };

  /** 能改才往下走：只读的写明原因 */
  const writable = (agentId: string): AgentHandle => {
    const handle = handleOf(agentId);
    if (handle.readOnly !== undefined) throw new RequestRejected("not_allowed", handle.readOnly);
    return handle;
  };

  /** 能单独配模型才往下走 */
  const modelOf = (handle: AgentHandle): { models: NonNullable<AgentSettingsOptions["models"]>; agent: MaintainerModelAgent } => {
    if (!handle.model || !options.models) throw new RequestRejected("not_allowed", t("agentSettings.noOwnModel", { label: handle.label }));
    return { models: options.models, agent: handle.model.agent };
  };

  /** 模型一块（120 号票） */
  const modelView = (handle: AgentHandle, panel: AgentSessionPanel | undefined): AgentModelView | undefined => {
    if (!handle.model || !options.models) return undefined;
    const m = options.models.maintainerModel(handle.agentId, handle.model.agent);
    return {
      agent: handle.model.agent,
      role: m.role,
      ...(m.own ? { own: m.own } : {}),
      ...(m.unavailable === undefined ? {} : { unavailable: m.unavailable }),
      next: m.next,
      ...(panel?.model ? { session: { ...panel.model } } : {}),
      switchAt: handle.model.switchAt,
    };
  };

  /** 运行时一块（289 号票）：现在用的、选的值、正在换成哪个、不能用的原因 */
  const runtimeView = (handle: AgentHandle, panel: AgentSessionPanel | undefined): AgentRuntimeStateView | undefined => {
    if (!handle.runtime || !options.runtimes) return undefined;
    const all = options.runtimes.view().runtimes;
    const { id, options: chosen } = handle.runtime.current();
    const known = all.find((r) => r.id === id);
    const switching = panel?.runtimeSwitch;
    return {
      id,
      title: known?.title ?? id,
      ...(chosen?.model === undefined ? {} : { model: chosen.model }),
      settings: { ...chosen?.settings },
      ...(switching ? { switching: { to: switching.to, title: all.find((r) => r.id === switching.to)?.title ?? switching.to, state: switching.state } } : {}),
      ...(known?.unavailable === undefined ? (known ? {} : { unavailable: t("agentSettings.runtime.unknown", { id }) }) : { unavailable: known.unavailable }),
      ...takeoverView(handle.runtime),
      // 292 号票：能交给官方 App（不是接管来的会话也能交）
      ...(known?.capabilities.remote_control === true ? { remoteControl: true as const } : {}),
      // 305 号票：能选工作文件夹的运行时写出维护者的工作文件夹（守卫的项目目录就是它）
      ...(known?.workFolder && handle.runtime.workdir ? { workdir: handle.runtime.workdir() } : {}),
    };
  };

  /** 按运行时登记表核对选的值（289 号票）：不认得的运行时、没启用的（换过去的）、不在列表里的模型、不认得的设置项和值都抛 RequestRejected；等于默认的设置项不记 */
  const checkedRuntime = (body: AgentRuntimeBody, current: string): RuntimeChoice | undefined => {
    const target = options.runtimes!.view().runtimes.find((r) => r.id === body.runtime);
    if (!target) throw new RequestRejected("bad_params", t("agentSettings.runtime.unknown", { id: body.runtime }));
    if (!target.available && body.runtime !== current) throw new RequestRejected("bad_params", target.unavailable ?? t("agentSettings.runtime.unknown", { id: body.runtime }));
    if (body.model !== undefined && !target.models?.some((m) => m.id === body.model)) {
      throw new RequestRejected("bad_params", t("agentSettings.runtime.badModel", { model: body.model, runtime: target.title }));
    }
    const settings: Record<string, string> = {};
    for (const [id, value] of Object.entries(body.settings ?? {})) {
      const setting = target.settings.find((s) => s.id === id);
      if (!setting) throw new RequestRejected("bad_params", t("agentSettings.runtime.badSetting", { setting: id, runtime: target.title }));
      if (!setting.options.some((o) => o.value === value)) throw new RequestRejected("bad_params", t("agentSettings.runtime.badValue", { value, setting: setting.title }));
      if (value !== setting.default) settings[id] = value;
    }
    const hasSettings = Object.keys(settings).length > 0;
    return body.model === undefined && !hasSettings ? undefined : { ...(body.model === undefined ? {} : { model: body.model }), ...(hasSettings ? { settings } : {}) };
  };

  /** 音色下拉能选的（参考音色；语音插件没在运行时没有） */
  const voiceOptions = () => options.roles.voices()?.list();

  /** 全局默认用的那个参考音色（"跟默认"后面写它的名字）；一个都没有时 undefined */
  const defaultVoice = () => {
    const list = voiceOptions();
    return list?.voices.find((v) => v.id === list.currentId);
  };

  /**
   * 这个 agent 现在的角色、名字和音色（248 号票）：身份就是它用的角色——
   * 名字是那个角色的名字（默认角色 = 全局的名字），音色是那个角色指定的（默认角色 = 全局选中的那个参考音色）；
   * 角色指定的音色被删了就回退当前默认音色（名字照常）
   */
  const identityOf = (handle: AgentHandle): AgentIdentityView => {
    const role = options.roles.roleOf(handle.agentId);
    const ownRoleId = role.isDefault ? undefined : role.id;
    const list = voiceOptions();
    const pinned = role.voiceId === undefined ? undefined : list?.voices.find((v) => v.id === role.voiceId);
    const fallback = defaultVoice();
    const voice = pinned ?? fallback;
    return {
      roleId: role.id,
      name: role.name,
      defaultName: options.roles.defaultRole().name,
      nameSource: ownRoleId === undefined ? "default" : "own",
      ...(ownRoleId === undefined ? {} : { ownRoleId }),
      ...(voice ? { voiceId: voice.id, voiceName: voice.name } : {}),
      voiceSource: pinned !== undefined ? "own" : fallback !== undefined ? "default" : "none",
    };
  };

  /** agent 的先后：秘书、项目维护者、任务维护者、记忆管理员（242 号票；同一个种类里按 id 的先后，稳） */
  const KIND_ORDER: Readonly<Record<AgentSettingsKind, number>> = { secretary: 0, project: 1, task: 2, curator: 3 };

  /** 能配的 agent 一个个按顺序来（删了的、认不得的跳过；同一个 id 只算一次） */
  const entries = (): AgentRoleAssignmentView[] => {
    const agents: AgentRoleAssignmentView[] = [];
    const seen = new Set<string>();
    for (const agentId of options.candidates()) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const handle = options.resolve(agentId);
      if (!handle) continue;
      agents.push({
        agentId,
        kind: handle.kind,
        label: handle.label,
        ...(handle.readOnly === undefined ? {} : { readOnly: handle.readOnly }),
        identity: identityOf(handle),
      });
    }
    return agents.toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  };

  /** 每个能配的 agent 现在的名字和音色（241 号票，旧的 GET /api/agent-profiles 的只读兼容）：从角色算出来的结果 */
  const profiles = (): AgentProfilesView => {
    const list = voiceOptions();
    const fallback = defaultVoice();
    const voiceUnavailable = options.voiceUnavailable?.();
    return {
      agents: entries(),
      ...(list ? { voices: list.voices } : {}),
      ...(fallback ? { defaultVoiceId: fallback.id } : {}),
      ...(voiceUnavailable === undefined ? {} : { voiceUnavailable }),
    };
  };

  /** 角色表那一页（248 号票）：默认角色、角色表（连同谁在用）、每个 agent 用哪个角色、参考音色 */
  const rolesView = (): AgentRolesView => {
    const document = options.roles.document();
    const agents = entries();
    const usedBy = new Map<string, string[]>();
    for (const entry of agents) usedBy.set(entry.identity.roleId, [...(usedBy.get(entry.identity.roleId) ?? []), entry.agentId]);
    const list = voiceOptions();
    const fallback = defaultVoice();
    const roles = document.roles.map((role) => {
      const isDefault = role.id === document.defaultRoleId;
      // 默认角色的名字和音色都按全局现取（它显示的就是设置顶上那个名字和语音页里选的那个音色）
      const name = isDefault ? options.roles.defaultRole().name : role.name;
      const pinned = isDefault || role.voiceId === undefined ? undefined : list?.voices.find((v) => v.id === role.voiceId);
      const voice = pinned ?? fallback;
      return {
        id: role.id,
        name,
        isDefault,
        ...(voice ? { voiceId: voice.id, voiceName: voice.name } : {}),
        usedBy: usedBy.get(role.id) ?? [],
      };
    });
    const voiceUnavailable = options.voiceUnavailable?.();
    return {
      defaultRoleId: document.defaultRoleId,
      roles,
      agents,
      ...(list ? { voices: list.voices } : {}),
      ...(fallback ? { defaultVoiceId: fallback.id } : {}),
      ...(voiceUnavailable === undefined ? {} : { voiceUnavailable }),
    };
  };

  /** 角色下拉里的选项（⚙ 面板）：默认角色 + 每个角色；"跟默认"那一项由界面自己加 */
  const roleOptions = (): AgentRoleOption[] => {
    const document: RoleDocument = options.roles.document();
    const defaultRole = options.roles.defaultRole();
    return document.roles.map((role) => ({ id: role.id, name: role.id === document.defaultRoleId ? defaultRole.name : role.name, isDefault: role.id === document.defaultRoleId }));
  };

  const view = (handle: AgentHandle): AgentSettingsView => {
    const { agentId } = handle;
    const own = prompts.agentPrompt(agentId, handle.template);
    const template = prompts.detail(handle.template);
    const since = handle.since();
    const panel = handle.panel();
    // 这段会话里最近一次干活的调用、最近一次压缩：压缩在后的，压缩之后还没调用过模型，用量等下一次调用再说
    const work = ledger.lastOf(agentId, ["work"], since.seq);
    const compacted = ledger.lastOf(agentId, ["compaction"], since.seq);
    const used = work && (!compacted || compacted.seq < work.seq) ? work : undefined;
    // 窗口：会话最近一次就绪时报的；没在跑过就用这个模型上一次报的（agent 管家记着，按账本里最近一次调用的模型）
    const lastModel = (work ?? ledger.lastOf(agentId, ["work", "compaction"]))?.model;
    const context = panel?.context ?? (lastModel === undefined ? undefined : options.agents.contextOf(lastModel));
    const cannotCompact = handle.cannotCompact();
    const model = modelView(handle, panel);
    const runtime = runtimeView(handle, panel);
    const identity = identityOf(handle);
    const voices = voiceOptions();
    const fallback = defaultVoice();
    const voiceUnavailable = options.voiceUnavailable?.();
    return {
      agentId,
      kind: handle.kind,
      label: handle.label,
      ...(handle.readOnly === undefined ? {} : { readOnly: handle.readOnly }),
      identity,
      roles: roleOptions(),
      ...(voices ? { voices: voices.voices } : {}),
      ...(fallback ? { defaultVoiceId: fallback.id } : {}),
      ...(voiceUnavailable === undefined ? {} : { voiceUnavailable }),
      prompt: {
        state: own ? own.mode : "template",
        content: own?.content ?? "",
        ...(own?.problem === undefined ? {} : { problem: own.problem }),
        template: { id: template.id, title: template.title, content: template.content, placeholders: template.placeholders, allowEmpty: template.allowEmpty },
        effective: prompts.withPrefix(handle.systemPrompt()),
      },
      clear: { how: handle.clearKind, pending: panel?.clearPending ?? false, ...(since.clearedAt === undefined ? {} : { lastAt: since.clearedAt }) },
      context: {
        running: panel?.running ?? false,
        busy: panel?.busy ?? false,
        // 311 号票：其中缓存命中的单给一个数（Claude Code 的大半是缓存命中）
        ...(used ? { usedTokens: tokenTotal(used.tokens), ...(used.tokens.cacheHit > 0 ? { cacheHitTokens: used.tokens.cacheHit } : {}), measuredAt: used.time } : {}),
        ...(context ? { window: context.window, autoCompactAt: Math.max(0, context.window - context.reserveTokens), keepRecentTokens: context.keepRecentTokens } : {}),
        ...(compacted ? { lastCompactedAt: compacted.time } : {}),
        compaction: panel?.compaction ?? "idle",
        ...(panel?.lastCompact ? { lastCompact: panel.lastCompact } : {}),
        ...(cannotCompact === undefined ? {} : { cannotCompact }),
      },
      ...(model ? { model } : {}),
      ...(runtime ? { runtime } : {}),
    };
  };

  return {
    view: (agentId) => view(handleOf(agentId)),
    savePrompt(agentId, body) {
      const handle = writable(agentId);
      prompts.saveAgentPrompt(agentId, handle.template, body.mode, body.content);
      return view(handle);
    },
    resetPrompt(agentId) {
      const handle = writable(agentId);
      prompts.resetAgentPrompt(agentId);
      return view(handle);
    },
    clear(agentId, idempotencyKey) {
      const handle = writable(agentId);
      handle.clear(idempotencyKey);
      return view(handle);
    },
    compact(agentId) {
      const handle = writable(agentId);
      const cannot = handle.cannotCompact();
      if (cannot !== undefined) throw new RequestRejected("not_allowed", cannot);
      handle.compact();
      return view(handle);
    },
    async setModel(agentId, body) {
      const handle = writable(agentId);
      const { models } = modelOf(handle);
      await models.setMaintainerModel(agentId, body);
      return view(handle);
    },
    followRoleModel(agentId) {
      const handle = writable(agentId);
      modelOf(handle).models.followRole(agentId, "在它的 ⚙ 里改回跟随"); // @i18n-ignore log：只进日志
      return view(handle);
    },
    async takeoverAction(agentId, action) {
      const handle = writable(agentId);
      // 交给官方 App（292 号票）不是接管来的会话也能交（运行时能不能交、会话开始了没有由接管服务核对）
      if (!options.takeover || !handle.runtime || (action !== "remote" && !handle.runtime.takeover?.())) throw new RequestRejected("not_allowed", t("takeover.notTakenOver"));
      await options.takeover.act(agentId, action);
      return view(handle);
    },
    setRuntime(agentId, body) {
      const handle = writable(agentId);
      if (!handle.runtime || !options.runtimes) throw new RequestRejected("not_allowed", t("agentSettings.runtime.notAllowed", { label: handle.label }));
      const current = handle.runtime.current().id;
      const chosen = checkedRuntime(body, current);
      if (body.runtime === current) handle.runtime.setOptions(chosen);
      else handle.runtime.switchTo(body.runtime, chosen);
      return view(handle);
    },
    profiles,
    rolesView,
    createRole(body) {
      // 名字、音色的校验都在 agent-roles/ 里（和 43 号票同一个起名规矩），不合规的抛 RequestRejected
      options.roles.create(body);
      return rolesView();
    },
    updateRole(roleId, body) {
      options.roles.update(roleId, body);
      return rolesView();
    },
    deleteRole(roleId) {
      // 默认角色不能删、还有 agent 在用的不能删：这里先说清是谁在用（角色服务里还有一道兜底）
      const view = rolesView();
      const role = view.roles.find((item) => item.id === roleId);
      if (role === undefined) throw new RequestRejected("not_found", t("agentRoles.roleNotFound", { id: roleId }));
      if (role.isDefault) throw new RequestRejected("bad_params", t("agentRoles.defaultCannotDelete"));
      if (role.usedBy.length > 0) {
        const labels = role.usedBy.map((agentId) => entries().find((entry) => entry.agentId === agentId)?.label ?? agentId);
        throw new RequestRejected("bad_params", t("agentRoles.roleInUse", { agents: labels.join(t("common.listSeparator")) }));
      }
      options.roles.remove(roleId);
      return rolesView();
    },
    setDefaultRole(roleId) {
      options.roles.setDefault(roleId);
      return rolesView();
    },
    assignRole(agentId, body) {
      // 只读的（任务结束了、项目归档了）改不了；角色存不存在在角色服务里查
      writable(agentId);
      options.roles.assign(agentId, body.roleId);
      return rolesView();
    },
  };
}
