/**
 * 聊天里的阶段框（91 号票第 6 块，照搬 AgentSense bedf5a5 的 web/src/ui/stageBox.tsx 的 StageBox，incidents.tsx 的 NoteChips、NoteLegend）：
 * 长程任务的会话里，每个阶段一个框，按发生的先后排。框上只有两行：第几阶段、标题、出过的情况（图标）、完成情况；下面一句小结
 * （做完了说结果，正在做说在做什么）。点框一次展开：要点（验收时查到的、退回过几次）和这一阶段的每次操作一起出来（每次操作由会话历史
 * 接在框下面画，见 ZoomHistory），底部"验收和规则 ›"进这一阶段的详情。不属于哪个阶段的后台事项合成一条细的。
 * 写什么由状态层的 stageBoxes 算（state/stage-boxes.ts）。AgentSense 的照片缩略图、"撤回到这一步开始前"二狗没有。
 */
import { INCIDENT_META, type IncidentKind, STAGE_NOTE_ORDER, type StageBoxView, type StageNote } from "../../state/index.ts";
import { IncidentIcon, IncidentIcons } from "../detail/incidents.tsx";

/** 一个阶段框：两行（阶段名 + 情况 + 完成情况；一句小结），点它把要点和每次操作一起展开 */
export function StageBox({ box, open, onToggle, onStage }: { box: StageBoxView; open: boolean; onToggle(): void; onStage?: ((stageId: string) => void) | undefined }) {
  const more = (
    <button type="button" className="sbox-more" onClick={onToggle} aria-expanded={open}>
      {open ? "收起详情" : `详情${box.toolCount ? `（${box.toolCount} 次操作）` : ""}`}
      <span className="sbox-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
  if (box.stageId === undefined) {
    // 不属于哪个阶段的：一行
    return (
      <div className={`sbox sbox-misc${open ? " sbox-open" : ""}`} data-focus-id={box.focusId}>
        <div className="sbox-row">
          <span className="sbox-misc-t">{box.title}</span>
          <IncidentIcons list={box.incidents} />
          {more}
        </div>
      </div>
    );
  }
  const stageId = box.stageId;
  return (
    <div className={`sbox sbox-${box.status.cls}${open ? " sbox-points sbox-open" : ""}${box.live ? " sbox-live" : ""}`} data-focus-id={box.focusId}>
      <button type="button" className="sbox-head" onClick={onToggle} aria-expanded={open}>
        <span className="sbox-row">
          <span className="sbox-name">
            {box.no !== undefined && <span className="sbox-no">第 {box.no} 阶段</span>}
            <span className="sbox-title">{box.title}</span>
          </span>
          <IncidentIcons list={box.incidents} />
          <span className={`sbox-st sbox-st-${box.status.cls}`}>{box.status.text}</span>
          <span className="sbox-caret" aria-hidden="true">
            ▾
          </span>
        </span>
        {box.summary && <span className="sbox-sum">{box.summary}</span>}
      </button>
      {open && (
        <div className="sbox-body">
          {box.lines.map((l) => (
            <div key={l} className="sbox-line">
              · {l}
            </div>
          ))}
          <div className="sbox-foot">
            {onStage && (
              <button type="button" className="sbox-more" onClick={() => onStage(stageId)}>
                验收和规则 ›
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 收着的阶段框在缩小后条外右边的标注：一个图标 + 一句话，一类合成一条，箭头指向框上那个图标（data-mark 是 ic:<类>）。
 * 点一条直接进详情：说的是一件事就进那一件的详情，合起来的好几件进这个阶段的详情（AgentSense NoteChips）
 */
export function StageNoteChips({ notes, onOpen }: { notes: readonly StageNote[]; onOpen(note: StageNote): void }) {
  return (
    <div className="zd-right">
      {notes.map((n) => (
        <button
          type="button"
          key={n.glyph}
          data-mark={n.key}
          className={`zd-risk zd-note${n.warn ? " zd-note-warn" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(n);
          }}
        >
          <svg className="zd-risk-leader" aria-hidden="true">
            <path />
          </svg>
          <IncidentIcon kind={n.glyph} attention={n.warn} />
          <span className="zd-note-t">{n.text}</span>
        </button>
      ))}
    </div>
  );
}

/** 图例：这个会话的阶段框上出现过的那几个图标（AgentSense NoteLegend） */
export function StageNoteLegend({ boxes }: { boxes: readonly StageBoxView[] }) {
  const used = new Set<IncidentKind>(boxes.flatMap((b) => b.notes.map((n) => n.glyph)));
  if (!used.size) return null;
  return (
    <span className="zh-glyphs">
      {STAGE_NOTE_ORDER.filter((g) => used.has(g)).map((g) => (
        <span key={g}>
          <IncidentIcon kind={g} />
          {INCIDENT_META[g].name}
        </span>
      ))}
    </span>
  );
}
