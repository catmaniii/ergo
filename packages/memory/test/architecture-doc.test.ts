// 197 号票：记忆系统的总览文档（docs/memory-system.md）和代码对得上。改了接口名、挪了文件而没改文档，这里就红。
// 查三样：
// 1. 接口表：每张前面写着 <!-- 接口表 --> 的表，表头是"状态、接口、文件、参数要点、返回"。状态是 ✅ 或 🧪 的行：
//    - 文件要存在；
//    - 接口格里每个反引号名字都要在文件里找得到：记忆包（@ergo/memory）入口转出的文件，名字要是这个文件的导出、也要是包入口的导出；
//      记忆包别的文件、评测包（packages/memory-eval，评测这类）的文件，名字要是这个文件的导出；守护进程、网页、协议包的文件，名字要在文件里声明；
//      "名字.成员"的成员要在这个名字的声明块里。
//    状态是 📋 或写着"进行中"的行不查名字（还没有代码）。
// 2. 文档里反引号括起来的、以 packages/、docs/、.scratch/ 开头的路径，和相对链接指向的文件，都要存在。
// 3. mermaid 的几条硬规矩：流程图的节点名、连线上的字都加引号；时序图的消息里不出现分号、井号。
// 197 号票第二版（记忆接进二狗以后）又加了三样，管住守护进程这一侧：
// 4. 工具表：每张前面写着 <!-- 工具表 --> 的表，表头是"状态、工具、给谁、文件、做什么"。✅、🧪 行的每个工具名都要以字符串字面量
//    出现在写明的文件里；守护进程里记忆的工具名（memory/tool-names.ts 的常量、CURATOR_TOOL_NAMES）每一个都要在工具表里有一行。
// 5. 守护进程 packages/daemon/src/memory/、网页 packages/web/src/plugins/memory/ 下的每个源文件，完整路径都要在文档里出现。
// 只读文件、不跑代码，用正则认声明（这个仓库的 TypeScript 是 7.x，没有编译器的 JS 接口）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DOC = path.join(REPO, "docs", "memory-system.md");
/**
 * 公开仓库里没有评测包 packages/memory-eval（326 号票：评测和评测数据只留私有仓库）。
 * 文档里的接口表会提到它的源文件，公开版里那些行没法核——读文档时按"目录在不在"决定要不要把那些行去掉，
 * 私有仓库照旧一个都查。
 */
const HAS_MEMORY_EVAL = fs.existsSync(path.join(REPO, "packages", "memory-eval"));
const docForChecks = (text: string): string =>
  HAS_MEMORY_EVAL ? text : text.split(/\r?\n/).filter((line) => !line.includes("packages/memory-eval/")).join("\n");
/** 记忆包的入口（@ergo/memory） */
const ENTRY = "packages/memory/src/index.ts";
/** 记忆包和评测包的源码（326 号票分成两个包）：这两处的文件按"导出"认名字 */
const LAB_SRC: readonly string[] = ["packages/memory/src/", "packages/memory-eval/src/"];

export const TABLE_MARKER = "<!-- 接口表 -->";
export const TABLE_HEADER: readonly string[] = ["状态", "接口", "文件", "参数要点", "返回"];

export interface InterfaceRow {
  /** 文档里的行号（从 1 起） */
  line: number;
  status: string;
  names: string[];
  /** 文件格里的路径；写的是"—"的为 null */
  file: string | null;
  /** 要不要查名字：✅、🧪 查，📋 和"进行中"不查 */
  checked: boolean;
}

const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/;

function cellsOf(line: string): string[] | undefined {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return undefined;
  return t
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** 解析全部接口表；格式不对的写进 problems */
export function parseInterfaceTables(md: string): { tables: number; rows: InterfaceRow[]; problems: string[] } {
  const lines = md.split(/\r?\n/);
  const rows: InterfaceRow[] = [];
  const problems: string[] = [];
  let tables = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() !== TABLE_MARKER) continue;
    tables += 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === "") j += 1;
    const header = cellsOf(lines[j] ?? "");
    if (!header || header.join("|") !== TABLE_HEADER.join("|")) {
      problems.push(`第 ${j + 1} 行：接口表的表头应该是 | ${TABLE_HEADER.join(" | ")} |`);
      continue;
    }
    const divider = cellsOf(lines[j + 1] ?? "");
    if (!divider || divider.length !== TABLE_HEADER.length || !divider.every((c) => /^:?-+:?$/.test(c))) {
      problems.push(`第 ${j + 2} 行：表头下面应该是分隔行`);
      continue;
    }
    for (let k = j + 2; k < lines.length; k += 1) {
      const cells = cellsOf(lines[k]!);
      if (!cells) break;
      const where = `第 ${k + 1} 行`;
      if (cells.length !== TABLE_HEADER.length) {
        problems.push(`${where}：应该是 ${TABLE_HEADER.length} 列，实际 ${cells.length} 列`);
        continue;
      }
      const [status, nameCell, fileCell] = cells as [string, string, string];
      const planned = status.startsWith("📋") || status.includes("进行中");
      if (!planned && !status.startsWith("✅") && !status.startsWith("🧪")) {
        problems.push(`${where}：状态要以 ✅、🧪、📋 开头（"${status}"）`);
        continue;
      }
      const names = ticked(nameCell);
      const files = ticked(fileCell);
      if (!planned) {
        if (names.length === 0) problems.push(`${where}：接口格里没有反引号括起来的名字`);
        for (const n of names) if (!NAME.test(n)) problems.push(`${where}：接口名"${n}"不是"名字"或"名字.成员"的写法`);
        if (files.length !== 1) problems.push(`${where}：文件格里要有且只有一个反引号括起来的路径`);
      }
      rows.push({ line: k + 1, status, names, file: files[0] ?? null, checked: !planned });
    }
  }
  return { tables, rows, problems };
}

// ---------- 认代码里的名字 ----------

const read = (() => {
  const cache = new Map<string, string>();
  return (rel: string): string => {
    let text = cache.get(rel);
    if (text === undefined) {
      text = fs.readFileSync(path.join(REPO, rel), "utf8");
      cache.set(rel, text);
    }
    return text;
  };
})();

const escape = (s: string) => s.replace(/[$]/g, "\\$");
const DECL_KINDS = String.raw`(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)`;

/** 名字在文件里声明的那一行（exported：只认 export 的）；找不到是 -1 */
function declarationLine(code: string, name: string, exported: boolean): number {
  const re = new RegExp(String.raw`^${exported ? String.raw`export\s+` : String.raw`(?:export\s+)?`}${DECL_KINDS}\s+${escape(name)}\b`);
  return code.split(/\r?\n/).findIndex((l) => re.test(l));
}

/** 文件自己的导出：声明的、export { … } 列出的（含 from 转出的），export * 转出的模块另算（starsOf） */
export function exportedNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(new RegExp(String.raw`^export\s+${DECL_KINDS}\s+([A-Za-z_$][\w$]*)`, "gm"))) names.add(m[1]!);
  for (const m of code.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const item of m[1]!.split(",")) {
      const words = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      const name = (words[1] ?? words[0] ?? "").trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** export * from "./x.ts" 转出的模块（仓库根开始的路径） */
function starsOf(rel: string): string[] {
  const dir = path.posix.dirname(rel);
  return [...read(rel).matchAll(/^export\s+\*\s+from\s+["'](\.[^"']+)["']/gm)].map((m) => path.posix.normalize(path.posix.join(dir, m[1]!)));
}

/** 包入口转出的全部模块和全部名字 */
const entry = (() => {
  let cached: { modules: Set<string>; names: Set<string> } | undefined;
  return () => {
    if (cached) return cached;
    const modules = new Set<string>();
    const names = new Set<string>();
    const visit = (rel: string) => {
      if (modules.has(rel)) return;
      modules.add(rel);
      for (const n of exportedNames(read(rel))) names.add(n);
      for (const s of starsOf(rel)) visit(s);
    };
    visit(ENTRY);
    cached = { modules, names };
    return cached;
  };
})();

/** 声明块：从声明那一行到第一行顶格的 }（或 )）；声明那一行就收尾的只有它自己 */
function blockOf(code: string, declLine: number): string[] {
  const lines = code.split(/\r?\n/);
  const first = lines[declLine] ?? "";
  if (!/[{(]\s*$/.test(first) && /;\s*$/.test(first)) return [first];
  const block = [first];
  for (let i = declLine + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    block.push(l);
    if (/^[})]/.test(l)) break;
  }
  return block;
}

const MEMBER_MODIFIERS = String.raw`(?:(?:readonly|static|async|private|public|protected|get|set|override|declare)\s+)*`;

function hasMember(block: readonly string[], member: string): boolean {
  const re = new RegExp(String.raw`^\s+${MEMBER_MODIFIERS}["']?${escape(member)}["']?\??\s*[(:<=,]`);
  return block.slice(1).some((l) => re.test(l));
}

/** 一行接口表的问题（没有问题是空数组） */
export function checkRow(row: InterfaceRow): string[] {
  if (!row.checked) return [];
  const where = `第 ${row.line} 行`;
  if (!row.file) return [`${where}：没写文件`];
  if (!fs.existsSync(path.join(REPO, row.file))) return [`${where}：文件 ${row.file} 不存在`];
  const code = read(row.file);
  const inLab = LAB_SRC.some((src) => row.file!.startsWith(src));
  const viaEntry = inLab && entry().modules.has(row.file);
  const problems: string[] = [];
  for (const full of row.names) {
    const [name, member] = full.split(".") as [string, string | undefined];
    const line = declarationLine(code, name, inLab);
    const reExported = inLab && exportedNames(code).has(name);
    if (line < 0 && !reExported) {
      problems.push(`${where}：${row.file} 里${inLab ? "没有导出" : "没有声明"} ${name}`);
      continue;
    }
    if (viaEntry && !entry().names.has(name)) problems.push(`${where}：包入口 ${ENTRY} 没有转出 ${name}`);
    if (member === undefined) continue;
    if (line < 0 || !hasMember(blockOf(code, line), member)) problems.push(`${where}：${row.file} 里 ${name} 没有成员 ${member}`);
  }
  return problems;
}

// ---------- 路径和链接 ----------

/** 文档里反引号括起来的仓库路径中不存在的 */
export function missingPaths(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/`((?:packages|docs|\.scratch)\/[^`\s]*)`/g)) {
    const p = m[1]!;
    if (/[<>*…]/.test(p)) continue;
    if (!fs.existsSync(path.join(REPO, p))) out.push(p);
  }
  return [...new Set(out)];
}

/** 相对链接（相对文档所在的目录）中指向的文件不存在的 */
export function missingLinks(md: string, docDir: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]!;
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const file = decodeURI(target.split("#")[0]!);
    if (!fs.existsSync(path.resolve(docDir, file))) out.push(target);
  }
  return [...new Set(out)];
}

// ---------- 工具表（agent 能调的工具名） ----------

export const TOOL_MARKER = "<!-- 工具表 -->";
export const TOOL_HEADER: readonly string[] = ["状态", "工具", "给谁", "文件", "做什么"];

export interface ToolRow {
  /** 文档里的行号（从 1 起） */
  line: number;
  status: string;
  tools: string[];
  /** 文件格里的路径；写的是"—"的为 null */
  file: string | null;
  /** 要不要查：✅、🧪 查，📋 和"进行中"不查 */
  checked: boolean;
}

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/** 解析全部工具表；格式不对的写进 problems */
export function parseToolTables(md: string): { tables: number; rows: ToolRow[]; problems: string[] } {
  const lines = md.split(/\r?\n/);
  const rows: ToolRow[] = [];
  const problems: string[] = [];
  let tables = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() !== TOOL_MARKER) continue;
    tables += 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === "") j += 1;
    const header = cellsOf(lines[j] ?? "");
    if (!header || header.join("|") !== TOOL_HEADER.join("|")) {
      problems.push(`第 ${j + 1} 行：工具表的表头应该是 | ${TOOL_HEADER.join(" | ")} |`);
      continue;
    }
    const divider = cellsOf(lines[j + 1] ?? "");
    if (!divider || divider.length !== TOOL_HEADER.length || !divider.every((c) => /^:?-+:?$/.test(c))) {
      problems.push(`第 ${j + 2} 行：表头下面应该是分隔行`);
      continue;
    }
    for (let k = j + 2; k < lines.length; k += 1) {
      const cells = cellsOf(lines[k]!);
      if (!cells) break;
      const where = `第 ${k + 1} 行`;
      if (cells.length !== TOOL_HEADER.length) {
        problems.push(`${where}：应该是 ${TOOL_HEADER.length} 列，实际 ${cells.length} 列`);
        continue;
      }
      const [status, toolCell, , fileCell] = cells as [string, string, string, string];
      const planned = status.startsWith("📋") || status.includes("进行中");
      if (!planned && !status.startsWith("✅") && !status.startsWith("🧪")) {
        problems.push(`${where}：状态要以 ✅、🧪、📋 开头（"${status}"）`);
        continue;
      }
      const tools = ticked(toolCell);
      const files = ticked(fileCell);
      if (tools.length === 0) problems.push(`${where}：工具格里没有反引号括起来的工具名`);
      for (const n of tools) if (!TOOL_NAME.test(n)) problems.push(`${where}：工具名"${n}"不是小写加下划线的写法`);
      if (!planned && files.length !== 1) problems.push(`${where}：文件格里要有且只有一个反引号括起来的路径`);
      rows.push({ line: k + 1, status, tools, file: files[0] ?? null, checked: !planned });
    }
  }
  return { tables, rows, problems };
}

/** 一行工具表的问题：工具名要以字符串字面量出现在写明的文件里 */
export function checkToolRow(row: ToolRow): string[] {
  if (!row.checked) return [];
  const where = `第 ${row.line} 行`;
  if (!row.file) return [`${where}：没写文件`];
  if (!fs.existsSync(path.join(REPO, row.file))) return [`${where}：文件 ${row.file} 不存在`];
  const code = read(row.file);
  return row.tools.filter((name) => !code.includes(`"${name}"`) && !code.includes(`'${name}'`)).map((name) => `${where}：${row.file} 里没有工具名 "${name}"`);
}

/** 守护进程里记忆的工具名：memory/tool-names.ts 里的字符串常量，加上 CURATOR_TOOL_NAMES 列的 */
export function memoryToolNamesInCode(): string[] {
  const names = new Set<string>();
  for (const m of read("packages/daemon/src/memory/tool-names.ts").matchAll(/^export\s+const\s+[A-Z_]+\s*=\s*["']([a-z0-9_]+)["']/gm)) names.add(m[1]!);
  const curator = /export\s+const\s+CURATOR_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/.exec(read("packages/daemon/src/memory/curator-tools.ts"));
  for (const m of (curator?.[1] ?? "").matchAll(/["']([a-z0-9_]+)["']/g)) names.add(m[1]!);
  return [...names];
}

/** 代码里有、工具表里一行都没有的工具名 */
export function undocumentedTools(rows: readonly ToolRow[], inCode: readonly string[]): string[] {
  const documented = new Set(rows.flatMap((r) => r.tools));
  return inCode.filter((name) => !documented.has(name));
}

// ---------- 守护进程、网页的记忆文件都写进了文档 ----------

/** 要求文档写到的目录（仓库根开始）：守护进程的记忆插件、网页的记忆插件 */
export const COVERED_DIRS: readonly string[] = ["packages/daemon/src/memory", "packages/web/src/plugins/memory"];

/** 这些目录下（不往下钻）完整路径没在文档里出现的源文件 */
export function uncoveredFiles(md: string, dirs: readonly string[] = COVERED_DIRS): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(path.join(REPO, dir)).toSorted()) {
      if (!/\.tsx?$/.test(name) || name.endsWith(".d.ts")) continue;
      const rel = `${dir}/${name}`;
      // 后面紧跟字母数字的不算（plugin.ts 不能借 plugin.tsx 的光）
      if (!new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(md)) out.push(rel);
    }
  }
  return out;
}

// ---------- mermaid ----------

const FLOW_SKIP = /^(?:%%|end$|classDef\s|class\s|style\s|linkStyle\s|direction\s)/;
const QUOTED_SHAPE = /(\[\(|\(\[|\[\[|\(\(|\{\{|\[|\(|\{)""(\)\]|\]\)|\]\]|\)\)|\}\}|\]|\)|\})/g;
const SEQ_MESSAGE = /(?:-->>|->>|-->|->|--x|-x|--\)|-\))/;

/** mermaid 图里违反硬规矩的地方 */
export function mermaidProblems(md: string): string[] {
  const out: string[] = [];
  const blocks = [...md.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)];
  blocks.forEach((b, n) => {
    const lines = b[1]!.split(/\r?\n/).map((l) => l.trim());
    const kind = lines.find((l) => l !== "") ?? "";
    const where = (l: string) => `第 ${n + 1} 张图「${l}」`;
    if (/^(?:flowchart|graph)\b/.test(kind)) {
      for (const l of lines.slice(lines.indexOf(kind) + 1)) {
        if (l === "" || FLOW_SKIP.test(l)) continue;
        if ((l.match(/"/g) ?? []).length % 2 !== 0) {
          out.push(`${where(l)}：引号没配对`);
          continue;
        }
        const rest = l.replace(/"[^"]*"/g, '""').replace(QUOTED_SHAPE, "").replace(/\|""\|/g, "");
        if (/[[\](){}|]/.test(rest)) out.push(`${where(l)}：节点名或连线上的字没加引号`);
        if (/(?:^|[\s>])end\s*[[({]/.test(l)) out.push(`${where(l)}：end 不能当节点 id`);
      }
    } else if (kind === "sequenceDiagram") {
      for (const l of lines.slice(lines.indexOf(kind) + 1)) {
        const isText = /^Note\s/.test(l) || (SEQ_MESSAGE.test(l) && l.includes(":"));
        const isParticipant = /^(?:participant|actor)\s/.test(l);
        const text = isText ? l.slice(l.indexOf(":") + 1) : isParticipant ? l : "";
        if (/[;#]/.test(text)) out.push(`${where(l)}：时序图里不要分号、井号`);
      }
    } else {
      out.push(`第 ${n + 1} 张图：只用 flowchart 和 sequenceDiagram（"${kind}"）`);
    }
  });
  return out;
}

// ---------- 测试 ----------

describe("docs/memory-system.md 和代码对得上", () => {
  const md = docForChecks(fs.readFileSync(DOC, "utf8"));
  const parsed = parseInterfaceTables(md);

  it("接口表的格式写对了", () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.tables).toBeGreaterThanOrEqual(10);
    expect(parsed.rows.filter((r) => r.checked).length).toBeGreaterThan(300);
  });

  it("✅、🧪 行的名字在写明的文件里找得到（记忆包的还要是包入口的导出）", () => {
    expect(parsed.rows.flatMap(checkRow)).toEqual([]);
  });

  it("工具表的格式写对了，✅、🧪 行的工具名在写明的文件里找得到", () => {
    const tools = parseToolTables(md);
    expect(tools.problems).toEqual([]);
    expect(tools.tables).toBeGreaterThanOrEqual(1);
    expect(tools.rows.flatMap(checkToolRow)).toEqual([]);
  });

  it("守护进程里记忆的工具名（tool-names.ts、CURATOR_TOOL_NAMES）都在工具表里", () => {
    const inCode = memoryToolNamesInCode();
    expect(inCode.length).toBeGreaterThanOrEqual(10);
    expect(undocumentedTools(parseToolTables(md).rows, inCode)).toEqual([]);
  });

  it("守护进程和网页的记忆插件下的每个源文件都写进了文档", () => {
    expect(uncoveredFiles(md)).toEqual([]);
  });

  it("文档里写的仓库路径都存在", () => {
    expect(missingPaths(md)).toEqual([]);
  });

  it("相对链接指向的文件都存在", () => {
    expect(missingLinks(md, path.dirname(DOC))).toEqual([]);
  });

  it("mermaid 图守住几条硬规矩", () => {
    expect(md.match(/```mermaid/g)?.length ?? 0).toBeGreaterThanOrEqual(20);
    expect(mermaidProblems(md)).toEqual([]);
  });
});

/** 拼一张接口表（自检用） */
function table(rows: string[]): string {
  return [TABLE_MARKER, `| ${TABLE_HEADER.join(" | ")} |`, "|---|---|---|---|---|", ...rows].join("\n");
}

describe("检查本身管用", () => {
  it("抓得到改错的名字、成员、文件、没从包入口转出的名字；📋 的行不查", () => {
    const { rows, problems } = parseInterfaceTables(
      table([
        "| 🧪 | `MemoryEngine.reflect` | `packages/memory/src/engine.ts` | 对的 | 对的 |",
        "| 🧪 | `MemoryEngine.reflekt` | `packages/memory/src/engine.ts` | 成员写错 | — |",
        "| 🧪 | `MemoryEngin` | `packages/memory/src/engine.ts` | 名字写错 | — |",
        "| ✅ | `memoryPlugin.setup` | `packages/daemon/src/memory/nope.ts` | 文件不对 | — |",
        "| ✅ | `KERNEL.materials` | `packages/daemon/src/plugins/kernel.ts` | 对的 | — |",
        "| ✅ | `KERNEL.memories` | `packages/daemon/src/plugins/kernel.ts` | 成员写错 | — |",
        "| 🧪 | `runEval` | `packages/memory-eval/src/eval/run.ts` | 不经包入口，对的 | — |",
        "| 📋（198） | `runNightly` | — | 还没有 | — |",
      ]),
    );
    expect(problems).toEqual([]);
    const found = rows.map((r) => checkRow(r).length);
    expect(found).toEqual([0, 1, 1, 1, 0, 1, 0, 0]);
  });

  it("表格格式不对、状态写错都报出来", () => {
    const bad = [TABLE_MARKER, "| 接口 | 文件 |", "|---|---|"].join("\n");
    expect(parseInterfaceTables(bad).problems).toHaveLength(1);
    expect(parseInterfaceTables(table(["| 好了 | `x` | `packages/memory/src/engine.ts` | — | — |"])).problems).toHaveLength(1);
    expect(parseInterfaceTables(table(["| ✅ | `a.b.c` | `packages/memory/src/engine.ts` | — | — |"])).problems).toHaveLength(1);
  });

  it("工具表抓得到改错的工具名、不对的文件、表头写错；📋 的行不查；代码里有、表里没有的工具名报出来", () => {
    const toolTable = (rows: string[]) => [TOOL_MARKER, `| ${TOOL_HEADER.join(" | ")} |`, "|---|---|---|---|---|", ...rows].join("\n");
    const { rows, problems } = parseToolTables(
      toolTable([
        "| ✅ | `ask_memory` | 秘书 | `packages/daemon/src/memory/tool-names.ts` | 对的 |",
        "| ✅ | `ask_memery` | 秘书 | `packages/daemon/src/memory/tool-names.ts` | 名字写错 |",
        "| ✅ | `inspect_memory` | 记忆管理员 | `packages/daemon/src/memory/nope.ts` | 文件不对 |",
        "| ✅ | `remember`、`no_infer` | 秘书提议 | `packages/protocol/src/constants.ts` | 一格两个，对的 |",
        "| 📋 | `pick_question` | 秘书 | — | 还没有 |",
      ]),
    );
    expect(problems).toEqual([]);
    expect(rows.map((r) => checkToolRow(r).length)).toEqual([0, 1, 1, 0, 0]);
    expect(undocumentedTools(rows, ["ask_memory", "inspect_memory", "run_memory_consolidation"])).toEqual(["run_memory_consolidation"]);
    expect(parseToolTables([TOOL_MARKER, "| 工具 | 文件 |", "|---|---|"].join("\n")).problems).toHaveLength(1);
    expect(parseToolTables(toolTable(["| ✅ | `AskMemory` | 秘书 | `packages/daemon/src/memory/tool-names.ts` | — |"])).problems).toHaveLength(1);
  });

  it("认得出守护进程里记忆的工具名", () => {
    const names = memoryToolNamesInCode();
    for (const name of ["search_materials", "ask_memory", "ask_curator", "run_memory_consolidation", "review_memory_claim", "memory_questions"]) expect(names).toContain(name);
  });

  it("抓得到文档里没写到的记忆文件", () => {
    const all = uncoveredFiles("");
    expect(all).toContain("packages/daemon/src/memory/plugin.ts");
    expect(all).toContain("packages/web/src/plugins/memory/plugin.tsx");
    const md = fs.readFileSync(DOC, "utf8");
    expect(uncoveredFiles(md.replaceAll("packages/daemon/src/memory/privacy.ts", "privacy.ts"))).toEqual(["packages/daemon/src/memory/privacy.ts"]);
    // 只写了 plugin.tsx 不算写了 plugin.ts
    expect(uncoveredFiles("`packages/daemon/src/memory/plugin.tsx`", ["packages/daemon/src/memory"])).toContain("packages/daemon/src/memory/plugin.ts");
    expect(uncoveredFiles("`packages/daemon/src/memory/plugin.ts`", ["packages/daemon/src/memory"])).not.toContain("packages/daemon/src/memory/plugin.ts");
  });

  it("抓得到不存在的路径和链接", () => {
    expect(missingPaths("见 `packages/memory/src/engine.ts` 和 `packages/memory/src/nope.ts`、`docs/<x>.md`")).toEqual(["packages/memory/src/nope.ts"]);
    expect(missingLinks("[a](memory-architecture.md) [b](nope.md#x) [c](#1-全貌) [d](https://example.com)", path.dirname(DOC))).toEqual(["nope.md#x"]);
  });

  it("抓得到 mermaid 里没加引号的节点名、连线上的字和时序图里的分号", () => {
    const flow = "```mermaid\nflowchart LR\n  A[\"好的（括号）\"] -->|\"好的\"| B((\"好的\"))\n  C[坏的(括号)] --> D\n  E -->|坏的: 冒号| F\n  G[(\"数据库\")]\n```";
    expect(mermaidProblems(flow)).toHaveLength(2);
    const seq = "```mermaid\nsequenceDiagram\n  participant A as 甲\n  A->>B: 好的，没问题\n  B-->>A: 坏的; 分号\n```";
    expect(mermaidProblems(seq)).toHaveLength(1);
    expect(mermaidProblems("```mermaid\npie\n```")).toHaveLength(1);
  });
});
