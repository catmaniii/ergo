// 脚本执行前的扫描（规格第 7 节"不能联网"的尽力而为）：守卫只看得到命令这一层（`python fetch.py`），
// 脚本里写了什么要在执行前读出来看。这里找出脚本用到的联网库或函数，作为环境事实（ScriptFact）交给守卫的判定函数；
// 联网开关关着时，判定函数据此拒绝，说明里提示"联网请发起任务"。
//
// 只认常见写法（import / require 联网的库、fetch、WebSocket、在字符串里调 curl / wget……），扫不出来的写法挡不住：
// 第一阶段没有系统级沙箱（规格 Out of Scope），bash 起的进程另有无效代理兜一层（process/child-env.ts）。
import fs from "node:fs";
import path from "node:path";
import { NETWORK_PROGRAMS, type ScriptFact } from "../guard/index.ts";

/** 最多读这么多字节（更大的脚本只看开头） */
const MAX_BYTES = 1024 * 1024;

type Language = "python" | "node" | "shell";

/**
 * 扫一个脚本。interpreter 是命令里的解释器（`python`、`node`；直接执行的脚本为空），看不出语言时用它和 `#!` 行判断，
 * 都看不出就按三种语言都扫一遍。文件不存在或读不了时返回 undefined（判定时算不知道）。
 */
export function scanScript(file: string, interpreter = ""): ScriptFact | undefined {
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
      const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const languages = languagesOf(file, interpreter, text);
  const found = new Set<string>();
  for (const language of languages) for (const hit of SCANNERS[language](text)) found.add(hit);
  return { networkUsage: [...found] };
}

const EXTENSIONS: Record<string, Language> = {
  ".py": "python",
  ".pyw": "python",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".ts": "node",
  ".mts": "node",
  ".cts": "node",
  ".jsx": "node",
  ".tsx": "node",
  ".sh": "shell",
  ".bash": "shell",
};

function languagesOf(file: string, interpreter: string, text: string): Language[] {
  const byExt = EXTENSIONS[path.extname(file).toLowerCase()];
  if (byExt) return [byExt];
  const byName = languageOfProgram(path.basename(interpreter).replace(/\.exe$/i, "").toLowerCase());
  if (byName) return [byName];
  const shebang = /^#!(.*)$/m.exec(text.split("\n", 1)[0] ?? "")?.[1] ?? "";
  const byShebang = shebang.split(/[\s/]+/).map(languageOfProgram).find((l) => l !== undefined);
  if (byShebang) return [byShebang];
  return ["python", "node", "shell"];
}

function languageOfProgram(name: string): Language | undefined {
  if (/^(python[\d.]*|py|pythonw)$/.test(name)) return "python";
  if (/^(node|nodejs|deno|bun|tsx|ts-node)$/.test(name)) return "node";
  if (/^(bash|sh|zsh|dash|ksh)$/.test(name)) return "shell";
  return undefined;
}

// ───────────────────────── 各语言 ─────────────────────────

/** 联网的程序名（守卫拆 bash 用的同一份名单，guard/shell/programs.ts 的 NETWORK_PROGRAMS），按长的在前排好、转义，拼进正则 */
const PROGRAM_ALTERNATIVES = NETWORK_PROGRAMS.toSorted((a, b) => b.length - a.length)
  .map((p) => p.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"))
  .join("|");

/**
 * 在字符串里调起的联网程序：命令字符串（execSync('wget …')、"curl -s …"），或参数列表的第一项（subprocess.run(['curl', …])）。
 * 程序名后面要跟空白，或者是收尾的引号再跟逗号——`config["host"]`、`get("http")` 这类普通字符串不算
 */
const QUOTED_PROGRAM = new RegExp(`["'\`]\\s*(${PROGRAM_ALTERNATIVES})(?=\\s|["'\`]\\s*,)`, "g");

/** shell 脚本里在命令位置上的联网程序（`curl …`、`| nc …`、`$(wget …)`） */
const SHELL_PROGRAM = new RegExp(`(?:^|[\\s;|&(\`$])(${PROGRAM_ALTERNATIVES})(?=\\s|$)`, "gm");

const PYTHON_MODULES = [
  "requests",
  "urllib.request",
  "urllib3",
  "http.client",
  "http.server",
  "httpx",
  "aiohttp",
  "socket",
  "socketserver",
  "ftplib",
  "smtplib",
  "poplib",
  "imaplib",
  "telnetlib",
  "xmlrpc.client",
  "websocket",
  "websockets",
  "paramiko",
  "pycurl",
  "asyncssh",
  "grpc",
  "boto3",
  "botocore",
  "openai",
  "anthropic",
  "selenium",
  "playwright",
  "scrapy",
  "tornado",
  "twisted",
  "zmq",
  "mechanize",
];

/** 模块名命中哪一个联网模块（`urllib.request.foo` 命中 `urllib.request`；只写 `urllib` 不算） */
function pythonModuleHit(module: string): string | undefined {
  return PYTHON_MODULES.find((m) => module === m || module.startsWith(`${m}.`));
}

function scanPython(source: string): string[] {
  const text = source.replace(/(^|\s)#.*$/gm, "$1");
  const hits: string[] = [];
  for (const [, list] of text.matchAll(/^\s*import\s+([^\n;]+)/gm)) {
    for (const item of list!.split(",")) {
      const hit = pythonModuleHit(item.trim().split(/\s+/)[0] ?? "");
      if (hit) hits.push(hit);
    }
  }
  for (const [, module, names] of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n;]+)/gm)) {
    const direct = pythonModuleHit(module!);
    if (direct) {
      hits.push(direct);
      continue;
    }
    // from urllib import request / from http import client
    for (const name of names!.replace(/[()]/g, "").split(",")) {
      const hit = pythonModuleHit(`${module}.${name.trim().split(/\s+/)[0]}`);
      if (hit) hits.push(hit);
    }
  }
  for (const [, module] of text.matchAll(/(?:__import__|import_module)\(\s*["']([\w.]+)["']/g)) {
    const hit = pythonModuleHit(module!);
    if (hit) hits.push(hit);
  }
  hits.push(...quotedPrograms(text));
  return hits;
}

const NODE_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "axios",
  "node-fetch",
  "undici",
  "got",
  "superagent",
  "request",
  "ky",
  "cross-fetch",
  "isomorphic-fetch",
  "ws",
  "socket.io-client",
  "puppeteer",
  "playwright",
  "openai",
  "@anthropic-ai/sdk",
  "ssh2",
  "nodemailer",
  "ftp",
  "basic-ftp",
];

const NODE_GLOBALS: [RegExp, string][] = [
  [/\bfetch\s*\(/, "fetch"],
  [/\bnew\s+WebSocket\b/, "WebSocket"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnew\s+EventSource\b/, "EventSource"],
  [/\bsendBeacon\s*\(/, "sendBeacon"],
];

function scanNode(source: string): string[] {
  // 去掉注释：块注释，和前面不是 `:`、引号的 `//`（免得把字符串里的 https:// 当成注释）
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const hits: string[] = [];
  const specifiers = [
    ...text.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g),
    ...text.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g),
  ].map((m) => m[1]!.replace(/^node:/, ""));
  for (const specifier of specifiers) {
    const hit = NODE_MODULES.find((m) => specifier === m || specifier.startsWith(`${m}/`));
    if (hit) hits.push(hit);
  }
  for (const [pattern, name] of NODE_GLOBALS) if (pattern.test(text)) hits.push(name);
  hits.push(...quotedPrograms(text));
  return hits;
}

function scanShell(source: string): string[] {
  const text = source.replace(/(^|\s)#.*$/gm, "$1");
  const hits: string[] = [];
  for (const [, program] of text.matchAll(SHELL_PROGRAM)) hits.push(program!);
  for (const [, sub] of text.matchAll(/\bgit\s+(push|pull|fetch|clone)\b/g)) hits.push(`git ${sub}`);
  for (const [, tool, sub] of text.matchAll(/\b(npm|pnpm|yarn|pip3?|npx)\s+(install|i|add|publish|exec)\b/g)) hits.push(`${tool} ${sub}`);
  return hits;
}

function quotedPrograms(text: string): string[] {
  return [...text.matchAll(QUOTED_PROGRAM)].map((m) => m[1]!);
}

const SCANNERS: Record<Language, (text: string) => string[]> = { python: scanPython, node: scanNode, shell: scanShell };
