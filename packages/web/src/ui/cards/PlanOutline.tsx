/**
 * 聊天里计划卡、计划变更卡上一直列着的阶段提纲（93 号票，照搬 AgentSense bedf5a5 web/src/ui/milestone.tsx 的 PlanOutline、NodePanel、
 * MarkLegend 和 MilestonePlanCard 里提纲下面那一句提示）：按阶段号分组，这一阶段只有一个的写在"第 N 阶段"那一行，几个并行的写
 * "可并行 · N 个"、下面逐个列出；每一项是标题、新 / 改、要你留意的小标记（权、外、问）、状态（没开始的不写）、去掉的划掉写"已去掉"。
 * 点一项：它的要点就地展开在下面（要交的、验收标准、要你留意的、"这一阶段的详情 ›"），同时左边图上那一阶段高亮（StageFocus.onStep，
 * 宽屏阶段栏藏着就打开）；再点收起。计划刚交上来（一分钟内）时等提纲第一次滚进屏幕，一个阶段一个阶段地出来。
 * 写什么由状态层的 planOutline 算（state/plan-outline.ts）。
 */
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type Card, type OutlineItem, type PlanCardPayload, type PlanChangeCardPayload, planOutline } from "../../state/index.ts";
import { MarkBadges, MarkRows } from "../detail/StageDetail.tsx";
import { useStageFocus } from "./PlanStages.tsx";

/** 刚交上来的计划（不是翻历史看到的）：提纲出场带动效（AgentSense isFresh(…, 60000)） */
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
  // 还没确认的计划看这张卡的详情里这一阶段；确认了、在执行的看阶段详情（AgentSense onFocus → 计划详情定位到这一步）
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
          <span className="mo-st">已去掉</span>
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
              <span className="mo-no">第 {st.no} 阶段</span>
              {st.items.length === 1 ? <div className="mo-solo">{item(st.items[0]!)}</div> : <span className="mo-par">{st.live > 1 ? `可并行 · ${st.live} 个` : ""}</span>}
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
            <span className="mg-bd mg-bd-perm" title="敏感权限：授权它动你电脑里的东西（写文件、删改、越出项目目录、装软件），不给别人">
              <i>权</i>敏感权限{legend.perm.length > 0 && <em className="mg-kinds">（{legend.perm.join("、")}）</em>}
            </span>
          )}
          {legend.out && (
            <span className="mg-bd mg-bd-out" title="对外动作：做了，电脑以外的人或平台就会收到、记下：推送、发布、发消息、带数据的请求……">
              <i>外</i>对外动作{legend.out.length > 0 && <em className="mg-kinds">（{legend.out.join("、")}）</em>}
            </span>
          )}
          {legend.ask && (
            <span className="mg-bd mg-bd-ask" title="停下来问你：到这一步会停下来等你点头、等你验收">
              <i>问</i>停下来问你
            </span>
          )}
        </div>
      )}
      {focus === undefined && (
        <div className="mp-hint">
          {/* 详情里（没有 openPlan）就在详情里了，只写前半句 */}
          点一个阶段，看它要交什么、怎么验收、哪些要你留意
          {openPlan && (
            <>
              ；
              <button type="button" className="link-btn" onClick={() => openPlan(card.id)}>
                更多在详情里 ›
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** 点中的那一阶段：要交的、验收标准、要你留意的（AgentSense NodePanel；规则在详情里） */
function NodePanel({ payload, item, onDetail }: { payload: PlanCardPayload | PlanChangeCardPayload; item: OutlineItem; onDetail?: (() => void) | undefined }) {
  const stage = payload.plan.stages.find((s) => s.stageId === item.id);
  if (!stage) return null;
  return (
    <div className="mp-node">
      <div className="mp-node-head">
        <span className="mp-node-no">第 {item.code} 阶段</span>
        <b className="mp-node-title">{stage.title}</b>
        {item.look && <span className="mp-ms-st">{item.look.text}</span>}
      </div>
      <div className="mp-node-row">
        <span className="mp-node-k">要交的</span>
        <span>{stage.deliverables.join("；")}</span>
      </div>
      <div className="mp-node-row">
        <span className="mp-node-k">验收标准</span>
        <ul className="mp-node-list">
          {stage.acceptance.map((c) => (
            <li key={`${c.method}:${c.criterion}`}>
              <span className={c.method === "user" ? "mp-tag mp-user" : "mp-tag mp-auto"}>{c.method === "user" ? "由你验收" : c.method === "script" ? "自动核对" : "评审"}</span>
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
            这一阶段的详情 ›
          </button>
        </div>
      )}
    </div>
  );
}
