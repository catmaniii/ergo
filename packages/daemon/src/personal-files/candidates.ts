// 个人档案的候选（283 号票，用户 2026-10-25 定）：记忆管理员把白天听到的、关于某个人的固定信息（"小张换工作了""表弟叫小张"）攒成候选；
// 还没有档案、提到够几次的人提议建档；候选第二天早上合成一张核对卡（卡片类型 personal_file_suggest）给用户逐条确认，不每句话打断。
// 推断出来的东西永远只当候选：用户在卡上勾了才写进档案（留痕：经记忆管理员提议、你在卡上确认），没勾的记成"没写"，同样的不再提。
// - 谁交候选：每晚整理（记忆插件，memory/personal-files-link.ts）、284 号票的访谈（记忆管理员）——都交 CandidateInput，带出处的素材和日子；
// - 认人：说的是用户自己的对到本人那份；按称呼、别名对到已有的档案；都对不上的按称呼（和别名）当一个还没档案的人（personKey "n:<称呼>"）；
// - 只收能写成"字段：值"的那几样（和我的关系、别名、生日、单位或学校、过敏和用药）；号码类、住址不收（那些只经秘书的核对卡、逐位核对）；
//   值和档案里现在的一样的不收；同一个人同一字段来了新的，旧的作废；
// - 一天一张卡：还没处理的那张接着往里加（新版本），处理了的下一次另起一张；卡进待我处理（不卡事）；
// - 283 时秘书直接写进档案的生日、纪念日问一句要不要每年提醒也用这张卡（一条 reminder，origin secretary）；302 号票起直接写的按默认
//   直接建每年提醒、不再出这张，以前出的照样能点；
// - 出处的话被忘掉、彻底删除了：只靠那几条素材的候选作废，彻底删除的连候选里的值、卡上的值一起改写（memory_command 订阅）。
// 299 号票：用户在手机上的二狗 App 里从通讯录挑的人（origin contacts，"手机"插件经 KERNEL.personalFiles 交来）——是用户自己挑的，
// 不用提到几次就上卡（拒过建档的也再提一次），电话、住址也收（号码在卡上逐位核对），值按档案的规矩规范化；候选记着从哪个数据源来
// （dataSource），断开那个数据源并删已导入的时，还没写进档案的候选连卡上的值一起彻底删除（registerCandidateDeletion）。
// 301 号票：用户放进导入文件夹的通讯录 vCard（origin vcard，Google 插件解析后经 KERNEL.personalFiles 交来）走同一条路——也是用户自己交来的：
// 不用提到几次就上卡、电话住址也收、值按档案的规矩规范化、记着数据源；另外收关系、别名、纪念日（vCard 里有）；和 contacts 不同的是
// 拒过的（建档、同一个值）不再提（同一份通讯录再导一次不该再问一遍）。一个人有几个电话、住址时交来的字段带 also（别的几个）：
// 档案里现在的值是其中之一就不提这个字段（不拿通讯录里的第二个号码去换档案里的那个）。
import { randomUUID } from "node:crypto";
import {
  ANNUAL_REMINDER_DEFAULT_DAYS,
  anniversaryNameOf,
  checkPersonalValue,
  isAnnualField,
  isNumberField,
  type MemoryCommandEventPayload,
  monthDayOf,
  type PersonalFileKind,
  type PersonalFileSuggestCardPayload,
  PersonalFileSuggestCardPayload as SuggestPayloadSchema,
  PersonalFileSuggestInput,
  type PersonalFileSuggestItem,
  type PersonalSuggestOrigin,
  personalFieldLabel,
  personalFieldOf,
  PURGED_TEXT,
  SELF_PERSON_ID,
  t,
  Type,
  withheldFromModel,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import { DATA_SOURCE_DELETION, type DeletionParticipants, liveEvents } from "../deletion/participants.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { personalFileEvent, PERSONAL_FILE_EVENT, PERSONAL_FILES_CHANNEL, type PersonalFileChange, type PersonalFileTrail } from "./events.ts";
import type { PersonalFileWrite, PersonRef } from "./personal-files.ts";
import { candidatesOf, type StoredCandidate } from "./view.ts";

/** 还没有档案的人，提到几次才提议建档（用户 2026-10-25 的"提到够几次"；拿不准，先定 3 次，见票的 Comments） */
export const NEW_PERSON_MIN_MENTIONS = 3;

/** 候选能写的字段（个人档案的字段编号）：和我的关系、别名、生日、单位或学校和职位、过敏和用药 */
export const CANDIDATE_FIELDS: readonly string[] = ["relation", "aliases", "birthday", "work", "health"];

/** 从通讯录挑的人（299 号票）能写的字段：电话、生日、住址（通讯录里只取这几样） */
export const CONTACT_FIELDS: readonly string[] = ["phone", "birthday", "address"];

/** 导入的通讯录 vCard（301 号票）能写的字段：电话、生日、住址、和我的关系、别名，另外每一个纪念日（"anniversary:<名字>"） */
export const VCARD_FIELDS: readonly string[] = ["phone", "birthday", "address", "relation", "aliases"];

/** 这个来源能写这个字段吗 */
function fieldAllowed(origin: PersonalSuggestOrigin, field: string): boolean {
  if (origin === "vcard") return VCARD_FIELDS.includes(field) || anniversaryNameOf(field) !== undefined;
  return (origin === "contacts" ? CONTACT_FIELDS : CANDIDATE_FIELDS).includes(field);
}

/** 用户自己交来的（299 通讯录挑的、301 导入的 vCard）：不用提到几次就上卡，电话、住址也收，值按档案的规矩规范化 */
const userProvided = (origin: string) => origin === "contacts" || origin === "vcard";

/** 说的是用户自己 */
// @i18n-ignore-next data：认记忆那一侧交来的中文"我"
const SELF_NAMES = new Set(["我", "我自己", "本人", "用户", SELF_PERSON_ID]);

/** 别名一格里几个别名之间的分隔（同 personal-files.ts） */
// @i18n-ignore-next data：认用户写的中文标点
const ALIAS_SEPARATORS = /[、，,/／\s]+/;

/** 记忆那一侧交来的一个人：每晚整理认出来的、访谈里听到的 */
export interface CandidateInput {
  /** 怎么称呼（说的是用户自己写"我"） */
  name: string;
  aliases?: readonly string[];
  /** 和用户的关系（原话里明说了的） */
  relation?: string;
  /** 从哪几条素材听到的（数提到了几次、出处被删了跟着作废） */
  materialIds: readonly string[];
  /** 哪几天说的（本地日期） */
  heard: readonly string[];
  /**
   * 固定信息：字段（编号或名字）、照抄的值。also 是同一个人这个字段的别的几个值（301：通讯录里的第二个电话、住址）——
   * 档案里现在的值是其中之一就不提这个字段
   */
  fields: ReadonlyArray<{ field: string; value: string; also?: readonly string[] }>;
  /** 从哪个数据源来的（299 号票：通讯录选人是 phone-contacts）：断开它并删已导入的时，还没写进档案的跟着删 */
  dataSource?: string;
}

/** 候选这块用到的档案服务的几样（建在服务里面，免得互相引用） */
export interface CandidateFiles {
  find(name: string): PersonRef | undefined;
  kindOf(personId: string): PersonalFileKind | undefined;
  currentValue(personId: string, field: string): string | undefined;
  /** 这个字段开着每年提醒没有 */
  hasReminder(personId: string, field: string): boolean;
  /** 提醒插件在不在（不在就不给每年提醒的勾） */
  remindersOn(): boolean;
  prepareWrite(write: PersonalFileWrite): { events: NewEvent[]; personId: string; afterCommit?: () => void; changed: string[] };
  today(): string;
}

export interface CandidatesOptions {
  store: EventStore;
  cards: CardService;
  inbox: Pick<InboxService, "buildAdd">;
  files: CandidateFiles;
  /** 彻底删除候选的值（出处的话被彻底删除了）：改写候选事件和卡片的每个版本 */
  purge(targets: readonly StoredEvent[]): void;
  log: (line: string) => void;
}

export interface PersonalFileCandidates {
  /** 收下记忆那一侧交来的候选；返回新收了几条（同样的、不用的不算） */
  add(origin: PersonalSuggestOrigin, inputs: readonly CandidateInput[]): number;
  /**
   * 把攒着的候选合成核对卡：还没处理的那张接着往里加，没有就另起一张（进待我处理）；没有能上卡的是 undefined。
   * date 是卡上写的日子（每晚整理写那一夜，访谈写今天）
   */
  compose(options?: { date?: string }): string | undefined;
  /** 出处的素材被忘掉、彻底删除了（memory_command）：只靠它们的候选作废，彻底删除的连值一起改写 */
  onMaterialsDeleted(materialIds: readonly string[], mode: "forget" | "purge" | "no_infer"): void;
}

/** 卡片类型 personal_file_suggest 的定义（组合根登记） */
export type SuggestCardType = ReturnType<typeof defineSuggestCardType>;

const newCandidateId = () => `pc-${randomUUID().slice(0, 8)}`;

/** 按档案的规矩规范化以后的样子（比 also 里的值用；不合规的原样） */
function normalizedAs(field: string, raw: string): string {
  const checked = checkPersonalValue(field, raw);
  return checked.ok ? checked.value : raw.trim();
}
const createItemId = (personKey: string) => `new:${personKey}`;
const union = <T>(lists: ReadonlyArray<readonly T[]>): T[] => [...new Set(lists.flat())];

/** 卡上一条的纯文本 */
function itemText(item: PersonalFileSuggestItem): string {
  if (item.kind === "create") {
    if (item.origin === "contacts") return t("personalFiles.suggest.text.createPicked", { name: item.person.name });
    if (item.origin === "vcard") {
      return item.person.relation === undefined
        ? t("personalFiles.suggest.text.createImported", { name: item.person.name })
        : t("personalFiles.suggest.text.createImportedRelation", { name: item.person.name, relation: item.person.relation });
    }
    return item.person.relation === undefined
      ? t("personalFiles.suggest.text.create", { name: item.person.name, count: item.mentions ?? 0 })
      : t("personalFiles.suggest.text.createRelation", { name: item.person.name, relation: item.person.relation, count: item.mentions ?? 0 });
  }
  if (item.kind === "reminder") return t("personalFiles.suggest.text.reminder", { name: item.person.name, label: item.label ?? "", value: item.value ?? "", count: item.remind?.daysBefore ?? 0 });
  return t("personalFiles.suggest.text.field", { name: item.person.name, label: item.label ?? "", value: item.value ?? "" });
}

function cardText(p: PersonalFileSuggestCardPayload): string {
  return [p.title, ...p.items.map((item) => `- ${itemText(item)}`), ...(p.result === undefined ? [] : [p.result])].join("\n");
}

export function createCandidates(options: CandidatesOptions): PersonalFileCandidates {
  const { store, cards, inbox, files, log } = options;
  const reader = store.reader;

  /** 认人：本人、已有的档案、还没档案的（按称呼和别名认同一个） */
  const resolve = (input: CandidateInput): { key: string; personId?: string; kind: PersonalFileKind } => {
    if (SELF_NAMES.has(input.name.trim())) return { key: SELF_PERSON_ID, personId: SELF_PERSON_ID, kind: "self" };
    for (const name of [input.name, ...(input.aliases ?? [])]) {
      const ref = files.find(name);
      if (ref) return { key: ref.id, personId: ref.id, kind: ref.kind };
    }
    const names = new Set([input.name.trim(), ...(input.aliases ?? []).map((a) => a.trim())]);
    const known = candidatesOf(reader).find((c) => c.personId === undefined && c.status !== "dropped" && [c.name, ...c.aliases].some((n) => names.has(n)));
    return { key: known?.personKey ?? `n:${input.name.trim()}`, kind: "person" };
  };

  /** 这个人被拒过建档没有（同一个人不再提） */
  const createRejected = (key: string) => candidatesOf(reader, "rejected").some((c) => c.personKey === key && c.field === undefined);

  const add: PersonalFileCandidates["add"] = (origin, inputs) => {
    const events: NewEvent[] = [];
    let added = 0;
    // 用户自己从通讯录挑的（299）、导入的 vCard（301）：电话、住址也收，值按档案的规矩规范化；挑的人拒过的值再挑一次照样上卡，
    // 导入的拒过的不再提
    const picked = origin === "contacts";
    const provided = userProvided(origin);
    for (const input of inputs) {
      const name = input.name.trim();
      if (name === "" || name === PURGED_TEXT) continue;
      const person = resolve(input);
      // 文件里有的人：已经删了（视图里没了）的当没有
      const personId = person.personId !== undefined && files.kindOf(person.personId) !== undefined ? person.personId : undefined;
      const aliases = (input.aliases ?? []).map((a) => a.trim()).filter((a) => a !== "" && a !== name);
      const relation = input.relation?.trim() || undefined;
      const base = {
        personKey: person.key,
        ...(personId === undefined ? {} : { personId }),
        name: personId === SELF_PERSON_ID ? t("personalFiles.self") : personId !== undefined ? (files.currentValue(personId, "name") ?? name) : name,
        aliases,
        ...(relation === undefined || person.kind === "self" ? {} : { relation }),
        materialIds: [...new Set(input.materialIds)],
        heard: [...new Set(input.heard)].toSorted(),
        origin,
        ...(input.dataSource === undefined ? {} : { dataSource: input.dataSource }),
      };
      const rows = candidatesOf(reader).filter((c) => c.personKey === person.key);
      // 提到一次（数次数、作废用）：同样几条素材的不重复记
      const seenMaterials = new Set(rows.flatMap((c) => c.materialIds));
      if (input.materialIds.some((id) => !seenMaterials.has(id)) || input.materialIds.length === 0) {
        events.push(personalFileEvent({ change: "candidate_added", candidateId: newCandidateId(), ...base }));
      }
      // 固定信息
      const fields = [...input.fields];
      if (relation !== undefined && person.kind === "person" && personId !== undefined) fields.push({ field: "relation", value: relation });
      // 301：导入的通讯录按昵称对上了已有的人，卡片上的称呼也算这个人的别名（档案里叫"老周"、通讯录里叫"周建国"）；档案里现在的称呼不算
      const aliasPool = origin === "vcard" && personId !== undefined ? [name, ...aliases].filter((a) => a !== files.currentValue(personId, "name")) : aliases;
      if (aliasPool.length > 0 && person.kind === "person" && personId !== undefined) fields.push({ field: "aliases", value: aliasPool.join(t("personalFiles.action.sep")) });
      for (const raw of fields) {
        const field = personalFieldOf(person.kind, raw.field);
        if (field === undefined || !fieldAllowed(origin, field) || (person.kind === "self" && (field === "relation" || field === "aliases"))) continue;
        let value = raw.value.trim();
        if (value === "") continue;
        if (provided) {
          const checked = checkPersonalValue(field, value);
          if (!checked.ok) continue;
          value = checked.value;
        } else if (withheldFromModel(field, value) || isNumberField(field, value)) continue;
        // 新建的人的关系在建档那一条上
        if (personId === undefined && field === "relation") continue;
        const current = personId === undefined ? undefined : files.currentValue(personId, field);
        if (field === "aliases" && current !== undefined) {
          const had = current.split(ALIAS_SEPARATORS);
          const extra = value.split(ALIAS_SEPARATORS).filter((a) => a !== "" && !had.includes(a));
          if (extra.length === 0) continue;
          value = [...had, ...extra].join(t("personalFiles.action.sep"));
        }
        if (current === value) continue;
        // 通讯录里这个人这个字段有几个值（几个电话）：档案里现在的是其中之一就不提
        if (current !== undefined && raw.also?.some((other) => normalizedAs(field, other) === current)) continue;
        const sameField = rows.filter((c) => c.field === field);
        if (sameField.some((c) => c.value === value && (c.status === "pending" || (!picked && c.status === "rejected")))) continue;
        const stale = sameField.filter((c) => c.status === "pending").map((c) => c.candidateId);
        if (stale.length > 0) events.push(personalFileEvent({ change: "candidates_resolved", candidateIds: stale, outcome: "dropped" }));
        events.push(personalFileEvent({ change: "candidate_added", candidateId: newCandidateId(), ...base, field, value }));
        added += 1;
      }
    }
    if (events.length > 0) store.appendBatch(events);
    return added;
  };

  /** 一条字段候选上卡的样子 */
  const fieldItem = (c: StoredCandidate, person: PersonalFileSuggestItem["person"], kind: PersonalFileKind): PersonalFileSuggestItem => {
    const field = c.field!;
    const value = c.value!;
    const previous = person.id === undefined ? undefined : files.currentValue(person.id, field);
    const date = isAnnualField(field) && files.remindersOn() && (person.id === undefined || !files.hasReminder(person.id, field)) ? monthDayOf(value) : undefined;
    return {
      id: c.candidateId,
      kind: "field",
      person,
      field,
      label: personalFieldLabel(kind, field),
      value,
      ...(previous === undefined ? {} : { previous }),
      number: isNumberField(field, value),
      ...(date === undefined ? {} : { remind: { ...date, daysBefore: ANNUAL_REMINDER_DEFAULT_DAYS } }),
      heard: c.heard,
      origin: c.origin as PersonalSuggestOrigin,
    };
  };

  /** 攒着的候选能上卡的那些；顺手把已经没用的作废（值和档案里的一样了、拒过建档的人的） */
  const cardItems = (): { items: PersonalFileSuggestItem[]; ids: string[]; stale: string[] } => {
    const pending = candidatesOf(reader, "pending");
    const items: PersonalFileSuggestItem[] = [];
    const ids: string[] = [];
    const stale: string[] = [];
    const byKey = new Map<string, StoredCandidate[]>();
    for (const c of pending) byKey.set(c.personKey, [...(byKey.get(c.personKey) ?? []), c]);
    for (const [key, rows] of byKey) {
      const latest = rows.at(-1)!;
      // 攒着的时候还没有档案、后来有了（档案页里建了）：照已有的人上卡
      const personId = rows.find((c) => c.personId !== undefined)?.personId ?? (key.startsWith("n:") ? files.find(latest.name)?.id : undefined);
      const kind = personId === undefined ? "person" : files.kindOf(personId);
      if (personId !== undefined && kind !== undefined) {
        // 卡上写档案里现在的称呼（本人写"我"）
        const person = { id: personId, name: kind === "self" ? t("personalFiles.self") : (files.currentValue(personId, "name") ?? latest.name), isNew: false };
        for (const c of rows) {
          if (c.field === undefined) continue;
          if (files.currentValue(personId, c.field) === c.value) {
            stale.push(c.candidateId);
            continue;
          }
          items.push(fieldItem(c, person, kind));
          ids.push(c.candidateId);
        }
        continue;
      }
      // 用户从通讯录挑的人（299）：不用提到几次，拒过建档的也再提；导入的 vCard（301）：不用提到几次，拒过建档的不再提
      const picked = rows.some((c) => c.origin === "contacts");
      const imported = rows.some((c) => c.origin === "vcard");
      if (!picked && createRejected(key)) {
        stale.push(...rows.map((c) => c.candidateId));
        continue;
      }
      const mentions = union(rows.map((c) => c.materialIds)).length;
      if (!picked && !imported && mentions < NEW_PERSON_MIN_MENTIONS) continue;
      const relation = rows.toReversed().find((c) => c.relation !== undefined)?.relation;
      const person = { name: latest.name, ...(relation === undefined ? {} : { relation }), isNew: true };
      const origin = (picked ? "contacts" : imported ? "vcard" : latest.origin) as PersonalSuggestOrigin;
      items.push({ id: createItemId(key), kind: "create", person, mentions, heard: union(rows.map((c) => c.heard)).toSorted(), origin });
      ids.push(...rows.map((c) => c.candidateId));
      for (const c of rows) if (c.field !== undefined) items.push(fieldItem(c, person, "person"));
    }
    return { items, ids, stale };
  };

  /** 还没处理的那张候选核对卡（每晚整理、访谈合出来的；问每年提醒的那种不算） */
  const openCard = (): string | undefined => {
    for (const c of candidatesOf(reader, "pending").toReversed()) {
      if (c.cardId === undefined) continue;
      if (cards.get(c.cardId)?.status === "pending") return c.cardId;
    }
    return undefined;
  };

  const compose: PersonalFileCandidates["compose"] = (opts = {}) => {
    const { items, ids, stale } = cardItems();
    const events: NewEvent[] = [];
    if (stale.length > 0) events.push(personalFileEvent({ change: "candidates_resolved", candidateIds: stale, outcome: "dropped" }));
    if (items.length === 0) {
      if (events.length > 0) store.appendBatch(events);
      return undefined;
    }
    const date = opts.date ?? files.today();
    const payload: PersonalFileSuggestCardPayload = { title: t("personalFiles.suggest.title"), date, items };
    const existing = openCard();
    let cardId: string;
    if (existing !== undefined) {
      cardId = existing;
      events.push(cards.buildUpdate(existing, { payload }).event);
    } else {
      const created = cards.buildCreate({ type: "personal_file_suggest", payload });
      cardId = created.card.id;
      // 299：只有从手机通讯录挑的人时，来源写"手机通讯录"；301：只有导入的通讯录时写"导入的通讯录"，两样都有写"通讯录"
      const source = items.every((i) => i.origin === "contacts")
        ? t("personalFiles.suggest.sourceContacts")
        : items.every((i) => i.origin === "vcard")
          ? t("personalFiles.suggest.sourceVcard")
          : items.every((i) => userProvided(i.origin))
            ? t("personalFiles.suggest.sourceAddressBook")
            : t("personalFiles.suggest.source");
      events.push(created.event, inbox.buildAdd({ kind: "card", cardId, title: t("personalFiles.suggest.inboxTitle"), source, urgency: "non_blocking" }).event);
    }
    events.push(personalFileEvent({ change: "candidates_carded", cardId, candidateIds: ids }));
    store.appendBatch(events);
    log(`个人档案：候选核对卡 ${cardId}（${items.length} 条）`);
    return cardId;
  };

  return {
    add,
    compose,
    onMaterialsDeleted(materialIds, mode) {
      const gone = new Set(materialIds);
      const hit = candidatesOf(reader).filter((c) => c.materialIds.length > 0 && c.materialIds.every((id) => gone.has(id)));
      if (hit.length === 0) return;
      const pendingIds = hit.filter((c) => c.status === "pending").map((c) => c.candidateId);
      if (pendingIds.length > 0) store.append(personalFileEvent({ change: "candidates_resolved", candidateIds: pendingIds, outcome: "dropped" }));
      if (mode === "purge") {
        const wanted = new Set(hit.map((c) => c.candidateId));
        const cardIds = new Set(hit.flatMap((c) => (c.cardId === undefined ? [] : [c.cardId])));
        const targets = [
          ...store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT).filter((e) => {
            const change = e.payload as PersonalFileChange;
            return change.change === "candidate_added" && wanted.has(change.candidateId);
          }),
          ...cardEventsOf(store, cardIds),
        ];
        options.purge(targets);
      }
      // 还开着的那张卡按剩下的重排（作废的不再上卡）
      const open = openCard();
      if (open !== undefined || pendingIds.length > 0) compose();
    },
  };
}

/** 这几张卡的每个版本（彻底删除时连卡上的值一起改写） */
export function cardEventsOf(store: EventStore, cardIds: ReadonlySet<string>): StoredEvent[] {
  if (cardIds.size === 0) return [];
  return store.read("cards", 0, "card").filter((e) => cardIds.has((e.payload as { card?: { id?: string } }).card?.id ?? ""));
}

/** 卡上"写进档案"的输入：不带就是全写、提醒照默认 */
const SuggestInput = Type.Union([PersonalFileSuggestInput, Type.Undefined()]);

/**
 * 候选核对卡（卡片类型 personal_file_suggest）："写进档案"按勾了的条目写（新建的人只有勾了建档那一条才建；带每年提醒的按勾着的建），
 * 没勾的记成"没写"；"都不用"全记成没写。都由运行时写，和候选的结局同一批
 */
export function defineSuggestCardType(deps: { store: EventStore; files: CandidateFiles }) {
  const { store, files } = deps;
  return defineCardType({
    type: "personal_file_suggest",
    version: 1,
    payload: SuggestPayloadSchema,
    actions: {
      confirm: {
        input: SuggestInput,
        run: ({ card, payload, input }): CardActionEffect<PersonalFileSuggestCardPayload> => {
          const all = payload.items.map((i) => i.id);
          const accept = new Set(input?.accept ?? all);
          for (const id of accept) if (!all.includes(id)) throw new RequestRejected("bad_params", t("personalFiles.suggest.unknownItem", { id }));
          const days = new Map<string, number>(
            input?.remind === undefined ? payload.items.flatMap((i) => (i.remind === undefined ? [] : [[i.id, i.remind.daysBefore] as const])) : input.remind.map((r) => [r.item, r.daysBefore] as const),
          );
          const events: NewEvent[] = [];
          const after: Array<() => void> = [];
          const accepted: string[] = [];
          const trailOf = (item: PersonalFileSuggestItem): PersonalFileTrail =>
            item.origin === "secretary" && payload.via !== undefined
              ? { via: "secretary", basis: "confirmed", actionId: payload.via.actionId, cardId: card.id, conversation: payload.via.conversation }
              : { via: "curator", basis: "confirmed", cardId: card.id, origin: item.origin };
          // 按人分：已有档案的按编号，新建的按建档那一条
          const groups = new Map<string, PersonalFileSuggestItem[]>();
          for (const item of payload.items) {
            const key = item.person.id ?? `new:${item.person.name}`;
            groups.set(key, [...(groups.get(key) ?? []), item]);
          }
          for (const items of groups.values()) {
            const first = items[0]!;
            const create = items.find((i) => i.kind === "create");
            if (first.person.isNew && (create === undefined || !accept.has(create.id))) continue;
            const chosen = items.filter((i) => i.kind !== "create" && accept.has(i.id));
            const fields = chosen.filter((i) => i.kind === "field" && i.field !== undefined && i.value !== undefined).map((i) => ({ field: i.field!, value: i.value! }));
            const reminders = chosen.flatMap((i) => (i.remind !== undefined && i.field !== undefined && days.has(i.id) ? [{ field: i.field, daysBefore: days.get(i.id)! }] : []));
            if (create === undefined && fields.length === 0 && reminders.length === 0) continue;
            if (!first.person.isNew && (first.person.id === undefined || files.kindOf(first.person.id) === undefined)) continue;
            const person = first.person.isNew ? { newName: first.person.name, ...(first.person.relation === undefined ? {} : { relation: first.person.relation }) } : { id: first.person.id! };
            try {
              const prepared = files.prepareWrite({ person, fields, reminders, trail: trailOf(create ?? chosen[0]!) });
              events.push(...prepared.events);
              if (prepared.afterCommit) after.push(prepared.afterCommit);
              accepted.push(...(create === undefined ? [] : [create.id]), ...chosen.map((i) => i.id));
            } catch (err) {
              // 值不合规了（档案里改过、名字撞了）：这一个人跳过，别的照写
              if (!(err instanceof RequestRejected)) throw err;
            }
          }
          const acceptedSet = new Set(accepted);
          const candidateIdsOf = (ids: readonly string[]) => {
            const out: string[] = [];
            for (const id of ids) {
              if (id.startsWith("new:")) out.push(...candidatesOf(store.reader, "pending").filter((c) => c.personKey === id.slice(4) && c.field === undefined).map((c) => c.candidateId));
              else if (id !== "reminder") out.push(id);
            }
            return out;
          };
          const rejected = all.filter((id) => !acceptedSet.has(id));
          const acceptedCandidates = candidateIdsOf(accepted);
          const rejectedCandidates = candidateIdsOf(rejected);
          if (acceptedCandidates.length > 0) events.push(personalFileEvent({ change: "candidates_resolved", candidateIds: acceptedCandidates, outcome: "accepted" }));
          if (rejectedCandidates.length > 0) events.push(personalFileEvent({ change: "candidates_resolved", candidateIds: rejectedCandidates, outcome: "rejected" }));
          const result = accepted.length === 0 ? t("personalFiles.suggest.none") : t("personalFiles.suggest.done", { count: accepted.length });
          return {
            status: "handled",
            payload: { ...payload, items: payload.items.map((i) => ({ ...i, decision: acceptedSet.has(i.id) ? "accepted" : "rejected" })), result },
            events,
            ...(after.length === 0 ? {} : { afterCommit: () => after.forEach((fn) => fn()) }),
          };
        },
      },
      reject: {
        input: undefined,
        run: ({ payload }): CardActionEffect<PersonalFileSuggestCardPayload> => {
          const ids: string[] = [];
          for (const item of payload.items) {
            if (item.kind === "field") ids.push(item.id);
            else if (item.kind === "create") ids.push(...candidatesOf(store.reader, "pending").filter((c) => c.personKey === item.id.slice(4) && c.field === undefined).map((c) => c.candidateId));
          }
          return {
            status: "handled",
            payload: { ...payload, items: payload.items.map((i) => ({ ...i, decision: "rejected" as const })), result: t("personalFiles.suggest.none") },
            events: ids.length === 0 ? [] : [personalFileEvent({ change: "candidates_resolved", candidateIds: ids, outcome: "rejected" })],
          };
        },
      },
    },
    toText: cardText,
    // 每年提醒的勾带着生日、纪念日的月日：整个去掉（302 号票，和 personal_file、interview_files 两种核对卡一样）；
    // 建档那一条的编号里有称呼（"new:n:王小明"），换成按先后编的（301 号票）
    purge: (p) => ({
      ...p,
      title: t("personalFiles.suggest.purgedTitle", { purged: PURGED_TEXT }),
      items: p.items.map(({ remind: _remind, ...i }, index) => ({
        ...i,
        ...(i.kind === "create" ? { id: `new:${PURGED_TEXT}:${index}` } : {}),
        person: { ...i.person, name: PURGED_TEXT, ...(i.person.relation === undefined ? {} : { relation: PURGED_TEXT }) },
        ...(i.value === undefined ? {} : { value: PURGED_TEXT }),
        ...(i.previous === undefined ? {} : { previous: PURGED_TEXT }),
      })),
      ...(p.result === undefined ? {} : { result: PURGED_TEXT }),
    }),
  });
}

/** 一条 memory_command 是不是删素材的（忘掉、彻底删除、别推断），是的话删了哪几条 */
export function deletedMaterials(payload: MemoryCommandEventPayload): { materialIds: string[]; mode: "forget" | "purge" | "no_infer" } | undefined {
  if (payload.command === "remember") return undefined;
  return { materialIds: [...payload.materialIds], mode: payload.command };
}

/**
 * 断开数据源并删已导入的（299 号票，"删除参与方"登记表的 DATA_SOURCE_DELETION）：从这个数据源来的候选（通讯录选人的）——
 * 事件里的称呼、值彻底删除（改写），还没处理的作废，合进过的候选核对卡每个版本字段级改写（同一个事务）；提交之后还开着的那张卡
 * 按剩下的候选重排，没剩下的卡作废（待办里不再挂着）。已经写进档案的（用户在卡上确认过的）不动：那是用户自己的档案了
 */
export function registerCandidateDeletion(
  participants: Pick<DeletionParticipants, "register">,
  deps: { store: EventStore; cards: Pick<CardService, "get" | "buildUpdate">; compose: () => void },
): () => void {
  return participants.register(DATA_SOURCE_DELETION, {
    owner: "personal-files",
    join: ({ source }, plan) => ({
      claim() {
        const { store } = deps;
        const events = liveEvents(store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT)).filter((e) => {
          const change = e.payload as PersonalFileChange;
          return change.change === "candidate_added" && change.dataSource === source;
        });
        if (events.length === 0) return;
        const ids = new Set(events.map((e) => (e.payload as Extract<PersonalFileChange, { change: "candidate_added" }>).candidateId));
        for (const event of events) plan.rewrite(event);
        const rows = candidatesOf(store.reader).filter((c) => ids.has(c.candidateId));
        const pending = rows.filter((c) => c.status === "pending").map((c) => c.candidateId);
        if (pending.length > 0) plan.append("records", personalFileEvent({ change: "candidates_resolved", candidateIds: pending, outcome: "dropped" }));
        const cardIds = [...new Set(rows.flatMap((c) => (c.cardId === undefined ? [] : [c.cardId])))];
        for (const cardId of cardIds) plan.purgeCard(cardId);
        plan.afterCommit(() => {
          deps.compose();
          // 只装着这些候选的卡：没有能上卡的了，作废
          const stillCarded = new Set(candidatesOf(store.reader, "pending").flatMap((c) => (c.cardId === undefined ? [] : [c.cardId])));
          const expire = cardIds.filter((id) => deps.cards.get(id)?.status === "pending" && !stillCarded.has(id));
          if (expire.length > 0) store.appendBatch(expire.map((id) => deps.cards.buildUpdate(id, { status: "expired", expiredNote: t("personalFiles.suggest.sourceGone") }).event));
        });
      },
    }),
  });
}
