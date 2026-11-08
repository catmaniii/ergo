// 谷歌地图插件的边界（ADR-0027、ADR-0057，照日历的 test/calendar/boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现谷歌地图插件：内核、网关都不认得它（底图、查询、用量全经地图插件的"地图服务"插槽）；
// 2. 谷歌地图目录之外只从 google-maps/api.ts 拿它的东西，写明的例外只有插件清单列它；
// 3. 它从地图插件只拿 map/api.ts（插槽的接口、查询的外形），不碰地图插件的别的文件；
// 4. 它要地图插件的插槽（needs），数据契约里只登记数据源和"连数据删"（不拥有事件、卡片）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { googleMapsPlugin } from "../../src/google-maps/plugin.ts";

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

/** 一个文件 import 的（拼成相对 src 的路径） */
const importsOf = (f: { path: string; content: string }) => [...f.content.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!)));

describe("谷歌地图插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现谷歌地图插件", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/google-maps|googleMaps|GOOGLE_MAPS/);
  });

  it("谷歌地图目录之外只 import google-maps/api.ts（例外只有插件清单）", () => {
    const outside = files.filter((f) => !f.path.startsWith("google-maps/")).flatMap((f) => importsOf(f).filter((i) => i.startsWith("google-maps/")).map((i) => `${f.path} → ${i}`));
    expect(outside.filter((i) => !i.endsWith("→ google-maps/api.ts"))).toEqual(["plugins/manifest.ts → google-maps/plugin.ts"]);
  });

  it("它从地图插件只拿 map/api.ts", () => {
    const fromMap = files.filter((f) => f.path.startsWith("google-maps/")).flatMap((f) => importsOf(f).filter((i) => i.startsWith("map/")));
    expect(fromMap.length).toBeGreaterThan(0);
    expect([...new Set(fromMap)]).toEqual(["map/api.ts"]);
  });

  it("要地图插件的插槽；不拥有事件、卡片（没有视图）", () => {
    expect((googleMapsPlugin.needs ?? []).map((k) => k.id)).toContain("map-providers");
    expect(googleMapsPlugin.views ?? []).toEqual([]);
    expect(googleMapsPlugin.contracts).toBeDefined();
  });
});
