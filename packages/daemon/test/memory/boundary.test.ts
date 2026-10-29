// 记忆插件的边界（129 号票，ADR-0027，照提醒插件的 test/reminders/boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现记忆插件：只按插件清单装；采成素材（素材库的 collect）、记忆命令、记忆删除卡、秘书的素材检索都不在这里；
//    242 号票起组合根会 import memory/api.ts 里的服务名（MEMORY_NIGHTLY：记忆管理员要用每晚整理，经插件宿主按名字取），
//    api.ts 是插件对外的接口（ADR-0027：别的模块只从这里拿），实现照旧不在这里；
// 2. 记忆插件的内部（plugin.ts、memory-commands.ts、search-tool.ts、prompt.ts、ask-tool.ts、context.ts、engine-provider.ts，
//    284 号票加了 interview.ts：了解你访谈的记录和发起，网关、组合根只从 api.ts 拿它的服务名和类型）
//    在 memory/ 之外只有插件清单 import（列它），
//    别的模块要记忆插件的东西只从 memory/api.ts 拿；memory/index.ts 只导出内核这一侧的（彻底删除、批量删除、项目内部记录）；
// 3. 开始采成素材只在记忆插件里。
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

/** 去掉注释（注释里提到不算） */
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** 记忆插件的内部文件 */
const INTERNAL = ["memory/plugin.ts", "memory/memory-commands.ts", "memory/search-tool.ts", "memory/prompt.ts", "memory/ask-tool.ts", "memory/context.ts", "memory/engine-provider.ts", "memory/interview.ts"];

/** 写明的例外：谁 → 记忆插件的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → memory/plugin.ts"];

describe("记忆插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现记忆插件（采成素材、记忆命令、记忆删除卡、素材检索）；只 import 它对外的 api.ts", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/memoryPlugin|memoryCommandExecutors|memoryDeleteCardType|searchMaterialsTool|search_materials|SEARCH_MATERIALS|\.collect\(/);
    // api.ts 是插件对外的接口（242 号票起组合根从这里取服务名）；实现文件一个都不 import
    expect(root).not.toMatch(/from\s+["']\.\/memory\/(plugin|memory-commands|search-tool|prompt)\.ts["']/);
    expect([...root.matchAll(/from\s+["']\.\/memory\/([a-z-]+)\.ts["']/g)].map((m) => m[1])).toContain("api");
    expect(root).toContain("PLUGIN_MANIFEST");
  });

  it("记忆插件的内部在 memory/ 之外只有插件清单 import（例外写明），memory/index.ts 不转出它们", () => {
    const imports = files
      .filter((f) => !f.path.startsWith("memory/"))
      .flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']*memory\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`));
    expect(imports.filter((i) => INTERNAL.some((file) => i.endsWith(`→ ${file}`)) && !ALLOWED.includes(i))).toEqual([]);
    // 检查本身有效：确实有经插件清单 import 的
    expect(imports).toContain("plugins/manifest.ts → memory/plugin.ts");
    const index = withoutComments(files.find((f) => f.path === "memory/index.ts")!.content);
    expect(index).not.toMatch(/memory-commands|search-tool|plugin|prompt/);
  });

  it("开始采成素材只在记忆插件里", () => {
    const callers = files.filter((f) => !f.path.startsWith("materials/") && /\.collect\(\{?/.test(withoutComments(f.content))).map((f) => f.path);
    expect(callers).toEqual(["memory/plugin.ts"]);
  });
});
