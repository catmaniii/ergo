/**
 * "这次用到的记忆"（187 号票）：会话里"回忆了 N 条记忆 ›"那一行点开的详情。内容由状态层的 detailContent 推好（RecallDetail：
 * 按先后的思考、每次检索、读全文），这里只管画。按调用先后列出：
 * - 每次检索：为什么查（旧记录没有，写"查：<query>"）、查了什么，找到的每条；"这次调用 ›"点进单次调用的详情（参数、完整返回）；
 * - 找到的每条（RecallHitCard）：每次打开现取（GET /api/materials/<素材 id>，记忆页同一个接口，不缓存）——原话（本人的话；长的截断、
 *   能展开）或说明（不是本人的话）、什么时候（具体时间加"3 天前"）、在哪（来源会话的名字，没有会话的写任务、项目）、"看原话 ›"
 *   （出处的消息还在当前分支上才有，去哪和记忆页的"跳到这条消息"同一个认法）、种类、怎么找出来的、读了全文；
 *   取不到（忘掉了、彻底删除了）写"这条记忆已删除"，不显示原文；
 * - 读全文的：读的是前面检索到的那条就在那条上标"读了全文"，别的单独一条"读了一条记忆的全文"；
 * - 187 号票之前的检索记录没有逐条的命中：现取这次调用的完整返回（53 号票的接口），按行认出素材 id（parseLegacyHits），取不到的注明；
 * - 266 号票：自动带上的记忆简报（不是工具调用，没有"这次调用 ›"）：每条为什么带它（直接说到这件事、经哪条路找到的；同一方面；
 *   还没分出胜负；明说过的禁忌）、说到的结论——每次打开按编号现取说法（GET /api/memory/claims/<编号>），带"看证据与推理 ›"，
 *   结论已经没有了（撤回、彻底删除）写明；下面是简报引的原话背后的素材，和检索的一样画。
 * 排版借详情栏的几样（dt-head、dt-title、chips、dg-think），11 套风格跟着各自的详情栏走。
 * 193 号票：从 ui/detail/ 挪进记忆插件，登记成详情 recall 的画法（plugins/memory/plugin.tsx）。
 */
import { useEffect, useState } from "react";
import { inboxJumpRoute, toHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import {
  conversationName,
  type DetailContent,
  type MaterialDetailView,
  type MemoryClaimBrief,
  memoryClaimRow,
  parseLegacyHits,
  readableId,
  recallHowLabel,
  type RecallHitLine,
  recallMaterial,
  type RecallStepLine,
  t,
} from "../../state/index.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { Icon } from "../../ui/icons.tsx";
import { MEMORY_PAGE } from "./route.ts";

type Content = Extract<DetailContent, { kind: "recall" }>;

/** 详情插槽 recall 的正文（193 号票）：核心按详情的种类交过来，挂着的内部工具调用由核心接在后面 */
export function RecallDetailBody({ content, onOpen }: { content: DetailContent; onOpen?: ((id: string) => void) | undefined }) {
  return content.kind === "recall" ? <RecallDetail content={content} onOpen={onOpen} /> : null;
}

export function RecallDetail({ content, onOpen }: { content: Content; onOpen?: ((id: string) => void) | undefined }) {
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-tool rc-tag">
          <Icon name="layers" /> {t("ui.recallDetail.tag")}
        </span>
        <span className={`dt-status${content.count > 0 ? " ok" : ""}`}>{content.title}</span>
      </div>
      <div className="dt-title">{t("ui.recallDetail.title")}</div>
      <ol className="rc-steps">
        {content.steps.map((step) => (
          <RecallStep key={step.kind === "thinking" ? step.id : `${step.id}:${step.kind === "read" ? step.hit.materialId : ""}`} step={step} onOpen={onOpen} />
        ))}
      </ol>
    </>
  );
}

function RecallStep({ step, onOpen }: { step: RecallStepLine; onOpen?: ((id: string) => void) | undefined }) {
  if (step.kind === "thinking")
    return (
      <li className="dg-think">
        <span className="dg-think-tag">💭 {t("ui.detailPane.thinking")}</span>
        {step.text}
      </li>
    );
  const callLink = onOpen && (
    <button type="button" className="link-btn rc-call" onClick={() => onOpen(step.id)}>
      {t("ui.recallDetail.callLink")}
    </button>
  );
  if (step.kind === "brief")
    return (
      <li className="rc-step">
        <div className="rc-why">
          <span className="rc-why-text">{step.title}</span>
        </div>
        <ul className="rc-reasons">
          {step.items.map((item) => (
            <li key={item.key} className="rc-reason">
              <div className="rc-reason-why">
                <span className="chip">{item.reason}</span>
                {item.how && <span className="rc-reason-how">{item.how}</span>}
              </div>
              {item.claimIds.map((id) => (
                <BriefClaim key={id} claimId={id} />
              ))}
            </li>
          ))}
        </ul>
        <HitList hits={step.hits} />
      </li>
    );
  if (step.kind === "read")
    return (
      <li className="rc-step">
        <div className="rc-why">
          <span className="rc-label">{t("ui.recallDetail.read")}</span>
          {callLink}
        </div>
        <div className="rc-hits">
          <RecallHitCard hit={step.hit} />
        </div>
      </li>
    );
  return (
    <li className="rc-step">
      <div className="rc-why">
        {step.query !== undefined && <span className="rc-label">{t("ui.recallDetail.why")}</span>}
        <span className="rc-why-text">{step.title}</span>
        {callLink}
      </div>
      {step.query !== undefined && (
        <div className="rc-query">
          <span className="rc-label">{t("ui.recallDetail.query")}</span>
          {step.query}
        </div>
      )}
      {step.hits ? <HitList hits={step.hits} /> : <LegacyHits callId={step.callId} />}
    </li>
  );
}

function HitList({ hits }: { hits: readonly RecallHitLine[] }) {
  if (hits.length === 0) return <div className="muted rc-none">{t("ui.recallDetail.none")}</div>;
  return (
    <div className="rc-hits">
      {hits.map((hit) => (
        <RecallHitCard key={hit.materialId} hit={hit} />
      ))}
    </div>
  );
}

type ClaimLoaded = { kind: "claim"; claim: MemoryClaimBrief } | { kind: "missing" } | { kind: "failed"; message: string };

/** 记忆简报说到的一条结论（266 号票）：每次打开按编号现取说法（不缓存：撤回、彻底删除之后再打开就是"已经没有了"） */
function BriefClaim({ claimId }: { claimId: string }) {
  const { http } = useStore();
  const [got, setGot] = useState<{ id: string; loaded: ClaimLoaded }>();
  useEffect(() => {
    const abort = new AbortController();
    const done = (loaded: ClaimLoaded) => {
      if (!abort.signal.aborted) setGot({ id: claimId, loaded });
    };
    http.memoryClaim(claimId, abort.signal).then(
      (view) => done(view?.claim ? { kind: "claim", claim: view.claim } : { kind: "missing" }),
      (err: unknown) => done({ kind: "failed", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => abort.abort();
  }, [http, claimId]);
  const loaded = got?.id === claimId ? got.loaded : undefined;
  if (!loaded) return <div className="rc-claim muted">{t("ui.recallDetail.claimLoading")}</div>;
  if (loaded.kind === "missing") return <div className="rc-claim rc-gone">{t("ui.recallDetail.claimGone", { id: claimId })}</div>;
  if (loaded.kind === "failed") return <div className="rc-claim muted">{t("ui.recallDetail.claimFailed", { reason: loaded.message })}</div>;
  const row = memoryClaimRow(loaded.claim);
  return (
    <div className="rc-claim">
      <div className="rc-quote">{row.statement}</div>
      <div className="rc-meta">
        <span>{row.meta}</span>
        <a className="link rc-jump" href={toHash({ tab: "more", page: MEMORY_PAGE, item: "evidence", sub: claimId })}>
          {t("ui.recallDetail.viewClaim")}
        </a>
      </div>
    </div>
  );
}

type Legacy = { state: "loading" } | { state: "ready"; hits: RecallHitLine[] } | { state: "missing" };

/** 187 号票之前的检索：现取完整返回，按行认出命中（读全文的标记旧记录不另算） */
function LegacyHits({ callId }: { callId: string }) {
  const { http } = useStore();
  const [got, setGot] = useState<{ callId: string; legacy: Legacy }>();
  useEffect(() => {
    const abort = new AbortController();
    const done = (legacy: Legacy) => {
      if (!abort.signal.aborted) setGot({ callId, legacy });
    };
    http.toolCallDetail(callId, abort.signal).then(
      (detail) => done(detail && !detail.purged && !detail.cleared ? { state: "ready", hits: parseLegacyHits(detail.result).map((h) => ({ materialId: h.materialId, how: recallHowLabel(h), readFull: false })) } : { state: "missing" }),
      () => done({ state: "missing" }),
    );
    return () => abort.abort();
  }, [http, callId]);
  const legacy = got && got.callId === callId ? got.legacy : { state: "loading" as const };
  if (legacy.state === "loading") return <div className="muted rc-none">{t("ui.recallDetail.legacyLoading")}</div>;
  if (legacy.state === "missing") return <div className="muted rc-none">{t("ui.recallDetail.legacyMissing")}</div>;
  return <HitList hits={legacy.hits} />;
}

type Loaded = { kind: "view"; view: MaterialDetailView } | { kind: "missing" } | { kind: "failed"; message: string };

/** 找到的一条：每次打开现取原文和时间（不缓存：忘掉、彻底删除之后再打开就是"已删除"） */
function RecallHitCard({ hit }: { hit: RecallHitLine }) {
  const { http, ui } = useStore();
  // 取到的时候记下"现在"（相对说法按它算；渲染时不取时间）
  const [got, setGot] = useState<{ id: string; loaded: Loaded; now: number }>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    http.material(hit.materialId, abort.signal).then(
      (view) => {
        if (!abort.signal.aborted) setGot({ id: hit.materialId, loaded: view ? { kind: "view", view } : { kind: "missing" }, now: Date.now() });
      },
      (err: unknown) => {
        if (!abort.signal.aborted) setGot({ id: hit.materialId, loaded: { kind: "failed", message: err instanceof Error ? err.message : String(err) }, now: Date.now() });
      },
    );
    return () => abort.abort();
  }, [http, hit.materialId]);
  const loaded = got?.id === hit.materialId ? got.loaded : undefined;
  const now = got?.now ?? 0;
  if (!loaded) return <div className="rc-hit muted">{t("ui.recallDetail.loading")}</div>;
  if (loaded.kind === "missing") return <div className="rc-hit rc-gone">{t("ui.recallDetail.gone")}</div>;
  if (loaded.kind === "failed") return <div className="rc-hit muted">{t("ui.recallDetail.failed", { reason: loaded.message })}</div>;
  const m = recallMaterial(ui, loaded.view, now);
  const where = m.conversation ?? m.taskId ?? m.projectId;
  return (
    <div className="rc-hit">
      <div className="rc-cap">{m.own ? t("ui.recallDetail.own") : t("ui.recallDetail.desc")}</div>
      <div className={`rc-quote${m.own ? "" : " rc-desc"}`}>
        {open ? m.text : m.head}
        {m.more && (
          <button type="button" className="link-btn rc-more" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? t("ui.recallDetail.collapse") : t("ui.recallDetail.expand")}
          </button>
        )}
      </div>
      <div className="rc-meta">
        <span className="rc-when" title={m.at}>
          {m.at}
          {m.ago ? ` · ${m.ago}` : ""}
        </span>
        {where !== undefined && (
          <span className="rc-where">
            <NamedText text={m.conversation !== undefined ? conversationName(ui, m.conversation) : readableId(ui, where)} />
          </span>
        )}
        {m.jump && (
          <a className="link rc-jump" href={toHash(inboxJumpRoute(m.jump))}>
            {t("ui.recallDetail.viewOriginal")}
          </a>
        )}
      </div>
      <div className="chips">
        <span className="chip">{m.kind}</span>
        {hit.how && <span className="chip chip-quiet">{hit.how}</span>}
        {hit.readFull && <span className="chip chip-ok">{t("ui.recallDetail.readFull")}</span>}
      </div>
    </div>
  );
}
