/**
 * 语音气泡（规格第 22 节，31 号票）：和文字类似的气泡，带播放图标和时长，宽度随时长变。
 * 点一下播放或暂停（同一时间只播一条，app/voice-playback.ts）；长按（桌面上右键）弹出菜单。两种用法（VoiceBubbleView 的 textMode）：
 * - shown：用户发的语音（VoiceBubble）。识别出的文字默认直接显示在气泡下方，这段文字就算用户对识别结果的确认；
 *   还没识别完显示"识别中…"，失败显示"识别失败"。菜单里有"复制文字"，失败的还有"重新识别"；
 * - on_demand：agent 发的语音（32 号票的 TTS 音频）。菜单里"转文字"在气泡下方展开送进 TTS 的原文，再点收起；"复制文字"。
 * 消息通用的菜单项（引用等）等消息有了通用菜单再加。用户的语音气泡要的东西（时长、宽度、状态、文字）由状态层的 voiceBubble 给出，
 * agent 的（AgentVoiceBubble，32 号票）由 agentVoiceBubble 给出。
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { toggleVoice, useVoicePlaying } from "../../app/voice-playback.ts";
import { agentVoiceBubble, type MessagePart, type VoiceBubble as VoiceBubbleState, voiceBubble } from "../../state/index.ts";
import { useToast } from "../toast.tsx";

type VoicePart = Extract<MessagePart, { type: "voice" }>;
type TtsAudioPart = Extract<MessagePart, { type: "tts_audio" }>;

/** 按住多久算长按（毫秒） */
const LONG_PRESS_MS = 500;
/** 按住时手指挪开多远就不算长按也不算点 */
const MOVE_TOLERANCE_PX = 10;

/** 用户发的语音：识别出的文字默认显示在气泡下方，失败的能在菜单里重新识别 */
export function VoiceBubble({ part }: { part: VoicePart }) {
  const { ui, retryVoice } = useStore();
  const bubble = voiceBubble(ui, part);
  const voiceId = part.voiceId;
  return (
    <VoiceBubbleView
      mediaId={part.mediaId}
      duration={bubble.duration}
      width={bubble.width}
      waveform={part.waveform}
      text={bubble.text}
      textMode="shown"
      caption={bubble.caption}
      {...(bubble.canRetry && voiceId !== undefined ? { onRetry: () => retryVoice(voiceId) } : {})}
    />
  );
}

/** agent 发的语音（32 号票的语音回复）：文字不默认展开，长按（桌面右键）"转文字"展开送进 TTS 的原文，再点收起 */
export function AgentVoiceBubble({ part }: { part: TtsAudioPart }) {
  const { ui } = useStore();
  const bubble = agentVoiceBubble(ui, part);
  return <VoiceBubbleView mediaId={part.mediaId} duration={bubble.duration} width={bubble.width} waveform={part.waveform} text={bubble.text} textMode="on_demand" />;
}

export interface VoiceBubbleViewProps {
  mediaId: string;
  /** 时长的说法（5″） */
  duration: string;
  width: number;
  /** 波形摘要（每格 0–100） */
  waveform: readonly number[];
  /** 这条语音的文字："复制文字"复制它，on_demand 时"转文字"展开它；没有时菜单里的"复制文字"不能点 */
  text: string | undefined;
  /** shown：气泡下方总显示 caption（用户发的语音）；on_demand：长按"转文字"才展开 text（agent 发的语音） */
  textMode: "shown" | "on_demand";
  /** shown 时气泡下方的那一行 */
  caption?: VoiceBubbleState["caption"];
  /** 给了就在菜单里加"重新识别" */
  onRetry?: () => void;
}

export function VoiceBubbleView({ mediaId, duration, width, waveform, text, textMode, caption, onRetry }: VoiceBubbleViewProps) {
  const { http } = useStore();
  const toast = useToast();
  const playing = useVoicePlaying(mediaId);
  const url = http.mediaUrl(mediaId, "语音");
  const [menu, setMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout>; long: boolean } | null>(null);

  // 菜单开着时点别处收起
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const play = () => {
    if (url) toggleVoice(mediaId, url);
    else toast("这条语音现在播放不了");
  };

  const copy = () => {
    setMenu(false);
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => toast("文字已复制"),
      () => toast("复制失败"),
    );
  };

  return (
    <div className="voice-msg">
      <button
        type="button"
        className={`voice-bubble${playing ? " voice-playing" : ""}`}
        style={{ width }}
        aria-label={`语音 ${duration}，${playing ? "点一下暂停" : "点一下播放"}，长按看更多`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const timer = setTimeout(() => {
            if (!press.current) return;
            press.current.long = true;
            setMenu(true);
          }, LONG_PRESS_MS);
          press.current = { x: e.clientX, y: e.clientY, timer, long: false };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE_PX) {
            clearTimeout(p.timer);
            press.current = null;
          }
        }}
        onPointerUp={() => {
          const p = press.current;
          press.current = null;
          if (!p) return;
          clearTimeout(p.timer);
          if (!p.long) play();
        }}
        onPointerCancel={() => {
          if (press.current) clearTimeout(press.current.timer);
          press.current = null;
        }}
        onContextMenu={(e) => {
          // 桌面上右键：弹出菜单（手机上长按也会触发它，菜单已经由长按打开）
          e.preventDefault();
          setMenu(true);
        }}
      >
        <span className="voice-icon" aria-hidden="true">
          {playing ? "❚❚" : "▶"}
        </span>
        <span className="voice-wave-mini" aria-hidden="true">
          {waveform.slice(0, 16).map((v, i) => (
            <i key={i} style={{ height: `${Math.max(15, v)}%` }} />
          ))}
        </span>
        <span className="voice-duration">{duration}</span>
      </button>
      {menu && (
        <div className="voice-menu" role="menu" onPointerDown={(e) => e.stopPropagation()}>
          {textMode === "on_demand" && (
            <button
              type="button"
              role="menuitem"
              disabled={!text}
              onClick={() => {
                setExpanded(!expanded);
                setMenu(false);
              }}
            >
              {expanded ? "收起文字" : "转文字"}
            </button>
          )}
          <button type="button" role="menuitem" disabled={!text} onClick={copy}>
            复制文字
          </button>
          {onRetry && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                onRetry();
              }}
            >
              重新识别
            </button>
          )}
        </div>
      )}
      {textMode === "shown" && caption && (
        <div className={caption.kind === "text" ? "voice-text" : `voice-status voice-status-${caption.kind}`}>
          {caption.text}
          {caption.kind === "failed" && onRetry && <span>（长按语音可以重新识别）</span>}
        </div>
      )}
      {textMode === "on_demand" && expanded && text && <div className="voice-text">{text}</div>}
    </div>
  );
}
