// 找隐蔽的联系（199 号票）：在知识图谱上做"对比模式"。
// 用户推掉的一组邀约和去了的一组邀约，看它们在哪个属性上不一样：组织者、组织者和用户的关系、参加的人、地点、时间段、活动类型、提前多久约的。
// - 某个属性的某个值：推掉的里至少 2 次有它，有它的邀约推掉的占比至少 2/3，而且比没有它的邀约推掉的占比高出至少 1/3，
//   或者至少有一对对照（见下）、也比没有它的高，才算对比明显；要有去了的邀约（没有对照就谈不上对比）。
//   这个属性没写的邀约（不知道是谁约的、提前多久）不算"没有它"，不进比较；
// - 对照：去了的一次和推掉的一次在别的具体属性上（组织者、参加的人、地点、时间段、活动类型）两边都写了的都对得上、至少对上两样，
//   只有这个属性不一样——"同样的活动、换个组织者他就去了"；
// - 只看能当依据的本人事实（推理图谱的 usableFact），在 at 成立的。
// 这里只做知识图谱上的计算（纯读）；交给推理图谱出竞争假设的是 rg/joint.ts。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import { validAt } from "../domain/time.ts";
import type { Fact, Predicate } from "../domain/types.ts";
import { HELD_STATUSES, type MemoryStore } from "../store/store.ts";
import { RELATION_LABELS, RELATION_PREDICATES, type RelationPredicate } from "./relations.ts";

export const CONTRAST_DIMENSIONS = ["organizer", "organizer_relation", "participant", "place", "slot", "type", "lead_time"] as const;
export type ContrastDimension = (typeof CONTRAST_DIMENSIONS)[number];

export const DIMENSION_LABELS: Readonly<Record<ContrastDimension, string>> = {
  organizer: "组织者",
  organizer_relation: "组织者和用户的关系",
  participant: "参加的人",
  place: "地点",
  slot: "时间段",
  type: "活动类型",
  lead_time: "提前多久约的",
};

/** 每个属性在图上是哪个谓词（组织者的关系是两跳：事件 → 组织者 → 用户） */
const DIM_PREDICATE: Readonly<Record<Exclude<ContrastDimension, "organizer_relation">, Predicate>> = {
  organizer: "organized_by",
  participant: "involves",
  place: "held_at",
  slot: "in_slot",
  type: "of_type",
  lead_time: "lead_time",
};

/** 对照要看的具体属性（提前多久、组织者的关系不算：它们正是可能的原因，不是"同样的活动"） */
export const CONCRETE_DIMENSIONS: readonly ContrastDimension[] = ["organizer", "participant", "place", "slot", "type"];

export const CONTRAST_MIN_DECLINES = 2;
export const CONTRAST_MIN_RATE = 2 / 3;
export const CONTRAST_MIN_GAP = 1 / 3;

/** 一个属性值：实体（key 是实体 id，names 是名字和别名）或者值 */
export interface AttrValue {
  key: string;
  label: string;
  names: string[];
}

/** 一次邀约：事件、用户怎么回的、属性 */
export interface EventRecord {
  eventId: string;
  name: string;
  response: "declined" | "accepted";
  /** 用户对它的那条事实（拒绝了、参加了） */
  factId: string;
  evidenceIds: string[];
  time: string;
  attrs: Partial<Record<ContrastDimension, AttrValue[]>>;
  /** 同一条证据里用户当时说的理由（说自己忙、累……的事实） */
  reasonFactIds: string[];
}

export interface ContrastControl {
  accepted: EventRecord;
  declined: EventRecord;
  /** 两边都对得上的具体属性 */
  shared: ContrastDimension[];
}

export interface ContrastMotif {
  key: string;
  dimension: ContrastDimension;
  value: AttrValue;
  declinedWith: EventRecord[];
  acceptedWith: EventRecord[];
  declinedWithout: number;
  acceptedWithout: number;
  rateWith: number;
  rateWithout: number;
  controls: ContrastControl[];
}

const time = (f: Fact) => f.eventTime ?? f.validFrom ?? f.observedAt;

/** 图上的邀约：用户拒绝了、参加了的事件实体，带属性 */
export function eventRecords(store: MemoryStore, at: string, usable: (f: Fact) => boolean): EventRecord[] {
  const out = new Map<string, EventRecord>();
  const valid = (f: Fact) => (HELD_STATUSES as readonly string[]).includes(f.status) && validAt(f, at);
  for (const f of store.factsValidAt(at)) {
    if (f.subjectId !== USER_ENTITY_ID || f.negated || f.object.type !== "entity" || !usable(f)) continue;
    if (f.predicate !== "declined" && f.predicate !== "participated_in") continue;
    const event = store.getEntity(f.object.id);
    if (!event || event.type !== "event") continue;
    const prev = out.get(event.id);
    if (prev && Date.parse(prev.time) > Date.parse(time(f))) continue;
    const attrs: EventRecord["attrs"] = {};
    const push = (dim: ContrastDimension, v: AttrValue) => {
      const list = (attrs[dim] ??= []);
      if (!list.some((x) => x.key === v.key)) list.push(v);
    };
    for (const a of store.factsTouching(event.id)) {
      if (a.subjectId !== event.id || !valid(a)) continue;
      for (const [dim, predicate] of Object.entries(DIM_PREDICATE) as [ContrastDimension, Predicate][]) {
        if (a.predicate !== predicate) continue;
        if (a.object.type === "value") push(dim, { key: `value:${a.object.value}`, label: a.object.value, names: [a.object.value] });
        else {
          const e = store.getEntity(a.object.id);
          if (e) push(dim, { key: e.id, label: e.name, names: [e.name, ...e.aliases] });
        }
      }
    }
    for (const org of attrs.organizer ?? []) {
      for (const r of store.factsTouching(org.key)) {
        if (r.subjectId !== org.key || !(RELATION_PREDICATES as readonly string[]).includes(r.predicate) || !valid(r)) continue;
        if (r.object.type !== "entity" || r.object.id !== USER_ENTITY_ID) continue;
        const label = RELATION_LABELS[r.predicate as RelationPredicate];
        push("organizer_relation", { key: `relation:${r.predicate}`, label, names: [label] });
      }
    }
    const reasonFactIds = f.evidenceIds.flatMap((id) =>
      store
        .factsByEvidence(id)
        .filter((x) => x.subjectId === USER_ENTITY_ID && x.predicate === "said_about" && !x.negated && usable(x))
        .map((x) => x.id),
    );
    out.set(event.id, { eventId: event.id, name: event.name, response: f.predicate === "declined" ? "declined" : "accepted", factId: f.id, evidenceIds: [...f.evidenceIds], time: time(f), attrs, reasonFactIds });
  }
  return [...out.values()].toSorted((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

export const hasValue = (r: EventRecord, dim: ContrastDimension, key: string): boolean => (r.attrs[dim] ?? []).some((v) => v.key === key);

/** 对照：去了的和推掉的在别的具体属性上两边都写了的都对得上、至少对上两样，只有 dim 不一样（推掉的有 key，去了的没有） */
export function controlsFor(dim: ContrastDimension, key: string, records: readonly EventRecord[]): ContrastControl[] {
  const declined = records.filter((r) => r.response === "declined" && hasValue(r, dim, key));
  const out: ContrastControl[] = [];
  for (const a of records) {
    if (a.response !== "accepted" || hasValue(a, dim, key)) continue;
    for (const d of declined) {
      const shared: ContrastDimension[] = [];
      let clash = false;
      for (const other of CONCRETE_DIMENSIONS) {
        if (other === dim) continue;
        const av = a.attrs[other] ?? [];
        const dv = d.attrs[other] ?? [];
        if (av.length === 0 || dv.length === 0) continue;
        if (av.some((x) => dv.some((y) => y.key === x.key))) shared.push(other);
        else clash = true;
      }
      if (!clash && shared.length >= 2) {
        out.push({ accepted: a, declined: d, shared });
        break;
      }
    }
  }
  return out;
}

/** 这几次邀约在某个属性上最多的那个值（至少两次都有才算） */
export function sharedValue(records: readonly EventRecord[], dim: ContrastDimension): AttrValue | undefined {
  const counts = new Map<string, { v: AttrValue; n: number }>();
  for (const r of records) for (const v of r.attrs[dim] ?? []) counts.set(v.key, { v, n: (counts.get(v.key)?.n ?? 0) + 1 });
  const best = [...counts.values()].filter((x) => x.n >= 2).toSorted((a, b) => b.n - a.n || a.v.label.localeCompare(b.v.label))[0];
  return best?.v;
}

/** 对比模式：哪个属性的哪个值把推掉的和去了的分开了（见文件开头） */
export function mineContrasts(records: readonly EventRecord[]): ContrastMotif[] {
  const declined = records.filter((r) => r.response === "declined");
  const accepted = records.filter((r) => r.response === "accepted");
  if (declined.length < CONTRAST_MIN_DECLINES || accepted.length === 0) return [];
  const out: ContrastMotif[] = [];
  for (const dim of CONTRAST_DIMENSIONS) {
    const values = new Map<string, AttrValue>();
    for (const r of declined) for (const v of r.attrs[dim] ?? []) values.set(v.key, v);
    const known = (r: EventRecord) => (r.attrs[dim] ?? []).length > 0;
    for (const v of values.values()) {
      const declinedWith = declined.filter((r) => hasValue(r, dim, v.key));
      const acceptedWith = accepted.filter((r) => hasValue(r, dim, v.key));
      if (declinedWith.length < CONTRAST_MIN_DECLINES) continue;
      const declinedWithout = declined.filter((r) => known(r) && !hasValue(r, dim, v.key)).length;
      const acceptedWithout = accepted.filter((r) => known(r) && !hasValue(r, dim, v.key)).length;
      const rateWith = declinedWith.length / (declinedWith.length + acceptedWith.length);
      const rateWithout = declinedWithout + acceptedWithout === 0 ? 0 : declinedWithout / (declinedWithout + acceptedWithout);
      if (rateWith < CONTRAST_MIN_RATE || rateWith <= rateWithout) continue;
      const controls = controlsFor(dim, v.key, records);
      if (rateWith - rateWithout < CONTRAST_MIN_GAP && controls.length === 0) continue;
      out.push({ key: `${dim}|${v.key}`, dimension: dim, value: v, declinedWith, acceptedWith, declinedWithout, acceptedWithout, rateWith, rateWithout, controls });
    }
  }
  return out.toSorted((a, b) => b.rateWith - b.rateWithout - (a.rateWith - a.rateWithout) || b.declinedWith.length - a.declinedWith.length || a.key.localeCompare(b.key));
}
