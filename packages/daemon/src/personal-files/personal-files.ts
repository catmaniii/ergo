// 个人档案（281 号票，用户 2026-10-25 定）：用户本人和重要的人各一份，放内核（像"我的名字"、素材库，停用记忆插件也不丢）。
// - 谁有档案：本人一份（一直在，编号 SELF_PERSON_ID；姓名就是"我的名字"，同一个来源，不另存一份）；重要的人每人一份（用户在
//   档案页里建，或者秘书提议、用户确认后建；283 号票的每晚候选也走 prepareWrite）；
// - 每份三块：固定信息（字段表，同一字段来了新值旧值记成历史）、记下的事、二狗了解到的（283 号票接上，这里只留位置）；
// - 写入只有两条路：用户在档案页里直接改（改了就算确认，change / addPerson），秘书经快速动作提议（quick-action.ts：号码类出核对卡，
//   原话里明说了的直接写、留回执）。每次写都留痕（events.ts 的 PersonalFileTrail）；
// - 读：档案页（file / list，原话按消息编号现取）、秘书的 read_personal_file（read-tool.ts，按人、按字段拿确认过的原值）；
// - 删：忘掉（档案里没有了，事件日志里原话还在）、彻底删除（字段值和历史连同核对卡、操作记录、读过它的调用一起改写，
//   用户选了的话连出处那句原话一起，照删素材的口径）；删一个人连他的整份档案。本人那份删不掉。
// 安全照 ADR-0026"功能先跑通、安全后接"：证件号等先明文存，打码、不外发、取全值留痕以后安全阶段再接（只记录不实现）。
// 283 号票接上记忆和提醒：
// - 生日、纪念日的每年提醒（annual.ts）：写的时候可以一起开（核对卡、候选卡上的勾；302 号票起原话里明说、直接写的按默认直接开），
//   档案页上开、关、改天数（set_reminder）；字段改了、删了、撤销了、改了称呼，落盘之后提醒插件里的那条跟着改、删；
// - 候选（candidates.ts）：记忆管理员攒的、合成一张候选核对卡；
// - 给记忆这一侧的（memory-link.ts）：档案里的人、档案摘要、不进整理提示的值、字段换了新值的通知；
// - "二狗了解到的"：经记忆插件的服务现取（learned），插件没启用时写明。
// 302 号票：内置字段"纪念日"能有几个（"anniversary:<名字>"），字段的先后按协议包的 personalFieldOrder；认字段名时带上这份档案已有的字段
// （283 时建的同名自定义字段接着写）。
// 285 号票：档案里的人分组（家人、重要的人、其他人）——建人时选（addPerson 的 group）、档案页上改（set_group），记成 group_set；
// 没选过的按"和我的关系"现猜（协议包的 guessPersonGroup），列表和一份档案上写 groupGuessed。秘书、记忆管理员提议建的人都没选分组。
import { randomUUID } from "node:crypto";
import {
  type AddPersonBody,
  checkPersonalNote,
  checkPersonalValue,
  checkPersonName,
  checkUserName,
  customLabelOf,
  EVENT_TYPES,
  isAnnualField,
  isDeletedEventPayload,
  isNumberField,
  type MemoryCommandEventPayload,
  type MessageEventPayload,
  monthDayOf,
  type PersonalFieldValue,
  type PersonalFieldView,
  type PersonalFileChangeBody,
  type PersonalFileDeleteBody,
  type PersonalFileDeleteResult,
  type PersonalFileKind,
  type PersonalFileLearnedView,
  type PersonalFileSource,
  type PersonalFilesView,
  type PersonalFileSummary,
  type PersonalFileView,
  type PersonGroup,
  guessPersonGroup,
  isPersonGroup,
  personalFieldLabel,
  personalFieldOf,
  personalFieldOrder,
  SELF_PERSON_ID,
  t,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { type Material, type Materials, MATERIALS_CHANNEL } from "../materials/index.ts";
import { deletionEvents } from "../memory/deletion.ts";
import { type PurgeDeps, purgePlan, type QuickActionTrace, type ToolCallMention } from "../memory/purge.ts";
import { readUserTurn } from "../quick-actions/index.ts";
import type { UserNameService } from "../user-name/index.ts";
import { type AnnualReminderPort, createAnnualReminders } from "./annual.ts";
import { type CandidateInput, cardEventsOf, createCandidates, defineSuggestCardType, deletedMaterials, type PersonalFileCandidates } from "./candidates.ts";
import { carriesValue, PERSONAL_FILE_EVENT, PERSONAL_FILES_CHANNEL, type PersonalFileChange, personalFileEvent, type PersonalFileTrail } from "./events.ts";
import { backgroundText, type FieldReplaced, type FileForMemory, type PersonalFilesForMemory, type PersonForMemory, withheldValues } from "./memory-link.ts";
import { READ_PERSONAL_FILE } from "./tool-names.ts";
import { chosenGroupOf, hasPerson, listPeople, notesOf, type StoredValue, valuesOf } from "./view.ts";

/** 原话截多长（档案页的"出处"） */
const QUOTE_MAX = 80;
/** 彻底删除时，参数、返回里带着这个值的任何工具的调用都改写——值至少这么长才这样找（短的只找读档案的调用，免得误伤） */
const MENTION_ANY_TOOL_MIN = 6;

/** 别名一格里几个别名之间的分隔（按字认） */
// @i18n-ignore-next data：认用户写的中文标点
const ALIAS_SEPARATORS = /[、，,/／\s]+/;

/** 秘书写"谁"时指本人的说法（按字认） */
// @i18n-ignore-next data：认秘书写的中文"谁"
const SELF_WORDS: readonly string[] = ["我", "我自己", "自己", "本人", "用户", "me", SELF_PERSON_ID];

/** 认出来的一份档案 */
export interface PersonRef {
  id: string;
  kind: PersonalFileKind;
  /** 本人：我的名字（没设是 undefined）；重要的人：称呼 */
  name: string | undefined;
}

/** 一次写入（值都已按规矩查过、规范化过） */
export interface PersonalFileWrite {
  /** 写给已有的一份，或者新建一个人（285：建人时选的分组；不选按关系猜） */
  person: { id: string } | { newName: string; relation?: string; group?: PersonGroup };
  fields: ReadonlyArray<{ field: string; value: string }>;
  note?: { text: string; date: string };
  /** 283：一起开的每年提醒（生日、纪念日这类字段；值认不出公历日子的不开） */
  reminders?: ReadonlyArray<{ field: string; daysBefore: number }>;
  trail: PersonalFileTrail;
}

/** "二狗了解到的"由记忆插件给（283）：档案里的人按称呼、别名对到人物实体；本人对用户自己 */
export interface PersonalFileMemoryPort {
  learnedAbout(subject: { kind: PersonalFileKind; names: readonly string[] }): PersonalFileLearnedView;
}

export interface PersonalFilesServiceOptions {
  store: EventStore;
  cards: CardService;
  /** 283：候选核对卡进待我处理 */
  inbox: Pick<InboxService, "buildAdd">;
  userName: UserNameService;
  /** 彻底删除要的：改写函数表、卡片（PurgeDeps），连出处一起删时的素材库 */
  deletion: PurgeDeps & { materials: Pick<Materials, "list"> };
  /** 今天（配置的时区里的 YYYY-MM-DD）：记下的事不写日期时用 */
  today: () => string;
  /** 283：现在（协议时间）：字段换了新值的那一刻 */
  now: () => string;
  /** 283：提醒插件（每年提醒；没启用是 undefined）。组合根经 annual-port.ts 的 annualPortOf 拼好交来 */
  annual?: () => AnnualReminderPort | undefined;
  /** 283："二狗了解到的"（记忆插件的服务；没启用是 undefined） */
  memory?: () => PersonalFileMemoryPort | undefined;
  log: (line: string) => void;
}

export interface PersonalFilesService {
  /** 列表：本人那份在最前，然后是重要的人（按建的先后） */
  list(): PersonalFilesView;
  /** 一份档案；没有这份是 undefined */
  file(personId: string): PersonalFileView | undefined;
  /** 秘书写的"谁"认成一份档案：我 / 本人 → 本人；别的按称呼、别名找（去掉首尾空白，一字不差）、按编号找 */
  find(person: string): PersonRef | undefined;
  /** 一个字段现在的值（本人的姓名取我的名字） */
  currentValue(personId: string, field: string): string | undefined;
  /** 一个人的全部值（读档案用：每个字段新的在前） */
  values(personId: string): StoredValue[];
  /** 档案页：加一个重要的人（改了就算确认） */
  addPerson(body: AddPersonBody): PersonalFileView;
  /** 档案页：写字段、记下一件事、撤销最近一次写入 */
  change(personId: string, body: PersonalFileChangeBody): PersonalFileView;
  /** 档案页：删一个人、一个字段、一件事（忘掉或彻底删除） */
  remove(personId: string, body: PersonalFileDeleteBody): PersonalFileDeleteResult;
  /**
   * 一次写入要追加的事件（快速动作执行时和卡片、操作记录同一事务；页面改的直接追加）。本人改姓名在落盘之后改我的名字（afterCommit）。
   * 值没变的字段不写。不让写（新建的人和已有的重名之外的规矩都在调用方查过）时抛 RequestRejected。
   * reminded（302 号票）：这次开了（或改了天数）的每年提醒，回执里写明
   */
  prepareWrite(write: PersonalFileWrite): { events: NewEvent[]; personId: string; afterCommit?: () => void; changed: string[]; reminded: Array<{ field: string; daysBefore: number }> };
  /** 302：秘书、页面写的字段名认成这份档案的字段编号（带上已有的字段：283 时建的同名自定义纪念日接着写）；认不出是 undefined */
  fieldOf(personId: string | undefined, kind: PersonalFileKind, raw: string): string | undefined;
  /** 今天 */
  today(): string;
  /** 283："二狗了解到的"（经记忆插件现取；插件没启用时 ready 是 false、写明原因） */
  learned(personId: string): PersonalFileLearnedView;
  /** 283：候选（记忆管理员攒的、合成候选核对卡；284 号票的访谈也交到这里） */
  readonly candidates: PersonalFileCandidates;
  /** 283：给记忆插件的（KERNEL.personalFiles） */
  readonly forMemory: PersonalFilesForMemory;
  /** 283：候选核对卡的卡片类型（组合根登记） */
  suggestCardType(): ReturnType<typeof defineSuggestCardType>;
  /** 283：提醒插件在不在（核对卡上要不要给每年提醒的勾） */
  remindersOn(): boolean;
  /** 283：守护进程起来、插件都装好以后：对一遍每年提醒，开始跟着素材的删除作废候选；返回停的函数 */
  start(): () => void;
}

/** 字段值的规矩：本人的姓名照我的名字的规矩，重要的人的称呼照称呼的规矩，别的照字段的规矩 */
export function checkFieldFor(kind: PersonalFileKind, field: string, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  if (field === "name" && kind === "self") {
    const name = checkUserName(raw);
    return name.ok ? { ok: true, value: name.name } : name;
  }
  if (field === "name") return checkPersonName(raw);
  return checkPersonalValue(field, raw);
}

/** 一个字段现在的值（这几个值里没有 until 的那个） */
const currentOf = (values: readonly StoredValue[], field: string) => values.find((v) => v.field === field && v.until === undefined);

/** 这份档案列哪些字段：默认的（没填的也列；302 的纪念日换成已有的那几个），然后是自定义的（按第一次写的先后） */
function fieldsOf(kind: PersonalFileKind, values: readonly StoredValue[]): string[] {
  return personalFieldOrder(kind, values.toReversed().map((v) => v.field));
}

/** 这份档案已有的字段（认字段名时用：302） */
const presentFields = (values: readonly StoredValue[]): string[] => [...new Set(values.map((v) => v.field))];

/** 页面写的字段名认成编号、值按规矩查；不合规抛 RequestRejected（说明回给页面）。existing：这份档案已有的字段 */
function checked(kind: PersonalFileKind, rawField: string, rawValue: string, existing: readonly string[] = []): { field: string; value: string } {
  const field = personalFieldOf(kind, rawField, existing);
  if (field === undefined) throw new RequestRejected("bad_params", t("personalFiles.badField", { field: rawField }));
  const value = checkFieldFor(kind, field, rawValue);
  if (!value.ok) throw new RequestRejected("bad_params", t("personalFiles.badValue", { field: personalFieldLabel(kind, field), reason: value.error }));
  return { field, value: value.value };
}

const newPersonId = () => `p-${randomUUID().slice(0, 8)}`;
const newNoteId = () => `n-${randomUUID().slice(0, 8)}`;

export function createPersonalFilesService(options: PersonalFilesServiceOptions): PersonalFilesService {
  const { store, cards, userName, deletion } = options;
  const reader = store.reader;

  const kindOf = (personId: string): PersonalFileKind | undefined => (personId === SELF_PERSON_ID ? "self" : hasPerson(reader, personId) ? "person" : undefined);
  /** 283：字段换了新值的订阅方（记忆插件让旧事实到期） */
  const replacedListeners = new Set<(change: FieldReplaced) => void>();
  const requireKind = (personId: string): PersonalFileKind => {
    const kind = kindOf(personId);
    if (!kind) throw new RequestRejected("not_found", t("personalFiles.noFile", { id: personId }));
    return kind;
  };

  const nameOf = (personId: string): string | undefined => (personId === SELF_PERSON_ID ? userName.current() : currentOf(valuesOf(reader, personId), "name")?.value);

  /** 302：字段名认成这份档案的字段编号（新建的人没有已有的字段） */
  const fieldOf = (personId: string | undefined, kind: PersonalFileKind, raw: string): string | undefined =>
    personalFieldOf(kind, raw, personId === undefined ? [] : presentFields(valuesOf(reader, personId)));

  /** 那句话的原文（截短）；消息不在了（彻底删除了）写明 */
  const quoteOf = (messageId: string): Pick<PersonalFileSource, "quote" | "messageGone"> => {
    const turn = readUserTurn(store, cards, messageId);
    const text = [...turn.typed, ...turn.spoken].join(" ").replace(/\s+/g, " ").trim();
    if (text === "") return { messageGone: true };
    return { quote: [...text].length > QUOTE_MAX ? `${[...text].slice(0, QUOTE_MAX).join("")}…` : text };
  };

  const sourceOf = (trail: PersonalFileTrail, at: string): PersonalFileSource => {
    if (trail.via === "page") return { via: "page", at };
    return {
      via: trail.via,
      basis: trail.basis,
      at,
      ...(trail.messageId === undefined ? {} : { messageId: trail.messageId, ...quoteOf(trail.messageId) }),
      // 299：经候选核对卡写的，写上候选从哪来（从手机通讯录挑的）
      ...("origin" in trail ? { origin: trail.origin } : {}),
    };
  };

  /** 283：每年提醒 */
  const annual = createAnnualReminders({
    store,
    port: () => options.annual?.(),
    valueOf: (personId, field) => currentOf(valuesOf(reader, personId), field)?.value,
    whoOf: (personId) => ({ self: personId === SELF_PERSON_ID, name: nameOf(personId) }),
    labelOf: (personId, field) => personalFieldLabel(personId === SELF_PERSON_ID ? "self" : "person", field),
    log: options.log,
  });

  /** 285：分组——选过的是选的那组，没选过的按现在的关系猜（groupGuessed）；本人那份没有 */
  const groupView = (personId: string, kind: PersonalFileKind, values: readonly StoredValue[]): Pick<PersonalFileSummary, "group" | "groupGuessed"> => {
    if (kind === "self") return {};
    const chosen = chosenGroupOf(reader, personId);
    return chosen !== undefined ? { group: chosen } : { group: guessPersonGroup(currentOf(values, "relation")?.value), groupGuessed: true };
  };

  const valueView = (v: StoredValue): PersonalFieldValue => ({ value: v.value, since: v.since, ...(v.until === undefined ? {} : { until: v.until }), source: sourceOf(v.trail, v.since) });

  const fieldView = (personId: string, kind: PersonalFileKind, field: string, values: readonly StoredValue[]): PersonalFieldView => {
    const rows = values.filter((v) => v.field === field);
    const current = rows.find((v) => v.until === undefined);
    const base = { field, label: personalFieldLabel(kind, field), custom: customLabelOf(field) !== undefined };
    // 本人的姓名就是我的名字：值现取，没有历史
    if (kind === "self" && field === "name") {
      const name = userName.current();
      return { ...base, number: false, linked: "user_name", ...(name === undefined ? {} : { current: { value: name } }), history: [] };
    }
    const annualView = annual.view(personId, field, current?.value);
    return {
      ...base,
      number: isNumberField(field, current?.value ?? ""),
      ...(current ? { current: valueView(current) } : {}),
      history: rows.filter((v) => v.until !== undefined).map(valueView),
      ...(annualView === undefined ? {} : { annual: annualView }),
    };
  };

  const file = (personId: string): PersonalFileView | undefined => {
    const kind = kindOf(personId);
    if (!kind) return undefined;
    const values = valuesOf(reader, personId);
    const name = nameOf(personId);
    return {
      id: personId,
      kind,
      ...(name === undefined ? {} : { name }),
      ...groupView(personId, kind, values),
      fields: fieldsOf(kind, values).map((f) => fieldView(personId, kind, f, values)),
      notes: notesOf(reader, personId).map((n) => ({ id: n.noteId, text: n.text, date: n.date, source: sourceOf(n.trail, n.at) })),
    };
  };

  const summaryOf = (personId: string, kind: PersonalFileKind): PersonalFileSummary => {
    const values = valuesOf(reader, personId);
    const name = nameOf(personId);
    const relation = kind === "person" ? currentOf(values, "relation")?.value : undefined;
    const filled = new Set(values.filter((v) => v.until === undefined).map((v) => v.field));
    if (kind === "self" && name !== undefined) filled.add("name");
    return {
      id: personId,
      kind,
      ...(name === undefined ? {} : { name }),
      ...(relation === undefined ? {} : { relation }),
      ...groupView(personId, kind, values),
      filled: filled.size,
      notes: notesOf(reader, personId).length,
    };
  };

  const find = (person: string): PersonRef | undefined => {
    const wanted = person.trim();
    if (wanted === "") return undefined;
    if (SELF_WORDS.includes(wanted)) return { id: SELF_PERSON_ID, kind: "self", name: userName.current() };
    const people = listPeople(reader);
    if (people.includes(wanted)) return { id: wanted, kind: "person", name: nameOf(wanted) };
    // 先按称呼，再按别名（别名一格里可以写好几个，按顿号、逗号、斜杠、空白分开）
    for (const id of people) if (nameOf(id) === wanted) return { id, kind: "person", name: wanted };
    for (const id of people) {
      const aliases = currentOf(valuesOf(reader, id), "aliases")?.value.split(ALIAS_SEPARATORS) ?? [];
      if (aliases.includes(wanted)) return { id, kind: "person", name: nameOf(id) };
    }
    return undefined;
  };

  const prepareWrite: PersonalFilesService["prepareWrite"] = (write) => {
    const events: NewEvent[] = [];
    const changed: string[] = [];
    let personId: string;
    let kind: PersonalFileKind;
    let afterCommit: (() => void) | undefined;
    if ("newName" in write.person) {
      // 新建一个重要的人：提议到确认之间已经有了同名的，就写进那一份
      const existing = find(write.person.newName);
      if (existing) {
        personId = existing.id;
        kind = existing.kind;
      } else {
        personId = newPersonId();
        kind = "person";
        events.push(personalFileEvent({ change: "person_added", personId, trail: write.trail }));
        events.push(personalFileEvent({ change: "field_set", personId, field: "name", value: write.person.newName, trail: write.trail }));
        changed.push("name");
        if (write.person.relation !== undefined) {
          events.push(personalFileEvent({ change: "field_set", personId, field: "relation", value: write.person.relation, trail: write.trail }));
          changed.push("relation");
        }
        if (write.person.group !== undefined) events.push(personalFileEvent({ change: "group_set", personId, group: write.person.group, trail: write.trail }));
      }
    } else {
      personId = write.person.id;
      kind = requireKind(personId);
    }
    const values = valuesOf(reader, personId);
    /** 283：换了新值的字段（旧值）：落盘之后交给记忆插件 */
    const replaced: Array<{ field: string; oldValue: string }> = [];
    for (const { field, value } of write.fields) {
      if (kind === "self" && field === "name") {
        // 本人的姓名就是我的名字：落盘之后改它（不合规的在调用方已经按 checkUserName 查过），这里只留痕
        if (userName.current() === value) continue;
        events.push(personalFileEvent({ change: "field_set", personId, field, trail: write.trail }));
        afterCommit = () => void userName.change(value);
        changed.push(field);
        continue;
      }
      const before = currentOf(values, field)?.value;
      if (before === value && !changed.includes(field)) continue;
      events.push(personalFileEvent({ change: "field_set", personId, field, value, trail: write.trail }));
      changed.push(field);
      if (before !== undefined && before !== value && field !== "name") replaced.push({ field, oldValue: before });
    }
    if (write.note) {
      events.push(personalFileEvent({ change: "note_added", personId, noteId: newNoteId(), text: write.note.text, date: write.note.date, trail: write.trail }));
      changed.push("note");
    }
    // 283：一起开的每年提醒（生日、纪念日这类字段，值是这次写的或者现在的，认得出公历日子才开）
    const reminderFields: string[] = [];
    const reminded: Array<{ field: string; daysBefore: number }> = [];
    for (const { field, daysBefore } of write.reminders ?? []) {
      const value = write.fields.find((f) => f.field === field)?.value ?? currentOf(values, field)?.value;
      if (!isAnnualField(field) || value === undefined || monthDayOf(value) === undefined) continue;
      const set = annual.setEvents(personId, field, daysBefore, write.trail);
      events.push(...set);
      reminderFields.push(field);
      if (set.length > 0) reminded.push({ field, daysBefore });
    }
    const userNameChange = afterCommit;
    const at = options.now();
    // 落盘之后：我的名字；每年提醒跟上（改了称呼的这个人全部、改了日子的那几个字段、新开的）；字段换了新值告诉记忆插件
    const syncFields = changed.includes("name") ? undefined : [...new Set([...changed, ...reminderFields])].filter(isAnnualField);
    afterCommit = () => {
      userNameChange?.();
      if (syncFields === undefined || syncFields.length > 0) annual.sync(personId, syncFields);
      if (replaced.length > 0) notifyReplaced(personId, kind, replaced, at);
    };
    return { events, personId, changed, afterCommit, reminded };
  };

  /** 283：字段换了新值，告诉订阅方（记忆插件）；订阅方出错不影响写档案 */
  const notifyReplaced = (personId: string, kind: PersonalFileKind, replaced: ReadonlyArray<{ field: string; oldValue: string }>, at: string) => {
    if (replacedListeners.size === 0) return;
    const names = namesOf(personId, kind);
    for (const { field, oldValue } of replaced) {
      const change: FieldReplaced = { personId, kind, names, field, label: personalFieldLabel(kind, field), oldValue, at };
      for (const listener of replacedListeners) {
        try {
          listener(change);
        } catch (err) {
          options.log(`个人档案：通知字段换了新值出错（${err instanceof Error ? err.message : String(err)}）`);
        }
      }
    }
  };

  /** 283：一个人的叫法（称呼和别名；本人是空的） */
  const namesOf = (personId: string, kind: PersonalFileKind): string[] => {
    if (kind === "self") return [];
    const values = valuesOf(reader, personId);
    const name = currentOf(values, "name")?.value;
    const aliases = currentOf(values, "aliases")?.value.split(ALIAS_SEPARATORS).filter((a) => a !== "") ?? [];
    return [...(name === undefined ? [] : [name]), ...aliases];
  };

  /** 页面上写一次：追加事件，改我的名字（本人的姓名） */
  const commit = (write: PersonalFileWrite): string => {
    const prepared = prepareWrite(write);
    if (prepared.events.length > 0) store.appendBatch(prepared.events);
    prepared.afterCommit?.();
    return prepared.personId;
  };

  /** 这份档案里要删的东西对应的事件（带原值的、留痕指向快速动作的） */
  const eventsOf = (personId: string, target: PersonalFileDeleteBody["target"]): StoredEvent[] =>
    store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT).filter((event) => {
      const change = event.payload as PersonalFileChange;
      if (!("personId" in change) || change.personId !== personId) return false;
      switch (target.kind) {
        case "person":
          return true;
        case "field":
          return (change.change === "field_set" || change.change === "field_undone") && change.field === target.field;
        case "note":
          return change.change === "note_added" && change.noteId === target.noteId;
      }
    });

  /** 彻底删除要改写的、要连带的：带原值的档案事件、留痕里的快速动作、读过这些值的调用、出处那几句话 */
  const purgeTargets = (personId: string, target: PersonalFileDeleteBody["target"], extraValues: readonly string[]) => {
    const related = eventsOf(personId, target);
    const changes = related.map((e) => e.payload as PersonalFileChange);
    const traces = new Map<string, QuickActionTrace>();
    const messageIds = new Set<string>();
    const texts = new Set<string>(extraValues);
    /** 283：候选核对卡（经记忆管理员提议的值）：每个版本连同改写 */
    const suggestCards = new Set<string>();
    for (const change of changes) {
      // 经快速动作写的（秘书提议；284 号票起还有访谈的档案核对卡上确认的，via curator、带 actionId）：操作记录、卡片、提议它的调用
      if ("trail" in change && change.trail !== undefined && change.trail.via !== "page" && "actionId" in change.trail) {
        traces.set(change.trail.actionId, { actionId: change.trail.actionId, cardId: change.trail.cardId, conversation: change.trail.conversation });
        if (change.trail.messageId !== undefined) messageIds.add(change.trail.messageId);
      }
      if ("trail" in change && change.trail !== undefined && change.trail.via === "curator" && "origin" in change.trail) {
        suggestCards.add(change.trail.cardId);
        if (change.trail.messageId !== undefined) messageIds.add(change.trail.messageId);
      }
      if (change.change === "field_set" && change.value !== undefined) texts.add(change.value);
      if (change.change === "note_added") texts.add(change.text);
    }
    // 283：同样的值还在候选里（一个人的固定信息）：候选事件和它上过的卡一起改写
    const candidates = store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT).filter((event) => {
      const change = event.payload as PersonalFileChange;
      return change.change === "candidate_added" && change.value !== undefined && texts.has(change.value) && (target.kind === "person" ? change.personId === personId || change.personId === undefined : change.personId === personId);
    });
    for (const event of candidates) {
      const change = event.payload as Extract<PersonalFileChange, { change: "candidate_added" }>;
      const view = reader.get<{ card_id: string | null }>("SELECT card_id FROM personal_candidates WHERE candidate_id = ?", change.candidateId);
      if (view?.card_id) suggestCards.add(view.card_id);
    }
    // 302：由档案建的每年提醒（生日、纪念日）：提醒插件事件记录里它的内容、时间，连同提醒卡、通知（改写函数由提醒插件登记；
    // 插件移除了、没有改写函数的不碰，免得整个删除被拒）
    const reminderEvents =
      target.kind === "note" || !deletion.rewriters.has(EVENT_TYPES.reminder) ? [] : annual.purgeTargets(personId, target.kind === "field" ? target.field : undefined);
    const mentions: ToolCallMention[] = [...texts]
      .filter((text) => [...text].length >= 2)
      .map((text) => ([...text].length >= MENTION_ANY_TOOL_MIN ? { text } : { text, tools: [READ_PERSONAL_FILE] }));
    return {
      rewrite: [...related.filter((e) => carriesValue(e.payload as PersonalFileChange)), ...candidates, ...cardEventsOf(store, suggestCards), ...reminderEvents],
      traces: [...traces.values()],
      messageIds: [...messageIds],
      mentions,
    };
  };

  /** 出处那几句话：有素材的按素材彻底删除（记一条记忆命令），没有素材的（记忆插件没启用过）直接改写那条消息 */
  const sourcesOf = (messageIds: readonly string[]): { materials: Material[]; messages: StoredEvent[] } => {
    const wanted = new Set(messageIds);
    const materials = deletion.materials.list().filter((m) => m.ref.messageId !== undefined && wanted.has(m.ref.messageId));
    const covered = new Set(materials.map((m) => m.ref.messageId));
    const messages = messageIds
      .filter((id) => !covered.has(id))
      .flatMap((id) => store.mentioning(EVENT_TYPES.message, id).filter((e) => !isDeletedEventPayload(e.payload) && (e.payload as MessageEventPayload).message.id === id));
    return { materials, messages };
  };

  /** 283：候选（记忆管理员攒的）和候选核对卡 */
  const candidateFiles = {
    find,
    kindOf,
    currentValue: (personId: string, field: string) => (personId === SELF_PERSON_ID && field === "name" ? userName.current() : currentOf(valuesOf(reader, personId), field)?.value),
    hasReminder: (personId: string, field: string) => annual.settings(personId).some((r) => r.field === field),
    remindersOn: () => options.annual?.() !== undefined,
    prepareWrite,
    today: options.today,
  };
  const candidates = createCandidates({
    store,
    cards,
    inbox: options.inbox,
    files: candidateFiles,
    purge: (targets) => {
      if (targets.length === 0) return;
      const plan = purgePlan(deletion, [], { extraTargets: targets });
      store.appendBatch(plan.events, plan.purge.length === 0 ? undefined : { purge: plan.purge });
    },
    log: options.log,
  });

  /** 283：摘要、不进整理提示的值要的每份档案 */
  const filesForMemory = (): FileForMemory[] => [
    { id: SELF_PERSON_ID, kind: "self", ...(userName.current() === undefined ? {} : { name: userName.current()! }), values: valuesOf(reader, SELF_PERSON_ID), notes: notesOf(reader, SELF_PERSON_ID) },
    ...listPeople(reader).map((id) => {
      const name = nameOf(id);
      return { id, kind: "person" as const, ...(name === undefined ? {} : { name }), values: valuesOf(reader, id), notes: notesOf(reader, id) };
    }),
  ];

  const forMemory: PersonalFilesForMemory = {
    people(): PersonForMemory[] {
      return filesForMemory().map((f) => {
        const relation = f.kind === "person" ? currentOf(f.values, "relation")?.value : undefined;
        return { id: f.id, kind: f.kind, ...(f.name === undefined ? {} : { name: f.name }), aliases: namesOf(f.id, f.kind).slice(1), ...(relation === undefined ? {} : { relation }) };
      });
    },
    background: () => backgroundText(filesForMemory(), options.now()),
    withheld: () => withheldValues(filesForMemory()),
    onFieldReplaced(listener) {
      replacedListeners.add(listener);
      return () => void replacedListeners.delete(listener);
    },
    replacedValues() {
      const out: FieldReplaced[] = [];
      for (const f of filesForMemory()) {
        for (const v of f.values) {
          if (v.until === undefined || v.field === "name") continue;
          out.push({ personId: f.id, kind: f.kind, names: namesOf(f.id, f.kind), field: v.field, label: personalFieldLabel(f.kind, v.field), oldValue: v.value, at: v.until });
        }
      }
      return out;
    },
    addCandidates: (origin, inputs: readonly CandidateInput[]) => candidates.add(origin, inputs),
    composeCandidates: (opts) => candidates.compose(opts),
  };

  return {
    list() {
      return { files: [summaryOf(SELF_PERSON_ID, "self"), ...listPeople(reader).map((id) => summaryOf(id, "person"))] };
    },
    file,
    find,
    currentValue(personId, field) {
      if (personId === SELF_PERSON_ID && field === "name") return userName.current();
      return currentOf(valuesOf(reader, personId), field)?.value;
    },
    values: (personId) => valuesOf(reader, personId),
    addPerson(body) {
      const name = checkPersonName(body.name);
      if (!name.ok) throw new RequestRejected("bad_params", name.error);
      if (find(name.value)) throw new RequestRejected("bad_params", t("personalFiles.duplicate", { name: name.value }));
      let relation: string | undefined;
      if (body.relation !== undefined && body.relation.trim() !== "") relation = checked("person", "relation", body.relation).value;
      if (body.group !== undefined && !isPersonGroup(body.group)) throw new RequestRejected("bad_params", t("personalFiles.badGroup"));
      const person = { newName: name.value, ...(relation === undefined ? {} : { relation }), ...(body.group === undefined ? {} : { group: body.group }) };
      const personId = commit({ person, fields: [], trail: { via: "page" } });
      return file(personId)!;
    },
    change(personId, body) {
      const kind = requireKind(personId);
      switch (body.kind) {
        case "set_field": {
          const write = checked(kind, body.field, body.value, presentFields(valuesOf(reader, personId)));
          if (kind === "person" && write.field === "name") {
            const other = find(write.value);
            if (other && other.id !== personId) throw new RequestRejected("bad_params", t("personalFiles.duplicate", { name: write.value }));
          }
          commit({ person: { id: personId }, fields: [write], trail: { via: "page" } });
          break;
        }
        case "add_note": {
          const text = checkPersonalNote(body.text);
          if (!text.ok) throw new RequestRejected("bad_params", text.error);
          commit({ person: { id: personId }, fields: [], note: { text: text.value, date: body.date ?? options.today() }, trail: { via: "page" } });
          break;
        }
        case "undo_field": {
          const field = fieldOf(personId, kind, body.field);
          if (field === undefined) throw new RequestRejected("bad_params", t("personalFiles.badField", { field: body.field }));
          if (kind === "self" && field === "name") throw new RequestRejected("bad_params", t("personalFiles.nameLinked"));
          if (!currentOf(valuesOf(reader, personId), field)) throw new RequestRejected("bad_params", t("personalFiles.nothingToUndo"));
          if (kind === "person" && field === "name" && valuesOf(reader, personId).filter((v) => v.field === "name").length < 2) throw new RequestRejected("bad_params", t("personalFiles.nameRequired"));
          store.append(personalFileEvent({ change: "field_undone", personId, field, trail: { via: "page" } }));
          // 283：撤销回上一个值（或者空了）：每年提醒跟上；改的是称呼，这个人的都跟上
          annual.sync(personId, field === "name" ? undefined : [field]);
          break;
        }
        case "set_group": {
          // 285：改分组（选了以后不再按关系猜）；本人那份没有分组
          if (kind === "self") throw new RequestRejected("bad_params", t("personalFiles.selfNoGroup"));
          if (!isPersonGroup(body.group)) throw new RequestRejected("bad_params", t("personalFiles.badGroup"));
          if (chosenGroupOf(reader, personId) !== body.group) store.append(personalFileEvent({ change: "group_set", personId, group: body.group, trail: { via: "page" } }));
          break;
        }
        case "set_reminder": {
          // 283：生日、纪念日这类字段的每年提醒，开（提前几天）或关
          const field = fieldOf(personId, kind, body.field);
          if (field === undefined) throw new RequestRejected("bad_params", t("personalFiles.badField", { field: body.field }));
          if (!isAnnualField(field)) throw new RequestRejected("bad_params", t("personalFiles.annual.notAnnual", { field: personalFieldLabel(kind, field) }));
          const before = annual.settings(personId).filter((r) => r.field === field);
          if (body.daysBefore !== null) {
            const value = currentOf(valuesOf(reader, personId), field)?.value;
            if (value === undefined) throw new RequestRejected("bad_params", t("personalFiles.noValue"));
            if (monthDayOf(value) === undefined) throw new RequestRejected("bad_params", t("personalFiles.annual.notGregorian", { value }));
            if (!options.annual?.()) throw new RequestRejected("not_allowed", t("personalFiles.annual.remindersOff"));
          }
          const events = annual.setEvents(personId, field, body.daysBefore, { via: "page" });
          if (events.length > 0) store.appendBatch(events);
          if (body.daysBefore === null) annual.removeReminders(before);
          else annual.sync(personId, [field]);
          break;
        }
      }
      return file(personId)!;
    },
    remove(personId, body) {
      const kind = requireKind(personId);
      const { mode } = body;
      // 283：删之前的每年提醒设置（删了字段、删了人，提醒插件里对应的那几条跟着删）
      const remindersBefore = annual.settings(personId);
      // 字段按编号认（页面、以后别处写的可能是名字）
      let target = body.target;
      let forgotten: PersonalFileChange;
      let afterCommit: (() => void) | undefined;
      const extraValues: string[] = [];
      switch (target.kind) {
        case "person":
          if (kind === "self") throw new RequestRejected("bad_params", t("personalFiles.selfNotRemovable"));
          forgotten = { change: "person_forgotten", personId, mode };
          break;
        case "field": {
          const field = fieldOf(personId, kind, target.field);
          if (field === undefined) throw new RequestRejected("bad_params", t("personalFiles.badField", { field: target.field }));
          if (kind === "person" && field === "name") throw new RequestRejected("bad_params", t("personalFiles.nameRequired"));
          if (kind === "self" && field === "name") {
            // 本人的姓名就是我的名字：删了就是清除我的名字
            const name = userName.current();
            if (name !== undefined) extraValues.push(name);
            afterCommit = () => void userName.change(null);
          } else if (!valuesOf(reader, personId).some((v) => v.field === field)) throw new RequestRejected("not_found", t("personalFiles.noValue"));
          forgotten = { change: "field_forgotten", personId, field, mode };
          target = { kind: "field", field };
          break;
        }
        case "note": {
          const { noteId } = target;
          if (!notesOf(reader, personId).some((n) => n.noteId === noteId)) throw new RequestRejected("not_found", t("personalFiles.noNote"));
          forgotten = { change: "note_forgotten", personId, noteId, mode };
          break;
        }
      }
      let sources = 0;
      if (mode === "forget") {
        store.append(personalFileEvent(forgotten));
      } else {
        const targets = purgeTargets(personId, target, extraValues);
        const found = body.withSources === true ? sourcesOf(targets.messageIds) : { materials: [], messages: [] };
        sources = new Set([...found.materials.map((m) => m.ref.messageId), ...found.messages.map((e) => (e.payload as MessageEventPayload).message.id)]).size;
        const extraTargets = [...targets.rewrite, ...found.messages];
        const shared = { extraTargets, quickActions: targets.traces, toolCallsMentioning: targets.mentions };
        // 有素材的连同记忆命令一起（素材库据此删素材和原文副本），没有素材的只改写事件
        const plan = found.materials.length > 0 ? deletionEvents(deletion, { mode: "purge", materials: found.materials, from: { kind: "personal_file", personId }, ...shared }) : purgePlan(deletion, [], shared);
        store.appendBatch([...plan.events, personalFileEvent(forgotten)], plan.purge.length === 0 ? undefined : { purge: plan.purge });
        options.log(`个人档案：彻底删除了 ${personId} 的${target.kind === "person" ? "整份档案" : target.kind === "field" ? `字段 ${target.field}` : "一件事"}（改写 ${plan.purge.length} 条事件，连带 ${sources} 句出处）`);
      }
      afterCommit?.();
      if (target.kind !== "note") {
        const removedField = target.kind === "field" ? target.field : undefined;
        annual.removeReminders(remindersBefore.filter((r) => removedField === undefined || r.field === removedField));
      }
      const after = target.kind === "person" ? undefined : file(personId);
      return { ...(after ? { file: after } : {}), sources };
    },
    prepareWrite,
    fieldOf,
    today: options.today,
    learned(personId) {
      const kind = requireKind(personId);
      const memory = options.memory?.();
      if (!memory) return { ready: false, reason: t("personalFiles.learned.memoryOff"), entities: [], claims: [], facts: [], quotes: [] };
      return memory.learnedAbout({ kind, names: namesOf(personId, kind) });
    },
    candidates,
    forMemory,
    suggestCardType: () => defineSuggestCardType({ store, files: candidateFiles }),
    remindersOn: () => options.annual?.() !== undefined,
    start() {
      // 守护进程起来时对一遍每年提醒（提醒插件停用期间开的补建、看板上取消了的清掉）
      annual.reconcile();
      // 出处的素材被忘掉、彻底删除、别推断：只靠它们的候选作废（落盘之后另起一批，不在别人的事务里追加）
      return store.onAppend((event) => {
        if (event.channel !== MATERIALS_CHANNEL || event.type !== EVENT_TYPES.memoryCommand) return;
        const deleted = deletedMaterials(event.payload as MemoryCommandEventPayload);
        if (!deleted || deleted.materialIds.length === 0) return;
        queueMicrotask(() => {
          try {
            candidates.onMaterialsDeleted(deleted.materialIds, deleted.mode);
          } catch (err) {
            options.log(`个人档案：素材删了以后作废候选出错（${err instanceof Error ? err.message : String(err)}）`);
          }
        });
      });
    },
  };
}
