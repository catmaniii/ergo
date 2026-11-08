// 地图页（429，#/more/map[/<纬度>,<经度>[,<级别>]]）：上面一条标题栏，下面整块是地图（MapView.tsx）。
// - 一开始看哪里：地址里带了位置看那里；没带看这台设备上次看的地方（存在浏览器里，只是方便）；都没有看整个中国；
// - 演示页：上面一排两个地点（国内一处、新加坡一处），点了跳过去、底图跟着换，地图上标着它们；
// - 地图上的东西（MapScene）：429 只有演示页的两个地点；430 我的足迹、431 聊天里的地图卡片、432 高德查到的地点和路线往里放。
// - 我的足迹（430，DayFootprints.tsx）：标题栏里选日期的那一组（442 追加：和"地图"、"足迹"开关一行，不再单独一条；窄的时候写短的），
//   地图上画那一天的轨迹、停留、照片、常去的地方，点停留点看详情；地址里可以带日期（#/more/map/<YYYY-MM-DD>）。
// - 聊天里的地图卡片点开（431，#/more/map/card/<卡片编号>）：从手里的卡片状态取出这张卡，画它的点、线（和卡片同一份 card-scene.ts），
//   视野挪到看全它；标题栏下面一条写卡片的标题和概况，"×"回到足迹。看卡片时不画足迹。高德（445 起别家）查来的只在底图是那一家时画
//   （amap-results.ts）。
// - 地图切换（445，MapSwitch.tsx）：标题栏右边那一格（.map-bar-tools）的最前面，"地图：自动 / 高德 / OpenStreetMap……"，宽的时候一个下拉、窄的时候收进 ⋮；
//   按区域记在这台设备上，地图那块（MapCanvas）照它挑底图、报回现在的样子。
// - 回到我现在的位置（442，LocateControl.tsx）：地图右下角一个按钮，两种底图都有；定到的蓝点、精度圈压在最上面。
//   位置不存：记"上次看哪里"时跳过定位挪过去的那一下。
// - 地图页的二狗（444）：标题栏最右边一个二狗按钮开合右边的聊天窗（MapChat.tsx，秘书本人，和浏览侧边栏同一个东西）——地图页够宽（≥ 600）时
//   挤压地图（地图 | 分隔条 | 聊天窗，分隔条能拖，宽度这台设备记住，和浏览侧边栏同一套 Splitter 和宽度规矩），窄的时候整屏盖住地图页；
//   开合记在这台设备上（map-layout.ts）。聊天窗关着时地图右下角一个二狗悬浮按钮（MapFab.tsx，和浏览里的悬浮按钮同一个按钮、同一套规矩），
//   点一下打字、按住说话，气泡里能"展开到右边"；"回到我现在的位置"排在它上面。聊天窗、悬浮按钮发的消息都带地图上下文（mapContext：
//   现在看的中心、缩放、底图、看哪一天的足迹或哪张卡片）；
// - 标题栏省空间（444 接着 442）："足迹"关着时不放选日期的那一组（只剩"地图"、"足迹"开关、二狗按钮）；看聊天里的地图卡片时，卡片的
//   标题和概况也挪进标题栏（原来是标题栏下面单独一条）；
// - 左边的面板能收起、关掉（444）：宽的时候这一天的列表收成左上角一个小按钮、或者关掉（点标题栏上这一天的概况再打开），窄的时候
//   下面的卡片是能拖低、能关的抽屉；都记在这台设备上（map-layout.ts）。
// 直接显示在导航里（MapSection）和收进"更多"（MapColumn）画的是同一页，后者左上角有返回。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { pageVoicePlayer } from "../../app/page-voice.ts";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { clampChatSideWidth } from "../../app/stage-side-width.ts";
import { pageVoiceOver } from "../../app/talk-button.ts";
import { browserVoiceEnv } from "../../app/voice-browser.ts";
import { NativeVoiceRecorder } from "../../app/voice-native-recorder.ts";
import { VoiceRecorder } from "../../app/voice-recorder.ts";
import { buttonTurnOf, CHANNELS, type MapCardPayload, type MapConfigView, type MapContext, mapCardTitle, parseMapCardPath, parseMapFocusItem, t } from "../../state/index.ts";
import { Splitter, TopBar } from "../../ui/common.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useDraggedSideWidth } from "../../ui/side-width.ts";
import { type PageColumnProps, type PageSectionProps, usePlugins } from "../api.ts";
import { FOOTPRINT_BAR_FULL_MIN, FOOTPRINT_LABEL_ROOM, FOOTPRINT_PANEL_W, FOOTPRINT_WIDE_MIN, FootprintBar, FootprintPanel, FootprintToggle, useFootprints, useWidth } from "./DayFootprints.tsx";
import { contentSummary } from "./card-scene.ts";
import { shiftViewRight, shortDateLabel, spotTitle, withFootprints } from "./footprints.ts";
import { LocateButton, useDockInset, useHere } from "./LocateControl.tsx";
import { MapChat, MapChatToggle } from "./MapChat.tsx";
import { MapFab } from "./MapFab.tsx";
import { pageMapChatWidth, pageMapLayout } from "./map-layout.ts";
import { MapTalk } from "./map-talk.ts";
import { withHere } from "./locate.ts";
import { useMapCardData } from "./MapCard.tsx";
import { MapSwitch, useBasemapSwitch } from "./MapSwitch.tsx";
import { lookupBasemap } from "./providers.ts";
import { MapCanvas } from "./MapView.tsx";
import { DEFAULT_VIEW, EMPTY_SCENE, type MapScene, type MapView, parseSavedView, viewToFit } from "./scene.ts";
import { demoMapPlaces } from "../../prototype/fake-map.ts";

/** 这台设备上次看的地方存在哪（浏览器里，只是方便） */
const SAVED_VIEW_KEY = "ergo-map-view";

/** 演示页的两个地点（安装版这个分支摇掉） */
const demoPlaces = () => (import.meta.env.MODE === "demo" ? demoMapPlaces() : []);

function savedView(): MapView | undefined {
  try {
    return parseSavedView(localStorage.getItem(SAVED_VIEW_KEY));
  } catch {
    return undefined;
  }
}

function saveView(view: MapView): void {
  try {
    localStorage.setItem(SAVED_VIEW_KEY, JSON.stringify({ lat: Number(view.lat.toFixed(6)), lon: Number(view.lon.toFixed(6)), zoom: Number(view.zoom.toFixed(2)) }));
  } catch {
    // 存不了（隐私模式）就算了
  }
}

/** 两个视野差不多是同一处（不到 1 米、同一级）：定位挪过去之后地图报回来的那一下（换底图时来回转坐标差几厘米） */
function sameView(a: MapView, b: MapView | undefined): boolean {
  return b !== undefined && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5 && Math.abs(a.zoom - b.zoom) < 0.01;
}

/** 地图页够宽（像素）时聊天窗挤压地图（分栏），窄的时候整屏盖住地图页 */
export const MAP_CHAT_SPLIT_MIN = 600;

/** 经度绕回 -180–180（OpenStreetMap 往东西拖过了头） */
const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 页面上那一份布局（聊天窗开合、左边那一栏、下面的抽屉），改了跟着变 */
function useMapLayout() {
  const layout = pageMapLayout();
  return { layout, view: useSyncExternalStore(layout.subscribe, layout.snapshot) };
}

/**
 * 右下角二狗按钮背后的那一份（map-talk.ts）：录音接到"按住说话"的同一套后端（App 里是原生录音器），识别走内核的 POST /api/talk-voice
 * （和浏览的悬浮按钮同一段识别、剔串词，conversation/talk-voice.ts；只依赖语音插件，浏览插件停用照样能说），
 * 发进秘书主会话（带地图上下文）；能不能说话跟着输入框的语音插槽（语音插件登记的）；离开地图页时收起、放掉录音器
 */
function useMapTalk(context: () => Omit<MapContext, "via" | "spoken">): MapTalk {
  const { http, ui, sendMessage } = useStore();
  const [talk] = useState(() => {
    const env = browserVoiceEnv();
    return new MapTalk({
      voice: pageVoiceOver(
        () => (env.native ? new NativeVoiceRecorder(env.native, env.now, { log: env.micLog, onTrouble: () => {} }) : new VoiceRecorder(env.media, env.now, { log: env.micLog })),
        env.now,
      ),
      // 内核的识别接口（POST /api/talk-voice）：只依赖语音插件，不经浏览插件
      recognize: (audio) => http.talkVoice({ audio }),
      context,
      // 按着二狗按钮说话：二狗正在播的语音暂停（和聊天窗口里按住说话同一个播放器，地图的按钮单算一处）
      capture: (on) => pageVoicePlayer().setCapturing(on, "map-button"),
    });
  });
  // 发的时候现取地图上下文：每次渲染换上最新的那个函数
  useEffect(() => talk.setContext(context));
  useEffect(() => {
    talk.connect({ say: (text, map) => sendMessage(CHANNELS.secretary, [{ type: "text", text }], undefined, undefined, map) });
  }, [talk, sendMessage]);
  useEffect(() => talk.secretaryChanged((key) => buttonTurnOf(ui, key)), [talk, ui]);
  const voice = usePlugins().list("composerVoice").length > 0;
  useEffect(() => talk.setVoice(voice), [talk, voice]);
  useEffect(() => () => talk.hidden(), [talk]);
  return talk;
}

/** 地址里的位置 → 看哪里（没写级别看 15 级） */
function focusOf(item: string | undefined): MapView | undefined {
  const f = parseMapFocusItem(item);
  return f ? { lat: f.lat, lon: f.lon, zoom: f.zoom ?? 15 } : undefined;
}

function MapScreen({ item, sub, navigate, onBack }: { item: string | undefined; sub: string | undefined; navigate: Navigate; onBack: (() => void) | undefined }) {
  const { http, ui } = useStore();
  const [config, setConfig] = useState<MapConfigView>();
  const places = useMemo(() => demoPlaces(), []);
  const [initial] = useState<MapView>(() => focusOf(item) ?? (places[0] ? { lat: places[0].lat, lon: places[0].lon, zoom: places[0].zoom } : (savedView() ?? DEFAULT_VIEW)));
  // 跳到哪里：点了地点、地址里的位置变了（聊天里的地图卡片点进来）。地址变了在渲染时就换（React 推荐的"跟着 props 调 state"的写法）
  const [jump, setJump] = useState<{ view: MapView }>();
  const [lastItem, setLastItem] = useState(item);
  if (item !== lastItem) {
    setLastItem(item);
    const f = focusOf(item);
    if (f) setJump({ view: f });
  }

  useEffect(() => {
    let alive = true;
    http.mapConfig().then(
      (c) => alive && setConfig(c),
      // 取不到（插件刚停用、断线）：当作没填 Key，照样能看 OpenStreetMap
      () => alive && setConfig({}),
    );
    return () => {
      alive = false;
    };
  }, [http]);

  const base = useMemo<MapScene>(() => (places.length === 0 ? EMPTY_SCENE : { marks: places.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, label: p.label, kind: "place" as const })), lines: [], circles: [] }), [places]);

  // 我的足迹：取到一天就把视野挪到看得全它（宽的时候让开左边那一栏，右边给点旁边的字留地方），点了列表里的一行挪过去
  const fp = useFootprints(http, item);
  // 地图切换（445）：这台设备按区域记的手动选择、地图那块报回来的样子
  const basemapSwitch = useBasemapSwitch();
  const pageRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageWidth = useWidth(pageRef);
  const stageWidth = useWidth(stageRef);
  const wide = stageWidth >= FOOTPRINT_WIDE_MIN;
  // 标题栏横跨整页（聊天窗开着也是）：按整页的宽度收
  const barCompact = pageWidth < FOOTPRINT_BAR_FULL_MIN;
  const [listOpen, setListOpen] = useState(false);
  // 聊天窗开合、左边那一栏收起 / 关掉、下面的抽屉拖低（444，记在这台设备上）
  const { layout, view: layoutView } = useMapLayout();
  const split = pageWidth >= MAP_CHAT_SPLIT_MIN;
  const chatOpen = layoutView.chatOpen && pageWidth > 0;
  const chatWidth = useDraggedSideWidth(pageMapChatWidth());
  const chatShownWidth = clampChatSideWidth(chatWidth.width, pageWidth);
  /** 左边那一栏开着（定视野时让开它）：拿最新的（挪视野的 effect 里用，不因为它重挪） */
  const panelOpen = useRef(layoutView.panel === "open");
  useEffect(() => {
    panelOpen.current = layoutView.panel === "open";
  });
  /** 现在看的是哪里（只挪不缩放时用它的级别） */
  const viewNow = useRef<MapView>(initial);
  // 聊天里的地图卡片点开（431）：这张卡画什么
  const cardId = parseMapCardPath(item, sub);
  const cardState = cardId === undefined ? undefined : ui.cards[cardId];
  const cardPayload = cardState?.card.type === "map" ? (cardState.card.payload as MapCardPayload) : undefined;
  const cardData = useMapCardData(http, cardPayload?.show);
  const cardContent = cardData?.state === "ready" ? cardData.content : undefined;
  useEffect(() => {
    if (!cardContent) return;
    const el = stageRef.current;
    const v = viewToFit(cardContent.bounds, (el?.clientWidth ?? 390) - FOOTPRINT_LABEL_ROOM, el?.clientHeight ?? 600);
    if (v) setJump({ view: shiftViewRight(v, -FOOTPRINT_LABEL_ROOM / 2) });
  }, [cardContent]);

  useEffect(() => {
    // 看卡片时不挪到足迹；关了卡片（回到 #/more/map）再挪回来
    if (!fp.fit || cardId !== undefined) return;
    const el = stageRef.current;
    const panel = el && el.clientWidth >= FOOTPRINT_WIDE_MIN && panelOpen.current ? FOOTPRINT_PANEL_W : 0;
    const v = viewToFit(fp.fit.bounds, (el?.clientWidth ?? 390) - panel - FOOTPRINT_LABEL_ROOM, el?.clientHeight ?? 600);
    if (v) setJump({ view: shiftViewRight(v, (panel - FOOTPRINT_LABEL_ROOM) / 2) });
  }, [fp.fit, cardId]);
  useEffect(() => {
    if (!fp.focus) return;
    const el = stageRef.current;
    const panel = el && el.clientWidth >= FOOTPRINT_WIDE_MIN && panelOpen.current ? FOOTPRINT_PANEL_W : 0;
    setJump({ view: shiftViewRight({ lat: fp.focus.lat, lon: fp.focus.lon, zoom: fp.focus.zoom ?? viewNow.current.zoom }, panel / 2) });
  }, [fp.focus]);
  // 看卡片时画卡片（高德、别家查来的另交给 ownScene：只在底图是那一家时画），不画足迹
  const showCard = cardId !== undefined;
  // "回到我现在的位置"（442）：挪过去时宽的、左边列着这一天时让开那一栏；挪过去的那一下不记成"上次看哪里"（位置不存）
  const panelShown = !showCard && fp.shown && fp.day !== undefined && !fp.day.empty && layoutView.panel === "open";
  const locateJump = useRef<MapView | undefined>(undefined);
  const here = useHere(
    http,
    () => {
      const el = stageRef.current;
      const width = el?.clientWidth ?? 390;
      return { width: width - (panelShown && width >= FOOTPRINT_WIDE_MIN ? FOOTPRINT_PANEL_W : 0), height: el?.clientHeight ?? 600 };
    },
    (v) => {
      const el = stageRef.current;
      const panel = panelShown && el && el.clientWidth >= FOOTPRINT_WIDE_MIN ? FOOTPRINT_PANEL_W : 0;
      const view = shiftViewRight(v, panel / 2);
      locateJump.current = view;
      setJump({ view });
    },
  );
  const dock = useDockInset(stageRef);
  const scene = useMemo(
    () =>
      withHere(
        showCard ? withFootprints(base, cardContent && !cardContent.amapOnly ? cardContent.scene : undefined) : withFootprints(base, fp.shown ? fp.day?.scene : undefined),
        here.scene,
      ),
    [base, showCard, cardContent, fp.shown, fp.day, here.scene],
  );
  const ownScene = cardContent?.ownBasemap === undefined ? undefined : { source: cardContent.ownBasemap, scene: cardContent.scene };
  // "足迹"开着就当画着足迹（还没取到、这一天空着也算）：底图一律 OpenStreetMap，也不为它加载高德的脚本（scene.ts 的 AMAP_WITH_FOOTPRINTS）；
  // 看的是足迹卡也一样（按卡上写的认，不等取到）
  const footprintsDrawn = showCard ? cardPayload?.show.kind === "day" : fp.shown;
  const cardTitle = cardPayload ? mapCardTitle(cardPayload) : undefined;
  const cardNote = cardId === undefined ? undefined : cardState === undefined ? t("ui.plugins.map.card.missing") : cardData ? contentSummary(cardData) : undefined;

  // 聊天窗、二狗按钮发的消息带的地图上下文：这一刻看的中心、缩放、底图、看哪一天的足迹或哪张卡片；不带"回到我现在的位置"定到的点。
  // 底图是地图服务插槽（445）里那一家的编号——地图那块报给地图切换的"真画着的那一家"（basemapSwitch.status.rendered），
  // 秘书照它把查询工具的 map 写成这一家（查询跟着地图走）；还没画上是 loading。画着足迹时底图固定 OpenStreetMap，这里不跟着写 osm，
  // 写这个区域手动选的那家、没选过按"自动"（国内即高德，providers.ts 的 lookupBasemap，用户 2026-11-08 定）。
  // 它是 state，变了就重渲染、这个函数跟着换新的
  const mapContext = (): Omit<MapContext, "via" | "spoken"> => {
    const v = viewNow.current;
    const status = basemapSwitch.status;
    const basemap = status === undefined ? "loading" : lookupBasemap(status, basemapSwitch.choice, footprintsDrawn);
    const spot = fp.day?.spots.find((x) => x.key === fp.selected);
    return {
      lat: clamp(v.lat, -90, 90),
      lon: clamp(wrapLon(v.lon), -180, 180),
      zoom: clamp(v.zoom, 0, 22),
      basemap: basemap.slice(0, 32),
      ...(cardId !== undefined
        ? { card: { id: cardId.slice(0, 64), ...(cardTitle ? { title: cardTitle.slice(0, 120) } : {}) } }
        : fp.shown
          ? { footprints: { date: fp.date, ...(spot ? { spot: spotTitle(spot).slice(0, 120) } : {}) } }
          : {}),
    };
  };
  const talk = useMapTalk(mapContext);
  // 聊天窗顶上"现在在看"：地图 · 这张卡片、这一天的足迹
  const watching =
    cardId !== undefined
      ? t("ui.plugins.map.chat.watchingCard", { title: cardTitle ?? t("ui.plugins.map.card.bar") })
      : fp.shown
        ? t("ui.plugins.map.chat.watchingDay", { date: shortDateLabel(fp.date, fp.today) })
        : t("ui.plugins.map.chat.watchingMap");
  const toggleChat = () => layout.setChatOpen(!layoutView.chatOpen);

  const chat = chatOpen && <MapChat watching={watching} context={mapContext} cover={!split} onClose={() => layout.setChatOpen(false)} />;
  return (
    <div className="chat-col map-page" ref={pageRef} data-chat={chatOpen ? (split ? "split" : "cover") : undefined}>
      {/* 一行（442、444、445）：返回、"地图"、选日期的那一组（"足迹"开着时）或看着的卡片、最右边地图切换、"足迹"开关和二狗按钮 */}
      <TopBar title={t("ui.plugins.map.title")} onBack={onBack}>
        {!showCard && fp.shown && (
          <FootprintBar
            fp={fp}
            wide={wide}
            compact={barCompact}
            listOpen={wide ? layoutView.panel === "open" : listOpen}
            onList={() => (wide ? layout.setPanel("open") : setListOpen(!listOpen))}
            listInWide={layoutView.panel !== "open"}
            navigate={navigate}
          />
        )}
        {showCard && (
          <div className="map-card-bar" role="status">
            <Icon name="map" />
            <span className="map-card-bar-text">
              <b>{cardTitle ?? t("ui.plugins.map.card.bar")}</b>
              {cardNote !== undefined && <span className="map-card-bar-note">{cardNote}</span>}
            </span>
            <button type="button" className="icon-btn" aria-label={t("ui.plugins.map.card.close")} title={t("ui.plugins.map.card.close")} onClick={() => navigate({ tab: "more", page: "map" })}>
              <Icon name="cross" />
            </button>
          </div>
        )}
        {/* 标题栏最右边那一格：地图切换（445）、"足迹"、右边聊天窗的开合（444，二狗按钮在最右，和"浏览"顶栏一致） */}
        <div className="map-bar-tools">
          <MapSwitch sw={basemapSwitch} compact={barCompact} footprints={footprintsDrawn} />
          {!showCard && <FootprintToggle fp={fp} compact={barCompact} />}
          <MapChatToggle open={chatOpen} onToggle={toggleChat} />
        </div>
      </TopBar>
      {places.length > 0 && (
        <div className="map-places" role="toolbar" aria-label={t("ui.plugins.map.places")}>
          {places.map((p) => (
            <button key={p.id} type="button" className="chip" data-place={p.id} onClick={() => setJump({ view: { lat: p.lat, lon: p.lon, zoom: p.zoom } })}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="map-body">
        <div className="map-stage" ref={stageRef} data-fab={chatOpen ? undefined : ""}>
          <MapCanvas
            config={config}
            scene={scene}
            footprints={footprintsDrawn}
            ownScene={ownScene}
            switcher={basemapSwitch}
            initial={initial}
            jump={jump}
            onView={(v) => {
              viewNow.current = v;
              // 定位挪过去的那一下不记（那就是你现在的位置）；之后拖开了照常记
              if (sameView(v, locateJump.current)) return;
              locateJump.current = undefined;
              if (import.meta.env.MODE !== "demo") saveView(v);
            }}
            onMarkClick={(id) => {
              if (fp.markClick(id)) {
                // 宽的时候点了停留点：左边那一栏收着、关着就打开（详情在那一栏里）
                if (wide && layoutView.panel !== "open") layout.setPanel("open");
                return;
              }
              const p = places.find((x) => x.id === id);
              if (p) setJump({ view: { lat: p.lat, lon: p.lon, zoom: Math.max(p.zoom, 15) } });
            }}
            navigate={navigate}
            notice={here.note === undefined ? undefined : { text: here.note, onClose: here.busy ? undefined : here.closeNote }}
          />
          <LocateButton here={here} />
          <MapFab talk={talk} chatOpen={chatOpen} stageRef={stageRef} dock={dock} onExpand={() => layout.setChatOpen(true)} />
          {!showCard && (
            <FootprintPanel
              fp={fp}
              wide={wide}
              listOpen={listOpen}
              onCloseList={() => setListOpen(false)}
              panel={layoutView.panel}
              onPanel={(next) => layout.setPanel(next)}
              drawer={layoutView.drawer}
              onDrawer={(next) => layout.setDrawer(next)}
              navigate={navigate}
            />
          )}
        </div>
        {/* 宽屏：地图和聊天窗中间的分隔条，拖着调聊天窗的宽度（松手记在这台设备上） */}
        {chatOpen && split && (
          <>
            <Splitter label={t("ui.plugins.map.chat.resize")} onDrag={(dx) => chatWidth.onDrag(dx, chatShownWidth, pageWidth)} onDragEnd={() => chatWidth.onDragEnd(pageWidth)} />
            <aside className="map-chat" style={{ width: chatShownWidth }}>
              {chat}
            </aside>
          </>
        )}
      </div>
      {/* 窄的时候：整屏盖住地图页 */}
      {chatOpen && !split && <aside className="map-chat map-chat-cover">{chat}</aside>}
    </div>
  );
}

/** 直接显示在导航里：整页 */
export function MapSection({ item, sub, navigate }: PageSectionProps) {
  return <MapScreen item={item} sub={sub} navigate={navigate} onBack={undefined} />;
}

/** 收进"更多"时右边（竖屏是整页）那一栏：左上角返回"更多" */
export function MapColumn({ item, sub, navigate, onBack }: PageColumnProps) {
  return <MapScreen item={item} sub={sub} navigate={navigate} onBack={onBack} />;
}
