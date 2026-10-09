// 麦克风预热的开关时机（规格第 22 节"麦克风预热"，37 号票；用户 2026-10-08 定：提前加载麦克风但不记录）。
// 进语音模式（页面在前台）就打开麦克风流、备好音量分析，但不录（录音器按下才开始，见 voice-gesture.ts），所以开头不丢。
// 代价是语音模式期间浏览器和系统的麦克风指示灯亮着，所以这些时候立刻关掉：
// - 离开语音模式（切回文字、离开会话页，输入框卸下）；
// - 页面切到后台；
// - 让路（61 号票，用户 2026-10-09 反馈"麦克风被占用"，调研 docs/research/16 的方案一）：页面里可输入的元素（输入框、
//   textarea、contenteditable，见 isTextEntry）拿到焦点、窗口失去焦点（页面还看得见，比如分屏切到另一边）时立即放开，
//   让系统输入法的语音能用（安卓上 Chrome 占着时输入法只录到静音；鸿蒙上先占着的一方把后来的输入法拒掉；iOS 听写会打断
//   网页的录音）。焦点回来（离开输入元素、窗口回来）之后先等 VOICE_MIC_RETURN_DELAY_MS 再预热：免得挤掉还在录的输入法，
//   焦点从一个输入框跳到另一个时也不会开了又关。按住说话的时候焦点怎么变都不打断（"按住 说话"本身不是输入元素）。
// 语音模式里闲置不关（44 号票，用户 2026-10-09 定）：放着多久都开着，按下即录。回到前台、重新进语音模式时再开。
// 权限：第一次进语音模式时自动要麦克风；被拒了不再自动要（切后台再回来、重新进语音模式都不弹，拒过的记在页面上，
// 由 enter 带进来），按下是用户自己的动作，照样要；要到了恢复预热。自动打开因为别的原因失败（没有麦克风、被占着）时
// 先关着不反复试，等下一次用到（按下、回到前台、窗口回来、重新进语音模式）再试。
// 36 号票评审加的兜底 (a)（默认不开，见 app/voice-fallbacks.ts）：有语音在播时（playback）先关着，播完再预热；
// 在播的时候按下照样要麦克风（这一段等"准备中"）。兜底没开时界面不送 playback，这一条不起作用。
// 纯函数：输入是进出语音模式、页面前后台、焦点、按住与否、时钟和打开的结果，输出"麦克风该不该开着"，以及开、关的原因
// （诊断记录用）；真正开关麦克风的是 app/voice-session.ts。

/** 焦点回来（离开输入元素、窗口回来）之后等多久再预热（毫秒） */
export const VOICE_MIC_RETURN_DELAY_MS = 500;

export interface VoiceMicState {
  /** 在语音模式里（"按住 说话"的输入框在） */
  entered: boolean;
  /** 页面在前台 */
  visible: boolean;
  /** 窗口有系统焦点（分屏切到另一边时没有） */
  focused: boolean;
  /** 焦点在页面里可输入的元素上：让给系统输入法 */
  editing: boolean;
  /** 刚从让路回来：到 until 之前先不开（免得挤掉还在录的输入法）；reason 是怎么回来的 */
  returning: { until: number; reason: "edit-out" | "focus" } | undefined;
  /** 正按着"按住 说话" */
  held: boolean;
  /** 歇着：自动打开失败了；等下一次用到（按下、回到前台、窗口回来、重新进语音模式）再开 */
  resting: boolean;
  /** 要麦克风被拒过：不再自动要（按下照样要） */
  denied: boolean;
  /** 有语音在播（兜底 (a) 开着时才会变成 true）：先关着，播完再预热 */
  playing: boolean;
}

export type VoiceMicInput =
  /** 进语音模式（输入框挂上）：页面在不在前台、窗口有没有焦点、焦点在不在输入元素上；这个页面上之前有没有被拒过 */
  | { kind: "enter"; visible: boolean; focused: boolean; editing: boolean; denied: boolean }
  /** 离开语音模式（输入框卸下） */
  | { kind: "leave" }
  /** 页面切到前台或后台 */
  | { kind: "visibility"; visible: boolean }
  /** 焦点进出可输入的元素（time：这一刻） */
  | { kind: "editing"; editing: boolean; time: number }
  /** 窗口得到或失去系统焦点（time：这一刻） */
  | { kind: "focus"; focused: boolean; time: number }
  /** 时钟走了（等回来的那 0.5 秒到了没有） */
  | { kind: "tick"; time: number }
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

export const initialVoiceMic: VoiceMicState = {
  entered: false,
  visible: false,
  focused: false,
  editing: false,
  returning: undefined,
  held: false,
  resting: false,
  denied: false,
  playing: false,
};

export function voiceMic(state: VoiceMicState, input: VoiceMicInput): VoiceMicState {
  switch (input.kind) {
    case "enter":
      // 在不在播和进出语音模式无关，接着记着
      return {
        ...initialVoiceMic,
        entered: true,
        visible: input.visible,
        focused: input.focused,
        editing: input.editing,
        denied: input.denied,
        playing: state.playing,
      };
    case "playback":
      return { ...state, playing: input.playing };
    case "leave":
      return { ...state, entered: false, held: false, returning: undefined };
    case "visibility":
      // 回到前台：歇着的也重新预热，马上开。切到后台时窗口焦点不再跟踪、当作回来时一起回来（切到别的 App 时窗口也失去焦点，
      // 回来时 visibilitychange 和窗口的 focus 先后不定，都按回到前台算，不等 0.5 秒）；真的没回来，下一次看焦点时照样让路
      return input.visible ? { ...state, visible: true, resting: false } : { ...state, visible: false, focused: true, returning: undefined };
    case "editing":
      if (input.editing === state.editing) return state;
      // 拿到焦点：放开，等回来的作废；离开：等一会儿再开（按着的时候不用等，麦克风本来就开着）
      if (input.editing) return { ...state, editing: true, returning: undefined };
      return { ...state, editing: false, returning: state.held ? undefined : { until: input.time + VOICE_MIC_RETURN_DELAY_MS, reason: "edit-out" } };
    case "focus":
      // 页面在后台时窗口焦点的变化不算（见上面 visibility）
      if (input.focused === state.focused || !state.visible) return state;
      if (!input.focused) return { ...state, focused: false, returning: undefined };
      // 窗口回来算回到前台：歇着的也再试一次
      return {
        ...state,
        focused: true,
        resting: false,
        returning: state.held ? undefined : { until: input.time + VOICE_MIC_RETURN_DELAY_MS, reason: "focus" },
      };
    case "tick":
      return state.returning && input.time >= state.returning.until ? { ...state, returning: undefined } : state;
    case "hold":
      // 按下是要用：歇着的也打开，等回来的不再等；抬手时这一段里打开失败歇着的，接着歇着
      return input.held ? { ...state, held: true, resting: false, returning: undefined } : { ...state, held: false };
    case "granted":
      return { ...state, denied: false };
    // 要不到麦克风：按着的这一段也随之结束（不会因为还按着又去要一次）
    case "denied":
      return { ...state, denied: true, held: false };
    case "failed":
      return { ...state, resting: true, held: false };
  }
}

/**
 * 开麦的原因（诊断记录用）：enter 进语音模式、visible 回到前台、press 按下（之前没开着）、edit-out 离开输入元素 0.5 秒后、
 * focus 窗口回来 0.5 秒后、playback-end 兜底 (a) 播完、stale 本来就该开着但流失效了（结束了、被系统静音了）、
 * silent 上一段整段是静音之后换一个流（app/voice-session.ts）
 */
export type VoiceMicOpenReason = "enter" | "visible" | "press" | "edit-out" | "focus" | "playback-end" | "stale" | "silent";

/**
 * 关麦的原因（诊断记录用）：leave 离开语音模式、hidden 切到后台、edit-in 输入元素拿到焦点、blur 窗口失去焦点、
 * returning 刚回来还在等（按下又抬手得太快）、failed 打开失败歇着、denied 被拒、playback 兜底 (a) 在播；
 * 下面两个不出自状态，由 app/ 那边定：stale 放掉失效的流、silent 整段静音后放掉这个流
 */
export type VoiceMicCloseReason = "leave" | "hidden" | "edit-in" | "blur" | "returning" | "failed" | "denied" | "playback" | "stale" | "silent";

/**
 * 麦克风为什么不该开着（挡着的第一条）；该开着就没有。voiceMicWanted 和关麦的原因都出自这里，加规则只改这一处。
 * 该开着：在语音模式里、页面在前台，并且正按着，或者没让路（焦点不在输入元素上、窗口有焦点、不在回来的那 0.5 秒里）、
 * 没歇着、没被拒过、没有语音在播（兜底 (a)）
 */
export function voiceMicCloseReason(state: VoiceMicState): VoiceMicCloseReason | undefined {
  if (!state.entered) return "leave";
  if (!state.visible) return "hidden";
  if (state.held) return undefined;
  if (state.editing) return "edit-in";
  if (!state.focused) return "blur";
  if (state.returning) return "returning";
  if (state.resting) return "failed";
  if (state.denied) return "denied";
  if (state.playing) return "playback";
  return undefined;
}

/** 麦克风现在该不该开着（规则见 voiceMicCloseReason） */
export function voiceMicWanted(state: VoiceMicState): boolean {
  return voiceMicCloseReason(state) === undefined;
}

/** 等回来的那一刻（到了送一次 tick）；没在等就没有 */
export function voiceMicReturnAt(state: VoiceMicState): number | undefined {
  return state.returning?.until;
}

/**
 * 这次开麦的原因（诊断记录用）：before 是喂 input 之前的状态，喂完之后麦克风该开着、却没有开着的流。
 * before 本来就该开着，那就不是这个输入让它开的，而是流失效了（stale）；不然看是哪个输入放行的
 */
export function voiceMicOpenReason(before: VoiceMicState, input: VoiceMicInput): VoiceMicOpenReason {
  if (voiceMicWanted(before)) return "stale";
  switch (input.kind) {
    case "enter":
      return "enter";
    case "visibility":
      return "visible";
    case "hold":
      return "press";
    case "tick":
      return before.returning?.reason ?? "stale";
    case "playback":
      return "playback-end";
    case "editing":
      return "edit-out";
    case "focus":
      return "focus";
    default:
      // 被拒、失败、要到了、离开都不会让本来不该开着的麦克风变成该开着
      return "stale";
  }
}

/**
 * 录完的一段整段最大振幅低于它（约 -60 dBFS）就当作没录到声音、不发（61 号票）。
 * 被系统静音的流是精确的 0（安卓 Chrome 被别的应用压下去时）；开着降噪、自动增益时，对着手机说话哪怕很小声，峰值也远高于它
 */
export const VOICE_SILENT_PEAK = 0.001;
/** 这一段里音量分析至少读到几次（约 0.1 秒一次）才判断；读得太少（音量分析没在跑）就判断不了，照常发 */
export const VOICE_SILENT_MIN_READS = 5;

/**
 * 录完的一段是不是静音：peak 是录着的时候音量分析读到的最大振幅（0–1），reads 是音量分析在跑时读了几次。
 * iOS 上音量分析可能一直挂着（读到的全是 0），那时 reads 是 0，判断不了，不算静音
 */
export function voiceTakeSilent(levels: { peak: number; reads: number }): boolean {
  return levels.reads >= VOICE_SILENT_MIN_READS && levels.peak < VOICE_SILENT_PEAK;
}

/** 拿到焦点的元素（Element 用到的部分） */
export interface FocusTarget {
  tagName: string;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
  isContentEditable?: boolean;
}

/** 不弹键盘的 input：按钮、勾选、滑块、文件、颜色，以及弹选择器的日期时间 */
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "color", "file", "hidden", "image", "reset", "submit", "date", "datetime-local", "month", "week", "time"]);

/**
 * 拿到焦点的这个元素是不是可输入的（会弹键盘、能用输入法的语音）：textarea、文字类的 input（没写 type 的、搜索、邮箱、
 * 数字……）、contenteditable；只读、禁用的不算。按钮（包括"按住 说话"）、勾选框、下拉框不算
 */
export function isTextEntry(el: FocusTarget | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag !== "TEXTAREA" && tag !== "INPUT") return false;
  if (el.readOnly || el.disabled) return false;
  return tag === "TEXTAREA" || !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase());
}
