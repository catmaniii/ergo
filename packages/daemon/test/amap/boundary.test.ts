// 高德地图插件的边界（455，ADR-0061，照谷歌地图的 test/google-maps/boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现高德地图插件：内核、网关都不认得它（底图、查询、用量、静态图、安全密钥代理全经地图插件的"地图服务"插槽）；
// 2. amap 目录之外只从 amap/api.ts 拿它的东西，写明的例外只有插件清单列它；
// 3. 它从地图插件只拿 map/api.ts（插槽的接口、查询的外形），不碰地图插件的别的文件；也不碰别的地图服务插件；
// 4. 它要地图插件的插槽（needs），数据契约里只登记"连数据删"（和数据源），不拥有事件、卡片。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { amapPlugin } from "../../src/amap/plugin.ts";

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

describe("高德地图插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现高德地图插件", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/amap\/|amapPlugin|AMAP_PLUGIN|createAmap/);
  });

  it("amap 目录之外只 import amap/api.ts（例外只有插件清单）", () => {
    const outside = files.filter((f) => !f.path.startsWith("amap/")).flatMap((f) => importsOf(f).filter((i) => i.startsWith("amap/")).map((i) => `${f.path} → ${i}`));
    expect(outside.filter((i) => !i.endsWith("→ amap/api.ts"))).toEqual(["plugins/manifest.ts → amap/plugin.ts"]);
  });

  it("它从地图插件只拿 map/api.ts，不碰别的地图服务插件", () => {
    const mine = files.filter((f) => f.path.startsWith("amap/"));
    const fromMap = mine.flatMap((f) => importsOf(f).filter((i) => i.startsWith("map/")));
    expect(fromMap.length).toBeGreaterThan(0);
    expect([...new Set(fromMap)]).toEqual(["map/api.ts"]);
    const others = ["amap/", "openstreetmap/", "google-maps/"].filter((d) => d !== "amap/");
    expect(mine.flatMap((f) => importsOf(f).filter((i) => others.some((d) => i.startsWith(d))))).toEqual([]);
  });

  it("要地图插件的插槽；不拥有事件、卡片（没有视图）", () => {
    expect((amapPlugin.needs ?? []).map((k) => k.id)).toContain("map-providers");
    expect(amapPlugin.views ?? []).toEqual([]);
    expect(amapPlugin.contracts).toBeDefined();
  });
});
