// 设备配对（规格第 6 节、第 21 节）：
// - 配对等待页：新设备上看到的。设备名默认取浏览器和系统信息、可以改，显示 6 位短码和 8 位十六进制短指纹；
// - 批准页：在已信任的设备或 PC 本机上，显示同样的设备名、短码和短指纹供核对后批准。
import { useEffect, useState } from "react";
import { useCard, useStore } from "../app/store.tsx";
import { outcomeLabel, type PairingPayload } from "../model/cards.ts";
import { timeLabel } from "../util/time.ts";
import { codeLabel, fingerprintLabel } from "../ui/cards/cards.tsx";
import { TopBar } from "../ui/common.tsx";

/** 设备名默认值：浏览器 · 系统 */
export function defaultDeviceName(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /HarmonyOS|ArkWeb/.test(ua)
      ? "鸿蒙浏览器"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "浏览器";
  const os = /HarmonyOS|OpenHarmony/.test(ua)
    ? "HarmonyOS"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua)
        ? "iPad"
        : /Android/.test(ua)
          ? "Android"
          : /Windows/.test(ua)
            ? "Windows"
            : /Mac OS X/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "未知系统";
  return `${browser} · ${os}`;
}

function randomDigits(n: number): string {
  const a = new Uint32Array(n);
  globalThis.crypto?.getRandomValues?.(a);
  return Array.from(a, (x, i) => String((x || Math.floor(Math.random() * 1e9) + i) % 10)).join("");
}

function randomHex(n: number): string {
  const a = new Uint8Array(Math.ceil(n / 2));
  globalThis.crypto?.getRandomValues?.(a);
  return Array.from(a, (x) => (x || Math.floor(Math.random() * 256)).toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
}

const TTL = 5 * 60;

export function PairingWait({ onExit }: { onExit(): void }) {
  const [name, setName] = useState(() => defaultDeviceName(navigator.userAgent));
  const [code, setCode] = useState(() => randomDigits(6));
  const [fp, setFp] = useState(() => randomHex(8));
  const [left, setLeft] = useState(TTL);
  const [approved, setApproved] = useState(false);
  useEffect(() => {
    if (approved) return;
    const t = setInterval(() => setLeft((x) => Math.max(0, x - 1)), 1000);
    return () => clearInterval(t);
  }, [approved]);
  const expired = left === 0;
  return (
    <div className="pair-page">
      <button type="button" className="link pair-exit" onClick={onExit}>
        ‹ 原型：回到二狗
      </button>
      <div className="card pair-card">
        <div className="pair-brand">二狗</div>
        <h2>{approved ? "已配对" : "这台设备还没配对"}</h2>
        {approved ? (
          <>
            <p className="muted">设备拿到了凭证（HttpOnly cookie，365 天，每次使用续期）。</p>
            <button type="button" className="btn primary" onClick={onExit}>
              进入二狗
            </button>
          </>
        ) : (
          <>
            <label className="field">
              <span>设备名（可以改）</span>
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={expired} />
            </label>
            <div className="pair-codes pair-codes-big">
              <div>
                <span className="muted">短码</span>
                <b className="mono">{codeLabel(code)}</b>
              </div>
              <div>
                <span className="muted">短指纹</span>
                <b className="mono">{fingerprintLabel(fp)}</b>
              </div>
            </div>
            <p className="muted">
              在 PC 本机或已配对的设备上打开二狗，待我处理里会出现这台设备的配对请求。核对设备名、短码和短指纹一致后批准。
            </p>
            {expired ? (
              <>
                <div className="error">请求已过期（5 分钟）。</div>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setCode(randomDigits(6));
                    setFp(randomHex(8));
                    setLeft(TTL);
                  }}
                >
                  重新请求
                </button>
              </>
            ) : (
              <div className="pair-wait-row">
                <span className="think-live">等待批准…</span>
                <span className="muted mono">
                  {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} 后过期
                </span>
              </div>
            )}
            <button type="button" className="link" onClick={() => setApproved(true)} disabled={expired}>
              原型：模拟"已批准"
            </button>
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
              <div className="auth-result ok card-done-mark">✓ {outcomeLabel(view.card)}</div>
              <div className="auth-actions">
                <button type="button" className="btn ghost" onClick={onBack}>
                  回到待我处理
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
