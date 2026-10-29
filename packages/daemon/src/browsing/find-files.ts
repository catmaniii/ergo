// @i18n-ignore-file model：找到的文件在哪、子文件夹概况都写进 find_files 的结果（给秘书看）
// 替网页的上传框找文件（134 号票）：find_files 工具（149 号票起是秘书在浏览侧边栏、悬浮按钮那一轮用）在这两处找——
// - 素材：用户发过的附件、交付的产出（素材的附件切段带媒体引用），按关键词（素材的关键词检索加语义检索）找，时间是发来的时间；
// - 授权的文件夹（138 号票起叫这个名字，秘书在聊天里、在"浏览"里共用一份）：按文件夹名和文件名里有没有关键词（"杭州"多半在文件夹名里）、时间（照片按 EXIF 的拍摄时间，
//   没有的按修改时间）、种类（图片、视频、文档）找。按地点找先靠文件夹名、文件名，读 GPS 反查城市以后再做。
// 走文件夹有上限（每次最多看 MAX_ENTRIES 个条目、MAX_DEPTH 层），隐藏的和系统的文件夹不进（isSkippedFolder，设置里选文件夹的框同一条规则）；拍摄时间按路径、大小、修改时间记着，
// 同一个文件下次不再读。
// 145 号票：走的同时数一遍子文件夹概况——每个授权的文件夹下，第一层的各个子文件夹里有几个这次种类的文件（含更深的，不看关键词和时间），
// 附在结果后面（folderOverviewText）：结果按时间倒序只列几十个，最新的截图会占满，秘书据此知道有"头像"这样的文件夹，按文件夹名再找一次。
import fs from "node:fs";
import path from "node:path";
import { type Material, type Materials } from "../materials/index.ts";
import type { MediaStore } from "../media/media-store.ts";
import { readCaptureTime } from "./exif.ts";
import { isSkippedFolder } from "../folders/folder-browser.ts";

export const FILE_KINDS = ["image", "video", "document", "any"] as const;
export type FileKindFilter = (typeof FILE_KINDS)[number];

/** 找什么：关键词（都要出现）、时间范围（本地日期，含两头）、种类、最多几个 */
export interface FileQuery {
  keywords: readonly string[];
  from?: string;
  to?: string;
  kind: FileKindFilter;
  limit: number;
}

/** 找到的一个文件 */
export interface FoundFile {
  /** 素材里的：媒体库里的文件；文件夹里的：本机路径 */
  path: string;
  name: string;
  mime: string;
  size: number;
  image: boolean;
  /** "YYYY-MM-DD HH:mm"（本地时间） */
  when: string;
  /** 时间是什么：拍摄（EXIF）、修改（文件的修改时间）、发来（素材的时间） */
  whenKind: "taken" | "modified" | "sent";
  /** 在哪：文件夹里的相对位置，或"素材" */
  where: string;
  source: "folder" | "material";
}

const EXT_MIME: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  "3gp": "video/3gpp",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  zip: "application/zip",
};

/** 按扩展名认类型；认不得是 application/octet-stream */
export function mimeOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && EXT_MIME[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

function kindOf(mime: string): Exclude<FileKindFilter, "any"> | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/octet-stream" || mime === "application/zip") return "other";
  return "document";
}

/** 页面上能直接显示缩略图的图片（面板上画） */
export function isPreviewableImage(mime: string): boolean {
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/gif" || mime === "image/webp";
}

/** 时间按时区写成 "YYYY-MM-DD HH:mm" */
export function localDateTime(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function inRange(when: string, query: FileQuery): boolean {
  const day = when.slice(0, 10);
  return (query.from === undefined || day >= query.from) && (query.to === undefined || day <= query.to);
}

function matchesKind(mime: string, kind: FileKindFilter): boolean {
  return kind === "any" || kindOf(mime) === kind;
}

/** 关键词都出现在 text 里（不分大小写） */
function hasAll(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.every((k) => lower.includes(k.toLowerCase()));
}

/** 走文件夹最多看多少个条目、多深 */
const MAX_ENTRIES = 30_000;
const MAX_DEPTH = 10;
/** 拍摄时间的缓存：按路径记着大小、修改时间和读出来的（没有也记） */
export type CaptureTimeCache = Map<string, { size: number; mtimeMs: number; taken: string | undefined }>;

function captureTimeOf(file: string, stat: fs.Stats, cache: CaptureTimeCache): string | undefined {
  const known = cache.get(file);
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.taken;
  const taken = readCaptureTime(file);
  cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, taken });
  return taken;
}

/** 一个授权的文件夹的子文件夹概况（145 号票）：第一层各子文件夹里有几个这次种类的文件（含更深的），按数量从多到少；name 为空串的是直接放在文件夹里的 */
export interface FolderOverview {
  root: string;
  counts: ReadonlyArray<{ name: string; count: number }>;
}

/** 在授权的文件夹里找；同时数出子文件夹概况（不看关键词和时间，只看种类） */
export async function searchFolders(
  folders: readonly string[],
  query: FileQuery,
  options: { timeZone: string; cache: CaptureTimeCache },
): Promise<{ files: FoundFile[]; truncated: boolean; overview: FolderOverview[] }> {
  const found: FoundFile[] = [];
  const overview: FolderOverview[] = [];
  let seen = 0;
  let truncated = false;
  for (const root of folders) {
    /** 第一层子文件夹名（直接放着的是空串）→ 这次种类的文件数 */
    const counts = new Map<string, number>();
    let rootReadable = false;
    const queue: Array<{ dir: string; depth: number; group: string }> = [{ dir: root, depth: 0, group: "" }];
    while (queue.length > 0) {
      const { dir, depth, group } = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (depth === 0) rootReadable = true;
      for (const entry of entries) {
        if (++seen > MAX_ENTRIES) {
          truncated = true;
          break;
        }
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH && !isSkippedFolder(entry.name)) queue.push({ dir: full, depth: depth + 1, group: depth === 0 ? entry.name : group });
          continue;
        }
        if (!entry.isFile()) continue;
        const mime = mimeOfName(entry.name);
        if (!matchesKind(mime, query.kind)) continue;
        counts.set(group, (counts.get(group) ?? 0) + 1);
        // 关键词按"授权的文件夹名 + 里面的相对路径"找：地点、活动多半写在文件夹名里
        const where = path.join(path.basename(root), path.relative(root, full));
        if (!hasAll(where, query.keywords)) continue;
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(full);
        } catch {
          continue;
        }
        const taken = mime === "image/jpeg" ? captureTimeOf(full, stat, options.cache) : undefined;
        const when = taken ?? localDateTime(stat.mtimeMs, options.timeZone);
        if (!inRange(when, query)) continue;
        found.push({ path: full, name: entry.name, mime, size: stat.size, image: isPreviewableImage(mime), when, whenKind: taken ? "taken" : "modified", where, source: "folder" });
      }
      if (truncated) break;
    }
    if (rootReadable) overview.push({ root, counts: [...counts].map(([name, count]) => ({ name, count })).toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name)) });
    if (truncated) break;
  }
  return { files: found, truncated, overview };
}

/** 子文件夹概况最多列几个子文件夹（多的写"还有 N 个"） */
export const OVERVIEW_FOLDERS_MAX = 20;

/** 种类的说法：量词和名字（"几张图片""几个视频"） */
const KIND_WORDS: Readonly<Record<FileKindFilter, { unit: string; noun: string }>> = {
  image: { unit: "张", noun: "图片" },
  video: { unit: "个", noun: "视频" },
  document: { unit: "份", noun: "文档" },
  any: { unit: "个", noun: "文件" },
};

/**
 * 子文件夹概况写给秘书（附在 find_files 的结果后面）：每个授权的文件夹一行，"Pictures：Screenshots 134、头像 21，还有 3 个子文件夹（共 9 张），（顶层）50"——
 * 子文件夹按数量排、最多列 OVERVIEW_FOLDERS_MAX 个，直接放着的写"（顶层）"放最后；没有这种文件的写"没有图片"
 */
export function folderOverviewText(overview: readonly FolderOverview[], kind: FileKindFilter): string[] {
  if (overview.length === 0) return [];
  const { unit, noun } = KIND_WORDS[kind];
  const line = (o: FolderOverview) => {
    const name = path.basename(o.root) || o.root;
    const subs = o.counts.filter((c) => c.name !== "");
    const top = o.counts.find((c) => c.name === "");
    if (subs.length === 0 && !top) return `- ${name}：没有${noun}`;
    const shown = subs.slice(0, OVERVIEW_FOLDERS_MAX).map((c) => `${c.name} ${c.count}`);
    const rest = subs.slice(OVERVIEW_FOLDERS_MAX);
    const parts = [
      ...(shown.length > 0 ? [shown.join("、")] : []),
      ...(rest.length > 0 ? [`还有 ${rest.length} 个子文件夹（共 ${rest.reduce((sum, c) => sum + c.count, 0)} ${unit}）`] : []),
      ...(top ? [`（顶层）${top.count}`] : []),
    ];
    return `- ${name}：${parts.join("，")}`;
  };
  return [`子文件夹概况（每个子文件夹里有几${unit}${noun}，含更深的；可以把文件夹名当关键词再找）：`, ...overview.map(line)];
}

/** 在素材里找附件：关键词检索加语义检索（向量模型不在时只按关键词） */
export async function searchMaterialFiles(materials: Pick<Materials, "searchKeyword" | "searchSemantic">, media: Pick<MediaStore, "info" | "filePath">, query: FileQuery, timeZone: string): Promise<FoundFile[]> {
  if (query.keywords.length === 0) return [];
  const text = query.keywords.join(" ");
  const hits: Material[] = [];
  try {
    hits.push(...materials.searchKeyword(text, { limit: 30 }));
  } catch {
    // 关键词检索不了（比如只有一两个字的特殊写法）：只看语义的
  }
  try {
    for (const hit of await materials.searchSemantic(text, { limit: 30 })) if (hit.score >= 0.5) hits.push(hit.material);
  } catch {
    // 向量模型不在：只按关键词
  }
  const found = new Map<string, FoundFile>();
  for (const material of hits) {
    for (const segment of material.segments) {
      const ref = segment.media;
      if (segment.form !== "attachment" || !ref || found.has(ref.mediaId)) continue;
      const info = media.info(ref.mediaId);
      if (!info) continue;
      const name = ref.name ?? segment.label ?? ref.mediaId;
      const mime = info.image?.mime ?? ref.mime ?? mimeOfName(name);
      if (!matchesKind(mime, query.kind)) continue;
      const when = localDateTime(Date.parse(material.time), timeZone);
      if (!inRange(when, query)) continue;
      found.set(ref.mediaId, { path: media.filePath(ref.mediaId), name, mime, size: info.size, image: isPreviewableImage(mime), when, whenKind: "sent", where: "素材", source: "material" });
    }
  }
  return [...found.values()];
}
