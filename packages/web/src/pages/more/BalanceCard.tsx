// 消耗页顶上的"DeepSeek 余额"（440）：总余额（币种照服务商回的，CNY 写 ¥）、其中赠送 / 充值、能用 / 余额不多了 / 余额不足、
// 几分钟前查的、刷新按钮。数据经 HTTP 取（GET /api/usage/balance；刷新是 POST，守护进程防连点，按钮照 nextRefreshAt 灰掉）。
// 没配 Key：只一句"在 设置 · 模型 填了 DeepSeek 的 Key 才能看余额"。这次没查成：写原因，有上次查到的照旧显示。
// "去充值"打开服务商开放平台的充值页（守护进程给的 topUpUrl）：走 app/page-in-app-browser.ts 的 openInAppBrowser——
// 在 App 里（有原生内置浏览器、浏览插件启用着）交给浏览插件登记的打开办法，在"浏览"页签里打开并切过去；
// 电脑浏览器里新标签页打开；没有内置浏览器的 App（旧版安卓 App）里新开窗口会被 App 接住、交给系统浏览器。余额不足时它是主色。
// 服务商以后不止一个时，一个一块。
import { useEffect, useState } from "react";
import { openInAppBrowser } from "../../app/page-in-app-browser.ts";
import { useStore } from "../../app/store.tsx";
import {
  balanceAgo,
  balanceLowLine,
  balanceMoney,
  balanceRefreshWait,
  balanceStatus,
  balanceStatusLabel,
  balanceWhy,
  type ProviderBalance,
  type ProviderBalanceView,
  t,
} from "../../state/index.ts";

/** "几分钟前查的"多久重算一次（毫秒） */
const TICK_MS = 15_000;

/** 打开充值页：在 App 的内置浏览器里（切到"浏览"），没有就新标签页 / 交给系统 */
export function openTopUp(url: string): void {
  openInAppBrowser(url);
}

/** 一个服务商的那一块（没配 Key 时只一句话）；页面测试直接渲染它 */
export function ProviderBalanceBlock({
  entry,
  lowBelow,
  now,
  refreshing,
  onRefresh,
  onTopUp = openTopUp,
}: {
  entry: ProviderBalance;
  lowBelow: Readonly<Record<string, number>>;
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
  /** 点"去充值"（测试换成假的） */
  onTopUp?: (url: string) => void;
}) {
  const name = entry.label;
  if (!entry.configured) return <div className="muted balance-nokey">{t("pages.usage.balance.noKey", { name })}</div>;
  const { result, failure } = entry;
  const status = result ? balanceStatus(result) : undefined;
  const wait = balanceRefreshWait(entry, now);
  const line = balanceLowLine(entry, lowBelow);
  return (
    <section className={`balance-card${status ? ` balance-${status}` : ""}`} aria-label={t("pages.usage.balance.title", { name })}>
      <div className="balance-head">
        <h3 className="balance-title">{t("pages.usage.balance.title", { name })}</h3>
        {status && <span className={`chip balance-state ${status === "available" ? "chip-ok" : status === "low" ? "chip-op" : "chip-no"}`}>{balanceStatusLabel(status)}</span>}
        <div className="balance-actions">
          {entry.topUpUrl && (
            <button type="button" className={`btn small balance-topup ${status === "unavailable" ? "primary" : "ghost"}`} title={entry.topUpUrl} onClick={() => onTopUp(entry.topUpUrl!)}>
              {t("pages.usage.balance.topUp")}
            </button>
          )}
          <button type="button" className="btn ghost small balance-refresh" disabled={refreshing || wait > 0} title={wait > 0 ? t("pages.usage.balance.refreshWait", { seconds: wait }) : undefined} onClick={onRefresh}>
            {refreshing ? t("pages.usage.balance.refreshing") : t("pages.usage.balance.refresh")}
          </button>
        </div>
      </div>
      {failure && <div className="hint balance-failed">{t(result ? "pages.usage.balance.failedKept" : "pages.usage.balance.failed", { why: balanceWhy(failure.problem, name) })}</div>}
      {result && (
        <>
          {result.balances.map((b) => (
            <div className="balance-amounts" key={b.currency}>
              <div className="balance-total">
                <span className="stat-v balance-total-v">{balanceMoney(b.currency, b.total)}</span>
                <span className="muted">{t("pages.usage.balance.total")}</span>
              </div>
              <div className="muted balance-split">{t("pages.usage.balance.split", { granted: balanceMoney(b.currency, b.granted), toppedUp: balanceMoney(b.currency, b.toppedUp) })}</div>
            </div>
          ))}
          <div className="muted balance-foot">
            <span className="balance-ago">{balanceAgo(result.checkedAt, now)}</span>
            {line && <span> · {t("pages.usage.balance.lowLine", { threshold: line })}</span>}
            <span> · {t("pages.usage.balance.free")}</span>
          </div>
          {status === "unavailable" && <div className="hint balance-out">{t("pages.usage.balance.unavailableHint", { name })}</div>}
        </>
      )}
    </section>
  );
}

export function BalanceCard() {
  const { http } = useStore();
  const [view, setView] = useState<ProviderBalanceView>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    http.balance().then(
      (v) => {
        if (!alive) return;
        setView(v);
        setError(undefined);
        setNow(Date.now());
      },
      (err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [http]);

  // "几分钟前查的"跟着走；刷新防连点的那几秒到了按钮重新能点
  const wait = view?.providers.reduce((most, entry) => Math.max(most, balanceRefreshWait(entry, now)), 0) ?? 0;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait * 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const refresh = () => {
    setRefreshing(true);
    http.refreshBalance().then(
      (v) => {
        setView(v);
        setError(undefined);
        setRefreshing(false);
        setNow(Date.now());
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setRefreshing(false);
      },
    );
  };

  if (!view) {
    return (
      <div className="balance">
        {error ? <div className="hint balance-error">{t("pages.usage.balance.loadFailed", { reason: error })}</div> : <div className="muted balance-loading">{t("pages.usage.balance.loading")}</div>}
      </div>
    );
  }
  return (
    <div className="balance">
      {view.providers.map((entry) => (
        <ProviderBalanceBlock key={entry.provider} entry={entry} lowBelow={view.lowBelow} now={now} refreshing={refreshing} onRefresh={refresh} />
      ))}
      {error && <div className="hint balance-error">{t("pages.usage.balance.loadFailed", { reason: error })}</div>}
    </div>
  );
}
