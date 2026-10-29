// 候选的缩略图（149 号票，用户 2026-10-18："显示候选图片的时候应该显示的是缩略图，否则我一加载就加载半天。缩略图放在固定的
// 临时文件夹下，定期清理"）：网页上的挑图片窗口、会话里的网页候选卡凭取件码取 GET /api/page-files/<取件码>/thumb，不再下原图来缩
// （手机经隧道取原图，图一多就要等很久）。
// - 怎么缩：和 view_files 一样用 pi 自带的图片缩放（AgentManager.thumbnails，一次性子进程，不加依赖），长边 PAGE_THUMB_EDGE；
//   pi 的缩放缩小后先试 PNG 再试 JPEG（照片多半是 JPEG，大片纯色的截图是 PNG），存成哪种就按哪种回；
// - 存在哪：数据目录缓存区的固定文件夹（cache/page-thumbnails/，不进备份），文件名是"文件路径 + 修改时间 + 大小"的哈希——同一张图
//   换一组候选、再找一次都直接用；
// - 什么时候做：秘书给候选（网页候选卡建出来）那一刻就在后台先做（warm，一批一个子进程）；请求到了还没做好的等它，没排上的现做；
//   同时只缩一批，不抢机器；做不出来的（不是图片、坏图）记下，不反复试；
// - 清理：守护进程起来时扫一遍，之后每 PAGE_THUMBS_SWEEP_MS 扫一遍——超过 PAGE_THUMB_KEEP_MS 没用过的删掉，加起来超过
//   PAGE_THUMBS_MAX_BYTES 的从最久没用的删起（用过一次就把文件的修改时间改成现在，"最久没用"按它算）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PAGE_THUMB_EDGE } from "@ergo/protocol";
import type { ThumbnailRequest, ThumbnailResult } from "../runtime/index.ts";

/** 多久没用的缩略图删掉 */
export const PAGE_THUMB_KEEP_MS = 24 * 60 * 60_000;
/** 缩略图加起来最多多大，超了从最久没用的删起 */
export const PAGE_THUMBS_MAX_BYTES = 200 * 1024 * 1024;
/** 多久扫一遍 */
export const PAGE_THUMBS_SWEEP_MS = 60 * 60_000;
/** 做不出来的记几个（多了丢最早的） */
const FAILED_KEPT = 500;

/** 要缩的一个文件：本机路径、类型、是不是图片（取件码上记着的那些） */
export interface ThumbSource {
  path: string;
  mime: string;
  image: boolean;
}

/** 做好的缩略图：文件和类型 */
export interface ThumbFile {
  file: string;
  mime: string;
}

export interface PageThumbnails {
  /** 这个文件的缩略图；不是图片、做不出来、文件没了是 undefined */
  get(source: ThumbSource): Promise<ThumbFile | undefined>;
  /** 候选建出来时在后台先做好（不等） */
  warm(sources: readonly ThumbSource[]): void;
  /** 扫一遍：删掉太久没用的、超了总量的；回删了几个 */
  sweep(): number;
  /** 起来时扫一遍，之后定时扫 */
  start(): void;
  stop(): void;
}

export interface PageThumbnailsOptions {
  dir: string;
  /** 缩小几张图（AgentManager.thumbnails） */
  thumbnails: (request: ThumbnailRequest) => Promise<ThumbnailResult>;
  log: (line: string) => void;
  now?: () => number;
  keepMs?: number;
  maxBytes?: number;
  sweepMs?: number;
}

const EXT: Readonly<Record<string, string>> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MIME_OF_EXT: Readonly<Record<string, string>> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** 文件的键：路径 + 修改时间 + 大小的哈希；文件没了是 undefined */
function keyOf(source: ThumbSource): string | undefined {
  try {
    const st = fs.statSync(source.path);
    return createHash("sha1").update(`${path.resolve(source.path)}|${Math.round(st.mtimeMs)}|${st.size}`).digest("hex");
  } catch {
    return undefined;
  }
}

export function createPageThumbnails(options: PageThumbnailsOptions): PageThumbnails {
  const now = options.now ?? Date.now;
  const keepMs = options.keepMs ?? PAGE_THUMB_KEEP_MS;
  const maxBytes = options.maxBytes ?? PAGE_THUMBS_MAX_BYTES;
  /** 正在做的（键 → 做完的结果） */
  const making = new Map<string, Promise<ThumbFile | undefined>>();
  /** 做不出来的（键） */
  const failed = new Set<string>();
  /** 同时只缩一批：一批做完再做下一批 */
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;

  /** 做好了的缩略图（顺手记一下用过） */
  const cached = (key: string): ThumbFile | undefined => {
    for (const [ext, mime] of Object.entries(MIME_OF_EXT)) {
      const file = path.join(options.dir, `${key}.${ext}`);
      try {
        const t = new Date(now());
        fs.utimesSync(file, t, t);
        return { file, mime };
      } catch {
        // 没有这一种
      }
    }
    return undefined;
  };

  /** 缩一批（排队），每个键回它的结果 */
  const make = (batch: Array<{ key: string; source: ThumbSource }>): void => {
    const run = queue.then(async () => {
      let result: ThumbnailResult;
      try {
        result = await options.thumbnails({ files: batch.map((b) => ({ path: b.source.path, mime: b.source.mime })), maxEdge: PAGE_THUMB_EDGE });
      } catch (err) {
        options.log(`候选的缩略图没做出来：${err instanceof Error ? err.message : String(err)}`);
        return batch.map(() => undefined);
      }
      fs.mkdirSync(options.dir, { recursive: true });
      return batch.map((b, i): ThumbFile | undefined => {
        const thumb = result.thumbs[i];
        const ext = thumb?.ok ? EXT[thumb.mime] : undefined;
        if (!thumb?.ok || !ext) {
          failed.add(b.key);
          while (failed.size > FAILED_KEPT) failed.delete(failed.values().next().value!);
          return undefined;
        }
        const file = path.join(options.dir, `${b.key}.${ext}`);
        try {
          fs.writeFileSync(file, Buffer.from(thumb.data, "base64"));
          const t = new Date(now());
          fs.utimesSync(file, t, t);
          return { file, mime: thumb.mime };
        } catch (err) {
          options.log(`候选的缩略图存不下：${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      });
    });
    queue = run.catch(() => undefined);
    batch.forEach((b, i) => {
      const one = run.then((all) => all[i], () => undefined);
      making.set(b.key, one);
      void one.finally(() => making.delete(b.key));
    });
  };

  /** 要做的：没做过、没在做、没做坏过的图片 */
  const pending = (sources: readonly ThumbSource[]) => {
    const out: Array<{ key: string; source: ThumbSource }> = [];
    for (const source of sources) {
      if (!source.image) continue;
      const key = keyOf(source);
      if (!key || failed.has(key) || making.has(key) || out.some((o) => o.key === key) || cached(key)) continue;
      out.push({ key, source });
    }
    return out;
  };

  const sweep = (): number => {
    let entries: Array<{ file: string; size: number; used: number }>;
    try {
      entries = fs.readdirSync(options.dir).flatMap((name) => {
        const file = path.join(options.dir, name);
        try {
          const st = fs.statSync(file);
          return st.isFile() ? [{ file, size: st.size, used: st.mtimeMs }] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return 0;
    }
    const cutoff = now() - keepMs;
    let removed = 0;
    const remove = (file: string) => {
      try {
        fs.unlinkSync(file);
        removed += 1;
      } catch {
        // 删不掉（正被读着）：下次再说
      }
    };
    const kept = entries.filter((e) => {
      if (e.used >= cutoff) return true;
      remove(e.file);
      return false;
    });
    let total = kept.reduce((sum, e) => sum + e.size, 0);
    for (const e of kept.toSorted((a, b) => a.used - b.used)) {
      if (total <= maxBytes) break;
      remove(e.file);
      total -= e.size;
    }
    if (removed > 0) options.log(`候选的缩略图清掉 ${removed} 个`);
    return removed;
  };

  return {
    async get(source) {
      if (!source.image) return undefined;
      const key = keyOf(source);
      if (!key || failed.has(key)) return undefined;
      const hit = cached(key);
      if (hit) return hit;
      if (!making.has(key)) make([{ key, source }]);
      return (await making.get(key)) ?? cached(key);
    },
    warm(sources) {
      const todo = pending(sources);
      if (todo.length > 0) make(todo);
    },
    sweep,
    start() {
      sweep();
      timer ??= setInterval(sweep, options.sweepMs ?? PAGE_THUMBS_SWEEP_MS);
      timer.unref?.();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
