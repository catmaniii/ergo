/**
 * 160 号票：浏览器里加载完的一页、拦下的下载是能渲染的文件（markdown 这类，app/browse-files.ts 定）时，原生浏览器藏起来，内容区里画
 * 二狗的渲染层（ui/file-view.tsx：看原文、下载、用系统浏览器打开，拦下的下载多一个关闭）；返回手势先轮到它（页面上的浏览器能后退就后退，
 * 不能就收起露出原文；拦下的收起）。里面点的链接在浏览器里打开。
 *
 * "浏览"页签（134 号票，用户 2026-10-18："相当于二狗增加一个 tab 栏：浏览，点进去是一个浏览器的界面，可以输入网址，可以打开网页"）。
 * 只在鸿蒙 App 里有（导航只在有原生浏览器时多这一项）。网页画顶栏和内容区的框，框里是 App 叠上来的原生 ArkWeb：
 * - 顶栏：后退、前进、地址栏（网址直接开，关键词拿设置里选的搜索引擎搜）、刷新（加载中是停止）、用系统浏览器打开；下面一条加载进度；
 * - 内容区：一个占位的框（.browse-host），它在页面上的位置大小经原生桥报给 App（browserLayout），App 把浏览器的 Web 摆在那里盖住它；
 *   框变了（转屏、宽窄屏切换、输入法、页面更新提示条挤下来）就重新报。切到别的页签报"藏起来"：Web 留着，切回来页面原样还在；
 * - 还没打开过网页、或者在改地址栏时，浏览器藏起来，框里列最近访问（点一条打开）；
 * - 返回手势由 App 先退浏览器的网页历史，退到头才照别的页签的规矩（Index.ets 的 onBackPress）；
 * - 网页的框上的悬浮按钮点了、长按说话，网页弹出选文件对话框时（134 号票第二部分），146 号票起都在网页里悬浮按钮旁边的小气泡里
 *   （页面桥画，app/page-bubble.ts 交给它），浏览器下面不再出面板。
 * - 147 号票（用户定：开合按钮放在顶上那一栏）：顶栏最右边一个二狗的图标按钮，点了二狗侧边栏（秘书本人）从右边滑出来，再点收起
 *   （按钮展开着时是按下的样子，侧边栏顶上也有"收起"）；窄屏整屏盖住，收起回到网页。原生网页盖在这一页上面，所以侧边栏由 App 画在
 *   原生网页上面（App 另开的一个 Web 组件，加载二狗网页的侧边栏模式）。展开没展开记在这台设备上。
 * - 148 号票（2026-10-18 用户在平板横屏上提：侧边栏不能只是盖住网页，要挤压网页；宽度要能像"详情"那样拖）：宽屏展开时侧边栏在内容区
 *   右边，浏览器让出右边（侧边栏宽度加中间一条分隔条），两者不重叠；刚展开时浏览器先不让、等侧边栏滑到位再让（useSettled），收起时
 *   马上恢复原宽，中间不露空隙。分隔条（照"详情"阶段栏的 Splitter）这一页自己画在两个原生 Web 中间的缝里，拖着时浏览器、侧边栏
 *   的位置每帧最多报一次，松手宽度记在这台设备上；宽度有上下限，内容区变了（转屏、窗口变化）夹回。浏览器、侧边栏、分隔条摆在哪
 *   一起算（app/browse-side.ts 的 browseFrames），浏览器经 browserLayout、侧边栏经 browserSide 报给 App（useNativeFrames）：
 *   内容区变了、展开收起、拖着、网页和选中的框变了都重新报，没变不报；离开这一页报"都藏起来"。
 * - 165 号票（用户 2026-10-19）：顶栏最右边、二狗侧边栏开关旁边一个 ⋮，替掉原来的"用系统浏览器打开"按钮；点了弹菜单（手机上从底部
 *   弹出、宽屏是下拉菜单，pages/BrowseTools.tsx）：让二狗总结这一页、存进二狗的素材、在页面里查找、文字大小、桌面版网站、分享、
 *   用系统浏览器打开、浏览记录、下载记录、清除浏览数据。原生网页盖在这一页上面，二狗画的菜单、浏览记录、下载记录、对话框盖不过它，
 *   所以它们开着时浏览器先藏起来（Web 留着，关上原样回来；宽屏侧边栏展开着时下拉菜单贴着浏览器的右上角弹，清除浏览数据的对话框开着时
 *   侧边栏也藏起来）；查找栏在顶栏下面（浏览器跟着变矮，照样看得见高亮）。页面底部的短提示也会被原生网页盖住，这一页的提示（存好了、
 *   清好了……）写在顶栏上，过一会儿消失。空白页的最近访问和菜单里的完整浏览记录同一套：长按删、多选删、清空全部。
 * - 275 号票（用户 2026-10-25：设置里改了界面风格，侧边栏要重启 App 才跟着变）：报给 App 的侧边栏样子里带着这一页现在的外观
 *   （外观、风格、主色，app/theme.ts 的 appearance），外观变了也重报；侧边栏那一页收到就照着换（side-remote.ts）。
 * 不在 App 里打开这个地址（#/browse）只有一句说明。
 */
import { type CSSProperties, type FormEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { type BrowseFrames, type BrowseSide, browseFrames, dragBrowseSideWidth, type FrameRect } from "./browse-side.ts";
import { addressToUrl } from "./browse-address.ts";
import type { BrowserLayout, NativeBrowser } from "../../app/native-browser.ts";
import { useBackLayer } from "../../app/page-back.ts";
import { pageTheme } from "../../app/page-theme.ts";
import {
  pageBrowseFiles,
  pageBrowseSettings,
  pageBrowseSide,
  pageBrowseSideWidth,
  pageNativeBrowser,
  pageBrowseFind,
  pagePageCommands,
  setBrowseSideWide,
  useBrowseFile,
  useBrowseFind,
  useBrowserState,
  useBrowseSide,
  useBrowseSideWidth,
  useRecentVisits,
  useSearchEngine,
  useSiteSettings,
} from "./page-browse.ts";
import { useStore } from "../../app/store.tsx";
import {
  browseMenu,
  type BrowseMenuId,
  CHANNELS,
  filterVisits,
  RECENTS_SHOWN,
  SEARCH_ENGINES,
  shortAddress,
  siteDesktopOf,
  siteKeyOf,
  siteZoomOf,
  stepTextZoom,
  summarizePageText,
  t,
} from "../../state/index.ts";
import { Splitter, TopBar, useNow } from "../../ui/common.tsx";
import { FileView } from "../../ui/file-view.tsx";
import { Icon } from "../../ui/icons.tsx";
import { SelectToggle } from "../../ui/select-mode.tsx";
import { BrowseDownloadsPanel, BrowseHistoryPanel, BrowseMenu, ClearDataDialog, ClearVisitsConfirm, FindBar, useVisitSelection, VisitList, VisitSelectBar } from "./BrowseTools.tsx";

export function BrowsePage({ wide }: { wide: boolean }) {
  const browser = pageNativeBrowser();
  if (!browser) {
    return (
      <div className="chat-col">
        <TopBar title={t("pages.browse.title")} />
        <div className="page-placeholder">{t("pages.browse.appOnly")}</div>
      </div>
    );
  }
  return <NativeBrowse browser={browser} wide={wide} />;
}

/** 框在页面上的位置大小（CSS 像素）：没变就不再报 */
function sameLayout(a: BrowserLayout | undefined, b: BrowserLayout): boolean {
  return a !== undefined && a.visible === b.visible && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.dpr === b.dpr;
}

/** 内容区（.browse-host）在页面上的位置大小、页面的视口和 devicePixelRatio */
interface HostBox {
  readonly host: FrameRect;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly dpr: number;
}

/**
 * 量内容区：挂上时、框变了（ResizeObserver）、窗口和可视区变了（转屏、宽窄屏切换、输入法）都量一次；框的位置变了而大小没变（上面的
 * 提示条出来、收起）ResizeObserver 不报，页面上的过渡、动画结束时再量一次。没变不更新
 */
function useHostBox(host: React.RefObject<HTMLDivElement | null>): HostBox | undefined {
  const [box, setBox] = useState<HostBox>();
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next: HostBox = { host: { x: r.left, y: r.top, width: r.width, height: r.height }, viewport: { width: window.innerWidth, height: window.innerHeight }, dpr: window.devicePixelRatio || 1 };
      setBox((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    document.addEventListener("transitionend", measure, true);
    document.addEventListener("animationend", measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      document.removeEventListener("transitionend", measure, true);
      document.removeEventListener("animationend", measure, true);
    };
  }, [host]);
  return box;
}

/**
 * App 让侧边栏从右边滑进来要多久（Index.ets 的 layoutSide：animateTo 220 毫秒），再留一点余量（报过去、App 开始滑也要一会儿）。
 * 宽屏刚展开时浏览器等这么久再让出右边
 */
const SIDE_SLIDE_MS = 260;

/**
 * 宽屏展开的侧边栏滑到位了没有（148 号票）：on 变成 true 后过 SIDE_SLIDE_MS 才是 true——这之前浏览器照旧全宽、侧边栏盖在它右边滑进来，
 * 滑到位了浏览器再让出右边（网页只重排一次，中间不会露出一块空的）；on 变成 false 马上是 false（收起时浏览器马上恢复原宽，
 * 侧边栏盖着它滑出去）。转屏从窄屏到宽屏时侧边栏不滑（App 只在显示、藏起来时滑），也照样等一下再挤，那一下侧边栏盖着浏览器右边
 */
function useSettled(on: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setSettled(true), SIDE_SLIDE_MS);
    return () => {
      clearTimeout(timer);
      setSettled(false);
    };
  }, [on]);
  return on && settled;
}

/**
 * 侧边栏的宽度（148 号票）：这台设备记住的，拖着的时候是拖到的。拖分隔条时每帧最多更新一次（报给 App 的位置也就每帧最多一次，
 * 这一帧里挪的几下攒在一起），松手才记到这台设备上（照"详情"阶段栏）
 */
function useSideWidth() {
  const remembered = useBrowseSideWidth();
  /** 拖着的时候的宽度（松手才记到这台设备上） */
  const [dragging, setDragging] = useState<number>();
  /** 这一下拖：拖到的宽度、这一帧还没算进去的挪动、等着的那一帧 */
  const drag = useRef<{ width: number; dx: number; frame: number | undefined } | undefined>(undefined);
  // 拿下时还没到的那一帧不要了
  useEffect(
    () => () => {
      const frame = drag.current?.frame;
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
    [],
  );
  return {
    width: dragging ?? remembered,
    /** from 是现在摆着的宽度（按内容区夹回之后的，拖从它开始）；hostWidth 是内容区多宽 */
    onDrag(dx: number, from: number, hostWidth: number) {
      const d = (drag.current ??= { width: from, dx: 0, frame: undefined });
      d.dx += dx;
      if (d.frame !== undefined) return;
      d.frame = requestAnimationFrame(() => {
        d.frame = undefined;
        d.width = dragBrowseSideWidth(d.width, d.dx, hostWidth);
        d.dx = 0;
        setDragging(d.width);
      });
    },
    onDragEnd(hostWidth: number) {
      const d = drag.current;
      drag.current = undefined;
      if (!d) return;
      if (d.frame !== undefined) cancelAnimationFrame(d.frame);
      pageBrowseSideWidth().set(dragBrowseSideWidth(d.width, d.dx, hostWidth));
      setDragging(undefined);
    },
  };
}

/**
 * 把浏览器、侧边栏摆在哪报给 App：浏览器经 browserLayout（browserVisible：打开过网页、没在改地址栏），侧边栏经 browserSide（147 号票，
 * 旧版 App 没有就只报浏览器）。每次渲染都算一遍，没变不报；先报浏览器再报侧边栏（收起时浏览器先恢复原宽，侧边栏盖着它滑出去）。
 * 拿下时报"都藏起来"（Web 留着，切回来页面原样还在；侧边栏展开没展开照旧记着，回来照上次的样子）
 */
function useNativeFrames(browser: NativeBrowser, side: BrowseSide | undefined, box: HostBox | undefined, frames: BrowseFrames | undefined, browserVisible: boolean) {
  const lastLayout = useRef<BrowserLayout | undefined>(undefined);
  const lastSide = useRef("");
  const reportSide = browser.side;
  // 275 号票：侧边栏的样子带着现在的外观，外观变了重报（侧边栏跟着换风格）
  const theme = pageTheme();
  const appearance = useSyncExternalStore(theme.subscribe, theme.appearance);
  useLayoutEffect(() => {
    if (!box || !frames) return;
    const { browser: rect } = frames;
    const layout: BrowserLayout = { visible: browserVisible && rect.width > 0 && rect.height > 0, x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: box.dpr };
    if (!sameLayout(lastLayout.current, layout)) {
      lastLayout.current = layout;
      browser.layout(layout);
    }
    if (!reportSide || !side) return;
    // 窄屏整屏盖住时侧边栏的网页也延伸到了手势条底下：底部让开的那一截照这一页的
    const safeBottom = frames.cover ? getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom").trim() : "";
    const next = { dpr: box.dpr, side: frames.side, view: JSON.stringify(side.sideView(safeBottom || undefined, appearance)) };
    const key = JSON.stringify(next);
    if (key === lastSide.current) return;
    lastSide.current = key;
    reportSide(next);
  });
  useLayoutEffect(
    () => () => {
      browser.layout({ ...(lastLayout.current ?? { x: 0, y: 0, width: 0, height: 0, dpr: window.devicePixelRatio || 1 }), visible: false });
      lastLayout.current = undefined;
    },
    [browser],
  );
  useLayoutEffect(() => {
    if (!reportSide || !side) return;
    return () => {
      lastSide.current = "";
      reportSide({ dpr: window.devicePixelRatio || 1, side: { visible: false, x: 0, y: 0, width: 0, height: 0 }, view: JSON.stringify(side.sideView(undefined, pageTheme().appearance())) });
    };
  }, [reportSide, side]);
}

/** 顶栏上的提示（存好了、清好了……）留多久（毫秒）：页面底部的短提示会被原生网页盖住，这一页的写在顶栏上 */
const NOTE_MS = 2600;

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 顶栏上的一句提示：过 NOTE_MS 消失，新的换掉旧的 */
function useNote(): [string | undefined, (text: string) => void] {
  const [note, setNote] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    note,
    (text) => {
      clearTimeout(timer.current);
      setNote(text);
      timer.current = setTimeout(() => setNote(undefined), NOTE_MS);
    },
  ];
}

function NativeBrowse({ browser, wide }: { browser: NativeBrowser; wide: boolean }) {
  const state = useBrowserState();
  const engine = useSearchEngine();
  const recents = useRecentVisits();
  // ⋮ 菜单（165 号票）：菜单、浏览记录 / 下载记录（盖在内容区里）、清除浏览数据的对话框开着时浏览器藏起来
  const { sendMessage, http } = useStore();
  const settings = pageBrowseSettings();
  const sites = useSiteSettings();
  const tools = browser.tools;
  const find = pageBrowseFind();
  const findView = useBrowseFind();
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<"history" | "downloads">();
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [note, say] = useNote();
  const recentSel = useVisitSelection();
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuSpot = useRef<HTMLDivElement>(null);
  const overlay = menu || panel !== undefined || clearing;
  const host = useRef<HTMLDivElement>(null);
  /** 地址栏在改（有焦点）：浏览器藏起来，框里列最近访问 */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /** 点了打开、App 还没推回地址之前也算打开了（浏览器马上显示） */
  const [requested, setRequested] = useState(false);
  const opened = state.url !== "" || requested;
  // 浏览侧边栏（147 号票）：侧边栏由 App 画在原生网页上面；宽屏挤压网页、中间的分隔条能拖（148 号票）。这里算位置、报给 App
  const side = pageBrowseSide();
  const sideView = useBrowseSide();
  useEffect(() => setBrowseSideWide(wide), [wide]);
  const sideOpen = side !== undefined && browser.side !== undefined && sideView.open;
  const settled = useSettled(wide && sideOpen);
  const sideWidth = useSideWidth();
  const box = useHostBox(host);
  // 清除浏览数据的对话框开着时侧边栏也藏起来（宽屏上居中的对话框可能伸到它底下）
  const frames = box ? browseFrames(box.host, box.viewport, { wide, open: sideOpen, shown: !clearing, settled, width: sideWidth.width }) : undefined;
  // 能渲染的文件（160 号票）：渲染层画在内容区里，原生浏览器藏起来；改地址栏时照旧列最近访问
  const files = pageBrowseFiles();
  const file = useBrowseFile();
  const showFile = files !== undefined && file !== undefined && !editing && panel === undefined;
  useBackLayer("overlay", showFile, () => files?.back());
  useNativeFrames(browser, side, box, frames, opened && !editing && file === undefined && !overlay);
  /** 挤压着时浏览器让出的右边（侧边栏加分隔条）：最近访问的列表也让开 */
  const yieldRight = frames?.splitter ? frames.splitter.width + frames.side.width : 0;
  const yieldStyle: CSSProperties | undefined = yieldRight > 0 ? { marginRight: yieldRight } : undefined;
  const commands = pagePageCommands();
  // 离开"浏览"：正在录的丢掉、放掉录音器
  useEffect(() => () => commands?.hidden(), [commands]);

  const open = (url: string) => {
    browser.load(url);
    setRequested(true);
    setEditing(false);
    (document.activeElement as HTMLElement | null)?.blur?.();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const url = addressToUrl(draft, engine);
    if (url) open(url);
  };
  const filter = editing ? draft.trim().toLowerCase() : "";
  // 地址栏输入时的候选从全部浏览记录里找（删了的不再出现）；空白页列前 RECENTS_SHOWN 条，能长按删、多选删、清空全部
  const shownRecents = filterVisits(recents, filter).slice(0, RECENTS_SHOWN);
  // 改地址栏时不在多选里
  useEffect(() => {
    if (editing) recentSel.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const groups = browseMenu({
    url: state.url,
    title: state.title,
    side: side !== undefined && browser.side !== undefined,
    text: browser.page !== undefined,
    tools: tools !== undefined,
    sites,
    ownOrigin: window.location.origin,
  });
  /** 存进二狗的素材：取这一页的正文（页面桥取整页文字的那条路，有上限），存成一条素材 */
  const savePage = async () => {
    const text = await browser.page?.text();
    if (!text) {
      say(t("pages.browse.saveUnavailable"));
      return;
    }
    try {
      await http.saveWebPage({ idempotencyKey: newKey(), title: text.page.title, url: text.page.url, text: text.text, truncated: text.truncated, total: text.total });
      say(text.truncated ? t("pages.browse.savedTruncated", { count: text.text.length }) : t("pages.browse.saved"));
    } catch (err) {
      say(t("pages.browse.saveFailed", { reason: err instanceof Error ? err.message : String(err) }));
    }
  };
  const pick = (id: BrowseMenuId) => {
    setMenu(false);
    const site = siteKeyOf(state.url);
    switch (id) {
      case "summarize":
        // 147 号票侧边栏发消息的那条路：打开侧边栏（手机上整屏），替用户发一句，带网页上下文
        if (!side) return;
        side.setOpen(true);
        sendMessage(CHANNELS.secretary, [{ type: "text", text: summarizePageText() }], undefined, side.context());
        return;
      case "save":
        void savePage();
        return;
      case "find":
        find?.open();
        return;
      case "zoom":
        return;
      case "desktop":
        // 先把按网站的设置交给 App（换浏览器标识），再重新加载
        if (!site) return;
        settings.setSiteDesktop(site, !siteDesktopOf(sites, state.url));
        browser.nav("reload");
        return;
      case "share":
        void tools?.share({ title: state.title, url: state.url }).then((done) => {
          if (!done.ok) say(t("pages.browse.shareFailed", { reason: done.reason ?? t("pages.browse.noAppReply") }));
        });
        return;
      case "outside":
        browser.nav("outside");
        return;
      case "history":
      case "downloads":
        setPanel(id);
        return;
      case "clear":
        setClearing(true);
        return;
    }
  };
  const zoom = (dir: 1 | -1) => {
    const site = siteKeyOf(state.url);
    if (site) settings.setSiteZoom(site, stepTextZoom(siteZoomOf(sites, state.url), dir));
  };
  const now = useNow(60_000);

  return (
    <div className="chat-col browse-page">
      <header className="topbar browse-bar">
        <button type="button" className="icon-btn" onClick={() => browser.nav("back")} disabled={!state.canGoBack} aria-label={t("pages.browse.back")} title={t("pages.browse.back")}>
          <Icon name="back" />
        </button>
        <button type="button" className="icon-btn browse-forward" onClick={() => browser.nav("forward")} disabled={!state.canGoForward} aria-label={t("pages.browse.forward")} title={t("pages.browse.forward")}>
          <Icon name="forward" />
        </button>
        <form className="browse-address" onSubmit={submit} role="search">
          <input
            className="input"
            type="text"
            inputMode="url"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={t("pages.browse.address")}
            placeholder={t("pages.browse.addressPlaceholder", { engine: SEARCH_ENGINES[engine].label })}
            value={editing ? draft : state.url}
            onFocus={(e) => {
              setDraft(state.url);
              setEditing(true);
              const input = e.currentTarget;
              setTimeout(() => input.select());
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
        {state.loading ? (
          <button type="button" className="icon-btn" onClick={() => browser.nav("stop")} aria-label={t("pages.browse.stop")} title={t("pages.browse.stop")}>
            <Icon name="cross" />
          </button>
        ) : (
          <button type="button" className="icon-btn" onClick={() => browser.nav("reload")} disabled={!opened} aria-label={t("pages.browse.reload")} title={t("pages.browse.reload")}>
            <Icon name="reload" />
          </button>
        )}
        {/* 浏览侧边栏的开合（147 号票，用户定：放在顶上这一栏的最右边）：展开着时是按下的样子 */}
        {side && browser.side && (
          <button
            type="button"
            className={`icon-btn browse-side-toggle${sideView.open ? " on" : ""}`}
            onClick={() => side.toggle()}
            aria-pressed={sideView.open}
            aria-label={sideView.open ? t("pages.browse.sideClose") : t("pages.browse.sideOpen")}
            title={sideView.open ? t("pages.browse.sideClose") : t("pages.browse.sideOpen")}
          >
            <Icon name="ergo" />
          </button>
        )}
        {/* ⋮ 菜单（165 号票）：替掉原来的"用系统浏览器打开"；菜单开着时再按一下是收起（按下不让菜单先关、点击再打开） */}
        <button
          ref={menuButton}
          type="button"
          className={`icon-btn browse-menu-btn${menu ? " on" : ""}`}
          onPointerDown={(e) => {
            if (menu) e.stopPropagation();
          }}
          onClick={() => setMenu(!menu)}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={t("pages.browse.more")}
          title={t("pages.browse.more")}
        >
          <Icon name="kebab" />
        </button>
        {note && (
          <div className="browse-note" role="status">
            {note}
          </div>
        )}
      </header>
      {find && findView.open && <FindBar view={findView} find={find} />}
      <div className="browse-progress" aria-hidden="true">
        {state.loading && <i style={{ width: `${Math.max(5, state.progress)}%` }} />}
      </div>
      <div className="browse-host" ref={host}>
        {(!opened || editing) && panel === undefined && (
          <div className="scroll browse-recents" style={yieldStyle}>
            {shownRecents.length > 0 && editing ? (
              // 改地址栏时：候选（不管理）
              <>
                <div className="menu-group browse-recents-head">
                  <span>{t("pages.browse.recents")}</span>
                </div>
                <div className="menu">
                  {shownRecents.map((v) => (
                    // 按下时不让地址栏先失去焦点（不然列表先消失、点不到）
                    <button key={v.url} type="button" className="menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => open(v.url)}>
                      <span className="menu-text">
                        <span className="browse-recent-title">{v.title || shortAddress(v.url)}</span>
                        <small className="browse-recent-url">{shortAddress(v.url)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : shownRecents.length > 0 ? (
              // 空白页：和菜单里的完整浏览记录同一套（长按删、多选删、清空全部）
              <>
                <div className="menu-group browse-recents-head">
                  <span>{t("pages.browse.recents")}</span>
                  <span className="browse-recents-acts">
                    <SelectToggle selecting={recentSel.selecting} onStart={() => recentSel.start()} onStop={recentSel.stop} />
                    <button type="button" className="link-btn danger-text" onClick={() => setConfirmClear(true)}>
                      {t("pages.browse.clearAll")}
                    </button>
                  </span>
                </div>
                <VisitList visits={shownRecents} grouped={false} now={now} sel={recentSel} onOpen={open} onRemove={(urls) => settings.removeVisits(urls)} />
                {recents.length > RECENTS_SHOWN && (
                  <button type="button" className="link-btn browse-recents-more" onClick={() => setPanel("history")}>
                    {t("pages.browse.allHistory", { count: recents.length })}
                  </button>
                )}
              </>
            ) : (
              <div className="page-placeholder">{filter ? t("pages.browse.enterToOpen") : t("pages.browse.emptyHint")}</div>
            )}
          </div>
        )}
        {(!opened || editing) && panel === undefined && !editing && recentSel.selecting && <VisitSelectBar sel={recentSel} shown={shownRecents} onRemove={(urls) => settings.removeVisits(urls)} />}
        {confirmClear && <ClearVisitsConfirm count={recents.length} onClear={() => settings.clearRecents()} onClose={() => setConfirmClear(false)} />}
        {panel === "history" && (
          <BrowseHistoryPanel
            settings={settings}
            visits={recents}
            onOpen={(url) => {
              setPanel(undefined);
              open(url);
            }}
            onClose={() => setPanel(undefined)}
            style={yieldStyle}
          />
        )}
        {panel === "downloads" && tools && <BrowseDownloadsPanel tools={tools} onClose={() => setPanel(undefined)} onNote={say} style={yieldStyle} />}
        {/* 宽屏侧边栏展开着（挤压）时下拉菜单贴着浏览器的右上角弹（贴着 ⋮ 会伸进侧边栏底下，被它盖住） */}
        <div ref={menuSpot} className="browse-menu-spot" style={{ right: yieldRight }} aria-hidden="true" />
        {showFile && (
          <FileView
            key={`${file.id}#${file.seq}`}
            url={file.url}
            name={file.name}
            kind={file.kind}
            load={() => files.load(file)}
            onLink={open}
            download={{ run: () => files.save() }}
            outside={{ label: t("pages.browse.openOutside"), run: () => files.outside() }}
            onClose={file.via === "download" ? () => files.close() : undefined}
            style={yieldStyle}
          />
        )}
        {/* 浏览器和侧边栏中间的分隔条（148 号票）：两个原生 Web 都不盖这条缝，触摸到这一页；拖着调侧边栏的宽度 */}
        {box && frames?.splitter && (
          <div className="browse-split" style={{ left: frames.splitter.x - Math.round(box.host.x), width: frames.splitter.width }}>
            <Splitter
              label={t("pages.browse.resizeSide")}
              onDrag={(dx) => sideWidth.onDrag(dx, frames.side.width, box.host.width)}
              onDragEnd={() => sideWidth.onDragEnd(box.host.width)}
            />
          </div>
        )}
      </div>
      {menu && (
        <BrowseMenu
          wide={wide}
          anchor={frames?.splitter ? menuSpot : menuButton}
          title={state.url ? state.title || shortAddress(state.url) : t("pages.browse.title")}
          groups={groups}
          onPick={pick}
          onZoom={zoom}
          onClose={() => setMenu(false)}
        />
      )}
      {clearing && <ClearDataDialog wide={wide} url={state.url} tools={tools} settings={settings} onClose={() => setClearing(false)} onDone={say} />}
    </div>
  );
}
