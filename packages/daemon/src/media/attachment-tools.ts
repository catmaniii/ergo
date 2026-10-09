// agent 用的附件工具（宿主工具，在守护进程里执行）：
// - read_attachment（读取附件）：按附件引用读全文，文本类读原文，PDF 读抽出的文本；图片（79 号票）：模型看得了图时
//   把图作为图片交给它看，看不了时回一句清楚的话（图片的基本信息，图里的内容请用户用文字说）。只能读自己会话里的附件，
//   读别的会话的附件被拒并说明原因。按引用读、不按路径读，所以不落入"越出项目目录"；它只读、幂等，
//   不落入任何关注类别（07 号票接守卫时在工具注册表里这样登记）。
// - send_attachment（把文件作为附件发出）：把草稿区里的一个文件复制进媒体库（图片照样剥元数据），
//   作为 agent 的一条消息发进聊天。之后清理草稿区不影响聊天里的附件。草稿区外的文件发不了。
import fs from "node:fs";
import path from "node:path";
import { attachmentPartFrom, type ConversationId, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { attachmentElsewhere, type ConversationAttachment, findConversationAttachment } from "../conversation/attachments-view.ts";
import { appendMessage } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import { comparable, isWithin } from "../guard/index.ts";
import { realPathOf } from "../util/real-path.ts";
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
    title: "读取附件",
    // 按附件引用读、不按路径读，只读、幂等，不落入任何关注类别
    readOnlyOrIdempotent: true,
    nature: "look",
    description: [
      "读取本会话里一个附件的全文：文本类文件（含 markdown、代码、CSV）读原文，PDF 读抽出来的文本；",
      "图片：你看得了图时把这张图交给你看，看不了时只给图片的基本信息（名字、类型、尺寸、大小）。",
      "消息里的长附件只内联了开头一段；要看后面的内容就用这个工具。ref 是附件引用（消息里「附件引用」后面那串十六进制）。",
      `一次最多交回 ${READ_ATTACHMENT_MAX_CHARS} 个字符，更长的用 offset（从第几个字符起，从 0 数）接着读。只能读这个会话里的附件。`,
    ].join(""),
    parameters: ReadAttachmentParams,
    async run({ ref, offset = 0 }, call) {
      const attachment = findConversationAttachment(store.reader, conversation, ref);
      if (!attachment) {
        if (attachmentElsewhere(store.reader, conversation, ref)) {
          return { text: `不能读附件 ${ref}：它不在这个会话里。只能读本会话里的附件。`, isError: true };
        }
        return { text: `这个会话里没有附件 ${ref}（附件引用是消息里「附件引用」后面那串十六进制）。`, isError: true };
      }
      if (attachment.kind === "image") return readImage(media, attachment, call.vision === true);
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

/**
 * 读取附件读到一张图片（79 号票）：模型看得了图时把图（入库版本）作为图片交给它看；看不了时回一句清楚的话：
 * 图片的基本信息，看不了图里的内容，要用到就请用户用文字说（不让 agent 去猜）
 */
function readImage(media: MediaStore, attachment: ConversationAttachment, vision: boolean): HostToolOutput {
  const info = media.info(attachment.mediaId);
  if (!info) return { text: `附件「${attachment.name}」的文件不在媒体库里了`, isError: true };
  const mime = info.image?.mime ?? attachment.mime;
  const width = info.image?.width;
  const height = info.image?.height;
  const what = `附件「${attachment.name}」是图片（${mime}${width !== undefined && height !== undefined ? `，${width}×${height}` : ""}，${sizeLabel(info.size)}）`;
  if (!vision) return { text: `${what}。当前的模型看不了图片，读不出图里的内容；要用到图里的内容，请用户用文字说一下。` };
  return { text: `${what}，见下面的图。`, images: [{ mime, data: fs.readFileSync(media.filePath(attachment.mediaId)).toString("base64") }] };
}

export function sendAttachmentTool(options: AttachmentToolsOptions & { scratchDir: string }): HostTool {
  const { store, media, conversation, scratchDir } = options;
  return defineHostTool({
    name: SEND_ATTACHMENT_TOOL,
    title: "把文件作为附件发出",
    // 只读草稿区里的文件、发进自己的聊天，没有对外效果，不落入任何关注类别；草稿区外的文件由工具自己拒绝（resolveInside）
    description: [
      "把草稿区里的一个文件作为附件发进聊天给用户（比如算好的表、生成的图或文档）。",
      "文件会复制进媒体库长期保留，之后清理草稿区不影响。path 是草稿区里的相对路径；只能发草稿区里的文件。",
    ].join(""),
    parameters: SendAttachmentParams,
    // 每调用一次多发一条附件消息
    readOnlyOrIdempotent: false,
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
 * 在 root 里解析一个路径（顺着符号链接、目录联接、8.3 短名找真实位置；还不存在的按最近的已有上级目录算）；
 * 落在 root 外面、或就是 root 本身时为 undefined。真实路径和"在不在里面"的判断和守卫用的是同一份
 * （util/real-path.ts 的 realPathOf，守卫的 isWithin：Windows 语义、不分大小写）。
 */
function resolveInside(root: string, requested: string): string | undefined {
  if (!requested.trim()) return undefined;
  const realRoot = realPathOf(root);
  if (realRoot === undefined) return undefined;
  const real = realPathOf(path.resolve(realRoot, requested));
  if (real === undefined || comparable(real) === comparable(realRoot) || !isWithin(real, realRoot)) return undefined;
  return real;
}
