// Looki 的"存一份到本地"那一块（307 号票）：设置 · 数据源里 Looki 下面、填 Key 那一块的后面（同一个 dataSources 插槽）。
// 数据是守护进程报在数据源上的 panel（协议包 looki.ts 的 LookiArchiveView），改设置、补存经填设置（values.archive）交给守护进程：
// - 开关"存一份到本地"（默认开）；位置（默认「文档」下的 Looki，能改：完整路径，空着是默认位置）、"打开文件夹"（守护进程在电脑上打开，
//   和导入文件夹同一个做法）；
// - 存哪几类：照片、AI 日记、vlog 默认存，原始视频片段默认不存；
// - 已存多少（照片几张、视频几段、日记几篇、vlog 几个，共多大、几天）、上次存的时间；正在存哪一天、限速了在等；停下了的原因、
//   没存齐的 / 试了几次都没存下来的几个时刻和"现在接着存"；上一次没做成的原因；
// - 把以前的也存下来：从哪天到哪天（默认最近 30 天到昨天），开始补存、停下、接着补，补的进度；
// - 几行说明：怎么分文件夹、不进记忆不进备份、断开不删这些文件、改位置不搬。
// 正在存、正在补的时候每 3 秒重取一次整页（数据源页自己只在"正在同步"时重取）。
// 组件本身是纯渲染（LookiArchiveBlock 不碰 HTTP，测试在 Node 里直接渲染）。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type DataSourcesView, type DataSourceView, isLookiArchiveView, LOOKI_ARCHIVE_KINDS, LOOKI_BACKFILL_DEFAULT_DAYS, type LookiArchiveView, localDate, sizeLabel, t } from "../../state/index.ts";
import { timeLabel } from "../../util/time.ts";

/** 正在存、正在补时多久重取一次 */
const POLL_MS = 3000;

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** YYYY-MM-DD 加几天 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`;
}

/** 补存默认的范围：最近 30 天到昨天 */
export function defaultRange(today: string): { from: string; to: string } {
  return { from: shiftDate(today, -LOOKI_BACKFILL_DEFAULT_DAYS), to: shiftDate(today, -1) };
}

/** 数据源上报的那一块（认不出没有） */
export function archiveOf(source: DataSourceView): LookiArchiveView | undefined {
  return isLookiArchiveView(source.panel) ? source.panel : undefined;
}

/** 已存那一行：照片几张、视频几段、日记几篇、vlog 几个，共多大（几天）；还没存过 */
export function savedLine(a: LookiArchiveView): string {
  const s = a.saved;
  const parts = [
    ...(s.photos > 0 ? [t("ui.plugins.looki.archive.photos", { count: s.photos, n: s.photos })] : []),
    ...(s.clips > 0 ? [t("ui.plugins.looki.archive.clips", { count: s.clips, n: s.clips })] : []),
    ...(s.journals > 0 ? [t("ui.plugins.looki.archive.journals", { count: s.journals, n: s.journals })] : []),
    ...(s.vlogs > 0 ? [t("ui.plugins.looki.archive.vlogs", { count: s.vlogs, n: s.vlogs })] : []),
  ];
  if (parts.length === 0) return t("ui.plugins.looki.archive.savedNone");
  const line = t("ui.plugins.looki.archive.saved", { what: parts.join(t("ui.plugins.looki.archive.sep")), size: sizeLabel(s.bytes), count: s.days, n: s.days });
  return a.lastSavedAt === undefined ? line : `${line} · ${t("ui.plugins.looki.archive.lastSaved", { when: timeLabel(a.lastSavedAt) })}`;
}

/** 正在存那一行：正在存 / 补存 / 接着存哪一天的，限速了在等 */
export function workingLine(a: LookiArchiveView): string | undefined {
  const w = a.working;
  if (!w) return undefined;
  const what = w.day === undefined ? t("ui.plugins.looki.archive.working.start") : t(`ui.plugins.looki.archive.working.${w.kind}`, { day: w.day.slice(5) });
  return w.waiting ? `${what} · ${t("ui.plugins.looki.archive.waiting")}` : what;
}

/** 补存那一行（没有补过、补完了不再显示进度时没有） */
export function backfillLine(a: LookiArchiveView): string | undefined {
  const b = a.backfill;
  if (!b) return undefined;
  const params = { day: (b.next ?? b.from).slice(5), done: b.doneDays, total: b.totalDays, files: b.files, from: b.from, to: b.to };
  return t(`ui.plugins.looki.archive.backfill.${b.state}`, params);
}

export interface LookiArchiveBlockProps {
  archive: LookiArchiveView;
  busy: boolean;
  /** 正在改位置：输入框里的字 */
  folderText: string | undefined;
  range: { from: string; to: string };
  /** 刚才那一下的结果（打开文件夹、没做成） */
  result: { ok: boolean; text: string } | undefined;
  onSettings(values: Record<string, string>): void;
  onFolderText(text: string | undefined): void;
  onRange(range: { from: string; to: string }): void;
  onOpen(): void;
  onBackfill(): void;
  onStop(): void;
  onResume(): void;
  onRetry(): void;
}

/** 纯渲染的那一块 */
export function LookiArchiveBlock({ archive: a, busy, folderText, range, result, onSettings, onFolderText, onRange, onOpen, onBackfill, onStop, onResume, onRetry }: LookiArchiveBlockProps) {
  const working = workingLine(a);
  const backfill = backfillLine(a);
  const running = a.backfill?.state === "running";
  const resumable = a.backfill !== undefined && a.backfill.next !== undefined && !running;
  const isDefault = a.folder !== "" && a.folder === a.defaultFolder;
  return (
    <div className="looki-archive" data-on={a.on ? "true" : "false"}>
      <div className="looki-title">{t("ui.plugins.looki.archive.title")}</div>
      <label className="menu-item source-usage">
        <span className="menu-text">
          {t("ui.plugins.looki.archive.switch")}
          <small>{t("ui.plugins.looki.archive.switchSub")}</small>
        </span>
        <input type="checkbox" role="switch" className="mem-setting-switch" aria-label={t("ui.plugins.looki.archive.switch")} checked={a.on} disabled={busy} onChange={(e) => onSettings({ on: String(e.currentTarget.checked) })} />
      </label>

      <div className="looki-archive-folder">
        <span className="muted">
          {t("ui.plugins.looki.archive.folder")}
          {isDefault && <span className="chip chip-quiet">{t("ui.plugins.looki.archive.default")}</span>}
        </span>
        <code className="import-path">{a.folder === "" ? t("ui.plugins.looki.archive.noFolder") : a.folder}</code>
        {folderText === undefined ? (
          <div className="plugin-actions">
            <button type="button" className="btn ghost small" disabled={busy || a.folder === ""} onClick={onOpen}>
              {t("ui.plugins.looki.archive.open")}
            </button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => onFolderText(isDefault ? "" : a.folder)}>
              {t("ui.plugins.looki.archive.change")}
            </button>
          </div>
        ) : (
          <>
            <label className="field">
              <span>{t("ui.plugins.looki.archive.folderLabel")}</span>
              <input type="text" spellCheck={false} value={folderText} placeholder={a.defaultFolder || t("ui.plugins.looki.archive.folderPlaceholder")} disabled={busy} onChange={(e) => onFolderText(e.currentTarget.value)} />
            </label>
            <div className="plugin-actions">
              <button type="button" className="btn primary small" disabled={busy} onClick={() => onSettings({ folder: folderText })}>
                {t("ui.plugins.looki.archive.saveFolder")}
              </button>
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => onFolderText(undefined)}>
                {t("ui.plugins.looki.archive.cancel")}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="looki-archive-kinds" role="group" aria-label={t("ui.plugins.looki.archive.kinds")}>
        <div className="looki-subtitle">{t("ui.plugins.looki.archive.kinds")}</div>
        {LOOKI_ARCHIVE_KINDS.map((k) => (
          <label key={k} className="check-row">
            <input type="checkbox" checked={a.kinds[k]} disabled={busy || !a.on} onChange={(e) => onSettings({ [k]: String(e.currentTarget.checked) })} />
            <span>
              {t(`ui.plugins.looki.archive.kind.${k}`)}
              <small className="muted">{t(`ui.plugins.looki.archive.kind.${k}Sub`)}</small>
            </span>
          </label>
        ))}
      </div>

      <div className="source-meta muted looki-saved">{savedLine(a)}</div>
      {working !== undefined && (
        <div className="hint" role="status">
          {working}
        </div>
      )}
      {a.problem !== undefined && <div className="field-error">{t("ui.plugins.looki.archive.problem", { problem: a.problem })}</div>}
      {a.pending > 0 && <div className="source-meta muted">{t("ui.plugins.looki.archive.pending", { count: a.pending, n: a.pending })}</div>}
      {a.failed > 0 && <div className="source-meta muted">{t("ui.plugins.looki.archive.failed", { count: a.failed, n: a.failed })}</div>}
      {(a.problem !== undefined || a.pending > 0 || a.failed > 0) && working === undefined && (
        <div className="plugin-actions">
          <button type="button" className="btn ghost small" disabled={busy || !a.on} onClick={onRetry}>
            {t("ui.plugins.looki.archive.retry")}
          </button>
        </div>
      )}
      {a.refused !== undefined && <div className="field-error">{a.refused}</div>}
      {result && (
        <div className={result.ok ? "hint" : "field-error"} role="status">
          {result.text}
        </div>
      )}

      <div className="looki-backfill">
        <div className="looki-subtitle">{t("ui.plugins.looki.archive.backfill.title")}</div>
        {backfill !== undefined && <div className="source-meta muted">{backfill}</div>}
        {running ? (
          <div className="plugin-actions">
            <button type="button" className="btn ghost small" disabled={busy} onClick={onStop}>
              {t("ui.plugins.looki.archive.backfill.stop")}
            </button>
          </div>
        ) : (
          <>
            {resumable && (
              <div className="plugin-actions">
                <button type="button" className="btn primary small" disabled={busy || !a.on} onClick={onResume}>
                  {t("ui.plugins.looki.archive.backfill.resume")}
                </button>
              </div>
            )}
            <div className="looki-range">
              <label className="field">
                <span>{t("ui.plugins.looki.archive.backfill.from")}</span>
                <input type="date" value={range.from} max={range.to} disabled={busy || !a.on} onChange={(e) => onRange({ ...range, from: e.currentTarget.value })} />
              </label>
              <label className="field">
                <span>{t("ui.plugins.looki.archive.backfill.to")}</span>
                <input type="date" value={range.to} min={range.from} disabled={busy || !a.on} onChange={(e) => onRange({ ...range, to: e.currentTarget.value })} />
              </label>
            </div>
            <div className="plugin-actions">
              <button type="button" className={`btn ${resumable ? "ghost" : "primary"} small`} disabled={busy || !a.on || range.from === "" || range.to === ""} onClick={onBackfill}>
                {t("ui.plugins.looki.archive.backfill.start")}
              </button>
            </div>
            <span className="muted">{t("ui.plugins.looki.archive.backfill.hint", { days: LOOKI_BACKFILL_DEFAULT_DAYS })}</span>
          </>
        )}
      </div>

      <ul className="source-notes">
        <li>{t("ui.plugins.looki.archive.note.layout")}</li>
        <li>{t("ui.plugins.looki.archive.note.keep")}</li>
        <li>{t("ui.plugins.looki.archive.note.move")}</li>
      </ul>
    </div>
  );
}

/** 插槽里的那一块（跟在填 Key 那一块后面）：改设置、打开文件夹、补存都经守护进程 */
export function LookiArchive({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const archive = archiveOf(source);
  const [busy, setBusy] = useState(false);
  const [folderText, setFolderText] = useState<string>();
  const [range, setRange] = useState(() => defaultRange(localDate(new Date())));
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const active = archive?.working !== undefined || archive?.backfill?.state === "running";

  // 正在存、正在补：隔一会儿重取一次整页，做完了就停
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setInterval(() => {
      http.dataSources().then(
        (next) => {
          if (!cancelled) onView(next);
        },
        () => {},
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, http, onView]);

  if (!archive) return null;

  const send = (values: Record<string, string>, after?: (next: LookiArchiveView | undefined) => void) => {
    setBusy(true);
    setResult(undefined);
    http
      .dataSourceAction(source.id, { action: "configure", values, idempotencyKey: newKey() })
      .then(
        (res) => {
          onView(res.view);
          const mine = res.view.sources.find((s) => s.id === source.id);
          after?.(mine ? archiveOf(mine) : undefined);
        },
        (err: unknown) => setResult({ ok: false, text: t("ui.plugins.looki.archive.failedAction", { reason: err instanceof Error ? err.message : String(err) }) }),
      )
      .finally(() => setBusy(false));
  };

  const open = () => {
    setBusy(true);
    setResult(undefined);
    http
      .dataSourceAction(source.id, { action: "open", idempotencyKey: newKey() })
      .then(
        (res) => {
          onView(res.view);
          setResult(res.opened ? { ok: true, text: t("ui.plugins.looki.archive.opened") } : { ok: false, text: res.error ?? t("ui.plugins.looki.archive.openFailed") });
        },
        (err: unknown) => setResult({ ok: false, text: t("ui.plugins.looki.archive.failedAction", { reason: err instanceof Error ? err.message : String(err) }) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <LookiArchiveBlock
      archive={archive}
      busy={busy}
      folderText={folderText}
      range={range}
      result={result}
      onSettings={(values) =>
        // 改位置：做成了收起输入框；没做成（写不进去、不是完整路径）留着，原因在下面
        send({ archive: "settings", ...values }, values.folder === undefined ? undefined : (next) => (next?.refused === undefined ? setFolderText(undefined) : undefined))
      }
      onFolderText={setFolderText}
      onRange={setRange}
      onOpen={open}
      onBackfill={() => send({ archive: "backfill", from: range.from, to: range.to })}
      onStop={() => send({ archive: "stop" })}
      onResume={() => send({ archive: "resume" })}
      onRetry={() => send({ archive: "retry" })}
    />
  );
}
