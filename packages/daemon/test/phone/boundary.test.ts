// 手机插件的边界（299 号票，照日历插件的 test/calendar/boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现手机插件：不建它的服务、不 import 它的内部；
// 2. 手机插件目录之外只从 phone/api.ts 拿它的东西，写明的例外只有插件清单列它；
// 3. 数据契约的形状：登记四个数据源（通讯录选人、手机日历、照片的时间地点、位置），都只有导入；只有照片、位置的摘要登记素材来源
//    （通讯录、日历不进记忆）；日历插件是可选依赖。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { phonePlugin } from "../../src/phone/plugin.ts";

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

/** 写明的例外：谁 → 手机插件的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → phone/plugin.ts"];

const noop = () => () => {};

describe("手机插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现手机插件", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/createPhoneService|phonePlugin/);
    expect(root).not.toMatch(/from\s+["']\.\/phone\/[^"']+["']/);
  });

  it("手机插件目录之外只 import phone/api.ts（例外写明）", () => {
    const imports = files
      .filter((f) => !f.path.startsWith("phone/"))
      .flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']*phone\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`))
      .filter((i) => /→ phone\//.test(i));
    expect(imports.filter((i) => !i.endsWith("→ phone/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    expect(imports).toContain("plugins/manifest.ts → phone/plugin.ts");
  });

  it("数据契约：四个数据源都只有导入，只有照片、位置的摘要登记素材来源；日历插件是可选依赖", () => {
    const sources: Array<{ id: string; usages: object; push?: unknown; calendar?: unknown; raw?: unknown; sensitive?: string[] }> = [];
    const materialSources: string[] = [];
    phonePlugin.contracts!({
      plugin: "phone",
      active: () => {
        throw new Error("契约里不该现取服务");
      },
      dataSources: { register: (s: (typeof sources)[number]) => (sources.push(s), () => {}) },
      materialSources: { register: (m: { eventType: string }) => (materialSources.push(m.eventType), () => {}) },
      removal: { declare: () => {} },
      cardTypes: { register: noop },
      purge: { register: noop, registerQuotes: noop },
      requests: { register: noop },
      runtimes: { register: noop },
    } as never);
    expect(sources.map((s) => [s.id, Object.keys(s.usages), s.push !== undefined, s.calendar !== undefined, s.raw !== undefined, s.sensitive ?? []])).toEqual([
      ["phone-contacts", ["import"], true, false, false, []],
      ["phone-calendar", ["import"], true, true, false, []],
      ["phone-photos", ["import"], true, false, true, ["location"]],
      ["phone-location", ["import"], true, false, true, ["location"]],
    ]);
    expect(materialSources).toEqual(["phone_photos_day", "phone_location_day"]);
    expect((phonePlugin.wants ?? []).map((k) => k.id)).toEqual(["calendar"]);
    expect((phonePlugin.needs ?? []).map((k) => k.id)).toEqual(["store", "clock", "layout", "personalFiles"]);
  });
});
