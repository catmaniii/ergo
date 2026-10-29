/**
 * 长程任务的依赖图（91 号票，整张图、小图、节点、计划层、横向阶段条）：宽屏阶段栏、手机抽屉全开画整张图，抽屉半开画横向阶段条。排法、编号、画哪一份计划都在状态层
 * （state/stage-graph.ts），这里只管画：
 * - 图：自上而下分层、同层并排、曲线连线（SVG），节点是一个按钮；节点大小按放图那块的宽高算，放不下时上下滑（栏里）或整张缩小；
 * - 节点：执行中的计划写"第 N 阶段 · 状态图标 + 两三个字"、标题，出过的状况一排小图标（防 / 拦 / 拉 / 问，处理好的带 ✓）；
 *   等你确认的计划写"第 N 阶段"、标题和要你留意的几样（敏 / 权 / 外 / 问的个数，没有的写"只查看"），计划变更里新加的标"新"、
 *   改过的标"改"（状态照执行中的），去掉的写"已去掉"、淡化划掉；
 * - 状态靠边框（look.css）：没开始虚线、在做蓝框呼吸、完成绿底、没通过红框、不做的淡化划掉；点中的那一个外面一圈蓝；
 * - 点中的那一阶段（聊天里点的也算）在图上看不到时滚过去。
 */
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fillNodeSize, fillScale, graphGeometry, railColumns, type StageGraph, type StageGraphNode, t } from "../../state/index.ts";
import { IncidentIcons } from "../detail/incidents.tsx";
import { MarkBadges } from "../detail/StageDetail.tsx";

/** 第几层（给逐层画出来的动效用） */
const layerVar = (l: number) => ({ "--mg-l": l }) as CSSProperties;

/** 等你确认的计划里的一个阶段：第几阶段（状态、新 / 改）、标题、要你留意的几样；去掉的写"已去掉" */
function planBody(n: StageGraphNode, withStatus: boolean): ReactNode {
  if (n.state === "removed")
    return (
      <>
        <span className="mg-id">{t("ui.stageGraph.removed")}</span>
        <span className="mg-title">{n.title}</span>
      </>
    );
  return (
    <>
      <span className="mg-id">
        {t("ui.stageGraph.stageNo", { no: n.n })}
        {withStatus && n.state !== "pending" && (
          <span className="mg-st" title={n.look.text}>
            <span className="mg-st-i">{n.look.icon}</span>
            {n.mark ? "" : <span className="mg-st-t">{` ${n.look.text}`}</span>}
          </span>
        )}
        {n.mark && <span className="mg-mark">{n.mark}</span>}
      </span>
      <span className="mg-title">{n.title}</span>
      <MarkBadges marks={n.marks} />
    </>
  );
}

/** 执行中的计划里的一个阶段：第几阶段、状态、标题；出过的状况只标图标，细节点进去看 */
function liveBody(n: StageGraphNode): ReactNode {
  return (
    <>
      <span className={`pl-st pl-st-${n.look.st}`}>
        <span className="pl-no">{t("ui.stageGraph.stageNo", { no: n.n })}</span>
        <span>
          <span className="pl-st-i">{n.look.icon}</span> <span className="pl-st-t">{n.look.text}</span>
        </span>
      </span>
      <span className="pl-name">{n.title}</span>
      {n.incidents.length > 0 && <IncidentIcons list={n.incidents} />}
    </>
  );
}

/** 节点外框的样式类：状态（st-*）、出过状况、新 / 改、去掉的、点中的 */
function nodeClass(graph: StageGraph, n: StageGraphNode, focus: string | undefined): string {
  const pending = graph.kind !== "live";
  // 等你确认的计划里去掉的阶段：给没开始的状态（虚线框）加 mg-removed；执行中的计划里去掉的是 st-abandoned
  const st = pending && n.state === "removed" ? "pending" : n.look.st;
  const cls = [`mg-node st-${st}`];
  if (graph.current === n.id && n.state !== "stopped") cls.push("mg-current");
  if (!pending && n.trouble) cls.push("mg-incident");
  if (pending && n.mark) cls.push("mg-changed");
  if (pending && n.state === "removed") cls.push("mg-removed");
  if (focus === n.id) cls.push("mg-focus");
  return cls.join(" ");
}

/**
 * 有向无环图：自上而下分层，同一层并排（并行），线从上游底边连到下游顶边。
 * 去掉的阶段（等你确认的计划变更里）点不开
 */
function Graph({ graph, w, h, focus, onNode }: { graph: StageGraph; w: number; h: number; focus: string | undefined; onNode(id: string): void }) {
  const geo = graphGeometry(graph.nodes, w, h);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const pending = graph.kind !== "live";
  return (
    <div className="mg" style={{ width: geo.width, height: geo.height }}>
      <svg className="mg-edges" width={geo.width} height={geo.height} aria-hidden="true">
        {geo.edges.map((e) => {
          const to = byId.get(e.to)!;
          const st = pending && to.state === "removed" ? "pending" : to.look.st;
          return <path key={e.key} className={`mg-edge st-${st}`} style={layerVar(e.layer)} d={e.d} />;
        })}
      </svg>
      {graph.nodes.map((n) => {
        const p = geo.pos.get(n.id)!;
        const gone = pending && n.state === "removed";
        return (
          <button
            type="button"
            key={n.id}
            className={nodeClass(graph, n, focus)}
            style={{ left: p.x, top: p.y, width: w, height: h, ...layerVar(p.layer) }}
            onClick={gone ? undefined : () => onNode(n.id)}
            aria-label={t("ui.stageGraph.nodeLabel", { code: n.code, title: n.title, state: n.state === "removed" ? t("ui.stageGraph.removed") : n.look.text })}
          >
            {pending ? planBody(n, graph.kind === "change") : liveBody(n)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 依赖图铺满放它的那一块：按那一块的宽和高算节点大小，字不缩小；
 * 比那一块宽时整张缩到它的宽，比它高时上下滑（scroll）
 */
export function StageGraphView({ graph, focus, onNode }: { graph: StageGraph; focus: string | undefined; onNode(id: string): void }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ W: number; H: number }>();
  const [k, setK] = useState(1);
  // 放图那一块变了（拖分界线、抽屉换档）重排节点；图本身变了大小（节点换了、多了一层）重算缩放：两层都量
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const fit = () => {
      const W = o.clientWidth;
      const H = o.clientHeight;
      setBox((b) => (b && b.W === W && b.H === H ? b : { W, H }));
      if (i.scrollWidth && i.scrollHeight) setK(fillScale({ W, H }, { width: i.scrollWidth, height: i.scrollHeight }, true));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  const size = box ? fillNodeSize(box, graph.nodes, true) : undefined;
  // 点中的那一阶段（聊天里点的也算）在图上看不到时，滚过去
  useEffect(() => {
    if (focus === undefined) return;
    outer.current?.querySelector(".mg-focus")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [focus]);
  return (
    <div className="pl">
      <div className="pl-fit pl-fit-scroll" ref={outer}>
        <div className="pl-fit-inner" ref={inner} style={{ transform: `translateX(-50%) scale(${k})` }}>
          {size && <Graph graph={graph} w={size.w} h={size.h} focus={focus} onNode={onNode} />}
        </div>
      </div>
    </div>
  );
}

/**
 * 计划详情里的小流程图（93 号票，"流程"一节：节点固定 112×70，外面包一层
 * ScaleToWidth——比放它的那一块宽时整张缩到它的宽，高度跟着缩）。点一个节点定位到下面那一阶段
 */
export function StageGraphMini({ graph, focus, onNode }: { graph: StageGraph; focus: string | undefined; onNode(id: string): void }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ k: 1, h: 0 });
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const fit = () => {
      const w = i.scrollWidth;
      const h = i.scrollHeight;
      if (!w || !h) return;
      const k = Math.min(1, o.clientWidth / w);
      setBox((b) => (Math.abs(b.k - k) < 0.001 && b.h === h * k ? b : { k, h: h * k }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="mp-graph">
      <div className="stw" ref={outer} style={{ height: box.h || undefined }}>
        <div className="stw-inner" ref={inner} style={{ transform: `translateX(-50%) scale(${box.k})` }}>
          <Graph graph={graph} w={112} h={70} focus={focus} onNode={onNode} />
        </div>
      </div>
    </div>
  );
}

/**
 * 横向的阶段条（手机抽屉半开）：一个阶段一列，并行的几个叠在同一列；等你确认的计划标出要你留意的几样
 * （没有的不写"只查看"）。点中的那个滚到中间
 */
export function StageRail({ graph, selected, onSelect }: { graph: StageGraph; selected: string | undefined; onSelect(id: string): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected === undefined) return;
    const rail = ref.current;
    const on = rail?.querySelector<HTMLElement>(".rail-node.on");
    if (rail && on) rail.scrollTo({ left: on.offsetLeft - rail.clientWidth / 2 + on.offsetWidth / 2, behavior: "smooth" });
  }, [selected]);
  // 等你确认的计划（计划卡、计划变更）：阶段条不带执行中的状态，一律写没开始
  const pending = graph.kind !== "live";
  return (
    <div className="rail" ref={ref}>
      {railColumns(graph.nodes).map((col, i) => (
        <div key={col[0]!.id} className="rail-step">
          {i > 0 && <span className="rail-link" aria-hidden="true" />}
          <div className="rail-col">
            {col.map((n) => {
              const look = pending ? { icon: "○", st: "pending" } : n.look;
              return (
                <button type="button" key={n.id} className={`rail-node rs-${look.st}${selected === n.id ? " on" : ""}`} onClick={() => onSelect(n.id)}>
                  <span className="rail-no">
                    {look.icon} {t("ui.stageGraph.stageNo", { no: i + 1 })}
                  </span>
                  <span className="rail-title">{n.title}</span>
                  {pending && <MarkBadges marks={n.marks} quiet />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
