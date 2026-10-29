// 设置 · 插件（211 号票，用户 2026-10-20："设置界面里面要能查看当前加载了哪些插件，还有可以把它暂时禁用或者是移除。相当于是可以热插拔"）：
// 列出清单里的插件（GET /api/plugins），运行中停用、启用（移除了的就是装回）、移除（POST /api/plugins/<插件名>），马上生效、不重启。
// - 装和停在插件宿主（host.ts：disable / enable / remove，依赖方一起停、一起开）；状况变了宿主通知，组合根在插件频道上推新的
//   plugin_status，网页按它收起、放回它的页面和栏目；给 agent 的工具、上下文块从下一轮起没有（agent 贡献撤了，秘书这一条处理完就重新装配）。
// - 这里写配置：停用的（连同跟着一起停的）进 plugins.disabled，移除的进 plugins.removed，启用、装回的从两边拿掉（只拿掉真装上了的；
//   启用时装配出错的照旧记着，重启后不算降级）。配置文件的别的内容原样留着（config.ts 的 writePluginsConfig），重启后保持。
//   配置里写着、清单里不认得的名字原样留着。
// - 移除时勾了"连它的数据一起彻底删除"：先停用、记成移除了，再按插件在数据契约里写明的删（removal.ts，ADR-0008 的口子，留删除记录）；
//   插件没写明的回"没有可以一起删的数据"，什么都不动。插件写明的这份建的时候登记进"删除参与方"登记表（279 号票，和删项目、删任务同一张）。删的时候把这个插件停着的视图先登记回去、一起重放，删完再记回停着的（215 号票）：
//   彻底删除只重放在用的视图，不这样的话停着的视图表里还留着删之前的内容（提醒的 reminders 表里有提醒的原话），要到装回时才清掉。
// - 一次一个：上一个还没做完时再来的回"等一下再试"（宿主那边也是一个一个来，这里先挡住，免得配置写乱）。
import { type PluginAction, type PluginActionResult, type PluginInfo, type PluginPurgeCounts, type PluginsView, t } from "@ergo/protocol";
import { type PluginsConfig, writePluginsConfig } from "../config/config.ts";
import { RequestRejected } from "../errors.ts";
import type { PluginHost } from "./host.ts";
import { type PluginDataPurgeDeps, purgePluginData, registerPluginDataRemoval } from "./removal.ts";

export interface PluginSettings {
  /** 清单里的全部插件（给人看的样子） */
  view(): PluginsView;
  /** 停用、启用、移除一个插件（移除时 purgeData 连它的数据一起彻底删除）；不认得的插件抛 not_found，做不了的抛 not_allowed */
  act(name: string, request: { action: PluginAction; purgeData?: boolean | undefined; idempotencyKey: string }): Promise<PluginActionResult>;
}

export interface PluginSettingsOptions {
  host: Pick<PluginHost, "info" | "disable" | "enable" | "remove" | "removalOf" | "viewsOf" | "has" | "running">;
  /** 数据目录的配置文件（ergo.json） */
  configFile: string;
  /** 启动时读到的 plugins（之后由这里写） */
  config: PluginsConfig;
  /** 连数据删要的（removal.ts）：建的时候把插件写明的那份登记进它的"删除参与方"登记表 */
  purge: PluginDataPurgeDeps;
  log: (line: string) => void;
}

export function createPluginSettings(options: PluginSettingsOptions): PluginSettings {
  const { host, log } = options;
  const disabled = new Set(options.config.disabled);
  const removed = new Set(options.config.removed);
  let busy = false;

  // 插件宿主收着的各插件写明的"连数据删"：作为登记表里的一个参与方（数据契约不管插件开没开都在，移除了的也照样找得到）
  const { participants, dataDir, media } = options.purge;
  registerPluginDataRemoval(participants, { removalOf: (name) => host.removalOf(name), dataDir, ...(media ? { media } : {}), log: options.purge.log });

  const save = () => writePluginsConfig(options.configFile, { disabled: [...disabled], removed: [...removed] });
  const plugins = (): PluginInfo[] => host.info();

  return {
    view: () => ({ plugins: plugins() }),
    async act(name, request) {
      if (!host.has(name)) throw new RequestRejected("not_found", t("plugins.unknown", { name }));
      if (busy) throw new RequestRejected("conflict", t("plugins.settings.busy"));
      busy = true;
      try {
        if (request.action === "disable") {
          const changed = await host.disable(name);
          for (const n of changed) {
            disabled.add(n);
            removed.delete(n);
          }
          if (changed.length > 0) save();
          return { changed, plugins: plugins() };
        }
        if (request.action === "enable") {
          const changed = await host.enable(name);
          // 只拿掉真装上了的（启用时出错的照旧记着）
          for (const n of [name, ...changed]) {
            if (!host.running(n)) continue;
            disabled.delete(n);
            removed.delete(n);
          }
          save();
          return { changed, plugins: plugins() };
        }
        const spec = request.purgeData === true ? host.removalOf(name) : undefined;
        if (request.purgeData === true && !spec) {
          const title = plugins().find((p) => p.name === name)?.title ?? name;
          throw new RequestRejected("not_allowed", t("plugins.settings.noRemoval", { title }));
        }
        const changed = await host.remove(name);
        for (const n of changed) {
          if (n === name) continue;
          disabled.add(n);
          removed.delete(n);
        }
        removed.add(name);
        disabled.delete(name);
        save();
        if (!spec) return { changed, plugins: plugins() };
        // 停着的视图不随彻底删除重放：删的时候先登记回去，和在用的视图一起按改写后的日志重放（"已删除"标记跳过、提交后检查点），删完再记回停着的
        const { store } = options.purge;
        const views = host.viewsOf(name);
        for (const view of views) store.attachView(view);
        let purged: PluginPurgeCounts;
        try {
          purged = purgePluginData(options.purge, name, spec, request.idempotencyKey);
        } finally {
          for (const view of views) store.detachView(view.name);
        }
        log(`设置里移除了插件 ${name}，连它的数据一起彻底删除了`);
        return { changed, purged, plugins: plugins() };
      } finally {
        busy = false;
      }
    },
  };
}
