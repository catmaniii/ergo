/**
 * 手机：对话框顶部的阶段条；宽屏：左边栏里的整张图（StageSideBody，用户 2026-11-01，和档案共用栏位；放在哪、展开到哪一档见 stage-panel.tsx）：
 * - 第一行一个阶段标签（StageChip）："◐ 第 N 阶段 · 已验收几个/共几个 ▾"（60 号票；小三角表示能点，展开时朝上），点它展开、收起；
 *   任务做完了换成一句话（比如"✓ 首版已完成 · 4/4 ▾"，368 号票）；计划还没确认时写"计划图"；刚被拉回、拦下、你拒绝时闪一下；
 * - 下面是抽屉：半开是横向的阶段条，全开是整个计划的依赖图（91 号票，StageGraph.tsx；同层并排、曲线连线），下面一行是出过的状况
 *   （每类几次，点一个看是哪几次：counts 由任务详情给）。底下的把手往下拉展开一档、往上推收回一档；
 * - 点一个阶段选中它的同时，在右边的详情栏（手机从右侧滑入）打开它的阶段详情（onSelect + onDetail，ui/detail/StageDetail.tsx）：交付件和验收标准都在那里。
 * 等你确认的计划（计划卡、计划变更）也画在这里。
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ACCEPTANCE_METHOD_LABEL, tokensLabel, WAIT_REASON_LABEL } from "../../model/labels.ts";
import type { Stage } from "../../model/types.ts";
import { approxMoney, type GuardPingKind, observedLine, type StageGraph, stageCodeLabel, stageCodes, t, tTable } from "../../state/index.ts";
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

/**
 * 预算一行：用了多少（token 来自账本，工具调用次数数的是这个阶段的调用记录）有数时写"用了 / 预算"，没有时只写预算（阶段卡、阶段详情共用）。
 * 361 号票：token 预算是阶段开始时运行时算的，还没算（0）时只写次数；算得出钱时带上大约多少钱
 */
export function budgetText(b: Stage["budget"]): string {
  const calls = b.usedToolCalls === undefined ? t("ui.stageDrawer.budget.calls", { count: b.toolCalls }) : t("ui.stageDrawer.budget.callsUsed", { used: b.usedToolCalls, total: b.toolCalls });
  if (b.tokens <= 0) return calls;
  const tokens =
    b.usedTokens === undefined
      ? t("ui.stageDrawer.budget.tokens", { tokens: tokensLabel(b.tokens) })
      : t("ui.stageDrawer.budget.tokensUsed", { used: tokensLabel(b.usedTokens), tokens: tokensLabel(b.tokens) });
  return [tokens, ...(b.cost ? [t("ui.stageDrawer.budget.cost", { cost: approxMoney(b.cost) })] : []), calls].join(" · ");
}

/** token 超出了预算（还没算预算的不算） */
export const tokensOverBudget = (b: Stage["budget"]): boolean => b.tokens > 0 && (b.usedTokens ?? 0) > b.tokens;

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
 * 368 号票：标签不在标题栏了（手机、电脑都在阶段条第一行），有地方写全，不再省"第 … 阶段"几个字
 */
export function StageChip({
  graph,
  selected,
  progress,
  open,
  onTap,
  ping,
  done,
}: {
  graph: StageGraph;
  selected?: string | undefined;
  progress: { done: number; total: number };
  open: boolean;
  onTap(): void;
  ping?: GuardPingKind | undefined;
  /** 任务做完了：这一行写的话（368 号票，比如"首版已完成"） */
  done?: { text: string; ok: boolean } | undefined;
}) {
  if (done !== undefined)
    return (
      <button type="button" className="stage-chip stage-chip-done" onClick={onTap} aria-expanded={open} aria-label={`${done.text} · ${open ? t("ui.stageDrawer.chip.hidePlan") : t("ui.stageDrawer.chip.showPlan")}`}>
        {done.ok && <span className="stage-st rs-accepted">✓</span>}
        {done.text}
        <span className="stage-prog">
          · {progress.done}/{progress.total}
        </span>
        <span className="stage-caret" aria-hidden="true">
          ▾
        </span>
      </button>
    );
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
      {t("ui.stageDrawer.stageNo", { no: s.n })}
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

/** 宽屏左边栏里的阶段进展（用户 2026-11-01：和项目档案共用一个栏位）：整张依赖图，最下面一行是出过的状况。点一个阶段：选中它，右边详情栏打开它 */
export function StageSideBody({
  graph,
  selected,
  onSelect,
  onDetail,
  counts,
}: {
  graph: StageGraph;
  selected?: string | undefined;
  onSelect(id: string): void;
  onDetail(id: string): void;
  counts?: ReactNode;
}) {
  return (
    <>
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
    </>
  );
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
  const over = tokensOverBudget(s.budget);
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
        <dd className={over ? "over" : undefined} title={t("ui.stageDrawer.budget.how")}>
          {budgetText(s.budget)}
          {over && t("ui.stageDrawer.card.overBudget")}
        </dd>
      </dl>
    </div>
  );
}

/**
 * 阶段条下面的抽屉（收起 / 半开 / 全开）。半开是横向的阶段条，全开是整个计划的图，下面一行是出过的
 * 情况；都不放阶段卡片。点一个阶段：选中它（图上高亮），同时打开它的详情（手机上详情整页从右边滑入）
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
