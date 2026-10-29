// 网页插件的边界（193 号票，ADR-0027："网页用类型化插槽，插件之间不互相 import"）：扫 src/ 下每个文件的 import——
// - 核心（src/plugins/<插件>/ 以外的）不 import 插件：插件清单 src/plugins/manifest.ts 是唯一列插件的地方，也只有组合根 App.tsx 引它；
// - 插件之间不互相 import，也不引插件清单；
// - 插件经宿主接口只引 src/plugins/api.ts（不直接引宿主的 host.ts、react.tsx、slots.ts），状态层只经 src/state/index.ts；
// - src/plugins/ 下的每个插件目录都在清单里。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../../src");
const PLUGINS = path.join(SRC, "plugins");
const MANIFEST = path.join(PLUGINS, "manifest.ts");
const APP = path.join(SRC, "App.tsx");
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** src/ 下的每个源文件和它 import 的（相对路径换成绝对路径） */
function sources(): { file: string; imports: string[] }[] {
  return fs
    .readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => {
      const file = path.join(SRC, name);
      const imports = [...fs.readFileSync(file, "utf8").matchAll(IMPORT)].map((m) => m[1]!).filter((spec) => spec.startsWith(".")).map((spec) => path.resolve(path.dirname(file), spec));
      return { file, imports };
    });
}

/** 这个文件属于哪个插件（src/plugins/<插件>/ 下面的）；核心的是 undefined */
function pluginOf(file: string): string | undefined {
  const rel = path.relative(PLUGINS, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const [head, ...rest] = rel.split(path.sep);
  return rest.length > 0 ? head : undefined;
}

const rel = (file: string) => path.relative(SRC, file).replaceAll("\\", "/");
const ALL = sources();

describe("网页插件的边界", () => {
  test("找得到插件（扫的路子没走偏）：记忆、提醒、日历（213 号票）、语音（214 号票）、浏览（212 号票）、手机（299 号票）、Google（297 号票）、Looki（296 号票）、Claude Code（305 号票）九个插件，清单引了它们", () => {
    const dirs = fs.readdirSync(PLUGINS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs.toSorted()).toEqual(["browsing", "calendar", "claude-code", "google", "looki", "memory", "phone", "reminders", "voice"]);
    const manifest = ALL.find((s) => s.file === MANIFEST)!;
    // 每个插件目录都在清单里
    expect(dirs.filter((d) => !manifest.imports.some((i) => pluginOf(i) === d))).toEqual([]);
  });

  test("核心不 import 插件（插件清单除外）", () => {
    const bad = ALL.filter((s) => pluginOf(s.file) === undefined && s.file !== MANIFEST).flatMap((s) => s.imports.filter((i) => pluginOf(i) !== undefined).map((i) => `${rel(s.file)} → ${rel(i)}`));
    expect(bad).toEqual([]);
  });

  test("插件清单只由组合根 App.tsx 引", () => {
    const users = ALL.filter((s) => s.imports.includes(MANIFEST)).map((s) => rel(s.file));
    expect(users).toEqual([rel(APP)]);
  });

  test("插件之间不互相 import；插件不引清单、不直接引宿主的内部（只经 plugins/api.ts）；状态层只经 state/index.ts", () => {
    const bad = ALL.flatMap((s) => {
      const mine = pluginOf(s.file);
      if (mine === undefined) return [];
      return s.imports.flatMap((i) => {
        const other = pluginOf(i);
        if (other !== undefined && other !== mine) return [`${rel(s.file)} → ${rel(i)}（别的插件）`];
        if (other === undefined && path.dirname(i) === PLUGINS && path.basename(i) !== "api.ts") return [`${rel(s.file)} → ${rel(i)}（宿主的内部）`];
        if (i.startsWith(path.join(SRC, "state") + path.sep) && path.basename(i) !== "index.ts") return [`${rel(s.file)} → ${rel(i)}（状态层要经 state/index.ts）`];
        return [];
      });
    });
    expect(bad).toEqual([]);
  });
});
