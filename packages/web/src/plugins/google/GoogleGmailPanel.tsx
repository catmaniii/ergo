// 设置 · 数据源里 Google · Gmail 下面的那一块（298 号票，dataSources 插槽）：填 Gmail 地址和应用专用密码——"连上并测试"经
// POST /api/data-sources/google-gmail（configure）交给守护进程，守护进程只读地连一遍 Gmail（登录、列邮箱），过了才存进密钥区；
// 连上以后能换密码、重新测试连接。交回的整页交给 onView 换上。
// 密码是密钥：输入框是密码框、交了就清空，页面上从不回显（守护进程也只给打了码的地址）。下面写明怎么开两步验证、生成应用专用密码，
// 以及只读（不发信、不删信、不改已读）、密码存在哪、改了 Google 密码会失效。
// 按钮、提示是纯渲染的 GoogleGmailFields（测试在 Node 里直接渲染），GoogleGmailPanel 接上 HTTP。
import { type FormEvent, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type DataSourceView, type DataSourcesView, t } from "../../state/index.ts";

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export interface GoogleGmailFieldsProps {
  source: DataSourceView;
  address: string;
  password: string;
  busy: boolean;
  /** 上一下的结果（"连上了"）或者没做成的原因 */
  done: string | undefined;
  failed: string | undefined;
  onAddress(value: string): void;
  onPassword(value: string): void;
  /** 连上并测试（或者换邮箱、换密码） */
  onSave(): void;
  /** 用存着的再测一次 */
  onRetest(): void;
}

/** 纯渲染：填地址和应用专用密码的表单、怎么生成应用专用密码 */
export function GoogleGmailFields({ source, address, password, busy, done, failed, onAddress, onPassword, onSave, onRetest }: GoogleGmailFieldsProps) {
  const connected = source.connection === "connected" || source.account !== undefined;
  const canSave = password.trim() !== "" && (connected || address.trim() !== "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSave) onSave();
  };
  return (
    <div className="gcal-panel gmail-panel">
      <form className="gcal-form" onSubmit={submit}>
        <label className="field">
          <span>{connected ? t("ui.plugins.google.gmail.addressChange") : t("ui.plugins.google.gmail.addressLabel")}</span>
          <input
            className="input"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={address}
            placeholder={t("ui.plugins.google.gmail.addressPlaceholder")}
            disabled={busy}
            onChange={(e) => onAddress(e.currentTarget.value)}
          />
        </label>
        <label className="field">
          <span>{t("ui.plugins.google.gmail.passwordLabel")}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={password}
            placeholder={t("ui.plugins.google.gmail.passwordPlaceholder")}
            disabled={busy}
            onChange={(e) => onPassword(e.currentTarget.value)}
          />
        </label>
        {failed !== undefined && (
          <div className="field-error" role="alert">
            {failed}
          </div>
        )}
        {done !== undefined && <div className="hint">{done}</div>}
        <div className="plugin-actions">
          <button type="submit" className="btn primary small" disabled={busy || !canSave}>
            {busy ? t("ui.plugins.google.testing") : connected ? t("ui.plugins.google.gmail.change") : t("ui.plugins.google.gmail.connect")}
          </button>
          {connected && (
            <button type="button" className="btn ghost small" disabled={busy} onClick={onRetest}>
              {t("ui.plugins.google.gmail.retest")}
            </button>
          )}
        </div>
      </form>
      <details className="gcal-howto" open={!connected}>
        <summary>{t("ui.plugins.google.gmail.howtoTitle")}</summary>
        <ol>
          <li>{t("ui.plugins.google.gmail.howto1")}</li>
          <li>{t("ui.plugins.google.gmail.howto2")}</li>
          <li>{t("ui.plugins.google.gmail.howto3")}</li>
        </ol>
        <p className="muted">{t("ui.plugins.google.gmail.readOnly")}</p>
        <p className="muted">{t("ui.plugins.google.gmail.safe")}</p>
        <p className="muted">{t("ui.plugins.google.gmail.revoked")}</p>
        <p className="muted">{t("ui.plugins.google.gmail.missing")}</p>
      </details>
    </div>
  );
}

/** 接上 HTTP 的那一块 */
export function GoogleGmailPanel({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const run = (values: Record<string, string>) => {
    setBusy(true);
    setDone(undefined);
    setFailed(undefined);
    http
      .dataSourceAction(source.id, { action: "configure", values, idempotencyKey: newKey() })
      .then(
        (result) => {
          onView(result.view);
          const now = result.view.sources.find((s) => s.id === source.id);
          if (now && now.problem === undefined && now.connection === "connected") {
            setDone(result.error !== undefined ? t("ui.plugins.google.gmail.connectedSyncFailed", { error: result.error }) : result.added === undefined ? t("ui.plugins.google.gmail.connected") : t("ui.plugins.google.gmail.connectedImported", { added: result.added, count: result.added }));
            setAddress("");
            setPassword("");
          }
        },
        (err: unknown) => setFailed(t("ui.plugins.google.failed", { reason: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(false));
  };
  return (
    <GoogleGmailFields
      source={source}
      address={address}
      password={password}
      busy={busy}
      done={done}
      failed={failed}
      onAddress={setAddress}
      onPassword={setPassword}
      onSave={() => run({ ...(address.trim() === "" ? {} : { address: address.trim() }), password })}
      onRetest={() => run({})}
    />
  );
}
