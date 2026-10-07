// 处置（规格第 9 节）：六档，规格始终按由松到严的顺序列出，比较严格程度也按这个顺序（26 号票的设置同样）。
// 硬拒绝不是处置的一档，见 types.ts 的 HardRefusalId。

/** 六档处置，由松到严 */
export const DISPOSITIONS = ["log_only", "notify_after", "plan_listed", "ask_first", "hand_over", "never"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

interface DispositionInfo {
  /** 中文名（给模型的说明、审批卡用） */
  label: string;
  /** 作为最终处置时，给模型的说明的开头和下一步。"计划里列了才做"在判定里总会落成放行或先问，不会是最终处置 */
  explain?: { headline: string; nextStep: string };
}

export const DISPOSITION_INFO: Readonly<Record<Disposition, DispositionInfo>> = Object.freeze({
  log_only: { label: "直接做只记录", explain: { headline: "放行", nextStep: "直接做，只记录。" } },
  notify_after: { label: "做完告诉我", explain: { headline: "放行", nextStep: "直接做，做完会告诉用户。" } },
  plan_listed: { label: "计划里列了才做" },
  ask_first: { label: "先问我", explain: { headline: "先问用户", nextStep: "守护进程会请用户审批，批准后才执行；不要换个写法绕过。" } },
  hand_over: { label: "交给我做", explain: { headline: "交给用户做", nextStep: "不要自己执行：把需要的信息整理好，交给用户亲手完成。" } },
  never: {
    label: "永不",
    explain: { headline: "永不", nextStep: "这次调用不会执行，任何设置、授权项和用户批准都放宽不了；换一种做法，或者放弃这一步。" },
  },
});

export function isDisposition(value: unknown): value is Disposition {
  return typeof value === "string" && (DISPOSITIONS as readonly string[]).includes(value);
}

function rank(d: Disposition): number {
  return DISPOSITIONS.indexOf(d);
}

/** a 是否比 b 严 */
export function isStricter(a: Disposition, b: Disposition): boolean {
  return rank(a) > rank(b);
}

/** 取最严；一个都没有时是"直接做只记录" */
export function strictest(...values: Disposition[]): Disposition {
  let best: Disposition = "log_only";
  for (const v of values) if (rank(v) > rank(best)) best = v;
  return best;
}

/** 这一档会不会让调用直接执行（不问、不拦） */
export function executes(d: Disposition): boolean {
  return d === "log_only" || d === "notify_after";
}
