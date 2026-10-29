// 日历插件的边界（213 号票，ADR-0027，照提醒、记忆插件的 test/reminders/boundary.test.ts、test/memory/boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现日历插件：不建日历的服务、不 import 日历的内部，网关的按月取经 calendar/api.ts 的服务名现取；
// 2. 日历目录之外只从 calendar/api.ts 拿日历的东西（服务名和类型），写明的例外只有插件清单列它；
// 3. 日历插件不拥有数据：没有派生视图、卡片类型、彻底删除的改写函数、素材来源、移除时的"连数据删"（211 号票的勾选对它是空的）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calendarPlugin } from "../../src/calendar/plugin.ts";

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

/** 写明的例外：谁 → 日历的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → calendar/plugin.ts"];

describe("日历插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现日历插件：不建日历的服务，只 import calendar/api.ts", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/createCalendarService|calendarPlugin/);
    expect(root).not.toMatch(/from\s+["']\.\/calendar\/(?!api\.ts)[^"']+["']/);
    expect(root).toContain("PLUGIN_MANIFEST");
  });

  it("日历目录之外只 import calendar/api.ts（例外写明）", () => {
    const imports = files
      .filter((f) => !f.path.startsWith("calendar/"))
      .flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']*calendar\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`))
      // 个人工作日历（workday/calendar.ts）是内核的，不是日历插件
      .filter((i) => /→ calendar\//.test(i));
    expect(imports.filter((i) => !i.endsWith("→ calendar/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    // 检查本身有效：插件清单列它，网关经 api.ts 取类型
    expect(imports).toContain("plugins/manifest.ts → calendar/plugin.ts");
    expect(imports).toContain("gateway/http-api.ts → calendar/api.ts");
  });

  it("日历插件不拥有数据：没有视图、没有数据契约（卡片、改写函数、素材来源、连数据删都没有）；提醒是可选依赖", () => {
    expect(calendarPlugin.views ?? []).toEqual([]);
    expect(calendarPlugin.contracts).toBeUndefined();
    expect((calendarPlugin.wants ?? []).map((k) => k.id)).toEqual(["reminders"]);
    expect((calendarPlugin.needs ?? []).map((k) => k.id)).not.toContain("reminders");
  });
});
