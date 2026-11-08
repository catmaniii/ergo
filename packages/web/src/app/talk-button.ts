// 二狗的悬浮按钮背后那一套不分在哪的东西（"浏览"里网页上的悬浮按钮、地图右下角的二狗按钮共用，444 从浏览插件挪到这里）：
// - 按住说话的录音（pageVoiceOver：接到"按住说话"的同一套后端，App 里是原生录音器，浏览器里是 VoiceRecorder）；
// - 几个时长（录着时多久取一次音量、最长录多久、回话多久收起、按下了多久没开始录算说完）；
// - 气泡里的话：说到助理的那几句按名字切开（namedText，名字画成名字标签），在办的那一句怎么写（BUSY_KEY），回话太长了没有（replyTooLong）。
// 不碰 DOM 和浏览器的全局变量（录音后端由参数给），测试在 Node 里跑。
import { t, tParts } from "../state/index.ts";
import { isRecordingCancelled, micErrorOf, type VoiceCaptureBackend } from "./voice-recorder.ts";

/** 在办的那一句走到哪了：hearing 在认说了什么、thinking 秘书在办、queued 秘书正忙，排在后面 */
export type BusyNote = "hearing" | "thinking" | "queued" | "finding";

/** 在办的那一句气泡里怎么写（秘书正忙时说明排在后面，不让用户以为没反应；说到助理的写 {name}） */
export const BUSY_KEY: Readonly<Record<BusyNote, string>> = {
  hearing: "app.pageBubble.busy.hearing",
  thinking: "app.pageBubble.busy.thinking",
  queued: "app.pageBubble.busy.queued",
  // "在地图上看"（447）：在查这个地方（不经对话）
  finding: "app.pageBubble.busy.finding",
};

/** 成了的回话过多久收起（毫秒）；没成的不收 */
export const REPLY_HIDE_MS = 6000;
/** 录着的时候多久取一次音量（毫秒）；留最近几个（气泡里的波形用得上的） */
export const LEVEL_MS = 80;
export const LEVELS_KEPT = 40;
/** 最长录多久（毫秒）：到了自己发，和语音消息一样 60 秒 */
export const LISTEN_MAX_MS = 60_000;
/**
 * 按下了多久还没开始录、也没开打字框，就算说完（毫秒）：按够 350 毫秒开始录、短按松手开打字框，
 * 手势被系统收走时什么都不报；留足余量
 */
export const PRESS_CAPTURE_MS = 2_000;
/** 按住多久算长按（开始录）：和页面桥一样 0.35 秒 */
export const LONG_PRESS_MS = 350;

/** 回话多长算"太长"：超过这么多字，或者超过这么多行（气泡 300 来宽，一行二十来个字） */
export const REPLY_LONG_CHARS = 120;
export const REPLY_LONG_LINES = 6;

/** 回话太长了没有 */
export function replyTooLong(text: string): boolean {
  return text.length > REPLY_LONG_CHARS || text.split("\n").length > REPLY_LONG_LINES;
}

/** 一句话里的一段：字，或者助理的名字（画成名字标签） */
export type NamedPart = string | { name: string };

/** 一句可能说到助理的话：纯文字（名字换好）；说到了的另给按名字切开的几段（画成名字标签） */
export interface NamedText {
  text: string;
  parts?: NamedPart[];
}

/** 名字在 tParts 里的记号 */
const NAME_MARK = Symbol("name");

/** 按当前语言取一句，{name} 是助理的名字：别的参数照常换上，名字那一段单独切出来 */
export function namedText(key: string, name: string, params: Readonly<Record<string, string | number>> = {}): NamedText {
  const text = t(key, { ...params, name });
  const parts: NamedPart[] = [];
  let plain = "";
  let named = false;
  for (const part of tParts(key, { ...params, name: NAME_MARK })) {
    if (part !== NAME_MARK) {
      plain += String(part);
      continue;
    }
    if (plain) parts.push(plain);
    plain = "";
    parts.push({ name });
    named = true;
  }
  if (plain) parts.push(plain);
  return named ? { text, parts } : { text };
}

/** 录的一段：音频的 base64 和类型；整段是静音、没录下来是 undefined（reason 是给人看的话） */
export type PageTake = { ok: true; base64: string; mime: string } | { ok: false; reason: string };

/** 按住说话的录音 */
export interface PageVoice {
  /** 现在的音量（0–1；不在录是 0） */
  level(): number;
  /** 备好录音器（不录）；userAction：按下引起的（被拒过权限时 App 再问一次）。备不好不抛错，start 时再说 */
  prepare(userAction: boolean): void;
  /** 开始录（等备好）；录不了抛错（message 是给人看的话） */
  start(): Promise<void>;
  stop(): Promise<PageTake>;
  cancel(): void;
  /** 放掉录音器 */
  release(): void;
}

/** Blob 的 base64（分段转，长录音也不爆调用栈） */
async function base64OfBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * 录音接到"按住说话"的同一套后端上（App 里是原生录音器 NativeVoiceRecorder，浏览器里是 VoiceRecorder；create 第一次用到时才建）：
 * prepare 备好（不录）、start 等备好了开始、stop 交出这一段（整段是静音的不发）
 */
export function pageVoiceOver(create: () => VoiceCaptureBackend, now: () => number): PageVoice {
  let backend: VoiceCaptureBackend | undefined;
  let opening: Promise<void> | undefined;
  let failure: string | undefined;
  const get = (): VoiceCaptureBackend => (backend ??= create());
  const prepare = (userAction: boolean) => {
    const b = get();
    if (b.warm) return;
    if (opening && !userAction) return;
    failure = undefined;
    const o = b.open(userAction ? "press" : "enter", { userAction }).catch((err: unknown) => {
      if (!isRecordingCancelled(err)) failure = micErrorOf(err).text;
    });
    opening = o;
    void o.finally(() => {
      if (opening === o) opening = undefined;
    });
  };
  return {
    prepare,
    async start() {
      const b = get();
      const pressedAt = now();
      const prewarmed = b.warm;
      if (!b.warm) {
        if (!opening) prepare(true);
        await opening;
      }
      if (!b.warm) throw new Error(failure ?? t("app.pageCommands.recorderNotReady"));
      b.begin({ pressedAt, prewarmed });
    },
    async stop() {
      const recording = await get().stop();
      if (recording.silent) return { ok: false, reason: t("app.pageCommands.silent") };
      return { ok: true, base64: await base64OfBlob(recording.blob), mime: recording.mime };
    },
    level: () => backend?.level() ?? 0,
    cancel: () => backend?.cancel(),
    release() {
      opening = undefined;
      backend?.close("leave");
    },
  };
}
