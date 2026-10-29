// 提醒插件的边界（126 号票，ADR-0027）：
// 1. 组合根（daemon.ts）里不出现提醒：只按插件清单装插件；
// 2. 提醒目录之外只从 reminders/api.ts 拿提醒的东西（服务名和类型，经插件宿主按名字取），不 import 提醒的内部。
//    写明的例外（Comments 里有为什么、留给哪张票）：插件清单列它；配置段 reminders 还在内核的配置里解析。
//    128 号票起秘书的提醒工具、系统提示里的工具名和讲提醒的段落都由提醒插件经 agent 贡献缝给（secretary/tool-list.ts、
//    prompts/registry.ts 不再 import 提醒）。
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

/** 写明的例外：谁 → 提醒的哪个文件 */
const ALLOWED = [
  "plugins/manifest.ts → reminders/plugin.ts",
  "config/config.ts → reminders/thresholds.ts",
];

describe("提醒插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现提醒", () => {
    const root = files.find((f) => f.path === "daemon.ts")!.content;
    expect(root).not.toMatch(/reminder|提醒/i);
    expect(root).toContain("PLUGIN_MANIFEST");
  });

  it("提醒目录之外只 import reminders/api.ts（例外写明）", () => {
    const imports = files
      .filter((f) => !f.path.startsWith("reminders/"))
      .flatMap((f) =>
        [...f.content.matchAll(/from\s+["']([^"']*reminders\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`),
      );
    expect(imports.filter((i) => !i.endsWith("→ reminders/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    // 检查本身有效：确实有经 api.ts 取的
    expect(imports.some((i) => i.startsWith("calendar/calendar.ts"))).toBe(true);
  });
});
