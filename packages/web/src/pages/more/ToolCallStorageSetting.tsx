// 设置里的"工具调用的完整内容"（65 号票）：守护进程另存的每次调用的完整参数和返回占了多大、保留多久、总量上限，
// 照现在的规则马上清会清掉多少；"现在就清理"点了先确认，确认后按现在的规则马上清一次，清完重新取一遍。
// 每次打开设置现取（守护进程每天自己清一次，数字会变）。说法在状态层（state/tool-call-storage.ts）。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type ToolCallStorageView, toolCallCleanupText, toolCallStorageText } from "../../state/index.ts";
import { Sheet } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

export function ToolCallStorageSetting() {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<ToolCallStorageView>();
  /** 没取到的原因 */
  const [failed, setFailed] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    http.toolCallStorage().then(
      (v) => {
        if (!live) return;
        setView(v);
        setFailed(undefined);
      },
      (err: unknown) => {
        if (live) setFailed(`没取到：${err instanceof Error ? err.message : String(err)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [http]);

  const text = view && toolCallStorageText(view);
  const clean = () => {
    setBusy(true);
    http
      .cleanupToolCalls()
      .then(
        (result) => {
          setConfirming(false);
          toast(toolCallCleanupText(result));
        },
        (err: unknown) => toast(`没清成：${err instanceof Error ? err.message : String(err)}`),
      )
      // 清完（或者没清成）重新取一遍
      .then(() => http.toolCallStorage())
      .then(setView, () => {})
      .finally(() => setBusy(false));
  };

  return (
    <div className="tool-call-storage">
      <div className="menu-text">
        工具调用的完整内容
        <small>{text?.usage ?? failed ?? "正在算…"}</small>
        {text && <small>{text.rule}</small>}
      </div>
      <div className="tool-call-storage-row">
        <span className="muted">{text?.due ?? ""}</span>
        <button type="button" className="btn ghost small" disabled={busy || !text?.canClean} onClick={() => setConfirming(true)}>
          现在就清理
        </button>
      </div>
      {confirming && text?.confirm && (
        <Sheet title="现在就清理？" onClose={() => !busy && setConfirming(false)} center>
          <div className="modal-body">
            <p>{text.confirm}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={clean}>
              {busy ? "清理中…" : "确认清理"}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
