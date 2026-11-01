// pi 的 find、grep 靠系统里的 fd、rg（ripgrep），找不到就去 GitHub 下载。二狗固定设了 PI_OFFLINE（child-env.ts），不会下载，
// 只回一句 "fd is not available and could not be downloaded"，这个工具就废了（362 号票：真模型试验里新任务的负责人第一下就撞上）。
// 这里接一层：PATH 上有 fd、rg 的照旧用 pi 自带的，没有的退回 Node 自己找（不认 .gitignore，跳过 node_modules、.git），结果的写法和 pi 的一样。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createFindToolDefinition, createGrepToolDefinition, defineTool, DEFAULT_MAX_BYTES, type ToolDefinition, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";

const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);
/** 退回的 grep 不读太大的文件 */
const GREP_MAX_FILE_BYTES = 5 * 1024 * 1024;
const GREP_DEFAULT_LIMIT = 100;

const known = new Map<string, boolean>();

/** 这几个名字里有一个在 PATH 上（查一次记下：子进程活着期间不会变） */
function onPath(names: readonly string[]): boolean {
  const key = names.join(",");
  let found = known.get(key);
  if (found === undefined) {
    found = names.some((name) => spawnSync(name, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0);
    known.set(key, found);
  }
  return found;
}

/** 没写目录的 glob 按文件名匹配、一层层往下找（fd 和 rg 都这样认） */
const recursive = (pattern: string) => (pattern.includes("/") ? pattern : `**/${pattern}`);

/** 目录下匹配 glob 的路径（相对这个目录；跳过 node_modules、.git）；够数了就停 */
async function globbed(pattern: string, root: string, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of fs.promises.glob(recursive(pattern), { cwd: root, exclude: (name) => SKIPPED_DIRS.has(path.basename(name)) })) {
    found.push(entry);
    if (found.length >= limit) break;
  }
  return found;
}

interface GrepArgs {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  ignoreCase?: boolean | undefined;
  literal?: boolean | undefined;
  context?: number | undefined;
  limit?: number | undefined;
}

/** 一个文件的每一行；读不了、太大、不是文本的没有 */
function textLines(file: string): string[] | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > GREP_MAX_FILE_BYTES) return undefined;
    const text = fs.readFileSync(file, "utf8");
    return text.includes("\0") ? undefined : text.replace(/\r\n?/g, "\n").split("\n");
  } catch {
    return undefined;
  }
}

/** 没有 rg 时的 grep：写法同 pi（`文件:行号: 内容`，上下文行是 `文件-行号- 内容`） */
async function grepWithNode(cwd: string, args: GrepArgs, signal: AbortSignal | undefined): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
  const root = path.resolve(cwd, args.path ?? ".");
  if (!fs.existsSync(root)) throw new Error(`Path not found: ${root}`);
  const single = fs.statSync(root).isFile();
  const files = single ? [root] : (await globbed(args.glob ?? "*", root)).map((entry) => path.join(root, entry));
  const regex = new RegExp(args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern, args.ignoreCase ? "i" : "");
  const limit = Math.max(1, args.limit ?? GREP_DEFAULT_LIMIT);
  const context = Math.max(0, args.context ?? 0);
  const output: string[] = [];
  let matches = 0;
  let limited = false;
  for (const file of files) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const lines = textLines(file);
    if (!lines) continue;
    const shown = single ? path.basename(file) : path.relative(root, file).replace(/\\/g, "/");
    for (const [index, line] of lines.entries()) {
      if (!regex.test(line)) continue;
      if (matches >= limit) {
        limited = true;
        break;
      }
      matches += 1;
      for (let at = Math.max(0, index - context); at <= Math.min(lines.length - 1, index + context); at++) {
        const { text } = truncateLine(lines[at] ?? "");
        output.push(at === index ? `${shown}:${at + 1}: ${text}` : `${shown}-${at + 1}- ${text}`);
      }
    }
    if (limited) break;
  }
  if (matches === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const notices = [...(limited ? [`${limit} matches limit reached`] : []), ...(truncation.truncated ? [`${Math.round(DEFAULT_MAX_BYTES / 1024)}KB limit reached`] : [])];
  return { content: [{ type: "text", text: truncation.content + (notices.length > 0 ? `\n\n[${notices.join(". ")}]` : "") }], details: undefined };
}

/** 替换 pi 的 find、grep：工具白名单里有的才换，用的时候看 PATH 上有没有 fd、rg */
export function fileSearchOverrides(tools: readonly string[], cwd: string): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  if (tools.includes("find")) {
    const withFd = createFindToolDefinition(cwd);
    const withNode = createFindToolDefinition(cwd, {
      operations: {
        exists: (p) => fs.existsSync(p),
        glob: (pattern, root, { limit }) => globbed(pattern, root, limit).then((found) => found.map((entry) => path.join(root, entry))),
      },
    });
    out.push(defineTool({ ...withFd, execute: (...args) => (onPath(["fd", "fdfind"]) ? withFd : withNode).execute(...args) }));
  }
  if (tools.includes("grep")) {
    const withRg = createGrepToolDefinition(cwd);
    out.push(defineTool({ ...withRg, execute: (id, args, signal, update, ctx) => (onPath(["rg"]) ? withRg.execute(id, args, signal, update, ctx) : grepWithNode(cwd, args, signal)) }));
  }
  return out;
}
