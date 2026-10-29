// 从解析出的联系人（vcard.ts）整理出要交给个人档案候选的人（301 号票）：谁进、进哪几样、关系怎么认。纯函数，不碰事件、不碰档案。
// 一份 Google 通讯录可能几百人，大半只是存了个电话——个人档案是本人和重要的人的，所以只取：
// - 用户自己的那张（称呼或昵称就是"我的名字"）：生日、纪念日、电话、住址进本人那份；它上面的"相关的人"（Google 的关系、X-ABRELATEDNAMES、
//   RELATED）就是用户的家人朋友——那些人带着"和我的关系"进来（有卡片的合上卡片上的生日、电话）；
// - 档案里已经有的人（按称呼、别名对上卡片的称呼、昵称）：卡片上有的几样都进（和档案里一样的由候选那一层去掉）；
// - 别的人：有生日、纪念日、关系的才进；只有电话、住址、邮箱的不进（算"没进候选"，导入结果里写个数）。
// 关系的方向：Google、苹果的"相关的人"写的是"这个人是卡片主人的谁"。用户自己那张上的就是"他是我的谁"，照写；别人卡片上指向用户自己
// （名字是"我的名字""我"）的只认两头一样的（配偶、伴侣、朋友、亲戚、兄弟姐妹、同事、邻居……），父母、孩子、上司这类反过来就不对、
// 自己起的名字认不出方向，不要；别人卡片上指向别人的（王小明的妻子李芳）和用户没关系，不要。
// 几个电话、几个住址：档案一个人一个，取首选（pref），没有首选的电话取手机、住址取家里的，再没有取第一个；别的几个交给候选当 also
// （档案里现在的值是其中之一就不提）。同一份文件里同一个称呼的几张卡片（Google 里重复的联系人）合成一个人。
import { anniversaryFieldOf, checkPersonName, t } from "@ergo/protocol";
import { formatVcardDate, type VcardContact, type VcardRelated, type VcardTyped } from "./vcard.ts";

/** 要交给档案候选的一个字段：also 是同一个人这个字段别的几个值 */
export interface OfferField {
  readonly field: string;
  readonly value: string;
  readonly also?: readonly string[];
}

/** 要交给档案候选的一个人 */
export interface ContactOffer {
  /** 认同一个人用（本人是 "me"，别人是称呼）：再导一次时按它比之前交过什么 */
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[];
  /** 用户自己的那张 */
  readonly self?: true;
  /** 和我的关系（给人看的，走 t()；用户起的名字原样） */
  readonly relation?: string;
  readonly fields: readonly OfferField[];
}

export interface OffersResult {
  /** 先后：本人、档案里已有的、带关系的、别的（各自按文件里的先后） */
  readonly offers: ContactOffer[];
  /** 没进候选的人数（没有生日、纪念日、关系，档案里也还没有；称呼太长的也算） */
  readonly skipped: number;
}

/** 档案这一侧：我的名字、某个叫法是不是档案里已有的人 */
export interface OfferContext {
  readonly selfName?: string;
  readonly known: (name: string) => boolean;
}

/** 名字是指用户自己的叫法（别人卡片上"相关的人"写的） */
// @i18n-ignore-next data：认 vCard 里写的中文"我"
const SELF_WORDS = new Set(["我", "我自己", "本人", "me", "myself"]);

/** 关系的类型（RELATED 的 TYPE、苹果 / Google 的标准名字、Outlook 那几种）→ 语言文件里的名字 */
const RELATION_KEYS: Readonly<Record<string, string>> = {
  spouse: "spouse",
  wife: "wife",
  husband: "husband",
  partner: "partner",
  "domestic partner": "partner",
  domestic_partner: "partner",
  child: "child",
  son: "son",
  daughter: "daughter",
  mother: "mother",
  father: "father",
  parent: "parent",
  brother: "brother",
  sister: "sister",
  sibling: "sibling",
  friend: "friend",
  relative: "relative",
  kin: "relative",
  manager: "manager",
  assistant: "assistant",
  "referred by": "referredBy",
  referred_by: "referredBy",
  colleague: "colleague",
  "co-worker": "colleague",
  coworker: "colleague",
  neighbor: "neighbor",
  acquaintance: "acquaintance",
  sweetheart: "sweetheart",
  emergency: "emergency",
};

/** 两头一样的关系（别人卡片上指向用户自己时，反过来也是这个）→ 语言文件里的名字 */
const SYMMETRIC_KEYS: Readonly<Record<string, string>> = {
  spouse: "spouse",
  wife: "spouse",
  husband: "spouse",
  partner: "partner",
  "domestic partner": "partner",
  domestic_partner: "partner",
  brother: "sibling",
  sister: "sibling",
  sibling: "sibling",
  friend: "friend",
  relative: "relative",
  kin: "relative",
  colleague: "colleague",
  "co-worker": "colleague",
  coworker: "colleague",
  neighbor: "neighbor",
  acquaintance: "acquaintance",
  sweetheart: "sweetheart",
};

const relationText = (key: string) => t(`google.contacts.relation.${key}`);

/** 用户自己那张上的一个相关的人"是我的谁"：标准的类型翻成给人看的，用户自己起的名字原样；认不出是 undefined */
function relationOf(r: VcardRelated): string | undefined {
  if (r.label !== undefined) {
    const key = RELATION_KEYS[r.label.toLowerCase()];
    if (key !== undefined) return relationText(key);
    // 苹果的别的标准名字（_$!<Other>!$_ 写成 other）不算关系
    if (r.label.toLowerCase() !== "other") return r.label;
  }
  for (const type of r.types) {
    const key = RELATION_KEYS[type];
    if (key !== undefined) return relationText(key);
  }
  return undefined;
}

/** 别人卡片上指向用户自己的相关的人：两头一样的才认 */
function symmetricOf(r: VcardRelated): string | undefined {
  for (const type of [r.label?.toLowerCase(), ...r.types]) {
    if (type === undefined) continue;
    const key = SYMMETRIC_KEYS[type];
    if (key !== undefined) return relationText(key);
  }
  return undefined;
}

/** 电话去掉空白、横线、括号、点（"138-0000 1111" 存成 "13800001111"）；+ 留着 */
// @i18n-ignore-next data：认通讯录里写的全角括号
export const cleanPhone = (raw: string) => raw.replace(/[\s\-().（）]/g, "");

const cleanAddress = (raw: string) => raw.replace(/\s+/g, " ").trim();

/** 几个值里挑一个进档案：首选，没有就按 prefer 认的那种，再没有取第一个；别的给 also */
function pick(values: readonly VcardTyped[], clean: (v: string) => string, prefer: (v: VcardTyped) => boolean): { value: string; also: string[] } | undefined {
  const seen = new Set<string>();
  const unique: Array<{ value: string; typed: VcardTyped }> = [];
  for (const typed of values) {
    const value = clean(typed.value);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    unique.push({ value, typed });
  }
  const chosen = unique.find((u) => u.typed.pref) ?? unique.find((u) => prefer(u.typed)) ?? unique[0];
  if (!chosen) return undefined;
  return { value: chosen.value, also: unique.filter((u) => u !== chosen).map((u) => u.value) };
}

// @i18n-ignore-next data：认 Google 里自己起的电话名字
const MOBILE_LABEL = /mobile|手机|移动/i;
const isMobile = (v: VcardTyped) => v.types.some((type) => type === "cell" || type === "mobile" || type === "iphone") || (v.label !== undefined && MOBILE_LABEL.test(v.label));
const isHome = (v: VcardTyped) => v.types.includes("home");

/** 一个纪念日起什么名字：没写的、标准的 Anniversary 叫"纪念日"，Other 叫"其他纪念日"，自己起的原样 */
function anniversaryName(label: string | undefined): string {
  if (label === undefined || label === "anniversary") return t("google.contacts.anniversary");
  if (label === "other") return t("google.contacts.otherDate");
  return label;
}

/** 卡片上的几样写成档案的字段：生日、纪念日（每个一格）、电话、住址 */
function fieldsOf(c: VcardContact): OfferField[] {
  const fields: OfferField[] = [];
  if (c.birthday) fields.push({ field: "birthday", value: formatVcardDate(c.birthday) });
  const anniversaries = new Set<string>();
  for (const a of c.anniversaries) {
    const field = anniversaryFieldOf(anniversaryName(a.label));
    if (anniversaries.has(field)) continue;
    anniversaries.add(field);
    fields.push({ field, value: formatVcardDate(a.date) });
  }
  const phone = pick(c.phones, cleanPhone, isMobile);
  if (phone) fields.push({ field: "phone", value: phone.value, ...(phone.also.length === 0 ? {} : { also: phone.also }) });
  const address = pick(c.addresses, cleanAddress, isHome);
  if (address) fields.push({ field: "address", value: address.value, ...(address.also.length === 0 ? {} : { also: address.also }) });
  return fields;
}

/** 同一个称呼的几张卡片合成一张：生日取第一个有的，别的几样合起来 */
function merge(a: VcardContact, b: VcardContact): VcardContact {
  const birthday = a.birthday ?? b.birthday;
  const uid = a.uid ?? b.uid;
  return {
    ...(uid === undefined ? {} : { uid }),
    name: a.name,
    nicknames: [...new Set([...a.nicknames, ...b.nicknames])],
    ...(birthday === undefined ? {} : { birthday }),
    anniversaries: [...a.anniversaries, ...b.anniversaries],
    phones: [...a.phones, ...b.phones],
    addresses: [...a.addresses, ...b.addresses],
    related: [...a.related, ...b.related],
  };
}

/** 整理一份通讯录：谁进候选、进哪几样 */
export function offersFromContacts(contacts: readonly VcardContact[], ctx: OfferContext): OffersResult {
  // 同一个称呼的合起来（先后按第一次出现）
  const byName = new Map<string, VcardContact>();
  for (const c of contacts) {
    const name = c.name.trim();
    const had = byName.get(name);
    byName.set(name, had ? merge(had, c) : { ...c, name });
  }
  const all = [...byName.values()];
  const selfName = ctx.selfName?.trim() || undefined;
  const own = selfName === undefined ? undefined : all.find((c) => c.name === selfName || c.nicknames.includes(selfName));
  const others = all.filter((c) => c !== own);
  const nameOfUid = new Map(all.flatMap((c) => (c.uid === undefined ? [] : [[c.uid, c.name] as const])));
  const refersToMe = (name: string) => SELF_WORDS.has(name.toLowerCase()) || (selfName !== undefined && name === selfName);

  // 关系：用户自己那张上的相关的人照写；别人卡片上指向用户自己的只认两头一样的
  const relations = new Map<string, string>();
  for (const r of own?.related ?? []) {
    const name = (r.name ?? (r.uid === undefined ? undefined : nameOfUid.get(r.uid)))?.trim();
    const relation = relationOf(r);
    if (name === undefined || name === "" || relation === undefined || refersToMe(name) || relations.has(name)) continue;
    relations.set(name, relation);
  }
  for (const c of others) {
    if (relations.has(c.name)) continue;
    for (const r of c.related) {
      const name = r.name ?? (r.uid === undefined ? undefined : nameOfUid.get(r.uid));
      if (name === undefined || !refersToMe(name.trim())) continue;
      const relation = symmetricOf(r);
      if (relation !== undefined) {
        relations.set(c.name, relation);
        break;
      }
    }
  }
  // 卡片的叫法 → 卡片（关系里写的可能是昵称）
  const cardOf = (name: string) => others.find((c) => c.name === name || c.nicknames.includes(name));

  let skipped = 0;
  const self: ContactOffer[] = [];
  const existing: ContactOffer[] = [];
  const related: ContactOffer[] = [];
  const rest: ContactOffer[] = [];
  if (own) {
    const fields = fieldsOf(own);
    if (fields.length > 0) self.push({ key: "me", name: own.name, aliases: [], self: true, fields });
  }
  for (const c of others) {
    const relation = relations.get(c.name) ?? c.nicknames.map((n) => relations.get(n)).find((r) => r !== undefined);
    const fields = fieldsOf(c);
    const known = ctx.known(c.name) || c.nicknames.some((n) => ctx.known(n));
    const dated = c.birthday !== undefined || c.anniversaries.length > 0;
    if (!checkPersonName(c.name).ok || (!known && !dated && relation === undefined) || (fields.length === 0 && relation === undefined)) {
      skipped += 1;
      continue;
    }
    const offer: ContactOffer = { key: c.name, name: c.name, aliases: c.nicknames.filter((n) => checkPersonName(n).ok), ...(relation === undefined ? {} : { relation }), fields };
    (known ? existing : relation !== undefined ? related : rest).push(offer);
  }
  // 用户自己那张上写了、通讯录里没有卡片的人：只带着关系进来
  for (const [name, relation] of relations) {
    // 有卡片的上面已经带着关系算过了
    if (cardOf(name) !== undefined || !checkPersonName(name).ok) continue;
    (ctx.known(name) ? existing : related).push({ key: name, name, aliases: [], relation, fields: [] });
  }
  return { offers: [...self, ...existing, ...related, ...rest], skipped };
}
