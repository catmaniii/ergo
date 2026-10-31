// 设置 · 数据源里 Google · Gmail 下面的那一块（298 号票，dataSources 插槽）：连着的几个账号，加一个账号——"连上并测试"经
// POST /api/data-sources/google-gmail（configure）交给守护进程，守护进程只读地连一遍 Gmail（登录、列邮箱），过了才存进密钥区；
// 能重新测试连接。交回的整页交给 onView 换上。
// 344 号票（多账号）：每个账号一行——完整邮箱、状态和已导入几封、登录没通过的原因；开关（关了不查、不导入）、重新填密码（把地址带到下面的表单）、
// 断开（走内核的确认框，留着已导入的 / 连已导入的一起删，只动这一个账号）。同一个地址再填一次就是换密码。
// 密码是密钥：输入框是密码框、交了就清空，页面上从不回显（守护进程只给邮箱地址，不给密码）。下面写明怎么开两步验证、生成应用专用密码，
// 以及只读（不发信、不删信、不改已读）、密码存在哪、改了 Google 密码会失效。
// 按钮、提示是纯渲染的 GoogleGmailFields（测试在 Node 里直接渲染），GoogleGmailPanel 接上 HTTP。
import { type FormEvent, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type DataSourceItemView, type DataSourceView, type DataSourcesView, t } from "../../state/index.ts";

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
  /** 连上并测试（新账号，或者换已有账号的密码） */
  onSave(): void;
  /** 用存着的把开着的账号再测一次 */
  onRetest(): void;
  /** 开关一个账号 */
  onToggle(item: DataSourceItemView, on: boolean): void;
  /** 重新填这个账号的密码：地址带到表单里 */
  onReenter(item: DataSourceItemView): void;
  /** 断开这一个账号（确认框是内核的页面画的）；不给的不画按钮 */
  onDisconnect?: ((item: DataSourceItemView) => void) | undefined;
}

/** 纯渲染：连着的几个账号、加一个账号的表单、怎么生成应用专用密码 */
export function GoogleGmailFields({ source, address, password, busy, done, failed, onAddress, onPassword, onSave, onRetest, onToggle, onReenter, onDisconnect }: GoogleGmailFieldsProps) {
  const items = source.items ?? [];
  const typed = address.trim().toLowerCase();
  const existing = typed !== "" && items.some((item) => item.title.toLowerCase() === typed);
  const canSave = password.trim() !== "" && typed !== "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSave) onSave();
  };
  return (
    <div className="gcal-panel gmail-panel">
      {items.length > 0 && (
        <ul className="gcal-feeds gmail-accounts">
          {items.map((item) => (
            <li key={item.id} className="gcal-feed gmail-account" data-account={item.id}>
              <span className="gcal-feed-main">
                <b>{item.title}</b>
                {item.detail !== undefined && <span className="muted">{item.detail}</span>}
                {item.problem !== undefined && <span className="field-error">{item.problem}</span>}
              </span>
              <span className="gmail-account-actions">
                {item.problem !== undefined && (
                  <button type="button" className="btn ghost small" disabled={busy} onClick={() => onReenter(item)} aria-label={t("ui.plugins.google.gmail.reenterLabel", { address: item.title })}>
                    {t("ui.plugins.google.gmail.reenter")}
                  </button>
                )}
                {onDisconnect && (
                  <button type="button" className="btn ghost small" disabled={busy} onClick={() => onDisconnect(item)} aria-label={t("ui.plugins.google.gmail.disconnectLabel", { address: item.title })}>
                    {t("ui.plugins.google.gmail.disconnect")}
                  </button>
                )}
                <input
                  type="checkbox"
                  role="switch"
                  className="mem-setting-switch"
                  aria-label={t("ui.plugins.google.gmail.switchLabel", { address: item.title })}
                  checked={!item.off}
                  disabled={busy}
                  onChange={(e) => onToggle(item, e.currentTarget.checked)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <form className="gcal-form" onSubmit={submit}>
        <label className="field">
          <span>{items.length > 0 ? t("ui.plugins.google.gmail.addAnother") : t("ui.plugins.google.gmail.addressLabel")}</span>
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
            {busy ? t("ui.plugins.google.testing") : existing ? t("ui.plugins.google.gmail.change") : t("ui.plugins.google.gmail.connect")}
          </button>
          {items.length > 0 && (
            <button type="button" className="btn ghost small" disabled={busy} onClick={onRetest}>
              {t("ui.plugins.google.gmail.retest")}
            </button>
          )}
        </div>
      </form>
      <details className="gcal-howto" open={items.length === 0}>
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
export function GoogleGmailPanel({ source, onView, onDisconnectItem }: { source: DataSourceView; onView(view: DataSourcesView): void; onDisconnectItem?: ((item: DataSourceItemView) => void) | undefined }) {
  const { http } = useStore();
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failed, setFailed] = useState<string>();
  /** 连上了要说一句、清空表单（填的那个账号过了；再测一次是都过了）；开关的（toggle）页面上看得见，不用说 */
  const run = (values: Record<string, string>, kind: "save" | "retest" | "toggle") => {
    setBusy(true);
    setDone(undefined);
    setFailed(undefined);
    http
      .dataSourceAction(source.id, { action: "configure", values, idempotencyKey: newKey() })
      .then(
        (result) => {
          onView(result.view);
          const now = result.view.sources.find((s) => s.id === source.id);
          const filled = now?.items?.find((item) => item.title.toLowerCase() === values.address?.toLowerCase());
          const ok = now !== undefined && now.problem === undefined && (kind === "save" ? filled !== undefined && filled.problem === undefined : kind === "retest" && now.needsAuth !== true);
          if (ok) {
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
      onSave={() => run({ address: address.trim(), password }, "save")}
      onRetest={() => run({}, "retest")}
      onToggle={(item, on) => run({ account: item.id, enabled: on ? "on" : "off" }, "toggle")}
      onReenter={(item) => {
        setAddress(item.title);
        setPassword("");
        setDone(undefined);
        setFailed(undefined);
      }}
      onDisconnect={onDisconnectItem}
    />
  );
}
