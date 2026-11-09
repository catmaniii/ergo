// 455 的迁移：高德从地图插件里挪成单独的插件，已有用户的数据原样认、不用重新填——
// - Key：一直在密钥区 secrets/data-sources/amap.json（数据源的编号 amap 没变），新插件装上就认，页面要的设置里有 Key、数据源连着；
// - 用量：原来在地图插件名下（map/amap-usage.json），高德插件启用时挪到 amap/usage.json，次数原样接着数；能重复执行；
//   新的已经在不动旧的；挪完 map/ 空了删掉；
// - 这台设备的手动选择（ergo-map-choice）存的是地图服务的编号，编号没变（amap、osm、google），网页那一半的测试里核对。
import fs from "node:fs";
import path from "node:path";
import { AMAP_SOURCE_ID, type AmapSourcePanel } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { AMAP_PLUGIN } from "../../src/amap/api.ts";
import { AMAP_USAGE_FILE, LEGACY_AMAP_USAGE, migrateAmapUsage, openAmapUsage } from "../../src/amap/amap-usage.ts";
import { AMAP_DATA_DIR } from "../../src/amap/plugin.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { MAP } from "../../src/map/api.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, AMAP_TEST_SERVICE_KEY, startFakeAmap } from "../helpers/fake-map.ts";
import { mapPlugins } from "../helpers/map-plugins.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 2026-11-09 中午（本地月份 2026-11） */
const NOW = Date.parse("2026-11-09T12:00:00+08:00");
const OLD_USAGE = { format: 1, months: { "2026-10": { search: 40, lbs: 900 }, "2026-11": { search: 12, lbs: 345 } } };

/** 455 以前的数据目录：高德的 Key 在密钥区、用量在 map/amap-usage.json */
function oldDataDir(): string {
  const dir = makeTempDir("ergo-455-old-");
  const secrets = createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} }).forSource(AMAP_SOURCE_ID);
  secrets.set("jsKey", AMAP_TEST_JS_KEY);
  secrets.set("securityCode", AMAP_TEST_SECURITY_CODE);
  secrets.set("serviceKey", AMAP_TEST_SERVICE_KEY);
  fs.mkdirSync(path.join(dir, "map"), { recursive: true });
  fs.writeFileSync(path.join(dir, LEGACY_AMAP_USAGE), JSON.stringify(OLD_USAGE));
  return dir;
}

describe("455 的迁移：高德的用量挪到高德插件名下", () => {
  it("旧的挪过来、次数原样；map/ 空了删掉；再叫一次什么都不动", () => {
    const root = oldDataDir();
    const logs: string[] = [];
    const dir = path.join(root, AMAP_DATA_DIR);
    const file = migrateAmapUsage({ root, dir, log: (l) => logs.push(l) });
    expect(file).toBe(path.join(dir, AMAP_USAGE_FILE));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(OLD_USAGE);
    expect(fs.existsSync(path.join(root, LEGACY_AMAP_USAGE))).toBe(false);
    expect(fs.existsSync(path.join(root, "map"))).toBe(false);
    expect(logs.join("\n")).toContain("挪过来了");
    const usage = openAmapUsage({ file, now: () => NOW, log: () => {} });
    expect(usage.view()).toMatchObject({ month: "2026-11", search: 12, lbs: 345 });
    usage.count("search");
    expect(migrateAmapUsage({ root, dir, log: (l) => logs.push(l) })).toBe(file);
    expect(openAmapUsage({ file, now: () => NOW, log: () => {} }).view()).toMatchObject({ search: 13, lbs: 345 });
  });

  it("新装的（没有旧的）：什么都不做；新的已经在：不动、旧的留着（连数据删时一起删）；map/ 里还有别的东西不删目录", () => {
    const fresh = makeTempDir("ergo-455-fresh-");
    const dir = path.join(fresh, AMAP_DATA_DIR);
    expect(migrateAmapUsage({ root: fresh, dir, log: () => {} })).toBe(path.join(dir, AMAP_USAGE_FILE));
    expect(fs.existsSync(dir)).toBe(false);

    const both = oldDataDir();
    const bothDir = path.join(both, AMAP_DATA_DIR);
    fs.mkdirSync(bothDir, { recursive: true });
    fs.writeFileSync(path.join(bothDir, AMAP_USAGE_FILE), JSON.stringify({ format: 1, months: { "2026-11": { search: 99, lbs: 1 } } }));
    expect(migrateAmapUsage({ root: both, dir: bothDir, log: () => {} })).toBe(path.join(bothDir, AMAP_USAGE_FILE));
    expect(JSON.parse(fs.readFileSync(path.join(bothDir, AMAP_USAGE_FILE), "utf8")).months["2026-11"].search).toBe(99);
    expect(fs.existsSync(path.join(both, LEGACY_AMAP_USAGE))).toBe(true);

    const other = oldDataDir();
    fs.writeFileSync(path.join(other, "map", "keep.txt"), "x");
    migrateAmapUsage({ root: other, dir: path.join(other, AMAP_DATA_DIR), log: () => {} });
    expect(fs.existsSync(path.join(other, "map", "keep.txt"))).toBe(true);
  });

  it("455 以前的数据目录上装三个插件：Key 原样认（数据源连着、页面有 Key，不用重填），用量挪过来、数据源那一块照旧显示这个月的次数", async () => {
    const dataDir = oldDataDir();
    const amap = await startFakeAmap();
    const k = await startPluginKernel({
      dataDir,
      at: new Date(NOW),
      plugins: mapPlugins({ amapHosts: amap.hosts, timeoutMs: 5000 }),
      services: [
        extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
        extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} })),
      ],
    });
    expect(k.host.running(AMAP_PLUGIN)).toBe(true);
    const view = k.host.service(MAP)!.config().providers?.find((p) => p.id === "amap");
    expect(view).toMatchObject({ ready: true, key: AMAP_TEST_JS_KEY, lookup: true });
    const source = k.dataSources.view().sources.find((s) => s.id === AMAP_SOURCE_ID)!;
    expect(source.connection).toBe("connected");
    expect((source.panel as AmapSourcePanel).usage).toMatchObject({ month: "2026-11", search: 12, lbs: 345 });
    expect(fs.existsSync(path.join(dataDir, AMAP_DATA_DIR, AMAP_USAGE_FILE))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, LEGACY_AMAP_USAGE))).toBe(false);
    // 没向高德发任何请求（不重测 Key）
    expect(amap.requests).toHaveLength(0);
  });
});
