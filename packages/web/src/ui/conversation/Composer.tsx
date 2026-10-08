/**
 * 会话的输入框。聊天里"引用"的卡片显示成输入框上方的引用条（可去掉），发送时作为卡片引用带上（21 号票）。
 * 秘书的输入框多一个附件菜单（图片、文件、作为材料投喂）：
 * 选了文件就开始上传（分片续传，断网恢复后接着传），每个附件显示进度；都传完了才能发送，
 * 发出去的消息里是入库后的图片 part 和文件 part（引用入库版本的哈希）。
 * "作为材料投喂"（21 号票）选的附件带 asMaterial 标记，这条消息记成"用户主动投喂的材料"。
 * 输入栏右侧的按钮在"文字 / 语音"之间切换（31 号票，照微信；左边的加号不变）：语音模式下整个输入框变成"按住 说话"
 * （VoiceInput.tsx），录音在本地，抬手后整段经分片续传上传，传完发一条带语音 part 的消息（连同引用的卡片）。
 * 语音模式下加号照常可用：选的附件传完就作为单独一条消息发出去，不用切回文字。选的模式记在这个浏览器里。
 * 附件和语音走同一套上传（startUpload）和同一种进度条（UploadChip）。
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import type { UploadProgress } from "../../app/uploader.ts";
import { attachmentPartFrom, type MessagePart, selectCard, type UploadedMedia, voiceDurationLabel } from "../../state/index.ts";
import { sizeLabel } from "./parts.tsx";
import { type RecordedVoice, VoiceInput } from "./VoiceInput.tsx";

export type ComposerMode = "secretary" | "maintainer";

/**
 * 上传的是什么：附件（经"作为材料投喂"选的带 asMaterial；语音模式下选的 alone：传好就单独发出去），
 * 或者一段录好的语音（传好就发出去）
 */
type UploadWhat = { kind: "attachment"; asMaterial: boolean; alone: boolean } | { kind: "voice"; voice: RecordedVoice };

/** 输入框上方正在上传（或传好了等着发）的一个文件 */
interface Upload {
  key: string;
  file: File;
  what: UploadWhat;
  progress: UploadProgress;
  media?: UploadedMedia;
  controller: AbortController;
}

let localSeq = 0;

/** 附件在消息里的样子 */
function attachmentPart(media: UploadedMedia, what: Extract<UploadWhat, { kind: "attachment" }>): MessagePart {
  return { ...attachmentPartFrom(media), ...(what.asMaterial ? { asMaterial: true } : {}) };
}

/** 文字还是语音：记在这个浏览器里（取不到就是文字） */
const INPUT_MODE_KEY = "ergou.input_mode";
function savedVoiceMode(): boolean {
  try {
    return localStorage.getItem(INPUT_MODE_KEY) === "voice";
  } catch {
    return false;
  }
}
function saveVoiceMode(voice: boolean): void {
  try {
    localStorage.setItem(INPUT_MODE_KEY, voice ? "voice" : "text");
  } catch {
    // 存不了就算了：下次打开回到文字
  }
}

/** 录音文件的名字（服务端按内容认格式，名字只是给人看的） */
function voiceFileName(mime: string): string {
  return `语音.${mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm"}`;
}

export function Composer({
  mode,
  quoted = [],
  onUnquote,
  onSend,
}: {
  mode: ComposerMode;
  /** 引用到输入框的卡片（卡片 id） */
  quoted?: readonly string[];
  onUnquote?(cardId: string): void;
  onSend(parts: MessagePart[]): void;
}) {
  const { http, ui } = useStore();
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [voiceMode, setVoiceMode] = useState(savedVoiceMode);
  const fileInput = useRef<HTMLInputElement>(null);
  /** 这次选文件是不是"作为材料投喂" */
  const feeding = useRef(false);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  // 离开页面（组件卸下）时，还在传的停掉
  const live = useRef<Upload[]>([]);
  useEffect(() => {
    live.current = uploads;
  });
  useEffect(() => () => live.current.forEach((u) => u.controller.abort()), []);

  // 引用的卡片：发出去的时候取最新的（语音、附件是传完才发的）
  const quotedRef = useRef(quoted);
  useEffect(() => {
    quotedRef.current = quoted;
  });
  const cardRefs = (): MessagePart[] => quotedRef.current.map((cardId): MessagePart => ({ type: "card_ref", cardId }));

  const update = (key: string, f: (u: Upload) => Upload) => setUploads((xs) => xs.map((u) => (u.key === key ? f(u) : u)));

  /** 开始上传（重试时沿用原来的位置和 key）；语音、语音模式下选的附件传好就连同引用的卡片单独发出去 */
  const startUpload = (file: File, what: UploadWhat, key = `up-${++localSeq}`) => {
    const controller = new AbortController();
    const fresh: Upload = { key, file, what, controller, progress: { state: "uploading", sent: 0, total: file.size } };
    setUploads((xs) => (xs.some((u) => u.key === key) ? xs.map((u) => (u.key === key ? fresh : u)) : [...xs, fresh]));
    http
      .upload(file, { signal: controller.signal, onProgress: (progress) => update(key, (u) => ({ ...u, progress })) })
      .then((media) => {
        if (what.kind === "attachment" && !what.alone) return update(key, (u) => ({ ...u, media, progress: { state: "done", sent: file.size, total: file.size } }));
        setUploads((xs) => xs.filter((u) => u.key !== key));
        if (what.kind === "attachment") return onSend([...cardRefs(), attachmentPart(media, what)]);
        const { voice } = what;
        // capture：按下 → 开录的毫秒数、是不是预热命中（37 号票的诊断，守护进程存进语音对象）
        onSend([...cardRefs(), { type: "voice", mediaId: media.mediaId, mime: voice.mime, durationMs: Math.round(voice.durationMs), waveform: voice.waveform, capture: voice.capture }]);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        update(key, (u) => ({ ...u, progress: { state: "failed", sent: 0, total: file.size, error: err instanceof Error ? err.message : String(err) } }));
      });
  };

  const recorded = (voice: RecordedVoice) => startUpload(new File([voice.blob], voiceFileName(voice.mime), { type: voice.mime }), { kind: "voice", voice });

  const remove = (u: Upload) => {
    u.controller.abort();
    setUploads((xs) => xs.filter((x) => x.key !== u.key));
  };

  /** 等着和文字一起发的附件（语音模式下选的不算：它们传好就单独发了） */
  const attachments = uploads.flatMap((u) => (u.what.kind === "attachment" && !u.what.alone ? [{ ...u, what: u.what }] : []));

  const pick = (opts: { image?: boolean; material?: boolean }) => {
    setMenu(false);
    const input = fileInput.current;
    if (!input) return;
    feeding.current = opts.material === true;
    input.accept = opts.image ? "image/*" : "";
    input.click();
  };

  const uploading = attachments.some((a) => !a.media);
  /** 发出去：引用的卡片、传好的附件和打的字 */
  const send = () => {
    if (uploading) return;
    const parts: MessagePart[] = [...cardRefs(), ...attachments.map((a) => attachmentPart(a.media!, a.what))];
    if (text.trim()) parts.push({ type: "text", text: text.trim() });
    if (!parts.some((p) => p.type !== "card_ref")) return;
    onSend(parts);
    setText("");
    const sent = new Set(attachments.map((a) => a.key));
    setUploads((xs) => xs.filter((u) => !sent.has(u.key)));
  };

  return (
    <div className="composer-wrap">
      {quoted.length > 0 && (
        <div className="quote-list">
          {quoted.map((cardId) => (
            <div key={cardId} className="quote-bar">
              <span className="quote-text">引用：{selectCard(ui, cardId)?.card.text ?? "卡片"}</span>
              {onUnquote && (
                <button type="button" className="icon-btn" aria-label="去掉这条引用" onClick={() => onUnquote(cardId)}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {uploads.length > 0 && (
        <div className="attach-list">
          {uploads.map((u) => (
            <UploadChip key={u.key} upload={u} onRemove={() => remove(u)} onRetry={() => startUpload(u.file, u.what, u.key)} />
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
                <button type="button" role="menuitem" title="作为你主动提供的材料存进素材库" onClick={() => pick({ material: true })}>
                  📥 作为材料投喂
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
            // 语音模式下选的附件（照微信）：传好就单独发出去，不用切回文字
            for (const file of Array.from(e.currentTarget.files ?? [])) startUpload(file, { kind: "attachment", asMaterial: feeding.current, alone: voiceMode });
            e.currentTarget.value = "";
          }}
        />
        {voiceMode ? (
          <VoiceInput onRecorded={recorded} />
        ) : (
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
        )}
        <button
          type="button"
          className="icon-btn voice-toggle"
          aria-label={voiceMode ? "切换到文字输入" : "切换到语音输入"}
          title={voiceMode ? "切换到文字输入" : "切换到语音输入（按住说话）"}
          onClick={() => {
            saveVoiceMode(!voiceMode);
            setVoiceMode(!voiceMode);
          }}
        >
          {voiceMode ? "⌨" : "🎤"}
        </button>
        {!voiceMode && (
          <button type="button" className="btn primary" disabled={uploading || (!text.trim() && !attachments.length)} onClick={send} title={uploading ? "附件还在上传，传完才能发送" : undefined}>
            {uploading ? "上传中" : "发送"}
          </button>
        )}
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

/** 输入框上方一个正在上传的文件（附件或语音）：名字、进度条；附件传好了显示大小，语音传好就发出去；失败时可以重试 */
function UploadChip({ upload: u, onRemove, onRetry }: { upload: Upload; onRemove(): void; onRetry(): void }) {
  const { state, sent, total, error } = u.progress;
  const percent = total > 0 ? Math.floor((sent / total) * 100) : 100;
  const name = u.what.kind === "voice" ? `🎤 语音 ${voiceDurationLabel(u.what.voice.durationMs)}` : u.file.name;
  const status = state === "done" ? sizeLabel(total) : state === "uploading" ? `${percent}%` : state === "failed" && u.what.kind === "voice" ? "没发出去" : STATE_LABEL[state];
  return (
    <span className={`attach attach-${state}`} title={error ?? STATE_LABEL[state]}>
      <span className="attach-name">{name}</span>
      {u.what.kind === "attachment" && u.what.asMaterial && <span className="chip chip-data">作为材料</span>}
      <span className="muted attach-status">{status}</span>
      {state === "failed" && (
        <button type="button" className="link attach-retry" onClick={onRetry}>
          重试
        </button>
      )}
      <button type="button" className="attach-x" aria-label={u.what.kind === "voice" ? "放弃这段语音" : `移除 ${u.file.name}`} onClick={onRemove}>
        ×
      </button>
      {state !== "done" && state !== "failed" && (
        <span className="attach-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${u.what.kind === "voice" ? "语音" : u.file.name} 上传进度`}>
          <i style={{ width: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}
