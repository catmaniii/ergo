// 输入栏上方等着发的附件和排着的语音（用户 2026-10-10 改：附件一律不自动发，等下一条消息一起带走）。
// - 选的附件（文字、语音模式都一样）先放在输入栏上方等着：显示进度和缩略图，可以删掉；
// - 下一条消息把等着的附件一起带走：文字模式下点发送时打的字，语音模式下说完的那段语音；
//   只发附件、不说话的，点附件下面的"直接发送"（Composer.tsx）；
// - 说完时语音还没传好、或者它带走的附件还没传好：这段语音排进队里，都传好了再作为一条消息发出去
//   （part 的顺序是先附件后语音，和文字模式的"先附件后文字"一样；引用的卡片由输入框放在最前面）；
//   附件传失败了就一直等着（重试传好了接着发），删掉了就不带它；语音放弃了（删掉它的上传）这一条撤掉，它带走的附件留回去等下一条；
// - 排着的语音按说完的先后发，后说的不越过先说的。
// 纯函数：只管"谁带走谁、什么时候能发、发出去是哪些 part"。上传、引用的卡片、真的发出去在 ui/conversation/Composer.tsx。
import type { MessagePart } from "./protocol.ts";

/** 输入栏上方的一个上传（附件或一段录好的语音）：排发送只看这几样 */
export interface ComposerUpload {
  readonly key: string;
  readonly what: { readonly kind: "attachment" | "voice" };
  /** 传好了：它在消息里的 part；还没传好的（上传中、等网络、校验中、失败）没有 */
  readonly part: MessagePart | undefined;
  /** 上传的进度（app/uploader.ts 的 UploadProgress）：这里只看是不是传失败了 */
  readonly progress: { readonly state: string };
}

/** 说完、排着等发的一段语音：它的上传，和说完那一刻等着的附件（被它带走了） */
export interface QueuedVoice {
  readonly voice: string;
  readonly attachments: readonly string[];
}

/** 等着下一条消息的附件：还没被排着的语音带走的，按选的先后 */
export function waitingAttachments<U extends ComposerUpload>(uploads: readonly U[], queue: readonly QueuedVoice[]): U[] {
  const taken = new Set(queue.flatMap((q) => q.attachments));
  return uploads.filter((u) => u.what.kind === "attachment" && !taken.has(u.key));
}

/** 等着的附件能不能现在发：没有附件、都传好了、还有在传的、有传失败的（重试或删掉它才能发） */
export function waitingState(waiting: readonly ComposerUpload[]): "none" | "ready" | "uploading" | "failed" {
  if (waiting.length === 0) return "none";
  if (waiting.some((u) => u.progress.state === "failed")) return "failed";
  return waiting.every((u) => u.part !== undefined) ? "ready" : "uploading";
}

/** 说完一段语音：排到队尾，带走现在等着的附件 */
export function queueVoice(uploads: readonly ComposerUpload[], queue: readonly QueuedVoice[], voiceKey: string): QueuedVoice[] {
  return [...queue, { voice: voiceKey, attachments: waitingAttachments(uploads, queue).map((u) => u.key) }];
}

/**
 * 排着的这段语音在等什么（它自己传好了才问这个）：它带走的附件有传失败的（等重试或删掉）、还在传、
 * 前面说的还没发出去。不在队里的、什么都不等的没有
 */
export function queuedVoiceWait(uploads: readonly ComposerUpload[], queue: readonly QueuedVoice[], voiceKey: string): "attachment_failed" | "attachments" | "earlier" | undefined {
  const live = pruneQueue(uploads, queue);
  const at = live.findIndex((q) => q.voice === voiceKey);
  if (at < 0) return undefined;
  const byKey = new Map(uploads.map((u) => [u.key, u]));
  const taken = live[at]!.attachments.map((key) => byKey.get(key)!);
  if (taken.some((u) => u.progress.state === "failed")) return "attachment_failed";
  if (taken.some((u) => u.part === undefined)) return "attachments";
  return at > 0 ? "earlier" : undefined;
}

/** 队里去掉放弃了的语音（它带走的附件随之留回去等着），每条去掉已经删掉的附件 */
function pruneQueue(uploads: readonly ComposerUpload[], queue: readonly QueuedVoice[]): QueuedVoice[] {
  const keys = new Set(uploads.map((u) => u.key));
  return queue.filter((q) => keys.has(q.voice)).map((q) => ({ voice: q.voice, attachments: q.attachments.filter((key) => keys.has(key)) }));
}

/** 能发出去的一条：消息的 part（先附件后语音），和它用掉的上传（发出去之后从输入栏上方拿掉） */
export interface ReadyVoiceMessage {
  readonly parts: MessagePart[];
  readonly keys: string[];
}

/**
 * 从队首起，语音和它带走的（还在的）附件都传好了的，各是一条消息；剩下的接着排（放弃了的语音、删掉的附件顺带清掉）。
 * 队首没好就停：后说的不越过先说的
 */
export function takeReadyVoices(uploads: readonly ComposerUpload[], queue: readonly QueuedVoice[]): { messages: ReadyVoiceMessage[]; queue: QueuedVoice[] } {
  const byKey = new Map(uploads.map((u) => [u.key, u]));
  const rest = pruneQueue(uploads, queue);
  const messages: ReadyVoiceMessage[] = [];
  while (rest.length > 0) {
    const head = rest[0]!;
    const voice = byKey.get(head.voice)!.part;
    const attachments = head.attachments.map((key) => byKey.get(key)!.part);
    if (voice === undefined || attachments.some((p) => p === undefined)) break;
    messages.push({ parts: [...(attachments as MessagePart[]), voice], keys: [...head.attachments, head.voice] });
    rest.shift();
  }
  return { messages, queue: rest };
}
