// 时间和变化判定（第 5 节的表）：新说法和旧的对不上时先分是哪一种。这里只做判定（纯函数），改状态在 graph.ts。
//
// | 判定           | 条件                                                         | 处理（graph.ts）                                  |
// |----------------|--------------------------------------------------------------|---------------------------------------------------|
// | context_differs | 两条的场景不重叠（context.ts）                              | 两条都不动，不算冲突                               |
// | correction     | 整条证据带纠正信号（或证据种类是 correction）                | 旧的 corrected，retractedBy 指向这条证据            |
// | time_differs   | 两条的有效期不重叠（比如"去年喜欢"和"今年不喜欢"）           | 都不动；新的明说了变化时旧的标 superseded           |
// | change_of_mind | 场景、有效期重叠；有效期开始得晚的那条**自己明说了变化**     | 开始得早的那条到期（validTo = 晚的 validFrom），superseded，不删 |
// | conflict       | 场景、有效期重叠，互相排斥，开始得晚的那条没明说变化         | 两条都 contested，生成一个判别性追问                |
//
// 先看场景再看纠正：场景不重叠的两条本来就都成立，谈不上纠正。纠正在有效期之前：用户说"记错了"时不管旧的那条说的是哪段时间。
// 334 号票（用户 2026-10-27 选 A，ADR-0032）：以前"不在同一天说的就按先后、后说的赢"，现在不这样了——前后两句意思相反、
// 后说的那句没自己说"变了"（signals.ts 的 explicitChangeSignals：不再、不…了、改成、以前…现在…、搬家、换工作……），
// 是矛盾：两条都拿不准、问用户，哪边都不自动赢（原始推理图谱 LIFECYCLE §6b：不许"信先到的、信后到的"）。
// 后说的那句自己说了变化，才是用户亲口说的变化，照旧新取代旧。
import { EPISODIC_PREDICATES, type FactObject, type Predicate } from "../domain/types.ts";
import { compareFrom, intervalsOverlap, sameLocalDay } from "../domain/time.ts";
import { contextsCompatible } from "./context.ts";

export const CHANGE_KINDS = ["context_differs", "time_differs", "change_of_mind", "correction", "conflict"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** 判定要看的那几个字段（事实和还没写入的新事实都有） */
export interface ComparableFact {
  subjectId: string;
  predicate: Predicate;
  object: FactObject;
  negated: boolean;
  context: string[];
  eventTime: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface ChangeVerdict {
  kind: ChangeKind;
  /** change_of_mind 时哪一条是后来的（后来的那条成立，另一条到它开始时为止） */
  later?: "old" | "new";
}

export function sameObject(a: FactObject, b: FactObject): boolean {
  return a.type === "entity" ? b.type === "entity" && a.id === b.id : b.type === "value" && a.value === b.value;
}

/** 互相排斥的谓词对（宾语相同、否定相同时）：喜欢 ⟂ 不喜欢；参加了 ⟂ 拒绝了 */
const OPPOSITE: ReadonlyArray<readonly [Predicate, Predicate]> = [
  ["prefers", "dislikes"],
  ["participated_in", "declined"],
];

export interface ExcludeOptions {
  /** 实体所在的互斥组（词表里的 group，比如远程办公、坐班同属"办公方式"） */
  groupOf?: (object: FactObject) => string | undefined;
  /** 新的这条带纠正信号：事情类的不要求同一天（"其实那次我没去"是事后说的） */
  correction?: boolean;
}

/**
 * 两条事实互相排斥吗（同一个主语）：
 * - 同一个谓词、同一个宾语，一条否定一条不否定（不喜欢 X ⟂ 不反感 X）；
 * - 喜欢 X ⟂ 不喜欢 X；参加了 X ⟂ 拒绝了 X（否定相同）；
 * - 都"喜欢"、宾语在同一个互斥组里（喜欢远程办公 ⟂ 喜欢坐班）；
 * - 事情类的还要是同一天的同一件事（周三的聚会和周六的聚会是两件事）；新的带纠正信号时不看日子。
 */
export function excludes(old: ComparableFact, neu: ComparableFact, options: ExcludeOptions = {}): boolean {
  if (old.subjectId !== neu.subjectId) return false;
  let exclusive = false;
  if (sameObject(old.object, neu.object)) {
    if (old.predicate === neu.predicate) exclusive = old.negated !== neu.negated;
    else if (old.negated === neu.negated) exclusive = OPPOSITE.some(([a, b]) => (old.predicate === a && neu.predicate === b) || (old.predicate === b && neu.predicate === a));
  } else if (old.predicate === "prefers" && neu.predicate === "prefers" && !old.negated && !neu.negated) {
    const g = options.groupOf?.(old.object);
    exclusive = g !== undefined && g === options.groupOf?.(neu.object);
  }
  if (!exclusive) return false;
  const episodic = EPISODIC_PREDICATES.has(old.predicate) || EPISODIC_PREDICATES.has(neu.predicate);
  if (episodic && !options.correction) return old.eventTime !== null && neu.eventTime !== null && sameLocalDay(old.eventTime, neu.eventTime);
  return true;
}

/**
 * 判定要看的信号：change = 新来的这句自己明说了变化（334 号票，signals.ts 的 explicitChangeSignals）；
 * oldChange = 已有的那条背后的话明说了变化（新来的说的是更早的事时，后说的是旧的那条）；correction = 新来的这句是纠正
 */
export interface ChangeSignals {
  change: boolean;
  correction: boolean;
  oldChange?: boolean;
}

/** 两条互相排斥的事实（excludes 为真）是哪一种不一样 */
export function classifyChange(old: ComparableFact, neu: ComparableFact, signals: ChangeSignals): ChangeVerdict {
  if (!contextsCompatible(old.context, neu.context)) return { kind: "context_differs" };
  if (signals.correction) return { kind: "correction" };
  if (!intervalsOverlap(old, neu)) return { kind: "time_differs" };
  // 有效期开始得晚的那条是后来的；它自己明说了变化才算观点变化（334 号票）。开始得一样早（说的是同一段时间）分不出先后，
  // 后来的那条没说变化，都是真冲突
  const c = compareFrom(neu.validFrom, old.validFrom);
  if (c > 0 && signals.change) return { kind: "change_of_mind", later: "new" };
  if (c < 0 && signals.oldChange === true) return { kind: "change_of_mind", later: "old" };
  return { kind: "conflict" };
}
