// 设置 · 数据源（生活数据源）：外面的数据经数据源插件接进来，这一页一处列出全部（内核的页面，记忆页有链接过来）：
// - 每个数据源一块：名字和连接状态的小签（连着 / 没连 / 出错了 / 手动导入 / 插件没启用）、连的账号、一句话、上次同步（时间、新进来几条、
//   出错的原因）和共几条、两种用法的开关（按需查：二狗被问到时现查、不存；导入：定期或手动同步、整理成素材）、用到的敏感内容（对上记忆的
//   敏感类别：默认只记录、不用于推断）、认导入文件夹里哪种文件；插件画的设置那一块（dataSources 插槽：填 Key、地址、测试连接）；
//   按钮：立即同步、断开（确认框里选"留着已导入的"或"连已导入的一起删"，后者走彻底删除、不能恢复）；只靠导入文件夹的数据源是"删除已导入的"；
// - 导入文件夹：路径（复制、在电脑上打开）、现在检查、留在里面没导入的文件和原因、最近导入的。
// 导入的东西不进素材的数据源（Google 日历：显示在日历里）在导入那一项下面写明去哪；数据源报的一句提示（"日历插件没启用：……"）
// 写在出错那一行的位置、不标红；它下面的几样（订阅的几个日历）由插件画的那一块列出。
// 设备交来的（手机上的二狗 App）上次那一行写"手机交来"和数据源写的那一句（这次进来的是什么），导入的说法换成"App 交来时收下"。
// 插件自己存储里的原始数据（手机的原始位置点、照片的时间地点）折起来的一节"原始数据"：有哪几天、各几条、整理过没有，
// 一天一个"清掉"（点两下才清：第一下变成"确定清掉？"）；清掉的再交来不再收、还没整理的那天清掉了摘要里就没有这些，写明。
// 断开的确认框里写数据源报的那一句（Looki："存到本地的照片、日记、vlog 不删……"）；插件那一块要的数据（panel）原样交给插件。
// 确认框按数据源说话（disconnectTexts）——"填过的密钥从这台电脑上删掉"只在真有密钥、"素材照样在"只在真进素材时说，
// 手机日历、通讯录、Google 联系人这种没密钥、不进素材的由数据源报的那一句说实际会删什么。出错了、内核每小时替它再试的（autoRetry）在出错那一行下面写"每小时自动再试一次，也可以重新填"。
// 每次打开、插件的状况或者词典的版本变了现取一次；有在同步的每 3 秒再取一次（useDataSourcesView）。
// "从目录进入数据源页面，显示整体有哪些数据源。点击每一个数据源卡片，跳转到一页单独全屏展示详细配置选项细节"：分成两层——
// - 这一页是一级（#/more/data-sources）：卡片总览，按插件分组。每张卡只有名字、一句话、状态（已连接 / 未连接 / 要授权 / 出错 / 插件没启用）、账号、已获取几条、
//   上次同步，**没有任何输入框和操作按钮**，整张卡是一个按钮；最后一张卡是共用的导入文件夹（没导入的文件数写在小签上）；
// - 点卡片去二级（#/more/data-sources/<id>，DataSourceDetail.tsx）：单独占满内容区，状态、设置（上面说的那些全挪过去）、数据（已获取的、现在能查到的）。
// 这个文件留一级页和两层共用的：状态的说法、上次同步那一行、确认框、原始数据、导入文件夹（纯渲染，测试在 Node 里直接渲染）。
import { useEffect, useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { IMPORT_FOLDER_ITEM } from "../../app/route-hash.ts";
import { useStore } from "../../app/store.tsx";
import {
  type DataSourceActionBody,
  type DataSourceActionResult,
  type DataSourceConnection,
  type DataSourceItemView,
  type DataSourcesView,
  type DataSourceUsage,
  type DataSourceView,
  formatList,
  type ImportFolderView,
  t,
} from "../../state/index.ts";
import { Sheet } from "../../ui/common.tsx";
import { timeLabel } from "../../util/time.ts";

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
export function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 有在同步的多久再取一次 */
const POLL_MS = 3000;

/** 连接状态的小签 */
const CONNECTION_CHIP: Readonly<Record<DataSourceConnection, string>> = { connected: "chip chip-ok", not_connected: "chip", error: "chip chip-no", manual: "chip chip-quiet" };

/** 小签上写什么：插件没启用的先说这个，要去授权、重新填的说"要授权" */
export function connectionText(source: DataSourceView): string {
  if (!source.available) return t("pages.dataSources.state.off");
  if (source.needsAuth) return t("pages.dataSources.state.needsAuth");
  return t(`pages.dataSources.state.${source.connection}`);
}

/** 小签的样子 */
export function connectionChip(source: DataSourceView): string {
  if (!source.available) return "chip chip-no";
  if (source.needsAuth) return "chip chip-high";
  return CONNECTION_CHIP[source.connection];
}

/** 卡片上"上次同步"那一小段：只写时间、出没出错，原因在详情里 */
export function cardSyncText(source: DataSourceView): string {
  if (source.syncing) return t("pages.dataSources.syncing");
  const last = source.lastSync;
  if (!last) return t("pages.dataSources.neverSynced");
  const when = timeLabel(last.at);
  return t(last.error === undefined ? "pages.dataSources.card.last" : "pages.dataSources.card.lastFailed", { when });
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
export function usageSub(source: DataSourceView, usage: DataSourceUsage): string {
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

/** 正在确认断开（或者删除只靠导入文件夹的数据源已导入的）；item 是只断开它下面的这一样（Gmail 的一个账号） */
export interface DisconnectConfirming {
  source: DataSourceView;
  purge: boolean;
  item?: DataSourceItemView | undefined;
}

/** 断开之后、同步之后说一句 */
export function doneText(source: DataSourceView, body: DataSourceActionBody, result: DataSourceActionResult): string {
  switch (body.action) {
    case "sync":
      if (result.error !== undefined) return t("pages.dataSources.done.syncFailed", { error: result.error });
      return result.added === undefined ? t("pages.dataSources.done.syncing") : t("pages.dataSources.done.synced", { added: result.added });
    case "disconnect": {
      // 只断开一样：说断开的是那一样
      const item = body.item === undefined ? undefined : source.items?.find((one) => one.id === body.item);
      const base = t(source.connection === "manual" ? "pages.dataSources.done.cleared" : "pages.dataSources.done.disconnected", { title: item?.title ?? source.title });
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

/** 原始数据那一节（纯渲染）：折起来，打开是一天一行（日期、几条、还没整理的写明）和"清掉"，点两下才清 */
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

export interface DisconnectConfirmProps {
  confirming: DisconnectConfirming;
  busy: boolean;
  onPurgeChange(purge: boolean): void;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * 断开确认框里按数据源说的几句：通用的"填过的密钥从这台电脑上删掉"只在真有密钥（hasSecrets）时说，"素材照样在""由它们整理出的
 * 素材和原文副本"只在导入的真进素材（toMaterials）时说，"「已导入」里它的文件"只在认导入文件夹里的文件时说；"不再同步、按需查"按它提供的用法说。
 * 手机日历、通讯录、Google 联系人这种没密钥、不进素材的，实际会删什么由数据源报的那一句（disconnectNote）说。
 * 只断开它下面的一样（Gmail 的一个账号）：条数是那一样的，写明别的账号不受影响
 */
export function disconnectTexts(source: DataSourceView, item?: DataSourceItemView): { body: string; keep: string; purge: string } {
  const n = item === undefined ? source.count : (item.count ?? 0);
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
    body: t(item !== undefined ? "pages.dataSources.confirm.itemBody" : source.hasSecrets ? "pages.dataSources.confirm.body" : "pages.dataSources.confirm.bodyPlain", { stop, count: n, n }),
    keep: t(source.toMaterials ? "pages.dataSources.confirm.keep" : "pages.dataSources.confirm.keepPlain"),
    purge: t(source.toMaterials ? "pages.dataSources.confirm.purge" : "pages.dataSources.confirm.purgePlain"),
  };
}

/** 断开的确认框：留着已导入的 / 连已导入的一起删（彻底删除、不能恢复）；只靠导入文件夹的数据源只有"删除已导入的" */
export function DisconnectConfirm({ confirming: c, busy, onPurgeChange, onCancel, onConfirm }: DisconnectConfirmProps) {
  const { source, purge, item } = c;
  const manual = source.connection === "manual";
  const texts = disconnectTexts(source, item);
  return (
    <Sheet title={t(manual ? "pages.dataSources.confirm.clearTitle" : "pages.dataSources.confirm.title", { title: item?.title ?? source.title })} onClose={onCancel} center>
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
        {item === undefined && source.disconnectNote !== undefined && <p className="source-keep-note">{source.disconnectNote}</p>}
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

/** 一个插件的几个数据源 */
export interface DataSourceGroup {
  plugin: string;
  title: string;
  sources: DataSourceView[];
}

/** 插件的标题写成"数据源-Google"（设置 · 插件里一眼分得清）；这一页全是数据源，分组标题不重复前缀 */
function groupTitle(pluginTitle: string): string {
  const prefix = t("pages.dataSources.pluginPrefix");
  return pluginTitle.startsWith(prefix) ? pluginTitle.slice(prefix.length) : pluginTitle;
}

/** 按插件分组：组的先后、组里的先后都照守护进程给的 */
export function groupByPlugin(sources: readonly DataSourceView[]): DataSourceGroup[] {
  const groups = new Map<string, DataSourceGroup>();
  for (const source of sources) {
    const group = groups.get(source.plugin);
    if (group) group.sources.push(source);
    else groups.set(source.plugin, { plugin: source.plugin, title: groupTitle(source.pluginTitle), sources: [source] });
  }
  return [...groups.values()];
}

/** 一张卡：整张是一个按钮，点了去详情；只有名字、一句话、状态、账号、已获取几条、上次同步 */
function DataSourceCard({ source: s, onOpen }: { source: DataSourceView; onOpen(id: string): void }) {
  return (
    <button type="button" className="ds-card" data-source={s.id} onClick={() => onOpen(s.id)}>
      <span className="ds-card-head">
        <span className="ds-card-name">{s.title}</span>
        <span className={connectionChip(s)}>{connectionText(s)}</span>
      </span>
      {s.summary !== "" && <span className="ds-card-summary">{s.summary}</span>}
      <span className="ds-card-meta">
        {s.account !== undefined && <span className="ds-card-account">{s.account}</span>}
        <span>{t("pages.dataSources.card.fetched", { count: s.count, n: s.count })}</span>
        <span>{cardSyncText(s)}</span>
      </span>
    </button>
  );
}

export interface DataSourceCardsProps {
  sources: readonly DataSourceView[];
  folder: ImportFolderView;
  onOpen(id: string): void;
}

/** 一级页的卡片（纯渲染）：按插件分组，最后是共用的导入文件夹；没有输入框、没有操作按钮 */
export function DataSourceCards({ sources, folder, onOpen }: DataSourceCardsProps) {
  const pending = folder.pending.length;
  return (
    <div className="ds-groups">
      {sources.length === 0 && <div className="muted">{t("pages.dataSources.none")}</div>}
      {groupByPlugin(sources).map((group) => (
        <section key={group.plugin} className="ds-group" aria-label={group.title} data-plugin={group.plugin}>
          <h3 className="ds-group-title">{group.title}</h3>
          <div className="ds-cards">
            {group.sources.map((s) => (
              <DataSourceCard key={s.id} source={s} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ))}
      <section className="ds-group" aria-label={t("pages.dataSources.folder.title")}>
        <h3 className="ds-group-title">{t("pages.dataSources.card.shared")}</h3>
        <div className="ds-cards">
          <button type="button" className="ds-card" data-source={IMPORT_FOLDER_ITEM} onClick={() => onOpen(IMPORT_FOLDER_ITEM)}>
            <span className="ds-card-head">
              <span className="ds-card-name">{t("pages.dataSources.folder.title")}</span>
              {pending > 0 && <span className="chip chip-high">{t("pages.dataSources.card.pending", { count: pending, n: pending })}</span>}
            </span>
            <span className="ds-card-summary">{t("pages.dataSources.card.folderSummary")}</span>
            <span className="ds-card-meta">
              <span>{folder.scannedAt ? t("pages.dataSources.folder.scannedAt", { when: timeLabel(folder.scannedAt) }) : t("pages.dataSources.folder.notScanned")}</span>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}

/** 现取一整页：每次打开、插件的状况或者词典的版本变了取一次；有在同步的每隔一会儿再取（两层都用它） */
export function useDataSourcesView() {
  const { http, ui } = useStore();
  const revision = ui.locale?.revision;
  // 插件的状况变了（这台设备上或者别处停用、启用）：重取一次
  const statusKey = (ui.pluginStatus?.plugins ?? []).map((p) => `${p.name}:${p.state}`).join(",");
  const [view, setView] = useState<DataSourcesView>();
  const [loadFailed, setLoadFailed] = useState<string>();
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

  return { view, setView, loadFailed };
}

/** 一级页：卡片总览 */
export function DataSourcesPage({ navigate }: { navigate: Navigate }) {
  const { view, loadFailed } = useDataSourcesView();
  return (
    <div className="data-sources-page">
      <span className="muted">{t("pages.dataSources.intro")}</span>
      {!view && !loadFailed && <div className="muted">{t("pages.dataSources.loading")}</div>}
      {loadFailed && (
        <div className="field-error" role="alert">
          {t("pages.dataSources.loadFailed", { reason: loadFailed })}
        </div>
      )}
      {view && <DataSourceCards sources={view.sources} folder={view.folder} onOpen={(id) => navigate({ tab: "more", page: "data-sources", item: id })} />}
    </div>
  );
}
