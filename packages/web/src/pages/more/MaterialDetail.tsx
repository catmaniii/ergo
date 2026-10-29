// 记忆 · 素材里点开的一条（158 号票原来在设置 · 删除素材里；167 号票起 #/more/memory/materials/<素材 id>，成批删除里点开的是
// #/more/memory/materials-delete/<素材 id>）：每次打开现取（GET /api/materials/<素材 id>），不缓存。
// - 头上：种类 · 说或做 · 来源等级，标记的小签（不参与推断、在废弃分支里、项目内部的记录），"跳到这条消息 ›"（出处的消息还在当前分支上才有，
//   去哪个页面和待办的"去看看 ›"同一个认法，到了会话里定位到那一条，在更早的历史里就往前取几页）；
// - 内容：一段一块，标明来源和形态。本人的话全文（太长的在框里滚动）；引用块写原文；附件、语音照会话里的样子画（图片点开放大、
//   文件卡片能预览下载、语音条点一下播放、下面是识别出的文字）；只记了引用的写引用的说明；你存的网页（165 号票）写标题、网址（点了在
//   "浏览"或新窗口里打开）和存下的正文（外部数据，太长的在框里滚动），截断了写明；
// - 来源：时间、会话、任务、项目、出处的消息现在怎样、卡片、记录、原文副本、原始事件、情境；
// - 删除：忘掉、彻底删除、别推断，确认框和口径同成批删除（同一个接口，范围是"这一条"）；忘掉、彻底删除之后回到列表，
//   别推断之后留在这里、标记跟着变。
// 怎么画在状态层（state/materials.ts），这里只管画；详情的排版借详情栏的那几样（dt-section、dt-doc、dt-kv）。
import { Fragment, useCallback, useEffect, useState } from "react";
import { inboxJumpRoute, type Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import {
  conversationName,
  type MaterialBlock,
  materialBlocks,
  materialDeleteChoices,
  type MaterialDetailView,
  materialFacts,
  materialJump,
  materialMarkChips,
  MEMORY_DELETE_MODE_INFO,
  type MemoryDeleteMode,
  t,
  tTable,
} from "../../state/index.ts";
import { NamedText } from "../../ui/assistant-name.tsx";
import { Sheet } from "../../ui/common.tsx";
import { PartView } from "../../ui/conversation/parts.tsx";
import { TranscribedVoiceBubble } from "../../ui/conversation/VoiceBubble.tsx";
import { Section } from "../../ui/detail/section.tsx";
import { useToast } from "../../ui/toast.tsx";

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
export function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 确认框的标题、确认按钮（171 号票：英文按删法各写一句，中文和原来拼出来的"<删法>这条素材？""确认<删法>"一样；确认按钮成批删除也用） */
const CONFIRM_TITLE: Readonly<Record<MemoryDeleteMode, string>> = tTable({
  forget: "pages.materialDetail.confirmTitle.forget",
  purge: "pages.materialDetail.confirmTitle.purge",
  no_infer: "pages.materialDetail.confirmTitle.noInfer",
});
export const CONFIRM_BUTTON: Readonly<Record<MemoryDeleteMode, string>> = tTable({
  forget: "pages.materialDetail.confirmButton.forget",
  purge: "pages.materialDetail.confirmButton.purge",
  no_infer: "pages.materialDetail.confirmButton.noInfer",
});
/** 忘掉、彻底删除之后的提示（"已<删法>这条素材"） */
const DONE_TOAST: Readonly<Record<Exclude<MemoryDeleteMode, "no_infer">, string>> = tTable({
  forget: "pages.materialDetail.done.forget",
  purge: "pages.materialDetail.done.purge",
});

type Loaded = { kind: "view"; view: MaterialDetailView } | { kind: "missing" } | { kind: "failed"; message: string };

/** onDeleted：忘掉、彻底删除之后（回到列表）；onChanged：别推断之后（列表上的标记跟着变） */
export function MaterialDetail({ id, navigate, onDeleted, onChanged }: { id: string; navigate: Navigate; onDeleted(): void; onChanged(): void }) {
  const { http, ui } = useStore();
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded>();
  const load = useCallback(
    (signal?: AbortSignal) => {
      http.material(id, signal).then(
        (view) => setLoaded(view ? { kind: "view", view } : { kind: "missing" }),
        (err: unknown) => {
          if (!signal?.aborted) setLoaded({ kind: "failed", message: errorText(err) });
        },
      );
    },
    [http, id],
  );
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal);
    return () => abort.abort();
  }, [load]);
  /** 确认框开着时：哪种删法、这次确认的幂等键 */
  const [confirming, setConfirming] = useState<{ mode: MemoryDeleteMode; key: string }>();
  const [busy, setBusy] = useState(false);

  if (!loaded) return <div className="muted">{t("pages.materialDetail.loading")}</div>;
  if (loaded.kind === "missing") return <div className="page-placeholder">{t("pages.materialDetail.missing")}</div>;
  if (loaded.kind === "failed") return <div className="hint">{t("pages.materialDetail.loadFailed", { reason: loaded.message })}</div>;
  const { view } = loaded;
  const facts = materialFacts(view);
  const chips = materialMarkChips(view.marks);
  const jump = materialJump(ui, view);

  const run = (mode: MemoryDeleteMode, key: string) => {
    setBusy(true);
    http
      .deleteMaterials({ kind: "material", materialId: view.id }, mode, key)
      .then(({ count }) => {
        setConfirming(undefined);
        if (count === 0) {
          toast(t("pages.materialDetail.gone"));
          onDeleted();
        } else if (mode === "no_infer") {
          toast(t("pages.materialDetail.markedNoInfer"));
          load();
          onChanged();
        } else {
          toast(DONE_TOAST[mode]);
          onDeleted();
        }
      })
      .catch((err: unknown) => toast(t("pages.materialDetail.deleteFailed", { reason: errorText(err) })))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mat-detail">
      <div className="dt-title">{facts.head}</div>
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((c) => (
            <span key={c} className="chip chip-quiet">
              {c}
            </span>
          ))}
        </div>
      )}
      {jump && (
        <div className="mat-actions">
          <button type="button" className="btn ghost" onClick={() => navigate(inboxJumpRoute(jump))}>
            {t("pages.materialDetail.jump")}
          </button>
        </div>
      )}
      <Section title={t("pages.materialDetail.content")}>
        {view.segments.length === 0 ? (
          <div className="muted">{t("pages.materialDetail.noContent")}</div>
        ) : (
          <div className="mat-blocks">
            {materialBlocks(view).map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </div>
        )}
      </Section>
      <Section title={t("pages.materialDetail.source")}>
        <dl className="dt-kv">
          {facts.rows.map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.mono ? "mono" : undefined}>{row.conversation ? <NamedText text={conversationName(ui, row.value)} /> : row.value}</dd>
            </Fragment>
          ))}
        </dl>
      </Section>
      <Section title={t("pages.materialDetail.deleteSection")}>
        <div className="mat-delete">
          {materialDeleteChoices(view).map((choice) => (
            <button
              key={choice.mode}
              type="button"
              className={`btn ${choice.mode === "purge" ? "danger" : choice.mode === "forget" ? "primary" : "ghost"}`}
              disabled={choice.disabled !== undefined}
              title={choice.disabled}
              onClick={() => setConfirming({ mode: choice.mode, key: newKey() })}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <div className="muted dt-note">{t("pages.materialDetail.deleteNote")}</div>
      </Section>
      {confirming && (
        <Sheet title={CONFIRM_TITLE[confirming.mode]} onClose={() => setConfirming(undefined)} center>
          <div className="modal-body">
            <p>
              <NamedText text={MEMORY_DELETE_MODE_INFO[confirming.mode].note} />
            </p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirming(undefined)}>
              {t("pages.materialDetail.cancel")}
            </button>
            <button type="button" className={`btn ${confirming.mode === "purge" ? "danger" : "primary"}`} disabled={busy} onClick={() => run(confirming.mode, confirming.key)}>
              {busy ? t("pages.materialDetail.working") : CONFIRM_BUTTON[confirming.mode]}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** 内容里的一段：小标题写来源和形态，下面照会话里的样子画 */
function Block({ block }: { block: MaterialBlock }) {
  return (
    <div className="mat-block">
      <div className="mat-block-title">{block.title}</div>
      <BlockBody block={block} />
    </div>
  );
}

function BlockBody({ block }: { block: MaterialBlock }) {
  switch (block.kind) {
    case "text":
      return <div className="dt-doc mat-text">{block.text}</div>;
    case "quote":
      return <blockquote className="dt-doc mat-text mat-quote">{block.text}</blockquote>;
    case "part":
      return (
        <div className="dt-attachments">
          <PartView part={block.part} />
        </div>
      );
    case "voice":
      return (
        <div className="mat-voice">
          <TranscribedVoiceBubble part={block.part} text={block.text} />
        </div>
      );
    case "page":
      return (
        <div className="mat-saved">
          <a className="mat-saved-title" href={block.url} target="_blank" rel="noopener noreferrer">
            {block.pageTitle}
          </a>
          <div className="mat-ref">{block.url}</div>
          <div className="dt-doc mat-text">{block.text || t("pages.materialDetail.noPageText")}</div>
          {block.note && <div className="muted dt-note">{block.note}</div>}
        </div>
      );
    case "ref":
      return (
        <div className="mat-ref">
          {block.url ? (
            <a href={block.url} target="_blank" rel="noopener noreferrer">
              {block.text}
            </a>
          ) : (
            block.text
          )}
        </div>
      );
  }
}
