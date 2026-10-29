// Google · 联系人的服务（301 号票）：导入文件夹交来的 vCard → 解析（vcard.ts）→ 整理出要进档案候选的人（contact-offers.ts）→
// 只记以前没交过的（contacts-events.ts）→ 一批一批交给个人档案的候选、当场合成候选核对卡（和 299 号票手机通讯录选人同一条路：
// KERNEL.personalFiles 的 addCandidates / composeCandidates，来源写 vcard、数据源写 google-contacts）。
// - 同一份再导一次不重复出候选：同一个人同一个字段同一个值交过就不再交（不管用户在卡上写了、没写还是还没处理）；换了新号码、新生日的
//   才再交，卡上写着档案里原来的值。断开并删已导入的以后记录没了，再导就是从头来；
// - 一批最多 CONTACTS_BATCH 个人：一张卡上太多核对不过来（卡上"写进档案"最多带 100 条）。排着的等这一批合进的那张卡处理完
//   （不再是待处理：写了、都不用、作废了）接着交下一批；插件停着时处理的，启用时补上；
// - 档案那一侧（认人、规范化值、和档案里一样的不提、拒过的不再提、电话逐位核对）都在个人档案的候选里，这里不管。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { type Card, SELF_PERSON_ID, t } from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import type { DataSourceImportContext, DataSourceSyncResult, ImportFile } from "../data-sources/api.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { CandidateInput, PersonalFilesForMemory } from "../personal-files/index.ts";
import { type ContactOffer, offersFromContacts } from "./contact-offers.ts";
import { GOOGLE_CONTACT, GOOGLE_CONTACTS_OFFERED, type GoogleContactPayload, type GoogleContactsOfferedPayload, liveContactPayloads } from "./contacts-events.ts";
import { GOOGLE_CHANNEL } from "./events.ts";
import { parseVcards } from "./vcard.ts";

/** 这个数据源的 id（定了别改：用法开关、同步记录、档案候选的数据源都按它记） */
export const GOOGLE_CONTACTS_SOURCE = "google-contacts";
/** 一张候选核对卡最多交几个人（一个人最多建档、电话、生日、住址、关系、别名、几个纪念日七八条，十个人不到一百条） */
export const CONTACTS_BATCH = 10;
/** vCard 最大多少（MB）：Google 导出的照片是网址，几千人也就几 MB；别的导出可能把照片编进去 */
export const VCARD_MAX_MB = 32;

export interface GoogleContactsOptions {
  store: EventStore;
  now: () => string;
  /** 个人档案：我的名字、档案里的人（认用户自己那张、认已有的人），收候选、合成候选核对卡（内核的 KERNEL.personalFiles） */
  personalFiles: Pick<PersonalFilesForMemory, "people" | "addCandidates" | "composeCandidates">;
  /** 卡片（看上一批合进的那张处理了没有） */
  cards: Pick<CardService, "get">;
  log: (line: string) => void;
}

export interface GoogleContactsService {
  /** 导入一个 vCard（导入文件夹交来的，已经挪进"已导入"）；读不出联系人的抛错（文件留在导入文件夹） */
  importFile(file: ImportFile, ctx: DataSourceImportContext): Promise<DataSourceSyncResult>;
  /** 交过（和排着的）几个人：数据源页的"共几条" */
  count(): number;
  /** 上一批的卡处理完了就交下一批（插件起来时、卡片变了时叫） */
  offerNext(): void;
  /** 一张卡片变了（事件存储里追加的 card 事件）：是上一批合进的那张、处理完了，就交下一批 */
  onCard(card: Card): void;
}

interface OfferOutcome {
  /** 这次交了几个人 */
  offered: number;
  cardId?: string;
  /** 上一批的卡还没处理完，这次没交 */
  waiting: boolean;
}

/** 交给档案候选的样子 */
function inputOf(p: GoogleContactPayload): CandidateInput {
  return {
    name: p.self ? SELF_PERSON_ID : p.name,
    aliases: p.aliases,
    ...(p.relation === undefined ? {} : { relation: p.relation }),
    materialIds: [],
    heard: [],
    fields: p.fields,
    dataSource: GOOGLE_CONTACTS_SOURCE,
  };
}

const fieldKey = (f: { field: string; value: string }) => `${f.field}\u0000${f.value}`;

/** 只留以前没交过的：同一个人（key）以前记过的字段值、关系去掉；什么新的都没有是 undefined */
const freshOf = (o: ContactOffer, before: readonly GoogleContactPayload[]): ContactOffer | undefined => {
  const seen = new Set(before.flatMap((p) => p.fields.map(fieldKey)));
  const fields = o.fields.filter((f) => !seen.has(fieldKey(f)));
  const relation = o.relation !== undefined && !before.some((p) => p.relation === o.relation) ? o.relation : undefined;
  if (before.length > 0 && fields.length === 0 && relation === undefined) return undefined;
  const { relation: _relation, ...rest } = o;
  return { ...rest, fields, ...(relation === undefined ? {} : { relation }) };
};

/** 导入结果那一句（数据源页"上次导入"那一行）：几人进候选、这次上卡几个 / 等上一张、之前导过的、没进候选的 */
const summaryOf = (counts: { people: number; skipped: number; repeated: number }, outcome: OfferOutcome, left: number): string => {
  const parts: string[] = [];
  if (counts.people === 0) parts.push(t("google.contacts.result.nothing"));
  else if (outcome.waiting) parts.push(t("google.contacts.result.people", { count: counts.people }), t("google.contacts.result.waiting"));
  else if (outcome.cardId === undefined && left === 0) parts.push(t("google.contacts.result.same", { count: counts.people }));
  else parts.push(t("google.contacts.result.people", { count: counts.people }), ...(left > 0 ? [t("google.contacts.result.batched", { count: outcome.offered })] : []));
  if (counts.repeated > 0) parts.push(t("google.contacts.result.repeated", { count: counts.repeated }));
  if (counts.skipped > 0) parts.push(t("google.contacts.result.skipped", { count: counts.skipped }));
  return parts.join(t("google.contacts.result.sep"));
};

export function createGoogleContacts(options: GoogleContactsOptions): GoogleContactsService {
  const { store, now, personalFiles, cards, log } = options;
  const contacts = () => liveContactPayloads<GoogleContactPayload>(store, GOOGLE_CONTACT);
  const batches = () => liveContactPayloads<GoogleContactsOfferedPayload>(store, GOOGLE_CONTACTS_OFFERED);

  /** 上一批合进的那张卡（还没处理完时） */
  const openCard = (): string | undefined => {
    const cardId = batches()
      .toReversed()
      .find((b) => b.cardId !== undefined)?.cardId;
    return cardId !== undefined && cards.get(cardId)?.status === "pending" ? cardId : undefined;
  };

  /** 排着的（记下了、还没交给档案候选的），按先后 */
  const queued = (): GoogleContactPayload[] => {
    const offered = new Set(batches().flatMap((b) => b.ids));
    return contacts().filter((c) => !offered.has(c.id));
  };

  const offer = (): OfferOutcome => {
    if (openCard() !== undefined) return { offered: 0, waiting: queued().length > 0 };
    let offered = 0;
    // 交了一批却没有要核对的（都和档案里一样）：接着交下一批，直到出了卡或者交完
    for (let batch = queued().slice(0, CONTACTS_BATCH); batch.length > 0; batch = queued().slice(0, CONTACTS_BATCH)) {
      personalFiles.addCandidates("vcard", batch.map(inputOf));
      const cardId = personalFiles.composeCandidates();
      store.append({ channel: GOOGLE_CHANNEL, type: GOOGLE_CONTACTS_OFFERED, payload: { at: now(), ids: batch.map((c) => c.id), ...(cardId === undefined ? {} : { cardId }) } satisfies GoogleContactsOfferedPayload });
      offered += batch.length;
      if (cardId !== undefined) {
        log(`Google 联系人：交给档案候选 ${batch.length} 人，候选核对卡 ${cardId}`);
        return { offered, cardId, waiting: false };
      }
    }
    return { offered, waiting: false };
  };

  return {
    async importFile(file) {
      if (file.size > VCARD_MAX_MB * 1024 * 1024) throw new Error(t("google.contacts.error.tooBig", { mb: VCARD_MAX_MB }));
      const parsed = parseVcards(await fs.promises.readFile(file.path));
      if (parsed.length === 0) throw new Error(t("google.contacts.error.empty"));
      const people = personalFiles.people();
      const selfName = people.find((p) => p.kind === "self")?.name;
      const known = new Set(people.filter((p) => p.kind === "person").flatMap((p) => [...(p.name === undefined ? [] : [p.name]), ...p.aliases]));
      const { offers, skipped } = offersFromContacts(parsed, { ...(selfName === undefined ? {} : { selfName }), known: (name) => known.has(name) });
      const before = new Map<string, GoogleContactPayload[]>();
      for (const c of contacts()) before.set(c.key, [...(before.get(c.key) ?? []), c]);
      const at = now();
      let repeated = 0;
      const records: NewEvent[] = [];
      for (const o of offers) {
        const fresh = freshOf(o, before.get(o.key) ?? []);
        if (!fresh) {
          repeated += 1;
          continue;
        }
        const payload: GoogleContactPayload = {
          id: `gc-${randomUUID().slice(0, 8)}`,
          at,
          file: file.name,
          key: fresh.key,
          name: fresh.name,
          aliases: [...fresh.aliases],
          ...(fresh.self ? { self: true as const } : {}),
          ...(fresh.relation === undefined ? {} : { relation: fresh.relation }),
          fields: fresh.fields.map((f) => ({ field: f.field, value: f.value, ...(f.also === undefined ? {} : { also: [...f.also] }) })),
        };
        records.push({ channel: GOOGLE_CHANNEL, type: GOOGLE_CONTACT, payload });
      }
      if (records.length > 0) store.appendBatch(records);
      const outcome = records.length > 0 ? offer() : { offered: 0, waiting: false };
      const left = queued().length;
      log(`Google 联系人：${file.name} 里 ${parsed.length} 张卡片，新进候选 ${records.length} 人（这次交 ${outcome.offered}、排着 ${left}），之前交过 ${repeated}，没进候选 ${skipped}`);
      return { added: records.length, summary: summaryOf({ people: records.length, skipped, repeated }, outcome, left) };
    },
    count: () => new Set(contacts().map((c) => c.key)).size,
    offerNext() {
      if (queued().length > 0) offer();
    },
    onCard(card) {
      if (card.type !== "personal_file_suggest" || card.status === "pending") return;
      const last = batches()
        .toReversed()
        .find((b) => b.cardId !== undefined);
      if (last?.cardId === card.id && queued().length > 0) offer();
    },
  };
}
