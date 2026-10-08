/**
 * 语音气泡（规格第 22 节；31 号票起，36 号票改成同框）：和文字类似的气泡，带播放图标和时长，宽度随时长变。
 * 语音和它的文字在同一个框里（用户 2026-10-08 定）：播放条和时长在上，文字在下；有文字时框按文字撑开，随时长的宽度是最小宽度。
 * 点一下播放或暂停（同一时间只播一条，app/voice-playback.ts）；长按（桌面上右键）弹出菜单。两种用法：
 * - VoiceBubble：用户发的语音。识别出的文字识别完成就直接显示在框里，这段文字就算用户对识别结果的确认；
 *   还没识别完显示"识别中…"，失败显示"识别失败"。菜单里有"复制文字"，失败的还有"重新识别"；
 * - AgentVoiceBubble：agent 发的语音（32 号票的 TTS 音频）。默认框里只有播放条和时长，菜单里"转文字"在框里展开送进 TTS 的
 *   原文，再点"收起文字"收起；"复制文字"。新到的 agent 语音会自动播放（app/voice-autoplay.ts），浏览器拦下了就在框里提示
 *   "点一下播放"。
 * 框的样子（有没有下半截、宽度怎么定、菜单里展开收起那一项）由状态层的 voiceBubbleLook / agentVoiceBubbleLook 给出。
 * 消息通用的菜单项（引用等）等消息有了通用菜单再加。
 */
import { useEffect, useRef, useState } from "react";
import { toggleVoice, useVoiceBlocked, useVoicePlaying } from "../../app/page-voice.ts";
import { useStore } from "../../app/store.tsx";
import { type AgentVoiceBubbleLook, agentVoiceBubble, agentVoiceBubbleLook, type MessagePart, voiceBubble, type VoiceBubbleLook, voiceBubbleLook } from "../../state/index.ts";
import { useToast } from "../toast.tsx";

type VoicePart = Extract<MessagePart, { type: "voice" }>;
type TtsAudioPart = Extract<MessagePart, { type: "tts_audio" }>;

/** 按住多久算长按（毫秒） */
const LONG_PRESS_MS = 500;
/** 按住时手指挪开多远就不算长按也不算点 */
const MOVE_TOLERANCE_PX = 10;

/** 用户发的语音：识别出的文字识别完成就显示在框里，失败的能在菜单里重新识别 */
export function VoiceBubble({ part }: { part: VoicePart }) {
  const { ui, retryVoice } = useStore();
  const bubble = voiceBubble(ui, part);
  const voiceId = part.voiceId;
  return (
    <VoiceBubbleView
      mediaId={part.mediaId}
      duration={bubble.duration}
      waveform={part.waveform}
      text={bubble.text}
      look={voiceBubbleLook(bubble)}
      {...(bubble.canRetry && voiceId !== undefined ? { onRetry: () => retryVoice(voiceId) } : {})}
    />
  );
}

/** agent 发的语音（32 号票的语音回复）：文字不默认展开，长按（桌面右键）"转文字"在框里展开送进 TTS 的原文，再点收起 */
export function AgentVoiceBubble({ part }: { part: TtsAudioPart }) {
  const { ui } = useStore();
  const [expanded, setExpanded] = useState(false);
  const bubble = agentVoiceBubble(ui, part);
  const look = agentVoiceBubbleLook(bubble, expanded);
  return <VoiceBubbleView mediaId={part.mediaId} duration={bubble.duration} waveform={part.waveform} text={bubble.text} look={look} textToggle={{ ...look.textToggle, onToggle: () => setExpanded(!expanded) }} />;
}

export interface VoiceBubbleViewProps {
  mediaId: string;
  /** 时长的说法（5″） */
  duration: string;
  /** 波形摘要（每格 0–100） */
  waveform: readonly number[];
  /** 这条语音的文字："复制文字"复制它；没有时菜单里的"复制文字"不能点 */
  text: string | undefined;
  /** 框的样子：框里下半截显示什么、宽度怎么定 */
  look: VoiceBubbleLook;
  /** 菜单里展开 / 收起文字的那一项（agent 发的语音才有） */
  textToggle?: AgentVoiceBubbleLook["textToggle"] & { onToggle(): void };
  /** 给了就在菜单里加"重新识别" */
  onRetry?: () => void;
}

export function VoiceBubbleView({ mediaId, duration, waveform, text, look, textToggle, onRetry }: VoiceBubbleViewProps) {
  const { http } = useStore();
  const toast = useToast();
  const playing = useVoicePlaying(mediaId);
  const blocked = useVoiceBlocked(mediaId);
  const url = http.mediaUrl(mediaId, "语音");
  const [menu, setMenu] = useState(false);
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

  const { body } = look;
  const failed = body?.kind === "failed";
  // 自动播放被拦下时框里多一行"点一下播放"：随时长的宽度这时也只当最小宽度，短语音的框按这行字撑开，不折行
  const hint = blocked && !playing;
  const width = "exact" in look.width ? (hint ? { minWidth: look.width.exact } : { width: look.width.exact }) : { minWidth: look.width.min };
  const action = playing ? "点一下暂停" : "点一下播放";
  return (
    <div className="voice-msg">
      <button
        type="button"
        className={`voice-bubble${playing ? " voice-playing" : ""}${body ? " voice-has-body" : ""}`}
        style={width}
        // 框里的字都在按钮里（读屏只读名字）：名字里带上框里显示的文字
        aria-label={`语音 ${duration}${blocked ? "，自动播放被浏览器拦下了" : ""}，${action}，长按看更多${body ? `。${body.text}` : ""}`}
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
        <span className="voice-bar">
          <span className="voice-icon" aria-hidden="true">
            {playing ? "❚❚" : "▶"}
          </span>
          <span className="voice-wave-mini" aria-hidden="true">
            {waveform.slice(0, 16).map((v, i) => (
              <i key={i} style={{ height: `${Math.max(15, v)}%` }} />
            ))}
          </span>
          <span className="voice-duration">{duration}</span>
        </span>
        {hint && <span className="voice-tap-hint">点一下播放</span>}
        {body && (
          <span className={`voice-body${body.kind === "text" ? " voice-text" : ` voice-status voice-status-${body.kind}`}`}>
            {body.text}
            {failed && onRetry && "（长按语音可以重新识别）"}
          </span>
        )}
      </button>
      {menu && (
        <div className="voice-menu" role="menu" onPointerDown={(e) => e.stopPropagation()}>
          {textToggle && (
            <button
              type="button"
              role="menuitem"
              disabled={!textToggle.enabled}
              onClick={() => {
                textToggle.onToggle();
                setMenu(false);
              }}
            >
              {textToggle.label}
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
    </div>
  );
}
