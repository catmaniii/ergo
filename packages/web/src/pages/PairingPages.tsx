// 设备配对（规格第 6 节、第 21 节）：
// - 配对等待页：新设备上看到的（外网端口上还没有凭证）。设备名默认由守护进程按浏览器和系统信息生成、可以改，
//   显示短码和十六进制短指纹，每隔两秒问一次批准了没有；批准后这台设备领到凭证（HttpOnly cookie，
//   页面脚本看不到），进入二狗。待批的请求过期了可以重新申请。被吊销的设备不自动申请（开场方式见 state/pairing-gate.ts）；
// - 批准页：在已信任的设备或 PC 本机上，显示同样的设备名、短码和短指纹供核对后批准。
// 时长、位数都取共享协议包里的常量。
import { useCallback, useEffect, useRef, useState } from "react";
import { type PairingApi, PairingError } from "../app/pairing-api.ts";
import { useCard, useStore } from "../app/store.tsx";
import { outcomeLabel, type PairingPayload } from "../model/cards.ts";
import {
  DEVICE_CREDENTIAL_TTL_MS,
  DEVICE_NAME_MAX_LENGTH,
  durationText,
  normalizeDeviceName,
  PAIRING_REQUEST_TTL_MS,
  type PairingOpening,
  type PairingRequestView,
} from "../state/index.ts";
import { codeLabel, fingerprintLabel } from "../ui/cards/cards.tsx";
import { TopBar, useNow } from "../ui/common.tsx";
import { timeLabel } from "../util/time.ts";

/** 新设备多久问一次批准了没有 */
const POLL_MS = 2000;

const errorText = (err: unknown) => (err instanceof PairingError || err instanceof Error ? err.message : String(err));

/** 重新发起配对请求的按钮 */
const REAPPLY = "重新申请";

/** 没有配对请求、也不自动发起时，说明为什么 */
const IDLE_TEXT: Record<Exclude<PairingOpening, "request">, string> = {
  revoked: "此设备已被吊销",
  expired: "这台设备的凭证过期了（太久没用，或者领到之后一直没用过）",
};

export interface PairingWaitProps {
  api: PairingApi;
  /** 配对成功后进入二狗（真实的：重新加载页面，带着新凭证连上） */
  onPaired(): void;
  /** 原型预览：回到设置 */
  onExit?: () => void;
  /**
   * 怎么开场（state/pairing-gate.ts）：新设备打开时还没有配对请求就自动发起一个；被吊销、凭证过期的不自动发，
   * 等用户在这台设备上点"重新申请"
   */
  opening?: PairingOpening;
  /** 用户点了"重新申请"（真实的：擦掉浏览器里"本设备已被吊销"的记号） */
  onReapply?: () => void;
}

export function PairingWait({ api, onPaired, onExit, opening = "request", onReapply }: PairingWaitProps) {
  const [request, setRequest] = useState<PairingRequestView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  /** 没有配对请求、也不自动发起（被吊销、凭证过期）：等用户点"重新申请" */
  const [idle, setIdle] = useState(false);
  const now = useNow();
  // 输入框里正在改的名字不被轮询的结果冲掉
  const editing = useRef(false);

  const show = useCallback((r: PairingRequestView | undefined) => {
    setRequest(r);
    if (r && !editing.current) setName(r.deviceName);
  }, []);

  const create = useCallback(async (deviceName?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      show(await api.create(deviceName));
      setIdle(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, [api, show]);

  const reapply = (deviceName?: string) => {
    onReapply?.();
    void create(deviceName);
  };

  // 打开页面：已经有请求（刷新了页面）就接着等它，没有就发起一个
  useEffect(() => {
    let cancelled = false;
    api.current().then(
      (r) => {
        if (cancelled) return;
        if (r) show(r);
        else if (opening === "request") void create();
        else setIdle(true);
      },
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, create, show, opening]);

  // 等批准：每隔两秒问一次（批准了的那一次就领到凭证）
  const waiting = request?.status === "pending" || request?.status === "approved";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      api.current().then(show, () => {
        // 网断了：下一次再问
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, waiting, show]);

  const rename = async () => {
    editing.current = false;
    const next = normalizeDeviceName(name);
    if (!request || request.status !== "pending") return;
    if (next === undefined) {
      setName(request.deviceName);
      setError("设备名不能为空");
      return;
    }
    if (next === request.deviceName) return;
    try {
      setError(undefined);
      show(await api.rename(next));
    } catch (err) {
      setError(errorText(err));
      setName(request.deviceName);
    }
  };

  const left = request ? Math.max(0, Math.ceil((Date.parse(request.expiresAt) - now) / 1000)) : 0;
  const status = request?.status === "pending" && left === 0 ? "expired" : request?.status;
  return (
    <div className="pair-page">
      {onExit && (
        <button type="button" className="link pair-exit" onClick={onExit}>
          ‹ 原型：回到二狗
        </button>
      )}
      <div className="card pair-card">
        <div className="pair-brand">二狗</div>
        <h2>{status === "paired" ? "已配对" : idle && opening === "revoked" ? IDLE_TEXT.revoked : "这台设备还没配对"}</h2>
        {status === "paired" ? (
          <>
            <p className="muted">这台设备拿到了凭证（只在浏览器的 HttpOnly cookie 里，{durationText(DEVICE_CREDENTIAL_TTL_MS)}，每次使用续期）。</p>
            <button type="button" className="btn primary" onClick={onPaired}>
              进入二狗
            </button>
          </>
        ) : !request ? (
          <>
            {idle && opening !== "request" && (
              <p className="muted">
                {opening === "revoked" ? "这台设备的凭证在二狗那边被吊销了。" : `${IDLE_TEXT.expired}。`}要接着在这台设备上用二狗，重新申请配对，再在 PC
                本机或已配对的设备上批准。
              </p>
            )}
            {error ? <div className="error">{error}</div> : !idle && <p className="muted">正在发起配对请求…</p>}
            {(error || idle) && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => reapply()}>
                {REAPPLY}
              </button>
            )}
          </>
        ) : (
          <>
            <label className="field">
              <span>设备名（可以改，改完那边的配对请求跟着变）</span>
              <input
                value={name}
                maxLength={DEVICE_NAME_MAX_LENGTH}
                disabled={status !== "pending"}
                onFocus={() => (editing.current = true)}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void rename()}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </label>
            <div className="pair-codes pair-codes-big">
              <div>
                <span className="muted">短码</span>
                <b className="mono">{codeLabel(request.shortCode)}</b>
              </div>
              <div>
                <span className="muted">短指纹</span>
                <b className="mono">{fingerprintLabel(request.fingerprint)}</b>
              </div>
            </div>
            <p className="muted">在 PC 本机或已配对的设备上打开二狗，待办里会出现这台设备的配对请求。核对设备名、短码和短指纹一致后批准。</p>
            {error && <div className="error">{error}</div>}
            {status === "expired" || status === "denied" ? (
              <>
                <div className="error">{status === "denied" ? "这个配对请求被拒绝了。" : `请求已过期（${durationText(PAIRING_REQUEST_TTL_MS)}没有批准）。`}</div>
                <button type="button" className="btn primary" disabled={busy} onClick={() => reapply(normalizeDeviceName(name))}>
                  {REAPPLY}
                </button>
              </>
            ) : status === "approved" ? (
              <div className="pair-wait-row">
                <span className="think-live">已批准，正在领取凭证…</span>
              </div>
            ) : (
              <div className="pair-wait-row">
                <span className="think-live">等待批准…</span>
                <span className="muted mono">
                  {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} 后过期
                </span>
              </div>
            )}
            {api.simulateApproval && status === "pending" && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  api.simulateApproval?.();
                  void api.current().then(show);
                }}
              >
                原型：模拟"已批准"
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function PairingApprove({ cardId, onBack }: { cardId: string; onBack(): void }) {
  const view = useCard(cardId);
  const { cardAction } = useStore();
  if (!view || view.card.type !== "pairing") return <div className="page-placeholder">没有这个配对请求</div>;
  const p = view.card.payload as PairingPayload;
  const done = view.card.status !== "pending";
  return (
    <div className="chat-col">
      <TopBar title="批准新设备" onBack={onBack} />
      <div className="scroll page-pad">
        <div className="card pair-card pair-approve">
          <div className="muted">新设备上显示的应该和这里一模一样：</div>
          <dl className="kv kv-big">
            <dt>设备名</dt>
            <dd>
              <b>{p.deviceName}</b>
            </dd>
            <dt>短码</dt>
            <dd>
              <b className="mono">{codeLabel(p.shortCode)}</b>
            </dd>
            <dt>短指纹</dt>
            <dd>
              <b className="mono">{fingerprintLabel(p.fingerprint)}</b>
            </dd>
            <dt>来源</dt>
            <dd>{p.from}</dd>
            <dt>过期</dt>
            <dd>{timeLabel(p.expiresAt)}</dd>
          </dl>
          {done ? (
            <>
              <div className={`auth-result card-done-mark${view.card.status === "expired" ? " muted" : " ok"}`}>
                {view.card.status === "expired" ? "已过期：请在新设备上重新请求" : `✓ ${outcomeLabel(view.card)}`}
              </div>
              <div className="auth-actions">
                <button type="button" className="btn ghost" onClick={onBack}>
                  回到待办
                </button>
              </div>
            </>
          ) : view.pending?.status === "sending" ? (
            <div className="auth-result muted">处理中…</div>
          ) : (
            <>
              {view.pending?.status === "failed" && <div className="error">没处理成：{view.pending.error}</div>}
              <div className="hint">对不上就拒绝：可能有人冒充你的设备。批准后对方拿到一个可以随时吊销的长期凭证。</div>
              <div className="auth-actions">
                <button type="button" className="btn ghost" onClick={() => cardAction(cardId, "deny")}>
                  拒绝
                </button>
                <button type="button" className="btn primary" onClick={() => cardAction(cardId, "approve")}>
                  一致，批准
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
