// 高德地图插件（455，ADR-0061；429 起在地图插件里，用户 2026-11-09 要三家各做成一个插件）：国内的地图、查地点、算路线用高德。
// - 数据契约（不管插件开没开都登记，停用也认得）：数据源 amap"高德地图"——设置 · 数据源里填 Web 端（JS API）的 Key 和安全密钥、
//   Web 服务的 Key（432 查地点用），填完先测再存（amap.ts）；不导入，只有按需查（开关在数据源页上；工具由地图插件给，ownTools）；
//   不拥有记录。移除时"连数据删"：密钥区那一格、插件自己的存储（用量），还有 455 以前记在地图插件名下、还没挪过来的用量。
// - 装配：要地图插件的"地图服务"插槽（needs MAP_PROVIDERS），在 setup 里经 ctx.effect 登记一家 amap（service.ts）：停用、移除时撤掉，
//   地图页、秘书的查询自动退回别家；地图插件停了，它跟着停（宿主的 needs 规矩）。秘书的工具不新增。
// - 它带来：网关 /_AMapService 的安全密钥代理（插槽的 proxy）、聊天卡片的静态预览图（staticMap）、体检里高德的用量（地图插件替它登记）。
// - 网页那一半（packages/web/src/plugins/amap/）：高德的底图（同一页加载高德 JS API，只出底图）、设置 · 数据源 · 高德地图填 Key 和试查一下。
// - 455 的迁移：Key 一直在密钥区 secrets/data-sources/amap.json（数据源的编号没变，原样认）；用量原来在 map/amap-usage.json，
//   启用时挪到 amap/usage.json（amap-usage.ts 的 migrateAmapUsage，能重复执行）。
// - 隐私：查询时只把要查的那一两个点（起终点、"附近"的中心）发给高德，结果不存；Web 端 Key 本来就在页面上（高德的设计），
//   安全密钥、Web 服务 Key 不进页面；足迹、二狗画的点和线不交给高德（ADR-0059 的 453 修订）。
import path from "node:path";
import { AMAP_SOURCE_ID, t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { MAP_PROVIDERS } from "../map/api.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { AMAP, AMAP_PLUGIN } from "./api.ts";
import type { AmapHosts } from "./amap.ts";
import { LEGACY_AMAP_USAGE, migrateAmapUsage } from "./amap-usage.ts";
import { createAmapService } from "./service.ts";

export interface AmapPluginOptions {
  /** 高德的地址（测试换成本机的假高德） */
  hosts?: Partial<AmapHosts>;
  /** 一次请求最多等多久（毫秒） */
  timeoutMs?: number;
}

/** 移除并连数据删时删掉的：密钥区里那一格（和 data-dir.ts 的 dataSourceSecrets 一致） */
const SECRET_FILE = path.join("secrets", "data-sources", `${AMAP_SOURCE_ID}.json`);
/** 插件自己的存储在数据目录里的哪（用量） */
export const AMAP_DATA_DIR = "amap";

export function createAmapPlugin(options: AmapPluginOptions = {}): PluginDefinition {
  return {
    name: AMAP_PLUGIN,
    get title() {
      return t("amap.plugin.title");
    },
    get summary() {
      return t("amap.plugin.summary");
    },
    needs: [MAP_PROVIDERS, KERNEL.clock, KERNEL.layout, KERNEL.dataSourceSecrets],
    // 数据源的用法开关：查之前看高德的按需查开没开（没有这项服务时当开着）
    wants: [KERNEL.dataSourceUsage],
    provides: [AMAP],
    contracts(ctx) {
      const source: DataSource = {
        id: AMAP_SOURCE_ID,
        get title() {
          return t("amap.source.title");
        },
        get summary() {
          return t("amap.source.summary");
        },
        sensitive: [],
        // 按需查（432）：让秘书用高德查国内的地点、路线；不导入。工具由地图插件给（几家共用一套），这里只是开关
        usages: { query: { default: true, ownTools: true } },
        status: (c) => ctx.active(AMAP).status(c.secrets),
        configure: (values, c) => ctx.active(AMAP).configure(values, c.secrets),
        // Key 不认（出错）后内核每小时叫一次，拿存着的再测
        recheck: (c) => ctx.active(AMAP).recheck(c.secrets, c.signal),
        disconnect: () => ctx.active(AMAP).reset(),
        // 试查一下（设置里那一块、数据源详情的"现在能查到的"）：搜一个固定的地点
        live: (_query, c) => ctx.active(AMAP).tryLookup(c.signal),
        get disconnectNote() {
          return t("amap.source.disconnectNote");
        },
      };
      ctx.dataSources.register(source);
      ctx.removal.declare({
        get deletes() {
          return [t("amap.plugin.purge.keys"), t("amap.plugin.purge.usage")];
        },
        get keeps() {
          return [t("amap.plugin.keep.chat")];
        },
        files: [SECRET_FILE, AMAP_DATA_DIR, LEGACY_AMAP_USAGE],
      });
    },
    setup(ctx) {
      const clock = ctx.use(KERNEL.clock);
      const layout = ctx.use(KERNEL.layout);
      const secrets = ctx.use(KERNEL.dataSourceSecrets);
      // 455：用量从地图插件名下挪过来（能重复执行；挪不动就接着用旧的那一份）
      const usageFile = migrateAmapUsage({ root: layout.root, dir: path.join(layout.root, AMAP_DATA_DIR), log: (line) => ctx.log(line) });
      const service = createAmapService({
        ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        secrets: () => secrets.forSource(AMAP_SOURCE_ID),
        usageFile,
        now: () => clock.now(),
        // 高德的按需查开没开（现取：用户随时在数据源页上开关）
        queryOn: () => ctx.optional(KERNEL.dataSourceUsage)?.on(AMAP_SOURCE_ID, "query") ?? true,
        log: (line) => ctx.log(line),
      });
      ctx.provide(AMAP, service);
      // 登记进地图插件的"地图服务"插槽：停用、移除时宿主替它撤掉，地图页和秘书的查询退回别家
      const slot = ctx.use(MAP_PROVIDERS);
      ctx.effect(() => slot.register(service.provider));
    },
  };
}

export const amapPlugin: PluginDefinition = createAmapPlugin();
