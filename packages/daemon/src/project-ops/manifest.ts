// 运营接口清单（260 号票；268 号票照用户 2026-10-13 的设计草稿补齐）：项目档案里的 ops.json，维护者写，验收过了才登记给秘书用
// （registry.ts：验收 acceptance.ts、登记带版本号；秘书用的是登记着的那一版，档案里改了重新验收、版本号加一）。
// 格式照 MCP 的 tools/list（用户 2026-10-13 定"清单照 MCP 格式"），每个操作在 MCP 的 Tool 上多写几样（草稿逐条）：
//   {
//     "endpoint": { "service": "<服务名>", "path": "/ops" },   // 本机调用口（http 实现方式用）：可不写，默认 path 是 /ops、service 是这个项目唯一的服务
//     "tools": [ {
//       "name", "title"（中文标题）, "description"（做什么、什么时候用）, "userSays"（用户可能怎么说，几句）,
//       "kind"（query 只读查询 / action 有副作用的动作 / run 触发一次运行）,
//       "inputSchema"（参数：JSON Schema 的对象；少而简单、枚举带中文名 enumNames、有默认值 default）,
//       "returns"（返回什么：能念的那句 say 说什么、附件里有什么）, "risk"（direct 直接做 / confirm 要确认 / handoff 交给我做：只记不做）,
//       "impl"（实现方式，不写是 http）, "usage"（可选的用法说明，describe 时一起给）, "test"（验收用的一条测试：{ "args", "sayIncludes"? }）
//     } ]
//   }
// - 种类：旧清单（260 号票的）只写了 annotations.readOnlyHint 的照读——true 是只读查询，false 是有副作用的动作；两个都写的要对得上
//   （query 配 true，action / run 配 false）。都没写的照 MCP 的默认算有副作用的动作（验收时要求写明 kind）。
// - 实现方式（impl.type）：
//   - http：项目服务的本机调用口（call.ts，260 号票那一套）；
//   - script：工作目录里的脚本，JSON 进出（script.ts）——file 是相对项目工作目录的路径，按扩展名选解释器，args 是固定的附加参数；
//   - ergo：二狗自带动作绑参数（builtin.ts：就是白送的那几个通用操作）——action 是动作名，params 是绑定的参数，
//     值可以写 "{{参数名}}" 代入这个操作的参数；
//   - maintainer：转给项目的维护者当工单（建一个项目内部的普通任务，派一张执行的工单）——instructions 是交给维护者的话，可以写 "{{参数名}}"。
// - 白送的通用操作（builtin.ts）的名字项目清单里不能再用；$ 开头的键（模板里的 $comment、$example）是说明，不算操作。
// 这里只管读得通不通（结构、类型）：写坏了的整份不用，说清哪里坏（problems.ts 的 OpsMsg）。写全了没有（标题、用户可能怎么说、测试……）、
// 参数说明写得对不对、测试跑不跑得通是验收的事（acceptance.ts）。
import crypto from "node:crypto";
import fs from "node:fs";
import { isNameOrOld, t } from "@ergo/protocol";
import { problem, type OpsMsg } from "./problems.ts";

/** 三种操作（草稿：只读查询 / 有副作用的动作 / 触发一次运行） */
export const OP_KINDS = ["query", "action", "run"] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** 风险标记（草稿：直接做 / 要确认 / 交给我做，映射到关注类别）：用户 2026-10-25 定只记不做——清单里能写、照读照显示，不接守卫 */
export const OP_RISKS = ["direct", "confirm", "handoff"] as const;
export type OpRisk = (typeof OP_RISKS)[number];

/** 四种实现方式 */
export const OP_IMPL_TYPES = ["http", "script", "ergo", "maintainer"] as const;
export type OpImplType = (typeof OP_IMPL_TYPES)[number];

export type OpImpl =
  | { type: "http" }
  | { type: "script"; file: string; args: string[] }
  | { type: "ergo"; action: string; params: Record<string, unknown> }
  | { type: "maintainer"; instructions?: string };

/** 验收用的一条测试：照这些参数调一次（带着测试标记），sayIncludes 是能念的那句里要有的字 */
export interface OpTest {
  args: Record<string, unknown>;
  sayIncludes?: string;
}

/** 一个操作（读出来、补齐默认值之后） */
export interface ProjectOp {
  name: string;
  title?: string;
  description: string;
  /** 用户可能怎么说 */
  userSays: string[];
  kind: OpKind;
  /** 种类是怎么来的：写明的 kind、旧清单的 readOnlyHint、都没写（照 MCP 的默认） */
  kindFrom: "kind" | "readOnlyHint" | "default";
  /** MCP 的 inputSchema（JSON Schema 的对象）；没写的是 { type: "object", properties: {} } */
  inputSchema: Record<string, unknown>;
  returns?: string;
  risk?: OpRisk;
  impl: OpImpl;
  usage?: string;
  test?: OpTest;
}

/** 本机调用口：在哪个服务上（不写是这个项目唯一的服务）、哪个路径 */
export interface OpsEndpoint {
  service?: string;
  path: string;
}

export type OpsManifestRead = { kind: "ok"; endpoint: OpsEndpoint; ops: ProjectOp[] } | { kind: "missing" } | { kind: "broken"; problem: OpsMsg };

/** 调用口默认的路径 */
export const DEFAULT_OPS_PATH = "/ops";

/** MCP 的工具名：字母、数字、_ . -，1–128 个 */
export const OP_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** 调用口的路径：/ 开头、不是 // 开头（那会换掉主机）、没有空白和反斜杠 */
const OPS_PATH = /^\/(?!\/)[^\s\\]*$/;
/** 服务名（同 133 号票的服务名，宽一点：交方案时已经校验过） */
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 脚本认得的扩展名（script.ts 按它选解释器） */
export const SCRIPT_EXTENSIONS = [".mjs", ".js", ".cjs", ".ts", ".mts", ".py", ".ps1", ".cmd", ".bat", ".exe"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class Broken extends Error {
  readonly msg: OpsMsg;
  constructor(msg: OpsMsg) {
    super(msg.code);
    this.msg = msg;
  }
}

/** 清单内容的指纹：内容一样的验收一次就够（换行统一成 \n、去掉 BOM 再算） */
export function manifestHash(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/^﻿/, "").replace(/\r\n/g, "\n")).digest("hex").slice(0, 32);
}

/** 读档案里的 ops.json 原文：没有这个文件是 missing；读不了的是 broken */
export function readOpsText(file: string): { kind: "ok"; text: string } | { kind: "missing" } | { kind: "broken"; problem: OpsMsg } {
  try {
    return { kind: "ok", text: fs.readFileSync(file, "utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "broken", problem: problem("readFailed", { reason: (err as Error).message }) };
  }
}

/** 读项目档案里的 ops.json：没有这个文件是 missing（没交）；读不了、写坏了是 broken */
export function readOpsManifest(file: string, reserved: readonly string[] = []): OpsManifestRead {
  const read = readOpsText(file);
  return read.kind === "ok" ? parseOpsManifest(read.text, reserved) : read;
}

/** 解析一份 ops.json 的内容；reserved 是白送的通用操作的名字（项目清单里不能再用） */
export function parseOpsManifest(text: string, reserved: readonly string[] = []): Exclude<OpsManifestRead, { kind: "missing" }> {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    return { kind: "broken", problem: problem("notJson", { reason: (err as Error).message }) };
  }
  try {
    if (!isObject(json)) throw new Broken(problem("topNotObject"));
    const endpoint = endpointOf(json.endpoint);
    if (!Array.isArray(json.tools)) throw new Broken(problem("noTools"));
    const seen = new Set<string>();
    const ops = json.tools.map((tool, index) => {
      const op = opOf(tool, index);
      if (reserved.includes(op.name)) throw new Broken(problem("opReserved", { name: op.name }));
      if (seen.has(op.name)) throw new Broken(problem("opDuplicate", { name: op.name }));
      seen.add(op.name);
      return op;
    });
    return { kind: "ok", endpoint, ops };
  } catch (err) {
    if (err instanceof Broken) return { kind: "broken", problem: err.msg };
    throw err;
  }
}

function endpointOf(value: unknown): OpsEndpoint {
  if (value === undefined) return { path: DEFAULT_OPS_PATH };
  if (!isObject(value)) throw new Broken(problem("endpointNotObject"));
  const { service, path } = value;
  if (service !== undefined && (typeof service !== "string" || !SERVICE_NAME.test(service))) throw new Broken(problem("endpointService"));
  if (path !== undefined && (typeof path !== "string" || !OPS_PATH.test(path))) throw new Broken(problem("endpointPath"));
  return { ...(service === undefined ? {} : { service }), path: path ?? DEFAULT_OPS_PATH };
}

const optionalString = (value: unknown, name: string, code: Parameters<typeof problem>[0]): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Broken(problem(code, { name }));
  return value.trim() === "" ? undefined : value;
};

/** 种类：写明的 kind；旧清单的 readOnlyHint；都没写照 MCP 的默认算有副作用的动作。两个都写了要对得上 */
function kindOf(name: string, kind: unknown, readOnlyHint: unknown): Pick<ProjectOp, "kind" | "kindFrom"> {
  if (readOnlyHint !== undefined && typeof readOnlyHint !== "boolean") throw new Broken(problem("readOnlyHintNotBool", { name }));
  if (kind !== undefined) {
    if (typeof kind !== "string" || !(OP_KINDS as readonly string[]).includes(kind)) throw new Broken(problem("kindInvalid", { name, value: String(kind) }));
    if (readOnlyHint !== undefined && readOnlyHint !== (kind === "query")) throw new Broken(problem("kindConflict", { name }));
    return { kind: kind as OpKind, kindFrom: "kind" };
  }
  if (readOnlyHint !== undefined) return { kind: readOnlyHint ? "query" : "action", kindFrom: "readOnlyHint" };
  return { kind: "action", kindFrom: "default" };
}

/** 脚本的相对路径：不是绝对路径、不往上走出工作目录（..）、没有空字符 */
const relativeFile = (file: string) => file.trim() !== "" && !/^([a-zA-Z]:|[\\/])/.test(file) && !file.split(/[\\/]/).includes("..") && !file.includes("\0");

function implOf(name: string, value: unknown, actions: readonly string[]): OpImpl {
  if (value === undefined) return { type: "http" };
  if (!isObject(value)) throw new Broken(problem("implNotObject", { name }));
  // 312 号票：二狗自带动作的实现方式以前写作 ergou，早先交的清单里的旧写法照样认（读出来是 ergo）
  const type = isNameOrOld(value.type, "ergo") ? "ergo" : (value.type ?? "http");
  if (typeof type !== "string" || !(OP_IMPL_TYPES as readonly string[]).includes(type)) throw new Broken(problem("implTypeInvalid", { name, value: String(type) }));
  if (type === "http") return { type: "http" };
  if (type === "script") {
    const { file, args } = value;
    if (typeof file !== "string" || !relativeFile(file)) throw new Broken(problem("scriptFile", { name }));
    const ext = /\.[A-Za-z0-9]+$/.exec(file)?.[0]?.toLowerCase();
    if (!ext || !(SCRIPT_EXTENSIONS as readonly string[]).includes(ext)) throw new Broken(problem("scriptExt", { name, file, exts: SCRIPT_EXTENSIONS.join(" ") }));
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string" || a.includes("\0")))) throw new Broken(problem("scriptArgs", { name }));
    return { type: "script", file: file.trim(), args: (args as string[] | undefined) ?? [] };
  }
  if (type === "ergo") {
    const { action, params } = value;
    if (typeof action !== "string" || !actions.includes(action)) throw new Broken(problem("ergoAction", { name, action: String(action), actions: actions.join(t("protocol.common.listSep")) }));
    if (params !== undefined && !isObject(params)) throw new Broken(problem("ergoParams", { name }));
    return { type: "ergo", action, params: (params as Record<string, unknown> | undefined) ?? {} };
  }
  const instructions = optionalString(value.instructions, name, "maintainerInstructions");
  return { type: "maintainer", ...(instructions === undefined ? {} : { instructions }) };
}

function testOf(name: string, value: unknown): OpTest | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Broken(problem("testNotObject", { name }));
  const { args, sayIncludes } = value;
  if (args !== undefined && !isObject(args)) throw new Broken(problem("testArgsNotObject", { name }));
  if (sayIncludes !== undefined && (typeof sayIncludes !== "string" || sayIncludes.trim() === "")) throw new Broken(problem("testSayIncludes", { name }));
  return { args: (args as Record<string, unknown> | undefined) ?? {}, ...(typeof sayIncludes === "string" ? { sayIncludes: sayIncludes.trim() } : {}) };
}

/** 二狗自带的动作名（ergo 实现方式能绑的）：就是白送的通用操作（builtin.ts 里的名字；这里不引用它，免得循环） */
export const ERGO_ACTIONS = ["status", "recent_runs", "latest_deliverables", "run_now", "pause_resume", "reschedule", "tell_maintainer"] as const;

function opOf(tool: unknown, index: number): ProjectOp {
  const which = String(index + 1);
  if (!isObject(tool)) throw new Broken(problem("opNotObject", { which }));
  const { name, title, description, userSays, returns, usage, inputSchema, annotations, kind, risk, impl, test } = tool;
  if (name === undefined || name === "") throw new Broken(problem("opNoName", { which }));
  if (typeof name !== "string" || !OP_NAME.test(name)) throw new Broken(problem("opBadName", { which, name: String(name) }));
  const titled = optionalString(title, name, "titleNotString");
  const described = optionalString(description, name, "descriptionNotString");
  if (userSays !== undefined && (!Array.isArray(userSays) || userSays.some((s) => typeof s !== "string"))) throw new Broken(problem("userSaysNotStrings", { name }));
  const returned = optionalString(returns, name, "returnsNotString");
  const used = optionalString(usage, name, "usageNotString");
  if (inputSchema !== undefined && !isObject(inputSchema)) throw new Broken(problem("inputSchemaNotObject", { name }));
  if (isObject(inputSchema) && inputSchema.type !== undefined && inputSchema.type !== "object") throw new Broken(problem("inputSchemaType", { name }));
  if (annotations !== undefined && !isObject(annotations)) throw new Broken(problem("annotationsNotObject", { name }));
  const kinded = kindOf(name, kind, isObject(annotations) ? annotations.readOnlyHint : undefined);
  if (risk !== undefined && (typeof risk !== "string" || !(OP_RISKS as readonly string[]).includes(risk))) throw new Broken(problem("riskInvalid", { name, value: String(risk) }));
  const tested = testOf(name, test);
  return {
    name,
    ...(titled === undefined ? {} : { title: titled }),
    description: described ?? "",
    userSays: ((userSays as string[] | undefined) ?? []).map((s) => s.trim()).filter(Boolean),
    ...kinded,
    inputSchema: isObject(inputSchema) ? { type: "object", ...inputSchema } : { type: "object", properties: {} },
    ...(returned === undefined ? {} : { returns: returned }),
    ...(risk === undefined ? {} : { risk: risk as OpRisk }),
    impl: implOf(name, impl, ERGO_ACTIONS),
    ...(used === undefined ? {} : { usage: used }),
    ...(tested === undefined ? {} : { test: tested }),
  };
}

/** 只读查询（旧清单的"只读"） */
export const isReadOnly = (op: Pick<ProjectOp, "kind">) => op.kind === "query";
