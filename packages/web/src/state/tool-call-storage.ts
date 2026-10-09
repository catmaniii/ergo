// 设置里的"工具调用的完整内容"（65 号票）：守护进程另存的每次调用的完整参数和返回占了多大、留多久、总量上限，
// "现在就清理"会清掉多少、清完怎么说。纯函数，界面（pages/more/ToolCallStorageSetting.tsx）只管画；能不能点看 canClean。
import type { ToolCallCleanupResult, ToolCallStorageView } from "./protocol.ts";
import { sizeLabel } from "./detail-content.ts";

export interface ToolCallStorageText {
  /** 占了多大、存着几次调用的完整内容、清掉过几次 */
  readonly usage: string;
  /** 规则：保留多少天、总量上限，还被用着的不清 */
  readonly rule: string;
  /** 照现在的规则马上清会清掉多少；到期了但还被用着的另说 */
  readonly due: string;
  /** 有可清的才能点"现在就清理" */
  readonly canClean: boolean;
  /** 点了之后确认框里的话；没有可清的是 undefined */
  readonly confirm: string | undefined;
}

/** 配置里的上限：整数不带小数（2 GB、512 MB） */
function limitLabel(n: number): string {
  if (n >= 1024 ** 3) return `${Number((n / 1024 ** 3).toFixed(2))} GB`;
  if (n >= 1024 ** 2) return `${Number((n / 1024 ** 2).toFixed(1))} MB`;
  return sizeLabel(n);
}

export function toolCallStorageText(view: ToolCallStorageView): ToolCallStorageText {
  const { due } = view;
  const kept = (lead: string) => (due.inUse > 0 ? `；${lead} ${due.inUse} 次到期了但还被用着，先不清` : "");
  const dueSize = `约 ${sizeLabel(due.bytes)}`;
  return {
    usage: `占 ${sizeLabel(view.bytes)}，${view.calls} 次调用存着完整内容${view.cleared > 0 ? `，${view.cleared} 次已经清掉、只剩摘要` : ""}`,
    rule: `保留 ${view.retentionDays} 天、总量最多 ${limitLabel(view.maxBytes)}，超出的从最旧的起清；没结束的任务里的、待办里还引用着的不清。每天自动清一次`,
    due: due.calls > 0 ? `现在可以清掉 ${due.calls} 次（${dueSize}）${kept("另有")}` : `现在没有要清的${kept("有")}`,
    canClean: due.calls > 0,
    confirm:
      due.calls > 0
        ? `按现在的规则清掉 ${due.calls} 次调用的完整内容（${dueSize}）？清掉的只是完整参数和返回：聊天里的记录、要点、效果记录照旧，详情页里退回摘要。清掉后找不回来。`
        : undefined,
  };
}

/** 清完怎么说（"现在就清理"之后的提示） */
export function toolCallCleanupText(result: ToolCallCleanupResult): string {
  const cleared = result.expired + result.overLimit;
  if (cleared > 0) return `清掉了 ${cleared} 次调用的完整内容，腾出 ${sizeLabel(result.freedBytes)}`;
  return result.keptInUse > 0 ? `没有要清的（${result.keptInUse} 次到期了但还被用着，先不清）` : "没有要清的";
}
