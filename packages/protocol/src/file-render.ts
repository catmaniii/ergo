// 文本类文件怎么画：只看扩展名时能渲染的清单（EXTENSION_KIND）、浏览器会当网页跑的扩展名、各种类型（Content-Type）各按什么画。
// 一份清单两处用（不引用 TypeBox）：
// - 聊天附件：守护进程的附件内容接口、网页的附件卡片和报告页（parts.ts 的 textPreviewOf）；
// - 网页内置浏览器打开文件（packages/web/src/state/file-view.ts 的 fileRenderOf）。
// 鸿蒙、安卓 App 拦下载时粗筛用的扩展名（frontend/harmony/.../browser/FileDocs.ets、frontend/android/.../browser/FileDocs.kt
// 的 RENDER_EXTENSIONS）是原生代码各抄的一份，以这里为准：网页的 test/state/file-view.test.ts、frontend/test/android.test.ts 核对。

/** 怎么画：Markdown、纯文本、JSON（格式化）、CSV / TSV（表格）、代码和配置（等宽，不高亮） */
export type FileRenderKind = "markdown" | "plain" | "json" | "csv" | "tsv" | "code";

/** 只看扩展名时能渲染的（点链接、直接打开、服务端一律当下载发的时候；聊天附件以它为准） */
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

/** 清单里这个扩展名按什么画；不在清单里（包括 constructor 这类对象自带的名字）是 undefined */
export function extensionKindOf(ext: string): FileRenderKind | undefined {
  return Object.hasOwn(EXTENSION_KIND, ext) ? EXTENSION_KIND[ext] : undefined;
}

/** 浏览器会当网页跑的扩展名：不管类型写的什么都不按文本画（内置浏览器照旧当网页开；聊天附件里 html、htm、svg 在沙箱里看，别的只能下载） */
export const PAGE_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm", "xhtml", "shtml", "mht", "mhtml", "svg", "svgz", "xml", "xsl", "xslt", "rss", "atom"]);

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

/** 文件名的扩展名（小写，不带点）；没有、点在开头或结尾的是空串 */
export function fileExtensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * 按类型（Content-Type，参数和大小写不论）定怎么画，ext 是扩展名（fileExtensionOf 的结果）；undefined 是不按文本画。
 * - 扩展名是网页的（PAGE_EXTENSIONS）不管类型一律不画；
 * - 说不出是什么的类型（application/octet-stream、没写）按扩展名；
 * - 网页、流式、明确不是文本的（图片、视频、PDF……）不画；
 * - text/markdown → Markdown；CSV、TSV → 表格；JSON → 格式化；JS、CSS、YAML 这类 → 代码；
 * - text/plain 和别的 text/* 按扩展名细分（GitHub raw 发的 README.md 是 text/plain），没认得的扩展名按纯文本（text/x-* 按代码）。
 */
export function renderKindOf(ext: string, contentType: string | undefined): FileRenderKind | undefined {
  if (PAGE_EXTENSIONS.has(ext)) return undefined;
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const byExtension = extensionKindOf(ext);
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
