/**
 * 聊天里计划卡、计划变更卡上一直列着的阶段提纲（93 号票，提纲、点中的那一阶段、图例和提纲下面那一句提示）：按阶段号分组，这一阶段只有一个的写在"第 N 阶段"那一行，几个并行的写
 * "可并行 · N 个"、下面逐个列出；每一项是标题、新 / 改、要你留意的小标记（权、外、问）、状态（没开始的不写）、去掉的划掉写"已去掉"。
 * 点一项：它的要点就地展开在下面（要交的、验收标准、要你留意的、"这一阶段的详情 ›"），同时左边图上那一阶段高亮（StageFocus.onStep，
 * 宽屏阶段栏藏着就打开）；再点收起。计划刚交上来（一分钟内）时等提纲第一次滚进屏幕，一个阶段一个阶段地出来。
 * 写什么由状态层的 planOutline 算（state/plan-outline.ts）。
 */
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type Card, type OutlineItem, type PlanCardPayload, type PlanChangeCardPayload, planOutline, t } from "../../state/index.ts";
import { MarkBadges, MarkRows } from "../detail/StageDetail.tsx";
import { useStageFocus } from "./PlanStages.tsx";

/** 刚交上来的计划（不是翻历史看到的）：提纲出场带动效（60 秒之内交上来的） */
const FRESH_MS = 60_000;

/** 计划卡上的提纲、图例和提示 */
export function PlanOutline({ card }: { card: Card }) {
  const { ui } = useStore();
  const { onStep, onStage, openPlan } = useStageFocus();
  const [focus, setFocus] = useState<string>();
  const box = useRef<HTMLOListElement>(null);
  const [animate] = useState(() => Date.now() - Date.parse(card.createdAt) < FRESH_MS);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!animate || drawn || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setDrawn(true), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [animate, drawn]);
  const view = planOutline(ui, card);
  if (!view) return null;
  const payload = card.payload as PlanCardPayload | PlanChangeCardPayload;
  // 还没确认的计划看这张卡的详情里这一阶段；确认了、在执行的看阶段详情
  const pending = card.status === "pending";
  const openStage = (id: string) => (pending || !onStage ? openPlan?.(card.id, id) : onStage(id));
  const item = (x: OutlineItem) => (
    <>
      <button
        type="button"
        className={`mo-item${x.gone ? " mo-gone" : ""}${focus === x.id ? " on" : ""}`}
        disabled={x.gone}
        aria-expanded={focus === x.id}
        onClick={() => {
          setFocus(focus === x.id ? undefined : x.id);
          onStep?.(x.id);
        }}
      >
        <span className="mo-title">{x.title}</span>
        {x.mark && <span className="mg-mark">{x.mark}</span>}
        {!x.gone && <MarkBadges marks={x.marks} quiet />}
        {x.gone ? (
          <span className="mo-st">{t("ui.planOutline.removed")}</span>
        ) : (
          x.look && (
            <span className={`mo-st rs-${x.look.st}`}>
              {x.look.icon} {x.look.text}
            </span>
          )
        )}
        {!x.gone && <span className="mo-caret">{focus === x.id ? "▾" : "›"}</span>}
      </button>
      {focus === x.id && <NodePanel payload={payload} item={x} onDetail={onStage || openPlan ? () => openStage(x.id) : undefined} />}
    </>
  );
  const { legend } = view;
  return (
    <>
      <ol ref={box} className={`mp-outline${animate ? (drawn ? " mo-draw" : " mo-wait") : ""}`}>
        {view.stages.map((st, i) => (
          <li key={st.no} className="mo-stage" style={{ "--mg-l": i } as CSSProperties}>
            <div className="mo-head">
              <span className="mo-no">{t("ui.planOutline.stageNo", { no: st.no })}</span>
              {st.items.length === 1 ? <div className="mo-solo">{item(st.items[0]!)}</div> : <span className="mo-par">{st.live > 1 ? t("ui.planOutline.parallel", { count: st.live }) : ""}</span>}
            </div>
            {st.items.length > 1 && (
              <ul className="mo-items">
                {st.items.map((x) => (
                  <li key={x.id}>{item(x)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {(legend.perm || legend.out || legend.ask) && (
        <div className="mg-legend">
          {legend.perm && (
            <span className="mg-bd mg-bd-perm" title={t("ui.planOutline.legend.permTip")}>
              <i>{t("ui.planOutline.legend.permGlyph")}</i>
              {t("ui.planOutline.legend.perm")}
              {legend.perm.length > 0 && <em className="mg-kinds">{t("ui.planOutline.legend.kinds", { kinds: legend.perm.join(t("ui.common.listSep")) })}</em>}
            </span>
          )}
          {legend.out && (
            <span className="mg-bd mg-bd-out" title={t("ui.planOutline.legend.outTip")}>
              <i>{t("ui.planOutline.legend.outGlyph")}</i>
              {t("ui.planOutline.legend.out")}
              {legend.out.length > 0 && <em className="mg-kinds">{t("ui.planOutline.legend.kinds", { kinds: legend.out.join(t("ui.common.listSep")) })}</em>}
            </span>
          )}
          {legend.ask && (
            <span className="mg-bd mg-bd-ask" title={t("ui.planOutline.legend.askTip")}>
              <i>{t("ui.planOutline.legend.askGlyph")}</i>
              {t("ui.planOutline.legend.ask")}
            </span>
          )}
        </div>
      )}
      {focus === undefined && (
        <div className="mp-hint">
          {/* 详情里（没有 openPlan）就在详情里了，只写前半句 */}
          {t("ui.planOutline.hint")}
          {openPlan && (
            <>
              {t("ui.planOutline.hintSep")}
              <button type="button" className="link-btn" onClick={() => openPlan(card.id)}>
                {t("ui.planOutline.hintMore")}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** 点中的那一阶段：要交的、验收标准、要你留意的（规则在详情里） */
function NodePanel({ payload, item, onDetail }: { payload: PlanCardPayload | PlanChangeCardPayload; item: OutlineItem; onDetail?: (() => void) | undefined }) {
  const stage = payload.plan.stages.find((s) => s.stageId === item.id);
  if (!stage) return null;
  return (
    <div className="mp-node">
      <div className="mp-node-head">
        <span className="mp-node-no">{t("ui.planOutline.stageNo", { no: item.code })}</span>
        <b className="mp-node-title">{stage.title}</b>
        {item.look && <span className="mp-ms-st">{item.look.text}</span>}
      </div>
      <div className="mp-node-row">
        <span className="mp-node-k">{t("ui.planOutline.deliverables")}</span>
        <span>{stage.deliverables.join(t("ui.planOutline.itemSep"))}</span>
      </div>
      <div className="mp-node-row">
        <span className="mp-node-k">{t("ui.planOutline.criteria")}</span>
        <ul className="mp-node-list">
          {stage.acceptance.map((c) => (
            <li key={`${c.method}:${c.criterion}`}>
              <span className={c.method === "user" ? "mp-tag mp-user" : "mp-tag mp-auto"}>{c.method === "user" ? t("ui.planOutline.byUser") : c.method === "script" ? t("ui.planOutline.byScript") : t("ui.planOutline.byReview")}</span>
              {c.criterion}
            </li>
          ))}
        </ul>
      </div>
      {item.marks && <MarkRows marks={item.marks} />}
      {onDetail && (
        <div className="mp-node-links">
          <button
            type="button"
            className="link-btn mp-node-more"
            onClick={(e) => {
              e.stopPropagation();
              onDetail();
            }}
          >
            {t("ui.planOutline.stageDetail")}
          </button>
        </div>
      )}
    </div>
  );
}
