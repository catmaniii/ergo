/**
 * 阶段抽屉。照 AgentSense 的里程碑抽屉（web/src/ui/drawer.tsx）改的：
 * - 标题里挂一个阶段标签（StageChip）："第 N/M 阶段"，点它开关抽屉；
 * - 竖屏：标题栏下面拉出抽屉。半开是横向的阶段条，点一个只是选中它；全开下面再放选中阶段的卡片。
 *   底下的把手往下拉展开一档、往上推收回一档；
 * - 宽屏：会话左边的常驻栏（阶段列表 + 选中阶段的卡片）。
 * 60 号票照 AgentSense（bedf5a5）补上：阶段标签写"◐ 第 N 阶段 · 已验收几个/共几个 ▾"（StageChip 的 progress，小三角表示能点，
 * 展开时朝上）；点一个阶段（阶段条、阶段栏）选中它的同时，在右边的详情栏（竖屏从右侧滑入）打开它的阶段详情（AgentSense 的 pick：
 * onSelect + onDetail，阶段详情在 ui/detail/StageDetail.tsx）；抽屉全开、宽屏阶段栏的下面一行是执行中出过的状况（每类几次，点一个
 * 看是哪几次：AgentSense 的 Counts，counts 由任务详情给）；刚被拉回、拦下、你拒绝时阶段标签闪一下（AgentSense 的 fx-ping，usePing）。
 * 88 号票：宽屏的阶段栏头上一行"整个计划"和 ×（照 AgentSense bedf5a5 MilestoneSide 的 md-side-head / md-side-close），点了整栏藏掉，
 * 宽屏的阶段标签挪到标题栏左边（正在阶段栏上方），点它再打开（用户 2026-10-11 定）；开着还是藏掉按设备记住，由任务详情管
 * （state/task-page.ts 的 stageSideLayout、stageChipPlace，app/page-stage-side.ts）。竖屏的抽屉、阶段标签不变。
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ACCEPTANCE_METHOD_LABEL, tokensLabel, WAIT_REASON_LABEL } from "../../model/labels.ts";
import type { Stage } from "../../model/types.ts";
import type { GuardPingKind } from "../../state/index.ts";

export type DrawerMode = "closed" | "half" | "full";

/** 阶段的状态：图标和说法（阶段抽屉、阶段详情共用） */
export const STAGE_STATUS: Record<Stage["status"], { icon: string; text: string }> = {
  pending: { icon: "○", text: "没开始" },
  running: { icon: "◐", text: "进行中" },
  accepting: { icon: "◔", text: "验收中" },
  waiting: { icon: "◐", text: "等你" },
  accepted: { icon: "✓", text: "已验收" },
  failed: { icon: "✕", text: "没通过" },
  stopped: { icon: "⏹", text: "不做了" },
};

export function currentStage(stages: Stage[]): Stage | undefined {
  return stages.find((s) => s.status === "running" || s.status === "accepting" || s.status === "waiting") ?? stages.find((s) => s.status === "pending") ?? stages.at(-1);
}

/** 预算一行：用了多少（token 来自账本，工具调用次数数的是这个阶段的调用记录）有数时写"用了 / 预算"，没有时只写预算（阶段卡、阶段详情共用） */
export function budgetText(b: Stage["budget"]): string {
  const tokens = b.usedTokens === undefined ? `${tokensLabel(b.tokens)} token` : `${tokensLabel(b.usedTokens)} / ${tokensLabel(b.tokens)} token`;
  const calls = b.usedToolCalls === undefined ? `工具调用 ${b.toolCalls} 次` : `工具调用 ${b.usedToolCalls}/${b.toolCalls}`;
  return `${tokens} · ${calls}`;
}

/** 整份计划验收了几个（AgentSense milestone.tsx 的 milestoneProgress：已验收 / 总数去掉不做了的） */
export function stageProgress(stages: readonly Stage[]): { done: number; total: number } {
  return { done: stages.filter((s) => s.status === "accepted").length, total: stages.filter((s) => s.status !== "stopped").length };
}

/** 动效播多久就算"刚发生"（AgentSense look.ts 的 FRESH_MS） */
const FRESH_MS = 1600;
/** 打开页面后这么久之内到的（补发的历史、取回的旧页）都算历史，不闪（AgentSense look.ts 的 quietUntil） */
const QUIET_MS = 1500;

/**
 * 刚发生的拉回、拦下、你拒绝（AgentSense look.ts 的 isFresh 加 drawer.tsx 的 ping）：最近那一次换了一个、而且不是刚打开页面时
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
 * 标题里的阶段标签（AgentSense drawer.tsx 的 StageChip）：聊天里正在看的那一段属于第几阶段（状态图标跟着这个阶段），后面是整份计划
 * 验收了几个；小三角表示能点，点它开关计划（展开时三角朝上）；刚被拉回 / 拦下 / 你拒绝时闪一下（ping），"回到这一阶段"
 */
export function StageChip({ stages, selected, open, onTap, ping }: { stages: Stage[]; selected?: string; open: boolean; onTap(): void; ping?: GuardPingKind | undefined }) {
  const s = stages.find((x) => x.id === selected) ?? currentStage(stages);
  if (!s) return null;
  const n = stages.indexOf(s) + 1;
  const progress = stageProgress(stages);
  return (
    <button
      type="button"
      className={`stage-chip${ping ? ` fx-ping fx-ping-${ping}` : ""}`}
      onClick={onTap}
      aria-expanded={open}
      aria-label={`第 ${n} 阶段，验收了 ${progress.done}/${progress.total}，${open ? "收起计划" : "看整个计划"}`}
      title={`第 ${n} 阶段 · ${s.title} · ${STAGE_STATUS[s.status].text} · 验收了 ${progress.done}/${progress.total}`}
    >
      <span className={`stage-st rs-${s.status}`}>{STAGE_STATUS[s.status].icon}</span>第 {n} 阶段
      <span className="stage-prog">
        · {progress.done}/{progress.total}
      </span>
      <span className="stage-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

/** 横向的阶段条 */
function StageRail({ stages, selected, onSelect }: { stages: Stage[]; selected?: string; onSelect(id: string): void }) {
  return (
    <div className="rail">
      {stages.map((s, i) => (
        <div key={s.id} className="rail-step">
          {i > 0 && <span className="rail-link" aria-hidden="true" />}
          <div className="rail-col">
            <button type="button" className={`rail-node rs-${s.status}${s.incident ? " incident" : ""}${selected === s.id ? " on" : ""}`} onClick={() => onSelect(s.id)}>
              <span className="rail-no">
                {STAGE_STATUS[s.status].icon} 第 {i + 1} 阶段
              </span>
              <span className="rail-title">{s.title}</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 一个阶段的卡片：交付件、验收标准、模式、授权、规则、预算 */
export function StageCard({ stages, id }: { stages: Stage[]; id?: string }) {
  const s = stages.find((x) => x.id === id);
  if (!s) return null;
  const n = stages.indexOf(s) + 1;
  const over = (s.budget.usedTokens ?? 0) > s.budget.tokens;
  return (
    <div className="stage-card">
      <div className="stage-card-h">
        <b>
          第 {n} 阶段 · {s.title}
        </b>
        <span className={`rs-${s.status}`}>
          {STAGE_STATUS[s.status].icon} {STAGE_STATUS[s.status].text}
          {s.status === "waiting" && s.waitReason ? `（${WAIT_REASON_LABEL[s.waitReason]}）` : ""}
          {s.attempts ? <span className="muted"> · 宣布完成 {s.attempts} 次</span> : null}
        </span>
      </div>
      {s.status === "waiting" && s.waitNote && <div className="muted">{s.waitNote}</div>}
      <dl className="kv">
        <dt>交付件</dt>
        <dd>{s.deliverable}</dd>
        <dt>验收</dt>
        <dd>
          <ul className="plain-list">
            {s.acceptance.map((a) => (
              <li key={a.text} className={a.result === "pass" ? "sys-line" : undefined}>
                {a.text}
                <span className="muted">（{ACCEPTANCE_METHOD_LABEL[a.method]}）</span>
                {a.result && (
                  <span className={a.result === "pass" ? "chip chip-ok" : "chip chip-no"}>
                    {a.result === "pass" ? "通过" : "没通过"}
                    {a.method === "review" ? " · 评审判定" : ""}
                  </span>
                )}
                {a.note && <div className="muted">{a.note}</div>}
              </li>
            ))}
          </ul>
        </dd>
        <dt>模式</dt>
        <dd>
          {s.mode === "steps" ? "定步" : "开放"}
          {s.after.length > 0 && <span className="muted"> · 前置：第 {s.after.map((a) => stages.findIndex((x) => x.id === a) + 1).join("、")} 阶段</span>}
        </dd>
        <dt>授权</dt>
        <dd>{s.grants.length ? s.grants.join("；") : <span className="muted">无</span>}</dd>
        <dt>时序规则</dt>
        <dd>{s.rules.length ? s.rules.join("；") : <span className="muted">无</span>}</dd>
        <dt>预算</dt>
        <dd className={over ? "over" : undefined}>
          {budgetText(s.budget)}
          {over && " · 超出预算"}
        </dd>
      </dl>
    </div>
  );
}

/**
 * 竖屏：标题栏下面的抽屉（收起 / 半开 / 全开）。onDetail：点一个阶段时同时打开它的阶段详情（AgentSense 的 pick）
 */
export function StageDrawer({
  stages,
  mode,
  onMode,
  selected,
  onSelect,
  onDetail,
  counts,
}: {
  stages: Stage[];
  mode: DrawerMode;
  onMode(m: DrawerMode): void;
  selected?: string;
  onSelect(id: string): void;
  onDetail?: ((id: string) => void) | undefined;
  /** 全开时最下面一行：执行中出过的状况（AgentSense 的 Counts） */
  counts?: ReactNode;
}) {
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
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
  if (mode === "closed" || stages.length === 0) return null;
  return (
    <div ref={root} className={`md md-m-${mode}`}>
      <div className="md-body">
        <StageRail
          stages={stages}
          selected={selected}
          onSelect={(id) => {
            onSelect(id);
            onDetail?.(id);
          }}
        />
        {mode === "full" && (
          <div className="md-card">
            <StageCard stages={stages} id={selected} />
          </div>
        )}
        {mode === "full" && counts && <div className="md-counts">{counts}</div>}
      </div>
      <div
        className="md-grab"
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
          onMode(mode === "half" ? "full" : "closed");
        }}
      >
        <span className="md-grab-bar" />
        <span className="md-grab-hint">{mode === "half" ? "点一下或往下拉看阶段详情 · 往上推收起" : "点一下或往上推收起"}</span>
      </div>
    </div>
  );
}

/**
 * 宽屏：会话左边的阶段栏。onDetail：点一个阶段时同时在右边的详情栏打开它的阶段详情；最下面一行是执行中出过的状况
 * （AgentSense 的 MilestoneSide）。头上一行"整个计划"和 ×（88 号票，AgentSense 的 md-side-head / md-side-close）：点了整栏藏掉
 */
export function StageSide({
  stages,
  selected,
  onSelect,
  onDetail,
  counts,
  onClose,
}: {
  stages: Stage[];
  selected?: string;
  onSelect(id: string): void;
  onDetail?: ((id: string) => void) | undefined;
  counts?: ReactNode;
  onClose(): void;
}) {
  return (
    <aside className="md-side">
      <div className="md-side-head">
        <span>整个计划</span>
        <button type="button" className="md-side-close" onClick={onClose} aria-label="收起阶段栏" title="收起阶段栏（点标题栏的阶段标签再打开）">
          ×
        </button>
      </div>
      <div className="stage-list">
        {stages.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`stage-item${selected === s.id ? " on" : ""}`}
            onClick={() => {
              onSelect(s.id);
              onDetail?.(s.id);
            }}
          >
            <span className={`rs-${s.status}`}>{STAGE_STATUS[s.status].icon}</span>
            <span className="stage-item-t">
              第 {i + 1} 阶段 · {s.title}
            </span>
            {s.incident && <span className="incident-dot" title="出过状况" />}
          </button>
        ))}
      </div>
      <div className="md-card">
        <StageCard stages={stages} id={selected} />
      </div>
      {counts && <div className="md-counts">{counts}</div>}
    </aside>
  );
}
