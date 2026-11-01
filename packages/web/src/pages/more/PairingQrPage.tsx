// 设置 · 设备配对 · 配对二维码（地址 #/more/devices/qr）：大二维码、下面写着地址、"等手机扫码"。
// - 地址问守护进程（app/page-connection-addresses.ts）：公网 → tailnet → 手填，打通过的排前面，打不通的标明但仍然列出；有多个时能切换；
// - 码里只有地址，普通网址，不放口令；配对规则不变，手机发来请求时就在这个界面上核对、批准，不用换页；批准后写"连好了"；
// - 没有地址时不显示二维码，写清楚"二狗现在从外面连不上"，给两条路：去服务管家开通、填一个自己的地址。不做局域网。
// 纯渲染的部分（PairingQrContent）不碰网络，测试在 Node 里直接渲染。
import { useEffect, useState } from "react";
import { useAccess } from "../../app/access.tsx";
import { addressKindLabel, addressNotes, manualAddressProblem } from "../../app/connection-addresses.ts";
import { useConnectionAddresses } from "../../app/page-connection-addresses.ts";
import { useStore } from "../../app/store.tsx";
import type { PairingPayload } from "../../model/cards.ts";
import { type CardState, type ConnectionAddress, type ConnectionAddressesView, pendingPairingCardIds, t } from "../../state/index.ts";
import { AutomatedHint, codeLabel, fingerprintLabel } from "../../ui/cards/cards.tsx";
import { TopBar, useNow } from "../../ui/common.tsx";
import { QrCode } from "../../ui/qr-code.tsx";

export function PairingQrPage({ title, onBack }: { title: string; onBack: (() => void) | undefined }) {
  return (
    <div className="chat-col">
      <TopBar title={title} onBack={onBack} />
      <div className="scroll page-pad">
        <PairingQrPanel />
      </div>
    </div>
  );
}

/** 二维码界面的内容（设置向导的手机配对这一步也放它）：取地址、配对请求就地批准 */
export function PairingQrPanel() {
  const { view, error, saveManual } = useConnectionAddresses();
  const access = useAccess();
  const { ui, cardAction, seeAlert } = useStore();
  const now = useNow();
  // 配对请求就出现在这个界面上，顶上那条"新设备请求配对"不用再弹，弹了还盖住标题
  useEffect(() => {
    for (const alert of ui.alerts) {
      const cardId = alert.itemId ? ui.inbox[alert.itemId]?.cardId : undefined;
      if (cardId && ui.cards[cardId]?.card.type === "pairing") seeAlert(alert.id);
    }
  }, [ui.alerts, ui.inbox, ui.cards, seeAlert]);
  // 在这个界面上出现过的配对请求：批准、拒绝之后留着一行结果（"连好了"），不是一闪就没了
  const pending = pendingPairingCardIds(ui, now);
  const [seen, setSeen] = useState<readonly string[]>([]);
  const fresh = pending.filter((id) => !seen.includes(id));
  if (fresh.length > 0) setSeen([...seen, ...fresh]);
  const requests = [...seen, ...fresh].flatMap((id) => {
    const state = ui.cards[id];
    return state ? [state] : [];
  });
  return <PairingQrContent view={view} error={error} local={access?.access === "local"} requests={requests} onCard={(id, action) => cardAction(id, action)} onSaveManual={saveManual} />;
}

export interface PairingQrContentProps {
  view: ConnectionAddressesView | undefined;
  error: string | undefined;
  /** 这台就是装二狗的电脑（服务管家的链接只在这里打得开） */
  local: boolean;
  /** 这个界面上出现过的配对请求（新的在后） */
  requests: readonly CardState[];
  onCard(cardId: string, action: "approve" | "deny"): void;
  onSaveManual(manual: string | null): Promise<string | undefined>;
}

export function PairingQrContent({ view, error, local, requests, onCard, onSaveManual }: PairingQrContentProps) {
  const addresses = view?.addresses ?? [];
  // 选了哪个地址（按网址记）：没选过、选的那个没了，都用排第一的
  const [picked, setPicked] = useState<string>();
  const current = addresses.find((address) => address.url === picked) ?? addresses[0];
  return (
    <div className="pair-qr">
      {requests.map((state) => (
        <PairingRequestPanel key={state.card.id} state={state} onCard={onCard} />
      ))}
      {view === undefined && error === undefined && <div className="muted">{t("pages.devices.qr.loading")}</div>}
      {error !== undefined && (
        <div className="field-error" role="alert">
          {t("pages.devices.qr.loadFailed", { reason: error })}
        </div>
      )}
      {view !== undefined &&
        (current === undefined ? (
          <NoAddress view={view} local={local} onSaveManual={onSaveManual} />
        ) : (
          <>
            <div className="card pair-qr-card">
              <QrCode text={current.url} label={t("pages.devices.qr.title")} />
              <div className="pair-qr-url mono">{current.url}</div>
              <AddressDescription address={current} />
              <div className="pair-qr-wait think-live">{t("pages.devices.qr.waiting")}</div>
              <div className="muted pair-qr-hint">{t("pages.devices.qr.scanHint")}</div>
            </div>
            {addresses.length > 1 && <AddressSwitcher addresses={addresses} current={current} onPick={setPicked} />}
            {view.rejected.length > 0 && <div className="muted pair-qr-hint">{t("pages.devices.qr.rejected", { count: view.rejected.length })}</div>}
            <ManualAddress key={view.manual ?? ""} manual={view.manual} onSave={onSaveManual} foldable />
          </>
        ))}
    </div>
  );
}

/** 这个地址是什么、打没打通 */
function AddressDescription({ address }: { address: ConnectionAddress }) {
  return (
    <div className="pair-qr-desc">
      <b>{addressKindLabel(address)}</b>
      {addressNotes(address).map((note) => (
        <span key={note} className={address.reachable === false && note === t("pages.devices.qr.state.unreachable") ? "pair-qr-warn" : "muted"}>
          {note}
        </span>
      ))}
    </div>
  );
}

/** 换一个地址：每个地址一行，当前这个标出来 */
function AddressSwitcher({ addresses, current, onPick }: { addresses: readonly ConnectionAddress[]; current: ConnectionAddress; onPick(url: string): void }) {
  return (
    <section className="pair-qr-switch" aria-label={t("pages.devices.qr.switch")}>
      <div className="pair-qr-switch-title">{t("pages.devices.qr.switch")}</div>
      {addresses.map((address) => (
        <button key={address.url} type="button" className={`pair-qr-option${address.url === current.url ? " on" : ""}`} aria-pressed={address.url === current.url} onClick={() => onPick(address.url)}>
          <span className="pair-qr-option-url mono">{address.url}</span>
          <AddressDescription address={address} />
        </button>
      ))}
    </section>
  );
}

/** 没有可用的地址：不显示二维码，写清楚怎么回事，给两条路 */
function NoAddress({ view, local, onSaveManual }: { view: ConnectionAddressesView; local: boolean; onSaveManual(manual: string | null): Promise<string | undefined> }) {
  const managerUrl = view.managerUrl;
  return (
    <div className="card pair-qr-none">
      <h2>{t("pages.devices.qr.none.title")}</h2>
      <p className="muted">{t("pages.devices.qr.none.body")}</p>
      {view.rejected.length > 0 && <p className="pair-qr-warn">{t("pages.devices.qr.rejected", { count: view.rejected.length })}</p>}
      <section className="pair-qr-way">
        <h3>{t("pages.devices.qr.none.managerTitle")}</h3>
        <p className="muted">{t("pages.devices.qr.none.managerBody")}</p>
        {view.manager === "unsupported" && <p className="muted">{t("pages.devices.qr.none.managerOld")}</p>}
        {managerUrl === undefined ? (
          <p className="muted">{t("pages.devices.qr.none.managerUnknown")}</p>
        ) : local ? (
          <a className="btn ghost" href={managerUrl} target="_blank" rel="noreferrer">
            {t("pages.devices.qr.none.managerLink")}
          </a>
        ) : (
          <p className="muted">{t("pages.devices.qr.none.managerOnComputer", { url: managerUrl })}</p>
        )}
      </section>
      <section className="pair-qr-way">
        <h3>{t("pages.devices.qr.none.manualTitle")}</h3>
        <ManualAddress key={view.manual ?? ""} manual={view.manual} onSave={onSaveManual} />
      </section>
    </div>
  );
}

/** 手填的地址：自己搭的反代、frp，服务管家不知道的。foldable 时先收着，已经填过的直接展开 */
function ManualAddress({ manual, onSave, foldable = false }: { manual: string | undefined; onSave(manual: string | null): Promise<string | undefined>; foldable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(manual ?? "");
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const run = async (value: string | null) => {
    setSaving(true);
    setProblem(await onSave(value));
    setSaving(false);
  };
  const save = () => {
    const bad = manualAddressProblem(draft);
    if (bad !== undefined) return setProblem(bad);
    void run(draft);
  };
  if (foldable && !open && manual === undefined) {
    return (
      <button type="button" className="link pair-qr-manual-open" onClick={() => setOpen(true)}>
        {t("pages.devices.qr.manual.title")}
      </button>
    );
  }
  return (
    <div className="pair-qr-manual">
      {foldable && <div className="pair-qr-switch-title">{t("pages.devices.qr.manual.title")}</div>}
      <p className="muted">{t("pages.devices.qr.manual.body")}</p>
      <input
        className="mono"
        type="url"
        inputMode="url"
        value={draft}
        placeholder={t("pages.devices.qr.manual.placeholder")}
        aria-label={t("pages.devices.qr.manual.title")}
        disabled={saving}
        onChange={(e) => {
          setDraft(e.target.value);
          setProblem(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      {problem !== undefined && (
        <div className="field-error" role="alert">
          {problem}
        </div>
      )}
      <div className="auth-actions">
        {manual !== undefined && (
          <button type="button" className="btn ghost" disabled={saving} onClick={() => void run(null)}>
            {t("pages.devices.qr.manual.remove")}
          </button>
        )}
        <button type="button" className="btn primary" disabled={saving} onClick={save}>
          {saving ? t("pages.devices.qr.manual.saving") : t("pages.devices.qr.manual.save")}
        </button>
      </div>
    </div>
  );
}

/** 手机发来的配对请求：设备名、短码、短指纹，就在这里批准、拒绝；处理完留一行结果 */
function PairingRequestPanel({ state, onCard }: { state: CardState; onCard(cardId: string, action: "approve" | "deny"): void }) {
  const { card, pending } = state;
  const p = card.payload as PairingPayload;
  if (card.status !== "pending") {
    const approved = card.outcome?.action === "approve";
    const text =
      card.status === "expired" ? t("pages.devices.qr.request.expired", { name: p.deviceName }) : approved ? t("pages.devices.qr.request.connected", { name: p.deviceName }) : t("pages.devices.qr.request.denied", { name: p.deviceName });
    return <div className={`card pair-qr-result${approved ? " ok" : " muted"}`}>{approved ? `✓ ${text}` : text}</div>;
  }
  return (
    <div className="card pair-qr-request" data-pairing-request={card.id}>
      <h2>{t("pages.devices.qr.request.title")}</h2>
      <div className="muted">{t("pages.pairing.approve.matchHint")}</div>
      <dl className="kv kv-big">
        <dt>{t("pages.pairing.approve.deviceName")}</dt>
        <dd>
          <b>{p.deviceName}</b>
        </dd>
        <dt>{t("pages.pairing.shortCode")}</dt>
        <dd>
          <b className="mono">{codeLabel(p.shortCode)}</b>
        </dd>
        <dt>{t("pages.pairing.fingerprint")}</dt>
        <dd>
          <b className="mono">{fingerprintLabel(p.fingerprint)}</b>
        </dd>
        <dt>{t("pages.pairing.approve.from")}</dt>
        <dd>{p.from}</dd>
      </dl>
      {p.automated && <AutomatedHint reason={p.automated.reason} />}
      {pending?.status === "failed" && <div className="error">{t("pages.pairing.approve.failed", { error: pending.error })}</div>}
      {pending?.status === "sending" ? (
        <div className="muted">{t("pages.pairing.approve.sending")}</div>
      ) : (
        <>
          <div className="hint">{t("pages.pairing.approve.warning")}</div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => onCard(card.id, "deny")}>
              {t("pages.pairing.approve.deny")}
            </button>
            <button type="button" className="btn primary" onClick={() => onCard(card.id, "approve")}>
              {t("pages.pairing.approve.approve")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
