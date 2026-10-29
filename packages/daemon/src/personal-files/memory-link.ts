// 个人档案交给记忆这一侧的东西（283 号票，联动的规矩："档案是推理图谱的背景"）。记忆插件经内核服务 KERNEL.personalFiles 取
// （PersonalFilesForMemory，组合根现转），停用记忆插件不影响档案：
// - 档案里的人：称呼、别名、关系（事实图谱的人物实体按它对齐；每晚认人物信息时给模型看"已知的人"）；
// - 档案摘要（background）：每晚整理推理的几步、记忆管理员的系统提示当情境（"有个 6 岁的女儿""刚搬家"），写明不当证据。
//   号码类、住址的值不列（withheldFromModel），只写"最近换过"这类情境；
// - 不进整理提示的值（withheld）：号码类、住址现在的和以前的值，每晚整理发给模型之前换成占位（@ergo/memory 的 withRedaction）；
// - 字段换了新值（onFieldReplaced、replacedValues）：记忆插件据此让事实图谱里旧值的事实到期（经唯一写入口）。
// @i18n-ignore-file model：档案摘要、占位整段是给模型看的
import { isNumberField, type PersonalFileKind, PERSON_FIELDS, personalFieldLabel, SELF_FIELDS, withheldFromModel } from "@ergo/protocol";
import type { CandidateInput } from "./candidates.ts";
import type { StoredNote, StoredValue } from "./view.ts";

/** 档案里的一个人（给记忆这一侧看的：不带号码） */
export interface PersonForMemory {
  id: string;
  kind: PersonalFileKind;
  /** 本人：我的名字（没设没有）；别人：称呼 */
  name?: string;
  aliases: string[];
  relation?: string;
}

/** 档案的一个字段换了新值（旧值到 at 为止） */
export interface FieldReplaced {
  personId: string;
  kind: PersonalFileKind;
  /** 这个人的叫法（称呼、别名；本人是空的，对的是用户自己） */
  names: string[];
  field: string;
  label: string;
  oldValue: string;
  /** 换的那一刻（协议时间） */
  at: string;
}

/** 一段不进整理提示的值 */
export interface WithheldValue {
  value: string;
  /** 号码（中间夹着空白、短横也认） */
  digits: boolean;
  /** 换成什么 */
  placeholder: string;
}

/** 记忆插件要的档案的几样（内核服务 KERNEL.personalFiles） */
export interface PersonalFilesForMemory {
  people(): PersonForMemory[];
  /** 档案摘要（空档案是空串） */
  background(): string;
  withheld(): WithheldValue[];
  /** 字段换了新值时叫（落盘之后）；返回取消订阅 */
  onFieldReplaced(listener: (change: FieldReplaced) => void): () => void;
  /** 以前换过的值（每晚对一遍：插件停用期间换的也补上） */
  replacedValues(): FieldReplaced[];
  /** 收下候选（每晚整理认出来的、访谈里听到的；299 号票起还有"手机"插件交来的用户从通讯录挑的人，301 号票起 Google 插件交来的导入的通讯录 vCard） */
  addCandidates(origin: "nightly" | "interview" | "contacts" | "vcard", inputs: readonly CandidateInput[]): number;
  /** 把攒着的候选合成核对卡（一天一张） */
  composeCandidates(options?: { date?: string }): string | undefined;
}

/** 摘要最多多少字 */
const BACKGROUND_MAX = 1200;
/** 记下的事每人最多带几件、每件截多长 */
const NOTES_MAX = 3;
const NOTE_CLIP = 40;
/** 号码、住址换过多久以内算"最近换过"（天） */
const RECENT_DAYS = 60;

const HEADER = "【个人档案摘要】用户确认过的固定信息，只当情境（家里有谁、在哪工作、刚搬家这类），不是证据，不拿它解释\"他为什么这样\"；号码、住址的值不列。";

const clip = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max).join("")}…` : text);

/** 占位：号码、住址 */
export function placeholderOf(field: string, value: string): string {
  return field === "address" ? "［住址已略去］" : isNumberField(field, value) ? "［号码已略去］" : "［已略去］";
}

/** 一个人的档案（摘要要的） */
export interface FileForMemory {
  id: string;
  kind: PersonalFileKind;
  name?: string;
  values: readonly StoredValue[];
  notes: readonly StoredNote[];
}

/** 档案摘要：每人一行（本人在最前），现在的字段（号码、住址不列值，最近换过的写一句）、最多三件记下的事 */
export function backgroundText(files: readonly FileForMemory[], now: string): string {
  const lines: string[] = [];
  const recent = Date.parse(now) - RECENT_DAYS * 86_400_000;
  for (const file of files) {
    const current = file.values.filter((v) => v.until === undefined);
    const parts: string[] = [];
    if (file.kind === "self" && file.name !== undefined) parts.push(`姓名 ${file.name}`);
    const order = file.kind === "self" ? SELF_FIELDS : PERSON_FIELDS;
    const sorted = current.toSorted((a, b) => indexOf(order, a.field) - indexOf(order, b.field));
    for (const v of sorted) {
      if (v.field === "name" || (file.kind === "person" && v.field === "relation")) continue;
      const label = personalFieldLabel(file.kind, v.field);
      if (withheldFromModel(v.field, v.value)) {
        const changed = file.values.some((h) => h.field === v.field && h.until !== undefined && Date.parse(h.until) >= recent);
        if (changed) parts.push(`${label}${v.since.slice(0, 10)} 换过`);
        continue;
      }
      parts.push(`${label} ${clip(v.value, 40)}`);
    }
    const notes = file.notes.slice(0, NOTES_MAX).map((n) => clip(n.text, NOTE_CLIP));
    if (notes.length > 0) parts.push(`记下的事：${notes.join("；")}`);
    if (parts.length === 0) continue;
    const relation = file.kind === "person" ? current.find((v) => v.field === "relation")?.value : undefined;
    const who = file.kind === "self" ? "我（用户本人）" : `${file.name ?? file.id}${relation === undefined ? "" : `（${relation}）`}`;
    lines.push(`- ${who}：${parts.join("；")}`);
  }
  if (lines.length === 0) return "";
  const kept: string[] = [HEADER];
  for (const line of lines) {
    if ([...kept, line].join("\n").length > BACKGROUND_MAX) break;
    kept.push(line);
  }
  return kept.join("\n");
}

const indexOf = (order: readonly string[], field: string) => {
  const at = order.indexOf(field);
  return at < 0 ? order.length : at;
};

/** 不进整理提示的值：号码类、住址现在的和以前的（同一个值只列一次） */
export function withheldValues(files: readonly FileForMemory[]): WithheldValue[] {
  const out = new Map<string, WithheldValue>();
  for (const file of files) {
    for (const v of file.values) {
      if (!withheldFromModel(v.field, v.value) || out.has(v.value)) continue;
      out.set(v.value, { value: v.value, digits: isNumberField(v.field, v.value), placeholder: placeholderOf(v.field, v.value) });
    }
  }
  return [...out.values()];
}
