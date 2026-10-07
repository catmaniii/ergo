// 二狗加进 planguard 表达式语言的运算（planguard 原版没有，搬来的 planguard/expr.ts 也不认识它们）。
// 时序规则的检查（temporal-rules.ts）加载时调 installErgouOps() 把它们注册进引擎的运算表 OPS；规则校验直接看 ERGOU_OPS。
import { isWithin } from "./paths.ts";
import { evaluate, isUnknown, MISSING, OPS, SpecError, UNKNOWN, type Op } from "./planguard/expr.ts";

/**
 * path_within: [路径, 目录或一组目录]——路径就是这个目录或在它里面。Windows 语义：不分大小写、不分 `/` 和 `\`，
 * 不会把 `E:\work\notes2` 当成在 `E:\work\notes` 里（planguard 的 startswith 做不到这两点）。
 * 路径或目录是"未知"时得 UNKNOWN；路径不存在、不是字符串时得 false。
 */
const pathWithin: Op = (arg, env) => {
  if (!Array.isArray(arg) || arg.length !== 2) throw new SpecError(`expected 2 operands, got ${JSON.stringify(arg)}`);
  const [target, dirs] = arg.map((x) => evaluate(x, env));
  if (isUnknown(target)) return UNKNOWN;
  if (typeof target !== "string") return false;
  const items = isUnknown(dirs) ? null : dirs === MISSING || dirs === null || dirs === undefined ? [] : Array.isArray(dirs) ? dirs : [dirs];
  if (items === null) return UNKNOWN;
  let unknown = false;
  for (const dir of items) {
    if (isUnknown(dir)) unknown = true;
    else if (typeof dir === "string" && isWithin(target, dir)) return true;
  }
  return unknown ? UNKNOWN : false;
};

/** 二狗的扩展运算和它们要的操作数个数 */
export const ERGOU_OPS: Readonly<Record<string, { op: Op; arity: number }>> = Object.freeze({
  path_within: { op: pathWithin, arity: 2 },
});

/** 把二狗的扩展运算注册进引擎的运算表（重复调用无妨） */
export function installErgouOps(): void {
  for (const [name, { op }] of Object.entries(ERGOU_OPS)) OPS[name] = op;
}
