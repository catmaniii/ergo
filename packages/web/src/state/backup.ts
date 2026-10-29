// 设置里的"备份"（335 号票）：同步目录、最近一次（谁做的、成没成）、本机和同步目录里最新的快照、下一次什么时候（或者交给了外部定时器）、
// 现在有没有一份在做，"立即备份"做完怎么说。纯函数，界面（pages/more/BackupSetting.tsx）只管画：能不能点看 canRun，要不要接着取看 busy。
import { type BackupRunRecord, type BackupStatusView, t } from "./protocol.ts";

export interface BackupText {
  /** 同步目录：写在哪 / 没配，只在本机 / 用不了和原因 */
  readonly syncDir: string;
  /** 最近一次：什么时候、谁做的（命令行的注明）、成没成；还没做过另说 */
  readonly last: string;
  /** 最近一次没做成（标红） */
  readonly lastFailed: boolean;
  /** 本机、同步目录里最新一份快照的日期 */
  readonly latest: string;
  /** 下一次：每天几点、下次哪天几点；交给外部定时器的写清楚 */
  readonly next: string;
  /** 现在在做的（谁、从几点起）、排着的；都没有是 undefined */
  readonly busy: string | undefined;
  /** 守护进程这边没排着才能点"立即备份" */
  readonly canRun: boolean;
}

/** 月-日 时:分（协议时间里写的本地时刻） */
function whenLabel(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}

/** 这一次没做成：本机快照没做成，或者没写进同步目录 */
export const backupFailed = (record: Pick<BackupRunRecord, "local" | "sync">): boolean => record.local === "failed" || record.sync === "failed";

/** 一次备份的结果怎么说 */
export function backupOutcomeText(record: Pick<BackupRunRecord, "local" | "sync" | "error">): string {
  const reason = record.error ?? t("state.backup.unknownReason");
  if (record.local === "failed") return t("state.backup.outcome.localFailed", { reason });
  if (record.sync === "failed") return t("state.backup.outcome.syncFailed", { reason });
  if (record.sync === "not_configured") return t("state.backup.outcome.localOnly");
  if (record.local === "kept" && record.sync === "kept") return t("state.backup.outcome.kept");
  return t("state.backup.outcome.done");
}

export function backupText(view: BackupStatusView): BackupText {
  const { syncDir, last, running } = view;
  const syncText =
    syncDir.kind === "ready" ? t("state.backup.syncDir.ready", { dir: syncDir.dir }) : syncDir.kind === "none" ? t("state.backup.syncDir.none") : t("state.backup.syncDir.unusable", { reason: syncDir.reason });
  const lastText = last
    ? t("state.backup.last", { when: whenLabel(last.finishedAt), by: last.by === "script" ? t("state.backup.byScript") : "", outcome: backupOutcomeText(last) })
    : t("state.backup.never");
  const none = t("state.backup.noSnapshot");
  const latest =
    view.latestLocal === undefined && view.latestSync === undefined
      ? t("state.backup.noSnapshots")
      : syncDir.kind === "none"
        ? t("state.backup.latestLocal", { local: view.latestLocal ?? none })
        : t("state.backup.latest", { local: view.latestLocal ?? none, sync: view.latestSync ?? none });
  const next =
    view.schedule === "external"
      ? t("state.backup.next.external")
      : view.next
        ? t("state.backup.next.internal", { time: view.time, when: whenLabel(view.next) })
        : t("state.backup.next.daily", { time: view.time });
  const busy = running
    ? t("state.backup.running", { who: t(running.by === "script" ? "state.backup.who.script" : "state.backup.who.daemon"), since: whenLabel(running.since) })
    : view.queued
      ? t("state.backup.queued")
      : undefined;
  return { syncDir: syncText, last: lastText, lastFailed: last !== undefined && backupFailed(last), latest, next, busy, canRun: !view.queued };
}

/** "立即备份"做完之后的一句提示 */
export function backupDoneText(record: BackupRunRecord): string {
  return backupFailed(record) ? t("state.backup.doneFailed", { outcome: backupOutcomeText(record) }) : t("state.backup.doneOk", { date: record.date, outcome: backupOutcomeText(record) });
}
