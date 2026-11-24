// 这台电脑上配置的其他各份二狗（468）：守卫（GuardPlaces.otherInstances：它们的文件夹、端口、服务管家日志目录里它们的日志一律拒绝）、
// 秘书的服务管家工具（不列、不碰它们和它们名下的服务）要的。
// 从服务管家的注册表现读（cli/instances.ts 的 registeredInstances）：新建的一份、拿掉的一份，在跑的这一份都跟得上；
// 读一次留 OTHER_INSTANCES_STALE_MS，免得每次判定都扫一遍目录。
// 默认那份（~/.ergo）没登记时：这一份不是默认那份、那个文件夹又在的话照样算一份（登记拿掉了，数据还在）。
// 只读服务管家的注册表、各份的 config/ergo.json 和日志目录的文件名，不连服务管家、不改任何东西。
import fs from "node:fs";
import { DEFAULT_SERVICE_ID, instanceLogFiles, instancePorts, registeredInstances } from "../cli/instances.ts";
import { resolveDataDir } from "../config/data-dir.ts";
import { isWithin, type OtherInstance } from "../guard/index.ts";
import { realPathOf } from "../util/real-path.ts";

/** 读一次留多久（毫秒） */
export const OTHER_INSTANCES_STALE_MS = 3_000;

export interface OtherInstancesOptions {
  /** 服务管家的数据目录 */
  svcDataDir: string;
  /** 这一份自己的登记 id */
  selfId: string;
  /** 这一份自己的数据目录 */
  ownDataDir: string;
  /** 用户主目录：默认那份没在登记里写数据目录时按它下面的 .ergo */
  homeDir: string;
  now?: () => number;
}

export interface OtherInstances {
  /** 其他各份（读的结果留一会儿） */
  current(): readonly OtherInstance[];
  /** 其他各份的登记 id */
  ids(): string[];
}

export function otherInstances(options: OtherInstancesOptions): OtherInstances {
  const now = options.now ?? Date.now;
  let cache: { at: number; list: OtherInstance[] } | undefined;

  const one = (id: string, dir: string, probePort?: number): OtherInstance | undefined => {
    const real = realPathOf(dir);
    const dirs = [...new Set([dir, ...(real === undefined ? [] : [real])])];
    // 这一份自己就是它、或者在它里面（叠着放的，ergo init 不让这样建）：不当别的一份，免得把自己挡在外面
    if (dirs.some((d) => isWithin(options.ownDataDir, d))) return undefined;
    const ports = instancePorts(dir);
    return {
      id,
      dataDirs: dirs,
      ports: [...new Set([ports.local, ports.external, ...(probePort === undefined ? [] : [probePort])])],
      logFiles: instanceLogFiles(options.svcDataDir, id),
    };
  };

  const read = (): OtherInstance[] => {
    const list: OtherInstance[] = [];
    const registered = registeredInstances(options.svcDataDir);
    for (const i of registered) {
      if (i.id === options.selfId) continue;
      const found = one(i.id, i.dataDir ?? resolveDataDir({}, options.homeDir), i.probePort);
      if (found) list.push(found);
    }
    if (options.selfId !== DEFAULT_SERVICE_ID && !registered.some((i) => i.id === DEFAULT_SERVICE_ID)) {
      const dir = resolveDataDir({}, options.homeDir);
      const found = fs.existsSync(dir) ? one(DEFAULT_SERVICE_ID, dir) : undefined;
      if (found) list.push(found);
    }
    return list;
  };

  const current = (): readonly OtherInstance[] => {
    const at = now();
    if (cache === undefined || at - cache.at >= OTHER_INSTANCES_STALE_MS || at < cache.at) {
      try {
        cache = { at, list: read() };
      } catch {
        // 读不了注册表：照上一次的（第一次就是没有）
        cache = { at, list: cache?.list ?? [] };
      }
    }
    return cache.list;
  };

  return { current, ids: () => current().map((o) => o.id) };
}
