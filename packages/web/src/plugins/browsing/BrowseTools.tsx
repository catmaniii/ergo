/**
 * "浏览"页签右上角 ⋮ 菜单（165 号票）的界面：菜单本身、查找栏、浏览记录（空白页的"最近访问"和菜单里的完整浏览记录同一套）、
 * 下载记录、清除浏览数据的对话框。菜单项能不能用、按网站记住的、记录怎么分组怎么删都在 state/browse-tools.ts；
 * 接到页面上的那一半在 app/page-browse.ts，摆在哪由 pages/BrowsePage.tsx 定。
 * - 菜单：手机上从底部弹出（Sheet）、宽屏是贴着 ⋮ 的下拉菜单（PopupMenu），分组之间画分隔线；点不了的灰掉、下面一行写原因；
 *   文字大小一行带减号、加号（点了不关菜单）；桌面版网站带勾；
 * - 浏览记录：长按（电脑上右键）一条出菜单（打开、删除、多选）；多选用 157 号票的多选模式（"已选 N 个"、醒目的"退出多选"、
 *   删除选中）；"清空全部"先确认；完整的浏览记录按日期分组、能搜；
 * - 下载记录：App 记的在浏览器里下载、存好了的文件（名字、大小、时间、存在哪），点了打开，长按删记录（文件留着）；
 * - 清除浏览数据：勾清什么（缓存、Cookie 和网站数据、浏览记录），范围"全部"或"只清当前网站"。
 */
import { Fragment, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { BrowseFind, BrowseFindView } from "./browse-find.ts";
import type { BrowseSettings } from "../../app/browse-settings.ts";
import type { DownloadRecord, NativeToolControl } from "../../app/native-browser.ts";
import { useBackLayer } from "../../app/page-back.ts";
import {
  type BrowseMenuGroup,
  type BrowseMenuId,
  type BrowseMenuItem,
  type ClearChoice,
  clearPlan,
  downloadWhere,
  filterVisits,
  findCountLabel,
  historyGroups,
  type RecentVisit,
  shortAddress,
  siteKeyOf,
  sizeLabel,
  t,
  visitTimeLabel,
} from "../../state/index.ts";
import { Sheet, useNow } from "../../ui/common.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useLongPress } from "../../ui/long-press.ts";
import { PopupMenu } from "../../ui/popup.tsx";
import { SelectExit, SelectToggle, useSelectingBack } from "../../ui/select-mode.tsx";

// ───────────────────────── ⋮ 菜单 ─────────────────────────

/** 一串菜单项（下拉菜单、底部弹层共用）：点一项交给 onPick（文字大小的减号、加号交给 onZoom，菜单不关） */
function BrowseMenuItems({ groups, onPick, onZoom }: { groups: readonly BrowseMenuGroup[]; onPick(id: BrowseMenuId): void; onZoom(dir: 1 | -1): void }) {
  return groups.map((group, gi) => (
    <Fragment key={group.key}>
      {gi > 0 && <div className="menu-sep" role="separator" />}
      {group.items.map((item) => (item.zoom ? <ZoomRow key={item.id} item={item} onZoom={onZoom} /> : <MenuButton key={item.id} item={item} onPick={onPick} />))}
    </Fragment>
  ));
}

function MenuButton({ item, onPick }: { item: BrowseMenuItem; onPick(id: BrowseMenuId): void }) {
  const toggle = item.checked !== undefined;
  return (
    <button
      type="button"
      role={toggle ? "menuitemcheckbox" : "menuitem"}
      aria-checked={toggle ? item.checked : undefined}
      className="browse-menu-item"
      disabled={item.disabled !== undefined}
      onClick={() => onPick(item.id)}
    >
      <span className="browse-menu-label">
        {item.label}
        {item.disabled && <small>{item.disabled}</small>}
      </span>
      {toggle && (
        <span className={`browse-menu-check${item.checked ? " on" : ""}`} aria-hidden="true">
          {item.checked ? "✓" : ""}
        </span>
      )}
    </button>
  );
}

/** 文字大小那一行：现在多大、减号、加号（按这一页的网站记住） */
function ZoomRow({ item, onZoom }: { item: BrowseMenuItem; onZoom(dir: 1 | -1): void }) {
  const zoom = item.zoom!;
  const off = item.disabled !== undefined;
  return (
    <div className={`browse-menu-item browse-menu-zoom${off ? " disabled" : ""}`} role="group" aria-label={t("pages.browseTools.textSize")}>
      <span className="browse-menu-label">
        {item.label}
        {item.disabled && <small>{item.disabled}</small>}
      </span>
      <button type="button" className="browse-zoom-btn" aria-label={t("pages.browseTools.textSmaller")} disabled={off || !zoom.down} onClick={() => onZoom(-1)}>
        −
      </button>
      <span className="browse-zoom-value" aria-live="polite">
        {zoom.value}%
      </span>
      <button type="button" className="browse-zoom-btn" aria-label={t("pages.browseTools.textLarger")} disabled={off || !zoom.up} onClick={() => onZoom(1)}>
        +
      </button>
    </div>
  );
}

/** ⋮ 菜单：宽屏贴着 anchor 往下弹，手机上从底部弹出（标题写这一页的网站） */
export function BrowseMenu({
  wide,
  anchor,
  title,
  groups,
  onPick,
  onZoom,
  onClose,
}: {
  wide: boolean;
  anchor: RefObject<HTMLElement | null>;
  title: string;
  groups: readonly BrowseMenuGroup[];
  onPick(id: BrowseMenuId): void;
  onZoom(dir: 1 | -1): void;
  onClose(): void;
}) {
  if (wide) {
    return (
      <PopupMenu anchor={anchor} align="end" className="row-menu browse-menu" label={t("pages.browseTools.menu")} onClose={onClose}>
        <BrowseMenuItems groups={groups} onPick={onPick} onZoom={onZoom} />
      </PopupMenu>
    );
  }
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="browse-menu browse-menu-sheet" role="menu" aria-label={t("pages.browseTools.menu")}>
        <BrowseMenuItems groups={groups} onPick={onPick} onZoom={onZoom} />
      </div>
    </Sheet>
  );
}

// ───────────────────────── 查找栏 ─────────────────────────

/** 顶栏下面的查找栏：输入框、第 n / 共 m 个、上一个、下一个、关闭；网页里的高亮由 App 用 ArkWeb 的页内查找做 */
export function FindBar({ view, find }: { view: BrowseFindView; find: BrowseFind }) {
  const input = useRef<HTMLInputElement>(null);
  useBackLayer("overlay", true, () => find.close());
  useEffect(() => input.current?.focus(), []);
  const count = findCountLabel(view.query, view.result);
  const can = view.query.trim() !== "" && (view.result?.total ?? 0) > 0;
  return (
    <div className="browse-find" role="search">
      <input
        ref={input}
        className="input browse-find-input"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        aria-label={t("pages.browseTools.find")}
        placeholder={t("pages.browseTools.find")}
        value={view.query}
        onChange={(e) => find.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) find.prev();
            else find.submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            find.close();
          }
        }}
      />
      <span className="browse-find-count" aria-live="polite">
        {count}
      </span>
      <button type="button" className="icon-btn" onClick={() => find.prev()} disabled={!can} aria-label={t("pages.browseTools.prev")} title={t("pages.browseTools.prev")}>
        <Icon name="up" />
      </button>
      <button type="button" className="icon-btn" onClick={() => find.next()} disabled={!can} aria-label={t("pages.browseTools.next")} title={t("pages.browseTools.next")}>
        <Icon name="down" />
      </button>
      <button type="button" className="icon-btn" onClick={() => find.close()} aria-label={t("pages.browseTools.closeFind")} title={t("pages.browseTools.closeFind")}>
        <Icon name="cross" />
      </button>
    </div>
  );
}

// ───────────────────────── 浏览记录 ─────────────────────────

/** 浏览记录的多选状态（空白页的最近访问、完整的浏览记录各一份） */
export function useVisitSelection() {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const stop = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  useSelectingBack(selecting, stop);
  return {
    selecting,
    picked,
    start(url?: string) {
      setSelecting(true);
      setPicked(new Set(url ? [url] : []));
    },
    stop,
    toggle(url: string) {
      setPicked((old) => {
        const next = new Set(old);
        if (next.has(url)) next.delete(url);
        else next.add(url);
        return next;
      });
    },
    setAll(urls: readonly string[]) {
      setPicked(new Set(urls));
    },
  };
}

type VisitSelection = ReturnType<typeof useVisitSelection>;

/** 一条浏览记录：点了打开（多选时勾选）；长按、右键出菜单（打开、删除、多选） */
function VisitRow({ visit, now, sel, onOpen, onRemove }: { visit: RecentVisit; now: number; sel: VisitSelection; onOpen(url: string): void; onRemove(urls: readonly string[]): void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const press = useLongPress(() => setMenu(true), { disabled: sel.selecting });
  const checked = sel.picked.has(visit.url);
  return (
    <div ref={rowRef} className={`browse-visit${checked ? " picked" : ""}`} {...press}>
      <button type="button" className="menu-item browse-visit-main" aria-pressed={sel.selecting ? checked : undefined} onClick={() => (sel.selecting ? sel.toggle(visit.url) : onOpen(visit.url))}>
        {sel.selecting && (
          <span className={`bsel${checked ? " on" : ""}`} aria-hidden="true">
            {checked ? "✓" : ""}
          </span>
        )}
        <span className="menu-text">
          <span className="browse-recent-title">{visit.title || shortAddress(visit.url)}</span>
          <small className="browse-recent-url">
            {shortAddress(visit.url)} · {visitTimeLabel(visit.time, now)}
          </small>
        </span>
      </button>
      {menu && (
        <PopupMenu anchor={rowRef} align="end" className="row-menu" onClose={() => setMenu(false)}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              onOpen(visit.url);
            }}
          >
            {t("pages.browseTools.open")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger-text"
            onClick={() => {
              setMenu(false);
              onRemove([visit.url]);
            }}
          >
            {t("pages.browseTools.delete")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              sel.start(visit.url);
            }}
          >
            {t("pages.browseTools.multiSelect")}
          </button>
        </PopupMenu>
      )}
    </div>
  );
}

/** 浏览记录的一串（不分组的：空白页的最近访问；分组的：完整的浏览记录） */
export function VisitList({
  visits,
  grouped,
  now,
  sel,
  onOpen,
  onRemove,
}: {
  visits: readonly RecentVisit[];
  grouped: boolean;
  now: number;
  sel: VisitSelection;
  onOpen(url: string): void;
  onRemove(urls: readonly string[]): void;
}) {
  const rows = (list: readonly RecentVisit[]) => (
    <div className="menu">
      {list.map((v) => (
        <VisitRow key={v.url} visit={v} now={now} sel={sel} onOpen={onOpen} onRemove={onRemove} />
      ))}
    </div>
  );
  if (!grouped) return rows(visits);
  return historyGroups(visits, now).map((g) => (
    <section key={g.key} className="browse-visit-group" aria-label={g.label}>
      <div className="menu-group">{g.label}</div>
      {rows(g.visits)}
    </section>
  ));
}

/** 多选的操作栏："已选 N 个"、全选、删除选中、醒目的"退出多选" */
export function VisitSelectBar({ sel, shown, onRemove }: { sel: VisitSelection; shown: readonly RecentVisit[]; onRemove(urls: readonly string[]): void }) {
  const urls = shown.map((v) => v.url);
  const all = urls.length > 0 && urls.every((u) => sel.picked.has(u));
  const picked = urls.filter((u) => sel.picked.has(u));
  return (
    <div className="sel-bar" role="toolbar" aria-label={t("pages.browseTools.selectActions")}>
      <span className="sel-n">{t("pages.browseTools.selectedCount", { count: picked.length })}</span>
      <button type="button" className="link sel-all" onClick={() => sel.setAll(all ? [] : urls)}>
        {all ? t("pages.browseTools.selectNone") : t("pages.browseTools.selectAll")}
      </button>
      <div className="sel-acts">
        <button
          type="button"
          className="btn small ghost sel-danger"
          disabled={picked.length === 0}
          onClick={() => {
            onRemove(picked);
            sel.stop();
          }}
        >
          {t("pages.browseTools.deleteSelected")}
          {picked.length > 0 && <span className="sel-count">{t("pages.browseTools.deleteSelectedCount", { count: picked.length })}</span>}
        </button>
      </div>
      <SelectExit onExit={sel.stop} />
    </div>
  );
}

/** "清空全部"先确认 */
export function ClearVisitsConfirm({ count, onClear, onClose }: { count: number; onClear(): void; onClose(): void }) {
  return (
    <Sheet title={t("pages.browseTools.clearVisitsTitle")} onClose={onClose} center>
      <div className="modal-body">
        <p>{t("pages.browseTools.clearVisitsBody", { count })}</p>
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.browseTools.clearVisitsCancel")}
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            onClose();
            onClear();
          }}
        >
          {t("pages.browseTools.clearVisitsConfirm")}
        </button>
      </div>
    </Sheet>
  );
}

/** 面板的标题行（浏览记录、下载记录）：返回、标题、右边几个按钮 */
function PanelHead({ title, onClose, children }: { title: string; onClose(): void; children?: ReactNode }) {
  return (
    <div className="browse-panel-head">
      <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.back")} title={t("common.back")}>
        <Icon name="back" />
      </button>
      <span className="browse-panel-title">{title}</span>
      {children}
    </div>
  );
}

/** 完整的浏览记录（菜单里点"浏览记录"）：盖在内容区里（浏览器藏起来），按日期分组、能搜、能删、能多选删、能清空 */
export function BrowseHistoryPanel({ settings, visits, onOpen, onClose, style }: { settings: BrowseSettings; visits: readonly RecentVisit[]; onOpen(url: string): void; onClose(): void; style?: React.CSSProperties | undefined }) {
  useBackLayer("overlay", true, onClose);
  const sel = useVisitSelection();
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState(false);
  const now = useNow(60_000);
  const shown = filterVisits(visits, query);
  return (
    <div className="browse-panel" style={style}>
      <PanelHead title={t("pages.browseTools.history")} onClose={onClose}>
        <SelectToggle selecting={sel.selecting} onStart={() => sel.start()} onStop={sel.stop} disabled={visits.length === 0} />
        <button type="button" className="btn small ghost danger-text" disabled={visits.length === 0} onClick={() => setConfirm(true)}>
          {t("pages.browseTools.clearAll")}
        </button>
      </PanelHead>
      <div className="browse-panel-search">
        <input className="input" type="search" placeholder={t("pages.browseTools.searchHistoryPlaceholder")} aria-label={t("pages.browseTools.searchHistory")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="scroll browse-panel-body">
        {shown.length > 0 ? (
          <VisitList visits={shown} grouped now={now} sel={sel} onOpen={onOpen} onRemove={(urls) => settings.removeVisits(urls)} />
        ) : (
          <div className="page-placeholder">{query.trim() ? t("pages.browseTools.notFound") : t("pages.browseTools.historyEmpty")}</div>
        )}
      </div>
      {sel.selecting && <VisitSelectBar sel={sel} shown={shown} onRemove={(urls) => settings.removeVisits(urls)} />}
      {confirm && <ClearVisitsConfirm count={visits.length} onClear={() => settings.clearRecents()} onClose={() => setConfirm(false)} />}
    </div>
  );
}

// ───────────────────────── 下载记录 ─────────────────────────

/** 一条下载记录：点了打开；长按、右键出菜单（打开、删除记录） */
function DownloadRow({ item, now, onOpen, onRemove }: { item: DownloadRecord; now: number; onOpen(): void; onRemove(): void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const press = useLongPress(() => setMenu(true));
  return (
    <div ref={rowRef} className="browse-visit" {...press}>
      <button type="button" className="menu-item browse-visit-main" onClick={onOpen}>
        <span className="menu-icon" aria-hidden="true">
          <Icon name="file" />
        </span>
        <span className="menu-text">
          <span className="browse-recent-title">{item.name}</span>
          <small className="browse-recent-url">
            {sizeLabel(item.size)} · {visitTimeLabel(item.time, now)}
          </small>
          <small className="browse-recent-url">{t("pages.browseTools.savedIn", { where: downloadWhere(item.uri) })}</small>
        </span>
      </button>
      {menu && (
        <PopupMenu anchor={rowRef} align="end" className="row-menu" onClose={() => setMenu(false)}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              onOpen();
            }}
          >
            {t("pages.browseTools.open")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger-text"
            onClick={() => {
              setMenu(false);
              onRemove();
            }}
          >
            {t("pages.browseTools.deleteDownloadRecord")}
          </button>
        </PopupMenu>
      )}
    </div>
  );
}

/** 下载记录（菜单里点"下载记录"）：盖在内容区里，每次打开现取 */
export function BrowseDownloadsPanel({ tools, onClose, onNote, style }: { tools: NativeToolControl; onClose(): void; onNote(text: string): void; style?: React.CSSProperties | undefined }) {
  useBackLayer("overlay", true, onClose);
  const [list, setList] = useState<readonly DownloadRecord[]>();
  useEffect(() => {
    let live = true;
    void tools.downloads().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [tools]);
  const now = useNow(60_000);
  const open = async (item: DownloadRecord) => {
    const done = await tools.openDownload(item.id);
    if (!done.ok) onNote(t("pages.browseTools.openFailed", { name: item.name, reason: done.reason ?? t("pages.browseTools.fileMoved") }));
  };
  const remove = async (item: DownloadRecord) => {
    setList((old) => old?.filter((d) => d.id !== item.id));
    const done = await tools.removeDownloads([item.id]);
    if (!done.ok) onNote(t("pages.browseTools.removeFailed", { reason: done.reason ?? t("pages.browseTools.noAppReply") }));
  };
  return (
    <div className="browse-panel" style={style}>
      <PanelHead title={t("pages.browseTools.downloads")} onClose={onClose} />
      <div className="scroll browse-panel-body">
        {list === undefined ? (
          <div className="page-placeholder">{t("pages.browseTools.loading")}</div>
        ) : list.length === 0 ? (
          <div className="page-placeholder">{t("pages.browseTools.downloadsEmpty")}</div>
        ) : (
          <>
            <div className="menu">
              {list.map((item) => (
                <DownloadRow key={item.id} item={item} now={now} onOpen={() => void open(item)} onRemove={() => void remove(item)} />
              ))}
            </div>
            <p className="muted browse-panel-hint">{t("pages.browseTools.downloadsHint")}</p>
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── 清除浏览数据 ─────────────────────────

/** 清除浏览数据：勾清什么、范围；缓存、Cookie 和网站数据交给 App（旧版 App 只能清浏览记录） */
export function ClearDataDialog({
  wide,
  url,
  tools,
  settings,
  onClose,
  onDone,
}: {
  wide: boolean;
  url: string;
  tools: NativeToolControl | undefined;
  settings: BrowseSettings;
  onClose(): void;
  onDone(note: string): void;
}) {
  const host = siteKeyOf(url);
  const [choice, setChoice] = useState<ClearChoice>({ cache: tools !== undefined, cookies: false, history: true, scope: "all" });
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<ClearChoice>) => setChoice((old) => ({ ...old, ...change }));
  const nothing = !choice.cache && !choice.cookies && !choice.history;
  const run = async () => {
    const plan = clearPlan(choice, url);
    setBusy(true);
    const notes: string[] = [];
    let failed: string | undefined;
    if (plan.native && tools) {
      const done = await tools.clear(plan.native);
      notes.push(...done.notes);
      if (!done.ok) failed = done.reason ?? t("pages.browseTools.appClearFailed");
    }
    if (plan.history?.kind === "all") settings.clearRecents();
    else if (plan.history?.kind === "site") settings.removeSiteVisits(plan.history.host);
    setBusy(false);
    onClose();
    onDone(failed ? t("pages.browseTools.clearFailed", { reason: failed }) : [t("pages.browseTools.cleared"), ...notes].join(t("pages.browseTools.noteSeparator")));
  };
  const site = choice.scope === "site" && host !== undefined;
  return (
    <Sheet title={t("pages.browseTools.clearData")} onClose={onClose} center={wide}>
      <div className="modal-body browse-clear">
        <div className="browse-clear-scope" role="radiogroup" aria-label={t("pages.browseTools.scope")}>
          <label className="check-row">
            <input type="radio" name="browse-clear-scope" checked={!site} onChange={() => set({ scope: "all" })} />
            <span>{t("pages.browseTools.allSites")}</span>
          </label>
          <label className="check-row">
            <input type="radio" name="browse-clear-scope" checked={site} disabled={host === undefined} onChange={() => set({ scope: "site" })} />
            <span>
              {host ? t("pages.browseTools.thisSiteHost", { host }) : t("pages.browseTools.thisSite")}
              {host === undefined && <small className="muted">{t("pages.browseTools.noPage")}</small>}
            </span>
          </label>
        </div>
        <div className="menu-sep" role="separator" />
        <label className="check-row">
          <input type="checkbox" checked={choice.cache && tools !== undefined} disabled={tools === undefined} onChange={(e) => set({ cache: e.target.checked })} />
          <span>
            {t("pages.browseTools.cache")}
            <small className="muted">{site ? t("pages.browseTools.cacheHintSite") : t("pages.browseTools.cacheHint")}</small>
          </span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={choice.cookies && tools !== undefined} disabled={tools === undefined} onChange={(e) => set({ cookies: e.target.checked })} />
          <span>
            {t("pages.browseTools.cookies")}
            <small className="muted">{site ? t("pages.browseTools.cookiesHintSite") : t("pages.browseTools.cookiesHint")}</small>
          </span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={choice.history} onChange={(e) => set({ history: e.target.checked })} />
          <span>
            {t("pages.browseTools.history")}
            <small className="muted">{site ? t("pages.browseTools.historyHintSite") : t("pages.browseTools.historyHint")}</small>
          </span>
        </label>
        {tools === undefined && <p className="muted">{t("pages.browseTools.needNewApp")}</p>}
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.browseTools.cancel")}
        </button>
        <button type="button" className="btn danger" disabled={nothing || busy} onClick={() => void run()}>
          {busy ? t("pages.browseTools.clearing") : t("pages.browseTools.clear")}
        </button>
      </div>
    </Sheet>
  );
}
