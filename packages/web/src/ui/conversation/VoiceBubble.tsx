/**
 * 语音气泡（规格第 22 节；31 号票起，36 号票改成同框）：和文字类似的气泡，带播放图标和时长，宽度随时长变。
 * 语音和它的文字在同一个框里（用户 2026-10-08 定）：播放条和时长在上，文字在下；有文字时框按文字撑开，随时长的宽度是最小宽度。
 * 点一下播放或暂停（同一时间只播一条，app/voice-playback.ts）；长按（桌面上右键）弹出菜单。两种用法：
 * - VoiceBubble：用户发的语音。识别出的文字识别完成就直接显示在框里，这段文字就算用户对识别结果的确认；
 *   还没识别完显示"识别中…"，失败显示"识别失败"。菜单里有"复制文字"，失败的还有"重新识别"；
 * - AgentVoiceBubble：agent 发的语音（32 号票的 TTS 音频）。默认框里只有播放条和时长，菜单里"转文字"在框里展开送进 TTS 的
 *   原文，再点"收起文字"收起；"复制文字"。新到的 agent 语音会自动播放（app/voice-autoplay.ts），浏览器拦下了就在框里提示
 *   "点一下播放"。
 * - StreamingAgentVoiceBubble（38 号票）：分段合成中的 agent 语音，第一段到了就出现在会话末尾，时长随已到的段增长、标"合成中"，
 *   点一下边收边播（再点停掉整条）；合成完了换成载着完整音频的那条消息（AgentVoiceBubble），重播用完整音频。
 *   agent 的语音在播放器里按语音 id 认（边收边播和完整音频是同一条），用户的语音按媒体 id 认。
 * 框的样子（有没有下半截、宽度怎么定、菜单里展开收起那一项）由状态层的 voiceBubbleLook / agentVoiceBubbleLook 给出。
 * 播放条里的波形只画按时长定的那几格（状态层的 voiceWave，69 号票），时长紧跟在波形后面，框因为文字变宽时空白留在行尾。
 * 消息通用的菜单项（引用等）等消息有了通用菜单再加。56 号票起菜单里有"详情 ›"（点一下是播放，详情从这里进）。
 * 菜单经 ui/popup.tsx 画在应用框最上面的一层（用户 2026-10-10 反馈被输入栏挡住：会话的缩放内容带 transform，就地画盖不过外面），
 * 贴着气泡：默认在下方，放不下翻到上方；自己发的右边对齐，agent 的左边对齐（原来样式里 .user .voice-menu 的规矩）。
 */
import { useRef, useState } from "react";
import { agentVoiceUrls, toggleVoice, useVoiceBlocked, useVoicePlaying } from "../../app/page-voice.ts";
import { useStore } from "../../app/store.tsx";
import type { VoiceSource } from "../../app/voice-playback.ts";
import {
  type AgentVoiceBubbleLook,
  agentVoiceBubble,
  agentVoiceBubbleLook,
  agentVoicePlayback,
  type AgentVoiceRecord,
  type MessagePart,
  playbackSource,
  type PopupAlign,
  streamingAgentVoiceBubble,
  voiceBubble,
  type VoiceBubbleLook,
  voiceBubbleLook,
  voiceWave,
} from "../../state/index.ts";
import { PopupMenu } from "../popup.tsx";
import { useToast } from "../toast.tsx";

type VoicePart = Extract<MessagePart, { type: "voice" }>;
type TtsAudioPart = Extract<MessagePart, { type: "tts_audio" }>;

/** 按住多久算长按（毫秒） */
const LONG_PRESS_MS = 500;
/** 按住时手指挪开多远就不算长按也不算点 */
const MOVE_TOLERANCE_PX = 10;

/** 用户发的语音：识别出的文字识别完成就显示在框里，失败的能在菜单里重新识别 */
export function VoiceBubble({ part, onDetail }: { part: VoicePart; onDetail?: (() => void) | undefined }) {
  const { ui, http, retryVoice } = useStore();
  const bubble = voiceBubble(ui, part);
  const voiceId = part.voiceId;
  return (
    <VoiceBubbleView
      playId={part.mediaId}
      source={http.mediaUrl(part.mediaId, "语音")}
      duration={bubble.duration}
      wave={voiceWave(part.waveform, part.durationMs)}
      text={bubble.text}
      look={voiceBubbleLook(bubble)}
      menuAlign="end"
      {...(bubble.canRetry && voiceId !== undefined ? { onRetry: () => retryVoice(voiceId) } : {})}
      onDetail={onDetail}
    />
  );
}

/** agent 发的语音（32 号票的语音回复）：文字不默认展开，长按（桌面右键）"转文字"在框里展开送进 TTS 的原文，再点收起 */
export function AgentVoiceBubble({ part, onDetail }: { part: TtsAudioPart; onDetail?: (() => void) | undefined }) {
  const { ui, http } = useStore();
  const [expanded, setExpanded] = useState(false);
  const bubble = agentVoiceBubble(ui, part);
  const look = agentVoiceBubbleLook(bubble, expanded);
  return (
    <VoiceBubbleView
      playId={part.voiceId}
      source={http.mediaUrl(part.mediaId, "语音")}
      duration={bubble.duration}
      wave={voiceWave(part.waveform, part.durationMs)}
      text={bubble.text}
      look={look}
      textToggle={{ ...look.textToggle, onToggle: () => setExpanded(!expanded) }}
      onDetail={onDetail}
    />
  );
}

/** 分段合成中的 agent 语音（38 号票）：时长是已经到了的段，标"合成中"，点一下边收边播 */
export function StreamingAgentVoiceBubble({ voice }: { voice: AgentVoiceRecord }) {
  const { http } = useStore();
  const [expanded, setExpanded] = useState(false);
  const bubble = streamingAgentVoiceBubble(voice);
  const look = agentVoiceBubbleLook(bubble, expanded);
  return (
    <VoiceBubbleView
      playId={voice.id}
      source={playbackSource(agentVoicePlayback(voice, agentVoiceUrls(http)))}
      duration={bubble.duration}
      wave={[]}
      text={bubble.text}
      look={look}
      note="合成中"
      textToggle={{ ...look.textToggle, onToggle: () => setExpanded(!expanded) }}
    />
  );
}

export interface VoiceBubbleViewProps {
  /** 播放器里认这一条的 id：用户的语音是媒体 id，agent 的语音是语音 id */
  playId: string;
  /** 点一下播什么（完整音频的地址，或者边收边播的段）；播不了（原型里没有真媒体）是 undefined */
  source: VoiceSource | undefined;
  /** 时长的说法（5″） */
  duration: string;
  /** 播放条里画的波形（每格 0–100）：voiceWave 按时长缩放好的格数，没有就不画 */
  wave: readonly number[];
  /** 这条语音的文字："复制文字"复制它；没有时菜单里的"复制文字"不能点 */
  text: string | undefined;
  /** 框的样子：框里下半截显示什么、宽度怎么定 */
  look: VoiceBubbleLook;
  /** 时长后面的小字（分段合成中的"合成中"） */
  note?: string;
  /** 菜单里展开 / 收起文字的那一项（agent 发的语音才有） */
  textToggle?: AgentVoiceBubbleLook["textToggle"] & { onToggle(): void };
  /** 给了就在菜单里加"重新识别" */
  onRetry?: () => void;
  /** 给了就在菜单里加"详情 ›"（56 号票：点一下是播放，详情从菜单进） */
  onDetail?: (() => void) | undefined;
  /** 长按菜单和气泡哪一边对齐：自己发的靠右（end），agent 的靠左（start，默认） */
  menuAlign?: PopupAlign;
}

export function VoiceBubbleView({ playId, source, duration, wave, text, look, note, textToggle, onRetry, onDetail, menuAlign = "start" }: VoiceBubbleViewProps) {
  const toast = useToast();
  const playing = useVoicePlaying(playId);
  const blocked = useVoiceBlocked(playId);
  // 长按菜单开没开：点别处、滚动、缩放、鸿蒙 App 的系统返回键（62 号票）都会关，见 ui/popup.tsx
  const [menu, setMenu] = useState(false);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout>; long: boolean } | null>(null);

  const play = () => {
    if (source !== undefined) toggleVoice(playId, source);
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
        ref={bubbleRef}
        type="button"
        className={`voice-bubble${playing ? " voice-playing" : ""}${body ? " voice-has-body" : ""}`}
        style={width}
        // 框里的字都在按钮里（读屏只读名字）：名字里带上框里显示的文字
        aria-label={`语音 ${duration}${note ? `，${note}` : ""}${blocked ? "，自动播放被浏览器拦下了" : ""}，${action}，长按看更多${body ? `。${body.text}` : ""}`}
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
          {wave.length > 0 && (
            <span className="voice-wave-mini" aria-hidden="true">
              {wave.map((v, i) => (
                <i key={i} style={{ height: `${Math.max(15, v)}%` }} />
              ))}
            </span>
          )}
          <span className="voice-duration">{duration}</span>
          {note && <span className="voice-note">{note}</span>}
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
        <PopupMenu anchor={bubbleRef} align={menuAlign} className="voice-menu" onClose={() => setMenu(false)}>
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
          {onDetail && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                onDetail();
              }}
            >
              详情 ›
            </button>
          )}
        </PopupMenu>
      )}
    </div>
  );
}
