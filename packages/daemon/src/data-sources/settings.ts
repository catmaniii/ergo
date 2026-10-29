// 数据源的用法开关（295 号票）：配置区的 data-sources.json——{ format: 1, usages: { <数据源 id>: { query?: boolean, import?: boolean } } }。
// 只记用户改过的（没写的按数据源登记的默认）；只由运行时写（设置 · 数据源）。读坏了的文件当作没改过（照默认），日志里写一句，
// 下一次改的时候整份重写。
import fs from "node:fs";
import path from "node:path";
import type { DataSourceUsage } from "@ergo/protocol";

interface UsageFile {
  format: 1;
  usages: Record<string, Partial<Record<DataSourceUsage, boolean>>>;
}

export interface DataSourceSettings {
  /** 用户改过的（没改过是 undefined，照默认） */
  usage(id: string, usage: DataSourceUsage): boolean | undefined;
  setUsage(id: string, usage: DataSourceUsage, on: boolean): void;
}

export function createDataSourceSettings(options: { file: string; log: (line: string) => void }): DataSourceSettings {
  let cache: UsageFile | undefined;
  const load = (): UsageFile => {
    if (cache) return cache;
    cache = { format: 1, usages: {} };
    if (fs.existsSync(options.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(options.file, "utf8")) as Partial<UsageFile>;
        if (parsed.usages && typeof parsed.usages === "object") cache = { format: 1, usages: parsed.usages };
      } catch (err) {
        options.log(`数据源的用法开关 ${options.file} 读不了，照默认：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return cache;
  };
  return {
    usage(id, usage) {
      const value = load().usages[id]?.[usage];
      return typeof value === "boolean" ? value : undefined;
    },
    setUsage(id, usage, on) {
      const current = load();
      current.usages = { ...current.usages, [id]: { ...current.usages[id], [usage]: on } };
      fs.mkdirSync(path.dirname(options.file), { recursive: true });
      const tmp = `${options.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`);
      fs.renameSync(tmp, options.file);
    },
  };
}
