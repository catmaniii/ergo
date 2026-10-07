// ADR-0001 / ADR-0004：pi 只出现在 agent 子进程里（packages/daemon/src/runtime/agent-child/）。
// 规则：
// 1. agent-child/ 之外（runtime/ 的其余文件、守护进程上层、其他包、测试）不许出现对 @earendil-works 作用域的引用，
//    静态 import、import type、动态 import()、typeof import() 都算；
// 2. 任何地方都不许转导出 pi 的东西：`export ... from "@earendil-works/..."`，
//    以及 agent-child/ 里把从 pi 导入的名字原样 `export { ... }` 出去；
// 3. agent-child/ 之外不许 import agent-child/ 里的模块（否则 pi 的类型会顺着函数签名漏出来）；
//    子进程入口只由 agent-process.ts 按路径拉起。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const CHILD_DIR = "packages/daemon/src/runtime/agent-child/";
const SELF = "packages/daemon/test/pi-boundary.test.ts";
const SOURCE_EXT = /\.(c|m)?(t|j)sx?$/;
const PI_REFERENCE = /@earendil-works\//;
const PI_REEXPORT = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']@earendil-works\//;
const PI_IMPORT = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s*["']@earendil-works\/[^"']+["']/g;
const LOCAL_EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g;
const CHILD_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["'][^"']*agent-child\//;

interface SourceFile {
  /** 相对仓库根目录、用 / 分隔的路径 */
  path: string;
  content: string;
}

/** 按上面三条规则检查，返回违规说明 */
function findPiBoundaryViolations(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const inChild = file.path.startsWith(CHILD_DIR);
    if (!inChild && PI_REFERENCE.test(file.content)) violations.push(`${file.path}: agent-child/ 之外引用了 pi`);
    if (PI_REEXPORT.test(file.content)) violations.push(`${file.path}: 转导出了 pi 的东西`);
    if (inChild) {
      const piNames = importedNames(file.content);
      for (const match of file.content.matchAll(LOCAL_EXPORT_LIST)) {
        const exported = splitNames(match[1]!).map((n) => n.local);
        const leaked = exported.filter((name) => piNames.has(name));
        if (leaked.length > 0) violations.push(`${file.path}: 转导出了从 pi 导入的 ${leaked.join("、")}`);
      }
    } else if (CHILD_IMPORT.test(file.content)) {
      violations.push(`${file.path}: agent-child/ 之外 import 了 agent-child/ 里的模块`);
    }
  }
  return violations;
}

/** 从 pi 导入的本地名字（具名、默认、命名空间导入都算） */
function importedNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(PI_IMPORT)) {
    const clause = match[1]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const { local } of splitNames(braces[1]!)) names.add(local);
    const namespace = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (namespace) names.add(namespace[1]!);
    const defaultName = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
    if (defaultName && defaultName[1] !== "type") names.add(defaultName[1]!);
  }
  return names;
}

function splitNames(list: string): Array<{ local: string }> {
  return list
    .split(",")
    .map((item) => item.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map((item) => ({ local: item.split(/\s+as\s+/)[0]!.trim() }));
}

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listSourceFiles(full);
    return SOURCE_EXT.test(entry.name) ? [full] : [];
  });
}

describe("pi 封装边界", () => {
  it("仓库里的源码和测试都守着边界", () => {
    const packagesDir = path.join(repoRoot, "packages");
    const files = fs
      .readdirSync(packagesDir)
      .flatMap((pkg) => ["src", "test"].flatMap((sub) => listSourceFiles(path.join(packagesDir, pkg, sub))))
      .map((full) => ({ path: path.relative(repoRoot, full).replaceAll("\\", "/"), content: fs.readFileSync(full, "utf8") }))
      // 本文件里的反例是故意写的，不算
      .filter((file) => file.path !== SELF);
    expect(files.some((f) => f.path.startsWith(CHILD_DIR) && PI_REFERENCE.test(f.content))).toBe(true);
    expect(findPiBoundaryViolations(files)).toEqual([]);
  });

  // 反例：确认上面的检查真能抓到这些写法
  const pi = "@earendil-works";
  it.each([
    ["守护进程上层的静态 import", "packages/daemon/src/daemon.ts", `import { x } from "${pi}/pi-ai";`],
    ["runtime/ 里非子进程文件的 import type", "packages/daemon/src/runtime/host-protocol.ts", `import type { Model } from "${pi}/pi-ai";`],
    ["runtime/index.ts 转导出", "packages/daemon/src/runtime/index.ts", `export { createAgentSession } from "${pi}/pi-coding-agent";`],
    ["其他包里的 typeof import()", "packages/protocol/src/index.ts", `export type Pi = typeof import("${pi}/pi-ai");`],
    ["测试里的动态 import()", "packages/daemon/test/x.test.ts", `const m = await import("${pi}/pi-ai");`],
    ["agent-child 里 export type ... from", `${CHILD_DIR}session.ts`, `export type { AgentSession } from "${pi}/pi-coding-agent";`],
    ["agent-child 里 export * from", `${CHILD_DIR}faux.ts`, `export * from "${pi}/pi-ai";`],
    ["agent-child 里跨行的 export { } from", `${CHILD_DIR}faux.ts`, `export {\n  fauxProvider,\n  fauxText,\n} from "${pi}/pi-ai";`],
    [
      "agent-child 里先 import 再原样 export",
      `${CHILD_DIR}session.ts`,
      `import { type AgentSession, ModelRuntime } from "${pi}/pi-coding-agent";\nexport type { AgentSession };`,
    ],
    ["agent-child 之外 import 子进程模块", "packages/daemon/src/agent-manager/agent-manager.ts", `import { openAgentSession } from "../runtime/agent-child/session.ts";`],
  ])("反例：%s", (_name, filePath, content) => {
    expect(findPiBoundaryViolations([{ path: filePath, content }])).not.toEqual([]);
  });

  it("agent-child 里正常地 import pi、导出自己的东西，不算违规", () => {
    const content = `import { fauxProvider, type Model } from "${pi}/pi-ai";\nexport function registerFauxModel(): Model { return fauxProvider().getModel(); }\nconst helper = 1;\nexport { helper };`;
    expect(findPiBoundaryViolations([{ path: `${CHILD_DIR}faux.ts`, content }])).toEqual([]);
  });
});
