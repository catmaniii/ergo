/**
 * 主框架：竖屏底部横栏、宽屏左侧竖栏（内容区分栏）。主导航按空间自适应（33 号票，ui/main-nav.tsx）：秘书、任务、项目、
 * 待我处理、浏览（134 号票，只在鸿蒙 App 里）、日历（35 号票）、消耗、记忆、设置按顺序放得下的直接显示，放不下的从末尾起收进"更多"。
 * 宽窄按内容区的实际宽度判断（以 600 为界），所以原型的"手机宽度"预览也能直接用。
 *
 * 由守护进程提供页面时先问一次这个页面被信任吗（/api/access，10 号票）：外网端口上还没配对的设备只看到配对等待页；
 * 用着用着凭证失效了（被吊销、过期），连接报 unpaired，也回到配对等待页。被吊销的设备不自动重新申请：
 * 浏览器里留着"本设备已被吊销"的记号，刷新之后也一样（state/pairing-gate.ts、app/revoked-mark.ts）。
 *
 * 193 号票：网页插件（ADR-0027 的网页插槽）在这里装：插件清单（plugins/manifest.ts，只有这里引它）建成网页插件宿主，经 PluginHostProvider
 * 交给界面；守护进程在插件频道上报的状况变了就装、停（PluginStatusSync）。导航里网页插件的页面（记忆）按它登记的 order 插进来。
 * 214 号票：网页插件的后台部件（background 插槽：语音插件的"自动播放 agent 的语音"）挂在这里，整个页面一份（PluginBackground）。
 *
 * 147 号票：地址带 ?ergo=side 的是浏览侧边栏模式——鸿蒙 App 另开一个 Web 组件加载它、摆在原生网页上面当侧边栏，整页只画侧边栏
 * （秘书的主会话，SideShell），没有导航；"浏览"页那一份的样子由 App 转过来。
 *
 * 212 号票：内置浏览器（"浏览"页签、浏览侧边栏、悬浮按钮、挑图片窗口、网页候选卡）是浏览插件的（plugins/browsing/）：导航里"浏览"的位置、
 * 地址 #/browse、只在 App 里有原生浏览器时才有还是核心定，整页、侧边栏模式那一页、主框架里挂一次的由插件经页签插槽（tabs）给；
 * 插件停用了导航里没有"浏览"，#/browse 和侧边栏模式写"内置浏览器插件没启用"。开场接上 App 推过来的（悬浮按钮、浏览侧边栏、原生浏览器，
 * 以前在这里和 main.tsx）由插件第一次装上时做：建插件宿主时把页面的连接和 HTTP 交给它。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessProvider } from "./app/access.tsx";
import { pageNativeApp } from "./app/page-native.ts";
import { SIDE_MODE } from "./app/side-mode.ts";
import { fetchAccess, httpPairingApi } from "./app/pairing-api.ts";
import { revokedMark } from "./app/revoked-mark.ts";
import { type Navigate, navItemOf, type Route, toHash, useRoute } from "./app/route.ts";
import { StoreProvider, useStore } from "./app/store.tsx";
import { useDaemonLocale, useLocale } from "./app/locale.ts";
import { useSecretaryAlerts } from "./app/secretary-unread.ts";
import { InboxPage } from "./pages/InboxPage.tsx";
import { MorePage } from "./pages/MorePage.tsx";
import { PairingApprove, PairingWait } from "./pages/PairingPages.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { ReportPage } from "./pages/ReportPage.tsx";
import { SecretaryPage } from "./pages/SecretaryPage.tsx";
import { SetupBanner } from "./pages/SetupWizard.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import type { Connection } from "./app/connection.ts";
import { type DaemonHttp, HttpDaemonClient } from "./app/daemon-http.ts";
import { FakeDaemonHttp } from "./prototype/fake-http.ts";
import { daemonSocketUrl, WebSocketConnection } from "./app/ws-connection.ts";
import { isPrototypePage } from "./app/prototype-mode.ts";
import { FakeConnection } from "./prototype/fake-connection.ts";
import { SplitConnection } from "./prototype/split-connection.ts";
import {
  type AccessInfo,
  CHANNELS,
  type CredentialRejection,
  inboxBadge,
  type NavItem,
  navHighlight,
  navItemsFor,
  type PairingOpening,
  pairingOpening,
  revokedMarkAfter,
  secretaryNavDot,
  t,
} from "./state/index.ts";
import { FAKE_ACCESS } from "./prototype/fake-data.ts";
import { startDemoDebug } from "./prototype/demo-debug.ts";
import { previewPairingApi } from "./prototype/preview-pairing.ts";
import { ProtoProvider } from "./prototype/proto-store.tsx";
import { AlertsView, FailureToasts } from "./ui/alerts.tsx";
import { CardPanel } from "./ui/cards/CardPanel.tsx";
import { TopBar, useElementWidth } from "./ui/common.tsx";
import { DetailHost, FrameWidth } from "./ui/detail/DetailLayout.tsx";
import { InAppBrowser } from "./ui/in-app-browser.tsx";
import { MainNav, useNavFit } from "./ui/main-nav.tsx";
import { PageUpdateBar } from "./ui/page-update.tsx";
import { PopupHost } from "./ui/popup.tsx";
import { ToastProvider, ToastView } from "./ui/toast.tsx";
import { createWebPluginHost } from "./plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "./plugins/manifest.ts";
import { PluginBackground, PluginHostProvider, PluginRoutePage, PluginStatusSync, usePlugins } from "./plugins/react.tsx";

/** 鸿蒙"一多"断点：≥600 视为宽屏 */
const WIDE_MIN = 600;

/**
 * 页面由守护进程提供（http://127.0.0.1:8810）；直接打开构建产物（file://）、在线演示页（`npm run build:demo` 那份，316 号票）
 * 没有守护进程，全部用原型的假数据（app/prototype-mode.ts）
 */
const SERVED_BY_DAEMON = !isPrototypePage(window.location.protocol, import.meta.env.MODE);

/**
 * 已经接上真数据的频道：04 号票起是秘书会话；06 号票起卡片、待我处理，以及看板频道（目前只有简单提醒，
 * 看板页面接真数据在 12 号票）；10 号票起已配对设备；29 号票起工作日历；15 号票起项目列表（项目的维护者会话打开时再订阅）。
 * 后面的票往这里加
 */
const REAL_CHANNELS = [
  CHANNELS.secretary,
  CHANNELS.cards,
  CHANNELS.inbox,
  CHANNELS.board,
  CHANNELS.activity,
  CHANNELS.devices,
  CHANNELS.workdayCalendar,
  CHANNELS.watchCategories,
  CHANNELS.projects,
  // 43 号票：个人助理的名字（界面上处处用它，一打开就订阅）
  CHANNELS.assistantName,
  // 109 号票：已读位置（"秘书"页签的红点、秘书新消息的提醒，几台设备同步）
  CHANNELS.readMarks,
  // 168 号票：语言（全局一个；换了语言、语言文件变了，开着的页面重取词典）
  CHANNELS.language,
  // 193 号票：插件的状况（网页按它装、停自己的网页插件，一打开就订阅）
  CHANNELS.plugins,
];

/**
 * 问一下这个页面被信任吗（打开时；外网端口上断线后），顺带更新浏览器里"本设备已被吊销"的记号：
 * 知道被吊销了就留下，被信任了就擦掉
 */
async function checkAccess(): Promise<AccessInfo> {
  const info = await fetchAccess();
  revokedMark.set(revokedMarkAfter(info, revokedMark.get()));
  return info;
}

/**
 * 前端连接只在这里注入，别处不认具体的连接（原型的看板等假数据也只看前端状态层里的变化）。
 * 由守护进程提供页面时，接了真数据的频道走 WebSocket，其余频道仍是原型的假数据。
 */
const fakeConnection = new FakeConnection();
const connection: Connection = SERVED_BY_DAEMON
  ? new SplitConnection(new WebSocketConnection({ url: daemonSocketUrl(window.location), channels: REAL_CHANNELS, checkAccess }), fakeConnection, REAL_CHANNELS)
  : fakeConnection;

/** HTTP 那一半（上传附件、往上翻历史、媒体地址、改工作日历）：同样只在这里注入；原型的改工作日历交给假连接推事件 */
const http: DaemonHttp = SERVED_BY_DAEMON ? new HttpDaemonClient() : new FakeDaemonHttp(fakeConnection);

/**
 * 网页插件宿主（193 号票）：一建好就按全开装上，收到守护进程报的状况再装、停。212 号票起建在连接和 HTTP 之后、交给插件：
 * 浏览插件第一次装上时开场接上 App 推过来的（"浏览"里网页的框上的悬浮按钮——拦下的选文件对话框不能没人接；浏览侧边栏——报这台设备上
 * 浏览器的样子、办秘书的网页工具推来的事；原生浏览器）；不在 App 里什么都不做
 */
const pluginHost = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, page: { connection, http, sideMode: SIDE_MODE } });

// 原型的 ?demo-debug（124 号票）：一打开就在关于页，Debug 工具集已打开，各组有假数据（在页面读地址之前）
if (!SERVED_BY_DAEMON && !SIDE_MODE) startDemoDebug();

/** 这个页面被信任吗：问的路上、问到了（问不到也照常进，连不上时界面会提示）、还没配对（配对等待页怎么开场） */
type AccessState = { kind: "checking" } | { kind: "ready"; info?: AccessInfo } | { kind: "unpaired"; opening: PairingOpening };

function useAccessCheck(): AccessState {
  // 原型（直接打开构建产物）假装是从已配对的一台手机上打开的：设置 · 已配对设备里标"就是这台"（123 号票）
  const [state, setState] = useState<AccessState>(SERVED_BY_DAEMON ? { kind: "checking" } : { kind: "ready", info: FAKE_ACCESS });
  useEffect(() => {
    if (!SERVED_BY_DAEMON) return;
    checkAccess().then(
      (info) => setState(info.access === "none" ? { kind: "unpaired", opening: pairingOpening(info.reason, revokedMark.get()) } : { kind: "ready", info }),
      () => setState({ kind: "ready" }),
    );
  }, []);
  return state;
}

/** 配对成功：带着新凭证重新打开页面 */
const reload = () => window.location.reload();

/**
 * 外网端口上还没配对（或者凭证失效了）：只有配对等待页（不连 WebSocket，连了也会被拒）。
 * 原型里吊销、删除了"就是这台"（123 号票）也到这里，用假的配对接口（重新申请、模拟批准之后刷新，假数据从头来）
 */
function Unpaired({ opening }: { opening: PairingOpening }) {
  const [api] = useState(() => (SERVED_BY_DAEMON ? httpPairingApi : previewPairingApi(navigator.userAgent)));
  return <PairingWait api={api} onPaired={reload} opening={opening} onReapply={() => revokedMark.set(false)} />;
}

/** 用着用着连接报 unpaired：按知道的原因和浏览器里的记号定开场（打开这一页时定一次） */
function UnpairedNow({ reason }: { reason: CredentialRejection | undefined }) {
  const [opening] = useState(() => pairingOpening(reason, revokedMark.get()));
  return <Unpaired opening={opening} />;
}

/** 跟着守护进程换词典（168 号票）：语言频道上推来的版本和手里的对不上就取一份；整个页面一份 */
function LocaleSync() {
  const store = useStore();
  useDaemonLocale(store.http, store.ui.locale, deviceStorage);
  return null;
}

/**
 * 角色（248 号票）：打开页面时取一次（每个 agent 现在用哪个角色、它的名字和音色要在界面各处现取；
 * 角色页、⚙ 面板打开时另取）。取不到按"跟默认"显示
 */
function AgentRolesSync() {
  const { loadAgentRoles } = useStore();
  useEffect(() => {
    loadAgentRoles().catch(() => undefined);
  }, [loadAgentRoles]);
  return null;
}

/**
 * 我的名字（249 号票）：打开页面时取一次（秘书页、待办页的副标题和设置里那一项用它）。取不到就照旧（一个字都不多）；
 * 设置里改完用接口回的那个，不用再取
 */
function UserNameSync() {
  const { loadUserName } = useStore();
  useEffect(() => {
    loadUserName().catch(() => undefined);
  }, [loadUserName]);
  return null;
}

/** 这台设备的 localStorage（记上次的词典） */
const deviceStorage = () => window.localStorage;

export default function App() {
  // 换了语言整棵树重画（168 号票：组件里直接调 t()）
  useLocale();
  const access = useAccessCheck();
  if (access.kind === "checking") return null;
  if (access.kind === "unpaired") return <Unpaired opening={access.opening} />;
  return (
    <AccessProvider access={access.info}>
      <StoreProvider connection={connection} http={http}>
        <LocaleSync />
        <AgentRolesSync />
        <UserNameSync />
        <PluginHostProvider host={pluginHost}>
          <PluginStatusSync />
          <PluginBackground />
          <ToastProvider>
            <ProtoProvider realBoard={SERVED_BY_DAEMON && REAL_CHANNELS.includes(CHANNELS.board)}>
              {SIDE_MODE ? <SideShell /> : <PrototypeStage />}
            </ProtoProvider>
          </ToastProvider>
        </PluginHostProvider>
      </StoreProvider>
    </AccessProvider>
  );
}

/**
 * 应用外框：量出宽度给页面（宽窄两种布局按它切；54 号票评审去掉了原型的"手机竖屏 390"预览和顶上的原型栏，一律自适应宽度）。
 * 最后一层是弹出菜单的（.popup-layer，ui/popup.tsx）：长按菜单这类经 portal 画在这里，浮在输入栏、标题栏、详情栏之上
 */
function PrototypeStage() {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const [popupHost, setPopupHost] = useState<HTMLElement | null>(null);
  return (
    <div className="proto-stage">
      <div className="proto-main">
        <div className="proto-frame" ref={ref}>
          <PopupHost.Provider value={popupHost}>
            <Shell width={width} />
          </PopupHost.Provider>
          <ToastView />
          <div className="popup-layer" ref={setPopupHost} />
        </div>
      </div>
    </div>
  );
}

/**
 * 浏览侧边栏模式（147 号票）：整页只有侧边栏（秘书的主会话），状态由 App 从"浏览"页转过来。212 号票起侧边栏那一页是浏览插件给的
 * （页签插槽 browse 的 Side），插件停用了写"内置浏览器插件没启用"
 */
function SideShell() {
  const plugins = usePlugins();
  const Side = plugins.get("tabs", "browse")?.Side;
  const off = plugins.unavailable("tabs", "browse");
  const { ui } = useStore();
  const [popupHost, setPopupHost] = useState<HTMLElement | null>(null);
  // 会话里点开一条的详情（工具调用、想法、卡片……）：和窄屏一样整页滑入，盖住侧边栏（2026-10-19 用户：侧边栏里工具调用那一条点不开）
  const [detailHost, setDetailHost] = useState<HTMLElement | null>(null);
  // 新到的 agent 语音在开着的会话里自动播放（侧边栏开着秘书的会话）：214 号票起是语音插件的后台部件，挂在 App 里（PluginBackground）
  if (ui.connection === "unpaired") return <UnpairedNow reason={ui.unpairedReason} />;
  return (
    <div className="proto-stage">
      <div className="proto-main">
        <div className="proto-frame">
          <PopupHost.Provider value={popupHost}>
            <DetailHost.Provider value={detailHost}>
              <div className="app narrow browse-side-app">
                <FailureToasts />
                <main className="tab-content">{Side ? <Side /> : <PluginOffPage plugin={off} />}</main>
                <div className="dp-host" ref={setDetailHost} />
              </div>
            </DetailHost.Provider>
          </PopupHost.Provider>
          <ToastView />
          <div className="popup-layer" ref={setPopupHost} />
        </div>
      </div>
    </div>
  );
}

function Shell({ width }: { width: number }) {
  const wide = width >= WIDE_MIN;
  const [route, navigate] = useRoute();
  // 内置浏览器（132 号票）是盖在页面上的一层：地址是 #/apps/…，底下照旧是打开它之前的那一页（直接打开、刷新时是秘书页），关掉回到那一页
  const [underlay, setUnderlay] = useState<Route>(() => (route.tab === "app" ? { tab: "secretary" } : route));
  if (route.tab !== "app" && route !== underlay) setUnderlay(route);
  const shown = route.tab === "app" ? underlay : route;
  const { ui } = useStore();
  // 待办的提示；秘书会话里有没看过的消息时"秘书"也亮红点（109 号票）
  const badge = { ...inboxBadge(ui), secretary: secretaryNavDot(ui) };
  const openInboxItem = useCallback((itemId: string) => navigate({ tab: "inbox", itemId }), [navigate]);
  const openInbox = useCallback(() => navigate({ tab: "inbox" }), [navigate]);
  // 秘书新消息的提醒（109 号票）："查看"去秘书会话里那一条
  const openSecretaryAt = useCallback((at: string) => navigate({ tab: "secretary", at }), [navigate]);
  // 鸿蒙 App 里（新版 App 有原生的内置浏览器）导航多"浏览"（134 号票；212 号票起还要浏览插件在用）；在用的网页插件的页面（193 号票：记忆）按 order 插进来
  const plugins = usePlugins();
  const [nativeBrowser] = useState(() => pageNativeApp()?.browser !== undefined);
  const browse = nativeBrowser && plugins.get("tabs", "browse") !== undefined;
  const pages = plugins.list("pages");
  const tabs = plugins.list("tabs");
  const pagesKey = pages.map((p) => `${p.id}:${p.order}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies -- pagesKey 就是 pages 的样子（每次装、停换一个新数组）
  const navItems = useMemo(() => navItemsFor({ browse, plugins: pages }), [browse, pagesKey]);
  const { fit, onMeasure } = useNavFit(navItems);
  // 新到的 agent 语音自动播放（36 号票）：整个页面一份——214 号票起是语音插件的后台部件，挂在 App 里（PluginBackground）
  // 插件的页签在主框架里挂的（212 号票："浏览"里的悬浮按钮、挑图片窗口接到 store，149 号票）告诉这里：在那一页签上时秘书会话算不算在看
  const [watching, setWatching] = useState<Readonly<Record<string, boolean>>>({});
  const watchers = useMemo(() => new Map<string, (on: boolean) => void>(), []);
  const watcherOf = (id: string) => {
    let fn = watchers.get(id);
    if (!fn) {
      fn = (on: boolean) => setWatching((w) => (w[id] === on ? w : { ...w, [id]: on }));
      watchers.set(id, fn);
    }
    return fn;
  };
  // 秘书说完一轮、打开时有没看过的：不在看秘书会话时在顶上提醒（109 号票）；"浏览"右边的侧边栏开着时也算在看（147 号票）
  useSecretaryAlerts(shown.tab === "secretary" || watching[shown.tab] === true);
  const [detailHost, setDetailHost] = useState<HTMLElement | null>(null);

  // 用着用着凭证失效了（外网端口上被吊销、过期）：回到配对等待页
  if (ui.connection === "unpaired") return <UnpairedNow reason={ui.unpairedReason} />;
  // 配对等待页的预览（设置 · 已配对设备里点进来）：新设备上看到的样子，用假的配对接口，没有 tab
  if (shown.tab === "pair-wait") return <PairingPreview onExit={() => navigate({ tab: "more", page: "devices" })} />;

  const current = navItemOf(shown);
  const nav = <MainNav orientation={wide ? "rail" : "bar"} items={navItems} pages={pages} fit={fit} highlight={current && navHighlight(fit, current)} badge={badge} navigate={navigate} onMeasure={onMeasure} />;
  // 服务端的页面更新了（116 号票）：内容区最上面一条"二狗有新版本 · 刷新"，挤在页面上面、不盖住标题栏
  // 319 号票：首页（会话页）顶上一条"花两分钟把二狗配一下"，五步没走完时才有（点 × 关掉、记在这台设备上，见 app/page-setup.ts）；
  // 演示页不显示。放在内容区里（narrow 是上下、wide 是左右，放进 .app 那一层会挤成左边一列）
  const page = (
    <>
      {SERVED_BY_DAEMON && shown.tab === "secretary" && <SetupBanner />}
      <PageUpdateBar />
      <Page route={shown} wide={wide} folded={fit.folded} navigate={navigate} />
      {route.tab === "app" && <InAppBrowser key={route.app} route={route} leaveTo={toHash(underlay)} />}
    </>
  );
  // 到点的提醒、秘书新消息：在任意页面顶上提示；被拒的请求在底部提示原因。插件的页签在主框架里挂的（212 号票）也放在这里（不画东西）
  const notices = (
    <>
      <AlertsView onOpen={openInboxItem} onInbox={openInbox} onSecretary={openSecretaryAt} />
      <FailureToasts />
      {tabs.map(({ id, Mount }) => (Mount ? <Mount key={id} watching={watcherOf(id)} /> : null))}
    </>
  );
  // 详情页（56 号票）：宽屏右栏封顶在外框宽度的 32%；窄屏整页滑入，挂在盖住底部导航的 .dp-host 上
  return (
    <FrameWidth.Provider value={width}>
      <DetailHost.Provider value={detailHost}>
        {wide ? (
          <div className="app wide">
            {notices}
            {nav}
            <main className="tab-content">{page}</main>
          </div>
        ) : (
          <div className="app narrow">
            {notices}
            <main className="tab-content">{page}</main>
            {nav}
            <div className="dp-host" ref={setDetailHost} />
          </div>
        )}
      </DetailHost.Provider>
    </FrameWidth.Provider>
  );
}

/** 插件给的页签（212 号票）：在用的插件登记了就画它的整页；停用的插件拥有它写"X插件没启用" */
function PluginTab({ id, wide }: { id: string; wide: boolean }) {
  const plugins = usePlugins();
  const tab = plugins.get("tabs", id);
  return tab ? <tab.Page wide={wide} /> : <PluginOffPage plugin={plugins.unavailable("tabs", id)} />;
}

/** 插件没启用的一页（212 号票：页签、侧边栏模式）：标题写插件的名字，下面一句"X插件没启用，这一页暂时看不到" */
function PluginOffPage({ plugin }: { plugin: string | undefined }) {
  const name = plugin ?? "";
  return (
    <div className="chat-col">
      <TopBar title={name} />
      <div className="page-placeholder">{t("ui.plugins.pageUnavailable", { plugin: name })}</div>
    </div>
  );
}

/** 原型：配对等待页的预览（不连守护进程） */
function PairingPreview({ onExit }: { onExit(): void }) {
  const [api] = useState(() => previewPairingApi(navigator.userAgent));
  return <PairingWait api={api} onPaired={onExit} onExit={onExit} />;
}

function Page({ route, wide, folded, navigate }: { route: Route; wide: boolean; folded: readonly NavItem[]; navigate: Navigate }) {
  switch (route.tab) {
    case "secretary":
      return <SecretaryPage wide={wide} at={route.at} />;
    case "tasks":
      return <TasksPage wide={wide} taskId={route.taskId} jobId={route.jobId} at={route.at} navigate={navigate} />;
    case "projects":
      return <ProjectsPage wide={wide} projectId={route.projectId} chat={route.chat} jobId={route.jobId} at={route.at} navigate={navigate} />;
    case "inbox":
      return <InboxPage wide={wide} itemId={route.itemId} navigate={navigate} />;
    case "browse":
      // 浏览（134 号票）：鸿蒙 App 里的原生内置浏览器，内容区是 App 叠上来的 ArkWeb；212 号票起是浏览插件的页签
      return <PluginTab id="browse" wide={wide} />;
    case "calendar":
      // 日历（35 号票）：213 号票起是日历插件的页面（plugins/calendar/），地址照旧由核心拆拼；插件停用时写"日历插件没启用"
      return <PluginRoutePage id="calendar" wide={wide} item={route.date ?? route.month} navigate={navigate} />;
    case "more":
      return <MorePage wide={wide} page={route.page} item={route.item} sub={route.sub} folded={folded} navigate={navigate} />;
    case "pair-approve":
      return <PairingApprove cardId={route.cardId} onBack={() => navigate({ tab: "inbox" })} />;
    case "card":
      return (
        <div className="chat-col">
          <TopBar title={t("shell.card.title")} onBack={() => navigate({ tab: "inbox" })} />
          <div className="scroll page-pad">
            <CardPanel cardId={route.cardId} />
          </div>
        </div>
      );
    case "report":
      // 报告页（113 号票）：文本类附件渲染着看；不属于主导航的哪一项
      return <ReportPage mediaId={route.mediaId} />;
    case "pair-wait":
    // 内置浏览器（132 号票）盖在底下那一页上，由 Shell 画，不在这里
    case "app":
      return null;
  }
}
