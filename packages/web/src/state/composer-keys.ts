// 输入框里的回车干什么（用户 2026-11-01 定）：电脑上回车发送，按住选好的那个键（Ctrl 或 Shift，设置里换）再按回车才换行。
// 选 Ctrl 时 Shift + 回车也算发送，选 Shift 时 Ctrl + 回车也算发送：选的那个键才换行，设置才有意义。⌘ 和 Ctrl 算一个键。
// 触屏设备不变：回车换行（屏幕键盘上换行没有组合键），外接键盘的 Ctrl + 回车发送。
// 斜杠命令的候选开着时，本来要发送的回车是选中候选。输入法组字时的回车不走到这里（Composer.tsx 先拦了）。

export const NEWLINE_KEYS = ["ctrl", "shift"] as const;
export type NewlineKey = (typeof NEWLINE_KEYS)[number];

/** 记住的值：只认 shift，没记过、不认识的都按默认（Ctrl） */
export function newlineKeyOf(raw: string | null): NewlineKey {
  return raw === "shift" ? "shift" : "ctrl";
}

export interface EnterPress {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

export interface EnterEnv {
  /** 触屏设备（pointer: coarse） */
  readonly touch: boolean;
  readonly newlineKey: NewlineKey;
  /** 斜杠命令的候选开着 */
  readonly picking: boolean;
}

/** default 是不管，交给浏览器 */
export type EnterAction = "send" | "newline" | "pick" | "default";

export function composerEnterAction(press: EnterPress, env: EnterEnv): EnterAction {
  if (press.altKey) return "default";
  const ctrl = press.ctrlKey || press.metaKey;
  if (env.touch) {
    if (ctrl) return "send";
    return env.picking && !press.shiftKey ? "pick" : "default";
  }
  if (env.newlineKey === "ctrl" ? ctrl : press.shiftKey) return "newline";
  return env.picking ? "pick" : "send";
}
