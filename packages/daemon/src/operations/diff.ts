// 使用中的项目交了新的一份运营方案（130 号票）：和现在生效的那一版比出差异，"运营方案变更"卡照它写，用户确认时照它生效。
// 按每一条的标识（key）认是不是同一条：
// - 新的里有、现在没有：加上（added）；现在有、新的里没有：去掉（removed，取消它的内部任务）；
// - 两边都有、写得不一样：改了（changed）——手段能就地改的（只改了重复的时间表）标 inPlace，就地改时间；别的撤了重建；
// - 两边都有、一样：照旧（kept）；但它现在没跑着的（上次没生效、它的内部任务被取消了或结束了）重新开起来（restored）。
// 比"写得一样不一样"只看维护者写的（名字、手段、触发、做法、每次做什么、要的能力、失败时怎样、要手动的、流程的步骤和条件、
// 服务的定义——133 号票，补过默认值的那一份），运行时补上的（手段的说法、审查的耗时这些）不算。
import type { OperationItem } from "@ergo/protocol";

/** 现在生效的一条：它写的样子、它生效成的东西（内部任务；要用户手动的没有；没生效的记着原因） */
export interface ActiveOperation {
  item: OperationItem;
  taskId?: string | undefined;
  failed?: string | undefined;
}

export interface OperationsDiff {
  added: OperationItem[];
  changed: Array<{ before: ActiveOperation; after: OperationItem; inPlace: boolean }>;
  removed: ActiveOperation[];
  restored: Array<{ before: ActiveOperation; after: OperationItem }>;
  kept: Array<{ before: ActiveOperation; after: OperationItem }>;
}

/** 维护者写的那部分（比较用）：流程的只看步骤（id、标题、工具、参数、前置）和条件，不看审查的结果 */
export function writtenForm(item: OperationItem): string {
  const caps = item.capabilities;
  return JSON.stringify({
    name: item.name,
    means: item.means,
    schedule: item.schedule ?? null,
    event: item.event ?? null,
    approach: item.approach,
    instructions: item.instructions,
    capabilities: {
      network: caps.network === true,
      bash: caps.bash === true,
      skills: [...new Set(caps.skills ?? [])].toSorted(),
      mcp: [...new Set(caps.mcp ?? [])].toSorted(),
      tellSecretary: caps.tellSecretary === true,
    },
    onFailure: item.onFailure ?? null,
    manual: item.manual ?? null,
    service: item.service ?? null,
    workflow: item.workflow ? { steps: item.workflow.steps.map((s) => ({ id: s.id, title: s.title, tool: s.tool, args: s.args, after: s.after })), rules: item.workflow.rules } : null,
  });
}

export interface DiffDeps {
  /** 它现在还跑着没有（要用户手动的算跑着：本来就没有内部任务） */
  alive(active: ActiveOperation): boolean;
  /** 改了的这一条能不能就地改（手段的 update 给得出事件） */
  inPlace(before: ActiveOperation, after: OperationItem): boolean;
}

export function diffOperations(active: readonly ActiveOperation[], next: readonly OperationItem[], deps: DiffDeps): OperationsDiff {
  const before = new Map(active.map((a) => [a.item.key, a]));
  const keys = new Set(next.map((i) => i.key));
  const diff: OperationsDiff = { added: [], changed: [], removed: active.filter((a) => !keys.has(a.item.key)), restored: [], kept: [] };
  for (const item of next) {
    const old = before.get(item.key);
    if (!old) diff.added.push(item);
    else if (writtenForm(old.item) !== writtenForm(item)) diff.changed.push({ before: old, after: item, inPlace: deps.alive(old) && deps.inPlace(old, item) });
    else if (deps.alive(old)) diff.kept.push({ before: old, after: item });
    else diff.restored.push({ before: old, after: item });
  }
  return diff;
}

/** 有没有要改的（全是照旧的就没有） */
export const diffIsEmpty = (diff: OperationsDiff): boolean => diff.added.length + diff.changed.length + diff.removed.length + diff.restored.length === 0;
