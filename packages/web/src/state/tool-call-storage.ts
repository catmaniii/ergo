// 设置里的"工具调用的完整内容"（65 号票）：守护进程另存的每次调用的完整参数和返回占了多大、留多久、总量上限，
// "现在就清理"会清掉多少、清完怎么说。纯函数，界面（pages/more/ToolCallStorageSetting.tsx）只管画；能不能点看 canClean。
import { t, type ToolCallCleanupResult, type ToolCallStorageView } from "./protocol.ts";
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
  const kept = (another: boolean) =>
    due.inUse > 0 ? t(another ? "state.toolCallStorage.keptAnother" : "state.toolCallStorage.kept", { count: due.inUse, n: due.inUse }) : "";
  const dueSize = sizeLabel(due.bytes);
  const cleared = view.cleared > 0 ? t("state.toolCallStorage.usageCleared", { count: view.cleared, n: view.cleared }) : "";
  return {
    usage: t("state.toolCallStorage.usage", { size: sizeLabel(view.bytes), count: view.calls, calls: view.calls, cleared }),
    rule: t("state.toolCallStorage.rule", { count: view.retentionDays, days: view.retentionDays, max: limitLabel(view.maxBytes) }),
    due:
      due.calls > 0
        ? t("state.toolCallStorage.due", { count: due.calls, n: due.calls, size: dueSize, kept: kept(true) })
        : t("state.toolCallStorage.nothingDue", { kept: kept(false) }),
    canClean: due.calls > 0,
    confirm: due.calls > 0 ? t("state.toolCallStorage.confirm", { count: due.calls, n: due.calls, size: dueSize }) : undefined,
  };
}

/** 清完怎么说（"现在就清理"之后的提示） */
export function toolCallCleanupText(result: ToolCallCleanupResult): string {
  const cleared = result.expired + result.overLimit;
  if (cleared > 0) return t("state.toolCallStorage.cleaned", { count: cleared, n: cleared, size: sizeLabel(result.freedBytes) });
  return result.keptInUse > 0 ? t("state.toolCallStorage.nothingKept", { count: result.keptInUse, n: result.keptInUse }) : t("state.toolCallStorage.nothing");
}
