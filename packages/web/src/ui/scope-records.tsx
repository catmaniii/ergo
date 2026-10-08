// 范围记录（18 号票）：简版项目页、任务详情里共用。越界和范围变更分开两组（各自最近的在前），
// 每条写明摘要、依据（范围变更）、说明、哪次审视的、属于哪张工单和哪个任务、时间。
import { useState } from "react";
import { SCOPE_RECORD_KIND_LABEL, type ScopeRecordGroups, type ScopeRecordKind, type ScopeRecordView } from "../state/index.ts";
import { timeLabel } from "../util/time.ts";

/** 两组的先后：越界在前（要用户留意），范围变更在后 */
const ORDER: readonly ScopeRecordKind[] = ["out_of_scope", "scope_change"];

export function ScopeRecordList({ groups, empty }: { groups: ScopeRecordGroups; empty: string }) {
  if (ORDER.every((kind) => groups[kind].length === 0)) return <div className="muted">{empty}</div>;
  return (
    <div className="scope-groups">
      {ORDER.map((kind) => (
        <div key={kind} className="scope-group">
          <div className="scope-group-h">
            <span className={`chip ${kind === "out_of_scope" ? "chip-no" : "chip-ok"}`}>{SCOPE_RECORD_KIND_LABEL[kind]}</span>
            <span className="bgroup-n">{groups[kind].length}</span>
          </div>
          {groups[kind].length === 0 && <div className="muted">没有</div>}
          {groups[kind].map((v) => (
            <ScopeRecordRow key={v.record.id} view={v} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ScopeRecordRow({ view }: { view: ScopeRecordView }) {
  const [open, setOpen] = useState(false);
  const { record } = view;
  return (
    <div className={`scope-row ${record.kind === "out_of_scope" ? "scope-overreach" : "scope-change"}`}>
      <div>{record.summary}</div>
      {record.basis && <div className="muted">依据：{record.basis}</div>}
      <div className="muted">
        {view.trigger}
        {view.where && ` · ${view.where}`} · {timeLabel(record.time)}
        {record.detail && (
          <>
            {" · "}
            <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "收起说明" : "说明"}
            </button>
          </>
        )}
      </div>
      {open && record.detail && <div className="scope-detail">{record.detail}</div>}
    </div>
  );
}
