// 拼附件 part 的小工具（守护进程和 Web 共用；不引用 TypeBox）；文件附件能不能预览、按什么预览。
import { extensionKindOf, fileExtensionOf, type FileRenderKind, PAGE_EXTENSIONS, renderKindOf } from "./file-render.ts";
import { t } from "./i18n/runtime.ts";
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
      return t("protocol.parts.image", { name: part.name });
    case "file":
      return t("protocol.parts.file", { name: part.name });
    case "voice":
      return t("protocol.parts.voice");
    default:
      return "";
  }
}

/**
 * 文本类附件能不能预览：能就给出怎么画（Markdown、纯文本、JSON、CSV / TSV 表格、代码），不能是 undefined。
 * 报告页的画法和内置浏览器打开文件是同一套（file-render.ts）：
 * - 浏览器会当页面跑的扩展名（PAGE_EXTENSIONS）不论 part 上写的什么类型都不按文本预览（媒体接口的安全边界不变；html、htm、svg
 *   在隔离的沙箱里预览，见 framePreviewOf，别的只能下载）；
 * - 扩展名在清单（EXTENSION_KIND）里的按扩展名定——附件的名字是用户的文件名，发消息时守护进程也是按扩展名补的类型
 *   （media/file-types.ts 的 mimeFromName）；
 * - 别的（没有扩展名、扩展名不认得）看 part 上的类型：text/plain、text/markdown 照旧能预览，text/csv、JSON 这些也认。
 * 以前发过的附件也一样，所以历史消息里的附件自动有预览入口。守护进程的内容接口和 Web 的附件卡片、报告页都按这一份判断
 */
export function textPreviewOf(file: { name: string; mime: string }): FileRenderKind | undefined {
  const ext = fileExtensionOf(file.name);
  if (PAGE_EXTENSIONS.has(ext)) return undefined;
  return extensionKindOf(ext) ?? renderKindOf(ext, file.mime);
}

/** 能在报告页用页面自带的播放器放的附件：音频（<audio controls>）、视频（<video controls playsinline>） */
export type MediaPreview = "audio" | "video";

const MEDIA_OF_EXTENSION: Readonly<Record<string, MediaPreview>> = {
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  wav: "audio",
  flac: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  weba: "audio",
  mp4: "video",
  m4v: "video",
  mov: "video",
  mkv: "video",
  webm: "video",
};

/**
 * 音频、视频附件能不能在报告页播放、按哪种放：有扩展名的看扩展名（.webm 既可能是视频也可能只有声音：part 上写的是 audio/*
 * 按音频，别的按视频）；没有扩展名的看 part 上的类型（audio/*、video/*）。avi、wmv 这类浏览器放不了的只能下载。
 * 只管网页上给不给播放器；媒体接口按不按音视频类型内联发出，由守护进程按内容认（认出是音视频容器才内联，part 上写的不算），
 * 内容认出来了再用这里分音频还是视频
 */
export function mediaPreviewOf(file: { name: string; mime: string }): MediaPreview | undefined {
  const ext = fileExtensionOf(file.name);
  const mime = (file.mime.split(";")[0] ?? "").trim().toLowerCase();
  if (ext === "webm") return mime.startsWith("audio/") ? "audio" : "video";
  if (ext) return Object.hasOwn(MEDIA_OF_EXTENSION, ext) ? MEDIA_OF_EXTENSION[ext] : undefined;
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return undefined;
}

/**
 * PDF 附件能不能在报告页预览：有扩展名的只看扩展名（.pdf），没有扩展名的看 part 上的类型（application/pdf）。
 * 报告页用 pdf.js 在二狗自己的页面里画（网页按需加载），PDF 的字节照旧从媒体接口取（作为附件下载的那个响应，不内联、
 * 响应头不变）；内容是不是真的 PDF 由 pdf.js 打开时认，打不开的报告页提示下载。守护进程的内容接口和 Web 的附件卡片、
 * 报告页都按这一份判断
 */
export function pdfPreviewOf(file: { name: string; mime: string }): boolean {
  const ext = fileExtensionOf(file.name);
  if (ext) return ext === "pdf";
  return (file.mime.split(";")[0] ?? "").trim().toLowerCase() === "application/pdf";
}

/** 在隔离的沙箱里预览的附件：HTML 在报告页的 <iframe sandbox> 里打开，SVG 用 <img> 显示 */
export type FramePreview = "html" | "svg";

const FRAME_OF_EXTENSION: Readonly<Record<string, FramePreview>> = { html: "html", htm: "html", svg: "svg" };
const FRAME_OF_MIME: Readonly<Record<string, FramePreview>> = { "text/html": "html", "image/svg+xml": "svg" };

/**
 * 文件附件能不能在沙箱里预览：有扩展名的只看扩展名（html、htm 是 HTML，svg 是 SVG；xhtml、svgz、xml 这些照旧只能下载），
 * 没有扩展名的看 part 上的类型（text/html、image/svg+xml）。超过 MEDIA_FRAME_MAX_BYTES 的不预览由调用方看大小。
 * 守护进程的 HTML、SVG 接口和 Web 的附件卡片、报告页都按这一份判断
 */
export function framePreviewOf(file: { name: string; mime: string }): FramePreview | undefined {
  const dot = file.name.lastIndexOf(".");
  if (dot >= 0 && dot < file.name.length - 1) return FRAME_OF_EXTENSION[file.name.slice(dot + 1).toLowerCase()];
  return FRAME_OF_MIME[(file.mime.split(";")[0] ?? "").trim().toLowerCase()];
}
