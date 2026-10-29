// 处置（规格第 9 节）：六档，规格始终按由松到严的顺序列出，比较严格程度也按这个顺序（26 号票的设置同样）。
// 硬拒绝不是处置的一档，见 types.ts 的 HardRefusalId。
// 173 号票：名字、说明的开头和下一步按当前语言现取（取值函数；回给 agent 的那一份在中文下判，审批卡上的在用户的语言下另判一遍）
import { t } from "@ergo/protocol";

/** 六档处置，由松到严 */
export const DISPOSITIONS = ["log_only", "notify_after", "plan_listed", "ask_first", "hand_over", "never"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

interface DispositionInfo {
  /** 中文名（给模型的说明、审批卡用） */
  label: string;
  /** 作为最终处置时，给模型的说明的开头和下一步。"计划里列了才做"在判定里总会落成放行或先问，不会是最终处置 */
  explain?: { headline: string; nextStep: string };
}

/** 一档的名字和说明（key 是 guard.disposition.<档>.label / .headline / .nextStep） */
function info(id: Disposition, explained: boolean): DispositionInfo {
  const out = {
    get label() {
      return t(`guard.disposition.${id}.label`);
    },
  } as DispositionInfo;
  if (explained) {
    Object.defineProperty(out, "explain", {
      enumerable: true,
      get: () => ({ headline: t(`guard.disposition.${id}.headline`), nextStep: t(`guard.disposition.${id}.nextStep`) }),
    });
  }
  return Object.freeze(out);
}

export const DISPOSITION_INFO: Readonly<Record<Disposition, DispositionInfo>> = Object.freeze({
  log_only: info("log_only", true),
  notify_after: info("notify_after", true),
  plan_listed: info("plan_listed", false),
  ask_first: info("ask_first", true),
  hand_over: info("hand_over", true),
  never: info("never", true),
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
