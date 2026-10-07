// 附件的内容（规格第 21 节附件）：给模型投影准备内容（这一版投影要什么就读什么：文本开头若干字节、PDF 抽出的文本），
// 以及"读取附件"工具读全文。投影本身是纯函数（conversation/model-projection.ts），读文件都在这里。
import fs from "node:fs";
import type { MessagePart } from "@ergou/protocol";
import { type AttachmentContent, projectorOf } from "../conversation/model-projection.ts";
import { decodeText, fileKind } from "./file-types.ts";
import type { MediaStore } from "./media-store.ts";

/** 第 version 版投影要的、一条消息里各文件附件的内容，键是媒体 id。媒体不在了的不给，投影只出文件名、类型和大小 */
export async function loadAttachmentContents(media: MediaStore, parts: readonly MessagePart[], version: number): Promise<Record<string, AttachmentContent>> {
  const projector = projectorOf(version);
  const out: Record<string, AttachmentContent> = {};
  for (const part of parts) {
    if (part.type !== "file" || out[part.mediaId]) continue;
    const info = media.info(part.mediaId);
    const needed = projector.contentNeeded(part);
    if (!info || !needed) continue;
    out[part.mediaId] =
      needed.kind === "text_head"
        ? { kind: "text", head: media.readHead(part.mediaId, needed.bytes), totalBytes: info.size }
        : { kind: "pdf", text: await extractPdfText(media.filePath(part.mediaId)) };
  }
  return out;
}

/** "读取附件"读到的全文：文本类是原文，PDF 是抽出来的文本；读不了的说明原因 */
export type AttachmentText = { ok: true; text: string } | { ok: false; reason: string };

export async function readAttachmentText(media: MediaStore, attachment: { mediaId: string; name: string; mime: string }): Promise<AttachmentText> {
  const { mediaId, name, mime } = attachment;
  if (!media.info(mediaId)) return { ok: false, reason: `附件「${name}」的文件不在媒体库里了` };
  switch (fileKind(name, mime)) {
    case "text": {
      const text = decodeText(fs.readFileSync(media.filePath(mediaId)));
      return text === undefined ? { ok: false, reason: `附件「${name}」的内容不是可读的文本` } : { ok: true, text };
    }
    case "pdf": {
      const text = await extractPdfText(media.filePath(mediaId));
      return text === undefined || text.trim() === "" ? { ok: false, reason: `附件「${name}」是 PDF，但抽不出文字（可能是扫描件）` } : { ok: true, text };
    }
    case "other":
      return { ok: false, reason: `附件「${name}」是 ${mime}，不是文本类，也不是 PDF，不能读取内容` };
  }
}

/** 抽出 PDF 里的文字（各页按顺序拼起来）；不是合法的 PDF 或抽不出时为 undefined */
export async function extractPdfText(file: string): Promise<string | undefined> {
  try {
    // 用到时才加载 pdf.js（两兆多），守护进程启动不背这个
    const { extractText, getDocumentProxy } = await import("unpdf");
    // verbosity 0：只报错误，不往守护进程的日志里打 pdf.js 的警告
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)), { verbosity: 0 });
    try {
      const { text } = await extractText(pdf, { mergePages: true });
      return text;
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch {
    return undefined;
  }
}
