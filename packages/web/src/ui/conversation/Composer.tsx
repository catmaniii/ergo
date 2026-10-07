/**
 * 会话的输入框。秘书的输入框多一个附件菜单（图片、文件；"作为材料投喂"归 21 号票，这一版不出现）：
 * 选了文件就开始上传（分片续传，断网恢复后接着传），每个附件显示进度；都传完了才能发送，
 * 发出去的消息里是入库后的图片 part 和文件 part（引用入库版本的哈希）。
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import type { UploadProgress } from "../../app/uploader.ts";
import { attachmentPartFrom, type MessagePart, type UploadedMedia } from "../../state/index.ts";
import { sizeLabel } from "./parts.tsx";

export type ComposerMode = "secretary" | "maintainer";

interface Attachment {
  key: string;
  file: File;
  progress: UploadProgress;
  media?: UploadedMedia;
  controller: AbortController;
}

let localSeq = 0;

export function Composer({ mode, onSend }: { mode: ComposerMode; onSend(parts: MessagePart[]): void }) {
  const { http } = useStore();
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  // 离开页面（组件卸下）时，还在传的停掉
  const live = useRef<Attachment[]>([]);
  useEffect(() => {
    live.current = attachments;
  });
  useEffect(() => () => live.current.forEach((a) => a.controller.abort()), []);

  const update = (key: string, f: (a: Attachment) => Attachment) => setAttachments((xs) => xs.map((a) => (a.key === key ? f(a) : a)));

  const startUpload = (file: File) => {
    const key = `att-${++localSeq}`;
    const controller = new AbortController();
    setAttachments((xs) => [...xs, { key, file, controller, progress: { state: "uploading", sent: 0, total: file.size } }]);
    http
      .upload(file, { signal: controller.signal, onProgress: (progress) => update(key, (a) => ({ ...a, progress })) })
      .then((media) => update(key, (a) => ({ ...a, media, progress: { state: "done", sent: file.size, total: file.size } })))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        update(key, (a) => ({ ...a, progress: { state: "failed", sent: 0, total: file.size, error: err instanceof Error ? err.message : String(err) } }));
      });
  };

  const remove = (a: Attachment) => {
    a.controller.abort();
    setAttachments((xs) => xs.filter((x) => x.key !== a.key));
  };

  const retry = (a: Attachment) => {
    remove(a);
    startUpload(a.file);
  };

  const pick = (opts: { image?: boolean }) => {
    setMenu(false);
    const input = fileInput.current;
    if (!input) return;
    input.accept = opts.image ? "image/*" : "";
    input.click();
  };

  const uploading = attachments.some((a) => !a.media);
  const send = () => {
    if (uploading) return;
    const parts: MessagePart[] = attachments.map((a) => attachmentPartFrom(a.media!));
    if (text.trim()) parts.push({ type: "text", text: text.trim() });
    if (!parts.length) return;
    onSend(parts);
    setText("");
    setAttachments([]);
  };

  return (
    <div className="composer-wrap">
      {attachments.length > 0 && (
        <div className="attach-list">
          {attachments.map((a) => (
            <AttachmentChip key={a.key} attachment={a} onRemove={() => remove(a)} onRetry={() => retry(a)} />
          ))}
        </div>
      )}
      <div className="composer">
        {mode === "secretary" && (
          <div className="attach-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" className="icon-btn attach-btn" aria-label="附件" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              ＋
            </button>
            {menu && (
              <div className="attach-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => pick({ image: true })}>
                  🖼 图片
                </button>
                <button type="button" role="menuitem" onClick={() => pick({})}>
                  📄 文件
                </button>
              </div>
            )}
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            for (const file of Array.from(e.currentTarget.files ?? [])) startUpload(file);
            e.currentTarget.value = "";
          }}
        />
        <textarea
          value={text}
          rows={1}
          placeholder={mode === "secretary" ? "和秘书说…" : "直接给维护者下指令…"}
          title={mode === "maintainer" ? "维护者在干活时，你的话作为插话，在它下一步之前插入" : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
          }}
        />
        <button type="button" className="btn primary" disabled={uploading || (!text.trim() && !attachments.length)} onClick={send} title={uploading ? "附件还在上传，传完才能发送" : undefined}>
          {uploading ? "上传中" : "发送"}
        </button>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<UploadProgress["state"], string> = {
  uploading: "上传中",
  waiting: "等待网络，恢复后接着传",
  verifying: "校验中",
  done: "已传好",
  failed: "上传失败",
};

/** 输入框上方的一个附件：名字、大小、进度条；失败时可以重试 */
function AttachmentChip({ attachment: a, onRemove, onRetry }: { attachment: Attachment; onRemove(): void; onRetry(): void }) {
  const { state, sent, total, error } = a.progress;
  const percent = total > 0 ? Math.floor((sent / total) * 100) : 100;
  return (
    <span className={`attach attach-${state}`} title={error ?? STATE_LABEL[state]}>
      <span className="attach-name">{a.file.name}</span>
      <span className="muted attach-status">
        {state === "done" ? sizeLabel(total) : state === "uploading" ? `${percent}%` : STATE_LABEL[state]}
      </span>
      {state === "failed" && (
        <button type="button" className="link attach-retry" onClick={onRetry}>
          重试
        </button>
      )}
      <button type="button" className="attach-x" aria-label={`移除 ${a.file.name}`} onClick={onRemove}>
        ×
      </button>
      {state !== "done" && state !== "failed" && (
        <span className="attach-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${a.file.name} 上传进度`}>
          <i style={{ width: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}
