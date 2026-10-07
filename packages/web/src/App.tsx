/**
 * 主框架：竖屏底部 5 个 tab（秘书、任务、项目、待我处理、更多）；宽屏时 tab 变成左侧竖栏，内容区分栏。
 * 宽窄按内容区的实际宽度判断（和 AgentSense 一样以 600 为界），所以原型的"手机宽度"预览也能直接用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type Navigate, type Route, type Tab, useRoute } from "./app/route.ts";
import { StoreProvider, useStore } from "./app/store.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { MorePage } from "./pages/MorePage.tsx";
import { PairingApprove, PairingWait } from "./pages/PairingPages.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { SecretaryPage } from "./pages/SecretaryPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import type { Connection } from "./app/connection.ts";
import { daemonSocketUrl, WebSocketConnection } from "./app/ws-connection.ts";
import { FakeConnection } from "./prototype/fake-connection.ts";
import { SplitConnection } from "./prototype/split-connection.ts";
import { CHANNELS, inboxBadge } from "./state/index.ts";
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
 * 看板页面接真数据在 12 号票）。后面的票往这里加
 */
const REAL_CHANNELS = [CHANNELS.secretary, CHANNELS.cards, CHANNELS.inbox, CHANNELS.board];

/**
 * 前端连接只在这里注入，别处不认具体的连接（原型的看板等假数据也只看前端状态层里的变化）。
 * 由守护进程提供页面时，接了真数据的频道走 WebSocket，其余频道仍是原型的假数据。
 */
const connection: Connection = SERVED_BY_DAEMON
  ? new SplitConnection(new WebSocketConnection({ url: daemonSocketUrl(window.location), channels: REAL_CHANNELS }), new FakeConnection(), REAL_CHANNELS)
  : new FakeConnection();

export default function App() {
  return (
    <StoreProvider connection={connection}>
      <ToastProvider>
        <ProtoProvider>
          <PrototypeStage />
        </ProtoProvider>
      </ToastProvider>
    </StoreProvider>
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
          <span>{SERVED_BY_DAEMON ? "秘书页、待我处理和卡片已接守护进程；其他页面仍是原型的假数据" : "原型：全部是假数据，点按钮只改本地的假状态"}</span>
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

  // 配对等待页是新设备上看到的：还没配对，没有 tab
  if (route.tab === "pair-wait") return <PairingWait onExit={() => navigate({ tab: "more", page: "devices" })} />;

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
