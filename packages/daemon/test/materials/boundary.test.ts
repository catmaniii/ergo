// 素材模块的边界（规格第 4、15 节）：
// 1. materials.db 只有素材模块拿得到写入口：素材目录（src/materials/）之外不许引用 memory-db.ts，也不许自己拼 "materials.db" 去打开
//    （路径表 config/data-dir.ts 除外：素材库的位置和老名字都由 dataDirLayout() 给，那是唯一该拼它的地方）；
//    素材模块对外（Materials）只有读、检索和登记来源，不暴露连接；
// 2. transformers.js 只在工作线程的推理后端里引用（bge-m3-backend.ts），守护进程主线程不加载模型。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(import.meta.dirname, "../../src");

function sourceFiles(dir: string): Array<{ path: string; content: string }> {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => {
      const file = path.join(d.parentPath, d.name);
      return { path: path.relative(srcRoot, file).split(path.sep).join("/"), content: fs.readFileSync(file, "utf8") };
    });
}

/** 去掉注释（注释里提到 materials.db 不算） */
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("素材模块的边界", () => {
  const files = sourceFiles(srcRoot);

  it("素材目录之外没有代码引用 memory-db.ts 或用 \"materials.db\" 打开库（路径表 data-dir.ts 除外）", () => {
    const outside = files.filter((f) => !f.path.startsWith("materials/") && f.path !== "config/data-dir.ts");
    const violations = outside.filter((f) => /memory-db\.ts|["'`]materials\.db["'`]/.test(withoutComments(f.content))).map((f) => f.path);
    expect(violations).toEqual([]);
    // 检查本身有效：素材目录里确实有这样的引用
    expect(files.some((f) => f.path.startsWith("materials/") && /["'`]materials\.db["'`]/.test(f.content))).toBe(true);
  });

  it("素材模块对外的接口里没有库连接，也没有写素材的方法", () => {
    const facade = files.find((f) => f.path === "materials/materials.ts")!.content;
    const api = /export interface Materials \{[\s\S]*?\n\}/.exec(facade)![0];
    expect(api).toContain("searchKeyword(");
    expect(api).not.toMatch(/Database|insert|write|update|delete/i);
  });

  it("transformers.js 只在工作线程的推理后端里引用", () => {
    const users = files.filter((f) => /@huggingface\/transformers/.test(withoutComments(f.content))).map((f) => f.path);
    expect(users).toEqual(["materials/embedding/bge-m3-backend.ts"]);
    // 主线程这边只按路径把它交给工作线程，不 import 它
    expect(files.filter((f) => /from\s+["'][^"']*bge-m3-backend/.test(f.content)).map((f) => f.path)).toEqual([]);
  });
});
