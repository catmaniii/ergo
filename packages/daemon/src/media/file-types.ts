// 文件类型的日常判断（不随模型投影的版本变）：按文件名认类型、是不是文本类或 PDF、把字节解成文本、大小怎么说。
// 发消息时补类型、"读取附件"、报告页取文本（113 号票，严格按 UTF-8 解）、各处的提示文字用它。发给模型前的投影有自己的一份（conversation/projection-v1.ts），
// 那一份冻结在投影的版本里，改这里不会改变投影的输出。

/** 按扩展名就能认定类型的文本类文件（浏览器常把它们报成空类型、octet-stream，甚至把 .ts 报成视频） */
const TEXT_TYPES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  mts: "text/x-typescript",
  cts: "text/x-typescript",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  cc: "text/x-c++",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  php: "text/x-php",
  lua: "text/x-lua",
  r: "text/x-r",
  scala: "text/x-scala",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  ps1: "text/x-powershell",
  bat: "text/x-bat",
  cmd: "text/x-bat",
  sql: "application/sql",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  properties: "text/plain",
  env: "text/plain",
  vue: "text/plain",
  svelte: "text/plain",
  tex: "application/x-tex",
  rst: "text/x-rst",
  org: "text/plain",
  srt: "text/plain",
  vtt: "text/vtt",
  ets: "text/plain",
};

const TEXT_MIMES = new Set(Object.values(TEXT_TYPES).filter((m) => !m.startsWith("text/")));

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * 按文件名认得的类型（只认文本类、PDF 和 SVG；SVG 是 117 号票加的：维护者发出的 .svg 照浏览器的写法标成 image/svg+xml，
 * 按 XML 文本读）；认不出是 undefined
 */
export function mimeFromName(name: string): string | undefined {
  const ext = extensionOf(name);
  return ext === "pdf" ? "application/pdf" : ext === "svg" ? "image/svg+xml" : TEXT_TYPES[ext];
}

/** 文件是文本类、PDF，还是别的（看扩展名和类型） */
export function fileKind(name: string, mime: string): "text" | "pdf" | "other" {
  const ext = extensionOf(name);
  const base = mime.toLowerCase();
  if (ext === "pdf" || base === "application/pdf") return "pdf";
  if (ext in TEXT_TYPES || base.startsWith("text/") || TEXT_MIMES.has(base) || base.endsWith("+json") || base.endsWith("+xml")) return "text";
  return "other";
}

/** 把字节解成文本：先按 UTF-8，不是合法的 UTF-8 再按 GB18030（Excel 导出的 CSV 常见）；都不行或含 NUL 时为 undefined */
export function decodeText(bytes: Uint8Array): string | undefined {
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      return text.includes("\u0000") ? undefined : text;
    } catch {
      // 换下一种编码
    }
  }
  return undefined;
}

/**
 * 只按 UTF-8 解（113 号票，报告页取文本：不猜别的编码，解不出来如实报错，不吐乱码）。cut 为真时这段字节是从文件开头截下来的：
 * 末尾没截完的半个字符去掉再解。不是合法的 UTF-8、或含 NUL（像二进制）时为 undefined
 */
export function decodeUtf8(bytes: Uint8Array, options: { cut?: boolean } = {}): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(options.cut ? bytes.subarray(0, utf8Boundary(bytes)) : bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/** 截下来的 UTF-8 字节里最后一个完整的字符在哪结束：末尾是没截完的多字节字符时退到它的首字节 */
function utf8Boundary(bytes: Uint8Array): number {
  // 从末尾往回找首字节（续字节是 10xxxxxx），一个字符最多 4 个字节
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i--) {
    const b = bytes[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const length = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
    return i + length <= bytes.length ? bytes.length : i;
  }
  return bytes.length;
}

/** 字节数的说法：512 B、40.0 KB、1.2 MB、2.00 GB（附件、工具调用完整内容的清理日志共用） */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
