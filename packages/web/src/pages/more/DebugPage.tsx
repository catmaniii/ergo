// Debug 工具集（124 号票，用户 2026-10-14 提）：关于页连点版本号 8 次打开，1 小时内有效（只在页面内存里，刷新、重开 App 就没了）。
// 顶上写还剩几分钟和"现在收起"；正停在这一页时到期不踢出去（返回后设置列表里就没有这一项了）。五组，每组一张卡：
// - 系统通知：状态（App 的通知权限、App 现在算前台还是后台，"请求授权""去系统设置"；浏览器里是浏览器通知的授权）、
//   只在本机发一条（延迟 0 / 5 / 15 / 60 秒，App 里"前台也强制发"）、完整链路的测试提醒（守护进程按它的钟定一条【测试】提醒，
//   真走提醒模块）、假的<名字>新消息提醒（走 109 号票的出口，不往会话里写）、通知记录（最近 20 条）；
// - 版本与环境：关于页那几个版本，加上原生桥有哪些方法、UA、屏幕和视口、安全区、风格和深浅色、主色、页面开了多久；一键复制；
// - 连接：WebSocket 现在的状态、断线和重连各几次、最近一次断线；测一次延迟（daemon_info 的往返）；断开重连；模拟有新版本；
// - 语音：录 3 秒再回放、录 3 秒送识别、合成念一句（DebugVoice.tsx）；
// - 日志与本机存储：页面日志（最近 200 条，复制、清空）、本机存储里二狗记的键（敏感的不显示值）、重置首次提示。
// 不在鸿蒙 App 里时 App 专属的项灰掉，写"只在鸿蒙 App 里能用"；旧版 App 缺方法的写明原因，不报错。
import { useCallback, useEffect, useState } from "react";
import { useAccess } from "../../app/access.tsx";
import { APP_VERSION, PAGE_WEB_VERSION } from "../../app/build-info.ts";
import type { ConnectionStats } from "../../app/connection.ts";
import { copyText, environmentRows, nativeBridgeMethods, resetFirstPrompts, type ResetResult, storageSnapshot } from "../../app/debug-page.ts";
import type { NativeNotifyState } from "../../app/native-notify.ts";
import { closeDebug, notifyLog, PAGE_OPENED_AT, pageLog, useDebugUnlock, useListStore } from "../../app/page-debug.ts";
import { pageNativeApp } from "../../app/page-native.ts";
import { pageNotifier } from "../../app/page-notify.ts";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import {
  ASSISTANT_NAME_MARK,
  type ConnectionStatus,
  NOTIFY_OUTCOME_LABEL,
  NOTIFY_VIA_LABEL,
  nowIso,
  pageLogText,
  t,
  tTable,
  uptimeText,
} from "../../state/index.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { T } from "../../ui/i18n.tsx";
import { useToast } from "../../ui/toast.tsx";
import { connectionText, daemonText, PROTOTYPE, useDaemonInfo, useMinuteClock } from "./AboutPage.tsx";
import { DebugVoice } from "./DebugVoice.tsx";
import { appOnly, DebugCard, DebugChoices, DebugRow, clockOf as clock } from "./debug-parts.tsx";

/** 本机发一条、假的新消息提醒可选的延迟（秒）：留时间切到后台 */
const LOCAL_DELAYS = [0, 5, 15, 60] as const;
/** 完整链路的测试提醒多少秒后到点 */
const CHAIN_DELAYS = [5, 15, 60] as const;

export function DebugPage({ navigate }: { navigate: Navigate }) {
  const { open, minutesLeft } = useDebugUnlock();
  // 进来时开着的：到期了也不踢出去
  const [entered] = useState(open);
  if (!open && !entered) {
    return (
      <div className="page-placeholder">
        <span>{t("pages.debug.notOpen")}</span>
        <span className="muted">{t("pages.debug.notOpenHint")}</span>
        <button type="button" className="btn ghost small" onClick={() => navigate({ tab: "more", page: "about" })}>
          {t("pages.debug.goAbout")}
        </button>
      </div>
    );
  }
  return (
    <div className="debug">
      <div className="card debug-head">
        <span>{open ? t("pages.debug.minutesLeft", { count: minutesLeft }) : t("pages.debug.expired")}</span>
        {open && (
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              closeDebug();
              navigate({ tab: "more", page: "about" });
            }}
          >
            {t("pages.debug.closeNow")}
          </button>
        )}
      </div>
      <NotifyCard />
      <EnvCard />
      <ConnectionCard />
      <DebugVoice />
      <LogCard />
    </div>
  );
}

/** 浏览器通知的授权 */
function browserPermission(): string {
  if (typeof window === "undefined" || !("Notification" in window)) return t("pages.debug.browserNoNotify");
  const p = Notification.permission;
  return t(p === "granted" ? "pages.debug.permission.granted" : p === "denied" ? "pages.debug.permission.denied" : "pages.debug.permission.notAsked");
}

/** App 的通知状态的写法 */
function appNotifyText(state: NativeNotifyState | undefined): string {
  if (!state) return t("pages.debug.appNoReply");
  return t("pages.debug.appNotify.text", {
    enabled: t(state.enabled ? "pages.debug.appNotify.on" : "pages.debug.appNotify.off"),
    asked: t(state.asked ? "pages.debug.appNotify.asked" : "pages.debug.appNotify.notAsked"),
  });
}

// ───────────────────────── 系统通知 ─────────────────────────

function NotifyCard() {
  const { createReminder, daemonInfo, showAlert } = useStore();
  const toast = useToast();
  const app = pageNativeApp();
  const notify = app?.notify;
  const [appState, setAppState] = useState(() => notify?.state());
  const [permission, setPermission] = useState(browserPermission);
  const [delay, setDelay] = useState<(typeof LOCAL_DELAYS)[number]>(5);
  const [force, setForce] = useState(false);
  const [pending, setPending] = useState<string>();
  const [chainDelay, setChainDelay] = useState<(typeof CHAIN_DELAYS)[number]>(15);
  const [chain, setChain] = useState<string>();
  const records = useListStore(notifyLog);

  // 从系统设置回来（页面回到前台、拿回焦点）再看一眼；前台还是后台每两秒看一眼
  const refresh = useCallback(() => {
    setAppState(notify?.state());
    setPermission(browserPermission());
  }, [notify]);
  useEffect(() => {
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 2000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [refresh]);

  /** 过 delay 秒再做 run（中间显示还差几秒） */
  const afterDelay = (what: string, run: () => void) => {
    if (delay === 0) {
      run();
      setPending(t("pages.debug.handedOff", { what }));
      return;
    }
    setPending(t("pages.debug.sendingIn", { what, count: delay }));
    setTimeout(() => {
      run();
      setPending(t("pages.debug.handedOff", { what }));
    }, delay * 1000);
  };

  const sendLocal = () =>
    afterDelay(t("pages.debug.localNotify.what"), () => {
      const at = nowIso();
      pageNotifier().show(
        { id: `debug-local-${Date.now()}`, title: t("pages.debug.localNotify.title"), body: t("pages.debug.localNotify.body", { time: clock(at) }), route: "#/more/debug" },
        force ? { force: true } : undefined,
      );
    });

  const sendFakeAssistant = () =>
    afterDelay(t("pages.debug.fakeAlert.what"), () => {
      const n = Date.now();
      // 109 号票的出口：顶上的提醒和系统通知，点开去会话页；不往会话里写真消息（不进上下文）
      showAlert({ id: `secretary:debug-${n}`, title: t("pages.debug.fakeAlert.title", { name: ASSISTANT_NAME_MARK }), body: t("pages.debug.fakeAlert.body"), secretary: { at: `debug-${n}`, through: Number.MAX_SAFE_INTEGER } });
    });

  const startChain = async () => {
    const seconds = chainDelay;
    // 按守护进程的钟算到点的时刻：手机和电脑的钟差几秒也是那边的 N 秒后
    let offset = 0;
    let basis = t("pages.debug.chain.daemonClock");
    try {
      const sentAt = Date.now();
      const info = await daemonInfo();
      offset = Date.parse(info.now) - (sentAt + Date.now()) / 2;
    } catch (err) {
      basis = t("pages.debug.chain.deviceClock", { reason: err instanceof Error ? err.message : String(err) });
    }
    const at = new Date(Date.now() + offset + seconds * 1000);
    createReminder(t("pages.debug.chain.reminderTitle", { seconds }), { kind: "once", at: nowIso(at) });
    setChain(t("pages.debug.chain.set", { time: clock(nowIso(at)), basis }));
    toast(t("pages.debug.chain.toast", { count: seconds }));
  };

  return (
    <DebugCard title={t("pages.debug.notify.title")}>
      <div className="debug-sub">{t("pages.debug.notify.status")}</div>
      {notify ? (
        <>
          <DebugRow label={t("pages.debug.notify.appPermission")}>{appNotifyText(appState)}</DebugRow>
          <DebugRow label={t("pages.debug.notify.appIsNow")}>{appState?.foreground === undefined ? t("pages.debug.notify.appTooOldToTell") : appState.foreground ? t("pages.debug.notify.foreground") : t("pages.debug.notify.background")}</DebugRow>
          <div className="debug-actions">
            <button type="button" className="btn ghost small" onClick={() => void notify.prepare(false).then((s) => setAppState(s ?? notify.state()))}>
              {t("pages.debug.notify.request")}
            </button>
            <button type="button" className="btn ghost small" onClick={() => void notify.prepare(true).then((s) => setAppState(s ?? notify.state()))}>
              {t("pages.debug.notify.openSettings")}
            </button>
          </div>
          <div className="hint">{t("pages.debug.notify.requestHint")}</div>
        </>
      ) : (
        <>
          <DebugRow label={t("pages.debug.notify.browser")}>{permission}</DebugRow>
          <DebugRow label={t("pages.debug.notify.appPermissionAndState")} off>
            {app ? t("pages.debug.notify.appTooOldNoNotify") : appOnly()}
          </DebugRow>
          <div className="debug-actions">
            <button
              type="button"
              className="btn ghost small"
              disabled={!("Notification" in window)}
              onClick={() => void Notification.requestPermission().then(() => setPermission(browserPermission()))}
            >
              {t("pages.debug.notify.request")}
            </button>
            <button type="button" className="btn ghost small" disabled title={appOnly()}>
              {t("pages.debug.notify.openSettings")}
            </button>
          </div>
        </>
      )}

      <div className="debug-sub">{t("pages.debug.local.title")}</div>
      <DebugRow label={t("pages.debug.local.delay")}>
        <DebugChoices<(typeof LOCAL_DELAYS)[number]> values={LOCAL_DELAYS} value={delay} onChange={setDelay} unit={t("pages.debug.secondsUnit")} />
      </DebugRow>
      <DebugRow label={t("pages.debug.local.force")} off={!notify?.canForce}>
        {notify?.canForce ? (
          <input type="checkbox" role="switch" checked={force} onChange={(e) => setForce(e.currentTarget.checked)} aria-label={t("pages.debug.local.force")} />
        ) : notify ? (
          t("pages.debug.local.appTooOldNoForce")
        ) : (
          appOnly()
        )}
      </DebugRow>
      <div className="debug-actions">
        <button type="button" className="btn primary small" onClick={sendLocal}>
          {t("pages.debug.local.send")}
        </button>
        <button type="button" className="btn ghost small" onClick={sendFakeAssistant}>
          {t("pages.debug.local.sendFake")}
        </button>
      </div>
      <div className="hint">
        <T k="pages.debug.local.hint" params={{ name: <NamedText text={ASSISTANT_NAME_MARK} /> }} />
      </div>
      {pending && <div className="debug-status">{pending}</div>}

      <div className="debug-sub">{t("pages.debug.chain.title")}</div>
      <DebugRow label={t("pages.debug.chain.dueIn")}>
        <DebugChoices<(typeof CHAIN_DELAYS)[number]> values={CHAIN_DELAYS} value={chainDelay} onChange={setChainDelay} unit={t("pages.debug.secondsUnit")} />
      </DebugRow>
      <div className="debug-actions">
        <button type="button" className="btn primary small" onClick={() => void startChain()}>
          {t("pages.debug.chain.start")}
        </button>
      </div>
      <div className="hint">{t("pages.debug.chain.hint")}</div>
      {chain && <div className="debug-status">{chain}</div>}

      <div className="debug-sub">{t("pages.debug.records.title")}</div>
      {records.length === 0 ? (
        <div className="muted">{t("pages.debug.records.empty")}</div>
      ) : (
        <ol className="debug-list">
          {records.toReversed().map((r, i) => (
            <li key={`${r.at}-${r.id}-${i}`}>
              <span className="debug-time">{clock(r.at)}</span>
              <span className={`debug-tag ${r.outcome}`}>{NOTIFY_OUTCOME_LABEL[r.outcome]}</span>
              <span>{r.via ? NOTIFY_VIA_LABEL[r.via] : "—"}</span>
              {r.forced && <span className="debug-tag">{t("pages.debug.records.forced")}</span>}
              <span className="debug-mono">{r.id}</span>
              {r.detail && <span className="muted">{r.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      {notify && !notify.canForce && <div className="hint">{t("pages.debug.records.oldApp", { label: NOTIFY_OUTCOME_LABEL.no_reply })}</div>}
    </DebugCard>
  );
}

// ───────────────────────── 版本与环境 ─────────────────────────

/** 守护进程的钟减这台设备的钟（毫秒；问的时候含一次往返的误差） */
function clockDiffText(ms: number): string {
  const seconds = Math.abs(ms) / 1000;
  if (seconds < 0.1) return t("pages.debug.clockDiff.tiny");
  return t(ms > 0 ? "pages.debug.clockDiff.ahead" : "pages.debug.clockDiff.behind", { seconds: seconds.toFixed(1) });
}

function EnvCard() {
  const toast = useToast();
  const access = useAccess();
  const daemon = useDaemonInfo();
  const now = useMinuteClock();
  const app = pageNativeApp();
  const [env, setEnv] = useState(environmentRows);
  // 转屏、换风格之后点一下"重新看"
  const methods = nativeBridgeMethods();
  const clockDiff = daemon.info && daemon.receivedAt !== undefined ? clockDiffText(Date.parse(daemon.info.now) - daemon.receivedAt) : daemonText(daemon, now);
  const rows: { label: string; value: string; off?: boolean }[] = [
    { label: t("pages.debug.env.ergo"), value: APP_VERSION },
    { label: t("pages.debug.env.pageBuild"), value: PAGE_WEB_VERSION ?? t("pages.debug.env.devServer") },
    { label: t("pages.debug.env.daemon"), value: daemonText(daemon, now) },
    { label: t("pages.debug.env.clockDiff"), value: clockDiff },
    { label: t("pages.debug.env.harmonyApp"), value: app ? app.version : appOnly(), off: !app },
    { label: t("pages.debug.env.thisDevice"), value: connectionText(access) },
    { label: t("pages.debug.env.bridgeMethods"), value: methods ? methods.join(t("pages.common.listSep")) : appOnly(), off: !methods },
    ...env,
    { label: t("pages.debug.env.uptime"), value: uptimeText(now - PAGE_OPENED_AT) },
  ];
  const copy = async () => {
    const text = [t("pages.debug.env.copyHead", { time: nowIso() }), ...rows.map((r) => t("pages.debug.env.copyRow", { label: r.label, value: r.value }))].join("\n");
    toast((await copyText(text)) ? t("pages.debug.env.copied") : t("pages.debug.copyFailed"));
  };
  return (
    <DebugCard
      title={t("pages.debug.env.title")}
      extra={
        <span className="debug-actions">
          <button type="button" className="btn ghost small" onClick={() => setEnv(environmentRows())}>
            {t("pages.debug.refresh")}
          </button>
          <button type="button" className="btn primary small" onClick={() => void copy()}>
            {t("pages.debug.env.copyAll")}
          </button>
        </span>
      }
    >
      {rows.map((r) => (
        <DebugRow key={r.label} label={r.label} off={r.off}>
          {r.value}
        </DebugRow>
      ))}
    </DebugCard>
  );
}

// ───────────────────────── 连接 ─────────────────────────

const CONNECTION_LABEL: Readonly<Record<ConnectionStatus, string>> = tTable({
  connecting: "pages.debug.connection.connecting",
  online: "pages.debug.connection.online",
  offline: "pages.debug.connection.offline",
  outdated: "pages.debug.connection.outdated",
  unpaired: "pages.debug.connection.unpaired",
});

function ConnectionCard() {
  const { ui, daemonInfo, connectionStats, reconnect, notePageUpdate } = useStore();
  const toast = useToast();
  const [stats, setStats] = useState<ConnectionStats>(connectionStats);
  const [pings, setPings] = useState<string[]>([]);
  useEffect(() => {
    const timer = setInterval(() => setStats(connectionStats()), 1000);
    return () => clearInterval(timer);
  }, [connectionStats]);

  const ping = async () => {
    const started = performance.now();
    try {
      await daemonInfo();
      const ms = Math.round(performance.now() - started);
      setPings((p) => [t("pages.debug.connection.ping", { time: clock(nowIso()), ms }), ...p].slice(0, 5));
    } catch (err) {
      setPings((p) => [t("pages.debug.connection.pingFailed", { time: clock(nowIso()), reason: err instanceof Error ? err.message : String(err) }), ...p].slice(0, 5));
    }
  };

  return (
    <DebugCard title={t("pages.debug.connection.title")}>
      <DebugRow label="WebSocket">{PROTOTYPE ? t("pages.debug.connection.prototype") : CONNECTION_LABEL[ui.connection]}</DebugRow>
      <DebugRow label={t("pages.debug.connection.sinceOpened")}>{t("pages.debug.connection.drops", { drops: stats.drops, reconnects: stats.reconnects })}</DebugRow>
      <DebugRow label={t("pages.debug.connection.lastDrop")}>{stats.lastDrop ? `${clock(stats.lastDrop.at)} · ${stats.lastDrop.reason}` : t("pages.debug.connection.neverDropped")}</DebugRow>
      <div className="debug-actions">
        <button type="button" className="btn ghost small" onClick={() => void ping()}>
          {t("pages.debug.connection.measure")}
        </button>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            reconnect();
            toast(t("pages.debug.connection.reconnecting"));
          }}
        >
          {t("pages.debug.connection.reconnect")}
        </button>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            notePageUpdate({ kind: "web_version", version: `debug-${Date.now()}` });
            toast(t("pages.debug.connection.fakeUpdateToast"));
          }}
        >
          {t("pages.debug.connection.fakeUpdate")}
        </button>
      </div>
      {pings.length > 0 && (
        <ul className="debug-list">
          {pings.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <div className="hint">{t("pages.debug.connection.hint")}</div>
    </DebugCard>
  );
}

// ───────────────────────── 日志与本机存储 ─────────────────────────

function LogCard() {
  const toast = useToast();
  const entries = useListStore(pageLog);
  const [storage, setStorage] = useState(storageSnapshot);
  const [reset, setReset] = useState<ResetResult>();
  const app = pageNativeApp();

  return (
    <DebugCard title={t("pages.debug.log.title")}>
      <div className="debug-sub">{t("pages.debug.log.pageLog", { count: entries.length })}</div>
      <div className="debug-actions">
        <button
          type="button"
          className="btn ghost small"
          disabled={entries.length === 0}
          onClick={() => void copyText(pageLogText(entries)).then((ok) => toast(ok ? t("pages.debug.log.copied") : t("pages.debug.copyFailed")))}
        >
          {t("pages.debug.log.copy")}
        </button>
        <button type="button" className="btn ghost small" disabled={entries.length === 0} onClick={() => pageLog.clear()}>
          {t("pages.debug.log.clear")}
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="muted">{t("pages.debug.log.empty")}</div>
      ) : (
        <ol className="debug-log">
          {entries.toReversed().map((e, i) => (
            <li key={`${e.at}-${i}`} className={e.source === "console.warn" ? "warn" : "error"}>
              <span className="debug-time">{clock(e.at)}</span> <span className="debug-tag">{e.source}</span>
              <pre>{e.text}</pre>
            </li>
          ))}
        </ol>
      )}

      <div className="debug-sub">{t("pages.debug.storage.title")}</div>
      <div className="debug-actions">
        <button type="button" className="btn ghost small" onClick={() => setStorage(storageSnapshot())}>
          {t("pages.debug.refresh")}
        </button>
      </div>
      {storage.length === 0 ? (
        <div className="muted">{t("pages.debug.storage.empty")}</div>
      ) : (
        storage.map((row) => (
          <DebugRow key={`${row.area}:${row.key}`} label={`${row.area === "localStorage" ? "local" : "session"} · ${row.key}`}>
            <span className={row.masked ? "muted" : "debug-mono"}>{row.value}</span>
          </DebugRow>
        ))
      )}
      <div className="hint">{t("pages.debug.storage.hint")}</div>

      <div className="debug-sub">{t("pages.debug.reset.title")}</div>
      <div className="debug-actions">
        <button type="button" className="btn ghost small" onClick={() => setReset(resetFirstPrompts())}>
          {t("pages.debug.reset.button")}
        </button>
      </div>
      {reset && (
        <>
          <DebugRow label={t("pages.debug.reset.page")}>{reset.page}</DebugRow>
          <DebugRow label="App" off={!app}>
            {reset.app}
          </DebugRow>
        </>
      )}
      <div className="hint">{t("pages.debug.reset.hint")}</div>
    </DebugCard>
  );
}
