// 内置浏览器插件自己的体检项（414），在 setup 里经 ctx.doctor.register 登记，passive（只读内存里记的次数）。
// 二狗已经替它生成的只有"插件本身"。这里加"缩略图"（thumbnails）：候选的缩略图（page-thumbnails.ts）、秘书看图（file-tools.ts 的
// view_files）都经内核的一次性子进程缩小图片（KERNEL.thumbnails），子进程起不来、超时、崩了以前只记日志——
// 插件在 setup 里把 KERNEL.thumbnails 包一层（countThumbnailFailures），两处都用包过的，记下缩了几次、连着出错几次、一共出错几次、
// 最近一次的时间和原因（单张不是图片、坏图不算出错：那是子进程照常交回的结果）。
// - 这次开机后还没缩过图 → 不适用；最近一次出错了（连着几次）→ 注意，从这一串开头起；出错过、后来又好了 → 正常（写一共几次）；
//   都没出错 → 正常。都在内存里，重启就没。
import type { ThumbnailRequest, ThumbnailResult } from "../runtime/index.ts";
import { doctorTime } from "../doctor/auto.ts";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";

/** 出错原因最多带多少字 */
const ERROR_MAX = 200;

/** 缩略图子进程这次开机以来怎么样 */
export interface ThumbnailStats {
  /** 缩了几次（一批一次） */
  calls: number;
  /** 连着出错几次（成功一次清零） */
  failures: number;
  /** 一共出错几次 */
  total: number;
  /** 这一串出错从什么时候起、最近一次的时间和原因（出过错才有） */
  since?: string;
  at?: string;
  error?: string;
}

/** 把缩小图片包一层，记下次数（交回包过的和读次数的） */
export function countThumbnailFailures(thumbnails: (request: ThumbnailRequest) => Promise<ThumbnailResult>, now: () => string) {
  const stats: ThumbnailStats = { calls: 0, failures: 0, total: 0 };
  const counted = async (request: ThumbnailRequest): Promise<ThumbnailResult> => {
    stats.calls += 1;
    try {
      const result = await thumbnails(request);
      stats.failures = 0;
      return result;
    } catch (err) {
      const at = now();
      if (stats.failures === 0) stats.since = at;
      stats.failures += 1;
      stats.total += 1;
      stats.at = at;
      stats.error = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX);
      throw err;
    }
  };
  return { thumbnails: counted, stats: (): ThumbnailStats => ({ ...stats }) };
}

/** 缩略图那一项 */
export function thumbnailsFinding(stats: ThumbnailStats): DoctorFinding {
  if (stats.calls === 0) return { level: "na", fact: { key: "browsing.doctor.thumbnails.idle" } };
  if (stats.failures > 0) {
    return {
      level: "warn",
      fact: { key: "browsing.doctor.thumbnails.failing", params: { count: stats.failures, time: doctorTime(stats.at!), error: stats.error ?? "" } },
      fix: { key: "browsing.doctor.thumbnails.fix" },
      ...(stats.since === undefined ? {} : { since: stats.since }),
    };
  }
  if (stats.total > 0) return { level: "ok", fact: { key: "browsing.doctor.thumbnails.recovered", params: { count: stats.total } } };
  return { level: "ok", fact: { key: "browsing.doctor.thumbnails.ok", params: { count: stats.calls } } };
}

/** "缩略图"那一项：stats 现取 */
export function thumbnailsCheck(stats: () => ThumbnailStats): DoctorCheck {
  return { id: "thumbnails", title: "browsing.doctor.thumbnails.title", cost: "passive", run: () => thumbnailsFinding(stats()) };
}
