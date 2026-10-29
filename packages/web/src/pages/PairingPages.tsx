// 设备配对（规格第 6 节、第 21 节）：
// - 配对页：新设备上看到的（外网端口上还没有凭证）。137 号票起先是一页说明（这是二狗、这台设备还没配对、设备名），
//   用户点"请求配对"才向守护进程发配对请求（公网上的扫描程序只打开页面、不点按钮，就不会再产生配对请求）；
//   之后显示短码和十六进制短指纹，每隔两秒问一次批准了没有；批准后这台设备领到凭证（HttpOnly cookie，
//   页面脚本看不到），进入二狗。请求过期、被拒以后回到说明页，要再点一次才重发。被吊销、凭证过期的设备
//   说明页上写明原因（开场方式见 state/pairing-gate.ts）。鸿蒙 App 里是同一个页面。流程在 app/pairing-flow.ts；
// - 批准页：在已信任的设备或 PC 本机上，显示同样的设备名、短码和短指纹供核对后批准；
//   像网络上的自动访问的请求（137 号票）多一句醒目的提示。
// 时长、位数都取共享协议包里的常量。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type PairingApi, PairingFlow } from "../app/pairing-flow.ts";
import { useCard, useStore } from "../app/store.tsx";
import { outcomeLabel, type PairingPayload } from "../model/cards.ts";
import {
  defaultDeviceName,
  DEVICE_CREDENTIAL_TTL_MS,
  DEVICE_NAME_MAX_LENGTH,
  durationText,
  normalizeDeviceName,
  PAIRING_REQUEST_TTL_MS,
  type PairingIntroNote,
  pairingIntroNote,
  type PairingOpening,
  pairingStage,
  t,
} from "../state/index.ts";
import { AutomatedHint, codeLabel, fingerprintLabel } from "../ui/cards/cards.tsx";
import { TopBar, useNow } from "../ui/common.tsx";
import { timeLabel } from "../util/time.ts";

/** 新设备多久问一次批准了没有 */
const POLL_MS = 2000;

/** 发起配对请求的按钮（说明页上唯一的按钮；按当前语言现取） */
const requestLabel = () => t("pages.pairing.request");

/** 说明页上多说的那一句（pairingIntroNote）：被拒、过期是醒目的，被吊销、凭证过期是说明（按当前语言现取） */
function introNote(note: PairingIntroNote): { text: string; alert: boolean } {
  switch (note) {
    case "denied":
      return { text: t("pages.pairing.note.denied"), alert: true };
    case "expired":
      return { text: t("pages.pairing.note.expired", { duration: durationText(PAIRING_REQUEST_TTL_MS) }), alert: true };
    case "revoked":
      return { text: t("pages.pairing.note.revoked"), alert: false };
    case "credential_expired":
      return { text: t("pages.pairing.note.credentialExpired"), alert: false };
  }
}

export interface PairingWaitProps {
  api: PairingApi;
  /** 配对成功后进入二狗（真实的：重新加载页面，带着新凭证连上） */
  onPaired(): void;
  /** 原型预览：回到设置 */
  onExit?: () => void;
  /** 怎么开场（state/pairing-gate.ts）：新设备、被吊销、凭证过期，只差说明页上说什么；都要点"请求配对"才发请求 */
  opening?: PairingOpening;
  /** 用户点了"请求配对"（真实的：擦掉浏览器里"本设备已被吊销"的记号） */
  onReapply?: () => void;
}

export function PairingWait({ api, onPaired, onExit, opening = "new", onReapply }: PairingWaitProps) {
  const [flow] = useState(() => new PairingFlow(api));
  const { loaded, request, busy, error } = useSyncExternalStore(flow.subscribe, flow.getState);
  // 说明页上的设备名：默认按这台浏览器生成（和守护进程的默认一样），上一个请求过期、被拒的沿用它的
  const [name, setName] = useState(() => defaultDeviceName(navigator.userAgent));
  const now = useNow();
  // 输入框里正在改的名字不被轮询的结果冲掉
  const editing = useRef(false);

  // 打开页面：只问有没有请求（刷新了页面就接着等它），不发请求
  useEffect(() => void flow.open(), [flow]);

  const shownName = request?.deviceName;
  useEffect(() => {
    if (shownName !== undefined && !editing.current) setName(shownName);
  }, [shownName]);

  const stage = pairingStage(request, now);
  // 等批准：每隔两秒问一次（批准了的那一次就领到凭证）；过期、被拒了停下，回到说明页
  const waiting = stage === "waiting" || stage === "claiming";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void flow.poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [flow, waiting]);

  const requestPairing = () => {
    const deviceName = normalizeDeviceName(name);
    if (deviceName === undefined) return flow.setError(t("pages.pairing.nameInvalid"));
    editing.current = false;
    onReapply?.();
    void flow.request(deviceName);
  };

  const rename = async () => {
    editing.current = false;
    if (!request || stage !== "waiting") return;
    const next = normalizeDeviceName(name);
    if (next === undefined) {
      setName(request.deviceName);
      flow.setError(t("pages.pairing.nameEmpty"));
      return;
    }
    if (next === request.deviceName) return;
    if (!(await flow.rename(next))) setName(request.deviceName);
  };

  const note = stage === "intro" ? pairingIntroNote(opening, request, now) : undefined;
  const left = request ? Math.max(0, Math.ceil((Date.parse(request.expiresAt) - now) / 1000)) : 0;
  return (
    <div className="pair-page">
      {onExit && (
        <button type="button" className="link pair-exit" onClick={onExit}>
          {t("pages.pairing.prototypeExit")}
        </button>
      )}
      <div className="card pair-card">
        <div className="pair-brand">{t("shell.brand")}</div>
        <h2>{stage === "paired" ? t("pages.pairing.paired") : note === "revoked" ? t("pages.pairing.revoked") : t("pages.pairing.unpaired")}</h2>
        {stage === "paired" ? (
          <>
            <p className="muted">{t("pages.pairing.pairedHint", { duration: durationText(DEVICE_CREDENTIAL_TTL_MS) })}</p>
            <button type="button" className="btn primary" onClick={onPaired}>
              {t("pages.pairing.enter")}
            </button>
          </>
        ) : stage === "intro" || !request ? (
          <>
            <p className="muted">{t("pages.pairing.intro", { label: requestLabel() })}</p>
            {note && (introNote(note).alert ? <div className="error">{introNote(note).text}</div> : <p className="muted">{introNote(note).text}</p>)}
            <DeviceNameField
              label={t("pages.pairing.nameLabelIntro")}
              value={name}
              disabled={busy}
              onChange={setName}
              onFocus={() => (editing.current = true)}
              onBlur={() => (editing.current = false)}
            />
            {error && <div className="error">{error}</div>}
            <button type="button" className="btn primary" disabled={!loaded || busy} onClick={requestPairing}>
              {busy ? t("pages.pairing.requesting") : requestLabel()}
            </button>
          </>
        ) : (
          <>
            <DeviceNameField
              label={t("pages.pairing.nameLabelWaiting")}
              value={name}
              disabled={stage !== "waiting"}
              onChange={setName}
              onFocus={() => (editing.current = true)}
              onBlur={() => void rename()}
            />
            <div className="pair-codes pair-codes-big">
              <div>
                <span className="muted">{t("pages.pairing.shortCode")}</span>
                <b className="mono">{codeLabel(request.shortCode)}</b>
              </div>
              <div>
                <span className="muted">{t("pages.pairing.fingerprint")}</span>
                <b className="mono">{fingerprintLabel(request.fingerprint)}</b>
              </div>
            </div>
            <p className="muted">{t("pages.pairing.waitingHint")}</p>
            {error && <div className="error">{error}</div>}
            {stage === "claiming" ? (
              <div className="pair-wait-row">
                <span className="think-live">{t("pages.pairing.claiming")}</span>
              </div>
            ) : (
              <div className="pair-wait-row">
                <span className="think-live">{t("pages.pairing.waiting")}</span>
                <span className="muted mono">
                  {t("pages.pairing.expiresIn", { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` })}
                </span>
              </div>
            )}
            {api.simulateApproval && stage === "waiting" && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  api.simulateApproval?.();
                  void flow.poll();
                }}
              >
                {t("pages.pairing.prototypeApprove")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 配对页上的设备名输入框：说明页上发请求前改，等批准时改完（失焦、回车）那边的配对请求跟着变 */
function DeviceNameField(props: { label: string; value: string; disabled: boolean; onChange(value: string): void; onFocus(): void; onBlur(): void }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        value={props.value}
        maxLength={DEVICE_NAME_MAX_LENGTH}
        disabled={props.disabled}
        onFocus={props.onFocus}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

export function PairingApprove({ cardId, onBack }: { cardId: string; onBack(): void }) {
  const view = useCard(cardId);
  const { cardAction } = useStore();
  if (!view || view.card.type !== "pairing") return <div className="page-placeholder">{t("pages.pairing.approve.missing")}</div>;
  const p = view.card.payload as PairingPayload;
  const done = view.card.status !== "pending";
  return (
    <div className="chat-col">
      <TopBar title={t("pages.pairing.approve.title")} onBack={onBack} />
      <div className="scroll page-pad">
        <div className="card pair-card pair-approve">
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
            <dt>{t("pages.pairing.approve.expires")}</dt>
            <dd>{timeLabel(p.expiresAt)}</dd>
          </dl>
          {p.automated && <AutomatedHint reason={p.automated.reason} />}
          {done ? (
            <>
              <div className={`auth-result card-done-mark${view.card.status === "expired" ? " muted" : " ok"}`}>
                {view.card.status === "expired" ? t("pages.pairing.approve.expired") : `✓ ${outcomeLabel(view.card)}`}
              </div>
              <div className="auth-actions">
                <button type="button" className="btn ghost" onClick={onBack}>
                  {t("pages.pairing.approve.backToInbox")}
                </button>
              </div>
            </>
          ) : view.pending?.status === "sending" ? (
            <div className="auth-result muted">{t("pages.pairing.approve.sending")}</div>
          ) : (
            <>
              {view.pending?.status === "failed" && <div className="error">{t("pages.pairing.approve.failed", { error: view.pending.error })}</div>}
              <div className="hint">{t("pages.pairing.approve.warning")}</div>
              <div className="auth-actions">
                <button type="button" className="btn ghost" onClick={() => cardAction(cardId, "deny")}>
                  {t("pages.pairing.approve.deny")}
                </button>
                <button type="button" className="btn primary" onClick={() => cardAction(cardId, "approve")}>
                  {t("pages.pairing.approve.approve")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
