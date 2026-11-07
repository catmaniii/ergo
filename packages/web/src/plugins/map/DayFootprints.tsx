// 地图页的"我的足迹"（430）：标题栏下面一条选日期的，地图上画那一天的足迹（footprints.ts 整理），点停留点看详情。
// - 哪一天：地址里带了日期（#/more/map/2026-11-06，聊天里的足迹卡片点进来）看那一天；没带看今天，今天什么都没有就跳到最近有足迹的
//   一天（只跳这一次）；左右箭头前一天、后一天，中间是日期选择；
// - 取到以后把视野挪到看得全这一天（地址里带了"纬度,经度"的不挪，那是要看那一处）；
// - 标题栏右边"足迹"开关：关了地图上不画（记在这台设备的浏览器里，只是方便）；
// - 宽的时候地图左边一栏列这一天（每段停留、不在停留里拍的照片），点一行跳过去；选中的停留在那一行下面展开详情。
//   窄的时候（手机）点停留点，地图下面出一张详情卡；点概况那一句看这一天的列表；
// - 取不到（手机插件没启用、日期不对）在那一条里写为什么，地图照样能看。
// 足迹只在二狗里画，不发给任何地图服务（GET /api/map/day 是本机守护进程现算的）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import type { Navigate } from "../../app/route.ts";
import { type LatLon, localDate, type MapDayView, parseMapDayItem, parseMapFocusItem, PHONE_LOCATION_SOURCE, shiftMapDate, t } from "../../state/index.ts";
import { Icon } from "../../ui/icons.tsx";
import { coordsLabel, daySummary, durationLabel, FOOTPRINT_PREFIX, type FootprintDay, footprintDay, type FootprintSpot, latestDayBefore, spotTitle, stayRange, type TimelineEntry } from "./footprints.ts";

/** "足迹"开关记在哪（浏览器里，只是方便） */
const LAYER_KEY = "ergo-map-footprints";
/** 地图那一块宽过这么多（像素）时左边列这一天 */
export const FOOTPRINT_WIDE_MIN = 720;
/** 左边那一栏占多宽（像素，含边距；定视野时让开它） */
export const FOOTPRINT_PANEL_W = 316;
/** 定视野时右边给点旁边的字留多宽（像素） */
export const FOOTPRINT_LABEL_ROOM = 110;

function layerShown(): boolean {
  try {
    return localStorage.getItem(LAYER_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveLayer(shown: boolean): void {
  try {
    if (shown) localStorage.removeItem(LAYER_KEY);
    else localStorage.setItem(LAYER_KEY, "off");
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

/** 标题栏下面那一条：前一天、日期、后一天，这一天的概况（"足迹"开关在标题栏右边：FootprintToggle） */
export function FootprintBar({ fp, wide, listOpen, onList, navigate }: { fp: Footprints; wide: boolean; listOpen: boolean; onList(): void; navigate: Navigate }) {
  const summary = fp.view && fp.day ? daySummary(fp.view, fp.day) : undefined;
  const latest = fp.view && fp.day?.empty ? latestDayBefore(fp.view.days, fp.date) : undefined;
  const note = ((): { text: string; action?: { label: string; run(): void } } | undefined => {
    if (fp.error !== undefined) return { text: fp.error };
    if (fp.loading) return { text: t("ui.plugins.map.day.loading") };
    if (!fp.view || !fp.day) return undefined;
    if (summary !== undefined) return { text: summary };
    if (latest !== undefined) return { text: t("ui.plugins.map.day.empty"), action: { label: t("ui.plugins.map.day.latest", { date: latest.slice(5) }), run: () => fp.pick(latest) } };
    if (!fp.view.linked.location) return { text: t("ui.plugins.map.day.notLinked"), action: { label: t("ui.plugins.map.day.goConnect"), run: () => navigate({ tab: "more", page: "data-sources", item: PHONE_LOCATION_SOURCE }) } };
    return { text: t("ui.plugins.map.day.empty") };
  })();
  // 窄的时候概况那一句能点：看这一天的列表
  const canList = !wide && summary !== undefined && fp.shown && (fp.day?.timeline.length ?? 0) > 0;
  return (
    <div className="map-day-bar" role="toolbar" aria-label={t("ui.plugins.map.day.toolbar")} data-loading={fp.loading ? "" : undefined}>
      <div className="map-day-pick">
        <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.day.prev")} title={t("ui.plugins.map.day.prev")} onClick={() => fp.pick(shiftMapDate(fp.date, -1))}>
          <Icon name="back" />
        </button>
        <input className="map-day-date" type="date" value={fp.date} max={fp.today} aria-label={t("ui.plugins.map.day.date")} onChange={(e) => fp.pick(e.currentTarget.value)} />
        <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.day.next")} title={t("ui.plugins.map.day.next")} disabled={fp.date >= fp.today} onClick={() => fp.pick(shiftMapDate(fp.date, 1))}>
          <Icon name="forward" />
        </button>
      </div>
      <div className="map-day-note" role="status">
        {canList ? (
          <button type="button" className="map-day-summary" aria-expanded={listOpen} aria-label={`${note?.text ?? ""} · ${t("ui.plugins.map.day.showList")}`} onClick={onList}>
            {note?.text}
            <Icon name={listOpen ? "up" : "down"} />
          </button>
        ) : (
          <span className="map-day-summary" data-error={fp.error === undefined ? undefined : ""}>
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

/** "足迹"开关（放在标题栏右边）：关了地图上不画 */
export function FootprintToggle({ fp }: { fp: Footprints }) {
  return (
    <button type="button" className="chip map-day-layer" aria-pressed={fp.shown} title={t("ui.plugins.map.day.layerHint")} onClick={fp.toggle}>
      <Icon name="pin" />
      {t("ui.plugins.map.day.layer")}
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

/** 盖在地图上的：宽的时候左边一栏（列表 + 详情），窄的时候下面一张卡（选中的那一处，或者打开的列表） */
export function FootprintPanel({ fp, wide, listOpen, onCloseList, navigate }: { fp: Footprints; wide: boolean; listOpen: boolean; onCloseList(): void; navigate: Navigate }) {
  if (!fp.shown || !fp.day || fp.day.empty) return null;
  const day = fp.day;
  const spot = day.spots.find((s) => s.key === fp.selected);
  if (wide) {
    return (
      <aside className="map-day-panel" aria-label={t("ui.plugins.map.day.list")}>
        <div className="map-day-panel-head">{t("ui.plugins.map.day.list")}</div>
        <DayList fp={fp} entries={day.timeline} navigate={navigate} />
        <div className="map-day-privacy">{t("ui.plugins.map.day.privacy")}</div>
      </aside>
    );
  }
  if (spot) {
    return (
      <div className="map-day-card">
        <SpotDetail spot={spot} onClose={() => fp.select(undefined)} onFocus={() => fp.select(spot.key, "zoom")} navigate={navigate} />
      </div>
    );
  }
  if (listOpen) {
    return (
      <div className="map-day-card" data-list="">
        <div className="map-day-detail-head">
          <strong className="map-day-detail-title">{t("ui.plugins.map.day.list")}</strong>
          <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.day.close")} title={t("ui.plugins.map.day.close")} onClick={onCloseList}>
            <Icon name="cross" />
          </button>
        </div>
        <DayList fp={fp} entries={day.timeline} navigate={navigate} />
        <div className="map-day-privacy">{t("ui.plugins.map.day.privacy")}</div>
      </div>
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
