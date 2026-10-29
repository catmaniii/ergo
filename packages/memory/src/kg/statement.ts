// 精炼陈述的模板（规则版）：把一条事实写成一句单独看得懂的话，带时间和场景、去掉口语碎屑（用户 2026-10-20 提）。
// 例："用户 2026-10-01 在周末、社交场合拒绝了聚会"、"用户从 2026-10-01 起在周末、社交场合偏好休息"。
// 模型版由模型写（④ 号票），不经这里。有效期变了（观点变化让旧的到期）时，规则版的陈述跟着重写（graph.ts）。
import { localDate } from "../domain/time.ts";
import { EPISODIC_PREDICATES, type Assertion, type Predicate } from "../domain/types.ts";
import { CONTEXT_DIMENSIONS, CONTEXT_LABELS } from "./context.ts";

export interface StatementInput {
  subjectName: string;
  predicate: Predicate;
  objectName: string;
  negated: boolean;
  context: readonly string[];
  assertion: Assertion;
  eventTime: string | null;
  validFrom: string | null;
  validTo: string | null;
}

/** 谓词的说法：[肯定, 否定] */
const VERBS: Readonly<Record<Predicate, readonly [string, string]>> = {
  participated_in: ["参加了", "没参加"],
  declined: ["拒绝了", "没拒绝"],
  initiated: ["主动约了", "没有主动约"],
  said_about: ["说自己", "说自己不"],
  occurred_at: ["去了", "没去"],
  prefers: ["偏好", "不想要"],
  dislikes: ["不喜欢", "不反感"],
  works_on: ["在做", "不再做"],
  associated_with: ["和", "和"],
  // 199 号票：实体和实体之间的关系；{o} 是宾语的位置（没有 {o} 的宾语接在后面）
  organized_by: ["由{o}组织", "不是{o}组织的"],
  involves: ["有{o}参加", "没有{o}参加"],
  held_at: ["地点在{o}", "地点不在{o}"],
  in_slot: ["时间在{o}", "时间不在{o}"],
  of_type: ["是一次{o}", "不是{o}"],
  lead_time: ["是{o}的", "不是{o}的"],
  went_with: ["和{o}一起活动", "没和{o}一起"],
  mentioned: ["提到了{o}", "没提到{o}"],
  colleague_of: ["是{o}的同事", "不是{o}的同事"],
  family_of: ["是{o}的家人", "不是{o}的家人"],
  friend_of: ["是{o}的朋友", "不是{o}的朋友"],
  work_contact_of: ["是{o}工作上的联系人", "不是{o}工作上的联系人"],
};

/** 场景按维度的顺序说（周末、工作日在前，社交、工作在后），不认得的标签照原样放最后 */
function contextPhrase(context: readonly string[]): string {
  if (context.length === 0) return "";
  const order = Object.values(CONTEXT_DIMENSIONS).flat();
  const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
  return `在${context.toSorted((a, b) => rank(a) - rank(b)).map((t) => CONTEXT_LABELS[t] ?? t).join("、")}`;
}

/** 状态类的有效期怎么说 */
function validityPhrase(validFrom: string | null, validTo: string | null): string {
  if (validFrom === null && validTo === null) return "一直";
  if (validFrom === null) return `到 ${localDate(validTo!)} 为止`;
  if (validTo === null) return `从 ${localDate(validFrom)} 起`;
  return `在 ${localDate(validFrom)} 到 ${localDate(validTo)} 之间`;
}

/** 只有谓词和宾语的短语（"不喜欢爬山"），追问里用 */
export function factPhrase(predicate: Predicate, negated: boolean, objectName: string): string {
  const verb = VERBS[predicate][negated ? 1 : 0];
  if (verb.includes("{o}")) return verb.replace("{o}", objectName);
  return predicate === "associated_with" ? `${verb}${objectName}${negated ? "无关" : "有关"}` : `${verb}${objectName}`;
}

export function factStatement(input: StatementInput): string {
  const when = EPISODIC_PREDICATES.has(input.predicate)
    ? ` ${input.eventTime ? localDate(input.eventTime) : input.validFrom ? localDate(input.validFrom) : "（时间不详）"} `
    : validityPhrase(input.validFrom, input.validTo);
  const where = contextPhrase(input.context);
  const what = factPhrase(input.predicate, input.negated, input.objectName);
  const reported = input.assertion === "third_party_reported" ? "据别人说，" : "";
  return `${reported}${input.subjectName}${when}${where}${what}`.replace(/\s+/g, " ").trim();
}
