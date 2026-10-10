/**
 * 会话的输入框。聊天里"引用"的卡片显示成输入框上方的引用条（可去掉），发送时作为卡片引用带上（21 号票）。
 * 秘书的输入框多一个附件菜单（图片、文件、作为材料投喂）：
 * 选了文件就开始上传（分片续传，断网恢复后接着传），每个附件在输入框上方显示进度（图片带缩略图），可以删掉；
 * 发出去的消息里是入库后的图片 part 和文件 part（引用入库版本的哈希）。
 * "作为材料投喂"（21 号票）选的附件带 asMaterial 标记，这条消息记成"用户主动投喂的材料"。
 * 输入栏右侧的按钮在"文字 / 语音"之间切换（31 号票，照微信；左边的加号不变）：语音模式下整个输入框变成"按住 说话"
 * （VoiceInput.tsx），录音在本地，抬手后整段经分片续传上传。选的模式记在这个浏览器里。
 * 附件一律不自动发（用户 2026-10-10 改；之前语音模式下选的附件传好就单独发出去）：两种模式下选的附件都先等在输入框上方，
 * 下一条消息把它们一起带走（谁带走谁、什么时候能发在状态层的 state/composer-outbox.ts）：
 * - 文字模式：打字后点发送，引用的卡片、等着的附件和打的字是一条消息；附件没传完不能点；
 * - 语音模式：说完的那段语音连同引用的卡片、等着的附件是一条消息。说完时语音或附件还没传好，就排着、都传好了再发；
 *   附件传失败的等重试或删掉，语音一直留在输入框上方（显示在等什么），不会丢；
 * - 只发附件、不说话：语音模式下附件下面有"直接发送"；文字模式下不打字直接点发送。
 * 附件和语音走同一套上传（startUpload）和同一种进度条（UploadChip）。
 * 秘书的输入框占位是"和<名字>说…"（43 号票），名字带底色：原生的 placeholder 不能部分上色，所以叠一层假占位
 * （输入框空着时显示，不挡点击，读屏用 aria-label）。
 * 斜杠命令（82 号票，三处会话都有）：在输入框开头打 / 弹出候选（SlashMenu.tsx：二狗自己的命令和这个会话能用的 skill，
 * 每次弹出时向守护进程现取），边打边过滤；方向键挪、Enter 或 Tab 选中（输入法正在组字时不算），点按也行，选中插入"写法 + 空格"
 * 接着打正文；Esc、点别处关掉（再打字又弹）。命令名里没有空白，打了空白就不弹了。语音模式下不弹（语音里说名字照旧算点名）。
 */
import { useEffect, useRef, useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { unlockVoicePlayback } from "../../app/page-voice.ts";
import { useStore } from "../../app/store.tsx";
import type { UploadProgress } from "../../app/uploader.ts";
import {
  attachmentPartFrom,
  type ConversationId,
  filterSlashCommands,
  type MessagePart,
  nextSlashIndex,
  type QueuedVoice,
  queuedVoiceWait,
  queueVoice,
  selectCard,
  sizeLabel,
  type SlashCommandEntry,
  slashInsertText,
  slashQuery,
  takeReadyVoices,
  type UploadedMedia,
  voiceDurationLabel,
  waitingAttachments,
  waitingState,
} from "../../state/index.ts";
import { AssistantName, NamedText, useAssistantName } from "../assistant-name.tsx";
import { SlashMenu, slashItemId } from "./SlashMenu.tsx";
import { type RecordedVoice, VoiceInput } from "./VoiceInput.tsx";

export type ComposerMode = "secretary" | "maintainer";

/** 上传的是什么：附件（经"作为材料投喂"选的带 asMaterial），或者一段录好的语音 */
type UploadWhat = { kind: "attachment"; asMaterial: boolean } | { kind: "voice"; voice: RecordedVoice };

/** 输入框上方正在上传（或传好了等着发）的一个文件 */
interface Upload {
  key: string;
  file: File;
  what: UploadWhat;
  progress: UploadProgress;
  /** 传好了：它在消息里的 part */
  part: MessagePart | undefined;
  controller: AbortController;
  /** 图片的本地缩略图（object URL，从输入框上方拿掉时收回） */
  preview: string | undefined;
}

/** 输入框上方的东西：上传（按选、说的先后），和说完了排着等发的语音 */
interface Draft {
  uploads: Upload[];
  queue: QueuedVoice[];
}

let localSeq = 0;

/** 附件在消息里的样子 */
function attachmentPart(media: UploadedMedia, what: Extract<UploadWhat, { kind: "attachment" }>): MessagePart {
  return { ...attachmentPartFrom(media), ...(what.asMaterial ? { asMaterial: true } : {}) };
}

/** 语音在消息里的样子 */
function voicePart(media: UploadedMedia, voice: RecordedVoice): MessagePart {
  // capture：按下 → 开录的毫秒数、是不是预热命中（37 号票）、开麦原因、冷启动耗时、麦克风诊断记录、UA（61 号票）；守护进程存进语音对象
  return { type: "voice", mediaId: media.mediaId, mime: voice.mime, durationMs: Math.round(voice.durationMs), waveform: voice.waveform, capture: voice.capture };
}

/** 从输入框上方拿掉这些上传：缩略图收回（还在传的由调用方先停掉） */
function dropUploads(uploads: readonly Upload[], keys: ReadonlySet<string>): Upload[] {
  for (const u of uploads) if (keys.has(u.key) && u.preview) URL.revokeObjectURL(u.preview);
  return uploads.filter((u) => !keys.has(u.key));
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
  return `语音.${mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm"}`;
}

export function Composer({
  conversation,
  mode,
  quoted = [],
  onUnquote,
  onSend,
  placeholder = "直接给维护者下指令…",
}: {
  /** 哪个会话的输入框（打 / 时按它取能用的斜杠命令） */
  conversation: ConversationId;
  mode: ComposerMode;
  /** 不是秘书的会话时输入框的占位（默认"直接给维护者下指令…"；普通任务的 agent 不叫维护者，75 号票） */
  placeholder?: string;
  /** 引用到输入框的卡片（卡片 id） */
  quoted?: readonly string[];
  onUnquote?(cardId: string): void;
  onSend(parts: MessagePart[]): void;
}) {
  const { http, ui } = useStore();
  const assistantName = useAssistantName();
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  useBackLayer("overlay", menu, () => setMenu(false));
  const [voiceMode, setVoiceMode] = useState(savedVoiceMode);
  const fileInput = useRef<HTMLInputElement>(null);
  /** 这次选文件是不是"作为材料投喂" */
  const feeding = useRef(false);

  // 斜杠命令的候选（82 号票）：文字以 / 开头、还没打空白时弹；候选每次弹出时现取（工具包随时会变），取到之前先用上一次的
  const fieldRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashList, setSlashList] = useState<readonly SlashCommandEntry[] | undefined>(undefined);
  /** 选中的是第几行，连同当时打的那段：打的字变了就回到第一行 */
  const [slashPick, setSlashPick] = useState<{ query: string | undefined; index: number }>({ query: undefined, index: 0 });
  /** 用户按 Esc、点别处关掉时的文字：文字没变就不再弹 */
  const [slashDismissed, setSlashDismissed] = useState<string | undefined>(undefined);
  const query = voiceMode ? undefined : slashQuery(text);
  const typingSlash = query !== undefined;
  const candidates = query !== undefined && slashList ? filterSlashCommands(slashList, query) : [];
  const slashOpen = candidates.length > 0 && slashDismissed !== text;
  const slashActive = slashPick.query === query ? Math.min(slashPick.index, Math.max(0, candidates.length - 1)) : 0;
  const setSlashActive = (index: number) => setSlashPick({ query, index });
  useEffect(() => {
    if (!typingSlash) return;
    let live = true;
    http.slashCommands(conversation).then(
      (list) => {
        if (live) setSlashList(list.commands);
      },
      () => {
        // 取不到就不弹（守护进程还没这个接口、会话没了）
      },
    );
    return () => {
      live = false;
    };
  }, [typingSlash, conversation, http]);

  /** 选中一个候选：输入框里换成"写法 + 空格"，光标放到最后，接着打正文 */
  const pickSlash = (entry: SlashCommandEntry) => {
    const next = slashInsertText(entry);
    setText(next);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(next.length, next.length));
    }
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  // 输入框上方的东西。上传完成、进度这些是异步回来的，所以真的状态放在 ref 里，每次改完同步给界面
  const [draft, setDraft] = useState<Draft>({ uploads: [], queue: [] });
  const draftRef = useRef(draft);
  const onSendRef = useRef(onSend);
  useEffect(() => {
    onSendRef.current = onSend;
  });

  // 离开页面（组件卸下）时，还在传的停掉，缩略图收回
  useEffect(
    () => () => {
      for (const u of draftRef.current.uploads) u.controller.abort();
      dropUploads(draftRef.current.uploads, new Set(draftRef.current.uploads.map((u) => u.key)));
    },
    [],
  );

  // 引用的卡片：发出去的时候取最新的（排着的语音是传好了才发的）；取过就算用掉了（发出去之后引用条会清掉）
  const quotedRef = useRef(quoted);
  useEffect(() => {
    quotedRef.current = quoted;
  });
  const takeCardRefs = (): MessagePart[] => {
    const parts = quotedRef.current.map((cardId): MessagePart => ({ type: "card_ref", cardId }));
    quotedRef.current = [];
    return parts;
  };

  /** 改输入框上方的东西；排着的语音有能发的（它和带走的附件都传好了），顺手按先后发出去 */
  const change = (f: (d: Draft) => Draft) => {
    const next = f(draftRef.current);
    const { messages, queue } = takeReadyVoices(next.uploads, next.queue);
    for (const m of messages) onSendRef.current([...takeCardRefs(), ...m.parts]);
    draftRef.current = { uploads: dropUploads(next.uploads, new Set(messages.flatMap((m) => m.keys))), queue };
    setDraft(draftRef.current);
  };
  const update = (key: string, f: (u: Upload) => Upload) => change((d) => ({ ...d, uploads: d.uploads.map((u) => (u.key === key ? f(u) : u)) }));

  /** 开始上传（重试时沿用原来的位置和 key）；传好了记下它在消息里的样子，排着的语音因此可能发得出去了 */
  const startUpload = (key: string, file: File, what: UploadWhat) => {
    const controller = new AbortController();
    update(key, (u) => ({ ...u, controller, part: undefined, progress: { state: "uploading", sent: 0, total: file.size } }));
    http
      .upload(file, { signal: controller.signal, onProgress: (progress) => update(key, (u) => ({ ...u, progress })) })
      .then((media) =>
        update(key, (u) => ({
          ...u,
          part: what.kind === "voice" ? voicePart(media, what.voice) : attachmentPart(media, what),
          progress: { state: "done", sent: file.size, total: file.size },
        })),
      )
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        update(key, (u) => ({ ...u, progress: { state: "failed", sent: 0, total: file.size, error: err instanceof Error ? err.message : String(err) } }));
      });
  };

  /** 输入框上方多一个上传：附件等着下一条消息；说完的语音排进队里，带走现在等着的附件 */
  const add = (file: File, what: UploadWhat) => {
    const key = `up-${++localSeq}`;
    const preview = what.kind === "attachment" && file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
    const fresh: Upload = { key, file, what, preview, part: undefined, controller: new AbortController(), progress: { state: "uploading", sent: 0, total: file.size } };
    change((d) => ({ uploads: [...d.uploads, fresh], queue: what.kind === "voice" ? queueVoice(d.uploads, d.queue, key) : d.queue }));
    startUpload(key, file, what);
  };

  const recorded = (voice: RecordedVoice) => add(new File([voice.blob], voiceFileName(voice.mime), { type: voice.mime }), { kind: "voice", voice });

  /** 删掉一个附件（排着的语音不再带它），或者放弃一段语音（它带走的附件留回去等下一条） */
  const remove = (key: string) => {
    draftRef.current.uploads.find((u) => u.key === key)?.controller.abort();
    change((d) => ({ ...d, uploads: dropUploads(d.uploads, new Set([key])) }));
  };

  const retry = (key: string) => {
    const u = draftRef.current.uploads.find((x) => x.key === key);
    if (u) startUpload(key, u.file, u.what);
  };

  /** 等着下一条消息的附件（排着的语音带走的不算） */
  const waiting = waitingAttachments(draft.uploads, draft.queue);
  const waitingNow = waitingState(waiting);

  const pick = (opts: { image?: boolean; material?: boolean }) => {
    setMenu(false);
    const input = fileInput.current;
    if (!input) return;
    feeding.current = opts.material === true;
    input.accept = opts.image ? "image/*" : "";
    input.click();
  };

  /** 发出去：引用的卡片、等着的附件（都传好了才行），文字模式下再加打的字；语音模式下的"直接发送"只发附件 */
  const send = (withText: boolean) => {
    // 点发送是用户手势：趁这时让播放器出一次声，之后 agent 的语音才能自动播放（36 号票）
    unlockVoicePlayback();
    const d = draftRef.current;
    const attachments = waitingAttachments(d.uploads, d.queue);
    const state = waitingState(attachments);
    if (state === "uploading" || state === "failed") return;
    const words = withText ? text.trim() : "";
    if (!words && attachments.length === 0) return;
    onSendRef.current([...takeCardRefs(), ...attachments.map((a) => a.part!), ...(words ? [{ type: "text", text: words } as const] : [])]);
    if (withText) setText("");
    change((x) => ({ ...x, uploads: dropUploads(x.uploads, new Set(attachments.map((a) => a.key))) }));
  };

  return (
    <div className="composer-wrap">
      {quoted.length > 0 && (
        <div className="quote-list">
          {quoted.map((cardId) => (
            <div key={cardId} className="quote-bar">
              <span className="quote-text">
                引用：<NamedText text={selectCard(ui, cardId)?.card.text ?? "卡片"} />
              </span>
              {onUnquote && (
                <button type="button" className="icon-btn" aria-label="去掉这条引用" onClick={() => onUnquote(cardId)}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {draft.uploads.length > 0 && (
        <div className="attach-list">
          {draft.uploads.map((u) => (
            <UploadChip
              key={u.key}
              upload={u}
              wait={u.what.kind === "voice" && u.part ? queuedVoiceWait(draft.uploads, draft.queue, u.key) : undefined}
              onRemove={() => remove(u.key)}
              onRetry={() => retry(u.key)}
            />
          ))}
          {voiceMode && waiting.length > 0 && (
            // 语音模式下只发附件、不说话（文字模式下不打字直接点发送就是）
            <div className="attach-send">
              <span className="attach-send-hint">按住说话，说完连同附件一起发</span>
              <button
                type="button"
                className="btn primary small"
                disabled={waitingNow !== "ready"}
                aria-label="不说话，直接发送附件"
                title={waitingNow === "uploading" ? "附件还在上传，传完才能发送" : waitingNow === "failed" ? "有附件没传上：重试或删掉它才能发送" : "不说话，只把这些附件发出去"}
                onClick={() => send(false)}
              >
                {waitingNow === "uploading" ? "上传中" : "直接发送"}
              </button>
            </div>
          )}
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
            // 两种模式一样：选的附件等在输入框上方，下一条消息（打的字、说完的语音，或者"直接发送"）把它们带走
            for (const file of Array.from(e.currentTarget.files ?? [])) add(file, { kind: "attachment", asMaterial: feeding.current });
            e.currentTarget.value = "";
          }}
        />
        {voiceMode ? (
          <VoiceInput onRecorded={recorded} />
        ) : (
          <div className="composer-field" ref={fieldRef}>
            <textarea
              ref={textareaRef}
              value={text}
              rows={1}
              placeholder={mode === "secretary" ? undefined : placeholder}
              aria-label={mode === "secretary" ? `和${assistantName}说…` : undefined}
              title={mode === "maintainer" ? "维护者在干活时，你的话作为插话，在它下一步之前插入" : undefined}
              aria-autocomplete="list"
              aria-expanded={slashOpen}
              aria-activedescendant={slashOpen ? slashItemId(slashActive) : undefined}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return send(true);
                // 候选开着：方向键挪、Enter / Tab 选中、Esc 关掉（输入法正在组字时的按键交给输入法）
                if (!slashOpen || e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashActive(nextSlashIndex(slashActive, e.key === "ArrowDown" ? 1 : -1, candidates.length));
                } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  const entry = candidates[slashActive];
                  if (entry) pickSlash(entry);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(text);
                }
              }}
            />
            {mode === "secretary" && text === "" && (
              <div className="composer-placeholder" aria-hidden="true">
                和<AssistantName />说…
              </div>
            )}
            {slashOpen && (
              <SlashMenu
                anchor={fieldRef}
                items={candidates}
                active={slashActive}
                onPick={pickSlash}
                onHover={setSlashActive}
                onClose={() => setSlashDismissed(text)}
              />
            )}
          </div>
        )}
        <button
          type="button"
          // data-to：点了切到哪种输入（视觉风格按它换图标，39 号票）
          className="icon-btn voice-toggle"
          data-to={voiceMode ? "text" : "voice"}
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
          <button
            type="button"
            className="btn primary"
            disabled={waitingNow === "uploading" || waitingNow === "failed" || (!text.trim() && waiting.length === 0)}
            onClick={() => send(true)}
            title={waitingNow === "uploading" ? "附件还在上传，传完才能发送" : waitingNow === "failed" ? "有附件没传上：重试或删掉它才能发送" : undefined}
          >
            {waitingNow === "uploading" ? "上传中" : "发送"}
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

/** 排着的语音传好了、还在等的：等什么 */
const VOICE_WAIT_LABEL: Record<NonNullable<ReturnType<typeof queuedVoiceWait>>, { status: string; title: string }> = {
  attachments: { status: "等附件传好", title: "附件传好了就连同这段语音一起发出去" },
  attachment_failed: { status: "等附件重传", title: "有附件没传上：重试它，或者删掉它，这段语音就发出去" },
  earlier: { status: "排队中", title: "前面说的那段还没发出去，发完就轮到这段" },
};

/**
 * 输入框上方一个正在上传（或传好了等着发）的文件：图片的缩略图、名字、进度条；附件传好了显示大小（等下一条消息带走），
 * 语音传好了还在排着的显示在等什么；失败时可以重试
 */
function UploadChip({ upload: u, wait, onRemove, onRetry }: { upload: Upload; wait: ReturnType<typeof queuedVoiceWait>; onRemove(): void; onRetry(): void }) {
  const { state, sent, total, error } = u.progress;
  const [broken, setBroken] = useState(false);
  const percent = total > 0 ? Math.floor((sent / total) * 100) : 100;
  const voice = u.what.kind === "voice";
  const name = u.what.kind === "voice" ? `🎤 语音 ${voiceDurationLabel(u.what.voice.durationMs)}` : u.file.name;
  const waitLabel = wait ? VOICE_WAIT_LABEL[wait] : undefined;
  const status = waitLabel
    ? waitLabel.status
    : state === "done"
      ? voice
        ? "已传好"
        : sizeLabel(total)
      : state === "uploading"
        ? `${percent}%`
        : state === "failed" && voice
          ? "没发出去"
          : STATE_LABEL[state];
  return (
    <span className={`attach attach-${state}${u.preview && !broken ? " attach-has-thumb" : ""}${waitLabel ? " attach-held" : ""}`} title={error ?? waitLabel?.title ?? STATE_LABEL[state]}>
      {u.preview && !broken ? (
        <img className="attach-thumb" src={u.preview} alt="" onError={() => setBroken(true)} />
      ) : (
        !voice && (
          <span className="attach-icon" aria-hidden="true">
            {u.preview ? "🖼" : "📄"}
          </span>
        )
      )}
      <span className="attach-name">{name}</span>
      {u.what.kind === "attachment" && u.what.asMaterial && <span className="chip chip-data">作为材料</span>}
      <span className="muted attach-status">{status}</span>
      {state === "failed" && (
        <button type="button" className="link attach-retry" onClick={onRetry}>
          重试
        </button>
      )}
      <button type="button" className="attach-x" aria-label={voice ? "放弃这段语音" : `移除 ${u.file.name}`} onClick={onRemove}>
        ×
      </button>
      {state !== "done" && state !== "failed" && (
        <span className="attach-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={`${voice ? "语音" : u.file.name} 上传进度`}>
          <i style={{ width: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}
