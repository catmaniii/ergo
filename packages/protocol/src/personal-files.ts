// 个人档案（281 号票，用户 2026-10-25 定："每个人单独建立一个档案库……对我自己，我重要的一些人会专门记一些重要的事情"）：
// 用户本人和用户身边重要的人各一份，分三块——固定信息（字段：值，一字不差、以最新为准，旧值留作历史）、用户特意要记的事、
// 二狗了解到的（283 号票：从统一记忆现取，只读）。写进去的都经用户确认过；推断出来的只能当候选。本人那份的姓名就是"我的名字"。
// 档案放内核（停用记忆插件也不丢），守护进程在 daemon/src/personal-files/。这里是两边共用的规矩（不引用 TypeBox；
// 接口、卡片的 schema 在 personal-files-schema.ts）：有哪些字段、叫什么、哪些算号码（核对卡上一位一位列出）、值合不合规。
// 283 号票加了：哪些字段每年要提醒（生日、纪念日）、值里认出公历的某月某日、哪些字段的值不进发给模型的整理提示（号码类、住址）。
// 302 号票加了内置字段"纪念日"：能有几个、各带名字（字段编号 "anniversary:<名字>"），档案页上排在生日后面；一个都没有时列一个空的
// "纪念日"（编号 "anniversary"，只占位置、不存值）。283 认"名字带纪念日的自定义字段"的规矩照旧。
// 285 号票加了分组：档案里的人（本人以外）分家人、重要的人、其他人三组；建人时选、能改，没选的按"和我的关系"猜（guessPersonGroup）。
import { t, tTable } from "./i18n/runtime.ts";
import { isMonthDay, type MonthDay } from "./reminder-schedule.ts";

/** 本人那份档案的编号（一直在，不用建） */
export const SELF_PERSON_ID = "me";

/** 本人默认有的字段（按显示的先后）；姓名就是"我的名字"（同一个来源，不另存一份） */
export const SELF_FIELDS = ["name", "id_card", "passport", "driver_license", "birthday", "anniversary", "phone", "email", "address", "work", "health"] as const;

/** 重要的人默认有的字段（按显示的先后）：称呼是这个人在档案里的名字 */
export const PERSON_FIELDS = ["name", "aliases", "relation", "birthday", "anniversary", "phone", "address", "work", "health"] as const;

export type PersonalFileKind = "self" | "person";

/** 号码类字段：核对卡上一位一位列出、不论点没点明都要用户核对一遍（以后安全阶段再接默认打码） */
export const NUMBER_FIELDS: readonly string[] = ["id_card", "passport", "driver_license", "phone"];

/** 自定义字段的编号：前缀加用户起的名字（"custom:车牌号"） */
export const CUSTOM_FIELD_PREFIX = "custom:";

/**
 * 内置字段"纪念日"（302 号票）在字段表里占的位置：一个纪念日都没有时档案页列一个空的"纪念日"，有了就换成那几个。它自己不存值——
 * 写"纪念日"写进名字就叫"纪念日"的那一个（anniversaryFieldOf）
 */
export const ANNIVERSARY_FIELD = "anniversary";
/** 一个纪念日的编号：前缀加名字（"anniversary:结婚纪念日"）；能有几个 */
export const ANNIVERSARY_FIELD_PREFIX = "anniversary:";

/** 一个字段的值最多几个字 */
export const PERSONAL_FIELD_VALUE_MAX = 200;
/** 记下的一件事最多几个字 */
export const PERSONAL_NOTE_MAX = 1000;
/** 重要的人的称呼最多几个字 */
export const PERSONAL_NAME_MAX = 20;
/** 自定义字段的名字最多几个字 */
export const CUSTOM_FIELD_LABEL_MAX = 20;
/** 自定义字段的值里有这么多位数字就当号码（逐位核对） */
export const NUMBER_MIN_DIGITS = 6;

const SELF_FIELD_LABEL: Readonly<Record<(typeof SELF_FIELDS)[number], string>> = tTable({
  name: "protocol.personalFiles.field.selfName",
  id_card: "protocol.personalFiles.field.idCard",
  passport: "protocol.personalFiles.field.passport",
  driver_license: "protocol.personalFiles.field.driverLicense",
  birthday: "protocol.personalFiles.field.birthday",
  anniversary: "protocol.personalFiles.field.anniversary",
  phone: "protocol.personalFiles.field.selfPhone",
  email: "protocol.personalFiles.field.email",
  address: "protocol.personalFiles.field.address",
  work: "protocol.personalFiles.field.selfWork",
  health: "protocol.personalFiles.field.health",
});

const PERSON_FIELD_LABEL: Readonly<Record<(typeof PERSON_FIELDS)[number], string>> = tTable({
  name: "protocol.personalFiles.field.personName",
  aliases: "protocol.personalFiles.field.aliases",
  relation: "protocol.personalFiles.field.relation",
  birthday: "protocol.personalFiles.field.birthday",
  anniversary: "protocol.personalFiles.field.anniversary",
  phone: "protocol.personalFiles.field.personPhone",
  address: "protocol.personalFiles.field.address",
  work: "protocol.personalFiles.field.personWork",
  health: "protocol.personalFiles.field.health",
});

/** 秘书（模型）写字段名时常用的别的说法（中文原话，按字认，不随界面语言变） */
// @i18n-ignore-start data：认模型写的中文字段名
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  名字: "name",
  姓名: "name",
  称呼: "name",
  身份证: "id_card",
  身份证号码: "id_card",
  护照: "passport",
  护照号码: "passport",
  驾照: "driver_license",
  驾驶证: "driver_license",
  驾驶证号: "driver_license",
  手机号: "phone",
  手机号码: "phone",
  电话号码: "phone",
  电话: "phone",
  手机: "phone",
  邮件: "email",
  电子邮箱: "email",
  地址: "address",
  家庭住址: "address",
  单位: "work",
  职位: "work",
  学校: "work",
  工作: "work",
  过敏: "health",
  用药: "health",
  别名: "aliases",
  关系: "relation",
};
// @i18n-ignore-end

/** 这份档案默认有的字段 */
export function builtinFields(kind: PersonalFileKind): readonly string[] {
  return kind === "self" ? SELF_FIELDS : PERSON_FIELDS;
}

export function isBuiltinField(kind: PersonalFileKind, field: string): boolean {
  return builtinFields(kind).includes(field);
}

/** 自定义字段的编号 */
export function customFieldOf(label: string): string {
  return `${CUSTOM_FIELD_PREFIX}${label.trim()}`;
}

/** 自定义字段用户起的名字；不是自定义字段是 undefined */
export function customLabelOf(field: string): string | undefined {
  return field.startsWith(CUSTOM_FIELD_PREFIX) ? field.slice(CUSTOM_FIELD_PREFIX.length) : undefined;
}

/** 一个纪念日的编号（302 号票） */
export function anniversaryFieldOf(name: string): string {
  return `${ANNIVERSARY_FIELD_PREFIX}${name.trim()}`;
}

/** 一个纪念日的名字（"结婚纪念日"）；不是纪念日（包括占位置的那个空的"纪念日"）是 undefined */
export function anniversaryNameOf(field: string): string | undefined {
  return field.startsWith(ANNIVERSARY_FIELD_PREFIX) ? field.slice(ANNIVERSARY_FIELD_PREFIX.length) : undefined;
}

/** 属于内置的"纪念日"：一个纪念日，或者一个都没有时占位置的那个空的 */
export function isAnniversaryField(field: string): boolean {
  return field === ANNIVERSARY_FIELD || anniversaryNameOf(field) !== undefined;
}

/**
 * 一份档案按什么先后列字段：默认的（没填的也列；"纪念日"那一格换成已有的几个纪念日，一个都没有列空的），然后是自定义的。
 * present 是这份档案里有值的字段（按第一次写的先后）
 */
export function personalFieldOrder(kind: PersonalFileKind, present: Iterable<string>): string[] {
  const fields = [...new Set(present)];
  const anniversaries = fields.filter((f) => anniversaryNameOf(f) !== undefined);
  const others = fields.filter((f) => !isBuiltinField(kind, f) && anniversaryNameOf(f) === undefined);
  const builtin = builtinFields(kind).flatMap((f) => (f === ANNIVERSARY_FIELD && anniversaries.length > 0 ? anniversaries : [f]));
  return [...builtin, ...others];
}

/** 字段给人看的名字（本人的"姓名""手机""单位和职位"，重要的人的"称呼""电话""单位或学校"；自定义的、纪念日是起的名字） */
export function personalFieldLabel(kind: PersonalFileKind, field: string): string {
  const custom = customLabelOf(field) ?? anniversaryNameOf(field);
  if (custom !== undefined) return custom;
  if (kind === "self" && Object.hasOwn(SELF_FIELD_LABEL, field)) return SELF_FIELD_LABEL[field as keyof typeof SELF_FIELD_LABEL];
  if (kind === "person" && Object.hasOwn(PERSON_FIELD_LABEL, field)) return PERSON_FIELD_LABEL[field as keyof typeof PERSON_FIELD_LABEL];
  return field;
}

/** 自定义字段、纪念日的名字合不合规：不能是空的、不能太长、不能有控制字符 */
const validLabel = (label: string) => label.trim() !== "" && [...label.trim()].length <= CUSTOM_FIELD_LABEL_MAX && !/[\p{Cc}]/u.test(label);

/**
 * 秘书、页面写的字段名认成字段编号：默认字段的编号或名字（当前语言的、别的说法）认成那个字段；"custom:" 开头的原样；
 * 别的当作自定义字段的名字。名字不合规（空的、太长）是 undefined。
 * 302 号票：内置的"纪念日"——写"纪念日"（编号、名字）认成名字就叫"纪念日"的那一个，"anniversary:" 开头的原样，名字里带"纪念日"的
 * （"结婚纪念日"）认成叫这个名字的纪念日；existing 是这份档案已有的字段：283 时已经建了同名的自定义字段（"custom:结婚纪念日"）
 * 而还没有这个纪念日的，接着写那个自定义字段，不另起一个
 */
export function personalFieldOf(kind: PersonalFileKind, raw: string, existing: readonly string[] = []): string | undefined {
  const name = raw.trim();
  if (name === "") return undefined;
  const anniversary = (label: string) => {
    const id = anniversaryFieldOf(label);
    return !existing.includes(id) && existing.includes(customFieldOf(label)) ? customFieldOf(label) : id;
  };
  if (name === ANNIVERSARY_FIELD) return anniversary(personalFieldLabel(kind, ANNIVERSARY_FIELD));
  if (isBuiltinField(kind, name)) return name;
  const byLabel = builtinFields(kind).find((f) => personalFieldLabel(kind, f) === name);
  if (byLabel !== undefined) return byLabel === ANNIVERSARY_FIELD ? anniversary(name) : byLabel;
  const alias = FIELD_ALIASES[name];
  if (alias !== undefined && isBuiltinField(kind, alias)) return alias;
  const named = anniversaryNameOf(name);
  if (named !== undefined) return validLabel(named) ? anniversary(named) : undefined;
  const custom = customLabelOf(name);
  const label = custom ?? name;
  if (!validLabel(label)) return undefined;
  if (custom === undefined && ANNIVERSARY_LABEL.test(label)) return anniversary(label);
  return customFieldOf(label);
}

const digitCount = (value: string) => (value.match(/\d/g) ?? []).length;

/**
 * 算不算号码（核对卡上逐位列出、一定要用户核对）：号码类字段，或者自定义字段里有 6 位以上数字。
 * 283 号票：名字里带"生日""纪念日"的自定义字段是日子（"2018年10月1日"也有 7 位数字），不算号码
 */
export function isNumberField(field: string, value: string): boolean {
  if (NUMBER_FIELDS.includes(field)) return true;
  return customLabelOf(field) !== undefined && !isAnnualField(field) && digitCount(value) >= NUMBER_MIN_DIGITS;
}

/**
 * 号码一位一位列出时怎么分组（空白不算一位）：18 位的身份证号 6 · 8 · 4（地区、出生日期、顺序码和校验码），
 * 11 位的手机号 3 · 4 · 4，别的每 4 位一组
 */
export function numberGroups(value: string): string[][] {
  const chars = [...value.replace(/\s+/g, "")];
  const sizes = /^\d{17}[\dXx]$/.test(chars.join("")) ? [6, 8, 4] : /^1\d{10}$/.test(chars.join("")) ? [3, 4, 4] : [];
  const groups: string[][] = [];
  let at = 0;
  for (const size of sizes) {
    groups.push(chars.slice(at, at + size));
    at += size;
  }
  for (; at < chars.length; at += 4) groups.push(chars.slice(at, at + 4));
  return groups;
}

/** 号码写成一位一位的一行（纯文本降级、读屏用）："1 1 0 1 0 1 · 1 9 9 0 …" */
export function spelledNumber(value: string): string {
  return numberGroups(value)
    .map((g) => g.join(" "))
    .join(" · ");
}

export type PersonalValueCheck = { ok: true; value: string } | { ok: false; error: string };

/**
 * 一个字段的值合不合规，合规时给出要存的样子：去掉首尾空白；号码类字段去掉中间的空白（"138 0000 1111" 存成 "13800001111"），
 * 身份证号、护照号的字母写成大写；不能是空的、不能太长、不能有换行和控制字符
 */
export function checkPersonalValue(field: string, raw: string): PersonalValueCheck {
  let value = raw.trim();
  if (NUMBER_FIELDS.includes(field)) value = value.replace(/\s+/g, "");
  if (field === "id_card" || field === "passport") value = value.toUpperCase();
  if (value === "") return { ok: false, error: t("protocol.personalFiles.error.empty") };
  if ([...value].length > PERSONAL_FIELD_VALUE_MAX) return { ok: false, error: t("protocol.personalFiles.error.tooLong", { max: PERSONAL_FIELD_VALUE_MAX }) };
  if (/[\p{Cc}\u2028\u2029]/u.test(value)) return { ok: false, error: t("protocol.personalFiles.error.lineBreak") };
  return { ok: true, value };
}

/** 记下的一件事合不合规：去掉首尾空白，不能是空的、不能太长（可以有换行） */
export function checkPersonalNote(raw: string): PersonalValueCheck {
  const value = raw.trim();
  if (value === "") return { ok: false, error: t("protocol.personalFiles.error.emptyNote") };
  if ([...value].length > PERSONAL_NOTE_MAX) return { ok: false, error: t("protocol.personalFiles.error.noteTooLong", { max: PERSONAL_NOTE_MAX }) };
  return { ok: true, value };
}

/** 重要的人的称呼合不合规：去掉首尾空白，1–20 个字，不能有换行和控制字符 */
export function checkPersonName(raw: string): PersonalValueCheck {
  const value = raw.trim();
  if (value === "") return { ok: false, error: t("protocol.personalFiles.error.emptyName") };
  if ([...value].length > PERSONAL_NAME_MAX) return { ok: false, error: t("protocol.personalFiles.error.nameTooLong", { max: PERSONAL_NAME_MAX }) };
  if (/[\p{Cc}\u2028\u2029]/u.test(value)) return { ok: false, error: t("protocol.personalFiles.error.lineBreak") };
  return { ok: true, value };
}

// ---------- 283 号票：生日、纪念日的每年提醒；不进整理提示的字段 ----------

/** 生日、纪念日的每年提醒默认提前几天（核对卡上的勾、档案页上的开关默认这个数） */
export const ANNUAL_REMINDER_DEFAULT_DAYS = 3;
/** 最多提前几天 */
export const ANNUAL_REMINDER_MAX_DAYS = 30;
/** 每年提醒在那一天几点响（本地时间） */
export const ANNUAL_REMINDER_TIME = "09:00";

/** 自定义字段的名字里带这些字的算每年要记着的日子（"结婚纪念日""女儿生日"） */
// @i18n-ignore-next data：认用户起的中文字段名
const ANNUAL_LABEL = /生日|纪念日|birthday|anniversary/iu;

/** 302 号票：秘书写的字段名里带这些字的认成内置"纪念日"里的一个（"结婚纪念日"） */
// @i18n-ignore-next data：认模型写的中文字段名
const ANNIVERSARY_LABEL = /纪念日|anniversary/iu;

/** 农历的写法：认出来就不当公历的日子（282 号票只做了公历每年） */
// @i18n-ignore-next data：认用户写的中文"农历"
const LUNAR = /农历|阴历|旧历|lunar/iu;

/** 这个字段是不是每年要提醒的日子：生日，纪念日（302 号票的内置字段，每一个），名字里带"生日""纪念日"的自定义字段 */
export function isAnnualField(field: string): boolean {
  if (field === "birthday" || anniversaryNameOf(field) !== undefined) return true;
  const label = customLabelOf(field);
  return label !== undefined && ANNUAL_LABEL.test(label);
}

/**
 * 值里认出公历的某月某日（生日、纪念日建每年提醒用）："3月2日""3 月 2 号""1990年3月2日""1990-03-02""1990/3/2""03-02"。
 * 写的是农历、认不出、日历上没有这一天（2 月 30 日）都是 undefined（2 月 29 日算有：闰年有）
 */
export function monthDayOf(value: string): MonthDay | undefined {
  const text = value.replace(/\s+/g, "");
  if (LUNAR.test(text)) return undefined;
  // @i18n-ignore-start data：认用户写的中文日期
  const match =
    /(?:^|[^\d])\d{4}[-/.年](\d{1,2})[-/.月](\d{1,2})(?:[日号]|$|[^\d])/u.exec(text) ??
    /(?:^|[^\d])(\d{1,2})月(\d{1,2})[日号]?(?:$|[^\d])/u.exec(text) ??
    /^(\d{1,2})[-/.](\d{1,2})$/u.exec(text);
  // @i18n-ignore-end
  if (!match) return undefined;
  const date = { month: Number(match[1]), day: Number(match[2]) };
  return isMonthDay(date) ? date : undefined;
}

/**
 * 这个字段的值发给模型的整理提示里不带（283 号票，第二阶段计划"号码类字段不进夜里的整理提示"）：号码类（证件号、电话、
 * 自定义字段里带一串数字的）和住址（门牌）。档案摘要里不列它们；夜里整理发给模型的每个请求里，出现了它们的值就换成占位
 */
export function withheldFromModel(field: string, value: string): boolean {
  return isNumberField(field, value) || field === "address";
}

// ---------- 285 号票：档案里的人分组 ----------

/**
 * 档案里的人（本人以外）分三组：家人、重要的人、其他人（用户 2026-10-25："既有我的档案，也有家人的档案，还有其他比较重要的档案，
 * 也可以有其他人的档案"）。本人那份不分组，列表上单独一组"我"
 */
export const PERSON_GROUPS = ["family", "important", "others"] as const;
export type PersonGroup = (typeof PERSON_GROUPS)[number];

export function isPersonGroup(s: unknown): s is PersonGroup {
  return typeof s === "string" && (PERSON_GROUPS as readonly string[]).includes(s);
}

/** "和我的关系"里算家人的写法：父母、配偶、子女、兄弟姐妹，连同祖辈、孙辈、公婆岳父母（按字认，不随界面语言变） */
// @i18n-ignore-start data：认用户写的中文关系
const FAMILY_RELATIONS: ReadonlySet<string> = new Set([
  "父母", "父亲", "母亲", "爸爸", "妈妈", "爸", "妈", "老爸", "老妈", "爹", "娘",
  "配偶", "妻子", "丈夫", "老婆", "老公", "爱人", "太太", "媳妇", "夫人",
  "子女", "孩子", "儿子", "女儿", "儿女",
  "兄弟姐妹", "兄弟", "姐妹", "哥哥", "姐姐", "弟弟", "妹妹", "哥", "姐", "弟", "妹",
  "爷爷", "奶奶", "外公", "外婆", "姥爷", "姥姥", "祖父", "祖母", "孙子", "孙女", "外孙", "外孙女",
  "公公", "婆婆", "岳父", "岳母", "丈人", "丈母娘",
  "parent", "parents", "father", "mother", "dad", "mom", "mum", "spouse", "wife", "husband", "partner",
  "child", "children", "son", "daughter", "kid", "sibling", "brother", "sister",
  "grandfather", "grandmother", "grandpa", "grandma", "grandson", "granddaughter",
]);
/** 关系前面可以带的：我、我的；排行、"亲"（"我妈""大女儿""二哥""亲姐姐"） */
const RELATION_OWNER = /^(我的|我)/u;
const RELATION_RANK = /^(亲|大|二|三|四|五|小|老)+/u;
// @i18n-ignore-end

/**
 * 没选分组的人按"和我的关系"猜（285 号票）：父母、配偶、子女、兄弟姐妹等归家人，猜不出的（同事、朋友、表亲、没写关系）归其他人。
 * 猜不会猜成"重要的人"——那一组只由用户选。283 的"提议建档"、秘书经快速动作建的人都没选分组，照这里猜
 */
export function guessPersonGroup(relation: string | undefined): Exclude<PersonGroup, "important"> {
  const text = (relation ?? "").trim().toLowerCase().replace(RELATION_OWNER, "");
  if (text === "") return "others";
  if (FAMILY_RELATIONS.has(text)) return "family";
  const core = text.replace(RELATION_RANK, "");
  return core !== "" && FAMILY_RELATIONS.has(core) ? "family" : "others";
}
