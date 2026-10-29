// 秘书写个人档案（281 号票）：快速动作 personal_file，秘书写清写给谁（"我"或者称呼）、哪些字段（字段名、照抄的值）、记下哪件事；
// 出处就是秘书当时在处理的那条用户消息（运行时知道，不由秘书报）。照现有快速动作的规矩判断能不能直接写：
// - 号码类（证件号、电话，numberGroups 逐位列出）不论点没点明都出核对卡，用户核对一遍（语音转写的数字可能错一位）；
// - 新建一个重要的人也出卡（"表弟小张"是秘书认的，不一定对）；
// - 别的：每个值、记下的事都原样出现在用户这一轮自己说的话里（打的字、语音转写）才算点明，直接写，聊天里留快速动作的"已执行"卡当回执
//   （撤销在档案页上：那个字段的"撤销"回到上一个值）；拿不准的出卡。推断出来的东西不会自动写；
// - 核对卡（卡片类型 personal_file）上"确认写入"由运行时写进档案，和操作记录同一事务；"取消"关掉。
// 每次写都留痕：经秘书转达、凭什么（点明 / 卡上确认）、根据哪句话、快速动作和卡片（彻底删除时据此改写核对卡、操作记录、提议的调用）。
// 283 号票：写生日、纪念日（值认得出公历日子、提醒插件在、还没开过每年提醒）时一起开每年提醒（默认提前 3 天）——
// 核对卡上一个勾（默认勾着，确认时一起建）。302 号票（用户 2026-10-25 定）：原话里明说了、直接写的，直接按默认建，
// 回执里写明"已建每年提醒（提前 3 天），档案页可改可关"，不再跟一张问提醒的小卡（283 那张候选核对卡）。
// 302 号票：彻底删除时核对卡上每年提醒那一勾（带着生日、纪念日的月日）整个去掉。
// 284 号票：记忆管理员在了解你访谈里记下的档案信息，收尾时合成一张档案核对卡（interview_files，memory/interview.ts）逐条确认，
// 确认的也经这个执行器写（卡在它的会话里，留痕写 curator）；不在访谈里时它的工具 propose_personal_file 照常提这个动作（总是出核对卡）。
import {
  ANNUAL_REMINDER_DEFAULT_DAYS,
  checkPersonalNote,
  checkPersonalValue,
  checkPersonName,
  isAnnualField,
  isNumberField,
  LOCAL_DATE_PATTERN,
  MEMORY_CURATOR_CONVERSATION,
  monthDayOf,
  PersonalFileCardPayload as PersonalFileCardPayloadSchema,
  type PersonalFileCardField,
  type PersonalFileCardPayload,
  type PersonalFileCardRemind,
  PersonalFileExecuteInput,
  type PersonalFileKind,
  personalFieldLabel,
  PURGED_TEXT,
  spelledNumber,
  t,
  Type,
} from "@ergo/protocol";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { RequestRejected } from "../errors.ts";
import { actionContext, defineQuickAction, foundIn, type QuickActionExecutor, type QuickActionService } from "../quick-actions/index.ts";
import type { JsonValue } from "../runtime/index.ts";
import type { PersonalFileTrail } from "./events.ts";
import { checkFieldFor, type PersonalFilesService } from "./personal-files.ts";
import { PERSONAL_FILE_ACTION } from "./tool-names.ts";

/** 一次最多写几个字段 */
const MAX_FIELDS = 20;

// @i18n-ignore-start model：参数说明（给秘书）
const Params = Type.Object(
  {
    person: Type.String({
      minLength: 1,
      description: "谁的档案：用户本人写\"我\"；别人写用户对他的称呼（\"妈妈\"\"小张\"），档案里已有的按称呼或别名找，没有的确认后新建一份",
    }),
    relation: Type.Optional(Type.String({ description: "新建别人的档案时：和用户的关系（\"母亲\"\"表弟\"\"同事\"）" })),
    fields: Type.Optional(
      Type.Array(
        Type.Object({ field: Type.String({ minLength: 1 }), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        {
          maxItems: MAX_FIELDS,
          description:
            "要写的固定信息，每项 {field, value}。field 写字段名——本人：姓名、身份证号、护照号、驾照号、生日、纪念日、手机、邮箱、住址、单位和职位、过敏和用药；" +
            "别人：别名、和我的关系、生日、纪念日、电话、住址、单位或学校、过敏和用药；纪念日可以有几个，写带名字的（\"结婚纪念日\"）；别的写一个自定义的名字（\"车牌号\"）。" +
            "value 照抄用户原话里的值，号码一位都不能改；同一字段的新值会把旧值记成历史",
        },
      ),
    ),
    note: Type.Optional(Type.String({ description: "用户特意要记下的一件事（\"我妈腿脚不好，爬楼吃力\"），尽量照抄原话" })),
    noteDate: Type.Optional(Type.String({ pattern: LOCAL_DATE_PATTERN, description: "那件事的日期 YYYY-MM-DD；不给是今天" })),
  },
  { additionalProperties: false },
);
// @i18n-ignore-end

/** 规范化后的动作（存进卡片和操作记录的参数，执行时原样交回） */
interface PersonalFileParams {
  /** 已有的档案（新建的没有） */
  personId?: string;
  /** 卡上写的"谁"：本人写"我"，别人写称呼 */
  person: string;
  kind: PersonalFileKind;
  isNew: boolean;
  relation?: string;
  fields: PersonalFileCardField[];
  note?: { text: string; date: string };
  /** 283：生日、纪念日的每年提醒（核对卡上默认勾着的） */
  remind?: PersonalFileCardRemind[];
  /** 283：用户在核对卡上勾了的每年提醒（确认时才有；没有就照 remind 默认的） */
  chosen?: Array<{ field: string; daysBefore: number }>;
}

/** 卡上"写了什么"那一截：字段名，记下一件事 */
function whatOf(p: Pick<PersonalFileParams, "fields" | "note">): string {
  const parts = [...p.fields.map((f) => f.label), ...(p.note ? [t("personalFiles.action.note")] : [])];
  return parts.join(t("personalFiles.action.sep"));
}

/** "提前 3 天" / "当天" */
const daysText = (days: number) => (days === 0 ? t("personalFiles.action.sameDay") : t("personalFiles.action.daysBefore", { count: days }));

/**
 * 302：回执（执行结果）后面写明这次建了的每年提醒："已建每年提醒（提前 3 天），档案页可改可关"；几个字段的写出各是哪个
 * （"已建每年提醒：生日提前 3 天、结婚纪念日当天，档案页可改可关"）
 */
function remindedText(p: Pick<PersonalFileParams, "fields">, reminded: ReadonlyArray<{ field: string; daysBefore: number }>): string | undefined {
  if (reminded.length === 0) return undefined;
  if (reminded.length === 1) return t("personalFiles.action.reminded", { days: daysText(reminded[0]!.daysBefore) });
  const labelOf = (field: string) => p.fields.find((f) => f.field === field)?.label ?? field;
  const list = reminded.map((r) => t("personalFiles.action.remindedItem", { label: labelOf(r.field), days: daysText(r.daysBefore) })).join(t("personalFiles.action.sep"));
  return t("personalFiles.action.remindedFields", { list });
}

/** 卡片负载 → 执行时的参数（核对卡上存的就是规范化后的动作） */
function paramsOfCard(p: PersonalFileCardPayload): PersonalFileParams {
  return {
    ...(p.person.id === undefined ? {} : { personId: p.person.id }),
    person: p.person.name,
    kind: p.person.kind,
    isNew: p.person.isNew,
    ...(p.person.relation === undefined ? {} : { relation: p.person.relation }),
    fields: p.fields,
    ...(p.note === undefined ? {} : { note: p.note }),
    ...(p.remind === undefined ? {} : { remind: p.remind }),
  };
}

/** 283：这份档案的这个字段开着每年提醒没有 */
function hasReminder(files: PersonalFilesService, personId: string, field: string): boolean {
  return files.file(personId)?.fields.find((f) => f.field === field)?.annual?.daysBefore !== undefined;
}

export function personalFileAction(files: PersonalFilesService): QuickActionExecutor {
  return defineQuickAction({
    type: PERSONAL_FILE_ACTION,
    get title() {
      return t("personalFiles.action.title");
    },
    // @i18n-ignore-next model：给秘书的用法
    usage: "用户要记下自己或身边重要的人的固定信息（证件号、生日、电话、住址、单位、过敏用药……）或者特意要记的一件事：写进个人档案。号码会出卡请用户逐位核对；原话里明说了的直接写",
    params: Params,
    // 写的是用户自己的档案，不落入任何关注类别；推断出来的一律先问，号码、新建的人在 explicit 里算没点明（总要核对）
    watch: { categories: [] },
    confirm: "ask_when_inferred",
    normalize({ person, relation, fields = [], note, noteDate }) {
      // @i18n-ignore-start model：交回秘书的出错说明
      if (fields.length === 0 && note === undefined) throw new Error("fields（要写的字段）和 note（记下的事）至少给一样");
      const found = files.find(person);
      let kind: PersonalFileKind;
      let name: string;
      let rel: string | undefined;
      if (found) {
        kind = found.kind;
        name = found.kind === "self" ? t("personalFiles.self") : (found.name ?? person.trim());
      } else {
        const checked = checkPersonName(person);
        if (!checked.ok) throw new Error(`person：${checked.error}`);
        kind = "person";
        name = checked.value;
        if (relation !== undefined && relation.trim() !== "") {
          const r = checkPersonalValue("relation", relation);
          if (!r.ok) throw new Error(`relation：${r.error}`);
          rel = r.value;
        }
      }
      const byField = new Map<string, PersonalFileCardField>();
      for (const { field: rawField, value: rawValue } of fields) {
        // 302：带上这份档案已有的字段认（283 时建的同名自定义纪念日接着写）
        const field = files.fieldOf(found?.id, kind, rawField);
        if (field === undefined) throw new Error(`认不出字段「${rawField}」`);
        if (!found && field === "name") throw new Error("新建的人的称呼写在 person 里，不用再写进 fields");
        const label = personalFieldLabel(kind, field);
        const value = checkFieldFor(kind, field, rawValue);
        if (!value.ok) throw new Error(`${label}：${value.error}`);
        const previous = found ? files.currentValue(found.id, field) : undefined;
        if (previous === value.value) continue;
        byField.set(field, { field, label, value: value.value, number: isNumberField(field, value.value), ...(previous === undefined ? {} : { previous }) });
      }
      let checkedNote: { text: string; date: string } | undefined;
      if (note !== undefined) {
        const text = checkPersonalNote(note);
        if (!text.ok) throw new Error(`note：${text.error}`);
        checkedNote = { text: text.value, date: noteDate ?? files.today() };
      }
      if (byField.size === 0 && checkedNote === undefined) throw new RequestRejected("bad_params", "档案里已经是这些值了，不用再写");
      // @i18n-ignore-end
      // 283：生日、纪念日一起开每年提醒（值认得出公历日子、提醒插件在、还没开过）：核对卡上默认勾着，直接写的直接开（302）
      const remind: PersonalFileCardRemind[] = [];
      if (files.remindersOn()) {
        for (const f of byField.values()) {
          const date = isAnnualField(f.field) ? monthDayOf(f.value) : undefined;
          if (date === undefined || (found && hasReminder(files, found.id, f.field))) continue;
          remind.push({ field: f.field, label: f.label, month: date.month, day: date.day, daysBefore: ANNUAL_REMINDER_DEFAULT_DAYS });
        }
      }
      const params: PersonalFileParams = {
        ...(found ? { personId: found.id } : {}),
        person: name,
        kind,
        isNew: !found,
        ...(rel === undefined ? {} : { relation: rel }),
        fields: [...byField.values()],
        ...(checkedNote === undefined ? {} : { note: checkedNote }),
        ...(remind.length === 0 ? {} : { remind }),
      };
      const content = [...params.fields.map((f) => t("personalFiles.action.fieldLine", { label: f.label, value: f.value })), ...(checkedNote ? [checkedNote.text] : [])].join(t("personalFiles.action.contentSep"));
      return { params: params as unknown as JsonValue, title: t("personalFiles.action.cardTitle", { person: name, what: whatOf(params) }), target: name, content };
    },
    explicit(action, turn) {
      const p = action.params as unknown as PersonalFileParams;
      // 号码类、新建一个人：总要用户核对
      if (p.isNew || p.fields.some((f) => f.number)) return undefined;
      let finding: ReturnType<typeof foundIn>;
      for (const piece of [...p.fields.map((f) => f.value), ...(p.note ? [p.note.text] : [])]) {
        const found = foundIn(turn, piece);
        // 只认用户自己说的话（打的字、语音转写）：引用块、引用的卡片里的不算用户要记的
        if (!found || (found.source !== "typed" && found.source !== "voice")) return undefined;
        finding ??= found;
      }
      return finding;
    },
    proposalCard(action, context) {
      const p = action.params as unknown as PersonalFileParams;
      const payload: PersonalFileCardPayload = {
        actionId: context.actionId,
        conversation: context.conversation,
        ...(context.inputMessageId === undefined ? {} : { inputMessageId: context.inputMessageId }),
        ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
        title: action.title,
        person: { ...(p.personId === undefined ? {} : { id: p.personId }), name: p.person, kind: p.kind, isNew: p.isNew, ...(p.relation === undefined ? {} : { relation: p.relation }) },
        fields: p.fields,
        ...(p.note === undefined ? {} : { note: p.note }),
        ...(p.remind === undefined ? {} : { remind: p.remind }),
      };
      return { type: "personal_file", payload, inboxTitle: t("personalFiles.card.inboxTitle") };
    },
    execute(params, context) {
      const p = params as PersonalFileParams;
      const trail: PersonalFileTrail = {
        // 284 号票：记忆管理员在了解你访谈里提的（卡在它的会话里），留痕写"记忆管理员提议、用户确认的"
        via: context.conversation === MEMORY_CURATOR_CONVERSATION ? "curator" : "secretary",
        basis: context.basis,
        ...(context.inputMessageId === undefined ? {} : { messageId: context.inputMessageId }),
        actionId: context.actionId,
        cardId: context.cardId,
        conversation: context.conversation,
      };
      const person = p.isNew || p.personId === undefined ? { newName: p.person, ...(p.relation === undefined ? {} : { relation: p.relation }) } : { id: p.personId };
      // 283：核对卡上确认的照勾着的建每年提醒（没带勾的照卡上默认的）；302：原话里明说了、直接写的照默认的直接建（回执写明）
      const reminders = p.chosen ?? (p.remind ?? []).map((r) => ({ field: r.field, daysBefore: r.daysBefore }));
      const prepared = files.prepareWrite({ person, fields: p.fields.map((f) => ({ field: f.field, value: f.value })), ...(p.note === undefined ? {} : { note: p.note }), reminders, trail });
      const done = prepared.changed.length === 0 ? t("personalFiles.action.unchanged", { person: p.person }) : t("personalFiles.action.done", { person: p.person, what: whatOf(p) });
      const reminded = remindedText(p, prepared.reminded);
      const summary = reminded === undefined ? done : t("personalFiles.action.doneReminded", { done, reminded });
      return { events: prepared.events, summary, ...(prepared.afterCommit === undefined ? {} : { afterCommit: prepared.afterCommit }) };
    },
  });
}

/** 纯文本降级：标题，每个字段一行（号码另写一位一位的），记下的事，结果 */
function cardText(p: PersonalFileCardPayload): string {
  const lines = [p.title];
  if (p.person.isNew) lines.push(p.person.relation === undefined ? t("personalFiles.card.newPerson", { name: p.person.name }) : t("personalFiles.card.newPersonRelation", { name: p.person.name, relation: p.person.relation }));
  for (const f of p.fields) {
    lines.push(f.number && f.value !== PURGED_TEXT ? t("personalFiles.card.numberLine", { label: f.label, value: f.value, digits: spelledNumber(f.value) }) : t("personalFiles.action.fieldLine", { label: f.label, value: f.value }));
  }
  if (p.note) lines.push(t("personalFiles.card.noteLine", { date: p.note.date, text: p.note.text }));
  for (const r of p.remind ?? []) lines.push(t("personalFiles.card.remindLine", { label: r.label, count: r.daysBefore }));
  if (p.result !== undefined) lines.push(p.result);
  return lines.join("\n");
}

/**
 * 个人档案的核对卡（卡片类型 personal_file）："确认写入"按卡上存的规范化动作由运行时写进档案（经快速动作服务：执行器的事件加操作记录，
 * 和卡片更新同一事务）；"取消"关掉。彻底删除时卡上的值、记下的事、称呼、结果都换成删除标记（字段名留着），
 * 每年提醒的勾带着生日、纪念日的月日，整个去掉（302 号票；284 的访谈核对卡同样）。
 * 版本 2（283 号票）：生日、纪念日带着每年提醒的勾，"确认写入"带上勾了哪几条、各提前几天（不带照卡上默认的建）
 */
export function personalFileCardType(quickActions: QuickActionService) {
  return defineCardType({
    type: "personal_file",
    version: 2,
    payload: PersonalFileCardPayloadSchema,
    actions: {
      execute: {
        input: Type.Union([PersonalFileExecuteInput, Type.Undefined()]),
        run: ({ card, payload, input }): CardActionEffect<PersonalFileCardPayload> => {
          const executor = quickActions.registry.get(PERSONAL_FILE_ACTION);
          if (!executor) throw new RequestRejected("not_allowed", t("quickActions.unknownType", { type: PERSONAL_FILE_ACTION }));
          // 283：勾了的每年提醒（只认卡上列着的字段）
          const offered = new Set((payload.remind ?? []).map((r) => r.field));
          const params: PersonalFileParams = { ...paramsOfCard(payload), ...(input?.remind === undefined ? {} : { chosen: input.remind.filter((r) => offered.has(r.field)) }) };
          const outcome = quickActions.execute(executor, params, actionContext(card, payload), payload.title);
          return {
            status: "handled",
            payload: { ...payload, result: outcome.summary },
            events: outcome.events,
            ...(outcome.afterCommit === undefined ? {} : { afterCommit: outcome.afterCommit }),
          };
        },
      },
      cancel: { input: undefined, run: () => ({ status: "dismissed" }) },
    },
    toText: cardText,
    purge: ({ remind: _remind, ...p }) => ({
      ...p,
      title: t("personalFiles.card.purgedTitle", { purged: PURGED_TEXT }),
      person: { ...p.person, name: PURGED_TEXT, ...(p.person.relation === undefined ? {} : { relation: PURGED_TEXT }) },
      fields: p.fields.map((f) => ({ ...f, value: PURGED_TEXT, ...(f.previous === undefined ? {} : { previous: PURGED_TEXT }) })),
      ...(p.note === undefined ? {} : { note: { ...p.note, text: PURGED_TEXT } }),
      ...(p.result === undefined ? {} : { result: PURGED_TEXT }),
    }),
  });
}
