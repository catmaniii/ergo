// 设置 · 数据源 · 谷歌地图 下面插件画的那一块（446，dataSources 插槽）：
// - 两个密码框：浏览器用的 Key（Maps JavaScript API，地图页的谷歌底图）、服务端用的 Key（Places API (New)、Routes API、Geocoding API，
//   查地点和路线）；不回显，填了才发；存着的不填就是"沿用存着的、再测一次服务端的"。经 POST 交给守护进程，先测再存进密钥区，
//   回来的整页里没有它们，发完马上清掉；
// - 每个框下面一句怎么在 Google Cloud 给它加限制：浏览器用的会进网页（谷歌的设计），加"网站限制"写这台设备打开二狗的地址
//   （和在外面打开二狗用的地址）、"API 限制"只勾 Maps JavaScript API；服务端用的加"IP 地址"限制、"API 限制"只勾那三个；
// - 这个月每一项用了几次 / 每月免费量；超了的写明先停用了、退回 OpenStreetMap；"超了还接着用"的开关（超出的谷歌按量收费）；
// - 几句说明：去哪看建 Key、设预算提醒和每日上限的步骤（用户手册 · 地图），隐私。
// 组件本身是纯渲染加一个请求（GoogleMapsPanelView 不碰 HTTP，测试在 Node 里直接渲染）。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type DataSourcesView, type DataSourceView, formatNumber, GOOGLE_MAPS_SKUS, type GoogleMapsSourcePanel, isGoogleMapsSourcePanel, t } from "../../state/index.ts";

/** 交给守护进程的两样（名字和守护进程 google-maps/keys.ts 的 GOOGLE_MAPS_SECRET 一样） */
export const GOOGLE_MAPS_FIELDS = ["browserKey", "serverKey"] as const;
export type GoogleMapsField = (typeof GOOGLE_MAPS_FIELDS)[number];

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 测完以后说一句：这个数据源在回来的整页里连着、没有问题就是过了 */
export function googleMapsResultOf(view: DataSourcesView, id: string): { ok: boolean; text: string } {
  const source = view.sources.find((s) => s.id === id);
  if (source && source.connection === "connected" && source.problem === undefined) return { ok: true, text: t("ui.plugins.googleMaps.panel.ok", { account: source.account ?? "" }) };
  return { ok: false, text: t("ui.plugins.googleMaps.panel.failed", { problem: source?.problem ?? t("ui.plugins.googleMaps.panel.unknown") }) };
}

export interface GoogleMapsPanelViewProps {
  source: DataSourceView;
  values: Readonly<Record<GoogleMapsField, string>>;
  busy: boolean;
  result: { ok: boolean; text: string } | undefined;
  /** 这台设备打开二狗的地址（写进"网站限制"那一句） */
  origin: string;
  onValue(field: GoogleMapsField, text: string): void;
  onSubmit(): void;
  onAllowOverage(on: boolean): void;
}

/** 这个月的用量那几行 */
function UsageRows({ panel }: { panel: GoogleMapsSourcePanel }) {
  return (
    <div className="google-maps-usage" data-google-usage="">
      <div className="looki-title">{t("ui.plugins.googleMaps.panel.usageTitle", { month: panel.usage.month })}</div>
      <ul className="google-maps-usage-rows">
        {GOOGLE_MAPS_SKUS.map((sku) => (
          <li key={sku} data-sku={sku} data-over={panel.over.includes(sku) ? "" : undefined}>
            <span>{t(`ui.plugins.googleMaps.sku.${sku}`)}</span>
            <span className="google-maps-usage-count">{t("ui.plugins.googleMaps.panel.usageCount", { count: formatNumber(panel.usage.counts[sku]), limit: formatNumber(panel.usage.limits[sku]) })}</span>
          </li>
        ))}
      </ul>
      {panel.over.length > 0 && (
        <div className={panel.allowOverage ? "hint" : "field-error"} role="status">
          {t(panel.allowOverage ? "ui.plugins.googleMaps.panel.overAllowed" : "ui.plugins.googleMaps.panel.overPaused", { items: panel.over.map((s) => t(`ui.plugins.googleMaps.sku.${s}`)).join(t("pages.common.listSep")) })}
        </div>
      )}
    </div>
  );
}

/** 纯渲染的那一块 */
export function GoogleMapsPanelView({ source, values, busy, result, origin, onValue, onSubmit, onAllowOverage }: GoogleMapsPanelViewProps) {
  const panel = isGoogleMapsSourcePanel(source.panel) ? source.panel : undefined;
  const saved = panel !== undefined && (panel.browserKey || panel.serverKey);
  const typed = GOOGLE_MAPS_FIELDS.some((f) => values[f].trim() !== "");
  const canSubmit = !busy && (typed || panel?.serverKey === true);
  const filled = (f: GoogleMapsField) => (f === "browserKey" ? panel?.browserKey : panel?.serverKey) === true;
  return (
    <div className="looki-panel google-maps-panel" data-google-maps-panel="">
      <div className="looki-title">{t(saved ? "ui.plugins.googleMaps.panel.titleSaved" : "ui.plugins.googleMaps.panel.title")}</div>
      {GOOGLE_MAPS_FIELDS.map((field) => (
        <label key={field} className="field" data-field={field}>
          <span>{t(`ui.plugins.googleMaps.panel.${field}`)}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={values[field]}
            placeholder={t(filled(field) ? "ui.plugins.googleMaps.panel.keep" : "ui.plugins.googleMaps.panel.empty")}
            disabled={busy}
            onChange={(e) => onValue(field, e.currentTarget.value)}
          />
          <small className="hint">{field === "browserKey" ? t("ui.plugins.googleMaps.panel.browserHint", { origin }) : t("ui.plugins.googleMaps.panel.serverHint")}</small>
        </label>
      ))}
      <div className="plugin-actions">
        <button type="button" className="btn primary small" disabled={!canSubmit} onClick={onSubmit}>
          {busy ? t("ui.plugins.googleMaps.panel.testing") : t(saved && !typed ? "ui.plugins.googleMaps.panel.retest" : "ui.plugins.googleMaps.panel.submit")}
        </button>
      </div>
      {result && (
        <div className={result.ok ? "hint" : "field-error"} role="status">
          {result.text}
        </div>
      )}
      {panel && <UsageRows panel={panel} />}
      {panel && (
        <label className="google-maps-overage" data-field="allowOverage">
          <input type="checkbox" checked={panel.allowOverage} disabled={busy} onChange={(e) => onAllowOverage(e.currentTarget.checked)} />
          <span>{t("ui.plugins.googleMaps.panel.allowOverage")}</span>
        </label>
      )}
      <ul className="source-notes">
        <li>{t("ui.plugins.googleMaps.panel.howTo")}</li>
        <li>{t("ui.plugins.googleMaps.panel.billing")}</li>
        <li>{t("ui.plugins.googleMaps.panel.privacy")}</li>
      </ul>
    </div>
  );
}

const EMPTY: Record<GoogleMapsField, string> = { browserKey: "", serverKey: "" };

/** 这台设备打开二狗的地址（file:// 打开的演示页没有，写个占位） */
const pageOrigin = () => (typeof window !== "undefined" && window.location.origin.startsWith("http") ? window.location.origin : "http://127.0.0.1:8810");

/** 插槽里的那一块：填 Key、测试并保存、超了还接着用 */
export function GoogleMapsPanel({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const [values, setValues] = useState<Record<GoogleMapsField, string>>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  const send = (sent: Record<string, string>, keys: boolean) => {
    setBusy(true);
    setResult(undefined);
    http
      .dataSourceAction(source.id, { action: "configure", values: sent, idempotencyKey: newKey() })
      .then(
        (res) => {
          onView(res.view);
          if (keys) {
            setResult(googleMapsResultOf(res.view, source.id));
            setValues(EMPTY);
          }
        },
        (err: unknown) => setResult({ ok: false, text: t("ui.plugins.googleMaps.panel.failed", { problem: err instanceof Error ? err.message : String(err) }) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <GoogleMapsPanelView
      source={source}
      values={values}
      busy={busy}
      result={result}
      origin={pageOrigin()}
      onValue={(f, v) => setValues((old) => ({ ...old, [f]: v }))}
      onSubmit={() => send(Object.fromEntries(GOOGLE_MAPS_FIELDS.flatMap((f) => (values[f].trim() === "" ? [] : [[f, values[f].trim()]]))), true)}
      onAllowOverage={(on) => send({ allowOverage: on ? "on" : "off" }, false)}
    />
  );
}
