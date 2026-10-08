/**
 * 语音模式下的输入框（规格第 22 节，31 号票），照微信：整个输入框变成"按住 说话"。
 * 按住时弹出录音面板，显示当前音量和最近一小段滚动的波形；抬手发送；按住时上划超过一段距离进"松开取消"，抬手不发送；
 * 不到 1 秒提示"说话时间太短"；最后 10 秒倒计时，到 60 秒自动发送；没有麦克风权限时提示怎么开。
 * 麦克风只在按住时开着：按下时才要，抬手、取消、切到后台、离开语音模式立刻停掉；流就绪之前面板显示"准备中"，就绪之后才计时。
 * 触屏和鼠标都用 pointer 事件（不另绑 touch 事件：两者并存在手机上会重复触发），按下时抓住指针，手指滑出按钮也照样收到。
 * 手势的规矩在状态层（state/voice-gesture.ts），录音在 app/voice-recorder.ts；录好的整段交给 onRecorded（上传后发消息）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isRecordingCancelled, micErrorOf, type Recording, VoiceRecorder, voiceSupport } from "../../app/voice-recorder.ts";
import {
  initialVoiceGesture,
  VOICE_LIVE_BARS,
  voiceGesture,
  type VoiceGestureInput,
  type VoiceGestureState,
  voiceGestureHint,
  voiceMicOpen,
  voicePanelStatus,
} from "../../state/index.ts";

/** 多久采一次音量（毫秒）：滚动的波形一格 */
const LEVEL_INTERVAL_MS = 100;
/** 提示停留多久 */
const NOTICE_MS = 1800;

export interface RecordedVoice extends Recording {
  durationMs: number;
  waveform: number[];
}

export function VoiceInput({ onRecorded }: { onRecorded(voice: RecordedVoice): void }) {
  const recorder = useRef<VoiceRecorder | null>(null);
  recorder.current ??= new VoiceRecorder();
  const stateRef = useRef<VoiceGestureState>(initialVoiceGesture);
  const [state, setState] = useState<VoiceGestureState>(initialVoiceGesture);
  const onRecordedRef = useRef(onRecorded);
  useEffect(() => {
    onRecordedRef.current = onRecorded;
  });
  const support = voiceSupport();

  /** 喂一个输入给手势状态机，执行它要做的事（开始录、停下发送、停下丢掉） */
  const apply = useCallback(function apply(input: VoiceGestureInput): void {
    const step = voiceGesture(stateRef.current, input);
    stateRef.current = step.state;
    setState(step.state);
    const rec = recorder.current!;
    if (step.effect === "start") {
      rec.start().then(
        () => {
          // 麦克风就绪之前就抬手了（说话时间太短）、切到了后台：刚开的录音连同麦克风一起停掉
          if (stateRef.current.phase !== "starting") return rec.cancel();
          apply({ kind: "ready", time: performance.now() });
        },
        (err: unknown) => {
          // 还没开始就被取消了（抬手、又按了一次）：麦克风已经停掉，别去动后来的那一段
          if (isRecordingCancelled(err)) return;
          rec.cancel();
          apply({ kind: "error", ...micErrorOf(err) });
        },
      );
    } else if (step.effect === "discard") {
      rec.cancel();
    } else if (step.effect === "send") {
      const sent = step.state.sent!;
      rec.stop().then(
        (recording) => onRecordedRef.current({ ...recording, ...sent }),
        (err: unknown) => apply({ kind: "error", reason: "failed", text: `没录下来：${err instanceof Error ? err.message : String(err)}` }),
      );
    }
  }, []);

  // 按着的时候切到后台：这一段丢掉不发，麦克风停掉；离开语音模式（组件卸下）时也停掉
  useEffect(() => {
    const rec = recorder.current!;
    const onVisibility = () => {
      if (document.hidden) apply({ kind: "abort" });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      rec.cancel();
    };
  }, [apply]);

  // 兜底：手势回到空闲（不该开着麦克风）时，还开着的一律停掉（发送的那一段已经在 stop 里交出去了，这里是空操作）
  const micOpen = voiceMicOpen(state);
  useEffect(() => {
    if (!micOpen) recorder.current!.cancel();
  }, [micOpen]);

  // 录着的时候：每一帧走一次时钟（倒计时、60 秒自动发送），每 0.1 秒采一次音量
  const recording = state.phase === "recording";
  useEffect(() => {
    if (!recording) return;
    let frame = 0;
    let lastLevel = 0;
    const loop = (now: number) => {
      if (now - lastLevel >= LEVEL_INTERVAL_MS) {
        lastLevel = now;
        apply({ kind: "level", level: recorder.current!.level() });
      }
      apply({ kind: "tick", time: now });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [recording, apply]);

  // 提示停一会儿自己收起
  const notice = state.notice;
  useEffect(() => {
    if (!notice || notice.kind === "denied") return;
    const t = setTimeout(() => apply({ kind: "dismiss_notice" }), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, apply]);

  if (!support.ok) return <div className="voice-hold voice-hold-off muted">{support.text}</div>;

  const active = state.phase !== "idle";
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
            <button type="button" className="link" onClick={() => apply({ kind: "dismiss_notice" })}>
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
          apply({ kind: "press", y: e.clientY });
        }}
        onPointerMove={(e) => apply({ kind: "move", y: e.clientY })}
        onPointerUp={() => apply({ kind: "release", time: performance.now() })}
        onPointerCancel={() => apply({ kind: "release", time: performance.now() })}
        onContextMenu={(e) => e.preventDefault()}
      >
        {active ? (state.cancelZone ? "松开 取消" : "松开 发送") : "按住 说话"}
      </button>
    </div>
  );
}

