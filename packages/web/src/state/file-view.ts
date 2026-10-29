// 内置浏览器里点到能渲染的文件（160 号票）：markdown 这类文本文件不显示原始文本、不下载，用二狗的渲染打开（照 113 号票报告页的画法）。
// 这里是纯函数：哪些走内置渲染（看扩展名和响应的 Content-Type）、文件名、字符集、JSON 格式化、CSV 拆成表格、渲染层显示什么。
// 网页的内置浏览器（132 号票，app/in-app-browser.ts）、鸿蒙 App "浏览"页签的原生浏览器（134 号票，app/browse-files.ts）都按这一份判断；
// 鸿蒙 App 拦下载时先粗筛一遍（frontend/harmony/.../browser/FileDocs.ets 的 looksText，扩展名清单和这里的 EXTENSION_KIND 一致），最后还是这里定。
// 能渲染的：Markdown（按 Markdown 画）、纯文本、JSON（格式化）、CSV / TSV（表格）、代码和配置（等宽，不高亮）；HTML、SVG、XML 照旧当网页开。
// 状态层不用 URL、TextDecoder（tsconfig.state.json 不给 DOM 的类型），地址按字符串拆；解码在 app/file-source.ts。
import { sizeLabel } from "./detail-content.ts";
import { MEDIA_TEXT_MAX_BYTES, t, tTable } from "./protocol.ts";

/** 怎么画：Markdown、纯文本、JSON（格式化）、CSV / TSV（表格）、代码（等宽） */
export type FileRenderKind = "markdown" | "plain" | "json" | "csv" | "tsv" | "code";

export const FILE_RENDER_LABEL: Readonly<Record<FileRenderKind, string>> = tTable({
  markdown: "state.fileView.kind.markdown",
  plain: "state.fileView.kind.plain",
  json: "state.fileView.kind.json",
  csv: "state.fileView.kind.csv",
  tsv: "state.fileView.kind.tsv",
  code: "state.fileView.kind.code",
});

/** 只看扩展名时能渲染的（点链接、直接打开、服务端一律当下载发的时候）。鸿蒙 App 的 FileDocs.ets 里有同一份 */
export const EXTENSION_KIND: Readonly<Record<string, FileRenderKind>> = {
  ...kinds("markdown", "md markdown mdown mkd mkdn"),
  ...kinds("plain", "txt text log rst adoc org srt vtt"),
  ...kinds("json", "json jsonc geojson webmanifest"),
  csv: "csv",
  ...kinds("tsv", "tsv tab"),
  ...kinds(
    "code",
    "jsonl ndjson json5 js mjs cjs jsx ts tsx mts cts ets vue svelte css scss sass less py pyw rb go rs java kt kts scala groovy gradle swift m mm " +
      "c h cc cpp cxx hpp hh cs fs vb php pl pm lua r dart ex exs erl hs clj sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto " +
      "yaml yml toml ini cfg conf properties env diff patch tex bib cmake mk tf hcl nix zig sol",
  ),
};

function kinds(kind: FileRenderKind, list: string): Record<string, FileRenderKind> {
  return Object.fromEntries(list.split(" ").map((ext) => [ext, kind]));
}

/** 浏览器会当网页跑的扩展名：不管服务端回什么类型都不渲染（照旧当网页开） */
const ACTIVE_EXTENSIONS = new Set(["html", "htm", "xhtml", "shtml", "mht", "mhtml", "svg", "svgz", "xml", "xsl", "xslt", "rss", "atom"]);

/** 说不出是什么的类型（一律当下载发）：按扩展名认 */
const GENERIC_MIMES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-download",
  "application/force-download",
  "application/download",
  "application/unknown",
  "application/x-unknown",
  "application/binary",
  "unknown/unknown",
]);

/** 网页、流式的：不渲染（+xml 结尾的也是） */
const PAGE_MIMES = new Set(["text/html", "application/xhtml+xml", "text/xml", "application/xml", "text/event-stream", "image/svg+xml"]);
const MARKDOWN_MIMES = new Set(["text/markdown", "text/x-markdown", "text/x-gfm"]);
const CSV_MIMES = new Set(["text/csv", "text/x-csv", "application/csv", "application/x-csv", "text/comma-separated-values"]);
const TSV_MIMES = new Set(["text/tab-separated-values", "text/tsv"]);
const JSON_MIMES = new Set(["application/json", "text/json", "text/x-json", "application/x-json"]);
/** 一行一个 JSON：整个解析不了，等宽显示原文 */
const JSON_LINES_MIMES = new Set(["application/x-ndjson", "application/ndjson", "application/jsonl", "application/jsonlines", "application/x-jsonlines"]);
const CODE_MIMES = new Set([
  "text/css",
  "text/javascript",
  "text/ecmascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-yaml",
  "application/yaml",
  "text/yaml",
  "text/x-yaml",
  "application/toml",
  "application/sql",
  "application/x-sql",
  "application/graphql",
]);

/** 地址里的路径（去掉 scheme://host、查询串和 #） */
function pathOf(url: string): string {
  const bare = url.replace(/[?#].*$/s, "");
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(bare);
  return scheme ? bare.slice(scheme[0].length) : bare;
}

/** decodeURIComponent，解不了的（100% 这种）原样 */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 名字的扩展名（小写，不带点）；没有是空串 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 地址最后一段（解码过的）：README.md；路径是空的（只有域名）给域名 */
export function fileNameOf(url: string): string {
  const segments = pathOf(url).split("/").filter(Boolean);
  const last = segments.at(-1);
  if (last !== undefined) return decoded(last);
  return /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? url;
}

/** Content-Type 里的类型部分（小写，去掉参数） */
function mimeOf(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Content-Type 里写的字符集（小写）；没写是 undefined */
export function charsetOf(contentType: string): string | undefined {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m ? m[1]!.toLowerCase() : undefined;
}

/**
 * 这个文件用不用二狗的渲染打开、怎么画；undefined 是不用（照旧当网页开、交给浏览器、下载）。
 * - url：文件的地址；mime：响应的 Content-Type（还没请求时不给，只看扩展名）；name：下载时服务端给的文件名（有扩展名时比地址准）。
 * - 扩展名是网页的（html、svg、xml……）不管类型一律不渲染；
 * - 说不出是什么的类型（application/octet-stream、没写）按扩展名；
 * - 网页、流式、明确不是文本的（图片、视频、PDF……）不渲染，扩展名是 .md 的网页（GitHub 的 blob 页）也是；
 * - text/markdown → Markdown；CSV、TSV → 表格；JSON → 格式化；JS、CSS、YAML 这类 → 代码；
 * - text/plain 和别的 text/* 按扩展名细分（GitHub raw 发的 README.md 是 text/plain），没认得的扩展名按纯文本（text/x-* 按代码）。
 */
export function fileRenderOf(target: { url: string; mime?: string | undefined; name?: string | undefined }): FileRenderKind | undefined {
  const ext = (target.name ? extensionOf(target.name) : "") || extensionOf(fileNameOf(target.url));
  if (ACTIVE_EXTENSIONS.has(ext)) return undefined;
  const mime = mimeOf(target.mime);
  const byExtension = EXTENSION_KIND[ext];
  if (GENERIC_MIMES.has(mime)) return byExtension;
  if (PAGE_MIMES.has(mime) || mime.endsWith("+xml")) return undefined;
  if (MARKDOWN_MIMES.has(mime)) return "markdown";
  if (TSV_MIMES.has(mime)) return "tsv";
  if (CSV_MIMES.has(mime)) return byExtension === "tsv" ? "tsv" : "csv";
  if (JSON_LINES_MIMES.has(mime)) return "code";
  if (JSON_MIMES.has(mime) || mime.endsWith("+json")) return "json";
  if (CODE_MIMES.has(mime)) return "code";
  if (mime === "text/plain") return byExtension ?? "plain";
  if (mime.startsWith("text/")) return byExtension ?? (mime.startsWith("text/x-") ? "code" : "plain");
  return undefined;
}

/** 认得的 JSON 缩进两格；认不得（不完整、截断了）是 undefined */
export function prettyJson(text: string): string | undefined {
  if (text.trim() === "") return undefined;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

/** 表格最多画多少行（含表头）：再多的说明一下，看全部点"看原文"或下载 */
export const FILE_TABLE_MAX_ROWS = 500;

/**
 * CSV（sep 是逗号）、TSV（制表符）拆成一行行：引号里的分隔符、换行照原样，两个引号是一个引号；\r\n、\n 都算换行，末尾的换行不多出一行。
 * 只拆前 maxRows 行；total 是一共多少行
 */
export function parseDelimited(text: string, sep: string, maxRows = Number.POSITIVE_INFINITY): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  /** 这一行里有没有东西（空行不算一行） */
  let started = false;
  const endRow = () => {
    row.push(cell);
    if (started || row.length > 1 || cell !== "") {
      total += 1;
      if (rows.length < maxRows) rows.push(row);
    }
    row = [];
    cell = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") {
      quoted = true;
      started = true;
    } else if (ch === sep) {
      row.push(cell);
      cell = "";
      started = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== "" || started || row.length > 0) endRow();
  return { rows, total };
}

/**
 * 取文件内容的结果：text 取到了（bytes 是文件一共多少字节，不知道是 undefined；truncated 只取了开头 MEDIA_TEXT_MAX_BYTES）；
 * page 响应不是能渲染的文本（网页、图片……），调用方照旧当网页开；error 取不到（title、detail 说清楚怎么了、怎么办）
 */
export type FileTextResult =
  | { readonly status: "text"; readonly mime: string; readonly text: string; readonly bytes: number | undefined; readonly truncated: boolean }
  | { readonly status: "page"; readonly mime: string }
  | { readonly status: "error"; readonly title: string; readonly detail: string };

/** 渲染层的正文：Markdown、纯文本（自动换行）、代码（等宽、不换行，格式化过的 JSON 也是）、表格 */
export type FileBody =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "table"; readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] };

/** 渲染层显示什么：上面一行（文件名、类型、大小）、提示条、正文；canRaw 渲染出来和原文不一样（能"看原文"），raw 是原文 */
export interface FileViewModel {
  readonly facts: string;
  readonly notice: string | undefined;
  readonly body: FileBody;
  readonly canRaw: boolean;
  readonly raw: string;
}

const LIMIT_LABEL = sizeLabel(MEDIA_TEXT_MAX_BYTES);

export function fileViewOf(kind: FileRenderKind, name: string, result: Extract<FileTextResult, { status: "text" }>): FileViewModel {
  const { text } = result;
  const size = result.bytes !== undefined ? sizeLabel(result.bytes) : result.truncated ? t("state.fileView.over", { limit: LIMIT_LABEL }) : undefined;
  const notices: string[] = [];
  if (result.truncated)
    notices.push(result.bytes !== undefined ? t("state.fileView.truncatedSized", { size: sizeLabel(result.bytes), limit: LIMIT_LABEL }) : t("state.fileView.truncatedOver", { limit: LIMIT_LABEL }));
  let body: FileBody;
  switch (kind) {
    case "markdown":
      body = { kind: "markdown", text };
      break;
    case "json": {
      const pretty = prettyJson(text);
      if (pretty === undefined) notices.push(result.truncated ? t("state.fileView.jsonTruncated") : t("state.fileView.jsonInvalid"));
      body = { kind: "code", text: pretty ?? text };
      break;
    }
    case "csv":
    case "tsv": {
      const { rows, total } = parseDelimited(text, kind === "csv" ? "," : "\t", FILE_TABLE_MAX_ROWS);
      if (rows.length === 0) {
        body = { kind: "plain", text };
        break;
      }
      if (total > rows.length) notices.push(t("state.fileView.tableTruncated", { total, max: FILE_TABLE_MAX_ROWS }));
      body = { kind: "table", head: rows[0]!, rows: rows.slice(1) };
      break;
    }
    case "code":
      body = { kind: "code", text };
      break;
    case "plain":
      body = { kind: "plain", text };
      break;
  }
  const canRaw = body.kind === "markdown" || body.kind === "table" || (body.kind === "code" && body.text !== text);
  return {
    facts: [name, FILE_RENDER_LABEL[kind], size].filter(Boolean).join(" · "),
    notice: notices.length > 0 ? notices.join(t("state.fileView.noticeSep")) : undefined,
    body,
    canRaw,
    raw: text,
  };
}
