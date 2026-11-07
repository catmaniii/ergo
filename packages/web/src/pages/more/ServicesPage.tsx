// 设置 · 数据与设备 · 服务（428）：地址 #/more/services[/<服务 id>]，和"体检"挨着。在二狗里看和开关服务管家里"和二狗有关的"服务——
// 服务管家自己的网页只在电脑上开得了，这一页手机上、电脑上一样。和二狗无关的服务这里不出现（守护进程按共用的判定挑，体检也用它）。
// 一个服务一块：名字、状态、id、端口、在跑多久、为什么和二狗有关；最近一次出错；受保护的（二狗自己、它的外网隧道、tailnet 网关、
// 二狗离不开的）写原因、没有停止 / 重启按钮、开着的开机自启关不掉。按钮：启动 / 停止、重启、强制停止（有正常停止办法时才有）、
// 取消等空闲再停、看日志、开机自启开关。用户亲手点的不出审批卡；强制停止、关开机自启先弹确认框。结果和失败原因照实写在那一块下面。
// 地址带了服务 id（体检里点过来）时，那一块描一圈主色并滚到它。右上"刷新"重取；开着时每 15 秒自己再取一次。
// 每个服务能点什么、话怎么说都在状态层（state/managed-services.ts）；列表（ServicesList）是纯渲染，测试在 Node 里直接渲染。
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  type ManagedServiceAction,
  type ManagedServiceLogsView,
  type ManagedServicesView,
  type ManagedServiceView,
  managedServiceActionLabel,
  managedServiceActionNeedsConfirm,
  managedServiceActions,
  managedServiceAutostartLocked,
  managedServiceConfirmText,
  managedServiceMeta,
  managedServiceName,
  managedServiceProtectionText,
  managedServiceResultText,
  managedServiceStateText,
  managedServiceStateTone,
  managedServiceUseText,
  t,
} from "../../state/index.ts";
import { Sheet, TopBar } from "../../ui/common.tsx";

/** 开着这一页时多久自己重取一次 */
const REFRESH_MS = 15_000;

/** 一个服务下面那一句结果 */
export interface ServiceResult {
  ok: boolean;
  text: string;
}

export interface ServicesListProps {
  view: ManagedServicesView;
  now: number;
  /** 正在做操作的那个服务 */
  working?: string | undefined;
  results: Readonly<Record<string, ServiceResult>>;
  /** 地址里带的那个（描一圈） */
  focus?: string | undefined;
  /** 展开了日志的那个 */
  logsOpen?: string | undefined;
  onAct(service: ManagedServiceView, action: ManagedServiceAction): void;
  onToggleLogs(id: string): void;
  /** 展开着的日志那一块（页面里是会自己取的 ServiceLogs，测试里不给） */
  renderLogs?: (id: string) => ReactNode;
}

/** 取不到列表时的那一句（没接入、没连上、服务管家太老、服务管家没给） */
export function servicesStatusText(view: ManagedServicesView): string | undefined {
  if (view.support !== "supported") return t(`pages.services.support.${view.support}`);
  if (view.error) return t("pages.services.listFailed", { reason: view.error.message || view.error.code });
  if (view.services.length === 0) return t("pages.services.empty");
  return undefined;
}

/** 一个服务一块 */
export function ServiceCard({ service: s, now, working, result, focus, logsOpen, onAct, onToggleLogs, logs }: {
  service: ManagedServiceView;
  now: number;
  working: boolean;
  result: ServiceResult | undefined;
  focus: boolean;
  logsOpen: boolean;
  onAct(service: ManagedServiceView, action: ManagedServiceAction): void;
  onToggleLogs(id: string): void;
  logs?: ReactNode;
}) {
  const tone = managedServiceStateTone(s.state);
  const meta = managedServiceMeta(s, now);
  const locked = managedServiceAutostartLocked(s);
  return (
    <li className={`service-row${focus ? " service-focus" : ""}`} data-service={s.id} data-state={s.state}>
      <div className="service-head">
        <span className="service-name">{s.title}</span>
        <span className={`chip service-state service-tone-${tone}`}>{managedServiceStateText(s.state)}</span>
        {s.protection && <span className="chip chip-quiet service-protected-tag">{t("pages.services.protectedTag")}</span>}
      </div>
      <div className="service-meta">{[s.id, ...meta].join(t("pages.services.metaSep"))}</div>
      <div className="chips service-uses">
        {s.uses.map((use) => (
          <span key={use} className="chip chip-data" data-use={use}>
            {managedServiceUseText(use)}
          </span>
        ))}
      </div>
      {s.busy && <div className="service-note">{s.busyReason ? t("pages.services.busyWhy", { why: s.busyReason }) : t("pages.services.busy")}</div>}
      {s.pendingStop && <div className="service-note">{t("pages.services.pendingStop")}</div>}
      {s.lastError && !s.up && <div className="service-error">{t("pages.services.lastError", { error: s.lastError })}</div>}
      {s.protection && <div className="service-protected">{managedServiceProtectionText(s.protection)}</div>}
      {!s.protection && !s.canStop && s.up && <div className="service-note">{t("pages.services.noStopNote")}</div>}
      <div className="service-actions">
        {managedServiceActions(s).map((action) => (
          <button
            key={action}
            type="button"
            className={`btn small ${action === "start" ? "primary" : action === "force_stop" ? "danger" : "ghost"}`}
            data-action={action}
            disabled={working}
            onClick={() => onAct(s, action)}
          >
            {managedServiceActionLabel(action)}
          </button>
        ))}
        <button type="button" className="btn ghost small" data-action="logs" aria-expanded={logsOpen} onClick={() => onToggleLogs(s.id)}>
          {logsOpen ? t("pages.services.hideLogs") : t("pages.services.logs")}
        </button>
        <label className="service-autostart" title={locked ? t("pages.services.autostartLocked") : undefined}>
          <input
            type="checkbox"
            role="switch"
            className="mem-setting-switch"
            data-action="autostart"
            checked={s.autostart}
            disabled={working || locked}
            onChange={(e) => onAct(s, e.currentTarget.checked ? "autostart_on" : "autostart_off")}
          />
          {t("pages.services.autostart")}
        </label>
      </div>
      {working && <div className="service-note">{t("pages.services.working")}</div>}
      {result && (
        <div className={result.ok ? "service-result" : "field-error"} role={result.ok ? "status" : "alert"}>
          {result.text}
        </div>
      )}
      {logsOpen && logs}
    </li>
  );
}

/** 列表（纯渲染）：取不到的写一句；取到了一个服务一块 */
export function ServicesList({ view, now, working, results, focus, logsOpen, onAct, onToggleLogs, renderLogs }: ServicesListProps) {
  const status = servicesStatusText(view);
  return (
    <>
      {status !== undefined && (
        <div className={view.error ? "field-error" : "services-status muted"} role={view.error ? "alert" : undefined} data-support={view.support}>
          {status}
        </div>
      )}
      {view.services.length > 0 && (
        <ul className="service-list">
          {view.services.map((s) => (
            <ServiceCard
              key={s.id}
              service={s}
              now={now}
              working={working === s.id}
              result={results[s.id]}
              focus={focus === s.id}
              logsOpen={logsOpen === s.id}
              onAct={onAct}
              onToggleLogs={onToggleLogs}
              logs={renderLogs?.(s.id)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** 展开的日志：最后几十行（截短、擦掉像密钥的在守护进程做了）；有几份的可以换着看 */
export function ServiceLogsBlock({ logs, loading, onSource }: { logs: ManagedServiceLogsView | undefined; loading: boolean; onSource(source: number): void }) {
  if (logs === undefined) return <div className="service-logs muted">{t("pages.services.logsLoading")}</div>;
  if (!logs.ok) return <div className="service-logs field-error">{t("pages.services.logsFailed", { reason: logs.message || logs.code })}</div>;
  return (
    <div className="service-logs" data-loading={loading ? "" : undefined}>
      <div className="service-logs-head">
        {logs.sources.length > 1 ? (
          logs.sources.map((s) => (
            <button key={s.source} type="button" className={`chip${s.source === logs.source ? " chip-op" : ""}`} onClick={() => onSource(s.source)}>
              {s.label}
            </button>
          ))
        ) : (
          <span className="muted">{logs.label}</span>
        )}
        {logs.cut && <span className="muted">{t("pages.services.logsCut", { count: logs.lines.length, n: logs.lines.length })}</span>}
      </div>
      {logs.lines.length === 0 ? <div className="muted">{t("pages.services.logsEmpty")}</div> : <pre className="service-logs-text">{logs.lines.join("\n")}</pre>}
    </div>
  );
}

/** 页面里的日志：展开时取一次，换一份再取 */
function ServiceLogs({ id }: { id: string }) {
  const { http } = useStore();
  const [source, setSource] = useState<number | undefined>(undefined);
  // 取到的是哪一份：换了一份、还没取到时上一份照着显示（变淡）
  const [got, setGot] = useState<{ source: number | undefined; logs: ManagedServiceLogsView }>();
  useEffect(() => {
    let alive = true;
    http.managedServiceLogs(id, source).then(
      (logs) => {
        if (alive) setGot({ source, logs });
      },
      (err: unknown) => {
        if (alive) setGot({ source, logs: { ok: false, id, code: "failed", message: err instanceof Error ? err.message : String(err) } });
      },
    );
    return () => {
      alive = false;
    };
  }, [http, id, source]);
  return <ServiceLogsBlock logs={got?.logs} loading={got !== undefined && got.source !== source} onSource={setSource} />;
}

/** 设置里的"服务"一页：标题栏右上"刷新"；item 是地址里带的服务 id（体检里点过来，那一块描一圈、滚到它） */
export function ServicesPage({ title, item, onBack }: { title: string; item?: string | undefined; onBack: (() => void) | undefined }) {
  const { http } = useStore();
  const [view, setView] = useState<ManagedServicesView>();
  const [loadFailed, setLoadFailed] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string>();
  const [results, setResults] = useState<Record<string, ServiceResult>>({});
  const [confirming, setConfirming] = useState<{ service: ManagedServiceView; action: ManagedServiceAction }>();
  const [logsOpen, setLogsOpen] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const scrolled = useRef(false);

  const load = useCallback(
    () =>
      http.managedServices().then(
        (v) => {
          setView(v);
          setLoadFailed(undefined);
          setNow(Date.now());
        },
        (err: unknown) => setLoadFailed(err instanceof Error ? err.message : String(err)),
      ),
    [http],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // 右上"刷新"：点了到取回来之间按钮灰着
  const refresh = () => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  };

  // 体检里点过来的：取到列表后滚到那一块（只滚一次）
  useEffect(() => {
    if (item === undefined || view === undefined || scrolled.current) return;
    scrolled.current = true;
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-service]")).find((x) => x.dataset.service === item);
    el?.scrollIntoView({ block: "center" });
  }, [item, view]);

  const run = (service: ManagedServiceView, action: ManagedServiceAction) => {
    setConfirming(undefined);
    setWorking(service.id);
    setResults(({ [service.id]: _old, ...rest }) => rest);
    http.managedServiceAction(service.id, action).then(
      (result) => {
        setResults((r) => ({ ...r, [service.id]: managedServiceResultText(result, managedServiceName(service), service.protection) }));
        if (result.service) {
          const next = result.service;
          setView((v) => (v ? { ...v, services: v.services.map((s) => (s.id === next.id ? next : s)) } : v));
        }
        setNow(Date.now());
      },
      (err: unknown) => setResults((r) => ({ ...r, [service.id]: { ok: false, text: t("pages.services.err.other", { message: err instanceof Error ? err.message : String(err) }) } })),
    ).finally(() => setWorking(undefined));
  };

  const onAct = (service: ManagedServiceView, action: ManagedServiceAction) => {
    if (managedServiceActionNeedsConfirm(action)) setConfirming({ service, action });
    else run(service, action);
  };

  const confirmText = confirming ? managedServiceConfirmText(confirming.action, managedServiceName(confirming.service)) : undefined;
  return (
    <div className="chat-col">
      <TopBar title={title} onBack={onBack}>
        <button type="button" className="btn ghost small" data-action="refresh" disabled={loading} onClick={refresh}>
          {loading ? t("pages.services.refreshing") : t("pages.services.refresh")}
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <div className="services-page">
          <div className="services-intro muted">{t("pages.services.intro")}</div>
          {view === undefined && loadFailed === undefined && <div className="muted">{t("pages.services.loading")}</div>}
          {loadFailed !== undefined && (
            <div className="field-error" role="alert">
              {t("pages.services.loadFailed", { reason: loadFailed })}
            </div>
          )}
          {view !== undefined && (
            <ServicesList
              view={view}
              now={now}
              working={working}
              results={results}
              focus={item}
              logsOpen={logsOpen}
              onAct={onAct}
              onToggleLogs={(id) => setLogsOpen((open) => (open === id ? undefined : id))}
              renderLogs={(id) => <ServiceLogs id={id} />}
            />
          )}
          {view?.managerUrl !== undefined && (
            <div className="services-manager muted">
              {t("pages.services.managerHint")}{" "}
              <a href={view.managerUrl} target="_blank" rel="noreferrer">
                {view.managerUrl}
              </a>
            </div>
          )}
        </div>
      </div>
      {confirming && confirmText && (
        <Sheet title={confirmText.title} onClose={() => setConfirming(undefined)} center>
          <div className="modal-body services-confirm">
            <p>{confirmText.body}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirming(undefined)}>
              {t("pages.services.confirm.cancel")}
            </button>
            <button type="button" className="btn danger" data-action="confirm" onClick={() => run(confirming.service, confirming.action)}>
              {confirmText.ok}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
