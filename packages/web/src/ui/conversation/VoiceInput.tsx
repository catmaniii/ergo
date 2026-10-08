/**
 * 语音模式下的输入框（规格第 22 节，31 号票），照微信：整个输入框变成"按住 说话"。
 * 按住时弹出录音面板，显示当前音量和最近一小段滚动的波形；抬手发送；按住时上划超过一段距离进"松开取消"，抬手不发送；
 * 不到 1 秒提示"说话时间太短"；最后 10 秒倒计时，到 60 秒自动发送；没有麦克风权限时提示怎么开。
 * 麦克风预热（37 号票）：输入框挂上（进语音模式）就打开麦克风流、备好音量分析，但不录；按下的那个 pointer 事件里就开始录，
 * 开头不丢。离开语音模式（卸下）、切到后台、闲置太久立刻关掉麦克风；没预热好时照旧"准备中"，就绪之后才计时。
 * 触屏和鼠标都用 pointer 事件（不另绑 touch 事件：两者并存在手机上会重复触发），按下时抓住指针，手指滑出按钮也照样收到。
 * 手势的规矩在状态层（state/voice-gesture.ts、voice-mic.ts），接到浏览器上的在 app/voice-session.ts；
 * 录好的整段交给 onRecorded（上传后发消息）。
 * 36 号票起：按着的时候告诉播放器（在播的语音停下，新到的 agent 语音等松手再播）；抬手时顺带解锁播放器（手机浏览器要有
 * 用户手势才允许出声，见 app/voice-playback.ts）。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { pageVoicePlayer, unlockVoicePlayback, useVoiceAnyPlaying } from "../../app/page-voice.ts";
import { browserVoiceEnv, voiceSupport } from "../../app/voice-browser.ts";
import { type RecordedVoice, VoiceSession } from "../../app/voice-session.ts";
import { VOICE_LIVE_BARS, voiceGestureHint, voicePanelStatus } from "../../state/index.ts";

export type { RecordedVoice };

/** 提示停留多久 */
const NOTICE_MS = 1800;

/**
 * 按下的时刻：pointer 事件的 timeStamp（手指落下的那一刻，和 performance.now 同一个起点），量"按下 → 开录"用；
 * 看着不像（个别旧内核的起点不同）就用现在
 */
function pressTime(timeStamp: number): number {
  const now = performance.now();
  return timeStamp > 0 && timeStamp <= now && now - timeStamp < 1000 ? timeStamp : now;
}

export function VoiceInput({ onRecorded }: { onRecorded(voice: RecordedVoice): void }) {
  const [session] = useState(() => new VoiceSession(browserVoiceEnv()));
  const state = useSyncExternalStore(session.subscribe, session.getState);
  useEffect(() => session.onRecorded(onRecorded), [session, onRecorded]);
  const support = voiceSupport();
  const supported = support.ok;

  // 进语音模式（挂上）就预热麦克风；离开语音模式（卸下）立刻关掉。前后台、闲置由 session 自己盯着
  useEffect(() => {
    if (!supported) return;
    session.enter();
    return () => session.leave();
  }, [session, supported]);

  // 录着的时候：每一帧走一次时钟（倒计时、60 秒自动发送）、采音量
  const recording = state.phase === "recording";
  useEffect(() => {
    if (!recording) return;
    let frame = 0;
    const loop = (now: number) => {
      session.frame(now);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [recording, session]);

  // 按着的时候（等麦克风、正在录）不播语音（36 号票）：在播的停下（不然会录进去），新到的 agent 语音等松手再播
  const active = state.phase !== "idle";
  useEffect(() => pageVoicePlayer().setCapturing(active), [active]);
  useEffect(() => () => pageVoicePlayer().setCapturing(false), []);
  // 有语音在播：兜底 (a) 开着时先关麦克风、播完再预热；默认不开，这里什么也不做（app/voice-fallbacks.ts）
  const playing = useVoiceAnyPlaying();
  useEffect(() => session.setPlayback(playing), [session, playing]);

  // 提示停一会儿自己收起（没有权限的那条等用户点"知道了"）
  const notice = state.notice;
  useEffect(() => {
    if (!notice || notice.kind === "denied") return;
    const t = setTimeout(() => session.dismissNotice(), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, session]);

  if (!support.ok) return <div className="voice-hold voice-hold-off muted">{support.text}</div>;

  return (
    <div className="voice-input">
      {active && (
        <div className={`voice-panel${state.cancelZone ? " voice-cancel" : ""}`} role="status" aria-live="polite">
          <div className="voice-panel-time">{voicePanelStatus(state)}</div>
          <div className="voice-wave" aria-hidden="true">
            {Array.from({ length: VOICE_LIVE_BARS }, (_, i) => {
              const level = state.live[state.live.length - VOICE_LIVE_BARS + i] ?? 0;
              return <i key={i} style={{ height: `${Math.max(6, Math.round(level * 100))}%` }} />;
            })}
          </div>
          <div className="voice-meter" aria-label="当前音量">
            <i style={{ width: `${Math.round(state.level * 100)}%` }} />
          </div>
          <div className="voice-panel-hint">{voiceGestureHint(state)}</div>
        </div>
      )}
      {!active && notice && (
        <div className={`voice-notice voice-notice-${notice.kind}`} role="alert">
          {notice.text}
          {notice.kind === "denied" && (
            <button type="button" className="link" onClick={() => session.dismissNotice()}>
              知道了
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className={`voice-hold${active ? " voice-hold-active" : ""}${state.cancelZone ? " voice-cancel" : ""}`}
        aria-label="按住说话，松开发送，上划取消"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          // 预热好了的话，录音器就在这一步里开始
          session.press(e.clientY, pressTime(e.timeStamp));
        }}
        onPointerMove={(e) => session.move(e.clientY)}
        onPointerUp={() => {
          // 抬手是用户手势（手机上按下不算）：趁这时让播放器出一次声，agent 的语音回复到了才能自动播放（36 号票）。
          // 不在按下时做：免得和按下就开录挤在一起
          unlockVoicePlayback();
          session.release(performance.now());
        }}
        onPointerCancel={() => session.release(performance.now())}
        onContextMenu={(e) => e.preventDefault()}
      >
        {active ? (state.cancelZone ? "松开 取消" : "松开 发送") : "按住 说话"}
      </button>
    </div>
  );
}

