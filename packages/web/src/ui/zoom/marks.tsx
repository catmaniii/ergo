// 缩小后条右侧的标注（先把要点层、全局层标出的东西都标上，不丢信息；补齐 ×N、左侧任务卡或工单卡、
// 底色带、书脊和图例，见 ZoomHistory.tsx、state/zoom-decor.ts）。
// 一个要点（state/timeline.ts 的 TimelineMark）一条标注，写的字由状态层给（state/mark-chip.ts 的 markChip；
// 连着几块的合成一条、写 ×N 或"等 N 次"在 zoom-decor.ts 的 rightMarks）：前一段是种类或样式、结果、⚠类别，后面是一句具体的，
// 审批最后接批了没有。一行放得下就接着写，放不下最多两行（zoom.css 的 .zd-chip：宽的折行截两行，窄的前一段一行、那句话一行，
// "等 N 次"和批了没有钉在末尾不截）；完整的在悬停文字里。
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
       * 秘书转达的要点写名字占位：按名字标签画。"等 N 次"、批了没有各画两份，zoom.css 按标注那一列的宽窄只显示一份：
       * 宽的（zd-w）钉在整条的右下角；窄的（zd-n）批了没有接在前一段那一行、"等 N 次"接在那句话那一行
       */}
      <span className={`zd-chip${chip.said ? "" : " zd-chip-solo"}`}>
        <span className="zd-chip-body">
          {/* 前一段：打头那一项（种类或样式）和后面的分开放，窄的时候先截后面的 */}
          <span className="zd-chip-head">
            <span className="zd-chip-text zd-chip-lead">
              <NamedText text={chip.lead} />
            </span>
            {chip.head.length > chip.lead.length && (
              <span className="zd-chip-text zd-chip-rest">
                <NamedText text={chip.head.slice(chip.lead.length)} />
              </span>
            )}
            {chip.tail && <span className="zd-chip-tail zd-n">{chip.tail}</span>}
          </span>
          {chip.said && (
            <span className="zd-chip-said">
              <span className="zd-chip-text">
                <NamedText text={chip.said} />
              </span>
              {chip.more && <span className="zd-chip-more zd-n">{chip.more}</span>}
            </span>
          )}
        </span>
        {(chip.more || chip.tail) && (
          <span className="zd-chip-pin zd-w">
            {chip.more && <span className="zd-chip-more">{chip.more}</span>}
            {chip.tail && <span className="zd-chip-tail">{chip.tail}</span>}
          </span>
        )}
      </span>
    </span>
  );
}
