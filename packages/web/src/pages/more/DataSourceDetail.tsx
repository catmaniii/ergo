// 数据源详情（343 号票，用户 2026-10-31："点击每一个数据源卡片，跳转到一页单独全屏展示详细配置选项细节，也要支持显示已经获取的数据或者能在线查看当前能获取到的数据"）：
// #/more/data-sources/<id>。单独占满内容区（宽屏不留设置的左栏，MorePage 在最前面接走），标题栏有返回，地址里带着 id、刷新后还在这一页；
// id 不存在时写一句、给个回去的按钮。分三块（窄屏纵向排，宽屏两栏：左边状态和设置，右边数据）：
// - 状态：连接状态的小签、账号、一句话、问题（插件没启用、出错、每小时再试、提示）、上次同步和共几条、立即同步；
// - 设置：原来数据源页上的全部配置都挪过来——两种用法的开关（定期时间写在导入下面）、敏感类别、认的文件、插件画的那一块（dataSources 插槽）、
//   原始数据（按天清）、导入文件夹（认文件的数据源才有）、断开（确认框）/ 删除已导入的；
// - 数据：两个标签，这个数据源没有的那个不显示——
//   已获取的（POST …/stored）：已经进到二狗的，一页一页取、新的在前；进素材的点开跳素材详情，不进素材的有正文的就地展开；
//   现在能查到的（POST …/live）：切过来才现查，顶上写明"这是现查的，不会存进二狗"、有刷新按钮，查不到写原因；Gmail 列表只有发件人、主题、时间，点开一封才现取正文。
//   手机来的数据源没有现查，写明数据由手机交来。
// 导入文件夹是共用的（#/more/data-sources/import_folder，一级页最后一张卡）：ImportFolderPage。
// 几块纯渲染的（DataSourceStatusBlock、DataSourceSettingsBlock、StoredView、LiveView）测试在 Node 里直接渲染；
// 走一级 → 点卡片 → 二级 → 返回见 page-opens.test.ts。
import { useEffect, useState } from "react";
import { copyText } from "../../app/debug-page.ts";
import { useStore } from "../../app/store.tsx";
import { type DataSourceSlot, usePlugins } from "../../plugins/api.ts";
import {
  DATA_SOURCE_STORED_PAGE,
  type DataSourceActionBody,
  type DataSourceDataItem,
  type DataSourceLiveResult,
  type DataSourcesView,
  type DataSourceStoredPage,
  type DataSourceUsage,
  type DataSourceView,
  formatList,
  type ImportFolderView,
  t,
} from "../../state/index.ts";
import { Section, Segmented, TopBar } from "../../ui/common.tsx";
import { clockLabel, nextTimeLabel } from "../../util/time.ts";
import { connectionChip, connectionText, DisconnectConfirm, type DisconnectConfirming, doneText, ImportFolderBlock, newKey, RawDays, sensitiveLine, syncLine, useDataSourcesView, usageSub } from "./DataSourcesPage.tsx";

/** 没做成的那一句 */
const errorText = (err: unknown) => t("pages.dataSources.failed", { reason: err instanceof Error ? err.message : String(err) });
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- 状态、设置 ----

export interface DataSourceStatusBlockProps {
  source: DataSourceView;
  /** 正在处理的数据源 */
  busy: string | undefined;
  failed?: string | undefined;
  note?: string | undefined;
  onSync(source: DataSourceView): void;
  /** 窄屏上设置很长，数据在最下面：状态里给一个直接去数据的链接；没有数据可看的不给 */
  onJumpToData?: (() => void) | undefined;
}

/** 状态一块：连接状态、账号、一句话、问题、上次同步、立即同步 */
export function DataSourceStatusBlock({ source: s, busy, failed, note, onSync, onJumpToData }: DataSourceStatusBlockProps) {
  return (
    <div className={`source-row source-${s.available ? s.connection : "off"}`} data-block="status">
      <div className="source-head ds-status-head">
        <span className={connectionChip(s)}>{connectionText(s)}</span>
        {busy === s.id ? (
          <span className="muted">{t("pages.dataSources.working")}</span>
        ) : (
          s.canSync && (
            <button type="button" className="btn primary small" disabled={busy !== undefined || s.syncing} onClick={() => onSync(s)}>
              {t("pages.dataSources.action.sync")}
            </button>
          )
        )}
      </div>
      {s.account !== undefined && <div className="source-meta muted">{t("pages.dataSources.account", { account: s.account })}</div>}
      {s.summary && <div className="source-summary">{s.summary}</div>}
      {s.unavailable !== undefined && <div className="field-error">{t("pages.dataSources.unavailable", { reason: s.unavailable })}</div>}
      {s.problem !== undefined && <div className="field-error">{t("pages.dataSources.problem", { problem: s.problem })}</div>}
      {s.autoRetry && <div className="hint source-retry">{t(s.configurable ? "pages.dataSources.autoRetry" : "pages.dataSources.autoRetryPlain")}</div>}
      {s.note !== undefined && <div className="hint source-note">{s.note}</div>}
      <div className="source-meta muted">{syncLine(s)}</div>
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
      {onJumpToData && (
        <button type="button" className="link ds-jump" onClick={onJumpToData}>
          {t("pages.dataSources.detail.jump")}
        </button>
      )}
    </div>
  );
}

export interface DataSourceSettingsBlockProps {
  source: DataSourceView;
  busy: string | undefined;
  /** 插件画的设置那一块（插件没在用的没有） */
  panel: DataSourceSlot | undefined;
  /** 导入文件夹（认文件的数据源才画） */
  folder?: { view: ImportFolderView; busy: boolean; onCopy(): void; onOpen(): void; onScan(): void } | undefined;
  onView(view: DataSourcesView): void;
  onUsage(source: DataSourceView, usage: DataSourceUsage, on: boolean): void;
  onDisconnect(source: DataSourceView): void;
  /** 清掉几天的原始数据（300 号票）；不给的不画那一节 */
  onClearRaw?(source: DataSourceView, dates: string[]): void;
}

/** 设置一块：两种用法的开关、敏感内容、认的文件、插件画的那一块、原始数据、导入文件夹、断开 / 删除已导入的 */
export function DataSourceSettingsBlock({ source: s, busy, panel, folder, onView, onUsage, onDisconnect, onClearRaw }: DataSourceSettingsBlockProps) {
  const disabled = busy !== undefined;
  const sensitive = sensitiveLine(s);
  const canDisconnect = s.connection === "connected" || s.connection === "error";
  const canClear = s.connection === "manual" && s.count > 0;
  const Panel = s.available ? panel?.Panel : undefined;
  return (
    <div className="source-row" data-block="settings">
      {s.usages.length > 0 && (
        <div className="source-usages ds-usages">
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
      {onClearRaw && <RawDays source={s} busy={disabled} onClear={(dates) => onClearRaw(s, dates)} />}
      {folder && s.files.length > 0 && (
        <details className="source-raw" data-folder={s.id}>
          <summary>{t("pages.dataSources.folder.title")}</summary>
          <ImportFolderBlock folder={folder.view} busy={folder.busy} onCopy={folder.onCopy} onOpen={folder.onOpen} onScan={folder.onScan} />
        </details>
      )}
      {(canDisconnect || canClear) && (
        <div className="plugin-actions ds-danger-actions">
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
        </div>
      )}
    </div>
  );
}

// ---- 数据：一条 ----

/** 一条的时间：全天的只写日期；有结束的写到结束（同一天只写钟点） */
export function dataItemTime(item: Pick<DataSourceDataItem, "time" | "end" | "allDay">, now: number = Date.now()): string | undefined {
  if (item.time === undefined) return undefined;
  const start = nextTimeLabel(item.time, now);
  if (item.allDay) return start.split(" ")[0];
  if (item.end === undefined) return start;
  const sameDay = item.end.slice(0, 10) === item.time.slice(0, 10);
  return t("pages.dataSources.data.span", { start, end: sameDay ? clockLabel(item.end) : nextTimeLabel(item.end, now) });
}

/** 标题、小签、时间和副标题那一块（一条的三种样子共用） */
function ItemText({ item }: { item: DataSourceDataItem }) {
  const when = dataItemTime(item);
  return (
    <span className="prompt-row-text">
      <span className="ds-item-title">
        <span className="ds-item-name">{item.title}</span>
        {(item.labels ?? []).map((label) => (
          <span key={label} className="chip chip-quiet">
            {label}
          </span>
        ))}
      </span>
      {(when !== undefined || item.subtitle !== undefined) && <small className="ds-item-meta">{[when, item.subtitle].filter((x) => x !== undefined).join(" · ")}</small>}
    </span>
  );
}

/** 点开一封取回来的（Gmail）：还在取、取到了、没取到 */
export type OpenedBody = { state: "loading" } | { state: "ok"; item: DataSourceDataItem } | { state: "failed"; reason: string };

export interface DataItemRowProps {
  item: DataSourceDataItem;
  /** 现取的正文（只有 openable 的有） */
  opened?: OpenedBody | undefined;
  onMaterial?(materialId: string): void;
  /** 点开一条 openable 的：现取正文 */
  onFetch?(id: string): void;
}

/** 一条：进素材的整行是按钮（跳素材详情）；有正文的、点开才取正文的点了就地展开；别的只显示 */
export function DataItemRow({ item, opened, onMaterial, onFetch }: DataItemRowProps) {
  const [expanded, setExpanded] = useState(false);
  if (item.materialId !== undefined && onMaterial) {
    const materialId = item.materialId;
    return (
      <button type="button" className="prompt-row ds-item" data-item={item.id} onClick={() => onMaterial(materialId)}>
        <ItemText item={item} />
        <span className="muted" aria-hidden="true">
          ›
        </span>
      </button>
    );
  }
  if (item.body === undefined && !item.openable) {
    return (
      <div className="prompt-row ds-item" data-item={item.id}>
        <ItemText item={item} />
      </div>
    );
  }
  const shown = opened?.state === "ok" ? opened.item : item;
  return (
    <div className={`ds-item-box${expanded ? " on" : ""}`} data-item={item.id}>
      <button
        type="button"
        className="prompt-row ds-item"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded && item.openable && (opened === undefined || opened.state === "failed")) onFetch?.(item.id);
          setExpanded(!expanded);
        }}
      >
        <ItemText item={shown} />
        <span className="muted ds-item-fold" aria-hidden="true">
          ›
        </span>
      </button>
      {expanded && (
        <div className="ds-item-body">
          {opened?.state === "loading" && <span className="muted">{t("pages.dataSources.data.opening")}</span>}
          {opened?.state === "failed" && (
            <span className="field-error" role="alert">
              {t("pages.dataSources.data.openFailed", { reason: opened.reason })}
            </span>
          )}
          {shown.body !== undefined && <div className="ds-item-text">{shown.body}</div>}
        </div>
      )}
    </div>
  );
}

// ---- 数据：已获取的 ----

export interface StoredViewProps {
  source: DataSourceView;
  page: DataSourceStoredPage | undefined;
  failed: string | undefined;
  loadingMore: boolean;
  onMore(): void;
  onMaterial(materialId: string): void;
}

/** 已获取的（纯渲染）：共几条、一条一条、再显示；没有的按情况说一句 */
export function StoredView({ source, page, failed, loadingMore, onMore, onMaterial }: StoredViewProps) {
  const rawDays = source.raw?.days.length ?? 0;
  const importOff = source.usages.some((u) => u.usage === "import" && !u.on);
  return (
    <div className="ds-stored" data-stored={source.id}>
      {failed !== undefined && (
        <div className="field-error" role="alert">
          {t("pages.dataSources.data.storedFailed", { reason: failed })}
        </div>
      )}
      {page === undefined && failed === undefined && <div className="muted">{t("pages.dataSources.loading")}</div>}
      {page?.problem !== undefined && (
        <div className="field-error" role="alert">
          {t("pages.dataSources.data.storedProblem", { reason: page.problem })}
        </div>
      )}
      {page !== undefined && page.problem === undefined && page.total === 0 && <div className="muted ds-empty">{t(importOff ? "pages.dataSources.data.storedEmptyOff" : "pages.dataSources.data.storedEmpty")}</div>}
      {page !== undefined && page.total > 0 && <div className="muted ds-count">{t("pages.dataSources.data.storedTotal", { count: page.total, n: page.total })}</div>}
      {page !== undefined && page.items.length > 0 && (
        <div className="prompt-rows">
          {page.items.map((item) => (
            <DataItemRow key={item.id} item={item} onMaterial={onMaterial} />
          ))}
        </div>
      )}
      {page !== undefined && page.items.length < page.total && (
        <button type="button" className="btn ghost" disabled={loadingMore} onClick={onMore}>
          {loadingMore ? t("pages.dataSources.loading") : t("pages.dataSources.data.more", { count: Math.min(DATA_SOURCE_STORED_PAGE, page.total - page.items.length), rest: page.total - page.items.length })}
        </button>
      )}
      {rawDays > 0 && <div className="hint">{t("pages.dataSources.data.rawHint", { title: source.raw!.title, count: rawDays, days: rawDays })}</div>}
    </div>
  );
}

/** 接上 HTTP：打开时取第一页；条数、上次同步变了（同步了、手机交来了、删了）从头取 */
function StoredPanel({ source, onMaterial }: { source: DataSourceView; onMaterial(materialId: string): void }) {
  const { http } = useStore();
  const [page, setPage] = useState<DataSourceStoredPage>();
  const [failed, setFailed] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const { id, count } = source;
  const synced = source.lastSync?.at;
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- count、synced 只用来在进了新的之后重取
  useEffect(() => {
    let live = true;
    http.dataSourceStored(id, {}).then(
      (next) => {
        if (!live) return;
        setPage(next);
        setFailed(undefined);
      },
      (err: unknown) => {
        if (live) setFailed(messageOf(err));
      },
    );
    return () => {
      live = false;
    };
  }, [http, id, count, synced]);
  const more = () => {
    if (!page) return;
    setLoadingMore(true);
    http
      .dataSourceStored(id, { offset: page.items.length })
      .then(
        (next) => setPage((cur) => (cur ? { ...next, items: [...cur.items, ...next.items] } : next)),
        (err: unknown) => setFailed(messageOf(err)),
      )
      .finally(() => setLoadingMore(false));
  };
  return <StoredView source={source} page={page} failed={failed} loadingMore={loadingMore} onMore={more} onMaterial={onMaterial} />;
}

// ---- 数据：现在能查到的 ----

export interface LiveViewProps {
  result: DataSourceLiveResult | undefined;
  loading: boolean;
  failed: string | undefined;
  opened: Readonly<Record<string, OpenedBody>>;
  onRefresh(): void;
  onFetch(id: string): void;
}

/** 现在能查到的（纯渲染）：顶上写明是现查的、不会存进二狗，有刷新；查不到写原因 */
export function LiveView({ result, loading, failed, opened, onRefresh, onFetch }: LiveViewProps) {
  const ok = result?.state === "ok";
  const when = result === undefined ? undefined : nextTimeLabel(result.at);
  return (
    <div className="ds-live">
      <div className="ds-live-head">
        <span className="hint ds-live-note">{t("pages.dataSources.data.liveNote")}</span>
        <button type="button" className="btn ghost small" data-action="live-refresh" disabled={loading} onClick={onRefresh}>
          {loading ? t("pages.dataSources.data.refreshing") : t("pages.dataSources.data.refresh")}
        </button>
      </div>
      {failed !== undefined && (
        <div className="field-error" role="alert">
          {t("pages.dataSources.data.liveFailed", { reason: failed })}
        </div>
      )}
      {result !== undefined && !ok && (
        <div className={result.state === "error" ? "field-error" : "hint"} role={result.state === "error" ? "alert" : "status"} data-live-state={result.state}>
          {result.state === "error" ? t("pages.dataSources.data.liveFailed", { reason: result.problem ?? "" }) : result.problem}
        </div>
      )}
      {result === undefined && failed === undefined && <div className="muted">{t("pages.dataSources.data.liveLoading")}</div>}
      {result !== undefined && ok && (
        <>
          <div className="muted ds-count">
            {result.scope === undefined ? t("pages.dataSources.data.liveAt", { when: when! }) : t("pages.dataSources.data.liveScopeAt", { scope: result.scope, when: when! })}
            {result.total !== undefined && result.total > result.items.length && <> · {t("pages.dataSources.data.liveShown", { total: result.total, shown: result.items.length })}</>}
          </div>
          {(result.notes ?? []).map((note) => (
            <div key={note} className="hint" data-live-note="">
              {note}
            </div>
          ))}
          {result.items.length === 0 && <div className="muted ds-empty">{t("pages.dataSources.data.liveEmpty")}</div>}
          {result.items.length > 0 && (
            <div className="prompt-rows">
              {result.items.map((item) => (
                <DataItemRow key={item.id} item={item} opened={opened[item.id]} onFetch={onFetch} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 接上 HTTP：切到这个标签才现查一次（只读），之后点刷新才再查；点开一封现取正文，取过的不再取 */
function LivePanel({ source }: { source: DataSourceView }) {
  const { http } = useStore();
  const { id } = source;
  const [result, setResult] = useState<DataSourceLiveResult>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string>();
  const [opened, setOpened] = useState<Readonly<Record<string, OpenedBody>>>({});
  /** 第几次查（点刷新加一） */
  const [round, setRound] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- round 只用来在点刷新时再查一次
  useEffect(() => {
    let live = true;
    http.dataSourceLive(id, {}).then(
      (next) => {
        if (!live) return;
        setResult(next);
        setFailed(undefined);
        setOpened({});
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setFailed(messageOf(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [http, id, round]);
  const refresh = () => {
    setLoading(true);
    setFailed(undefined);
    setRound((n) => n + 1);
  };
  const fetchBody = (item: string) => {
    setOpened((cur) => ({ ...cur, [item]: { state: "loading" } }));
    http.dataSourceLive(id, { open: item }).then(
      (next) => {
        const found = next.items[0];
        setOpened((cur) => ({ ...cur, [item]: next.state === "ok" && found ? { state: "ok", item: found } : { state: "failed", reason: next.problem ?? "" } }));
      },
      (err: unknown) => setOpened((cur) => ({ ...cur, [item]: { state: "failed", reason: messageOf(err) } })),
    );
  };
  return <LiveView result={result} loading={loading} failed={failed} opened={opened} onRefresh={refresh} onFetch={fetchBody} />;
}

// ---- 数据一块 ----

type DataTab = "stored" | "live";

/** 数据那一节的 id（状态里的链接滚到这里） */
const DATA_SECTION = "ds-data";

/** 这个数据源有哪几个标签 */
export function dataTabs(source: Pick<DataSourceView, "hasStored" | "hasLive">): DataTab[] {
  return [...(source.hasStored ? (["stored"] as const) : []), ...(source.hasLive ? (["live"] as const) : [])];
}

/** 手机来的那一句：没有"现在能查到的"，写明数据由手机交来 */
export function DeviceNote({ source }: { source: Pick<DataSourceView, "fromDevice" | "hasLive"> }) {
  if (!source.fromDevice || source.hasLive) return null;
  return (
    <div className="hint" data-from-device="">
      {t("pages.dataSources.data.fromDevice")}
    </div>
  );
}

function DataSourceData({ source, onMaterial }: { source: DataSourceView; onMaterial(materialId: string): void }) {
  const tabs = dataTabs(source);
  const [chosen, setChosen] = useState<DataTab>();
  const tab = chosen !== undefined && tabs.includes(chosen) ? chosen : tabs[0];
  const label = (one: DataTab) => t(one === "stored" ? "pages.dataSources.data.stored" : "pages.dataSources.data.live");
  return (
    <Section id={DATA_SECTION} title={tabs.length === 1 ? t("pages.dataSources.data.titleOne", { tab: label(tabs[0]!) }) : t("pages.dataSources.section.data")}>
      {tabs.length > 1 && <Segmented<DataTab> value={tab!} label={t("pages.dataSources.section.data")} onChange={setChosen} options={tabs.map((one) => ({ value: one, label: label(one) }))} />}
      <DeviceNote source={source} />
      {tab === undefined && <div className="muted ds-empty">{t("pages.dataSources.data.none")}</div>}
      {tab === "stored" && <StoredPanel source={source} onMaterial={onMaterial} />}
      {tab === "live" && <LivePanel source={source} />}
    </Section>
  );
}

// ---- 页面 ----

/** 导入文件夹的几个动作（详情页、导入文件夹页共用） */
function useFolderActions(view: DataSourcesView | undefined, setView: (view: DataSourcesView) => void, report: { setFailed(text: string | undefined): void; setNote(text: string | undefined): void }) {
  const { http } = useStore();
  const [busy, setBusy] = useState(false);
  const run = (action: "scan" | "open") => {
    setBusy(true);
    report.setFailed(undefined);
    report.setNote(undefined);
    http
      .importFolderAction({ action })
      .then(
        (result) => {
          setView(result.view);
          if (action === "open") report.setNote(result.opened ? t("pages.dataSources.folder.opened") : (result.error ?? t("pages.dataSources.folder.openFailed")));
          else report.setNote(t("pages.dataSources.folder.scanned"));
        },
        (err: unknown) => report.setFailed(errorText(err)),
      )
      .finally(() => setBusy(false));
  };
  const copy = () => {
    if (!view) return;
    void copyText(view.folder.path).then((ok) => report.setNote(t(ok ? "pages.dataSources.folder.copied" : "pages.dataSources.folder.copyFailed")));
  };
  return { busy, scan: () => run("scan"), open: () => run("open"), copy };
}

export interface DataSourceDetailPageProps {
  id: string;
  /** 点开一条进了素材的：去素材详情 */
  onMaterial(materialId: string): void;
  onBack(): void;
}

/** 二级页：#/more/data-sources/<id> */
export function DataSourceDetailPage({ id, onMaterial, onBack }: DataSourceDetailPageProps) {
  const { http } = useStore();
  const plugins = usePlugins();
  const { view, setView, loadFailed } = useDataSourcesView();
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [note, setNote] = useState<string>();
  const [confirming, setConfirming] = useState<DisconnectConfirming>();
  const folder = useFolderActions(view, setView, { setFailed, setNote });
  const source = view?.sources.find((s) => s.id === id);

  const run = (target: DataSourceView, body: DataSourceActionBody) => {
    setConfirming(undefined);
    setBusy(target.id);
    setFailed(undefined);
    setNote(undefined);
    http
      .dataSourceAction(target.id, body)
      .then(
        (result) => {
          setView(result.view);
          setNote(doneText(target, body, result));
        },
        (err: unknown) => setFailed(errorText(err)),
      )
      .finally(() => setBusy(undefined));
  };
  const onConfirm = () => {
    if (!confirming) return;
    run(confirming.source, { action: "disconnect", purge: confirming.source.connection === "manual" ? true : confirming.purge, idempotencyKey: newKey() });
  };

  return (
    <div className="chat-col">
      <TopBar title={source?.title ?? t("shell.pages.dataSources.title")} {...(source && source.pluginTitle !== source.title ? { sub: source.pluginTitle } : {})} onBack={onBack} />
      <div className="scroll page-pad">
        {!view && !loadFailed && <div className="muted">{t("pages.dataSources.loading")}</div>}
        {loadFailed && (
          <div className="field-error" role="alert">
            {t("pages.dataSources.loadFailed", { reason: loadFailed })}
          </div>
        )}
        {view && !source && (
          <div className="page-placeholder" data-missing-source="">
            <span>{t("pages.dataSources.detail.notFound", { id })}</span>
            <button type="button" className="btn primary" onClick={onBack}>
              {t("pages.dataSources.detail.back")}
            </button>
          </div>
        )}
        {view && source && (
          <div className="ds-detail" data-source-detail={source.id}>
            <div className="ds-detail-side">
              <Section title={t("pages.dataSources.section.status")}>
                <DataSourceStatusBlock
                  source={source}
                  busy={busy}
                  failed={failed}
                  note={note}
                  onSync={(s) => run(s, { action: "sync", idempotencyKey: newKey() })}
                  {...(dataTabs(source).length > 0 ? { onJumpToData: () => document.getElementById(DATA_SECTION)?.scrollIntoView({ block: "start" }) } : {})}
                />
              </Section>
              <Section title={t("pages.dataSources.section.settings")}>
                <DataSourceSettingsBlock
                  source={source}
                  busy={busy}
                  panel={plugins.get("dataSources", source.id)}
                  folder={{ view: view.folder, busy: folder.busy, onCopy: folder.copy, onOpen: folder.open, onScan: folder.scan }}
                  onView={setView}
                  onUsage={(s, usage, on) => run(s, { action: "usage", usage, on, idempotencyKey: newKey() })}
                  onDisconnect={(s) => setConfirming({ source: s, purge: false })}
                  onClearRaw={(s, dates) => run(s, { action: "clear_raw", dates, idempotencyKey: newKey() })}
                />
              </Section>
            </div>
            <div className="ds-detail-data">
              <DataSourceData key={source.id} source={source} onMaterial={onMaterial} />
            </div>
          </div>
        )}
      </div>
      {confirming && <DisconnectConfirm confirming={confirming} busy={busy !== undefined} onPurgeChange={(purge) => setConfirming((c) => (c ? { ...c, purge } : c))} onCancel={() => setConfirming(undefined)} onConfirm={onConfirm} />}
    </div>
  );
}

/** 共用的导入文件夹：#/more/data-sources/import_folder（一级页最后一张卡）。路径、按钮、没导入的、最近导入的，下面列哪个数据源认哪种文件 */
export function ImportFolderPage({ onBack }: { onBack(): void }) {
  const { view, setView, loadFailed } = useDataSourcesView();
  const [failed, setFailed] = useState<string>();
  const [note, setNote] = useState<string>();
  const folder = useFolderActions(view, setView, { setFailed, setNote });
  const accepting = (view?.sources ?? []).filter((s) => s.files.length > 0);
  return (
    <div className="chat-col">
      <TopBar title={t("pages.dataSources.folder.title")} onBack={onBack} />
      <div className="scroll page-pad">
        {!view && !loadFailed && <div className="muted">{t("pages.dataSources.loading")}</div>}
        {loadFailed && (
          <div className="field-error" role="alert">
            {t("pages.dataSources.loadFailed", { reason: loadFailed })}
          </div>
        )}
        {view && (
          <div className="ds-folder-page" data-source-detail="import_folder">
            <div className="source-row">
              <ImportFolderBlock folder={view.folder} busy={folder.busy} onCopy={folder.copy} onOpen={folder.open} onScan={folder.scan} />
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
            </div>
            {accepting.length > 0 && (
              <Section title={t("pages.dataSources.folder.accepts")}>
                <ul className="source-notes">
                  {accepting.map((s) => (
                    <li key={s.id}>{t("pages.dataSources.folder.acceptsLine", { title: s.title, files: formatList(s.files) })}</li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
