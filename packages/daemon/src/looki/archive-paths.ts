// "存一份到本地"（307 号票）的文件夹和文件名：按 年-月\日期\时刻（起始时间 标题）\ 分文件夹，手机上翻得懂。
// - 时间按 Looki 给的那个时区的墙上时间（ISO 里带的偏移）写，不按这台电脑的时区：时刻 "14.00 在望京开会"、照片 "14.00.05-a1b2c3.jpg"；
//   Windows 的文件名里不能有冒号，钟点用点隔开；
// - 文件夹名、文件名里 Windows 不认的字（< > : " / \ | ? * 和控制字符）换成长得像的全角字（：／？……），末尾的点和空格去掉，
//   CON、NUL 这类保留名后面加个"_"；
// - 路径太长截短：整条路径（含文件名）不超过 MAX_PATH_CHARS（Windows 的老程序、同步客户端过了 260 就出毛病），先截标题，
//   标题截没了只留钟点；按 UTF-16 的长度算（Windows 的路径长度就是这么数的），不把一个字截成两半。
import path from "node:path";

/** 整条路径最多多长（留出 .part 和重名序号的地方） */
export const MAX_PATH_CHARS = 240;
/** 标题最多留几个字 */
const TITLE_MAX = 60;
/** 时刻文件夹里文件名最长多长（"14.00.05-a1b2c3.jpeg.part"），给时刻文件夹算预算用 */
const FILE_NAME_ROOM = 26;

/** Windows 文件名里不能有的字 → 长得像的全角字 */
// @i18n-ignore-next data：替换用的全角符号，不是给人看的句子
const LOOKALIKE: Readonly<Record<string, string>> = { "<": "＜", ">": "＞", ":": "：", '"': "＂", "/": "／", "\\": "＼", "|": "｜", "?": "？", "*": "＊" };
/** 保留名（不分大小写，带不带扩展名都不行） */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** 按 UTF-16 长度截到 max 以内，不把代理对截成两半 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** 一段给人看的字 → 能当文件名的（非法字换成全角的、控制字符去掉、连续空白并成一个、末尾的点和空格去掉、保留名加"_"），再截到 max */
export function safeName(text: string, max = TITLE_MAX): string {
  let s = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) s += " ";
    else s += LOOKALIKE[ch] ?? ch;
  }
  s = clip(s.replace(/\s+/g, " ").trim(), max).replace(/[. ]+$/, "");
  return RESERVED.test(s) ? `${s}_` : s;
}

/** 带偏移的 ISO（2026-10-24T14:00:05.000+08:00）里的墙上时间：日期、时、分、秒 */
export function wallClock(iso: string): { date: string; hh: string; mm: string; ss: string } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (!m) return { date: iso.slice(0, 10), hh: "00", mm: "00", ss: "00" };
  return { date: m[1]!, hh: m[2]!, mm: m[3]!, ss: m[4] ?? "00" };
}

/** 一天的文件夹（相对存放位置，正斜杠）：2026-10/2026-10-24 */
export function dayFolder(date: string): string {
  return `${date.slice(0, 7)}/${date}`;
}

/** 相对路径（正斜杠）→ 存放位置下的完整路径 */
export function absolute(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

/** 存放位置下这一天的文件夹的完整路径有多长（再加一个分隔符） */
function dayPathLength(root: string, date: string): number {
  return absolute(root, dayFolder(date)).length + 1;
}

/**
 * 一个时刻的文件夹名："14.00 在望京开会"（标题按路径预算截短，截没了只留钟点）；taken 里的名字（同一天别的时刻占了的，不分大小写）
 * 重了加" (2)"、" (3)"
 */
export function momentFolderName(root: string, date: string, start: string, title: string, taken: ReadonlySet<string>): string {
  const { hh, mm } = wallClock(start);
  const clock = `${hh}.${mm}`;
  // 留出" (9)"的地方
  const room = MAX_PATH_CHARS - dayPathLength(root, date) - FILE_NAME_ROOM - clock.length - 1 - 4;
  const name = safeName(title, Math.max(0, Math.min(TITLE_MAX, room)));
  return dedupe(name === "" ? clock : `${clock} ${name}`, taken);
}

/** 当天文件夹里一个 vlog 的文件名："vlog 忙碌的周六.mp4"（没标题是"vlog.mp4"），按路径预算截短、重了加序号 */
export function vlogFileName(root: string, date: string, title: string, ext: string, taken: ReadonlySet<string>): string {
  const room = MAX_PATH_CHARS - dayPathLength(root, date) - "vlog ".length - ext.length - ".part".length - 4;
  const name = safeName(title, Math.max(0, Math.min(TITLE_MAX, room)));
  const base = name === "" ? "vlog" : `vlog ${name}`;
  let candidate = `${base}${ext}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${base} (${n})${ext}`;
  return candidate;
}

/** 重了加" (2)"、" (3)"（比较不分大小写：Windows 的文件名不分） */
function dedupe(name: string, taken: ReadonlySet<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${name} (${n})`;
  return candidate;
}

/** 照片、视频的文件名：拍摄时刻（墙上时间）加 Looki 文件 id 的末 6 位（同一秒拍了几张也不重，索引丢了也认得出是哪个文件） */
export function mediaFileName(taken: string, fileId: string, ext: string): string {
  const { hh, mm, ss } = wallClock(taken);
  const tail = fileId.replace(/[^0-9A-Za-z]/g, "").slice(-6) || "file";
  return `${hh}.${mm}.${ss}-${tail}${ext}`;
}

/** 类型 → 扩展名 */
const CONTENT_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
};

/** 扩展名：链接路径上带的（.jpg、.mp4……，只认 2–5 个字母数字），没有按对方说的类型，再没有按种类猜（照片 .jpg、视频 .mp4） */
export function extensionOf(url: string | undefined, kind: "photo" | "video" | "audio", contentType?: string): string {
  if (url !== undefined) {
    try {
      const ext = path.posix.extname(new URL(url).pathname).toLowerCase();
      if (/^\.[0-9a-z]{2,5}$/.test(ext)) return ext === ".jpeg" ? ".jpg" : ext;
    } catch {
      // 不是地址：往下猜
    }
  }
  if (contentType !== undefined && CONTENT_EXT[contentType]) return CONTENT_EXT[contentType]!;
  return kind === "photo" ? ".jpg" : kind === "video" ? ".mp4" : ".m4a";
}
