// 每晚整理时认人物信息（283 号票，个人档案和记忆联动）：从用户自己说的话里认出关于某个人的固定信息（"表弟叫小张""小张在某公司上班"
// "我妈生日 3 月 2 日"），交给守护进程攒成个人档案的候选——用户第二天在一张核对卡上逐条勾了才写进档案。推断出来的永远只当候选。
// - 只看本人说的、还有效的证据（别人转述的、助理记的、做的不看）；每条证据只看一次（person_info_log 记着看过哪条、用的哪个认法）；
// - 只认原话里明说了的：模型版交回的名字、别名、关系、字段的值都要在它引的那条证据的原文里（已知的人可以用档案里的叫法），
//   不在的丢掉；证据 id 只能是这一批的；
// - 字段只有这几样：和我的关系、别名、生日、单位或学校和职位、过敏和用药。证件号、电话、住址这类号码不认（守护进程发给模型之前也会把
//   档案里已有的号码换成占位，见 llm/guarded-chat.ts）；偏好、想法、近况不算固定信息，留在统一记忆里；
// - 只是提到、没说固定信息的人也交回来（fields 是空的），守护进程按它数"提到了几次"，够了才提议建档；
// - 说的是用户自己写"我"（守护进程对到本人那份档案）。
// 两个认法：模型版 LlmPersonInfoExtractor（线上默认，和整理同一个模型、同一份预算）、规则版 RulePersonInfoExtractor（不调模型，
// 配置 memory.extractor 写 rule 时用；只认几种常见说法）。
import type { Evidence } from "../domain/types.ts";
import type { ChatModel, ChatRequest } from "../llm/chat.ts";
import { isStringArray, parseModelJson } from "../llm/json.ts";
import type { ModelBudget } from "../rg/types.ts";
import type { MemoryStore } from "../store/store.ts";

/** 能认的固定信息：和我的关系、别名、生日、单位或学校和职位、过敏和用药（个人档案的字段编号） */
export const PERSON_INFO_FIELDS = ["relation", "aliases", "birthday", "work", "health"] as const;
export type PersonInfoField = (typeof PERSON_INFO_FIELDS)[number];

/** 用户自己（交回的名字写它） */
export const SELF_MENTION = "我";

/** 已知的人（档案里的）：认人物信息时给模型看，同一个人尽量用这里的名字 */
export interface KnownPerson {
  name: string;
  aliases: readonly string[];
  relation?: string;
  /** 用户本人 */
  self?: boolean;
}

/** 认出来的一个人：名字、原话里的别名和关系、提到他的证据、固定信息（每条带出自哪条证据） */
export interface PersonMention {
  name: string;
  aliases: string[];
  relation?: string;
  evidenceIds: string[];
  fields: { field: PersonInfoField; value: string; evidenceId: string }[];
}

export interface PersonInfoResult {
  mentions: PersonMention[];
  /** 这次看过的证据（记进 person_info_log；预算用完没看的不在里面，下一夜接着看） */
  scanned: string[];
  /** 调了几次模型 */
  calls: number;
  /** 丢掉的（原文里没有、证据 id 不对、字段不认得……） */
  dropped: { reason: string; item?: unknown }[];
}

export interface PersonInfoExtractor {
  /** 记进 person_info_log 的认法（model:<名> / rule:1） */
  readonly id: string;
  extract(evidence: readonly Evidence[], known: readonly KnownPerson[], options: { budget: ModelBudget }): Promise<PersonInfoResult>;
}

/** 名字、关系、别名最多几个字 */
const NAME_MAX = 20;
/** 字段的值最多几个字 */
const VALUE_MAX = 100;
/** 一批几条证据 */
const BATCH = 20;
/** 一条证据给模型看多少字 */
const TEXT_MAX = 300;
/** 一批的输出上限（token） */
const MAX_TOKENS = 3000;

/** 比"在不在原文里"时不看空白 */
const squash = (text: string) => text.replace(/\s+/g, "");
const inText = (text: string, piece: string) => piece.length > 0 && squash(text).includes(squash(piece));

/** 用户自己的说法 */
// @i18n-ignore-next data：认模型写的中文"我"
const SELF_NAMES = new Set(["我", "我自己", "用户", "本人", "user", "me"]);

/** 能当依据的：本人说的、还有效、有原文 */
export const canMentionPeople = (e: Evidence): boolean => e.sourceLevel === "self" && e.mode === "say" && e.status === "active" && e.text.trim().length > 0;

/**
 * 还没看过的证据（本人说的、有效的），按知道的时间先后。since 给了只看那以后知道的（第一次跑时不把几个月前的话全翻一遍）
 */
export function personInfoPending(store: MemoryStore, options: { since?: string } = {}): Evidence[] {
  const seen = new Set(store.db.all<{ evidence_id: string }>("SELECT evidence_id FROM person_info_log").map((r) => r.evidence_id));
  const sinceMs = options.since === undefined ? undefined : Date.parse(options.since);
  return store
    .listEvidence({ status: "active", sourceLevel: "self" })
    .filter((e) => canMentionPeople(e) && !seen.has(e.id) && (sinceMs === undefined || Date.parse(e.observedAt) >= sinceMs))
    .toSorted((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

/** 记下这几条看过了（簿记，不进修订日志） */
export function markPersonInfoScanned(store: MemoryStore, evidenceIds: readonly string[], extractor: string, at: string): void {
  for (const id of evidenceIds) store.db.run("INSERT INTO person_info_log (evidence_id, extractor, at) VALUES (?, ?, ?) ON CONFLICT (evidence_id) DO UPDATE SET extractor = excluded.extractor, at = excluded.at", id, extractor, at);
}

/** 同一个人的几处合成一个（名字相同、或者名字是另一个的别名） */
function mergeMentions(list: readonly PersonMention[]): PersonMention[] {
  const out: PersonMention[] = [];
  for (const m of list) {
    const names = [m.name, ...m.aliases];
    const same = out.find((o) => names.some((n) => n === o.name || o.aliases.includes(n)));
    if (!same) {
      out.push({ ...m, aliases: [...m.aliases], evidenceIds: [...m.evidenceIds], fields: [...m.fields] });
      continue;
    }
    for (const alias of [m.name, ...m.aliases]) if (alias !== same.name && !same.aliases.includes(alias)) same.aliases.push(alias);
    same.relation ??= m.relation;
    for (const id of m.evidenceIds) if (!same.evidenceIds.includes(id)) same.evidenceIds.push(id);
    for (const f of m.fields) if (!same.fields.some((g) => g.field === f.field && g.value === f.value)) same.fields.push(f);
  }
  return out;
}

export const PEOPLE_SYSTEM = `你是二狗的记忆管理员，每晚整理时从用户自己说的话里认出关于"某个人"的固定信息，攒成个人档案的候选（用户之后逐条确认才写进档案）。规则：
- 只认原话里明说了的，不推断、不猜；名字、关系、字段的值都照抄原话里的字；
- 人：用户怎么称呼就写什么（"小张""妈妈"）；说的是用户自己写"我"；"已知的人"里有的尽量用那里的名字；
- 每个人：name；aliases（原话里同一个人的别的叫法）；relation（和用户的关系，原话里明说了才写，如"表弟""同事"，用户自己不写）；
  evidence_ids（提到这个人的证据 id，只能用输入里的）；fields（固定信息，每条 {"field", "value", "evidence_id"}，field 是 relation 和我的关系、
  aliases 别名、birthday 生日、work 单位或学校和职位、health 过敏和用药之一）；
- 只是提到、没说固定信息的人也列出来（fields 为空），用来数提到了几次；
- 证件号、电话、住址这类号码不写（就算原话里有）；偏好、想法、心情、近况不算固定信息。
只输出 JSON：{"people": [{"name": "...", "aliases": [], "relation": 字符串或 null, "evidence_ids": [], "fields": []}]}`;

/** 模型版（线上默认）：一批证据问一次模型，交回的照原文核过才算 */
export class LlmPersonInfoExtractor implements PersonInfoExtractor {
  readonly id: string;
  private readonly model: ChatModel;

  constructor(model: ChatModel) {
    this.model = model;
    this.id = `model:${model.name}`;
  }

  /** 一批的请求 */
  requestFor(batch: readonly Evidence[], known: readonly KnownPerson[]): ChatRequest {
    const people = known.map((k) => JSON.stringify({ name: k.self ? SELF_MENTION : k.name, aliases: k.aliases, ...(k.relation === undefined ? {} : { relation: k.relation }) }));
    const lines = batch.map((e) => JSON.stringify({ evidence_id: e.id, observed_at: e.observedAt, text: [...e.text].slice(0, TEXT_MAX).join("") }));
    return {
      purpose: "people",
      system: PEOPLE_SYSTEM,
      user: `已知的人：\n${people.join("\n") || "（还没有）"}\n用户说的话：\n${lines.join("\n")}`,
      maxTokens: MAX_TOKENS,
    };
  }

  async extract(evidence: readonly Evidence[], known: readonly KnownPerson[], options: { budget: ModelBudget }): Promise<PersonInfoResult> {
    const result: PersonInfoResult = { mentions: [], scanned: [], calls: 0, dropped: [] };
    const usable = evidence.filter(canMentionPeople);
    for (let i = 0; i < usable.length; i += BATCH) {
      const batch = usable.slice(i, i + BATCH);
      if (!options.budget.take()) break;
      result.calls += 1;
      const response = await this.model.complete(this.requestFor(batch, known));
      result.scanned.push(...batch.map((e) => e.id));
      let parsed: Record<string, unknown>;
      try {
        parsed = parseModelJson(response.content);
      } catch (err) {
        result.dropped.push({ reason: `模型输出解析不了：${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      result.mentions.push(...validatePeople(parsed, batch, known, result.dropped));
    }
    result.mentions = mergeMentions(result.mentions);
    return result;
  }
}

/** 名字是不是已知的人（档案里的称呼、别名） */
const knownName = (known: readonly KnownPerson[], name: string) => known.some((k) => k.name === name || k.aliases.includes(name));

/** 核对模型交回的：证据 id 是这一批的；名字、别名、关系、字段的值在它引的证据原文里（已知的人的名字可以不在） */
export function validatePeople(parsed: Record<string, unknown>, batch: readonly Evidence[], known: readonly KnownPerson[], dropped: PersonInfoResult["dropped"]): PersonMention[] {
  const byId = new Map(batch.map((e) => [e.id, e]));
  const out: PersonMention[] = [];
  for (const raw of Array.isArray(parsed.people) ? parsed.people : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const drop = (reason: string) => dropped.push({ reason, item: raw });
    const rawName = typeof r.name === "string" ? r.name.trim() : "";
    if (rawName === "" || [...rawName].length > NAME_MAX) {
      drop("名字不合格");
      continue;
    }
    const self = SELF_NAMES.has(rawName);
    const name = self ? SELF_MENTION : rawName;
    const ids = (isStringArray(r.evidence_ids) ? r.evidence_ids : []).filter((id) => byId.has(id));
    if (ids.length === 0) {
      drop(`没有这一批的证据 id：${JSON.stringify(r.evidence_ids)}`);
      continue;
    }
    const texts = ids.map((id) => byId.get(id)!.text);
    const aliases = (isStringArray(r.aliases) ? r.aliases : []).map((a) => a.trim()).filter((a) => a !== "" && a !== name && [...a].length <= NAME_MAX && texts.some((t) => inText(t, a)));
    if (!self && !knownName(known, name) && !texts.some((t) => inText(t, name)) && aliases.length === 0) {
      drop(`名字「${name}」原文里没有`);
      continue;
    }
    const relationRaw = !self && typeof r.relation === "string" ? r.relation.trim() : "";
    const relation = relationRaw !== "" && [...relationRaw].length <= NAME_MAX && texts.some((t) => inText(t, relationRaw)) ? relationRaw : undefined;
    const fields: PersonMention["fields"] = [];
    for (const f of Array.isArray(r.fields) ? r.fields : []) {
      const g = (f ?? {}) as Record<string, unknown>;
      const field = g.field as PersonInfoField;
      const value = typeof g.value === "string" ? g.value.trim() : "";
      const evidence = typeof g.evidence_id === "string" ? byId.get(g.evidence_id) : undefined;
      if (!(PERSON_INFO_FIELDS as readonly unknown[]).includes(field) || value === "" || [...value].length > VALUE_MAX) {
        dropped.push({ reason: "字段不认得或者值不合格", item: f });
        continue;
      }
      if (self && (field === "relation" || field === "aliases")) continue;
      if (!evidence || !inText(evidence.text, value)) {
        dropped.push({ reason: `「${value}」原文里没有`, item: f });
        continue;
      }
      if (!ids.includes(evidence.id)) ids.push(evidence.id);
      fields.push({ field, value, evidenceId: evidence.id });
    }
    out.push({ name, aliases, ...(relation === undefined ? {} : { relation }), evidenceIds: ids, fields });
  }
  return out;
}

// ---------- 规则版 ----------

// @i18n-ignore-start data：认用户说的中文称呼和句式（规则版）
/** 常见的称呼（亲戚、身边的人）：规则版认"我表弟小张""我妈" */
const RELATION_WORDS = [
  "爸爸", "妈妈", "爸", "妈", "老爸", "老妈", "父亲", "母亲", "老婆", "老公", "妻子", "丈夫", "爱人", "儿子", "女儿", "哥哥", "姐姐", "弟弟", "妹妹", "哥", "姐",
  "表哥", "表姐", "表弟", "表妹", "堂哥", "堂姐", "堂弟", "堂妹", "爷爷", "奶奶", "外公", "外婆", "姥姥", "姥爷", "舅舅", "舅妈", "叔叔", "婶婶", "阿姨", "姑姑", "姑父", "姨妈", "小姨",
  "岳父", "岳母", "公公", "婆婆", "侄子", "侄女", "外甥", "外甥女", "同事", "领导", "老板", "朋友", "室友", "同学", "邻居", "师傅", "徒弟",
].toSorted((a, b) => b.length - a.length);
/** 人名：小张、老王、阿强，或者两三个字的名字 */
const NAME = "(?:[小老阿][\\p{Script=Han}]|[\\p{Script=Han}]{2,3}?)";
const ORG = "([^，。,.！!？?；;\\s]{2,20}?)";
const DATE = "(\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]?)";
// @i18n-ignore-end

/** 规则版（不调模型）：只认"我表弟小张""我妈""X 在 Y 上班""X 的生日是 3 月 2 日"这几种 */
export class RulePersonInfoExtractor implements PersonInfoExtractor {
  readonly id = "rule:1";

  async extract(evidence: readonly Evidence[], known: readonly KnownPerson[], _options: { budget: ModelBudget }): Promise<PersonInfoResult> {
    const mentions: PersonMention[] = [];
    const usable = evidence.filter(canMentionPeople);
    for (const e of usable) mentions.push(...this.read(e, known));
    return { mentions: mergeMentions(mentions), scanned: usable.map((e) => e.id), calls: 0, dropped: [] };
  }

  private read(e: Evidence, known: readonly KnownPerson[]): PersonMention[] {
    const text = e.text;
    const found: PersonMention[] = [];
    const add = (name: string, relation?: string): PersonMention => {
      let m = found.find((x) => x.name === name);
      if (!m) {
        m = { name, aliases: [], evidenceIds: [e.id], fields: [] };
        found.push(m);
      }
      if (relation !== undefined && m.relation === undefined && name !== SELF_MENTION) {
        m.relation = relation;
        m.fields.push({ field: "relation", value: relation, evidenceId: e.id });
      }
      return m;
    };
    // @i18n-ignore-start data：规则版的中文句式
    const relations = RELATION_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    // "我表弟小张""我的同事老王""我表弟叫小张"；没有名字的"我妈"就叫"妈"那个称呼
    for (const m of text.matchAll(new RegExp(`我的?(${relations})(?:叫|是)?(${NAME})?`, "gu"))) {
      const relation = m[1]!;
      const name = m[2];
      if (name !== undefined && !RELATION_WORDS.includes(name)) add(name, relation);
      else add(relation, relation);
    }
    // 档案里已有的人（称呼、别名）
    for (const k of known) {
      if (k.self) continue;
      const hit = [k.name, ...k.aliases].find((n) => n.length > 0 && text.includes(n));
      if (hit !== undefined) add(k.name);
    }
    const names = [SELF_MENTION, ...found.map((f) => f.name)];
    for (const name of names) {
      const who = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const work = new RegExp(`${who}(?:现在)?(?:在|去了|进了)${ORG}(?:上班|工作|上学|读书|当)`, "u").exec(text);
      if (work) add(name).fields.push({ field: "work", value: work[1]!, evidenceId: e.id });
      const birthday = new RegExp(`${who}的?生日(?:是|在)?${DATE}`, "u").exec(text);
      if (birthday) add(name).fields.push({ field: "birthday", value: birthday[1]!.replace(/\s+/g, ""), evidenceId: e.id });
    }
    // @i18n-ignore-end
    return found;
  }
}
