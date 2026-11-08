// 缩小后条右侧的标注（先把要点层、全局层标出的东西都标上，不丢信息；补齐 ×N、左侧任务卡或工单卡、
// 底色带、书脊和图例，见 ZoomHistory.tsx、state/zoom-decor.ts）。
// 一个要点（state/timeline.ts 的 TimelineMark）一条标注，写的字由状态层给（state/mark-chip.ts 的 markChip；
// 连着几块的合成一条、写 ×N 或"等 N 次"在 zoom-decor.ts 的 rightMarks）：前一段是种类或样式、结果、⚠类别，后面是一句具体的，
// 审批最后接批了没有。一行放得下就接着写，放不下最多两行（zoom.css 的 .zd-chip：前一段最多一行，那句话接着折行截到两行；
// "等 N 次"和批了没有跟在字后面，两行放不下时也不截掉）；完整的在悬停文字里。
// 颜色：被拦下或问过、严重的记录是 high；做完告诉我、命中类别的、一般的记录是 op；
// 授权内是 fix（绿）；只是通用 bash、说明性的记录是 data。
import { markChip, type MarkChipText, type TimelineMark } from "../../state/index.ts";
import { NamedText, useNamedPlain } from "../assistant-name.tsx";

export type RiskLevel = "high" | "op" | "data" | "fix";

/** 一条标注的颜色档（条右上角的小圆点也按它：有 high 的用高亮色） */
export function markLevel(mark: TimelineMark): RiskLevel {
  if (mark.style === "stopped" || mark.severity === "alert") return "high";
  if (mark.style === "notify" || mark.severity === "notice" || mark.categories.length > 0) return "op";
  if (mark.style === "granted") return "fix";
  return "data";
}

/**
 * 一条标注：data-mark 对着对话层里那一行（箭头指过去），svg 是箭头（ZoomHistory 的 layoutAnnotations 画）。
 * chip 是状态层算好的字；没给（没有装饰数据的地方）就按要点现说，不写批没批
 */
export function MarkChip({ mark, chip = markChip(undefined, mark) }: { mark: TimelineMark; chip?: MarkChipText | undefined }) {
  const plain = useNamedPlain();
  return (
    <span data-mark={mark.key} className={`zd-risk r-${markLevel(mark)}`} title={plain(chip.hover)}>
      <svg className="zd-risk-leader" aria-hidden="true">
        <path />
      </svg>
      {/*
       * 秘书转达的要点写名字占位：按名字标签画。前一段最多占一行（放不下截掉后面的类别），那句话接在它后面折行，一共最多两行。
       * "等 N 次"、批了没有接在那句话后面；接上之后两行放不下（ZoomHistory 的 fitChipPins 量了标 data-pin）才换成
       * 浮在第二行右边的那一份（zd-chip-pin，排在最前面才浮得到第二行），那句话在它前面截掉
       */}
      <span className={`zd-chip${chip.said ? "" : " zd-chip-solo"}`} data-suffix={chip.more || chip.tail ? "1" : undefined}>
        <span className="zd-chip-body">
          <span className="zd-chip-flow">
            {(chip.more || chip.tail) && (
              <span className="zd-chip-pin">
                {chip.more && <span className="zd-chip-more">{chip.more}</span>}
                {chip.tail && <span className="zd-chip-tail">{chip.tail}</span>}
              </span>
            )}
            <span className="zd-chip-head">
              <NamedText text={chip.head} />
            </span>
            {chip.said && (
              <span className="zd-chip-said">
                <NamedText text={chip.said} />
                {chip.more && <span className="zd-chip-more">{chip.more}</span>}
                {chip.tail && <span className="zd-chip-tail">{chip.tail}</span>}
              </span>
            )}
          </span>
        </span>
      </span>
    </span>
  );
}
