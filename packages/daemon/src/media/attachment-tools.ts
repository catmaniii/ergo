// agent 用的附件工具（宿主工具，在守护进程里执行）：
// - read_attachment（读取附件）：按附件引用读全文，文本类读原文，PDF 读抽出的文本。只能读自己会话里的附件，
//   读别的会话的附件被拒并说明原因。按引用读、不按路径读，所以不落入"越出项目目录"；它只读、幂等，
//   不落入任何关注类别（07 号票接守卫时在工具注册表里这样登记）。
// - send_attachment（把文件作为附件发出）：把草稿区里的一个文件复制进媒体库（图片照样剥元数据），
//   作为 agent 的一条消息发进聊天。之后清理草稿区不影响聊天里的附件。草稿区外的文件发不了。
import fs from "node:fs";
import path from "node:path";
import { attachmentPartFrom, type ConversationId, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { attachmentElsewhere, findConversationAttachment } from "../conversation/attachments-view.ts";
import { appendMessage } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import { readAttachmentText } from "./attachment-content.ts";
import { mimeFromName, sizeLabel } from "./file-types.ts";
import { sanitizeName, type MediaStore } from "./media-store.ts";
import { READ_ATTACHMENT_TOOL, SEND_ATTACHMENT_TOOL } from "./tool-names.ts";

/** read_attachment 一次最多交回这么多个字符；更长的分几次读（offset） */
export const READ_ATTACHMENT_MAX_CHARS = 64 * 1024;

export interface AttachmentToolsOptions {
  store: EventStore;
  media: MediaStore;
  /** 这个 agent 自己的会话：只能读这里面的附件 */
  conversation: ConversationId;
}

const ReadAttachmentParams = Type.Object(
  {
    ref: Type.String({ description: "附件引用（媒体的 sha256，64 位十六进制；也可以是本会话里唯一的前缀）" }),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "从第几个字符起读（从 0 数），默认 0" })),
  },
  { additionalProperties: false },
);

const SendAttachmentParams = Type.Object(
  {
    path: Type.String({ description: "草稿区里的文件路径（相对草稿区）" }),
    name: Type.Optional(Type.String({ description: "给用户看的文件名，默认用文件本身的名字" })),
  },
  { additionalProperties: false },
);

export function readAttachmentTool(options: AttachmentToolsOptions): HostTool {
  const { store, media, conversation } = options;
  return defineHostTool({
    name: READ_ATTACHMENT_TOOL,
    description: [
      "读取本会话里一个附件的全文：文本类文件（含 markdown、代码、CSV）读原文，PDF 读抽出来的文本。",
      "消息里的长附件只内联了开头一段；要看后面的内容就用这个工具。ref 是附件引用（消息里「附件引用」后面那串十六进制）。",
      `一次最多交回 ${READ_ATTACHMENT_MAX_CHARS} 个字符，更长的用 offset（从第几个字符起，从 0 数）接着读。只能读这个会话里的附件。`,
    ].join(""),
    parameters: ReadAttachmentParams,
    async run({ ref, offset = 0 }) {
      const attachment = findConversationAttachment(store.reader, conversation, ref);
      if (!attachment) {
        if (attachmentElsewhere(store.reader, conversation, ref)) {
          return { text: `不能读附件 ${ref}：它不在这个会话里。只能读本会话里的附件。`, isError: true };
        }
        return { text: `这个会话里没有附件 ${ref}（附件引用是消息里「附件引用」后面那串十六进制）。`, isError: true };
      }
      if (attachment.kind === "image") {
        return { text: `附件「${attachment.name}」是图片（${attachment.mime}），不能当文本读。`, isError: true };
      }
      const read = await readAttachmentText(media, attachment);
      if (!read.ok) return { text: read.reason, isError: true };
      const total = read.text.length;
      const end = Math.min(total, offset + READ_ATTACHMENT_MAX_CHARS);
      const what = `附件「${attachment.name}」（${attachment.mime}，${sizeLabel(attachment.size ?? 0)}）`;
      if (offset === 0 && end === total) return { text: `${what}全文：\n${read.text}` };
      if (offset >= total) return { text: `${what}共 ${total} 个字符，offset ${offset} 已经超出末尾。` };
      const more = end < total ? `\n（还没完：offset 传 ${end} 接着读）` : "\n（已经读到末尾）";
      return { text: `${what}第 ${offset}–${end} 个字符（共 ${total} 个字符）：\n${read.text.slice(offset, end)}${more}` };
    },
  });
}

export function sendAttachmentTool(options: AttachmentToolsOptions & { scratchDir: string }): HostTool {
  const { store, media, conversation, scratchDir } = options;
  return defineHostTool({
    name: SEND_ATTACHMENT_TOOL,
    description: [
      "把草稿区里的一个文件作为附件发进聊天给用户（比如算好的表、生成的图或文档）。",
      "文件会复制进媒体库长期保留，之后清理草稿区不影响。path 是草稿区里的相对路径；只能发草稿区里的文件。",
    ].join(""),
    parameters: SendAttachmentParams,
    async run(args) {
      const requested = args.path;
      const file = resolveInside(scratchDir, requested);
      if (!file) return { text: `发不了「${requested}」：只能发草稿区里的文件。`, isError: true };
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        return { text: `草稿区里没有「${requested}」。`, isError: true };
      }
      if (!stat.isFile()) return { text: `「${requested}」不是文件。`, isError: true };
      if (stat.size > media.maxUploadBytes) {
        return { text: `「${requested}」有 ${sizeLabel(stat.size)}，超过单个附件的上限 ${sizeLabel(media.maxUploadBytes)}。`, isError: true };
      }
      const name = sanitizeName(args.name?.trim() ? args.name : path.basename(file));
      const stored = await media.ingestFile(file, { name, mime: mimeFromName(name) ?? "application/octet-stream" });
      appendMessage(store, { conversation, speaker: "agent", parts: [attachmentPartFrom(stored)] });
      return { text: `已把「${stored.name}」（${sizeLabel(stored.size)}）作为附件发给用户，附件引用 ${stored.mediaId}。` };
    },
  });
}

/**
 * 在 root 里解析一个路径（顺着符号链接、目录联接找真实位置）；落在 root 外面时为 undefined。
 * 和守卫判断"越出项目目录"的路径逻辑重复了：09 号票不动守卫，留给 07 号票合并成一份。
 */
function resolveInside(root: string, requested: string): string | undefined {
  if (!requested.trim()) return undefined;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return undefined;
  }
  const candidate = path.resolve(realRoot, requested);
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    // 不存在：按字面位置判断，交给后面的"没有这个文件"
    real = candidate;
  }
  const rel = path.relative(process.platform === "win32" ? realRoot.toLowerCase() : realRoot, process.platform === "win32" ? real.toLowerCase() : real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return real;
}
