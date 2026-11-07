// 设置 · 数据源 · 高德地图那一块里的"试查一下"（432）：填好 Web 服务 Key 后搜一个固定的地点（北京的天安门，不是你的位置），
// 看查地点、算路线通不通。走数据源的"现在能查到的"（POST /api/data-sources/amap/live）：只读，查到的不存。
// - 守护进程在连接状态里带来这一块要的（AmapSourcePanel）：Web 服务 Key 填了没有（没填时按钮灰着、写一句先填）、这个月查了几次；
// - 查完列出搜到的几个（名字、省市区和地址），写明数据来自高德和这次查完时的用量；没查成写原因（Key 不认、到上限、太频繁……）。
// 组件本身是纯渲染加一个请求（AmapTryView 不碰 HTTP，测试在 Node 里直接渲染）。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type AmapSourcePanel, type DataSourceLiveResult, type DataSourceView, isAmapSourcePanel, t } from "../../state/index.ts";

export interface AmapTryViewProps {
  panel: AmapSourcePanel;
  busy: boolean;
  /** 查回来的（state 不是 ok 的写原因） */
  result: DataSourceLiveResult | undefined;
  /** 请求本身没成（连不上守护进程） */
  failed: string | undefined;
  onTry(): void;
}

/** 纯渲染的"试查一下" */
export function AmapTryView({ panel, busy, result, failed, onTry }: AmapTryViewProps) {
  const problem = failed ?? (result !== undefined && result.state !== "ok" ? (result.problem ?? t("ui.plugins.map.panel.unknown")) : undefined);
  const ok = result?.state === "ok" ? result : undefined;
  return (
    <div className="amap-try" data-amap-try="">
      <div className="looki-title">{t("ui.plugins.map.try.title")}</div>
      <div className="hint amap-try-hint">{t(panel.lookup ? "ui.plugins.map.try.hint" : "ui.plugins.map.try.needKey")}</div>
      <div className="plugin-actions">
        <button type="button" className="btn small" data-action="amap-try" disabled={!panel.lookup || busy} onClick={onTry}>
          {busy ? t("ui.plugins.map.try.trying") : t("ui.plugins.map.try.button")}
        </button>
      </div>
      {problem !== undefined && (
        <div className="field-error" role="alert" data-amap-try-state="error">
          {t("ui.plugins.map.try.failed", { problem })}
        </div>
      )}
      {ok && (
        <div className="prompt-rows amap-try-rows" data-amap-try-state="ok">
          {ok.scope !== undefined && <div className="hint amap-try-hint">{ok.scope}</div>}
          {ok.items.map((item) => (
            <div key={item.id} className="prompt-row ds-item" data-item={item.id}>
              <span className="prompt-row-text">
                <span className="ds-item-title">
                  <span className="ds-item-name">{item.title}</span>
                </span>
                {item.subtitle !== undefined && <small className="ds-item-meta">{item.subtitle}</small>}
              </span>
            </div>
          ))}
          {(ok.notes ?? []).map((note) => (
            <div key={note} className="hint amap-try-hint">
              {note}
            </div>
          ))}
        </div>
      )}
      {!ok && <div className="hint amap-try-hint">{t("ui.plugins.map.try.usage", { ...panel.usage })}</div>}
    </div>
  );
}

/** 那一块里的"试查一下"：没连上（连接状态里没带这一块要的）时不画 */
export function AmapTry({ source }: { source: DataSourceView }) {
  const { http } = useStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DataSourceLiveResult>();
  const [failed, setFailed] = useState<string>();
  if (!isAmapSourcePanel(source.panel)) return null;
  const onTry = () => {
    setBusy(true);
    setResult(undefined);
    setFailed(undefined);
    http
      .dataSourceLive(source.id, {})
      .then(setResult, (err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  return <AmapTryView panel={source.panel} busy={busy} result={result} failed={failed} onTry={onTry} />;
}
