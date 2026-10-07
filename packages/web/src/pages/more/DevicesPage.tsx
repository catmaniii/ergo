// 设置 · 已配对设备：从外网用二狗的设备，可以随时吊销。PC 本机直接用，不需要配对。
import { useState } from "react";
import { timeLabel } from "../../model/labels.ts";
import type { PairedDevice } from "../../model/types.ts";
import { useProto } from "../../prototype/proto-store.tsx";
import { Section, Sheet } from "../../ui/common.tsx";

export function DevicesPage({ onPreviewPairing }: { onPreviewPairing(): void }) {
  const { proto, update, toast } = useProto();
  const [revoking, setRevoking] = useState<PairedDevice>();
  const active = proto.devices.filter((d) => !d.revoked);
  const revoked = proto.devices.filter((d) => d.revoked);
  return (
    <>
      <div className="card device-row device-local">
        <div>
          <b>这台电脑（本机）</b>
          <div className="muted">从本机端口进来的自动信任，不需要配对。</div>
        </div>
      </div>
      <Section title={`已配对 ${active.length}`}>
        {active.map((d) => (
          <div key={d.id} className="device-row">
            <div>
              <b>{d.name}</b>
              <div className="muted">
                配对于 {timeLabel(d.pairedAt)} · 最近使用 {timeLabel(d.lastUsedAt)} · 凭证到 {d.expiresAt}（每次使用续期）
              </div>
            </div>
            <button type="button" className="btn ghost small" onClick={() => setRevoking(d)}>
              吊销
            </button>
          </div>
        ))}
      </Section>
      {revoked.length > 0 && (
        <Section title="已吊销">
          {revoked.map((d) => (
            <div key={d.id} className="device-row device-revoked">
              <div>
                <b>{d.name}</b>
                <div className="muted">最近使用 {timeLabel(d.lastUsedAt)}</div>
              </div>
            </div>
          ))}
        </Section>
      )}
      <Section title="怎么配对新设备">
        <div className="muted">新设备打开二狗的网址，会显示设备名、6 位短码和 8 位短指纹；这边的待我处理里会出现一张配对请求卡，核对一致后批准。待批的请求 5 分钟过期。</div>
        <div className="auth-actions">
          <button type="button" className="btn ghost" onClick={onPreviewPairing}>
            预览：新设备上看到的配对等待页
          </button>
        </div>
      </Section>
      {revoking && (
        <Sheet title={`吊销「${revoking.name}」？`} onClose={() => setRevoking(undefined)} center>
          <div className="modal-body">
            <p>这台设备的凭证立刻失效，下次打开要重新配对。</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setRevoking(undefined)}>
              取消
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                update((s) => ({ ...s, devices: s.devices.map((x) => (x.id === revoking.id ? { ...x, revoked: true } : x)) }));
                toast("已吊销");
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
