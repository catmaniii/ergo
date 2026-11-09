// 地图页的"我的足迹"（430）：标题栏里选日期的那一组（442 追加：原来是标题栏下面单独一条，挪进标题栏、和"地图"一行；
// 窄的时候日期、概况写短的，"足迹"开关只剩图标），地图上画那一天的足迹（footprints.ts 整理），点停留点看详情。
// - 哪一天：地址里带了日期（#/more/map/2026-11-06，聊天里的足迹卡片点进来）看那一天；没带看今天，今天什么都没有就跳到最近有足迹的
//   一天（只跳这一次）；左右箭头前一天、后一天，中间是日期选择；
// - 取到以后把视野挪到看得全这一天（地址里带了"纬度,经度"的不挪，那是要看那一处）；
// - 标题栏右边"足迹"开关：关了地图上不画（记在这台设备的浏览器里，只是方便）。默认关着（444，用户 2026-11-08：国内先看高德——
//   451 起开着足迹时底图也是当前地图）；打开时把视野挪到看全这一天；从聊天里的足迹卡片、日期链接点进来照旧这次打开（不改记着的开关）；
//   关着时标题栏上不放选日期的那一组；
// - 宽的时候地图左边一栏列这一天（每段停留、不在停留里拍的照片），点一行跳过去；选中的停留在那一行下面展开详情。
//   这一栏能收成左上角一个小按钮、能关掉（444；记在这台设备上，点小按钮、标题栏上这一天的概况再打开）。
//   窄的时候（手机）点停留点，地图下面出一张详情卡；点概况那一句看这一天的列表；这张卡是抽屉：顶上的把手往下拖拖低（只露标题那一行，
//   记在这台设备上），再往下拖关掉，往上拖拉高，点一下把手拖低 / 拉高；
// - 取不到（手机插件没启用、日期不对）在那一条里写为什么，地图照样能看。
// 足迹是本机守护进程现算的（GET /api/map/day，不联网）；451 起画在当前地图上——高德、谷歌的脚本看得到画上去的轨迹（用户 2026-11-09 定）。
import { type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import type { Navigate } from "../../app/route.ts";
import { type LatLon, localDate, type MapDayView, parseMapDayItem, parseMapFocusItem, PHONE_LOCATION_SOURCE, shiftMapDate, t } from "../../state/index.ts";
import { Icon } from "../../ui/icons.tsx";
import type { MapDrawerState, MapPanelState } from "./map-layout.ts";
import {
  coordsLabel,
  daySummary,
  daySummaryShort,
  durationLabel,
  FOOTPRINT_PREFIX,
  type FootprintDay,
  footprintDay,
  type FootprintSpot,
  latestDayBefore,
  shortDateLabel,
  spotTitle,
  stayRange,
  type TimelineEntry,
} from "./footprints.ts";

/** "足迹"开关记在哪（浏览器里，只是方便）：开着记 "on"，关着不留记号（444 起默认关着；以前关掉记的 "off" 照样算关着） */
const LAYER_KEY = "ergo-map-footprints";
/** 地图那一块宽过这么多（像素）时左边列这一天 */
export const FOOTPRINT_WIDE_MIN = 720;
/** 左边那一栏占多宽（像素，含边距；定视野时让开它） */
export const FOOTPRINT_PANEL_W = 316;
/** 定视野时右边给点旁边的字留多宽（像素） */
export const FOOTPRINT_LABEL_ROOM = 110;

function layerShown(): boolean {
  try {
    return localStorage.getItem(LAYER_KEY) === "on";
  } catch {
    return false;
  }
}

function saveLayer(shown: boolean): void {
  try {
    if (shown) localStorage.setItem(LAYER_KEY, "on");
    else localStorage.removeItem(LAYER_KEY);
  } catch {
    // 存不了（隐私模式）就算了
  }
}

/** 要看哪一天：日期、是不是用户（或地址）指定的（不是的话今天空着跳到最近一天）、取到后挪不挪视野 */
interface DayRequest {
  readonly date: string;
  readonly chosen: boolean;
  readonly fit: boolean;
}

export interface Footprints {
  readonly date: string;
  readonly today: string;
  readonly view: MapDayView | undefined;
  readonly day: FootprintDay | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly shown: boolean;
  /** 选中的那一处（spot） */
  readonly selected: string | undefined;
  /** 换了一个对象就把视野挪到看全这些点 */
  readonly fit: { readonly bounds: readonly LatLon[] } | undefined;
  /** 换了一个对象就跳到这里（没给级别的只挪过去、级别不变） */
  readonly focus: { readonly lat: number; readonly lon: number; readonly zoom?: number } | undefined;
  pick(date: string): void;
  toggle(): void;
  /** 选中一处；jump 是挪过去（"pan" 级别不变，"zoom" 放大到看得清那一处） */
  select(spot: string | undefined, jump?: "pan" | "zoom"): void;
  /** 跳到一处（列表里点了不在停留里拍的照片） */
  jumpTo(where: LatLon): void;
  /** 地图上点了一个点：是足迹的就接着（交回 true） */
  markClick(id: string): boolean;
}

/** "看这里"放大到的级别 */
const SPOT_ZOOM = 17;

export function useFootprints(http: DaemonHttp, item: string | undefined): Footprints {
  const [today] = useState(() => localDate(new Date()));
  const [request, setRequest] = useState<DayRequest>(() => {
    const date = parseMapDayItem(item);
    return { date: date ?? today, chosen: date !== undefined, fit: parseMapFocusItem(item) === undefined };
  });
  // 地址里的日期变了（聊天里的足迹卡片点进来）：换那一天、挪视野（React 推荐的"跟着 props 调 state"的写法）；
  // 地址里写了日期就是要看那天的足迹：关着的"足迹"这次打开（不改记着的开关）
  const [lastItem, setLastItem] = useState(item);
  const [loaded, setLoaded] = useState<{ date: string; view: MapDayView } | { date: string; error: string }>();
  const [shown, setShown] = useState(() => layerShown() || parseMapDayItem(item) !== undefined);
  if (item !== lastItem) {
    setLastItem(item);
    const date = parseMapDayItem(item);
    if (date !== undefined) {
      setRequest({ date, chosen: true, fit: true });
      setShown(true);
    }
  }
  const [selected, setSelected] = useState<string>();
  const [fit, setFit] = useState<{ bounds: readonly LatLon[] }>();
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom?: number }>();
  const shownRef = useRef(shown);
  useEffect(() => {
    shownRef.current = shown;
  });

  useEffect(() => {
    let alive = true;
    http.mapDay(request.date).then(
      (view) => {
        if (!alive) return;
        const day = footprintDay(view);
        // 没指定哪天、今天又什么都没有：跳到最近有足迹的一天（只跳这一次）
        const latest = !request.chosen && day.empty && view.unlocatedPhotos === 0 ? latestDayBefore(view.days, request.date) : undefined;
        if (latest !== undefined) {
          setRequest({ date: latest, chosen: true, fit: request.fit });
          return;
        }
        setLoaded({ date: request.date, view });
        if (request.fit && shownRef.current && !day.empty) setFit({ bounds: day.bounds });
      },
      (err: unknown) => alive && setLoaded({ date: request.date, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
  }, [http, request]);

  const current = loaded?.date === request.date ? loaded : undefined;
  const view = current && "view" in current ? current.view : undefined;
  const day = useMemo(() => (view ? footprintDay(view) : undefined), [view]);

  return {
    date: request.date,
    today,
    view,
    day,
    loading: current === undefined,
    error: current && "error" in current ? current.error : undefined,
    shown,
    selected: day?.spots.some((s) => s.key === selected) ? selected : undefined,
    fit,
    focus,
    pick(date) {
      if (!parseMapDayItem(date)) return;
      setSelected(undefined);
      setRequest({ date, chosen: true, fit: true });
    },
    toggle() {
      saveLayer(!shown);
      setShown(!shown);
      if (shown) setSelected(undefined);
      // 打开时把视野挪到看全这一天（默认关着，打开了就是要看它）
      else if (day && !day.empty) setFit({ bounds: day.bounds });
    },
    select(spot, jump) {
      setSelected(spot);
      const s = day?.spots.find((x) => x.key === spot);
      if (s && jump) setFocus({ lat: s.lat, lon: s.lon, ...(jump === "zoom" ? { zoom: SPOT_ZOOM } : {}) });
    },
    jumpTo(where) {
      setFocus({ lat: where.lat, lon: where.lon });
    },
    markClick(id) {
      if (!id.startsWith(FOOTPRINT_PREFIX)) return false;
      const spot = day?.spots.find((s) => s.markId === id);
      if (spot) setSelected(spot.key === selected ? undefined : spot.key);
      return true;
    },
  };
}

/** 地图那一块窄过这么多（像素）时，标题栏上的选日期收紧：日期写短的（11/08），概况写成"3 处 · 6 张"，"足迹"开关只剩图标 */
export const FOOTPRINT_BAR_FULL_MIN = 600;

/** 日期选择框：点了直接弹出系统的选日期（窄的时候框是透明的、盖在短日期上面） */
function openPicker(input: HTMLInputElement): void {
  try {
    input.showPicker();
  } catch {
    // 有的浏览器不让（没有这个方法、不是用户点的）：照常聚焦，键盘也能改
  }
}

/**
 * 选日期的那一组（442 追加：放进标题栏、和"地图"在一行，用户 2026-11-08 要求）：前一天、日期、后一天，这一天的概况。
 * compact 是窄的时候（手机）：日期写短的、概况写短的；"足迹"开关在标题栏最右边（FootprintToggle）
 */
export function FootprintBar({
  fp,
  wide,
  compact = false,
  listOpen,
  onList,
  listInWide = false,
  navigate,
}: {
  fp: Footprints;
  wide: boolean;
  compact?: boolean;
  listOpen: boolean;
  onList(): void;
  /** 宽的时候左边那一栏收着、关着（444）：概况那一句能点，点了打开它 */
  listInWide?: boolean;
  navigate: Navigate;
}) {
  const summary = fp.view && fp.day ? daySummary(fp.view, fp.day) : undefined;
  const shortSummary = compact && fp.view && fp.day ? daySummaryShort(fp.view, fp.day) : undefined;
  const latest = fp.view && fp.day?.empty ? latestDayBefore(fp.view.days, fp.date) : undefined;
  const note = ((): { text: string; full?: string; action?: { label: string; run(): void } } | undefined => {
    if (fp.error !== undefined) return { text: fp.error };
    if (fp.loading) return compact ? { text: t("ui.plugins.map.day.loadingShort"), full: t("ui.plugins.map.day.loading") } : { text: t("ui.plugins.map.day.loading") };
    if (!fp.view || !fp.day) return undefined;
    if (summary !== undefined) return shortSummary !== undefined ? { text: shortSummary, full: summary } : { text: summary };
    // 窄的时候：说法写短的（整句在悬停提示和读屏里）
    const empty = compact ? { text: t("ui.plugins.map.day.emptyShort"), full: t("ui.plugins.map.day.empty") } : { text: t("ui.plugins.map.day.empty") };
    if (latest !== undefined) {
      const label = compact ? t("ui.plugins.map.day.latestShort", { date: latest.slice(5) }) : t("ui.plugins.map.day.latest", { date: latest.slice(5) });
      return { ...empty, action: { label, run: () => fp.pick(latest) } };
    }
    if (!fp.view.linked.location) {
      const text = compact ? { text: t("ui.plugins.map.day.notLinkedShort"), full: t("ui.plugins.map.day.notLinked") } : { text: t("ui.plugins.map.day.notLinked") };
      return { ...text, action: { label: t("ui.plugins.map.day.goConnect"), run: () => navigate({ tab: "more", page: "data-sources", item: PHONE_LOCATION_SOURCE }) } };
    }
    return empty;
  })();
  // 窄的时候概况那一句能点：看这一天的列表；宽的时候左边那一栏收着、关着也能点：打开它
  const canList = (!wide || listInWide) && summary !== undefined && fp.shown && (fp.day?.timeline.length ?? 0) > 0;
  const date = <input className="map-day-date" type="date" value={fp.date} max={fp.today} aria-label={t("ui.plugins.map.day.date")} onChange={(e) => fp.pick(e.currentTarget.value)} onClick={compact ? (e) => openPicker(e.currentTarget) : undefined} />;
  return (
    <div className="map-day-bar" role="toolbar" aria-label={t("ui.plugins.map.day.toolbar")} data-loading={fp.loading ? "" : undefined} data-compact={compact ? "" : undefined}>
      <div className="map-day-pick">
        <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.day.prev")} title={t("ui.plugins.map.day.prev")} onClick={() => fp.pick(shiftMapDate(fp.date, -1))}>
          <Icon name="back" />
        </button>
        {compact ? (
          // 窄的时候：看得见的是短日期，系统的选日期框透明地盖在上面（点了照样弹出选日期）
          <span className="map-day-datebox">
            <span className="map-day-short" aria-hidden="true">
              {shortDateLabel(fp.date, fp.today)}
            </span>
            {date}
          </span>
        ) : (
          date
        )}
        <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.day.next")} title={t("ui.plugins.map.day.next")} disabled={fp.date >= fp.today} onClick={() => fp.pick(shiftMapDate(fp.date, 1))}>
          <Icon name="forward" />
        </button>
      </div>
      <div className="map-day-note" role="status">
        {canList ? (
          <button type="button" className="map-day-summary" aria-expanded={listOpen} aria-label={`${note?.full ?? note?.text ?? ""} · ${t("ui.plugins.map.day.showList")}`} title={note?.full} onClick={onList}>
            <span className="map-day-summary-text">{note?.text}</span>
            <Icon name={listOpen ? "up" : "down"} />
          </button>
        ) : (
          <span className="map-day-summary" data-error={fp.error === undefined ? undefined : ""} title={note?.full ?? (compact ? note?.text : undefined)}>
            {note?.text}
          </span>
        )}
        {note?.action && (
          <button type="button" className="btn small ghost" onClick={note.action.run}>
            {note.action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** "足迹"开关（放在标题栏最右边）：关了地图上不画。窄的时候只剩图标（读屏、悬停照样说"足迹"） */
export function FootprintToggle({ fp, compact = false }: { fp: Footprints; compact?: boolean }) {
  const label = t("ui.plugins.map.day.layer");
  return (
    <button
      type="button"
      className="chip map-day-layer"
      aria-pressed={fp.shown}
      aria-label={compact ? label : undefined}
      title={t("ui.plugins.map.day.layerHint")}
      data-compact={compact ? "" : undefined}
      onClick={fp.toggle}
    >
      <Icon name="pin" />
      {!compact && label}
    </button>
  );
}

/** 一处的详情：叫什么、地名、几段各几点到几点、一共待了多久、在这里拍了几张照片；没起名的能去起名 */
function SpotDetail({ spot, onClose, onFocus, navigate }: { spot: FootprintSpot; onClose?: () => void; onFocus(): void; navigate: Navigate }) {
  const total = spot.stays.length > 1;
  return (
    <div className="map-day-detail" data-spot={spot.key}>
      <div className="map-day-detail-head">
        <strong className="map-day-detail-title">{spotTitle(spot)}</strong>
        {onClose && (
          <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.day.close")} title={t("ui.plugins.map.day.close")} onClick={onClose}>
            <Icon name="cross" />
          </button>
        )}
      </div>
      {spot.name !== undefined && spot.address !== undefined && <div className="map-day-detail-sub">{spot.address}</div>}
      {spot.name === undefined && spot.address === undefined && <div className="map-day-detail-sub">{coordsLabel(spot)}</div>}
      <ul className="map-day-visits">
        {spot.stays.map((s) => (
          <li key={s.id}>
            <span className="map-day-time">{stayRange(s)}</span>
            <span>{t("ui.plugins.map.day.stayed", { duration: durationLabel(s.minutes) })}</span>
          </li>
        ))}
      </ul>
      {total && <div className="map-day-detail-sub">{t("ui.plugins.map.day.total", { duration: durationLabel(spot.minutes) })}</div>}
      {spot.photos > 0 && (
        <div className="map-day-detail-sub">
          <Icon name="image" /> {t("ui.plugins.map.day.photosHere", { count: spot.photos })}
        </div>
      )}
      <div className="map-day-detail-actions">
        <button type="button" className="btn small" onClick={onFocus}>
          {t("ui.plugins.map.day.focus")}
        </button>
        {spot.name === undefined && (
          <button type="button" className="btn small ghost" onClick={() => navigate({ tab: "more", page: "data-sources", item: PHONE_LOCATION_SOURCE })}>
            {t("ui.plugins.map.day.goName")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 这一天的列表：每段停留、不在停留里拍的照片；选中的停留在那一行下面展开详情 */
function DayList({ fp, entries, navigate }: { fp: Footprints; entries: readonly TimelineEntry[]; navigate: Navigate }) {
  const unlocated = fp.view?.unlocatedPhotos ?? 0;
  return (
    <ol className="map-day-list">
      {entries.map((e) =>
        e.kind === "stay" ? (
          <li key={e.stay.id} className="map-day-entry" data-kind="stay" data-selected={fp.selected === e.spot.key ? "" : undefined}>
            <button type="button" className="map-day-entry-btn" aria-expanded={fp.selected === e.spot.key} onClick={() => fp.select(fp.selected === e.spot.key ? undefined : e.spot.key, "pan")}>
              <span className="map-day-time">{stayRange(e.stay)}</span>
              <span className="map-day-entry-title">{spotTitle(e.spot)}</span>
              <span className="map-day-entry-sub">{durationLabel(e.stay.minutes)}</span>
            </button>
            {fp.selected === e.spot.key && e.spot.stays[0] === e.stay && <SpotDetail spot={e.spot} onFocus={() => fp.select(e.spot.key, "zoom")} navigate={navigate} />}
          </li>
        ) : (
          <li key={e.group.markId} className="map-day-entry" data-kind="photos">
            <button type="button" className="map-day-entry-btn" onClick={() => fp.jumpTo(e.group)}>
              <span className="map-day-time">{stayRange({ from: e.group.at, to: e.group.until })}</span>
              <span className="map-day-entry-title">
                <Icon name="image" /> {t("ui.plugins.map.day.photoGroup", { count: e.group.count })}
              </span>
            </button>
          </li>
        ),
      )}
      {unlocated > 0 && <li className="map-day-entry map-day-entry-note">{t("ui.plugins.map.day.unlocated", { count: unlocated })}</li>}
    </ol>
  );
}

/** 抽屉的把手往下拖多远算拖低 / 关掉、往上拖多远算拉高（像素）；挪不到这么多算点了一下 */
const DRAWER_DRAG = 40;
const DRAWER_TAP = 6;

/**
 * 窄的时候下面的抽屉（444）：顶上一条把手——往下拖拖低（只露标题那一行）、拖低了再往下拖关掉，往上拖拉高；点一下拖低 / 拉高。
 * 拖着的时候抽屉跟着手指往下走（往上不走，松手才拉高）
 */
function Drawer({ drawer, onDrawer, onClose, list, children }: { drawer: MapDrawerState; onDrawer(next: MapDrawerState): void; onClose(): void; list: boolean; children: ReactNode }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<{ y: number; id: number } | undefined>(undefined);
  const low = drawer === "low";
  const end = (e: PointerEvent<HTMLButtonElement>, cancel: boolean) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = undefined;
    setDrag(0);
    if (cancel) return;
    const dy = e.clientY - s.y;
    if (Math.abs(dy) < DRAWER_TAP) return onDrawer(low ? "normal" : "low");
    if (dy >= DRAWER_DRAG) return low ? onClose() : onDrawer("low");
    if (dy <= -DRAWER_DRAG && low) onDrawer("normal");
  };
  return (
    <div className="map-day-card" data-list={list ? "" : undefined} data-drawer={drawer} style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}>
      <button
        type="button"
        className="map-drawer-grip"
        aria-label={low ? t("ui.plugins.map.side.raise") : t("ui.plugins.map.side.lower")}
        title={low ? t("ui.plugins.map.side.raise") : t("ui.plugins.map.side.lower")}
        aria-expanded={!low}
        onPointerDown={(e) => {
          start.current = { y: e.clientY, id: e.pointerId };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (s && s.id === e.pointerId) setDrag(Math.max(0, e.clientY - s.y));
        }}
        onPointerUp={(e) => end(e, false)}
        onPointerCancel={(e) => end(e, true)}
        onKeyDown={(e) => {
          // 键盘：回车、空格由按钮的点击处理（拖低 / 拉高）
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (low) onClose();
            else onDrawer("low");
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            onDrawer("normal");
          }
        }}
        onClick={(e) => {
          // 指针点的由 onPointerUp 处理；这里只接键盘的回车、空格（detail 是 0）
          if (e.detail === 0) onDrawer(low ? "normal" : "low");
        }}
      >
        <span className="map-drawer-grip-bar" />
      </button>
      <div className="map-day-card-body">{children}</div>
    </div>
  );
}

/**
 * 盖在地图上的：宽的时候左边一栏（列表 + 详情；开着、收成左上角一个小按钮、关掉，444），
 * 窄的时候下面一张卡（选中的那一处，或者打开的列表；是能拖低、能关的抽屉，444）
 */
export function FootprintPanel({
  fp,
  wide,
  listOpen,
  onCloseList,
  panel = "open",
  onPanel,
  drawer = "normal",
  onDrawer,
  navigate,
}: {
  fp: Footprints;
  wide: boolean;
  listOpen: boolean;
  onCloseList(): void;
  panel?: MapPanelState;
  onPanel?: (next: MapPanelState) => void;
  drawer?: MapDrawerState;
  onDrawer?: (next: MapDrawerState) => void;
  navigate: Navigate;
}) {
  if (!fp.shown || !fp.day || fp.day.empty) return null;
  const day = fp.day;
  const spot = day.spots.find((s) => s.key === fp.selected);
  if (wide) {
    if (panel === "closed") return null;
    if (panel === "folded") {
      return (
        <button type="button" className="map-day-panel-tab" aria-expanded={false} aria-label={t("ui.plugins.map.side.open")} title={t("ui.plugins.map.side.open")} onClick={() => onPanel?.("open")}>
          <Icon name="layers" />
          <span>{t("ui.plugins.map.day.list")}</span>
          <span className="map-day-panel-count">{day.timeline.length}</span>
        </button>
      );
    }
    return (
      <aside className="map-day-panel" aria-label={t("ui.plugins.map.day.list")}>
        <div className="map-day-panel-head">
          <span className="map-day-panel-title">{t("ui.plugins.map.day.list")}</span>
          {onPanel && (
            <>
              <button type="button" className="icon-btn map-day-panel-fold" aria-label={t("ui.plugins.map.side.fold")} title={t("ui.plugins.map.side.fold")} onClick={() => onPanel("folded")}>
                <Icon name="collapse" />
              </button>
              <button type="button" className="icon-btn map-day-panel-close" aria-label={t("ui.plugins.map.side.close")} title={t("ui.plugins.map.side.close")} onClick={() => onPanel("closed")}>
                <Icon name="cross" />
              </button>
            </>
          )}
        </div>
        <DayList fp={fp} entries={day.timeline} navigate={navigate} />
        <div className="map-day-privacy">{t("ui.plugins.map.day.privacy")}</div>
      </aside>
    );
  }
  const setDrawer = onDrawer ?? (() => {});
  if (spot) {
    const close = () => fp.select(undefined);
    return (
      <Drawer drawer={drawer} onDrawer={setDrawer} onClose={close} list={false}>
        <SpotDetail spot={spot} onClose={close} onFocus={() => fp.select(spot.key, "zoom")} navigate={navigate} />
      </Drawer>
    );
  }
  if (listOpen) {
    return (
      <Drawer drawer={drawer} onDrawer={setDrawer} onClose={onCloseList} list>
        <div className="map-day-detail-head">
          <strong className="map-day-detail-title">{t("ui.plugins.map.day.list")}</strong>
          <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.day.close")} title={t("ui.plugins.map.day.close")} onClick={onCloseList}>
            <Icon name="cross" />
          </button>
        </div>
        <DayList fp={fp} entries={day.timeline} navigate={navigate} />
        <div className="map-day-privacy">{t("ui.plugins.map.day.privacy")}</div>
      </Drawer>
    );
  }
  return null;
}

/** 一个元素现在多宽（像素；跟着变） */
export function useWidth(ref: { readonly current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
