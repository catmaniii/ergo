// 记忆 · 素材（167 号票，#/more/memory/materials）：素材的查看和管理中心。
// - 按时间范围浏览，默认近 7 天：快捷选项今天、近 7 天、近 30 天、自定义（起止日期），外加往前一段、往后一段；列表按日期分组（今天、昨天、
//   10 月 17 日 周六……），新的在前；一段里太多时照 158 号票分批取（一次 30 条，"再显示"）；
// - 搜：顶上的搜索框按关键词搜（守护进程的素材关键词检索，166 号票后存的网页按正文也搜得到），范围照旧生效，范围那里能一键换成全部时间；
//   摘录是命中的那一段，命中的字标出来；
// - 筛：按种类（说过的话、做过的、附件、语音、存的网页、记忆命令，可以选几种）、按会话（秘书主线、任务和项目的维护者，159/163 号票的名字）；
// - 点开一条：158 号票的素材详情（MaterialDetail.tsx，#/more/memory/materials/<素材 id>），单条忘掉、彻底删除、别推断；
// - 成批删除在顶栏（MemoryPage.tsx 放的按钮，进 #/more/memory/materials-delete，原来设置里的那一整套）。
// 范围、搜的字、筛选、已取的列表和滚动位置在列表和详情之间一直留着；范围和筛选另记在模块变量里，跳去出处的消息再回来也还在
// （只记在这次打开的网页里，刷新回默认）。推导都在状态层（state/material-browse.ts）。记忆插件没启用时顶上写明，已有的照样能看能删。
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import {
  canShiftMaterialRangeLater,
  conversationName,
  customMaterialRange,
  DEFAULT_MATERIAL_RANGE_PRESET,
  highlightParts,
  MATERIAL_FACET_HINT,
  MATERIAL_FACET_LABEL,
  MATERIAL_FACETS,
  MATERIAL_LIST_MAX,
  MATERIAL_QUERY_MAX,
  MATERIAL_RANGE_PRESET_LABEL,
  MATERIAL_RANGE_PRESETS,
  materialClock,
  materialConversationChoices,
  materialDayGroups,
  type MaterialFacet,
  type MaterialListItem,
  materialListFilter,
  materialMarkChips,
  type MaterialRange,
  materialRangeLabel,
  materialRangePreset,
  type MaterialRangePreset,
  type MaterialScopeSummary,
  presetMaterialRange,
  shiftMaterialRange,
  t,
} from "../../state/index.ts";
import { NamedText, useNamedPlain } from "../../ui/assistant-name.tsx";
import { Segmented } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";
import { MaterialDetail } from "../../pages/more/MaterialDetail.tsx";

/** 列表一次取多少条 */
const LIST_PAGE = 30;
/** 打字停多久才搜 */
const SEARCH_DELAY_MS = 300;
/** 页面的滚动区（记忆页一栏的 .scroll） */
const SCROLLER = ".scroll";

type RangeChoice = MaterialRangePreset | "custom";

/** 上次的范围、搜的字和筛选（跳到出处的消息再回来，这一页重新打开时还是它；只记在这次打开的网页里） */
interface Choice {
  range: MaterialRange;
  query: string;
  facets: MaterialFacet[];
  conversation: string | undefined;
}
let remembered: Choice | undefined;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** sub：点开的那条素材；onOpen 点开一条，onClose 回到列表（忘掉、彻底删除之后） */
export function MaterialsBrowse({ sub, onOpen, onClose, navigate }: { sub?: string | undefined; onOpen(id: string): void; onClose(): void; navigate: Navigate }) {
  const { http, ui } = useStore();
  const toast = useToast();
  const plain = useNamedPlain();
  // 打开页面的这一刻：今天、近 7 天按它算
  const [now] = useState(() => new Date());
  const [range, setRange] = useState<MaterialRange>(() => remembered?.range ?? presetMaterialRange(DEFAULT_MATERIAL_RANGE_PRESET, now));
  const [query, setQuery] = useState(() => remembered?.query ?? "");
  const [facets, setFacets] = useState<MaterialFacet[]>(() => remembered?.facets ?? []);
  const [conversation, setConversation] = useState<string | undefined>(() => remembered?.conversation);
  useEffect(() => {
    remembered = { range, query, facets, conversation };
  }, [range, query, facets, conversation]);
  /** 自定义时两个日期框里的（可能一时不成范围：起点晚于终点） */
  const [customDraft, setCustomDraft] = useState<{ from: string; to: string }>(() => (range.kind === "all" ? { from: "", to: "" } : { from: range.from, to: range.to }));

  // 打字停一会儿才搜
  const [searched, setSearched] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const [refresh, setRefresh] = useState(0);
  /** 有素材的会话（下拉框）、记忆插件开没开；删过之后重新取 */
  const [summary, setSummary] = useState<MaterialScopeSummary & { refresh: number }>();
  useEffect(() => {
    let live = true;
    http
      .materialScope()
      .then((s) => live && setSummary({ ...s, refresh }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [http, refresh]);

  const filter = useMemo(() => materialListFilter({ range, query: searched, facets, conversation }), [range, searched, facets, conversation]);
  const filterKey = `${JSON.stringify(filter)}#${refresh}`;

  // 换了范围、搜的字、筛选，删过之后从头取；同样的筛选删过之后取回的条数不少于原来手里的（返回列表时还在原处）
  const [list, setList] = useState<{ key: string; filter: string; items: MaterialListItem[]; total: number }>();
  const [listFailed, setListFailed] = useState<string>();
  const shown = useRef({ filter: "", count: 0 });
  useEffect(() => {
    shown.current = { filter: list?.filter ?? "", count: list?.items.length ?? 0 };
  });
  useEffect(() => {
    let live = true;
    const filterText = JSON.stringify(filter);
    const keep = shown.current.filter === filterText ? shown.current.count : 0;
    http
      .materialList(undefined, { offset: 0, limit: Math.min(Math.max(LIST_PAGE, keep), MATERIAL_LIST_MAX) }, filter)
      .then((page) => {
        if (!live) return;
        setList({ key: filterKey, filter: filterText, ...page });
        setListFailed(undefined);
      })
      .catch((err: unknown) => {
        if (live) setListFailed(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [http, filter, filterKey]);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = () => {
    if (!list) return;
    const key = list.key;
    setLoadingMore(true);
    http
      .materialList(undefined, { offset: list.items.length, limit: LIST_PAGE }, filter)
      .then((page) => setList((cur) => (cur?.key === key ? { ...cur, items: [...cur.items, ...page.items], total: page.total } : cur)))
      .catch((err: unknown) => toast(t("pages.materials.loadFailed", { reason: errorText(err) })))
      .finally(() => setLoadingMore(false));
  };

  // 进详情时记下列表滚到哪，详情从顶上看；返回列表时滚回原处
  const rootRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const open = (id: string) => {
    listScroll.current = rootRef.current?.closest<HTMLElement>(SCROLLER)?.scrollTop ?? 0;
    onOpen(id);
  };
  const opened = sub !== undefined;
  useLayoutEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>(SCROLLER);
    if (scroller) scroller.scrollTop = opened ? 0 : listScroll.current;
  }, [opened, rootRef, listScroll]);

  if (sub) {
    return (
      <div ref={rootRef} className="mat-page">
        <MaterialDetail
          key={sub}
          id={sub}
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

  const preset = materialRangePreset(range, now);
  const pickPreset = (choice: RangeChoice) => {
    if (choice === "custom") {
      const base = range.kind === "all" ? presetMaterialRange(DEFAULT_MATERIAL_RANGE_PRESET, now) : range;
      if (base.kind === "all") return;
      setCustomDraft({ from: base.from, to: base.to });
      setRange({ kind: "custom", from: base.from, to: base.to });
    } else setRange(presetMaterialRange(choice, now));
  };
  const editCustom = (next: { from: string; to: string }) => {
    setCustomDraft(next);
    const r = customMaterialRange(next.from, next.to);
    if (r) setRange(r);
  };
  const shift = (dir: -1 | 1) => {
    const next = shiftMaterialRange(range, dir);
    setRange(next);
    if (next.kind === "custom") setCustomDraft({ from: next.from, to: next.to });
  };
  const toggleFacet = (f: MaterialFacet) => setFacets((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : MATERIAL_FACETS.filter((x) => x === f || cur.includes(x))));
  const customInvalid = range.kind === "custom" && customMaterialRange(customDraft.from, customDraft.to) === undefined;

  const items = list?.key === filterKey ? list.items : (list?.items ?? []);
  const total = list?.key === filterKey ? list.total : undefined;
  const groups = materialDayGroups(items, now);
  const choices = materialConversationChoices(summary?.conversations ?? []);
  const narrowed = facets.length > 0 || conversation !== undefined;
  const all = range.kind === "all";
  const countText =
    total === undefined
      ? t("pages.materials.loading")
      : searched
        ? t(all ? "pages.materials.foundAllTime" : "pages.materials.foundInRange", { count: total })
        : t(all ? "pages.materials.countAllTime" : "pages.materials.countInRange", { count: total });

  return (
    <div ref={rootRef} className="mat-browse">
      {summary?.keepingOnly && <div className="hint">{t("pages.materials.keepingOnly")}</div>}
      <div className="mat-search">
        <input
          className="input"
          type="search"
          value={query}
          maxLength={MATERIAL_QUERY_MAX}
          placeholder={t("pages.materials.searchPlaceholder")}
          aria-label={t("pages.materials.search")}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="mat-range">
        <Segmented<RangeChoice | "">
          value={preset ?? ""}
          role="radio"
          label={t("pages.materials.range")}
          onChange={(v) => v !== "" && pickPreset(v)}
          options={[...MATERIAL_RANGE_PRESETS.map((p) => ({ value: p as RangeChoice, label: MATERIAL_RANGE_PRESET_LABEL[p] })), { value: "custom" as const, label: t("pages.materials.custom") }]}
        />
        {range.kind === "custom" && (
          <div className="usage-range">
            <input className="input" type="date" value={customDraft.from} max={customDraft.to || undefined} onChange={(e) => editCustom({ ...customDraft, from: e.target.value })} aria-label={t("pages.materials.from")} />
            <span className="muted">{t("pages.materials.to")}</span>
            <input className="input" type="date" value={customDraft.to} min={customDraft.from || undefined} onChange={(e) => editCustom({ ...customDraft, to: e.target.value })} aria-label={t("pages.materials.until")} />
          </div>
        )}
        {customInvalid && <div className="hint">{t("pages.materials.badRange")}</div>}
        <div className="mat-range-nav">
          <button type="button" className="btn ghost small" disabled={range.kind === "all"} onClick={() => shift(-1)}>
            {t("pages.materials.earlier")}
          </button>
          <span className="mat-range-label">{materialRangeLabel(range, now)}</span>
          <button type="button" className="btn ghost small" disabled={!canShiftMaterialRangeLater(range, now)} onClick={() => shift(1)}>
            {t("pages.materials.later")}
          </button>
        </div>
        {searched && range.kind !== "all" && (
          <button type="button" className="btn ghost small mat-all-time" onClick={() => setRange({ kind: "all" })}>
            {t("pages.materials.searchAllTime")}
          </button>
        )}
      </div>
      <div className="mat-filters">
        <div className="mat-facets" role="group" aria-label={t("pages.materials.byKind")}>
          {MATERIAL_FACETS.map((f) => {
            const on = facets.includes(f);
            return (
              <button key={f} type="button" className={`mat-facet${on ? " on" : ""}`} aria-pressed={on} title={plain(MATERIAL_FACET_HINT[f])} onClick={() => toggleFacet(f)}>
                {MATERIAL_FACET_LABEL[f]}
              </button>
            );
          })}
        </div>
        <label className="mat-conv">
          <span className="muted">{t("pages.materials.conversation")}</span>
          <select className="input" value={conversation ?? ""} onChange={(e) => setConversation(e.target.value || undefined)}>
            <option value="">{t("pages.materials.allConversations")}</option>
            {choices.map((c) => (
              <option key={c.conversation} value={c.conversation}>
                {t("pages.materials.conversationOption", { name: plain(conversationName(ui, c.conversation)), count: c.count })}
              </option>
            ))}
            {conversation !== undefined && !choices.some((c) => c.conversation === conversation) && <option value={conversation}>{plain(conversationName(ui, conversation))}</option>}
          </select>
        </label>
      </div>
      <div className="mat-count">
        <span className="muted">{countText}</span>
        {narrowed && (
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              setFacets([]);
              setConversation(undefined);
            }}
          >
            {t("pages.materials.clearFilters")}
          </button>
        )}
      </div>
      {listFailed && <div className="hint">{t("pages.materials.loadFailed", { reason: listFailed })}</div>}
      {list && items.length === 0 && total !== undefined && (
        <div className="muted mat-empty">{searched ? t("pages.materials.noResults") : narrowed ? t("pages.materials.noneFiltered") : t("pages.materials.noneInRange")}</div>
      )}
      {groups.map((g) => (
        <section key={g.date} className="mat-day" aria-label={g.label}>
          <div className="mat-day-head">{g.label}</div>
          <div className="prompt-rows">
            {g.items.map((it) => (
              <MaterialRowButton key={it.id} item={it} query={searched} showConversation={conversation === undefined} onOpen={() => open(it.id)} />
            ))}
          </div>
        </section>
      ))}
      {total !== undefined && items.length < total && (
        <button type="button" className="btn ghost" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t("pages.materials.loading") : t("pages.materials.showMore", { count: Math.min(LIST_PAGE, total - items.length), rest: total - items.length })}
        </button>
      )}
    </div>
  );
}

/** 列表里的一行：种类 · 几点几分 · 会话（按会话筛的时候不写），标记的小签；摘录（搜的时候是命中的那一段，命中的字标出来） */
function MaterialRowButton({ item, query, showConversation, onOpen }: { item: MaterialListItem; query: string; showConversation: boolean; onOpen(): void }) {
  const { ui } = useStore();
  const chips = materialMarkChips(item.marks);
  return (
    <button type="button" className="prompt-row mat-row" onClick={onOpen}>
      <span className="prompt-row-text">
        <span className="mat-row-title">
          <span>
            {item.kind} · {materialClock(item.time)}
            {showConversation && item.conversation !== undefined && (
              <span className="mat-row-conv">
                {" · "}
                <NamedText text={conversationName(ui, item.conversation)} />
              </span>
            )}
          </span>
          {chips.map((c) => (
            <span key={c} className="chip chip-quiet">
              {c}
            </span>
          ))}
        </span>
        <small className="mat-row-excerpt">
          {item.excerpt ? (
            highlightParts(item.excerpt, query).map((p, i) => <Fragment key={i}>{p.hit ? <mark className="mat-hit">{p.text}</mark> : p.text}</Fragment>)
          ) : (
            t("pages.materials.noText")
          )}
        </small>
      </span>
      <span className="muted">›</span>
    </button>
  );
}
