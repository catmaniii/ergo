// 地图插件的边界（429，照日历插件的 test/calendar/boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现地图插件：不建地图的服务、不 import 地图的内部，网关、接口经 map/api.ts 的服务名现取；
// 2. 地图目录之外只从 map/api.ts 拿地图的东西，写明的例外只有插件清单列它；
// 3. 地图插件拥有的只有聊天里的地图卡片（431）：没有派生视图、素材来源；数据契约里登记地图卡片和移除时删什么；
//    可选依赖只有手机插件（430 我的足迹；432 常去的地方、最近一个位置点）。455 起 Key、用量、瓦片缓存都在各家的插件名下；
// 4. 地图插件不认识任何一家地图服务（455，ADR-0061）：去掉注释后地图目录里没有 "amap"、"osm"、"google" 这些编号，
//    也不 import 哪一家的插件——只认插槽。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mapPlugin } from "../../src/map/plugin.ts";

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

/** 写明的例外：谁 → 地图的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → map/plugin.ts"];

describe("地图插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现地图插件：不建地图的服务，只 import map/api.ts", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/createMapService|createMapPlugin|mapPlugin\b/);
    expect(root).not.toMatch(/from\s+["']\.\/map\/(?!api\.ts)[^"']+["']/);
  });

  it("地图目录之外只 import map/api.ts（例外写明）", () => {
    const imports = files
      .filter((f) => !f.path.startsWith("map/"))
      .flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']*\/map\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`))
      .filter((i) => /→ map\//.test(i));
    expect(imports.filter((i) => !i.endsWith("→ map/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    // 检查本身有效：插件清单列它，网关、接口、组合根经 api.ts 取
    expect(imports).toContain("plugins/manifest.ts → map/plugin.ts");
    expect(imports).toContain("gateway/map-routes.ts → map/api.ts");
    expect(imports).toContain("gateway/http-api.ts → map/api.ts");
    expect(imports).toContain("daemon.ts → map/api.ts");
  });

  it("没有视图；要时钟、卡片（地图卡片，431）；可选要手机插件（430、432）；455 起不要数据目录、密钥区（那些在各家名下）", () => {
    expect(mapPlugin.views ?? []).toEqual([]);
    expect(typeof mapPlugin.contracts).toBe("function");
    expect((mapPlugin.needs ?? []).map((k) => k.id).toSorted()).toEqual(["cards", "clock"]);
    expect((mapPlugin.wants ?? []).map((k) => k.id)).toEqual(["phone"]);
  });

  it("不认识任何一家（455）：地图目录里没有写死的编号，也不 import 哪一家的插件", () => {
    const mine = files.filter((f) => f.path.startsWith("map/"));
    expect(mine.length).toBeGreaterThan(10);
    const named = mine.flatMap((f) => [...withoutComments(f.content).matchAll(/["'`](amap|osm|google|openstreetmap|google-maps)["'`/-]/gi)].map((m) => `${f.path}：${m[0]}`));
    expect(named).toEqual([]);
    const providerImports = mine.flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!).filter((i) => /\/(amap|openstreetmap|google-maps)\//.test(i)).map((i) => `${f.path} → ${i}`));
    expect(providerImports).toEqual([]);
  });
});
