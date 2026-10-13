// 聊天里的文件附件画成卡片（113 号票）：类型图标（方块里写类型，按类别上色）、标题、"预览""下载"两个按钮；一条消息里连着的几个附件
// 排成一横排，装不下换行（partRuns 把它们合成一组）。能不能预览只看 part 上的类型（协议包的 textPreviewOf：Markdown、纯文本），
// 所以以前发过的附件也自动有预览入口。点图标：能预览的去报告页（#/report/<媒体 id>），不能预览的直接下载，图标上标明"仅下载"。
// 117 号票：HTML、SVG（协议包的 framePreviewOf，1 MB 以内）也能预览——报告页里 HTML 在沙箱框里打开，SVG 用 <img> 显示。
// 报告页（pages/ReportPage.tsx）显示什么也在这里推：取到的内容按 Markdown 还是纯文本画（HTML、SVG 在框里看）、截断的提示、取不到时说什么。
import { sizeLabel } from "./detail-content.ts";
import {
  type FilePartValue,
  type FramePreview,
  framePreviewOf,
  type HttpErrorCode,
  MEDIA_FRAME_MAX_BYTES,
  MEDIA_TEXT_MAX_BYTES,
  type MediaTextView,
  type MessagePart,
  textPreviewOf,
  type TextPreviewMime,
} from "./protocol.ts";

/** 附件的类别（图标按它上色）：文档、表格、图片、音视频、其它 */
export type AttachmentCategory = "doc" | "sheet" | "image" | "media" | "other";

export const ATTACHMENT_CATEGORY_LABEL: Readonly<Record<AttachmentCategory, string>> = { doc: "文档", sheet: "表格", image: "图片", media: "音视频", other: "其它" };

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
  if (DOC_EXTENSIONS.has(ext) || textPreviewOf({ name, mime }) || type === "application/pdf") return "doc";
  return "other";
}

/** 能怎么预览：按 Markdown、纯文本画（113 号票），或者在框里看 HTML、SVG（117 号票） */
export type AttachmentPreview = TextPreviewMime | FramePreview;

/** 一个文件附件能怎么预览：文本类看类型；HTML、SVG 看扩展名，超过 MEDIA_FRAME_MAX_BYTES 的不预览（没法截一半看）；不能预览是 undefined */
export function attachmentPreviewOf(part: Pick<FilePartValue, "name" | "mime" | "size">): AttachmentPreview | undefined {
  const text = textPreviewOf(part);
  if (text) return text;
  const frame = framePreviewOf(part);
  return frame && part.size <= MEDIA_FRAME_MAX_BYTES ? frame : undefined;
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
  /** 能预览就是怎么看（按哪种文本画，或者在框里看 HTML、SVG），不能预览是 undefined */
  readonly preview: AttachmentPreview | undefined;
  /** 点图标做什么：能预览的去报告页，不能预览的直接下载 */
  readonly iconAction: "preview" | "download";
  /** 图标的悬停文字（不能预览的写明"仅下载"） */
  readonly iconHint: string;
  /** 卡片的悬停文字：全名、类型、大小 */
  readonly tooltip: string;
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
        ? `点开预览「${part.name}」`
        : tooLarge
          ? `仅下载：${label} 文件超过 ${sizeLabel(MEDIA_FRAME_MAX_BYTES)}，不在这里预览，点了直接下载`
          : `仅下载：${label} 文件不能在这里预览，点了直接下载`,
      tooltip: `${part.name}（${part.mime}，${sizeLabel(part.size)}）`,
    };
  });
}

/** 一条消息的各部分怎么排：连着的文件附件合成一组（画成一横排），别的各是各的；index 是在原来 parts 里的位置 */
export type PartRun = { kind: "part"; part: MessagePart; index: number } | { kind: "files"; files: FilePartValue[]; index: number };

export function partRuns(parts: readonly MessagePart[]): PartRun[] {
  const runs: PartRun[] = [];
  parts.forEach((part, index) => {
    const last = runs.at(-1);
    if (part.type !== "file") runs.push({ kind: "part", part, index });
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
  /** facts：类型、大小、什么时候发的；notice：顶上的提示条（截断了） */
  | { kind: "ready"; name: string; facts: string; render: "markdown" | "plain"; text: string; notice: string | undefined }
  /** HTML、SVG（117 号票）：内容不经 JSON 给，在框里看——HTML 用 <iframe sandbox>，SVG 用 <img>；notice 说明沙箱拦着什么 */
  | { kind: "frame"; name: string; facts: string; frame: FramePreview; notice: string | undefined }
  /** title、detail 说清楚怎么了、怎么办；note 是守护进程说的原因 */
  | { kind: "error"; title: string; detail: string; note: string };

const RENDER_LABEL: Readonly<Record<AttachmentPreview, string>> = { "text/markdown": "Markdown", "text/plain": "纯文本", html: "HTML 页面", svg: "SVG 图" };

/** HTML 预览顶上的说明（117 号票）：页面在沙箱里，拦着什么、放着什么 */
export const HTML_FRAME_NOTICE = "在隔离的沙箱里打开：页面照常运行、能从外网取数据，但拿不到二狗的数据、连不上二狗；页面里的链接在新窗口打开";

/** 取不到的几种情况怎么说（别的错误、连不上都算"取文件内容失败"） */
const REPORT_ERRORS: Partial<Record<HttpErrorCode, { title: string; detail: string }>> = {
  not_found: { title: "这个文件不在了", detail: "可能已经彻底删除了，或者链接写错了。" },
  unsupported_type: { title: "这种文件不能预览", detail: "这里能看 Markdown、纯文本、HTML 和 SVG；别的文件请回到聊天里，点附件卡片上的「下载」。" },
  too_large: { title: "文件太大，不在这里预览", detail: `超过 ${sizeLabel(MEDIA_FRAME_MAX_BYTES)} 的 HTML、SVG 只能下载：请回到聊天里点附件卡片上的「下载」。` },
  undecodable: { title: "预览不了这个文件", detail: "它不是 UTF-8 编码的文本。请回到聊天里点附件卡片上的「下载」，用本机的程序打开。" },
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
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]} 发出` : undefined;
}

export function reportPageView(result: MediaTextResult | undefined): ReportPageView {
  if (!result) return { kind: "loading" };
  if (!result.ok) {
    const known = result.code === "network" ? undefined : REPORT_ERRORS[result.code];
    return { kind: "error", ...(known ?? { title: "取文件内容失败", detail: "检查一下连接，稍后刷新这一页再试。" }), note: result.message };
  }
  const { view } = result;
  const sent = view.sentAt ? sentLabel(view.sentAt) : undefined;
  if (view.frame) {
    return {
      kind: "frame",
      name: view.name,
      facts: [RENDER_LABEL[view.frame], sizeLabel(view.bytes), sent].filter(Boolean).join(" · "),
      frame: view.frame,
      notice: view.frame === "html" ? HTML_FRAME_NOTICE : undefined,
    };
  }
  const render = textPreviewOf(view) ?? "text/plain";
  return {
    kind: "ready",
    name: view.name,
    facts: [RENDER_LABEL[render], sizeLabel(view.bytes), sent].filter(Boolean).join(" · "),
    render: render === "text/markdown" ? "markdown" : "plain",
    text: view.text,
    notice: view.truncated ? `文件有 ${sizeLabel(view.bytes)}，这里只显示前 ${sizeLabel(MEDIA_TEXT_MAX_BYTES)}，完整版点「下载」` : undefined,
  };
}
