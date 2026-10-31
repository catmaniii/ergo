// 设置里的"备份"（335 号票）：同步目录、最近一次（谁做的、成没成）、下一次什么时候（或者交给了外部定时器）、
// 现在有没有一份在做，"立即备份"做完怎么说。纯函数，界面（pages/more/BackupPage.tsx，356 号票起单独一页）只管画：能不能点看 canRun，要不要接着取看 busy。
// 356 号票多了最近一次校验怎么说、一处快照的日期和大小。
import { sizeLabel } from "./detail-content.ts";
import { type BackupRunRecord, type BackupSnapshotPlace, type BackupStatusView, type BackupVerifyCheck, t } from "./protocol.ts";

export interface BackupText {
  /** 同步目录现在怎么样（路径另外画）：能用 / 没配，只留本机 / 用不了和原因 */
  readonly syncDir: string;
  /** 最近一次：什么时候、谁做的（命令行的注明）、成没成；还没做过另说 */
  readonly last: string;
  /** 最近一次没做成（标红） */
  readonly lastFailed: boolean;
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
  const syncText = syncDir.kind === "ready" ? t("state.backup.syncDir.ready") : syncDir.kind === "none" ? t("state.backup.syncDir.none") : t("state.backup.syncDir.unusable", { reason: syncDir.reason });
  const lastText = last
    ? t("state.backup.last", { when: whenLabel(last.finishedAt), by: last.by === "script" ? t("state.backup.byScript") : t("state.backup.byDaemon"), outcome: backupOutcomeText(last) })
    : t("state.backup.never");
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
  return { syncDir: syncText, last: lastText, lastFailed: last !== undefined && backupFailed(last), next, busy, canRun: !view.queued };
}

const placeOf = (check: Pick<BackupVerifyCheck, "location">) => t(check.location === "sync" ? "state.backup.place.sync" : "state.backup.place.local");

/** 校验最新快照怎么说：在校验、还没校验过、通过（查了哪几份）、没通过（哪份、什么问题）、等备份太久没校验成；另存文件夹用不了没查的写原因 */
export function backupVerifyText(view: Pick<BackupStatusView, "verifying" | "lastVerify">): { text: string; failed: boolean } {
  if (view.verifying) return { text: t("state.backup.verify.running"), failed: false };
  const record = view.lastVerify;
  if (!record) return { text: t("state.backup.verify.never"), failed: false };
  const when = whenLabel(record.finishedAt);
  if (record.busy !== undefined) return { text: t("state.backup.verify.busy", { when, reason: record.busy }), failed: true };
  const skipped = record.syncSkipped === undefined ? "" : t("state.backup.verify.skipped", { reason: record.syncSkipped });
  const bad = record.checks.filter((c) => c.problems.length > 0);
  if (bad.length > 0) {
    const problems = bad.map((c) => t("state.backup.verify.problem", { place: placeOf(c), date: c.date, problems: c.problems.join(" ") })).join(" ");
    return { text: `${t("state.backup.verify.failed", { when, problems })}${skipped}`, failed: true };
  }
  if (record.checks.length === 0) return { text: `${t("state.backup.verify.empty", { when })}${skipped}`, failed: record.syncSkipped !== undefined };
  const list = record.checks.map((c) => t("state.backup.verify.item", { place: placeOf(c), date: c.date })).join(" · ");
  return { text: `${t("state.backup.verify.ok", { when, list })}${skipped}`, failed: record.syncSkipped !== undefined };
}

/** 一处快照的一行行：日期、大小；清单读不出来的 problem 为真，写原因 */
export function backupSnapshotRows(place: Pick<BackupSnapshotPlace, "snapshots">): Array<{ date: string; text: string; problem: boolean }> {
  return place.snapshots.map((s) => ({ date: s.date, text: s.problem ?? (s.bytes === undefined ? "" : sizeLabel(s.bytes)), problem: s.problem !== undefined }));
}

/** "立即备份"做完之后的一句提示 */
export function backupDoneText(record: BackupRunRecord): string {
  return backupFailed(record) ? t("state.backup.doneFailed", { outcome: backupOutcomeText(record) }) : t("state.backup.doneOk", { date: record.date, outcome: backupOutcomeText(record) });
}
