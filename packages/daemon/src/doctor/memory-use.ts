// 体检"二狗本身"的"二狗占的内存"（439）：守护进程这个 node 进程现在占多少、其中 JS 堆多少、这次起来以后最多占过多少、
// 向量模型加载着没有，再带一句它拉起的程序（语音识别的 Python、内置浏览器、agent 子进程……）另占多少。
// 只读本进程和子孙进程的计数（process.memoryUsage、K32GetProcessMemoryInfo），不另起进程、不改东西。
//
// - "占多少"看私有提交（这个进程自己要下的内存，挤到页面文件里的也算）；读不到时（不是 Windows、调不通）退回工作集。
//   工作集在系统内存紧时会被挤小（语音识别的 Python 私有 3 GB、工作集只有 10 MB 的时候都有），不拿它判；
// - 平时的量：二狗自己约 0.2–0.5 GB；向量模型加载着再加约 0.6–1.2 GB（闲 10 分钟卸掉，见 materials/embedding/worker-host.ts）；
//   算一批长文字时短暂再多 1 GB 上下（每批有上限，见 materials/embedding/batching.ts；算完就还）；
// - 现在占的 ≥ MEMORY_WARN_BYTES 算注意：439 那次就是向量模型一批补齐到 1900 多 token、占到 8.7 GB。
//   起来以后的最高值只写进事实，不单独算注意（过去的事，重启前一直挂着没用）；
// - 它拉起的程序只说，不判：语音识别的大模型本来就要好几 GB，那是语音那一块的事。
import { formatList, t } from "@ergo/protocol";
import { descendantsOf, processCreationTimes, processMemory, processSnapshot } from "../process/process-list.ts";
import type { DoctorFinding } from "./checks.ts";
import { sizeText } from "./housekeeping.ts";

/** 二狗自己占到多少算注意 */
export const MEMORY_WARN_BYTES = 3 * 1024 ** 3;
/** 它拉起的程序最多点名几个（按占的从多到少） */
const CHILDREN_NAMED = 3;

/** 读到的样子（字节） */
export interface MemoryUse {
  /** 二狗自己现在占的（私有提交；读不到时是工作集） */
  used: number;
  /** 这次起来以后最多占过的（同上，读不到私有提交时是工作集的最高值） */
  peak: number;
  /** 其中 JS 堆用着的 */
  heapUsed: number;
  /** 向量模型现在加载着没有；没有向量模型、不知道是 undefined */
  embedderLoaded?: boolean;
  /** 它拉起的程序（子孙进程）各占多少（私有提交），按从多到少；读不到是空 */
  children: ReadonlyArray<{ exe: string; used: number }>;
}

/** 读本进程（和子孙进程）的内存计数；embedderLoaded 现取向量模型的状态 */
export function readMemoryUse(embedderLoaded?: () => boolean | undefined): MemoryUse {
  const usage = process.memoryUsage();
  let used = usage.rss;
  // resourceUsage().maxRSS 是工作集的最高值（KB）
  let peak = Math.max(usage.rss, process.resourceUsage().maxRSS * 1024);
  let children: Array<{ exe: string; used: number }> = [];
  if (process.platform === "win32") {
    try {
      const own = processMemory([process.pid]).get(process.pid);
      if (own) {
        used = own.private;
        peak = Math.max(own.peakPrivate, own.private);
      }
      const snapshot = processSnapshot();
      const candidates = descendantsOf(process.pid, snapshot);
      if (candidates.length > 0) {
        const pids = descendantsOf(process.pid, snapshot, processCreationTimes([process.pid, ...candidates]));
        const counts = processMemory(pids);
        children = pids.flatMap((pid) => {
          const count = counts.get(pid);
          return count === undefined ? [] : [{ exe: snapshot.get(pid)?.exe ?? String(pid), used: count.private }];
        });
        children.sort((a, b) => b.used - a.used);
      }
    } catch {
      // 读不到就只报 node 自己给的数（工作集），不算这一项出错
    }
  }
  const loaded = embedderLoaded?.();
  return { used, peak, heapUsed: usage.heapUsed, ...(loaded === undefined ? {} : { embedderLoaded: loaded }), children };
}

/** 判：二狗自己占的超过 MEMORY_WARN_BYTES 算注意；事实里带 JS 堆、向量模型、起来以后最多的、它拉起的程序 */
export function judgeMemoryUse(use: MemoryUse, warnAt: number = MEMORY_WARN_BYTES): DoctorFinding {
  const model = use.embedderLoaded === undefined ? "" : t(use.embedderLoaded ? "doctor.memoryUse.modelLoaded" : "doctor.memoryUse.modelIdle");
  const childTotal = use.children.reduce((sum, child) => sum + child.used, 0);
  const children =
    use.children.length === 0
      ? ""
      : t("doctor.memoryUse.children", {
          total: sizeText(childTotal),
          list: formatList(use.children.slice(0, CHILDREN_NAMED).map((child) => t("doctor.memoryUse.child", { exe: child.exe, size: sizeText(child.used) }))),
        });
  const params = { used: sizeText(use.used), heap: sizeText(use.heapUsed), peak: sizeText(use.peak), model, children };
  if (use.used < warnAt) return { level: "ok", fact: { key: "doctor.memoryUse.fine", params } };
  return { level: "warn", fact: { key: "doctor.memoryUse.over", params: { ...params, limit: sizeText(warnAt) } }, fix: { key: "doctor.fix.memoryUse" } };
}
