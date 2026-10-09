/**
 * 会话组件的缩放（25 号票）：完整、要点、全局三层。数据全来自前端状态层（state/timeline.ts 的 gistView、globalView），
 * 样式、更细的说法（被拦下、问过、你点明的……）、结果的文字都由状态层推好，这里只管画：
 * - 要点层：带要点的条目各一行（工具调用、操作记录、审批、验收、偏离、范围变更、越界），其余收起成"收起了 N 条"；
 * - 全局层：一列色块（任务按阶段、项目按工单段和对话段、秘书主线按天），块上是要点的小标记；
 * - 三种操作样式：授权内（绿）、做完告诉我（你的蓝）、被拦下或问过（红）；通用 bash 另带标记；时间线记录按严重度取样式。
 * 点要点打开工具调用的详情（有的话，56 号票的详情页），点收起的行或色块回到完整视图、跳到那一条。
 */
import { useCard } from "../../app/store.tsx";
import { outcomeLabel } from "../../model/cards.ts";
import {
  type ConversationRecord,
  GENERIC_BASH_LABEL,
  type GistRow,
  isTimelineRecordKind,
  MARK_KIND_LABEL,
  OP_REASON,
  OP_STYLE_LABEL,
  OP_STYLES,
  TIMELINE_RECORD_KIND_INFO,
  TIMELINE_TONE_COUNT,
  type TimelineBlock,
  type TimelineMark,
  ZOOM_LEVEL_LABEL,
  ZOOM_LEVELS,
  type ZoomLevel,
} from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";

/** 缩放控件：完整 / 要点 / 全局 */
export function ZoomBar({ level, onLevel }: { level: ZoomLevel; onLevel(level: ZoomLevel): void }) {
  return (
    <div className="zoom-bar" role="tablist" aria-label="时间线缩放">
      {ZOOM_LEVELS.map((l) => (
        <button key={l} type="button" role="tab" aria-selected={l === level} className={l === level ? "on" : ""} onClick={() => onLevel(l)}>
          {ZOOM_LEVEL_LABEL[l]}
        </button>
      ))}
    </div>
  );
}

/** 要点的样式类：种类、操作样式、记录的严重度 */
function markClass(mark: TimelineMark): string {
  return [`mk-${mark.kind}`, mark.style ? `op-${mark.style}` : "", mark.severity ? `sev-${mark.severity}` : ""].filter(Boolean).join(" ");
}

/** 审批要点的处理结果：卡片的处理结果文字（还没处理的写待你处理） */
function ApprovalOutcome({ cardId }: { cardId: string }) {
  const card = useCard(cardId)?.card;
  if (!card) return null;
  return <>{card.status === "pending" ? "待你处理" : outcomeLabel(card)}</>;
}

/** 一个要点：种类、样式的说法、通用 bash、命中的关注类别、一句话、结果和补充 */
function MarkLine({ mark, onOpen }: { mark: TimelineMark; onOpen?(): void }) {
  const tail = [mark.outcome, mark.note].filter(Boolean).join(" · ");
  return (
    <button type="button" className={`tl-mark ${markClass(mark)}`} onClick={onOpen} disabled={!onOpen}>
      <span className="tl-mark-head">
        <span className="tl-kind">{MARK_KIND_LABEL[mark.kind]}</span>
        {mark.reason && <span className={`chip tl-style op-${mark.style}`}>{OP_REASON[mark.reason].label}</span>}
        {mark.genericBash && <span className="chip chip-generic">{GENERIC_BASH_LABEL}</span>}
        {mark.categories.map((c) => (
          <span key={c} className="chip chip-op">
            {c}
          </span>
        ))}
        {mark.time && <span className="tl-time">{clockLabel(mark.time)}</span>}
      </span>
      <span className="tl-title">{mark.title}</span>
      {(tail || mark.cardId) && (
        <span className="tl-note">
          {mark.cardId ? <ApprovalOutcome cardId={mark.cardId} /> : tail}
        </span>
      )}
    </button>
  );
}

/** 要点层：点工具调用的要点打开那一次调用的详情（56 号票：要点的 key 就是那次调用在条目层的 id） */
export function GistLayer({ rows, onDetail, onJump }: { rows: readonly GistRow[]; onDetail?: ((id: string) => void) | undefined; onJump(itemKey: string): void }) {
  if (rows.length === 0) return <div className="page-placeholder">还没有消息</div>;
  if (rows.every((r) => r.kind === "folded")) {
    return <div className="page-placeholder">这段会话里没有要点：没有命中关注类别的操作、审批、偏离、验收、通用 bash、范围变更和越界</div>;
  }
  return (
    <div className="tl-gist">
      {rows.map((row) =>
        row.kind === "folded" ? (
          <button key={row.key} type="button" className="tl-folded" onClick={() => onJump(row.itemKey)}>
            收起了 {row.count} 条
          </button>
        ) : (
          <div key={row.key} className="tl-row">
            {row.marks.map((m) => (
              <MarkLine key={m.key} mark={m} onOpen={m.toolCall && onDetail ? () => onDetail(m.key) : () => onJump(row.itemKey)} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

/** 色块上一个要点的小标记：颜色按种类、样式和严重度，文字很短 */
function MarkTick({ mark }: { mark: TimelineMark }) {
  return (
    <span className={`tl-tick ${markClass(mark)}${mark.genericBash ? " tick-generic" : ""}`} title={`${MARK_KIND_LABEL[mark.kind]}：${mark.title}${mark.categories.length ? `（${mark.categories.join("、")}）` : ""}`}>
      {mark.short}
      {mark.genericBash && <span className="tick-flag">{GENERIC_BASH_LABEL}</span>}
    </span>
  );
}

/** 全局层 */
export function GlobalLayer({ blocks, onJump }: { blocks: readonly TimelineBlock[]; onJump(itemKey: string): void }) {
  if (blocks.length === 0) return <div className="page-placeholder">还没有消息</div>;
  return (
    <div className="tl-global">
      {blocks.map((b) => (
        <button key={b.key} type="button" className={`tl-block tone-${b.tone % TIMELINE_TONE_COUNT} by-${b.grouping}`} onClick={() => onJump(b.firstKey)} title="回到完整视图看这一段">
          <span className="tl-block-head">
            <b>{b.title}</b>
            <span className="tl-block-sub">
              {b.count} 条{b.from ? ` · ${clockLabel(b.from)}${b.to && b.to !== b.from ? `–${clockLabel(b.to)}` : ""}` : ""}
            </span>
          </span>
          {b.marks.length > 0 && (
            <span className="tl-ticks">
              {b.marks.map((m) => (
                <MarkTick key={m.key} mark={m} />
              ))}
            </span>
          )}
        </button>
      ))}
      <div className="tl-legend" aria-label="图例">
        {OP_STYLES.map((s) => (
          <span key={s} className={`tl-tick op-${s}`}>
            {OP_STYLE_LABEL[s]}
          </span>
        ))}
        <span className="tl-tick tick-generic">{GENERIC_BASH_LABEL}</span>
      </div>
    </div>
  );
}

/**
 * 完整视图里消息之外的一条记录：偏离、范围变更、越界（不认识的种类照样显示摘要，按一般的严重度），快速动作的操作记录。
 * 56 号票起点整条看详情（itemId 是它在条目层的 id）
 */
export function RecordRow({ record, time, itemId, onDetail }: { record: ConversationRecord; time: string | undefined; itemId: string; onDetail?: ((id: string) => void) | undefined }) {
  const open = onDetail && (() => onDetail(itemId));
  const cls = `msg msg-system${open ? " has-detail" : ""}`;
  if (record.type === "operation") {
    const { operation } = record;
    return (
      <div className={cls} data-item={itemId}>
        <div className={`sys-note tl-record rec-operation${operation.result.ok ? "" : " rec-failed"}`} onClick={open}>
          <b>{MARK_KIND_LABEL.operation}</b> · {operation.title}：{operation.result.summary}
          {time ? <span className="muted"> · {clockLabel(time)}</span> : null}
        </div>
      </div>
    );
  }
  const { timeline } = record;
  const info = isTimelineRecordKind(timeline.kind) ? TIMELINE_RECORD_KIND_INFO[timeline.kind] : undefined;
  return (
    <div className={cls} data-item={itemId}>
      <div className={`sys-note tl-record sev-${info?.severity ?? "info"}`} onClick={open}>
        <b>{info?.label ?? "记录"}</b> · {timeline.summary}
        {timeline.detail && <div className="muted">{timeline.detail}</div>}
        {time ? <span className="muted"> · {clockLabel(time)}</span> : null}
      </div>
    </div>
  );
}
