// 看素材（158 号票在设置里，167 号票起在"记忆 · 素材"；用户 2026-10-18 要的"删除素材的地方能看每条素材的内容"）：
// - 列表：范围（同设置里删除的范围：全部、一个会话、一个时间段、这一条）里的素材一页一页列出来，新的在前；每条带种类、时间、会话、
//   摘录（同记忆删除卡的摘录）和标记；
// - 一条的完整内容：信封里的都给（种类、说或做、时间、会话、任务、项目、来源等级、情境标签、每一段、原始事件、原文副本），
//   本人的段带全文。素材只记了本人的话，引用块、附件、语音只记了引用和哈希（08 号票）——出处的消息还在时从消息里补上：
//   引用块的原文，附件、语音在消息里的那个 part（界面照会话里的样子画图片、文件、语音条）。出处的消息被彻底删除了的补不上。
// - 标记：说过"别推断"的（21）；在会话回退留下的废弃分支里的（150：查询时现算，切回去就不在了；装配时给 abandoned）；
//   项目内部的记录（64：由系统记下的，删项目时随项目删；装配时给 internal）。出处的消息在废弃分支里时跳不过去（会话里只显示当前分支）。
// - 你存的网页（165："浏览"的 ⋮ 菜单里存进素材的）：素材里网页那一段只记了网址、标题和哈希，存下的正文（外部数据）在原始事件里，
//   事件还在、没被彻底删除时补上（段视图的 saved；browsing/saved-pages.ts 的 savedPageOf，秘书读素材也用它）。
// - 167 号票（记忆 · 素材）：在范围里再筛（filter）——时间段、种类（materials/facets.ts）、来源会话、关键词。关键词用素材库的关键词检索
//   （和秘书的素材检索同一个索引：本人的话、引用的说明、存的网页的正文）；只保管（记忆插件没启用、库里没有新素材）时退回逐条比对同一份文字
//   （每个词都要有、不分大小写，同关键词检索的口径）。搜的时候列表里的摘录换成命中的那一段（存的网页按正文命中的给正文里那一段）。
//   列表新的在前按素材的时间（以前按原始事件倒着排：识别得慢的语音、补回的素材会排错日子，页面按日期分组）。
// 这是内核的（同设置里的批量删除 bulk.ts）：记忆插件停用时照样能看、能删已有的素材。只读。
import {
  INTERVIEW_CONTEXT,
  type MaterialDetailView,
  type MaterialListFilter,
  type MaterialListItem,
  type MaterialListPage,
  type MaterialMarks,
  type MaterialScope,
  type MaterialSegmentView,
  type MessageEnvelope,
  type MessagePart,
  type ProjectInternal,
  t,
} from "@ergo/protocol";
import { savedPageOf } from "../browsing/api.ts";
import { getMessage } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { RequestRejected } from "../errors.ts";
import { excerptOf, type Material, MATERIAL_KIND_LABEL, type Materials, matchesFacets, queryTerms, snippetOf } from "../materials/index.ts";
import { materialsInScope } from "./bulk.ts";

/** 列表的摘录长度（一行半左右） */
const LIST_EXCERPT_CHARS = 80;
/** 一页默认多少条 */
const DEFAULT_LIMIT = 30;
/** 搜的时候摘录（命中的那一段）多长、检索词前面留几个字 */
const HIT_SNIPPET = { chars: LIST_EXCERPT_CHARS, lead: 20 } as const;
/** 关键词检索一次取多少条（这一页要的是范围里全部命中的，再按时间排、分页） */
const KEYWORD_ALL = 1_000_000;

export interface MaterialBrowser {
  /** 范围里的素材（不给范围是全部），再按 filter 筛（167），新的在前（按素材的时间）；offset 从 0 起。时间不对抛 RequestRejected */
  list(scope: MaterialScope | undefined, page: { offset?: number | undefined; limit?: number | undefined }, filter?: MaterialListFilter): MaterialListPage;
  /** 一条素材的完整内容和来源；没有这条（删了）是 undefined */
  detail(id: string): MaterialDetailView | undefined;
}

export interface MaterialBrowserOptions {
  store: EventStore;
  materials: Materials;
  /** 素材在不在废弃分支里（150 号票，conversation/session-branches.ts 的 inAbandonedBranch） */
  abandoned(material: Material): boolean;
  /** 由系统记下的项目内部记录是哪个项目的（64 号票，internal-records.ts 的 internalRecordOf）；不是的为 undefined */
  internal(material: Material): ProjectInternal | undefined;
}

export function createMaterialBrowser(options: MaterialBrowserOptions): MaterialBrowser {
  const { store, materials } = options;

  const marksOf = (m: Material, abandoned = options.abandoned(m)): MaterialMarks => {
    const internal = options.internal(m);
    return {
      ...(m.noInfer ? { noInfer: true as const } : {}),
      ...(abandoned ? { abandoned: true as const } : {}),
      ...(internal ? { internal } : {}),
      // 284 号票：了解你访谈里说的（情境标签 interview）
      ...(m.context.includes(INTERVIEW_CONTEXT) ? { interview: true as const } : {}),
    };
  };

  /** 搜的那份文字：同关键词索引（本人的话、引用的说明），存的网页再接上存下的正文 */
  const searchableText = (m: Material): string =>
    [searchTextOf(m), savedPageOf(store, m)?.text].filter((text): text is string => text !== undefined && text.length > 0).join("\n");

  const itemOf = (m: Material, query: string | undefined): MaterialListItem => ({
    id: m.id,
    kind: MATERIAL_KIND_LABEL[m.kind],
    time: m.time,
    ...(m.conversation === null ? {} : { conversation: m.conversation }),
    excerpt: query === undefined ? excerptOf(m, LIST_EXCERPT_CHARS) : snippetOf(searchableText(m), query, HIT_SNIPPET),
    marks: marksOf(m),
  });

  /** 关键词命中的：采成素材时用关键词检索（索引）；只保管时逐条比对同一份文字 */
  const keywordFilter = (query: string): ((m: Material) => boolean) => {
    if (materials.collecting()) {
      const ids = new Set(materials.searchKeyword(query, { limit: KEYWORD_ALL }).map((m) => m.id));
      return (m) => ids.has(m.id);
    }
    const terms = queryTerms(query).map((term) => term.toLowerCase());
    return (m) => {
      const text = searchableText(m).toLowerCase();
      return terms.every((term) => text.includes(term));
    };
  };

  return {
    list(scope, page, filter = {}) {
      const query = filter.query?.trim() || undefined;
      const from = filter.from === undefined ? -Infinity : timeOf(filter.from);
      const to = filter.to === undefined ? Infinity : timeOf(filter.to);
      if (from > to) throw new RequestRejected("bad_params", t("memory.range.reversed"));
      const hit = query === undefined ? () => true : keywordFilter(query);
      const found = materialsInScope(materials, scope)
        .map((m, order) => ({ m, order, time: Date.parse(m.time) }))
        .filter(({ m, time }) => time >= from && time <= to && (filter.conversation === undefined || m.conversation === filter.conversation) && matchesFacets(m, filter.facets) && hit(m))
        // 新的在前：按素材的时间，同一时刻按原始事件倒着
        .toSorted((a, b) => b.time - a.time || b.order - a.order)
        .map(({ m }) => m);
      const offset = page.offset ?? 0;
      const limit = page.limit ?? DEFAULT_LIMIT;
      return { total: found.length, items: found.slice(offset, offset + limit).map((m) => itemOf(m, query)) };
    },
    detail(id) {
      const m = materials.get(id);
      if (!m) return undefined;
      const abandoned = options.abandoned(m);
      const { messageId, cardId, recordId } = m.ref;
      const message = messageId === undefined ? undefined : liveMessage(store, messageId);
      const state = message === undefined ? "gone" : abandoned ? "abandoned" : "shown";
      const saved = savedPageOf(store, m);
      return {
        id: m.id,
        kind: MATERIAL_KIND_LABEL[m.kind],
        mode: m.mode,
        time: m.time,
        ...(m.conversation === null ? {} : { conversation: m.conversation }),
        ...(m.task === null ? {} : { taskId: m.task }),
        ...(m.project === null ? {} : { projectId: m.project }),
        source: m.source,
        context: m.context,
        segments: m.segments.map((s) => segmentView(s, message, saved)),
        event: { channel: m.ref.event.channel, seq: m.ref.event.seq, type: m.ref.event.type },
        ...(messageId === undefined ? {} : { message: { id: messageId, state } }),
        ...(cardId === undefined ? {} : { cardId }),
        ...(recordId === undefined ? {} : { recordId }),
        ...(m.original ? { original: m.original.path } : {}),
        marks: marksOf(m, abandoned),
      };
    },
  };
}

/** 筛选里的时间（带时区的 ISO）→ 毫秒；写法不对抛 RequestRejected */
function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RequestRejected("bad_params", t("memory.range.bad"));
  return ms;
}

/** 关键词索引里的那份文字（memory-db.ts 的 searchTextOf，不含采集规则另给的外部正文）：本人的话、引用的说明 */
function searchTextOf(m: Material): string {
  return m.segments
    .map((s) => (s.source === "self" ? s.text : s.label))
    .filter((text): text is string => text !== undefined && text.length > 0)
    .join("\n");
}

/** 出处的消息（会话消息视图里的：彻底删除改写成标记的不在视图里）；被彻底删除了、随项目删了的没有 */
function liveMessage(store: EventStore, messageId: string): MessageEnvelope | undefined {
  return getMessage(store.reader, messageId);
}

/** 一段：信封里的（不含位置），出处的消息还在时补上引用块的原文、附件和语音在消息里的 part；你存的网页补上存下的正文（165） */
function segmentView(s: Material["segments"][number], message: MessageEnvelope | undefined, saved?: MaterialSegmentView["saved"]): MaterialSegmentView {
  const view: MaterialSegmentView = {
    form: s.form,
    source: s.source,
    notes: s.notes,
    ...(s.sha256 === undefined ? {} : { sha256: s.sha256 }),
    ...(s.text === undefined ? {} : { text: s.text }),
    ...(s.label === undefined ? {} : { label: s.label }),
    ...(s.media === undefined ? {} : { media: s.media }),
    ...(s.url === undefined ? {} : { url: s.url }),
    ...(s.cardId === undefined ? {} : { cardId: s.cardId }),
  };
  if (s.form === "web_page" && saved) return { ...view, saved };
  if (!message) return view;
  const { part: index, start, end } = s.locator;
  const at = index === undefined ? undefined : message.parts[index];
  if (s.form === "quote" && at?.type === "text" && start !== undefined && end !== undefined) return { ...view, quoted: at.text.slice(start, end) };
  if (s.form === "attachment" && at && isAttachment(at) && at.mediaId === s.media?.mediaId) return { ...view, part: at };
  // 语音素材由语音对象产生（位置是语音的第 0 段，不是消息的 part），按录音的媒体 id 在消息里找
  if (s.form === "voice" && s.media) {
    const voice = message.parts.find((p) => p.type === "voice" && p.mediaId === s.media!.mediaId);
    if (voice) return { ...view, part: voice };
  }
  return view;
}

const isAttachment = (part: MessagePart): part is Extract<MessagePart, { type: "image" | "file" | "video" }> => part.type === "image" || part.type === "file" || part.type === "video";
