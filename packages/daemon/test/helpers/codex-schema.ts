// 按 Codex 0.166 生成的协议 schema 校验（test/fixtures/codex-app-server.schema.json，由 fixtures/trim-codex-schema.mjs 裁出）：
// 假 app-server 发的回复、通知、请求，适配子进程发的请求、回的结果都过它，不一致就算错，这样假的和真的协议对得上。
// 不加依赖：这里是 draft-07 里这份 schema 用到的那一小部分（$ref、allOf、anyOf、oneOf、type、enum、const、required、properties、additionalProperties、items）。
// oneOf 按"至少一个"判（生成的 schema 里 serde 的 untagged 会有几个都对的）。
import fs from "node:fs";
import { fileURLToPath } from "node:url";

type Schema = boolean | SchemaObject;

interface SchemaObject {
  $ref?: string;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: Schema;
  items?: Schema | Schema[];
}

interface SchemaFile {
  codexVersion: string;
  requests: Record<string, { params: Schema; response: Schema }>;
  serverRequests: Record<string, { params: Schema; response: Schema }>;
  notifications: Record<string, Schema>;
  definitions: { v2: Record<string, Schema> } & Record<string, unknown>;
}

const file = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../fixtures/codex-app-server.schema.json", import.meta.url)), "utf8")) as SchemaFile;

function resolve(ref: string): Schema {
  const parts = ref.replace("#/definitions/", "").split("/");
  const found = parts.reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], file.definitions);
  if (found === undefined) throw new Error(`schema 里没有 ${ref}：要重新跑 fixtures/trim-codex-schema.mjs`);
  return found as Schema;
}

const typeOk = (type: string, value: unknown): boolean => {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return true;
  }
};

function check(schema: Schema, value: unknown, at: string, errors: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${at}：这里不该有值`);
    return;
  }
  if (schema.$ref !== undefined) check(resolve(schema.$ref), value, at, errors);
  for (const part of schema.allOf ?? []) check(part, value, at, errors);
  for (const options of [schema.anyOf, schema.oneOf]) {
    if (!options) continue;
    const attempts = options.map((option) => {
      const inner: string[] = [];
      check(option, value, at, inner);
      return inner;
    });
    if (!attempts.some((a) => a.length === 0)) errors.push(`${at}：没有一种写法对得上（${attempts.map((a) => a[0]).join("；")}）`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeOk(type, value))) {
      errors.push(`${at}：要 ${types.join("|")}，是 ${JSON.stringify(value)?.slice(0, 80)}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}：${JSON.stringify(value)} 不在 ${JSON.stringify(schema.enum)} 里`);
  if ("const" in schema && schema.const !== value) errors.push(`${at}：要 ${JSON.stringify(schema.const)}`);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) if (!(name in object)) errors.push(`${at}.${name}：缺了`);
    for (const [name, inner] of Object.entries(schema.properties ?? {})) if (name in object) check(inner, object[name], `${at}.${name}`, errors);
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const [name, inner] of Object.entries(object)) {
        if (schema.properties && name in schema.properties) continue;
        check(schema.additionalProperties, inner, `${at}.${name}`, errors);
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      const inner = Array.isArray(schema.items) ? schema.items[i] : schema.items;
      if (inner !== undefined) check(inner as Schema, item, `${at}[${i}]`, errors);
    });
  }
}

function validate(schema: Schema, value: unknown, label: string): string[] {
  const errors: string[] = [];
  check(schema, value, label, errors);
  return errors;
}

/** 请求参数顶层多写的字段（schema 没有禁止多写，真的 app-server 会默默忽略：写错名字发现不了，这里当错） */
function unknownFields(schema: Schema, value: unknown, label: string): string[] {
  let at = schema;
  while (typeof at === "object" && at.$ref !== undefined) at = resolve(at.$ref);
  if (typeof at !== "object" || !at.properties || typeof value !== "object" || value === null) return [];
  const known = at.properties;
  return Object.keys(value).filter((name) => !(name in known)).map((name) => `${label}.${name}：协议里没有这个字段`);
}

export const codexSchema = {
  version: file.codexVersion,
  /** 适配子进程发的请求的参数 */
  requestParams(method: string, params: unknown): string[] {
    const entry = file.requests[method];
    if (!entry) return [`${method}：不在用到的方法表里（fixtures/trim-codex-schema.mjs）`];
    return [...validate(entry.params, params, method), ...unknownFields(entry.params, params, method)];
  },
  /** 假 app-server 回的结果 */
  requestResult(method: string, result: unknown): string[] {
    const entry = file.requests[method];
    return entry ? validate(entry.response, result, `${method} 的回复`) : [`${method}：不在用到的方法表里`];
  },
  /** 假 app-server 发来的请求的参数 */
  serverRequestParams(method: string, params: unknown): string[] {
    const entry = file.serverRequests[method];
    return entry ? validate(entry.params, params, method) : [`${method}：不在用到的方法表里`];
  },
  /** 适配子进程回的结果 */
  serverRequestResult(method: string, result: unknown): string[] {
    const entry = file.serverRequests[method];
    return entry ? validate(entry.response, result, `${method} 的回复`) : [`${method}：不在用到的方法表里`];
  },
  /** 假 app-server 发的通知 */
  notification(method: string, params: unknown): string[] {
    const schema = file.notifications[method];
    return schema === undefined ? [`${method}：不在用到的通知表里`] : validate(schema, params, method);
  },
};
