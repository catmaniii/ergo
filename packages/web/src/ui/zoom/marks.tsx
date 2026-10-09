// 缩小后条右侧的标注（54 号票先把 25 号票要点层、全局层标出的东西都标上，不丢信息；
// 标注的完整内容和样式——×N、左侧任务卡或工单卡、底色带、书脊、补齐图例——是 55 号票的事）。
// 一个要点（state/timeline.ts 的 TimelineMark）一条标注，写法照 25 号票：
// - 操作（工具调用、操作记录）：样式的说法（授权内、做完告诉我、被拦下、问过、你点明的、你确认后）、命中的关注类别（⚠）、通用 bash、
//   结果（被拦下的原因、你拒绝了、等你批准、出错）；
// - 审批：要批的事和批了没有；验收：结论；时间线记录（偏离、范围变更、越界……）：种类。
// 颜色（AgentSense 的 r-high / r-op / r-data / r-fix）：被拦下或问过、严重的记录是 high；做完告诉我、命中类别的、一般的记录是 op；
// 授权内是 fix（绿）；只是通用 bash、说明性的记录是 data。
import { useCard } from "../../app/store.tsx";
import { outcomeLabel } from "../../model/cards.ts";
import { GENERIC_BASH_LABEL, MARK_KIND_LABEL, OP_REASON, type TimelineMark } from "../../state/index.ts";

export type RiskLevel = "high" | "op" | "data" | "fix";

/** 一条标注的颜色档（条右上角的小圆点也按它：有 high 的用高亮色） */
export function markLevel(mark: TimelineMark): RiskLevel {
  if (mark.style === "stopped" || mark.severity === "alert") return "high";
  if (mark.style === "notify" || mark.severity === "notice" || mark.categories.length > 0) return "op";
  if (mark.style === "granted") return "fix";
  return "data";
}

/** 审批要点：批了没有（还没处理的写待你处理） */
function ApprovalState({ cardId }: { cardId: string }) {
  const card = useCard(cardId)?.card;
  if (!card) return null;
  return <> · {card.status === "pending" ? "待你处理" : outcomeLabel(card)}</>;
}

/** 标注上写的字（详细的一句放在 title 里，悬停看） */
function chipText(mark: TimelineMark): string {
  const style = mark.reason ? OP_REASON[mark.reason].label : undefined;
  const cats = mark.categories.map((c) => `⚠${c}`);
  const bash = mark.genericBash ? [GENERIC_BASH_LABEL] : [];
  const parts =
    mark.kind === "tool"
      ? [style, ...cats, ...bash, mark.outcome]
      : mark.kind === "operation"
        ? [`${MARK_KIND_LABEL.operation}：${mark.short}`, style, ...cats]
        : mark.kind === "acceptance"
          ? [mark.title]
          : [MARK_KIND_LABEL[mark.kind], ...cats];
  return parts.filter((x): x is string => !!x).join(" · ");
}

/** 一条标注：data-mark 对着对话层里那一行（箭头指过去），svg 是箭头（ZoomHistory 的 layoutAnnotations 画） */
export function MarkChip({ mark }: { mark: TimelineMark }) {
  const title = [mark.title, mark.outcome, mark.note].filter(Boolean).join(" · ");
  return (
    <span data-mark={mark.key} className={`zd-risk r-${markLevel(mark)}`} title={title}>
      <svg className="zd-risk-leader" aria-hidden="true">
        <path />
      </svg>
      {chipText(mark)}
      {mark.cardId && <ApprovalState cardId={mark.cardId} />}
    </span>
  );
}
