// 目录授权（ADR-0049）：每个 agent 一份目录授权表——秘书一份（agent id secretary）、每个项目一份（项目负责人的 pm-<n>，
// 项目的负责人在各段都用）、每个任务一份（任务负责人的 tm-<n>）；子 agent、评审、记忆管理员没有（canHold 说了算）。
// 存在数据目录配置区的 folder-grants.json（{ "format": 1, "grants": [...] }），只由运行时写：设置 · 目录授权和各 agent 的 ⚙ 里加、删、清，
// 审批卡上的"以后都允许"登记（allow），agent 申请、用户在申请卡上同意的并进去（merge，464：folder-grant-requests.ts）；
// agent 自己改不了它（申请只是发一张卡），配置区本来就是受保护区域。
// - 每条：哪个 agent、哪个目录（登记时的真实路径：fs.realpathSync.native 展开符号链接、目录联接、8.3 短名）、哪几种操作
//   （读、写、删可组合，删不带写）、到期时间（不写是长期有效）、为什么给、谁什么时候加的、到期前提示过没有；
// - 同一个 agent 同一个目录只有一条：再加是换掉（操作、到期时间、说明换成新的）；"以后都允许"是并进去（操作取并集、变成长期有效）；
//   申请卡上同意的也是并进去（操作取并集、到期取更晚的，长期有效最晚）：已有的那条不会被收窄；
// - 登记的目录要在、要是目录，不能在数据目录、二狗程序目录里（守卫本来也不算它们）；
// - 守卫每次判定现读这个 agent 的那一份（forAgent，过期的也给，判定时按 now 算），改了下一次调用就生效。
// 文件坏了当没有（记一条日志），下次存的时候整份重写。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  FOLDER_GRANT_ADDED_BY,
  FOLDER_GRANT_MODES,
  FOLDER_GRANTS_PER_AGENT_MAX,
  type FolderGrantAddedBy,
  type FolderGrantMode,
  type FolderGrantsView,
  type FolderGrantView,
  nowIso,
  t,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { comparable, type GuardFolderGrant, isWithin } from "../guard/index.ts";
import { writeJsonAtomic } from "../util/json-file.ts";

/** 文件里的一条 */
export interface FolderGrantRecord {
  id: string;
  agentId: string;
  /** 登记的目录（登记时的真实路径） */
  path: string;
  modes: FolderGrantMode[];
  /** 到期时间（协议时间）；不写是长期有效 */
  expiresAt?: string;
  note: string;
  addedBy: FolderGrantAddedBy;
  addedAt: string;
  /** 到期前在待办里提示过的时间（每条只提示一次） */
  remindedAt?: string;
}

/** 加一条要给的 */
export interface NewFolderGrant {
  agentId: string;
  path: string;
  modes: readonly FolderGrantMode[];
  expiresAt?: string | undefined;
  note?: string | undefined;
  addedBy: FolderGrantAddedBy;
}

/** 一次清掉哪些：给 ids 清这几条，expired 清掉全部已过期的；agentId 只清这个 agent 的 */
export interface FolderGrantsClear {
  ids?: readonly string[] | undefined;
  expired?: boolean | undefined;
  agentId?: string | undefined;
}

export interface FolderGrants {
  /** 全部（按加的先后） */
  list(): FolderGrantRecord[];
  /** 这个 agent 的那一份，换成守卫要的样子（过期的也给，判定时按 now 算） */
  forAgent(agentId: string): GuardFolderGrant[];
  /** 加一条（同一个 agent 同一个目录已经有的换掉）；目录不对、agent 不能有表、到期时间不对、超过上限抛 bad_params */
  add(input: NewFolderGrant): FolderGrantRecord;
  /** 审批卡上的"以后都允许"：并进已有的（操作取并集、变成长期有效），没有就加一条长期有效的 */
  allow(agentId: string, dir: string, modes: readonly FolderGrantMode[]): FolderGrantRecord;
  /**
   * 并进已有的（申请卡上同意的）：操作取并集、到期取更晚的（长期有效最晚），已有的说明留着（没有才用这次的），谁加的、什么时候换成这次的；
   * 已有的过期了按重新登记算（只留这次的）。没有就加一条。校验和 add 同一套，不对抛 bad_params
   */
  merge(input: NewFolderGrant): FolderGrantRecord;
  /** 要登记的目录查一遍（完整路径、在、是目录、不在数据目录和程序目录里），回它的真实路径；不对抛 bad_params（原因写给人看） */
  resolve(dir: string): string;
  /** 删几条，回删掉了几条 */
  remove(ids: readonly string[]): number;
  /** 一次清掉几条，回清掉了几条 */
  clear(filter: FolderGrantsClear): number;
  /** 记下这几条到期前提示过了 */
  markReminded(ids: readonly string[]): void;
}

export interface FolderGrantsOptions {
  file: string;
  /** 现在（毫秒）：到期时间要晚于它；过期的按它算 */
  now: () => number;
  /** 不能登记的地方：数据目录、二狗程序目录（真实路径） */
  forbidden: () => readonly string[];
  /** 这个 agent 能不能有目录授权表（秘书、在的项目负责人、在的任务负责人） */
  canHold: (agentId: string) => boolean;
  log: (line: string) => void;
}

const isMode = (m: unknown): m is FolderGrantMode => typeof m === "string" && (FOLDER_GRANT_MODES as readonly string[]).includes(m);

/** 操作按读、写、删的先后排好、去重 */
const sortedModes = (modes: readonly FolderGrantMode[]): FolderGrantMode[] => FOLDER_GRANT_MODES.filter((m) => modes.includes(m));

const text = (x: unknown) => (typeof x === "string" ? x : undefined);

/** 要登记的操作：按读、写、删排好，一种都没有抛 bad_params */
function checkModes(modes: readonly FolderGrantMode[]): FolderGrantMode[] {
  const sorted = sortedModes(modes);
  if (sorted.length === 0) throw new RequestRejected("bad_params", t("folders.grants.noModes"));
  return sorted;
}

/** 文件里的一条读出来：字段不对的整条不要 */
function recordOf(value: unknown): FolderGrantRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const modes = Array.isArray(v.modes) ? sortedModes(v.modes.filter(isMode)) : [];
  const id = text(v.id);
  const agentId = text(v.agentId);
  const dir = text(v.path);
  const addedAt = text(v.addedAt);
  if (!id || !agentId || !dir || !path.isAbsolute(dir) || modes.length === 0 || !addedAt) return undefined;
  const expiresAt = text(v.expiresAt);
  const remindedAt = text(v.remindedAt);
  const addedBy = (FOLDER_GRANT_ADDED_BY as readonly unknown[]).includes(v.addedBy) ? (v.addedBy as FolderGrantAddedBy) : "user";
  return {
    id,
    agentId,
    path: dir,
    modes,
    ...(expiresAt !== undefined && Number.isFinite(Date.parse(expiresAt)) ? { expiresAt } : {}),
    note: text(v.note) ?? "",
    addedBy,
    addedAt,
    ...(remindedAt !== undefined ? { remindedAt } : {}),
  };
}

/** 设置 · 目录授权、⚙ 里看的样子：每条现在的状态（过期的、目录找不到了的），谁的（认不得的 agent 不写名字），连同授权的文件夹 */
export function folderGrantsView(
  grants: readonly FolderGrantRecord[],
  context: { now: number; labelOf: (agentId: string) => string | undefined; authorizedFolders: readonly string[]; isDirectory: (dir: string) => boolean },
): FolderGrantsView {
  return {
    grants: grants.map((g): FolderGrantView => {
      const label = context.labelOf(g.agentId);
      const state = folderGrantExpired(g, context.now) ? "expired" : context.isDirectory(g.path) ? "active" : "missing";
      return {
        id: g.id,
        agentId: g.agentId,
        ...(label === undefined ? {} : { agentLabel: label }),
        path: g.path,
        modes: g.modes,
        ...(g.expiresAt === undefined ? {} : { expiresAt: g.expiresAt }),
        note: g.note,
        addedBy: g.addedBy,
        addedAt: g.addedAt,
        state,
      };
    }),
    authorizedFolders: [...context.authorizedFolders],
  };
}

/** 一条现在过期了没有 */
export function folderGrantExpired(grant: Pick<FolderGrantRecord, "expiresAt">, now: number): boolean {
  return grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now;
}

export function openFolderGrants(options: FolderGrantsOptions): FolderGrants {
  const read = (): FolderGrantRecord[] => {
    if (!fs.existsSync(options.file)) return [];
    try {
      const value = JSON.parse(fs.readFileSync(options.file, "utf8")) as { grants?: unknown };
      return Array.isArray(value.grants) ? value.grants.map(recordOf).filter((g): g is FolderGrantRecord => g !== undefined) : [];
    } catch (err) {
      options.log(`目录授权（${options.file}）读不出来，当没有登记：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };
  const save = (grants: readonly FolderGrantRecord[]) => writeJsonAtomic(options.file, { format: 1, grants });

  /** 要登记的目录：完整路径、在、是目录，换成真实路径；不能在数据目录、程序目录里 */
  const realDir = (raw: string): string => {
    const written = raw.trim();
    if (!path.isAbsolute(written)) throw new RequestRejected("bad_params", t("folders.grants.notAbsolute", { path: written }));
    let real: string;
    try {
      real = fs.realpathSync.native(path.resolve(written));
    } catch {
      throw new RequestRejected("bad_params", t("folders.grants.missing", { path: written }));
    }
    let directory = false;
    try {
      directory = fs.statSync(real).isDirectory();
    } catch {
      directory = false;
    }
    if (!directory) throw new RequestRejected("bad_params", t("folders.grants.notDirectory", { path: written }));
    if (options.forbidden().some((dir) => isWithin(real, dir))) throw new RequestRejected("bad_params", t("folders.grants.forbidden", { path: real }));
    return real;
  };

  const checkAgent = (agentId: string) => {
    if (!options.canHold(agentId)) throw new RequestRejected("bad_params", t("folders.grants.noTable", { agentId }));
  };

  /** 到期时间：要是以后的时间，写成协议时间 */
  const checkExpiry = (raw: string | undefined): string | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) throw new RequestRejected("bad_params", t("folders.grants.badExpiry", { at: raw }));
    if (at <= options.now()) throw new RequestRejected("bad_params", t("folders.grants.pastExpiry", { at: raw }));
    return nowIso(new Date(at));
  };

  /** 换掉或加上一条（同一个 agent 同一个目录只有一条），超过上限抛 bad_params */
  const put = (grants: FolderGrantRecord[], next: FolderGrantRecord): FolderGrantRecord => {
    const index = grants.findIndex((g) => g.agentId === next.agentId && comparable(g.path) === comparable(next.path));
    if (index >= 0) {
      const merged = { ...next, id: grants[index]!.id };
      grants[index] = merged;
      save(grants);
      return merged;
    }
    if (grants.filter((g) => g.agentId === next.agentId).length >= FOLDER_GRANTS_PER_AGENT_MAX) {
      throw new RequestRejected("bad_params", t("folders.grants.tooMany", { max: FOLDER_GRANTS_PER_AGENT_MAX }));
    }
    grants.push(next);
    save(grants);
    return next;
  };

  return {
    list: read,
    forAgent: (agentId) =>
      read()
        .filter((g) => g.agentId === agentId)
        .map((g) => ({ grantId: g.id, dir: g.path, modes: g.modes, ...(g.expiresAt === undefined ? {} : { expiresAt: Date.parse(g.expiresAt) }) })),
    add(input) {
      checkAgent(input.agentId);
      const modes = checkModes(input.modes);
      const dir = realDir(input.path);
      const expiresAt = checkExpiry(input.expiresAt);
      const note = (input.note ?? "").trim();
      const record: FolderGrantRecord = {
        id: `fg-${randomUUID()}`,
        agentId: input.agentId,
        path: dir,
        modes,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        note,
        addedBy: input.addedBy,
        addedAt: nowIso(new Date(options.now())),
      };
      return put(read(), record);
    },
    allow(agentId, raw, modes) {
      checkAgent(agentId);
      const dir = realDir(raw);
      const grants = read();
      const existing = grants.find((g) => g.agentId === agentId && comparable(g.path) === comparable(dir));
      const record: FolderGrantRecord = {
        id: `fg-${randomUUID()}`,
        agentId,
        path: dir,
        // 过期了的并进来也是重新登记：只留这次要的
        modes: checkModes([...(existing && !folderGrantExpired(existing, options.now()) ? existing.modes : []), ...modes]),
        note: existing?.note ?? "",
        addedBy: "approval",
        addedAt: nowIso(new Date(options.now())),
      };
      return put(grants, record);
    },
    merge(input) {
      checkAgent(input.agentId);
      const dir = realDir(input.path);
      const expiresAt = checkExpiry(input.expiresAt);
      const grants = read();
      const found = grants.find((g) => g.agentId === input.agentId && comparable(g.path) === comparable(dir));
      // 过期了的并进来也是重新登记：只留这次的
      const existing = found && !folderGrantExpired(found, options.now()) ? found : undefined;
      const later = existing === undefined ? expiresAt : existing.expiresAt === undefined || expiresAt === undefined ? undefined : Date.parse(existing.expiresAt) >= Date.parse(expiresAt) ? existing.expiresAt : expiresAt;
      const record: FolderGrantRecord = {
        id: `fg-${randomUUID()}`,
        agentId: input.agentId,
        path: dir,
        modes: checkModes([...(existing?.modes ?? []), ...input.modes]),
        ...(later === undefined ? {} : { expiresAt: later }),
        note: existing?.note || (input.note ?? "").trim(),
        addedBy: input.addedBy,
        addedAt: nowIso(new Date(options.now())),
        // 到期时间没变的：提示过就不再提示
        ...(existing?.remindedAt !== undefined && later !== undefined && later === existing.expiresAt ? { remindedAt: existing.remindedAt } : {}),
      };
      return put(grants, record);
    },
    resolve: realDir,
    remove(ids) {
      const grants = read();
      const kept = grants.filter((g) => !ids.includes(g.id));
      if (kept.length !== grants.length) save(kept);
      return grants.length - kept.length;
    },
    clear(filter) {
      const now = options.now();
      const grants = read();
      const hit = (g: FolderGrantRecord) =>
        (filter.agentId === undefined || g.agentId === filter.agentId) && ((filter.ids?.includes(g.id) ?? false) || (filter.expired === true && folderGrantExpired(g, now)) || (filter.ids === undefined && filter.expired !== true));
      const kept = grants.filter((g) => !hit(g));
      if (kept.length !== grants.length) save(kept);
      return grants.length - kept.length;
    },
    markReminded(ids) {
      if (ids.length === 0) return;
      const at = nowIso(new Date(options.now()));
      const grants = read().map((g) => (ids.includes(g.id) ? { ...g, remindedAt: at } : g));
      save(grants);
    },
  };
}
