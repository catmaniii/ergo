// 目录授权（ADR-0049）在状态层的那一半：纯函数。设置 · 目录授权的总览、各 agent 的 ⚙ 里那一块、审批卡上的"以后都允许"、
// 使用记录都用这里的说法：操作怎么写（只读、读、写、删）、到期怎么写（不写到期的醒目地写"长期有效"）、按 agent 分组。
import type { FolderMark } from "./folder-picker.ts";
import { FOLDER_GRANT_MODES, type FolderGrantMode, type FolderGrantsView, type FolderGrantView, t, tTable } from "./protocol.ts";

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

/** 到期选项怎么说 */
export function folderGrantDurationText(d: FolderGrantDuration): string {
  return d === "forever" ? t("state.folderGrants.forever") : t("state.folderGrants.days", { count: Number(d) });
}

/** 选的到期换成到期时间（now 是现在的毫秒）：长期有效没有 */
export function folderGrantExpiresAt(d: FolderGrantDuration, now: number): string | undefined {
  if (d === "forever") return undefined;
  const at = new Date(now + Number(d) * 24 * 60 * 60 * 1000);
  at.setHours(23, 59, 0, 0);
  return at.toISOString();
}
