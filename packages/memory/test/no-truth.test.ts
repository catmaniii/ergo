// 190 号票：隐藏答案（评测数据的 truth/）只有评测代码能读。检索、推理、抽取的代码里不准出现对它的引用，
// 也不准 import 评测模块（免得绕一道拿到答案）。只看代码，不看注释（注释里写"不读 truth"是允许的）。
// 326 号票起评测、演示和评测数据在另一个包（packages/memory-eval），这个包的 src/ 里一个评测文件都没有：整个 src/ 都查，
// import 那个包也算违规。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** 去掉注释，字符串和模板字符串原样留着 */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i += 1;
  }
  return out;
}

/** 一段代码里违规的地方：提到 truth，或者 import 评测模块 */
export function violations(code: string): string[] {
  const body = stripComments(code);
  const found: string[] = [];
  for (const m of body.matchAll(/truth/gi)) found.push(`引用了 ${body.slice(Math.max(0, m.index - 20), m.index + 20).trim()}`);
  for (const m of body.matchAll(/(?:from\s*|import\s*\(\s*)["'`]([^"'`]*(?:\/eval\/|memory-eval)[^"'`]*)["'`]/g)) found.push(`import 了评测模块 ${m[1]}`);
  return found;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(full);
    return /\.(ts|js|mjs|cjs|json)$/.test(d.name) ? [full] : [];
  });
}

describe("隐藏答案只有评测代码能读", () => {
  it("src/ 里没有评测文件，没有文件引用 truth，也没有文件 import 评测模块", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => path.relative(SRC, f).split(path.sep).includes("eval"))).toEqual([]);
    const problems = files.flatMap((f) => violations(fs.readFileSync(f, "utf8")).map((v) => `${path.relative(SRC, f)}：${v}`));
    expect(problems).toEqual([]);
  });

  it("检查本身管用：读答案文件、拼路径、import 评测模块都抓得到；注释里提到不算", () => {
    expect(violations(`const t = fs.readFileSync("../../fixtures/truth/truth.json", "utf8");`)).toHaveLength(2);
    expect(violations("const dir = path.join(root, `fixtures`, 'TRUTH');")).toHaveLength(1);
    expect(violations(`import { loadTruth } from "../eval/truth.ts";`).length).toBeGreaterThan(0);
    expect(violations(`const m = await import("../eval/run.ts");`)).toHaveLength(1);
    expect(violations(`import { runEval } from "@ergo/memory-eval";`)).toHaveLength(1);
    expect(violations(`// 不读 truth/\n/* truth 只给评测 */\nconst url = "https://example.com"; // truth`)).toEqual([]);
  });
});
