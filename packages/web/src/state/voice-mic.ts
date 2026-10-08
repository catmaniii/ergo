// 麦克风预热的开关时机（规格第 22 节"麦克风预热"，37 号票；用户 2026-10-08 定：提前加载麦克风但不记录）。
// 进语音模式（页面在前台）就打开麦克风流、备好音量分析，但不录（录音器按下才开始，见 voice-gesture.ts），所以开头不丢。
// 代价是语音模式期间浏览器和系统的麦克风指示灯亮着，所以这些时候立刻关掉：
// - 离开语音模式（切回文字、离开会话页，输入框卸下）；
// - 页面切到后台。
// 语音模式里闲置不关（44 号票，用户 2026-10-09 定）：放着多久都开着，按下即录。回到前台、重新进语音模式时再开。
// 权限：第一次进语音模式时自动要麦克风；被拒了不再自动要（切后台再回来、重新进语音模式都不弹，拒过的记在页面上，
// 由 enter 带进来），按下是用户自己的动作，照样要；要到了恢复预热。自动打开因为别的原因失败（没有麦克风、被占着）时
// 先关着不反复试，等下一次用到（按下、回到前台、重新进语音模式）再试。
// 36 号票评审加的兜底 (a)（默认不开，见 app/voice-fallbacks.ts）：有语音在播时（playback）先关着，播完再预热；
// 在播的时候按下照样要麦克风（这一段等"准备中"）。兜底没开时界面不送 playback，这一条不起作用。
// 纯函数：输入是进出语音模式、页面前后台、按住与否和打开的结果，输出"麦克风该不该开着"；
// 真正开关麦克风的是 app/voice-session.ts。

export interface VoiceMicState {
  /** 在语音模式里（"按住 说话"的输入框在） */
  entered: boolean;
  /** 页面在前台 */
  visible: boolean;
  /** 正按着"按住 说话" */
  held: boolean;
  /** 歇着：自动打开失败了；等下一次用到（按下、回到前台、重新进语音模式）再开 */
  resting: boolean;
  /** 要麦克风被拒过：不再自动要（按下照样要） */
  denied: boolean;
  /** 有语音在播（兜底 (a) 开着时才会变成 true）：先关着，播完再预热 */
  playing: boolean;
}

export type VoiceMicInput =
  /** 进语音模式（输入框挂上）：页面在不在前台；这个页面上之前有没有被拒过 */
  | { kind: "enter"; visible: boolean; denied: boolean }
  /** 离开语音模式（输入框卸下） */
  | { kind: "leave" }
  /** 页面切到前台或后台 */
  | { kind: "visibility"; visible: boolean }
  /** 按下（held 为真）或者这一段结束了（发送、丢掉、出错） */
  | { kind: "hold"; held: boolean }
  /** 要到麦克风了 */
  | { kind: "granted" }
  /** 要麦克风被拒了（没有权限） */
  | { kind: "denied" }
  /** 打开失败了（没有麦克风、被别的程序占着……） */
  | { kind: "failed" }
  /** 有语音开始播或者停了（兜底 (a)） */
  | { kind: "playback"; playing: boolean };

export const initialVoiceMic: VoiceMicState = { entered: false, visible: false, held: false, resting: false, denied: false, playing: false };

export function voiceMic(state: VoiceMicState, input: VoiceMicInput): VoiceMicState {
  switch (input.kind) {
    case "enter":
      // 在不在播和进出语音模式无关，接着记着
      return { entered: true, visible: input.visible, held: false, resting: false, denied: input.denied, playing: state.playing };
    case "playback":
      return { ...state, playing: input.playing };
    case "leave":
      return { ...state, entered: false, held: false };
    case "visibility":
      // 回到前台：歇着的也重新预热
      return input.visible ? { ...state, visible: true, resting: false } : { ...state, visible: false };
    case "hold":
      // 按下是要用：歇着的也打开；抬手时这一段里打开失败歇着的，接着歇着
      return { ...state, held: input.held, resting: input.held ? false : state.resting };
    case "granted":
      return { ...state, denied: false };
    // 要不到麦克风：按着的这一段也随之结束（不会因为还按着又去要一次）
    case "denied":
      return { ...state, denied: true, held: false };
    case "failed":
      return { ...state, resting: true, held: false };
  }
}

/** 麦克风现在该不该开着：在语音模式里、页面在前台，并且正按着，或者没歇着、没被拒过、没有语音在播（兜底 (a)） */
export function voiceMicWanted(state: VoiceMicState): boolean {
  return state.entered && state.visible && (state.held || (!state.resting && !state.denied && !state.playing));
}
