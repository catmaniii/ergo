// MCP 登记（规格第 9、18、20 节，27 号票）：用户在数据目录配置区的 mcp.json 里登记 MCP，二狗只读（配置区是受保护区域，
// agent 写不进去）。登记了才能写进项目或任务的工具包、授权给维护者；每次用到时现读，改了不用重启。
// 239 号票起 agent 有了提登记的入口：维护者用 request_mcp_change 出一张"MCP 登记变更"卡，用户确认之后由运行时写这个文件
// （mcp/change.ts、mcp/writer.ts）——agent 自己仍然写不进来。
//
// 一个 MCP 的登记：
// - 怎么拉起它的服务进程：command、args、cwd；env 是给它的环境变量——写字符串是原样的值，写 { "fromEnv": "名字" } 是
//   守护进程按名字从自己的环境里取（LSM 从数据目录的密钥区注入守护进程的那些），这就是"凭据由守护进程按登记注入"。
//   服务进程的环境 = 系统变量白名单 + 这些，不继承守护进程的其他环境；agent 子进程和它起的进程都碰不到这些凭据；
// - tools：用到的每个工具登记类别标签、底线、参数规则（同工具注册表，规格第 9 节）、"只读或幂等"（21 节）、要不要联网
//   （不写按要联网算：联网开关关着时会话里没有它）、"做完告诉我"；给模型看的说明和参数的 JSON Schema 可以写在这里，
//   不写就用服务进程自己报的（tools/list）；
// - 工具的 quickAction：授权给秘书的快速动作（14 节"调用一个已登记并授权给秘书快速动作的 MCP 工具，参数固定"），
//   写快速动作的说法和固定的参数。
// 没登记的工具不进会话（服务进程报了也不用）。
import fs from "node:fs";
import { t } from "@ergo/protocol";
import { MCP_NAME_PATTERN, schemaChecker, type Static, Type } from "@ergo/protocol";
import { ARG_KINDS, ARG_VALUE_TYPES, BOTTOM_LINE_IDS, BUILTIN_CATEGORY_IDS, PATH_ACCESSES, type ToolDescriptor } from "../guard/index.ts";

const Name = Type.String({ pattern: MCP_NAME_PATTERN, maxLength: 64 });

const ArgRuleSchema = Type.Object(
  {
    kind: Type.Enum(ARG_KINDS),
    access: Type.Optional(Type.Enum(PATH_ACCESSES)),
    replaces: Type.Optional(Type.Boolean()),
    defaultsToCwd: Type.Optional(Type.Boolean()),
    pattern: Type.Optional(Type.String()),
    type: Type.Optional(Type.Enum(ARG_VALUE_TYPES)),
    list: Type.Optional(Type.Boolean()),
    payload: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const McpToolRegistration = Type.Object(
  {
    /** 中文名（说明、审批卡、快速动作卡里用） */
    title: Type.String({ minLength: 1, maxLength: 60 }),
    /** 给模型看的说明；不写用服务进程报的 */
    description: Type.Optional(Type.String({ maxLength: 4000 })),
    /** 参数的 JSON Schema；不写用服务进程报的（服务进程还没起来过时，先给一个只要求是对象的） */
    inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** 落入的内置关注类别 */
    categories: Type.Optional(Type.Array(Type.Enum(BUILTIN_CATEGORY_IDS))),
    /** 底线（付款转账、建账户、改密码……） */
    bottomLines: Type.Optional(Type.Array(Type.Enum(BOTTOM_LINE_IDS))),
    /** 参数规则：参数名 → 规则（路径、收件人、网址……），守卫按它检查 */
    args: Type.Optional(Type.Record(Type.String(), ArgRuleSchema)),
    /** 只读或幂等（被打断后可以直接重跑） */
    readOnlyOrIdempotent: Type.Optional(Type.Boolean()),
    /** 要联网（不写按要联网算） */
    network: Type.Optional(Type.Boolean()),
    /** 做完告诉我 */
    notifyWhenDone: Type.Optional(Type.Boolean()),
    /** 会把参数里的内容发出去（"不重复发"、对外内容不许含密钥看它） */
    outbound: Type.Optional(Type.Boolean()),
    /** 授权给秘书的快速动作：说法和固定的参数 */
    quickAction: Type.Optional(
      Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 100 }),
          args: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type McpToolRegistration = Static<typeof McpToolRegistration>;

/** 一个登记的工具交给守卫的那几样（会话里的 MCP 工具在工具注册表里的登记、秘书快速动作的关注都从这里取）：不写联网标记按要联网算 */
export function guardFieldsOf(reg: McpToolRegistration): Omit<ToolDescriptor, "name" | "title" | "source"> {
  return {
    categories: reg.categories ?? [],
    ...(reg.bottomLines ? { bottomLines: reg.bottomLines } : {}),
    args: reg.args ?? {},
    ...(reg.notifyWhenDone ? { notifyWhenDone: true } : {}),
    readOnlyOrIdempotent: reg.readOnlyOrIdempotent === true,
    network: reg.network !== false,
    ...(reg.outbound ? { outbound: true } : {}),
  };
}

const EnvValue = Type.Union([Type.String(), Type.Object({ fromEnv: Type.String({ minLength: 1 }) }, { additionalProperties: false })]);

/** 一个 MCP 的登记（schema 也给 MCP 登记变更的工具用：写进去之前按它再校一遍，239 号票） */
export const McpServerRegistrationSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 60 })),
    command: Type.String({ minLength: 1 }),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.String()),
    /** 单次调用、自检最多等多久（毫秒）；不写按工具调用的默认超时（239 号票） */
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 600_000 })),
    env: Type.Optional(Type.Record(Type.String(), EnvValue)),
    tools: Type.Record(Name, McpToolRegistration),
  },
  { additionalProperties: false },
);
export type McpServerRegistration = Static<typeof McpServerRegistrationSchema>;

const McpRegistrationFile = Type.Object({ servers: Type.Record(Name, McpServerRegistrationSchema) }, { additionalProperties: false });
export type McpRegistrations = Static<typeof McpRegistrationFile>["servers"];

const checker = schemaChecker(McpRegistrationFile);

/** 读出来的登记；读不了、写错了时 problem 写明，servers 是空的（一个也不用） */
export interface McpRegistrationRead {
  servers: McpRegistrations;
  problem?: string;
}

/** 现读配置区的 mcp.json；没有这个文件就是没登记 */
export function readMcpRegistrations(file: string): McpRegistrationRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { servers: {} };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    return { servers: {}, problem: t("mcp.registration.badJson", { file, message: err instanceof Error ? err.message : String(err) }) };
  }
  if (!checker.check(value)) return { servers: {}, problem: t("mcp.registration.invalid", { file, message: checker.firstError(value) ?? "" }) };
  return { servers: value.servers };
}

/**
 * 服务进程的环境变量：原样的值，加上按登记从守护进程环境里取的凭据（取不到的不给，说明里写出缺了哪些）。
 * secrets 是注入的凭据值：服务进程的输出、工具结果、它报的说明里出现了一律擦掉（mcp.ts）；
 * injected 是这些凭据的来路（240 号票：秘书带参调用时，参数里出现的注入值换成"来自环境变量 X"，不写原值）
 */
export function serverEnv(
  registration: McpServerRegistration,
  parentEnv: Readonly<Record<string, string | undefined>>,
): { env: Record<string, string>; missing: string[]; secrets: string[]; injected: Array<{ name: string; variable: string; value: string }> } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  const secrets: string[] = [];
  const injected: Array<{ name: string; variable: string; value: string }> = [];
  for (const [name, value] of Object.entries(registration.env ?? {})) {
    if (typeof value === "string") env[name] = value;
    else {
      const found = Object.entries(parentEnv).find(([k]) => k.toUpperCase() === value.fromEnv.toUpperCase())?.[1];
      if (found === undefined || found === "") missing.push(value.fromEnv);
      else {
        env[name] = found;
        secrets.push(found);
        injected.push({ name, variable: value.fromEnv, value: found });
      }
    }
  }
  return { env, missing, secrets, injected };
}
