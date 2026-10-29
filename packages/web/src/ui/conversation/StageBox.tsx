/**
 * 聊天里的阶段框（91 号票第 6 块）：
 * 长程任务的会话里，每个阶段一个框，按发生的先后排。框上只有两行：第几阶段、标题、出过的情况（图标）、完成情况；下面一句小结
 * （做完了说结果，正在做说在做什么）。点框一次展开：要点（验收时查到的、退回过几次）和这一阶段的每次操作一起出来（每次操作由会话历史
 * 接在框下面画，见 ZoomHistory），底部"验收和规则 ›"进这一阶段的详情。不属于哪个阶段的后台事项合成一条细的。
 * 写什么由状态层的 stageBoxes 算（state/stage-boxes.ts）。没有照片缩略图。
 * 152 号票补上"⟲ 撤回到这一步开始前"（sbox-undo）：长程任务的阶段开始有回退点（状态层 zoomRollbacks 的阶段开始那一种），
 * 展开的框底部一个按钮，点了和条左边的 ↶ 一样弹出确认。
 * 93 号票补上：条外标注的"外""权"两类；框里每次交上来验收的结论
 * 画成一行横条，点开是几条要点，箭头进那张卡的详情。
 */
import { useState } from "react";
import { GLYPH_META, INCIDENT_META, type NoteGlyph, STAGE_BOX_UNDO, STAGE_NOTE_ORDER, type StageBoxView, type StageNote, t, type VerdictStrip, type ZoomRollbackPoint } from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { IncidentIcon, IncidentIcons } from "../detail/incidents.tsx";

/** 一个阶段框：两行（阶段名 + 情况 + 完成情况；一句小结），点它把要点和每次操作一起展开 */
export function StageBox({
  box,
  open,
  onToggle,
  onStage,
  undo,
  onRollback,
}: {
  box: StageBoxView;
  open: boolean;
  onToggle(): void;
  onStage?: ((stageId: string) => void) | undefined;
  /** 这个阶段开始的回退点（152 号票）：展开的框底部"⟲ 撤回到这一阶段开始前"；只读、不能回退的会话、已作废的那一轮没有 */
  undo?: ZoomRollbackPoint | undefined;
  onRollback?: ((point: ZoomRollbackPoint) => void) | undefined;
}) {
  const more = (
    <button type="button" className="sbox-more" onClick={onToggle} aria-expanded={open}>
      {open ? t("ui.stageBox.collapse") : box.toolCount ? t("ui.stageBox.detailsWithOps", { count: box.toolCount }) : t("ui.stageBox.details")}
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
            {box.no !== undefined && <span className="sbox-no">{t("ui.stageBox.stageNo", { no: box.no })}</span>}
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
                {t("ui.stageBox.acceptance")}
              </button>
            )}
            {undo && onRollback && !box.stale && (
              <button type="button" className="sbox-more sbox-undo" onClick={() => onRollback(undo)}>
                {STAGE_BOX_UNDO}
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
 * 点一条直接进详情：说的是一件事就进那一件的详情，合起来的好几件进这个阶段的详情
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
          <NoteIcon glyph={n.glyph} warn={n.warn} />
          <span className="zd-note-t">
            <NamedText text={n.text} />
          </span>
        </button>
      ))}
    </div>
  );
}

/** "权""外"：和计划上的小标记同一个字、同一个颜色 */
function ActGlyph({ kind }: { kind: "perm" | "out" }) {
  const m = GLYPH_META[kind];
  return (
    <span className={`ic ic-${kind}`} title={m.name} aria-label={m.name}>
      <span className="ic-g">{m.glyph}</span>
    </span>
  );
}

/** 条外标注、图例上的那个字：出过的情况的图标，或者"权""外" */
function NoteIcon({ glyph, warn }: { glyph: NoteGlyph; warn?: boolean | undefined }) {
  return glyph === "perm" || glyph === "out" ? <ActGlyph kind={glyph} /> : <IncidentIcon kind={glyph} attention={warn} />;
}

/** 图例：这个会话的阶段框条外出现过的那几个字 */
export function StageNoteLegend({ boxes }: { boxes: readonly StageBoxView[] }) {
  const used = new Set<NoteGlyph>(boxes.flatMap((b) => b.notes.map((n) => n.glyph)));
  if (!used.size) return null;
  return (
    <span className="zh-glyphs">
      {STAGE_NOTE_ORDER.filter((g) => used.has(g)).map((g) => (
        <span key={g}>
          <NoteIcon glyph={g} />
          {g === "perm" || g === "out" ? GLYPH_META[g].name : INCIDENT_META[g].name}
        </span>
      ))}
    </span>
  );
}

/**
 * 框里一次交上来验收的结论：平时只占一行（图标、"验收通过：「…」"、右边的小签）；点横条在下面展开几条要点，点右边的箭头进那张卡的
 * 详情看全部（通过的 strip-ok，退回的 strip-reject，几次都没通过的再加 strip-failed）
 */
export function VerdictStripView({ strip, onDetail }: { strip: VerdictStrip; onDetail?: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const expandable = strip.points.length > 0;
  return (
    <div className={`strip strip-${strip.tone === "ok" ? "ok" : "reject"}${strip.tone === "failed" ? " strip-failed" : ""}${open ? " strip-open" : ""}`}>
      <div className="strip-bar">
        <button
          type="button"
          className="strip-main"
          aria-expanded={expandable ? open : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (expandable) setOpen(!open);
            else onDetail?.();
          }}
        >
          <span className="strip-icon">{strip.icon}</span>
          <span className="strip-text">
            <span className="strip-title">{strip.title}</span>
          </span>
          <span className="strip-tail">{strip.tail}</span>
          {expandable && <span className="strip-caret">{open ? "▴" : "▾"}</span>}
        </button>
        {onDetail && (
          <button
            type="button"
            className="strip-more"
            aria-label={t("ui.stageBox.detailLabel")}
            onClick={(e) => {
              e.stopPropagation();
              onDetail();
            }}
          >
            ›
          </button>
        )}
      </div>
      {open && expandable && (
        <div className="strip-body">
          <ul className="strip-points">
            {strip.points.map((p, i) => (
              <li key={i}>
                {p.k !== undefined ? (
                  <>
                    <span className="pt-k">{p.k}</span>
                    <span className={p.sys ? "pt-v pt-sys" : "pt-v"}>{p.text}</span>
                  </>
                ) : (
                  <span>{p.text}</span>
                )}
              </li>
            ))}
          </ul>
          {onDetail && (
            <button
              type="button"
              className="strip-detail"
              onClick={(e) => {
                e.stopPropagation();
                onDetail();
              }}
            >
              {t("ui.stageBox.viewDetail")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
