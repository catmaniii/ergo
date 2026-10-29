// 数据源的登记表（295 号票，ADR-0027 的"数据源"贡献点）：插件在数据契约里登记的数据源（plugins/host.ts 的 ContractContext.dataSources）
// 进这里，带上登记它的插件（插件名、给人看的名字、此刻在不在运行）。和运行时的登记表（runtime/runtimes.ts）一个路数：
// 不管插件开没开都登记——停用的插件的数据源照样在设置 · 数据源里列出（写"X插件没启用"），断开并删照样删得掉它导入的记录；
// 要插件在运行才能做的（连接状态、同步、导入文件、按需查的工具）由服务（service.ts）先看 owner.running() 再叫。
import { SENSITIVE_CATEGORIES } from "../config/config.ts";
import type { DataSource } from "./api.ts";

/** 登记这个数据源的插件：插件名、给人看的名字（"X插件没启用"里用）、现在在不在运行 */
export interface DataSourceOwner {
  readonly plugin: string;
  readonly title: string;
  running(): boolean;
}

export interface DataSourceEntry {
  readonly source: DataSource;
  readonly owner: DataSourceOwner;
}

export interface DataSourceRegistry {
  /** 登记一个数据源；id 不合规矩、重复了、敏感类别写错了都抛错（写错了代码）。返回撤销函数 */
  register(source: DataSource, owner: DataSourceOwner): () => void;
  /** 按登记的先后（插件清单的先后，同一个插件按它登记的先后） */
  list(): readonly DataSourceEntry[];
  get(id: string): DataSourceEntry | undefined;
}

/** 数据源 id 的规矩（用法开关、密钥区的文件名、同步记录都按它记） */
const DATA_SOURCE_ID = /^[a-z][a-z0-9-]*$/;

export function createDataSourceRegistry(): DataSourceRegistry {
  const entries: DataSourceEntry[] = [];
  return {
    register(source, owner) {
      // @i18n-ignore-start log：编程错误
      if (!DATA_SOURCE_ID.test(source.id)) throw new Error(`数据源的 id 不合规矩（小写英文、数字和连字符）：${source.id}`);
      if (entries.some((e) => e.source.id === source.id)) throw new Error(`数据源 ${source.id} 已经登记过了`);
      const wrong = (source.sensitive ?? []).filter((c) => !(SENSITIVE_CATEGORIES as readonly string[]).includes(c));
      if (wrong.length > 0) throw new Error(`数据源 ${source.id} 的敏感类别写错了：${wrong.join("、")}（认得的：${SENSITIVE_CATEGORIES.join("、")}）`);
      if (source.usages.query && !source.tools) throw new Error(`数据源 ${source.id} 说能按需查，却没给 tools()`);
      if (source.usages.import && !source.sync && !source.push && !(source.files && source.files.length > 0)) throw new Error(`数据源 ${source.id} 说能导入，却 sync()、push、认的文件一样都没给`);
      if (source.push && !source.usages.import) throw new Error(`数据源 ${source.id} 收设备交来的（push），却没说能导入`);
      for (const file of source.files ?? []) {
        if (!file.extensions && !file.names && !file.sniff) throw new Error(`数据源 ${source.id} 认的文件"${file.title}"扩展名、文件名、内容特征一样都没写`);
      }
      // @i18n-ignore-end
      const entry: DataSourceEntry = { source, owner };
      entries.push(entry);
      return () => {
        const at = entries.indexOf(entry);
        if (at >= 0) entries.splice(at, 1);
      };
    },
    list: () => [...entries],
    get: (id) => entries.find((e) => e.source.id === id),
  };
}
