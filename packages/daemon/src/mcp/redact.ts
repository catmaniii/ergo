// 秘书带参调用 MCP 的参数脱敏（240 号票）：时间线、mcp_called 事件、聊天里的工具调用摘要里都不出现密钥类的原值
// （参数照原样发给服务进程，脱敏只影响记录和显示）。
// 两种认法（和守卫的底线、30 号票的凭据不出守护进程同一套）：
// - 按登记注入给这个 MCP 的凭据值（env 里写 { fromEnv } 的那些）出现在参数里：整个值换成"来自环境变量 X"
//   （和"MCP 登记变更"卡上同一个说法），不写原值；
// - 名字看着是密钥的参数（SECRET_NAME）、像密钥的形态：换成星号 / "（密钥）"（guard/secrets.ts 的 maskSecretArgValues）。
// 参数里没有密钥类的东西时原样留着：时间线要看得懂到底做了什么。
import { t } from "@ergo/protocol";
import { maskSecretArgValues } from "../guard/index.ts";

/** 按登记注入给这个 MCP 的一个凭据：服务进程里的变量名、从守护进程的哪个环境变量来的、值 */
export interface InjectedSecret {
  name: string;
  variable: string;
  value: string;
}

/** 太短的凭据值不去认（可能是 "1"、"on" 这种，认了就全是假阳性）；和 guard/secrets.ts 擦值时的门槛一个口径 */
const MIN_SECRET_LENGTH = 8;

/** 一个字符串里有没有注入的凭据值：有就换成它的来路（"来自环境变量 X"），不写原值 */
function replaceInjected(value: unknown, injected: readonly InjectedSecret[]): unknown {
  if (Array.isArray(value)) return value.map((v) => replaceInjected(v, injected));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replaceInjected(v, injected)]));
  }
  if (typeof value !== "string") return value;
  const hit = injected.find((secret) => secret.value.length >= MIN_SECRET_LENGTH && value.includes(secret.value));
  return hit ? t("mcp.change.env.fromEnv", { variable: hit.variable }) : value;
}

/**
 * 参数里密钥类的值换成不写原值的说法，回脱敏之后的参数和"换过没有"（时间线、事件日志里用这一份；发给服务进程的是原参数）。
 * 聊天里的工具调用摘要另外自己擦一遍那一层参数（guard-runtime/describe.ts 的 summarizeArgs，按工具登记里的 maskArgs：那边拿不到登记的来路）
 */
export function redactMcpCallArgs(args: Record<string, unknown>, injected: readonly InjectedSecret[]): { args: Record<string, unknown>; redacted: boolean } {
  const masked = maskSecretArgValues(replaceInjected(args, injected)) as Record<string, unknown>;
  return { args: masked, redacted: JSON.stringify(args) !== JSON.stringify(masked) };
}
