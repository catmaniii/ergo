// 地图页的"回到我现在的位置"（442）：右下角一个按钮（高德、OpenStreetMap 两种底图上都有、样子一样，跟着风格和深浅），
// 点了取现在的位置（locate.ts：鸿蒙 App 的原生定位 → 浏览器定位 → 手机最近交来的点）、挪过去放大到街道级、画蓝点和精度圈；
// 一分钟内再点直接回到那里。拿不到这台设备的位置时地图下面说一句（用了手机的点写是多久以前交来的，都没有说拿不到）。
// 不在大陆时底图照 429 的规则自动换成 OpenStreetMap（挪过去之后地图停下来，MapView.tsx 按新的中心挑底图）。
// 位置只在这个页面的内存里：不存、不发给二狗以外的地方（只有退路那一步问这台电脑上的二狗要手机最近交来的点）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import { pageNativeApp } from "../../app/page-native.ts";
import { t } from "../../state/index.ts";
import { Icon } from "../../ui/icons.tsx";
import { type BrowserGeolocation, fixIsFresh, type HereFix, hereLabel, hereScene, locateMe, locateNote, locateView } from "./locate.ts";
import type { MapScene, MapView } from "./scene.ts";

/** 浏览器定位：有这个接口、是安全上下文（本机、https、file://）才给；局域网的 http 地址浏览器不给定位 */
function pageGeolocation(): BrowserGeolocation | undefined {
  if (typeof window === "undefined" || !window.isSecureContext) return undefined;
  return typeof navigator !== "undefined" && "geolocation" in navigator ? navigator.geolocation : undefined;
}

export interface Here {
  /** 地图上要加的：蓝点、精度圈（还没定过是空的） */
  readonly scene: MapScene;
  /** 正在取 */
  readonly busy: boolean;
  /** 要说的那句话（取着的时候是"正在找"）；没有是 undefined */
  readonly note: string | undefined;
  closeNote(): void;
  /** 点了按钮 */
  locate(): void;
}

/**
 * 取现在的位置、记着定到的那一点。size 是地图那块现在能用的像素大小（算放大到几级），jump 挪过去
 * （地图页按左边那一栏让开一点；记"上次看哪里"时跳过这一下）
 */
export function useHere(http: Pick<DaemonHttp, "mapLatest">, size: () => { width: number; height: number }, jump: (view: MapView) => void): Here {
  const [fix, setFix] = useState<HereFix>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const fixRef = useRef<HereFix | undefined>(undefined);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const latest = useRef({ http, size, jump });
  useEffect(() => {
    latest.current = { http, size, jump };
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const go = useCallback((f: HereFix) => {
    const s = latest.current.size();
    latest.current.jump(locateView(f, s.width, s.height));
  }, []);

  const locate = useCallback(() => {
    if (busyRef.current) return;
    // 一分钟内在这台设备上定过：直接回到那里
    const prev = fixRef.current;
    if (prev && fixIsFresh(prev, Date.now())) {
      setNote(undefined);
      go(prev);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNote(t("ui.plugins.map.locate.busy"));
    const places = pageNativeApp()?.phone?.places;
    void locateMe({
      appHere: places ? () => places.here() : undefined,
      geolocation: pageGeolocation(),
      latest: () => latest.current.http.mapLatest(),
      now: () => Date.now(),
    }).then((outcome) => {
      busyRef.current = false;
      if (!alive.current) return;
      setBusy(false);
      setNote(locateNote(outcome, Date.now()));
      if (outcome.fix) {
        fixRef.current = outcome.fix;
        setFix(outcome.fix);
        go(outcome.fix);
      }
    });
  }, [go]);

  // 手机交来的点旁边写的字（几点交来的）每次渲染现取（跟着界面语言），地图上的东西只在点或字变了时换
  const label = hereLabel(fix);
  const scene = useMemo(() => hereScene(fix, label), [fix, label]);
  const closeNote = useCallback(() => setNote(undefined), []);
  return { scene, busy, note, closeNote, locate };
}

/** 右下角那个按钮 */
export function LocateButton({ here }: { here: Here }) {
  const label = t("ui.plugins.map.locate.button");
  return (
    <div className="map-locate">
      <button
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-busy={here.busy || undefined}
        data-located={here.scene.marks.length > 0 ? "" : undefined}
        onClick={here.locate}
      >
        <Icon name="locate" />
      </button>
    </div>
  );
}

/**
 * 窄的时候足迹的详情卡、列表卡（.map-day-card）盖在地图下面：量它多高，挂在地图那块上（--map-dock），
 * 右下角的按钮、下面那句话跟着往上让；也交回这个高度（右下角的二狗按钮照它让，444）
 */
export function useDockInset(stageRef: { readonly current: HTMLElement | null }): number {
  const [dock, setDock] = useState(0);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    let card: Element | null = null;
    const measure = () => {
      const h = card ? Math.round(card.getBoundingClientRect().height) : 0;
      // 卡片底边离地图底边 28 像素、钮离 36：让开卡片的高度，正好在卡片上面 8 像素
      stage.style.setProperty("--map-dock", `${h}px`);
      setDock(h);
    };
    const resize = new ResizeObserver(measure);
    const find = () => {
      const next = stage.querySelector(":scope > .map-day-card");
      if (next !== card) {
        if (card) resize.unobserve(card);
        card = next;
        if (card) resize.observe(card);
      }
      measure();
    };
    // 卡片是地图那块的直接子元素：只看这一层的增删（瓦片、点都在更里面，不看）
    const mutations = new MutationObserver(find);
    mutations.observe(stage, { childList: true });
    find();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      stage.style.removeProperty("--map-dock");
    };
  }, [stageRef]);
  return dock;
}
