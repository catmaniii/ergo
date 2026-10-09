// 设置 · 已配对设备：从外网用二狗的设备，可以随时吊销（吊销后它开着的页面立刻被断开，回到配对页）。
// PC 本机直接用，不需要配对。列表来自前端状态层（已配对设备频道上的 device 事件）。
// 领到凭证、还没带着它来过的设备标"等待首次使用"（领取的响应可能丢了），到期还没用过就自动作废。
// 时长、位数都取共享协议包里的常量。
import { useState } from "react";
import { useAccess } from "../../app/access.tsx";
import { useStore } from "../../app/store.tsx";
import {
  DEVICE_CREDENTIAL_TTL_MS,
  DEVICE_FIRST_USE_WINDOW_MS,
  durationText,
  type InactiveReason,
  PAIRING_FINGERPRINT_HEX_DIGITS,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_SHORT_CODE_DIGITS,
  type PairedDevice,
  pairedDevices,
} from "../../state/index.ts";
import { Section, Sheet, useNow } from "../../ui/common.tsx";
import { timeLabel } from "../../util/time.ts";

const dateLabel = (iso: string) => iso.slice(0, 10);

/** 有效的设备那一行的说明：等待首次使用的，和用过的 */
function activeNote(d: PairedDevice): string {
  if (!d.activated) return `等待首次使用（领到凭证后 ${durationText(DEVICE_FIRST_USE_WINDOW_MS)}内没用过就作废）`;
  return `最近使用 ${timeLabel(d.lastUsedAt)} · 凭证到 ${dateLabel(d.expiresAt)}（每次使用续期）`;
}

/** 失效的设备那一行的说明 */
function inactiveNote(d: PairedDevice, reason: InactiveReason): string {
  switch (reason) {
    case "revoked":
      return `吊销于 ${timeLabel(d.revokedAt ?? d.lastUsedAt)}`;
    case "expired":
      return `连续 ${durationText(DEVICE_CREDENTIAL_TTL_MS)}没用，凭证已过期 · 最近使用 ${timeLabel(d.lastUsedAt)}`;
    case "never_used":
      return `领到凭证后 ${durationText(DEVICE_FIRST_USE_WINDOW_MS)}内一次也没用过，已作废`;
  }
}

export function DevicesPage({ onPreviewPairing }: { onPreviewPairing(): void }) {
  const { ui, revokeDevice } = useStore();
  const access = useAccess();
  const [revoking, setRevoking] = useState<PairedDevice>();
  const now = useNow(60_000);
  const { active, inactive } = pairedDevices(ui, now);
  const self = access?.access === "device" ? access.device.id : undefined;
  return (
    <>
      <div className="card device-row device-local">
        <div>
          <b>
            这台电脑（本机）{access?.access === "local" && <span className="muted">（就是这台）</span>}
          </b>
          <div className="muted">从本机端口进来的自动信任，不需要配对。</div>
        </div>
      </div>
      <Section title={`已配对 ${active.length}`}>
        {active.length === 0 && <div className="muted">还没有配对过的设备。</div>}
        {active.map((d) => (
          <div key={d.id} className="device-row">
            <div>
              <b>
                {d.name}
                {d.id === self && <span className="muted">（就是这台）</span>}
              </b>
              <div className="muted">
                {d.from} · 配对于 {timeLabel(d.pairedAt)} · {activeNote(d)}
              </div>
            </div>
            <button type="button" className="btn ghost small" onClick={() => setRevoking(d)}>
              吊销
            </button>
          </div>
        ))}
      </Section>
      {inactive.length > 0 && (
        <Section title="已失效">
          {inactive.map(({ device: d, reason }) => (
            <div key={d.id} className="device-row device-revoked">
              <div>
                <b>{d.name}</b>
                <div className="muted">{inactiveNote(d, reason)}</div>
              </div>
            </div>
          ))}
        </Section>
      )}
      <Section title="怎么配对新设备">
        <div className="muted">
          新设备打开二狗的公网地址，会显示设备名、{PAIRING_SHORT_CODE_DIGITS} 位短码和 {PAIRING_FINGERPRINT_HEX_DIGITS} 位短指纹；这边的待办里会出现一张配对请求卡，核对一致后批准。待批的请求{" "}
          {durationText(PAIRING_REQUEST_TTL_MS)}过期。
        </div>
        <div className="auth-actions">
          <button type="button" className="btn ghost" onClick={onPreviewPairing}>
            预览：新设备上看到的配对等待页
          </button>
        </div>
      </Section>
      {revoking && (
        <Sheet title={`吊销「${revoking.name}」？`} onClose={() => setRevoking(undefined)} center>
          <div className="modal-body">
            <p>这台设备的凭证立刻失效，它开着的页面马上断开，下次打开要重新配对。{revoking.id === self && "（就是你正在用的这台）"}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setRevoking(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                revokeDevice(revoking.id);
                setRevoking(undefined);
              }}
            >
              吊销
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
