// 聊天里的文件附件画成卡片：类型图标（方块里写类型，按类别上色）、标题、"预览""下载"两个按钮；一条消息里连着的几个附件
// 排成一横排，装不下换行（partRuns 把它们合成一组）。能不能预览只看 part 上的名字和类型（协议包的判断，守护进程的内容接口也按它），
// 所以以前发过的附件也自动有预览入口。点图标：能预览的去报告页（#/report/<媒体 id>），不能预览的直接下载，图标上标明"仅下载"。
// 能预览的：
// - 文本类（textPreviewOf）：Markdown、纯文本、JSON、CSV / TSV、代码和配置，画法和内置浏览器打开文件同一套（file-view.ts 的 fileBodyOf）；
// - HTML、SVG（framePreviewOf，1 MB 以内）：报告页里 HTML 在沙箱框里打开，SVG 用 <img> 显示；
// - 音频、视频（mediaPreviewOf）：报告页里用页面自带的播放器放，编码浏览器放不了的由播放器报错时提示下载（卡片上不事先判断）。
//   视频在聊天里不画卡片，像图片一样直接显示第一帧、点开大播放器（chat-video.ts）；第一帧取不到、解不了的才退回卡片。
// 报告页（pages/ReportPage.tsx）显示什么也在这里推：取到的内容怎么画（HTML、SVG 在框里看，音视频给播放器）、截断的提示、取不到时说什么。
import { isChatVideo } from "./chat-video.ts";
import { sizeLabel } from "./detail-content.ts";
import { FILE_RENDER_LABEL, type FileBody, fileBodyOf } from "./file-view.ts";
import {
  type FilePartValue,
  type FileRenderKind,
  type FramePreview,
  framePreviewOf,
  type HttpErrorCode,
  MEDIA_FRAME_MAX_BYTES,
  MEDIA_TEXT_MAX_BYTES,
  type MediaPreview,
  mediaPreviewOf,
  type MediaTextView,
  type MessagePart,
  t,
  textPreviewOf,
  tTable,
} from "./protocol.ts";

/** 附件的类别（图标按它上色）：文档、表格、图片、音视频、其它 */
export type AttachmentCategory = "doc" | "sheet" | "image" | "media" | "other";

export const ATTACHMENT_CATEGORY_LABEL: Readonly<Record<AttachmentCategory, string>> = tTable({
  doc: "state.attachments.category.doc",
  sheet: "state.attachments.category.sheet",
  image: "state.attachments.category.image",
  media: "state.attachments.category.media",
  other: "state.attachments.category.other",
});

/** 图标上不直接写扩展名的：Office 的新格式写老的三个字母，几种写法不同的同一类型写同一个 */
const LABEL_OF_EXTENSION: Readonly<Record<string, string>> = { pptx: "PPT", docx: "DOC", xlsx: "XLS", jpeg: "JPG", markdown: "MD", htm: "HTML" };

const DOC_EXTENSIONS = new Set(["md", "markdown", "txt", "text", "log", "pdf", "doc", "docx", "ppt", "pptx", "key", "odt", "odp", "rtf", "pages", "epub"]);
const SHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx", "ods", "numbers"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff", "svg", "ico"]);
const MEDIA_EXTENSIONS = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v", "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 类型图标上写的类型：扩展名大写（md → MD、pptx → PPT、jpeg → JPG）；没有扩展名、扩展名不是五个以内的字母数字的写 FILE */
export function attachmentTypeLabel(name: string): string {
  const ext = extensionOf(name);
  if (LABEL_OF_EXTENSION[ext]) return LABEL_OF_EXTENSION[ext];
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : "FILE";
}

/** 附件属于哪一类（图标的颜色）：先看扩展名，认不出的看类型 */
export function attachmentCategory(name: string, mime: string): AttachmentCategory {
  const ext = extensionOf(name);
  const type = mime.toLowerCase();
  if (SHEET_EXTENSIONS.has(ext) || type === "text/csv" || type === "text/tab-separated-values" || type.includes("spreadsheet")) return "sheet";
  if (IMAGE_EXTENSIONS.has(ext) || type.startsWith("image/")) return "image";
  if (MEDIA_EXTENSIONS.has(ext) || type.startsWith("audio/") || type.startsWith("video/")) return "media";
  // JSON、代码虽然也能预览，颜色照旧：文档色只给 Markdown、纯文本这类给人读的（part 上写成纯文本的配置文件照旧算文档）
  const text = textPreviewOf({ name, mime });
  const readable = text === "markdown" || text === "plain" || (text !== undefined && /^text\/(plain|markdown)\b/.test(type));
  if (DOC_EXTENSIONS.has(ext) || readable || type === "application/pdf") return "doc";
  return "other";
}

/** 能怎么预览：按哪种文本画（Markdown、纯文本、JSON、表格、代码），在框里看 HTML、SVG，或者用播放器放音频、视频 */
export type AttachmentPreview = FileRenderKind | FramePreview | MediaPreview;

/**
 * 一个文件附件能怎么预览：HTML、SVG 看扩展名，超过 MEDIA_FRAME_MAX_BYTES 的不预览（没法截一半看）；音频、视频看扩展名，
 * 多大都能放（播放器按需取一段段）；文本类按 textPreviewOf，超过 1 MB 的报告页只显示开头。不能预览是 undefined
 */
export function attachmentPreviewOf(part: Pick<FilePartValue, "name" | "mime" | "size">): AttachmentPreview | undefined {
  const frame = framePreviewOf(part);
  if (frame) return part.size <= MEDIA_FRAME_MAX_BYTES ? frame : undefined;
  return mediaPreviewOf(part) ?? textPreviewOf(part);
}

/** 卡片上的一个附件 */
export interface FileCard {
  readonly part: FilePartValue;
  /** 类型图标上写的类型（MD、PPT、FILE） */
  readonly label: string;
  readonly category: AttachmentCategory;
  /** 卡片上的标题：原名，太长的从中间省略（留住开头、结尾和扩展名） */
  readonly title: string;
  /** 一次发了多个同类文件时的序号（01-3：三个里的第一个）；只有一个的没有 */
  readonly seq: string | undefined;
  /** 能预览就是怎么看（按哪种文本画，在框里看 HTML、SVG，用播放器放音视频），不能预览是 undefined */
  readonly preview: AttachmentPreview | undefined;
  /** 点图标做什么：能预览的去报告页，不能预览的直接下载 */
  readonly iconAction: "preview" | "download";
  /** 图标的悬停文字（音视频写"播放"，不能预览的写明"仅下载"） */
  readonly iconHint: string;
  /** 卡片的悬停文字：全名、类型、大小 */
  readonly tooltip: string;
  /** 标题下面多写的一行（聊天里放不了的视频退回卡片时写"网页里放不了，下载看"，chat-video.ts）；平常没有 */
  readonly note?: string;
}

/** 卡片标题最多多宽（汉字算两个字母宽）：卡片两行写得下 */
const TITLE_MAX_WIDTH = 30;

/** 显示宽度：汉字这类全角的算 2，其余算 1 */
function widthOf(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
  return w;
}

/** 从末尾起取不超过 width 宽的一段 */
function tailOf(s: string, width: number): string {
  const chars = [...s];
  let w = 0;
  let i = chars.length;
  while (i > 0 && w + widthOf(chars[i - 1]!) <= width) w += widthOf(chars[--i]!);
  return chars.slice(i).join("");
}

/** 从开头起取不超过 width 宽的一段 */
function headOf(s: string, width: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    if (w + widthOf(ch) > width) break;
    w += widthOf(ch);
    out += ch;
  }
  return out;
}

/** 太长的文件名从中间省略：留住开头、结尾和扩展名（分段视频这类名字只差在结尾） */
function shortTitle(name: string): string {
  if (widthOf(name) <= TITLE_MAX_WIDTH) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  const room = TITLE_MAX_WIDTH - widthOf(ext) - 1;
  const tail = tailOf(stem, Math.floor(room / 3));
  return `${headOf(stem, room - widthOf(tail))}…${tail}${ext}`;
}

/** 一条消息里一组附件的卡片：同类（类型图标上写的一样）的有两个以上时按序号显示（01-3、02-3、03-3） */
export function fileCards(files: readonly FilePartValue[]): FileCard[] {
  const labels = files.map((f) => attachmentTypeLabel(f.name));
  const totals = new Map<string, number>();
  for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return files.map((part, i) => {
    const label = labels[i]!;
    const total = totals.get(label)!;
    const k = (seen.get(label) ?? 0) + 1;
    seen.set(label, k);
    const preview = attachmentPreviewOf(part);
    // HTML、SVG 太大了不预览：图标上说清楚为什么只能下载
    const tooLarge = !preview && framePreviewOf(part) !== undefined;
    return {
      part,
      label,
      category: attachmentCategory(part.name, part.mime),
      title: shortTitle(part.name),
      seq: total > 1 ? `${String(k).padStart(2, "0")}-${total}` : undefined,
      preview,
      iconAction: preview ? "preview" : "download",
      iconHint: preview
        ? preview === "audio" || preview === "video"
          ? t("state.attachments.hint.play", { name: part.name })
          : t("state.attachments.hint.preview", { name: part.name })
        : tooLarge
          ? t("state.attachments.hint.tooLarge", { type: label, limit: sizeLabel(MEDIA_FRAME_MAX_BYTES) })
          : t("state.attachments.hint.downloadOnly", { type: label }),
      tooltip: t("state.attachments.tooltip", { name: part.name, mime: part.mime, size: sizeLabel(part.size) }),
    };
  });
}

/**
 * 一条消息的各部分怎么排：连着的文件附件合成一组（画成一横排），别的各是各的；index 是在原来 parts 里的位置。
 * 视频附件像图片一样各自单独一块（聊天里直接显示第一帧，chat-video.ts 的 isChatVideo），不和别的附件挤在一排卡片里
 */
export type PartRun = { kind: "part"; part: MessagePart; index: number } | { kind: "files"; files: FilePartValue[]; index: number };

export function partRuns(parts: readonly MessagePart[]): PartRun[] {
  const runs: PartRun[] = [];
  parts.forEach((part, index) => {
    const last = runs.at(-1);
    if (part.type !== "file" || isChatVideo(part)) runs.push({ kind: "part", part, index });
    else if (last?.kind === "files" && last.index + last.files.length === index) last.files.push(part);
    else runs.push({ kind: "files", files: [part], index });
  });
  return runs;
}

// ───────────────────────── 报告页 ─────────────────────────

/** 取文本类附件的内容的结果（DaemonHttp.mediaText）：取不到时是错误码和原因（连不上守护进程是 network） */
export type MediaTextResult = { ok: true; view: MediaTextView } | { ok: false; code: HttpErrorCode | "network"; message: string };

/** 报告页显示什么 */
export type ReportPageView =
  | { kind: "loading" }
  /**
   * 文本类：facts 是类型（按 GBK 解的写明编码）、大小、什么时候发的；body 是怎么画（和内置浏览器同一套）；notice 是顶上的提示条
   * （截断了、表格太长只画了前面、JSON 认不出）；canRaw 时能"看原文"（raw 是原文）
   */
  | { kind: "ready"; name: string; facts: string; body: FileBody; canRaw: boolean; raw: string; notice: string | undefined }
  /** HTML、SVG：内容不经 JSON 给，在框里看——HTML 用 <iframe sandbox>，SVG 用 <img>；notice 说明沙箱拦着什么 */
  | { kind: "frame"; name: string; facts: string; frame: FramePreview; notice: string | undefined }
  /** 音频、视频：用页面自带的播放器放媒体接口的地址（能拖进度）；放不了时报告页提示下载 */
  | { kind: "media"; name: string; facts: string; media: MediaPreview }
  /** title、detail 说清楚怎么了、怎么办；note 是守护进程说的原因 */
  | { kind: "error"; title: string; detail: string; note: string };

/** 报告页"类型"那一栏：文本类和内置浏览器同一套说法（file-view.ts 的 FILE_RENDER_LABEL），HTML、SVG、音频、视频另说 */
const OTHER_LABEL: Readonly<Record<FramePreview | MediaPreview, string>> = tTable({
  html: "state.attachments.render.html",
  svg: "state.attachments.render.svg",
  audio: "state.attachments.render.audio",
  video: "state.attachments.render.video",
});

/** HTML 预览顶上的说明：页面在沙箱里，拦着什么、放着什么（按当前语言现取） */
export function htmlFrameNotice(): string {
  return t("state.attachments.htmlFrameNotice");
}

/** 取不到的几种情况怎么说（别的错误、连不上都算"取文件内容失败"）；按当前语言现取 */
const REPORT_ERRORS: Partial<Record<HttpErrorCode, () => { title: string; detail: string }>> = {
  not_found: () => ({ title: t("state.attachments.error.notFound.title"), detail: t("state.attachments.error.notFound.detail") }),
  unsupported_type: () => ({ title: t("state.attachments.error.unsupported.title"), detail: t("state.attachments.error.unsupported.detail") }),
  too_large: () => ({ title: t("state.attachments.error.tooLarge.title"), detail: t("state.attachments.error.tooLarge.detail", { limit: sizeLabel(MEDIA_FRAME_MAX_BYTES) }) }),
  undecodable: () => ({ title: t("state.attachments.error.undecodable.title"), detail: t("state.attachments.error.undecodable.detail") }),
};

/** 大报告分段画：每段大约多少个字（不到一段长的不分） */
export const REPORT_CHUNK_CHARS = 20_000;

/**
 * 把 Markdown 切成几段，报告页先画第一段，其余一段段接着画（1 MB 的 Markdown 一次解析、画完要一两秒，页面卡住）。
 * 够一段长了，在下一个"切开不改变怎么渲染"的空行后面切：不在代码块里、下一行顶格写（缩进的续行、缩进的代码前面不切）；
 * 表格中间没有空行，不会被切开。拼回去和原文一字不差。代价：引用式链接的定义、脚注跨了段就认不出（报告里很少见，
 * 而且只有超过一段长的才分）
 */
export function markdownChunks(text: string, size = REPORT_CHUNK_CHARS): string[] {
  if (text.length <= size) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  /** 这一段从第几行起、已经多少个字 */
  let start = 0;
  let length = 0;
  /** 在代码块里时，开头的那串 ``` 或 ~~~ */
  let fence: string | undefined;
  lines.forEach((line, i) => {
    length += line.length + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && fence === undefined) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    const next = lines[i + 1];
    if (length >= size && fence === undefined && line.trim() === "" && next !== undefined && /^\S/.test(next)) {
      chunks.push(`${lines.slice(start, i + 1).join("\n")}\n`);
      start = i + 1;
      length = 0;
    }
  });
  chunks.push(lines.slice(start).join("\n"));
  return chunks;
}

/** 发出的时间："10-13 21:30" */
function sentLabel(iso: string): string | undefined {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return undefined;
  const [, month, day, hour, minute] = m as unknown as [string, string, string, string, string];
  // 中文照原来写"10-13 21:30 发出"；英文"Sent 10/13 21:30"
  return t("state.attachments.sent", { month, day, hour, minute });
}

export function reportPageView(result: MediaTextResult | undefined): ReportPageView {
  if (!result) return { kind: "loading" };
  if (!result.ok) {
    const known = result.code === "network" ? undefined : REPORT_ERRORS[result.code]?.();
    return { kind: "error", ...(known ?? { title: t("state.attachments.error.failed.title"), detail: t("state.attachments.error.failed.detail") }), note: result.message };
  }
  const { view } = result;
  const sent = view.sentAt ? sentLabel(view.sentAt) : undefined;
  if (view.frame) {
    return {
      kind: "frame",
      name: view.name,
      facts: [OTHER_LABEL[view.frame], sizeLabel(view.bytes), sent].filter(Boolean).join(" · "),
      frame: view.frame,
      notice: view.frame === "html" ? htmlFrameNotice() : undefined,
    };
  }
  if (view.media) return { kind: "media", name: view.name, facts: [OTHER_LABEL[view.media], sizeLabel(view.bytes), sent].filter(Boolean).join(" · "), media: view.media };
  const kind = textPreviewOf(view) ?? "plain";
  const { body, notices, canRaw } = fileBodyOf(kind, view.text, view.truncated);
  if (view.truncated) notices.unshift(t("state.attachments.truncated", { size: sizeLabel(view.bytes), limit: sizeLabel(MEDIA_TEXT_MAX_BYTES) }));
  const encoding = view.encoding === "gb18030" ? t("state.attachments.encodingGbk") : undefined;
  return {
    kind: "ready",
    name: view.name,
    facts: [FILE_RENDER_LABEL[kind], encoding, sizeLabel(view.bytes), sent].filter(Boolean).join(" · "),
    body,
    canRaw,
    raw: view.text,
    notice: notices.length > 0 ? notices.join(t("state.fileView.noticeSep")) : undefined,
  };
}
