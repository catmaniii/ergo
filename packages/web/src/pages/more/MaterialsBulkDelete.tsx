// 记忆 · 素材的成批删除（167 号票起在这里：素材页顶栏的"成批删除"进来，#/more/memory/materials-delete；原来是设置 · 删除素材，
// 这一整套原样挪过来，删的语义、确认、删不掉的说明一字不改）。
// 21 号票：按会话或按时间段删。三种删法：忘掉（默认）、彻底删除、别推断。
// 范围里有几条素材、有素材的会话都问守护进程（HTTP）；确认后对范围内的全部素材执行，同一次确认重发只执行一次。
// 彻底删除另外连带范围里没有素材的语音（没识别出文字的，31 号票）：它们的消息和录音一起删，范围里只有它们时也能删。
// 158 号票：下面列出范围里的素材（新的在前，一次 30 条，"再显示"接着取），点一条进下一级（167 号票起 #/more/memory/materials-delete/<素材 id>）看完整内容和来源、
// 跳到出处的那条消息、单独删这一条（MaterialDetail.tsx）。选的范围、删法和列表在这一页一直留着：进详情再返回还在原处；
// 跳到出处的消息再回来（这一页重新打开）范围和删法也还是上次选的（只记在这次打开的网页里，刷新回到默认）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import {
  CHANNELS,
  conversationName,
  conversationPhrase,
  MATERIAL_LIST_MAX,
  type MaterialListItem,
  materialRow,
  type MaterialScope,
  MEMORY_COMMAND_LABEL,
  MEMORY_DELETE_MODE_INFO,
  MEMORY_DELETE_MODES,
  type MemoryDeleteMode,
  t,
  tTable,
} from "../../state/index.ts";
import { nowIso } from "../../util/time.ts";
import { useToast } from "../../ui/toast.tsx";
import { AssistantName, NamedText, useNamedPlain } from "../../ui/assistant-name.tsx";
import { Section, Segmented, Sheet } from "../../ui/common.tsx";
import { CONFIRM_BUTTON, MaterialDetail, newKey } from "./MaterialDetail.tsx";
import { T } from "../../ui/i18n.tsx";

type By = "session" | "range";

/** 列表一次取多少条 */
const LIST_PAGE = 30;

/** datetime-local 的值（本地时间，到分钟）→ 协议的时间；"到"取那一分钟的最后一刻，两头都算 */
function rangeIso(value: string, end: boolean): string {
  const ms = new Date(value).getTime();
  return nowIso(new Date(end ? ms + 59_999 : ms));
}

/** 上次选的范围和删法（158：跳到出处的消息再回来，这一页重新打开时还是它；只记在这次打开的网页里） */
interface Choice {
  by: By;
  conversation: string;
  from: string;
  to: string;
  mode: MemoryDeleteMode;
}
let remembered: Choice | undefined;

/** 确认框的标题（171 号票：英文按删法各写一句，中文和原来拼出来的"<删法>：<范围>？"一样） */
const CONFIRM_TITLE: Readonly<Record<MemoryDeleteMode, string>> = {
  forget: "pages.materialsDelete.confirmTitle.forget",
  purge: "pages.materialsDelete.confirmTitle.purge",
  no_infer: "pages.materialsDelete.confirmTitle.noInfer",
};

/** 按会话、按时间段 */
const BY_LABEL: Readonly<Record<By, string>> = tTable({ session: "pages.materialsDelete.bySession", range: "pages.materialsDelete.byRange" });

/** 页面的滚动区（设置子页的 .scroll） */
const SCROLLER = ".scroll";

/** item：点开的那条素材（#/more/memory/materials-delete/<素材 id>）；onOpen 点开一条，onClose 回到列表 */
export function MaterialsBulkDelete({ item, onOpen, onClose, navigate }: { item?: string | undefined; onOpen(id: string): void; onClose(): void; navigate: Navigate }) {
  const toast = useToast();
  const { http, ui } = useStore();
  const plain = useNamedPlain();
  const [by, setBy] = useState<By>(() => remembered?.by ?? "session");
  const [conversation, setConversation] = useState<string>(() => remembered?.conversation ?? CHANNELS.secretary);
  const [from, setFrom] = useState(() => remembered?.from ?? nowIso(new Date(Date.now() - 7 * 86_400_000)).slice(0, 16));
  const [to, setTo] = useState(() => remembered?.to ?? nowIso().slice(0, 16));
  const [mode, setMode] = useState<MemoryDeleteMode>(() => remembered?.mode ?? "forget");
  useEffect(() => {
    remembered = { by, conversation, from, to, mode };
  }, [by, conversation, from, to, mode]);
  /** 守护进程数出来的：哪个范围（scopeKey）里有几条，有素材的会话 */
  const [summary, setSummary] = useState<{ key: string; count: number; conversations: Array<{ conversation: string; count: number }>; voices?: number }>();
  /** 确认框开着时带着这次确认的幂等键 */
  const [confirming, setConfirming] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const scope = useMemo<MaterialScope | undefined>(() => {
    if (by === "session") return { kind: "conversation", conversation };
    if (!from || !to) return undefined;
    return { kind: "time_range", from: rangeIso(from, false), to: rangeIso(to, true) };
  }, [by, conversation, from, to]);

  // 有素材的会话（下拉框），以及范围里有几条；删过之后（refresh）重新数
  const scopeKey = `${JSON.stringify(scope ?? null)}#${refresh}`;
  useEffect(() => {
    let live = true;
    http
      .materialScope(scope)
      .then((s) => {
        if (live) setSummary({ key: scopeKey, ...s });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [http, scope, scopeKey]);

  // 范围里的素材（158）：换了范围、删过之后从头取；同一个范围删过之后取回的条数不少于原来手里的（返回列表时还在原处）
  const [list, setList] = useState<{ key: string; scope: string; items: MaterialListItem[]; total: number }>();
  const [listFailed, setListFailed] = useState<string>();
  const shown = useRef({ scope: "", count: 0 });
  useEffect(() => {
    shown.current = { scope: list?.scope ?? "", count: list?.items.length ?? 0 };
  });
  useEffect(() => {
    let live = true;
    const scopeText = JSON.stringify(scope ?? null);
    const keep = shown.current.scope === scopeText ? shown.current.count : 0;
    http
      .materialList(scope, { offset: 0, limit: Math.min(Math.max(LIST_PAGE, keep), MATERIAL_LIST_MAX) })
      .then((page) => {
        if (!live) return;
        setList({ key: scopeKey, scope: scopeText, ...page });
        setListFailed(undefined);
      })
      .catch((err: unknown) => {
        if (live) setListFailed(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [http, scope, scopeKey]);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = () => {
    if (!list) return;
    const key = list.key;
    setLoadingMore(true);
    http
      .materialList(scope, { offset: list.items.length, limit: LIST_PAGE })
      .then((page) => setList((cur) => (cur?.key === key ? { ...cur, items: [...cur.items, ...page.items], total: page.total } : cur)))
      .catch((err: unknown) => toast(t("pages.materials.loadFailed", { reason: err instanceof Error ? err.message : String(err) })))
      .finally(() => setLoadingMore(false));
  };

  // 进详情时记下列表滚到哪，详情从顶上看；返回列表时滚回原处
  const rootRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const open = (id: string) => {
    listScroll.current = rootRef.current?.closest<HTMLElement>(SCROLLER)?.scrollTop ?? 0;
    onOpen(id);
  };
  const opened = item !== undefined;
  useLayoutEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>(SCROLLER);
    if (scroller) scroller.scrollTop = opened ? 0 : listScroll.current;
  }, [opened, rootRef, listScroll]);

  const count = summary?.key === scopeKey ? summary.count : undefined;
  /** 范围里没有素材的语音（没识别出文字的）：只有彻底删除管它们 */
  const voices = mode === "purge" && summary?.key === scopeKey ? (summary.voices ?? 0) : 0;
  const voicesText = voices > 0 ? t("pages.materialsDelete.voicesExtra", { count: voices }) : "";
  const conversations = summary?.conversations ?? [];

  const choices = conversations.some((c) => c.conversation === CHANNELS.secretary) ? conversations : [{ conversation: CHANNELS.secretary, count: 0 }, ...conversations];
  const scopeText = by === "session" ? conversationPhrase(ui, conversation) : t("pages.materialsDelete.rangeText", { from: from.replace("T", " "), to: to.replace("T", " ") });
  const label = MEMORY_COMMAND_LABEL[mode];

  const run = (key: string) => {
    if (!scope) return;
    setBusy(true);
    http
      .deleteMaterials(scope, mode, key)
      .then(({ count: done }) => {
        setConfirming(undefined);
        // 没识别出文字的语音只有彻底删除才算进来（voices 只在彻底删除时不是 0）
        toast(
          mode === "no_infer"
            ? t("pages.materialsDelete.doneNoInfer", { count: done })
            : mode === "forget"
              ? t("pages.materialsDelete.doneForget", { count: done })
              : t("pages.materialsDelete.donePurge", { count: done }) + (voices > 0 ? t("pages.materialsDelete.doneVoices", { count: voices }) : ""),
        );
        setRefresh((n) => n + 1);
      })
      .catch((err: unknown) => toast(t("pages.materialDetail.deleteFailed", { reason: err instanceof Error ? err.message : String(err) })))
      .finally(() => setBusy(false));
  };

  if (item) {
    return (
      <div ref={rootRef} className="mat-page">
        <MaterialDetail
          key={item}
          id={item}
          navigate={navigate}
          onChanged={() => setRefresh((n) => n + 1)}
          onDeleted={() => {
            setRefresh((n) => n + 1);
            onClose();
          }}
        />
      </div>
    );
  }

  const items = list?.key === scopeKey ? list.items : (list?.items ?? []);
  const total = list?.total;
  return (
    <div ref={rootRef} className="mat-page">
      <div className="muted">
        <T k="pages.materialsDelete.intro" params={{ name: <AssistantName /> }} />
      </div>
      <Segmented<By>
        value={by}
        onChange={setBy}
        options={[
          { value: "session", label: BY_LABEL.session },
          { value: "range", label: BY_LABEL.range },
        ]}
      />
      <Section title={t("pages.materialsDelete.scope")}>
        {by === "session" ? (
          <label className="field">
            <span>{t("pages.materials.conversation")}</span>
            <select value={conversation} onChange={(e) => setConversation(e.target.value)}>
              {choices.map((c) => (
                <option key={c.conversation} value={c.conversation}>
                  {t("pages.materials.conversationOption", { name: plain(conversationName(ui, c.conversation)), count: c.count })}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="range-row">
            <label className="field">
              <span>{t("pages.materialsDelete.from")}</span>
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>{t("pages.materialsDelete.to")}</span>
              <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        )}
      </Section>
      <Section title={t("pages.materialsDelete.mode")}>
        {MEMORY_DELETE_MODES.map((m) => (
          <label key={m} className="check-row radio-row">
            <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <b>{MEMORY_COMMAND_LABEL[m]}</b>
              {m === "forget" && <span className="muted">{t("pages.materialsDelete.default")}</span>}
              <div className="muted">
                <NamedText text={MEMORY_DELETE_MODE_INFO[m].note} />
              </div>
            </span>
          </label>
        ))}
      </Section>
      <div className="add-row">
        <span className="muted">
          {count === undefined
            ? t("pages.materialsDelete.counting")
            : t("pages.materialsDelete.scopeCount", { count }) + voicesText}
        </span>
        <button type="button" className={`btn ${mode === "purge" ? "danger" : "primary"}`} disabled={!count && voices === 0} onClick={() => setConfirming(newKey())}>
          {label}
        </button>
      </div>
      <Section title={t("pages.materialsDelete.listTitle")} extra={<span className="muted mat-list-note">{t("pages.materialsDelete.listNote")}</span>}>
        {listFailed && <div className="hint">{t("pages.materials.loadFailed", { reason: listFailed })}</div>}
        {!list && !listFailed && <div className="muted">{t("pages.materials.loading")}</div>}
        {list && items.length === 0 && <div className="muted">{t("pages.materialsDelete.empty")}</div>}
        {items.length > 0 && (
          <div className="prompt-rows">
            {items.map((it) => {
              const row = materialRow(it);
              return (
                <button key={row.id} type="button" className="prompt-row mat-row" onClick={() => open(row.id)}>
                  <span className="prompt-row-text">
                    <span className="mat-row-title">
                      <span>
                        {row.title}
                        {by === "range" && row.conversation !== undefined && (
                          <>
                            {" · "}
                            <NamedText text={conversationName(ui, row.conversation)} />
                          </>
                        )}
                      </span>
                      {row.chips.map((c) => (
                        <span key={c} className="chip chip-quiet">
                          {c}
                        </span>
                      ))}
                    </span>
                    <small className="mat-row-excerpt">{row.excerpt}</small>
                  </span>
                  <span className="muted">›</span>
                </button>
              );
            })}
          </div>
        )}
        {total !== undefined && items.length < total && (
          <button type="button" className="btn ghost" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? t("pages.materials.loading") : t("pages.materials.showMore", { count: Math.min(LIST_PAGE, total - items.length), rest: total - items.length })}
          </button>
        )}
      </Section>
      {confirming !== undefined && (
        <Sheet title={<NamedText text={t(CONFIRM_TITLE[mode], { scope: scopeText })} />} onClose={() => setConfirming(undefined)} center>
          <div className="modal-body">
            <p>
              {t("pages.materialsDelete.scopeCount", { count: count ?? 0 }) + voicesText + t("pages.materialsDelete.sentenceEnd")}
              <NamedText text={MEMORY_DELETE_MODE_INFO[mode].note} />
            </p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirming(undefined)}>
              {t("pages.materialDetail.cancel")}
            </button>
            <button type="button" className={`btn ${mode === "purge" ? "danger" : "primary"}`} disabled={busy} onClick={() => run(confirming)}>
              {busy ? t("pages.materialDetail.working") : CONFIRM_BUTTON[mode]}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
