// 设置 · 数据源（295 号票，issue 25 生活数据源）：外面的数据经数据源插件接进来，这一页一处列出全部（内核的页面，记忆页有链接过来）：
// - 每个数据源一块：名字和连接状态的小签（连着 / 没连 / 出错了 / 手动导入 / 插件没启用）、连的账号、一句话、上次同步（时间、新进来几条、
//   出错的原因）和共几条、两种用法的开关（按需查：二狗被问到时现查、不存；导入：定期或手动同步、整理成素材）、用到的敏感内容（对上记忆的
//   敏感类别：默认只记录、不用于推断）、认导入文件夹里哪种文件；插件画的设置那一块（dataSources 插槽：填 Key、地址、测试连接）；
//   按钮：立即同步、断开（确认框里选"留着已导入的"或"连已导入的一起删"，后者走彻底删除、不能恢复）；只靠导入文件夹的数据源是"删除已导入的"；
// - 导入文件夹：路径（复制、在电脑上打开）、现在检查、留在里面没导入的文件和原因、最近导入的。
// 297 号票：导入的东西不进素材的数据源（Google 日历：显示在日历里）在导入那一项下面写明去哪；数据源报的一句提示（"日历插件没启用：……"）
// 写在出错那一行的位置、不标红；它下面的几样（订阅的几个日历）由插件画的那一块列出。
// 299 号票：设备交来的（手机上的二狗 App）上次那一行写"手机交来"和数据源写的那一句（这次进来的是什么），导入的说法换成"App 交来时收下"。
// 300 号票：插件自己存储里的原始数据（手机的原始位置点、照片的时间地点）折起来的一节"原始数据"：有哪几天、各几条、整理过没有，
// 一天一个"清掉"（点两下才清：第一下变成"确定清掉？"）；清掉的再交来不再收、还没整理的那天清掉了摘要里就没有这些，写明。
// 307 号票：断开的确认框里写数据源报的那一句（Looki："存到本地的照片、日记、vlog 不删……"）；插件那一块要的数据（panel）原样交给插件。
// 306 号票：确认框按数据源说话（disconnectTexts）——"填过的密钥从这台电脑上删掉"只在真有密钥、"素材照样在"只在真进素材时说，
// 手机日历、通讯录、Google 联系人这种没密钥、不进素材的由数据源报的那一句说实际会删什么。出错了、内核每小时替它再试的（autoRetry）在出错那一行下面写"每小时自动再试一次，也可以重新填"。
// 每次打开、插件的状况或者词典的版本变了现取一次；有在同步的每 3 秒再取一次。列表、导入文件夹、确认框是纯渲染的组件
// （DataSourceList、ImportFolderBlock、DisconnectConfirm），测试在 Node 里直接渲染。
import { useEffect, useState } from "react";
import { copyText } from "../../app/debug-page.ts";
import { useStore } from "../../app/store.tsx";
import { type DataSourceSlot, usePlugins } from "../../plugins/api.ts";
import {
  type DataSourceActionBody,
  type DataSourceActionResult,
  type DataSourceConnection,
  type DataSourcesView,
  type DataSourceUsage,
  type DataSourceView,
  formatList,
  type ImportFolderView,
  t,
} from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { timeLabel } from "../../util/time.ts";

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 有在同步的多久再取一次 */
const POLL_MS = 3000;

/** 连接状态的小签 */
const CONNECTION_CHIP: Readonly<Record<DataSourceConnection, string>> = { connected: "chip chip-ok", not_connected: "chip", error: "chip chip-no", manual: "chip chip-quiet" };

/** 小签上写什么：插件没启用的先说这个 */
export function connectionText(source: DataSourceView): string {
  if (!source.available) return t("pages.dataSources.state.off");
  return t(`pages.dataSources.state.${source.connection}`);
}

/** 上次同步那一行：时间、新进来几条或者出错的原因；还没同步过；正在同步；后面接"共几条" */
export function syncLine(source: DataSourceView): string {
  const total = t("pages.dataSources.count", { count: source.count, n: source.count });
  if (source.syncing) return `${t("pages.dataSources.syncing")} · ${total}`;
  const last = source.lastSync;
  if (!last) return `${t("pages.dataSources.neverSynced")} · ${total}`;
  const when = timeLabel(last.at);
  const what =
    last.error !== undefined
      ? t("pages.dataSources.lastError", { when, error: last.error })
      : last.trigger === "file"
        ? last.summary !== undefined
          ? t("pages.dataSources.lastFileSummary", { when, file: last.file ?? "", summary: last.summary })
          : t("pages.dataSources.lastFile", { when, file: last.file ?? "", added: last.added ?? 0 })
        : last.trigger === "device"
          ? last.summary !== undefined
            ? t("pages.dataSources.lastDeviceSummary", { when, summary: last.summary })
            : t("pages.dataSources.lastDevice", { when, added: last.added ?? 0 })
          : last.summary !== undefined
            ? t("pages.dataSources.lastSyncSummary", { when, summary: last.summary })
            : t("pages.dataSources.lastSync", { when, added: last.added ?? 0 });
  return `${what} · ${total}`;
}

/** 一种用法下面的小字 */
function usageSub(source: DataSourceView, usage: DataSourceUsage): string {
  if (usage === "query") return t("pages.dataSources.usage.querySub");
  if (source.fromDevice) return t("pages.dataSources.usage.importDevice");
  if (source.destination !== undefined) {
    if (source.schedule) return t("pages.dataSources.usage.importScheduledTo", { schedule: source.schedule, destination: source.destination });
    // 301：只靠导入文件夹的（Google · 联系人）
    return t(source.connection === "manual" ? "pages.dataSources.usage.importManualTo" : "pages.dataSources.usage.importOnDemandTo", { destination: source.destination });
  }
  if (source.schedule) return t("pages.dataSources.usage.importScheduled", { schedule: source.schedule });
  return t(source.connection === "manual" ? "pages.dataSources.usage.importManual" : "pages.dataSources.usage.importOnDemand");
}

/** 敏感内容那一行：几类，各自是"只记录、不用于推断"还是"已打开推断" */
export function sensitiveLine(source: DataSourceView): string | undefined {
  if (source.sensitive.length === 0) return undefined;
  const locked = source.sensitive.filter((c) => !c.inferable).map((c) => c.title);
  const open = source.sensitive.filter((c) => c.inferable).map((c) => c.title);
  const parts = [...(locked.length > 0 ? [t("pages.dataSources.sensitiveLocked", { names: formatList(locked) })] : []), ...(open.length > 0 ? [t("pages.dataSources.sensitiveOpen", { names: formatList(open) })] : [])];
  return t("pages.dataSources.sensitive", { parts: parts.join(t("pages.dataSources.sensitiveSep")) });
}

/** 正在确认断开（或者删除只靠导入文件夹的数据源已导入的） */
export interface DisconnectConfirming {
  source: DataSourceView;
  purge: boolean;
}

/** 断开之后、同步之后说一句 */
export function doneText(source: DataSourceView, body: DataSourceActionBody, result: DataSourceActionResult): string {
  switch (body.action) {
    case "sync":
      if (result.error !== undefined) return t("pages.dataSources.done.syncFailed", { error: result.error });
      return result.added === undefined ? t("pages.dataSources.done.syncing") : t("pages.dataSources.done.synced", { added: result.added });
    case "disconnect": {
      const base = t(source.connection === "manual" ? "pages.dataSources.done.cleared" : "pages.dataSources.done.disconnected", { title: source.title });
      if (!result.purged) return base;
      const { events, materials, files } = result.purged;
      return `${base}${t("pages.dataSources.done.purged", { events, materials, files })}`;
    }
    case "usage":
      return t(body.on ? "pages.dataSources.done.usageOn" : "pages.dataSources.done.usageOff", { usage: t(`pages.dataSources.usage.${body.usage}`), title: source.title });
    case "configure":
      return t("pages.dataSources.done.configured", { title: source.title });
    case "clear_raw":
      return t("pages.dataSources.done.rawCleared", { count: result.cleared ?? 0, n: result.cleared ?? 0, title: source.raw?.title ?? "" });
    case "open":
      return result.opened ? t("pages.dataSources.done.opened", { title: source.title }) : (result.error ?? t("pages.dataSources.done.openFailed", { title: source.title }));
  }
}

export interface RawDaysProps {
  source: DataSourceView;
  busy: boolean;
  onClear(dates: string[]): void;
}

/** 原始数据那一节（300 号票，纯渲染）：折起来，打开是一天一行（日期、几条、还没整理的写明）和"清掉"，点两下才清 */
export function RawDays({ source, busy, onClear }: RawDaysProps) {
  const [armed, setArmed] = useState<string>();
  const raw = source.raw;
  if (!raw || raw.days.length === 0) return null;
  const total = raw.days.reduce((n, d) => n + d.count, 0);
  return (
    <details className="source-raw" data-raw={source.id}>
      <summary>{t("pages.dataSources.raw.summary", { title: raw.title, days: raw.days.length, total })}</summary>
      <span className="muted">{t("pages.dataSources.raw.hint")}</span>
      <ul className="source-raw-days">
        {raw.days.map((d) => (
          <li key={d.date}>
            <span>
              {t("pages.dataSources.raw.day", { date: d.date, count: d.count, n: d.count })}
              {!d.summarized && <small className="muted">{t("pages.dataSources.raw.notSummarized")}</small>}
            </span>
            <button
              type="button"
              className={`btn small ${armed === d.date ? "danger" : "ghost"}`}
              disabled={busy}
              onClick={() => {
                if (armed !== d.date) return setArmed(d.date);
                setArmed(undefined);
                onClear([d.date]);
              }}
            >
              {armed === d.date ? t("pages.dataSources.raw.confirm") : t("pages.dataSources.raw.clear")}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface DataSourceListProps {
  sources: readonly DataSourceView[];
  /** 正在处理的数据源 */
  busy: string | undefined;
  /** 插件画的设置那一块（按数据源 id；插件没在用的没有） */
  panel: (id: string) => DataSourceSlot | undefined;
  onView(view: DataSourcesView): void;
  onSync(source: DataSourceView): void;
  onUsage(source: DataSourceView, usage: DataSourceUsage, on: boolean): void;
  onDisconnect(source: DataSourceView): void;
  /** 清掉几天的原始数据（300 号票）；不给的不画那一节 */
  onClearRaw?(source: DataSourceView, dates: string[]): void;
}

/** 数据源的列表：一个数据源一块 */
export function DataSourceList({ sources, busy, panel, onView, onSync, onUsage, onDisconnect, onClearRaw }: DataSourceListProps) {
  if (sources.length === 0) return <div className="muted">{t("pages.dataSources.none")}</div>;
  return (
    <div className="source-list">
      {sources.map((s) => (
        <DataSourceRow key={s.id} source={s} busy={busy} panel={panel(s.id)} onView={onView} onSync={onSync} onUsage={onUsage} onDisconnect={onDisconnect} {...(onClearRaw ? { onClearRaw } : {})} />
      ))}
    </div>
  );
}

function DataSourceRow({ source: s, busy, panel, onView, onSync, onUsage, onDisconnect, onClearRaw }: Omit<DataSourceListProps, "sources" | "panel"> & { source: DataSourceView; panel: DataSourceSlot | undefined }) {
  const disabled = busy !== undefined;
  const sensitive = sensitiveLine(s);
  const canDisconnect = s.connection === "connected" || s.connection === "error";
  const canClear = s.connection === "manual" && s.count > 0;
  const Panel = s.available ? panel?.Panel : undefined;
  return (
    <div className={`source-row source-${s.available ? s.connection : "off"}`} data-source={s.id}>
      <div className="source-head">
        <span className="source-name">{s.title}</span>
        <span className={s.available ? CONNECTION_CHIP[s.connection] : "chip chip-no"}>{connectionText(s)}</span>
      </div>
      {s.account !== undefined && <div className="source-meta muted">{t("pages.dataSources.account", { account: s.account })}</div>}
      {s.summary && <div className="source-summary">{s.summary}</div>}
      {s.unavailable !== undefined && <div className="field-error">{t("pages.dataSources.unavailable", { reason: s.unavailable })}</div>}
      {s.problem !== undefined && <div className="field-error">{t("pages.dataSources.problem", { problem: s.problem })}</div>}
      {s.autoRetry && <div className="hint source-retry">{t(s.configurable ? "pages.dataSources.autoRetry" : "pages.dataSources.autoRetryPlain")}</div>}
      {s.note !== undefined && <div className="hint source-note">{s.note}</div>}
      <div className="source-meta muted">{syncLine(s)}</div>
      {s.usages.length > 0 && (
        <div className="source-usages">
          {s.usages.map(({ usage, on }) => (
            <label key={usage} className="menu-item source-usage">
              <span className="menu-text">
                {t(`pages.dataSources.usage.${usage}`)}
                <small>{usageSub(s, usage)}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="mem-setting-switch"
                aria-label={t("pages.dataSources.usage.label", { usage: t(`pages.dataSources.usage.${usage}`), title: s.title })}
                checked={on}
                disabled={disabled}
                onChange={(e) => onUsage(s, usage, e.currentTarget.checked)}
              />
            </label>
          ))}
        </div>
      )}
      <ul className="source-notes">
        {sensitive !== undefined && <li>{sensitive}</li>}
        {s.files.length > 0 && <li>{t("pages.dataSources.files", { names: formatList(s.files) })}</li>}
      </ul>
      {Panel && (
        <div className="source-panel">
          <Panel source={s} onView={onView} />
        </div>
      )}
      {onClearRaw && <RawDays source={s} busy={busy !== undefined} onClear={(dates) => onClearRaw(s, dates)} />}
      {(busy === s.id || s.canSync || canDisconnect || canClear) && (
        <div className="plugin-actions">
          {busy === s.id ? (
            <span className="muted">{t("pages.dataSources.working")}</span>
          ) : (
            <>
              {s.canSync && (
                <button type="button" className="btn primary small" disabled={disabled || s.syncing} onClick={() => onSync(s)}>
                  {t("pages.dataSources.action.sync")}
                </button>
              )}
              {canDisconnect && (
                <button type="button" className="btn ghost small" disabled={disabled} onClick={() => onDisconnect(s)}>
                  {t("pages.dataSources.action.disconnect")}
                </button>
              )}
              {canClear && (
                <button type="button" className="btn ghost small" disabled={disabled} onClick={() => onDisconnect(s)}>
                  {t("pages.dataSources.action.clear")}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface DisconnectConfirmProps {
  confirming: DisconnectConfirming;
  busy: boolean;
  onPurgeChange(purge: boolean): void;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * 断开确认框里按数据源说的几句（306 号票）：通用的"填过的密钥从这台电脑上删掉"只在真有密钥（hasSecrets）时说，"素材照样在""由它们整理出的
 * 素材和原文副本"只在导入的真进素材（toMaterials）时说，"「已导入」里它的文件"只在认导入文件夹里的文件时说；"不再同步、按需查"按它提供的用法说。
 * 手机日历、通讯录、Google 联系人这种没密钥、不进素材的，实际会删什么由数据源报的那一句（disconnectNote）说
 */
export function disconnectTexts(source: DataSourceView): { body: string; keep: string; purge: string } {
  const n = source.count;
  if (source.connection === "manual") {
    const files = source.files.length > 0;
    const body = source.toMaterials
      ? t(files ? "pages.dataSources.confirm.clearBody" : "pages.dataSources.confirm.clearBodyMaterials", { count: n, n })
      : t(files ? "pages.dataSources.confirm.clearBodyFiles" : "pages.dataSources.confirm.clearBodyPlain", { count: n, n });
    return { body, keep: "", purge: "" };
  }
  const offers = (usage: DataSourceUsage) => source.usages.some((u) => u.usage === usage);
  const stop = t(offers("query") ? (offers("import") ? "pages.dataSources.confirm.stop.both" : "pages.dataSources.confirm.stop.query") : "pages.dataSources.confirm.stop.import");
  return {
    body: t(source.hasSecrets ? "pages.dataSources.confirm.body" : "pages.dataSources.confirm.bodyPlain", { stop, count: n, n }),
    keep: t(source.toMaterials ? "pages.dataSources.confirm.keep" : "pages.dataSources.confirm.keepPlain"),
    purge: t(source.toMaterials ? "pages.dataSources.confirm.purge" : "pages.dataSources.confirm.purgePlain"),
  };
}

/** 断开的确认框：留着已导入的 / 连已导入的一起删（彻底删除、不能恢复）；只靠导入文件夹的数据源只有"删除已导入的" */
export function DisconnectConfirm({ confirming: c, busy, onPurgeChange, onCancel, onConfirm }: DisconnectConfirmProps) {
  const { source, purge } = c;
  const manual = source.connection === "manual";
  const texts = disconnectTexts(source);
  return (
    <Sheet title={t(manual ? "pages.dataSources.confirm.clearTitle" : "pages.dataSources.confirm.title", { title: source.title })} onClose={onCancel} center>
      <div className="modal-body plugin-confirm">
        {manual ? (
          <p>{texts.body}</p>
        ) : (
          <>
            <p>{texts.body}</p>
            <label className="check-row">
              <input type="radio" name="source-purge" checked={!purge} onChange={() => onPurgeChange(false)} />
              <span>{texts.keep}</span>
            </label>
            <label className="check-row">
              <input type="radio" name="source-purge" checked={purge} onChange={() => onPurgeChange(true)} />
              <span>{texts.purge}</span>
            </label>
          </>
        )}
        {source.disconnectNote !== undefined && <p className="source-keep-note">{source.disconnectNote}</p>}
        {(manual || purge) && <p className="plugin-final">{t("pages.dataSources.confirm.final")}</p>}
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("pages.dataSources.confirm.cancel")}
        </button>
        <button type="button" className={`btn ${manual || purge ? "danger" : "primary"}`} disabled={busy} onClick={onConfirm}>
          {t(manual ? "pages.dataSources.confirm.clearOk" : purge ? "pages.dataSources.confirm.purgeOk" : "pages.dataSources.confirm.ok")}
        </button>
      </div>
    </Sheet>
  );
}

export interface ImportFolderBlockProps {
  folder: ImportFolderView;
  busy: boolean;
  onCopy(): void;
  onOpen(): void;
  onScan(): void;
}

/** 导入文件夹：路径、复制、在电脑上打开、现在检查；没导入的和原因；最近导入的 */
export function ImportFolderBlock({ folder, busy, onCopy, onOpen, onScan }: ImportFolderBlockProps) {
  return (
    <div className="import-folder">
      <span className="muted">{t("pages.dataSources.folder.intro")}</span>
      <code className="import-path">{folder.path}</code>
      <div className="plugin-actions">
        <button type="button" className="btn ghost small" onClick={onCopy}>
          {t("pages.dataSources.folder.copy")}
        </button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={onOpen}>
          {t("pages.dataSources.folder.open")}
        </button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={onScan}>
          {t("pages.dataSources.folder.scan")}
        </button>
      </div>
      {folder.pending.length > 0 && (
        <div className="import-group">
          <div className="import-group-title">{t("pages.dataSources.folder.pending", { count: folder.pending.length })}</div>
          <ul className="source-notes">
            {folder.pending.map((p) => (
              <li key={p.name} data-problem={p.problem}>
                <span className="import-file">{p.name}</span>
                {t("pages.dataSources.folder.dash")}
                {p.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {folder.recent.length > 0 && (
        <div className="import-group">
          <div className="import-group-title">{t("pages.dataSources.folder.recent")}</div>
          <ul className="source-notes">
            {folder.recent.map((r) => (
              <li key={`${r.at}-${r.name}`}>{t("pages.dataSources.folder.imported", { name: r.name, source: r.sourceTitle, added: r.added, when: timeLabel(r.at) })}</li>
            ))}
          </ul>
        </div>
      )}
      <span className="muted import-scanned">{folder.scannedAt ? t("pages.dataSources.folder.scannedAt", { when: timeLabel(folder.scannedAt) }) : t("pages.dataSources.folder.notScanned")}</span>
    </div>
  );
}

/** 没做成的那一句 */
const errorText = (err: unknown) => t("pages.dataSources.failed", { reason: err instanceof Error ? err.message : String(err) });

export function DataSourcesPage() {
  const { http, ui } = useStore();
  const plugins = usePlugins();
  const revision = ui.locale?.revision;
  // 插件的状况变了（这台设备上或者别处停用、启用）：重取一次
  const statusKey = (ui.pluginStatus?.plugins ?? []).map((p) => `${p.name}:${p.state}`).join(",");
  const [view, setView] = useState<DataSourcesView>();
  const [loadFailed, setLoadFailed] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [folderBusy, setFolderBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [note, setNote] = useState<string>();
  const [confirming, setConfirming] = useState<DisconnectConfirming>();
  const syncing = view?.sources.some((s) => s.syncing) ?? false;

  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- statusKey、revision 只用来在状况、语言变了时重取
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      http.dataSources().then(
        (next) => {
          if (cancelled) return;
          setView(next);
          setLoadFailed(undefined);
        },
        (err: unknown) => {
          if (!cancelled) setLoadFailed(err instanceof Error ? err.message : String(err));
        },
      );
    void load();
    // 有在同步的：隔一会儿再取，同步完了就停
    const timer = syncing ? setInterval(() => void load(), POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [http, statusKey, revision, syncing]);

  const run = (source: DataSourceView, body: DataSourceActionBody) => {
    setConfirming(undefined);
    setBusy(source.id);
    setFailed(undefined);
    setNote(undefined);
    http
      .dataSourceAction(source.id, body)
      .then(
        (result) => {
          setView(result.view);
          setNote(doneText(source, body, result));
        },
        (err: unknown) => setFailed(errorText(err)),
      )
      .finally(() => setBusy(undefined));
  };

  const folderAction = (action: "scan" | "open") => {
    setFolderBusy(true);
    setFailed(undefined);
    setNote(undefined);
    http
      .importFolderAction({ action })
      .then(
        (result) => {
          setView(result.view);
          if (action === "open") setNote(result.opened ? t("pages.dataSources.folder.opened") : (result.error ?? t("pages.dataSources.folder.openFailed")));
          else setNote(t("pages.dataSources.folder.scanned"));
        },
        (err: unknown) => setFailed(errorText(err)),
      )
      .finally(() => setFolderBusy(false));
  };

  const copyPath = () => {
    if (!view) return;
    void copyText(view.folder.path).then((ok) => setNote(t(ok ? "pages.dataSources.folder.copied" : "pages.dataSources.folder.copyFailed")));
  };

  const onConfirm = () => {
    if (!confirming) return;
    const { source, purge } = confirming;
    run(source, { action: "disconnect", purge: source.connection === "manual" ? true : purge, idempotencyKey: newKey() });
  };

  return (
    <div className="data-sources-page">
      <Section title={t("pages.dataSources.listTitle")}>
        <span className="muted">{t("pages.dataSources.intro")}</span>
        {!view && !loadFailed && <div className="muted">{t("pages.dataSources.loading")}</div>}
        {loadFailed && (
          <div className="field-error" role="alert">
            {t("pages.dataSources.loadFailed", { reason: loadFailed })}
          </div>
        )}
        {view && (
          <DataSourceList
            sources={view.sources}
            busy={busy}
            panel={(id) => plugins.get("dataSources", id)}
            onView={setView}
            onSync={(s) => run(s, { action: "sync", idempotencyKey: newKey() })}
            onUsage={(s, usage, on) => run(s, { action: "usage", usage, on, idempotencyKey: newKey() })}
            onDisconnect={(s) => setConfirming({ source: s, purge: false })}
            onClearRaw={(s, dates) => run(s, { action: "clear_raw", dates, idempotencyKey: newKey() })}
          />
        )}
        {failed && (
          <div className="field-error" role="alert">
            {failed}
          </div>
        )}
        {note && (
          <div className="hint" role="status">
            {note}
          </div>
        )}
      </Section>
      {view && (
        <Section title={t("pages.dataSources.folder.title")}>
          <ImportFolderBlock folder={view.folder} busy={folderBusy} onCopy={copyPath} onOpen={() => folderAction("open")} onScan={() => folderAction("scan")} />
        </Section>
      )}
      {confirming && <DisconnectConfirm confirming={confirming} busy={busy !== undefined} onPurgeChange={(purge) => setConfirming((c) => (c ? { ...c, purge } : c))} onCancel={() => setConfirming(undefined)} onConfirm={onConfirm} />}
    </div>
  );
}
