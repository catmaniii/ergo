// planguard 的三值表达式语言（同步记录和哈希见同目录 VERSION）。
// 语义一字不改，只按本仓库的 TypeScript 和 oxlint 设置改写法（不用参数属性、下标取值加非空断言、排序用 toSorted），
// 另外导出了 Op 类型和 PLACEHOLDER，给二狗的扩展运算（../rule-ops.ts）和规则校验用。不引用二狗的任何模块。
// 求值结果是三值：true / false / UNKNOWN（"存在但还不知道"）；引用不存在的东西得到 MISSING。

export class SpecError extends Error {}

/** 存在但还不知道的值（比如没法规范化的参数、取不到的环境事实） */
export class Unknown {
  readonly desc: unknown;
  constructor(desc: unknown = null) {
    this.desc = desc;
  }
}

// 只用来做一个独一无二的标记值（照搬 planguard）
// oxlint-disable-next-line typescript/no-extraneous-class
class Missing {}

export const UNKNOWN = new Unknown();
export const MISSING = new Missing();

export type Tri = boolean | Unknown;
export type Env = Record<string, unknown>;

export const isUnknown = (v: unknown): v is Unknown => v instanceof Unknown;
export const isNumber = (v: unknown): v is number => typeof v === "number";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Unknown) && v !== MISSING;
}

export function deepKnown(v: unknown): boolean {
  if (isUnknown(v) || v === MISSING) return false;
  if (Array.isArray(v)) return v.every(deepKnown);
  if (isPlainObject(v)) return Object.values(v).every(deepKnown);
  return true;
}

export function truthy(v: unknown): Tri {
  if (typeof v === "boolean") return v;
  if (isUnknown(v)) return UNKNOWN;
  if (v === null || v === undefined || v === MISSING) return false;
  if (isNumber(v)) return v !== 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  return true;
}

export function equals(a: unknown, b: unknown): boolean {
  const left = a === MISSING || a === undefined ? null : a;
  const right = b === MISSING || b === undefined ? null : b;
  if (isNumber(left) && isNumber(right)) return left === right;
  if (left instanceof Unknown || right instanceof Unknown) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((x, i) => equals(x, right[i]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const ka = Object.keys(left).toSorted();
    const kb = Object.keys(right).toSorted();
    return equals(ka, kb) && ka.every((k) => equals(left[k], right[k]));
  }
  return left === right;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function resolve(ref: string, env: Env): unknown {
  const [head, ...rest] = ref.slice(1).split(".");
  if (head === undefined || !hasOwn(env, head)) return MISSING;
  let value: unknown = env[head];
  for (const part of rest) {
    if (isUnknown(value)) return UNKNOWN;
    if (isPlainObject(value)) value = hasOwn(value, part) ? value[part] : MISSING;
    else if (Array.isArray(value) && /^\d+$/.test(part) && Number(part) < value.length) value = value[Number(part)];
    else return MISSING;
  }
  return value;
}

export function evaluate(expr: unknown, env: Env): unknown {
  if (typeof expr === "string") return expr.startsWith("$") ? resolve(expr, env) : expr;
  if (Array.isArray(expr)) return expr.map((x) => evaluate(x, env));
  if (isPlainObject(expr)) {
    const keys = Object.keys(expr);
    if (keys.length === 1) {
      const key = keys[0]!;
      if (hasOwn(OPS, key)) return OPS[key]!(expr[key], env);
      if (key === "$unknown") return new Unknown(expr[key]);
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = evaluate(expr[k], env);
    return out;
  }
  return expr;
}

/** 把一个谓词求值成 true / false / UNKNOWN */
export const test = (expr: unknown, env: Env): Tri => truthy(evaluate(expr, env));

// ───────────────────────── 运算 ─────────────────────────

export type Op = (arg: unknown, env: Env) => unknown;

function args(arg: unknown, count?: number): unknown[] {
  const items = Array.isArray(arg) ? arg : [arg];
  if (count !== undefined && items.length !== count) throw new SpecError(`expected ${count} operands, got ${JSON.stringify(items)}`);
  return items;
}

const opAnd: Op = (arg, env) => {
  let unknown = false;
  for (const item of args(arg)) {
    const v = test(item, env);
    if (v === false) return false;
    if (v !== true) unknown = true;
  }
  return unknown ? UNKNOWN : true;
};

const opOr: Op = (arg, env) => {
  let unknown = false;
  for (const item of args(arg)) {
    const v = test(item, env);
    if (v === true) return true;
    if (v !== false) unknown = true;
  }
  return unknown ? UNKNOWN : false;
};

const opNot: Op = (arg, env) => {
  const v = test(args(arg, 1)[0], env);
  return isUnknown(v) ? UNKNOWN : !v;
};

function compare(check: (a: number | string, b: number | string) => boolean): Op {
  return (arg, env) => {
    const [left, right] = args(arg, 2).map((x) => evaluate(x, env));
    if (isUnknown(left) || isUnknown(right) || left === MISSING || right === MISSING) return UNKNOWN;
    const ok = (isNumber(left) && isNumber(right)) || (typeof left === "string" && typeof right === "string");
    if (!ok) throw new SpecError(`cannot order ${String(left)} and ${String(right)}`);
    return check(left as number | string, right as number | string);
  };
}

const opEq: Op = (arg, env) => {
  const [left, right] = args(arg, 2).map((x) => evaluate(x, env));
  if (isUnknown(left) || isUnknown(right)) return UNKNOWN;
  return equals(left, right);
};

const opNe: Op = (arg, env) => {
  const v = opEq(arg, env);
  return isUnknown(v) ? UNKNOWN : !v;
};

function numbers(arg: unknown, env: Env, count?: number): number[] | null {
  const values = args(arg, count).map((x) => evaluate(x, env));
  if (values.some((v) => isUnknown(v) || v === MISSING)) return null;
  for (const v of values) if (!isNumber(v)) throw new SpecError(`not a number: ${String(v)}`);
  return values as number[];
}

const opAdd: Op = (arg, env) => {
  const v = numbers(arg, env);
  return v === null ? UNKNOWN : v.reduce((s, x) => s + x, 0);
};
const opSub: Op = (arg, env) => {
  const v = numbers(arg, env, 2);
  return v === null ? UNKNOWN : v[0]! - v[1]!;
};
const opMul: Op = (arg, env) => {
  const v = numbers(arg, env, 2);
  return v === null ? UNKNOWN : v[0]! * v[1]!;
};

function list(v: unknown): unknown[] | null {
  if (isUnknown(v)) return null;
  if (v === MISSING || v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new SpecError(`not a list: ${String(v)}`);
  return v;
}

const opSum: Op = (arg, env) => {
  const items = list(evaluate(arg, env));
  if (items === null || items.some(isUnknown)) return UNKNOWN;
  for (const v of items) if (!isNumber(v)) throw new SpecError(`not a number: ${String(v)}`);
  return (items as number[]).reduce((s, x) => s + x, 0);
};

const opLen: Op = (arg, env) => {
  const v = evaluate(arg, env);
  if (typeof v === "string") return [...v].length;
  const items = list(v);
  if (items === null || items.some(isUnknown)) return UNKNOWN;
  return items.length;
};

const opStartswith: Op = (arg, env) => {
  const [text, prefix] = args(arg, 2).map((x) => evaluate(x, env));
  if (isUnknown(text) || isUnknown(prefix)) return UNKNOWN;
  return typeof text === "string" && typeof prefix === "string" && text.startsWith(prefix);
};

const regexCache = new Map<string, RegExp>();
const opMatches: Op = (arg, env) => {
  const [text, pattern] = args(arg, 2).map((x) => evaluate(x, env));
  if (isUnknown(text) || isUnknown(pattern)) return UNKNOWN;
  if (typeof text !== "string" || typeof pattern !== "string") return false;
  let re = regexCache.get(pattern);
  if (!re) regexCache.set(pattern, (re = new RegExp(pattern)));
  return re.test(text);
};

const opIn: Op = (arg, env) => {
  const [needle, haystack] = args(arg, 2).map((x) => evaluate(x, env));
  const items = list(haystack);
  if (isUnknown(needle) || items === null) return UNKNOWN;
  let unknown = false;
  for (const item of items) {
    if (isUnknown(item)) unknown = true;
    else if (equals(item, needle)) return true;
  }
  return unknown ? UNKNOWN : false;
};

const opAsList: Op = (arg, env) => {
  const v = evaluate(arg, env);
  if (v === MISSING || v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
};

function rows(spec: unknown, env: Env): [unknown[] | null, string, Record<string, unknown>] {
  if (!isPlainObject(spec) || !hasOwn(spec, "from")) throw new SpecError(`expected {from, where}: ${JSON.stringify(spec)}`);
  return [list(evaluate(spec.from, env)), String(spec.as ?? "row"), spec];
}

const rowEnv = (env: Env, name: string, row: unknown): Env => ({ ...env, [name]: row });

const opSelect: Op = (arg, env) => {
  const [items, name, spec] = rows(arg, env);
  if (items === null) return UNKNOWN;
  const out: unknown[] = [];
  for (const row of items) {
    const scoped = rowEnv(env, name, row);
    const keep = hasOwn(spec, "where") ? test(spec.where, scoped) : true;
    if (keep === false) continue;
    if (keep !== true) {
      out.push(UNKNOWN);
      continue;
    }
    out.push(hasOwn(spec, "map") ? evaluate(spec.map, scoped) : row);
  }
  return out;
};

const opFind: Op = (arg, env) => {
  const [items, name, spec] = rows(arg, env);
  if (items === null) return UNKNOWN;
  for (const row of items) {
    const keep = test(spec.where, rowEnv(env, name, row));
    if (keep === true) return row;
    if (keep !== false) return UNKNOWN;
  }
  return MISSING;
};

const opAny: Op = (arg, env) => {
  const [items, name, spec] = rows(arg, env);
  if (items === null) return UNKNOWN;
  let unknown = false;
  for (const row of items) {
    const v = test(hasOwn(spec, "where") ? spec.where : true, rowEnv(env, name, row));
    if (v === true) return true;
    if (v !== false) unknown = true;
  }
  return unknown ? UNKNOWN : false;
};

const opAll: Op = (arg, env) => {
  const [items, name, spec] = rows(arg, env);
  if (items === null) return UNKNOWN;
  let unknown = false;
  for (const row of items) {
    const v = test(spec.where, rowEnv(env, name, row));
    if (v === false) return false;
    if (v !== true) unknown = true;
  }
  return unknown ? UNKNOWN : true;
};

const opKnown: Op = (arg, env) => deepKnown(evaluate(arg, env));

const opPresent: Op = (arg, env) => {
  const v = evaluate(arg, env);
  if (isUnknown(v)) return true;
  return !(v === MISSING || v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0));
};

const TIME = /^(\d{1,2}):(\d{2})(?:\+(\d+))?$/;

export function parseTime(v: unknown): unknown {
  if (typeof v !== "string") return UNKNOWN;
  const m = TIME.exec(v.trim());
  if (!m) return UNKNOWN;
  return Number(m[3] ?? 0) * 1440 + Number(m[1]) * 60 + Number(m[2]);
}

export function formatTime(minutes: unknown): unknown {
  if (!isNumber(minutes)) return UNKNOWN;
  const total = Math.trunc(minutes);
  const days = Math.floor(total / 1440);
  const rest = total - days * 1440;
  const text = `${String(Math.floor(rest / 60)).padStart(2, "0")}:${String(rest % 60).padStart(2, "0")}`;
  return days ? `${text}+${days}` : text;
}

const opTime: Op = (arg, env) => parseTime(evaluate(arg, env));
const opFmtTime: Op = (arg, env) => formatTime(evaluate(arg, env));

const opIf: Op = (arg, env) => {
  const [condition, then, otherwise] = args(arg, 3);
  const v = test(condition, env);
  if (isUnknown(v)) return UNKNOWN;
  return evaluate(v ? then : otherwise, env);
};

const opGet: Op = (arg, env) => {
  const [target, path] = args(arg, 2);
  return resolve(`$v.${String(path)}`, { v: evaluate(target, env) });
};

const opLit: Op = (arg) => arg;

/** 全部运算。二狗的扩展运算（path_within）由 ../rule-ops.ts 加进来，这个文件不认识它们 */
export const OPS: Record<string, Op> = {
  and: opAnd,
  or: opOr,
  not: opNot,
  eq: opEq,
  ne: opNe,
  lt: compare((a, b) => a < b),
  le: compare((a, b) => a <= b),
  gt: compare((a, b) => a > b),
  ge: compare((a, b) => a >= b),
  add: opAdd,
  sub: opSub,
  mul: opMul,
  sum: opSum,
  len: opLen,
  startswith: opStartswith,
  matches: opMatches,
  in: opIn,
  as_list: opAsList,
  select: opSelect,
  find: opFind,
  any: opAny,
  all: opAll,
  known: opKnown,
  present: opPresent,
  time: opTime,
  fmt_time: opFmtTime,
  if: opIf,
  get: opGet,
  lit: opLit,
};

// ───────────────────────── 显示与 JSON ─────────────────────────

export function display(v: unknown): string {
  if (isUnknown(v)) return v.desc === null || v.desc === undefined ? "?" : String(v.desc);
  if (v === MISSING || v === null || v === undefined) return "?";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(display).join("、"); // @i18n-ignore data：引擎原样的写法（规则说明里列值）
  if (isPlainObject(v)) return canonical(v);
  return String(v);
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).toSorted()) out[k] = stable(v[k]);
    return out;
  }
  return v;
}

/** 键排好序的紧凑 JSON */
export const canonical = (v: unknown): string => JSON.stringify(stable(toJson(v)));

/** message 里的占位符 `{a.b}` */
export const PLACEHOLDER = /\{([A-Za-z_][\w.]*)\}/g;

export const render = (template: string, env: Env): string => template.replace(PLACEHOLDER, (_, name: string) => display(resolve(`$${name}`, env)));

export function toJson(v: unknown): unknown {
  if (isUnknown(v)) return { $unknown: v.desc ?? null };
  if (v === MISSING || v === undefined) return null;
  if (Array.isArray(v)) return v.map(toJson);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toJson(x);
    return out;
  }
  return v;
}

export function fromJson(v: unknown): unknown {
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$unknown") return new Unknown(v.$unknown);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = fromJson(v[k]);
    return out;
  }
  if (Array.isArray(v)) return v.map(fromJson);
  return v;
}

/** 深拷贝，保留 Unknown / MISSING 标记 */
export function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out as T;
  }
  return v;
}
