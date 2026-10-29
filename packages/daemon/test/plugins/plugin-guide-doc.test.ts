// 215 号票：插件开发手册（docs/guides/plugin-development.md）和给 agent 用的 skill（.claude/skills/ergo-plugin/SKILL.md）跟代码对得上。
// 照 @ergo/memory 的 architecture-doc.test.ts（197 号票）的做法，只读文件、不跑代码，用正则认声明。查五样：
// 1. 代码片段：手册里每个 ts / tsx 代码块前面一行写着 <!-- 摘自 <仓库里的路径> -->，块里每一行（去掉首尾空白、空行不算，
//    单独一行的 "// …" 是省略号）按先后都在那个文件里找得到。没写摘自哪里的 ts / tsx 代码块算错（手册里不放编的代码）。
// 2. 名字表：每张前面写着 <!-- 名字表 --> 的表（表头"名字、文件、说明"），名字格里每个反引号名字（"名字"或"名字.成员"）在写明的文件里
//    声明着，"名字.成员"的成员在这个名字的声明块里。
// 3. 讲全了：插件的定义、两边宿主给插件的上下文、数据契约、"连数据删"、网页的插槽表，它们的每个成员手册里都用反引号提到过——
//    宿主加了能登记的东西而手册没写，这里就红。
// 4. 手册和 skill 里反引号括起来的仓库路径（packages/、docs/、.scratch/、.claude/ 开头的）都存在；
// 5. 相对链接指向的文件都存在。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const GUIDE = path.join(REPO, "docs", "guides", "plugin-development.md");
const SKILL = path.join(REPO, ".claude", "skills", "ergo-plugin", "SKILL.md");

/** 手册要讲全的接口：文件 → 接口（或常量）名 */
const COVERED: ReadonlyArray<{ file: string; name: string }> = [
  { file: "packages/daemon/src/plugins/host.ts", name: "PluginDefinition" },
  { file: "packages/daemon/src/plugins/host.ts", name: "PluginContext" },
  { file: "packages/daemon/src/plugins/host.ts", name: "ContractContext" },
  { file: "packages/daemon/src/plugins/removal.ts", name: "PluginDataRemoval" },
  { file: "packages/web/src/plugins/host.ts", name: "WebPluginDefinition" },
  { file: "packages/web/src/plugins/host.ts", name: "WebPluginContext" },
  { file: "packages/web/src/plugins/slots.ts", name: "SlotMap" },
];

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

const lines = (text: string) => text.split(/\r?\n/);

// ---------- 1. 代码片段 ----------

export const EXCERPT_MARKER = /^<!--\s*摘自\s+(\S+)\s*-->$/;
/** 单独一行的省略号：摘录里跳过的部分 */
const ELLIPSIS = /^\/\/\s*…$/;

export interface CodeBlock {
  /** 开头那一行的行号（从 1 起） */
  line: number;
  lang: string;
  body: string[];
  /** 前面一行写的"摘自"；没写是 undefined */
  source: string | undefined;
}

export function codeBlocks(md: string): CodeBlock[] {
  const all = lines(md);
  const out: CodeBlock[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const open = /^\s*```(\S*)\s*$/.exec(all[i]!);
    if (!open) continue;
    const start = i;
    const body: string[] = [];
    for (i += 1; i < all.length && !/^\s*```\s*$/.test(all[i]!); i += 1) body.push(all[i]!);
    const marker = EXCERPT_MARKER.exec((all[start - 1] ?? "").trim());
    out.push({ line: start + 1, lang: open[1]!, body, source: marker?.[1] });
  }
  return out;
}

/** 一个代码块的问题：ts / tsx 要写明摘自哪里，每一行按先后在那个文件里找得到 */
export function excerptProblems(block: CodeBlock): string[] {
  if (!/^(?:ts|tsx|typescript)$/.test(block.lang)) return [];
  const where = `第 ${block.line} 行的代码块`;
  if (block.source === undefined) return [`${where}：前面一行没写 <!-- 摘自 <路径> -->`];
  if (!fs.existsSync(path.join(REPO, block.source))) return [`${where}：摘自的 ${block.source} 不存在`];
  const code = lines(read(block.source)).map((l) => l.trim());
  let at = 0;
  for (const raw of block.body) {
    const want = raw.trim();
    if (want === "" || ELLIPSIS.test(want)) continue;
    const found = code.indexOf(want, at);
    if (found < 0) return [`${where}：「${want}」在 ${block.source} 里找不到（或者先后不对）`];
    at = found + 1;
  }
  return [];
}

// ---------- 2. 名字表 ----------

export const TABLE_MARKER = "<!-- 名字表 -->";
const TABLE_HEADER = ["名字", "文件", "说明"];
const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/;

function cellsOf(line: string): string[] | undefined {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return undefined;
  return t
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

const ticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** 去掉代码块（围栏里的反引号会把行内代码的配对错开） */
const prose = (md: string) => md.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, "");

export interface NameRow {
  line: number;
  names: string[];
  file: string | undefined;
}

export function parseNameTables(md: string): { tables: number; rows: NameRow[]; problems: string[] } {
  const all = lines(md);
  const rows: NameRow[] = [];
  const problems: string[] = [];
  let tables = 0;
  for (let i = 0; i < all.length; i += 1) {
    if (all[i]!.trim() !== TABLE_MARKER) continue;
    tables += 1;
    let j = i + 1;
    while (j < all.length && all[j]!.trim() === "") j += 1;
    if (cellsOf(all[j] ?? "")?.join("|") !== TABLE_HEADER.join("|")) {
      problems.push(`第 ${j + 1} 行：名字表的表头应该是 | ${TABLE_HEADER.join(" | ")} |`);
      continue;
    }
    for (let k = j + 2; k < all.length; k += 1) {
      const cells = cellsOf(all[k]!);
      if (!cells) break;
      const where = `第 ${k + 1} 行`;
      if (cells.length !== TABLE_HEADER.length) {
        problems.push(`${where}：应该是 ${TABLE_HEADER.length} 列，实际 ${cells.length} 列`);
        continue;
      }
      const names = ticked(cells[0]!);
      const files = ticked(cells[1]!);
      if (names.length === 0) problems.push(`${where}：名字格里没有反引号括起来的名字`);
      for (const n of names) if (!NAME.test(n)) problems.push(`${where}：名字"${n}"不是"名字"或"名字.成员"的写法`);
      if (files.length !== 1) problems.push(`${where}：文件格里要有且只有一个反引号括起来的路径`);
      rows.push({ line: k + 1, names, file: files[0] });
    }
  }
  return { tables, rows, problems };
}

const DECL = String.raw`^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+`;

/** 名字顶格声明的那一行；找不到是 -1 */
function declarationLine(code: string, name: string): number {
  const re = new RegExp(`${DECL}${name.replace(/\$/g, "\\$")}\\b`);
  return lines(code).findIndex((l) => re.test(l));
}

/** 声明块：从声明那一行到第一行顶格的 } 或 ]（声明那一行就收尾的只有它自己） */
function blockOf(code: string, declLine: number): string[] {
  const all = lines(code);
  const first = all[declLine] ?? "";
  if (!/[{([]\s*$/.test(first) && /;\s*$/.test(first)) return [first];
  const block = [first];
  for (let i = declLine + 1; i < all.length; i += 1) {
    block.push(all[i]!);
    if (/^[}\])]/.test(all[i]!)) break;
  }
  return block;
}

const MODIFIERS = String.raw`(?:(?:readonly|static|async|private|public|protected|get|set|override|declare)\s+)*`;

function hasMember(block: readonly string[], member: string): boolean {
  const re = new RegExp(String.raw`^\s+${MODIFIERS}["']?${member.replace(/\$/g, "\\$")}["']?\??\s*[(:<=,]`);
  return block.slice(1).some((l) => re.test(l));
}

/** 名字表一行的问题 */
export function checkNameRow(row: NameRow): string[] {
  const where = `第 ${row.line} 行`;
  if (!row.file) return [`${where}：没写文件`];
  if (!fs.existsSync(path.join(REPO, row.file))) return [`${where}：文件 ${row.file} 不存在`];
  const code = read(row.file);
  const problems: string[] = [];
  for (const full of row.names) {
    const [name, member] = full.split(".") as [string, string | undefined];
    const line = declarationLine(code, name);
    if (line < 0) {
      problems.push(`${where}：${row.file} 里没有声明 ${name}`);
      continue;
    }
    if (member !== undefined && !hasMember(blockOf(code, line), member)) problems.push(`${where}：${row.file} 里 ${name} 没有成员 ${member}`);
  }
  return problems;
}

// ---------- 3. 讲全了 ----------

/** 接口（或常量对象）顶层的成员名：声明块里缩进两格的那几行 */
export function membersOf(code: string, name: string): string[] {
  const line = declarationLine(code, name);
  if (line < 0) return [];
  const re = new RegExp(String.raw`^  ${MODIFIERS}["']?([A-Za-z_$][\w$]*)["']?\??\s*[(:<]`);
  return [...new Set(blockOf(code, line).flatMap((l) => re.exec(l)?.[1] ?? []))];
}

/** 文档里没用反引号提到过的成员 */
export function uncoveredMembers(md: string, members: readonly string[]): string[] {
  const spans = ticked(prose(md));
  return members.filter((m) => !spans.some((s) => new RegExp(String.raw`(?:^|[^\w$])${m.replace(/\$/g, "\\$")}(?:$|[^\w$])`).test(s)));
}

// ---------- 4、5. 路径和链接 ----------

/** 反引号括起来的仓库路径中不存在的 */
export function missingPaths(md: string): string[] {
  const out: string[] = [];
  for (const m of prose(md).matchAll(/`((?:packages|docs|\.scratch|\.claude)\/[^`\s]*)`/g)) {
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

// ---------- 测试 ----------

describe("插件开发手册和代码对得上", () => {
  const md = fs.readFileSync(GUIDE, "utf8");

  it("代码片段都摘自真代码：写明摘自哪里，每一行按先后在那个文件里找得到", () => {
    const blocks = codeBlocks(md);
    expect(blocks.filter((b) => b.source !== undefined).length).toBeGreaterThanOrEqual(10);
    expect(blocks.flatMap(excerptProblems)).toEqual([]);
  });

  it("名字表里的名字在写明的文件里声明着（成员在声明块里）", () => {
    const parsed = parseNameTables(md);
    expect(parsed.problems).toEqual([]);
    expect(parsed.tables).toBeGreaterThanOrEqual(1);
    expect(parsed.rows.length).toBeGreaterThanOrEqual(15);
    expect(parsed.rows.flatMap(checkNameRow)).toEqual([]);
  });

  it("讲全了：插件的定义、两边宿主给的上下文、数据契约、连数据删、网页的插槽，每个成员都提到过", () => {
    const missing = COVERED.flatMap(({ file, name }) => {
      const members = membersOf(read(file), name);
      expect(members.length, `${file} 的 ${name}`).toBeGreaterThan(0);
      return uncoveredMembers(md, members).map((m) => `${name}.${m}`);
    });
    expect(missing).toEqual([]);
  });

  it("手册里写的仓库路径、相对链接都存在", () => {
    expect(missingPaths(md)).toEqual([]);
    expect(missingLinks(md, path.dirname(GUIDE))).toEqual([]);
  });

  it("skill 指向手册，写的路径、链接都存在", () => {
    const skill = fs.readFileSync(SKILL, "utf8");
    expect(skill).toMatch(/^---\r?\nname: ergo-plugin\r?\ndescription: .+\r?\n---\r?\n/);
    expect(skill).toContain("docs/guides/plugin-development.md");
    expect(missingPaths(skill)).toEqual([]);
    expect(missingLinks(skill, path.dirname(SKILL))).toEqual([]);
  });
});

describe("检查本身管用", () => {
  it("抓得到没写摘自哪里的、文件不在的、改了一个字的、先后颠倒的；省略号和空行不算；bash 块不查", () => {
    const md = [
      "<!-- 摘自 packages/daemon/src/plugins/kernel.ts -->",
      "```ts",
      "export const KERNEL = {",
      "  // …",
      "  store: serviceKey<EventStore>(\"store\"),",
      "",
      "```",
      "```ts",
      "const 编的 = 1;",
      "```",
      "<!-- 摘自 packages/daemon/src/plugins/nope.ts -->",
      "```ts",
      "x",
      "```",
      "<!-- 摘自 packages/daemon/src/plugins/kernel.ts -->",
      "```ts",
      "  store: serviceKey<EventStore>(\"stor\"),",
      "```",
      "<!-- 摘自 packages/daemon/src/plugins/kernel.ts -->",
      "```ts",
      "  store: serviceKey<EventStore>(\"store\"),",
      "  config: serviceKey<ErgoConfig>(\"config\"),",
      "```",
      "```bash",
      "npm run lint",
      "```",
    ].join("\n");
    expect(codeBlocks(md).map((b) => excerptProblems(b).length)).toEqual([0, 1, 1, 1, 1, 0]);
  });

  it("名字表：抓得到改错的名字、成员、文件", () => {
    const md = [
      TABLE_MARKER,
      "| 名字 | 文件 | 说明 |",
      "|---|---|---|",
      "| `PluginContext.agent` | `packages/daemon/src/plugins/host.ts` | 对的 |",
      "| `PluginContext.agnet` | `packages/daemon/src/plugins/host.ts` | 成员写错 |",
      "| `KERNEL.store`、`serviceKey` | `packages/daemon/src/plugins/kernel.ts` | 后一个不在这个文件里 |",
      "| `KERNEL.store` | `packages/daemon/src/plugins/nope.ts` | 文件不对 |",
    ].join("\n");
    const { rows, problems } = parseNameTables(md);
    expect(problems).toEqual([]);
    expect(rows.map((r) => checkNameRow(r).length)).toEqual([0, 1, 1, 1]);
  });

  it("讲全了：认得出接口顶层的成员，抓得到没提到的", () => {
    const members = membersOf(read("packages/daemon/src/plugins/host.ts"), "PluginLifecycle");
    expect(members).toEqual(["start", "stop"]);
    expect(uncoveredMembers("写 `ctx.lifecycle({ start })`", members)).toEqual(["stop"]);
  });

  it("抓得到不存在的路径和链接", () => {
    expect(missingPaths("`packages/daemon/src/plugins/host.ts`、`packages/daemon/src/plugins/nope.ts`、`docs/<x>.md`")).toEqual(["packages/daemon/src/plugins/nope.ts"]);
    expect(missingLinks("[a](../developer-guide.md) [b](nope.md#x) [c](#一) [d](https://example.com)", path.dirname(GUIDE))).toEqual(["nope.md#x"]);
  });
});
