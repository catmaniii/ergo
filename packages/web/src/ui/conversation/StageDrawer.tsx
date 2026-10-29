/**
 * 阶段抽屉、宽屏阶段栏：
 * - 标题里挂一个阶段标签（StageChip）："第 N 阶段 · 验收了几个"，点它开关抽屉、阶段栏；
 * - 竖屏：标题栏下面拉出抽屉。半开是横向的阶段条；全开是整个计划的图，下面一行是出过的情况（几次）。
 *   底下的把手往下拉展开一档、往上推收回一档；
 * - 宽屏：会话左边的常驻栏（整个计划的图 + 出过的情况）。
 * 60 号票补上：阶段标签写"◐ 第 N 阶段 · 已验收几个/共几个 ▾"（StageChip 的 progress，小三角表示能点，
 * 展开时朝上）；点一个阶段（阶段条、阶段栏）选中它的同时，在右边的详情栏（竖屏从右侧滑入）打开它的阶段详情（
 * onSelect + onDetail，阶段详情在 ui/detail/StageDetail.tsx）；抽屉全开、宽屏阶段栏的下面一行是执行中出过的状况（每类几次，点一个
 * 看是哪几次：counts 由任务详情给）；刚被拉回、拦下、你拒绝时阶段标签闪一下。
 * 88 号票：宽屏的阶段栏头上一行"整个计划"和 ×，点了整栏藏掉，
 * 宽屏的阶段标签挪到标题栏左边（正在阶段栏上方），点它再打开（用户 2026-10-11 定）；开着还是藏掉按设备记住，由任务详情管
 * （state/task-page.ts 的 stageSideLayout、stageChipPlace，app/page-stage-side.ts）。
 * 91 号票（用户 2026-10-11 定）：阶段栏、抽屉全开都画成依赖图（ui/conversation/StageGraph.tsx，
 * 同层并排、曲线连线），不再在下面放选中阶段的卡片——点阶段卡片只在右边的详情栏（竖屏整页滑入）看它的详情；抽屉半开的阶段条
 * 并行的叠在同一列；等你确认的计划（计划卡、计划变更）也画在这里，栏头写"整个计划 · 等你确认"；阶段栏和聊天之间的分界线能左右拖
 * （宽度由任务详情管，见 stage-panel.tsx）。
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ACCEPTANCE_METHOD_LABEL, tokensLabel, WAIT_REASON_LABEL } from "../../model/labels.ts";
import type { Stage } from "../../model/types.ts";
import { type GuardPingKind, observedLine, type StageGraph, stageCodeLabel, stageCodes, t, tTable } from "../../state/index.ts";
import { StageGraphView, StageRail } from "./StageGraph.tsx";

export type DrawerMode = "closed" | "half" | "full";

/** 阶段状态的说法（按当前语言现取） */
const STAGE_STATUS_TEXT: Readonly<Record<Stage["status"], string>> = tTable({
  pending: "ui.stageDrawer.status.pending",
  running: "ui.stageDrawer.status.running",
  accepting: "ui.stageDrawer.status.accepting",
  waiting: "ui.stageDrawer.status.waiting",
  accepted: "ui.stageDrawer.status.accepted",
  failed: "ui.stageDrawer.status.failed",
  stopped: "ui.stageDrawer.status.stopped",
});

/** 一种状态：图标固定，说法取值时按当前语言现查 */
function stageStatus(status: Stage["status"], icon: string): { icon: string; text: string } {
  return {
    icon,
    get text() {
      return STAGE_STATUS_TEXT[status];
    },
  };
}

/** 阶段的状态：图标和说法（阶段抽屉、阶段详情共用） */
export const STAGE_STATUS: Record<Stage["status"], { icon: string; text: string }> = {
  pending: stageStatus("pending", "○"),
  running: stageStatus("running", "◐"),
  accepting: stageStatus("accepting", "◔"),
  waiting: stageStatus("waiting", "◐"),
  accepted: stageStatus("accepted", "✓"),
  failed: stageStatus("failed", "✕"),
  stopped: stageStatus("stopped", "⏹"),
};

export function currentStage(stages: Stage[]): Stage | undefined {
  return stages.find((s) => s.status === "running" || s.status === "accepting" || s.status === "waiting") ?? stages.find((s) => s.status === "pending") ?? stages.at(-1);
}

/** 预算一行：用了多少（token 来自账本，工具调用次数数的是这个阶段的调用记录）有数时写"用了 / 预算"，没有时只写预算（阶段卡、阶段详情共用） */
export function budgetText(b: Stage["budget"]): string {
  const tokens =
    b.usedTokens === undefined
      ? t("ui.stageDrawer.budget.tokens", { tokens: tokensLabel(b.tokens) })
      : t("ui.stageDrawer.budget.tokensUsed", { used: tokensLabel(b.usedTokens), tokens: tokensLabel(b.tokens) });
  const calls = b.usedToolCalls === undefined ? t("ui.stageDrawer.budget.calls", { count: b.toolCalls }) : t("ui.stageDrawer.budget.callsUsed", { used: b.usedToolCalls, total: b.toolCalls });
  return `${tokens} · ${calls}`;
}

/** 整份计划验收了几个（已验收 / 总数去掉不做了的） */
export function stageProgress(stages: readonly Stage[]): { done: number; total: number } {
  return { done: stages.filter((s) => s.status === "accepted").length, total: stages.filter((s) => s.status !== "stopped").length };
}

/** 动效播多久就算"刚发生" */
const FRESH_MS = 1600;
/** 打开页面后这么久之内到的（补发的历史、取回的旧页）都算历史，不闪 */
const QUIET_MS = 1500;

/**
 * 刚发生的拉回、拦下、你拒绝：最近那一次换了一个、而且不是刚打开页面时
 * 读进来的，就返回它的种类，播完一次（FRESH_MS）收回。翻历史、切页面都不播
 */
export function usePing(latest: { key: string; kind: GuardPingKind } | undefined): GuardPingKind | undefined {
  // 打开页面的时刻（挂上之后记下；渲染里不取时间）
  const opened = useRef<number | undefined>(undefined);
  useEffect(() => {
    opened.current = Date.now();
  }, []);
  const seen = useRef(latest?.key);
  const [ping, setPing] = useState<GuardPingKind>();
  const key = latest?.key;
  const kind = latest?.kind;
  useEffect(() => {
    if (key === undefined || key === seen.current) return;
    seen.current = key;
    if (opened.current === undefined || Date.now() - opened.current < QUIET_MS) return;
    setPing(kind);
    const timer = setTimeout(() => setPing(undefined), FRESH_MS);
    return () => clearTimeout(timer);
  }, [key, kind]);
  return ping;
}

/**
 * 标题里的阶段标签：聊天里正在看的那一段属于第几阶段（状态图标跟着这个阶段），后面是整份计划
 * 验收了几个；小三角表示能点，点它开关计划（展开时三角朝上）；刚被拉回 / 拦下 / 你拒绝时闪一下（ping），"回到这一阶段"。
 * 91 号票：第几阶段按依赖图的阶段号（并行的同号）；计划还没确认、画的是等你确认的计划时写"计划图"。
 * 93 号票：手机上也写"· 验收了几个"（91 号票为了给标题让地方在手机上省掉过）。compact（手机上，用户 2026-10-12
 * 定 B）：省掉"第 … 阶段"几个字，只写"◐ 3 · 3/7 ▾"，给标题让地方；全称照样在读屏的说明和 title 里
 */
export function StageChip({
  graph,
  selected,
  progress,
  open,
  onTap,
  ping,
  compact = false,
}: {
  graph: StageGraph;
  selected?: string | undefined;
  progress: { done: number; total: number };
  open: boolean;
  onTap(): void;
  ping?: GuardPingKind | undefined;
  compact?: boolean | undefined;
}) {
  if (graph.kind === "plan")
    return (
      <button type="button" className="stage-chip" onClick={onTap} aria-expanded={open} aria-label={open ? t("ui.stageDrawer.chip.hidePlanGraph") : t("ui.stageDrawer.chip.showPlanGraph")}>
        {t("ui.stageDrawer.chip.planGraph")}
        <span className="stage-caret" aria-hidden="true">
          ▾
        </span>
      </button>
    );
  const live = graph.nodes.filter((x) => x.state !== "removed");
  const s = live.find((x) => x.id === selected) ?? live[0];
  if (!s) return null;
  return (
    <button
      type="button"
      className={`stage-chip${ping ? ` fx-ping fx-ping-${ping}` : ""}`}
      onClick={onTap}
      aria-expanded={open}
      aria-label={t("ui.stageDrawer.chip.label", { no: s.n, done: progress.done, total: progress.total, action: open ? t("ui.stageDrawer.chip.hidePlan") : t("ui.stageDrawer.chip.showPlan") })}
      title={t("ui.stageDrawer.chip.title", { no: s.n, title: s.title, status: s.look.text, done: progress.done, total: progress.total })}
    >
      <span className={`stage-st rs-${s.look.st}`}>{s.look.icon}</span>
      {compact ? s.n : t("ui.stageDrawer.stageNo", { no: s.n })}
      <span className="stage-prog">
        · {progress.done}/{progress.total}
      </span>
      <span className="stage-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

/**
 * 整个计划下面一行：执行中出过的情况，每类一个数，点一个看是哪几次（counts 由任务详情给）；
 * 计划还没确认时写"授权之后，这里实时显示进展和出过的情况"
 */
function Counts({ graph, counts }: { graph: StageGraph; counts: ReactNode }) {
  if (graph.kind === "plan") return <div className="md-counts ic-none">{t("ui.stageDrawer.countsPending")}</div>;
  return counts ? <div className="md-counts">{counts}</div> : null;
}

/**
 * 一个阶段的卡片：交付件、验收标准、模式、授权、规则、预算（任务详情"计划"一栏逐个列出；91 号票起阶段栏、抽屉里不再放它，
 * 点阶段在右边的详情栏看阶段详情）。第几阶段按依赖图的编号（并行的写 4a、4b）
 */
export function StageCard({ stages, id }: { stages: Stage[]; id?: string }) {
  const s = stages.find((x) => x.id === id);
  if (!s) return null;
  const codes = stageCodes(stages);
  const n = codes.get(s.id);
  const over = (s.budget.usedTokens ?? 0) > s.budget.tokens;
  return (
    <div className="stage-card">
      <div className="stage-card-h">
        <b>{t("ui.stageDrawer.card.title", { no: n ?? "", title: s.title })}</b>
        <span className={`rs-${s.status}`}>
          {STAGE_STATUS[s.status].icon} {STAGE_STATUS[s.status].text}
          {s.status === "waiting" && s.waitReason ? t("ui.stageDrawer.card.waitReason", { reason: WAIT_REASON_LABEL[s.waitReason] }) : ""}
          {s.attempts ? <span className="muted">{t("ui.stageDrawer.card.attempts", { count: s.attempts })}</span> : null}
        </span>
      </div>
      {s.status === "waiting" && s.waitNote && <div className="muted">{s.waitNote}</div>}
      <dl className="kv">
        <dt>{t("ui.stageDrawer.card.deliverable")}</dt>
        <dd>{s.deliverable}</dd>
        {/* 274 号票：最近一次交上来时系统从执行记录里查到的，和自报对不上的另标 */}
        {s.observed && (
          <>
            <dt>{t("ui.stageDrawer.card.observed")}</dt>
            <dd>
              <span className="sys-line">{observedLine(s.observed)}</span>
              {s.observed.mismatches > 0 && <span className="stage-card-bad">{t("ui.stageDrawer.card.observedMismatch", { n: s.observed.mismatches, count: s.observed.mismatches })}</span>}
            </dd>
          </>
        )}
        <dt>{t("ui.stageDrawer.card.acceptance")}</dt>
        <dd>
          <ul className="plain-list">
            {s.acceptance.map((a) => (
              <li key={a.text} className={a.result === "pass" ? "sys-line" : undefined}>
                {a.text}
                <span className="muted">{t("ui.stageDrawer.card.method", { method: ACCEPTANCE_METHOD_LABEL[a.method] })}</span>
                {a.result && (
                  <span className={a.result === "pass" ? "chip chip-ok" : "chip chip-no"}>
                    {a.result === "pass" ? t("ui.stageDrawer.card.passed") : t("ui.stageDrawer.card.failed")}
                    {a.method === "review" ? t("ui.stageDrawer.card.byReview") : ""}
                  </span>
                )}
                {a.note && <div className="muted">{a.note}</div>}
              </li>
            ))}
          </ul>
        </dd>
        <dt>{t("ui.stageDrawer.card.mode")}</dt>
        <dd>
          {s.mode === "steps" ? t("ui.stageDrawer.card.modeSteps") : t("ui.stageDrawer.card.modeOpen")}
          {s.after.length > 0 && <span className="muted">{t("ui.stageDrawer.card.after", { stages: s.after.map((a) => stageCodeLabel(codes, a)).join(t("ui.common.listSep")) })}</span>}
        </dd>
        <dt>{t("ui.stageDrawer.card.grants")}</dt>
        <dd>{s.grants.length ? s.grants.join(t("ui.stageDrawer.card.itemSep")) : <span className="muted">{t("ui.stageDrawer.card.none")}</span>}</dd>
        <dt>{t("ui.stageDrawer.card.rules")}</dt>
        <dd>{s.rules.length ? s.rules.join(t("ui.stageDrawer.card.itemSep")) : <span className="muted">{t("ui.stageDrawer.card.none")}</span>}</dd>
        <dt>{t("ui.stageDrawer.card.budget")}</dt>
        <dd className={over ? "over" : undefined}>
          {budgetText(s.budget)}
          {over && t("ui.stageDrawer.card.overBudget")}
        </dd>
      </dl>
    </div>
  );
}

/**
 * 竖屏：标题栏下面的抽屉（收起 / 半开 / 全开）。半开是横向的阶段条，全开是整个计划的图，下面一行是出过的
 * 情况；都不放阶段卡片。点一个阶段：选中它（图上高亮），同时打开它的详情（详情整页从右边滑入）
 */
export function StageDrawer({
  graph,
  mode,
  onMode,
  selected,
  onSelect,
  onDetail,
  counts,
}: {
  graph: StageGraph;
  mode: DrawerMode;
  onMode(m: DrawerMode): void;
  selected?: string | undefined;
  onSelect(id: string): void;
  /** 进某个阶段的详情 */
  onDetail(id: string): void;
  /** 全开时最下面一行：执行中出过的状况 */
  counts?: ReactNode;
}) {
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  /** 刚拖过：随后那一下 click 不再当成点击 */
  const dragged = useRef(false);
  /** 拖的时候把位移写到抽屉上（--md-dy），抽屉跟着手指走一点；不触发重新渲染 */
  const root = useRef<HTMLDivElement>(null);
  const follow = (dy: number | undefined) => {
    const el = root.current;
    if (!el) return;
    if (dy === undefined) {
      el.removeAttribute("data-drag");
      el.style.removeProperty("--md-dy");
    } else {
      el.setAttribute("data-drag", "");
      el.style.setProperty("--md-dy", `${Math.round(dy)}px`);
    }
  };
  if (mode === "closed") return null;
  const pick = (id: string) => {
    onSelect(id);
    onDetail(id);
  };
  return (
    <div ref={root} className={`md md-m-${mode}`}>
      {mode === "half" && (
        <div className="md-body md-rail-only">
          <StageRail graph={graph} selected={selected} onSelect={pick} />
        </div>
      )}
      {mode === "full" && (
        <div className="md-body md-split">
          <div className="md-graph">
            <StageGraphView graph={graph} focus={selected} onNode={pick} />
          </div>
          <Counts graph={graph} counts={counts} />
        </div>
      )}
      <div
        className="md-grab"
        // 往下拉展开一档，往上推收回一档；没怎么动就当是点了一下（点一下：全开缩回半开，半开收起）
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          if (Math.abs(e.clientY - drag.current.y) > 12) drag.current.moved = true;
          if (drag.current.moved) follow(e.clientY - drag.current.y);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          follow(undefined);
          dragged.current = !!d?.moved;
          if (!d?.moved) return;
          if (e.clientY - d.y > 0) onMode("full");
          else onMode(mode === "full" ? "half" : "closed");
        }}
        onPointerCancel={() => {
          drag.current = null;
          follow(undefined);
        }}
        onClick={() => {
          if (dragged.current) return void (dragged.current = false);
          onMode(mode === "full" ? "half" : "closed");
        }}
      >
        <span className="md-grab-bar" />
        <span className="md-grab-hint">{mode === "half" ? t("ui.stageDrawer.grab.half") : t("ui.stageDrawer.grab.full")}</span>
      </div>
    </div>
  );
}

/**
 * 宽屏：会话左边的阶段栏：头上一行"整个计划"（等你确认的计划写"· 等你确认"）和 ×（整栏藏掉），
 * 下面是整个计划的图，最下面一行是出过的情况。点一个阶段：选中它，同时在右边的详情栏打开它的详情。栏宽由任务详情给（分界线拖它）
 */
export function StageSide({
  graph,
  selected,
  onSelect,
  onDetail,
  counts,
  width,
  onClose,
}: {
  graph: StageGraph;
  selected?: string | undefined;
  onSelect(id: string): void;
  onDetail(id: string): void;
  counts?: ReactNode;
  /** 栏宽（像素），右边的分界线拖它 */
  width: number;
  onClose(): void;
}) {
  return (
    <aside className="md-side" style={{ width }}>
      <div className="md-side-head">
        <span>
          {t("ui.stageDrawer.side.title")}
          {graph.kind !== "live" && <span className="md-side-wait">{t("ui.stageDrawer.side.awaiting")}</span>}
        </span>
        <button type="button" className="md-side-close" onClick={onClose} aria-label={t("ui.stageDrawer.side.close")} title={t("ui.stageDrawer.side.closeTip")}>
          ×
        </button>
      </div>
      <div className="md-side-graph">
        <StageGraphView
          graph={graph}
          focus={selected}
          onNode={(id) => {
            onSelect(id);
            onDetail(id);
          }}
        />
      </div>
      <Counts graph={graph} counts={counts} />
    </aside>
  );
}
