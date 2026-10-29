// Looki 插件的边界（296 号票，ADR-0027，照 Claude Code 插件的 test/claude-code/boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现它；插件目录之外只从 looki/api.ts 拿东西，写明的例外只有插件清单列它；
// 2. 数据契约的形状：登记一个数据源（looki：两种用法、定期导入、敏感类别、导入的记录）、两条采集规则、两个改写函数、移除时连数据删；
//    不登记卡片、前端请求、运行时；没有视图；装配要事件存储、时钟和数据目录各区（307 号票：存一份到本地的设置、索引）；
//    移除并连数据删时连存一份到本地的设置和索引一起删（存下的文件不删）；
// 3. 只连官方的两个地址：接口地址写死在 client.ts（中国区 open.looki.tech、海外 open.looki.ai），src 里别处不出现 looki 的域名；
//    请求只用调用时现取的 globalThis.fetch（测试里只许连本机）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DataSource } from "../../src/data-sources/api.ts";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_MOMENT, LOOKI_SOURCE_ID } from "../../src/looki/api.ts";
import { LOOKI_ENDPOINTS } from "../../src/looki/client.ts";
import { lookiPlugin } from "../../src/looki/plugin.ts";
import type { MaterialSource } from "../../src/materials/capture.ts";
import type { ContractContext } from "../../src/plugins/host.ts";
import type { PluginDataRemoval } from "../../src/plugins/removal.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";

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

/** 写明的例外：谁 → 插件的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → looki/plugin.ts"];

describe("Looki 插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现 Looki 插件；插件目录之外只 import looki/api.ts（例外写明）", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/looki/i);
    const imports = files
      .filter((f) => !f.path.startsWith("looki/"))
      .flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']*looki\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`));
    expect(imports.filter((i) => !i.endsWith("→ looki/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    expect(imports).toContain("plugins/manifest.ts → looki/plugin.ts");
  });

  it("只连官方的两个地址：域名只写在 client.ts；请求用 globalThis.fetch", () => {
    expect(LOOKI_ENDPOINTS).toEqual({ cn: "https://open.looki.tech/api/v1", global: "https://open.looki.ai/api/v1" });
    const mentioning = files.filter((f) => /looki\.(tech|ai)/.test(withoutComments(f.content))).map((f) => f.path);
    expect(mentioning).toEqual(["looki/client.ts"]);
    const client = withoutComments(files.find((f) => f.path === "looki/client.ts")!.content);
    expect(client).toContain("globalThis.fetch(");
    expect(client).not.toMatch(/\bimport\b[^;]*\bfetch\b[^;]*from/);
  });

  it("数据契约：一个数据源、两条采集规则、两个改写函数、移除时连数据删；没有卡片、请求、运行时、视图", () => {
    expect(lookiPlugin.views ?? []).toEqual([]);
    expect(lookiPlugin.needs).toEqual([KERNEL.store, KERNEL.clock, KERNEL.layout]);
    const sources: DataSource[] = [];
    const materials: MaterialSource[] = [];
    const purged: string[] = [];
    const removals: PluginDataRemoval[] = [];
    const touched: string[] = [];
    const record = (name: string) => () => {
      touched.push(name);
    };
    const ctx = {
      plugin: lookiPlugin.name,
      cardTypes: { register: record("cardTypes") },
      purge: { register: (...rewriters: Array<{ eventType: string }>) => purged.push(...rewriters.map((r) => r.eventType)), registerQuotes: record("purgeQuotes") },
      materialSources: { register: (source: MaterialSource) => materials.push(source) },
      requests: { register: record("requests") },
      removal: { declare: (spec: PluginDataRemoval) => removals.push(spec) },
      runtimes: { register: record("runtimes") },
      dataSources: { register: (source: DataSource) => sources.push(source) },
      active: () => {
        throw new Error("数据契约里不该取服务");
      },
    } as unknown as ContractContext;
    lookiPlugin.contracts!(ctx);
    expect(touched).toEqual([]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: LOOKI_SOURCE_ID,
      sensitive: ["location", "emotion", "health"],
      usages: { query: { default: true }, import: { default: true, schedule: { kind: "daily", time: "02:30" } } },
      records: [
        { channel: LOOKI_CHANNEL, type: LOOKI_MOMENT },
        { channel: LOOKI_CHANNEL, type: LOOKI_JOURNAL },
      ],
    });
    expect(sources[0]!.files).toBeUndefined();
    expect(["status", "configure", "sync", "disconnect", "tools", "localFolder"].every((fn) => typeof (sources[0] as unknown as Record<string, unknown>)[fn] === "function")).toBe(true);
    expect(materials.map((m) => [m.name, m.eventType])).toEqual([
      ["looki-moment", LOOKI_MOMENT],
      ["looki-journal", LOOKI_JOURNAL],
    ]);
    expect(purged).toEqual([LOOKI_MOMENT, LOOKI_JOURNAL]);
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ events: sources[0]!.records, files: [path.join("secrets", "data-sources", "looki.json"), path.join("config", "looki-archive.json"), "looki-archive"] });
  });
});
