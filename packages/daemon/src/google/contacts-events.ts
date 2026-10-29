// Google · 联系人的事件（301 号票）：和日历一样在守护进程内部的频道 google 上（前端不订阅；数据源页经 HTTP 取，候选核对卡是档案那一侧的）。
// - google_contact：导入的 vCard 里要交给档案候选的一个人（contact-offers.ts 整理过的：称呼、昵称、是不是用户自己、和我的关系、这次新的
//   几个字段）——只记以前没交过的（同一个人同一个字段同一个值交过就不再记，所以同一份再导一次什么都不写）；
// - google_contacts_offered：这几个人交给了档案候选（一批，最多 10 个人）、合进了哪张候选核对卡。还没交的就是排着的下一批，
//   那张卡处理完了（不再是待处理）接着交。
// 数据源"Google · 联系人"拥有这两类（断开并删已导入的时整条换成"已删除"标记；档案候选里从它来的由个人档案登记的删除参与方删）。
// 不进记忆素材（通讯录只进档案候选，号码、住址本来就不进整理）。
import { isDeletedEventPayload } from "@ergo/protocol";
import type { EventStore } from "../events/event-store.ts";
import { GOOGLE_CHANNEL } from "./events.ts";

export const GOOGLE_CONTACT = "google_contact";
export const GOOGLE_CONTACTS_OFFERED = "google_contacts_offered";

export interface GoogleContactPayload {
  id: string;
  at: string;
  /** 从哪个文件来的（用户放进来时的文件名） */
  file: string;
  /** 认同一个人（本人是 "me"，别人是称呼） */
  key: string;
  name: string;
  aliases: string[];
  self?: true;
  relation?: string;
  fields: Array<{ field: string; value: string; also?: string[] }>;
}

export interface GoogleContactsOfferedPayload {
  at: string;
  ids: string[];
  /** 合进的候选核对卡（都和档案里一样、没有要核对的时没有） */
  cardId?: string;
}

/** 还在的（没被换成"已删除"标记的）某一类事件的负载，按先后 */
export function liveContactPayloads<T>(store: Pick<EventStore, "read">, type: typeof GOOGLE_CONTACT | typeof GOOGLE_CONTACTS_OFFERED): T[] {
  return store
    .read(GOOGLE_CHANNEL, 0, type)
    .filter((e) => !isDeletedEventPayload(e.payload))
    .map((e) => e.payload as T);
}
