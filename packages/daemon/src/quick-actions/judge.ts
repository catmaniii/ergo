// 快速动作的处置（规格第 9 节"快速动作的确认"）：把动作作为一个伪工具调用交给守卫的判定函数，不另写一套类别规则。
// - 伪工具叫 quick_action:<动作类型>，它的登记就是执行器的 watch（内置类别、底线、做完告诉我、参数规则、是否对外发送），
//   参数是规范化后的参数：用户的自定义类别（按工具名、收件人、金额、路径匹配）也能匹配到它；
// - 处置取最严的规则不变（守卫的判定函数里定）。对话场景，没有任务；效果日志给空的（快速动作不进效果日志）；
// - 点明了的：只看底线（付款、改密码……仍按底线交给我做或永不），类别不管；推断出来的：看全部依据，"按规则退回"按先问处理。
import { strictest, type Disposition, type GuardPlaces, judgeToolCall, type ToolDescriptor, type WatchCategorySettings } from "../guard/index.ts";
import { categoryTitle } from "../guard-runtime/describe.ts";
import type { NormalizedQuickAction, QuickActionExecutor } from "./registry.ts";

/** 判定快速动作要用的：守卫的各区（判定函数要它）、秘书的草稿区、每次现读的关注类别设置、现在 */
export interface QuickActionGuard {
  places: GuardPlaces;
  scratchDir: string;
  settings: () => WatchCategorySettings;
  now: () => number;
}

/** 伪工具的名字：自定义类别的 match.tools 写它 */
export function quickActionToolName(type: string): string {
  return `quick_action:${type}`;
}

/** 伪工具的登记：形状同工具注册表（关注按这一个动作给的优先，27 号票） */
function descriptorOf(executor: QuickActionExecutor, action: NormalizedQuickAction): ToolDescriptor {
  const watch = executor.watchFor?.(action) ?? executor.watch;
  return {
    name: quickActionToolName(executor.type),
    title: executor.title,
    source: "host",
    categories: watch.categories,
    ...(watch.bottomLines === undefined ? {} : { bottomLines: watch.bottomLines }),
    args: watch.args ?? {},
    ...(watch.notifyWhenDone === undefined ? {} : { notifyWhenDone: watch.notifyWhenDone }),
    ...(watch.outbound === undefined ? {} : { outbound: watch.outbound }),
    readOnlyOrIdempotent: false,
  };
}

export type QuickActionJudgement =
  | { refused: string }
  /** 处置和命中的类别（显示用的名字：内置类别的中文名、自定义类别的名字） */
  | { refused?: undefined; disposition: Disposition; categories: string[] };

export function judgeQuickAction(guard: QuickActionGuard, executor: QuickActionExecutor, action: NormalizedQuickAction, explicit: boolean): QuickActionJudgement {
  const descriptor = descriptorOf(executor, action);
  const settings = guard.settings();
  const args = typeof action.params === "object" && action.params !== null && !Array.isArray(action.params) ? action.params : {};
  const judgement = judgeToolCall({
    call: { toolName: descriptor.name, args },
    agent: {
      kind: "secretary",
      agentId: descriptor.name,
      cwd: guard.scratchDir,
      scratchDir: guard.scratchDir,
      toolkit: { bash: false, network: false, tools: [descriptor.name] },
    },
    places: guard.places,
    task: null,
    effectLog: [],
    settings,
    facts: {},
    tools: { [descriptor.name]: descriptor },
    now: guard.now(),
  });
  if (judgement.hardRefusal !== null) return { refused: judgement.explanation };
  if (explicit) {
    const bottomLines = judgement.findings.flatMap((f) => (f.kind === "bottom_line" ? [f.disposition] : []));
    return { disposition: strictest("log_only", ...bottomLines), categories: [] };
  }
  let disposition = judgement.pullBack === null ? judgement.disposition : strictest(judgement.disposition, "ask_first");
  // 对话里没有计划可列："计划里列了才做"等同先问（判定函数里已经这样落了，这里兜底）
  if (disposition === "plan_listed") disposition = "ask_first";
  return { disposition, categories: judgement.categories.map((id) => categoryTitle(id, [settings])) };
}
