// 设置里的"关于二狗"和 Debug 工具集（124 号票）要从守护进程取的几样：
// - 守护进程是哪一版、什么时候起来的、它此刻的时间（daemon_info，WebSocket 上的查询方法，不带幂等键、没有副作用）：
//   关于页显示版本和已运行多久；Debug 工具集"测一次延迟"量的就是它的往返，"完整链路"的测试提醒按它的时钟算到点的时刻
//   （手机和电脑的钟差几秒时，"5 秒后"也是守护进程那边的 5 秒）；
// - 语音组的两个调试接口（HTTP，路径在 http.ts）：录一段送识别（POST /api/debug/recognize）、合成念一句
//   （POST /api/debug/speak）。都直接用守护进程里的识别进程、合成服务和当前参考音色，不经任何会话，不进秘书的上下文；
//   识别不了、合成不了不算接口出错（回 200 和原因），Debug 页照原样显示。
import { type Static, Type } from "typebox";

/** daemon_info 不带参数 */
export const DaemonInfoParams = Type.Object({});
export type DaemonInfoParams = Static<typeof DaemonInfoParams>;

/** 守护进程是哪一版（packages/daemon 的 package.json）、什么时候起来的、它此刻的时间（协议时间，带时区偏移） */
export const DaemonInfo = Type.Object({
  version: Type.String(),
  startedAt: Type.String(),
  now: Type.String(),
});
export type DaemonInfo = Static<typeof DaemonInfo>;

/** 送识别的一段录音最大多少字节（Debug 工具集录 3 秒：浏览器的 webm/opus 几十 KB，App 的 16 kHz WAV 约 96 KB） */
export const DEBUG_AUDIO_MAX_BYTES = 2 * 1024 * 1024;
/** 合成念的一句最多多少字 */
export const DEBUG_SPEAK_TEXT_MAX = 200;

/** POST /api/debug/recognize：一段录音（base64）和它的类型（浏览器录的 audio/webm…，App 录的 audio/wav） */
export const DebugRecognizeBody = Type.Object({
  audioBase64: Type.String({ minLength: 1, maxLength: Math.ceil((DEBUG_AUDIO_MAX_BYTES * 4) / 3) + 4 }),
  mime: Type.String({ minLength: 1, maxLength: 100 }),
});
export type DebugRecognizeBody = Static<typeof DebugRecognizeBody>;

/**
 * 识别的结果：识别出的文字、守护进程这边花了多久（毫秒）、用的模型和设备；识别不了的说原因。
 * 180 号票：文字是剔掉模型自带串词之后的，剔了几个字在 strippedChars（没剔没有；文字是空的就是整条只有串词，已丢弃）
 */
export const DebugRecognizeResult = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    text: Type.String(),
    ms: Type.Integer({ minimum: 0 }),
    model: Type.String(),
    device: Type.String(),
    language: Type.Optional(Type.String()),
    strippedChars: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  Type.Object({ ok: Type.Literal(false), reason: Type.String(), ms: Type.Integer({ minimum: 0 }) }),
]);
export type DebugRecognizeResult = Static<typeof DebugRecognizeResult>;

/** POST /api/debug/speak：要念的一句（用当前的参考音色） */
export const DebugSpeakBody = Type.Object({
  text: Type.String({ minLength: 1, maxLength: DEBUG_SPEAK_TEXT_MAX }),
});
export type DebugSpeakBody = Static<typeof DebugSpeakBody>;

/** 合成的结果：WAV（base64）、守护进程这边花了多久（毫秒）、用的模型、参考音色的名字；合成不了的说原因 */
export const DebugSpeakResult = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    audioBase64: Type.String(),
    mime: Type.String(),
    ms: Type.Integer({ minimum: 0 }),
    model: Type.String(),
    voiceName: Type.String(),
  }),
  Type.Object({ ok: Type.Literal(false), reason: Type.String(), ms: Type.Integer({ minimum: 0 }) }),
]);
export type DebugSpeakResult = Static<typeof DebugSpeakResult>;
