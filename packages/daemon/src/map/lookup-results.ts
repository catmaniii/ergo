// 查到的、能画在地图上的那一份（432）：只在内存里留一会儿，给 431 的"画在地图上"工具、聊天里的地图卡片按编号取。
// - 编号写进给模型的工具结果（"amap-r1"）：模型调 show_on_map 时带上它，守护进程从这里取出点和线（WGS-84）画——
//   坐标不经模型转手，模型也不用抄一长串折线；
// - 不落盘、不进记忆素材（高德的协议不许存、不许缓存）：守护进程重启就没了；最多留 LOOKUP_KEEP 份、每份 LOOKUP_TTL_MS，
//   过期的、挤出去的取不到（431 那边说"结果过期了，再查一次"）。
import type { MapLookupDrawing } from "@ergo/protocol";

/** 每份留多久（毫秒） */
export const LOOKUP_TTL_MS = 2 * 60 * 60_000;
/** 最多留几份（多了把最老的挤掉） */
export const LOOKUP_KEEP = 30;

export interface LookupResults {
  /** 放一份，交回编号（前缀是数据来源加种类：amap-p 地点、amap-r 路线、amap-a 地址） */
  put(drawing: Omit<MapLookupDrawing, "id">): string;
  /** 按编号取；过期、挤掉了、没有是 undefined */
  get(id: string): MapLookupDrawing | undefined;
  /** 全部扔掉（插件停用时） */
  clear(): void;
}

const PREFIX: Readonly<Record<MapLookupDrawing["kind"], string>> = { places: "p", route: "r", address: "a" };

export function createLookupResults(options: { now: () => number; ttlMs?: number; keep?: number }): LookupResults {
  const ttl = options.ttlMs ?? LOOKUP_TTL_MS;
  const keep = options.keep ?? LOOKUP_KEEP;
  const kept = new Map<string, { drawing: MapLookupDrawing; until: number }>();
  let seq = 0;
  return {
    put(drawing) {
      seq += 1;
      const id = `${drawing.source}-${PREFIX[drawing.kind]}${seq}`;
      kept.set(id, { drawing: { ...drawing, id }, until: options.now() + ttl });
      // Map 按放进去的先后：多了删最老的
      while (kept.size > keep) kept.delete(kept.keys().next().value!);
      return id;
    },
    get(id) {
      const entry = kept.get(id);
      if (!entry) return undefined;
      if (entry.until <= options.now()) {
        kept.delete(id);
        return undefined;
      }
      return entry.drawing;
    },
    clear: () => kept.clear(),
  };
}
