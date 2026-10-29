// 记忆 · 结论（233 号票，#/more/memory/claims）：从素材里整理出来的结论，按层分组（近期状态、偏好、需求、价值观），
// 顶上按状态筛（全凭概览给的条数），点一条去"证据与推理"看它的证据链和竞争解释。
// - 一行：陈述；下面编号 · 层级 · 状态 · 把握 · 来源，更新时间，支持/反证/竞争解释的条数小签；
// - 顶上：结论一共几条、各层各几条；最近一次整理是那一夜、跑成什么样、新出几条；问题箱开着几个在首页上写；
// - 推理库还没建、正被每晚整理占着：写原因和空数据（不报错、不是空白的页）；
// - 一页最多 MEMORY_CLAIMS_MAX 条（接口的上限），超过时写明只显示前几条。
// - 330 号票：每条结论一行上先是醒目的"已验证 / 猜测"小签（标着复核的再加"复核中"）；最下面一节"做法"（交互策略）：
//   在用 / 待你确认、"建在猜测上"、"理由没了"的小签，下面是依据的结论（GET /api/memory/strategies）。
// 说法和推导都在状态层（state/memory-graph.ts），这里只管画。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { retryLoad } from "../../app/retry-load.ts";
import {
  MEMORY_CLAIMS_MAX,
  type MemoryClaimBrief,
  type MemoryClaimListPage,
  type MemoryBadge,
  type MemoryClaimStatus,
  type MemoryClaimStatusChoice,
  type MemoryStrategiesView,
  memoryStrategyRow,
  memoryClaimGroups,
  memoryClaimRow,
  memoryClaimStatusChoices,
  memoryLastNightLine,
  memorySummaryLine,
  type MemorySummaryView,
  t,
} from "../../state/index.ts";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 330 号票：醒目的小签（已验证绿、猜测橙、别的淡） */
export function Badges({ badges }: { badges: readonly MemoryBadge[] }) {
  return (
    <>
      {badges.map((badge) => (
        <span key={badge.label} className={`chip mem-badge chip-${badge.tone === "ok" ? "ok" : badge.tone === "guess" ? "guess" : "quiet"}`} data-tone={badge.tone}>
          {badge.label}
        </span>
      ))}
    </>
  );
}

/** 列表里的一条结论（结论页和"证据与推理"的挑选用同一个） */
export function ClaimRowButton({ item, onOpen }: { item: MemoryClaimBrief; onOpen(): void }) {
  const row = memoryClaimRow(item);
  return (
    <button type="button" className="prompt-row mem-row" onClick={onOpen}>
      <span className="prompt-row-text">
        <span className="mem-row-text">{row.statement}</span>
        <small className="mem-row-meta">{row.meta}</small>
        <small className="mem-row-meta">{row.updated}</small>
        <span className="mem-row-chips">
          <Badges badges={row.badges} />
          {row.chips.map((chip) => (
            <span key={chip} className="chip chip-quiet">
              {chip}
            </span>
          ))}
        </span>
      </span>
      <span className="muted">›</span>
    </button>
  );
}

/** 330 号票：做法（交互策略）那一节；没有做法不出这一节 */
function StrategySection({ view }: { view: MemoryStrategiesView | undefined }) {
  if (view === undefined || !view.ready || view.items.length === 0) return null;
  return (
    <section className="mem-tier mem-strategies" aria-label={t("pages.memoryGraph.strategies")}>
      <div className="mem-tier-head">
        <span>{t("pages.memoryGraph.strategies")}</span>
        <span className="muted">{view.items.length}</span>
      </div>
      <div className="mem-note">{t("pages.memoryGraph.strategiesSub")}</div>
      <div className="prompt-rows">
        {view.items.map((item) => {
          const row = memoryStrategyRow(item);
          return (
            <div key={row.id} className="prompt-row mem-row mem-strategy" data-strategy={row.id}>
              <span className="prompt-row-text">
                <span className="mem-row-text">{row.text}</span>
                <span className="mem-row-chips">
                  <Badges badges={row.badges} />
                </span>
                <small className="mem-row-meta">{row.basis}</small>
                {row.note !== undefined && <small className="mem-row-meta">{row.note}</small>}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 层的小标题和它下面那几条 */
function ClaimGroup({ label, items, onOpen }: { label: string; items: readonly MemoryClaimBrief[]; onOpen(id: string): void }) {
  return (
    <section className="mem-tier" aria-label={label}>
      <div className="mem-tier-head">
        <span>{label}</span>
        <span className="muted">{items.length}</span>
      </div>
      <div className="prompt-rows">
        {items.map((item) => (
          <ClaimRowButton key={item.id} item={item} onOpen={() => onOpen(item.id)} />
        ))}
      </div>
    </section>
  );
}

/** 记忆 · 结论：onOpen 点开一条（去"证据与推理"那一层看） */
export function ClaimsBrowse({ onOpen }: { onOpen(id: string): void }) {
  const { http } = useStore();
  const [status, setStatus] = useState<MemoryClaimStatus | "all">("all");
  const [summary, setSummary] = useState<MemorySummaryView>();
  const [page, setPage] = useState<MemoryClaimListPage>();
  const [failed, setFailed] = useState<string>();
  const [strategies, setStrategies] = useState<MemoryStrategiesView>();

  useEffect(() => {
    let live = true;
    retryLoad(() => http.memorySummary())
      .then((view) => live && setSummary(view))
      .catch(() => {});
    // 330 号票：做法（交互策略）；取不到就不出那一节
    http
      .memoryStrategies()
      .then((view) => live && setStrategies(view))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [http]);

  useEffect(() => {
    let live = true;
    retryLoad(() => http.memoryClaims({ ...(status === "all" ? {} : { status }), limit: MEMORY_CLAIMS_MAX }))
      .then((view) => {
        if (!live) return;
        setPage(view);
        setFailed(undefined);
      })
      .catch((err: unknown) => live && setFailed(errorText(err)));
    return () => {
      live = false;
    };
  }, [http, status]);

  const statusChoices: MemoryClaimStatusChoice[] = memoryClaimStatusChoices(summary?.statuses);
  const groups = page === undefined ? [] : memoryClaimGroups(page.items);
  const ready = page?.ready ?? true;

  return (
    <div className="mem-page">
      {summary !== undefined && summary.ready && <div className="mem-note mem-head">{memorySummaryLine(summary)}</div>}
      {summary !== undefined && summary.ready && <div className="mem-note mem-head">{memoryLastNightLine(summary.lastNight)}</div>}
      <div className="mem-filters" role="group" aria-label={t("pages.memoryGraph.filters")}>
        {statusChoices.map((choice) => {
          const on = choice.value === status;
          return (
            <button key={choice.value} type="button" className={`mat-facet${on ? " on" : ""}`} aria-pressed={on} onClick={() => setStatus(choice.value)}>
              {choice.label}
              {choice.count !== undefined && <span className="muted"> {choice.count}</span>}
            </button>
          );
        })}
      </div>
      {failed !== undefined && <div className="hint">{t("pages.memoryGraph.loadFailed", { reason: failed })}</div>}
      {page !== undefined && !ready && <div className="hint">{page.reason ?? t("pages.memoryGraph.notReady")}</div>}
      {page !== undefined && ready && page.items.length === 0 && status !== "all" && <div className="muted">{t("pages.memoryGraph.noneFiltered")}</div>}
      {page !== undefined && ready && page.items.length === 0 && status === "all" && summary === undefined && <div className="muted">{t("pages.memoryGraph.noClaims")}</div>}
      {groups.map((group) => (
        <ClaimGroup key={group.tier} label={group.label} items={group.items} onOpen={onOpen} />
      ))}
      {page !== undefined && ready && page.total > page.items.length && <div className="mem-note">{t("pages.memoryGraph.limited", { shown: page.items.length, total: page.total })}</div>}
      <StrategySection view={strategies} />
    </div>
  );
}
