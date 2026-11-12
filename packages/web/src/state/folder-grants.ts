// 目录授权（ADR-0049）在状态层的那一半：纯函数。设置 · 目录授权的总览、各 agent 的 ⚙ 里那一块、审批卡上的"以后都允许"、
// 使用记录都用这里的说法：操作怎么写（只读、读、写、删）、到期怎么写（不写到期的醒目地写"长期有效"）、按 agent 分组。
// agent 自己申请的那张卡（464，folder_grant_request）上的说法也在这里：已经登记了什么、多久能选哪几样、处理之后怎么写。
import type { FolderMark } from "./folder-picker.ts";
import { FOLDER_GRANT_MODES, type FolderGrantMode, type FolderGrantRequestCardPayload, type FolderGrantsView, type FolderGrantView, nowIso, t, tTable } from "./protocol.ts";

/** 一种操作怎么说 */
export const FOLDER_GRANT_MODE_LABEL: Readonly<Record<FolderGrantMode, string>> = tTable({
  read: "state.folderGrants.mode.read",
  write: "state.folderGrants.mode.write",
  delete: "state.folderGrants.mode.delete",
});

/** 登记了的操作怎么说：只有读的写"只读"，别的按读、写、删的先后列出来 */
export function folderGrantModesText(modes: readonly FolderGrantMode[]): string {
  if (modes.length === 1 && modes[0] === "read") return t("state.folderGrants.readOnly");
  return FOLDER_GRANT_MODES.filter((m) => modes.includes(m))
    .map((m) => FOLDER_GRANT_MODE_LABEL[m])
    .join(t("state.folderGrants.modeSep"));
}

/** 协议时间写给人看：2026-11-08 18:00（写的就是守护进程那边的本地时间） */
export function folderGrantTimeText(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/** 到期怎么说：长期有效（醒目）、到某时、已过期 */
export function folderGrantExpiry(grant: Pick<FolderGrantView, "expiresAt" | "state">): { text: string; tone: "forever" | "until" | "expired" } {
  if (grant.state === "expired") return { text: grant.expiresAt ? t("state.folderGrants.expiredAt", { at: folderGrantTimeText(grant.expiresAt) }) : t("state.folderGrants.expired"), tone: "expired" };
  if (grant.expiresAt === undefined) return { text: t("state.folderGrants.forever"), tone: "forever" };
  return { text: t("state.folderGrants.until", { at: folderGrantTimeText(grant.expiresAt) }), tone: "until" };
}

/** 一组：一个 agent 的全部授权（认不得的 agent 没有名字） */
export interface FolderGrantGroup {
  agentId: string;
  agentLabel: string | undefined;
  grants: FolderGrantView[];
}

/** 按 agent 分组：个人助理在最前，其余按第一次出现的先后 */
export function folderGrantGroups(view: FolderGrantsView): FolderGrantGroup[] {
  const groups: FolderGrantGroup[] = [];
  for (const g of view.grants) {
    let group = groups.find((x) => x.agentId === g.agentId);
    if (!group) groups.push((group = { agentId: g.agentId, agentLabel: g.agentLabel, grants: [] }));
    group.grants.push(g);
  }
  return groups.toSorted((a, b) => Number(b.agentId === "secretary") - Number(a.agentId === "secretary"));
}

/** 这个 agent 的那几条 */
export function folderGrantsOf(view: FolderGrantsView | undefined, agentId: string): FolderGrantView[] {
  return view?.grants.filter((g) => g.agentId === agentId) ?? [];
}

/**
 * ⚙ 里登记目录时，选文件夹的框要标出来的：这个 agent 已经登记了的标"已登记"（再选一次是换成新填的那一条），
 * 授权的文件夹标"所有 agent 可读"（那里已经能读，要写、删才需要单独登记）。两种都还能选
 */
export function folderGrantPickerMarks(view: FolderGrantsView | undefined, agentId: string): FolderMark[] {
  return [
    { paths: folderGrantsOf(view, agentId).map((g) => g.path), label: t("state.folderGrants.markRegistered") },
    { paths: view?.authorizedFolders ?? [], label: t("state.folderGrants.markReadable") },
  ];
}

/** 有几条已过期 */
export function expiredFolderGrants(view: FolderGrantsView | undefined): number {
  return view?.grants.filter((g) => g.state === "expired").length ?? 0;
}

/** 加的框里选的到期：长期有效，或者从今天起多少天（换成那一天的 23:59，写成带偏移的时间） */
export const FOLDER_GRANT_DURATIONS = ["forever", "1", "7", "30", "90"] as const;
export type FolderGrantDuration = (typeof FOLDER_GRANT_DURATIONS)[number];

/** 到期选项怎么说（申请卡上还有申请的天数，不在固定的几样里也照写） */
export function folderGrantDurationText(d: FolderGrantDuration | string): string {
  return d === "forever" ? t("state.folderGrants.forever") : t("state.folderGrants.days", { count: Number(d) });
}

/** 选的到期换成到期时间（now 是现在的毫秒）：长期有效没有 */
export function folderGrantExpiresAt(d: FolderGrantDuration, now: number): string | undefined {
  if (d === "forever") return undefined;
  const at = new Date(now + Number(d) * 24 * 60 * 60 * 1000);
  at.setHours(23, 59, 0, 0);
  return at.toISOString();
}

// ───────────────────────── agent 申请的卡（464） ─────────────────────────

/** 几样操作一样一样列出来（"写、删"；不像 folderGrantModesText 那样把只有读的写成"只读"） */
function modesList(modes: readonly FolderGrantMode[]): string {
  return FOLDER_GRANT_MODES.filter((m) => modes.includes(m))
    .map((m) => FOLDER_GRANT_MODE_LABEL[m])
    .join(t("state.folderGrants.modeSep"));
}

/** 申请的多久写成选项的值：长期有效是 forever，别的是天数 */
export function folderGrantRequestDuration(days: number | undefined): string {
  return days === undefined ? "forever" : String(days);
}

/** 选项的值换回天数：长期有效是 null（同意时交给守护进程的写法） */
export function folderGrantRequestDays(value: string): number | null {
  return value === "forever" ? null : Number(value);
}

/** 申请卡上"多久"能选的：长期有效和几个常用的天数，申请的天数不在里面的按长短插进去 */
export function folderGrantRequestDurations(days: number | undefined): string[] {
  const options: string[] = [...FOLDER_GRANT_DURATIONS];
  const asked = folderGrantRequestDuration(days);
  if (options.includes(asked)) return options;
  const at = options.findIndex((o) => o !== "forever" && Number(o) > Number(asked));
  return at < 0 ? [...options, asked] : [...options.slice(0, at), asked, ...options.slice(at)];
}

/** 路径比较用的写法：不分大小写、正反斜杠，去掉末尾的斜杠 */
const comparablePath = (p: string) => p.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();

/** 两个路径是不是同一个目录 */
const samePath = (a: string, b: string) => comparablePath(a) === comparablePath(b);

/** 申请的天数现在同意的话到什么时候：从 now 起第几天的 23:59（和守护进程、⚙ 里加的一样算，写成带偏移的本地时间） */
export function folderGrantRequestUntil(days: number, now: number): string {
  const at = new Date(now + days * 24 * 60 * 60 * 1000);
  at.setHours(23, 59, 0, 0);
  return nowIso(at);
}

/**
 * 申请卡上"已有"那一行：这个目录已经登记了的写"现在只读（长期有效），这次要加写、删"；期限不够、这次要延长的写
 * "现在读、写，到 11-14 23:59；这次要延到 02-10 23:59"（要长期有效的写"改成长期有效"；延到哪天按现在同意算，now 是现在的毫秒）；
 * 登记的是上级目录的写出是哪个；以前登记过、已经过期的写明。没登记过的是 undefined
 */
export function folderGrantRequestExisting(p: Pick<FolderGrantRequestCardPayload, "path" | "modes" | "days" | "existing">, now: number): string | undefined {
  const e = p.existing;
  if (!e) return undefined;
  const has = folderGrantModesText(e.modes);
  if (e.expired) return t("state.folderGrants.request.existingExpired", { path: e.path, has, at: e.expiresAt ? folderGrantTimeText(e.expiresAt) : "" });
  const expiry = folderGrantExpiry({ ...(e.expiresAt === undefined ? {} : { expiresAt: e.expiresAt }), state: "active" }).text;
  if (!samePath(e.path, p.path)) return t("state.folderGrants.request.existingParent", { path: e.path, has, expiry });
  const add = modesList(p.modes.filter((m) => !e.modes.includes(m)));
  const until = p.days === undefined ? undefined : folderGrantRequestUntil(p.days, now);
  // 要延长：已有的有期限，这次要长期有效，或者要到的比它晚
  if (e.expiresAt !== undefined && (until === undefined || Date.parse(until) > Date.parse(e.expiresAt))) {
    const at = folderGrantTimeText(e.expiresAt);
    if (until === undefined) return add ? t("state.folderGrants.request.existingAddForever", { has, at, add }) : t("state.folderGrants.request.existingForever", { has, at });
    const to = folderGrantTimeText(until);
    return add ? t("state.folderGrants.request.existingAddExtend", { has, at, add, until: to }) : t("state.folderGrants.request.existingExtend", { has, at, until: to });
  }
  return add ? t("state.folderGrants.request.existingAdd", { has, expiry, add }) : t("state.folderGrants.request.existingHas", { has, expiry });
}

/** 申请卡上"要"那一行：几样操作（一样一样列）和多久 */
export function folderGrantRequestAsk(p: Pick<FolderGrantRequestCardPayload, "modes" | "days">): { modes: string; duration: string } {
  return { modes: modesList(p.modes), duration: folderGrantDurationText(folderGrantRequestDuration(p.days)) };
}

/** 处理之后卡上写的：同意了登记成什么（并进已有的之后）、到什么时候；没同意的写没同意。附的那句话跟在后面 */
export function folderGrantRequestOutcome(p: Pick<FolderGrantRequestCardPayload, "decided">): string | undefined {
  const d = p.decided;
  if (!d) return undefined;
  const note = d.note;
  if (d.approved && d.grant) {
    const expiry = folderGrantExpiry({ ...(d.grant.expiresAt === undefined ? {} : { expiresAt: d.grant.expiresAt }), state: "active" }).text;
    const text = t("state.folderGrants.request.approved", { modes: folderGrantModesText(d.grant.modes), expiry });
    return note ? t("state.folderGrants.request.withNote", { text, note }) : text;
  }
  return note ? t("state.folderGrants.request.deniedNote", { note }) : t("state.folderGrants.request.denied");
}
