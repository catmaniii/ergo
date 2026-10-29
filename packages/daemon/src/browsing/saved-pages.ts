// 存进二狗的素材（165 号票）："浏览"的 ⋮ 菜单里点"存进二狗的素材"，二狗的网页取这一页的正文（页面桥取整页文字的那条路，
// 最多 BROWSER_PAGE_TEXT_MAX 字）交过来，存成素材频道上的一条 web_page_saved 事件（标题、地址、正文、截没截、原文一共多少字）：
// - 素材（内核登记的来源，daemon.ts 里和别的 materials.register 放一起）：一条"用户主动投喂的材料"——存是用户做的，信封来源本人，
//   情境标签 saved_web_page（设置里写成"你存的网页"）；网页那一段是外部、不可信的，只记网址、标题（引用的说明，进关键词索引）
//   和正文的哈希。正文是网页上的外部数据，不进切段、不进原文副本（推断不拿它当用户的话），存着的只有这条事件；
//   166 号票（用户 2026-10-19 定，规格第 15 节的例外：用户主动存的）：正文进检索的索引（MaterialDraft.indexText：关键词全文、
//   向量算开头），秘书按正文检索得到；检索结果里的那一段、读素材给的全文都从这条事件里取（savedPageOf），夹在外部数据标记里
//   （memory/search-tool.ts）；设置里点开这条素材时同样从事件里补上给用户看（memory/browse.ts）；
// - 请求带幂等键：同一个请求重发只存一次，回第一次的结果；回的素材 id 按事件算（materialId），记忆插件没开、素材库只保管时也是它；
// - 彻底删除：改写函数把事件里的标题、地址、正文换成删除标记，编号、时间、截没截、字数不变（daemon.ts 登记进改写函数表）。
import { randomUUID } from "node:crypto";
import {
  EVENT_TYPES,
  isDeletedEventPayload,
  type MaterialSegmentView,
  nowIso,
  PURGED_TEXT,
  SAVED_WEB_PAGE_CONTEXT,
  type SaveWebPageBody,
  type SaveWebPageResult,
  type WebPageSavedEventPayload,
} from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { PurgeRewriter } from "../events/purge.ts";
import { type Material, MATERIALS_CHANNEL, materialId, type MaterialSource, segmentPieces } from "../materials/index.ts";

/** 素材来源的名字（素材 id 由它和事件算出来，定了就别改） */
export const WEB_PAGE_SAVED_SOURCE = "web-page-saved";

/** 幂等键在事件存储里的写法（和别的接口的键分开） */
const saveKey = (idempotencyKey: string) => `web-page-saved:${idempotencyKey}`;

/** 存下的一页：采成一条用户主动投喂的材料，正文只进检索的索引（166）；彻底删除改写过的（标题、地址换成了删除标记）不再采 */
export const webPageSavedSource: MaterialSource = {
  name: WEB_PAGE_SAVED_SOURCE,
  eventType: EVENT_TYPES.webPageSaved,
  capture(event) {
    const p = event.payload as Partial<WebPageSavedEventPayload>;
    if (typeof p.id !== "string" || typeof p.url !== "string" || p.url === PURGED_TEXT) return [];
    return [
      {
        kind: "fed_material",
        source: "self",
        ...(typeof p.time === "string" ? { time: p.time } : {}),
        context: [SAVED_WEB_PAGE_CONTEXT],
        segments: segmentPieces([
          { form: "web_page", url: p.url, ...(typeof p.text === "string" ? { text: p.text } : {}), ...(typeof p.title === "string" ? { title: p.title } : {}), locator: { field: "text" } },
        ]),
        ref: { recordId: p.id },
        ...(typeof p.text === "string" && p.text.trim() !== "" ? { indexText: p.text } : {}),
      },
    ];
  },
};

/** 存下的那一页（标题、正文、截没截、原文一共多少字） */
export type SavedPage = NonNullable<MaterialSegmentView["saved"]>;

/**
 * 素材是存下的网页时，从它的原始事件里取存下的标题、正文：事件还在、对得上、没被彻底删除改写过才有。
 * 设置里点开这条（memory/browse.ts）、秘书检索和读素材（166，memory/search-tool.ts）都用它
 */
export function savedPageOf(store: Pick<EventStore, "eventAt">, m: Material): SavedPage | undefined {
  const { channel, seq, type } = m.ref.event;
  if (type !== EVENT_TYPES.webPageSaved) return undefined;
  const event = store.eventAt(channel, seq);
  if (!event || event.type !== type || isDeletedEventPayload(event.payload)) return undefined;
  const p = event.payload as WebPageSavedEventPayload;
  if (p.id !== m.ref.recordId || p.text === PURGED_TEXT || p.url === PURGED_TEXT) return undefined;
  return { title: p.title, text: p.text, truncated: p.truncated, total: p.total };
}

/** 彻底删除：标题、地址、正文换成删除标记，别的不变 */
export const webPageSavedPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.webPageSaved,
  rewrite(event) {
    const p = event.payload as WebPageSavedEventPayload;
    return { ...p, title: PURGED_TEXT, url: PURGED_TEXT, text: PURGED_TEXT } satisfies WebPageSavedEventPayload;
  },
};

/** 存好了的结果：这一页的编号、它采成的素材 id（按事件算，记忆插件没开时也是它） */
function resultOf(event: StoredEvent): SaveWebPageResult {
  return { id: (event.payload as WebPageSavedEventPayload).id, materialId: materialId(event, WEB_PAGE_SAVED_SOURCE, 0) };
}

export interface SavedPages {
  /** 存一页（请求体已按 SaveWebPageBody 核对过）；同一个幂等键重发回第一次的结果 */
  save(body: SaveWebPageBody): SaveWebPageResult;
}

export interface SavedPagesOptions {
  store: EventStore;
  /** 现在（协议时间；测试给固定的） */
  now?: () => string;
  /** 这一页的编号（测试给固定的） */
  newId?: () => string;
}

export function createSavedPages(options: SavedPagesOptions): SavedPages {
  const { store } = options;
  const now = options.now ?? nowIso;
  const newId = options.newId ?? (() => `wp-${randomUUID()}`);
  return {
    save(body) {
      const key = saveKey(body.idempotencyKey);
      const done = store.eventByIdempotencyKey(key);
      if (done) return resultOf(done);
      const payload: WebPageSavedEventPayload = { id: newId(), time: now(), title: body.title, url: body.url, text: body.text, truncated: body.truncated, total: body.total };
      return resultOf(store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.webPageSaved, payload, idempotencyKey: key }).event);
    },
  };
}
