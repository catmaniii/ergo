// 「角色与权限」（docs/roles-and-permissions.md 和英文的 .en.md）跟代码对得上。照 plugins/plugin-guide-doc.test.ts 的做法，只读文件、不跑代码。查这几样：
// 1. 依据：表格里"依据"（英文"Code"）那一栏、行里"依据："（英文"Code: "）后面的部分，每个反引号名字前面都写了文件。
// 2. 路径和名字：整篇（代码块外）反引号括起来的路径都存在（不写包名的在 packages/daemon/src/ 下）；同一格、同一行里跟在路径后面的
//    反引号名字在那个文件里出现过（整词）。改名、挪了文件、删了函数，这里就红，提醒回来改这篇。
// 3. 工具名："每种 agent 拿到的工具"那一节里（依据以外），反引号括起来的工具名在守护进程源码里以字符串 "名字" 出现过。
// 4. 秘书的工具清单：两篇里 <!-- secretary-tools --> 后面的代码块，和 test/main/reminders.test.ts 断言的秘书工具清单逐个一致、连先后。
//    给秘书加了工具，那条集成测试要改，这篇也要跟着改。
// 5. 中英两篇的依据一样（路径和名字的对，不看先后）：两篇内容一致的最低限度。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const DAEMON_SRC = path.join(REPO, "packages", "daemon", "src");
const DOCS = [
  { file: "docs/roles-and-permissions.md", marker: "依据：", column: "依据", toolsHeading: "## 每种 agent 拿到的工具", head: "以代码为准，改实现请同步改这篇" },
  { file: "docs/roles-and-permissions.en.md", marker: "Code: ", column: "Code", toolsHeading: "## Tools each agent gets", head: "The code is the source of truth" },
] as const;
type Doc = (typeof DOCS)[number];

const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const ticks = (text: string) => Array.from(text.matchAll(/`([^`]+)`/g), (m) => m[1]!);

/** 依据里写的路径：不写包名的在守护进程的 src 下 */
const PATH_TOKEN = /^[\w.-]+(?:\/[\w.-]+)*\.(?:ts|tsx|mjs|json|md)$/;
const NAME_TOKEN = /^[A-Za-z_$][\w$]*$/;
const repoPath = (token: string) => (token.startsWith("packages/") ? token : `packages/daemon/src/${token}`);

interface Piece {
  line: number;
  text: string;
}

/** 代码块外的每一行：表格行按格拆开（一格一段），别的一行一段 */
function piecesOf(md: string): Array<Piece & { row?: string[]; header?: boolean }> {
  const all = md.split(/\r?\n/);
  const out: Array<Piece & { row?: string[]; header?: boolean }> = [];
  let fenced = false;
  all.forEach((raw, i) => {
    if (raw.startsWith("```")) fenced = !fenced;
    if (fenced || raw.startsWith("```")) return;
    const line = raw.trim();
    if (!line.startsWith("|")) return out.push({ line: i + 1, text: raw });
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim());
    if (/^-+$/.test(cells[0] ?? "")) return;
    const header = /^\|\s*-/.test(all[i + 1]?.trim() ?? "");
    for (const cell of cells) out.push({ line: i + 1, text: cell, row: cells, header });
  });
  return out;
}

/** 一篇里的依据片段：最后一栏叫"依据"的表的那一栏、行里标记后面的部分 */
function evidenceOf(doc: Doc, md: string): Piece[] {
  const out: Piece[] = [];
  let column = false;
  let lastRow: string[] | undefined;
  for (const piece of piecesOf(md)) {
    if (piece.row) {
      if (piece.row !== lastRow) {
        lastRow = piece.row;
        if (piece.header) column = piece.row.at(-1) === doc.column;
        else if (column) out.push({ line: piece.line, text: piece.row.at(-1) ?? "" });
      }
      continue;
    }
    column = false;
    lastRow = undefined;
    const at = piece.text.indexOf(doc.marker);
    if (at >= 0) out.push({ line: piece.line, text: piece.text.slice(at + doc.marker.length) });
  }
  return out;
}

/** 一段里的路径和跟在它后面的名字；strict 时名字前面没写路径记成错 */
function pairsIn(pieces: readonly Piece[], strict: boolean): { pairs: Array<{ line: number; file: string; name: string | null }>; orphans: string[] } {
  const pairs: Array<{ line: number; file: string; name: string | null }> = [];
  const orphans: string[] = [];
  for (const { line, text } of pieces) {
    let file: string | undefined;
    for (const token of ticks(text)) {
      if (PATH_TOKEN.test(token)) {
        file = repoPath(token);
        pairs.push({ line, file, name: null });
      } else if (NAME_TOKEN.test(token)) {
        if (file !== undefined) pairs.push({ line, file, name: token });
        else if (strict) orphans.push(`第 ${line} 行：\`${token}\` 前面没写文件`);
      }
    }
  }
  return { pairs, orphans };
}

/** 一节（从这个标题到下一个二级标题） */
function section(md: string, heading: string): string[] {
  const all = md.split(/\r?\n/);
  const start = all.findIndex((l) => l.trim() === heading);
  if (start < 0) return [];
  const end = all.findIndex((l, i) => i > start && l.startsWith("## "));
  return all.slice(start + 1, end < 0 ? undefined : end);
}

/** 守护进程源码全文（查工具名用） */
const daemonSource = (() => {
  let text: string | undefined;
  return (): string => {
    text ??= fs
      .readdirSync(DAEMON_SRC, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join(DAEMON_SRC, f), "utf8"))
      .join("\n");
    return text;
  };
})();

/** reminders.test.ts 里断言的秘书工具清单（"[tool] read" 起，到这个数组结束） */
function secretaryToolsInTest(): string[] {
  const test = read("packages/daemon/test/main/reminders.test.ts");
  const start = test.indexOf('"[tool] read",');
  const end = test.indexOf("]);", start);
  return Array.from(test.slice(start, end).matchAll(/"\[tool\] (\w+)"/g), (m) => m[1]!);
}

/** 篇里 <!-- secretary-tools --> 后面那个代码块的工具 */
function secretaryToolsInDoc(md: string): string[] {
  const all = md.split(/\r?\n/);
  const at = all.findIndex((l) => l.includes("<!-- secretary-tools"));
  if (at < 0) return [];
  const open = all.findIndex((l, i) => i > at && l.startsWith("```"));
  const close = all.findIndex((l, i) => i > open && l.startsWith("```"));
  return all
    .slice(open + 1, close)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
}

describe.each(DOCS)("$file", (doc) => {
  let text: string | undefined;
  const md = () => (text ??= read(doc.file));

  it("开头写着以代码为准", () => {
    expect(md().split(/\r?\n/).slice(0, 6).join("\n")).toContain(doc.head);
  });

  it("依据里的名字前面都写了文件", () => {
    const evidence = evidenceOf(doc, md());
    expect(evidence.length).toBeGreaterThan(50);
    expect(pairsIn(evidence, true).orphans).toEqual([]);
  });

  it("路径都在，跟在路径后面的名字在那个文件里出现过", () => {
    const { pairs } = pairsIn(piecesOf(md()), false);
    expect(pairs.filter((p) => p.name !== null).length).toBeGreaterThan(100);
    const problems = pairs.flatMap(({ line, file, name }) => {
      const full = path.join(REPO, file);
      if (!fs.existsSync(full)) return [`第 ${line} 行：${file} 不存在`];
      if (name === null) return [];
      const escaped = name.replaceAll("$", "\\$");
      return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(fs.readFileSync(full, "utf8")) ? [] : [`第 ${line} 行：${file} 里没有 ${name}`];
    });
    expect(problems).toEqual([]);
  });

  it("工具清单那一节里的工具名在守护进程源码里都有", () => {
    const body = section(md(), doc.toolsHeading);
    expect(body.length).toBeGreaterThan(0);
    const names = new Set(body.filter((l) => !l.includes(doc.marker)).flatMap((l) => ticks(l).filter((t) => /^[a-z][a-z0-9_]*$/.test(t))));
    expect(names.size).toBeGreaterThan(60);
    const source = daemonSource();
    expect([...names].filter((name) => !source.includes(`"${name}"`))).toEqual([]);
  });

  it("秘书的工具清单和 reminders.test.ts 断言的一致", () => {
    const expected = secretaryToolsInTest();
    expect(expected.length).toBeGreaterThan(40);
    expect(secretaryToolsInDoc(md())).toEqual(expected);
  });
});

/** 一篇的依据：路径和名字的对，排好序（中英两篇比对用） */
function evidenceKeys(doc: Doc): string[] {
  return pairsIn(evidenceOf(doc, read(doc.file)), true)
    .pairs.map((p) => `${p.file} ${p.name ?? ""}`)
    .toSorted();
}

describe("中英两篇", () => {
  it("依据一样（路径和名字的对）", () => {
    expect(evidenceKeys(DOCS[1])).toEqual(evidenceKeys(DOCS[0]));
  });
});
