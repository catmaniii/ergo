// 处置（规格第 9 节）：六档，规格始终按由松到严的顺序列出，比较严格程度也按这个顺序（26 号票的设置同样）。
// 另有一个"直接拒绝"（rejected）：路径围栏越界写入、联网关着时的联网调用、读密钥区这类硬边界，
// 不属于六档、设置和授权项都碰不到它，也不出审批卡。

/** 六档处置，由松到严 */
export const DISPOSITIONS = ["log_only", "notify_after", "plan_listed", "ask_first", "hand_over", "never"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** 判定的输出：六档之一，或硬边界上的直接拒绝 */
export type GuardDisposition = Disposition | "rejected";

/** 各档的中文名（给模型的说明、审批卡用） */
export const DISPOSITION_LABELS: Readonly<Record<GuardDisposition, string>> = Object.freeze({
  log_only: "直接做只记录",
  notify_after: "做完告诉我",
  plan_listed: "计划里列了才做",
  ask_first: "先问我",
  hand_over: "交给我做",
  rejected: "直接拒绝",
  never: "永不",
});

// 取最严时的排位："永不"排在"直接拒绝"之上，这样受保护区域的写入（永不）和围栏越界（拒绝）同时命中时报"永不"。
const RANK: Readonly<Record<GuardDisposition, number>> = Object.freeze({
  log_only: 0,
  notify_after: 1,
  plan_listed: 2,
  ask_first: 3,
  hand_over: 4,
  rejected: 5,
  never: 6,
});

export function isDisposition(value: unknown): value is Disposition {
  return typeof value === "string" && (DISPOSITIONS as readonly string[]).includes(value);
}

/** a 是否比 b 严 */
export function isStricter(a: GuardDisposition, b: GuardDisposition): boolean {
  return RANK[a] > RANK[b];
}

/** 取最严；一个都没有时是"直接做只记录" */
export function strictest<T extends GuardDisposition>(...values: T[]): T | "log_only" {
  let best: T | "log_only" = "log_only";
  for (const v of values) if (RANK[v] > RANK[best]) best = v;
  return best;
}

/** 这一档会不会让调用直接执行（不问、不拦） */
export function executes(d: GuardDisposition): boolean {
  return d === "log_only" || d === "notify_after";
}
