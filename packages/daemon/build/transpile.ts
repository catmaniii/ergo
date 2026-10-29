// 把 TypeScript 源码转成 JS（318 号票：装好的程序不在用户机器上直接跑 .ts——npm 装的包在 node_modules 里，Node 不给那里的 .ts 剥类型）。
// 用 Node 自带的类型剥离（module.stripTypeScriptTypes，和开发时直接跑 .ts 是同一个剥离器），一个文件对一个文件、目录结构不变：
// 源码里按 import.meta.url 找的相对路径（prompts/、locales/、子进程入口 `./agent-child/main${ownExt}`）都照样对。
// 剥完再改引用：
//   - 相对路径的 "./x.ts" → "./x.js"（import、export from、动态 import、new URL("./worker.ts", import.meta.url)）；
//   - 工作区的包 "@ergo/protocol"、"@ergo/memory" → 指到 packages/<包>/src/index.js 的相对路径（装好的程序里不放 node_modules/@ergo 的联接）。
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

/** 工作区的包名 → 它的入口（相对程序目录） */
export const WORKSPACE_ENTRIES: Readonly<Record<string, string>> = {
  "@ergo/protocol": "packages/protocol/src/index.js",
  "@ergo/memory": "packages/memory/src/index.js",
};

/** 引号里的相对路径（以 ./ 或 ../ 开头、.ts 结尾）和工作区包名 */
const SPECIFIER = /(["'])((?:\.\.?\/)[^"'\n]*?\.ts|@ergo\/[a-z-]+)\1/g;

/**
 * 改一段（已经剥了类型的）代码里的引用。fileRel 是这个文件在程序目录里的位置（用 /），用来算到工作区包入口的相对路径。
 * 认不出的工作区包名抛错（别悄悄留着一个装好后找不到的引用）
 */
export function rewriteSpecifiers(code: string, fileRel: string): string {
  return code.replace(SPECIFIER, (_whole, quote: string, spec: string) => {
    if (spec.startsWith(".")) return `${quote}${spec.slice(0, -3)}.js${quote}`;
    const entry = WORKSPACE_ENTRIES[spec];
    if (!entry) throw new Error(`${fileRel} 引用了不认得的工作区包 ${spec}`);
    let rel = path.posix.relative(path.posix.dirname(fileRel), entry);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${quote}${rel}${quote}`;
  });
}

/** 转一个 .ts 文件的内容 */
export function transpileSource(code: string, fileRel: string): string {
  const stripped = stripTypeScriptTypes(code, { mode: "strip" });
  return rewriteSpecifiers(stripped, fileRel);
}

/** Node 22 剥类型时报一句 ExperimentalWarning：构建脚本里不用看它 */
export function quietStripWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /stripTypeScriptTypes|Type Stripping/i.test(warning.message)) return;
    for (const l of listeners) l(warning);
  });
}

export interface TranspileTreeOptions {
  /** 源目录（比如 <仓库>/packages/daemon/src） */
  from: string;
  /** 目标目录 */
  to: string;
  /** 源目录在程序目录里的位置（packages/daemon/src） */
  rel: string;
  /** 不要的（相对源目录，用 /） */
  skip?: (relPath: string) => boolean;
}

/** 转一整个目录：.ts（不含 .d.ts）转成 .js，别的文件原样复制。回写了几个文件 */
export function transpileTree(options: TranspileTreeOptions): { files: number; transpiled: number } {
  let files = 0;
  let transpiled = 0;
  const walk = (dir: string, relDir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (options.skip?.(rel)) continue;
      const src = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (entry.name.endsWith(".ts")) {
        const outRel = `${rel.slice(0, -3)}.js`;
        const out = path.join(options.to, ...outRel.split("/"));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, transpileSource(fs.readFileSync(src, "utf8"), `${options.rel}/${rel}`));
        transpiled++;
      } else {
        const out = path.join(options.to, ...rel.split("/"));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(src, out);
      }
      files++;
    }
  };
  walk(options.from, "");
  return { files, transpiled };
}
