/**
 * 主框架：竖屏底部 5 个 tab（秘书、任务、项目、待我处理、更多）；宽屏时 tab 变成左侧竖栏，内容区分栏。
 * 宽窄按内容区的实际宽度判断（和 AgentSense 一样以 600 为界），所以原型的"手机宽度"预览也能直接用。
 *
 * 由守护进程提供页面时先问一次这个页面被信任吗（/api/access，10 号票）：外网端口上还没配对的设备只看到配对等待页；
 * 用着用着凭证失效了（被吊销、过期），连接报 unpaired，也回到配对等待页。被吊销的设备不自动重新申请：
 * 浏览器里留着"本设备已被吊销"的记号，刷新之后也一样（state/pairing-gate.ts、app/revoked-mark.ts）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessProvider } from "./app/access.tsx";
import { fetchAccess, httpPairingApi } from "./app/pairing-api.ts";
import { revokedMark } from "./app/revoked-mark.ts";
import { type Navigate, type Route, type Tab, useRoute } from "./app/route.ts";
import { StoreProvider, useStore } from "./app/store.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { MorePage } from "./pages/MorePage.tsx";
import { PairingApprove, PairingWait } from "./pages/PairingPages.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { SecretaryPage } from "./pages/SecretaryPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import type { Connection } from "./app/connection.ts";
import { type DaemonHttp, HttpDaemonClient } from "./app/daemon-http.ts";
import { FakeDaemonHttp } from "./prototype/fake-http.ts";
import { daemonSocketUrl, WebSocketConnection } from "./app/ws-connection.ts";
import { FakeConnection } from "./prototype/fake-connection.ts";
import { SplitConnection } from "./prototype/split-connection.ts";
import { type AccessInfo, CHANNELS, type CredentialRejection, inboxBadge, type PairingOpening, pairingOpening, revokedMarkAfter } from "./state/index.ts";
import { previewPairingApi } from "./prototype/preview-pairing.ts";
import { ProtoProvider } from "./prototype/proto-store.tsx";
import { AlertsView, FailureToasts } from "./ui/alerts.tsx";
import { CardPanel } from "./ui/cards/CardPanel.tsx";
import { TopBar, useElementWidth } from "./ui/common.tsx";
import { ToastProvider, ToastView } from "./ui/toast.tsx";

/** 鸿蒙"一多"断点：≥600 视为宽屏（AgentSense 同） */
const WIDE_MIN = 600;

const TABS: { route: Route & { tab: Tab }; label: string; icon: string }[] = [
  { route: { tab: "secretary" }, label: "秘书", icon: "💬" },
  { route: { tab: "tasks" }, label: "任务", icon: "📋" },
  { route: { tab: "projects" }, label: "项目", icon: "📦" },
  { route: { tab: "inbox" }, label: "待我处理", icon: "🔔" },
  { route: { tab: "more" }, label: "更多", icon: "⋯" },
];

/** 页面由守护进程提供（http://127.0.0.1:8810）；直接打开构建产物（file://）时没有守护进程，全部用原型的假数据 */
const SERVED_BY_DAEMON = window.location.protocol !== "file:";

/**
 * 已经接上真数据的频道：04 号票起是秘书会话；06 号票起卡片、待我处理，以及看板频道（目前只有简单提醒，
 * 看板页面接真数据在 12 号票）；10 号票起已配对设备；29 号票起工作日历；15 号票起项目列表（项目的维护者会话打开时再订阅）。
 * 后面的票往这里加
 */
const REAL_CHANNELS = [CHANNELS.secretary, CHANNELS.cards, CHANNELS.inbox, CHANNELS.board, CHANNELS.activity, CHANNELS.devices, CHANNELS.workdayCalendar, CHANNELS.watchCategories, CHANNELS.projects];

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

/** 这个页面被信任吗：问的路上、问到了（问不到也照常进，连不上时界面会提示）、还没配对（配对等待页怎么开场） */
type AccessState = { kind: "checking" } | { kind: "ready"; info?: AccessInfo } | { kind: "unpaired"; opening: PairingOpening };

function useAccessCheck(): AccessState {
  const [state, setState] = useState<AccessState>(SERVED_BY_DAEMON ? { kind: "checking" } : { kind: "ready" });
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

/** 外网端口上还没配对（或者凭证失效了）：只有配对等待页（不连 WebSocket，连了也会被拒） */
function Unpaired({ opening }: { opening: PairingOpening }) {
  return <PairingWait api={httpPairingApi} onPaired={reload} opening={opening} onReapply={() => revokedMark.set(false)} />;
}

/** 用着用着连接报 unpaired：按知道的原因和浏览器里的记号定开场（打开这一页时定一次） */
function UnpairedNow({ reason }: { reason: CredentialRejection | undefined }) {
  const [opening] = useState(() => pairingOpening(reason, revokedMark.get()));
  return <Unpaired opening={opening} />;
}

export default function App() {
  const access = useAccessCheck();
  if (access.kind === "checking") return null;
  if (access.kind === "unpaired") return <Unpaired opening={access.opening} />;
  return (
    <AccessProvider access={access.info}>
      <StoreProvider connection={connection} http={http}>
        <ToastProvider>
          <ProtoProvider realBoard={SERVED_BY_DAEMON && REAL_CHANNELS.includes(CHANNELS.board)}>
            <PrototypeStage />
          </ProtoProvider>
        </ToastProvider>
      </StoreProvider>
    </AccessProvider>
  );
}

const PHONE_PREF = "ergou-proto-phone";

function readPhonePref(): boolean {
  try {
    return localStorage.getItem(PHONE_PREF) === "1";
  } catch {
    return false;
  }
}

/** 原型：在宽屏浏览器里可以切到手机宽度（390）查看，不用开开发者工具 */
function PrototypeStage() {
  const [phone, setPhone] = useState(readPhonePref);
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const choose = (v: boolean) => {
    setPhone(v);
    try {
      localStorage.setItem(PHONE_PREF, v ? "1" : "0");
    } catch {
      // 存不了就只在这次打开里生效
    }
  };
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const framed = phone && winW >= 760;
  return (
    <div className={`proto-stage${framed ? " phone" : ""}`}>
      {winW >= 760 && (
        <div className="proto-bar" role="group" aria-label="原型预览宽度">
          <span>{SERVED_BY_DAEMON ? "秘书页、待我处理、卡片、已配对设备和工作日历已接守护进程；其他页面仍是原型的假数据" : "原型：全部是假数据，点按钮只改本地的假状态"}</span>
          <button type="button" className={framed ? "" : "on"} onClick={() => choose(false)}>
            自适应宽度
          </button>
          <button type="button" className={framed ? "on" : ""} onClick={() => choose(true)}>
            手机竖屏 390
          </button>
        </div>
      )}
      <div className="proto-main">
        <div className="proto-frame" ref={ref}>
          <Shell width={width} />
          <ToastView />
        </div>
      </div>
    </div>
  );
}

function Shell({ width }: { width: number }) {
  const wide = width >= WIDE_MIN;
  const [route, navigate] = useRoute();
  const { ui } = useStore();
  const badge = inboxBadge(ui);
  const openInboxItem = useCallback((itemId: string) => navigate({ tab: "inbox", itemId }), [navigate]);

  // 用着用着凭证失效了（外网端口上被吊销、过期）：回到配对等待页
  if (ui.connection === "unpaired") return <UnpairedNow reason={ui.unpairedReason} />;
  // 配对等待页的预览（设置 · 已配对设备里点进来）：新设备上看到的样子，用假的配对接口，没有 tab
  if (route.tab === "pair-wait") return <PairingPreview onExit={() => navigate({ tab: "more", page: "devices" })} />;

  const active: Tab = route.tab === "pair-approve" || route.tab === "card" ? "inbox" : route.tab;
  const tabs = TABS.map((t) => (
    <button key={t.route.tab} type="button" className={`tab${active === t.route.tab ? " on" : ""}`} aria-current={active === t.route.tab ? "page" : undefined} onClick={() => navigate(t.route)}>
      <span className="tab-icon" aria-hidden="true">
        {t.icon}
        {t.route.tab === "inbox" && badge.unread > 0 && <i className="tab-dot" />}
        {t.route.tab === "inbox" && badge.seenPending > 0 && <i className="tab-count">{badge.seenPending}</i>}
      </span>
      <span>
        {t.label}
        {t.route.tab === "inbox" && (badge.unread > 0 || badge.seenPending > 0) && (
          <span className="sr-only">
            （{badge.unread} 条未读，{badge.seenPending} 条看过没处理）
          </span>
        )}
      </span>
    </button>
  ));
  const page = <Page route={route} wide={wide} navigate={navigate} />;
  // 到点的提醒：在任意页面顶上提示；被拒的请求在底部提示原因
  const notices = (
    <>
      <AlertsView onOpen={openInboxItem} />
      <FailureToasts />
    </>
  );
  return wide ? (
    <div className="app wide">
      {notices}
      <nav className="siderail" aria-label="主导航">
        <div className="siderail-brand">二狗</div>
        {tabs}
      </nav>
      <main className="tab-content">{page}</main>
    </div>
  ) : (
    <div className="app narrow">
      {notices}
      <main className="tab-content">{page}</main>
      <nav className="tabbar" aria-label="主导航">
        {tabs}
      </nav>
    </div>
  );
}

/** 原型：配对等待页的预览（不连守护进程） */
function PairingPreview({ onExit }: { onExit(): void }) {
  const [api] = useState(() => previewPairingApi(navigator.userAgent));
  return <PairingWait api={api} onPaired={onExit} onExit={onExit} />;
}

function Page({ route, wide, navigate }: { route: Route; wide: boolean; navigate: Navigate }) {
  switch (route.tab) {
    case "secretary":
      return <SecretaryPage wide={wide} />;
    case "tasks":
      return <TasksPage wide={wide} taskId={route.taskId} navigate={navigate} />;
    case "projects":
      return <ProjectsPage wide={wide} projectId={route.projectId} chat={route.chat} navigate={navigate} />;
    case "inbox":
      return <InboxPage wide={wide} itemId={route.itemId} navigate={navigate} />;
    case "more":
      return <MorePage wide={wide} page={route.page} navigate={navigate} />;
    case "pair-approve":
      return <PairingApprove cardId={route.cardId} onBack={() => navigate({ tab: "inbox" })} />;
    case "card":
      return (
        <div className="chat-col">
          <TopBar title="卡片" onBack={() => navigate({ tab: "inbox" })} />
          <div className="scroll page-pad">
            <CardPanel cardId={route.cardId} />
          </div>
        </div>
      );
    case "pair-wait":
      return null;
  }
}
