// 设置里的"备份"（335 号票）：同步目录、最近一次、最新的快照、下一次（或者交给了外部定时器），"立即备份"按钮。
// 每次打开设置现取；有一份在做（守护进程排着、锁的主人还活着）时每 2 秒再取一遍，点过"立即备份"的做完了弹一句结果。
// 说法在状态层（state/backup.ts）。
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type BackupStatusView, backupDoneText, backupText, t } from "../../state/index.ts";
import { useToast } from "../../ui/toast.tsx";

/** 有一份在做时多久再取一遍 */
const POLL_MS = 2_000;

export function BackupSetting() {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<BackupStatusView>();
  /** 没取到的原因 */
  const [failed, setFailed] = useState<string>();
  const [starting, setStarting] = useState(false);
  /** 点过"立即备份"、还在等它做完 */
  const waiting = useRef(false);

  const show = (next: BackupStatusView) => {
    setView(next);
    setFailed(undefined);
  };

  useEffect(() => {
    let live = true;
    http.backupStatus().then(
      (v) => {
        if (!live) return;
        setView(v);
        setFailed(undefined);
      },
      (err: unknown) => {
        if (live) setFailed(t("pages.backup.loadFailed", { reason: err instanceof Error ? err.message : String(err) }));
      },
    );
    return () => {
      live = false;
    };
  }, [http]);

  // 有一份在做：过一会儿再取一遍，直到做完
  useEffect(() => {
    if (!view || (!view.queued && !view.running)) return;
    let live = true;
    const timer = setTimeout(() => {
      http.backupStatus().then(
        (v) => {
          if (live) setView(v);
        },
        () => {},
      );
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [http, view]);

  // 点过"立即备份"的做完了（守护进程这边不再排着）：弹一句结果
  useEffect(() => {
    if (!view || view.queued || !waiting.current) return;
    waiting.current = false;
    if (view.last) toast(backupDoneText(view.last));
  }, [view, toast]);

  const text = view && backupText(view);
  const run = () => {
    setStarting(true);
    waiting.current = true;
    http
      .backupRun()
      .then(show, (err: unknown) => {
        waiting.current = false;
        toast(t("pages.backup.startFailed", { reason: err instanceof Error ? err.message : String(err) }));
      })
      .finally(() => setStarting(false));
  };

  return (
    <div className="backup-setting" data-section="backup">
      <div className="menu-text">
        {t("pages.backup.title")}
        <small>{text?.syncDir ?? failed ?? t("pages.backup.loading")}</small>
        {text && <small className={text.lastFailed ? "danger-text" : undefined}>{text.last}</small>}
        {text && <small>{text.latest}</small>}
        {text && <small>{text.next}</small>}
      </div>
      <div className="backup-setting-row">
        <span className="muted">{text?.busy ?? ""}</span>
        <button type="button" className="btn ghost small" disabled={starting || !text?.canRun} onClick={run}>
          {starting || view?.queued ? t("pages.backup.working") : t("pages.backup.now")}
        </button>
      </div>
    </div>
  );
}
