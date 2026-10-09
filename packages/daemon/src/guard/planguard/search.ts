// planguard 不用求解器的后端：穷举搜索，和 Z3 同一个字典序目标。照搬 AgentSense `web/src/agent/planguard/search.ts`
// （来源和哈希见同目录 VERSION），语义不改；58 号票为流程的审查修补搬来。
import { type Backend, type Blocked, type Candidate, type Problem, type Solution, goalHolds, lessThan, objectiveVector, quantityValues, usedActions } from "./reviewer.ts";

function evaluate(problem: Problem, c: Candidate, selection: number[], relaxed: boolean, required: Set<string> | null): [number, string[]] | null {
  const values = quantityValues(c, usedActions(c, selection));
  const kept: string[] = [];
  let penalty = 0;
  for (const goal of problem.goals) {
    if (goalHolds(c, goal.id, values) !== false) {
      kept.push(goal.id);
      continue;
    }
    if (required !== null) {
      if (required.has(goal.id)) return null;
      continue;
    }
    if ((goal.hard ?? true) && !relaxed) return null;
    penalty += goal.weight ?? 1;
  }
  return [penalty, kept];
}

function* selections(c: Candidate): Generator<number[]> {
  const sizes = c.options.map((o) => o.length);
  if (sizes.some((n) => n === 0)) return;
  const current = sizes.map(() => 0);
  while (true) {
    yield [...current];
    let j = sizes.length - 1;
    while (j >= 0 && (current[j] = current[j]! + 1) === sizes[j]) current[j--] = 0;
    if (j < 0) return;
  }
}

function* solutions(problem: Problem, relaxed: boolean, blocked: Blocked, required: Set<string> | null = null) {
  const skip = new Set(blocked.map(([i, s]) => `${i}:${s.join(",")}`));
  for (const c of problem.candidates) {
    for (const selection of selections(c)) {
      if (skip.has(`${c.index}:${selection.join(",")}`)) continue;
      const outcome = evaluate(problem, c, selection, relaxed, required);
      if (outcome !== null) yield { c, selection, outcome };
    }
  }
}

export const searchBackend: Backend = {
  async solve(problem, relaxed, blocked): Promise<Solution | null> {
    let best: { vector: number[]; solution: Solution } | null = null;
    for (const { c, selection, outcome } of solutions(problem, relaxed, blocked)) {
      const vector = objectiveVector(problem, c, selection, outcome[0]);
      if (best === null || lessThan(vector, best.vector)) {
        best = { vector, solution: { candidate: c.index, selection, keptGoals: outcome[1], relaxed } };
      }
    }
    return best?.solution ?? null;
  },

  /** 没有任何修补能同时满足的最小一组硬目标（按目标的先后取第一组） */
  async unsatCore(problem, blocked) {
    const hard = problem.goals.filter((g) => g.hard ?? true).map((g) => g.id);
    for (let size = 0; size <= hard.length; size++) {
      for (const subset of combinations(hard, size)) {
        if (solutions(problem, true, blocked, new Set(subset)).next().done) return subset;
      }
    }
    return [];
  },
};

function* combinations<T>(items: T[], size: number, start = 0, prefix: T[] = []): Generator<T[]> {
  if (prefix.length === size) {
    yield prefix;
    return;
  }
  for (let i = start; i < items.length; i++) yield* combinations(items, size, i + 1, [...prefix, items[i]!]);
}
