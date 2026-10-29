// 输入框上方等着发的附件和排着的语音（用户 2026-10-10 改：附件一律不自动发，等下一条消息一起带走），
// state/composer-outbox.ts 的纯函数：谁带走谁、什么时候能发、发出去是哪些 part、后说的不越过先说的。
// 上传、引用的卡片、真的发出去在 ui/conversation/Composer.tsx，靠用户评审和截图。
import { describe, expect, test } from "vitest";
import {
  type ComposerUpload,
  type MessagePart,
  type QueuedVoice,
  queuedVoiceWait,
  queueVoice,
  takeReadyVoices,
  waitingAttachments,
  waitingState,
} from "../../src/state/index.ts";

type State = "uploading" | "waiting" | "verifying" | "done" | "failed";

const image = (name: string, asMaterial = false): MessagePart => ({ type: "image", mediaId: name.padEnd(64, "0"), name, mime: "image/png", ...(asMaterial ? { asMaterial: true } : {}) });
const voicePart = (n: number): MessagePart => ({ type: "voice", mediaId: String(n).padEnd(64, "0"), mime: "audio/webm", durationMs: 3000, waveform: [] });

/** 一个附件的上传：传好了（done）的带着 part */
function attachment(key: string, state: State = "done", part: MessagePart = image(`${key}.png`)): ComposerUpload {
  return { key, what: { kind: "attachment" }, part: state === "done" ? part : undefined, progress: { state } };
}
/** 一段语音的上传 */
function voice(key: string, state: State = "done", n = 1): ComposerUpload {
  return { key, what: { kind: "voice" }, part: state === "done" ? voicePart(n) : undefined, progress: { state } };
}

/** 依次说完几段语音（每段说完时带走当时等着的附件：前一段带走了的，后一段就没有了） */
function said(uploads: readonly ComposerUpload[], ...voiceKeys: string[]): QueuedVoice[] {
  let queue: QueuedVoice[] = [];
  for (const key of voiceKeys) queue = queueVoice(uploads, queue, key);
  return queue;
}

describe("等着的附件：两种模式都一样，选了不发，等下一条消息", () => {
  test("没被语音带走的附件都在等着，按选的先后；能不能直接发看它们传没传好", () => {
    const uploads = [attachment("a"), attachment("b", "uploading")];
    expect(waitingAttachments(uploads, []).map((u) => u.key)).toEqual(["a", "b"]);
    expect(waitingState(waitingAttachments(uploads, []))).toBe("uploading");
    expect(waitingState([attachment("a"), attachment("c", "verifying")])).toBe("uploading");
    expect(waitingState([attachment("a"), attachment("c", "failed")])).toBe("failed");
    expect(waitingState([attachment("a")])).toBe("ready");
    expect(waitingState([])).toBe("none");
  });

  test("说完一段语音：带走现在等着的附件；之后选的附件等下一条", () => {
    const uploads = [attachment("a"), attachment("b", "uploading"), voice("v1", "uploading")];
    const queue = queueVoice(uploads.slice(0, 2), [], "v1");
    expect(queue).toEqual([{ voice: "v1", attachments: ["a", "b"] }]);
    const later = [...uploads, attachment("c")];
    expect(waitingAttachments(later, queue).map((u) => u.key)).toEqual(["c"]);
  });
});

describe("排着的语音什么时候发", () => {
  test("语音和它带走的附件都传好了：一条消息，先附件后语音（附件的 part 原样，作为材料投喂的标记还在）", () => {
    const fed = image("报告.png", true);
    const uploads = [attachment("a", "done", fed), attachment("b"), voice("v1")];
    const { messages, queue } = takeReadyVoices(uploads, said(uploads, "v1"));
    expect(messages).toEqual([{ parts: [fed, image("b.png"), voicePart(1)], keys: ["a", "b", "v1"] }]);
    expect(queue).toEqual([]);
  });

  test("说完时附件还在传：语音等着，附件传好了再一起发；语音自己没传好也等着", () => {
    const uploading = [attachment("a", "uploading"), voice("v1")];
    const queue = said(uploading, "v1");
    expect(takeReadyVoices(uploading, queue)).toEqual({ messages: [], queue });
    expect(queuedVoiceWait(uploading, queue, "v1")).toBe("attachments");

    const voiceUploading = [attachment("a"), voice("v1", "uploading")];
    expect(takeReadyVoices(voiceUploading, queue).messages).toEqual([]);

    const done = [attachment("a"), voice("v1")];
    expect(takeReadyVoices(done, queue).messages.map((m) => m.keys)).toEqual([["a", "v1"]]);
  });

  test("带走的附件传失败了：语音不丢、一直等着；重试传好了接着发，删掉了就不带它", () => {
    const failed = [attachment("a", "failed"), attachment("b"), voice("v1")];
    const queue = said(failed, "v1");
    expect(takeReadyVoices(failed, queue)).toEqual({ messages: [], queue });
    expect(queuedVoiceWait(failed, queue, "v1")).toBe("attachment_failed");

    // 重试：同一个 key 重新传，传好了就发
    const retried = [attachment("a"), attachment("b"), voice("v1")];
    expect(takeReadyVoices(retried, queue).messages.map((m) => m.keys)).toEqual([["a", "b", "v1"]]);

    // 删掉：不再带它，剩下的照发
    const removed = [attachment("b"), voice("v1")];
    expect(takeReadyVoices(removed, queue)).toEqual({ messages: [{ parts: [image("b.png"), voicePart(1)], keys: ["b", "v1"] }], queue: [] });
  });

  test("放弃一段语音（删掉它的上传）：这一条撤掉，它带走的附件留回去等下一条", () => {
    const uploads = [attachment("a", "uploading"), voice("v1")];
    const queue = said(uploads, "v1");
    expect(waitingAttachments(uploads, queue)).toEqual([]);
    const abandoned = [attachment("a", "uploading")];
    expect(takeReadyVoices(abandoned, queue)).toEqual({ messages: [], queue: [] });
    expect(waitingAttachments(abandoned, takeReadyVoices(abandoned, queue).queue).map((u) => u.key)).toEqual(["a"]);
  });

  test("后说的不越过先说的：前一段还在等附件，后一段传好了也排着；前一段发了，后一段跟着发", () => {
    const uploads = [attachment("a", "uploading"), voice("v1", "done", 1), voice("v2", "done", 2)];
    const queue = said(uploads, "v1", "v2");
    expect(queue).toEqual([
      { voice: "v1", attachments: ["a"] },
      { voice: "v2", attachments: [] },
    ]);
    expect(takeReadyVoices(uploads, queue).messages).toEqual([]);
    expect(queuedVoiceWait(uploads, queue, "v2")).toBe("earlier");

    const done = [attachment("a"), voice("v1", "done", 1), voice("v2", "done", 2)];
    expect(takeReadyVoices(done, queue).messages).toEqual([
      { parts: [image("a.png"), voicePart(1)], keys: ["a", "v1"] },
      { parts: [voicePart(2)], keys: ["v2"] },
    ]);
  });

  test("没带附件的语音：传好就发（和以前一样）", () => {
    const uploads = [voice("v1")];
    const queue = said(uploads, "v1");
    expect(queuedVoiceWait(uploads, queue, "v1")).toBeUndefined();
    expect(takeReadyVoices(uploads, queue).messages).toEqual([{ parts: [voicePart(1)], keys: ["v1"] }]);
  });
});
