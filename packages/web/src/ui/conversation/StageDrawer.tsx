/**
 * 阶段抽屉。照 AgentSense 的里程碑抽屉（web/src/ui/drawer.tsx）改的：
 * - 标题里挂一个阶段标签（StageChip）："第 N/M 阶段"，点它开关抽屉；
 * - 竖屏：标题栏下面拉出抽屉。半开是横向的阶段条，点一个只是选中它；全开下面再放选中阶段的卡片。
 *   底下的把手往下拉展开一档、往上推收回一档；
 * - 宽屏：会话左边的常驻栏（阶段列表 + 选中阶段的卡片）。
 */
import { useRef } from "react";
import { ACCEPTANCE_METHOD_LABEL, tokensLabel, WAIT_REASON_LABEL } from "../../model/labels.ts";
import type { Stage } from "../../model/types.ts";

export type DrawerMode = "closed" | "half" | "full";

const STATUS: Record<Stage["status"], { icon: string; text: string }> = {
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

/** 预算一行：用了多少还没有真数据时（24 号票）只写预算 */
function budgetText(b: Stage["budget"]): string {
  if (b.usedTokens === undefined) return `${tokensLabel(b.tokens)} token · 工具调用 ${b.toolCalls} 次`;
  return `${tokensLabel(b.usedTokens)} / ${tokensLabel(b.tokens)} token · 工具调用 ${b.usedToolCalls ?? 0}/${b.toolCalls}`;
}

export function StageChip({ stages, selected, open, onTap }: { stages: Stage[]; selected?: string; open: boolean; onTap(): void }) {
  const s = stages.find((x) => x.id === selected) ?? currentStage(stages);
  if (!s) return null;
  const n = stages.indexOf(s) + 1;
  return (
    <button type="button" className="stage-chip" onClick={onTap} aria-expanded={open} title={`第 ${n} 阶段 · ${s.title} · ${STATUS[s.status].text}`}>
      <span className={`rs-${s.status}`}>{STATUS[s.status].icon}</span>第 {n}/{stages.length} 阶段
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
                {STATUS[s.status].icon} 第 {i + 1} 阶段
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
          {STATUS[s.status].icon} {STATUS[s.status].text}
          {s.status === "waiting" && s.waitReason ? `（${WAIT_REASON_LABEL[s.waitReason]}）` : ""}
          {s.attempts ? <span className="muted"> · 宣布完成 {s.attempts} 次</span> : null}
        </span>
      </div>
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

/** 竖屏：标题栏下面的抽屉（收起 / 半开 / 全开） */
export function StageDrawer({ stages, mode, onMode, selected, onSelect }: { stages: Stage[]; mode: DrawerMode; onMode(m: DrawerMode): void; selected?: string; onSelect(id: string): void }) {
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
        <StageRail stages={stages} selected={selected} onSelect={onSelect} />
        {mode === "full" && (
          <div className="md-card">
            <StageCard stages={stages} id={selected} />
          </div>
        )}
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

/** 宽屏：会话左边的阶段栏 */
export function StageSide({ stages, selected, onSelect }: { stages: Stage[]; selected?: string; onSelect(id: string): void }) {
  return (
    <aside className="md-side">
      <div className="stage-list">
        {stages.map((s, i) => (
          <button key={s.id} type="button" className={`stage-item${selected === s.id ? " on" : ""}`} onClick={() => onSelect(s.id)}>
            <span className={`rs-${s.status}`}>{STATUS[s.status].icon}</span>
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
    </aside>
  );
}
