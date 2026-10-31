// 设置 · 备份（356 号票，#/more/backup；335 号票时是设置列表里就地展开的一小块）：详细的配置和按钮都在这一页。手机上也能开，选的文件夹照样是二狗那台电脑上的。
// - 状态：最近一次（什么时候、谁做的、成没成、失败原因）、下一次、现在有没有在做；
// - 备份放在哪：另存一份的文件夹（完整路径、能不能用、更改…、清掉、在电脑上打开），本机那份（路径、在电脑上打开）；
// - 什么时候备份：每晚几点、谁来定时，选外部定时器时写清要调哪条命令（按这台电脑的装法，守护进程现算）；
// - 留几份（只读）、已有的快照（本机和另存文件夹各列日期和大小，取不到写原因）；
// - 动手：立即备份、校验最新快照、怎么恢复（展开说明和能复制的命令）。这一页不做一键恢复：恢复要先停二狗。
// 改配置马上写进配置文件、马上生效，不用重启。选文件夹的框复用授权文件夹那个（ui/authorized-folders.tsx），选定之后的流程在 app/backup-folder.ts；说法在 state/backup.ts。
// 有一份在做（守护进程排着、锁的主人还活着、在校验）时每 2 秒再取一遍。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AuthorizedFolders } from "../../app/authorized-folders.ts";
import { chooseBackupFolder } from "../../app/backup-folder.ts";
import { copyText } from "../../app/debug-page.ts";
import { useStore } from "../../app/store.tsx";
import { type BackupConfigBody, type BackupPlace, type BackupRestoreStep, type BackupSnapshotPlace, type BackupSnapshotsView, type BackupStatusView, backupDoneText, backupSnapshotRows, backupText, backupVerifyText, t } from "../../state/index.ts";
import { FolderPickerBody } from "../../ui/authorized-folders.tsx";
import { Section, Segmented, Sheet } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

/** 有一份在做时多久再取一遍 */
const POLL_MS = 2_000;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 一条能复制的命令 */
function CommandLine({ command }: { command: string }) {
  const toast = useToast();
  return (
    <div className="backup-command">
      <code>{command}</code>
      <button type="button" className="btn ghost small" onClick={() => void copyText(command).then((ok) => toast(t(ok ? "pages.backup.copied" : "pages.backup.copyFailed")))}>
        {t("pages.backup.copy")}
      </button>
    </div>
  );
}

/** 一处的快照：日期和大小，取不到写原因 */
function SnapshotList({ title, place }: { title: string; place: BackupSnapshotPlace }) {
  return (
    <div className="backup-snapshots" data-place={title}>
      <h4>{title}</h4>
      {place.problem !== undefined && <div className="danger-text">{place.problem}</div>}
      {place.problem === undefined && place.snapshots.length === 0 && <div className="muted">{t("pages.backup.snapshots.none")}</div>}
      {place.snapshots.length > 0 && (
        <ul>
          {backupSnapshotRows(place).map((row) => (
            <li key={row.date}>
              <span>{row.date}</span>
              <span className={row.problem ? "danger-text" : "muted"}>{row.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 怎么恢复：展开说明和命令 */
function RestoreGuide({ steps }: { steps: readonly BackupRestoreStep[] }) {
  return (
    <div className="backup-restore">
      <p className="muted">{t("pages.backup.restore.intro")}</p>
      <ol>
        {steps.map((step) => (
          <li key={step.command}>
            <div>{step.note}</div>
            <CommandLine command={step.command} />
          </li>
        ))}
      </ol>
      <p className="muted">{t("pages.backup.restore.after")}</p>
    </div>
  );
}

export function BackupPage() {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<BackupStatusView>();
  /** 没取到的原因 */
  const [failed, setFailed] = useState<string>();
  const [snapshots, setSnapshots] = useState<BackupSnapshotsView>();
  const [snapshotsFailed, setSnapshotsFailed] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [time, setTime] = useState<string>();
  const [clearing, setClearing] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  /** 文件夹不存在，在问要不要新建：dir 和回答的那个函数 */
  const [asking, setAsking] = useState<{ dir: string; answer(yes: boolean): void }>();
  /** 点过"立即备份"、点过"校验最新快照"，还在等它做完 */
  const waitingBackup = useRef(false);
  const waitingVerify = useRef(false);

  const show = useCallback((next: BackupStatusView) => {
    setView(next);
    setFailed(undefined);
  }, []);

  const loadSnapshots = useCallback(() => {
    http.backupSnapshots().then(
      (next) => {
        setSnapshots(next);
        setSnapshotsFailed(undefined);
      },
      (err: unknown) => setSnapshotsFailed(t("pages.backup.snapshots.failed", { reason: messageOf(err) })),
    );
  }, [http]);

  // 选文件夹的框：列文件夹、上一级、贴路径都用授权文件夹那一套，"授权"换成校验、问要不要新建、写配置
  const picker = useMemo(
    () =>
      new AuthorizedFolders({
        localFolders: () => Promise.resolve({ folders: [] }),
        browseFolders: (folder) => http.browseFolders(folder),
        changeLocalFolders: async (change) => {
          const dir = change.add?.[0] ?? "";
          const next = await chooseBackupFolder(http, dir, (missing) => new Promise((resolve) => setAsking({ dir: missing, answer: resolve })));
          show(next);
          loadSnapshots();
          const chosen = next.syncDir.kind === "none" ? dir : next.syncDir.dir;
          toast(next.queued || next.running ? t("pages.backup.changedBusy", { dir: chosen }) : t("pages.backup.changed", { dir: chosen }));
          return { folders: [] };
        },
      }),
    [http, show, loadSnapshots, toast],
  );
  const pickerState = useSyncExternalStore(picker.subscribe, picker.state);

  useEffect(() => {
    let live = true;
    http.backupStatus().then(
      (v) => {
        if (live) show(v);
      },
      (err: unknown) => {
        if (live) setFailed(t("pages.backup.loadFailed", { reason: messageOf(err) }));
      },
    );
    loadSnapshots();
    return () => {
      live = false;
    };
  }, [http, show, loadSnapshots]);

  // 有一份在做：过一会儿再取一遍，直到做完
  useEffect(() => {
    if (!view || (!view.queued && !view.running && !view.verifying)) return;
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

  // 最近一次变了（谁做的都算）：快照列表也变了
  const seenFinished = useRef<{ at: string | undefined }>(undefined);
  useEffect(() => {
    if (!view) return;
    const at = view.last?.finishedAt;
    if (seenFinished.current && seenFinished.current.at !== at) loadSnapshots();
    seenFinished.current = { at };
  }, [view, loadSnapshots]);

  // 点过的做完了：弹一句结果
  useEffect(() => {
    if (!view) return;
    if (!view.queued && waitingBackup.current) {
      waitingBackup.current = false;
      if (view.last) toast(backupDoneText(view.last));
    }
    if (!view.verifying && waitingVerify.current) {
      waitingVerify.current = false;
      const verified = backupVerifyText(view);
      toast(verified.text);
    }
  }, [view, toast]);

  const text = view && backupText(view);
  const run = () => {
    setStarting(true);
    waitingBackup.current = true;
    http
      .backupRun()
      .then(show, (err: unknown) => {
        waitingBackup.current = false;
        toast(t("pages.backup.startFailed", { reason: messageOf(err) }));
      })
      .finally(() => setStarting(false));
  };
  const verify = () => {
    waitingVerify.current = true;
    http.backupVerify().then(show, (err: unknown) => {
      waitingVerify.current = false;
      toast(t("pages.backup.verifyStartFailed", { reason: messageOf(err) }));
    });
  };
  const open = (place: BackupPlace) => {
    http.backupOpen(place).then(
      (result) => toast(result.opened ? t("pages.backup.opened") : (result.error ?? t("pages.backup.openFailed", { reason: "" }))),
      (err: unknown) => toast(t("pages.backup.openFailed", { reason: messageOf(err) })),
    );
  };
  /** 改配置：成了换成新的状况；done 是成了之后说的那句 */
  const save = (body: BackupConfigBody, done: string, after?: () => void) => {
    setSaving(true);
    http
      .backupConfig(body)
      .then(
        (next) => {
          show(next);
          toast(done);
          after?.();
        },
        (err: unknown) => toast(t("pages.backup.saveFailed", { reason: messageOf(err) })),
      )
      .finally(() => setSaving(false));
  };

  if (!view || !text) return <div className="backup-page muted">{failed ?? t("pages.backup.loading")}</div>;

  const { syncDir, commands, retention, localDir } = view;
  const syncPath = syncDir.kind === "none" ? undefined : syncDir.dir;
  const shownTime = time ?? view.time;
  const verified = backupVerifyText(view);

  return (
    <div className="backup-page">
      <Section title={t("pages.backup.status")}>
        <div className="backup-lines">
          <div className={text.lastFailed ? "danger-text" : undefined}>{text.last}</div>
          <div>{text.next}</div>
          <div className="muted">{text.busy ?? t("state.backup.idle")}</div>
        </div>
      </Section>

      <Section title={t("pages.backup.where")}>
        <div className="backup-place" data-place="sync">
          <h4>{t("pages.backup.sync.title")}</h4>
          <p className="muted">{t("pages.backup.sync.intro")}</p>
          {syncPath !== undefined && <div className="backup-path">{syncPath}</div>}
          <div className={syncDir.kind === "unusable" ? "danger-text" : "muted"}>{text.syncDir}</div>
          <div className="backup-actions">
            <button type="button" className="btn" disabled={saving} onClick={() => void picker.openPicker()}>
              {syncPath === undefined ? t("pages.backup.sync.choose") : t("pages.backup.sync.change")}
            </button>
            {syncPath !== undefined && (
              <button type="button" className="btn ghost" disabled={saving} onClick={() => setClearing(true)}>
                {t("pages.backup.sync.clear")}
              </button>
            )}
            {syncDir.kind === "ready" && (
              <button type="button" className="btn ghost" onClick={() => open("sync")}>
                {t("pages.backup.open")}
              </button>
            )}
          </div>
          <p className="muted">{t("pages.backup.sync.changeNote")}</p>
        </div>
        <div className="backup-place" data-place="local">
          <h4>{t("pages.backup.local.title")}</h4>
          <div className="backup-path">{localDir}</div>
          <div className="muted">{t("pages.backup.local.note")}</div>
          <div className="backup-actions">
            <button type="button" className="btn ghost" onClick={() => open("local")}>
              {t("pages.backup.open")}
            </button>
          </div>
        </div>
      </Section>

      <Section title={t("pages.backup.when")}>
        <div className="backup-field">
          <span>{t("pages.backup.who")}</span>
          <Segmented<BackupStatusView["schedule"]>
            role="radio"
            label={t("pages.backup.who")}
            value={view.schedule}
            options={[
              { value: "internal", label: t("pages.backup.who.internal") },
              { value: "external", label: t("pages.backup.who.external") },
            ]}
            onChange={(schedule) => {
              if (schedule !== view.schedule && !saving) save({ schedule }, t("pages.backup.saved"));
            }}
          />
        </div>
        <div className="backup-field">
          <label htmlFor="backup-time">{t("pages.backup.time")}</label>
          <input id="backup-time" className="input" type="time" value={shownTime} disabled={view.schedule === "external"} onChange={(e) => setTime(e.target.value)} />
          {shownTime !== view.time && shownTime !== "" && (
            <button type="button" className="btn small" disabled={saving} onClick={() => save({ time: shownTime }, t("pages.backup.saved"), () => setTime(undefined))}>
              {t("pages.backup.timeSave")}
            </button>
          )}
        </div>
        {view.schedule === "external" ? (
          <>
            <p className="muted">{t("pages.backup.externalNote")}</p>
            <CommandLine command={commands.scheduled} />
          </>
        ) : (
          <p className="muted">{t("pages.backup.whenNote")}</p>
        )}
      </Section>

      <Section title={t("pages.backup.keep")}>
        <div className="muted">{t("state.backup.retention", { local: retention.local, daily: retention.syncDaily, weekly: retention.syncWeekly })}</div>
      </Section>

      <Section title={t("pages.backup.snapshots")}>
        {snapshotsFailed !== undefined && <div className="danger-text">{snapshotsFailed}</div>}
        {snapshots === undefined && snapshotsFailed === undefined && <div className="muted">{t("pages.backup.loading")}</div>}
        {snapshots && (
          <div className="backup-snapshot-groups">
            <SnapshotList title={t("pages.backup.snapshots.local")} place={snapshots.local} />
            {snapshots.sync && <SnapshotList title={t("pages.backup.snapshots.sync")} place={snapshots.sync} />}
          </div>
        )}
        <p className="muted">{t("pages.backup.snapshots.note")}</p>
      </Section>

      <Section title={t("pages.backup.actions")}>
        <div className="backup-actions">
          <button type="button" className="btn primary" disabled={starting || !text.canRun} onClick={run}>
            {starting || view.queued ? t("pages.backup.working") : t("pages.backup.now")}
          </button>
          <button type="button" className="btn" disabled={view.verifying} onClick={verify}>
            {view.verifying ? t("pages.backup.verifying") : t("pages.backup.verify")}
          </button>
          <button type="button" className="btn ghost" aria-expanded={restoreOpen} onClick={() => setRestoreOpen((v) => !v)}>
            {restoreOpen ? t("pages.backup.restoreHide") : t("pages.backup.restore")}
          </button>
        </div>
        <div className={verified.failed ? "danger-text backup-verify" : "muted backup-verify"}>{verified.text}</div>
        {restoreOpen && <RestoreGuide steps={commands.restore} />}
      </Section>

      {pickerState.picker && (
        <Sheet title={t("pages.backup.picker.title")} onClose={() => picker.closePicker()} center>
          <FolderPickerBody
            picker={pickerState.picker}
            folders={undefined}
            labels={{ here: t("pages.backup.picker.here"), busy: t("pages.backup.picker.checking"), paste: t("pages.backup.picker.paste") }}
            onBrowse={(path) => void picker.browse(path)}
            onUp={() => void picker.up()}
            onAuthorize={(path) => void picker.authorize(path)}
            onDraft={(draft) => picker.setDraft(draft)}
            onAuthorizeDraft={() => void picker.authorizeDraft()}
          />
        </Sheet>
      )}
      {asking && (
        <Sheet
          title={t("pages.backup.create.title")}
          onClose={() => {
            asking.answer(false);
            setAsking(undefined);
          }}
          center
        >
          <p className="backup-confirm-text">{t("pages.backup.create.body", { dir: asking.dir })}</p>
          <div className="backup-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                asking.answer(true);
                setAsking(undefined);
              }}
            >
              {t("pages.backup.create.yes")}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                asking.answer(false);
                setAsking(undefined);
              }}
            >
              {t("pages.backup.create.no")}
            </button>
          </div>
        </Sheet>
      )}
      {clearing && (
        <Sheet title={t("pages.backup.clear.title")} onClose={() => setClearing(false)} center>
          <p className="backup-confirm-text">{t("pages.backup.clear.body", { dir: syncPath ?? "" })}</p>
          <div className="backup-actions">
            <button
              type="button"
              className="btn danger"
              disabled={saving}
              onClick={() => {
                setClearing(false);
                save({ syncDir: null }, t("pages.backup.cleared"), loadSnapshots);
              }}
            >
              {t("pages.backup.clear.yes")}
            </button>
            <button type="button" className="btn ghost" onClick={() => setClearing(false)}>
              {t("pages.backup.cancel")}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
