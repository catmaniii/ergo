// 记忆 · 证据与推理（233 号票）：一条结论是怎么来的。285 号票起它是"结论"里点开的一条（#/more/memory/claims/<编号>，标题写"证据与推理"）——
// 233 号票时它自己是一栏，没点开时就是结论列表少了筛选，并进结论了（旧地址 #/more/memory/evidence[/<编号>] 换到结论）。
// - 点开一条：结论本身（陈述、层级、状态、把握、来源、推法、有效期、撤回/取代它的），
//   这一组的观察，证据链（结论 → 前提 → 事实 → 原话，一层缩进一层），支持、反证、只当背景的（为什么算、多重、引的原话），
//   竞争解释（点一条换到它），推理（这条结论是怎么推出来的：推法、理由、前提），修订记录（第几条、哪种操作、为什么、改了什么）；
// - 没有这一块时写明（还没找到反证、明说的不是推出来的、没有改过），不是空一片；
// - 推理库读不到：写原因；这条结论不在了：写"这条结论不在了"（可能撤回、清掉了，或者重建过推理库）。
// 说法和推导都在状态层（state/memory-graph.ts），这里只管画。
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { retryLoad } from "../../app/retry-load.ts";
import {
  MEMORY_PREMISE_KIND_LABEL,
  type MemoryClaimDetailView,
  type MemoryClaimDetailClaim,
  memoryClaimDetailMeta,
  memoryClaimEndedBy,
  memoryClaimBadges,
  memoryClaimValidity,
  memoryGuessLines,
  memoryInferenceRow,
  memoryLinkRow,
  memoryPremiseRows,
  memoryPremiseStatusText,
  memoryQuoteRow,
  memoryRevisionRow,
  t,
} from "../../state/index.ts";
import { Section } from "../../ui/detail/section.tsx";
import { Badges, ClaimRowButton } from "./ClaimsBrowse.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 记忆 · 结论里点开的一条（证据与推理）：sub 是那条结论 */
export function EvidenceBrowse({ sub, onOpen, onClose }: { sub: string; onOpen(id: string): void; onClose(): void }) {
  return <ClaimEvidence claimId={sub} onOpen={onOpen} onClose={onClose} />;
}

type Loaded = { kind: "view"; view: MemoryClaimDetailView } | { kind: "missing" } | { kind: "failed"; message: string };

/** 一条结论的完整解释 */
function ClaimEvidence({ claimId, onOpen, onClose }: { claimId: string; onOpen(id: string): void; onClose(): void }) {
  const { http } = useStore();
  const [loaded, setLoaded] = useState<Loaded>();

  const load = useCallback(
    (signal?: AbortSignal) => {
      retryLoad(() => http.memoryClaim(claimId, signal)).then(
        (view) => setLoaded(view ? { kind: "view", view } : { kind: "missing" }),
        (err: unknown) => {
          if (!signal?.aborted) setLoaded({ kind: "failed", message: errorText(err) });
        },
      );
    },
    [http, claimId],
  );
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal);
    return () => abort.abort();
  }, [load]);

  if (loaded === undefined) return <div className="muted">{t("pages.memoryGraph.loading")}</div>;
  if (loaded.kind === "failed") return <div className="hint">{t("pages.memoryGraph.loadFailed", { reason: loaded.message })}</div>;
  if (loaded.kind === "missing") return <div className="page-placeholder">{t("pages.memoryGraph.claimGone")}</div>;
  const { view } = loaded;
  if (!view.ready || view.claim === undefined) {
    return (
      <div className="mem-page">
        <div className="hint">{view.reason ?? t("pages.memoryGraph.notReady")}</div>
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.memoryGraph.backToPicker")}
        </button>
      </div>
    );
  }
  const claim: MemoryClaimDetailClaim = view.claim;
  const validity = memoryClaimValidity(claim);
  const ended = memoryClaimEndedBy(claim);
  const chain = memoryPremiseRows(view.premises);
  // 330 号票（R5）：猜测写明为什么还是猜测
  const guess = memoryGuessLines(view.whyGuess);

  return (
    <div className="mat-detail mem-detail">
      <div className="mem-detail-title">{claim.statement}</div>
      <div className="mem-row-chips">
        <Badges badges={memoryClaimBadges(claim)} />
      </div>
      <div className="mem-note">{memoryClaimDetailMeta(claim)}</div>
      {guess.length > 0 && (
        <div className="mem-guess" data-why-guess="">
          <div className="mem-guess-head">{t("pages.memoryGraph.whyGuess")}</div>
          {guess.map((line) => (
            <div key={line} className="mem-note">
              {line}
            </div>
          ))}
        </div>
      )}
      {validity !== undefined && <div className="mem-note">{validity}</div>}
      {ended !== undefined && <div className="mem-note">{ended}</div>}
      {view.group !== undefined && (
        <Section title={t("pages.memoryGraph.group")}>
          <div className="mem-note">{view.group.description}</div>
        </Section>
      )}
      <Section title={t("pages.memoryGraph.chain")}>
        {chain.length === 0 ? (
          <div className="muted">{t("pages.memoryGraph.noChain")}</div>
        ) : (
          <div className="mem-chain">
            {chain.map((row, i) => (
              <div key={`${row.id}-${i}`} className="mem-chain-row" style={{ paddingLeft: row.depth * 14 }}>
                <span className="mem-chain-id">{row.id}</span>
                <span>{row.kind === "evidence" ? t("pages.memoryGraph.quoted", { text: row.label }) : row.label}</span>
                <span className="mem-chain-state">
                  {MEMORY_PREMISE_KIND_LABEL[row.kind]} · {memoryPremiseStatusText(row)}
                </span>
                {row.truncated && <span className="mem-chain-state">{t("pages.memoryGraph.truncated")}</span>}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Links title={t("pages.memoryGraph.supports", { count: view.supports.length })} links={view.supports.map((link) => memoryLinkRow(link, "supports"))} empty={t("pages.memoryGraph.noSupports")} />
      <Links title={t("pages.memoryGraph.refutes", { count: view.refutes.length })} links={view.refutes.map((link) => memoryLinkRow(link, "refutes"))} empty={t("pages.memoryGraph.noRefutes")} />
      {view.background.length > 0 && (
        <Links title={t("pages.memoryGraph.background", { count: view.background.length })} links={view.background.map((link) => memoryLinkRow(link, "context"))} empty={t("pages.memoryGraph.noBackground")} />
      )}
      <Section title={t("pages.memoryGraph.competitors", { count: view.competitors.length })}>
        {view.competitors.length === 0 ? (
          <div className="muted">{t("pages.memoryGraph.noCompetitors")}</div>
        ) : (
          <div className="prompt-rows">
            {view.competitors.map((other) => (
              <ClaimRowButton key={other.id} item={other} onOpen={() => onOpen(other.id)} />
            ))}
          </div>
        )}
      </Section>
      <Section title={t("pages.memoryGraph.inferences", { count: view.inferences.length })}>
        {view.inferences.length === 0 ? (
          <div className="muted">{t("pages.memoryGraph.noInferences")}</div>
        ) : (
          <div className="mem-links">
            {view.inferences.map((inference) => {
              const row = memoryInferenceRow(inference);
              return (
                <div key={row.id} className="mem-link">
                  <div className="mem-link-head">
                    <b>{row.title}</b>
                  </div>
                  <div className="mem-note">{row.rationale}</div>
                  <div className="mem-note">{t("pages.memoryGraph.premises", { ids: row.premises })}</div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <Section title={t("pages.memoryGraph.revisions", { count: view.revisions.length })}>
        {view.revisions.length === 0 ? (
          <div className="muted">{t("pages.memoryGraph.noRevisions")}</div>
        ) : (
          <div className="mem-links">
            {view.revisions.map((revision) => {
              const row = memoryRevisionRow(revision);
              return (
                <div key={row.seq} className="mem-link">
                  <div className="mem-link-head">
                    <b>{row.title}</b>
                    <span className="muted">{row.when}</span>
                  </div>
                  {row.by !== "" && <div className="mem-note muted">{row.by}</div>}
                  <div className="mem-note">{row.reason}</div>
                  {row.changes.length > 0 && (
                    <ul className="mem-revision-changes">
                      {row.changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <Section title={t("pages.memoryGraph.quotes", { count: view.evidence.length })}>
        {view.evidence.length === 0 ? (
          <div className="muted">{t("pages.memoryGraph.noQuotes")}</div>
        ) : (
          <div className="mem-links">
            {view.evidence.map((quote) => {
              const row = memoryQuoteRow(quote);
              return (
                <div key={row.id} className={`mem-quote${row.usable ? "" : " mem-quote-bad"}`}>
                  <span className="mem-quote-text">{row.text}</span>
                  <span className="mem-quote-meta">{row.meta}</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

/** 支持、反证、只当背景的一块 */
function Links({ title, links, empty }: { title: string; links: ReturnType<typeof memoryLinkRow>[]; empty: string }) {
  return (
    <Section title={title}>
      {links.length === 0 ? (
        <div className="muted">{empty}</div>
      ) : (
        <div className="mem-links">
          {links.map((row) => (
            <div key={row.id} className="mem-link">
              <div className="mem-link-head">
                <b>{row.title}</b>
              </div>
              {row.statement !== undefined && <div className="mem-note">{row.statement}</div>}
              <div className="mem-note">{row.rationale}</div>
              {row.quotes.map((quote) => (
                <div key={quote.id} className={`mem-quote${quote.usable ? "" : " mem-quote-bad"}`}>
                  <span className="mem-quote-text">{quote.text}</span>
                  <span className="mem-quote-meta">{quote.meta}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
