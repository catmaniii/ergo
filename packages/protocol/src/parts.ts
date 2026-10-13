// 拼附件 part 的小工具（守护进程和 Web 共用；不引用 TypeBox）；文件附件能不能预览（113 号票）。
import type { MessagePart } from "./schema.ts";

export type ImagePartValue = Extract<MessagePart, { type: "image" }>;
export type FilePartValue = Extract<MessagePart, { type: "file" }>;

/** 图片 part：宽高有就带上，没有就不写这两个字段 */
export function imagePartFrom(image: { mediaId: string; name: string; mime: string; width?: number | undefined; height?: number | undefined }): ImagePartValue {
  return {
    type: "image",
    mediaId: image.mediaId,
    name: image.name,
    mime: image.mime,
    ...(image.width === undefined ? {} : { width: image.width }),
    ...(image.height === undefined ? {} : { height: image.height }),
  };
}

/** 入库后的媒体（收尾响应 UploadedMedia 的形状）→ 消息里的 part：服务端认出是图片的发图片 part，其余发文件 part */
export function attachmentPartFrom(media: {
  mediaId: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  width?: number | undefined;
  height?: number | undefined;
}): ImagePartValue | FilePartValue {
  if (media.kind === "image") return imagePartFrom(media);
  return { type: "file", mediaId: media.mediaId, name: media.name, mime: media.mime, size: media.size };
}

/**
 * 引用一条消息时每个 part 的说法（给人看的地方用，比如系统说明里引用用户的消息）：文字原样，图片、文件写文件名，
 * 其余不出现。发给模型的投影有自己冻结在版本里的写法，不用这个。
 */
export function partLabel(part: MessagePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return `[图片：${part.name}]`;
    case "file":
      return `[附件：${part.name}]`;
    case "voice":
      return "[语音]";
    default:
      return "";
  }
}

/**
 * 能预览的文本类附件（113 号票）：在报告页渲染着看，不用下载。本版只做 Markdown 和纯文本（csv、json、代码、PDF 列入规划）。
 */
export const TEXT_PREVIEW_MIMES = ["text/markdown", "text/plain"] as const;
export type TextPreviewMime = (typeof TEXT_PREVIEW_MIMES)[number];

/** 浏览器会当页面跑的扩展名：part 上不论写的什么类型都不预览，只能下载（媒体接口的安全边界不变） */
const ACTIVE_CONTENT_EXTENSIONS = new Set(["html", "htm", "xhtml", "svg", "svgz", "xml"]);

/**
 * 文件附件能不能预览：能就给出按哪种渲染（Markdown 还是纯文本），不能是 undefined。只看 part 上的类型——发消息时守护进程
 * 已经按扩展名补好（media/file-types.ts 的 mimeFromName），以前发过的附件也一样，所以历史消息里的附件自动有预览入口。
 * 守护进程的内容接口和 Web 的附件卡片都按这一份判断
 */
export function textPreviewOf(file: { name: string; mime: string }): TextPreviewMime | undefined {
  const dot = file.name.lastIndexOf(".");
  if (dot >= 0 && ACTIVE_CONTENT_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase())) return undefined;
  const mime = (file.mime.split(";")[0] ?? "").trim().toLowerCase();
  return TEXT_PREVIEW_MIMES.find((m) => m === mime);
}
