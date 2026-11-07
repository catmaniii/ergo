// 设置 · 数据源 · 高德地图 下面插件画的那一块（429，dataSources 插槽）：
// - 三个密码框：Web 端（JS API）的 Key、它的安全密钥（地图用，两样一起填）、Web 服务的 Key（选填，以后查地点和路线用）；
//   不回显，填了才发；存着的不填就是"沿用存着的、再测一次"。经 POST 交给守护进程，先测再存进密钥区，回来的整页里没有它们，发完马上清掉；
// - "测试并保存"：结果按回来的整页写一句（测过了 / 没通过的原因）；
// - 几句说明：Key 在哪建、只存在这台电脑上、安全密钥不进网页，地图服务看得到什么。
// 组件本身是纯渲染加一个请求（AmapPanelView 不碰 HTTP，测试在 Node 里直接渲染）。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type DataSourcesView, type DataSourceView, t } from "../../state/index.ts";

/** 交给守护进程的三样（名字和守护进程 map/amap.ts 的 AMAP_SECRET 一样） */
export const AMAP_FIELDS = ["jsKey", "securityCode", "serviceKey"] as const;
export type AmapField = (typeof AMAP_FIELDS)[number];

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 存着 Key 没有：连着或出错、账号那一行有 */
export function hasSavedAmapKey(source: DataSourceView): boolean {
  return (source.connection === "connected" || source.connection === "error") && source.account !== undefined;
}

/** 测完以后说一句：这个数据源在回来的整页里连着、没有问题就是过了 */
export function amapResultOf(view: DataSourcesView, id: string): { ok: boolean; text: string } {
  const source = view.sources.find((s) => s.id === id);
  if (source && source.connection === "connected" && source.problem === undefined) return { ok: true, text: t("ui.plugins.map.panel.ok", { account: source.account ?? "" }) };
  return { ok: false, text: t("ui.plugins.map.panel.failed", { problem: source?.problem ?? t("ui.plugins.map.panel.unknown") }) };
}

export interface AmapPanelViewProps {
  source: DataSourceView;
  values: Readonly<Record<AmapField, string>>;
  busy: boolean;
  result: { ok: boolean; text: string } | undefined;
  onValue(field: AmapField, text: string): void;
  onSubmit(): void;
}

/** 纯渲染的那一块 */
export function AmapPanelView({ source, values, busy, result, onValue, onSubmit }: AmapPanelViewProps) {
  const saved = hasSavedAmapKey(source);
  const typed = AMAP_FIELDS.some((f) => values[f].trim() !== "");
  const canSubmit = !busy && (typed || saved);
  return (
    <div className="looki-panel amap-panel">
      <div className="looki-title">{t(saved ? "ui.plugins.map.panel.titleSaved" : "ui.plugins.map.panel.title")}</div>
      {AMAP_FIELDS.map((field) => (
        <label key={field} className="field" data-field={field}>
          <span>{t(`ui.plugins.map.panel.${field}`)}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={values[field]}
            placeholder={t(saved ? "ui.plugins.map.panel.keep" : field === "serviceKey" ? "ui.plugins.map.panel.optional" : "ui.plugins.map.panel.required")}
            disabled={busy}
            onChange={(e) => onValue(field, e.currentTarget.value)}
          />
        </label>
      ))}
      <div className="plugin-actions">
        <button type="button" className="btn primary small" disabled={!canSubmit} onClick={onSubmit}>
          {busy ? t("ui.plugins.map.panel.testing") : t(saved && !typed ? "ui.plugins.map.panel.retest" : "ui.plugins.map.panel.submit")}
        </button>
      </div>
      {result && (
        <div className={result.ok ? "hint" : "field-error"} role="status">
          {result.text}
        </div>
      )}
      <ul className="source-notes">
        <li>{t("ui.plugins.map.panel.howTo")}</li>
        <li>{t("ui.plugins.map.panel.keySafe")}</li>
        <li>{t("ui.plugins.map.panel.privacy")}</li>
      </ul>
    </div>
  );
}

const EMPTY: Record<AmapField, string> = { jsKey: "", securityCode: "", serviceKey: "" };

/** 插槽里的那一块：填 Key、测试并保存 */
export function AmapPanel({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const [values, setValues] = useState<Record<AmapField, string>>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  const submit = () => {
    const sent = Object.fromEntries(AMAP_FIELDS.flatMap((f) => (values[f].trim() === "" ? [] : [[f, values[f].trim()]])));
    setBusy(true);
    setResult(undefined);
    http
      .dataSourceAction(source.id, { action: "configure", values: sent, idempotencyKey: newKey() })
      .then(
        (res) => {
          onView(res.view);
          setResult(amapResultOf(res.view, source.id));
          setValues(EMPTY);
        },
        (err: unknown) => setResult({ ok: false, text: t("ui.plugins.map.panel.failed", { problem: err instanceof Error ? err.message : String(err) }) }),
      )
      .finally(() => setBusy(false));
  };

  return <AmapPanelView source={source} values={values} busy={busy} result={result} onValue={(f, v) => setValues((old) => ({ ...old, [f]: v }))} onSubmit={submit} />;
}
