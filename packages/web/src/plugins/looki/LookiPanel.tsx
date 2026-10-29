// Looki 的设置那一块（296 号票）：设置 · 数据源里 Looki 下面插件画的（dataSources 插槽）——
// - 区域：中国区（looki.tech）/ 海外（looki.ai）。还没存过 Key 的默认中国区；存着 Key 的不预选（不点就沿用存着的，账号那一行写着现在是哪个区）；
// - API Key：输入框是密码框、不回显，填了才发；存着 Key 时不填就是"沿用存着的、再测一次"。Key 只经 POST 交给守护进程存进密钥区，
//   回来的整页里没有它，发完马上清掉输入框；
// - "测试连接并保存"：守护进程先校验地址、再拿 Key 读账号，过了才存；结果按回来的整页写一句（连上了 / 没连上的原因）；
// - 一段说明：Key 在 Looki 网页版哪里建、只存在这台电脑上；导入到昨天为止（当天的时刻还在变），照片视频不导入。
// 组件本身是纯渲染加一个请求（LookiPanelView 不碰 HTTP，测试在 Node 里直接渲染）。
// 307 号票：后面跟着"存一份到本地"那一块（LookiArchive.tsx：位置、存哪几类、已存多少、补存）。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type DataSourcesView, type DataSourceView, t } from "../../state/index.ts";
import { LookiArchive } from "./LookiArchive.tsx";

/** 区域（和守护进程 looki/api.ts 的一样） */
export type LookiRegion = "cn" | "global";

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 存着 Key 没有：连着或出错、账号那一行有（Looki 存着 Key 时账号那一行至少写着区域；没存过 Key 测试没过的只有出错、没有账号） */
export function hasSavedKey(source: DataSourceView): boolean {
  return (source.connection === "connected" || source.connection === "error") && source.account !== undefined;
}

/** 测试连接回来以后说一句：这个数据源在回来的整页里连着、没有问题就是连上了 */
export function resultOf(view: DataSourcesView, id: string): { ok: boolean; text: string } {
  const source = view.sources.find((s) => s.id === id);
  if (source && source.connection === "connected" && source.problem === undefined) return { ok: true, text: t("ui.plugins.looki.panel.ok", { account: source.account ?? "" }) };
  return { ok: false, text: t("ui.plugins.looki.panel.failed", { problem: source?.problem ?? t("ui.plugins.looki.panel.unknown") }) };
}

export interface LookiPanelViewProps {
  source: DataSourceView;
  region: LookiRegion | undefined;
  keyText: string;
  busy: boolean;
  result: { ok: boolean; text: string } | undefined;
  onRegion(region: LookiRegion): void;
  onKey(text: string): void;
  onSubmit(): void;
}

/** 纯渲染的那一块 */
export function LookiPanelView({ source, region, keyText, busy, result, onRegion, onKey, onSubmit }: LookiPanelViewProps) {
  const connected = hasSavedKey(source);
  const canSubmit = !busy && (keyText.trim() !== "" || connected);
  return (
    <div className="looki-panel">
      <div className="looki-title">{t(connected ? "ui.plugins.looki.panel.titleConnected" : "ui.plugins.looki.panel.title")}</div>
      <div className="seg looki-region" role="radiogroup" aria-label={t("ui.plugins.looki.panel.region")}>
        {(["cn", "global"] as const).map((r) => (
          <button key={r} type="button" role="radio" aria-checked={region === r} className={region === r ? "on" : ""} disabled={busy} onClick={() => onRegion(r)}>
            {t(`ui.plugins.looki.panel.region.${r}`)}
          </button>
        ))}
      </div>
      {connected && region === undefined && <div className="looki-note">{t("ui.plugins.looki.panel.keepRegion")}</div>}
      <label className="field">
        <span>{t("ui.plugins.looki.panel.key")}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={keyText}
          placeholder={t(connected ? "ui.plugins.looki.panel.keyKeep" : "ui.plugins.looki.panel.keyPlaceholder")}
          disabled={busy}
          onChange={(e) => onKey(e.currentTarget.value)}
        />
      </label>
      <div className="plugin-actions">
        <button type="button" className="btn primary small" disabled={!canSubmit} onClick={onSubmit}>
          {busy ? t("ui.plugins.looki.panel.testing") : t(connected && keyText.trim() === "" ? "ui.plugins.looki.panel.retest" : "ui.plugins.looki.panel.submit")}
        </button>
      </div>
      {result && (
        <div className={result.ok ? "hint" : "field-error"} role="status">
          {result.text}
        </div>
      )}
      <ul className="source-notes">
        <li>{t("ui.plugins.looki.panel.howTo")}</li>
        <li>{t("ui.plugins.looki.panel.keySafe")}</li>
        <li>{t("ui.plugins.looki.panel.importNote")}</li>
      </ul>
    </div>
  );
}

/** 插槽里的那一块：填 Key、选区域、测试连接；后面跟着存一份到本地 */
export function LookiPanel({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const [region, setRegion] = useState<LookiRegion | undefined>(hasSavedKey(source) ? undefined : "cn");
  const [keyText, setKeyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  const submit = () => {
    const values: Record<string, string> = { ...(region === undefined ? {} : { region }), ...(keyText.trim() === "" ? {} : { key: keyText.trim() }) };
    setBusy(true);
    setResult(undefined);
    http
      .dataSourceAction(source.id, { action: "configure", values, idempotencyKey: newKey() })
      .then(
        (res) => {
          onView(res.view);
          setResult(resultOf(res.view, source.id));
          setKeyText("");
        },
        (err: unknown) => setResult({ ok: false, text: t("ui.plugins.looki.panel.failed", { problem: err instanceof Error ? err.message : String(err) }) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <LookiPanelView source={source} region={region} keyText={keyText} busy={busy} result={result} onRegion={setRegion} onKey={setKeyText} onSubmit={submit} />
      <LookiArchive source={source} onView={onView} />
    </>
  );
}
