// 会话里消息之外的一条记录（25 号票起）：偏离、范围变更、越界（不认识的种类照样显示摘要，按一般的严重度），快速动作的操作记录。
// 54 号票从 Timeline.tsx 挪到这里（要点层、全局层两套单独的渲染去掉了，缩放换成一镜到底，见 ZoomHistory）。
// 56 号票起点整条看详情（itemId 是它在条目层的 id）。84 号票：重做记录画成阶段重开那一行。
import { type ConversationRecord, isTimelineRecordKind, MARK_KIND_LABEL, t, TIMELINE_RECORD_KIND_INFO } from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";

export function RecordRow({ record, time, itemId, onDetail }: { record: ConversationRecord; time: string | undefined; itemId: string; onDetail?: ((id: string) => void) | undefined }) {
  const open = onDetail && (() => onDetail(itemId));
  const cls = `msg msg-system${open ? " has-detail" : ""}`;
  if (record.type === "operation") {
    const { operation } = record;
    return (
      <div className={cls} data-item={itemId}>
        <div className={`sys-note tl-record rec-operation${operation.result.ok ? "" : " rec-failed"}`} onClick={open}>
          <b>{MARK_KIND_LABEL.operation}</b> · {t("ui.recordRow.operation", { title: operation.title, summary: operation.result.summary })}
          {time ? <span className="muted"> · {clockLabel(time)}</span> : null}
        </div>
      </div>
    );
  }
  const { timeline } = record;
  // 从某个阶段重做（84 号票）：阶段重开那一行，⟲ 加说法
  if (timeline.kind === "reopen")
    return (
      <div className={cls} data-item={itemId}>
        <div className="mevent me-reopen" onClick={open}>
          <span className="me-icon">⟲</span>
          <div className="me-body">
            <div className="me-text">
              {timeline.summary}
              {time ? <span className="muted"> · {clockLabel(time)}</span> : null}
            </div>
          </div>
        </div>
      </div>
    );
  const info = isTimelineRecordKind(timeline.kind) ? TIMELINE_RECORD_KIND_INFO[timeline.kind] : undefined;
  return (
    <div className={cls} data-item={itemId}>
      <div className={`sys-note tl-record sev-${info?.severity ?? "info"}`} onClick={open}>
        <b>{info?.label ?? t("ui.recordRow.record")}</b> · {timeline.summary}
        {timeline.detail && <div className="muted">{timeline.detail}</div>}
        {time ? <span className="muted"> · {clockLabel(time)}</span> : null}
      </div>
    </div>
  );
}
