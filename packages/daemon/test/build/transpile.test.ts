// 转 JS（318 号票）：剥类型用 Node 自带的；相对路径的 .ts 改成 .js，工作区包名改成到 packages/<包>/src/index.js 的相对路径。
import { describe, expect, it } from "vitest";
import { rewriteSpecifiers, transpileSource } from "../../build/transpile.ts";

describe("转 JS", () => {
  it("相对路径的 .ts → .js：import、export from、动态 import、new URL（Worker）", () => {
    const code = [
      'import { a } from "./a.ts";',
      "export * from '../b/index.ts';",
      'const m = await import("./daemon.ts");',
      'new Worker(new URL("./worker.ts", import.meta.url));',
      'const s = "./not-a-module.tsx";',
      'const ext = ".ts";',
    ].join("\n");
    expect(rewriteSpecifiers(code, "packages/daemon/src/main.ts")).toBe(
      [
        'import { a } from "./a.js";',
        "export * from '../b/index.js';",
        'const m = await import("./daemon.js");',
        'new Worker(new URL("./worker.js", import.meta.url));',
        'const s = "./not-a-module.tsx";',
        'const ext = ".ts";',
      ].join("\n"),
    );
  });

  it("工作区包名 → 相对路径（装好的程序里没有 node_modules/@ergo 的联接）；认不出的包名抛错", () => {
    expect(rewriteSpecifiers('import { t } from "@ergo/protocol";', "packages/daemon/src/cli/main.ts")).toBe('import { t } from "../../../protocol/src/index.js";');
    expect(rewriteSpecifiers('import { x } from "@ergo/memory";', "packages/daemon/src/daemon.ts")).toBe('import { x } from "../../memory/src/index.js";');
    expect(rewriteSpecifiers('import { y } from "@ergo/protocol";', "packages/memory/src/a/b.ts")).toBe('import { y } from "../../../protocol/src/index.js";');
    expect(() => rewriteSpecifiers('import "@ergo/web";', "packages/daemon/src/x.ts")).toThrow(/@ergo\/web/);
  });

  it("剥掉类型（和开发时直接跑 .ts 是同一个剥离器），引用跟着改", () => {
    const out = transpileSource(
      ['import type { A } from "./a.ts";', 'import { b, type C } from "./b.ts";', "export function f<T>(x: T, y?: C): T { return x as T; }", "const n: number = b;"].join("\n"),
      "packages/daemon/src/x.ts",
    );
    expect(out).not.toMatch(/import type|: number|<T>|as T/);
    expect(out).toContain('import { b,        } from "./b.js";');
    expect(out).toMatch(/export function f\s*\(x\s*,\s*y\s*\)\s*\{ return x\s*; \}/);
    expect(out).toMatch(/const n\s*= b;/);
    // 不带指回 .ts 的 sourceURL（装好的程序里没有 .ts）
    expect(out).not.toContain("sourceURL");
  });
});
