// 操作的参数（268 号票，草稿："参数不对时守护进程按清单校验、把这个操作的说明随报错退回"；参数"少而简单、枚举带中文名、有默认值，适合语音"）：
// - prepareArgs：call 之前按清单里的 JSON Schema（inputSchema）整理、校验——
//   1. 枚举带中文名的（enum + enumNames，或者 oneOf / anyOf 里每项 { const, title }），秘书写了中文名的换成对应的值（"午饭" → "lunch"）；
//   2. 没写、清单里有默认值（default）的顶层参数补上默认值；
//   3. 按整份 JSON Schema 校验（TypeBox 的 Compile 直接认 JSON Schema），不对的说清哪个参数、哪里不对：调用方不发请求，连同说明退回给秘书；
// - schemaProblems / schemaWarnings：验收时看参数说明本身写得对不对（属性是对象、required 里的都有、枚举有中文名且个数对得上、
//   默认值合乎自己的 schema）；参数太多、嵌套的对象、可选的没写默认值只提醒，不挡验收。
// @i18n-ignore-file model：参数哪里不对交给秘书（工具结果）
import { Compile } from "typebox/compile";
import { type OpsMsg, problem } from "./problems.ts";

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

/** 编好的校验器（按 schema 的 JSON 缓存；清单改了 schema 就变，旧的留着不碍事，最多留 500 份） */
const compiled = new Map<string, ReturnType<typeof Compile>>();

function validatorOf(schema: Schema): ReturnType<typeof Compile> {
  const key = JSON.stringify(schema);
  let v = compiled.get(key);
  if (!v) {
    v = Compile(schema as never);
    if (compiled.size >= 500) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, v);
  }
  return v;
}

/** 顶层的参数（properties 里每一个；写坏了的不算） */
export function propertiesOf(schema: Schema): Array<[string, Schema]> {
  const props = schema.properties;
  if (!isObject(props)) return [];
  return Object.entries(props).flatMap(([name, value]) => (isObject(value) ? [[name, value] as [string, Schema]] : []));
}

/** 必填的参数 */
export const requiredOf = (schema: Schema): string[] => (Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : []);

/** 一个枚举的选项：值和中文名（enum + enumNames，或者 oneOf / anyOf 里的 { const, title }）；不是枚举的是 undefined */
export function enumOptions(prop: Schema): Array<{ value: unknown; name?: string }> | undefined {
  if (Array.isArray(prop.enum)) {
    const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
    return prop.enum.map((value, i) => (typeof names[i] === "string" ? { value, name: names[i] as string } : { value }));
  }
  const list = Array.isArray(prop.oneOf) ? prop.oneOf : Array.isArray(prop.anyOf) ? prop.anyOf : undefined;
  if (list && list.length > 0 && list.every((o) => isObject(o) && "const" in o)) {
    return list.map((o) => {
      const item = o as Schema;
      return typeof item.title === "string" ? { value: item.const, name: item.title } : { value: item.const };
    });
  }
  return undefined;
}

/** 整理、校验的结果：能发的参数，或者哪里不对（说给秘书听的话） */
export type PreparedArgs = { ok: true; args: Record<string, unknown>; mapped: string[]; defaulted: string[] } | { ok: false; problems: string[] };

/** call 之前整理、校验参数（见文件开头） */
export function prepareArgs(schema: Schema, given: Record<string, unknown>): PreparedArgs {
  const args: Record<string, unknown> = { ...given };
  const mapped: string[] = [];
  const defaulted: string[] = [];
  for (const [name, prop] of propertiesOf(schema)) {
    const options = enumOptions(prop);
    const value = args[name];
    if (options && typeof value === "string" && !options.some((o) => o.value === value)) {
      const byName = options.find((o) => o.name !== undefined && o.name.trim() === value.trim());
      if (byName) {
        args[name] = byName.value;
        mapped.push(`${name}：${value} → ${JSON.stringify(byName.value)}`);
      }
    }
    if (args[name] === undefined && "default" in prop) {
      args[name] = prop.default;
      defaulted.push(name);
    }
  }
  let validator: ReturnType<typeof Compile>;
  try {
    validator = validatorOf(schema);
  } catch (err) {
    return { ok: false, problems: [`清单里这个操作的参数说明（JSON Schema）用不了：${(err as Error).message}`] };
  }
  if (validator.Check(args)) return { ok: true, args, mapped, defaulted };
  const problems = validator.Errors(args).map((e) => `${e.instancePath ? `参数 ${e.instancePath.replace(/^\//, "").replace(/\//g, ".")}` : "参数"}：${e.message}`);
  // 枚举不对的把能写的列出来（值和中文名）
  for (const [name, prop] of propertiesOf(schema)) {
    const options = enumOptions(prop);
    if (options && args[name] !== undefined && !options.some((o) => o.value === args[name])) {
      problems.push(`参数 ${name} 只能写：${options.map((o) => (o.name ? `${JSON.stringify(o.value)}（${o.name}）` : JSON.stringify(o.value))).join("、")}`);
    }
  }
  return { ok: false, problems: [...new Set(problems)] };
}

/** 一个值合不合这份 schema（默认值、测试的参数用） */
export function fits(schema: Schema, value: unknown): { ok: true } | { ok: false; reason: string } {
  try {
    const v = validatorOf(schema);
    if (v.Check(value)) return { ok: true };
    const first = v.Errors(value)[0];
    return { ok: false, reason: first ? `${first.instancePath || "/"} ${first.message}` : "不合 schema" };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 验收：参数说明本身写得对不对（name 是操作名） */
export function schemaProblems(name: string, schema: Schema): OpsMsg[] {
  const out: OpsMsg[] = [];
  try {
    validatorOf(schema);
  } catch (err) {
    return [problem("schemaUnusable", { name, reason: (err as Error).message })];
  }
  const props = schema.properties;
  if (props !== undefined && !isObject(props)) return [problem("schemaPropNotObject", { name, prop: "properties" })];
  for (const [prop, value] of Object.entries(isObject(props) ? props : {})) {
    if (!isObject(value)) out.push(problem("schemaPropNotObject", { name, prop }));
  }
  for (const r of requiredOf(schema)) if (!isObject(props) || !(r in props)) out.push(problem("schemaRequiredUnknown", { name, prop: r }));
  for (const [prop, value] of propertiesOf(schema)) {
    const options = enumOptions(value);
    if (options) {
      if (Array.isArray(value.enumNames) && value.enumNames.length !== options.length) out.push(problem("schemaEnumNamesLength", { name, prop }));
      else if (options.some((o) => o.name === undefined || o.name.trim() === "")) out.push(problem("schemaEnumNames", { name, prop }));
    }
    if ("default" in value) {
      const ok = fits(withoutEnumNames(value), value.default);
      if (!ok.ok) out.push(problem("schemaDefaultInvalid", { name, prop, reason: ok.reason }));
    }
  }
  return out;
}

/** 验收：只提醒、不挡的（参数太多、嵌套的对象、可选的没写默认值） */
export function schemaWarnings(name: string, schema: Schema): OpsMsg[] {
  const out: OpsMsg[] = [];
  const props = propertiesOf(schema);
  if (props.length > 8) out.push(problem("warnManyParams", { name, count: props.length }));
  const required = requiredOf(schema);
  for (const [prop, value] of props) {
    const nested = value.type === "object" || (value.type === "array" && isObject(value.items) && value.items.type === "object");
    if (nested) out.push(problem("warnNested", { name, prop }));
    if (!required.includes(prop) && !("default" in value)) out.push(problem("warnNoDefault", { name, prop }));
  }
  return out;
}

/** enumNames 不是 JSON Schema 的关键字，校验默认值时拿掉（TypeBox 不认识的关键字本来也不管，这里只为清楚） */
function withoutEnumNames(prop: Schema): Schema {
  const { enumNames: _names, ...rest } = prop;
  return rest;
}

/**
 * 参数写成几行给秘书看（describe）：名字、类型、必填还是默认值、枚举的值和中文名、说明。schema 的原文另外照给
 */
export function paramLines(schema: Schema): string[] {
  const required = requiredOf(schema);
  return propertiesOf(schema).map(([name, prop]) => {
    const options = enumOptions(prop);
    const type = options ? `只能写 ${options.map((o) => (o.name ? `${JSON.stringify(o.value)}（${o.name}）` : JSON.stringify(o.value))).join("、")}` : typeof prop.type === "string" ? prop.type : "";
    const need = required.includes(name) ? "必填" : "default" in prop ? `默认 ${JSON.stringify(prop.default)}` : "可不写";
    const desc = typeof prop.description === "string" ? `：${prop.description}` : typeof prop.title === "string" ? `：${prop.title}` : "";
    return `- ${name}（${[type, need].filter(Boolean).join("，")}）${desc}`;
  });
}

/** 绑定的参数里的占位："{{参数名}}"（整个值就是占位的保持参数原来的类型，夹在字里的代入成文字） */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** 绑定里引用了哪些参数 */
export function placeholdersIn(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  if (Array.isArray(value)) return value.flatMap(placeholdersIn);
  if (isObject(value)) return Object.values(value).flatMap(placeholdersIn);
  return [];
}

/** 代入参数（ergo 绑定的参数、maintainer 交给维护者的话）：没给的参数代入成空（整个值是占位的去掉这个键） */
export function bindPlaceholders(value: unknown, args: Readonly<Record<string, unknown>>): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
    if (whole) return args[whole[1]!];
    return value.replace(PLACEHOLDER, (_m, name: string) => {
      const v = args[name];
      return v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => bindPlaceholders(v, args));
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const bound = bindPlaceholders(v, args);
      if (bound !== undefined) out[k] = bound;
    }
    return out;
  }
  return value;
}
