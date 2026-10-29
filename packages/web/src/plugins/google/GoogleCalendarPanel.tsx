// 设置 · 数据源里 Google · 日历下面的那一块（297 号票，dataSources 插槽）：订阅的几个日历（名字、打了码的地址、几个事件、拉不到的原因，
// 每个能删），加一个日历（私密 iCal 地址、可选的名字）——"添加并测试连接"经 POST /api/data-sources/google-calendar（configure）交给守护进程，
// 守护进程拉一遍、认得出是日历才存进密钥区，连上了马上同步一次；交回的整页交给 onView 换上。
// 地址是密钥：输入框是密码框、交了就清空，页面上从不回显（守护进程也只给打了码的）。怎么拿私密地址写在下面（Google 日历网页版的设置里）。
// 按钮、提示是纯渲染的 GoogleCalendarFields（测试在 Node 里直接渲染），GoogleCalendarPanel 接上 HTTP。
import { type FormEvent, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type DataSourceActionResult, type DataSourcesView, type DataSourceView, t } from "../../state/index.ts";

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export interface GoogleCalendarFieldsProps {
  source: DataSourceView;
  address: string;
  name: string;
  busy: boolean;
  /** 上一下的结果（"加好了，同步进来 12 条"）或者没做成的原因 */
  done: string | undefined;
  failed: string | undefined;
  onAddress(value: string): void;
  onName(value: string): void;
  onAdd(): void;
  onRemove(id: string): void;
}

/** 纯渲染：订阅的几个日历、加一个日历的表单、怎么拿私密地址 */
export function GoogleCalendarFields({ source, address, name, busy, done, failed, onAddress, onName, onAdd, onRemove }: GoogleCalendarFieldsProps) {
  const items = source.items ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (address.trim() !== "") onAdd();
  };
  return (
    <div className="gcal-panel">
      {items.length > 0 && (
        <ul className="gcal-feeds">
          {items.map((item) => (
            <li key={item.id} className="gcal-feed" data-feed={item.id}>
              <span className="gcal-feed-main">
                <b>{item.title}</b>
                {item.detail !== undefined && <span className="muted">{item.detail}</span>}
                {item.problem !== undefined && <span className="field-error">{item.problem}</span>}
              </span>
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => onRemove(item.id)} aria-label={t("ui.plugins.google.removeLabel", { name: item.title })}>
                {t("ui.plugins.google.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="gcal-form" onSubmit={submit}>
        <label className="field">
          <span>{items.length > 0 ? t("ui.plugins.google.addAnother") : t("ui.plugins.google.addressLabel")}</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={address}
            placeholder={t("ui.plugins.google.addressPlaceholder")}
            disabled={busy}
            onChange={(e) => onAddress(e.currentTarget.value)}
          />
        </label>
        <label className="field">
          <span>{t("ui.plugins.google.nameLabel")}</span>
          <input className="input" value={name} placeholder={t("ui.plugins.google.namePlaceholder")} disabled={busy} onChange={(e) => onName(e.currentTarget.value)} />
        </label>
        {failed !== undefined && (
          <div className="field-error" role="alert">
            {failed}
          </div>
        )}
        {done !== undefined && <div className="hint">{done}</div>}
        <div className="plugin-actions">
          <button type="submit" className="btn primary small" disabled={busy || address.trim() === ""}>
            {busy ? t("ui.plugins.google.testing") : t("ui.plugins.google.add")}
          </button>
        </div>
      </form>
      <details className="gcal-howto">
        <summary>{t("ui.plugins.google.howtoTitle")}</summary>
        <ol>
          <li>{t("ui.plugins.google.howto1")}</li>
          <li>{t("ui.plugins.google.howto2")}</li>
          <li>{t("ui.plugins.google.howto3")}</li>
        </ol>
        <p className="muted">{t("ui.plugins.google.howtoSafe")}</p>
      </details>
    </div>
  );
}

/** 加好了、删掉了之后说一句 */
function doneText(action: "add" | "remove", result: DataSourceActionResult, id: string): string | undefined {
  const source = result.view.sources.find((s) => s.id === id);
  if (action === "remove") return t("ui.plugins.google.removed");
  if (!source || source.problem !== undefined) return undefined;
  if (result.error !== undefined) return t("ui.plugins.google.addedSyncFailed", { error: result.error });
  return result.added === undefined ? t("ui.plugins.google.addedSyncing") : t("ui.plugins.google.added", { added: result.added });
}

/** 接上 HTTP 的那一块 */
export function GoogleCalendarPanel({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const run = (action: "add" | "remove", values: Record<string, string>) => {
    setBusy(true);
    setDone(undefined);
    setFailed(undefined);
    http
      .dataSourceAction(source.id, { action: "configure", values, idempotencyKey: newKey() })
      .then(
        (result) => {
          onView(result.view);
          setDone(doneText(action, result, source.id));
          if (action === "add" && result.view.sources.find((s) => s.id === source.id)?.problem === undefined) {
            setAddress("");
            setName("");
          }
        },
        (err: unknown) => setFailed(t("ui.plugins.google.failed", { reason: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(false));
  };
  return (
    <GoogleCalendarFields
      source={source}
      address={address}
      name={name}
      busy={busy}
      done={done}
      failed={failed}
      onAddress={setAddress}
      onName={setName}
      onAdd={() => run("add", { add: address.trim(), ...(name.trim() === "" ? {} : { name: name.trim() }) })}
      onRemove={(id) => run("remove", { remove: id })}
    />
  );
}
