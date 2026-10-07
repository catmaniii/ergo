// 发给模型之前的投影，第 1 版。冻结：这里用到的常量和小函数都归第 1 版所有，不从会变的模块取；
// 要改规则就加第 2 版（新文件），在 model-projection.ts 里登记，这个文件原样留着。
// 期望的输出是 test/model-projection.test.ts 里手写的字面量。
//
// 第 1 版：
// - 第一行是这条消息的本地时间标记，格式固定为"[YYYY-MM-DD 周X HH:mm ±HH:MM]"（发送时间按配置的时区换算，
//   比如"[2026-10-08 周四 09:30 +08:00]"）。秘书要理解"明早 9 点""下周一"，得知道当时的日期和星期；
//   标记只加在每条新消息上、不改系统提示，所以不影响提示词前缀缓存。之后各个 part 按下面的规则，彼此空一行；
// - 文本：原样；推理：不进模型输入；
// - 卡片引用 → 一行摘要（卡片的纯文本降级版本，由调用方给出）；
// - 图片 → 模型支持视觉时作为图片输入，正文里是"[图片 n：文件名]"；不支持时只有"[图片：文件名]"；
// - 文本类文件（含 markdown、代码、CSV）→ 内联前 32 KB，超出的部分提示用"读取附件"工具读；
//   先按 UTF-8 解，不是合法的 UTF-8 再按 GB18030 解；
// - PDF → 先抽取文本（由调用方抽好），再按文本类处理；抽不出文字的说明一句；
// - 其他类型 → 只给文件名、类型和大小；
// - 语音 → 转写（第一阶段只预留）；TTS 音频、视频 → 占位；工具调用、工单分隔 → 一行。
import type { MessagePart } from "@ergou/protocol";
import { READ_ATTACHMENT_TOOL } from "../media/tool-names.ts";
import type { AttachmentContent, ContentNeeded, ModelInput, ProjectionInput, Projector } from "./model-projection.ts";

/** 文本类附件内联的字节数上限：32 KB */
const INLINE_BYTES = 32 * 1024;
const INLINE_LABEL = `${INLINE_BYTES / 1024} KB`;

/** 按扩展名就认定是文本类的 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt", "text", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "xml", "html", "htm", "css",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "cc", "hpp", "cs",
  "php", "lua", "r", "scala", "sh", "bash", "ps1", "bat", "cmd", "sql", "ini", "cfg", "conf", "properties", "env", "vue", "svelte", "tex",
  "rst", "org", "srt", "vtt", "ets", "arkts",
]);

/** 类型是这些的也算文本类（加上 text/* 和 +json、+xml） */
const TEXT_MIMES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-typescript",
  "application/x-sh",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/x-sql",
  "application/graphql",
  "application/x-httpd-php",
  "application/x-python",
  "application/x-tex",
  "application/x-ndjson",
]);

const WEEKDAYS: Readonly<Record<string, string>> = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };

type FilePart = Extract<MessagePart, { type: "file" }>;

export const projectorV1: Projector = {
  project,
  contentNeeded(part: FilePart): ContentNeeded {
    switch (classify(part.name, part.mime)) {
      case "text":
        return { kind: "text_head", bytes: INLINE_BYTES };
      case "pdf":
        return { kind: "pdf_text" };
      case "other":
        return undefined;
    }
  },
};

function project(input: ProjectionInput): ModelInput {
  const blocks: string[] = [];
  const images: ModelInput["images"] = [];
  for (const part of input.parts) {
    switch (part.type) {
      case "text":
        blocks.push(part.text);
        break;
      case "reasoning":
        break;
      case "image":
        if (input.vision) {
          images.push({ mediaId: part.mediaId, mime: part.mime });
          blocks.push(`[图片 ${images.length}：${part.name}]`);
        } else {
          blocks.push(`[图片：${part.name}]`);
        }
        break;
      case "file":
        blocks.push(fileBlock(part, input.attachments[part.mediaId]));
        break;
      case "voice":
        blocks.push(`[语音转写：${part.transcript}]`);
        break;
      case "tts_audio":
        blocks.push("[语音回复]");
        break;
      case "video":
        blocks.push("[视频]");
        break;
      case "tool_call":
        blocks.push(`[工具调用 ${part.tool}：${oneLine(part.argsSummary)}]`);
        break;
      case "card_ref": {
        const summary = input.cards[part.cardId];
        blocks.push(summary === undefined ? `[卡片 ${part.cardId}]` : `[卡片：${oneLine(summary)}]`);
        break;
      }
      case "work_order_divider":
        blocks.push(part.workOrderId ? `[工单 ${part.workOrderId}：${oneLine(part.title)}]` : `[对话段：${oneLine(part.title)}]`);
        break;
    }
  }
  return { version: 1, text: `${timeMarker(input.sentAt, input.timeZone)}\n${blocks.join("\n\n")}`, images };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function classify(name: string, mime: string): "text" | "pdf" | "other" {
  const ext = extensionOf(name);
  const base = mime.toLowerCase();
  if (ext === "pdf" || base === "application/pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (base.startsWith("text/") || TEXT_MIMES.has(base) || base.endsWith("+json") || base.endsWith("+xml")) return "text";
  return "other";
}

/** 开头的原始字节解成文本：先按 UTF-8，再按 GB18030；末尾被截断的半个字符不输出；都不行或含 NUL 时为 undefined */
function decodeHead(bytes: Uint8Array): string | undefined {
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: true });
      return text.includes("\u0000") ? undefined : text;
    } catch {
      // 换下一种编码
    }
  }
  return undefined;
}

/** 字节数的说法：512 B、40.0 KB、1.2 MB */
function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 卡片摘要、参数摘要压成一行，最多 200 字 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** 文本的前 limit 个 UTF-8 字节（不切断字符） */
function utf8Head(text: string, limit: number): { head: string; totalBytes: number } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return { head: text, totalBytes: bytes.length };
  return { head: new TextDecoder().decode(bytes.subarray(0, limit), { stream: true }), totalBytes: bytes.length };
}

function fileBlock(part: FilePart, content: AttachmentContent | undefined): string {
  const header = `[附件：${part.name}（${part.mime}，${sizeLabel(part.size)}，附件引用 ${part.mediaId}）]`;
  if (classify(part.name, part.mime) === "other" || !content) return header;
  if (content.kind === "pdf") {
    if (content.text === undefined || content.text.trim() === "") return `${header}\n（这个 PDF 抽不出文字，可能是扫描件）`;
    const { head, totalBytes } = utf8Head(content.text, INLINE_BYTES);
    return inlined(header, "PDF 抽取的文本", head, totalBytes, part.mediaId);
  }
  const text = decodeHead(content.head.subarray(0, INLINE_BYTES));
  if (text === undefined) return `${header}\n（内容不是可读的文本）`;
  return inlined(header, "附件内容", text, content.totalBytes, part.mediaId);
}

function inlined(header: string, what: string, head: string, totalBytes: number, mediaId: string): string {
  if (totalBytes <= INLINE_BYTES) return `${header}\n----- ${what}开始 -----\n${head}\n----- ${what}结束 -----`;
  return [
    header,
    `----- ${what}开始（只有前 ${INLINE_LABEL}）-----`,
    head,
    `----- ${what}到此截断：全文共 ${sizeLabel(totalBytes)}，要读后面的内容，用 ${READ_ATTACHMENT_TOOL} 工具（附件引用 ${mediaId}）-----`,
  ].join("\n");
}

/** 本地时间标记"[YYYY-MM-DD 周X HH:mm ±HH:MM]"：把发送时间换算到 timeZone */
function timeMarker(sentAt: string, timeZone: string): string {
  const at = new Date(sentAt);
  if (Number.isNaN(at.getTime())) throw new Error(`消息的时间不对：${sentAt}`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  // longOffset 是"GMT+08:00"，UTC 本身是"GMT"
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : String(parts.timeZoneName).replace("GMT", "");
  return `[${parts.year}-${parts.month}-${parts.day} ${WEEKDAYS[parts.weekday!] ?? parts.weekday} ${parts.hour}:${parts.minute} ${offset}]`;
}
