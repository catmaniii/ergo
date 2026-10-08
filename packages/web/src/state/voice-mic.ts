// 麦克风预热的开关时机（规格第 22 节"麦克风预热"，37 号票；用户 2026-10-08 定：提前加载麦克风但不记录）。
// 进语音模式（页面在前台）就打开麦克风流、备好音量分析，但不录（录音器按下才开始，见 voice-gesture.ts），所以开头不丢。
// 代价是语音模式期间浏览器和系统的麦克风指示灯亮着，所以这些时候立刻关掉：
// - 离开语音模式（切回文字、离开会话页，输入框卸下）；
// - 页面切到后台；
// - 语音模式里闲置超过 VOICE_MIC_IDLE_MS（从最后一次用到算起：进语音模式、回到前台、按下、抬手；按着的时候不算闲置）。
// 回到前台、按下、重新进语音模式时再开；闲置关掉后按下的那一次照旧"准备中"。
// 权限：第一次进语音模式时自动要麦克风；被拒了不再自动要（切后台再回来、重新进语音模式都不弹，拒过的记在页面上，
// 由 enter 带进来），按下是用户自己的动作，照样要；要到了恢复预热。自动打开因为别的原因失败（没有麦克风、被占着）时
// 先关着不反复试，等下一次用到再试。
// 纯函数：输入是进出语音模式、页面前后台、按住与否、时钟和打开的结果，输出"麦克风该不该开着"和闲置的期限；
// 真正开关麦克风的是 app/voice-session.ts。

/** 语音模式里闲置多久关掉麦克风（毫秒） */
export const VOICE_MIC_IDLE_MS = 10 * 60_000;

export interface VoiceMicState {
  /** 在语音模式里（"按住 说话"的输入框在） */
  entered: boolean;
  /** 页面在前台 */
  visible: boolean;
  /** 正按着"按住 说话" */
  held: boolean;
  /** 最后一次用到的时刻（进语音模式、回到前台、按下、抬手），闲置从这里算起 */
  lastUsedAt: number;
  /** 歇着：闲置太久关掉了，或者自动打开失败了；等下一次用到（按下、回到前台、重新进语音模式）再开 */
  resting: boolean;
  /** 要麦克风被拒过：不再自动要（按下照样要） */
  denied: boolean;
}

export type VoiceMicInput =
  /** 进语音模式（输入框挂上）：页面在不在前台；这个页面上之前有没有被拒过 */
  | { kind: "enter"; time: number; visible: boolean; denied: boolean }
  /** 离开语音模式（输入框卸下） */
  | { kind: "leave" }
  /** 页面切到前台或后台 */
  | { kind: "visibility"; visible: boolean; time: number }
  /** 按下（held 为真）或者这一段结束了（发送、丢掉、出错） */
  | { kind: "hold"; held: boolean; time: number }
  /** 时钟走了（闲置的期限到了时送一次） */
  | { kind: "tick"; time: number }
  /** 要到麦克风了 */
  | { kind: "granted" }
  /** 要麦克风被拒了（没有权限） */
  | { kind: "denied" }
  /** 打开失败了（没有麦克风、被别的程序占着……） */
  | { kind: "failed" };

export const initialVoiceMic: VoiceMicState = { entered: false, visible: false, held: false, lastUsedAt: 0, resting: false, denied: false };

export function voiceMic(state: VoiceMicState, input: VoiceMicInput): VoiceMicState {
  switch (input.kind) {
    case "enter":
      return { entered: true, visible: input.visible, held: false, lastUsedAt: input.time, resting: false, denied: input.denied };
    case "leave":
      return { ...state, entered: false, held: false };
    case "visibility":
      // 回到前台算用到了一次：歇着的也重新预热
      return input.visible ? { ...state, visible: true, lastUsedAt: input.time, resting: false } : { ...state, visible: false };
    case "hold":
      // 按下是要用：歇着的也打开；抬手只是记下用到的时刻（这一段里打开失败歇着的，接着歇着）
      return { ...state, held: input.held, lastUsedAt: input.time, resting: input.held ? false : state.resting };
    case "tick": {
      const idleAt = voiceMicIdleAt(state);
      return idleAt !== undefined && input.time >= idleAt ? { ...state, resting: true } : state;
    }
    case "granted":
      return { ...state, denied: false };
    // 要不到麦克风：按着的这一段也随之结束（不会因为还按着又去要一次）
    case "denied":
      return { ...state, denied: true, held: false };
    case "failed":
      return { ...state, resting: true, held: false };
  }
}

/** 麦克风现在该不该开着：在语音模式里、页面在前台，并且正按着，或者没歇着、没被拒过 */
export function voiceMicWanted(state: VoiceMicState): boolean {
  return state.entered && state.visible && (state.held || (!state.resting && !state.denied));
}

/** 闲置到什么时候关掉麦克风；按着的时候、本来就不该开着的时候没有 */
export function voiceMicIdleAt(state: VoiceMicState): number | undefined {
  return voiceMicWanted(state) && !state.held ? state.lastUsedAt + VOICE_MIC_IDLE_MS : undefined;
}
