// agent 用的附件工具（宿主工具，在守护进程里执行）：
// - read_attachment（读取附件）：按附件引用读全文，文本类读原文，PDF 读抽出的文本；图片（79 号票）：模型看得了图时
//   把图作为图片交给它看，看不了时回一句清楚的话（图片的基本信息，图里的内容请用户用文字说）。只能读自己会话里的附件，
//   读别的会话的附件被拒并说明原因。按引用读、不按路径读，所以不落入"越出项目目录"；它只读、幂等，
//   不落入任何关注类别（07 号票接守卫时在工具注册表里这样登记）。
// - send_attachment（把文件作为附件发出）：把草稿区里的一个文件复制进媒体库（图片照样剥元数据），
//   作为 agent 的一条消息发进聊天。之后清理草稿区不影响聊天里的附件。草稿区外的文件发不了。
//   117 号票：任务的维护者、项目的维护者也有（工具包里"发附件"开着的，默认开；maintainerAttachmentTools），能发它工作目录里的文件
//   （任务的产出区、项目的工作目录），发进它自己的会话（任务整页、项目整页）；子 agent、评审没有（它们的结果交回维护者，
//   维护者决定发不发）。附件消息由拉起它的会话追加（HostToolOutput.attachments），带上会话此刻的归属。
//   tell_secretary 带附件（secretary/letters.ts）也经这里的 ingestFrom 复制进媒体库。
import fs from "node:fs";
import path from "node:path";
import { attachmentPartFrom, canSendAttachment, type ConversationId, type MessagePart, type PlanToolkit, Type, type UploadedMedia } from "@ergou/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { attachmentElsewhere, type ConversationAttachment, findConversationAttachment } from "../conversation/attachments-view.ts";
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

/** send_attachment 能从哪里发文件：秘书是草稿区，维护者是工作目录（117 号票） */
export interface AttachmentSource {
  /** 给模型看的说法："草稿区"、"工作目录" */
  label: string;
  /** 能发的目录：相对路径按第一个算，绝对路径要落在其中一个里面 */
  roots: readonly string[];
}

/** 秘书的草稿区（它的工作目录 tmp/scratch） */
export const scratchSource = (scratchDir: string): AttachmentSource => ({ label: "草稿区", roots: [scratchDir] });
/** 维护者的工作目录（任务的产出区 outputs/<任务>、项目的工作目录；117 号票） */
export const workDirSource = (cwd: string): AttachmentSource => ({ label: "工作目录", roots: [cwd] });

/**
 * 把能发的地方里的一个文件复制进媒体库（图片照样剥元数据）：成了给出入库的媒体和它在消息里的 part，不成给出原因（给模型看）。
 * 那个地方外面的（含 ..、符号链接和目录联接逃出去的）、不是文件、超过单个附件上限的都不成
 */
export async function ingestFrom(
  media: MediaStore,
  from: AttachmentSource,
  requested: string,
  name?: string,
): Promise<{ ok: true; stored: UploadedMedia; part: MessagePart } | { ok: false; reason: string }> {
  const file = from.roots.map((root) => resolveInside(root, requested, root === from.roots[0])).find((f) => f !== undefined);
  if (!file) return { ok: false, reason: `发不了「${requested}」：只能发${from.label}里的文件。` };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, reason: `${from.label}里没有「${requested}」。` };
  }
  if (!stat.isFile()) return { ok: false, reason: `「${requested}」不是文件。` };
  if (stat.size > media.maxUploadBytes) {
    return { ok: false, reason: `「${requested}」有 ${sizeLabel(stat.size)}，超过单个附件的上限 ${sizeLabel(media.maxUploadBytes)}。` };
  }
  const shown = sanitizeName(name?.trim() ? name : path.basename(file));
  const stored = await media.ingestFile(file, { name: shown, mime: mimeFromName(shown) ?? "application/octet-stream" });
  return { ok: true, stored, part: attachmentPartFrom(stored) };
}

const SECRETARY_DESCRIPTION = [
  "把草稿区里的一个文件作为附件发进聊天给用户（比如算好的表、生成的图或文档）。",
  "文件会复制进媒体库长期保留，之后清理草稿区不影响。path 是草稿区里的相对路径；只能发草稿区里的文件。",
].join("");

/** 维护者的那一份（117 号票）：什么时候用写清楚 */
const maintainerDescription = (maxBytes: number) =>
  [
    "把你工作目录里的一个文件作为附件发进你和用户的这个会话（任务页、项目页），用户在那里看到一张附件卡片，能点开预览（Markdown、纯文本、HTML、SVG）或下载。",
    "什么时候用：交付件、报告、截图、图表这类做好了要给用户看的东西，想让他直接点开看，而不是只在回复里写个路径。子 agent 做出来的东西你看过、觉得该给用户看再发；",
    "要秘书在主线里转告用户的，用 tell_secretary 的附件参数，不用在这里再发一遍。",
    `文件会复制进媒体库长期保留（图片会去掉拍摄地点这类元数据），之后改动、删掉工作目录里的文件不影响已经发出的。一次发一个，单个不超过 ${sizeLabel(maxBytes)}。`,
    "path 是工作目录里的相对路径（也可以是工作目录里的绝对路径），只能发工作目录里的文件；name 是给用户看的文件名，默认用文件本身的名字。",
  ].join("");

export function sendAttachmentTool(options: { media: MediaStore; from: AttachmentSource; description?: string }): HostTool {
  const { media, from } = options;
  return defineHostTool({
    name: SEND_ATTACHMENT_TOOL,
    title: "把文件作为附件发出",
    // 只读能发的地方里的文件、发进自己的聊天，没有对外效果，不落入任何关注类别；地方外的文件由工具自己拒绝（resolveInside），
    // 路径参数不交给守卫查（不然那里外面的路径会先出审批卡、批准了工具也照样拒绝）
    description: options.description ?? SECRETARY_DESCRIPTION,
    parameters: Type.Object(
      {
        path: Type.String({ description: `${from.label}里的文件路径（相对${from.label}）` }),
        name: Type.Optional(Type.String({ description: "给用户看的文件名，默认用文件本身的名字" })),
      },
      { additionalProperties: false },
    ),
    // 每调用一次多发一条附件消息
    readOnlyOrIdempotent: false,
    async run(args) {
      const got = await ingestFrom(media, from, args.path, args.name);
      if (!got.ok) return { text: got.reason, isError: true };
      const { stored } = got;
      // 附件消息由拉起这个 agent 的会话追加（带上会话此刻的归属）
      return { text: `已把「${stored.name}」（${sizeLabel(stored.size)}）作为附件发给用户，附件引用 ${stored.mediaId}。`, attachments: [got.part] };
    },
  });
}

/** 秘书的发附件：只能发草稿区里的文件 */
export function secretaryAttachmentTool(media: MediaStore, scratchDir: string): HostTool {
  return sendAttachmentTool({ media, from: scratchSource(scratchDir) });
}

/** 维护者的发附件（117 号票）：工具包里"发附件"开着、给了媒体库才有；能发它工作目录里的文件 */
export function maintainerAttachmentTools(media: MediaStore | undefined, toolkit: Pick<PlanToolkit, "sendAttachment">, cwd: string): HostTool[] {
  return media && canSendAttachment(toolkit) ? [sendAttachmentTool({ media, from: workDirSource(cwd), description: maintainerDescription(media.maxUploadBytes) })] : [];
}

/**
 * 在 root 里解析一个路径（顺着符号链接、目录联接、8.3 短名找真实位置；还不存在的按最近的已有上级目录算）；
 * 落在 root 外面、或就是 root 本身时为 undefined。真实路径和"在不在里面"的判断和守卫用的是同一份
 * （util/real-path.ts 的 realPathOf，守卫的 isWithin：Windows 语义、不分大小写）。relative 为假时只认绝对路径（几个 root 里
 * 相对路径只按第一个算）
 */
function resolveInside(root: string, requested: string, relative = true): string | undefined {
  if (!requested.trim() || (!relative && !path.isAbsolute(requested))) return undefined;
  const realRoot = realPathOf(root);
  if (realRoot === undefined) return undefined;
  const real = realPathOf(path.resolve(realRoot, requested));
  if (real === undefined || comparable(real) === comparable(realRoot) || !isWithin(real, realRoot)) return undefined;
  return real;
}
