// Looki 插件（296 号票，生活数据源第一波之二；issue 25、调研 38；用户 2026-10-25 定第一波接）：接 Looki 挂脖相机的官方只读开放接口。
// - 数据契约（不管插件开没开都登记，停用也认得）：
//   · 数据源 looki（295 号票的数据源贡献点）：设置 · 数据源里填 API Key、选区域（中国区 / 海外）、测试连接（网页那一半在 dataSources 插槽里画），
//     两种用法默认都开——定期导入（每天 02:30，赶在 03:00 的每晚整理之前；拉到昨天为止）和按需查（给秘书"查 Looki"）；
//     用到的敏感类别：位置（时刻的地点）、情绪和健康（AI 日记）；导入的记录是频道 looki 上的 looki_moment、looki_journal；
//   · 两条采集规则（materials.ts，303 号票的写法）：时刻 → 观察到的本人行为（场景给起止时间、地点，敏感类别写空的），
//     AI 日记 → 别人写给你的（全文只进检索，标情绪、健康：默认只进检索、不读成证据）；照片视频不进素材库；
//   · 彻底删除的改写函数（标题、描述、地点、日记全文换掉）；
//   · 移除时"连数据删"：它导入的记录、密钥区里的 Key；素材属于内核不跟着删（要连素材一起删，先在设置 · 数据源里断开并选"连已导入的一起删"）。
// - 装配：提供 Looki 服务（service.ts：连接状态、测试连接、同步、按需查、存一份到本地），要事件存储、时钟、数据目录各区。数据源的函数经 ctx.active 现取它。
// - 停用时：数据源照样列出、写"Looki插件没启用"，不能同步、按需查（内核管）；Key 留在密钥区，启用后接着用。
// - 存一份到本地（307 号票，archive.ts）：同步时顺带把照片、AI 日记、vlog 存到本地文件夹（默认「文档」下的 Looki）；
//   设置在配置区的 looki-archive.json、索引在数据目录的 looki-archive/（数据目录各区要 KERNEL.layout）；数据源页"在电脑上打开"它（localFolder）；
//   断开（不管删不删已导入的）都不删存下的文件；移除并连数据删时删设置和索引，文件照样留着（确认框写明）。停用时正在存的停下。
// 接口地址、限速要等多久可以换（测试接本机的假 Looki：test/helpers/fake-looki.ts，主切面经 extraPlugins 换掉清单里的同名插件）。
import path from "node:path";
import { t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { type PluginDefinition, serviceKey } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_MOMENT, LOOKI_PLUGIN, LOOKI_SOURCE_ID, type LookiRegion } from "./api.ts";
import { ARCHIVE_SETTINGS_FILE, ARCHIVE_STATE_DIR, LOOKI_ARCHIVE_DEFAULT_FOLDER, type LookiArchiveOptions } from "./archive.ts";
import { LOOKI_ENDPOINTS } from "./client.ts";
import { journalMaterialSource, journalPurge, momentMaterialSource, momentPurge } from "./materials.ts";
import { createLookiService, type LookiService } from "./service.ts";
import { lookiQueryTool } from "./tools.ts";

const LOOKI = serviceKey<LookiService>("looki");

/** 定期导入的时间：赶在每晚整理（03:00）之前，昨天的时刻当夜就读得到 */
export const LOOKI_IMPORT_TIME = "02:30";

export interface LookiPluginOptions {
  /** 两个区域的接口地址（测试换成本机的假 Looki） */
  endpoints?: Partial<Record<LookiRegion, string>>;
  /** 同步时限速了等多久（毫秒）；不给按 Retry-After，没有就 60 秒 */
  rateLimitWaitMs?: number;
  /** 一次请求最多等多久（毫秒） */
  timeoutMs?: number;
  /**
   * 存一份到本地（307 号票）：默认位置（不给是「文档」下的 Looki——但换了接口地址又没给的没有默认位置：
   * 测试接本机的假 Looki 时不许往真的用户目录里写，要存得自己给临时目录）；测试另给磁盘剩余空间、下载
   */
  archive?: { defaultFolder?: string } & Pick<LookiArchiveOptions, "freeSpace" | "download">;
}

/** 移除并连数据删时删掉的：密钥区里这个数据源那一格（数据目录里的相对路径，和 data-dir.ts 的 dataSourceSecrets 一致） */
const SECRET_FILE = path.join("secrets", "data-sources", `${LOOKI_SOURCE_ID}.json`);
/** 还有存一份到本地的设置（配置区）和索引（数据目录）：存下的照片、日记、vlog 本身不删 */
const ARCHIVE_FILES = [path.join("config", ARCHIVE_SETTINGS_FILE), ARCHIVE_STATE_DIR];

export function createLookiPlugin(options: LookiPluginOptions = {}): PluginDefinition {
  const defaultFolder = options.archive?.defaultFolder ?? (options.endpoints === undefined ? LOOKI_ARCHIVE_DEFAULT_FOLDER : undefined);
  return {
    name: LOOKI_PLUGIN,
    get title() {
      return t("looki.plugin.title");
    },
    get summary() {
      return t("looki.plugin.summary");
    },
    get brings() {
      return { tools: [t("looki.tool.title")], cards: [], jobs: [] };
    },
    needs: [KERNEL.store, KERNEL.clock, KERNEL.layout],
    provides: [LOOKI],
    contracts(ctx) {
      const records = [
        { channel: LOOKI_CHANNEL, type: LOOKI_MOMENT },
        { channel: LOOKI_CHANNEL, type: LOOKI_JOURNAL },
      ];
      const source: DataSource = {
        id: LOOKI_SOURCE_ID,
        get title() {
          return t("looki.source.title");
        },
        get summary() {
          return t("looki.source.summary");
        },
        sensitive: ["location", "emotion", "health"],
        usages: { query: { default: true }, import: { default: true, schedule: { kind: "daily", time: LOOKI_IMPORT_TIME } } },
        records,
        status: (c) => ctx.active(LOOKI).status(c.secrets),
        configure: (values, c) => ctx.active(LOOKI).configure(values, c.secrets),
        sync: (c) => ctx.active(LOOKI).sync(c),
        // 306：Key 不认（出错）后内核每小时叫一次，拿存着的 Key 再测
        recheck: (c) => ctx.active(LOOKI).recheck(c.secrets, c.signal),
        disconnect: () => ctx.active(LOOKI).reset(),
        localFolder: () => ctx.active(LOOKI).localFolder(),
        tools: (c) => [lookiQueryTool(() => ctx.active(LOOKI), c.secrets, t("looki.tool.title"), () => ctx.active(LOOKI).today())],
      };
      ctx.dataSources.register(source);
      ctx.materialSources.register(momentMaterialSource(source));
      ctx.materialSources.register(journalMaterialSource(source));
      ctx.purge.register(momentPurge, journalPurge);
      ctx.removal.declare({
        get deletes() {
          return [t("looki.plugin.purge.records"), t("looki.plugin.purge.key"), t("looki.plugin.purge.archiveIndex")];
        },
        get keeps() {
          return [t("looki.plugin.keep.materials"), t("looki.plugin.keep.archive"), t("looki.plugin.keep.chat"), t("looki.plugin.keep.backup")];
        },
        events: records,
        files: [SECRET_FILE, ...ARCHIVE_FILES],
      });
    },
    setup(ctx) {
      const store = ctx.use(KERNEL.store);
      const clock = ctx.use(KERNEL.clock);
      const layout = ctx.use(KERNEL.layout);
      const service = createLookiService({
        store,
        clock,
        endpoints: { ...LOOKI_ENDPOINTS, ...options.endpoints },
        ...(options.rateLimitWaitMs === undefined ? {} : { rateLimitWaitMs: options.rateLimitWaitMs }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        archive: {
          settingsFile: path.join(layout.config, ARCHIVE_SETTINGS_FILE),
          stateDir: path.join(layout.root, ARCHIVE_STATE_DIR),
          dataDir: layout.root,
          defaultFolder,
          ...(options.archive?.freeSpace === undefined ? {} : { freeSpace: options.archive.freeSpace }),
          ...(options.archive?.download === undefined ? {} : { download: options.archive.download }),
        },
        log: (line) => ctx.log(line),
      });
      ctx.provide(LOOKI, service);
      // 停用时：正在存到本地的、补存的停下（补存停在"已暂停"），等它们停
      ctx.lifecycle({ stop: () => service.stop() });
    },
  };
}

export const lookiPlugin: PluginDefinition = createLookiPlugin();
