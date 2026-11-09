// 地图页中间那块地图（429）：按看的地方自动挑底图，几种底图之间整个换。
// - 445 起底图是"地图服务"插槽里登记的几家（网页一半 mapBasemaps：地图插件自带高德、OpenStreetMap，别的插件能再登记），按守护进程报的
//   providers 和这台设备按区域记的手动切换挑（providers.ts 的 pickBasemap）。"自动"时：看的中心在中国大陆、填了高德 Key（且高德没说
//   Key 不对、脚本加载上了）用高德；国外、香港澳门台湾、没填 Key 用 OpenStreetMap——和 429 一样；别家登记了的按优先级插进去。
//   拖、缩放停下来时按新的中心再挑一次，挑到别的就换（带着同一个中心和级别）；
// - 手动选了某家（地图切换，MapSwitch.tsx）：这个区域用它；它不能用了（Key 坏了、插件停了、这台设备加载不上）把这个区域退回"自动"，
//   说一句（fellBack）。挑完的样子（这个区域、用的谁、"自动"会挑谁、能选哪几家）报给地图页（switcher.report），地图切换照它画；
// - 外站的脚本（高德、谷歌）只在第一次真要用那一家时加载；451 起加载着的那一会儿不先画 OpenStreetMap（不再"先 OSM 再高德"地闪一下）：
//   中性的空底和一句"正在加载高德地图…"；加载失败或超时（BASEMAP_LOAD_TIMEOUT_MS）才退回 OpenStreetMap，写一句为什么（换了 Key 重试）；
//   建好以后那一家又说不能用了（446：谷歌的 gm_authFailure，引擎报 onFailed）也一样记成加载失败；
// - 没填 Key 而看的是国内：照样用 OpenStreetMap，写一句"填了高德 Key 国内地图更清楚"，点了去设置 · 数据源 · 高德地图；
// - 署名：OpenStreetMap 时右下角写"© OpenStreetMap 贡献者"（链到它的版权页）；高德地图自己画它的标志和审图号，不遮；
// - 深色：跟着页面的外观（OSM 的瓦片加滤镜，高德换深色样式）；
// - 放大、缩小的按钮在右上（手机上捏合、电脑上滚轮也行）；"回到我现在的位置"在右下（442，地图页画，LocateControl.tsx），
//   它要说的那句话（notice）放在下面那句提示的位置上；
// - 画着用户自己的足迹时也用当前地图（451，FOOTPRINTS_ON_CURRENT_MAP；11-07 定的"一律 OpenStreetMap"反过来了）；
// - 某一家查来的地点和路线（ownScene，431 的地图卡片点开）只画在那一家的地图上（高德协议 4.12.4 不许脱离它的服务展示，谷歌同样）：
//   451 起这一屏临时用那一家（不改这台设备记着的选择），地图上面写一句"这些是高德查的，用高德地图显示"；那家用不了时照常挑、
//   不画它们，写一句为什么（没填 Key 去填、它没加载上）；那家在这台设备上加载不了（设备在大陆连不上谷歌）而有这张卡的编号时，
//   地图那块放它的静态预览大图（守护进程取，和卡片同一个接口），说"这台设备连不上谷歌地图，先给你看一张图"。
// 演示页（MODE === "demo"）里瓦片是编的占位图、高德是假的（demo-amap.ts），不连任何地图服务（basemaps.ts）。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { pageTheme } from "../../app/page-theme.ts";
import { useStore } from "../../app/store.tsx";
import type { Navigate } from "../../app/route.ts";
import { AMAP_SOURCE_ID, MAP_PREVIEW_MAX_SIDE, type MapChoice, type MapConfigView, type MapPreviewQuery, type MapRegion, mapRegionOf, t } from "../../state/index.ts";
import { Icon } from "../../ui/icons.tsx";
import { type MapEngineFactory, usePlugins } from "../api.ts";
import { AMAP_BASEMAP, demoBasemapNoteText, OSM_BASEMAP, osmEngine } from "./basemaps.ts";
import type { MapEngine } from "./engine.ts";
import { previewSize, useBoxSize, useMapPreview } from "./preview.ts";
import { StaticPreview } from "./static-overlay.tsx";
import { type BasemapPage, choiceBroken, pickBasemap, priorityIn, providersOf, switchEntries } from "./providers.ts";
import type { MapScene, MapView } from "./scene.ts";

// 聊天里地图卡片的缩略图（MapThumb.tsx）从这里拿瓦片地址、演示页那句
export { demoBasemapNoteText, osmTileUrl } from "./basemaps.ts";

/** OpenStreetMap 的版权页（署名角标链过去） */
const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

/** 一家的底图最多等它加载多久（毫秒）：过了算没加载上、退回 OpenStreetMap（谷歌、高德自己的加载器也各有超时，这是兜底） */
export const BASEMAP_LOAD_TIMEOUT_MS = 20_000;

/** 一家的底图在这一页上准备到哪一步（记着准备时的 Key：换了 Key 重来） */
type Prepared = { readonly key: string | undefined; readonly state: "ready"; readonly factory: MapEngineFactory } | { readonly key: string | undefined; readonly state: "failed"; readonly reason: string };

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 页面现在是不是深色（跟着外观、系统） */
export function useDark(): boolean {
  const theme = pageTheme();
  return useSyncExternalStore(theme.subscribe, () => theme.theme() === "dark");
}

/** 地图切换里的一家：编号、名字；这台设备加载它失败了的带原因（标"连不上"） */
export interface BasemapOption {
  readonly id: string;
  readonly title: string;
  readonly failed?: string;
}

/** 地图挑完的样子（报给地图页，地图切换照它画） */
export interface BasemapStatus {
  /** 看的中心在哪个区域 */
  readonly region: MapRegion;
  /** 真画着的那一家 */
  readonly rendered: string;
  /** "自动"会挑的那一家（编号） */
  readonly auto: string;
  /** "自动"会挑的那一家的名字 */
  readonly autoTitle: string;
  /** 这个区域能手动选的几家（不含"自动"） */
  readonly options: readonly BasemapOption[];
}

/** 地图切换（445）：这台设备按区域记的手动选择、改它、收地图挑完的样子 */
export interface BasemapSwitcher {
  readonly choice: MapChoice;
  setChoice(region: MapRegion, id: string | undefined): void;
  report(status: BasemapStatus): void;
}

export interface MapCanvasProps {
  /** 地图页要的设置；还没取到是 undefined（先不画，免得先画 OSM 又换高德） */
  config: MapConfigView | undefined;
  scene: MapScene;
  /** 画着用户自己的足迹（挑底图时按 FOOTPRINTS_ON_CURRENT_MAP 走：451 起和别的一样用当前地图） */
  footprints?: boolean | undefined;
  /** 某一家查来的地点和路线（source 是那一家的编号）：这一屏临时用那一家（能用时），只在底图是它时画（在 scene 上面） */
  ownScene?: { readonly source: string; readonly scene: MapScene } | undefined;
  /** 它们的预览图按什么取（卡片编号或查到的编号，451）：那家在这台设备上加载不了时地图那块放它的静态大图 */
  ownPreview?: Pick<MapPreviewQuery, "card" | "lookup"> | undefined;
  /** 一开始看哪里 */
  initial: MapView;
  /** 跳到哪里：换了一个对象就跳（点了地点、地址里带了位置） */
  jump?: { view: MapView } | undefined;
  /** 停下来时看的是哪里（记住它） */
  onView?(view: MapView): void;
  onMarkClick?(id: string): void;
  navigate: Navigate;
  /**
   * 地图页"回到我现在的位置"（442）要说的那句话（正在找、拿不到这台设备的位置……）：放在下面那句提示的位置上，有它时先不显示提示；
   * onClose 有了才有"关上"
   */
  notice?: { text: string; onClose?: (() => void) | undefined } | undefined;
  /** 地图切换（445）；不给就一律"自动" */
  switcher?: BasemapSwitcher | undefined;
}

/** 提示那一句：文字，可能带一个按钮（去填 Key、换成某一家）、能关上 */
interface Hint {
  readonly text: string;
  readonly action?: { readonly label: string; run(): void };
  readonly onClose?: () => void;
}

export function MapCanvas({ config, scene, footprints = false, ownScene, ownPreview, initial, jump, onView, onMarkClick, navigate, notice, switcher }: MapCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | undefined>(undefined);
  /** 现在看的地方（换底图时带过去）；停下来时更新 */
  const viewRef = useRef<MapView>(initial);
  const dark = useDark();
  /** 停下来时的中心：底图按它挑、提示按它写 */
  const [settled, setSettled] = useState<MapView>(initial);
  const [prepared, setPrepared] = useState<Readonly<Record<string, Prepared>>>({});
  const loadingRef = useRef(new Set<string>());
  /** 手动选的那一家不能用了、退回了"自动"：说一句（哪个区域的哪一家） */
  const [fellBack, setFellBack] = useState<{ readonly region: MapRegion; readonly id: string }>();

  // 登记了的底图（插件停用时那一条撤掉）；version 变了重取
  const plugins = usePlugins();
  const version = plugins.version();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version 只用来在装、停之后重取
  const entries = useMemo(() => plugins.list("mapBasemaps"), [plugins, version]);
  const providers = useMemo(() => providersOf(config), [config]);
  const ready = config !== undefined;
  const region = mapRegionOf(settled);
  const keyOf = (id: string) => providers.find((p) => p.id === id)?.key;
  /** 这一页加载它失败了的原因（这个 Key 的） */
  const failedOf = (id: string): string | undefined => {
    const p = prepared[id];
    return p?.state === "failed" && p.key === keyOf(id) ? p.reason : undefined;
  };
  /** 准备好了的建引擎函数（OpenStreetMap 一直有） */
  const factoryOf = (id: string): MapEngineFactory | undefined => {
    if (id === OSM_BASEMAP) return osmEngine;
    const p = prepared[id];
    return p?.state === "ready" && p.key === keyOf(id) ? p.factory : undefined;
  };
  const page: BasemapPage = { has: (id) => entries.some((e) => e.id === id), failed: failedOf };
  const titleOf = (id: string) => entries.find((e) => e.id === id)?.title ?? providers.find((p) => p.id === id)?.title ?? id;
  const chosen = switcher?.choice[region];
  // 某一家查来的（别家只能画在自己地图上的）：这一屏临时用那一家（451）
  const ownExtra = ownScene !== undefined && ownScene.scene.marks.length + ownScene.scene.lines.length > 0;
  const pick = pickBasemap({ region, choice: chosen, providers, page, footprints, temporary: ownExtra ? ownScene.source : undefined });
  const wanted = pick.wanted;
  const renderedFactory = factoryOf(wanted);
  // 想用的那一家还在加载（451）：先不画 OpenStreetMap，空着等它（加载失败、超时才退回）
  const pending = ready && wanted !== OSM_BASEMAP && renderedFactory === undefined && failedOf(wanted) === undefined;
  const rendered = renderedFactory ? wanted : OSM_BASEMAP;
  const engineFactory = renderedFactory ?? osmEngine;
  const amapFailed = failedOf(AMAP_BASEMAP);
  const inChina = region === "mainland";
  // 真画上去的：某一家查来的只在底图是它时加上
  const ownShown = ownExtra && !pending && rendered === ownScene.source;
  // 那一家在这台设备上加载不了（设备在大陆连不上谷歌）、有这张卡的编号：地图那块放它的静态大图（451）
  const ownStatic = ownExtra && ownPreview !== undefined && failedOf(ownScene.source) !== undefined;
  const [staticFailed, setStaticFailed] = useState<string>();
  // 换了一张卡：静态大图重新取
  useEffect(() => setStaticFailed(undefined), [ownPreview?.card, ownPreview?.lookup]);
  const drawn = useMemo<MapScene>(
    () => (ownShown ? { marks: [...scene.marks, ...ownScene.scene.marks], lines: [...scene.lines, ...ownScene.scene.lines], circles: [...scene.circles, ...ownScene.scene.circles] } : scene),
    [scene, ownScene, ownShown],
  );

  // 拿最新的回调、外观、要画的东西（引擎的事件回调里用）
  const latest = useRef({ dark, scene: drawn, onView, onMarkClick });
  useEffect(() => {
    latest.current = { dark, scene: drawn, onView, onMarkClick };
  });

  // 真要用某一家时才准备它（加载外站的脚本；同一个 Key 只试一次）
  const wantedEntry = entries.find((e) => e.id === wanted);
  const wantedKey = keyOf(wanted);
  const wantedFailed = failedOf(wanted);
  useEffect(() => {
    if (!ready || wanted === OSM_BASEMAP || renderedFactory || wantedFailed !== undefined || wantedEntry === undefined) return;
    const token = `${wanted}|${wantedKey ?? ""}`;
    if (loadingRef.current.has(token)) return;
    loadingRef.current.add(token);
    const done = (next: Prepared) => setPrepared((before) => ({ ...before, [wanted]: next }));
    // 兜底的超时：加载器自己没超时、一直不回的，到点算没加载上（退回 OpenStreetMap、说一句）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(t("ui.plugins.map.loadTimeout"))), BASEMAP_LOAD_TIMEOUT_MS);
    });
    Promise.race([Promise.resolve().then(() => wantedEntry.prepare(wantedKey)), timeout])
      .finally(() => clearTimeout(timer))
      .then(
        (factory) => done({ key: wantedKey, state: "ready", factory }),
        (err: unknown) => {
          loadingRef.current.delete(token);
          done({ key: wantedKey, state: "failed", reason: reasonOf(err) });
        },
      );
  }, [ready, wanted, wantedKey, wantedEntry, renderedFactory, wantedFailed]);

  // 画地图的那一层：底图换了就整个换掉，带着同一个中心和级别；想用的那一家还在加载时空着（451：不先画 OpenStreetMap）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready || pending) return;
    const options = {
      view: viewRef.current,
      dark: latest.current.dark,
      onMoveEnd: (v: MapView) => {
        viewRef.current = v;
        latest.current.onView?.(v);
        setSettled(v);
      },
      onMarkClick: (id: string) => latest.current.onMarkClick?.(id),
      // 建好以后这一家又说不能用了（谷歌说 Key 不对）：记成这一页加载失败，下一轮退回 OpenStreetMap（446）
      onFailed: (reason: string) => {
        const id = rendered;
        const key = keyOf(id);
        setPrepared((before) => ({ ...before, [id]: { key, state: "failed", reason } }));
      },
    };
    let engine: MapEngine;
    try {
      engine = engineFactory(host, options);
    } catch (err) {
      // 脚本加载上了，但建不了地图：退回 OSM，记下为什么（下一轮再换）
      engine = osmEngine(host, options);
      const key = keyOf(rendered);
      const id = rendered;
      void Promise.resolve().then(() => setPrepared((before) => ({ ...before, [id]: { key, state: "failed", reason: reasonOf(err) } })));
    }
    engine.setDark(latest.current.dark);
    engine.setScene(latest.current.scene);
    engineRef.current = engine;
    return () => {
      viewRef.current = engine.view();
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换了底图（哪一家、准备好的那一份）、等加载开始结束时整个换
  }, [rendered, engineFactory, ready, pending]);

  useEffect(() => engineRef.current?.setScene(drawn), [drawn]);
  useEffect(() => engineRef.current?.setDark(dark), [dark]);
  // 跳过去：引擎停下来时报回来（onMoveEnd），底图按新的地方再挑
  useEffect(() => {
    if (!jump) return;
    viewRef.current = jump.view;
    engineRef.current?.setView(jump.view);
  }, [jump]);

  // 手动选的那一家不能用了（Key 坏了、插件停了、这台设备加载不上）：这个区域退回"自动"，说一句
  const broken = ready && choiceBroken(region, chosen, providers, page);
  useEffect(() => {
    if (!broken || chosen === undefined || switcher === undefined) return;
    setFellBack({ region, id: chosen });
    switcher.setChoice(region, undefined);
  }, [broken, chosen, region, switcher]);
  // 这个区域又手动选了别的：那一句不用再说
  useEffect(() => {
    if (fellBack !== undefined && fellBack.region === region && chosen !== undefined && chosen !== fellBack.id) setFellBack(undefined);
  }, [chosen, fellBack, region]);
  /** 那一句只在退回的那个区域、还是"自动"时说 */
  const fellBackShown = fellBack !== undefined && fellBack.region === region && chosen === undefined ? fellBack.id : undefined;

  // 挑完的样子报给地图页（地图切换照它画）
  const options = switchEntries(region, providers, page).map((e) => ({ ...e, title: titleOf(e.id) }));
  const autoTitle = titleOf(pick.auto);
  const optionsKey = options.map((o) => `${o.id}:${o.title}:${o.failed ?? ""}`).join("|");
  const report = switcher?.report;
  // 还在加载的那一会儿报想用的那一家（秘书的查询跟着它走）
  const reported = pending ? wanted : rendered;
  useEffect(() => {
    if (!ready || report === undefined) return;
    report({ region, rendered: reported, auto: pick.auto, autoTitle, options });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options 按 optionsKey 认（每次渲染都是新数组）
  }, [ready, report, region, reported, pick.auto, autoTitle, optionsKey]);

  const settingsAction = { label: t("ui.plugins.map.hint.goSettings"), run: () => navigate({ tab: "more", page: "data-sources", item: AMAP_SOURCE_ID }) };

  /** 某一家查来的画不上去：为什么（它还在加载的那一会儿不写；451 起能用时这一屏临时用它，不再有"换成它"） */
  const ownHint = (source: string): Hint | undefined => {
    const name = titleOf(source);
    const amap = source === AMAP_BASEMAP;
    const failed = failedOf(source);
    if (failed !== undefined) {
      // 有静态大图顶着：说"先给你看一张图"（大图也取不到时才说画不上去）
      if (ownStatic && staticFailed === undefined) return { text: t("ui.plugins.map.hint.ownStatic", { name }) };
      return { text: amap ? t("ui.plugins.map.hint.amapOnlyFailed", { reason: failed }) : t("ui.plugins.map.hint.ownOnlyFailed", { name, reason: failed }) };
    }
    const p = providers.find((x) => x.id === source);
    if (p === undefined || !p.manualRegions.includes(region)) return { text: amap ? t("ui.plugins.map.hint.amapOnlyAbroad") : t("ui.plugins.map.hint.ownOnlyElsewhere", { name }) };
    if (!p.ready || !page.has(source)) return amap ? { text: t("ui.plugins.map.hint.amapOnlyNoKey"), action: settingsAction } : { text: t("ui.plugins.map.hint.ownOnlyUnavailable", { name }) };
    return undefined;
  };

  const hint = ((): Hint | undefined => {
    if (!ready || pending) return undefined;
    if (fellBackShown !== undefined) return { text: t("ui.plugins.map.switch.fellBack", { name: titleOf(fellBackShown) }), onClose: () => setFellBack(undefined) };
    // 某一家查来的没画上（那家用不了、这台设备加载不了它）：不管现在画着谁都说一句
    if (ownExtra && !ownShown) return ownHint(ownScene.source);
    if (rendered === OSM_BASEMAP && amapFailed !== undefined) return { text: t("ui.plugins.map.hint.amapFailed", { reason: amapFailed }) };
    // 照"自动"画着的时候，这个区域排在它前面的（别家登记的）没加载上：先用现在这家，说一句
    // （451：国外谷歌没加载上时先用高德；按这个区域的优先级比）
    if (!pick.manual && !pick.temporary) {
      const autoPriority = priorityIn(providers.find((p) => p.id === pick.auto) ?? { priority: 0 }, region);
      const ahead = providers
        .filter((p) => p.basemap && p.ready && p.regions.includes(region) && page.has(p.id) && priorityIn(p, region) > autoPriority)
        .toSorted((a, b) => priorityIn(b, region) - priorityIn(a, region))
        .find((p) => p.id !== AMAP_BASEMAP && failedOf(p.id) !== undefined);
      if (ahead !== undefined) {
        const reason = failedOf(ahead.id) ?? "";
        return rendered === OSM_BASEMAP
          ? { text: t("ui.plugins.map.hint.providerFailed", { name: titleOf(ahead.id), reason }) }
          : { text: t("ui.plugins.map.hint.providerFailedNext", { name: titleOf(ahead.id), reason, next: titleOf(rendered) }) };
      }
    }
    if (rendered !== OSM_BASEMAP) return undefined;
    if (!inChina) return undefined;
    if (config.amapProblem) return { text: t("ui.plugins.map.hint.amapProblem", { problem: config.amapProblem }), action: settingsAction };
    if (config.amapKey === undefined) return { text: t("ui.plugins.map.hint.noKey"), action: settingsAction };
    return undefined;
  })();

  const entryTitle = titleOf(rendered);
  // 这一屏临时用查它的那一家（451）：地图上面写一句（不改记着的选择）
  const temporaryNote = ownShown && pick.temporary ? t("ui.plugins.map.hint.ownTemporary", { name: titleOf(ownScene.source) }) : undefined;
  const staticShown = ownStatic && staticFailed === undefined;
  return (
    <div
      className="map-canvas"
      data-basemap={ready && !pending ? rendered : "loading"}
      data-pending={pending ? wanted : undefined}
      data-choice={chosen ?? "auto"}
      data-temporary={pick.temporary ? wanted : undefined}
      data-amap={factoryOf(AMAP_BASEMAP) ? "ready" : amapFailed !== undefined ? "failed" : "idle"}
      data-own-results={ownExtra ? (ownShown ? "shown" : staticShown ? "static" : "hidden") : undefined}
      data-amap-results={ownExtra && ownScene.source === AMAP_BASEMAP ? (ownShown ? "shown" : "hidden") : undefined}
    >
      <div className="map-host" ref={hostRef} />
      {!ready && <div className="map-loading">{t("ui.plugins.map.loading")}</div>}
      {pending && (
        <div className="map-loading map-loading-basemap" data-loading={wanted}>
          {t("ui.plugins.map.loadingMap", { name: titleOf(wanted) })}
        </div>
      )}
      {staticShown && <OwnStaticPreview query={ownPreview} scene={ownScene.scene} name={titleOf(ownScene.source)} dark={dark} onFailed={setStaticFailed} />}
      {!pending && !staticShown && (
        <span className="map-badge" data-basemap={rendered}>
          {entryTitle}
        </span>
      )}
      {temporaryNote !== undefined && (
        <div className="map-own-note" role="status">
          {temporaryNote}
        </div>
      )}
      {/* 盖着静态大图时不能放大缩小（451） */}
      {!staticShown && (
        <div className="map-zoom">
          <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.zoomIn")} title={t("ui.plugins.map.zoomIn")} onClick={() => engineRef.current?.zoomBy(1)}>
            <Icon name="plus" />
          </button>
          <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.zoomOut")} title={t("ui.plugins.map.zoomOut")} onClick={() => engineRef.current?.zoomBy(-1)}>
            <Icon name="minus" />
          </button>
        </div>
      )}
      {notice && (
        <div className="map-hint map-locate-note" role="status">
          <span>{notice.text}</span>
          {notice.onClose && (
            <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.locate.close")} title={t("ui.plugins.map.locate.close")} onClick={notice.onClose}>
              <Icon name="cross" />
            </button>
          )}
        </div>
      )}
      {hint && !notice && (
        <div className="map-hint" role="status" data-fell-back={fellBackShown === undefined ? undefined : ""}>
          <span>{hint.text}</span>
          {hint.action && (
            <button type="button" className="btn small" onClick={hint.action.run}>
              {hint.action.label}
            </button>
          )}
          {hint.onClose && (
            <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.switch.closeNote")} title={t("ui.plugins.map.switch.closeNote")} onClick={hint.onClose}>
              <Icon name="cross" />
            </button>
          )}
        </div>
      )}
      {rendered === OSM_BASEMAP && !pending && !staticShown && (
        <div className="map-attribution">
          <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noopener noreferrer">
            © OpenStreetMap
          </a>{" "}
          {t("ui.plugins.map.osmContributors")}
          {demoBasemapNoteText && <span className="map-demo-note"> · {demoBasemapNoteText()}</span>}
        </div>
      )}
      {rendered !== OSM_BASEMAP && !pending && !staticShown && demoBasemapNoteText && <div className="map-attribution">{demoBasemapNoteText()}</div>}
    </div>
  );
}

/**
 * 那一家在这台设备上加载不了时，盖在地图那块上的静态大图（451）：和卡片同一个接口（GET /api/map/preview），按地图那块的大小要
 * （最大 1024，各家再按自己的上限缩），高清；取不到告诉地图那块（退回原来的那句"画不上去"）。
 * 453 起那张是光底图，查到的点和线照回应头里的视野在本机画上去（static-overlay.tsx）
 */
function OwnStaticPreview({ query, scene, name, dark, onFailed }: { query: Pick<MapPreviewQuery, "card" | "lookup">; scene: MapScene; name: string; dark: boolean; onFailed(reason: string): void }) {
  const { http } = useStore();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const box = useBoxSize(el);
  const size = box.width > 0 ? previewSize(box.width, box.height, MAP_PREVIEW_MAX_SIDE) : undefined;
  const preview = useMapPreview(http, size === undefined ? undefined : { ...query, width: size.width, height: size.height, dark, scale: size.scale });
  const failed = preview?.state === "failed" ? preview.reason : undefined;
  useEffect(() => {
    if (failed !== undefined) onFailed(failed);
  }, [failed, onFailed]);
  return (
    <div className="map-static" ref={setEl} data-preview={preview?.state ?? "loading"}>
      {preview?.state === "ready" ? <StaticPreview url={preview.url} view={preview.view} scene={scene} alt={name} /> : <div className="map-loading">{t("ui.plugins.map.card.previewLoading")}</div>}
    </div>
  );
}
