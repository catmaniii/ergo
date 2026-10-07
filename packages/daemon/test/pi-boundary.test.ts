// ADR-0001：pi 的类型只出现在运行时封装层（packages/daemon/src/runtime/）里。
// 这条测试扫描全部包的源码和测试，运行时封装层之外不许出现对 @earendil-works 作用域下任何包的引用
// （静态 import、import type、动态 import()、typeof import() 都算）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const runtimeDir = path.join(repoRoot, "packages", "daemon", "src", "runtime");
// 正则里的斜杠转义过，所以本文件自己不会被扫到
const PI_IMPORT = /@earendil-works\//;
const SOURCE_EXT = /\.(c|m)?(t|j)sx?$/;

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listSourceFiles(full);
    return SOURCE_EXT.test(entry.name) ? [full] : [];
  });
}

describe("pi 封装边界", () => {
  it("运行时封装层之外的代码不引用 @earendil-works 作用域的包", () => {
    const packagesDir = path.join(repoRoot, "packages");
    const files = fs
      .readdirSync(packagesDir)
      .flatMap((pkg) => ["src", "test"].flatMap((sub) => listSourceFiles(path.join(packagesDir, pkg, sub))));
    expect(files.length).toBeGreaterThan(0);

    const offenders = files
      .filter((file) => !file.startsWith(runtimeDir + path.sep))
      .filter((file) => PI_IMPORT.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });
});
