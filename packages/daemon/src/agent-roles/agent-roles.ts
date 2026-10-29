// 角色（248 号票）：配置区 agent-roles.json 的存、校验、回退，替掉 241 号票"每个 agent 各管各的名字和音色"。
// 形状见协议包的 agent-roles.ts / agent-roles-schema.ts：
//   { format: 1, defaultRoleId, roles: [{ id, name, voiceId? }], assignments: { "<agent id>": "<角色 id>" } }
// - 慢点读：每次现读（文件很小），改了下一轮 / 下一次合成就生效，不用重启；读坏了不让守护进程起不来，也不覆盖它（改的时候回 400 说明）；
// - 默认角色（defaultRoleId 指的那一行）：名字就是全局名字（43 号票），音色就是全局选中的参考音色（31 号票）——
//   读的时候按全局现取，写的时候写全局（改名 = assistantName.change，换音色 = 参考音色的 select），文件里那份是给人看的镜像，
//   所以设置顶上的名字输入框、角色页、秘书的系统提示、历史消息里的名字占位永远是同一个名字；
// - 别的角色：name 照 43 号票的规矩查，voiceId 可空（= 跟当前默认音色）；写不存在的音色 400；
//   语音插件没启用时写音色 400 带原因（名字和角色分配照常，名字不归语音插件管）；
// - 角色指定的音色后来被删了：自己回退到当前默认音色（合成那边按 voiceIdOf 的 undefined 走老路）；
// - 没指定角色的 agent = 跟默认角色；把默认角色自己写进 assignments 等于跟默认（存的时候不留这一项）；
// - 删角色：默认角色不能删；还有 agent 指定的角色由调用方（agent-settings）先查再删，这里兜底再查一次；
// - 第一次读到文件不存在时做一次迁移（从旧的 agent-profiles.json + 全局名字 + 全局选中音色），旧文件保留；
//   迁移写不进去时先在内存里用迁移结果，下次启动再写（不丢名字和音色）；
// - 改了时通知 onChange（带这次该重新装配的 agent id），组合根据此让它们从下一轮起按新的名字重新装配。
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AGENT_ROLE_FORMAT,
  AGENT_ROLE_ID,
  AGENT_ROLE_ID_PREFIX,
  type AgentRoleBody,
  type AgentRoleStored,
  type AgentRoleUpdateBody,
  checkAssistantName,
  DEFAULT_AGENT_ROLE_ID,
  type ReferenceVoice,
  t,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { writeJsonAtomic } from "../util/json-file.ts";
import { readLegacyAgentProfiles } from "./legacy-profiles.ts";

/** 参考音色清单里这个模块要的那几样（语音插件的 ReferenceVoices 结构上满足它；不 import 语音插件的内部） */
export interface RoleVoice {
  id: string;
  name: string;
}

/** 参考音色的清单（语音插件在运行时才有；插件停用、没装上时 undefined） */
export interface RoleVoices {
  list(): { voices: ReferenceVoice[]; currentId?: string };
  /** 某一个参考音色；没有是 undefined（删了、写错了） */
  get(voiceId: string): RoleVoice | undefined;
}

/** 一份配置文件读出来的样子（只有能用的那部分） */
export interface RoleDocument {
  defaultRoleId: string;
  roles: AgentRoleStored[];
  /** agent id → 角色 id（只留认得的角色；跟默认的不在这里） */
  assignments: Record<string, string>;
}

/** 一个 agent 现在生效的角色（名字、音色都按它取） */
export interface ResolvedRole {
  id: string;
  /** 默认角色是全局名字（43）；别的角色是自己那个名字 */
  name: string;
  /** 角色指定的参考音色；默认角色、跟默认音色时是 undefined（用当前默认音色） */
  voiceId: string | undefined;
  isDefault: boolean;
}

export interface AgentRoles {
  /** 整份（迁移过、校验过）：默认角色、角色表、看得到的分配 */
  document(): RoleDocument;
  defaultRoleId(): string;
  /** 默认角色（名字是全局名字，音色是全局选中的那个） */
  defaultRole(): ResolvedRole;
  /** agent 现在生效的角色（没指定、指定的角色不在了都是默认角色） */
  roleOf(agentId: string): ResolvedRole;
  /** agent 自己指定的角色 id；跟默认是 undefined */
  ownRoleIdOf(agentId: string): string | undefined;
  /** 角色指定的参考音色（默认角色、跟默认音色是 undefined）；语音插件按它现取，删了回退当前默认 */
  voiceIdOf(agentId: string): string | undefined;
  /** 指定了角色时的名字（跟默认是 undefined）：它的系统提示末尾那句"用户叫你「…」"按它判断 */
  assignedNameOf(agentId: string): string | undefined;
  /** 参考音色的清单（音色下拉的选项、校验音色存不存在）；语音插件没启用时 undefined */
  voices(): RoleVoices | undefined;
  /** 新建一个角色；名字不合规、音色不存在、插件没启用时写音色都抛 RequestRejected */
  create(body: AgentRoleBody): RoleDocument;
  /** 改名 / 换音色（默认角色会同时改全局名字 / 全局选中的音色） */
  update(roleId: string, body: AgentRoleUpdateBody): RoleDocument;
  /** 删一个角色：默认角色、还有 agent 指定的都抛 RequestRejected */
  remove(roleId: string): RoleDocument;
  /** 把某个角色设成默认：全局名字和音色跟着变成那个角色的 */
  setDefault(roleId: string): RoleDocument;
  /** 给一个 agent 选角色：null（或默认角色）= 跟默认 */
  assign(agentId: string, roleId: string | null): RoleDocument;
  /** 全局名字 / 音色改了（43、31）：默认角色在文件里的那份镜像跟着记 */
  refreshGlobals(): void;
  /** 改了时叫 fn（这次该重新装配的 agent id）；返回取消登记的函数 */
  onChange(fn: (agentIds: readonly string[]) => void): () => void;
  /** 启动时做一次迁移（插件起来之后、全局名字和音色都能读到的时候调） */
  start(): void;
}

export interface AgentRolesOptions {
  /** config/agent-roles.json（数据目录配置区） */
  file: string;
  /** config/agent-profiles.json（241 号票的旧文件）：只在迁移时读，迁完保留不删（回滚用） */
  legacyFile: string;
  /** 全局名字（43 号票）：默认角色的名字 */
  assistantName: () => string;
  /** 改全局名字（43）：默认角色改名走的也是它；名字已经校验过 */
  setAssistantName: (name: string) => void;
  /** 参考音色（语音插件在运行时才有；现取） */
  voices?: () => RoleVoices | undefined;
  /** 选中全局的参考音色（31）：默认角色换音色走的也是它 */
  selectVoice?: (voiceId: string) => void;
  log: (line: string) => void;
}

/** 只认对象，别的当成没有 */
function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** 按 agent id 排一下：手看的时候好找，两次写同样的内容也一样 */
const sortedAssignments = (assignments: Record<string, string>) => Object.fromEntries(Object.entries(assignments).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** 名字合不合规（和 43 号票同一个检查）：不合规抛 RequestRejected，存不进去 */
function checkedName(raw: string): string {
  const checked = checkAssistantName(raw);
  if (!checked.ok) throw new RequestRejected("bad_params", checked.error);
  return checked.name;
}

export function openAgentRoles(options: AgentRolesOptions): AgentRoles {
  const { file, legacyFile, log } = options;
  const listeners = new Set<(agentIds: readonly string[]) => void>();
  /** 文件读坏了（不是 JSON、形状不对）：读的时候按"只有默认角色"算，改的时候拒绝（不覆盖用户的文件） */
  let broken = false;
  /** 迁移算出来、还没写进文件的（写失败时先用它，下次启动再写） */
  let pending: RoleDocument | undefined;
  /** 正在改全局名字 / 全局音色（它们会同步叫回 refreshGlobals）：这中间先别回头改文件，免得改到旧的默认角色上 */
  let busy = false;

  const changed = (agentIds: readonly string[]) => {
    for (const fn of listeners) {
      try {
        fn(agentIds);
      } catch (err) {
        log(`角色改了的通知出错：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：只进日志
      }
    }
  };
  const voicesNow = () => options.voices?.();
  const defaultName = () => options.assistantName();
  /** 全局选中的那个参考音色（默认角色的音色） */
  const defaultVoice = () => {
    const list = voicesNow()?.list();
    return list?.voices.find((voice) => voice.id === list.currentId);
  };

  /** 只有默认角色的一份：文件还没有、读坏了、迁移前都按它算（默认角色的名字是全局名字、音色是全局选中的那个） */
  const synthetic = (): RoleDocument => {
    const voice = defaultVoice();
    return { defaultRoleId: DEFAULT_AGENT_ROLE_ID, roles: [{ id: DEFAULT_AGENT_ROLE_ID, name: defaultName(), ...(voice === undefined ? {} : { voiceId: voice.id }) }], assignments: {} };
  };

  const findRole = (doc: RoleDocument, roleId: string) => doc.roles.find((role) => role.id === roleId);

  /** 默认角色（文件里没有那一行时合成一个，别让整个功能起不来） */
  const defaultRoleOf = (doc: RoleDocument): AgentRoleStored => findRole(doc, doc.defaultRoleId) ?? { id: doc.defaultRoleId === "" ? DEFAULT_AGENT_ROLE_ID : doc.defaultRoleId, name: defaultName() };

  /** 一个角色现在生效的身份：默认角色的名字、音色都按全局现取 */
  const resolve = (doc: RoleDocument, role: AgentRoleStored): ResolvedRole => {
    const isDefault = role.id === doc.defaultRoleId;
    if (isDefault) return { id: role.id, name: defaultName(), voiceId: undefined, isDefault };
    return { id: role.id, name: role.name, voiceId: role.voiceId, isDefault };
  };

  const roleOf = (doc: RoleDocument, agentId: string): ResolvedRole => {
    const ownId = doc.assignments[agentId];
    const own = ownId === undefined ? undefined : findRole(doc, ownId);
    return resolve(doc, own ?? defaultRoleOf(doc));
  };

  /** 读一份配置：读不了（不是 JSON、形状不对）时 broken，读出来按能用的那部分 */
  const parse = (raw: string): RoleDocument | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/^﻿/, ""));
    } catch {
      return undefined;
    }
    const document = obj(parsed);
    if (document === undefined || document.format !== AGENT_ROLE_FORMAT) return undefined;
    const roles: AgentRoleStored[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(document.roles) ? document.roles : []) {
      const item = obj(entry);
      if (item === undefined || typeof item.id !== "string" || !AGENT_ROLE_ID.test(item.id) || seen.has(item.id)) {
        log(`角色表里有一行不像样（要不 id 不是 role- 开头的），跳过：${JSON.stringify(entry)}`); // @i18n-ignore log：只进日志
        continue;
      }
      const checked = typeof item.name === "string" ? checkAssistantName(item.name) : { ok: false as const, error: "名字不是字符串" }; // @i18n-ignore log：只进日志
      if (!checked.ok) {
        log(`角色 ${item.id} 的名字不合规，跳过：${checked.error}`); // @i18n-ignore log：只进日志
        continue;
      }
      seen.add(item.id);
      roles.push({ id: item.id, name: checked.name, ...(typeof item.voiceId === "string" && item.voiceId !== "" ? { voiceId: item.voiceId } : {}) });
    }
    if (roles.length === 0) {
      log(`角色的配置文件里一个能用的角色都没有：${file}`); // @i18n-ignore log：只进日志
      return undefined;
    }
    const wanted = typeof document.defaultRoleId === "string" ? document.defaultRoleId : "";
    // 默认角色那一行没了（手删了、名字不合规被跳过）：退回第一个，别让整份配置废掉
    const defaultRoleId = roles.some((role) => role.id === wanted) ? wanted : roles[0]!.id;
    if (defaultRoleId !== wanted) log(`角色的配置文件里的默认角色 ${wanted || "（没写）"} 不在了，先用 ${defaultRoleId}`); // @i18n-ignore log：只进日志
    const assignments: Record<string, string> = {};
    for (const [agentId, roleId] of Object.entries(obj(document.assignments) ?? {})) {
      if (typeof roleId !== "string") continue;
      // 指向不存在的角色、指向默认角色：都算跟默认（不留这一项）
      if (roleId === defaultRoleId || !roles.some((role) => role.id === roleId)) continue;
      assignments[agentId] = roleId;
    }
    return { defaultRoleId, roles, assignments };
  };

  /** 读现在的配置；文件还没有时用迁移算出来那份 / 合成的默认角色 */
  const read = (): RoleDocument => {
    broken = false;
    // 迁移的结果还没写进去（磁盘满、路径被占着）：这一轮就用它，别再回头读一个不存在的文件
    if (pending !== undefined) return pending;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`角色的配置文件读不了：${file}：${err instanceof Error ? err.message : String(err)}；先按只有默认角色算`); // @i18n-ignore log：只进日志
      return synthetic();
    }
    const doc = parse(raw);
    if (doc === undefined) {
      broken = true;
      log(`角色的配置文件形状不对（要 format ${AGENT_ROLE_FORMAT}、defaultRoleId、roles、assignments），先按只有默认角色算，不覆盖它：${file}`); // @i18n-ignore log：只进日志
      return synthetic();
    }
    return doc;
  };

  const write = (doc: RoleDocument) => {
    try {
      writeJsonAtomic(file, { format: AGENT_ROLE_FORMAT, defaultRoleId: doc.defaultRoleId, roles: doc.roles, assignments: sortedAssignments(doc.assignments) } satisfies { format: number } & RoleDocument);
      pending = undefined;
      broken = false;
    } catch (err) {
      throw new RequestRejected("internal", t("agentRoles.writeFailed", { reason: err instanceof Error ? err.message : String(err) }));
    }
  };

  /** 改之前先看一眼文件坏没坏：坏了不覆盖 */
  const writable = (): RoleDocument => {
    const doc = read();
    if (broken) throw new RequestRejected("not_allowed", t("agentRoles.broken", { file }));
    return doc;
  };

  /** 音色存不存得进去：没选（null）永远行；选了就要插件在、清单里有 */
  const checkedVoice = (raw: string): string | undefined => {
    if (raw === "") return undefined;
    const voices = voicesNow();
    if (voices === undefined) throw new RequestRejected("not_allowed", t("agentRoles.voiceUnavailable"));
    if (voices.get(raw) === undefined) throw new RequestRejected("bad_params", t("agentRoles.voiceNotFound", { id: raw }));
    return raw;
  };

  /** 现成的、认得的角色；没有抛 RequestRejected */
  const mustRole = (doc: RoleDocument, roleId: string): AgentRoleStored => {
    const role = findRole(doc, roleId);
    if (role === undefined) throw new RequestRejected("not_found", t("agentRoles.roleNotFound", { id: roleId }));
    return role;
  };

  /** 指定了这个角色的 agent id（默认角色不算用的：跟默认的 agent 没存进 assignments） */
  const usedBy = (doc: RoleDocument, roleId: string): string[] => Object.entries(doc.assignments).flatMap(([agentId, id]) => (id === roleId ? [agentId] : []));

  /** 新角色的 id：role-<8 位>，和现有的不撞 */
  const nextRoleId = (doc: RoleDocument): string => {
    for (;;) {
      const id = `${AGENT_ROLE_ID_PREFIX}${randomUUID().slice(0, 8)}`;
      if (findRole(doc, id) === undefined) return id;
    }
  };

  /** 默认角色在文件里的那份镜像：名字跟着全局名字、音色跟着全局选中的那个 */
  const refreshDefaultMirror = (doc: RoleDocument) => {
    const role = defaultRoleOf(doc);
    const voice = defaultVoice();
    const nextVoiceId = voice?.id;
    if (role.name === defaultName() && role.voiceId === nextVoiceId) return false;
    role.name = defaultName();
    if (nextVoiceId === undefined) delete role.voiceId;
    else role.voiceId = nextVoiceId;
    return true;
  };

  /** 迁移：全局名字 + 全局选中音色造默认角色；旧配置里和默认角色不一样的 agent 各造一个角色（同一个名字+音色共用一个） */
  const migrate = () => {
    const doc = synthetic();
    const defaultRoleName = doc.roles[0]!.name;
    const defaultVoiceId = defaultVoice()?.id;
    const byShape = new Map<string, AgentRoleStored>();
    let migrated = 0;
    for (const [agentId, profile] of Object.entries(readLegacyAgentProfiles(legacyFile, log))) {
      const name = profile.name ?? defaultRoleName;
      const voiceId = profile.voiceId;
      // 和默认角色完全一样（名字同、音色也是当前默认的那个）：不用单独建角色，现在就是那两样，不丢
      if (name === defaultRoleName && (voiceId ?? defaultVoiceId) === defaultVoiceId) continue;
      const key = `${name}\u0000${voiceId ?? ""}`;
      let role = byShape.get(key);
      if (role === undefined) {
        role = { id: nextRoleId(doc), name, ...(voiceId === undefined ? {} : { voiceId }) };
        byShape.set(key, role);
        doc.roles.push(role);
      }
      doc.assignments[agentId] = role.id;
      migrated++;
    }
    log(`已把 ${migrated} 个 agent 的名字音色迁进角色表：${file}`); // @i18n-ignore log：只进日志
    try {
      write(doc);
    } catch (err) {
      // 写不进去：先在内存里用这份（名字和音色不丢），下次启动再写一次
      pending = doc;
      log(`迁移的结果没写进角色表（先用着，下次启动再写）：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：只进日志
    }
  };

  const start = () => {
    if (fs.existsSync(file)) return;
    migrate();
  };

  return {
    document: read,
    defaultRoleId: () => read().defaultRoleId,
    defaultRole() {
      const doc = read();
      return resolve(doc, defaultRoleOf(doc));
    },
    roleOf: (agentId) => roleOf(read(), agentId),
    ownRoleIdOf(agentId) {
      const doc = read();
      const role = roleOf(doc, agentId);
      return role.isDefault ? undefined : role.id;
    },
    voiceIdOf: (agentId) => roleOf(read(), agentId).voiceId,
    assignedNameOf(agentId) {
      const role = roleOf(read(), agentId);
      return role.isDefault ? undefined : role.name;
    },
    voices: voicesNow,
    create(body) {
      const doc = writable();
      const name = checkedName(body.name);
      const voiceId = body.voiceId === undefined || body.voiceId === null ? undefined : checkedVoice(body.voiceId);
      const role: AgentRoleStored = { id: nextRoleId(doc), name, ...(voiceId === undefined ? {} : { voiceId }) };
      doc.roles.push(role);
      write(doc);
      log(`新建了角色 ${role.id}（${role.name}）`); // @i18n-ignore log：只进日志
      return doc;
    },
    update(roleId, body) {
      const doc = writable();
      const role = mustRole(doc, roleId);
      const isDefault = role.id === doc.defaultRoleId;
      busy = true;
      try {
        if (body.name !== undefined) {
          const name = checkedName(body.name);
          role.name = name;
          // 默认角色的名字就是全局名字：改它等于改全局（秘书的系统提示、名字占位跟着变）
          if (isDefault) options.setAssistantName(name);
        }
        if (body.voiceId !== undefined) {
          const voiceId = body.voiceId === null ? undefined : checkedVoice(body.voiceId);
          if (voiceId === undefined) delete role.voiceId;
          else role.voiceId = voiceId;
          // 默认角色的音色就是全局选中的那个：改它等于在语音页里选一个
          if (isDefault && voiceId !== undefined) options.selectVoice?.(voiceId);
        }
      } finally {
        busy = false;
      }
      write(doc);
      // 这个角色在用的人：名字写进了它们的系统提示，得重新装配（默认角色另外走全局名字的通知）
      changed(usedBy(doc, roleId));
      log(`角色 ${roleId} 改了：名字「${role.name}」、音色${role.voiceId === undefined ? "跟默认" : role.voiceId}`); // @i18n-ignore log：只进日志
      return doc;
    },
    remove(roleId) {
      const doc = writable();
      const role = mustRole(doc, roleId);
      if (role.id === doc.defaultRoleId) throw new RequestRejected("bad_params", t("agentRoles.defaultCannotDelete"));
      const users = usedBy(doc, roleId);
      if (users.length > 0) throw new RequestRejected("bad_params", t("agentRoles.roleInUse", { agents: users.join(t("common.listSeparator")) }));
      doc.roles = doc.roles.filter((item) => item.id !== roleId);
      write(doc);
      log(`删掉了角色 ${roleId}（${role.name}）`); // @i18n-ignore log：只进日志
      return doc;
    },
    setDefault(roleId) {
      const doc = writable();
      const role = mustRole(doc, roleId);
      if (role.id === doc.defaultRoleId) return doc;
      const previous = doc.defaultRoleId;
      doc.defaultRoleId = role.id;
      // 默认角色的名字和音色就是全局的名字和音色：把全局换成这个角色的
      busy = true;
      try {
        options.setAssistantName(role.name);
        if (role.voiceId !== undefined) options.selectVoice?.(role.voiceId);
      } finally {
        busy = false;
      }
      // 进文件的那一份镜像跟着全局（旧的默认角色留下自己原来的名字）
      refreshDefaultMirror(doc);
      write(doc);
      log(`默认角色从 ${previous} 换成了 ${role.id}（${role.name}）`); // @i18n-ignore log：只进日志
      // 跟默认的 agent 名字可能变了：它们没存 assignments，叫不出名单，交给全局名字的通知（秘书）和下一次装配现取；
      // 指定了这个角色的 agent（现在成了默认角色）的名字没变，不用通知
      return doc;
    },
    assign(agentId, roleId) {
      const doc = writable();
      if (roleId !== null && roleId !== doc.defaultRoleId) mustRole(doc, roleId);
      if (roleId === null || roleId === doc.defaultRoleId) delete doc.assignments[agentId];
      else doc.assignments[agentId] = roleId;
      write(doc);
      changed([agentId]);
      log(`agent ${agentId} 的角色改成了${roleId === null || roleId === doc.defaultRoleId ? "跟默认" : roleId}`); // @i18n-ignore log：只进日志
      return doc;
    },
    refreshGlobals() {
      // 正在改默认角色自己的名字 / 音色（update、setDefault 调的）：那边会一起写，这里别拿旧文件回头改
      if (busy || broken) return;
      const doc = read();
      if (broken) return;
      if (!refreshDefaultMirror(doc)) return;
      try {
        write(doc);
      } catch (err) {
        log(`默认角色的镜像没记进角色表：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log：只进日志
      }
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start,
  };
}
